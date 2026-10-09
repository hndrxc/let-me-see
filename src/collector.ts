import { isRecord, TELEMETRY_CHANNEL, type AgentState, type EventPayload } from "./events.ts";
import type { HostAPI, HostContext } from "./host.ts";
import { SessionRegistry, type Binding } from "./registry.ts";

const text = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
export function observedModel(value: unknown): string | undefined {
  if (!isRecord(value)) return;
  const provider = text(value.provider), id = text(value.id) ?? text(value.model);
  return provider && id ? `${provider}/${id}` : undefined;
}
export function outcome(value: unknown): AgentState {
  if (isRecord(value) && value.role === "assistant") {
    if (value.stopReason === "aborted") return "cancelled";
    if (value.stopReason === "error") return "failed";
  }
  return "idle";
}

export class Collector {
  binding: Binding | undefined;
  private readonly unsubscribers: Array<() => void> = [];
  private readonly owners = new Map<string, { binding: Binding; agentId: string }>();
  private readonly frames = new Map<string, Binding>();
  private loopOutcome: AgentState = "idle";
  private readonly lastModels = new Map<string, string>();

  constructor(private readonly pi: HostAPI, readonly registry: SessionRegistry, private readonly onSwitch: () => void) {
    this.unsubscribers.push(pi.events.on(TELEMETRY_CHANNEL, data => { this.binding?.root?.ingest(data); }));
    for (const channel of ["task:subagent:lifecycle", "task:subagent:progress", "task:subagent:event"]) {
      this.unsubscribers.push(pi.events.on(channel, data => this.bridge(channel, data)));
    }
    for (const name of ["session_start", "session_switch", "session_branch", "agent_start", "agent_end",
      "before_agent_start", "before_provider_request", "message_end", "tool_execution_start", "tool_execution_end", "tool_call", "tool_result"]) {
      pi.on(name, (event, ctx) => { this.collect(name, event, ctx); });
    }
  }

  ensure(ctx: HostContext): Binding {
    if (this.binding?.sessionId === ctx.sessionManager.getSessionId()) return this.binding;
    if (this.binding) { this.onSwitch(); this.registry.unbind(this.binding); }
    this.binding = this.registry.bind(ctx);
    this.frames.clear();
    this.loopOutcome = "idle";
    this.lastModels.clear();
    this.registry.emit(this.binding, "agent_observed", this.identity(ctx));
    return this.binding;
  }

  private identity(ctx: HostContext): EventPayload {
    return { name: ctx.agent.name, kind: ctx.agent.kind, parentId: ctx.agent.parentId,
      state: ctx.isIdle() ? "idle" : "running" };
  }

  private model(binding: Binding, model: string | undefined, agentId = binding.agent.id): void {
    if (!model || this.lastModels.get(agentId) === model) return;
    this.lastModels.set(agentId, model);
    this.registry.emit(binding, "model_observed", { model }, Date.now(), agentId);
  }

  private collect(name: string, event: Record<string, unknown>, ctx: HostContext): void {
    const binding = this.ensure(ctx);
    if (name === "agent_start") {
      this.loopOutcome = "idle";
      this.registry.emit(binding, "loop_started");
    } else if (name === "agent_end") {
      this.registry.emit(binding, "loop_ended", { state: this.loopOutcome, willContinue: event.willContinue === true });
    } else if (name === "before_agent_start" && ctx.agent.kind === "main" && typeof event.prompt === "string") {
      // Keep only a brief first-line summary, never the full prompt or images.
      const task = event.prompt.split(/\r?\n/, 1)[0]?.trim().slice(0, 160);
      if (task) this.registry.emit(binding, "task_updated", { task });
    } else if (name === "before_provider_request") {
      // This context is request-scoped, unlike session/model preferences.
      this.model(binding, observedModel(ctx.model));
    } else if (name === "message_end" && isRecord(event.message) && event.message.role === "assistant") {
      this.model(binding, observedModel(event.message));
      this.loopOutcome = outcome(event.message);
    } else if (name === "tool_execution_start" || name === "tool_execution_end") {
      const toolCallId = text(event.toolCallId), toolName = text(event.toolName);
      if (!toolCallId || !toolName) return;
      if (name === "tool_execution_start") {
        this.owners.set(toolCallId, { binding, agentId: binding.agent.id });
        if (this.owners.size > 2048) this.owners.delete(this.owners.keys().next().value!);
      }
      this.registry.emit(binding, name === "tool_execution_start" ? "tool_started" : "tool_ended",
        { toolCallId, toolName, isError: event.isError === true });
    } else if ((name === "tool_call" || name === "tool_result") && ctx.agent.id !== binding.agent.id) {
      // OMP explicitly identifies advisor tool interceptions on the host session's runner.
      // ctx.model still belongs to the host here, so it cannot supply the advisor model.
      const advisor = ctx.agent.id === "advisor";
      const agentId = `${binding.agent.id}/${ctx.agent.id}`;
      const toolCallId = text(event.toolCallId), toolName = text(event.toolName);
      if (!toolCallId || !toolName) return;
      if (!binding.root?.nodes.has(agentId)) this.registry.emit(binding, "agent_observed",
        { ...this.identity(ctx), parentId: ctx.agent.parentId, relation: advisor ? "consultation" : "child", state: "unknown" }, Date.now(), agentId);
      this.registry.emit(binding, name === "tool_call" ? "tool_started" : "tool_ended",
        { toolCallId, toolName, isError: event.isError === true }, Date.now(), agentId);
      if (name === "tool_result" && !binding.root?.nodes.get(agentId)?.tools.size) {
        this.registry.emit(binding, "loop_ended", { state: "unknown" }, Date.now(), agentId);
      }
    }
  }

