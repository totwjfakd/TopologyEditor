import type { Point, TopologyDocument, TopologyNode } from "../types";
import { planMissionRoute, buildRobotGraph } from "./planner";
import { normalizeSeed, sampleExponentialMs } from "./random";
import {
  createTrafficState,
  evaluateEdgeEntry,
  MIN_SAME_EDGE_HEADWAY_M,
  occupyNode,
  releaseEdge,
  releaseNode,
  reserveEdge,
  type TrafficState,
} from "./traffic";
import type {
  CompiledMissionSummary,
  SimulationEvent,
  SimulatorPendingMissionSnapshot,
  SimulationSnapshot,
  SimulatorFleetConfig,
  SimulatorMissionDraft,
  SimulatorMissionInstance,
  SimulatorRobotSnapshot,
  SimulatorRobotState,
  SimulatorRouteSegment,
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
      missionId: string;
      routeIndex: number;
    }
  | {
      id: string;
      timeMs: number;
      kind: "robot_arrive_node";
      robotId: string;
      missionId: string;
      routeIndex: number;
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
      missionId: string;
      routeIndex: number;
    }
  | {
      timeMs: number;
      kind: "robot_arrive_node";
      robotId: string;
      missionId: string;
      routeIndex: number;
    };

export type SimulationEngine = {
  document: TopologyDocument;
  nodeMap: Map<string, TopologyNode>;
  graph: ReturnType<typeof buildRobotGraph>;
  templates: CompiledMissionTemplate[];
  templateMap: Map<string, CompiledMissionTemplate>;
  compiledMissionSummaries: CompiledMissionSummary[];
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

export function createSimulationEngine(
  document: TopologyDocument,
  missions: SimulatorMissionDraft[],
  fleet: SimulatorFleetConfig,
): SimulationEngine {
  const graph = buildRobotGraph(document);
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const compiled = compileMissions(document, missions);
  const robots = createRobots(document, fleet.robotCount);

  const engine: SimulationEngine = {
    document,
    nodeMap,
    graph,
    templates: compiled.templates,
    templateMap: new Map(compiled.templates.map((template) => [template.id, template])),
    compiledMissionSummaries: compiled.summaries,
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
  const destinations = document.nodes.filter((node) => node.type === "destination");
  const spawnNodes = destinations.length > 0 ? destinations : document.nodes;
  const robotCount = Math.max(0, Math.min(32, Math.trunc(requestedCount)));

  if (spawnNodes.length === 0 || robotCount === 0) {
    return [];
  }

  return Array.from({ length: robotCount }, (_, index): SimulatorRobotState => {
    const spawnNode = spawnNodes[index % spawnNodes.length];

    return {
      id: `robot_${String(index + 1).padStart(2, "0")}`,
      name: `R${index + 1}`,
      status: "idle",
      currentNodeId: spawnNode.id,
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
  const robot = engine.robots.find((entry) => entry.id === event.robotId);
  const mission = engine.missionMap.get(event.missionId);
  if (!robot || !mission || !robot.motion || robot.routeIndex !== event.routeIndex) {
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
      missionId: mission.id,
      message: `${robot.name} released edge ${reservation.fromNodeId} -> ${reservation.toNodeId}`,
    });
  }

  robot.currentNodeId = segment.toNodeId;
  robot.totalDistanceM += segment.distanceM;
  robot.motion = null;

  pushLog(engine, {
    type: "node_arrived",
    timeMs: event.timeMs,
    robotId: robot.id,
    missionId: mission.id,
    message: `${robot.name} arrived at ${engine.nodeMap.get(segment.toNodeId)?.name ?? segment.toNodeId}`,
  });

  robot.routeIndex += 1;

  if (robot.routeIndex >= robot.routeSegments.length) {
    robot.status = "idle";
    robot.currentMissionId = null;
    robot.currentMissionName = null;
    robot.routeSegments = [];
    robot.routeIndex = 0;
    robot.waitState = null;
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

    processTrafficQueue(engine, fleet);
    return;
  }

  scheduleEvent(engine, {
    kind: "robot_ready_to_enter_edge",
    timeMs: event.timeMs,
    robotId: robot.id,
    missionId: mission.id,
    routeIndex: robot.routeIndex,
  });
  processTrafficQueue(engine, fleet);
}

function processRobotReadyToEnterEdge(
  engine: SimulationEngine,
  event: Extract<ScheduledEvent, { kind: "robot_ready_to_enter_edge" }>,
  fleet: SimulatorFleetConfig,
) {
  const robot = engine.robots.find((entry) => entry.id === event.robotId);
  const mission = engine.missionMap.get(event.missionId);
  if (!robot || !mission || robot.currentMissionId !== mission.id || robot.routeIndex !== event.routeIndex) {
    return;
  }

  if (robot.motion) {
    return;
  }

  attemptRobotEdgeEntry(engine, robot, mission, event.timeMs, fleet);
}

function dispatchPendingMissions(engine: SimulationEngine, fleet: SimulatorFleetConfig) {
  let assignedAny = true;

  while (assignedAny) {
    assignedAny = false;
    const idleRobots = engine.robots.filter((robot) => robot.status === "idle");
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

    const bestRobot = selectRobotForMission(engine, idleRobots, template.stopNodeIds);
    if (!bestRobot) {
      return;
    }

    engine.pendingMissionIds.shift();
    mission.status = "assigned";
    mission.assignedRobotId = bestRobot.robot.id;
    mission.startedAtMs = engine.timeMs;
    bestRobot.robot.currentMissionId = mission.id;
    bestRobot.robot.currentMissionName = mission.name;
    bestRobot.robot.routeSegments = bestRobot.route;
    bestRobot.robot.routeIndex = 0;
    bestRobot.robot.waitState = null;

    pushLog(engine, {
      type: "mission_assigned",
      timeMs: engine.timeMs,
      robotId: bestRobot.robot.id,
      missionId: mission.id,
      message: `${bestRobot.robot.name} assigned to ${mission.name}`,
    });

    scheduleEvent(engine, {
      kind: "robot_ready_to_enter_edge",
      timeMs: engine.timeMs,
      robotId: bestRobot.robot.id,
      missionId: mission.id,
      routeIndex: 0,
    });
    assignedAny = true;
  }
}

function attemptRobotEdgeEntry(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  mission: SimulatorMissionInstance,
  startTimeMs: number,
  fleet: SimulatorFleetConfig,
) {
  const segment = robot.routeSegments[robot.routeIndex];
  if (!segment) {
    return false;
  }

  pushLog(engine, {
    type: "robot_ready_to_enter_edge",
    timeMs: startTimeMs,
    robotId: robot.id,
    missionId: mission.id,
    message: `${robot.name} ready to enter ${engine.nodeMap.get(segment.fromNodeId)?.name ?? segment.fromNodeId} -> ${engine.nodeMap.get(segment.toNodeId)?.name ?? segment.toNodeId}`,
  });

  const speedMps = Math.max(0.1, fleet.robotSpeedMps);
  const headwayMs = (MIN_SAME_EDGE_HEADWAY_M / speedMps) * 1000;
  const gate = evaluateEdgeEntry(engine.traffic, {
    robotId: robot.id,
    edgeId: segment.edgeId,
    fromNodeId: segment.fromNodeId,
    toNodeId: segment.toNodeId,
    targetNodeId: segment.toNodeId,
    nowMs: startTimeMs,
    headwayMs,
  });

  if (!gate.allowed) {
    applyWaitState(engine, robot, mission.id, startTimeMs, gate);
    return false;
  }

  clearWaitState(engine, robot, mission.id, startTimeMs);
  releaseNodeReservationForDeparture(engine, robot, mission.id, startTimeMs);

  const durationMs = (segment.distanceM / speedMps) * 1000;
  occupyNode(engine.traffic, segment.toNodeId, robot.id);
  reserveEdge(engine.traffic, {
    edgeId: segment.edgeId,
    robotId: robot.id,
    fromNodeId: segment.fromNodeId,
    toNodeId: segment.toNodeId,
    enteredAtMs: startTimeMs,
    releaseAtMs: startTimeMs + durationMs,
  });

  pushLog(engine, {
    type: "edge_enter_granted",
    timeMs: startTimeMs,
    robotId: robot.id,
    missionId: mission.id,
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
    endsAtMs: startTimeMs + durationMs,
  };

  pushLog(engine, {
    type: "edge_entered",
    timeMs: startTimeMs,
    robotId: robot.id,
    missionId: mission.id,
    message: `${robot.name} entered ${engine.nodeMap.get(segment.fromNodeId)?.name ?? segment.fromNodeId} -> ${engine.nodeMap.get(segment.toNodeId)?.name ?? segment.toNodeId}`,
  });

  scheduleEvent(engine, {
    kind: "robot_arrive_node",
    timeMs: startTimeMs + durationMs,
    robotId: robot.id,
    missionId: mission.id,
    routeIndex: robot.routeIndex,
  });
  return true;
}

function processTrafficQueue(engine: SimulationEngine, fleet: SimulatorFleetConfig) {
  let progressed = true;

  while (progressed) {
    const startedWaitingRobots = retryWaitingRobots(engine, fleet);
    const beforePending = engine.pendingMissionIds.length;
    const beforeMoving = engine.robots.filter((robot) => robot.motion).length;
    dispatchPendingMissions(engine, fleet);
    const afterMoving = engine.robots.filter((robot) => robot.motion).length;
    progressed =
      startedWaitingRobots ||
      engine.pendingMissionIds.length !== beforePending ||
      afterMoving !== beforeMoving;
  }
}

function retryWaitingRobots(engine: SimulationEngine, fleet: SimulatorFleetConfig) {
  let startedAny = false;

  const waitingRobots = engine.robots
    .filter((robot) => robot.status === "waiting_resource" && robot.currentMissionId)
    .filter((robot) => robot.waitState?.retryAtMs === null)
    .sort((a, b) => (a.waitState?.startedAtMs ?? 0) - (b.waitState?.startedAtMs ?? 0));

  for (const robot of waitingRobots) {
    const mission = engine.missionMap.get(robot.currentMissionId ?? "");
    if (!mission) {
      continue;
    }

    if (attemptRobotEdgeEntry(engine, robot, mission, engine.timeMs, fleet)) {
      startedAny = true;
    }
  }

  return startedAny;
}

function releaseNodeReservationForDeparture(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  missionId: string,
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

function applyWaitState(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  missionId: string,
  timeMs: number,
  gate: Exclude<ReturnType<typeof evaluateEdgeEntry>, { allowed: true }>,
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
    pushLog(engine, {
      type: gate.reason === "node_occupancy" ? "node_conflict" : "edge_blocked",
      timeMs,
      robotId: robot.id,
      missionId,
      message: `${robot.name} blocked by ${nextWaitState.waitingForLabel}`,
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
    });
  }
}

function clearWaitState(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  missionId: string,
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

function selectRobotForMission(
  engine: SimulationEngine,
  idleRobots: SimulatorRobotState[],
  missionStops: string[],
) {
  let winner:
    | {
        robot: SimulatorRobotState;
        route: SimulatorRouteSegment[];
        emptyDistanceM: number;
      }
    | null = null;

  for (const robot of idleRobots) {
    const route = planMissionRoute(engine.graph, robot.currentNodeId, missionStops);
    if (!route) {
      continue;
    }

    if (!winner || route.emptyDistanceM < winner.emptyDistanceM) {
      winner = {
        robot,
        route: route.segments,
        emptyDistanceM: route.emptyDistanceM,
      };
    }
  }

  return winner;
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
