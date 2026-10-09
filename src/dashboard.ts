import { Canvas, type CellStyle } from "./canvas.ts";
import type { HostColor, HostComponent, HostTheme } from "./host.ts";
import type { AgentState } from "./events.ts";
import { type Activity, type AgentNode, TreeStore, terminal } from "./store.ts";
import { clean, clip, pad, width, wrap } from "./text.ts";

export interface Row { node: AgentNode; prefix: string; unresolved: boolean; }

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

const SPINNERS = ["◐", "◓", "◑", "◒"] as const;

function nodePhase(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(hash);
}

function stateGlyph(node: AgentNode, frame: number): string {
  if (node.state === "running") return SPINNERS[(frame + nodePhase(node.id)) % 4]!;
  if (node.state === "idle") return "○";
  if (node.state === "completed") return "✓";
  if (node.state === "failed") return "✗";
  if (node.state === "cancelled") return "⊘";
  return "?";
}

function tierColor(node: AgentNode): HostColor {
  if (node.kind === "main") return "accent";
  if (node.relation === "consultation") return "thinkingXhigh";
  return "thinkingLow";
}

const shortModel = (model: string | undefined): string => model ? model.split("/").pop() || model : "model unknown";
const label = (store: TreeStore, node: AgentNode): string => store.options.labels?.[node.id] ?? node.name;

function formatTools(node: AgentNode, maxNamesWidth: number): string {
  const activeCount = node.tools.size;
  const filled = Math.min(4, Math.max(0, activeCount));
  const meter = "▮".repeat(filled) + "▯".repeat(4 - filled);
  const names = [...node.tools.values()].map(t => t.name).join(", ");
  if (!names) return `tools ${meter}`;
  return `tools ${meter} ${clip(names, maxNamesWidth)}`;
}

function countFolded(store: TreeStore, parentId: string): number {
  let count = 0;
  const queue = [parentId];
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const node of store.nodes.values()) {
      if (node.parentId === current) {
        count++;
        queue.push(node.id);
      }
    }
  }
  return count;
}

function getNestedDescendants(
  store: TreeStore,
  parentId: string,
  collapsed: Set<string>,
  depth = 0
): { node: AgentNode; depth: number; isLast: boolean }[] {
  const result: { node: AgentNode; depth: number; isLast: boolean }[] = [];
  if (collapsed.has(parentId)) return result;

  const children = [...store.nodes.values()].filter(
    n => n.parentId === parentId && n.relation !== "consultation"
  );
  for (let i = 0; i < children.length; i++) {
    const child = children[i]!;
    const last = i === children.length - 1;
    result.push({ node: child, depth, isLast: last });
    if (!collapsed.has(child.id)) {
      result.push(...getNestedDescendants(store, child.id, collapsed, depth + 1));
    }
  }
  return result;
}

export class Dashboard implements HostComponent {
  selectedId: string | undefined;
  readonly collapsed = new Set<string>();
  private top = 0;
  private detailTop = 0;
  private detailFocus = false;
  private showDetails = false;
  private pageSize = 5;
  private disposed = false;

  constructor(
    readonly store: TreeStore,
    private readonly height: () => number,
    private readonly redraw: () => void,
    private readonly close: () => void,
    private readonly theme?: HostTheme,
    private readonly now: () => number = Date.now
  ) {}

  invalidate(): void {}
  dispose(): void { this.disposed = true; }

  isAnimating(): boolean {
    const t = this.now();
    if ([...this.store.nodes.values()].some(n => n.state === "running")) return true;
    if (this.store.activity.some(a => t - a.timestamp >= 0 && t - a.timestamp < 2000)) return true;
    if ([...this.store.nodes.values()].some(n => t - n.stateAt >= 0 && t - n.stateAt < 1000)) return true;
    return false;
  }

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
    if (data === "\t") {
      this.detailFocus = !this.detailFocus;
      if (this.detailFocus) this.showDetails = true;
    }
    if (data === "\r" || data === "\n" || data === "d") {
      this.showDetails = !this.showDetails;
      if (!this.showDetails) this.detailFocus = false;
    }
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
    const nowTime = this.now();
    const frame = Math.floor(nowTime / 120);

    const nodes = [...this.store.nodes.values()];
    const main = nodes.find(n => n.kind === "main") ?? nodes[0];
    const consultations = nodes.filter(n => n.relation === "consultation");

    const modelShort = (main?.model ? shortModel(main.model) : main ? label(this.store, main) : "AGENT").toUpperCase();

    const stateWord = main?.state === "running" ? "WORKING" :
      main?.state === "idle" ? "IDLE" :
      main?.state === "completed" ? "DONE" :
      main?.state === "failed" ? "FAILED" :
      main?.state === "cancelled" ? "CANCELLED" : "UNKNOWN";

    let consultName = "";
    if (consultations.length > 0) {
      consultName = label(this.store, consultations[0]!).toUpperCase();
    }

    const titlePlain = `AGENT TREE · ${modelShort} ${stateWord}${consultName ? ` · ${consultName} ON CALL` : ""}`;
    const footerPlain = this.detailFocus
      ? "Tab tree · ↑↓ scroll details · Enter hide · q close"
      : "↑↓ select · Space fold · c completed · Enter details · Tab focus · q close";

    if (h === 1) return [this.color("accent", clip(titlePlain, w))];
    if (h === 2) return [this.color("accent", clip(titlePlain, w)), this.color("muted", clip(footerPlain, w))];

