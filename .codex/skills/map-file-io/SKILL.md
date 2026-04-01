---
name: map-file-io
description: Implement or debug ROS map YAML and PGM parsing, topology JSON import or export, and file-validation behavior in this repository. Use when the task touches map ingestion, topology serialization, or file-format rules.
---

# Map File IO

Use this skill for all parsing and serialization work.

## First Read

- `src/utils/mapFiles.ts`
- `src/utils/topology.ts` via `sanitizeLoadedDocument`
- `src/App.tsx` upload, load, and save handlers
- `src/types.ts`

## Format Rules

- ROS YAML must provide a positive `resolution`, a three-value `origin`, and a non-empty `image`.
- PGM parsing currently supports only `P2` and `P5`.
- Exported topology JSON stores only `map`, `nodes`, and `edges`.
- Loading topology JSON must clear the runtime raster and require manual map re-upload.
- YAML `image` basename must match the uploaded PGM basename.
- Validation errors should remain Korean.

## Workflow

1. Update parser or serializer logic in `src/utils/mapFiles.ts` or `src/utils/topology.ts` first.
2. Update the corresponding UI flow in `src/App.tsx`.
3. If schema normalization changes, update `sanitizeLoadedDocument` in the same patch.
4. Run `npm run build`.

## Regression Targets

- invalid YAML should fail with a clear message
- invalid or truncated PGM should fail cleanly
- exported JSON should load back through `sanitizeLoadedDocument`
- imported JSON should preserve node and edge ids when valid
