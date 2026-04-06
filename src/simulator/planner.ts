import type { TopologyDocument, TopologyNode } from "../types";
import type { SimulatorRouteSegment } from "./types";

type GraphNeighbor = {
  toNodeId: string;
  edgeId: string;
  distanceM: number;
};

export type RobotGraph = {
  nodes: Map<string, TopologyNode>;
  adjacency: Map<string, GraphNeighbor[]>;
};

export type PlannedPath = {
  nodeIds: string[];
  segments: Array<{
    edgeId: string;
    fromNodeId: string;
    toNodeId: string;
    distanceM: number;
  }>;
  distanceM: number;
};

export type PlannedRoute = {
  segments: SimulatorRouteSegment[];
  totalDistanceM: number;
  emptyDistanceM: number;
  loadedDistanceM: number;
};

type CameFromEntry = {
  fromNodeId: string;
  edgeId: string;
  distanceM: number;
};

export function buildRobotGraph(document: TopologyDocument): RobotGraph {
  const nodes = new Map(document.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, GraphNeighbor[]>();

  for (const node of document.nodes) {
    adjacency.set(node.id, []);
  }

  for (const edge of document.edges) {
    adjacency.get(edge.from)?.push({
      toNodeId: edge.to,
      edgeId: edge.id,
      distanceM: edge.distance_m,
    });

    if (edge.direction === "bidirectional") {
      adjacency.get(edge.to)?.push({
        toNodeId: edge.from,
        edgeId: edge.id,
        distanceM: edge.distance_m,
      });
    }
  }

  return { nodes, adjacency };
}

export function planShortestPath(
  graph: RobotGraph,
  startNodeId: string,
  goalNodeId: string,
): PlannedPath | null {
  if (!graph.nodes.has(startNodeId) || !graph.nodes.has(goalNodeId)) {
    return null;
  }

  if (startNodeId === goalNodeId) {
    return {
      nodeIds: [startNodeId],
      segments: [],
      distanceM: 0,
    };
  }

  const open = new Set<string>([startNodeId]);
  const cameFrom = new Map<string, CameFromEntry>();
  const gScore = new Map<string, number>([[startNodeId, 0]]);
  const fScore = new Map<string, number>([
    [startNodeId, heuristic(graph.nodes.get(startNodeId)!, graph.nodes.get(goalNodeId)!)],
  ]);

  while (open.size > 0) {
    const currentNodeId = getLowestScoreNode(open, fScore);
    if (!currentNodeId) {
      break;
    }

    if (currentNodeId === goalNodeId) {
      return reconstructPath(goalNodeId, cameFrom);
    }

    open.delete(currentNodeId);
    const currentScore = gScore.get(currentNodeId) ?? Number.POSITIVE_INFINITY;

    for (const neighbor of graph.adjacency.get(currentNodeId) ?? []) {
      const tentativeScore = currentScore + neighbor.distanceM;
      if (tentativeScore >= (gScore.get(neighbor.toNodeId) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      cameFrom.set(neighbor.toNodeId, {
        fromNodeId: currentNodeId,
        edgeId: neighbor.edgeId,
        distanceM: neighbor.distanceM,
      });
      gScore.set(neighbor.toNodeId, tentativeScore);
      fScore.set(
        neighbor.toNodeId,
        tentativeScore + heuristic(graph.nodes.get(neighbor.toNodeId)!, graph.nodes.get(goalNodeId)!),
      );
      open.add(neighbor.toNodeId);
    }
  }

  return null;
}

export function planMissionRoute(
  graph: RobotGraph,
  currentNodeId: string,
  missionStops: string[],
): PlannedRoute | null {
  if (missionStops.length < 2) {
    return null;
  }

  const segments: SimulatorRouteSegment[] = [];
  let totalDistanceM = 0;
  let emptyDistanceM = 0;
  let loadedDistanceM = 0;

  const emptyPath = planShortestPath(graph, currentNodeId, missionStops[0]);
  if (!emptyPath) {
    return null;
  }

  for (const segment of emptyPath.segments) {
    segments.push({ ...segment, loaded: false });
    totalDistanceM += segment.distanceM;
    emptyDistanceM += segment.distanceM;
  }

  for (let index = 0; index < missionStops.length - 1; index += 1) {
    const legPath = planShortestPath(graph, missionStops[index], missionStops[index + 1]);
    if (!legPath) {
      return null;
    }

    for (const segment of legPath.segments) {
      segments.push({ ...segment, loaded: true });
      totalDistanceM += segment.distanceM;
      loadedDistanceM += segment.distanceM;
    }
  }

  return {
    segments,
    totalDistanceM,
    emptyDistanceM,
    loadedDistanceM,
  };
}

function heuristic(a: TopologyNode, b: TopologyNode) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function getLowestScoreNode(open: Set<string>, fScore: Map<string, number>) {
  let winner: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const nodeId of open) {
    const score = fScore.get(nodeId) ?? Number.POSITIVE_INFINITY;
    if (score < bestScore) {
      bestScore = score;
      winner = nodeId;
    }
  }

  return winner;
}

function reconstructPath(
  goalNodeId: string,
  cameFrom: Map<string, CameFromEntry>,
): PlannedPath {
  const reversedSegments: PlannedPath["segments"] = [];
  const reversedNodeIds = [goalNodeId];
  let cursor = goalNodeId;

  while (cameFrom.has(cursor)) {
    const entry = cameFrom.get(cursor)!;
    reversedSegments.push({
      edgeId: entry.edgeId,
      fromNodeId: entry.fromNodeId,
      toNodeId: cursor,
      distanceM: entry.distanceM,
    });
    cursor = entry.fromNodeId;
    reversedNodeIds.push(cursor);
  }

  const segments = reversedSegments.reverse();
  const nodeIds = reversedNodeIds.reverse();

  return {
    nodeIds,
    segments,
    distanceM: segments.reduce((sum, segment) => sum + segment.distanceM, 0),
  };
}