    // Compact animated fallback for narrow or very short terminals
    if (w < 40 || h < 12) {
      const rows = treeRows(this.store, this.collapsed);
      let index = rows.findIndex(r => r.node.id === this.selectedId);
      if (index < 0) { index = 0; this.selectedId = rows[0]?.node.id; }
      const listHeight = Math.max(1, h - 3);
      if (index < this.top) this.top = index;
      if (index >= this.top + listHeight) this.top = index - listHeight + 1;
      this.top = Math.max(0, Math.min(this.top, Math.max(0, rows.length - listHeight)));
      this.pageSize = listHeight;

      const listLines: string[] = [];
      for (let i = 0; i < listHeight; i++) {
        const row = rows[this.top + i];
        if (!row) { listLines.push(""); continue; }
        const isSelected = row.node.id === this.selectedId;
        const lead = isSelected ? "▶" : " ";
        const fold = this.collapsed.has(row.node.id) ? "+" : "−";
        const glyph = stateGlyph(row.node, frame);
        const el = elapsed(row.node, nowTime);
        const text = clip(`${lead} ${row.prefix}${fold} ${label(this.store, row.node)} [${row.node.state}] ${glyph} ${el}`, w);
        listLines.push(this.color(tierColor(row.node), text, row.node.state));
      }

      return [
        this.color("accent", clip(titlePlain, w)),
        this.color("dim", clip("═".repeat(w), w)),
        ...listLines,
        this.color("muted", clip(footerPlain, w)),
      ].slice(0, h);
    }

    // Boxed diagram mode
    const screenCanvas = new Canvas(w, h);

    // 1. Title, centered, uppercase, bold
    const titlePfx = "AGENT TREE";
    const titleSep = " · ";
    const titleMain = `${modelShort} ${stateWord}`;
    const titleConsult = consultName ? `${consultName} ON CALL` : "";
    const totalTitleWidth = width(titlePfx + titleSep + titleMain + (consultName ? titleSep + titleConsult : ""));
    const titleStartX = Math.max(0, Math.floor((w - totalTitleWidth) / 2));
    let curX = titleStartX;
    curX = screenCanvas.text(curX, 0, titlePfx, { fg: "accent", bold: true });
    curX = screenCanvas.text(curX, 0, titleSep, { fg: "dim", bold: true });
    curX = screenCanvas.text(curX, 0, titleMain, { fg: "accent", bold: true });
    if (consultName) {
      curX = screenCanvas.text(curX, 0, titleSep, { fg: "dim", bold: true });
      screenCanvas.text(curX, 0, titleConsult, { fg: "thinkingXhigh", bold: true });
    }

    // 2. Rule: ═ across the width, dim
    screenCanvas.hline(0, 1, w, "═", { fg: "dim" });

    // 3. Legend
    const subagents = nodes.filter(n => n.kind !== "main" && n.relation !== "consultation");
    const runningSubagents = subagents.filter(n => n.state === "running").length;
    const totalSubagents = subagents.length;
    // Drop words before clipping so narrow terminals never cut a legend entry mid-word.
    const wide = 5 + width(` main · ${main?.state ?? "unknown"}   subagents · ${runningSubagents}/${totalSubagents} running`) + (consultations.length ? 4 + width(` consultations · ${consultations.length}`) : 0) <= w - 2;
    const legendMain = wide ? ` main · ${main?.state ?? "unknown"}` : " main";
    const legendSub = wide ? ` subagents · ${runningSubagents}/${totalSubagents} running` : ` subagents ${runningSubagents}/${totalSubagents}`;
    const legendConsult = consultations.length > 0 ? (wide ? ` consultations · ${consultations.length}` : ` consult ${consultations.length}`) : "";
    const totalLegendWidth = width(`■${legendMain}   ■${legendSub}${legendConsult ? `   ■${legendConsult}` : ""}`);
    let legX = Math.max(1, Math.floor((w - totalLegendWidth) / 2));
    legX = screenCanvas.text(legX, 2, "■", { fg: "accent" });
    legX = screenCanvas.text(legX, 2, legendMain + "   ", { fg: "muted" });
    legX = screenCanvas.text(legX, 2, "■", { fg: "thinkingLow" });
    legX = screenCanvas.text(legX, 2, legendSub, { fg: "muted" });
    if (consultations.length > 0) {
      legX = screenCanvas.text(legX, 2, "   ", { fg: "muted" });
      legX = screenCanvas.text(legX, 2, "■", { fg: "thinkingXhigh" });
      screenCanvas.text(legX, 2, legendConsult, { fg: "muted" });
    }

    // 6. Status line at h - 2
    const totalAgentsCount = nodes.length;
    const runningAgentsCount = nodes.filter(n => n.state === "running").length;
    const directChildren = nodes.filter(n => n.parentId === main?.id && n.relation !== "consultation");
    const returnedDirectSubagents = directChildren.filter(n => terminal(n.state)).length;
    const totalToolsCount = nodes.reduce((sum, n) => sum + n.tools.size, 0);

    let statX = 1;
    statX = screenCanvas.text(statX, h - 2, "agents ", { fg: "dim" });
    statX = screenCanvas.text(statX, h - 2, `[${totalAgentsCount}]`, { fg: "muted", bold: true });
    statX = screenCanvas.text(statX, h - 2, "  running ", { fg: "dim" });
    statX = screenCanvas.text(statX, h - 2, `[${runningAgentsCount}]`, { fg: "accent", bold: true });
    statX = screenCanvas.text(statX, h - 2, "  subagents ", { fg: "dim" });
    statX = screenCanvas.text(statX, h - 2, `[${returnedDirectSubagents}/${directChildren.length} returned]`, { fg: "thinkingLow", bold: true });
    statX = screenCanvas.text(statX, h - 2, "  consultations ", { fg: "dim" });
    statX = screenCanvas.text(statX, h - 2, `[${consultations.length}]`, { fg: "thinkingXhigh", bold: true });
    statX = screenCanvas.text(statX, h - 2, "  tools ", { fg: "dim" });
    screenCanvas.text(statX, h - 2, `[${totalToolsCount}]`, { fg: "muted", bold: true });

