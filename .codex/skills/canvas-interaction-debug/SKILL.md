---
name: canvas-interaction-debug
description: Diagnose or implement canvas, pointer, drag, zoom, hover, selection, edge-creation, and render-performance behavior in the topology editor. Use when the task touches `TopologyCanvas`, viewport math, coordinate transforms, or hot interaction loops.
---

# Canvas Interaction Debug

Use this skill for anything inside the high-frequency interaction path.

## First Read

- `src/App.tsx` around `TopologyCanvas`, `moveNodesInDocument`, and `drawBackgroundCanvas`
- `src/utils/geometry.ts`
- `src/utils/topology.ts`

## Invariants

- ROS world coordinates are authoritative.
- Screen Y is inverted relative to world Y.
- `worldToScreen`, `screenToWorld`, and `screenDeltaToWorld` are the only sources of truth for coordinate conversion.
- Background map rendering is separate from SVG overlay rendering.

## Hot-Path Rules

- Avoid broad Zustand subscriptions in hot UI paths.
- For pointer-heavy updates, prefer refs plus `requestAnimationFrame` batching.
- Do not redraw the background canvas for ordinary node drag updates unless map metadata or viewport state changed.
- When moving nodes, update only moved nodes and affected edges if possible.
- Preserve hit targets for edges and nodes after any SVG refactor.

## Workflow

1. Reproduce the interaction bug or identify the interaction being added.
2. Trace whether the issue lives in coordinate math, state transitions, or rendering.
3. Keep view math in `src/utils/geometry.ts`.
4. Keep document mutation logic in `src/utils/topology.ts` or local pure helpers.
5. Keep `TopologyCanvas` focused on event orchestration and rendering.
6. Run `npm run build`.

## Manual Smoke Checklist

- zoom with mouse wheel
- pan with space-drag or middle mouse
- drag one node and multiple selected nodes
- box-select nodes
- create edges in edge mode
- right-click canvas, node, and edge
- verify hover tooltips or chips still follow the cursor
