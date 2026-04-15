import type { Point, TopologyDocument, TopologyNode } from "../types";
import {
  buildCriticalSectionIndex,
  getCriticalSectionRouteSpans,
  type SimulatorCriticalSection,
  type SimulatorCriticalSectionIndex,
} from "./criticalSections";
import { buildRobotGraph, planMissionRoute, planTransferRoute } from "./planner";
import { normalizeSeed, sampleExponentialMs } from "./random";
import {
  MIN_SAME_EDGE_HEADWAY_M,
  createTrafficState,
  evaluateEdgeEntry,
  occupyNode,
  releaseEdge,
  releaseNode,
  releaseSection,
  reserveEdge,
  reserveSection,
  type TrafficState,
} from "./traffic";
import { getNodeHeadingRad } from "../utils/nodeHeading";
import type {
  CompiledMissionSummary,
  ReservationWindow,
  SimulationEvent,
  SimulatorPendingMissionSnapshot,
  SimulationSnapshot,
  SimulatorFleetConfig,
  SimulatorMissionDraft,
  SimulatorMissionInstance,
  SimulatorRobotSnapshot,
  SimulatorRobotState,
  SimulatorRouteSegment,
  SimulatorTimedRouteSegment,
  SimulatorWaitReason,
  SimulatorWaitState,
} from "./types";

type CompiledMissionTemplate = {
  id: string;
  name: string;
  stopNodeIds: string[];
  stopNames: string[];
  callsPerHour: number;
  loadedRouteSegments: SimulatorRouteSegment[];
  loadedDistanceM: number;
};

type ScheduledEvent =
  | {
      id: string;
      timeMs: number;
      kind: "mission_arrival";
      missionTemplateId: string;
    }
  | {
      id: string;
      timeMs: number;
      kind: "robot_ready_to_enter_edge";
      robotId: string;
      missionId: string | null;
      routeIndex: number;
      routeVersion: number;
    }
  | {
      id: string;
      timeMs: number;
      kind: "robot_arrive_node";
      robotId: string;
      missionId: string | null;
      routeIndex: number;
      routeVersion: number;
    };

type ScheduledEventInput =
  | {
      timeMs: number;
      kind: "mission_arrival";
      missionTemplateId: string;
    }
  | {
      timeMs: number;
      kind: "robot_ready_to_enter_edge";
      robotId: string;
      missionId: string | null;
      routeIndex: number;
      routeVersion: number;
    }
  | {
      timeMs: number;
      kind: "robot_arrive_node";
      robotId: string;
      missionId: string | null;
      routeIndex: number;
      routeVersion: number;
    };

export type SimulationEngine = {
  document: TopologyDocument;
  nodeMap: Map<string, TopologyNode>;
  graph: ReturnType<typeof buildRobotGraph>;
  templates: CompiledMissionTemplate[];
  templateMap: Map<string, CompiledMissionTemplate>;
  compiledMissionSummaries: CompiledMissionSummary[];
  criticalSections: SimulatorCriticalSectionIndex;
  robots: SimulatorRobotState[];
  missionMap: Map<string, SimulatorMissionInstance>;
  pendingMissionIds: string[];
  events: SimulationEvent[];
  queue: ScheduledEvent[];
  timeMs: number;
  nextMissionId: number;
  nextEventId: number;
  rngSeed: number;
  droppedMissionCount: number;
  traffic: TrafficState;
};

const MAX_EVENT_LOG = 500;
export const MAX_PENDING_MISSION_COUNT = 1000;
const DEFAULT_ROBOT_RESERVATION_HORIZON_MS = 100 * 60 * 60 * 1000;
const MAX_PLAN_SHIFT_ATTEMPTS = 96;

type ReservationBlock = {
  releaseAtMs: number;
  reason: SimulatorWaitReason;
  resourceType: "node" | "edge" | "section";
  resourceId: string;
  waitingForLabel: string;
  blockerRobotId: string | null;
};

export function createSimulationEngine(
  document: TopologyDocument,
  missions: SimulatorMissionDraft[],
  fleet: SimulatorFleetConfig,
): SimulationEngine {
  const graph = buildRobotGraph(document);
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const compiled = compileMissions(document, missions);
  const criticalSections = buildCriticalSectionIndex(document);
  const robots = createRobots(document, fleet.robotCount);

  const engine: SimulationEngine = {
    document,
    nodeMap,
    graph,
    templates: compiled.templates,
    templateMap: new Map(compiled.templates.map((template) => [template.id, template])),
    compiledMissionSummaries: compiled.summaries,
    criticalSections,
    robots,
    missionMap: new Map(),
    pendingMissionIds: [],
    events: [],
    queue: [],
    timeMs: 0,
    nextMissionId: 1,
    nextEventId: 1,
    rngSeed: normalizeSeed(fleet.seed),
    droppedMissionCount: 0,
    traffic: createTrafficState(
      robots.map((robot) => ({
        nodeId: robot.currentNodeId,
        robotId: robot.id,
      })),
    ),
  };

  scheduleInitialArrivals(engine);
  return engine;
}

export function advanceSimulation(
  engine: SimulationEngine,
  targetTimeMs: number,
  fleet: SimulatorFleetConfig,
) {
  const safeTargetTime = Math.max(targetTimeMs, engine.timeMs);

  while (engine.timeMs < safeTargetTime) {
    const nextQueuedEventTime = engine.queue[0]?.timeMs ?? Number.POSITIVE_INFINITY;
    const nextTime = Math.min(safeTargetTime, nextQueuedEventTime);

    if (!Number.isFinite(nextTime)) {
      engine.timeMs = safeTargetTime;
      break;
    }

    engine.timeMs = nextTime;

    while (engine.queue.length > 0 && engine.queue[0].timeMs <= engine.timeMs) {
      const nextEvent = engine.queue.shift()!;

      if (nextEvent.kind === "mission_arrival") {
        processMissionArrival(engine, nextEvent, fleet);
        continue;
      }

      if (nextEvent.kind === "robot_ready_to_enter_edge") {
        processRobotReadyToEnterEdge(engine, nextEvent, fleet);
        continue;
      }

      processRobotArrival(engine, nextEvent, fleet);
    }
  }
}

export function buildSimulationSnapshot(engine: SimulationEngine): SimulationSnapshot {
  const pendingMissionCount = engine.pendingMissionIds.length;
  const activeMissionCount = engine.robots.filter((robot) => robot.currentMissionId).length;
  const completedMissionCount = Array.from(engine.missionMap.values()).filter(
    (mission) => mission.status === "completed",
  ).length;
  const pendingMissions = buildPendingMissionSnapshots(engine);

  return {
    currentTimeMs: engine.timeMs,
    robots: engine.robots.map((robot) => buildRobotSnapshot(engine, robot)),
    recentEvents: engine.events.slice(-18).reverse(),
    pendingMissionCount,
    maxPendingMissionCount: MAX_PENDING_MISSION_COUNT,
    droppedMissionCount: engine.droppedMissionCount,
    oldestPendingWaitMs: pendingMissions[0]?.waitMs ?? null,
    pendingMissions,
    activeMissionCount,
    completedMissionCount,
    totalEventCount: engine.events.length,
    totalMissionCount: engine.missionMap.size,
    nextEventTimeMs: engine.queue[0]?.timeMs ?? null,
  };
}

function compileMissions(
  document: TopologyDocument,
  missions: SimulatorMissionDraft[],
) {
  const graph = buildRobotGraph(document);
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const templates: CompiledMissionTemplate[] = [];
  const summaries: CompiledMissionSummary[] = [];

  for (const mission of missions) {
    const stopNames = mission.stops.map((stopId) => nodeMap.get(stopId)?.name ?? stopId);
    const loadedSegments: SimulatorRouteSegment[] = [];
    let loadedDistanceM = 0;
    let error: string | null = null;

    for (let index = 0; index < mission.stops.length - 1; index += 1) {
      const legRoute = planMissionRoute(graph, mission.stops[index], [
        mission.stops[index],
        mission.stops[index + 1],
      ]);

      if (!legRoute) {
        error = "Directed path not reachable";
        break;
      }

      loadedSegments.push(...legRoute.segments.filter((segment) => segment.loaded));
      loadedDistanceM += legRoute.loadedDistanceM;
    }

    const isValid = error === null && loadedSegments.length > 0;
    summaries.push({
      id: mission.id,
      name: mission.name,
      callsPerHour: mission.callsPerHour,
      stopNodeIds: mission.stops,
      stopNames,
      isValid,
      error,
      loadedDistanceM,
    });

    if (isValid) {
      templates.push({
        id: mission.id,
        name: mission.name,
        stopNodeIds: mission.stops,
        stopNames,
        callsPerHour: mission.callsPerHour,
        loadedRouteSegments: loadedSegments,
        loadedDistanceM,
      });
    }
  }

  return { templates, summaries };
}

