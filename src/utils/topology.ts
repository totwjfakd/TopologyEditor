import type {
  ClipboardData,
  EdgeDirection,
  NodeType,
  Point,
  SelectionState,
  TopologyDocument,
  TopologyEdge,
  TopologyNode,
} from "../types";
import { NODE_TYPE_META } from "../types";

export const DEFAULT_RESOLUTION = 0.05;

export function createEmptyDocument(): TopologyDocument {
  return {
    map: {
      image: "",
      resolution: DEFAULT_RESOLUTION,
      origin: [0, 0, 0],
    },
    nodes: [],
    edges: [],
  };
}

export function cloneDocument(doc: TopologyDocument): TopologyDocument {
  return {
    map: {
      image: doc.map.image,
      resolution: doc.map.resolution,
      origin: [...doc.map.origin] as [number, number, number],
    },
    nodes: doc.nodes.map((node) => ({ ...node })),
    edges: doc.edges.map((edge) => ({ ...edge })),
  };
}

export function roundMeters(value: number): number {
  return Math.round(value * 100) / 100;
}

export function getEdgeDistance(a: Point, b: Point): number {
  return roundMeters(Math.hypot(a.x - b.x, a.y - b.y));
}

export function recalculateEdgeDistances(doc: TopologyDocument): TopologyDocument {
  const nodeMap = new Map(doc.nodes.map((node) => [node.id, node]));
  doc.edges = doc.edges
    .filter((edge) => nodeMap.has(edge.from) && nodeMap.has(edge.to))
    .map((edge) => {
      const fromNode = nodeMap.get(edge.from)!;
      const toNode = nodeMap.get(edge.to)!;

      return {
        ...edge,
        distance_m: getEdgeDistance(fromNode, toNode),
      };
    });

  return doc;
}

export function nextSequentialId(
  prefix: "node" | "edge",
  existingIds: string[],
): string {
  const nextNumber =
    existingIds.reduce((maxValue, id) => {
      const match = id.match(new RegExp(`^${prefix}_(\\d+)$`));
      if (!match) {
        return maxValue;
      }

      return Math.max(maxValue, Number(match[1]));
    }, 0) + 1;

  return `${prefix}_${String(nextNumber).padStart(3, "0")}`;
}

export function generateUniqueName(
  baseName: string,
  usedNames: Set<string>,
): string {
  const trimmed = baseName.trim() || "Unnamed";
  if (!usedNames.has(trimmed)) {
    return trimmed;
  }

  let index = 2;
  while (usedNames.has(`${trimmed} ${index}`)) {
    index += 1;
  }

  return `${trimmed} ${index}`;
}

export function generateDefaultNodeName(
  type: NodeType,
  existingNames: string[],
): string {
  const usedNames = new Set(existingNames);
  const base = NODE_TYPE_META[type].label;

  let index = 1;
  while (usedNames.has(`${base} ${index}`)) {
    index += 1;
  }

  return `${base} ${index}`;
}

export function normalizeName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

export function isNameUnique(
  name: string,
  nodes: TopologyNode[],
  ignoreId?: string,
): boolean {
  const normalized = normalizeName(name);

  return nodes.every(
    (node) => node.id === ignoreId || normalizeName(node.name) !== normalized,
  );
}

export function createNodeRecord(
  doc: TopologyDocument,
  point: Point,
  type: NodeType,
): TopologyNode {
  return {
    id: nextSequentialId(
      "node",
      doc.nodes.map((node) => node.id),
    ),
    type,
    name: generateDefaultNodeName(
      type,
      doc.nodes.map((node) => node.name),
    ),
    x: roundMeters(point.x),
    y: roundMeters(point.y),
  };
}

export function createEdgeRecord(
  doc: TopologyDocument,
  fromId: string,
  toId: string,
  direction: EdgeDirection,
): TopologyEdge | null {
  const fromNode = doc.nodes.find((node) => node.id === fromId);
  const toNode = doc.nodes.find((node) => node.id === toId);

  if (!fromNode || !toNode || fromId === toId) {
    return null;
  }

  return {
    id: nextSequentialId(
      "edge",
      doc.edges.map((edge) => edge.id),
    ),
    from: fromId,
    to: toId,
    direction,
    distance_m: getEdgeDistance(fromNode, toNode),
    speed_limit: null,
  };
}

