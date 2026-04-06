import type { MapRaster } from "../types";
import { useEditorStore } from "../store/editorStore";
import { mapMatchesDocument } from "../utils/editorDocument";
import type { SimulatorSpeed } from "../simulator/types";
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
};

export function SimulatorScreen(props: SimulatorScreenProps) {
  const document = useEditorStore((state) => state.document);
  const controller = useSimulatorController(document);
  const mapLabel = props.mapRaster && mapMatchesDocument(document, props.mapRaster)
    ? props.mapRaster.name
    : document.map.image || null;

  return (
    <>
      <SimulatorToolbar
        mapLabel={mapLabel}
        nodeCount={document.nodes.length}
        edgeCount={document.edges.length}
        paused={controller.paused}
        speed={controller.speed}
        simTimeLabel={formatSimulationTime(controller.snapshot.currentTimeMs)}
        activeRobotCount={controller.snapshot.robots.filter((robot) => robot.status !== "idle").length}
        pendingMissionCount={controller.snapshot.pendingMissionCount}
        canPlay={controller.canRun}
        hasStarted={controller.snapshot.currentTimeMs > 0 || controller.snapshot.totalEventCount > 0}
        showNodeLabels={props.showNodeLabels}
        showEdgeLabels={props.showEdgeLabels}
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
          document={document}
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
