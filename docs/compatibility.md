# Compatibility and validation

Pinned host: **@oh-my-pi/pi-coding-agent 18.8.6**. Development runtime: Bun 1.4.2 and TypeScript 5.8.3. The shipped extension consumes a small structural subset of `ExtensionAPI` in `src/host.ts`, avoiding imports of OMP's private internals. The compatibility check uses actual host internals only as a test harness.

The local host source was inspected for `ctx.agent`, request-scoped `ctx.model`, `pi.events`, managed timers, child extension rebinding, task lifecycle/progress/raw frames, and overlay cleanup. Official references: [extensions](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md) and [extension loading](https://github.com/can1357/oh-my-pi/blob/main/docs/extension-loading.md). Those online guides follow main; the installed package source is the authority for this pin.

`npm run check:host` verifies package-directory discovery through `omp.extensions`, actual factory loading, fresh child API rebinding, session-file parent correlation, model observation at the provider hook, payload preservation, concurrent tool correlation, redraws while the dashboard command is pending, closing without aborting work, and shutdown cleanup. It uses actual OMP session managers, extension APIs, event buses, and runners, with fixture events and a simulated UI. It does not call a provider or execute real delegated tasks.

The automated suite covers parallel and nested identities, children arriving before parents, independent root sessions with identical agent IDs, session switching with late child lifecycle events, model changes, repeated turns, continuation, cancellation, missing parents, cycles, duplicate/malformed telemetry, log retention, Unicode/control sequences, Kitty keyboard input, navigation, selection stability, responsive rendering, headless mode, and timer/subscription cleanup.

Runtime coverage and limits:

| Surface | Behavior |
| --- | --- |
| Main session | Lifecycle, request models, finalized assistant models, executed tools, bounded task summary |
| Task / eval children with rebound factories | Child handlers feed the shared root store after header or lifecycle file correlation; nested collectors do the same |
| Restricted children | OMP's SDK retains prepared factories and hooks, while omitting extension tools; this extension contributes no tools. Rebinding is tested, but a real restricted spawn still needs a provider smoke test |
| Children omitting the factory | The spawning collector bridges direct lifecycle/progress/raw frames; model remains unknown until an assistant frame arrives |
| In-memory children with no ancestry/file correlation | Direct spawn frames still show nodes when a known parent tool call links them. Their detached collectors cannot be safely assigned to a root, so their nested activity may be unavailable |
| `/tan` clones | Child identity is `kind: "sub"`, including depth zero. Header ancestry can link them. Real clone spawning has not been exercised |
| Advisor | OMP explicitly tags intercepted tools with advisor identity and parent ID. These appear as a scoped consultation node. The intercepted context's model belongs to the hosting session, so advisor model and whole-consultation lifecycle stay unknown unless an adapter supplies them |
| Custom router/advisor plugin | Only explicitly published v1 telemetry is visible |
| Cross-process / historical sessions | No aggregation or replay; data is held in the current process only |

Each factory subscribes to its own `pi.events` bus. A main collector opens its own root store. Child factories initially buffer up to 256 normalized events when their root is unknown. Header ancestry or a lifecycle frame's matching session file attaches that buffer to a known root. A parent tool-call ID supplies the spawning parent identity. Agent names alone never identify a root. An old child's known association takes priority over the currently selected session.

The host's separate internal root observability bus is not part of `ExtensionAPI`. The extension therefore combines per-session collectors and direct spawn-frame bridges rather than reaching into that private bus. If a custom SDK caller excludes collectors, ancestry, and spawn telemetry, the unavailable activity cannot be reconstructed.

Stores retain up to 4,096 event IDs for deduplication, 512 completed tool IDs per node for late-result correlation, 50 events per agent, 200 global activity entries, and 200 completed nodes by default. Referenced ancestors may exceed the completed-node limit to preserve tree relationships. Redraw requests are coalesced at 100 ms; elapsed clocks refresh once per second. Timers exist only while the overlay is open and use OMP's managed timer API.

For a provider-backed smoke test, start `omp -e .` with your normal model setup, open the tree with Ctrl+Shift+T during a turn, spawn parallel and nested tasks, switch models, interrupt a child, close the overlay, and verify chat and inference continue. Exercise `/tan`, restricted agents, and custom routing on the same pinned host. These provider-backed paths are explicitly unverified by the offline check.
