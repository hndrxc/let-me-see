import { expect, test } from "bun:test";
import { Dashboard, elapsed, normalizeKey, treeRows } from "../src/dashboard.ts";
import { clean, width } from "../src/text.ts";
import { TreeStore } from "../src/store.ts";
import { frame } from "./helpers.ts";

function fixture(size = 30): TreeStore {
  const store = new TreeStore("root-a");
  store.ingest(frame("agent_observed", "Main", { kind: "main", name: "main", state: "running" }, 1000));
  for (let i = 0; i < size; i++) {
    store.ingest(frame("agent_observed", `agent-${i}`, { parentId: "Main", name: `探索 👩‍💻 ${i}`, state: "running", task: "A lengthy task summary ".repeat(30) }, 1000));
  }
  return store;
}

test("fits narrow, wide and very short terminals with wide Unicode and hostile input", () => {
  const store = fixture();
  store.ingest(frame("task_updated", "Main", { task: "escape \x1b[31m red \x1b]0;bad\x07 title\nline" }));
  for (const columns of [1, 2, 8, 20, 40, 80, 100, 140]) for (const rows of [1, 2, 3, 4, 8, 16, 24]) {
    const dashboard = new Dashboard(store, () => rows, () => {}, () => {});
    const rendered = dashboard.render(columns);
    expect(rendered.length).toBeLessThanOrEqual(rows);
    for (const line of rendered) expect(width(line)).toBeLessThanOrEqual(columns);
    expect(rendered.join("\n")).not.toContain("\x1b");
  }
  expect(clean("safe\x1b[2J\u202eevil")).not.toContain("\x1b");
});

test("children arriving before parents remain unresolved until linked; cycles are finite", () => {
  const store = new TreeStore("root-a");
  store.ingest(frame("agent_observed", "child", { parentId: "parent" }));
  expect(treeRows(store, new Set())[0]?.unresolved).toBe(true);
  store.ingest(frame("agent_observed", "parent", { parentId: "Main" }));
  store.ingest(frame("agent_observed", "Main", { kind: "main" }));
  expect(treeRows(store, new Set()).map(r => r.node.id)).toEqual(["Main", "parent", "child"]);
  expect(treeRows(store, new Set())[2]?.unresolved).toBe(false);
  expect(treeRows(store, new Set(["parent"])).map(r => r.node.id)).toEqual(["Main", "parent"]);
  store.ingest(frame("agent_observed", "cycle-1", { parentId: "cycle-2" }));
  store.ingest(frame("agent_observed", "cycle-2", { parentId: "cycle-1" }));
  expect(treeRows(store, new Set()).length).toBe(5);
});

test("scrolling, folding and live additions preserve selection by runtime ID", () => {
  const store = fixture(100); let closed = 0;
  const dashboard = new Dashboard(store, () => 16, () => {}, () => { closed++; });
  dashboard.render(80);
  for (let i = 0; i < 60; i++) dashboard.handleInput("j");
  expect(dashboard.selectedId).toBe("agent-59");
  const rendered = dashboard.render(80).join("\n");
  expect(rendered).toContain("59");
  store.ingest(frame("agent_observed", "new", { parentId: "Main" }));
  dashboard.render(80);
  expect(dashboard.selectedId).toBe("agent-59");
  dashboard.handleInput("g"); dashboard.handleInput(" ");
  expect(treeRows(store, dashboard.collapsed).length).toBe(1);
  dashboard.handleInput("l");
  expect(treeRows(store, dashboard.collapsed).length).toBe(102);
  dashboard.handleInput("\t"); dashboard.handleInput("\x1b[6~");
  expect(dashboard.render(120).join("\n")).toContain("Recent activity");
  dashboard.handleInput("\x1b[113u");
  expect(closed).toBe(1);
  dashboard.dispose(); dashboard.handleInput("q");
  expect(closed).toBe(1);
});

test("elapsed time freezes after a turn, unknown time stays explicit and Kitty keys work", () => {
  const store = new TreeStore("root-a");
  store.ingest(frame("model_observed", "a", { model: "p/m" }, 0));
  expect(elapsed(store.nodes.get("a")!, 20000)).toBe("unknown");
  store.ingest(frame("loop_started", "a", {}, 1000));
  store.ingest(frame("loop_ended", "a", {}, 2000));
  expect(elapsed(store.nodes.get("a")!, 100000)).toBe("1s");
  expect(normalizeKey("\x1b[106u")).toBe("j");
  expect(normalizeKey("\x1b[103;2u")).toBe("G");
  expect(normalizeKey("\x1b[113;1:3u")).toBe("");
  expect(normalizeKey("\x1b[57352u")).toBe("\x1b[A");
});