function createRobots(document: TopologyDocument, requestedCount: number) {
  const waitingPositions = document.nodes.filter((node) => node.type === "waiting_position");
  const spawnNodes = waitingPositions;
  const robotCount = Math.max(
    0,
    Math.min(32, Math.trunc(requestedCount), spawnNodes.length),
  );

  if (spawnNodes.length === 0 || robotCount === 0) {
    return [];
  }

  return Array.from({ length: robotCount }, (_, index): SimulatorRobotState => {
    const spawnNode = spawnNodes[index];

    return {
      id: `robot_${String(index + 1).padStart(2, "0")}`,
      name: `R${index + 1}`,
      status: "idle",
      currentNodeId: spawnNode.id,
      routeKind: null,
      routeVersion: 0,
      currentMissionId: null,
      currentMissionName: null,
      completedMissionCount: 0,
      totalDistanceM: 0,
      routeSegments: [],
      routeIndex: 0,
      motion: null,
      waitState: null,
    };
  });
}

function scheduleInitialArrivals(engine: SimulationEngine) {
  for (const template of engine.templates) {
    if (template.callsPerHour <= 0) {
      continue;
    }

    scheduleNextMissionArrival(engine, template.id, 0);
  }
}

function processMissionArrival(
  engine: SimulationEngine,
  event: Extract<ScheduledEvent, { kind: "mission_arrival" }>,
  fleet: SimulatorFleetConfig,
) {
  const template = engine.templateMap.get(event.missionTemplateId);
  if (!template) {
    return;
  }

  scheduleNextMissionArrival(engine, template.id, event.timeMs);

  if (engine.pendingMissionIds.length >= MAX_PENDING_MISSION_COUNT) {
    engine.droppedMissionCount += 1;
    pushLog(engine, {
      type: "mission_dropped",
      timeMs: event.timeMs,
      robotId: null,
      missionId: null,
      message: `${template.name} dropped because the queue is full (${MAX_PENDING_MISSION_COUNT})`,
    });
    return;
  }

  const missionId = `run_mission_${String(engine.nextMissionId).padStart(4, "0")}`;
  engine.nextMissionId += 1;

  const mission: SimulatorMissionInstance = {
    id: missionId,
    templateId: template.id,
    name: template.name,
    stops: template.stopNodeIds,
    createdAtMs: event.timeMs,
    assignedRobotId: null,
    status: "pending",
    startedAtMs: null,
    completedAtMs: null,
  };

  engine.missionMap.set(mission.id, mission);
  engine.pendingMissionIds.push(mission.id);
  pushLog(engine, {
    type: "mission_created",
    timeMs: event.timeMs,
    robotId: null,
    missionId: mission.id,
    message: `${template.name} created`,
  });

  processTrafficQueue(engine, fleet);
}

function processRobotArrival(
  engine: SimulationEngine,
  event: Extract<ScheduledEvent, { kind: "robot_arrive_node" }>,
  fleet: SimulatorFleetConfig,
) {
  reconcileTrafficRuntimeState(engine);
  const robot = engine.robots.find((entry) => entry.id === event.robotId);
  const mission = event.missionId ? engine.missionMap.get(event.missionId) ?? null : null;
  if (
    !robot ||
    !robot.motion ||
    robot.routeIndex !== event.routeIndex ||
    robot.routeVersion !== event.routeVersion
  ) {
    return;
  }

  if (event.missionId !== null) {
    if (!mission || robot.currentMissionId !== mission.id || robot.routeKind !== "mission") {
      return;
    }
  } else if (robot.routeKind !== "parking" || robot.currentMissionId !== null) {
    return;
  }

  const segment = robot.routeSegments[event.routeIndex];
  if (!segment) {
    return;
  }

  const releasedEdgeReservations = releaseEdge(engine.traffic, segment.edgeId, robot.id);
  for (const reservation of releasedEdgeReservations) {
    pushLog(engine, {
      type: "reservation_released",
      timeMs: event.timeMs,
      robotId: robot.id,
      missionId: event.missionId,
      message: `${robot.name} released edge ${reservation.fromNodeId} -> ${reservation.toNodeId}`,
    });
  }
  const releasedSectionReservations = releaseSectionIfNeeded(engine, robot, segment);
  for (const reservation of releasedSectionReservations) {
    const section = engine.criticalSections.byId.get(reservation.sectionId);
    pushLog(engine, {
      type: "reservation_released",
      timeMs: event.timeMs,
      robotId: robot.id,
      missionId: event.missionId,
      message: `${robot.name} released section ${section?.label ?? reservation.sectionId}`,
    });
  }
  releaseStaleEdgeReservationsForRobot(engine, robot.id, event.timeMs, event.missionId);
  occupyNode(engine.traffic, segment.toNodeId, robot.id);

  robot.currentNodeId = segment.toNodeId;
  robot.totalDistanceM += segment.distanceM;
  robot.motion = null;

  pushLog(engine, {
    type: "node_arrived",
    timeMs: event.timeMs,
    robotId: robot.id,
    missionId: event.missionId,
    message: `${robot.name} arrived at ${engine.nodeMap.get(segment.toNodeId)?.name ?? segment.toNodeId}`,
  });

  robot.routeIndex += 1;

  if (robot.routeIndex >= robot.routeSegments.length) {
    if (robot.routeKind === "mission" && mission) {
      mission.status = "completed";
      mission.completedAtMs = event.timeMs;
      robot.completedMissionCount += 1;

      pushLog(engine, {
        type: "mission_completed",
        timeMs: event.timeMs,
        robotId: robot.id,
        missionId: mission.id,
        message: `${robot.name} completed ${mission.name}`,
      });

      robot.currentMissionId = null;

      if (!assignParkingRoute(engine, robot, event.timeMs, fleet.robotSpeedMps)) {
        resetRobotToIdle(engine, robot, event.timeMs, mission.id);
      }
    } else {
      pushLog(engine, {
        type: "parking_arrived",
        timeMs: event.timeMs,
        robotId: robot.id,
        missionId: null,
        message: `${robot.name} parked at ${engine.nodeMap.get(robot.currentNodeId)?.name ?? robot.currentNodeId}`,
      });
      resetRobotToIdle(engine, robot, event.timeMs, null);
    }

    processTrafficQueue(engine, fleet);
    return;
  }

  scheduleEvent(engine, {
    kind: "robot_ready_to_enter_edge",
    timeMs: event.timeMs,
    robotId: robot.id,
    missionId: event.missionId,
    routeIndex: robot.routeIndex,
    routeVersion: robot.routeVersion,
  });
  processTrafficQueue(engine, fleet);
}

function processRobotReadyToEnterEdge(
  engine: SimulationEngine,
  event: Extract<ScheduledEvent, { kind: "robot_ready_to_enter_edge" }>,
  fleet: SimulatorFleetConfig,
) {
  reconcileTrafficRuntimeState(engine);
  const robot = engine.robots.find((entry) => entry.id === event.robotId);
  const mission = event.missionId ? engine.missionMap.get(event.missionId) ?? null : null;
  if (
    !robot ||
    robot.routeIndex !== event.routeIndex ||
    robot.routeVersion !== event.routeVersion
  ) {
    return;
  }

  if (event.missionId !== null) {
    if (!mission || robot.currentMissionId !== mission.id || robot.routeKind !== "mission") {
      return;
    }
  } else if (robot.routeKind !== "parking" || robot.currentMissionId !== null) {
    return;
  }

  if (robot.motion) {
    return;
  }

  refreshRemainingRouteTiming(engine, robot, event.timeMs, fleet.robotSpeedMps);
  const segment = robot.routeSegments[robot.routeIndex];
  if (!segment) {
    return;
  }

  pushLog(engine, {
    type: "robot_ready_to_enter_edge",
    timeMs: event.timeMs,
    robotId: robot.id,
    missionId: mission?.id ?? null,
    message: `${robot.name} ready to enter ${engine.nodeMap.get(segment.fromNodeId)?.name ?? segment.fromNodeId} -> ${engine.nodeMap.get(segment.toNodeId)?.name ?? segment.toNodeId}`,
  });

  const departAtMs = segment.departAtMs;
  if (event.timeMs < departAtMs) {
    applyWaitState(engine, robot, mission?.id ?? null, event.timeMs, {
      reason: segment.waitReason ?? "edge_occupancy",
      resourceType: segment.waitResourceType ?? "edge",
      resourceId: segment.waitResourceId ?? segment.edgeId,
      blockerRobotId: segment.blockerRobotId,
      waitingForLabel:
        segment.waitingForLabel ??
        `${engine.nodeMap.get(segment.fromNodeId)?.name ?? segment.fromNodeId} -> ${engine.nodeMap.get(segment.toNodeId)?.name ?? segment.toNodeId}`,
      retryAtMs: departAtMs,
    });
    return;
  }

  if (tryStartRobotEdgeMotion(engine, robot, mission, event.timeMs, fleet.robotSpeedMps, segment)) {
    processTrafficQueue(engine, fleet);
  }
}

