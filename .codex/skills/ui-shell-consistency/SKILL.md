---
name: ui-shell-consistency
description: Update the toolbar, inspector, dialogs, context menu, status bar, notices, and CSS shell of the topology editor while preserving the existing product language and visual system. Use when the task is primarily UI or UX polish outside the core canvas math.
---

# UI Shell Consistency

Use this skill for non-trivial UI work that is not dominated by canvas math.

## First Read

- `src/App.tsx` sections for `Toolbar`, `InspectorPanel`, `ContextMenuView`, `NodeEditorDialog`, and `StatusBar`
- `src/index.css`

## Visual Rules

- Preserve the current warm-paper palette, rounded surfaces, soft shadows, and orange accent.
- Keep controls legible over the textured background.
- Match the repo’s current language mix: control labels are mostly English, while validation and failure messages are Korean.
- Prefer CSS classes over large inline style expansions.

## Structural Rules

- If a component grows, split container logic from presentational markup.
- Keep toolbar and inspector actions aligned with existing store flows.
- Avoid introducing a new UI library for small changes.

## Workflow

1. Update presentational markup in `src/App.tsx`.
2. Update styles in `src/index.css`.
3. If the UI exposes new data, wire it through types, helpers, and store in the same patch.
4. Run `npm run build`.

## Manual Smoke Checklist

- toolbar buttons remain clickable
- inspector still reflects current selection
- context menu positions correctly
- notices and dialogs do not overlap critical controls
- layout remains usable on a narrow viewport
