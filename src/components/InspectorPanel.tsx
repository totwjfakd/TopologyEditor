import { useEffect, useState } from "react";
import type {
  MapRaster,
  NodeType,
  SelectionState,
  TopologyDocument,
  TopologyEdge,
  TopologyNode,
} from "../types";
import { NODE_TYPE_META, NODE_TYPE_ORDER } from "../types";

export type InspectorProps = {
  document: TopologyDocument;
  selection: SelectionState;
  selectedNode: TopologyNode | null;
  selectedEdge: TopologyEdge | null;
  mapRaster: MapRaster | null;
  onUpdateNode: (nodeId: string, name: string, type: NodeType) => void;
  onOpenNodeEditor: () => void;
  onToggleEdgeDirection: (edgeId: string) => void;
  onDeleteSelection: () => void;
  onFitScene: () => void;
};

export function InspectorPanel(props: InspectorProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState<NodeType>("destination");
  const selectionCount = props.selection.nodeIds.length + props.selection.edgeIds.length;

  useEffect(() => {
    if (props.selectedNode) {
      setName(props.selectedNode.name);
      setType(props.selectedNode.type);
    }
  }, [props.selectedNode]);

  return (
    <aside className="sidebar">
      <section className="sidebar-panel">
        <div className="sidebar-header">
          <div>
            <h2>Scene</h2>
            <p>Current map and topology summary.</p>
          </div>
          <button type="button" className="ghost-button" onClick={props.onFitScene}>
            Fit
          </button>
        </div>
        <dl className="sidebar-list">
          <div>
            <dt>Map</dt>
            <dd>{props.mapRaster ? props.mapRaster.name : "Not loaded"}</dd>
          </div>
          <div>
            <dt>Origin</dt>
            <dd>
              {props.document.map.origin[0].toFixed(2)}, {props.document.map.origin[1].toFixed(2)}
            </dd>
          </div>
          <div>
            <dt>Resolution</dt>
            <dd>{props.document.map.resolution.toFixed(3)} m/px</dd>
          </div>
          <div>
            <dt>Objects</dt>
            <dd>
              {props.document.nodes.length} nodes / {props.document.edges.length} edges
            </dd>
          </div>
        </dl>
      </section>

      <section className="sidebar-panel">
        <div className="sidebar-header">
          <div>
            <h2>Selection</h2>
            <p>
              {selectionCount > 0
                ? `${selectionCount} item${selectionCount > 1 ? "s" : ""} selected`
                : "Nothing selected"}
            </p>
          </div>
          <button
            type="button"
            className="ghost-button danger"
            onClick={props.onDeleteSelection}
            disabled={selectionCount === 0}
          >
            Delete
          </button>
        </div>

        {props.selectedNode ? (
          <div className="sidebar-form">
            <div className="selection-badge" style={{ ["--selection-color" as string]: NODE_TYPE_META[props.selectedNode.type].color }}>
              <strong>{props.selectedNode.name}</strong>
              <span>{NODE_TYPE_META[props.selectedNode.type].label}</span>
            </div>
            <label>
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>Type</span>
              <select value={type} onChange={(event) => setType(event.target.value as NodeType)}>
                {NODE_TYPE_ORDER.map((nodeType) => (
                  <option key={nodeType} value={nodeType}>
                    {NODE_TYPE_META[nodeType].label}
                  </option>
                ))}
              </select>
            </label>
            <div className="metric-row">
              <span>X {props.selectedNode.x.toFixed(2)} m</span>
              <span>Y {props.selectedNode.y.toFixed(2)} m</span>
            </div>
            <div className="sidebar-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => props.onUpdateNode(props.selectedNode!.id, name, type)}
              >
                Apply
              </button>
              <button type="button" className="ghost-button" onClick={props.onOpenNodeEditor}>
                Dialog
              </button>
            </div>
          </div>
        ) : null}

        {props.selectedEdge ? (
          <div className="sidebar-form">
            <div className="selection-badge selection-badge-edge">
              <strong>{props.selectedEdge.distance_m.toFixed(2)} m</strong>
              <span>{props.selectedEdge.direction}</span>
            </div>
            <div className="metric-row">
              <span>From {props.selectedEdge.from}</span>
              <span>To {props.selectedEdge.to}</span>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => props.onToggleEdgeDirection(props.selectedEdge!.id)}
            >
              Toggle Direction
            </button>
          </div>
        ) : null}

        {!props.selectedNode && !props.selectedEdge ? (
          <div className="sidebar-empty">
            <p>Select a single node or edge to inspect and edit it here.</p>
          </div>
        ) : null}
      </section>
    </aside>
  );
}
