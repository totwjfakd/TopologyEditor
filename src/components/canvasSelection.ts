import type { SelectionState } from "../types";

type ContextSelectionTarget =
  | { kind: "node"; id: string }
  | { kind: "edge"; id: string };

export function getContextMenuSelection(
  current: SelectionState,
  target: ContextSelectionTarget,
): SelectionState {
  const alreadySelected = target.kind === "node"
    ? current.nodeIds.includes(target.id)
    : current.edgeIds.includes(target.id);

  if (alreadySelected) {
    return current;
  }

  return target.kind === "node"
    ? { nodeIds: [target.id], edgeIds: [] }
    : { nodeIds: [], edgeIds: [target.id] };
}
