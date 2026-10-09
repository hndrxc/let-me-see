/** Compatibility spike against the installed, pinned host. No network or model calls. */
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Dashboard } from "../src/dashboard.ts";

const temporary = await mkdtemp(path.join(tmpdir(), "omp-agent-tree-"));
// Isolate the host's own settings and storage before importing its module graph.
process.env.PI_CONFIG_DIR = path.join(temporary, "config");
const binary = Bun.which("omp");
const root = process.env.OMP_PACKAGE_DIR ?? (binary ? path.dirname(path.dirname(await realpath(binary))) : undefined);
if (!root) throw new Error("Install OMP 18.8.6 or set OMP_PACKAGE_DIR to its package directory.");
const pkg = await Bun.file(path.join(root, "package.json")).json();
assert.equal(pkg.version, "18.8.6", "Compatibility check is pinned to OMP 18.8.6");
const { loadExtensions, bindPreparedExtensions, discoverExtensionPaths } = await import(path.join(root, "src/extensibility/extensions/loader.ts"));
const { ExtensionRunner } = await import(path.join(root, "src/extensibility/extensions/runner.ts"));
const { SessionManager } = await import(path.join(root, "src/session/session-manager.ts"));
const { EventBus } = await import(path.join(root, "src/utils/event-bus.ts"));

const runners: any[] = [];
const errors: unknown[] = [];
const componentHolder: { current?: Dashboard; close?: () => void } = {};
let renders = 0;
let streaming = true;
const bus = new EventBus();
const fakeTui = { terminal: { rows: 24 }, requestRender: () => { renders++; } };
const ui = {
  notify(message: string, kind: string) { if (kind === "error") errors.push(message); },
  custom(factory: any, options: any) {
    assert.equal(options.overlay, true);
    return new Promise<void>((resolve, reject) => {
      const component = factory(fakeTui, { fg: (_color: string, text: string) => text }, {}, () => {
        component.dispose(); resolve();
      });
      componentHolder.current = component;
      componentHolder.close = () => component.handleInput("q");
      options.signal.addEventListener("abort", () => { component.dispose(); reject(new Error("aborted")); });
    });
  },
};
function runner(loaded: any, session: any, agent: any) {
  // The registry isn't used to make requests; supply only its observational surface.
  const modelRegistry = { getAvailable: () => [], find: () => undefined };
  const instance = new ExtensionRunner(loaded.extensions, loaded.runtime, temporary, session,
    modelRegistry, undefined, undefined, undefined, undefined, agent);
  instance.initialize({}, {
    getModel: () => ({ provider: "fixture", id: "configured-preference" }),
    isIdle: () => !streaming, abort: () => { throw new Error("Plugin must never abort inference"); },
    hasPendingMessages: () => false, shutdown: () => {}, getContextUsage: () => undefined,
    compact: async () => {}, getSystemPrompt: () => [],
  }, undefined, ui, "tui");
  instance.onError((error: unknown) => { errors.push(error); });
  runners.push(instance);
  return instance;
}
try {
  const source = path.resolve("src/index.ts");
  const paths = await discoverExtensionPaths([path.resolve(".")], temporary, undefined, { ambient: false });
  assert.deepEqual(paths, [source], "The package manifest must discover exactly one extension");
  const loaded = await loadExtensions(paths, temporary, bus);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.extensions.length, 1);
  const mainSession = SessionManager.create(temporary, path.join(temporary, "sessions"));
  const main = runner(loaded, mainSession, { kind: "main", id: "Main", name: "main", depth: 0 });
  await main.emit({ type: "session_start" });
  const open = main.getCommand("agent-tree").handler("", main.createCommandContext());
  await Promise.resolve();
  const dashboard = componentHolder.current!;
  assert.ok(dashboard);
  assert.ok(main.getShortcuts().has("ctrl+shift+t"));
  await main.emit({ type: "agent_start" });
  const request = { untouched: "request fixture" };
  assert.equal(await main.emitBeforeProviderRequest(request, { provider: "observed", id: "main-model" }), request);
  await main.emit({ type: "tool_execution_start", toolCallId: "spawn", toolName: "task", args: {} });
  const childLoaded = await bindPreparedExtensions(loaded.preparedExtensions, temporary, new EventBus());
  assert.deepEqual(childLoaded.errors, []);
  const childSession = SessionManager.create(temporary, path.join(temporary, "sessions"));
  const child = runner(childLoaded, childSession, { kind: "sub", id: "child", name: "runtime-name", depth: 1, parentId: "Main" });
  await child.emit({ type: "session_start" });
  bus.emit("task:subagent:lifecycle", { id: "child", agent: "runtime-name", status: "started", parentToolCallId: "spawn", sessionFile: childSession.getSessionFile() });
  await Promise.resolve();
  await child.emit({ type: "agent_start" });
  assert.equal(await child.emitBeforeProviderRequest(request, { provider: "observed", id: "child-model" }), request);
  await child.emit({ type: "tool_execution_start", toolCallId: "read-1", toolName: "read", args: { private: "ignored" } });
  await child.emit({ type: "tool_execution_start", toolCallId: "read-2", toolName: "read", args: {} });
  assert.equal(dashboard.store.nodes.get("child")?.model, "observed/child-model");
  assert.equal(dashboard.store.nodes.get("child")?.parentId, "Main");
  assert.equal(dashboard.store.nodes.get("child")?.tools.size, 2);
  assert.equal(dashboard.store.nodes.get("Main")?.model, "observed/main-model");
  // Events continue to flow through real runners while the dashboard command is pending.
  await Bun.sleep(120);
  assert.ok(renders > 0);
  assert.ok(dashboard.render(80).join("\n").includes("runtime-name"));
  await child.emit({ type: "tool_execution_end", toolCallId: "read-1", toolName: "read", result: { content: [] }, isError: false });
  assert.equal(dashboard.store.nodes.get("child")?.tools.size, 1);
  componentHolder.close!();
  await open;
  assert.equal(streaming, true);
  streaming = false;
  await child.emit({ type: "agent_end", messages: [] });
  bus.emit("task:subagent:lifecycle", { id: "child", status: "completed", parentToolCallId: "spawn", sessionFile: childSession.getSessionFile() });
  await Promise.resolve();
  assert.equal(dashboard.store.nodes.get("child")?.state, "completed");
  assert.deepEqual(errors, []);
  console.log(`OMP ${pkg.version}: real loader, factory rebinding, parent/file correlation, request model observation, concurrent tools, live redraw and cleanup passed.`);
} finally {
  for (const instance of runners.reverse()) {
    await instance.emit({ type: "session_shutdown" });
    instance.clearManagedTimers(); instance.disposeFileFallbacks();
  }
  await rm(temporary, { recursive: true, force: true });
}
