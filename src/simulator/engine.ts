import type { Point, TopologyDocument, TopologyNode } from "../types";
import { planMissionRoute, buildRobotGraph } from "./planner";
import { normalizeSeed, sampleExponentialMs } from "./random";
import {
  getRobotAxes,
  getRobotFrontPoint,
  getRobotSupportExtent,
  ROBOT_FORWARD_CLEARANCE_M,
  ROBOT_HALF_WIDTH_M,
} from "./robotGeometry";
import type {
  CompiledMissionSummary,
  SimulationEvent,
  SimulationSnapshot,
  SimulatorFleetConfig,
  SimulatorMissionDraft,
  SimulatorMissionInstance,
  SimulatorRobotSnapshot,
  SimulatorRobotState,
  SimulatorRouteSegment,
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
};

const MAX_EVENT_LOG = 500;
const SAFETY_STEP_MS = 100;

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
    const nextTime = Math.min(
      safeTargetTime,
      nextQueuedEventTime,
      engine.timeMs + SAFETY_STEP_MS,
    );

    engine.timeMs = nextTime;
    updateRobotForwardBlocking(engine);

    while (engine.queue.length > 0 && engine.queue[0].timeMs <= engine.timeMs) {
      const nextEvent = engine.queue.shift()!;

      if (nextEvent.kind === "mission_arrival") {
        processMissionArrival(engine, nextEvent, fleet);
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

  return {
    currentTimeMs: engine.timeMs,
    robots: engine.robots.map((robot) => buildRobotSnapshot(engine, robot)),
    recentEvents: engine.events.slice(-18).reverse(),
    pendingMissionCount,
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

  dispatchPendingMissions(engine, fleet);
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

  if (robot.motion.blockedAtMs !== null) {
    scheduleEvent(engine, {
      kind: "robot_arrive_node",
      timeMs: engine.timeMs + SAFETY_STEP_MS,
      robotId: robot.id,
      missionId: mission.id,
      routeIndex: robot.routeIndex,
    });
    return;
  }

  if (event.timeMs + 1 < robot.motion.endsAtMs) {
    scheduleEvent(engine, {
      kind: "robot_arrive_node",
      timeMs: robot.motion.endsAtMs,
      robotId: robot.id,
      missionId: mission.id,
      routeIndex: robot.routeIndex,
    });
    return;
  }

  const segment = robot.routeSegments[event.routeIndex];
  if (!segment) {
    return;
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

    dispatchPendingMissions(engine, fleet);
    return;
  }

  startRobotSegment(engine, robot, mission, event.timeMs, fleet);
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

    pushLog(engine, {
      type: "mission_assigned",
      timeMs: engine.timeMs,
      robotId: bestRobot.robot.id,
      missionId: mission.id,
      message: `${bestRobot.robot.name} assigned to ${mission.name}`,
    });

    startRobotSegment(engine, bestRobot.robot, mission, engine.timeMs, fleet);
    assignedAny = true;
  }
}

function startRobotSegment(
  engine: SimulationEngine,
  robot: SimulatorRobotState,
  mission: SimulatorMissionInstance,
  startTimeMs: number,
  fleet: SimulatorFleetConfig,
) {
  const segment = robot.routeSegments[robot.routeIndex];
  if (!segment) {
    return;
  }

  const speedMps = Math.max(0.1, fleet.robotSpeedMps);
  const durationMs = (segment.distanceM / speedMps) * 1000;
  robot.status = segment.loaded ? "moving_loaded" : "moving_empty";
  robot.motion = {
    edgeId: segment.edgeId,
    fromNodeId: segment.fromNodeId,
    toNodeId: segment.toNodeId,
    distanceM: segment.distanceM,
    loaded: segment.loaded,
    startedAtMs: startTimeMs,
    endsAtMs: startTimeMs + durationMs,
    blockedAtMs: null,
    blockedByRobotId: null,
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
  engine.queue.sort((a, b) => a.timeMs - b.timeMs);
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

  if (event.type === "mission_created") {
    const mission = engine.missionMap.get(event.missionId ?? "");
    if (mission) {
      scheduleNextMissionArrival(engine, mission.templateId, event.timeMs);
    }
  }
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
    blockedByRobotId: robot.motion?.blockedByRobotId ?? null,
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

  const effectiveTime = robot.motion.blockedAtMs ?? engine.timeMs;
  const duration = Math.max(1, robot.motion.endsAtMs - robot.motion.startedAtMs);
  return Math.max(
    0,
    Math.min(1, (effectiveTime - robot.motion.startedAtMs) / duration),
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

function updateRobotForwardBlocking(engine: SimulationEngine) {
  const positions = engine.robots.map((robot) => ({
    robot,
    point: getRobotPoint(engine, robot),
    heading: getRobotHeading(engine, robot),
  }));

  for (const current of positions) {
    if (!current.robot.motion) {
      continue;
    }

    const blocker = findForwardBlocker(current, positions);

    if (blocker) {
      if (current.robot.motion.blockedAtMs === null) {
        current.robot.motion.blockedAtMs = engine.timeMs;
        current.robot.motion.blockedByRobotId = blocker.robot.id;
        current.robot.status = "waiting_forward";
        pushLog(engine, {
          type: "robot_waiting",
          timeMs: engine.timeMs,
          robotId: current.robot.id,
          missionId: current.robot.currentMissionId,
          message: `${current.robot.name} waiting for ${blocker.robot.name} ahead`,
        });
      }

      continue;
    }

    if (current.robot.motion.blockedAtMs !== null) {
      const blockedAtMs = current.robot.motion.blockedAtMs;
      const pauseDuration = Math.max(0, engine.timeMs - blockedAtMs);
      current.robot.motion.startedAtMs += pauseDuration;
      current.robot.motion.endsAtMs += pauseDuration;
      current.robot.motion.blockedAtMs = null;
      current.robot.motion.blockedByRobotId = null;
      current.robot.status = current.robot.motion.loaded ? "moving_loaded" : "moving_empty";
      pushLog(engine, {
        type: "robot_resumed",
        timeMs: engine.timeMs,
        robotId: current.robot.id,
        missionId: current.robot.currentMissionId,
        message: `${current.robot.name} resumed`,
      });
    }
  }
}

function findForwardBlocker(
  current: { robot: SimulatorRobotState; point: Point; heading: number },
  positions: Array<{ robot: SimulatorRobotState; point: Point; heading: number }>,
) {
  const { forward, lateral } = getRobotAxes(current.heading);
  const frontPoint = getRobotFrontPoint(current.point, current.heading);
  const reverseForward = {
    x: -forward.x,
    y: -forward.y,
  };
  let winner: { robot: SimulatorRobotState; forwardGap: number } | null = null;

  for (const candidate of positions) {
    if (candidate.robot.id === current.robot.id) {
      continue;
    }

    const dx = candidate.point.x - frontPoint.x;
    const dy = candidate.point.y - frontPoint.y;
    const forwardDistance = dx * forward.x + dy * forward.y;
    if (forwardDistance <= 0) {
      continue;
    }

    const candidateForwardReach = getRobotSupportExtent(candidate.heading, reverseForward);
    const candidateLateralReach = getRobotSupportExtent(candidate.heading, lateral);
    const forwardGap = forwardDistance - candidateForwardReach;
    if (forwardGap > ROBOT_FORWARD_CLEARANCE_M) {
      continue;
    }

    const lateralDistance = Math.abs(dx * lateral.x + dy * lateral.y);
    if (lateralDistance > ROBOT_HALF_WIDTH_M + candidateLateralReach) {
      continue;
    }

    if (!winner || forwardGap < winner.forwardGap) {
      winner = {
        robot: candidate.robot,
        forwardGap,
      };
    }
  }

  return winner;
}
