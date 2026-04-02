import type { ViewState } from "../types";

export const DEFAULT_VIEW_STATE: ViewState = {
  zoom: 24,
  panX: 480,
  panY: 360,
  showNodeLabels: true,
  showEdgeLabels: true,
};

export function sanitizeViewState(view: unknown): ViewState {
  if (!view || typeof view !== "object") {
    return DEFAULT_VIEW_STATE;
  }

  const candidate = view as Partial<ViewState>;

  return {
    zoom:
      typeof candidate.zoom === "number" && Number.isFinite(candidate.zoom)
        ? candidate.zoom
        : DEFAULT_VIEW_STATE.zoom,
    panX:
      typeof candidate.panX === "number" && Number.isFinite(candidate.panX)
        ? candidate.panX
        : DEFAULT_VIEW_STATE.panX,
    panY:
      typeof candidate.panY === "number" && Number.isFinite(candidate.panY)
        ? candidate.panY
        : DEFAULT_VIEW_STATE.panY,
    showNodeLabels:
      typeof candidate.showNodeLabels === "boolean"
        ? candidate.showNodeLabels
        : DEFAULT_VIEW_STATE.showNodeLabels,
    showEdgeLabels:
      typeof candidate.showEdgeLabels === "boolean"
        ? candidate.showEdgeLabels
        : DEFAULT_VIEW_STATE.showEdgeLabels,
  };
}
