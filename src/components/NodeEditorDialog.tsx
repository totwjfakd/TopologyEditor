import { useEffect, useState } from "react";
import type { NodeType, TopologyNode } from "../types";
import { NODE_TYPE_META, NODE_TYPE_ORDER } from "../types";

export type NodeEditorDialogProps = {
  node: TopologyNode;
  onClose: () => void;
  onSave: (name: string, type: NodeType) => void;
};

export function NodeEditorDialog(props: NodeEditorDialogProps) {
  const [name, setName] = useState(props.node.name);
  const [type, setType] = useState<NodeType>(props.node.type);

  useEffect(() => {
    setName(props.node.name);
    setType(props.node.type);
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
        <div className="metric-row">
          <span>X {props.node.x.toFixed(2)} m</span>
          <span>Y {props.node.y.toFixed(2)} m</span>
        </div>
        <div className="dialog-actions">
          <button type="button" className="ghost-button" onClick={() => props.onSave(name, type)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
