import { TreeStore } from "../src/store.ts";
import { Dashboard } from "../src/dashboard.ts";
import type { TreeEvent } from "../src/events.ts";
import type { HostColor, HostTheme } from "../src/host.ts";

/** OMP dark theme palette (RGB values for ANSI 24-bit truecolor). */
const PALETTE: Record<HostColor, [number, number, number]> = {
  accent: [254, 188, 56],       // #febc38
  success: [137, 210, 129],     // #89d281
  warning: [228, 192, 15],      // #e4c00f
  error: [252, 58, 75],         // #fc3a4b
  dim: [95, 102, 115],          // #5f6673
  muted: [119, 125, 136],       // #777d88
  thinkingLow: [23, 143, 185],  // #178fb9
  thinkingXhigh: [229, 193, 255], // #e5c1ff
};

export const darkTheme: HostTheme = {
  fg(color: HostColor, text: string): string {
    const rgb = PALETTE[color];
    if (!rgb) return text;
    return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${text}\x1b[39m`;
  },
  bold(text: string): string {
    return `\x1b[1m${text}\x1b[22m`;
  },
  bg(color: "selectedBg", text: string): string {
    if (color === "selectedBg") {
      return `\x1b[48;2;49;54;63m${text}\x1b[49m`; // #31363f
    }
    return text;
  },
};

let eventSeq = 0;
function ingest(
  store: Pick<TreeStore, "ingest">,
  agentId: string,
  type: TreeEvent["type"],
  payload: TreeEvent["payload"],
  timestamp: number,
  cycle = 0,
): void {
  store.ingest({
    schemaVersion: 1,
    eventId: `demo:${cycle}:${++eventSeq}`,
    timestamp,
    source: "demo",
    rootSessionId: "demo",
    sessionId: "demo",
    agentId,
    type,
    payload,
  });
}

/**
 * Scenario resembling the screenshot using real v1 events:
 * - main agent (model example/model-a, task line, active tool)
 * - 3 subagents (worker, explorer, researcher) with concurrent tools
 * - 1 nested agent under worker
 * - 1 consultation node (advisor, relation: "consultation", parent main) with history
 */
function populateStaticScenario(target: TreeStore, now: number): void {
  // Buffer, then deliver in timestamp order so the session log reads chronologically.
  const events: TreeEvent[] = [];
  const store = { ingest: (event: TreeEvent) => { events.push(event); return true; } };
  // Main agent
  ingest(store, "root", "agent_observed", {
    name: "main",
    kind: "main",
    state: "running",
    task: "Build a live agent tree",
  }, now - 80000);
  ingest(store, "root", "model_observed", {
    model: "example/model-a",
  }, now - 79000);
  ingest(store, "root", "tool_started", {
    toolCallId: "main-call-1",
    toolName: "read",
  }, now - 60000);

  // Consultation node (advisor, relation: "consultation", parent: "root")
  ingest(store, "advisor", "agent_observed", {
    name: "advisor",
    parentId: "root",
    relation: "consultation",
    kind: "sub",
    state: "running",
    task: "Review architecture",
  }, now - 35000);
  ingest(store, "advisor", "model_observed", {
    model: "example/advisor",
  }, now - 34000);
  ingest(store, "advisor", "tool_started", {
    toolCallId: "adv-call-1",
    toolName: "read",
  }, now - 30000);
  ingest(store, "advisor", "tool_ended", {
    toolCallId: "adv-call-1",
    toolName: "read",
  }, now - 28000);
  ingest(store, "advisor", "tool_started", {
    toolCallId: "adv-call-2",
    toolName: "grep",
  }, now - 20000);
  ingest(store, "advisor", "tool_ended", {
    toolCallId: "adv-call-2",
    toolName: "grep",
  }, now - 18000);
  ingest(store, "advisor", "tool_started", {
    toolCallId: "adv-call-3",
    toolName: "read",
  }, now - 3000);

  // Subagent 1: worker with concurrent tools and a nested child
  ingest(store, "worker", "agent_observed", {
    name: "worker",
    parentId: "root",
    kind: "sub",
    state: "running",
    task: "edits + tests",
  }, now - 24000);
  ingest(store, "worker", "model_observed", {
    model: "example/model-b",
  }, now - 23000);
  ingest(store, "worker", "tool_started", {
    toolCallId: "w-call-1",
    toolName: "edit",
  }, now - 15000);
  ingest(store, "worker", "tool_started", {
    toolCallId: "w-call-2",
    toolName: "bash",
  }, now - 10000);

  // Nested agent under worker
  ingest(store, "nested", "agent_observed", {
    name: "nested",
    parentId: "worker",
    kind: "sub",
    state: "running",
    task: "run unit tests",
  }, now - 12000);
  ingest(store, "nested", "model_observed", {
    model: "example/model-d",
  }, now - 11000);
  ingest(store, "nested", "tool_started", {
    toolCallId: "n-call-1",
    toolName: "bash",
  }, now - 8000);

  // Subagent 2: explorer (completed)
  ingest(store, "explorer", "agent_observed", {
    name: "explorer",
    parentId: "root",
    kind: "sub",
    state: "running",
    task: "reads code",
  }, now - 40000);
  ingest(store, "explorer", "model_observed", {
    model: "example/model-c",
  }, now - 39000);
  ingest(store, "explorer", "tool_started", {
    toolCallId: "e-call-1",
    toolName: "read",
  }, now - 30000);
  ingest(store, "explorer", "tool_ended", {
    toolCallId: "e-call-1",
    toolName: "read",
  }, now - 25000);
  ingest(store, "explorer", "agent_finished", {
    state: "completed",
  }, now - 5000);

  // Subagent 3: researcher (running with tool)
  ingest(store, "researcher", "agent_observed", {
    name: "researcher",
    parentId: "root",
    kind: "sub",
    state: "running",
    task: "pulls docs",
  }, now - 9000);
  ingest(store, "researcher", "model_observed", {
    model: "example/model-e",
  }, now - 8500);
  ingest(store, "researcher", "tool_started", {
    toolCallId: "r-call-1",
    toolName: "web_search",
  }, now - 6000);
  events.sort((a, b) => a.timestamp - b.timestamp);
  for (const event of events) target.ingest(event);
}

interface TimelineStep {
  offsetMs: number;
  emit: (store: TreeStore, timestamp: number, cycle: number) => void;
}

/**
 * Scripted 20 s timeline exercising every animation and lifecycle path:
 * - children start
 * - tools start/end concurrently
 * - consultation tool activity
 * - child completes
 * - child fails with error
 * - main receives results, runs tool, finishes turn, and restarts
 */
const timeline: TimelineStep[] = [
  // 0.0s: main and advisor start
  {
    offsetMs: 0,
    emit: (store, t, c) => {
      ingest(store, "root", "agent_observed", {
        name: "main",
        kind: "main",
        state: "running",
        task: "Build a live agent tree",
      }, t, c);
      ingest(store, "root", "model_observed", { model: "example/model-a" }, t, c);
      ingest(store, "advisor", "agent_observed", {
        name: "advisor",
        parentId: "root",
        relation: "consultation",
        kind: "sub",
        state: "running",
        task: "Review architecture",
      }, t, c);
      ingest(store, "advisor", "model_observed", { model: "example/advisor" }, t, c);
    },
  },
  // 0.8s: main and advisor start tools
  {
    offsetMs: 800,
    emit: (store, t, c) => {
      ingest(store, "root", "tool_started", { toolCallId: "main-1", toolName: "read" }, t, c);
      ingest(store, "advisor", "tool_started", { toolCallId: "adv-1", toolName: "read" }, t, c);
    },
  },
  // 1.8s: tools end; worker starts
  {
    offsetMs: 1800,
    emit: (store, t, c) => {
      ingest(store, "advisor", "tool_ended", { toolCallId: "adv-1", toolName: "read" }, t, c);
      ingest(store, "root", "tool_ended", { toolCallId: "main-1", toolName: "read" }, t, c);
      ingest(store, "worker", "agent_observed", {
        name: "worker",
        parentId: "root",
        kind: "sub",
        state: "running",
        task: "edits + tests",
      }, t, c);
      ingest(store, "worker", "model_observed", { model: "example/model-b" }, t, c);
    },
  },
  // 2.5s: explorer and researcher start; worker starts tool
  {
    offsetMs: 2500,
    emit: (store, t, c) => {
      ingest(store, "worker", "tool_started", { toolCallId: "w-1", toolName: "read" }, t, c);
      ingest(store, "explorer", "agent_observed", {
        name: "explorer",
        parentId: "root",
        kind: "sub",
        state: "running",
        task: "reads code",
      }, t, c);
      ingest(store, "explorer", "model_observed", { model: "example/model-c" }, t, c);
      ingest(store, "researcher", "agent_observed", {
        name: "researcher",
        parentId: "root",
        kind: "sub",
        state: "running",
        task: "pulls docs",
      }, t, c);
      ingest(store, "researcher", "model_observed", { model: "example/model-e" }, t, c);
    },
  },
  // 3.5s: concurrent tools on worker, explorer, researcher
  {
    offsetMs: 3500,
    emit: (store, t, c) => {
      ingest(store, "worker", "tool_started", { toolCallId: "w-2", toolName: "bash" }, t, c);
      ingest(store, "explorer", "tool_started", { toolCallId: "e-1", toolName: "read" }, t, c);
      ingest(store, "researcher", "tool_started", { toolCallId: "r-1", toolName: "web_search" }, t, c);
    },
  },
  // 4.5s: nested agent under worker starts
  {
    offsetMs: 4500,
    emit: (store, t, c) => {
      ingest(store, "nested", "agent_observed", {
        name: "nested",
        parentId: "worker",
        kind: "sub",
        state: "running",
        task: "run unit tests",
      }, t, c);
      ingest(store, "nested", "model_observed", { model: "example/model-d" }, t, c);
      ingest(store, "nested", "tool_started", { toolCallId: "n-1", toolName: "bash" }, t, c);
    },
  },
  // 5.5s: consultation tool activity (grep)
  {
    offsetMs: 5500,
    emit: (store, t, c) => {
      ingest(store, "advisor", "tool_started", { toolCallId: "adv-2", toolName: "grep" }, t, c);
    },
  },
  // 6.5s: worker ends tool read (bash continues); advisor ends grep
  {
    offsetMs: 6500,
    emit: (store, t, c) => {
      ingest(store, "worker", "tool_ended", { toolCallId: "w-1", toolName: "read" }, t, c);
      ingest(store, "advisor", "tool_ended", { toolCallId: "adv-2", toolName: "grep" }, t, c);
    },
  },
  // 7.5s: explorer ends tool and completes (1/3 subagents returned)
  {
    offsetMs: 7500,
    emit: (store, t, c) => {
      ingest(store, "explorer", "tool_ended", { toolCallId: "e-1", toolName: "read" }, t, c);
      ingest(store, "explorer", "agent_finished", { state: "completed" }, t, c);
    },
  },
  // 8.5s: worker starts edit (concurrent with bash)
  {
    offsetMs: 8500,
    emit: (store, t, c) => {
      ingest(store, "worker", "tool_started", { toolCallId: "w-3", toolName: "edit" }, t, c);
    },
  },
  // 9.5s: nested finishes tool and completes
  {
    offsetMs: 9500,
    emit: (store, t, c) => {
      ingest(store, "nested", "tool_ended", { toolCallId: "n-1", toolName: "bash" }, t, c);
      ingest(store, "nested", "agent_finished", { state: "completed" }, t, c);
    },
  },
  // 11.0s: researcher tool fails; researcher fails (a child fails)
  {
    offsetMs: 11000,
    emit: (store, t, c) => {
      ingest(store, "researcher", "tool_ended", { toolCallId: "r-1", toolName: "web_search", isError: true }, t, c);
      ingest(store, "researcher", "agent_finished", { state: "failed", isError: true }, t, c);
    },
  },
  // 12.0s: consultation starts another read tool
  {
    offsetMs: 12000,
    emit: (store, t, c) => {
      ingest(store, "advisor", "tool_started", { toolCallId: "adv-3", toolName: "read" }, t, c);
    },
  },
  // 13.5s: consultation ends read tool; worker ends tools
  {
    offsetMs: 13500,
    emit: (store, t, c) => {
      ingest(store, "advisor", "tool_ended", { toolCallId: "adv-3", toolName: "read" }, t, c);
      ingest(store, "worker", "tool_ended", { toolCallId: "w-2", toolName: "bash" }, t, c);
      ingest(store, "worker", "tool_ended", { toolCallId: "w-3", toolName: "edit" }, t, c);
    },
  },
  // 14.5s: worker completes (all subagents returned)
  {
    offsetMs: 14500,
    emit: (store, t, c) => {
      ingest(store, "worker", "agent_finished", { state: "completed" }, t, c);
    },
  },
  // 15.5s: main runs verify tool
  {
    offsetMs: 15500,
    emit: (store, t, c) => {
      ingest(store, "root", "tool_started", { toolCallId: "main-2", toolName: "verify" }, t, c);
    },
  },
  // 17.0s: main finishes verify tool
  {
    offsetMs: 17000,
    emit: (store, t, c) => {
      ingest(store, "root", "tool_ended", { toolCallId: "main-2", toolName: "verify" }, t, c);
    },
  },
  // 18.0s: main finishes loop (turn returned idle)
  {
    offsetMs: 18000,
    emit: (store, t, c) => {
      ingest(store, "root", "loop_ended", { state: "idle" }, t, c);
    },
  },
  // 19.0s: main restarts next loop
  {
    offsetMs: 19000,
    emit: (store, t, c) => {
      ingest(store, "root", "loop_started", {}, t, c);
    },
  },
];

const LOOP_PERIOD_MS = 20000;

function runLive(columns: number, rows: number, theme: HostTheme | undefined): void {
  const store = new TreeStore("demo");

  let restored = false;
  const restoreTerminal = () => {
    if (restored) return;
    restored = true;
    if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
      try {
        process.stdin.setRawMode(false);
      } catch {}
    }
    process.stdout.write("\x1b[?25h\x1b[?1049l");
  };

  let timer: Timer | number | undefined;

  const close = () => {
    clearInterval(timer);
    restoreTerminal();
    process.exit(0);
  };

  process.on("SIGINT", close);
  process.on("SIGTERM", close);
  process.on("exit", restoreTerminal);
  process.on("uncaughtException", (err) => {
    restoreTerminal();
    console.error(err);
    process.exit(1);
  });

  // Enter alternate screen and hide cursor
  process.stdout.write("\x1b[?1049h\x1b[?25l");
  if (process.stdin.isTTY && typeof process.stdin.setRawMode === "function") {
    try {
      process.stdin.setRawMode(true);
    } catch {}
  }
  process.stdin.resume();

  const dashboard = new Dashboard(
    store,
    () => (process.stdout.rows && process.stdout.rows > 0 ? process.stdout.rows : rows),
    () => renderNow(),
    close,
    theme,
    () => Date.now(),
  );

  process.stdin.on("data", (chunk: Buffer | string) => {
    dashboard.handleInput(typeof chunk === "string" ? chunk : chunk.toString("utf-8"));
  });

  process.stdout.on("resize", () => {
    renderNow();
  });

  function renderNow(): void {
    if (restored) return;
    const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : columns;
    const lines = dashboard.render(cols);
    process.stdout.write(`\x1b[H${lines.join("\n")}\x1b[J`);
  }

  let cycle = 0;
  let loopStart = Date.now();
  let stepIndex = 0;

  const tick = () => {
    if (restored) return;
    const now = Date.now();
    let elapsed = now - loopStart;

    if (elapsed >= LOOP_PERIOD_MS) {
      loopStart = now;
      elapsed = 0;
      cycle++;
      stepIndex = 0;
      store.nodes.clear();
      store.activity.length = 0;
    }

    while (stepIndex < timeline.length && timeline[stepIndex].offsetMs <= elapsed) {
      const step = timeline[stepIndex];
      step.emit(store, loopStart + step.offsetMs, cycle);
      stepIndex++;
    }

    renderNow();
  };

  tick();
  timer = setInterval(tick, 100);
}

// Parse CLI flags
let columns = 120;
let rows = 46;
let plain = false;
let live = false;

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "--plain") {
    plain = true;
  } else if (arg === "--live") {
    live = true;
  } else if (arg === "--rows") {
    const val = Number(args[++i]);
    if (Number.isFinite(val) && val > 0) rows = Math.floor(val);
  } else if (arg.startsWith("--rows=")) {
    const val = Number(arg.slice(7));
    if (Number.isFinite(val) && val > 0) rows = Math.floor(val);
  } else if (!arg.startsWith("-")) {
    const val = Number(arg);
    if (Number.isFinite(val) && val > 0) columns = Math.floor(val);
  }
}

const useColor = !plain && Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
const theme: HostTheme | undefined = useColor ? darkTheme : undefined;

if (live) {
  runLive(columns, rows, theme);
} else {
  // Deterministic fixed timestamp for reproducible single-frame output
  const FIXED_NOW = 1_700_000_000_000;
  const store = new TreeStore("demo");
  populateStaticScenario(store, FIXED_NOW);
  const dashboard = new Dashboard(store, () => rows, () => {}, () => {}, theme, () => FIXED_NOW);
  console.log(dashboard.render(columns).join("\n"));
}
