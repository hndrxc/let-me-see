import { parseEvent, type AgentState, type Relation, type TreeEvent } from "./events.ts";

export interface TreeOptions {
  historyLimit?: number;
  activityLimit?: number;
  completedLimit?: number;
  labels?: Record<string, string>;
  colors?: Partial<Record<AgentState, string>>;
}
export interface Activity { timestamp: number; agentId: string; text: string; }
export interface AgentNode {
  rootSessionId: string;
  sessionId: string;
  id: string;
  parentId: string | undefined;
  name: string;
  kind: string;
  relation: Relation;
  model: string | undefined;
  state: AgentState;
  startedAt: number | undefined;
  endedAt: number | undefined;
  task: string | undefined;
  tools: Map<string, { name: string; startedAt: number }>;
  history: Activity[];
  stateAt: number;
  fieldsAt: Map<string, number>;
  toolEnds: Map<string, number>;
}
export const terminal = (state: AgentState): boolean => ["completed", "failed", "cancelled"].includes(state);
export function bounded(value: number | undefined, fallback: number, max = 10000): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(0, Math.floor(value))) : fallback;
}

export class TreeStore {
  readonly nodes = new Map<string, AgentNode>();
  readonly activity: Activity[] = [];
  readonly options: Required<Pick<TreeOptions, "historyLimit" | "activityLimit" | "completedLimit">> & TreeOptions;
  revision = 0;
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(readonly rootSessionId: string, options: TreeOptions = {}) {
    this.options = { ...options, historyLimit: bounded(options.historyLimit, 50), activityLimit: bounded(options.activityLimit, 200), completedLimit: bounded(options.completedLimit, 200) };
  }
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  ingest(input: unknown): boolean {
    const event = parseEvent(input);
    if (!event || event.rootSessionId !== this.rootSessionId || this.seen.has(event.eventId)) return false;
    this.seen.add(event.eventId);
    if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value!);
    let node = this.nodes.get(event.agentId);
    if (!node) {
      node = { rootSessionId: this.rootSessionId, sessionId: event.sessionId, id: event.agentId,
        parentId: undefined, name: event.agentId, kind: "unknown", relation: "child", model: undefined,
        state: "unknown", startedAt: undefined, endedAt: undefined, task: undefined,
        tools: new Map(), history: [], stateAt: -1, fieldsAt: new Map(), toolEnds: new Map() };
      this.nodes.set(node.id, node);
    }
    const p = event.payload;
    for (const key of ["parentId", "name", "kind", "model", "task", "relation"] as const) {
      if (p[key] !== undefined && event.timestamp >= (node.fieldsAt.get(key) ?? -1)) {
        // Each assignment remains typed even though the keys have different unions.
        Object.assign(node, { [key]: p[key] });
        node.fieldsAt.set(key, event.timestamp);
      }
    }
    if (event.type === "loop_started" && event.timestamp >= node.stateAt) {
      node.startedAt = event.timestamp;
      node.endedAt = undefined;
      node.tools.clear();
      node.sessionId = event.sessionId;
      this.setState(node, "running", event.timestamp);
    } else if (event.type === "agent_observed") {
      if (node.startedAt === undefined) node.startedAt = event.timestamp;
      if (node.state === "unknown" && event.timestamp >= node.stateAt) this.setState(node, p.state ?? "idle", event.timestamp);
    } else if (event.type === "loop_ended" && event.timestamp >= node.stateAt) {
      this.setState(node, p.willContinue ? "running" : (p.state ?? "idle"), event.timestamp);
      if (!p.willContinue) { node.endedAt = event.timestamp; node.tools.clear(); }
    } else if (event.type === "agent_finished" && event.timestamp >= node.stateAt) {
      this.setState(node, p.state!, event.timestamp);
      node.endedAt = event.timestamp;
      node.tools.clear();
    } else if (event.type === "tool_started") {
      const ended = node.toolEnds.get(p.toolCallId!);
      if ((ended === undefined || ended < event.timestamp) && event.timestamp >= node.stateAt && !terminal(node.state)) {
        node.tools.set(p.toolCallId!, { name: p.toolName!, startedAt: event.timestamp });
        // Tool starts are concurrent: don't advance the lifecycle watermark and
        // accidentally suppress an older start delivered after another tool.
        node.state = "running";
      }
    } else if (event.type === "tool_ended") {
      const call = node.tools.get(p.toolCallId!);
      if (!call || event.timestamp >= call.startedAt) node.tools.delete(p.toolCallId!);
      node.toolEnds.set(p.toolCallId!, Math.max(event.timestamp, node.toolEnds.get(p.toolCallId!) ?? -1));
      if (node.toolEnds.size > 512) node.toolEnds.delete(node.toolEnds.keys().next().value!);
    }
    // Log metadata only; task text is shown exclusively in the selected node's detail pane.
    const entry = { timestamp: event.timestamp, agentId: node.id, text: this.describe(event) };
    node.history.push(entry);
    node.history.splice(0, Math.max(0, node.history.length - this.options.historyLimit));
    this.activity.push(entry);
    this.activity.splice(0, Math.max(0, this.activity.length - this.options.activityLimit));
    this.prune();
    this.revision++;
    for (const listener of this.listeners) listener();
    return true;
  }
  private setState(node: AgentNode, state: AgentState, timestamp: number): void {
    node.state = state;
    node.stateAt = timestamp;
  }
  private describe(event: TreeEvent): string {
    const p = event.payload;
    switch (event.type) {
      case "agent_observed": return "agent observed";
      case "loop_started": return "agent started";
      case "loop_ended": return p.willContinue ? "continuation scheduled" : `turn returned (${p.state ?? "idle"})`;
      case "agent_finished": return `task returned (${p.state})`;
      case "model_observed": return `model observed: ${p.model ?? "unknown"}`;
      case "tool_started": return `tool started: ${p.toolName}`;
      case "tool_ended": return `tool ${p.isError ? "failed" : "ended"}: ${p.toolName}`;
      case "task_updated": return "task summary updated";
    }
  }
  private prune(): void {
    // Keep ancestors of retained nodes so pruning never strands a running subtree.
    let completed = [...this.nodes.values()].filter(n => terminal(n.state));
    for (const node of completed) {
      if (completed.length <= this.options.completedLimit) break;
      if (node.kind === "main" || [...this.nodes.values()].some(n => n.parentId === node.id)) continue;
      this.nodes.delete(node.id);
      completed = completed.filter(n => n.id !== node.id);
    }
  }
  dispose(): void { this.listeners.clear(); this.seen.clear(); }
}
