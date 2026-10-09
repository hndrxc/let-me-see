export const TELEMETRY_CHANNEL = "agent-tree:telemetry:v1";
export type AgentState = "unknown" | "idle" | "running" | "completed" | "failed" | "cancelled";
export type Relation = "child" | "consultation";
export type EventType = "agent_observed" | "loop_started" | "loop_ended" | "agent_finished" | "model_observed" | "tool_started" | "tool_ended" | "task_updated";

export interface EventPayload {
  parentId?: string | undefined;
  name?: string | undefined;
  kind?: string | undefined;
  relation?: Relation | undefined;
  model?: string | undefined;
  task?: string | undefined;
  state?: AgentState | undefined;
  toolCallId?: string | undefined;
  toolName?: string | undefined;
  isError?: boolean | undefined;
  willContinue?: boolean | undefined;
}

export interface TreeEvent {
  schemaVersion: 1;
  eventId: string;
  timestamp: number;
  source: string;
  rootSessionId: string;
  sessionId: string;
  agentId: string;
  type: EventType;
  payload: EventPayload;
}

export interface TelemetryBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

const types: readonly string[] = ["agent_observed", "loop_started", "loop_ended", "agent_finished", "model_observed", "tool_started", "tool_ended", "task_updated"];
const states: readonly string[] = ["unknown", "idle", "running", "completed", "failed", "cancelled"];
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate and copy only allowed fields. Prompts, outputs and arbitrary metadata are discarded. */
export function parseEvent(value: unknown): TreeEvent | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.payload)) return;
  for (const key of ["eventId", "source", "rootSessionId", "sessionId", "agentId", "type"]) {
    if (typeof value[key] !== "string" || !value[key] || (value[key] as string).length > 1024) return;
  }
  if (!types.includes(value.type as string) || typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp) || value.timestamp < 0) return;
  const input = value.payload;
  const payload: EventPayload = {};
  for (const key of ["parentId", "name", "kind", "model", "task", "toolCallId", "toolName"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "string") return;
    if (typeof input[key] === "string") payload[key] = input[key].slice(0, key === "task" ? 2048 : 1024);
  }
  if (input.state !== undefined) {
    if (typeof input.state !== "string" || !states.includes(input.state)) return;
    payload.state = input.state as AgentState;
  }
  if (input.relation !== undefined) {
    if (input.relation !== "child" && input.relation !== "consultation") return;
    payload.relation = input.relation;
  }
  for (const key of ["isError", "willContinue"] as const) {
    if (input[key] !== undefined && typeof input[key] !== "boolean") return;
    if (typeof input[key] === "boolean") payload[key] = input[key];
  }
  const type = value.type as EventType;
  if ((type === "tool_started" || type === "tool_ended") && (!payload.toolCallId || !payload.toolName)) return;
  if (type === "agent_finished" && !["completed", "failed", "cancelled"].includes(payload.state ?? "")) return;
  return { schemaVersion: 1, eventId: value.eventId as string, timestamp: value.timestamp,
    source: value.source as string, rootSessionId: value.rootSessionId as string,
    sessionId: value.sessionId as string, agentId: value.agentId as string, type, payload };
}

export function publishTelemetry(bus: Pick<TelemetryBus, "emit">, event: TreeEvent): void {
  const parsed = parseEvent(event);
  if (!parsed) throw new TypeError("Invalid agent-tree v1 telemetry event");
  bus.emit(TELEMETRY_CHANNEL, parsed);
}
