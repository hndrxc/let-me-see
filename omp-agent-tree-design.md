# OMP Agent Tree — Lightweight Design

**Status:** Proposed extension · **Date:** October 8, 2026

## Idea

Build a live terminal dashboard for Oh My Pi (OMP) that shows the main agent, subagents, and observable advisor activity as a connected tree. Use the supplied terminal-style image as visual inspiration. The tree should reflect the user's actual runtime setup rather than assume particular roles, models, or delegation patterns.

Users should be able to answer: **Who is working, on what, under which parent, and using which model?**

## First release

- `/agent-tree` opens a terminal dashboard while work continues; closing it returns to chat.
- Nodes appear as agents are observed and connect through runtime parent IDs.
- Each node shows name, actual model, activity state, current tool, and elapsed time.
- Selecting a node opens a detail pane with its task and a bounded activity history.
- Completed nodes remain visible for the current run and can be collapsed.
- Layout adapts to terminal width, with scrolling and compact rows for large trees.

Keep the first release observational. Run control, browser visualization, cross-process aggregation, and historical replay are later additions.

## Technical approach

Implement an installable TypeScript extension using OMP's extension API. A native extension avoids a separate Python service or mandatory browser backend.

| Component | Responsibility |
| --- | --- |
| OMP collector | Subscribe to runtime events in main and child sessions |
| Event normalizer | Convert host payloads into a versioned internal event format |
| Tree store | Track agents, parent relationships, tool activity, and run state |
| Terminal renderer | Draw nodes, connectors, selection, details, and activity log |
| Adapter interface | Accept optional telemetry from custom routers or orchestrators |

OMP documents child-session extension rebinding, agent identity with optional parent IDs, model access, lifecycle notifications, and tool execution events. These are the foundation; event coverage and terminal rendering behavior must be verified against a pinned OMP version before implementation.

Collectors update one session-scoped store. Child instances contribute events; only the main instance owns the dashboard. Isolate stores by root session identity so shared module state cannot mix unrelated runs. Batch redraws, keep handlers short, and dispose subscriptions and timers on shutdown.

## Adapting to custom setups

Use runtime IDs for identity and runtime names for labels. Do not hardcode worker, explorer, researcher, advisor, or any model family. Distinguish configured preferences from the model actually observed on a request.

Show only relationships supported by telemetry. An unknown parent stays visibly unresolved until it can be linked. Optional user settings can override labels, colors, grouping, and the number of retained completed nodes.

Custom plugins can publish normalized events through an adapter or shared event bus. Routing confidence, advisor consultations, and custom decision layers appear only when those integrations provide them. Arbitrary plugin internals cannot be discovered automatically.

## Minimal data model

**Agent node:** root/session ID, agent ID, parent ID, name, kind, observed model, state, start/end time, active tool calls, and optional task summary.

**Event:** schema version, event ID, timestamp, source, session ID, agent ID, type, and payload.

Use agent and tool-call IDs to correlate activity. Deduplicate events, tolerate children arriving before parents, and track concurrent tools separately. Suggested states are idle, running, completed, failed, cancelled, and unknown. Finishing one agent loop must not imply that the agent session is permanently finished. Unavailable fields display as unknown rather than estimated facts.

## Visual behavior

Place the main agent at the top with descendants below. Use consistent role-independent colors and explicit state labels. Preserve node positions where possible so new activity does not constantly rearrange the view. Show advisors as a separate relationship only when consultation telemetry supports it.

The activity strip records short events such as agent started, tool started, model changed, and task returned. Full prompts and tool outputs are excluded from the default view. Token and cost metrics are optional follow-up features and require reliable attributed usage data.

## Delivery and validation

1. **Compatibility spike:** prove child event capture, parent correlation, model observation, and a live terminal view during inference. Check whether restricted child sessions omit the extension; if so, document the gap or add a host bridge.
2. **MVP:** deliver the collector, tree store, terminal dashboard, navigation, and bounded activity log.
3. **Integrations:** define the adapter contract and add one example custom telemetry producer.

Validate with parallel agents, nested delegation where supported, model changes, repeated turns, cancellation, session switching, missing parents, and narrow terminals. The dashboard must preserve existing extension behavior and remain responsive without changing prompts, routing, or tool results.

## Open implementation questions

- Which OMP version and spawning paths will the first release support?
- Which terminal UI surface best preserves live chat and inference behavior?
- How much advisor and custom-router telemetry is available without adapters?
- Should a future recorder persist events independently or attach them to OMP sessions?

## Reference

[OMP extension documentation](https://github.com/can1357/oh-my-pi/blob/main/docs/extensions.md). API names are version-sensitive; this document proposes a design, not a tested implementation.