function refreshRemainingRouteTiming(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  startTimeMs: number,
  speedMps: number,
) {
  const remainingSegments = robot.routeSegments.slice(robot.routeIndex).map((segment) => ({
    edgeId: segment.edgeId,
    fromNodeId: segment.fromNodeId,
    toNodeId: segment.toNodeId,
    distanceM: segment.distanceM,
    loaded: segment.loaded,
  }));

  if (remainingSegments.length === 0) {
    return;
  }

  const replanned = buildTimedRoute(engine, robot.id, remainingSegments, startTimeMs, speedMps);
  if (!replanned) {
    return;
  }

  robot.routeSegments.splice(robot.routeIndex, remainingSegments.length, ...replanned.segments);
}

function dispatchPendingMissions(engine: SimulationEngine, fleet: SimulatorFleetConfig) {
  let dispatchedAny = true;

  while (dispatchedAny) {
    dispatchedAny = false;
    const idleRobots = engine.robots.filter(
      (robot) =>
        robot.status === "idle" &&
        robot.routeKind === null &&
        robot.currentMissionId === null &&
        robot.routeSegments.length === 0,
    );
    if (idleRobots.length === 0 || engine.pendingMissionIds.length === 0) {
      return;
    }

    const missionId = engine.pendingMissionIds[0];
    const mission = engine.missionMap.get(missionId);
    const template = mission ? engine.templateMap.get(mission.templateId) : null;
    if (!mission || !template) {
      engine.pendingMissionIds.shift();
      continue;
    }

    const bestRobot = selectRobotForMission(
      engine,
      idleRobots,
      template.stopNodeIds,
      engine.timeMs,
      fleet.robotSpeedMps,
    );
    if (!bestRobot) {
      return;
    }

    if (!dispatchMissionNow(engine, mission, bestRobot.robot, bestRobot.route, engine.timeMs, fleet.robotSpeedMps)) {
      return;
    }
    engine.pendingMissionIds.shift();
    dispatchedAny = true;
  }
}

function dispatchMissionNow(
  engine: SimulationEngine,
  mission: SimulatorMissionInstance,
  robot: SimulatorRobotState,
  route: SimulatorTimedRouteSegment[],
  timeMs: number,
  speedMps: number,
) {
  const firstSegment = route[0];
  if (!firstSegment) {
    return false;
  }

  if (!canRobotStartSegmentNow(engine, robot, firstSegment, timeMs, speedMps)) {
    return false;
  }

  mission.status = "assigned";
  mission.assignedRobotId = robot.id;
  mission.startedAtMs = timeMs;
  robot.routeKind = "mission";
  robot.routeVersion += 1;
  robot.currentMissionId = mission.id;
  robot.currentMissionName = mission.name;
  robot.routeSegments = route;
  robot.routeIndex = 0;
  robot.waitState = null;

  pushLog(engine, {
    type: "mission_assigned",
    timeMs,
    robotId: robot.id,
    missionId: mission.id,
    message: `${robot.name} assigned to ${mission.name}`,
  });

  pushLog(engine, {
    type: "robot_ready_to_enter_edge",
    timeMs,
    robotId: robot.id,
    missionId: mission.id,
    message: `${robot.name} ready to enter ${engine.nodeMap.get(firstSegment.fromNodeId)?.name ?? firstSegment.fromNodeId} -> ${engine.nodeMap.get(firstSegment.toNodeId)?.name ?? firstSegment.toNodeId}`,
  });

  releaseNodeReservationForDeparture(engine, robot, mission.id, timeMs);
  startRobotEdgeMotion(engine, robot, mission, timeMs, firstSegment);
  return true;
}

function startRobotEdgeMotion(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  mission: SimulatorMissionInstance | null,
  startTimeMs: number,
  segment: SimulatorTimedRouteSegment,
) {
  const sectionReservation = getSectionReservationForEntry(
    engine,
    robot.routeSegments,
    robot.routeIndex,
  );
  if (sectionReservation) {
    reserveSection(engine.traffic, {
      sectionId: sectionReservation.section.id,
      robotId: robot.id,
      enteredAtMs: startTimeMs,
      releaseAtMs: sectionReservation.releaseAtMs,
    });
  }

  reserveEdge(engine.traffic, {
    edgeId: segment.edgeId,
    robotId: robot.id,
    fromNodeId: segment.fromNodeId,
    toNodeId: segment.toNodeId,
    enteredAtMs: startTimeMs,
    releaseAtMs: segment.arriveAtMs,
  });

  pushLog(engine, {
    type: "edge_enter_granted",
    timeMs: startTimeMs,
    robotId: robot.id,
    missionId: mission?.id ?? null,
    message: `${robot.name} granted ${engine.nodeMap.get(segment.fromNodeId)?.name ?? segment.fromNodeId} -> ${engine.nodeMap.get(segment.toNodeId)?.name ?? segment.toNodeId}`,
  });

  robot.status = segment.loaded ? "moving_loaded" : "moving_empty";
  robot.motion = {
    edgeId: segment.edgeId,
    fromNodeId: segment.fromNodeId,
    toNodeId: segment.toNodeId,
    distanceM: segment.distanceM,
    loaded: segment.loaded,
    startedAtMs: startTimeMs,
    endsAtMs: segment.arriveAtMs,
  };

  pushLog(engine, {
    type: "edge_entered",
    timeMs: startTimeMs,
    robotId: robot.id,
    missionId: mission?.id ?? null,
    message: `${robot.name} entered ${engine.nodeMap.get(segment.fromNodeId)?.name ?? segment.fromNodeId} -> ${engine.nodeMap.get(segment.toNodeId)?.name ?? segment.toNodeId}`,
  });

  scheduleEvent(engine, {
    kind: "robot_arrive_node",
    timeMs: segment.arriveAtMs,
    robotId: robot.id,
    missionId: mission?.id ?? null,
    routeIndex: robot.routeIndex,
    routeVersion: robot.routeVersion,
  });
}

function processTrafficQueue(engine: SimulationEngine, fleet: SimulatorFleetConfig) {
  let progressed = true;

  while (progressed) {
    reconcileTrafficRuntimeState(engine);
    const beforePending = engine.pendingMissionIds.length;
    const beforeMoving = engine.robots.filter((robot) => robot.motion).length;
    const resumedWaitingRobot = wakeWaitingRobots(engine, fleet);
    dispatchPendingMissions(engine, fleet);
    const afterMoving = engine.robots.filter((robot) => robot.motion).length;
    progressed =
      resumedWaitingRobot ||
      engine.pendingMissionIds.length !== beforePending ||
      afterMoving !== beforeMoving;
  }
}

function wakeWaitingRobots(
  engine: SimulationEngine,
  fleet: SimulatorFleetConfig,
) {
  let resumedAny = false;

  const waitingRobots = engine.robots
    .filter((robot) => robot.status === "waiting_resource" && robot.routeKind !== null && !robot.motion)
    .sort((a, b) => (a.waitState?.startedAtMs ?? 0) - (b.waitState?.startedAtMs ?? 0));

  for (const robot of waitingRobots) {
    const mission = robot.currentMissionId
      ? engine.missionMap.get(robot.currentMissionId) ?? null
      : null;

    if (robot.currentMissionId && !mission) {
      continue;
    }

    if (robot.currentMissionId !== null) {
      if (!mission || robot.routeKind !== "mission") {
        continue;
      }
    } else if (robot.routeKind !== "parking") {
      continue;
    }

    refreshRemainingRouteTiming(engine, robot, engine.timeMs, fleet.robotSpeedMps);
    const segment = robot.routeSegments[robot.routeIndex];
    if (!segment || segment.departAtMs > engine.timeMs) {
      continue;
    }

    pushLog(engine, {
      type: "robot_ready_to_enter_edge",
      timeMs: engine.timeMs,
      robotId: robot.id,
      missionId: mission?.id ?? null,
      message: `${robot.name} ready to enter ${engine.nodeMap.get(segment.fromNodeId)?.name ?? segment.fromNodeId} -> ${engine.nodeMap.get(segment.toNodeId)?.name ?? segment.toNodeId}`,
    });

    if (tryStartRobotEdgeMotion(engine, robot, mission, engine.timeMs, fleet.robotSpeedMps, segment)) {
      resumedAny = true;
    }
  }

  return resumedAny;
}

