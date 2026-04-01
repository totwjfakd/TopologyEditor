---
name: state-history-persistence
description: Maintain editor state, undo or redo history, selection, clipboard, JSON-safe local draft storage, and persistence-related workflows in this repository. Use when the task touches `editorStore`, autosave, load or restore behavior, or history correctness.
---

# State History Persistence

Use this skill when correctness matters more than presentation.

## First Read

- `src/store/editorStore.ts`
- `src/utils/topology.ts`
- `src/App.tsx` local draft helpers and save/load flows
- `src/types.ts`

## State Ownership

`editorStore` owns:
- `document`
- `selection`
- `nodeType`
- `edgeMode`
- `view`
- `mouseWorld`
- `clipboard`
- `historyPast`
- `historyFuture`

## History Rules

- `commitDocument` pushes the previous document into history and clears redo history.
- `commitFrom` is for preview-to-commit flows such as drags.
- `replaceDocument` is preview-only and must not create an undo point.
- `loadDocument` resets selection and history.

## Persistence Rules

- Local draft storage is limited to `{ version, savedAt, document, view }`.
- Never store `MapRaster`, `File`, `canvas`, DOM nodes, or callbacks in local draft storage.
- Any persisted structure change must update both JSON load/save behavior and local draft normalization.
- Keep selection normalization centralized.

## Workflow

1. Change pure document helpers first.
2. Update store transitions second.
3. Update `App.tsx` orchestration for load, save, restore, or UX messaging last.
4. Run `npm run build`.

## Manual Smoke Checklist

- create node, undo, redo
- drag node, undo, redo
- copy, paste, delete
- reload page and confirm local draft offer appears only when work exists
- restore draft and confirm map raster still requires manual re-upload
