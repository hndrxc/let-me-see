import { expect, test } from "bun:test";
import { SessionRegistry } from "../src/registry.ts";
import { context, host } from "./helpers.ts";

test("child before parent, parallel children, nested delegation and repeated Main IDs stay isolated", () => {
  const registry = new SessionRegistry();
  const child = host(registry), nested = host(registry), main = host(registry), other = host(registry);
  const childCtx = context("child", "x", "Main", "/sessions/root-a.jsonl");
  const nestedCtx = context("nested", "y", "x", "child");
  child.emit("session_start", childCtx);
  nested.emit("session_start", nestedCtx);
  nested.emit("before_provider_request", { ...nestedCtx, model: { provider: "actual", id: "nested" } }, { payload: { secret: "never retained" } });
  expect(nested.collector.binding?.root).toBeUndefined();
  main.emit("session_start", context());
  other.emit("session_start", context("root-b"));
  const parallel = host(registry);
  parallel.emit("session_start", context("parallel", "z", "Main", "root-a"));
  const tree = main.collector.binding!.root!;
  expect([...tree.nodes.keys()]).toEqual(["x", "y", "Main", "z"]);
  expect(tree.nodes.get("y")?.model).toBe("actual/nested");
  expect(tree.nodes.get("y")?.parentId).toBe("x");
  expect([...other.collector.binding!.root!.nodes.keys()]).toEqual(["Main"]);
});

test("lifecycle file bridge correlates child sessions without header ancestry", () => {
  const registry = new SessionRegistry();
  const main = host(registry), child = host(registry);
  const ctx = context();
  main.emit("session_start", ctx);
  main.emit("tool_execution_start", ctx, { toolCallId: "spawn", toolName: "task" });
  child.emit("session_start", context("child", "worker", "Main"));
  expect(child.collector.binding?.root).toBeUndefined();
  main.bus.emit("task:subagent:lifecycle", { id: "worker", agent: "custom-name", status: "started", sessionFile: "/sessions/child.jsonl", parentToolCallId: "spawn" });
  expect(child.collector.binding?.root).toBe(main.collector.binding?.root);
  child.emit("before_provider_request", context("child", "worker", "Main"));
  expect(main.collector.binding?.root?.nodes.get("worker")?.model).toBe("test/configured-only");
});

test("omitted child factories use raw frames, not configured model preferences or tool outputs", () => {
  const main = host(); const ctx = context();
  main.emit("session_start", ctx);
  main.emit("tool_execution_start", ctx, { toolCallId: "spawn", toolName: "task" });
  main.bus.emit("task:subagent:lifecycle", { id: "worker", agent: "custom", status: "started", parentToolCallId: "spawn" });
  main.bus.emit("task:subagent:progress", { progress: { id: "worker", resolvedModelIdentity: "configured/guess", recentOutput: ["secret"] }, task: "Investigate parser", parentToolCallId: "spawn" });
  const tree = main.collector.binding!.root!;
  expect(tree.nodes.get("worker")?.model).toBeUndefined();
  main.bus.emit("task:subagent:event", { id: "worker", event: { type: "message_end", message: { role: "assistant", provider: "observed", model: "actual", content: [{ text: "secret" }] } } });
  main.bus.emit("task:subagent:event", { id: "worker", event: { type: "tool_execution_start", toolCallId: "one", toolName: "read", args: { secret: true } } });
  expect(tree.nodes.get("worker")?.model).toBe("observed/actual");
  expect(tree.nodes.get("worker")?.tools.size).toBe(1);
  expect(tree.nodes.get("worker")?.task).toBe("Investigate parser");
  expect(JSON.stringify(tree.activity)).not.toContain("secret");
  main.bus.emit("task:subagent:lifecycle", { id: "worker", status: "aborted", parentToolCallId: "spawn" });
  expect(tree.nodes.get("worker")?.state).toBe("cancelled");
});

test("provider observation tracks model changes and agent_end respects repeated turns and cancellation", () => {
  const h = host(); const ctx = context();
  h.emit("session_start", ctx);
  expect(h.collector.binding?.root?.nodes.get("Main")?.model).toBeUndefined();
  h.emit("agent_start", ctx);
  h.emit("before_provider_request", ctx);
  h.emit("before_provider_request", { ...ctx, model: { provider: "other", id: "fallback" } });
  h.emit("message_end", ctx, { message: { role: "assistant", stopReason: "aborted", provider: "other", model: "fallback" } });
  h.emit("agent_end", ctx);
  expect(h.collector.binding?.root?.nodes.get("Main")?.state).toBe("cancelled");
  expect(h.collector.binding?.root?.nodes.get("Main")?.model).toBe("other/fallback");
  h.emit("agent_start", ctx); h.emit("agent_end", ctx);
  expect(h.collector.binding?.root?.nodes.get("Main")?.state).toBe("idle");
});

test("main task summaries retain only a bounded first line and never images or the full prompt", () => {
  const h = host(); const ctx = context();
  h.emit("session_start", ctx);
  h.emit("before_agent_start", ctx, { prompt: "Build the parser\nprivate detailed instructions", images: ["private image"] });
  expect(h.collector.binding?.root?.nodes.get("Main")?.task).toBe("Build the parser");
  h.emit("before_agent_start", ctx, { prompt: "x".repeat(500) });
  expect(h.collector.binding?.root?.nodes.get("Main")?.task?.length).toBe(160);
  expect(JSON.stringify(h.collector.binding?.root?.activity)).not.toContain("private");
});

test("session switch keeps late child lifecycle in the old root and disposes subscriptions", () => {
  const h = host(); const ctx = context();
  h.emit("session_start", ctx);
  h.emit("tool_execution_start", ctx, { toolCallId: "old-spawn", toolName: "task" });
  const previous = h.collector.binding!.root!;
  h.emit("session_switch", context("root-b"));
  h.bus.emit("task:subagent:lifecycle", { id: "late", agent: "late", status: "completed", parentToolCallId: "old-spawn" });
  expect(previous.nodes.get("late")?.state).toBe("completed");
  expect(h.collector.binding?.root?.nodes.has("late")).toBe(false);
  h.collector.dispose();
  expect([...h.bus.listeners.values()].every(group => !group.size)).toBe(true);
});

test("advisor contexts expose consultation tools with scoped IDs and unknown models", () => {
  const h = host(); const ctx = context();
  h.emit("session_start", ctx);
  const advisor = { ...ctx, agent: { id: "advisor", kind: "sub" as const, name: "advisor", parentId: "Main", depth: 0 } };
  h.emit("tool_call", advisor, { toolCallId: "a", toolName: "read" });
  const node = h.collector.binding!.root!.nodes.get("Main/advisor")!;
  expect(node.relation).toBe("consultation");
  expect(node.parentId).toBe("Main");
  expect(node.model).toBeUndefined();
  expect(node.tools.size).toBe(1);
  h.emit("tool_result", advisor, { toolCallId: "a", toolName: "read", isError: false, content: [{ text: "secret" }] });
  expect(node.state).toBe("unknown");
  expect(node.tools.size).toBe(0);
});
