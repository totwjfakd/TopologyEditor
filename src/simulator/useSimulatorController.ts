import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { TopologyDocument } from "../types";
import {
  clampMissionCalls,
  createDefaultMission,
  sanitizeMissionDraft,
} from "./missionDrafts";
import {
  buildSimulationSnapshot,
  createSimulationEngine,
  type SimulationEngine,
  advanceSimulation,
} from "./engine";
import type {
  SimulationSnapshot,
  SimulatorFleetConfig,
  SimulatorMissionDraft,
  SimulatorSpeed,
} from "./types";

const DEFAULT_FLEET: SimulatorFleetConfig = {
  robotCount: 3,
  robotSpeedMps: 1,
  seed: 7,
};

export function useSimulatorController(document: TopologyDocument) {
  const destinationNodes = useMemo(
    () => document.nodes.filter((node) => node.type === "destination"),
    [document.nodes],
  );
  const destinationNodeMap = useMemo(
    () => new Map(destinationNodes.map((node) => [node.id, node])),
    [destinationNodes],
  );

  const [missions, setMissions] = useState<SimulatorMissionDraft[]>([]);
  const [customRateMissionId, setCustomRateMissionId] = useState<string | null>(null);
  const [fleet, setFleet] = useState<SimulatorFleetConfig>(DEFAULT_FLEET);
  const [paused, setPaused] = useState(true);
  const [speed, setSpeed] = useState<SimulatorSpeed>(1);
  const [snapshot, setSnapshot] = useState<SimulationSnapshot>(() =>
    buildSimulationSnapshot(createSimulationEngine(document, [], DEFAULT_FLEET)),
  );

  const engineRef = useRef<SimulationEngine | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);

  useEffect(() => {
    if (destinationNodes.length < 2) {
      setMissions([]);
      setCustomRateMissionId(null);
      return;
    }

    setMissions((current) => {
      if (current.length === 0) {
        return [createDefaultMission(destinationNodes, 1)];
      }

      return current.map((mission, index) =>
        sanitizeMissionDraft(mission, destinationNodes, index + 1),
      );
    });
  }, [destinationNodes]);

  const rebuildEngine = useCallback(() => {
    const nextEngine = createSimulationEngine(document, missions, fleet);
    engineRef.current = nextEngine;
    lastFrameAtRef.current = null;
    setSnapshot(buildSimulationSnapshot(nextEngine));
    setPaused(true);
  }, [document, fleet, missions]);

  const seekToTime = useCallback((targetTimeMs: number) => {
    const nextEngine = createSimulationEngine(document, missions, fleet);
    const safeTarget = Math.max(0, Math.round(targetTimeMs));
    advanceSimulation(nextEngine, safeTarget, fleet);
    engineRef.current = nextEngine;
    lastFrameAtRef.current = null;
    setSnapshot(buildSimulationSnapshot(nextEngine));
  }, [document, fleet, missions]);

  useEffect(() => {
    rebuildEngine();
  }, [rebuildEngine]);

  useEffect(() => {
    if (paused) {
      lastFrameAtRef.current = null;
      return;
    }

    let frameId = 0;
    const tick = (frameTime: number) => {
      const runtime = engineRef.current;
      if (!runtime) {
        return;
      }

      if (lastFrameAtRef.current === null) {
        lastFrameAtRef.current = frameTime;
        frameId = window.requestAnimationFrame(tick);
        return;
      }

      const wallDeltaMs = Math.min(frameTime - lastFrameAtRef.current, 250);
      lastFrameAtRef.current = frameTime;
      advanceSimulation(runtime, runtime.timeMs + wallDeltaMs * speed, fleet);
      setSnapshot(buildSimulationSnapshot(runtime));
      frameId = window.requestAnimationFrame(tick);
    };

    frameId = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frameId);
  }, [fleet, paused, speed]);

  const compiledMissionSummaries = engineRef.current?.compiledMissionSummaries ?? [];
  const canRun = (engineRef.current?.robots.length ?? 0) > 0 && (engineRef.current?.templates.length ?? 0) > 0;
  const timelineMaxMs = Math.max(
    30 * 60 * 1000,
    snapshot.currentTimeMs + 5 * 60 * 1000,
    (snapshot.nextEventTimeMs ?? 0) + 60 * 1000,
  );

  return {
    destinationNodes,
    destinationNodeMap,
    missions,
    customRateMissionId,
    setCustomRateMissionId,
    compiledMissionSummaries,
    fleet,
    paused,
    speed,
    snapshot,
    canRun,
    timelineMaxMs,
    setSpeed,
    play: () => {
      if (!canRun) {
        return;
      }
      setPaused(false);
    },
    pause: () => setPaused(true),
    reset: rebuildEngine,
    seekToTime,
    addMission: () => {
      if (destinationNodes.length < 2) {
        return;
      }

      setMissions((current) =>
        current.concat(createDefaultMission(destinationNodes, current.length + 1)),
      );
    },
    removeMission: (missionId: string) => {
      setMissions((current) => current.filter((mission) => mission.id !== missionId));
      setCustomRateMissionId((current) => (current === missionId ? null : current));
    },
    updateMission: (
      missionId: string,
      updater: (mission: SimulatorMissionDraft) => SimulatorMissionDraft,
    ) => {
      setMissions((current) =>
        current.map((mission) => (mission.id === missionId ? updater(mission) : mission)),
      );
    },
    setRobotCount: (value: string) => {
      const parsed = Number(value);
      setFleet((current) => ({
        ...current,
        robotCount: Number.isFinite(parsed)
          ? Math.max(0, Math.min(32, Math.trunc(parsed)))
          : current.robotCount,
      }));
    },
    setRobotSpeed: (value: string) => {
      const parsed = Number(value);
      setFleet((current) => ({
        ...current,
        robotSpeedMps: Number.isFinite(parsed)
          ? Math.max(0.1, Math.round(parsed * 10) / 10)
          : current.robotSpeedMps,
      }));
    },
    setSeed: (value: string) => {
      const parsed = Number(value);
      setFleet((current) => ({
        ...current,
        seed: Number.isFinite(parsed)
          ? Math.max(1, Math.trunc(parsed))
          : current.seed,
      }));
    },
    clampMissionCalls,
  };
}
