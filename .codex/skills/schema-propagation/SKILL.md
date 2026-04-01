---
name: schema-propagation
description: Propagate changes to `TopologyDocument`, node, edge, map, view, or selection shape across types, defaults, normalization, state, UI, JSON persistence, and local draft handling in this repository.
---

# Schema Propagation

Use this skill whenever a field is added, renamed, removed, or reinterpreted.

## First Read

- `src/types.ts`
- `src/utils/topology.ts`
- `src/store/editorStore.ts`
- `src/App.tsx`

## Change Order

1. `src/types.ts`
2. `src/utils/topology.ts`
3. `src/store/editorStore.ts`
4. `src/App.tsx`
5. `src/index.css` if the field becomes visible in UI

## Coverage Checklist

For every schema change, verify these functions or flows if applicable:
- `createEmptyDocument`
- `cloneDocument`
- `sanitizeLoadedDocument`
- copy/paste helpers
- edge-distance recalculation
- store defaults and history commits
- JSON save/load
- local draft read/write helpers
- inspector, dialog, context menu, and status bar rendering

## Rules

- Persist only serializable data in `TopologyDocument`.
- Keep derived fields derived. Recompute centrally instead of trusting stale imported values.
- If a new field should not survive export, keep it out of `TopologyDocument`.
- Run `npm run build`.

## Manual Smoke Checklist

- create a fresh document using new defaults
- save JSON and load it back
- reload the page and restore from local draft
- verify the inspector or dialog can display and edit the new field if required