function tryStartRobotEdgeMotion(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  mission: SimulatorMissionInstance | null,
  timeMs: number,
  speedMps: number,
  segment: SimulatorTimedRouteSegment,
) {
  const headwayMs = (MIN_SAME_EDGE_HEADWAY_M / Math.max(0.1, speedMps)) * 1000;
  const gate = evaluateEdgeEntry(engine.traffic, {
    robotId: robot.id,
    edgeId: segment.edgeId,
    fromNodeId: segment.fromNodeId,
    toNodeId: segment.toNodeId,
    targetNodeId: segment.toNodeId,
    nowMs: timeMs,
    headwayMs,
    sectionId: isSectionEntry(robot.routeSegments, robot.routeIndex) ? segment.sectionId : null,
    sectionLabel: isSectionEntry(robot.routeSegments, robot.routeIndex) ? segment.sectionLabel : null,
    sectionReleaseAtMs: isSectionEntry(robot.routeSegments, robot.routeIndex)
      ? segment.sectionReleaseAtMs
      : null,
  });

  if (!gate.allowed) {
    applyWaitState(engine, robot, mission?.id ?? null, timeMs, gate);
    return false;
  }

  clearWaitState(engine, robot, mission?.id ?? null, timeMs);
  releaseNodeReservationForDeparture(engine, robot, mission?.id ?? null, timeMs);
  startRobotEdgeMotion(engine, robot, mission, timeMs, segment);
  return true;
}

function releaseNodeReservationForDeparture(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  missionId: string | null,
  timeMs: number,
) {
  if (releaseNode(engine.traffic, robot.currentNodeId, robot.id)) {
    pushLog(engine, {
      type: "reservation_released",
      timeMs,
      robotId: robot.id,
      missionId,
      message: `${robot.name} released node ${engine.nodeMap.get(robot.currentNodeId)?.name ?? robot.currentNodeId}`,
    });
  }
}

function reconcileTrafficRuntimeState(engine: SimulationEngine) {
  const nextNodeOccupants = new Map<string, Set<string>>();
  const nextEdgeReservations: TrafficState["edgeReservations"] = [];
  const nextSectionReservations: TrafficState["sectionReservations"] = [];

  for (const robot of engine.robots) {
    if (!robot.motion) {
      const occupants = nextNodeOccupants.get(robot.currentNodeId) ?? new Set<string>();
      occupants.add(robot.id);
      nextNodeOccupants.set(robot.currentNodeId, occupants);
    }

    if (robot.motion) {
      nextEdgeReservations.push({
        edgeId: robot.motion.edgeId,
        robotId: robot.id,
        fromNodeId: robot.motion.fromNodeId,
        toNodeId: robot.motion.toNodeId,
        enteredAtMs: robot.motion.startedAtMs,
        releaseAtMs: robot.motion.endsAtMs,
      });
    }

    nextSectionReservations.push(
      ...collectSectionReservationsForRobot(engine, robot, engine.timeMs),
    );
  }

  engine.traffic.nodeOccupants = nextNodeOccupants;
  engine.traffic.edgeReservations = nextEdgeReservations;
  engine.traffic.sectionReservations = nextSectionReservations;
}

function releaseStaleEdgeReservationsForRobot(
  engine: SimulationEngine,
  robotId: string,
  timeMs: number,
  missionId: string | null,
) {
  const staleReservations = engine.traffic.edgeReservations.filter(
    (reservation) => reservation.robotId === robotId,
  );
  if (staleReservations.length > 0) {
    engine.traffic.edgeReservations = engine.traffic.edgeReservations.filter(
      (reservation) => reservation.robotId !== robotId,
    );

    for (const reservation of staleReservations) {
      pushLog(engine, {
        type: "reservation_released",
        timeMs,
        robotId,
        missionId,
        message: `Released stale edge ${reservation.fromNodeId} -> ${reservation.toNodeId}`,
      });
    }
  }

  const staleSectionReservations = engine.traffic.sectionReservations.filter(
    (reservation) => reservation.robotId === robotId,
  );

  if (staleReservations.length === 0 && staleSectionReservations.length === 0) {
    return;
  }

  engine.traffic.sectionReservations = engine.traffic.sectionReservations.filter(
    (reservation) => reservation.robotId !== robotId,
  );

  for (const reservation of staleSectionReservations) {
    pushLog(engine, {
      type: "reservation_released",
      timeMs,
      robotId,
      missionId,
      message: `Released stale section ${engine.criticalSections.byId.get(reservation.sectionId)?.label ?? reservation.sectionId}`,
    });
  }
}

function applyWaitState(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  missionId: string | null,
  timeMs: number,
  gate: {
    reason: SimulatorWaitReason;
    resourceType: "node" | "edge" | "section";
    resourceId: string;
    blockerRobotId: string | null;
    waitingForLabel: string;
    retryAtMs: number | null;
  },
) {
  const nextWaitState: SimulatorWaitState = {
    reason: gate.reason,
    resourceType: gate.resourceType,
    resourceId: gate.resourceId,
    blockerRobotId: gate.blockerRobotId,
    startedAtMs: robot.waitState?.startedAtMs ?? timeMs,
    retryAtMs: gate.retryAtMs,
    waitingForLabel: gate.waitingForLabel,
  };

  const changed =
    robot.status !== "waiting_resource" ||
    robot.waitState?.reason !== nextWaitState.reason ||
    robot.waitState?.resourceId !== nextWaitState.resourceId ||
    robot.waitState?.blockerRobotId !== nextWaitState.blockerRobotId;

  robot.status = "waiting_resource";
  robot.motion = null;
  robot.waitState = nextWaitState;

  if (changed) {
    const blockerName = nextWaitState.blockerRobotId
      ? engine.robots.find((entry) => entry.id === nextWaitState.blockerRobotId)?.name ?? nextWaitState.blockerRobotId
      : null;
    pushLog(engine, {
      type: gate.reason === "node_occupancy" ? "node_conflict" : "edge_blocked",
      timeMs,
      robotId: robot.id,
      missionId,
      message: blockerName
        ? `${robot.name} blocked by ${nextWaitState.waitingForLabel} (${blockerName})`
        : `${robot.name} blocked by ${nextWaitState.waitingForLabel}`,
    });
    pushLog(engine, {
      type: "robot_wait_started",
      timeMs,
      robotId: robot.id,
      missionId,
      message: `${robot.name} waiting for ${nextWaitState.waitingForLabel}`,
    });
  }

  if (gate.retryAtMs !== null) {
    scheduleEvent(engine, {
      kind: "robot_ready_to_enter_edge",
      timeMs: Math.max(timeMs + 1, gate.retryAtMs),
      robotId: robot.id,
      missionId,
      routeIndex: robot.routeIndex,
      routeVersion: robot.routeVersion,
    });
  }
}

function clearWaitState(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  missionId: string | null,
  timeMs: number,
) {
  if (!robot.waitState) {
    return;
  }

  pushLog(engine, {
    type: "robot_wait_finished",
    timeMs,
    robotId: robot.id,
    missionId,
    message: `${robot.name} resumed after waiting for ${robot.waitState.waitingForLabel}`,
  });
  robot.waitState = null;
}

function resetRobotToIdle(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  timeMs: number,
  missionId: string | null,
) {
  releaseStaleEdgeReservationsForRobot(engine, robot.id, timeMs, missionId);
  robot.status = "idle";
  robot.routeKind = null;
  robot.routeVersion += 1;
  robot.currentMissionId = null;
  robot.currentMissionName = null;
  robot.routeSegments = [];
  robot.routeIndex = 0;
  robot.motion = null;
  robot.waitState = null;
}

function assignParkingRoute(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  timeMs: number,
  speedMps: number,
) {
  const parking = selectNearestAvailableWaitingPosition(engine, robot, timeMs, speedMps);
  if (!parking) {
    pushLog(engine, {
      type: "parking_skipped",
      timeMs,
      robotId: robot.id,
      missionId: null,
      message: `${robot.name} stays at ${engine.nodeMap.get(robot.currentNodeId)?.name ?? robot.currentNodeId}; no reachable free waiting position`,
    });
    return false;
  }

  robot.routeKind = "parking";
  robot.routeVersion += 1;
  robot.status = "waiting_resource";
  robot.currentMissionName = `Parking -> ${parking.node.name}`;
  robot.routeSegments = parking.route;
  robot.routeIndex = 0;
  robot.motion = null;
  robot.waitState = null;

  pushLog(engine, {
    type: "parking_assigned",
    timeMs,
    robotId: robot.id,
    missionId: null,
    message: `${robot.name} heading to parking at ${parking.node.name}`,
  });

  scheduleEvent(engine, {
    kind: "robot_ready_to_enter_edge",
    timeMs,
    robotId: robot.id,
    missionId: null,
    routeIndex: 0,
    routeVersion: robot.routeVersion,
  });
  return true;
}

