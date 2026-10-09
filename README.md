# OMP Let Me See

A native TypeScript extension implementing [the design](./omp-agent-tree-design.md). Open `/agent-tree` to see the main agent, subagents, their runtime parent links, observed models, state, concurrent tools, elapsed time, task summaries, and bounded activity history. Inference continues while the dashboard is open. Closing it returns to chat.

The compatibility target is **Oh My Pi 18.8.6**, with Bun 1.3 or later. The extension has no runtime dependencies, network service, browser, or build step. It adds no tools and returns no event overrides.

From this directory, try it without installing:

```sh
omp -e .
```

Inside OMP, run `/agent-tree`. Press **Ctrl+Shift+T** to open it while the agent is working; some terminals reserve this shortcut, so use the slash command if necessary. To install the directory as a persistent OMP plugin:

```sh
omp plugin install /absolute/path/to/let-me-see
```

Restart OMP after installing. The `omp.extensions` package manifest loads `src/index.ts`. Use either explicit loading or installation to avoid loading it twice. The extension supports interactive terminal mode; a headless command gives an informational notification.

Navigation:

| Key | Action |
| --- | --- |
| ↑/↓ or j/k | Select agent; scroll history when details have focus |
| Page Up / Page Down | Scroll a page |
| g / G, Home / End | Select first / last agent |
| Space, ←/h, →/l | Toggle, collapse, expand a subtree |
| c | Collapse / expand completed subtrees |
| Tab | Move focus between tree and details |
| Enter or d | Hide / show details |
| q, Escape, Ctrl+C | Close dashboard; inference continues |

At 100 columns or more, details appear beside the tree. Smaller terminals stack the panes. Large trees scroll, selection follows runtime IDs, and missing or cyclic parent relationships remain visibly unresolved. Completed nodes remain until the configured retention limit is reached; ancestors needed by retained descendants stay visible.

Models appear only after an actual provider request or assistant message is observed. Configured model selectors are never presented as an observed model. A normal agent loop ending sets the node idle; task lifecycle completion sets it completed, failed, or cancelled. A later loop can reuse that node. Missing fields display as unknown.

The main task summary is the first prompt line, capped at 160 characters. Child task summaries come from the host's progress telemetry, capped at 2,048 characters. Logs contain event metadata only: no full prompts, images, tool arguments, or tool outputs. All data stays in memory. Archived session trees are capped at eight; session IDs isolate unrelated roots even when agent names repeat.

To customize labels, state colors, or retention, create a wrapper extension and load it instead of the default entry point:

```ts
import { createAgentTreeExtension } from "/absolute/path/to/let-me-see/src/index.ts";

export default createAgentTreeExtension({
  historyLimit: 50,          // entries per agent
  activityLimit: 200,        // activity strip history
  completedLimit: 200,       // completed nodes; needed ancestors are retained
  labels: { "Main": "My session" }, // runtime agent ID -> display label
  colors: { running: "accent", completed: "success" },
});
```

State colors accept `accent`, `success`, `warning`, `error`, `dim`, or `muted`, using the active OMP theme. No agent role or model family is assigned a special color.

Custom routers and orchestrators can publish explicit telemetry with `publishTelemetry` on `agent-tree:telemetry:v1`. The v1 contract is exported from [src/events.ts](./src/events.ts). Each event includes `schemaVersion`, a unique `eventId`, timestamp in Unix milliseconds, source, `rootSessionId`, producer `sessionId`, runtime `agentId`, type, and payload. Root IDs must match the main session's `ctx.sessionManager.getSessionId()`. Agent IDs must be unique within that root; use a producer namespace for custom nodes. Tool IDs correlate concurrent start/end frames.

Event types are `agent_observed`, `loop_started`, `loop_ended`, `agent_finished`, `model_observed`, `tool_started`, `tool_ended`, and `task_updated`. `agent_finished` requires a terminal state. Tool events require `toolCallId` and `toolName`. Consultation links require explicit `relation: "consultation"` plus `parentId`. Invalid frames, wrong-root frames, duplicate IDs, and fields outside the schema are ignored.

[examples/custom-telemetry.ts](./examples/custom-telemetry.ts) is a runnable producer. Load it alongside the tree:

```sh
omp -e . -e ./examples/custom-telemetry.ts
```

Run `/agent-tree-example`, then `/agent-tree`. The example creates a clearly labelled consultation without calling a model. Replace its command with your integration's real notifications. Arbitrary plugin internals and unreported consultations cannot be discovered.

Development checks:

```sh
npm ci
npm run typecheck
npm test
npm run check:host  # requires installed OMP 18.8.6; never calls a model
npm run demo -- 120 # deterministic tree structure with illustrative model labels
npm pack
```

The host check finds `omp` on PATH; set `OMP_PACKAGE_DIR` if using an executable distribution without the source package. It uses temporary configuration and sessions, the real extension loader and runner, factory rebinding, and a simulated UI surface. See [docs/compatibility.md](./docs/compatibility.md) for verified coverage and remaining runtime limitations.
