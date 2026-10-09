import type { HostAPI, HostContext } from "../src/host.ts";
import type { TreeEvent } from "../src/events.ts";
import { SessionRegistry } from "../src/registry.ts";
import { Collector } from "../src/collector.ts";

export class Bus {
  listeners = new Map<string, Set<(data: unknown) => void>>();
  emit(channel: string, data: unknown): void { for (const handler of this.listeners.get(channel) ?? []) handler(data); }
  on(channel: string, handler: (data: unknown) => void): () => void {
    const group = this.listeners.get(channel) ?? new Set(); group.add(handler); this.listeners.set(channel, group);
    return () => { group.delete(handler); };
  }
}
export function context(sessionId = "root-a", agentId = "Main", parentId?: string, parentSession?: string): HostContext {
  return {
    agent: { id: agentId, name: agentId === "Main" ? "main" : agentId, kind: agentId === "Main" ? "main" : "sub", depth: 0, ...(parentId ? { parentId } : {}) },
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => `/sessions/${sessionId}.jsonl`, getHeader: () => parentSession ? { parentSession } : {} },
    model: { provider: "test", id: "configured-only" }, mode: "tui", hasUI: true, isIdle: () => true,
    setInterval: fn => setInterval(fn, 100), clearTimer: handle => clearInterval(handle as ReturnType<typeof setInterval>),
    ui: { notify: () => {}, custom: async () => undefined as never },
  };
}
export function host(registry = new SessionRegistry()) {
  const handlers = new Map<string, Array<(event: Record<string, unknown>, ctx: HostContext) => void>>();
  const commands = new Map<string, any>();
  const shortcuts = new Map<string, any>();
  const bus = new Bus();
  const api: HostAPI = {
    events: bus,
    on(name, handler) { const group = handlers.get(name) ?? []; group.push(handler); handlers.set(name, group); },
    registerCommand(name, command) { commands.set(name, command); },
    registerShortcut(name, shortcut) { shortcuts.set(name, shortcut); },
  };
  const collector = new Collector(api, registry, () => {});
  return { api, bus, handlers, collector, commands, shortcuts,
    emit(name: string, ctx: HostContext, event: Record<string, unknown> = {}) {
      for (const handler of handlers.get(name) ?? []) handler({ ...event, type: name }, ctx);
    } };
}
let sequence = 0;
export function frame(type: TreeEvent["type"], agentId = "Main", payload: TreeEvent["payload"] = {}, timestamp = ++sequence): TreeEvent {
  return { schemaVersion: 1, eventId: `test:${++sequence}`, timestamp, source: "test",
    rootSessionId: "root-a", sessionId: "session-" + agentId, agentId, type, payload };
}
