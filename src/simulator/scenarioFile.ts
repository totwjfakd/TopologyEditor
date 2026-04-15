import type { TopologyDocument, TopologyNode } from "../types";
import {
  DEFAULT_MISSION_CALLS_PER_HOUR,
  sanitizeMissionDraft,
} from "./missionDrafts";
import type {
  SimulatorFleetConfig,
  SimulatorMissionDraft,
  SimulatorScenarioDocument,
} from "./types";

const SCENARIO_KIND = "fms_roi_simulator_scenario";
const SCENARIO_VERSION = 1;

export type LoadedSimulatorScenario = {
  fleet: SimulatorFleetConfig;
  missions: SimulatorMissionDraft[];
  adjustedMissionCount: number;
};

export function createSimulatorScenarioDocument(
  document: TopologyDocument,
  missions: SimulatorMissionDraft[],
  fleet: SimulatorFleetConfig,
): SimulatorScenarioDocument {
  return {
    kind: SCENARIO_KIND,
    version: SCENARIO_VERSION,
    savedAt: new Date().toISOString(),
    topology: {
      mapImage: document.map.image,
      nodeCount: document.nodes.length,
      edgeCount: document.edges.length,
    },
    fleet: {
      robotCount: Math.max(0, Math.min(32, Math.trunc(fleet.robotCount))),
      robotSpeedMps: Math.max(0.1, Math.round(fleet.robotSpeedMps * 10) / 10),
      seed: Math.max(1, Math.trunc(fleet.seed)),
    },
    missions: missions.map((mission) => ({
      id: mission.id,
      name: mission.name,
      stops: [...mission.stops],
      callsPerHour: mission.callsPerHour,
    })),
  };
}

export function parseSimulatorScenario(
  raw: unknown,
  destinationNodes: TopologyNode[],
): LoadedSimulatorScenario {
  const scenario = asRecord(raw, "시뮬레이터 시나리오 JSON 형식이 올바르지 않습니다.");
  if (scenario.kind !== SCENARIO_KIND || scenario.version !== SCENARIO_VERSION) {
    throw new Error("지원하지 않는 시뮬레이터 시나리오 파일입니다.");
  }

  const fleet = parseFleetConfig(scenario.fleet);
  const rawMissions = toMissionArray(scenario.missions);
  if (rawMissions.length > 0 && destinationNodes.length < 2) {
    throw new Error("현재 토폴로지에 Destination 노드가 두 개 이상 있어야 시나리오를 불러올 수 있습니다.");
  }

  const usedIds = new Set<string>();
  let adjustedMissionCount = 0;
  const missions = rawMissions.map((missionLike, index) => {
    const missionRecord = asRecord(missionLike, `mission ${index + 1} 형식이 올바르지 않습니다.`);
    const rawMission = {
      id: makeUniqueMissionId(
        usedIds,
        typeof missionRecord.id === "string" && missionRecord.id.trim()
          ? missionRecord.id.trim()
          : `scenario-mission-${index + 1}`,
      ),
      name:
        typeof missionRecord.name === "string" && missionRecord.name.trim()
          ? missionRecord.name.trim()
          : `Mission ${index + 1}`,
      stops: Array.isArray(missionRecord.stops)
        ? missionRecord.stops.filter((stopId): stopId is string => typeof stopId === "string")
        : [],
      callsPerHour: parseCallsPerHour(missionRecord.callsPerHour),
    } satisfies SimulatorMissionDraft;

    const sanitized = sanitizeMissionDraft(rawMission, destinationNodes, index + 1);
    if (
      sanitized.name !== rawMission.name ||
      sanitized.callsPerHour !== rawMission.callsPerHour ||
      sanitized.stops.length !== rawMission.stops.length ||
      sanitized.stops.some((stopId, stopIndex) => stopId !== rawMission.stops[stopIndex])
    ) {
      adjustedMissionCount += 1;
    }

    return sanitized;
  });

  return {
    fleet,
    missions,
    adjustedMissionCount,
  };
}

function parseFleetConfig(raw: unknown): SimulatorFleetConfig {
  const record = asRecord(raw, "시뮬레이터 fleet 설정 형식이 올바르지 않습니다.");
  const robotCount = typeof record.robotCount === "number" ? record.robotCount : Number(record.robotCount);
  const robotSpeedMps =
    typeof record.robotSpeedMps === "number" ? record.robotSpeedMps : Number(record.robotSpeedMps);
  const seed = typeof record.seed === "number" ? record.seed : Number(record.seed);

  return {
    robotCount: Number.isFinite(robotCount) ? Math.max(0, Math.min(32, Math.trunc(robotCount))) : 3,
    robotSpeedMps: Number.isFinite(robotSpeedMps)
      ? Math.max(0.1, Math.round(robotSpeedMps * 10) / 10)
      : 1,
    seed: Number.isFinite(seed) ? Math.max(1, Math.trunc(seed)) : 7,
  };
}

function parseCallsPerHour(raw: unknown) {
  const parsed = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_MISSION_CALLS_PER_HOUR;
  }

  return Math.max(0, Math.round(parsed * 10) / 10);
}

function makeUniqueMissionId(usedIds: Set<string>, baseId: string) {
  let candidate = baseId;
  let suffix = 2;

  while (usedIds.has(candidate)) {
    candidate = `${baseId}-${suffix}`;
    suffix += 1;
  }

  usedIds.add(candidate);
  return candidate;
}

function toMissionArray(raw: unknown) {
  if (!Array.isArray(raw)) {
    throw new Error("시뮬레이터 mission 목록 형식이 올바르지 않습니다.");
  }

  return raw;
}

function asRecord(raw: unknown, errorMessage: string): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(errorMessage);
  }

  return raw as Record<string, unknown>;
}
