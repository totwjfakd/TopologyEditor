import type { Point } from "../types";

export type StatusBarProps = {
  mouseWorld: Point;
  zoom: number;
  scaleDistance: number;
  scaleWidthPx: number;
  nodeCount: number;
  edgeCount: number;
  mapLabel: string | null;
};

export function StatusBar(props: StatusBarProps) {
  return (
    <footer className="statusbar">
      <div className="statusbar-group">
        <span className="status-chip">
          x {props.mouseWorld.x.toFixed(2)}m y {props.mouseWorld.y.toFixed(2)}m
        </span>
        <span className="status-chip">Zoom {Math.round((props.zoom / 24) * 100)}%</span>
        <span className="status-chip">
          {props.nodeCount} nodes / {props.edgeCount} edges
        </span>
        <span className="status-chip">{props.mapLabel ?? "Grid mode"}</span>
      </div>
      <div className="statusbar-scale">
        <span>{props.scaleDistance.toFixed(props.scaleDistance < 1 ? 2 : 0)} m</span>
        <div className="scale-bar" style={{ width: `${props.scaleWidthPx}px` }} />
      </div>
    </footer>
  );
}