    // 7. Hint line at h - 1
    screenCanvas.text(1, h - 1, footerPlain, { fg: "muted" });

    // Middle area calculation (diagram viewport and session log / details box)
    const middleHeight = (h - 3) - 3; // rows 3 to h-3 inclusive
    let detailBoxHeight = 0;
    let logBoxHeight = 0;
    let logEntryCount = 0;

    if (this.showDetails) {
      const maxDetail = Math.max(4, middleHeight - 5);
      detailBoxHeight = Math.min(Math.floor(h / 2), maxDetail);
    } else {
      if (h >= 34) { logEntryCount = 4; logBoxHeight = 6; }
      else if (h >= 26) { logEntryCount = 2; logBoxHeight = 4; }
    }

    const diagramViewportHeight = Math.max(1, middleHeight - (this.showDetails ? detailBoxHeight : logBoxHeight));
    const bottomBoxY = 3 + diagramViewportHeight;

    // Render Session Log or Details Box
    if (this.showDetails) {
      const rows = treeRows(this.store, this.collapsed);
      const selectedNode = rows.find(r => r.node.id === this.selectedId)?.node ?? main;
      const headerLabel = `details · ${selectedNode ? label(this.store, selectedNode) : "none"}${this.detailFocus ? " (scroll ↑↓)" : ""}`;
      const headerText = `┌─┤ ${headerLabel} ├`;
      screenCanvas.text(0, bottomBoxY, headerText, { fg: "dim" });
      const fillLen = Math.max(0, w - width(headerText) - 1);
      screenCanvas.hline(width(headerText), bottomBoxY, fillLen, "─", { fg: "dim" });
      screenCanvas.set(w - 1, bottomBoxY, "┐", { fg: "dim" });

      const detailContentLines: string[] = [];
      if (selectedNode) {
        detailContentLines.push(`ID: ${selectedNode.id}`);
        detailContentLines.push(`Parent: ${selectedNode.parentId ?? (selectedNode.kind === "main" ? "root" : "unknown")}`);
        detailContentLines.push(`Session: ${selectedNode.sessionId}`);
        detailContentLines.push(`Model observed: ${selectedNode.model ?? "unknown"}`);
        detailContentLines.push(`State: ${selectedNode.state} · ${elapsed(selectedNode, nowTime)}`);
        const toolList = [...selectedNode.tools.entries()].map(([id, t]) => `${t.name} (${id})`).join(", ");
        detailContentLines.push(`Tools: ${toolList || "none"}`);
        detailContentLines.push("Task:");
        for (const tl of wrap(selectedNode.task ?? "unknown (no task summary telemetry)", w - 4)) {
          detailContentLines.push(`  ${tl}`);
        }
        detailContentLines.push("Recent activity:");
        for (const a of selectedNode.history) {
          detailContentLines.push(`  ${this.time(a.timestamp)} ${a.text}`);
        }
      } else {
        detailContentLines.push("No agent selected");
      }

      const visibleDetailRows = detailBoxHeight - 2;
      this.detailTop = Math.max(0, Math.min(this.detailTop, Math.max(0, detailContentLines.length - visibleDetailRows)));
      for (let i = 0; i < visibleDetailRows; i++) {
        const lineY = bottomBoxY + 1 + i;
        screenCanvas.set(0, lineY, "│", { fg: "dim" });
        screenCanvas.text(2, lineY, clip(detailContentLines[this.detailTop + i] ?? "", w - 4));
        screenCanvas.set(w - 1, lineY, "│", { fg: "dim" });
      }
      screenCanvas.box(0, bottomBoxY + detailBoxHeight - 1, w, 1, { fg: "dim" });
      screenCanvas.set(0, bottomBoxY + detailBoxHeight - 1, "└", { fg: "dim" });
      screenCanvas.set(w - 1, bottomBoxY + detailBoxHeight - 1, "┘", { fg: "dim" });
    } else if (logBoxHeight > 0) {
      const headerText = "┌─┤ session log ├";
      screenCanvas.text(0, bottomBoxY, headerText, { fg: "dim" });
      const fillLen = Math.max(0, w - width(headerText) - 1);
      screenCanvas.hline(width(headerText), bottomBoxY, fillLen, "─", { fg: "dim" });
      screenCanvas.set(w - 1, bottomBoxY, "┐", { fg: "dim" });

      const entries = this.store.activity.slice(-logEntryCount);
      const emptyCount = logEntryCount - entries.length;
      for (let i = 0; i < emptyCount; i++) {
        const lineY = bottomBoxY + 1 + i;
        screenCanvas.set(0, lineY, "│", { fg: "dim" });
        screenCanvas.set(w - 1, lineY, "│", { fg: "dim" });
      }
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i]!;
        const lineY = bottomBoxY + 1 + emptyCount + i;
        const timeStr = this.time(entry.timestamp);
        const node = this.store.nodes.get(entry.agentId);
        const agentName = this.store.options.labels?.[entry.agentId] ?? node?.name ?? entry.agentId;
        const tierCol = node ? tierColor(node) : "dim";
        const isRecent = nowTime - entry.timestamp < 1500;

