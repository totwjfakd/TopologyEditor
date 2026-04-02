import type { ContextMenuState, NodeType, TopologyDocument } from "../types";
import { NODE_TYPE_META, NODE_TYPE_ORDER } from "../types";

export type ContextMenuViewProps = {
  menu: ContextMenuState;
  document: TopologyDocument;
  canPaste: boolean;
  selectionCount: number;
  onClose: () => void;
  onCreateNode: (type: NodeType, world: { x: number; y: number }) => void;
  onPaste: () => void;
  onEditNode: (nodeId: string) => void;
  onChangeNodeType: (nodeId: string, type: NodeType) => void;
  onCopy: () => void;
  onDelete: () => void;
  onToggleEdgeDirection: (edgeId: string) => void;
};

export function ContextMenuView(props: ContextMenuViewProps) {
  const menuStyle = {
    left: props.menu.x,
    top: props.menu.y,
  };

  const target = props.menu.target;
  const targetNode =
    target.kind === "node"
      ? props.document.nodes.find((node) => node.id === target.nodeId) ?? null
      : null;
  const targetEdge =
    target.kind === "edge"
      ? props.document.edges.find((edge) => edge.id === target.edgeId) ?? null
      : null;
  const deleteLabel = props.selectionCount > 1 ? "Delete Selection" : "Delete";

  return (
    <div className="context-menu" style={menuStyle} onPointerDown={(event) => event.stopPropagation()}>
      {target.kind === "canvas" ? (
        <>
          <div className="context-menu-title">Create Node</div>
          {NODE_TYPE_ORDER.map((type) => (
            <button key={type} type="button" onClick={() => props.onCreateNode(type, target.world)}>
              {NODE_TYPE_META[type].label}
            </button>
          ))}
          <button type="button" onClick={props.onPaste} disabled={!props.canPaste}>
            Paste
          </button>
        </>
      ) : null}

      {targetNode ? (
        <>
          <div className="context-menu-title">{targetNode.name}</div>
          <button type="button" onClick={() => props.onEditNode(targetNode.id)}>
            Edit Properties
          </button>
          {NODE_TYPE_ORDER.map((type) => (
            <button key={type} type="button" onClick={() => props.onChangeNodeType(targetNode.id, type)}>
              Change to {NODE_TYPE_META[type].label}
            </button>
          ))}
          <button type="button" onClick={props.onCopy}>
            Copy
          </button>
          <button type="button" className="danger" onClick={props.onDelete}>
            {deleteLabel}
          </button>
        </>
      ) : null}

      {targetEdge ? (
        <>
          <div className="context-menu-title">Edge</div>
          <button type="button" onClick={() => props.onToggleEdgeDirection(targetEdge.id)}>
            Toggle Direction
          </button>
          <button type="button" className="danger" onClick={props.onDelete}>
            {deleteLabel}
          </button>
        </>
      ) : null}

      <button type="button" className="menu-dismiss" onClick={props.onClose}>
        Close
      </button>
    </div>
  );
}