  private bridge(channel: string, data: unknown): void {
    if (!this.binding || !isRecord(data)) return;
    const progress = isRecord(data.progress) ? data.progress : undefined;
    const id = text(data.id) ?? text(progress?.id);
    if (!id) return;
    const file = text(data.sessionFile);
    const known = file ? this.registry.find(file, id) : undefined;
    const owner = typeof data.parentToolCallId === "string" ? this.owners.get(data.parentToolCallId) : undefined;
    // An old child's known session association wins over the currently selected root.
    const previous = this.frames.get(id);
    const root = known?.root ?? owner?.binding.root ?? previous?.root;
    if (!root) return; // Insufficient root correlation: never guess from a repeated agent name.
    if (file) this.registry.correlate(file, id, root);
    const producer = owner?.binding ?? previous ?? this.binding;
    const frame: Binding = { ...producer, root, sessionId: known?.sessionId ?? previous?.sessionId ?? `unobserved:${id}` };
    this.frames.set(id, frame);
    if (this.frames.size > 2048) this.frames.delete(this.frames.keys().next().value!);
    const emit = (type: Parameters<SessionRegistry["emit"]>[1], payload: EventPayload) => {
      // Build a frame-scoped binding so session IDs stay accurate even without child hooks.
      this.registry.emit(frame, type, payload, Date.now(), id);
    };
    if (channel === "task:subagent:lifecycle") {
      const state = text(data.status);
      emit("agent_observed", { name: text(data.agent), kind: "sub", parentId: known?.agent.parentId ?? owner?.agentId,
        task: text(data.description), state: state === "started" ? "running" : "unknown" });
      if (state === "started" && root.nodes.get(id)?.state !== "running") emit("loop_started", {});
      if (["completed", "failed", "aborted"].includes(state ?? "")) {
        emit("agent_finished", { state: state === "aborted" ? "cancelled" : state as AgentState });
      }
    } else if (channel === "task:subagent:progress") {
      const node = root.nodes.get(id);
      const task = text(data.task) ?? text(progress?.task);
      if (task && task.slice(0, 2048) !== node?.task) emit("task_updated", { task });
      // Resolved preference is not necessarily the model observed at inference.
      // Only actual assistant frames / request hooks set the observed model.
    } else if (channel === "task:subagent:event" && isRecord(data.event)) {
      const event = data.event;
      // Rebound child hooks already capture these. Bridge raw frames only for omitted factories.
      if (root.nodes.get(id)?.sessionId && !root.nodes.get(id)!.sessionId.startsWith("unobserved:")) return;
      if (event.type === "message_end" && isRecord(event.message)) {
        const model = observedModel(event.message);
        if (model && model !== root.nodes.get(id)?.model) emit("model_observed", { model });
      }
      if (event.type === "tool_execution_start" || event.type === "tool_execution_end") {
        const toolCallId = text(event.toolCallId), toolName = text(event.toolName);
        if (toolCallId && toolName) emit(event.type === "tool_execution_start" ? "tool_started" : "tool_ended", { toolCallId, toolName, isError: event.isError === true });
      }
    }
  }

  dispose(): void {
    for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
    if (this.binding) this.registry.unbind(this.binding);
    this.owners.clear(); this.frames.clear(); this.lastModels.clear();
  }
}