function selectNearestAvailableWaitingPosition(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  startTimeMs: number,
  speedMps: number,
) {
  let winner:
    | {
        node: TopologyNode;
        route: SimulatorTimedRouteSegment[];
        finishTimeMs: number;
      }
    | null = null;

  const waitingNodes = engine.document.nodes.filter((node) => node.type === "waiting_position");
  for (const waitingNode of waitingNodes) {
    const occupants = Array.from(engine.traffic.nodeOccupants.get(waitingNode.id) ?? []);
    const occupiedByOtherRobot = occupants.some((occupantId) => occupantId !== robot.id);
    const incomingRobot = engine.robots.some((otherRobot) => {
      if (otherRobot.id === robot.id) {
        return false;
      }

      return otherRobot.motion?.toNodeId === waitingNode.id;
    });
    const reservedByOtherRobot = engine.robots.some((otherRobot) => {
      if (otherRobot.id === robot.id || otherRobot.routeKind !== "parking") {
        return false;
      }

      const targetNodeId = otherRobot.routeSegments[otherRobot.routeSegments.length - 1]?.toNodeId ?? null;
      return targetNodeId === waitingNode.id;
    });

    if (occupiedByOtherRobot || incomingRobot || reservedByOtherRobot) {
      continue;
    }

    const path = planTransferRoute(engine.graph, robot.currentNodeId, waitingNode.id);
    if (!path || path.segments.length === 0) {
      continue;
    }

    const timedRoute = buildTimedRoute(
      engine,
      robot.id,
      path.segments,
      startTimeMs,
      speedMps,
    );
    if (!timedRoute) {
      continue;
    }

    if (!winner || timedRoute.finishTimeMs < winner.finishTimeMs) {
      winner = {
        node: waitingNode,
        route: timedRoute.segments,
        finishTimeMs: timedRoute.finishTimeMs,
      };
    }
  }

  return winner;
}

function selectRobotForMission(
  engine: SimulationEngine,
  idleRobots: SimulatorRobotState[],
  missionStops: string[],
  startTimeMs: number,
  speedMps: number,
) {
  let winner:
    | {
        robot: SimulatorRobotState;
        route: SimulatorTimedRouteSegment[];
        pickupArrivalTimeMs: number;
        finishTimeMs: number;
        emptyDistanceM: number;
      }
    | null = null;

  for (const robot of idleRobots) {
    const route = planMissionRoute(engine.graph, robot.currentNodeId, missionStops);
    if (!route) {
      continue;
    }

    const timedRoute = buildTimedRoute(
      engine,
      robot.id,
      route.segments,
      startTimeMs,
      speedMps,
    );
    if (!timedRoute) {
      continue;
    }

    if (hasRouteReservationDelay(timedRoute.segments)) {
      continue;
    }

    const firstSegment = timedRoute.segments[0];
    if (!firstSegment || !canRobotStartSegmentNow(engine, robot, firstSegment, startTimeMs, speedMps)) {
      continue;
    }

    const pickupArrivalTimeMs = getMissionPickupArrivalTimeMs(
      timedRoute.segments,
      startTimeMs,
    );

    if (
      !winner ||
      pickupArrivalTimeMs < winner.pickupArrivalTimeMs ||
      (pickupArrivalTimeMs === winner.pickupArrivalTimeMs &&
        timedRoute.finishTimeMs < winner.finishTimeMs) ||
      (pickupArrivalTimeMs === winner.pickupArrivalTimeMs &&
        timedRoute.finishTimeMs === winner.finishTimeMs &&
        route.emptyDistanceM < winner.emptyDistanceM)
    ) {
      winner = {
        robot,
        route: timedRoute.segments,
        pickupArrivalTimeMs,
        finishTimeMs: timedRoute.finishTimeMs,
        emptyDistanceM: route.emptyDistanceM,
      };
    }
  }

  return winner;
}

function hasRouteReservationDelay(route: SimulatorTimedRouteSegment[]) {
  return route.some((segment) => segment.waitEndMs > segment.waitStartMs);
}

function getMissionPickupArrivalTimeMs(
  route: SimulatorTimedRouteSegment[],
  startTimeMs: number,
) {
  for (let index = route.length - 1; index >= 0; index -= 1) {
    if (!route[index].loaded) {
      return route[index].arriveAtMs;
    }
  }

  return startTimeMs;
}

function getSectionSpanBounds(route: SimulatorTimedRouteSegment[], index: number) {
  const segment = route[index];
  if (!segment?.sectionId) {
    return null;
  }

  let startIndex = index;
  while (startIndex > 0 && route[startIndex - 1]?.sectionId === segment.sectionId) {
    startIndex -= 1;
  }

  let endIndex = index;
  while (endIndex + 1 < route.length && route[endIndex + 1]?.sectionId === segment.sectionId) {
    endIndex += 1;
  }

  return {
    sectionId: segment.sectionId,
    startIndex,
    endIndex,
  };
}

function isSectionEntry(route: SimulatorTimedRouteSegment[], index: number) {
  const bounds = getSectionSpanBounds(route, index);
  return bounds !== null && bounds.startIndex === index;
}

function isSectionExit(route: SimulatorTimedRouteSegment[], index: number) {
  const bounds = getSectionSpanBounds(route, index);
  return bounds !== null && bounds.endIndex === index;
}

function getSectionReservationForEntry(
  engine: SimulationEngine,
  route: SimulatorTimedRouteSegment[],
  index: number,
): { section: SimulatorCriticalSection; releaseAtMs: number } | null {
  if (!isSectionEntry(route, index)) {
    return null;
  }

  const segment = route[index];
  if (!segment?.sectionId || segment.sectionReleaseAtMs === null) {
    return null;
  }

  const section = engine.criticalSections.byId.get(segment.sectionId);
  if (!section) {
    return null;
  }

  return {
    section,
    releaseAtMs: segment.sectionReleaseAtMs,
  };
}

function releaseSectionIfNeeded(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  segment: SimulatorTimedRouteSegment,
) {
  if (!segment.sectionId || !isSectionExit(robot.routeSegments, robot.routeIndex)) {
    return [];
  }

  return releaseSection(engine.traffic, segment.sectionId, robot.id);
}

function collectSectionReservationsForRobot(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  fromTimeMs: number,
) {
  if (robot.routeSegments.length === 0) {
    return [];
  }

  return getCriticalSectionRouteSpans(robot.routeSegments, engine.criticalSections).flatMap((span) => {
    if (span.endIndex < robot.routeIndex) {
      return [];
    }

    const startSegment = robot.routeSegments[span.startIndex];
    const endSegment = robot.routeSegments[span.endIndex];
    if (!startSegment || !endSegment || endSegment.sectionReleaseAtMs === null) {
      return [];
    }

    const alreadyInsideSection =
      (robot.motion !== null && robot.routeIndex >= span.startIndex && robot.routeIndex <= span.endIndex) ||
      (robot.motion === null && robot.routeIndex > span.startIndex && robot.routeIndex <= span.endIndex);
    const enteredAtMs = alreadyInsideSection
      ? fromTimeMs
      : Math.max(fromTimeMs, startSegment.departAtMs);
    const releaseAtMs = endSegment.sectionReleaseAtMs;
    if (releaseAtMs <= fromTimeMs || enteredAtMs >= releaseAtMs) {
      return [];
    }

    return [{
      sectionId: span.section.id,
      robotId: robot.id,
      enteredAtMs,
      releaseAtMs,
    }];
  });
}

function canRobotStartSegmentNow(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  segment: SimulatorTimedRouteSegment,
  timeMs: number,
  speedMps: number,
) {
  if (segment.departAtMs > timeMs) {
    return false;
  }

  const headwayMs = (MIN_SAME_EDGE_HEADWAY_M / Math.max(0.1, speedMps)) * 1000;
  return evaluateEdgeEntry(engine.traffic, {
    robotId: robot.id,
    edgeId: segment.edgeId,
    fromNodeId: segment.fromNodeId,
    toNodeId: segment.toNodeId,
    targetNodeId: segment.toNodeId,
    nowMs: timeMs,
    headwayMs,
    sectionId: isSectionEntry(robot.routeSegments, robot.routeIndex) ? segment.sectionId : null,
    sectionLabel: isSectionEntry(robot.routeSegments, robot.routeIndex) ? segment.sectionLabel : null,
    sectionReleaseAtMs: isSectionEntry(robot.routeSegments, robot.routeIndex)
      ? segment.sectionReleaseAtMs
      : null,
  }).allowed;
}

