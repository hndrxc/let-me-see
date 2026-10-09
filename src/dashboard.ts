import type { HostComponent, HostTheme } from "./host.ts";
import { type AgentNode, TreeStore, terminal } from "./store.ts";
import { clean, clip, pad, wrap } from "./text.ts";

interface Row { node: AgentNode; prefix: string; unresolved: boolean; }
/** OMP enables Kitty keyboard input; accept CSI-u as well as legacy sequences. */
export function normalizeKey(data: string): string {
  const kitty = /^\x1b\[(\d+)(?::\d+)?(?:;(\d+)(?::(\d+))?)?u$/.exec(data);
  if (!kitty) return data;
  const code = Number(kitty[1]), modifiers = Number(kitty[2] ?? 1);
  if (kitty[3] === "3") return ""; // Key release.
  if (code === 99 && modifiers === 5) return "\x03";
  if (modifiers > 2) return "";
  const special: Record<number, string> = { 57352: "\x1b[A", 57353: "\x1b[B", 57350: "\x1b[D", 57351: "\x1b[C", 57354: "\x1b[5~", 57355: "\x1b[6~", 57356: "\x1b[H", 57357: "\x1b[F" };
  if (special[code]) return special[code]!;
  if (!Number.isInteger(code) || code > 0x10ffff) return "";
  const key = String.fromCodePoint(code);
  return modifiers === 2 ? key.toUpperCase() : key;
}
export function treeRows(store: TreeStore, collapsed: Set<string>): Row[] {
  const nodes = [...store.nodes.values()];
  const children = new Map<string, AgentNode[]>();
  for (const node of nodes) if (node.parentId && store.nodes.has(node.parentId)) {
    const group = children.get(node.parentId) ?? [];
    group.push(node); children.set(node.parentId, group);
  }
  const seen = new Set<string>();
  const rows: Row[] = [];
  const visit = (node: AgentNode, prefix: string, connector: string, unresolved: boolean): void => {
    if (seen.has(node.id)) return;
    seen.add(node.id);
    rows.push({ node, prefix: prefix + connector, unresolved });
    if (collapsed.has(node.id)) return;
    const group = children.get(node.id) ?? [];
    for (const [index, child] of group.entries()) {
      const last = index === group.length - 1;
      // Cap indentation to keep names legible for deeply nested trees.
      visit(child, (prefix + (connector ? (connector === "└─ " ? "   " : "│  ") : "")).slice(-24), last ? "└─ " : "├─ ", false);
    }
  };
  const roots = nodes.filter(n => !n.parentId || !store.nodes.has(n.parentId));
  roots.sort((a, b) => Number(b.kind === "main") - Number(a.kind === "main"));
  for (const node of roots) visit(node, "", "", node.kind !== "main");
  // Collapsed descendants must stay hidden; only use the fallback for actual cycles.
  const underCollapsed = (node: AgentNode): boolean => {
    const walked = new Set<string>();
    let parent = node.parentId;
    while (parent && !walked.has(parent)) {
      if (collapsed.has(parent)) return true;
      walked.add(parent); parent = store.nodes.get(parent)?.parentId;
    }
    return false;
  };
  for (const node of nodes) if (!seen.has(node.id) && !underCollapsed(node)) visit(node, "", "", true);
  return rows;
}

export function elapsed(node: AgentNode, now: number): string {
  if (node.startedAt === undefined) return "unknown";
  const seconds = Math.max(0, Math.floor(((node.endedAt ?? now) - node.startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export class Dashboard implements HostComponent {
  selectedId: string | undefined;
  readonly collapsed = new Set<string>();
  private top = 0;
  private detailTop = 0;
  private detailFocus = false;
  private showDetails = true;
  private pageSize = 5;
  private disposed = false;

  constructor(readonly store: TreeStore, private readonly height: () => number,
    private readonly redraw: () => void, private readonly close: () => void,
    private readonly theme?: HostTheme, private readonly now: () => number = Date.now) {}

  invalidate(): void {}
  dispose(): void { this.disposed = true; }
  handleInput(data: string): void {
    if (this.disposed) return;
    data = normalizeKey(data);
    if (["q", "\x1b", "\x03"].includes(data)) { this.close(); return; }
    const rows = treeRows(this.store, this.collapsed);
    let index = Math.max(0, rows.findIndex(r => r.node.id === this.selectedId));
    const movement = ["\x1b[A", "\x1bOA", "k"].includes(data) ? -1 :
      ["\x1b[B", "\x1bOB", "j"].includes(data) ? 1 :
      data === "\x1b[5~" ? -this.pageSize : data === "\x1b[6~" ? this.pageSize : 0;
    if (movement) {
      if (this.detailFocus) this.detailTop = Math.max(0, this.detailTop + movement);
      else { index = Math.max(0, Math.min(rows.length - 1, index + movement)); this.detailTop = 0; }
    }
    if (data === "g" || data === "\x1b[H") { index = 0; this.detailTop = 0; }
    if (data === "G" || data === "\x1b[F") index = Math.max(0, rows.length - 1);
    if (data === "\t") this.detailFocus = !this.detailFocus;
    if (data === "\r" || data === "\n" || data === "d") this.showDetails = !this.showDetails;
    const node = rows[index]?.node;
    if (node && [" ", "\x1b[D", "h"].includes(data)) {
      if (this.collapsed.has(node.id) && data === " ") this.collapsed.delete(node.id);
      else this.collapsed.add(node.id);
    }
    if (node && ["\x1b[C", "l"].includes(data)) this.collapsed.delete(node.id);
    if (data === "c") {
      const complete = [...this.store.nodes.values()].filter(n => terminal(n.state));
      const collapse = complete.some(n => !this.collapsed.has(n.id));
      for (const n of complete) if (collapse) this.collapsed.add(n.id); else this.collapsed.delete(n.id);
    }
    this.selectedId = node?.id;
    this.redraw();
  }

  render(columns: number): string[] {
    const w = Math.max(1, Math.floor(columns));
    const h = Math.max(1, Math.floor(this.height()));
    const rows = treeRows(this.store, this.collapsed);
    let index = rows.findIndex(r => r.node.id === this.selectedId);
    if (index < 0) { index = 0; this.selectedId = rows[0]?.node.id; }
    const selected = rows[index]?.node;
    const title = ` Agent tree · ${this.store.nodes.size} agents · ${[...this.store.nodes.values()].filter(n => n.state === "running").length} running`;
    const footer = this.detailFocus ? " Tab tree · ↑↓ scroll details · q close" : " ↑↓ select · Space fold · c completed · Tab details · Enter hide · q close";
    if (w < 3) return [clip(title, w), ...rows.slice(index).map(r => clip(r.node.name, w)), clip(footer, w)].slice(0, h);
    if (h < 4) return [clip(title, w), ...rows.slice(index, index + Math.max(0, h - 2)).map(r => clip(`${r.node.name} [${r.node.state}]`, w)), clip(footer, w)].slice(0, h);
    const inner = Math.max(1, w - 2);
    const bodyHeight = h - 3;
    const sideBySide = this.showDetails && w >= 100;
    const detailHeight = this.showDetails && !sideBySide ? Math.min(Math.floor(bodyHeight / 2), 9) : 0;
    const logHeight = h >= 16 ? 3 : 0;
    const treeHeight = Math.max(1, bodyHeight - detailHeight - logHeight);
    const treeWidth = sideBySide ? Math.max(40, Math.floor((inner - 3) * 0.55)) : inner;
    const detailWidth = sideBySide ? inner - treeWidth - 3 : inner;
    this.pageSize = treeHeight;
    if (index < this.top) this.top = index;
    if (index >= this.top + treeHeight) this.top = index - treeHeight + 1;
    this.top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - treeHeight)));
    const treeLines = rows.slice(this.top, this.top + treeHeight).map(r => this.row(r, treeWidth, r.node.id === this.selectedId));
    if (!treeLines.length) treeLines.push(clip("Waiting for runtime events…", treeWidth));
    while (treeLines.length < treeHeight) treeLines.push("");
    const details = selected ? this.details(selected, detailWidth) : ["No agent selected"];
    const body: string[] = [];
    if (sideBySide) {
      this.detailTop = Math.min(this.detailTop, Math.max(0, details.length - treeHeight));
      for (let i = 0; i < treeHeight; i++) body.push(`${pad(treeLines[i] ?? "", treeWidth)} │ ${details[this.detailTop + i] ?? ""}`);
    } else {
      body.push(...treeLines);
      if (detailHeight) {
        this.detailTop = Math.min(this.detailTop, Math.max(0, details.length - detailHeight));
        for (let i = 0; i < detailHeight; i++) body.push(details[this.detailTop + i] ?? "");
      }
    }
    if (logHeight) {
      body.push(clip("Activity", inner));
      for (const activity of this.store.activity.slice(-logHeight + 1)) body.push(clip(`${this.time(activity.timestamp)} ${activity.agentId}: ${activity.text}`, inner));
    }
    while (body.length < bodyHeight) body.push("");
    return [this.color("accent", clip(title, w)), clip("─".repeat(w), w),
      ...body.slice(0, bodyHeight).map(line => ` ${line}`), this.color("muted", clip(footer, w))].slice(0, h);
  }

  private row(row: Row, width: number, selected: boolean): string {
    const node = row.node;
    const name = this.store.options.labels?.[node.id] ?? node.name;
    const fold = this.collapsed.has(node.id) ? "+" : "−";
    const relation = node.relation === "consultation" ? " ~consultation" : "";
    const orphan = row.unresolved ? ` ?parent:${node.parentId ?? "unknown"}` : "";
    const tools = [...node.tools.values()].map(t => t.name).join(", ") || "—";
    const model = node.model ?? "unknown";
    const lead = `${selected ? "▶" : " "} ${row.prefix}${fold} ${name}`;
    const text = width < 58 ? `${lead} [${node.state}] ${elapsed(node, this.now())} ${model} tool:${tools}${relation}${orphan}` :
      `${lead} [${node.state}] ${model} · ${tools} · ${elapsed(node, this.now())}${relation}${orphan}`;
    return this.color(node.state === "running" ? "accent" : node.state === "failed" ? "error" : node.state === "cancelled" ? "warning" : node.state === "completed" ? "success" : "muted", clip(text, width), node.state);
  }
  private details(node: AgentNode, width: number): string[] {
    const lines = [`Details${this.detailFocus ? " (scroll ↑↓)" : ""}: ${node.name}`, `ID: ${node.id}`, `Parent: ${node.parentId ?? (node.kind === "main" ? "root" : "unknown")}`,
      `Session: ${node.sessionId}`, `Model observed: ${node.model ?? "unknown"}`,
      `State: ${node.state} · ${elapsed(node, this.now())}`, `Tools: ${[...node.tools.entries()].map(([id, t]) => `${t.name} (${id})`).join(", ") || "none"}`, "Task:"];
    const result = [...lines.map(s => clip(s, width)), ...wrap(node.task ?? "unknown (no task summary telemetry)", width), clip("Recent activity:", width)];
    for (const activity of node.history) result.push(clip(`${this.time(activity.timestamp)} ${activity.text}`, width));
    return result;
  }
  private time(timestamp: number): string { return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false }); }
  private color(color: Parameters<HostTheme["fg"]>[0], text: string, state?: AgentNode["state"]): string {
    const override = state ? this.store.options.colors?.[state] : undefined;
    const allowed = ["accent", "success", "warning", "error", "dim", "muted"];
    const actual = override && allowed.includes(override) ? override as typeof color : color;
    return this.theme?.fg(actual, clean(text)) ?? clean(text);
  }
}