export function mergeOrCreateEdge(
  doc: TopologyDocument,
  fromId: string,
  toId: string,
): { doc: TopologyDocument; edgeId: string | null } {
  const nextDoc = cloneDocument(doc);

  const exact = nextDoc.edges.find(
    (edge) => edge.from === fromId && edge.to === toId,
  );
  if (exact) {
    return { doc: nextDoc, edgeId: exact.id };
  }

  const reverse = nextDoc.edges.find(
    (edge) => edge.from === toId && edge.to === fromId,
  );
  if (reverse) {
    reverse.direction = "bidirectional";
    return { doc: nextDoc, edgeId: reverse.id };
  }

  const created = createEdgeRecord(nextDoc, fromId, toId, "unidirectional");
  if (!created) {
    return { doc: nextDoc, edgeId: null };
  }

  nextDoc.edges.push(created);
  return { doc: nextDoc, edgeId: created.id };
}

export function deleteSelectionFromDocument(
  doc: TopologyDocument,
  selection: SelectionState,
): TopologyDocument {
  const nextDoc = cloneDocument(doc);
  const nodeIds = new Set(selection.nodeIds);
  const edgeIds = new Set(selection.edgeIds);

  nextDoc.nodes = nextDoc.nodes.filter((node) => !nodeIds.has(node.id));
  nextDoc.edges = nextDoc.edges.filter(
    (edge) =>
      !edgeIds.has(edge.id) && !nodeIds.has(edge.from) && !nodeIds.has(edge.to),
  );

  return nextDoc;
}

export function buildClipboard(
  doc: TopologyDocument,
  selection: SelectionState,
): ClipboardData | null {
  if (selection.nodeIds.length === 0) {
    return null;
  }

  const selectedNodeIds = new Set(selection.nodeIds);
  const nodes = doc.nodes
    .filter((node) => selectedNodeIds.has(node.id))
    .map((node) => ({ ...node }));
  const edges = doc.edges
    .filter(
      (edge) =>
        selectedNodeIds.has(edge.from) && selectedNodeIds.has(edge.to),
    )
    .map((edge) => ({ ...edge }));

  return { nodes, edges };
}

export function pasteClipboard(
  doc: TopologyDocument,
  clipboard: ClipboardData,
  target: Point,
): { doc: TopologyDocument; selection: SelectionState } {
  const nextDoc = cloneDocument(doc);
  const usedNames = new Set(nextDoc.nodes.map((node) => normalizeName(node.name)));

  const xValues = clipboard.nodes.map((node) => node.x);
  const yValues = clipboard.nodes.map((node) => node.y);
  const center = {
    x: (Math.min(...xValues) + Math.max(...xValues)) / 2,
    y: (Math.min(...yValues) + Math.max(...yValues)) / 2,
  };

  const delta = {
    x: target.x - center.x,
    y: target.y - center.y,
  };

  const nodeIdMap = new Map<string, string>();
  const pastedNodes = clipboard.nodes.map((node) => {
    const id = nextSequentialId(
      "node",
      nextDoc.nodes.map((item) => item.id).concat([...nodeIdMap.values()]),
    );
    const name = generateUniqueName(normalizeName(node.name), usedNames);
    usedNames.add(name);
    nodeIdMap.set(node.id, id);

    return {
      ...node,
      id,
      name,
      x: roundMeters(node.x + delta.x),
      y: roundMeters(node.y + delta.y),
    };
  });

  const pastedEdges = clipboard.edges.flatMap((edge) => {
    const from = nodeIdMap.get(edge.from);
    const to = nodeIdMap.get(edge.to);
    if (!from || !to) {
      return [];
    }

    return [
      {
        ...edge,
        id: nextSequentialId(
          "edge",
          nextDoc.edges.map((item) => item.id),
        ),
        from,
        to,
      },
    ];
  });

  nextDoc.nodes.push(...pastedNodes);
  nextDoc.edges.push(...pastedEdges);
  recalculateEdgeDistances(nextDoc);

  return {
    doc: nextDoc,
    selection: {
      nodeIds: pastedNodes.map((node) => node.id),
      edgeIds: pastedEdges.map((edge) => edge.id),
    },
  };
}

