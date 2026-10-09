const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const ansi = /\x1b\[[0-9;]*m/g;

/** Remove terminal controls and bidi overrides from telemetry before rendering. */
export function clean(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
}
function cells(grapheme: string): number {
  if (/^\p{Mark}+$/u.test(grapheme)) return 0;
  if (/\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(grapheme)) return 2;
  const code = grapheme.codePointAt(0)!;
  return (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a ||
    (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x20000 && code <= 0x3fffd))) ? 2 : 1;
}
export function width(value: string): number {
  return [...segmenter.segment(value.replace(ansi, ""))].reduce((sum, item) => sum + cells(item.segment), 0);
}
export function clip(value: string, max: number): string {
  const plain = clean(value);
  if (max <= 0) return "";
  if (width(plain) <= max) return plain;
  let result = "", used = 0;
  for (const item of segmenter.segment(plain)) {
    const size = cells(item.segment);
    if (used + size > max - 1) break;
    result += item.segment;
    used += size;
  }
  return result + "…";
}
export const pad = (value: string, size: number): string => value + " ".repeat(Math.max(0, size - width(value)));
export function wrap(value: string, max: number): string[] {
  if (max <= 0) return [];
  const lines: string[] = [];
  let line = "", used = 0;
  for (const item of segmenter.segment(clean(value))) {
    const size = cells(item.segment);
    if (size > max) { if (line) lines.push(line); line = "?"; used = 1; continue; }
    if (used + size > max) { lines.push(line); line = ""; used = 0; }
    line += item.segment; used += size;
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}
