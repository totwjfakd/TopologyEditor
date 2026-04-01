---
name: build-and-smoke-verify
description: Validate changes in the FMS ROI topology editor. Use when asked to verify a fix, review a change, or finish a feature by running build checks and the relevant manual smoke checklist.
---

# Build And Smoke Verify

Use this skill as the final verification pass.

## Baseline Validation

Always run:
- `npm run build`

## Choose the Matching Smoke Checklist

### Canvas or interaction changes

- zoom and pan
- node drag
- box select
- edge creation
- right-click menus

### State or persistence changes

- undo and redo
- copy and paste
- JSON save and load
- reload page and check local draft restore

### Map file changes

- upload YAML and PGM together
- confirm basename validation
- confirm invalid files fail clearly

## Review Output Rules

If asked for a review:
- list findings first, highest severity first
- call out data-loss risks, coordinate mistakes, and undo/redo corruption before style issues
- mention unverified behavior explicitly if browser interaction was not exercised
