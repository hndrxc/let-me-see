import type { EventPayload, EventType, TreeEvent } from "./events.ts";
import type { HostContext } from "./host.ts";
import { TreeStore, type TreeOptions } from "./store.ts";

export interface Binding {
  sessionId: string;
  sessionFile: string | undefined;
  parentSession: string | undefined;
  agent: HostContext["agent"];
  root: TreeStore | undefined;
  pending: Array<{ type: EventType; payload: EventPayload; timestamp: number; agentId: string }>;
}

/** Shared by rebound factories, keyed by session identities rather than global agent names. */
export class SessionRegistry {
  private readonly roots = new Map<string, TreeStore>();
  private readonly bindings = new Set<Binding>();
  private sequence = 0;

  constructor(private readonly options: TreeOptions = {}) {}

  bind(ctx: HostContext): Binding {
    const binding: Binding = { sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(), parentSession: ctx.sessionManager.getHeader()?.parentSession,
      agent: { ...ctx.agent }, root: undefined, pending: [] };
    this.bindings.add(binding);
    if (ctx.agent.kind === "main") {
      binding.root = this.roots.get(binding.sessionId) ?? new TreeStore(binding.sessionId, this.options);
      this.roots.set(binding.sessionId, binding.root);
      // Bound archived runs; active child bindings still retain their own isolated store.
      if (this.roots.size > 8) this.roots.delete(this.roots.keys().next().value!);
    }
    this.resolve();
    return binding;
  }

  private resolve(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const binding of this.bindings) {
        if (binding.root || !binding.parentSession) continue;
        const parent = [...this.bindings].find(candidate => candidate !== binding && candidate.root &&
          (candidate.sessionId === binding.parentSession || candidate.sessionFile === binding.parentSession));
        if (parent?.root) { this.attach(binding, parent.root); changed = true; }
      }
    }
  }

  /** A lifecycle frame on the spawning session's bus supplies unambiguous file correlation. */
  correlate(sessionFile: string, agentId: string, root: TreeStore): Binding | undefined {
    const binding = [...this.bindings].find(b => b.sessionFile === sessionFile && b.agent.id === agentId);
    if (!binding) return;
    // Never move a child from one known root to another.
    if (binding.root && binding.root !== root) return;
    this.attach(binding, root);
    this.resolve();
    return binding;
  }

  find(sessionFile: string, agentId: string): Binding | undefined {
    return [...this.bindings].find(b => b.sessionFile === sessionFile && b.agent.id === agentId);
  }

  private attach(binding: Binding, root: TreeStore): void {
    binding.root = root;
    for (const event of binding.pending) this.emit(binding, event.type, event.payload, event.timestamp, event.agentId);
    binding.pending.length = 0;
  }

  emit(binding: Binding, type: EventType, payload: EventPayload = {}, timestamp = Date.now(), agentId = binding.agent.id): void {
    if (!binding.root) {
      binding.pending.push({ type, payload, timestamp, agentId });
      if (binding.pending.length > 256) binding.pending.shift();
      return;
    }
    const event: TreeEvent = { schemaVersion: 1, eventId: `omp:${binding.sessionId}:${++this.sequence}`,
      timestamp, source: "omp/18.8.6", rootSessionId: binding.root.rootSessionId,
      sessionId: binding.sessionId, agentId, type, payload };
    binding.root.ingest(event);
  }

  unbind(binding: Binding): void {
    this.bindings.delete(binding);
    binding.pending.length = 0;
  }
  releaseRoot(root: TreeStore): void {
    this.roots.delete(root.rootSessionId);
    root.dispose();
    for (const binding of this.bindings) if (binding.root === root) this.unbind(binding);
  }
}
