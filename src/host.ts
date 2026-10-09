import type { TelemetryBus } from "./events.ts";

/** Minimal structural subset of OMP 18.8.6's ExtensionAPI; no private host imports. */
export interface HostContext {
  agent: { id: string; name: string; kind: "main" | "sub"; parentId?: string; depth: number };
  sessionManager: {
    getSessionId(): string;
    getSessionFile(): string | undefined;
    getHeader(): { parentSession?: string } | null;
  };
  model: { provider: string; id: string } | undefined;
  mode: string;
  hasUI: boolean;
  isIdle(): boolean;
  setInterval(callback: () => void, ms: number): unknown;
  clearTimer(timer: unknown): void;
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void;
    custom<T>(factory: (tui: HostTui, theme: HostTheme, bindings: unknown, done: (value: T) => void) => HostComponent,
      options: { overlay: boolean; overlayOptions: { width: `${number}%`; maxHeight: `${number}%`; anchor: "center"; margin: number }; signal: AbortSignal }): Promise<T>;
  };
}
export interface HostTui { terminal: { rows: number }; requestRender(): void; }
export interface HostTheme { fg(color: "accent" | "success" | "warning" | "error" | "dim" | "muted", text: string): string; }
export interface HostComponent { render(width: number): string[]; handleInput(data: string): void; invalidate(): void; dispose(): void; }
export interface HostAPI {
  on(name: string, handler: (event: Record<string, unknown>, ctx: HostContext) => void): void;
  registerCommand(name: string, options: { description: string; handler(args: string, ctx: HostContext): Promise<void> }): void;
  registerShortcut(key: "ctrl+shift+t", options: { description: string; handler(ctx: HostContext): Promise<void> }): void;
  events: TelemetryBus;
}
