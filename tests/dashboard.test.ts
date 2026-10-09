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

test("spinner and particle output differs 120ms apart while running and is identical when static", () => {
  const storeRunning = new TreeStore("root-a");
  storeRunning.ingest(frame("agent_observed", "Main", { kind: "main", name: "main", state: "running" }, 1000));
  storeRunning.ingest(frame("agent_observed", "child-1", { parentId: "Main", name: "child-1", state: "running" }, 1000));

  let clock = 1000;
  const dashRunning = new Dashboard(storeRunning, () => 30, () => {}, () => {}, undefined, () => clock);
  const r1 = dashRunning.render(120).join("\n");
  clock += 120;
  const r2 = dashRunning.render(120).join("\n");
  expect(r1).not.toEqual(r2);

  const storeStatic = new TreeStore("root-a");
  storeStatic.ingest(frame("agent_observed", "Main", { kind: "main", name: "main", state: "completed" }, 1000));
  storeStatic.ingest(frame("agent_observed", "child-1", { parentId: "Main", name: "child-1", state: "completed" }, 1000));

  let clockStatic = 50000;
  const dashStatic = new Dashboard(storeStatic, () => 30, () => {}, () => {}, undefined, () => clockStatic);
  const s1 = dashStatic.render(120).join("\n");
  clockStatic += 120;
  const s2 = dashStatic.render(120).join("\n");
  expect(s1).toEqual(s2);
});

test("isAnimating transitions from true to false after all nodes end and activity ages out", () => {
  const store = new TreeStore("root-a");
  store.ingest(frame("agent_observed", "Main", { kind: "main", name: "main", state: "running" }, 1000));
  let clock = 1000;
  const dashboard = new Dashboard(store, () => 20, () => {}, () => {}, undefined, () => clock);

  expect(dashboard.isAnimating()).toBe(true);

  store.ingest(frame("agent_finished", "Main", { state: "completed" }, 1000));
  // At clock = 1000, recent activity timestamp is 1000 (< 2000ms old) and stateAt is 1000 (< 1000ms old)
  expect(dashboard.isAnimating()).toBe(true);

  // Advance clock past 2000ms
  clock = 3500;
  expect(dashboard.isAnimating()).toBe(false);
});

test("selected agent stays visible after scrolling deep into 100 children at 80x16 and 120x40", () => {
  const store = fixture(100);
  const d16 = new Dashboard(store, () => 16, () => {}, () => {});
  d16.render(80);
  for (let i = 0; i < 75; i++) d16.handleInput("j");
  expect(d16.selectedId).toBe("agent-74");
  const out16 = d16.render(80).join("\n");
  expect(out16).toContain("74");

  const d40 = new Dashboard(store, () => 40, () => {}, () => {});
  d40.render(120);
  for (let i = 0; i < 75; i++) d40.handleInput("j");
  expect(d40.selectedId).toBe("agent-74");
  const out40 = d40.render(120).join("\n");
  expect(out40).toContain("74");
});

test("details toggle shows and hides Recent activity", () => {
  const store = fixture(5);
  store.ingest(frame("task_updated", "Main", { task: "initial task" }, 1000));
  const dashboard = new Dashboard(store, () => 24, () => {}, () => {});

  // Starts hidden
  expect(dashboard.render(120).join("\n")).not.toContain("Recent activity");

  // Toggle on with 'd'
  dashboard.handleInput("d");
  expect(dashboard.render(120).join("\n")).toContain("Recent activity");

  // Toggle off with 'd'
  dashboard.handleInput("d");
  expect(dashboard.render(120).join("\n")).not.toContain("Recent activity");
});
