import type { Point } from "../types";

export type SimulatorSpeed = 1 | 2 | 4;

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

export type SimulatorRobotStatus =
  | "idle"
  | "moving_empty"
  | "moving_loaded"
  | "waiting_forward";

export type SimulatorMotion = {
  edgeId: string;
  fromNodeId: string;
  toNodeId: string;
  distanceM: number;
  loaded: boolean;
  startedAtMs: number;
  endsAtMs: number;
  blockedAtMs: number | null;
  blockedByRobotId: string | null;
};

export type SimulatorRobotState = {
  id: string;
  name: string;
  status: SimulatorRobotStatus;
  currentNodeId: string;
  currentMissionId: string | null;
  currentMissionName: string | null;
  completedMissionCount: number;
  totalDistanceM: number;
  routeSegments: SimulatorRouteSegment[];
  routeIndex: number;
  motion: SimulatorMotion | null;
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
  | "mission_assigned"
  | "edge_entered"
  | "node_arrived"
  | "mission_completed"
  | "robot_waiting"
  | "robot_resumed";

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
  currentMissionName: string | null;
  currentNodeId: string;
  targetNodeId: string | null;
  progress: number;
  totalDistanceM: number;
  completedMissionCount: number;
  pathPoints: Point[];
};

export type SimulationSnapshot = {
  currentTimeMs: number;
  robots: SimulatorRobotSnapshot[];
  recentEvents: SimulationEvent[];
  pendingMissionCount: number;
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