function buildTimedRoute(
  engine: SimulationEngine,
  robotId: string,
  route: SimulatorRouteSegment[],
  startTimeMs: number,
  speedMpsInput: number,
): {
  segments: SimulatorTimedRouteSegment[];
  reservations: ReservationWindow[];
  finishTimeMs: number;
} | null {
  if (route.length === 0) {
    return {
      segments: [],
      reservations: [],
      finishTimeMs: startTimeMs,
    };
  }

  const speedMps = Math.max(0.1, speedMpsInput);
  const headwayMs = (MIN_SAME_EDGE_HEADWAY_M / speedMps) * 1000;
  const skipReservationConflicts = engine.robots.filter((robot) => robot.id !== robotId).length === 0;
  const baseReservations = collectReservationWindows(engine, robotId, startTimeMs);
  const sectionSpanByStartIndex = new Map(
    getCriticalSectionRouteSpans(route, engine.criticalSections).map((span) => [span.startIndex, span]),
  );
  const ownReservations: ReservationWindow[] = [];
  const timedSegments: SimulatorTimedRouteSegment[] = [];

  let cursorMs = startTimeMs;
  let currentNodeId = route[0].fromNodeId;
  let currentNodeReservationStartMs = startTimeMs;

  for (let index = 0; index < route.length; index += 1) {
    const sectionSpan = sectionSpanByStartIndex.get(index);
    if (sectionSpan) {
      const plannedSection = planCriticalSectionSpan({
        engine,
        robotId,
        route,
        spanStartIndex: sectionSpan.startIndex,
        spanEndIndex: sectionSpan.endIndex,
        section: sectionSpan.section,
        startTimeMs,
        cursorMs,
        currentNodeId,
        currentNodeReservationStartMs,
        headwayMs,
        speedMps,
        reservations: [...baseReservations, ...ownReservations],
      });
      if (!plannedSection) {
        return null;
      }

      timedSegments.push(...plannedSection.segments);
      ownReservations.push(...plannedSection.reservations);
      cursorMs = plannedSection.finishTimeMs;
      currentNodeId = plannedSection.endNodeId;
      currentNodeReservationStartMs = plannedSection.finishTimeMs;
      index = sectionSpan.endIndex;
      continue;
    }

    const segment = route[index];
    const travelMs = Math.max(
      1,
      headwayMs,
      (segment.distanceM / speedMps) * 1000,
    );
    let departAtMs = Math.max(cursorMs, startTimeMs);
    let primaryBlock: ReservationBlock | null = null;
    let attempt = 0;

    while (attempt < MAX_PLAN_SHIFT_ATTEMPTS) {
      const block = skipReservationConflicts
        ? null
        : findReservationBlock(
          [...baseReservations, ...ownReservations],
          robotId,
          segment,
          departAtMs,
          travelMs,
          headwayMs,
        );
      if (!block) {
        break;
      }

      if (!Number.isFinite(block.releaseAtMs)) {
        return null;
      }

      if (!primaryBlock) {
        primaryBlock = block;
      }
      departAtMs = Math.max(departAtMs + 1, block.releaseAtMs);
      attempt += 1;
    }

    if (attempt >= MAX_PLAN_SHIFT_ATTEMPTS) {
      return null;
    }

    const arriveAtMs = departAtMs + travelMs;
    const waitStartMs = cursorMs;
    const waitEndMs = departAtMs;
    const waited = waitEndMs > waitStartMs;

    timedSegments.push({
      ...segment,
      waitStartMs,
      waitEndMs,
      departAtMs,
      arriveAtMs,
      sectionId: null,
      sectionLabel: null,
      sectionReleaseAtMs: null,
      waitReason: waited ? primaryBlock?.reason ?? "edge_occupancy" : null,
      waitResourceType: waited ? primaryBlock?.resourceType ?? null : null,
      waitResourceId: waited ? primaryBlock?.resourceId ?? null : null,
      waitingForLabel: waited ? primaryBlock?.waitingForLabel ?? null : null,
      blockerRobotId: waited ? primaryBlock?.blockerRobotId ?? null : null,
    });

    ownReservations.push({
      resourceType: "node",
      resourceId: currentNodeId,
      robotId,
      startTimeMs: currentNodeReservationStartMs,
      endTimeMs: departAtMs,
    });
    ownReservations.push({
      resourceType: "edge",
      resourceId: segment.edgeId,
      robotId,
      startTimeMs: departAtMs,
      endTimeMs: arriveAtMs,
      fromNodeId: segment.fromNodeId,
      toNodeId: segment.toNodeId,
    });

    currentNodeId = segment.toNodeId;
    currentNodeReservationStartMs = arriveAtMs;
    cursorMs = arriveAtMs;
  }

  ownReservations.push({
    resourceType: "node",
    resourceId: currentNodeId,
    robotId,
    startTimeMs: currentNodeReservationStartMs,
    endTimeMs: Math.max(
      currentNodeReservationStartMs + 1,
      cursorMs + DEFAULT_ROBOT_RESERVATION_HORIZON_MS,
    ),
  });

  return {
    segments: timedSegments,
    reservations: ownReservations,
    finishTimeMs: cursorMs,
  };
}

function planCriticalSectionSpan(input: {
  engine: SimulationEngine;
  robotId: string;
  route: SimulatorRouteSegment[];
  spanStartIndex: number;
  spanEndIndex: number;
  section: SimulatorCriticalSection;
  startTimeMs: number;
  cursorMs: number;
  currentNodeId: string;
  currentNodeReservationStartMs: number;
  headwayMs: number;
  speedMps: number;
  reservations: ReservationWindow[];
}) {
  let entryCursorMs = Math.max(input.cursorMs, input.startTimeMs);
  let attempts = 0;
  let primaryBlock: ReservationBlock | null = null;

  while (attempts < MAX_PLAN_SHIFT_ATTEMPTS) {
    const localReservations: ReservationWindow[] = [];
    const localSegments: SimulatorTimedRouteSegment[] = [];
    let localCursorMs = input.cursorMs;
    let localNodeId = input.currentNodeId;
    let localNodeReservationStartMs = input.currentNodeReservationStartMs;
    let restartWithEntryMs: number | null = null;

    for (let index = input.spanStartIndex; index <= input.spanEndIndex; index += 1) {
      const segment = input.route[index];
      const travelMs = Math.max(
        1,
        input.headwayMs,
        (segment.distanceM / input.speedMps) * 1000,
      );
      let departAtMs = index === input.spanStartIndex ? entryCursorMs : localCursorMs;
      let segmentPrimaryBlock: ReservationBlock | null = null;
      let segmentAttempts = 0;

      while (segmentAttempts < MAX_PLAN_SHIFT_ATTEMPTS) {
        const block = findReservationBlock(
          [...input.reservations, ...localReservations],
          input.robotId,
          segment,
          departAtMs,
          travelMs,
          input.headwayMs,
        );
        if (!block) {
          break;
        }

        if (!Number.isFinite(block.releaseAtMs)) {
          return null;
        }

        if (!segmentPrimaryBlock) {
          segmentPrimaryBlock = block;
        }
        departAtMs = Math.max(departAtMs + 1, block.releaseAtMs);
        segmentAttempts += 1;
      }

      if (segmentAttempts >= MAX_PLAN_SHIFT_ATTEMPTS) {
        return null;
      }

      if (index !== input.spanStartIndex && departAtMs > localCursorMs) {
        const offsetMs = localCursorMs - entryCursorMs;
        restartWithEntryMs = Math.max(entryCursorMs + 1, departAtMs - offsetMs);
        if (!primaryBlock) {
          primaryBlock = segmentPrimaryBlock;
        }
        break;
      }

      const arriveAtMs = departAtMs + travelMs;
      const waitStartMs = localCursorMs;
      const waitEndMs = departAtMs;
      const waited = waitEndMs > waitStartMs;

      localSegments.push({
        ...segment,
        waitStartMs,
        waitEndMs,
        departAtMs,
        arriveAtMs,
        sectionId: input.section.id,
        sectionLabel: input.section.label,
        sectionReleaseAtMs: null,
        waitReason: waited ? segmentPrimaryBlock?.reason ?? "edge_occupancy" : null,
        waitResourceType: waited ? segmentPrimaryBlock?.resourceType ?? null : null,
        waitResourceId: waited ? segmentPrimaryBlock?.resourceId ?? null : null,
        waitingForLabel: waited ? segmentPrimaryBlock?.waitingForLabel ?? null : null,
        blockerRobotId: waited ? segmentPrimaryBlock?.blockerRobotId ?? null : null,
      });

      localReservations.push({
        resourceType: "node",
        resourceId: localNodeId,
        robotId: input.robotId,
        startTimeMs: localNodeReservationStartMs,
        endTimeMs: departAtMs,
      });
      localReservations.push({
        resourceType: "edge",
        resourceId: segment.edgeId,
        robotId: input.robotId,
        startTimeMs: departAtMs,
        endTimeMs: arriveAtMs,
        fromNodeId: segment.fromNodeId,
        toNodeId: segment.toNodeId,
      });

      localNodeId = segment.toNodeId;
      localNodeReservationStartMs = arriveAtMs;
      localCursorMs = arriveAtMs;
    }

    if (restartWithEntryMs !== null) {
      entryCursorMs = restartWithEntryMs;
      attempts += 1;
      continue;
    }

    const sectionReleaseAtMs = localSegments[localSegments.length - 1]?.arriveAtMs ?? null;
    if (sectionReleaseAtMs === null) {
      return null;
    }

    const sectionBlock = findSectionReservationBlock(
      input.reservations,
      input.robotId,
      input.section,
      localSegments[0].departAtMs,
      sectionReleaseAtMs,
    );
    if (sectionBlock) {
      if (!primaryBlock) {
        primaryBlock = sectionBlock;
      }
      entryCursorMs = Math.max(entryCursorMs + 1, sectionBlock.releaseAtMs);
      attempts += 1;
      continue;
    }

    const annotatedSegments = localSegments.map((segment, index) => ({
      ...segment,
      sectionReleaseAtMs,
      waitReason:
        index === 0 && segment.waitEndMs > segment.waitStartMs
          ? primaryBlock?.reason ?? segment.waitReason
          : segment.waitReason,
      waitResourceType:
        index === 0 && segment.waitEndMs > segment.waitStartMs
          ? primaryBlock?.resourceType ?? segment.waitResourceType
          : segment.waitResourceType,
      waitResourceId:
        index === 0 && segment.waitEndMs > segment.waitStartMs
          ? primaryBlock?.resourceId ?? segment.waitResourceId
          : segment.waitResourceId,
      waitingForLabel:
        index === 0 && segment.waitEndMs > segment.waitStartMs
          ? primaryBlock?.waitingForLabel ?? segment.waitingForLabel
          : segment.waitingForLabel,
      blockerRobotId:
        index === 0 && segment.waitEndMs > segment.waitStartMs
          ? primaryBlock?.blockerRobotId ?? segment.blockerRobotId
          : segment.blockerRobotId,
    }));
    return {
      segments: annotatedSegments,
      reservations: localReservations.concat({
        resourceType: "section",
        resourceId: input.section.id,
        robotId: input.robotId,
        startTimeMs: annotatedSegments[0].departAtMs,
        endTimeMs: sectionReleaseAtMs,
      }),
      finishTimeMs: sectionReleaseAtMs,
      endNodeId: localNodeId,
      primaryBlock,
    };
  }

  return null;
}

