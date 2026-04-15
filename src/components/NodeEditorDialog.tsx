import { useEffect, useState } from "react";
import type { NodeType, TopologyNode } from "../types";
import { NODE_TYPE_META, NODE_TYPE_ORDER, nodeSupportsHeading } from "../types";

export type NodeEditorDialogProps = {
  node: TopologyNode;
  onClose: () => void;
  onSave: (name: string, type: NodeType, headingRad: number | null) => void;
};

export function NodeEditorDialog(props: NodeEditorDialogProps) {
  const [name, setName] = useState(props.node.name);
  const [type, setType] = useState<NodeType>(props.node.type);
  const [headingInput, setHeadingInput] = useState(
    typeof props.node.headingRad === "number" ? String(props.node.headingRad) : "",
  );

  useEffect(() => {
    setName(props.node.name);
    setType(props.node.type);
    setHeadingInput(typeof props.node.headingRad === "number" ? String(props.node.headingRad) : "");
  }, [props.node]);

  return (
    <div className="dialog-backdrop" onPointerDown={props.onClose}>
      <div className="dialog" onPointerDown={(event) => event.stopPropagation()}>
        <div className="dialog-header">
          <div>
            <h2>Node Properties</h2>
            <p>{NODE_TYPE_META[props.node.type].label}</p>
          </div>
          <button type="button" className="ghost-button" onClick={props.onClose}>
            Close
          </button>
        </div>
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
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
        {nodeSupportsHeading(type) ? (
          <label>
            <span>Direction (rad)</span>
            <div className="inline-input-with-suffix">
              <input
                type="number"
                step="0.01"
                value={headingInput}
                placeholder="Not set"
                onChange={(event) => setHeadingInput(event.target.value)}
              />
              <em>rad</em>
            </div>
          </label>
        ) : null}
        <div className="metric-row">
          <span>X {props.node.x.toFixed(2)} m</span>
          <span>Y {props.node.y.toFixed(2)} m</span>
          {nodeSupportsHeading(type) ? (
            <span>
              Direction {headingInput.trim() ? `${Number(headingInput).toFixed(2)} rad` : "unset"}
            </span>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button
            type="button"
            className="ghost-button"
            onClick={() => props.onSave(name, type, headingInput.trim() ? Number(headingInput) : null)}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
