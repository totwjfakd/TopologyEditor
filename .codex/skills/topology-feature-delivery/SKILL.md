---
name: topology-feature-delivery
description: Implement end-to-end features in the FMS ROI topology editor. Use when asked to add or change editor behavior, toolbar or inspector flows, node or edge actions, keyboard shortcuts, or persistence-aware UX in this repository.
---

# Topology Feature Delivery

Use this skill for feature work that crosses types, state, UI, and persistence.

## First Read

- `src/types.ts`
- `src/store/editorStore.ts`
- `src/utils/topology.ts`
- `src/App.tsx`
- `src/index.css`

## Project Rules

- `TopologyDocument` is the canonical serializable model.
- Keep persisted data JSON-safe. Do not put `File`, `HTMLCanvasElement`, `HTMLElement`, or other runtime objects inside `TopologyDocument`.
- `MapRaster` is runtime-only and must never be written to JSON export or local draft storage.
- User-facing validation and failure messages are currently Korean. Keep that convention unless asked to change it.
- Run `npm run build` for every non-trivial change.

## Input Contract

Expect the task to clarify:
- visible behavior change
- whether JSON or local draft persistence changes
- whether keyboard or mouse interaction changes
- what counts as done

If the request is underspecified, make the smallest repo-consistent choice and state it in the final report.

## Workflow

1. Update `src/types.ts` first if the data contract changes.
2. Put pure document logic in `src/utils/topology.ts` before wiring store or UI.
3. Put undo/redo-aware transitions in `src/store/editorStore.ts`.
4. Keep `src/App.tsx` focused on orchestration, container components, and rendering.
5. Put visual changes in `src/index.css` rather than expanding inline styles.
6. If import/export or autosave behavior changes, update all affected save/load paths in the same patch.
7. Run `npm run build`.

## State and History Rules

- Use `commitDocument` for durable edits that should create an undo point.
- Use `replaceDocument` for live previews that should not touch history.
- Use `commitFrom(previousDocument, nextDocument)` when a drag or preview begins from one snapshot and commits a different current document at the end.
- Let store helpers normalize selection. Do not hand-maintain dangling selected ids.

## Output Contract

Always report:
- touched files
- whether JSON schema changed
- whether local draft behavior changed
- validation you ran
- any manual smoke checks still recommended
