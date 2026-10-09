import { expect, test } from "bun:test";
import { createAgentTreeExtension } from "../src/index.ts";
import type { Dashboard } from "../src/dashboard.ts";
import type { HostContext } from "../src/host.ts";
import { Bus, context } from "./helpers.ts";

test("overlay stays live, batches redraws, closes without aborting work and disposes timers", async () => {
  const handlers = new Map<string, any>();
  const commands = new Map<string, any>();
  let shortcut: any;
  const bus = new Bus();
  createAgentTreeExtension()({ events: bus, on: (name, handler) => { handlers.set(name, handler); },
    registerCommand: (name, cmd) => { commands.set(name, cmd); }, registerShortcut: (_name, s) => { shortcut = s; } });
  const ctx = context();
  let dashboard!: Dashboard, tick: (() => void) | undefined;
  let redraws = 0, clears = 0, options: any;
  ctx.setInterval = fn => { tick = fn; return "timer"; };
  ctx.clearTimer = () => { tick = undefined; clears++; };
  ctx.ui.custom = ((factory: any, opts: any) => {
    options = opts;
    return new Promise<void>((resolve, reject) => {
      dashboard = factory({ terminal: { rows: 24 }, requestRender: () => { redraws++; } }, { fg: (_color: string, text: string) => text }, {}, () => { dashboard.dispose(); resolve(); });
      opts.signal.addEventListener("abort", () => { dashboard.dispose(); reject(new Error("aborted")); });
    });
  }) as HostContext["ui"]["custom"];
  handlers.get("session_start")({}, ctx);
  const opened = commands.get("agent-tree").handler("", ctx);
  expect(options.overlay).toBe(true);
  expect(shortcut).toBeDefined();
  // No handler waits for the dashboard or rewrites request/tool payloads.
  const request = { payload: { prompt: "private" } };
  expect(handlers.get("before_provider_request")(request, ctx)).toBeUndefined();
  expect(request).toEqual({ payload: { prompt: "private" } });
  handlers.get("agent_start")({}, ctx);
  for (let i = 0; i < 100; i++) handlers.get("tool_execution_start")({ toolCallId: String(i), toolName: "read" }, ctx);
  expect(redraws).toBe(0);
  tick?.();
  expect(redraws).toBe(1);
  expect(dashboard.store.nodes.get("Main")?.tools.size).toBe(100);
  dashboard.handleInput("q"); await opened;
  expect(dashboard.store.nodes.get("Main")?.state).toBe("running");
  expect(clears).toBe(1);
  handlers.get("session_shutdown")({}, ctx);
  expect([...bus.listeners.values()].every(group => !group.size)).toBe(true);
});

test("headless mode never opens a terminal component", async () => {
  const commands = new Map<string, any>(); let notifications = 0;
  createAgentTreeExtension()({ events: new Bus(), on: () => {}, registerCommand: (name, cmd) => { commands.set(name, cmd); }, registerShortcut: () => {} });
  const ctx = context(); ctx.mode = "rpc";
  ctx.ui.notify = () => { notifications++; };
  ctx.ui.custom = async () => { throw new Error("should not open"); };
  await commands.get("agent-tree").handler("", ctx);
  expect(notifications).toBe(1);
});