        screenCanvas.set(0, lineY, "│", { fg: "dim" });
        screenCanvas.text(2, lineY, timeStr, { fg: "dim", bold: isRecent });
        screenCanvas.text(12, lineY, pad(clip(agentName, 12), 12), { fg: tierCol, bold: true });
        screenCanvas.text(26, lineY, clip(entry.text, w - 28), { bold: isRecent });
        screenCanvas.set(w - 1, lineY, "│", { fg: "dim" });
      }
      screenCanvas.box(0, bottomBoxY + logBoxHeight - 1, w, 1, { fg: "dim" });
      screenCanvas.set(0, bottomBoxY + logBoxHeight - 1, "└", { fg: "dim" });
      screenCanvas.set(w - 1, bottomBoxY + logBoxHeight - 1, "┘", { fg: "dim" });
    }

    // Virtual Diagram Viewport Construction
    const rows = treeRows(this.store, this.collapsed);
    let index = rows.findIndex(r => r.node.id === this.selectedId);
    if (index < 0) { index = 0; this.selectedId = rows[0]?.node.id; }

    const isRunning = nodes.some(n => n.state === "running");
    const nodeBounds = new Map<string, { topY: number; bottomY: number }>();

    const hasSideConsult = w >= 100 && consultations.length > 0;
    const consultColWidth = hasSideConsult ? Math.min(28, Math.max(24, Math.floor(w * 0.23))) : 0;
    const arrowGap = hasSideConsult ? Math.min(12, Math.max(8, Math.floor((w - consultColWidth - 42) / 3))) : 0;
    const mainAreaLeft = hasSideConsult ? consultColWidth + arrowGap : 0;
    const mainAreaWidth = w - mainAreaLeft;

    const mainBoxWidth = Math.min(mainAreaWidth - 4, 38);
    const mainBoxX = mainAreaLeft + Math.floor((mainAreaWidth - mainBoxWidth) / 2);
    const mainBoxY = 0;
    const mainBoxHeight = (main && this.collapsed.has(main.id)) ? 7 : 6;
    if (main) nodeBounds.set(main.id, { topY: mainBoxY, bottomY: mainBoxY + mainBoxHeight - 1 });

    const isMainCollapsed = !main || this.collapsed.has(main.id);
    const trunkX = mainBoxX + Math.floor(mainBoxWidth / 2);

    let flowCursorY = mainBoxY + mainBoxHeight;
    let trunkY1 = 0, trunkY2 = 0, delLabelY = 0, delTrunkY = 0, busY = 0, arrowY = 0;

    interface GridRowLayout {
      y: number;
      boxHeight: number;
      children: AgentNode[];
      boxWidth: number;
      boxes: { child: AgentNode; x: number; centerX: number; nested: { node: AgentNode; prefix: string; isFolded?: boolean }[] }[];
    }
    const childGridLayout: GridRowLayout[] = [];
    let mergeBusY = 0;
    let returnBoxY = 0;

    if (!isMainCollapsed && directChildren.length > 0) {
      trunkY1 = flowCursorY;
      trunkY2 = trunkY1 + 1;
      delLabelY = trunkY2 + 1;
      delTrunkY = delLabelY + 1;
      busY = delTrunkY + 1;
      arrowY = busY + 1;
      flowCursorY = arrowY + 1;

      const N = directChildren.length;
      const colsPerRow = Math.max(1, Math.min(N, Math.floor((mainAreaWidth - 2) / 22)));
      const numGridRows = Math.ceil(N / colsPerRow);

      for (let r = 0; r < numGridRows; r++) {
        const rowChildren = directChildren.slice(r * colsPerRow, (r + 1) * colsPerRow);
        const k = rowChildren.length;
        const boxWidth = Math.min(32, Math.max(19, Math.floor((mainAreaWidth - (k + 1) * 2) / k)));
        const leftMargin = mainAreaLeft + Math.floor((mainAreaWidth - (k * boxWidth + (k - 1) * 2)) / 2);

        let maxContent = 5;
        const boxes: GridRowLayout["boxes"] = [];

        for (let i = 0; i < k; i++) {
          const child = rowChildren[i]!;
          const boxX = leftMargin + i * (boxWidth + 2);
          const childCenterX = boxX + Math.floor(boxWidth / 2);
          const nested: { node: AgentNode; prefix: string; isFolded?: boolean }[] = [];

          if (this.collapsed.has(child.id)) {
            const foldedCount = countFolded(this.store, child.id);
            if (foldedCount > 0) nested.push({ node: child, prefix: "", isFolded: true });
          } else {
            const descs = getNestedDescendants(this.store, child.id, this.collapsed);
            for (const d of descs) {
              const isSelected = d.node.id === this.selectedId;
              const indent = " ".repeat(Math.min(6, d.depth * 2));
              const conn = d.isLast ? "└" : "├";
              const pfx = isSelected ? `${indent}${conn}▶` : `${indent}${conn}─`;
              nested.push({ node: d.node, prefix: pfx });
            }
          }
          if (5 + nested.length > maxContent) maxContent = 5 + nested.length;
          boxes.push({ child, x: boxX, centerX: childCenterX, nested });
        }

        const boxHeight = maxContent + 2;
        childGridLayout.push({ y: flowCursorY, boxHeight, children: rowChildren, boxWidth, boxes });
        flowCursorY += boxHeight;
      }

      mergeBusY = flowCursorY;
      const returnTrunkY = mergeBusY + 1;
      returnBoxY = returnTrunkY + 1;
      flowCursorY = returnBoxY + 4;
    }

    // Consultations grid if narrow
    let consultGridHeaderY = 0;
    const narrowConsultBoxes: { consult: AgentNode; x: number; y: number; w: number; h: number }[] = [];
    if (!hasSideConsult && consultations.length > 0) {
      consultGridHeaderY = flowCursorY + 1;
      flowCursorY = consultGridHeaderY + 1;
      const k = Math.max(1, Math.min(consultations.length, Math.floor((w - 2) / 24)));
      const boxW = Math.min(32, Math.max(20, Math.floor((w - (k + 1) * 2) / k)));
      const leftMargin = Math.floor((w - (k * boxW + (k - 1) * 2)) / 2);
      for (let i = 0; i < consultations.length; i++) {
        const c = consultations[i]!;
        const cRow = Math.floor(i / k);
        const cCol = i % k;
        const bx = leftMargin + cCol * (boxW + 2);
        const by = flowCursorY + cRow * 8;
        narrowConsultBoxes.push({ consult: c, x: bx, y: by, w: boxW, h: 7 });
        nodeBounds.set(c.id, { topY: by, bottomY: by + 6 });
      }
      flowCursorY += Math.ceil(consultations.length / k) * 8;
    }

    // Unresolved nodes grid
    const unresolvedRows = rows.filter(r => r.unresolved);
    let unresolvedHeaderY = 0;
    const unresolvedBoxes: { node: AgentNode; x: number; y: number; w: number; h: number }[] = [];
    if (unresolvedRows.length > 0) {
      unresolvedHeaderY = flowCursorY + 1;
      flowCursorY = unresolvedHeaderY + 1;
      const k = Math.max(1, Math.min(unresolvedRows.length, Math.floor((w - 2) / 24)));
      const boxW = Math.min(30, Math.max(20, Math.floor((w - (k + 1) * 2) / k)));
      const leftMargin = Math.floor((w - (k * boxW + (k - 1) * 2)) / 2);
      for (let i = 0; i < unresolvedRows.length; i++) {
        const un = unresolvedRows[i]!.node;
        const uRow = Math.floor(i / k);
        const uCol = i % k;
        const bx = leftMargin + uCol * (boxW + 2);
        const by = flowCursorY + uRow * 6;
        unresolvedBoxes.push({ node: un, x: bx, y: by, w: boxW, h: 5 });
        nodeBounds.set(un.id, { topY: by, bottomY: by + 4 });
      }
      flowCursorY += Math.ceil(unresolvedRows.length / k) * 6;
    }

    // Side consultations height
    let sideConsultEndY = 0;
    interface SideConsultLayout {
      consult: AgentNode;
      x: number;
      y: number;
      w: number;
      h: number;
    }
    const sideConsultList: SideConsultLayout[] = [];
    if (hasSideConsult) {
      let scY = 0;
      for (const c of consultations) {
        const scH = 12;
        sideConsultList.push({ consult: c, x: 1, y: scY, w: consultColWidth, h: scH });
        nodeBounds.set(c.id, { topY: scY, bottomY: scY + scH - 1 });
        scY += scH + 1;
      }
      sideConsultEndY = scY;
    }

    const totalDiagramHeight = Math.max(diagramViewportHeight, Math.max(flowCursorY, sideConsultEndY) + 1);
    const diagramCanvas = new Canvas(w, totalDiagramHeight);

    // Draw Main Box
    if (main) {
      const isSelected = this.selectedId === main.id;
      const isFlashing = nowTime - main.stateAt < 1000;
      diagramCanvas.box(mainBoxX, mainBoxY, mainBoxWidth, mainBoxHeight, { fg: "accent", bold: isSelected || isFlashing }, isSelected);

      diagramCanvas.textCentered(mainBoxX + 1, mainBoxY + 1, mainBoxWidth - 2, `${label(this.store, main)} · ${shortModel(main.model)}`, { fg: "accent", bold: true });
      const taskText = main.task?.split("\n")[0] ? clip(main.task.split("\n")[0]!, mainBoxWidth - 4) : "no task summary";
      diagramCanvas.textCentered(mainBoxX + 1, mainBoxY + 2, mainBoxWidth - 2, taskText, { fg: main.task ? undefined : "dim" });
      diagramCanvas.textCentered(mainBoxX + 1, mainBoxY + 3, mainBoxWidth - 2, formatTools(main, mainBoxWidth - 14));
      diagramCanvas.textCentered(mainBoxX + 1, mainBoxY + 4, mainBoxWidth - 2, `${stateGlyph(main, frame)} ${main.state} · ${elapsed(main, nowTime)}`);

      if (this.collapsed.has(main.id)) {
        diagramCanvas.textCentered(mainBoxX + 1, mainBoxY + 5, mainBoxWidth - 2, `+${countFolded(this.store, main.id)} folded`, { fg: "dim" });
      } else if (directChildren.length > 0) {
        diagramCanvas.set(trunkX, mainBoxY + mainBoxHeight - 1, isSelected ? "┯" : "┬", { fg: "dim" });
      }
    }

    // Draw Trunk, Delegate Label, and Bus
    if (!isMainCollapsed && directChildren.length > 0 && childGridLayout.length > 0) {
      // Trunk line 1
      diagramCanvas.set(trunkX, trunkY1, isRunning && (frame % 2 === 0) ? "●" : "│", { fg: isRunning && (frame % 2 === 0) ? "accent" : "dim" });
      // Trunk line 2
      diagramCanvas.set(trunkX, trunkY2, isRunning && (frame % 2 === 1) ? "●" : "│", { fg: isRunning && (frame % 2 === 1) ? "accent" : "dim" });

      // Delegate label
      const delText = `delegate to subagents · ${runningSubagents} running`;
      diagramCanvas.textCentered(mainAreaLeft, delLabelY, mainAreaWidth, delText, { fg: "muted" });

      // Trunk to bus
      diagramCanvas.set(trunkX, delTrunkY, "│", { fg: "dim" });

      // Row 0 Fan-out Bus
      const firstRow = childGridLayout[0]!;
      const minX = firstRow.boxes[0]!.centerX;
      const maxX = firstRow.boxes[firstRow.boxes.length - 1]!.centerX;

      diagramCanvas.set(minX, busY, "┌", { fg: "dim" });
      diagramCanvas.set(maxX, busY, "┐", { fg: "dim" });
      diagramCanvas.hline(minX + 1, busY, maxX - minX - 1, "─", { fg: "dim" });
      diagramCanvas.set(trunkX, busY, "┼", { fg: "dim" });

      for (const b of firstRow.boxes) {
        if (b.centerX > minX && b.centerX < maxX && b.centerX !== trunkX) {
          diagramCanvas.set(b.centerX, busY, "┬", { fg: "dim" });
        }
        diagramCanvas.set(b.centerX, arrowY, "▼", { fg: "dim" });
      }

      // Fan-out particles moving outward
      if (isRunning) {
        const rightLen = Math.max(1, maxX - trunkX - 1);
        const rOffset = (frame * 2) % rightLen;
        diagramCanvas.set(trunkX + 1 + rOffset, busY, "•", { fg: "dim" });
        if (trunkX + 2 + rOffset <= maxX - 1) {
          diagramCanvas.set(trunkX + 2 + rOffset, busY, "●", { fg: "thinkingLow" });
        }

        const leftLen = Math.max(1, trunkX - minX - 1);
        const lOffset = (frame * 2) % leftLen;
        diagramCanvas.set(trunkX - 1 - lOffset, busY, "•", { fg: "dim" });
        if (trunkX - 2 - lOffset >= minX + 1) {
          diagramCanvas.set(trunkX - 2 - lOffset, busY, "●", { fg: "thinkingLow" });
        }
      }

      // Draw Child Grid Rows
      for (let rIndex = 0; rIndex < childGridLayout.length; rIndex++) {
        const gridRow = childGridLayout[rIndex]!;

        // Rail connection to subsequent rows
        if (rIndex > 0) {
          diagramCanvas.set(minX, gridRow.y - 1, "│", { fg: "dim" });
          for (const b of gridRow.boxes) diagramCanvas.set(b.centerX, gridRow.y - 1, "▼", { fg: "dim" });
        }

        for (const b of gridRow.boxes) {
          const child = b.child;
          const isSelected = this.selectedId === child.id;
          const isFlashing = nowTime - child.stateAt < 1000;
          nodeBounds.set(child.id, { topY: gridRow.y, bottomY: gridRow.y + gridRow.boxHeight - 1 });

          diagramCanvas.box(b.x, gridRow.y, gridRow.boxWidth, gridRow.boxHeight, { fg: "thinkingLow", bold: isSelected || isFlashing }, isSelected);

          diagramCanvas.textCentered(b.x + 1, gridRow.y + 1, gridRow.boxWidth - 2, clip(label(this.store, child), gridRow.boxWidth - 4), { fg: "thinkingLow", bold: true });
          const cModel = shortModel(child.model);
          diagramCanvas.textCentered(b.x + 1, gridRow.y + 2, gridRow.boxWidth - 2, clip(cModel, gridRow.boxWidth - 4), { fg: "dim" });
          diagramCanvas.textCentered(b.x + 1, gridRow.y + 3, gridRow.boxWidth - 2, clip(formatTools(child, gridRow.boxWidth - 14), gridRow.boxWidth - 4));
          const cTask = child.task?.split("\n")[0] ? clip(child.task.split("\n")[0]!, gridRow.boxWidth - 4) : "no task summary";
          diagramCanvas.textCentered(b.x + 1, gridRow.y + 4, gridRow.boxWidth - 2, cTask, { fg: child.task ? undefined : "dim" });
          diagramCanvas.textCentered(b.x + 1, gridRow.y + 5, gridRow.boxWidth - 2, `${stateGlyph(child, frame)} ${child.state} · ${elapsed(child, nowTime)}`);

          // Nested descendants
          for (let ni = 0; ni < b.nested.length; ni++) {
            const nest = b.nested[ni]!;
            const nestY = gridRow.y + 6 + ni;
            if (nest.isFolded) {
              diagramCanvas.textCentered(b.x + 1, nestY, gridRow.boxWidth - 2, `+${countFolded(this.store, child.id)} folded`, { fg: "dim" });
            } else {
              nodeBounds.set(nest.node.id, { topY: nestY, bottomY: nestY });
              const isNestSelected = this.selectedId === nest.node.id;
              const nGlyph = stateGlyph(nest.node, frame);
              const nEl = elapsed(nest.node, nowTime);
              const nestStr = clip(`${nest.prefix}${label(this.store, nest.node)} ${nGlyph} ${nEl}`, gridRow.boxWidth - 4);
              diagramCanvas.text(b.x + 2, nestY, nestStr, { bg: isNestSelected ? "selectedBg" : undefined, fg: isNestSelected ? "accent" : undefined });
            }
          }
        }
      }

      // Merge bus
      const lastRow = childGridLayout[childGridLayout.length - 1]!;
      const lastMinX = lastRow.boxes[0]!.centerX;
      const lastMaxX = lastRow.boxes[lastRow.boxes.length - 1]!.centerX;

      diagramCanvas.set(lastMinX, mergeBusY, "└", { fg: "dim" });
      diagramCanvas.set(lastMaxX, mergeBusY, "┘", { fg: "dim" });
      diagramCanvas.hline(lastMinX + 1, mergeBusY, lastMaxX - lastMinX - 1, "─", { fg: "dim" });
      diagramCanvas.set(trunkX, mergeBusY, "┴", { fg: "dim" });

      for (const b of lastRow.boxes) {
        if (b.centerX > lastMinX && b.centerX < lastMaxX && b.centerX !== trunkX) {
          diagramCanvas.set(b.centerX, mergeBusY, "┴", { fg: "dim" });
        }
      }

      // Merge bus particles moving inward
      if (isRunning) {
        const leftLen = Math.max(1, trunkX - lastMinX - 1);
        const lOffset = (frame * 2) % leftLen;
        diagramCanvas.set(lastMinX + 1 + lOffset, mergeBusY, "•", { fg: "dim" });
        if (lastMinX + 2 + lOffset < trunkX) {
          diagramCanvas.set(lastMinX + 2 + lOffset, mergeBusY, "●", { fg: "thinkingLow" });
        }

        const rightLen = Math.max(1, lastMaxX - trunkX - 1);
        const rOffset = (frame * 2) % rightLen;
        diagramCanvas.set(lastMaxX - 1 - rOffset, mergeBusY, "•", { fg: "dim" });
        if (lastMaxX - 2 - rOffset > trunkX) {
          diagramCanvas.set(lastMaxX - 2 - rOffset, mergeBusY, "●", { fg: "thinkingLow" });
        }
      }

      // Return trunk & Return box
      diagramCanvas.set(trunkX, returnBoxY - 1, isRunning ? "●" : "│", { fg: isRunning ? "accent" : "dim" });

      const returnBoxW = Math.min(mainAreaWidth - 4, 35);
      const returnBoxX = trunkX - Math.floor(returnBoxW / 2);
      diagramCanvas.box(returnBoxX, returnBoxY, returnBoxW, 4, { fg: "accent" });
      diagramCanvas.textCentered(returnBoxX + 1, returnBoxY + 1, returnBoxW - 2, `back to ${main ? label(this.store, main) : "main"} · ${main?.state ?? "unknown"}`);
      diagramCanvas.textCentered(returnBoxX + 1, returnBoxY + 2, returnBoxW - 2, `${returnedDirectSubagents}/${directChildren.length} subagents returned`);
    }

    // Side Consultations
    if (hasSideConsult) {
      for (const sc of sideConsultList) {
        const c = sc.consult;
        const isSelected = this.selectedId === c.id;
        const isFlashing = nowTime - c.stateAt < 1000;
        diagramCanvas.box(sc.x, sc.y, sc.w, sc.h, { fg: "thinkingXhigh", bold: isSelected || isFlashing }, isSelected);

        diagramCanvas.textCentered(sc.x + 1, sc.y + 1, sc.w - 2, clip(label(this.store, c).toUpperCase(), sc.w - 4), { fg: "thinkingXhigh", bold: true });
        const cModel = shortModel(c.model);
        diagramCanvas.textCentered(sc.x + 1, sc.y + 2, sc.w - 2, `${clip(cModel, sc.w - 14)} · on call`, { fg: "dim" });
        const consulter = c.parentId ? this.store.nodes.get(c.parentId) : undefined;
        diagramCanvas.textCentered(sc.x + 1, sc.y + 3, sc.w - 2, `consulted by ${consulter ? label(this.store, consulter) : c.parentId ?? "unknown"}`, { fg: "dim" });

        // Timeline
        const isConsultActive = c.state === "running" || (nowTime - (c.history[c.history.length - 1]?.timestamp ?? 0) < 2000);
        const pulseGlyph = isConsultActive ? ((frame % 2 === 0) ? "◆" : "◇") : "◆";

        if (c.history.length === 0) {
          diagramCanvas.text(sc.x + 2, sc.y + 4, `◇ agent observed`, { fg: "muted" });
          diagramCanvas.text(sc.x + 2, sc.y + 5, `┊`, { fg: "dim" });
          diagramCanvas.text(sc.x + 2, sc.y + 6, `${pulseGlyph} waiting for call`, { fg: "muted", bg: isSelected ? "selectedBg" : undefined });
        } else {
          const hist = c.history.slice(-3);
          for (let hi = 0; hi < hist.length - 1; hi++) {
            diagramCanvas.text(sc.x + 2, sc.y + 4 + hi * 2, clip(`◇ ${hist[hi]!.text}`, sc.w - 4), { fg: "muted" });
            diagramCanvas.text(sc.x + 2, sc.y + 5 + hi * 2, `┊`, { fg: "dim" });
          }
          const latest = hist[hist.length - 1]!;
          const latestY = sc.y + 4 + (hist.length - 1) * 2;
          diagramCanvas.text(sc.x + 2, latestY, clip(`${pulseGlyph} ${latest.text}`, sc.w - 4), {
            bg: isSelected ? "selectedBg" : undefined,
          });
        }

        diagramCanvas.textCentered(sc.x + 1, sc.y + sc.h - 3, sc.w - 2, clip(formatTools(c, sc.w - 14), sc.w - 4));
        diagramCanvas.textCentered(sc.x + 1, sc.y + sc.h - 2, sc.w - 2, `${stateGlyph(c, frame)} ${c.state} · ${elapsed(c, nowTime)}`);

        // Dashed arrow to main box
        const arrowY = mainBoxY + 2;
        const arrowStart = sc.x + sc.w;
        const arrowEnd = mainBoxX;
        if (arrowEnd > arrowStart + 2) {
          const arrowLen = arrowEnd - arrowStart;
          for (let ax = 0; ax < arrowLen; ax++) {
            const ch = ax === arrowLen - 1 ? ">" : ax % 2 === 0 ? "-" : " ";
            diagramCanvas.set(arrowStart + ax, arrowY, ch, { fg: "dim" });
          }
          if (isRunning) {
            const pOffset = (frame * 2) % Math.max(1, arrowLen - 3);
            diagramCanvas.set(arrowStart + pOffset, arrowY, "•", { fg: "dim" });
            diagramCanvas.set(arrowStart + pOffset + 1, arrowY, "●", { fg: "thinkingXhigh" });
          }
        }
      }
    }

    // Narrow Consultations Grid
    if (!hasSideConsult && consultations.length > 0) {
      diagramCanvas.text(2, consultGridHeaderY, `consultations · ${consultations.length}`, { fg: "dim" });
      for (const cb of narrowConsultBoxes) {
        const c = cb.consult;
        const isSelected = this.selectedId === c.id;
        const isFlashing = nowTime - c.stateAt < 1000;
        diagramCanvas.box(cb.x, cb.y, cb.w, cb.h, { fg: "thinkingXhigh", bold: isSelected || isFlashing }, isSelected);
        diagramCanvas.textCentered(cb.x + 1, cb.y + 1, cb.w - 2, clip(label(this.store, c).toUpperCase(), cb.w - 4), { fg: "thinkingXhigh", bold: true });
        const cModel = shortModel(c.model);
        diagramCanvas.textCentered(cb.x + 1, cb.y + 2, cb.w - 2, clip(cModel, cb.w - 4), { fg: "dim" });
        diagramCanvas.textCentered(cb.x + 1, cb.y + 3, cb.w - 2, clip(formatTools(c, cb.w - 14), cb.w - 4));
        const cTask = c.task?.split("\n")[0] ? clip(c.task.split("\n")[0]!, cb.w - 4) : "no task summary";
        diagramCanvas.textCentered(cb.x + 1, cb.y + 4, cb.w - 2, cTask, { fg: c.task ? undefined : "dim" });
        diagramCanvas.textCentered(cb.x + 1, cb.y + 5, cb.w - 2, `${stateGlyph(c, frame)} ${c.state} · ${elapsed(c, nowTime)}`);
      }
    }

    // Unresolved Nodes Grid
    if (unresolvedRows.length > 0) {
      diagramCanvas.text(2, unresolvedHeaderY, "unresolved parents", { fg: "warning" });
      for (const ub of unresolvedBoxes) {
        const un = ub.node;
        const isSelected = this.selectedId === un.id;
        const isFlashing = nowTime - un.stateAt < 1000;
        diagramCanvas.box(ub.x, ub.y, ub.w, ub.h, { fg: "warning", bold: isSelected || isFlashing }, isSelected, true);
        diagramCanvas.textCentered(ub.x + 1, ub.y + 1, ub.w - 2, clip(label(this.store, un), ub.w - 4), { bold: true });
        diagramCanvas.textCentered(ub.x + 1, ub.y + 2, ub.w - 2, `?parent: ${un.parentId ?? "unknown"}`, { fg: "dim" });
        diagramCanvas.textCentered(ub.x + 1, ub.y + 3, ub.w - 2, `${stateGlyph(un, frame)} ${un.state} · ${elapsed(un, nowTime)}`);
      }
    }

    // Scrollable diagram viewport adjustment
    const selectedNode = rows.find(r => r.node.id === this.selectedId)?.node ?? rows[0]?.node;
    const bounds = selectedNode ? nodeBounds.get(selectedNode.id) : undefined;
    if (bounds) {
      if (bounds.topY < this.top) {
        this.top = bounds.topY;
      } else if (bounds.bottomY >= this.top + diagramViewportHeight) {
        this.top = bounds.bottomY - diagramViewportHeight + 1;
      }
    }
    this.top = Math.max(0, Math.min(this.top, Math.max(0, totalDiagramHeight - diagramViewportHeight)));

    // Visible nodes count for PageUp / PageDown
    let visibleCount = 0;
    for (const row of rows) {
      const b = nodeBounds.get(row.node.id);
      if (b && b.topY < this.top + diagramViewportHeight && b.bottomY >= this.top) {
        visibleCount++;
      }
    }
    this.pageSize = Math.max(1, visibleCount);

    // Copy viewport lines to screen canvas
    for (let vy = 0; vy < diagramViewportHeight; vy++) {
      screenCanvas.copyRow(3 + vy, diagramCanvas, this.top + vy);
    }

    // Scroll markers
    if (this.top > 0) {
      screenCanvas.text(w - 7, 3, "↑ more", { fg: "dim" });
    }
    if (this.top + diagramViewportHeight < totalDiagramHeight) {
      screenCanvas.text(w - 7, 3 + diagramViewportHeight - 1, "↓ more", { fg: "dim" });
    }

    return screenCanvas.render(this.theme);
  }

  private time(timestamp: number): string {
    return new Date(timestamp).toLocaleTimeString("en-US", { hour12: false });
  }

  private color(color: Parameters<HostTheme["fg"]>[0], text: string, state?: AgentNode["state"]): string {
    const override = state ? this.store.options.colors?.[state] : undefined;
    const allowed = ["accent", "success", "warning", "error", "dim", "muted"];
    const actual = override && allowed.includes(override) ? override as typeof color : color;
    return this.theme?.fg(actual, clean(text)) ?? clean(text);
  }
}
