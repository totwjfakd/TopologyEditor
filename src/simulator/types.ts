import type { Point } from "../types";

export const SIMULATOR_SPEED_OPTIONS = [1, 2, 4, 8, 16, 32, 64] as const;

export type SimulatorSpeed = (typeof SIMULATOR_SPEED_OPTIONS)[number];

export type SimulatorMissionDraft = {
  id: string;
  name: string;
  stops: string[];
  callsPerHour: number;
};

export type CompiledMissionSummary = {
  id: string;
  name: string;
  callsPerHour: number;
  stopNodeIds: string[];
  stopNames: string[];
  isValid: boolean;
  error: string | null;
  loadedDistanceM: number;
};

export type SimulatorRouteSegment = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  distanceM: number;
  loaded: boolean;
};

export type SimulatorTimedRouteSegment = SimulatorRouteSegment & {
  waitStartMs: number;
  waitEndMs: number;
  departAtMs: number;
  arriveAtMs: number;
  sectionId: string | null;
  sectionLabel: string | null;
  sectionReleaseAtMs: number | null;
  waitReason: SimulatorWaitReason | null;
  waitResourceType: "node" | "edge" | "section" | null;
  waitResourceId: string | null;
  waitingForLabel: string | null;
  blockerRobotId: string | null;
};

export type ReservationWindow = {
  resourceType: "node" | "edge" | "section";
  resourceId: string;
  robotId: string;
  startTimeMs: number;
  endTimeMs: number;
  fromNodeId?: string;
  toNodeId?: string;
};

export type SimulatorRobotStatus =
  | "idle"
  | "moving_empty"
  | "moving_loaded"
  | "waiting_resource";

export type SimulatorWaitReason =
  | "node_occupancy"
  | "edge_occupancy"
  | "minimum_headway"
  | "bidirectional_mutual_exclusion"
  | "critical_section";

export type SimulatorMotion = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  distanceM: number;
  loaded: boolean;
  startedAtMs: number;
  endsAtMs: number;
};

export type SimulatorWaitState = {
  reason: SimulatorWaitReason;
  resourceType: "node" | "edge" | "section";
  resourceId: string;
  blockerRobotId: string | null;
  startedAtMs: number;
  retryAtMs: number | null;
  waitingForLabel: string;
};

export type SimulatorRobotState = {
  id: string;
  name: string;
  status: SimulatorRobotStatus;
  currentNodeId: string;
  routeKind: "mission" | "parking" | null;
  routeVersion: number;
  currentMissionId: string | null;
  currentMissionName: string | null;
  completedMissionCount: number;
  totalDistanceM: number;
  routeSegments: SimulatorTimedRouteSegment[];
  routeIndex: number;
  motion: SimulatorMotion | null;
  waitState: SimulatorWaitState | null;
};

export type SimulatorMissionStatus =
  | "pending"
  | "assigned"
  | "completed";

export type SimulatorMissionInstance = {
  id: string;
  templateId: string;
  name: string;
  stops: string[];
  createdAtMs: number;
  assignedRobotId: string | null;
  status: SimulatorMissionStatus;
  startedAtMs: number | null;
  completedAtMs: number | null;
};

export type SimulationEventType =
  | "mission_created"
  | "mission_dropped"
  | "mission_assigned"
  | "parking_assigned"
  | "parking_skipped"
  | "parking_arrived"
  | "robot_ready_to_enter_edge"
  | "edge_blocked"
  | "edge_enter_granted"
  | "edge_entered"
  | "robot_wait_started"
  | "robot_wait_finished"
  | "node_conflict"
  | "reservation_released"
  | "node_arrived"
  | "mission_completed";

export type SimulationEvent = {
  id: string;
  timeMs: number;
  type: SimulationEventType;
  robotId: string | null;
  missionId: string | null;
  message: string;
};

export type SimulatorRobotSnapshot = {
  id: string;
  name: string;
  status: SimulatorRobotStatus;
  point: Point;
  headingRad: number;
  blockedByRobotId: string | null;
  waitReason: SimulatorWaitReason | null;
  waitingForLabel: string | null;
  currentMissionName: string | null;
  currentNodeId: string;
  targetNodeId: string | null;
  progress: number;
  totalDistanceM: number;
  completedMissionCount: number;
  pathPoints: Point[];
};

export type SimulatorPendingMissionSnapshot = {
  id: string;
  name: string;
  waitMs: number;
  stopNames: string[];
};

export type SimulationSnapshot = {
  currentTimeMs: number;
  robots: SimulatorRobotSnapshot[];
  recentEvents: SimulationEvent[];
  pendingMissionCount: number;
  maxPendingMissionCount: number;
  droppedMissionCount: number;
  oldestPendingWaitMs: number | null;
  pendingMissions: SimulatorPendingMissionSnapshot[];
  activeMissionCount: number;
  completedMissionCount: number;
  totalEventCount: number;
  totalMissionCount: number;
  nextEventTimeMs: number | null;
};

export type SimulatorFleetConfig = {
  robotCount: number;
  robotSpeedMps: number;
  seed: number;
};

export type SimulatorScenarioDocument = {
  kind: "fms_roi_simulator_scenario";
  version: 1;
  savedAt: string;
  topology: {
    mapImage: string;
    nodeCount: number;
    edgeCount: number;
  };
  fleet: SimulatorFleetConfig;
  missions: SimulatorMissionDraft[];
};
