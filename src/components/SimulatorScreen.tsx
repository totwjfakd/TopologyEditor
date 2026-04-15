import { useRef, type ChangeEvent } from "react";
import type { MapRaster } from "../types";
import { useEditorStore } from "../store/editorStore";
import { mapMatchesDocument } from "../utils/editorDocument";
import type { SimulatorSpeed } from "../simulator/types";
import {
  createSimulatorScenarioDocument,
  parseSimulatorScenario,
} from "../simulator/scenarioFile";
import { useSimulatorController } from "../simulator/useSimulatorController";
import { SimulatorToolbar } from "./SimulatorToolbar";
import { SimulatorWorkspace } from "./SimulatorWorkspace";

export type SimulatorScreenProps = {
  mapRaster: MapRaster | null;
  showNodeLabels: boolean;
  showEdgeLabels: boolean;
  onToggleNodeLabels: () => void;
  onToggleEdgeLabels: () => void;
  onBackToEditor: () => void;
  onShowInfo: (text: string) => void;
  onShowError: (text: string) => void;
};

export function SimulatorScreen(props: SimulatorScreenProps) {
  const scenarioInputRef = useRef<HTMLInputElement>(null);
  const topologyDocument = useEditorStore((state) => state.document);
  const controller = useSimulatorController(topologyDocument);
  const mapLabel = props.mapRaster && mapMatchesDocument(topologyDocument, props.mapRaster)
    ? props.mapRaster.name
    : topologyDocument.map.image || null;

  async function handleScenarioLoad(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const loaded = parseSimulatorScenario(parsed, controller.destinationNodes);
      controller.replaceScenario({
        fleet: loaded.fleet,
        missions: loaded.missions,
      });
      props.onShowInfo(
        loaded.adjustedMissionCount > 0
          ? `시뮬레이터 시나리오를 불러왔습니다. ${loaded.adjustedMissionCount}개 mission이 현재 topology 기준으로 조정되었습니다.`
          : "시뮬레이터 시나리오를 불러왔습니다.",
      );
    } catch (error) {
      props.onShowError(
        error instanceof Error ? error.message : "시뮬레이터 시나리오를 불러오지 못했습니다.",
      );
    } finally {
      event.target.value = "";
    }
  }

  function handleScenarioSave() {
    try {
      const scenarioDocument = createSimulatorScenarioDocument(
        topologyDocument,
        controller.missions,
        controller.fleet,
      );
      const blob = new Blob([JSON.stringify(scenarioDocument, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `simulator-scenario-${formatDateStamp()}.json`;
      document.body.append(anchor);
      anchor.click();
      URL.revokeObjectURL(url);
      anchor.remove();
      props.onShowInfo("시뮬레이터 시나리오 JSON을 다운로드했습니다.");
    } catch (error) {
      props.onShowError(
        error instanceof Error ? error.message : "시뮬레이터 시나리오를 저장하지 못했습니다.",
      );
    }
  }

  return (
    <>
      <input
        ref={scenarioInputRef}
        hidden
        type="file"
        accept="application/json,.json"
        onChange={handleScenarioLoad}
      />

      <SimulatorToolbar
        mapLabel={mapLabel}
        nodeCount={topologyDocument.nodes.length}
        edgeCount={topologyDocument.edges.length}
        paused={controller.paused}
        speed={controller.speed}
        simTimeLabel={formatSimulationTime(controller.snapshot.currentTimeMs)}
        activeRobotCount={controller.snapshot.robots.filter((robot) => robot.status !== "idle").length}
        pendingMissionCount={controller.snapshot.pendingMissionCount}
        canPlay={controller.canRun}
        hasStarted={controller.snapshot.currentTimeMs > 0 || controller.snapshot.totalEventCount > 0}
        showNodeLabels={props.showNodeLabels}
        showEdgeLabels={props.showEdgeLabels}
        onLoadScenario={() => scenarioInputRef.current?.click()}
        onSaveScenario={handleScenarioSave}
        onPlay={controller.play}
        onPause={controller.pause}
        onReset={controller.reset}
        onSetSpeed={(speed: SimulatorSpeed) => controller.setSpeed(speed)}
        onToggleNodeLabels={props.onToggleNodeLabels}
        onToggleEdgeLabels={props.onToggleEdgeLabels}
        onBackToEditor={props.onBackToEditor}
      />

      <div className="workspace">
        <SimulatorWorkspace
          document={topologyDocument}
          mapRaster={props.mapRaster}
          showNodeLabels={props.showNodeLabels}
          showEdgeLabels={props.showEdgeLabels}
          destinationNodes={controller.destinationNodes}
          destinationNodeMap={controller.destinationNodeMap}
          missions={controller.missions}
          compiledMissionSummaries={controller.compiledMissionSummaries}
          customRateMissionId={controller.customRateMissionId}
          fleet={controller.fleet}
          snapshot={controller.snapshot}
          timelineMaxMs={controller.timelineMaxMs}
          onAddMission={controller.addMission}
          onRemoveMission={controller.removeMission}
          onSetCustomRateMissionId={controller.setCustomRateMissionId}
          onUpdateMission={controller.updateMission}
          onRobotCountChange={controller.setRobotCount}
          onRobotSpeedChange={controller.setRobotSpeed}
          onSeedChange={controller.setSeed}
          onSeekTime={controller.seekToTime}
          clampMissionCalls={controller.clampMissionCalls}
        />
      </div>
    </>
  );
}

function formatSimulationTime(timeMs: number) {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
}

function formatDateStamp() {
  return new Date().toISOString().replace(/:/g, "-");
}