function findSectionReservationBlock(
  reservations: ReservationWindow[],
  robotId: string,
  section: SimulatorCriticalSection,
  startTimeMs: number,
  endTimeMs: number,
): ReservationBlock | null {
  const overlaps = reservations
    .filter(
      (reservation) =>
        reservation.robotId !== robotId &&
        reservation.resourceType === "section" &&
        reservation.resourceId === section.id &&
        reservation.startTimeMs < endTimeMs &&
        reservation.endTimeMs > startTimeMs,
    )
    .map((reservation): ReservationBlock => ({
      releaseAtMs: reservation.endTimeMs,
      reason: "critical_section",
      resourceType: "section",
      resourceId: section.id,
      waitingForLabel: section.label,
      blockerRobotId: reservation.robotId,
    }));

  if (overlaps.length === 0) {
    return null;
  }

  return overlaps.reduce((winner, candidate) =>
    candidate.releaseAtMs > winner.releaseAtMs ? candidate : winner
  );
}

function collectReservationWindows(
  engine: SimulationEngine,
  excludeRobotId: string,
  startTimeMs: number,
) {
  const reservations: ReservationWindow[] = [];
  const robotMap = new Map(engine.robots.map((robot) => [robot.id, robot]));

  for (const edgeReservation of engine.traffic.edgeReservations) {
    if (edgeReservation.robotId === excludeRobotId) {
      continue;
    }
    if (edgeReservation.releaseAtMs <= startTimeMs) {
      continue;
    }

    reservations.push({
      resourceType: "edge",
      resourceId: edgeReservation.edgeId,
      robotId: edgeReservation.robotId,
      startTimeMs: Math.max(startTimeMs, edgeReservation.enteredAtMs),
      endTimeMs: edgeReservation.releaseAtMs,
      fromNodeId: edgeReservation.fromNodeId,
      toNodeId: edgeReservation.toNodeId,
    });
  }

  for (const sectionReservation of engine.traffic.sectionReservations) {
    if (sectionReservation.robotId === excludeRobotId) {
      continue;
    }
    if (sectionReservation.releaseAtMs <= startTimeMs) {
      continue;
    }

    reservations.push({
      resourceType: "section",
      resourceId: sectionReservation.sectionId,
      robotId: sectionReservation.robotId,
      startTimeMs: Math.max(startTimeMs, sectionReservation.enteredAtMs),
      endTimeMs: sectionReservation.releaseAtMs,
    });
  }

  for (const [nodeId, occupants] of engine.traffic.nodeOccupants) {
    for (const occupantRobotId of occupants) {
      if (occupantRobotId === excludeRobotId) {
        continue;
      }

      const occupant = robotMap.get(occupantRobotId);
      const releaseTimeMs = estimateNodeReleaseTime(occupant, nodeId, startTimeMs);
      if (releaseTimeMs <= startTimeMs) {
        continue;
      }

      reservations.push({
        resourceType: "node",
        resourceId: nodeId,
        robotId: occupantRobotId,
        startTimeMs,
        endTimeMs: releaseTimeMs,
      });
    }
  }

  for (const robot of engine.robots) {
    if (robot.id === excludeRobotId) {
      continue;
    }

    // Only in-flight robots contribute future route reservations here.
    // Stationary robots already block via current node occupancy, and treating their
    // entire planned route as reserved was causing false-positive blocks.
    if (!robot.motion) {
      continue;
    }

    for (let index = robot.routeIndex; index < robot.routeSegments.length; index += 1) {
      const segment = robot.routeSegments[index];
      if (segment.arriveAtMs <= startTimeMs) {
        continue;
      }

      reservations.push({
        resourceType: "edge",
        resourceId: segment.edgeId,
        robotId: robot.id,
        startTimeMs: Math.max(startTimeMs, segment.departAtMs),
        endTimeMs: segment.arriveAtMs,
        fromNodeId: segment.fromNodeId,
        toNodeId: segment.toNodeId,
      });

      const nextDepartAtMs = robot.routeSegments[index + 1]?.departAtMs
        ?? startTimeMs + DEFAULT_ROBOT_RESERVATION_HORIZON_MS;
      const nodeReservationStartMs = Math.max(startTimeMs, segment.arriveAtMs);
      const nodeReservationEndMs = Math.max(nodeReservationStartMs + 1, nextDepartAtMs);
      reservations.push({
        resourceType: "node",
        resourceId: segment.toNodeId,
        robotId: robot.id,
        startTimeMs: nodeReservationStartMs,
        endTimeMs: nodeReservationEndMs,
      });

      if (isSectionEntry(robot.routeSegments, index) && segment.sectionId && segment.sectionReleaseAtMs !== null) {
        reservations.push({
          resourceType: "section",
          resourceId: segment.sectionId,
          robotId: robot.id,
          startTimeMs: Math.max(startTimeMs, segment.departAtMs),
          endTimeMs: segment.sectionReleaseAtMs,
        });
      }
    }
  }

  return reservations;
}

function estimateNodeReleaseTime(
  robot: SimulatorRobotState | undefined,
  nodeId: string,
  fromTimeMs: number,
) {
  if (!robot) {
    return fromTimeMs + DEFAULT_ROBOT_RESERVATION_HORIZON_MS;
  }

  if (robot.motion) {
    if (robot.motion.toNodeId !== nodeId) {
      return fromTimeMs + DEFAULT_ROBOT_RESERVATION_HORIZON_MS;
    }

    const nextSegment = robot.routeSegments[robot.routeIndex + 1];
    if (nextSegment) {
      return Math.max(fromTimeMs + 1, nextSegment.departAtMs);
    }

    return fromTimeMs + DEFAULT_ROBOT_RESERVATION_HORIZON_MS;
  }

  if (robot.currentNodeId !== nodeId) {
    return fromTimeMs + DEFAULT_ROBOT_RESERVATION_HORIZON_MS;
  }

  const nextSegment = robot.routeSegments[robot.routeIndex];
  if (!nextSegment) {
    return fromTimeMs + DEFAULT_ROBOT_RESERVATION_HORIZON_MS;
  }

  return Math.max(fromTimeMs + 1, nextSegment.departAtMs);
}

