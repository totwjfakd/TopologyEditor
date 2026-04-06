import type { SimulatorWaitReason } from "./types";

export const MIN_SAME_EDGE_HEADWAY_M = 1;

export type EdgeReservation = {
  edgeId: string;
  robotId: string;
  fromNodeId: string;
  toNodeId: string;
  enteredAtMs: number;
  releaseAtMs: number;
};

export type TrafficState = {
  nodeOccupants: Map<string, Set<string>>;
  edgeReservations: EdgeReservation[];
};

export type EdgeEntryEvaluation =
  | { allowed: true }
  | {
      allowed: false;
      reason: SimulatorWaitReason;
      resourceType: "node" | "edge";
      resourceId: string;
      blockerRobotId: string | null;
      waitingForLabel: string;
      retryAtMs: number | null;
    };

export function createTrafficState(initialNodeOccupants: Array<{ nodeId: string; robotId: string }>): TrafficState {
  const traffic: TrafficState = {
    nodeOccupants: new Map(),
    edgeReservations: [],
  };

  for (const occupant of initialNodeOccupants) {
    occupyNode(traffic, occupant.nodeId, occupant.robotId);
  }

  return traffic;
}

export function occupyNode(traffic: TrafficState, nodeId: string, robotId: string) {
  const occupants = traffic.nodeOccupants.get(nodeId) ?? new Set<string>();
  occupants.add(robotId);
  traffic.nodeOccupants.set(nodeId, occupants);
}

export function releaseNode(traffic: TrafficState, nodeId: string, robotId: string) {
  const occupants = traffic.nodeOccupants.get(nodeId);
  if (!occupants) {
    return false;
  }

  occupants.delete(robotId);
  if (occupants.size === 0) {
    traffic.nodeOccupants.delete(nodeId);
  }

  return true;
}

export function reserveEdge(traffic: TrafficState, reservation: EdgeReservation) {
  traffic.edgeReservations.push(reservation);
}

export function releaseEdge(traffic: TrafficState, edgeId: string, robotId: string) {
  const released = traffic.edgeReservations.filter(
    (reservation) => reservation.edgeId === edgeId && reservation.robotId === robotId,
  );

  if (released.length === 0) {
    return [];
  }

  traffic.edgeReservations = traffic.edgeReservations.filter(
    (reservation) => !(reservation.edgeId === edgeId && reservation.robotId === robotId),
  );
  return released;
}

export function evaluateEdgeEntry(
  traffic: TrafficState,
  input: {
    robotId: string;
    edgeId: string;
    fromNodeId: string;
    toNodeId: string;
    targetNodeId: string;
    nowMs: number;
    headwayMs: number;
  },
): EdgeEntryEvaluation {
  const targetNodeOccupants = Array.from(traffic.nodeOccupants.get(input.targetNodeId) ?? []);
  const blockingNodeOccupants = targetNodeOccupants.filter((robotId) => robotId !== input.robotId);
  if (blockingNodeOccupants.length > 0) {
    return {
      allowed: false,
      reason: "node_occupancy",
      resourceType: "node",
      resourceId: input.targetNodeId,
      blockerRobotId: blockingNodeOccupants[0],
      waitingForLabel: `Node ${input.targetNodeId}`,
      retryAtMs: null,
    };
  }

  const activeReservations = traffic.edgeReservations.filter((reservation) => reservation.edgeId === input.edgeId);
  const oppositeDirection = activeReservations.find(
    (reservation) =>
      reservation.robotId !== input.robotId &&
      reservation.fromNodeId === input.toNodeId &&
      reservation.toNodeId === input.fromNodeId,
  );
  if (oppositeDirection) {
    return {
      allowed: false,
      reason: "bidirectional_mutual_exclusion",
      resourceType: "edge",
      resourceId: input.edgeId,
      blockerRobotId: oppositeDirection.robotId,
      waitingForLabel: `Edge ${input.fromNodeId} -> ${input.toNodeId}`,
      retryAtMs: oppositeDirection.releaseAtMs,
    };
  }

  const sameDirectionReservations = activeReservations
    .filter(
      (reservation) =>
        reservation.robotId !== input.robotId &&
        reservation.fromNodeId === input.fromNodeId &&
        reservation.toNodeId === input.toNodeId,
    )
    .sort((a, b) => b.enteredAtMs - a.enteredAtMs);

  const leadReservation = sameDirectionReservations[0];
  if (leadReservation && input.nowMs < leadReservation.enteredAtMs + input.headwayMs) {
    return {
      allowed: false,
      reason: "minimum_headway",
      resourceType: "edge",
      resourceId: input.edgeId,
      blockerRobotId: leadReservation.robotId,
      waitingForLabel: `Headway on ${input.fromNodeId} -> ${input.toNodeId}`,
      retryAtMs: leadReservation.enteredAtMs + input.headwayMs,
    };
  }

  return { allowed: true };
}
