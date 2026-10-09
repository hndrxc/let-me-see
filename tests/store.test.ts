import { expect, test } from "bun:test";
import { parseEvent, publishTelemetry, TELEMETRY_CHANNEL } from "../src/events.ts";
import { TreeStore } from "../src/store.ts";
import { Bus, frame } from "./helpers.ts";

test("validates, deduplicates, isolates roots and drops arbitrary payloads", () => {
  const store = new TreeStore("root-a");
  const event = frame("agent_observed", "Main", { kind: "main", name: "main" });
  expect(store.ingest(event)).toBe(true);
  expect(store.ingest(event)).toBe(false);
  expect(store.ingest({ ...event, eventId: "other", rootSessionId: "root-b" })).toBe(false);
  expect(store.ingest({ ...event, schemaVersion: 2 })).toBe(false);
  expect(store.ingest({ ...event, timestamp: NaN })).toBe(false);
  expect(parseEvent({ ...event, payload: { name: "a", prompt: "secret", output: "secret" } })?.payload).toEqual({ name: "a" });
  expect(parseEvent(frame("tool_started"))).toBeUndefined();
  expect(parseEvent(frame("agent_finished", "Main", { state: "running" }))).toBeUndefined();
});

test("correlates concurrent tools and ignores late starts after a result", () => {
  const store = new TreeStore("root-a");
  store.ingest(frame("loop_started", "a", {}, 10));
  store.ingest(frame("tool_started", "a", { toolCallId: "two", toolName: "write" }, 30));
  store.ingest(frame("tool_started", "a", { toolCallId: "one", toolName: "read" }, 20));
  expect(store.nodes.get("a")?.tools.size).toBe(2);
  store.ingest(frame("tool_ended", "a", { toolCallId: "one", toolName: "read" }, 40));
  expect([...store.nodes.get("a")!.tools.keys()]).toEqual(["two"]);
  store.ingest(frame("tool_ended", "a", { toolCallId: "three", toolName: "bash" }, 50));
  store.ingest(frame("tool_started", "a", { toolCallId: "three", toolName: "bash" }, 45));
  expect(store.nodes.get("a")!.tools.has("three")).toBe(false);
});

test("a turn ending is reusable, continuation is running, and stale events cannot resurrect a cancelled task", () => {
  const store = new TreeStore("root-a");
  store.ingest(frame("loop_started", "a", {}, 10));
  store.ingest(frame("loop_ended", "a", { willContinue: true }, 20));
  expect(store.nodes.get("a")?.state).toBe("running");
  store.ingest(frame("loop_ended", "a", { state: "idle" }, 30));
  expect(store.nodes.get("a")?.state).toBe("idle");
  store.ingest(frame("loop_started", "a", {}, 40));
  expect(store.nodes.get("a")?.endedAt).toBeUndefined();
  expect(store.nodes.get("a")?.startedAt).toBe(40);
  store.ingest(frame("agent_finished", "a", { state: "cancelled" }, 60));
  store.ingest(frame("loop_started", "a", {}, 50));
  store.ingest(frame("tool_started", "a", { toolCallId: "late", toolName: "read" }, 55));
  expect(store.nodes.get("a")?.state).toBe("cancelled");
  expect(store.nodes.get("a")?.tools.size).toBe(0);
  store.ingest(frame("loop_started", "a", {}, 70));
  expect(store.nodes.get("a")?.state).toBe("running");
});

test("bounds logs and retains parents needed by active descendants", () => {
  const store = new TreeStore("root-a", { historyLimit: 2, activityLimit: 3, completedLimit: 1 });
  store.ingest(frame("agent_observed", "parent"));
  store.ingest(frame("agent_observed", "child", { parentId: "parent", state: "running" }));
  store.ingest(frame("agent_finished", "parent", { state: "completed" }));
  for (let i = 0; i < 10; i++) store.ingest(frame("task_updated", "child", { task: String(i) }));
  for (let i = 0; i < 5; i++) store.ingest(frame("agent_finished", `done-${i}`, { state: "completed" }));
  expect(store.nodes.has("parent")).toBe(true);
  expect(store.nodes.has("child")).toBe(true);
  expect(store.nodes.size).toBe(2);
  expect(store.activity.length).toBe(3);
  expect(store.nodes.get("child")?.history.length).toBe(2);
});

test("adapter publishes a validated event and rejects malformed telemetry", () => {
  const bus = new Bus(); let received: unknown;
  bus.on(TELEMETRY_CHANNEL, event => { received = event; });
  const event = frame("agent_observed", "custom", { relation: "consultation" });
  publishTelemetry(bus, event);
  expect(received).toEqual(event);
  expect(() => publishTelemetry(bus, { ...event, timestamp: -1 })).toThrow();
});
