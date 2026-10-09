import type { HostColor, HostTheme } from "./host.ts";
import { clean, clip, width } from "./text.ts";

export interface CellStyle {
  fg?: HostColor | undefined;
  bold?: boolean | undefined;
  bg?: "selectedBg" | undefined;
}

interface Cell {
  char: string;
  fg?: HostColor | undefined;
  bold?: boolean | undefined;
  bg?: "selectedBg" | undefined;
  wideTrailing?: boolean | undefined;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export class Canvas {
  private readonly grid: Cell[][];

  constructor(readonly width: number, readonly height: number) {
    this.grid = Array.from({ length: Math.max(0, height) }, () =>
      Array.from({ length: Math.max(0, width) }, () => ({ char: " " }))
    );
  }

  private clearCell(x: number, y: number): void {
    const row = this.grid[y];
    if (!row || x < 0 || x >= this.width) return;
    const cell = row[x]!;
    if (cell.wideTrailing && x > 0 && row[x - 1]) {
      row[x - 1] = { char: " " };
    }
    if (!cell.wideTrailing && x + 1 < this.width && row[x + 1]?.wideTrailing) {
      row[x + 1] = { char: " " };
    }
    row[x] = { char: " " };
  }

  copyRow(dstY: number, srcCanvas: Canvas, srcY: number): void {
    if (dstY < 0 || dstY >= this.height || srcY < 0 || srcY >= srcCanvas.height) return;
    const srcRow = srcCanvas.grid[srcY];
    const dstRow = this.grid[dstY];
    if (!srcRow || !dstRow) return;
    const len = Math.min(this.width, srcCanvas.width);
    for (let x = 0; x < len; x++) {
      dstRow[x] = { ...srcRow[x]! };
    }
  }

  set(x: number, y: number, char: string, style?: CellStyle): void {
    if (x < 0 || x >= this.width || y < 0 || y >= this.height) return;
    const row = this.grid[y];
    if (!row) return;

    const w = width(char);
    if (w === 2) {
      if (x + 1 >= this.width) {
        // Cannot fit wide character split at right edge
        this.clearCell(x, y);
        row[x] = { char: " ", ...style, wideTrailing: false };
        return;
      }
      this.clearCell(x, y);
      this.clearCell(x + 1, y);
      row[x] = { char, ...style, wideTrailing: false };
      row[x + 1] = { char: "", ...style, wideTrailing: true };
    } else {
      this.clearCell(x, y);
      row[x] = { char, ...style, wideTrailing: false };
    }
  }

  text(x: number, y: number, str: string, style?: CellStyle): number {
    if (y < 0 || y >= this.height || x >= this.width) return x;
    const plain = clean(str);
    let curX = x;
    for (const item of segmenter.segment(plain)) {
      if (curX >= this.width) break;
      const g = item.segment;
      const w = width(g);
      if (w === 0) continue;
      if (w === 2) {
        if (curX + 1 >= this.width) {
          this.set(curX, y, " ", style);
          curX += 1;
          break;
        }
        this.set(curX, y, g, style);
        curX += 2;
      } else {
        this.set(curX, y, g, style);
        curX += 1;
      }
    }
    return curX;
  }

  textCentered(x: number, y: number, boxWidth: number, str: string, style?: CellStyle): void {
    // Never spill past the interior and overwrite a border.
    const plain = clip(str, boxWidth);
    const textWidth = width(plain);
    const startX = x + Math.max(0, Math.floor((boxWidth - textWidth) / 2));
    this.text(startX, y, plain, style);
  }

  hline(x: number, y: number, length: number, char = "─", style?: CellStyle): void {
    for (let i = 0; i < length; i++) {
      this.set(x + i, y, char, style);
    }
  }

  vline(x: number, y: number, length: number, char = "│", style?: CellStyle): void {
    for (let i = 0; i < length; i++) {
      this.set(x, y + i, char, style);
    }
  }

  box(x: number, y: number, w: number, h: number, style?: CellStyle, heavy = false, dashed = false): void {
    if (w <= 0 || h <= 0) return;
    const tl = heavy ? "┏" : "┌";
    const tr = heavy ? "┓" : "┐";
    const bl = heavy ? "┗" : "└";
    const br = heavy ? "┛" : "┘";
    const horiz = heavy ? "━" : dashed ? "┄" : "─";
    const vert = heavy ? "┃" : dashed ? "╎" : "│";

    if (w === 1 && h === 1) {
      this.set(x, y, tl, style);
      return;
    }
    if (h === 1) {
      this.hline(x, y, w, horiz, style);
      return;
    }
    if (w === 1) {
      this.vline(x, y, h, vert, style);
      return;
    }

    this.set(x, y, tl, style);
    this.set(x + w - 1, y, tr, style);
    this.set(x, y + h - 1, bl, style);
    this.set(x + w - 1, y + h - 1, br, style);

    this.hline(x + 1, y, w - 2, horiz, style);
    this.hline(x + 1, y + h - 1, w - 2, horiz, style);
    this.vline(x, y + 1, h - 2, vert, style);
    this.vline(x + w - 1, y + 1, h - 2, vert, style);
  }

  fill(x: number, y: number, w: number, h: number, char = " ", style?: CellStyle): void {
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w; col++) {
        this.set(x + col, y + row, char, style);
      }
    }
  }

  render(theme?: HostTheme): string[] {
    const lines: string[] = [];
    for (let y = 0; y < this.height; y++) {
      const rowCells = this.grid[y];
      if (!rowCells) {
        lines.push("");
        continue;
      }
      let lastOccupied = -1;
      for (let x = rowCells.length - 1; x >= 0; x--) {
        const cell = rowCells[x]!;
        if (cell.char !== " " || cell.bg || cell.fg || cell.bold || cell.wideTrailing) {
          lastOccupied = x;
          break;
        }
      }
      if (lastOccupied < 0) {
        lines.push("");
        continue;
      }

      let rowStr = "";
      let currentRun = "";
      let currentFg: HostColor | undefined = undefined;
      let currentBold: boolean | undefined = undefined;
      let currentBg: "selectedBg" | undefined = undefined;

      const flushRun = () => {
        if (!currentRun) return;
        if (!theme) {
          rowStr += currentRun;
        } else {
          let formatted = currentRun;
          if (currentBg === "selectedBg" && theme.bg) formatted = theme.bg("selectedBg", formatted);
          if (currentBold && theme.bold) formatted = theme.bold(formatted);
          if (currentFg) formatted = theme.fg(currentFg, formatted);
          rowStr += formatted;
        }
        currentRun = "";
      };

      for (let x = 0; x <= lastOccupied; x++) {
        const cell = rowCells[x]!;
        const sameStyle = cell.fg === currentFg && cell.bold === currentBold && cell.bg === currentBg;
        if (!sameStyle) {
          flushRun();
          currentFg = cell.fg;
          currentBold = cell.bold;
          currentBg = cell.bg;
        }
        currentRun += cell.char;
      }
      flushRun();
      lines.push(rowStr);
    }
    return lines;
  }
}
