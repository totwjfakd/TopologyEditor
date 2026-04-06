import { useEffect, useState } from "react";
import type { NodeType } from "../types";
import { NODE_TYPE_META, NODE_TYPE_ORDER } from "../types";

export type ToolbarProps = {
  nodeType: NodeType;
  edgeMode: boolean;
  resolution: number;
  showNodeLabels: boolean;
  showEdgeLabels: boolean;
  canOpenSimulator: boolean;
  canUndo: boolean;
  canRedo: boolean;
  nodeCount: number;
  edgeCount: number;
  mapLabel: string;
  onUploadMap: () => void;
  onLoadJson: () => void;
  onSaveJson: () => void;
  onOpenSimulator: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSetNodeType: (type: NodeType) => void;
  onToggleEdgeMode: () => void;
  onToggleNodeLabels: () => void;
  onToggleEdgeLabels: () => void;
  onCommitResolution: (value: number) => void;
};

export function Toolbar(props: ToolbarProps) {
  const [resolutionInput, setResolutionInput] = useState(String(props.resolution));
  const modeLabel = props.edgeMode ? "Edge" : NODE_TYPE_META[props.nodeType].shortLabel;

  useEffect(() => {
    setResolutionInput(String(props.resolution));
  }, [props.resolution]);

  return (
    <header className="toolbar">
      <div className="toolbar-section toolbar-brand">
        <div className="toolbar-title">
          <span className="toolbar-product">FMS ROI</span>
          <strong>Topology Editor</strong>
        </div>
        <div className="toolbar-meta">
          <span>{props.nodeCount} nodes</span>
          <span>{props.edgeCount} edges</span>
          <span>{props.mapLabel || "Grid"}</span>
          <span>{modeLabel}</span>
        </div>
      </div>

      <div className="toolbar-section">
        <span className="toolbar-label">Files</span>
        <div className="toolbar-actions">
          <button type="button" className="ghost-button" onClick={props.onUploadMap}>
            Map
          </button>
          <button type="button" className="ghost-button" onClick={props.onLoadJson}>
            Load
          </button>
          <button type="button" className="ghost-button" onClick={props.onSaveJson}>
            Save
          </button>
          <button
            type="button"
            className="ghost-button"
            onClick={props.onOpenSimulator}
            disabled={!props.canOpenSimulator}
          >
            Simulator
          </button>
        </div>
      </div>

      <div className="toolbar-section">
        <span className="toolbar-label">History</span>
        <div className="toolbar-actions">
          <button type="button" className="ghost-button" onClick={props.onUndo} disabled={!props.canUndo}>
            Undo
          </button>
          <button type="button" className="ghost-button" onClick={props.onRedo} disabled={!props.canRedo}>
            Redo
          </button>
        </div>
      </div>

      <div className="toolbar-section toolbar-section-tools">
        <span className="toolbar-label">Tools</span>
        <div className="toolbar-actions">
          {NODE_TYPE_ORDER.map((type) => {
            const meta = NODE_TYPE_META[type];
            return (
              <button
                key={type}
                type="button"
                className={`type-button ${props.nodeType === type ? "is-active" : ""}`}
                onClick={() => props.onSetNodeType(type)}
                style={{ ["--type-color" as string]: meta.color }}
              >
                <span>{meta.label}</span>
                <kbd>{meta.key}</kbd>
              </button>
            );
          })}
          <button
            type="button"
            className={`edge-toggle ${props.edgeMode ? "is-active" : ""}`}
            onClick={props.onToggleEdgeMode}
          >
            Edge <kbd>E</kbd>
          </button>
          <button
            type="button"
            className={`edge-toggle ${props.showNodeLabels ? "is-active" : ""}`}
            aria-pressed={props.showNodeLabels}
            onClick={props.onToggleNodeLabels}
          >
            Node Names
          </button>
          <button
            type="button"
            className={`edge-toggle ${props.showEdgeLabels ? "is-active" : ""}`}
            aria-pressed={props.showEdgeLabels}
            onClick={props.onToggleEdgeLabels}
          >
            Edge Distance
          </button>
        </div>
      </div>

      <div className="toolbar-section toolbar-section-scale">
        <span className="toolbar-label">Scale</span>
        <label className="toolbar-scale-field">
          <span>Resolution</span>
          <input
            value={resolutionInput}
            onChange={(event) => setResolutionInput(event.target.value)}
            onBlur={() => props.onCommitResolution(Number(resolutionInput))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                props.onCommitResolution(Number(resolutionInput));
              }
            }}
          />
          <em>m/px</em>
        </label>
      </div>
    </header>
  );
}
