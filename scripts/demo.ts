import { TreeStore } from "../src/store.ts";
import { Dashboard } from "../src/dashboard.ts";
import type { TreeEvent } from "../src/events.ts";

const store = new TreeStore("demo");
let sequence = 0;
const now = Date.now();
function add(id: string, type: TreeEvent["type"], payload: TreeEvent["payload"], timestamp = now): void {
  store.ingest({ schemaVersion: 1, eventId: `demo:${++sequence}`, timestamp, source: "demo", rootSessionId: "demo", sessionId: "demo", agentId: id, type, payload });
}
add("root", "agent_observed", { name: "main", kind: "main", state: "running", task: "Build a live agent tree" }, now - 80000);
add("root", "model_observed", { model: "example/model-a" });
add("child-1", "agent_observed", { name: "configured-agent", parentId: "root", kind: "sub", state: "running", task: "Inspect terminal rendering" }, now - 24000);
add("child-1", "model_observed", { model: "example/model-b" });
add("child-1", "tool_started", { toolCallId: "call-1", toolName: "read" });
add("child-2", "agent_observed", { name: "another-agent", parentId: "root", kind: "sub", task: "Check event normalization" }, now - 18000);
add("child-2", "agent_finished", { state: "completed" }, now - 5000);
add("nested", "agent_observed", { name: "nested-agent", parentId: "child-1", kind: "sub", state: "running" }, now - 12000);
add("consultation", "agent_observed", { name: "custom consultation", parentId: "root", relation: "consultation", state: "unknown" });
add("unresolved", "agent_observed", { name: "unresolved-agent", parentId: "missing-parent", state: "unknown" });
const columns = Number(process.argv[2]) || 120;
const dashboard = new Dashboard(store, () => 24, () => {}, () => {}, undefined, () => now);
console.log(dashboard.render(columns).join("\n"));
