---
name: fms-topology-refactor
description: Refactor the FMS ROI topology editor safely, especially App.tsx orchestration, TopologyCanvas interaction and render splits, view-state propagation, and simulator module growth, while preserving history, map loading, viewport behavior, and editor or simulator mode boundaries.
---

# FMS Topology Refactor

Use this skill when the codebase needs structural cleanup without changing editor behavior.

## Read First

- `src/App.tsx`
- `src/components/TopologyCanvas.tsx`
- `src/store/editorStore.ts`
- `src/utils/viewState.ts`
- `src/utils/localDraft.ts`
- `src/components/SimulatorWorkspace.tsx`

## When To Use

- `App.tsx` starts accumulating more mode branches, hidden file input flows, autosave wiring, or keyboard routing.
- `TopologyCanvas.tsx` mixes background drawing, pointer math, store mutations, and overlay rendering in the same edit.
- `ViewState` or persistence shape changes need to propagate through defaults, sanitize, restore, and store patching.
- simulator code grows beyond a shell and starts mixing scenario state, mission editing, preview rendering, and planner hooks.

## App Rules

- Keep `App` focused on orchestration, screen switching, and top-level effects.
- Move store-to-prop adaptation into container components or hooks before adding more JSX branches.
- Keep file I/O, autosave, and keyboard routing in `App` or dedicated hooks, not UI leaf components.
- If a container starts doing both selection and heavy derived-state formatting, split it before adding more responsibilities.

## Canvas Rules

- Extract shared drawing helpers first, then pointer helpers, then overlay fragments.
- Keep world or screen math in utils, not inline inside render blocks.
- Separate pure geometry from store mutation logic.
- Do not duplicate raster background drawing between editor and simulator views.
- Keep pointer lifecycle readable in one place even after extraction.

## Store And Persistence Rules

- For view changes, check this order: `src/types.ts` -> `DEFAULT_VIEW_STATE` -> sanitize helpers -> store patch callsites -> local draft restore.
- Preserve `patch*` naming for partial state updates.
- Persist only JSON-safe data. Runtime raster or canvas objects never belong in saved shapes.
- Let store helpers normalize selection and history integrity.

## Simulator Growth Rules

- Split simulator work when mission form state, preview viewport, run controls, and runtime engine start sharing one file.
- Promote simulator types out of local UI state once they gain a second consumer.
- Keep topology snapshot rendering separate from simulation runtime state.
- Treat planner APIs as replaceable modules so later traffic management can slot in cleanly.

## Extraction Recipes

- `App`: split screen assembly and toolbar wiring before extracting deeper behavior.
- `TopologyCanvas`: extract shared background draw utilities before interaction code.
- `View`: centralize default, sanitize, and restore logic together.
- `Simulator`: move mission default or sanitize helpers out of JSX once the UI grows past a single section.

## Validation

- `npm run build`
- map upload -> topology load keeps the matching background raster
- editor and simulator switching does not leak editor shortcuts or context menus
- label toggles, fit, pan or zoom, and local draft restore still behave the same
- multi-selection delete still removes the whole selection

## Avoid

- copying canvas draw logic into new files
- keeping simulator-only types duplicated across `App.tsx` and leaf components
- scattering view defaults and sanitize logic across multiple modules
- letting `App.tsx` become the permanent home for every selector and derived prop
