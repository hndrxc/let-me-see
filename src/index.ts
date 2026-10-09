import { Collector } from "./collector.ts";
import { Dashboard } from "./dashboard.ts";
import type { HostAPI, HostContext } from "./host.ts";
import { SessionRegistry } from "./registry.ts";
import type { TreeOptions } from "./store.ts";

export { publishTelemetry, TELEMETRY_CHANNEL } from "./events.ts";
export type { TreeEvent, EventPayload } from "./events.ts";
export type { TreeOptions } from "./store.ts";

export function createAgentTreeExtension(options: TreeOptions = {}): (pi: HostAPI) => void {
  // Shared module state is isolated by root session identity inside this registry.
  const registry = new SessionRegistry(options);
  return pi => {
    let overlay: AbortController | undefined;
    const closeOverlay = () => { overlay?.abort(); overlay = undefined; };
    const collector = new Collector(pi, registry, closeOverlay);
    const open = async (ctx: HostContext): Promise<void> => {
      if (ctx.agent.kind !== "main") return;
      if (ctx.mode !== "tui" || !ctx.hasUI) {
        ctx.ui.notify("Agent tree requires OMP's interactive terminal mode.", "info");
        return;
      }
      const store = collector.ensure(ctx).root;
      if (!store || overlay) return;
      const controller = new AbortController();
      overlay = controller;
      let timer: unknown;
      try {
        await ctx.ui.custom<void>((tui, theme, _bindings, done) => {
          let dirty = true;
          let lastClock = 0;
          const unsubscribe = store.subscribe(() => { dirty = true; });
          const dashboard = new Dashboard(store, () => Math.max(1, tui.terminal.rows - 2),
            () => tui.requestRender(), () => done(), theme);
          const dispose = dashboard.dispose.bind(dashboard);
          let disposed = false;
          dashboard.dispose = () => {
            if (disposed) return;
            disposed = true; unsubscribe(); dispose();
            if (timer !== undefined) { ctx.clearTimer(timer); timer = undefined; }
          };
          // Coalesce event bursts; animate every tick or refresh at least once a second.
          timer = ctx.setInterval(() => {
            const now = Date.now();
            if (dirty || dashboard.isAnimating() || now - lastClock >= 1000) {
              dirty = false;
              lastClock = now;
              tui.requestRender();
            }
          }, 100);
          return dashboard;
        }, { overlay: true, overlayOptions: { width: "100%", maxHeight: "100%", anchor: "center", margin: 1 }, signal: controller.signal });
      } catch (error) {
        if (!controller.signal.aborted) ctx.ui.notify(`Agent tree could not open: ${String(error)}`, "error");
      } finally {
        if (timer !== undefined) ctx.clearTimer(timer);
        if (overlay === controller) overlay = undefined;
      }
    };
    pi.registerCommand("agent-tree", { description: "Open the live agent tree", handler: async (_args, ctx) => { await open(ctx); } });
    pi.registerShortcut("ctrl+shift+t", { description: "Open agent tree while inference continues", handler: open });
    pi.on("session_shutdown", (_event, ctx) => {
      closeOverlay();
      const binding = collector.binding;
      if (binding && ctx.agent.kind === "main" && binding.root) registry.releaseRoot(binding.root);
      collector.dispose();
    });
  };
}

export default createAgentTreeExtension();
