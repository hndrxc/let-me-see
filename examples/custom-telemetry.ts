import { publishTelemetry, type TreeEvent } from "../src/events.ts";
import type { HostAPI } from "../src/host.ts";

/** Example producer: adapt actual router notifications to these frames. */
export default function customTelemetry(pi: HostAPI): void {
  pi.registerCommand("agent-tree-example", {
    description: "Publish a clearly labelled example consultation",
    async handler(_args, ctx) {
      if (ctx.agent.kind !== "main") return;
      const sessionId = ctx.sessionManager.getSessionId();
      const agentId = `example-consultation:${sessionId}`;
      const timestamp = Date.now();
      const send = (type: TreeEvent["type"], payload: TreeEvent["payload"], offset: number) => publishTelemetry(pi.events, {
        schemaVersion: 1, eventId: `example:${timestamp}:${offset}`, timestamp: timestamp + offset,
        source: "custom-telemetry-example", rootSessionId: sessionId, sessionId, agentId, type, payload,
      });
      send("agent_observed", { name: "Example consultation", kind: "custom", parentId: ctx.agent.id, relation: "consultation",
        task: "Demonstrate explicit telemetry from a custom integration" }, 0);
      send("loop_started", {}, 1);
      send("agent_finished", { state: "completed" }, 2);
    },
  });
}
