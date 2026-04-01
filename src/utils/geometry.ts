import type { Point, SelectionBox, TopologyDocument, ViewState } from "../types";

export interface Bounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export function worldToScreen(point: Point, view: ViewState): Point {
  return {
    x: point.x * view.zoom + view.panX,
    y: -point.y * view.zoom + view.panY,
  };
}

export function screenToWorld(point: Point, view: ViewState): Point {
  return {
    x: (point.x - view.panX) / view.zoom,
    y: -(point.y - view.panY) / view.zoom,
  };
}

export function screenDeltaToWorld(
  dx: number,
  dy: number,
  view: ViewState,
): Point {
  return {
    x: dx / view.zoom,
    y: -dy / view.zoom,
  };
}

export function selectionBoxToBounds(box: SelectionBox): Bounds {
  return {
    minX: Math.min(box.start.x, box.end.x),
    maxX: Math.max(box.start.x, box.end.x),
    minY: Math.min(box.start.y, box.end.y),
    maxY: Math.max(box.start.y, box.end.y),
  };
}

export function pointInBounds(point: Point, bounds: Bounds): boolean {
  return (
    point.x >= bounds.minX &&
    point.x <= bounds.maxX &&
    point.y >= bounds.minY &&
    point.y <= bounds.maxY
  );
}

export function documentBounds(
  doc: TopologyDocument,
  mapSize?: { width: number; height: number },
): Bounds {
  const points: Point[] = doc.nodes.map((node) => ({ x: node.x, y: node.y }));

  if (mapSize) {
    const widthM = mapSize.width * doc.map.resolution;
    const heightM = mapSize.height * doc.map.resolution;
    points.push(
      { x: doc.map.origin[0], y: doc.map.origin[1] },
      { x: doc.map.origin[0] + widthM, y: doc.map.origin[1] + heightM },
    );
  }

  if (points.length === 0) {
    return {
      minX: -10,
      maxX: 10,
      minY: -10,
      maxY: 10,
    };
  }

  return points.reduce<Bounds>(
    (acc, point) => ({
      minX: Math.min(acc.minX, point.x),
      maxX: Math.max(acc.maxX, point.x),
      minY: Math.min(acc.minY, point.y),
      maxY: Math.max(acc.maxY, point.y),
    }),
    {
      minX: points[0].x,
      maxX: points[0].x,
      minY: points[0].y,
      maxY: points[0].y,
    },
  );
}

export function fitViewToBounds(
  bounds: Bounds,
  viewportWidth: number,
  viewportHeight: number,
  padding = 48,
): ViewState {
  const width = Math.max(bounds.maxX - bounds.minX, 1);
  const height = Math.max(bounds.maxY - bounds.minY, 1);
  const zoom = Math.max(
    8,
    Math.min(
      (viewportWidth - padding * 2) / width,
      (viewportHeight - padding * 2) / height,
      180,
    ),
  );
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  return {
    zoom,
    panX: viewportWidth / 2 - centerX * zoom,
    panY: viewportHeight / 2 + centerY * zoom,
  };
}

export function clampZoom(nextZoom: number): number {
  return Math.max(8, Math.min(400, nextZoom));
}

export function getNiceDistance(rawDistance: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(Math.max(rawDistance, 0.0001)));
  const normalized = rawDistance / magnitude;

  if (normalized <= 1) {
    return 1 * magnitude;
  }
  if (normalized <= 2) {
    return 2 * magnitude;
  }
  if (normalized <= 5) {
    return 5 * magnitude;
  }

  return 10 * magnitude;
}
