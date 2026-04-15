import type { TopologyDocument, TopologyNode } from "../types";
import type {
  SimulatorRouteSegment,
  SimulatorTimedRouteSegment,
  SimulatorWaitReason,
} from "./types";

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

export type PlannedTransferRoute = {
  segments: SimulatorRouteSegment[];
  distanceM: number;
};

export type NodeReservationWindow = {
  nodeId: string;
  robotId: string;
  startTimeMs: number;
  endTimeMs: number;
};

export type EdgeReservationWindow = {
  edgeId: string;
  robotId: string;
  fromNodeId: string;
  toNodeId: string;
  startTimeMs: number;
  endTimeMs: number;
};

export type PlanningReservationTable = {
  nodeReservations: NodeReservationWindow[];
  edgeReservations: EdgeReservationWindow[];
};

export type PlannedTimedRoute = {
  segments: SimulatorTimedRouteSegment[];
  totalDistanceM: number;
  emptyDistanceM: number;
  loadedDistanceM: number;
  emptyArrivalTimeMs: number;
  finalArrivalTimeMs: number;
};

type CameFromEntry = {
  fromNodeId: string;
  edgeId: string;
  distanceM: number;
};

type TimedCameFromEntry = {
  fromNodeId: string;
  edgeId: string;
  distanceM: number;
  departAtMs: number;
  arriveAtMs: number;
  waitStartMs: number;
  waitEndMs: number;
  waitReason: SimulatorWaitReason | null;
  waitingForLabel: string | null;
  blockerRobotId: string | null;
};

type TimedPlannedPath = {
  nodeIds: string[];
  segments: SimulatorTimedRouteSegment[];
  distanceM: number;
  finalArrivalTimeMs: number;
};

