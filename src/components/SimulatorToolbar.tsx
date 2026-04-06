import type { SimulatorSpeed } from "../simulator/types";

export type SimulatorToolbarProps = {
  mapLabel: string | null;
  nodeCount: number;
  edgeCount: number;
  paused: boolean;
  speed: SimulatorSpeed;
  simTimeLabel: string;
  activeRobotCount: number;
  pendingMissionCount: number;
  canPlay: boolean;
  hasStarted: boolean;
  showNodeLabels: boolean;
  showEdgeLabels: boolean;
  onPlay: () => void;
  onPause: () => void;
  onReset: () => void;
  onSetSpeed: (speed: SimulatorSpeed) => void;
  onToggleNodeLabels: () => void;
  onToggleEdgeLabels: () => void;
  onBackToEditor: () => void;
};

export function SimulatorToolbar(props: SimulatorToolbarProps) {
  return (
    <header className="toolbar">
      <div className="toolbar-section toolbar-brand">
        <div className="toolbar-title">
          <span className="toolbar-product">FMS ROI</span>
          <strong>Fleet Simulator</strong>
        </div>
        <div className="toolbar-meta">
          <span>{props.nodeCount} nodes</span>
          <span>{props.edgeCount} edges</span>
          <span>{props.mapLabel ?? "Grid mode"}</span>
          <span>{props.simTimeLabel}</span>
        </div>
      </div>

      <div className="toolbar-section">
        <span className="toolbar-label">Mode</span>
        <div className="toolbar-actions">
          <button type="button" className="ghost-button" onClick={props.onBackToEditor}>
            Back To Editor
          </button>
        </div>
      </div>

      <div className="toolbar-section">
        <span className="toolbar-label">Run</span>
        <div className="toolbar-actions">
          <button type="button" className="ghost-button" onClick={props.onPlay} disabled={!props.canPlay || !props.paused}>
            {props.hasStarted ? "Resume" : "Start Simulation"}
          </button>
          <button type="button" className="ghost-button" onClick={props.onPause} disabled={props.paused}>
            Pause
          </button>
          <button type="button" className="ghost-button" onClick={props.onReset}>
            Reset
          </button>
        </div>
      </div>

      <div className="toolbar-section">
        <span className="toolbar-label">Speed</span>
        <div className="toolbar-actions">
          <button
            type="button"
            className={`edge-toggle ${props.speed === 1 ? "is-active" : ""}`}
            onClick={() => props.onSetSpeed(1)}
          >
            1x
          </button>
          <button
            type="button"
            className={`edge-toggle ${props.speed === 2 ? "is-active" : ""}`}
            onClick={() => props.onSetSpeed(2)}
          >
            2x
          </button>
          <button
            type="button"
            className={`edge-toggle ${props.speed === 4 ? "is-active" : ""}`}
            onClick={() => props.onSetSpeed(4)}
          >
            4x
          </button>
        </div>
      </div>

      <div className="toolbar-section">
        <span className="toolbar-label">View</span>
        <div className="toolbar-actions">
          <button
            type="button"
            className={`edge-toggle ${props.showNodeLabels ? "is-active" : ""}`}
            onClick={props.onToggleNodeLabels}
          >
            Node Names
          </button>
          <button
            type="button"
            className={`edge-toggle ${props.showEdgeLabels ? "is-active" : ""}`}
            onClick={props.onToggleEdgeLabels}
          >
            Edge Distance
          </button>
        </div>
        <div className="toolbar-meta">
          <span>{props.activeRobotCount} active robots</span>
          <span>{props.pendingMissionCount} pending</span>
        </div>
      </div>
    </header>
  );
}