function findReservationBlock(
  reservations: ReservationWindow[],
  robotId: string,
  segment: SimulatorRouteSegment,
  departAtMs: number,
  travelMs: number,
  headwayMs: number,
): ReservationBlock | null {
  const arrivalMs = departAtMs + travelMs;
  const nodeBlocks = reservations
    .filter(
      (reservation) =>
        reservation.robotId !== robotId &&
        reservation.resourceType === "node" &&
        reservation.resourceId === segment.toNodeId &&
        reservation.startTimeMs <= arrivalMs &&
        reservation.endTimeMs > arrivalMs,
    )
    .map((reservation): ReservationBlock => ({
      releaseAtMs: reservation.endTimeMs,
      reason: "node_occupancy",
      resourceType: "node",
      resourceId: segment.toNodeId,
      waitingForLabel: `Node ${segment.toNodeId}`,
      blockerRobotId: reservation.robotId,
    }));

  const oppositeDirectionBlocks = reservations
    .filter(
      (reservation) =>
        reservation.robotId !== robotId &&
        reservation.resourceType === "edge" &&
        reservation.resourceId === segment.edgeId &&
        reservation.fromNodeId === segment.toNodeId &&
        reservation.toNodeId === segment.fromNodeId &&
        reservation.startTimeMs < arrivalMs &&
        reservation.endTimeMs > departAtMs,
    )
    .map((reservation): ReservationBlock => ({
      releaseAtMs: reservation.endTimeMs,
      reason: "bidirectional_mutual_exclusion",
      resourceType: "edge",
      resourceId: segment.edgeId,
      waitingForLabel: `Edge ${segment.fromNodeId} -> ${segment.toNodeId}`,
      blockerRobotId: reservation.robotId,
    }));

  const sameDirectionHeadwayBlocks = reservations
    .filter(
      (reservation) =>
        reservation.robotId !== robotId &&
        reservation.resourceType === "edge" &&
        reservation.resourceId === segment.edgeId &&
        reservation.fromNodeId === segment.fromNodeId &&
        reservation.toNodeId === segment.toNodeId &&
        reservation.startTimeMs <= departAtMs &&
        departAtMs < reservation.startTimeMs + headwayMs,
    )
    .map((reservation): ReservationBlock => ({
      releaseAtMs: reservation.startTimeMs + headwayMs,
      reason: "minimum_headway",
      resourceType: "edge",
      resourceId: segment.edgeId,
      waitingForLabel: `Headway on ${segment.fromNodeId} -> ${segment.toNodeId}`,
      blockerRobotId: reservation.robotId,
    }));

  const blocks = [...nodeBlocks, ...oppositeDirectionBlocks, ...sameDirectionHeadwayBlocks];
  if (blocks.length === 0) {
    return null;
  }

  return blocks.reduce((winner, candidate) =>
    candidate.releaseAtMs > winner.releaseAtMs ? candidate : winner
  );
}

function scheduleNextMissionArrival(
  engine: SimulationEngine,
  missionTemplateId: string,
  fromTimeMs: number,
) {
  const template = engine.templateMap.get(missionTemplateId);
  if (!template || template.callsPerHour <= 0) {
    return;
  }

  const sampled = sampleExponentialMs(template.callsPerHour, engine.rngSeed);
  engine.rngSeed = sampled.seed;

  if (!Number.isFinite(sampled.intervalMs)) {
    return;
  }

  scheduleEvent(engine, {
    kind: "mission_arrival",
    timeMs: fromTimeMs + sampled.intervalMs,
    missionTemplateId,
  });
}

function scheduleEvent(
  engine: SimulationEngine,
  event: ScheduledEventInput,
) {
  const scheduledEvent = {
    ...event,
    id: `sim_event_${String(engine.nextEventId).padStart(5, "0")}`,
  } as ScheduledEvent;
  engine.nextEventId += 1;
  engine.queue.push(scheduledEvent);
  engine.queue.sort((a, b) => {
    if (a.timeMs !== b.timeMs) {
      return a.timeMs - b.timeMs;
    }

    return getScheduledEventPriority(a.kind) - getScheduledEventPriority(b.kind);
  });
}

function pushLog(
  engine: SimulationEngine,
  event: Omit<SimulationEvent, "id">,
) {
  engine.events.push({
    ...event,
    id: `log_${String(engine.events.length + 1).padStart(5, "0")}`,
  });

  if (engine.events.length > MAX_EVENT_LOG) {
    engine.events.splice(0, engine.events.length - MAX_EVENT_LOG);
  }
}

function buildPendingMissionSnapshots(engine: SimulationEngine): SimulatorPendingMissionSnapshot[] {
  return engine.pendingMissionIds.slice(0, 8).flatMap((missionId) => {
    const mission = engine.missionMap.get(missionId);
    if (!mission) {
      return [];
    }

    return [{
      id: mission.id,
      name: mission.name,
      waitMs: Math.max(0, engine.timeMs - mission.createdAtMs),
      stopNames: mission.stops.map((stopId) => engine.nodeMap.get(stopId)?.name ?? stopId),
    }];
  });
}

function buildRobotSnapshot(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
): SimulatorRobotSnapshot {
  const point = getRobotPoint(engine, robot);

  return {
    id: robot.id,
    name: robot.name,
    status: robot.status,
    point,
    headingRad: getRobotHeading(engine, robot),
    blockedByRobotId: robot.waitState?.blockerRobotId ?? null,
    waitReason: robot.waitState?.reason ?? null,
    waitingForLabel: robot.waitState?.waitingForLabel ?? null,
    currentMissionName: robot.currentMissionName,
    currentNodeId: robot.currentNodeId,
    targetNodeId: robot.motion?.toNodeId ?? null,
    progress: getRobotProgress(engine, robot),
    totalDistanceM: robot.totalDistanceM,
    completedMissionCount: robot.completedMissionCount,
    pathPoints: buildRobotPathPoints(engine, robot, point),
  };
}

function getRobotPoint(engine: SimulationEngine, robot: SimulatorRobotState): Point {
  const currentNode = engine.nodeMap.get(robot.currentNodeId);
  if (!currentNode) {
    return { x: 0, y: 0 };
  }

  if (!robot.motion) {
    return { x: currentNode.x, y: currentNode.y };
  }

  const fromNode = engine.nodeMap.get(robot.motion.fromNodeId) ?? currentNode;
  const toNode = engine.nodeMap.get(robot.motion.toNodeId) ?? currentNode;
  const progress = getRobotProgress(engine, robot);

  return {
    x: fromNode.x + (toNode.x - fromNode.x) * progress,
    y: fromNode.y + (toNode.y - fromNode.y) * progress,
  };
}

function getRobotProgress(engine: SimulationEngine, robot: SimulatorRobotState) {
  if (!robot.motion) {
    return 1;
  }

  const duration = Math.max(1, robot.motion.endsAtMs - robot.motion.startedAtMs);
  return Math.max(
    0,
    Math.min(1, (engine.timeMs - robot.motion.startedAtMs) / duration),
  );
}

function buildRobotPathPoints(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  currentPoint: Point,
) {
  const points: Point[] = [currentPoint];

  if (robot.motion) {
    const currentTarget = engine.nodeMap.get(robot.motion.toNodeId);
    if (currentTarget) {
      points.push({ x: currentTarget.x, y: currentTarget.y });
    }
  }

  for (let index = robot.routeIndex + (robot.motion ? 1 : 0); index < robot.routeSegments.length; index += 1) {
    const node = engine.nodeMap.get(robot.routeSegments[index].toNodeId);
    if (!node) {
      continue;
    }

    const lastPoint = points[points.length - 1];
    if (lastPoint && lastPoint.x === node.x && lastPoint.y === node.y) {
      continue;
    }

    points.push({ x: node.x, y: node.y });
  }

  return points;
}

function getRobotHeading(engine: SimulationEngine, robot: SimulatorRobotState) {
  if (robot.motion) {
    const fromNode = engine.nodeMap.get(robot.motion.fromNodeId);
    const toNode = engine.nodeMap.get(robot.motion.toNodeId);
    if (fromNode && toNode) {
      return Math.atan2(toNode.y - fromNode.y, toNode.x - fromNode.x);
    }
  }

  const currentNode = engine.nodeMap.get(robot.currentNodeId);
  const currentNodeHeading = currentNode ? getNodeHeadingRad(currentNode) : null;
  if (currentNodeHeading !== null) {
    return currentNodeHeading;
  }

  const nextSegment = robot.routeSegments[robot.routeIndex];
  if (nextSegment) {
    const fromNode = engine.nodeMap.get(nextSegment.fromNodeId);
    const toNode = engine.nodeMap.get(nextSegment.toNodeId);
    if (fromNode && toNode) {
      return Math.atan2(toNode.y - fromNode.y, toNode.x - fromNode.x);
    }
  }

  return 0;
}

function getScheduledEventPriority(kind: ScheduledEvent["kind"]) {
  if (kind === "mission_arrival") {
    return 0;
  }
  if (kind === "robot_arrive_node") {
    return 1;
  }

  return 2;
}
