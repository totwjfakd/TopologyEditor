export type NodeType =
  | "destination"
  | "waypoint"
  | "charge_station"
  | "waiting_position";

export type EdgeDirection = "unidirectional" | "bidirectional";

export interface Point {
  x: number;
  y: number;
}

export interface MapMetadata {
  image: string;
  resolution: number;
  origin: [number, number, number];
}

export interface TopologyNode {
  id: string;
  type: NodeType;
  name: string;
  x: number;
  y: number;
}

export interface TopologyEdge {
  id: string;
  from: string;
  to: string;
  direction: EdgeDirection;
  distance_m: number;
  speed_limit: null;
}

export interface TopologyDocument {
  map: MapMetadata;
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface ViewState {
  zoom: number;
  panX: number;
  panY: number;
  showNodeLabels: boolean;
  showEdgeLabels: boolean;
}

export interface SelectionState {
  nodeIds: string[];
  edgeIds: string[];
}

export interface ClipboardData {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
}

export interface MapRaster {
  name: string;
  width: number;
  height: number;
  canvas: HTMLCanvasElement;
}

export type ContextMenuTarget =
  | { kind: "canvas"; world: Point }
  | { kind: "node"; nodeId: string; world: Point }
  | { kind: "edge"; edgeId: string; world: Point };

export interface ContextMenuState {
  x: number;
  y: number;
  target: ContextMenuTarget;
}

export interface SelectionBox {
  start: Point;
  end: Point;
}

export const NODE_TYPE_ORDER: NodeType[] = [
  "destination",
  "waypoint",
  "charge_station",
  "waiting_position",
];

export const NODE_TYPE_META: Record<
  NodeType,
  { label: string; shortLabel: string; color: string; key: string }
> = {
  destination: {
    label: "Destination",
    shortLabel: "DST",
    color: "#1d4ed8",
    key: "1",
  },
  waypoint: {
    label: "Waypoint",
    shortLabel: "WP",
    color: "#6b7280",
    key: "2",
  },
  charge_station: {
    label: "Charge Station",
    shortLabel: "CHG",
    color: "#15803d",
    key: "3",
  },
  waiting_position: {
    label: "Waiting Position",
    shortLabel: "WAIT",
    color: "#c2410c",
    key: "4",
  },
};