export function sanitizeLoadedDocument(rawValue: unknown): TopologyDocument {
  const raw = typeof rawValue === "object" && rawValue ? rawValue : {};
  const source = raw as Record<string, unknown>;
  const rawMap =
    typeof source.map === "object" && source.map ? source.map : undefined;
  const rawMapRecord = rawMap as Record<string, unknown> | undefined;
  const rawNodes = Array.isArray(source.nodes) ? source.nodes : [];
  const rawEdges = Array.isArray(source.edges) ? source.edges : [];
  const rawResolution = rawMapRecord?.resolution;

  const map = {
    image: typeof rawMapRecord?.image === "string" ? String(rawMapRecord.image) : "",
    resolution:
      typeof rawResolution === "number" && Number.isFinite(rawResolution) && rawResolution > 0
        ? Number(rawResolution)
        : DEFAULT_RESOLUTION,
    origin: parseOrigin(rawMapRecord?.origin),
  } satisfies TopologyDocument["map"];

  const usedNodeIds = new Set<string>();
  const usedNames = new Set<string>();
  const nodes: TopologyNode[] = rawNodes.flatMap((entry) => {
    if (typeof entry !== "object" || !entry) {
      return [];
    }

    const node = entry as Record<string, unknown>;
    const type = getNodeType(node.type);
    const id =
      typeof node.id === "string" && node.id.trim() && !usedNodeIds.has(node.id)
        ? node.id
        : nextSequentialId("node", [...usedNodeIds]);
    const name = generateUniqueName(
      typeof node.name === "string" ? normalizeName(node.name) : NODE_TYPE_META[type].label,
      usedNames,
    );
    usedNodeIds.add(id);
    usedNames.add(name);

    return [
      {
        id,
        type,
        name,
        x: toFiniteNumber(node.x),
        y: toFiniteNumber(node.y),
      },
    ];
  });

  const existingNodeIds = new Set(nodes.map((node) => node.id));
  const usedEdgeIds = new Set<string>();
  const edges: TopologyEdge[] = rawEdges.flatMap((entry) => {
    if (typeof entry !== "object" || !entry) {
      return [];
    }

    const edge = entry as Record<string, unknown>;
    if (
      typeof edge.from !== "string" ||
      typeof edge.to !== "string" ||
      !existingNodeIds.has(edge.from) ||
      !existingNodeIds.has(edge.to) ||
      edge.from === edge.to
    ) {
      return [];
    }

    const id =
      typeof edge.id === "string" && edge.id.trim() && !usedEdgeIds.has(edge.id)
        ? edge.id
        : nextSequentialId("edge", [...usedEdgeIds]);
    usedEdgeIds.add(id);

    return [
      {
        id,
        from: edge.from,
        to: edge.to,
        direction:
          edge.direction === "bidirectional"
            ? "bidirectional"
            : "unidirectional",
        distance_m: 0,
        speed_limit: null,
      },
    ];
  });

  return recalculateEdgeDistances({
    map,
    nodes,
    edges,
  });
}

function getNodeType(value: unknown): NodeType {
  if (
    value === "destination" ||
    value === "waypoint" ||
    value === "charge_station" ||
    value === "waiting_position"
  ) {
    return value;
  }

  return "destination";
}

function parseOrigin(value: unknown): [number, number, number] {
  if (
    Array.isArray(value) &&
    value.length >= 3 &&
    value.every((item) => typeof item === "number" && Number.isFinite(item))
  ) {
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }

  return [0, 0, 0];
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return roundMeters(value);
  }

  return 0;
}