type EdgeTraversalPlan = {
  departAtMs: number;
  arriveAtMs: number;
  waitStartMs: number;
  waitEndMs: number;
  waitReason: SimulatorWaitReason | null;
  waitingForLabel: string | null;
  blockerRobotId: string | null;
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
    [startNodeId, distanceHeuristic(graph.nodes.get(startNodeId)!, graph.nodes.get(goalNodeId)!)],
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
        tentativeScore + distanceHeuristic(graph.nodes.get(neighbor.toNodeId)!, graph.nodes.get(goalNodeId)!),
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
    segments.push(createStaticRouteSegment(segment, false));
    totalDistanceM += segment.distanceM;
    emptyDistanceM += segment.distanceM;
  }

  for (let index = 0; index < missionStops.length - 1; index += 1) {
    const legPath = planShortestPath(graph, missionStops[index], missionStops[index + 1]);
    if (!legPath) {
      return null;
    }

    for (const segment of legPath.segments) {
      segments.push(createStaticRouteSegment(segment, true));
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

export function planTransferRoute(
  graph: RobotGraph,
  startNodeId: string,
  goalNodeId: string,
): PlannedTransferRoute | null {
  const path = planShortestPath(graph, startNodeId, goalNodeId);
  if (!path) {
    return null;
  }

  return {
    segments: path.segments.map((segment) => createStaticRouteSegment(segment, false)),
    distanceM: path.distanceM,
  };
}

export function planTimedMissionRoute(
  graph: RobotGraph,
  currentNodeId: string,
  missionStops: string[],
  options: {
    startTimeMs: number;
    speedMps: number;
    headwayMs: number;
    reservations: PlanningReservationTable;
  },
): PlannedTimedRoute | null {
  if (missionStops.length < 2) {
    return null;
  }

  let currentTimeMs = options.startTimeMs;
  let totalDistanceM = 0;
  let emptyDistanceM = 0;
  let loadedDistanceM = 0;
  let emptyArrivalTimeMs = options.startTimeMs;
  const segments: SimulatorTimedRouteSegment[] = [];

  const emptyPath = planTimedShortestPath(graph, currentNodeId, missionStops[0], options);
  if (!emptyPath) {
    return null;
  }

  segments.push(...emptyPath.segments.map((segment) => ({ ...segment, loaded: false })));
  totalDistanceM += emptyPath.distanceM;
  emptyDistanceM += emptyPath.distanceM;
  currentTimeMs = emptyPath.finalArrivalTimeMs;
  emptyArrivalTimeMs = currentTimeMs;

  for (let index = 0; index < missionStops.length - 1; index += 1) {
    const legPath = planTimedShortestPath(graph, missionStops[index], missionStops[index + 1], {
      ...options,
      startTimeMs: currentTimeMs,
    });
    if (!legPath) {
      return null;
    }

    segments.push(...legPath.segments.map((segment) => ({ ...segment, loaded: true })));
    totalDistanceM += legPath.distanceM;
    loadedDistanceM += legPath.distanceM;
    currentTimeMs = legPath.finalArrivalTimeMs;
  }

  return {
    segments,
    totalDistanceM,
    emptyDistanceM,
    loadedDistanceM,
    emptyArrivalTimeMs,
    finalArrivalTimeMs: currentTimeMs,
  };
}

export function planTimedTransferRoute(
  graph: RobotGraph,
  startNodeId: string,
  goalNodeId: string,
  options: {
    startTimeMs: number;
    speedMps: number;
    headwayMs: number;
    reservations: PlanningReservationTable;
  },
): PlannedTimedRoute | null {
  const path = planTimedShortestPath(graph, startNodeId, goalNodeId, options);
  if (!path) {
    return null;
  }

  return {
    segments: path.segments.map((segment) => ({ ...segment, loaded: false })),
    totalDistanceM: path.distanceM,
    emptyDistanceM: path.distanceM,
    loadedDistanceM: 0,
    emptyArrivalTimeMs: path.finalArrivalTimeMs,
    finalArrivalTimeMs: path.finalArrivalTimeMs,
  };
}

function planTimedShortestPath(
  graph: RobotGraph,
  startNodeId: string,
  goalNodeId: string,
  options: {
    startTimeMs: number;
    speedMps: number;
    headwayMs: number;
    reservations: PlanningReservationTable;
  },
): TimedPlannedPath | null {
  if (!graph.nodes.has(startNodeId) || !graph.nodes.has(goalNodeId)) {
    return null;
  }

  if (startNodeId === goalNodeId) {
    return {
      nodeIds: [startNodeId],
      segments: [],
      distanceM: 0,
      finalArrivalTimeMs: options.startTimeMs,
    };
  }

  const safeSpeedMps = Math.max(0.1, options.speedMps);
  const open = new Set<string>([startNodeId]);
  const cameFrom = new Map<string, TimedCameFromEntry>();
  const arrivalTimeScore = new Map<string, number>([[startNodeId, options.startTimeMs]]);
  const fScore = new Map<string, number>([
    [
      startNodeId,
      options.startTimeMs +
        travelTimeHeuristic(graph.nodes.get(startNodeId)!, graph.nodes.get(goalNodeId)!, safeSpeedMps),
    ],
  ]);

  while (open.size > 0) {
    const currentNodeId = getLowestScoreNode(open, fScore);
    if (!currentNodeId) {
      break;
    }

    if (currentNodeId === goalNodeId) {
      return reconstructTimedPath(goalNodeId, cameFrom, arrivalTimeScore.get(goalNodeId) ?? options.startTimeMs);
    }

    open.delete(currentNodeId);
    const currentArrivalTimeMs = arrivalTimeScore.get(currentNodeId) ?? Number.POSITIVE_INFINITY;

    for (const neighbor of graph.adjacency.get(currentNodeId) ?? []) {
      const traversal = computeEarliestTraversal({
        currentNodeId,
        currentTimeMs: currentArrivalTimeMs,
        neighbor,
        speedMps: safeSpeedMps,
        headwayMs: options.headwayMs,
        reservations: options.reservations,
      });
      if (!traversal) {
        continue;
      }

      if (traversal.arriveAtMs >= (arrivalTimeScore.get(neighbor.toNodeId) ?? Number.POSITIVE_INFINITY)) {
        continue;
      }

      cameFrom.set(neighbor.toNodeId, {
        fromNodeId: currentNodeId,
        edgeId: neighbor.edgeId,
        distanceM: neighbor.distanceM,
        departAtMs: traversal.departAtMs,
        arriveAtMs: traversal.arriveAtMs,
        waitStartMs: traversal.waitStartMs,
        waitEndMs: traversal.waitEndMs,
        waitReason: traversal.waitReason,
        waitingForLabel: traversal.waitingForLabel,
        blockerRobotId: traversal.blockerRobotId,
      });
      arrivalTimeScore.set(neighbor.toNodeId, traversal.arriveAtMs);
      fScore.set(
        neighbor.toNodeId,
        traversal.arriveAtMs +
          travelTimeHeuristic(graph.nodes.get(neighbor.toNodeId)!, graph.nodes.get(goalNodeId)!, safeSpeedMps),
      );
      open.add(neighbor.toNodeId);
    }
  }

  return null;
}

function computeEarliestTraversal(input: {
  currentNodeId: string;
  currentTimeMs: number;
  neighbor: GraphNeighbor;
  speedMps: number;
  headwayMs: number;
  reservations: PlanningReservationTable;
}): EdgeTraversalPlan | null {
  const travelMs = Math.max(
    1,
    input.headwayMs,
    (input.neighbor.distanceM / input.speedMps) * 1000,
  );
  let departAtMs = input.currentTimeMs;
  let lastWaitReason: SimulatorWaitReason | null = null;
  let lastWaitingForLabel: string | null = null;
  let lastBlockerRobotId: string | null = null;

  for (let attempt = 0; attempt < input.reservations.nodeReservations.length + input.reservations.edgeReservations.length + 8; attempt += 1) {
    const sameDirectionBlock = getSameDirectionHeadwayBlock(input, departAtMs);
    if (sameDirectionBlock) {
      departAtMs = Math.max(departAtMs, sameDirectionBlock.startTimeMs + input.headwayMs);
      lastWaitReason = "minimum_headway";
      lastWaitingForLabel = `Headway on ${input.currentNodeId} -> ${input.neighbor.toNodeId}`;
      lastBlockerRobotId = sameDirectionBlock.robotId;
      continue;
    }

    const arriveAtMs = departAtMs + travelMs;
    const oppositeBlock = getOppositeDirectionBlock(input, departAtMs, arriveAtMs);
    if (oppositeBlock) {
      departAtMs = Math.max(departAtMs, oppositeBlock.endTimeMs);
      lastWaitReason = "bidirectional_mutual_exclusion";
      lastWaitingForLabel = `Edge ${input.currentNodeId} -> ${input.neighbor.toNodeId}`;
      lastBlockerRobotId = oppositeBlock.robotId;
      continue;
    }

    const nodeBlock = getTargetNodeBlock(input, arriveAtMs);
    if (nodeBlock) {
      departAtMs = Math.max(departAtMs, nodeBlock.endTimeMs - travelMs);
      lastWaitReason = "node_occupancy";
      lastWaitingForLabel = `Node ${input.neighbor.toNodeId}`;
      lastBlockerRobotId = nodeBlock.robotId;
      continue;
    }

    return {
      departAtMs,
      arriveAtMs,
      waitStartMs: input.currentTimeMs,
      waitEndMs: departAtMs,
      waitReason: departAtMs > input.currentTimeMs ? lastWaitReason : null,
      waitingForLabel: departAtMs > input.currentTimeMs ? lastWaitingForLabel : null,
      blockerRobotId: departAtMs > input.currentTimeMs ? lastBlockerRobotId : null,
    };
  }

  return null;
}

function getSameDirectionHeadwayBlock(
  input: {
    currentNodeId: string;
    neighbor: GraphNeighbor;
    reservations: PlanningReservationTable;
    headwayMs: number;
  },
  departAtMs: number,
) {
  return input.reservations.edgeReservations
    .filter(
      (reservation) =>
        reservation.edgeId === input.neighbor.edgeId &&
        reservation.fromNodeId === input.currentNodeId &&
        reservation.toNodeId === input.neighbor.toNodeId &&
        reservation.startTimeMs <= departAtMs &&
        departAtMs < reservation.startTimeMs + input.headwayMs,
    )
    .sort((a, b) => a.startTimeMs - b.startTimeMs)[0] ?? null;
}

function getOppositeDirectionBlock(
  input: {
    currentNodeId: string;
    neighbor: GraphNeighbor;
    reservations: PlanningReservationTable;
  },
  departAtMs: number,
  arriveAtMs: number,
) {
  return input.reservations.edgeReservations
    .filter(
      (reservation) =>
        reservation.edgeId === input.neighbor.edgeId &&
        reservation.fromNodeId === input.neighbor.toNodeId &&
        reservation.toNodeId === input.currentNodeId &&
        reservation.startTimeMs < arriveAtMs &&
        reservation.endTimeMs > departAtMs,
    )
    .sort((a, b) => a.endTimeMs - b.endTimeMs)[0] ?? null;
}

function getTargetNodeBlock(
  input: {
    neighbor: GraphNeighbor;
    reservations: PlanningReservationTable;
  },
  arriveAtMs: number,
) {
  return input.reservations.nodeReservations
    .filter(
      (reservation) =>
        reservation.nodeId === input.neighbor.toNodeId &&
        reservation.startTimeMs <= arriveAtMs &&
        reservation.endTimeMs > arriveAtMs,
    )
    .sort((a, b) => a.endTimeMs - b.endTimeMs)[0] ?? null;
}

function createStaticRouteSegment(
  segment: PlannedPath["segments"][number],
  loaded: boolean,
): SimulatorRouteSegment {
  return {
    edgeId: segment.edgeId,
    fromNodeId: segment.fromNodeId,
    toNodeId: segment.toNodeId,
    distanceM: segment.distanceM,
    loaded,
  };
}

function distanceHeuristic(a: TopologyNode, b: TopologyNode) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function travelTimeHeuristic(a: TopologyNode, b: TopologyNode, speedMps: number) {
  return (distanceHeuristic(a, b) / speedMps) * 1000;
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

function reconstructTimedPath(
  goalNodeId: string,
  cameFrom: Map<string, TimedCameFromEntry>,
  finalArrivalTimeMs: number,
): TimedPlannedPath {
  const reversedSegments: SimulatorTimedRouteSegment[] = [];
  const reversedNodeIds = [goalNodeId];
  let cursor = goalNodeId;

  while (cameFrom.has(cursor)) {
    const entry = cameFrom.get(cursor)!;
    reversedSegments.push({
      edgeId: entry.edgeId,
      fromNodeId: entry.fromNodeId,
      toNodeId: cursor,
      distanceM: entry.distanceM,
      loaded: false,
      departAtMs: entry.departAtMs,
      arriveAtMs: entry.arriveAtMs,
      waitStartMs: entry.waitStartMs,
      waitEndMs: entry.waitEndMs,
      sectionId: null,
      sectionLabel: null,
      sectionReleaseAtMs: null,
      waitReason: entry.waitReason,
      waitResourceType:
        entry.waitReason === null
          ? null
          : entry.waitReason === "node_occupancy"
            ? "node"
            : entry.waitReason === "critical_section"
              ? "section"
            : "edge",
      waitResourceId:
        entry.waitReason === null
          ? null
          : entry.waitReason === "node_occupancy"
            ? cursor
            : entry.edgeId,
      waitingForLabel: entry.waitingForLabel,
      blockerRobotId: entry.blockerRobotId,
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
    finalArrivalTimeMs,
  };
}
