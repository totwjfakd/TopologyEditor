import type { TopologyNode } from "../types";
import type { SimulatorMissionDraft } from "./types";

export const DEFAULT_MISSION_CALLS_PER_HOUR = 5;

export function createDefaultMission(
  nodes: TopologyNode[],
  index: number,
): SimulatorMissionDraft {
  const firstNode = nodes[0];
  const secondNode = nodes[1] ?? nodes[0];

  return {
    id: `mission-${index}-${firstNode.id}-${secondNode.id}`,
    name: `Mission ${index}`,
    stops: [firstNode.id, secondNode.id],
    callsPerHour: DEFAULT_MISSION_CALLS_PER_HOUR,
  };
}

export function sanitizeMissionDraft(
  mission: SimulatorMissionDraft,
  nodes: TopologyNode[],
  index: number,
): SimulatorMissionDraft {
  const validIds = new Set(nodes.map((node) => node.id));
  const fallbackStops = [nodes[0].id, (nodes[1] ?? nodes[0]).id];
  const nextStops = mission.stops.filter((stopId) => validIds.has(stopId));

  return {
    ...mission,
    name: mission.name || `Mission ${index}`,
    stops: nextStops.length >= 2 ? nextStops : fallbackStops,
    callsPerHour: Number.isFinite(mission.callsPerHour)
      ? Math.max(0, Math.round(mission.callsPerHour * 10) / 10)
      : DEFAULT_MISSION_CALLS_PER_HOUR,
  };
}

export function clampMissionCalls(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return 0;
  }

  return Math.round(parsed * 10) / 10;
}
