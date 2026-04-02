import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  ContextMenuState,
  MapRaster,
  Point,
  SelectionBox,
  TopologyDocument,
  TopologyEdge,
  TopologyNode,
  ViewState,
} from "../types";
import { NODE_TYPE_META } from "../types";
import { useEditorStore } from "../store/editorStore";
import {
  clampZoom,
  getNiceDistance,
  pointInBounds,
  screenDeltaToWorld,
  screenToWorld,
  selectionBoxToBounds,
  worldToScreen,
} from "../utils/geometry";
import {
  cloneDocument,
  getEdgeDistance,
  roundMeters,
} from "../utils/topology";
import { mapMatchesDocument } from "../utils/editorDocument";
import { getContextMenuSelection } from "./canvasSelection";

type DragState =
  | {
      kind: "pan";
      startScreen: Point;
      startView: ViewState;
    }
  | {
      kind: "move";
      startScreen: Point;
      startView: ViewState;
      startDocument: TopologyDocument;
      nodeIds: string[];
    }
  | {
      kind: "select";
      startScreen: Point;
      additive: boolean;
    }
  | {
      kind: "connect";
      fromId: string;
      currentWorld: Point;
    };

export type TopologyCanvasProps = {
  viewportRef: RefObject<HTMLDivElement>;
  mapRaster: MapRaster | null;
  spacePressed: boolean;
  onOpenNodeEditor: (nodeId: string) => void;
  onOpenContextMenu: (menu: ContextMenuState | null) => void;
};

export function TopologyCanvas(props: TopologyCanvasProps) {
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);

  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const view = useEditorStore((state) => state.view);
  const edgeMode = useEditorStore((state) => state.edgeMode);

  const patchView = useEditorStore((state) => state.patchView);
  const setSelection = useEditorStore((state) => state.setSelection);
  const clearSelection = useEditorStore((state) => state.clearSelection);
  const setMouseWorld = useEditorStore((state) => state.setMouseWorld);
  const createNodeAt = useEditorStore((state) => state.createNodeAt);
  const createEdge = useEditorStore((state) => state.createEdge);
  const replaceDocument = useEditorStore((state) => state.replaceDocument);
  const commitFrom = useEditorStore((state) => state.commitFrom);

  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [pendingEdgeFromId, setPendingEdgeFromId] = useState<string | null>(null);
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [hoveredEdgeId, setHoveredEdgeId] = useState<string | null>(null);
  const [cursorScreen, setCursorScreen] = useState<Point | null>(null);

  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const hoveredNodeIdRef = useRef<string | null>(null);
  const hoveredEdgeIdRef = useRef<string | null>(null);
  const pointerFrameRef = useRef<number | null>(null);
  const latestPointerScreenRef = useRef<Point | null>(null);

  const nodeMap = useMemo(
    () => new Map(document.nodes.map((node) => [node.id, node])),
    [document.nodes],
  );

  const documentRef = useRef(document);
  const selectionRef = useRef(selection);
  const viewRef = useRef(view);
  const edgeModeRef = useRef(edgeMode);

  useEffect(() => {
    documentRef.current = document;
    selectionRef.current = selection;
    viewRef.current = view;
    edgeModeRef.current = edgeMode;
  }, [document, selection, view, edgeMode]);

  useEffect(() => {
    hoveredNodeIdRef.current = hoveredNodeId;
    hoveredEdgeIdRef.current = hoveredEdgeId;
  }, [hoveredEdgeId, hoveredNodeId]);

  useEffect(() => {
    drawBackgroundCanvas(
      backgroundCanvasRef.current,
      props.viewportRef.current,
      view,
      document,
      props.mapRaster,
    );
  }, [
    document.map.image,
    document.map.origin[0],
    document.map.origin[1],
    document.map.origin[2],
    document.map.resolution,
    props.mapRaster,
    props.viewportRef,
    view,
  ]);

  useEffect(() => {
    const viewport = props.viewportRef.current;
    if (!viewport) {
      return;
    }

    let frameId: number | null = null;
    const redraw = () => {
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
      frameId = window.requestAnimationFrame(() => {
        frameId = null;
        drawBackgroundCanvas(
          backgroundCanvasRef.current,
          props.viewportRef.current,
          viewRef.current,
          documentRef.current,
          props.mapRaster,
        );
      });
    };

    const resizeObserver = new ResizeObserver(() => {
      redraw();
    });

    resizeObserver.observe(viewport);
    window.addEventListener("resize", redraw);

    return () => {
      resizeObserver.disconnect();
      window.removeEventListener("resize", redraw);
      if (frameId !== null) {
        window.cancelAnimationFrame(frameId);
      }
    };
  }, [props.mapRaster, props.viewportRef]);

  function applyPointerUpdate(screen: Point) {
    const drag = dragRef.current;
    const showCursor = Boolean(
      hoveredNodeIdRef.current || hoveredEdgeIdRef.current || drag?.kind === "connect",
    );

    setCursorScreen((current) => {
      const next = showCursor ? screen : null;
      if (!next && !current) {
        return current;
      }
      if (current && next && current.x === next.x && current.y === next.y) {
        return current;
      }
      return next;
    });

    setMouseWorld(screenToWorld(screen, viewRef.current));

    if (!drag) {
      return;
    }

    if (drag.kind === "pan") {
      patchView({
        ...drag.startView,
        panX: drag.startView.panX + (screen.x - drag.startScreen.x),
        panY: drag.startView.panY + (screen.y - drag.startScreen.y),
      });
      return;
    }

    if (drag.kind === "move") {
      const delta = screenDeltaToWorld(
        screen.x - drag.startScreen.x,
        screen.y - drag.startScreen.y,
        drag.startView,
      );
      const nextDocument = moveNodesInDocument(drag.startDocument, drag.nodeIds, delta);
      replaceDocument(nextDocument, {
        nodeIds: drag.nodeIds,
        edgeIds: [],
      });
      if (
        Math.abs(screen.x - drag.startScreen.x) > 2 ||
        Math.abs(screen.y - drag.startScreen.y) > 2
      ) {
        suppressClickRef.current = true;
      }
      return;
    }

    if (drag.kind === "select") {
      setSelectionBox({
        start: drag.startScreen,
        end: screen,
      });
      return;
    }

    if (drag.kind === "connect") {
      dragRef.current = {
        ...drag,
        currentWorld: screenToWorld(screen, viewRef.current),
      };
    }
  }

  function schedulePointerUpdate(screen: Point) {
    latestPointerScreenRef.current = screen;
    if (pointerFrameRef.current !== null) {
      return;
    }

    pointerFrameRef.current = window.requestAnimationFrame(() => {
      pointerFrameRef.current = null;
      const nextScreen = latestPointerScreenRef.current;
      latestPointerScreenRef.current = null;
      if (nextScreen) {
        applyPointerUpdate(nextScreen);
      }
    });
  }

  useEffect(() => {
    function handlePointerMove(event: PointerEvent) {
      if (!dragRef.current) {
        return;
      }

      const viewport = props.viewportRef.current;
      if (!viewport) {
        return;
      }

      schedulePointerUpdate(screenPointFromEvent(event, viewport));
    }

    function handlePointerUp(event: PointerEvent) {
      const viewport = props.viewportRef.current;
      if (!viewport) {
        dragRef.current = null;
        return;
      }

      const drag = dragRef.current;
      if (!drag) {
        return;
      }

      const screen = screenPointFromEvent(event, viewport);
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current);
        pointerFrameRef.current = null;
      }
      latestPointerScreenRef.current = null;
      applyPointerUpdate(screen);
      dragRef.current = null;

      if (drag.kind === "move") {
        const moved =
          Math.abs(screen.x - drag.startScreen.x) > 2 ||
          Math.abs(screen.y - drag.startScreen.y) > 2;
        if (moved) {
          commitFrom(drag.startDocument, useEditorStore.getState().document, {
            nodeIds: drag.nodeIds,
            edgeIds: [],
          });
        } else {
          replaceDocument(drag.startDocument, { nodeIds: drag.nodeIds, edgeIds: [] });
        }
        return;
      }

      if (drag.kind === "select") {
        setSelectionBox(null);
        const isClick =
          Math.abs(screen.x - drag.startScreen.x) < 3 &&
          Math.abs(screen.y - drag.startScreen.y) < 3;

        if (isClick) {
          if (!drag.additive) {
            clearSelection();
          }
          return;
        }

        const startWorld = screenToWorld(drag.startScreen, viewRef.current);
        const endWorld = screenToWorld(screen, viewRef.current);
        const bounds = selectionBoxToBounds({ start: startWorld, end: endWorld });
        const nodes = documentRef.current.nodes
          .filter((node) => pointInBounds(node, bounds))
          .map((node) => node.id);
        const nodeSet = new Set(nodes);
        const edges = documentRef.current.edges
          .filter((edge) => nodeSet.has(edge.from) && nodeSet.has(edge.to))
          .map((edge) => edge.id);

        if (drag.additive) {
          setSelection({
            nodeIds: dedupe(selectionRef.current.nodeIds.concat(nodes)),
            edgeIds: dedupe(selectionRef.current.edgeIds.concat(edges)),
          });
        } else {
          setSelection({ nodeIds: nodes, edgeIds: edges });
        }
        return;
      }

      if (drag.kind === "connect") {
        setPendingEdgeFromId(drag.fromId);
      }
    }

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
    return () => {
      if (pointerFrameRef.current !== null) {
        window.cancelAnimationFrame(pointerFrameRef.current);
      }
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };
  }, [
    clearSelection,
    commitFrom,
    props.viewportRef,
    replaceDocument,
    setMouseWorld,
    setSelection,
    patchView,
  ]);

  function handleCanvasPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    props.onOpenContextMenu(null);

    if (event.button === 1 || (event.button === 0 && props.spacePressed)) {
      dragRef.current = {
        kind: "pan",
        startScreen: getLocalPoint(event, props.viewportRef.current),
        startView: useEditorStore.getState().view,
      };
      return;
    }

    if (event.button !== 0) {
      return;
    }

    const screen = getLocalPoint(event, props.viewportRef.current);
    if (edgeModeRef.current) {
      setPendingEdgeFromId(null);
      return;
    }

    dragRef.current = {
      kind: "select",
      startScreen: screen,
      additive: event.shiftKey,
    };
    setSelectionBox({ start: screen, end: screen });
  }

  function handleCanvasDoubleClick(event: ReactPointerEvent<HTMLDivElement>) {
    if (edgeModeRef.current) {
      return;
    }

    const world = screenToWorld(getLocalPoint(event, props.viewportRef.current), viewRef.current);
    createNodeAt(world);
  }

  function handleCanvasContextMenu(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const viewport = props.viewportRef.current;
    if (!viewport) {
      return;
    }
    const local = screenPointFromMouse(event, viewport);
    props.onOpenContextMenu({
      x: local.x,
      y: local.y,
      target: {
        kind: "canvas",
        world: screenToWorld(local, viewRef.current),
      },
    });
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    event.preventDefault();
    const viewport = props.viewportRef.current;
    if (!viewport) {
      return;
    }

    const local = screenPointFromWheel(event, viewport);
    const world = screenToWorld(local, viewRef.current);
    const nextZoom = clampZoom(viewRef.current.zoom * (event.deltaY < 0 ? 1.12 : 0.9));
    patchView({
      zoom: nextZoom,
      panX: local.x - world.x * nextZoom,
      panY: local.y + world.y * nextZoom,
    });
  }

  function handleNodePointerDown(event: ReactPointerEvent<SVGGElement>, nodeId: string) {
    event.stopPropagation();
    props.onOpenContextMenu(null);

    const local = getLocalPoint(event, props.viewportRef.current);

    if (edgeModeRef.current) {
      if (event.button !== 0) {
        return;
      }
      dragRef.current = {
        kind: "connect",
        fromId: nodeId,
        currentWorld: screenToWorld(local, viewRef.current),
      };
      setPendingEdgeFromId(nodeId);
      return;
    }

    if (event.button !== 0 || event.shiftKey || props.spacePressed) {
      return;
    }

    const currentSelection = selectionRef.current;
    const isSelected = currentSelection.nodeIds.includes(nodeId);
    const nodeIds = isSelected ? currentSelection.nodeIds : [nodeId];
    setSelection({ nodeIds, edgeIds: [] });

    dragRef.current = {
      kind: "move",
      startScreen: local,
      startView: viewRef.current,
      startDocument: cloneDocument(documentRef.current),
      nodeIds,
    };
  }

  function handleNodePointerUp(event: ReactPointerEvent<SVGGElement>, nodeId: string) {
    if (!edgeModeRef.current) {
      return;
    }

    event.stopPropagation();
    const drag = dragRef.current;
    if (drag?.kind === "connect" && drag.fromId !== nodeId) {
      createEdge(drag.fromId, nodeId);
      dragRef.current = null;
      suppressClickRef.current = true;
      setPendingEdgeFromId(null);
    }
  }

  function handleNodeClick(event: ReactMouseEvent<SVGGElement>, nodeId: string) {
    event.stopPropagation();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    if (edgeModeRef.current) {
      if (pendingEdgeFromId && pendingEdgeFromId !== nodeId) {
        createEdge(pendingEdgeFromId, nodeId);
        setPendingEdgeFromId(null);
      } else {
        setPendingEdgeFromId(nodeId);
      }
      setSelection({ nodeIds: [nodeId], edgeIds: [] });
      return;
    }

    if (event.shiftKey) {
      const current = selectionRef.current;
      const exists = current.nodeIds.includes(nodeId);
      setSelection({
        nodeIds: exists
          ? current.nodeIds.filter((id) => id !== nodeId)
          : current.nodeIds.concat(nodeId),
        edgeIds: current.edgeIds,
      });
      return;
    }

    setSelection({ nodeIds: [nodeId], edgeIds: [] });
  }

  function handleNodeContextMenu(event: ReactMouseEvent<SVGGElement>, node: TopologyNode) {
    event.preventDefault();
    event.stopPropagation();
    setSelection(getContextMenuSelection(selectionRef.current, { kind: "node", id: node.id }));
    props.onOpenContextMenu({
      x: event.nativeEvent.offsetX,
      y: event.nativeEvent.offsetY,
      target: {
        kind: "node",
        nodeId: node.id,
        world: { x: node.x, y: node.y },
      },
    });
  }

  function handleEdgeClick(event: ReactMouseEvent<SVGLineElement>, edgeId: string) {
    event.stopPropagation();
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }

    if (event.shiftKey) {
      const current = selectionRef.current;
      const exists = current.edgeIds.includes(edgeId);
      setSelection({
        nodeIds: current.nodeIds,
        edgeIds: exists
          ? current.edgeIds.filter((id) => id !== edgeId)
          : current.edgeIds.concat(edgeId),
      });
      return;
    }

    setSelection({ nodeIds: [], edgeIds: [edgeId] });
  }

  function handleEdgeContextMenu(event: ReactMouseEvent<SVGLineElement>, edge: TopologyEdge) {
    event.preventDefault();
    event.stopPropagation();
    setSelection(getContextMenuSelection(selectionRef.current, { kind: "edge", id: edge.id }));
    const from = nodeMap.get(edge.from);
    const to = nodeMap.get(edge.to);
    const world = from && to ? { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 } : { x: 0, y: 0 };
    props.onOpenContextMenu({
      x: event.nativeEvent.offsetX,
      y: event.nativeEvent.offsetY,
      target: {
        kind: "edge",
        edgeId: edge.id,
        world,
      },
    });
  }

  return (
    <div
      ref={props.viewportRef}
      className={`canvas-shell ${edgeMode ? "is-edge-mode" : ""}`}
      onPointerDown={handleCanvasPointerDown}
      onDoubleClick={handleCanvasDoubleClick}
      onContextMenu={handleCanvasContextMenu}
      onWheel={handleWheel}
      onPointerMove={(event) => {
        schedulePointerUpdate(getLocalPoint(event, props.viewportRef.current));
      }}
    >
      <canvas ref={backgroundCanvasRef} className="background-canvas" />
      <svg className="overlay" width="100%" height="100%">
        <defs>
          <marker id="arrow-end" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 12 6 L 0 12 z" fill="#cbd5e1" />
          </marker>
          <marker id="arrow-selected" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 12 6 L 0 12 z" fill="#60a5fa" />
          </marker>
        </defs>

        {document.edges.map((edge) => {
          const from = nodeMap.get(edge.from);
          const to = nodeMap.get(edge.to);
          if (!from || !to) {
            return null;
          }
          const fromScreen = worldToScreen(from, view);
          const toScreen = worldToScreen(to, view);
          const selected = selection.edgeIds.includes(edge.id);
          const markerId = selected ? "url(#arrow-selected)" : "url(#arrow-end)";
          const midX = (fromScreen.x + toScreen.x) / 2;
          const midY = (fromScreen.y + toScreen.y) / 2;

          return (
            <g key={edge.id}>
              <line
                x1={fromScreen.x}
                y1={fromScreen.y}
                x2={toScreen.x}
                y2={toScreen.y}
                className={`edge-line ${selected ? "is-selected" : ""}`}
                markerEnd={markerId}
                markerStart={edge.direction === "bidirectional" ? markerId : undefined}
              />
              <line
                x1={fromScreen.x}
                y1={fromScreen.y}
                x2={toScreen.x}
                y2={toScreen.y}
                className="edge-hit"
                onClick={(event) => handleEdgeClick(event, edge.id)}
                onContextMenu={(event) => handleEdgeContextMenu(event, edge)}
                onMouseEnter={() => setHoveredEdgeId(edge.id)}
                onMouseLeave={() => setHoveredEdgeId((current) => (current === edge.id ? null : current))}
              />
              {view.showEdgeLabels ? (
                <>
                  <rect x={midX - 28} y={midY - 12} width="56" height="20" rx="5" className="edge-label-bg" />
                  <text x={midX} y={midY + 3} textAnchor="middle" className="edge-label">
                    {edge.distance_m.toFixed(2)}m
                  </text>
                </>
              ) : null}
            </g>
          );
        })}

        {document.nodes.map((node) => {
          const point = worldToScreen(node, view);
          const selected = selection.nodeIds.includes(node.id);
          const pending = pendingEdgeFromId === node.id;
          const color = NODE_TYPE_META[node.type].color;

          return (
            <g
              key={node.id}
              transform={`translate(${point.x} ${point.y})`}
              onPointerDown={(event) => handleNodePointerDown(event, node.id)}
              onPointerUp={(event) => handleNodePointerUp(event, node.id)}
              onClick={(event) => handleNodeClick(event, node.id)}
              onDoubleClick={(event) => {
                event.stopPropagation();
                props.onOpenNodeEditor(node.id);
              }}
              onContextMenu={(event) => handleNodeContextMenu(event, node)}
              onMouseEnter={() => setHoveredNodeId(node.id)}
              onMouseLeave={() => setHoveredNodeId((current) => (current === node.id ? null : current))}
            >
              <circle r={selected || pending ? 17 : 14} className="node-ring" style={{ fill: `${color}20`, stroke: color }} />
              <circle r="9" className="node-core" style={{ fill: color }} />
              {view.showNodeLabels ? <text x="18" y="-16" className="node-tag">{node.name}</text> : null}
            </g>
          );
        })}

        {dragRef.current?.kind === "connect" ? (
          (() => {
            const from = nodeMap.get(dragRef.current.fromId);
            if (!from) {
              return null;
            }
            const fromScreen = worldToScreen(from, view);
            const toScreen = worldToScreen(dragRef.current.currentWorld, view);
            return (
              <line
                x1={fromScreen.x}
                y1={fromScreen.y}
                x2={toScreen.x}
                y2={toScreen.y}
                className="edge-preview"
              />
            );
          })()
        ) : null}

        {selectionBox ? (
          <rect
            x={Math.min(selectionBox.start.x, selectionBox.end.x)}
            y={Math.min(selectionBox.start.y, selectionBox.end.y)}
            width={Math.abs(selectionBox.end.x - selectionBox.start.x)}
            height={Math.abs(selectionBox.end.y - selectionBox.start.y)}
            className="selection-box"
          />
        ) : null}
      </svg>

      {hoveredNodeId && cursorScreen ? (
        <NodeTooltip
          node={nodeMap.get(hoveredNodeId) ?? null}
          position={cursorScreen}
        />
      ) : null}

      {hoveredEdgeId && !hoveredNodeId && cursorScreen ? (
        <div className="hover-chip" style={{ left: cursorScreen.x + 14, top: cursorScreen.y + 14 }}>
          <span className="hover-chip-label">Edge</span>
          <strong>{document.edges.find((edge) => edge.id === hoveredEdgeId)?.direction}</strong>
        </div>
      ) : null}

      <div className="canvas-hud">
        <strong>{edgeMode ? "Edge mode" : "Node mode"}</strong>
        <span>
          {edgeMode ? "Click A then B, or drag between nodes." : "Double click empty space to create a node."}
        </span>
      </div>
      <div className="canvas-hud secondary">
        <strong>{pendingEdgeFromId ? "Source locked" : "Selection"}</strong>
        <span>
          {pendingEdgeFromId
            ? "Choose a destination node to complete the edge."
            : "Drag to box-select. Shift-click adds or removes items."}
        </span>
      </div>
    </div>
  );
}

function moveNodesInDocument(
  document: TopologyDocument,
  nodeIds: string[],
  delta: Point,
): TopologyDocument {
  const movedIds = new Set(nodeIds);
  const nextNodes = document.nodes.map((node) =>
    movedIds.has(node.id)
      ? {
          ...node,
          x: roundMeters(node.x + delta.x),
          y: roundMeters(node.y + delta.y),
        }
      : node,
  );

  const nodeMap = new Map(nextNodes.map((node) => [node.id, node]));
  const nextEdges = document.edges
    .filter((edge) => nodeMap.has(edge.from) && nodeMap.has(edge.to))
    .map((edge) => {
      if (!movedIds.has(edge.from) && !movedIds.has(edge.to)) {
        return edge;
      }

      const fromNode = nodeMap.get(edge.from)!;
      const toNode = nodeMap.get(edge.to)!;
      const distance = getEdgeDistance(fromNode, toNode);

      return distance === edge.distance_m
        ? edge
        : {
            ...edge,
            distance_m: distance,
          };
    });

  return {
    map: document.map,
    nodes: nextNodes,
    edges: nextEdges,
  };
}

function NodeTooltip({ node, position }: { node: TopologyNode | null; position: Point }) {
  if (!node) {
    return null;
  }

  return (
    <div className="hover-chip" style={{ left: position.x + 14, top: position.y + 14 }}>
      <span className="hover-chip-label">Node</span>
      <strong>{node.name}</strong>
      <span>
        {node.x.toFixed(2)}, {node.y.toFixed(2)} m
      </span>
    </div>
  );
}

function drawBackgroundCanvas(
  canvas: HTMLCanvasElement | null,
  viewport: HTMLDivElement | null,
  view: ViewState,
  document: TopologyDocument,
  mapRaster: MapRaster | null,
) {
  if (!canvas || !viewport) {
    return;
  }

  const rect = viewport.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  canvas.style.width = `${rect.width}px`;
  canvas.style.height = `${rect.height}px`;

  const context = canvas.getContext("2d");
  if (!context) {
    return;
  }

  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  context.fillStyle = "#14181d";
  context.fillRect(0, 0, rect.width, rect.height);

  const topLeft = screenToWorld({ x: 0, y: 0 }, view);
  const bottomRight = screenToWorld({ x: rect.width, y: rect.height }, view);
  const visibleMinX = Math.min(topLeft.x, bottomRight.x);
  const visibleMaxX = Math.max(topLeft.x, bottomRight.x);
  const visibleMinY = Math.min(topLeft.y, bottomRight.y);
  const visibleMaxY = Math.max(topLeft.y, bottomRight.y);

  const minorStep = getNiceDistance(28 / view.zoom);
  const majorStep = minorStep * 5;

  context.lineWidth = 1;
  context.strokeStyle = "rgba(148, 163, 184, 0.08)";
  for (let x = Math.floor(visibleMinX / minorStep) * minorStep; x <= visibleMaxX; x += minorStep) {
    const screen = worldToScreen({ x, y: 0 }, view);
    context.beginPath();
    context.moveTo(screen.x, 0);
    context.lineTo(screen.x, rect.height);
    context.stroke();
  }
  for (let y = Math.floor(visibleMinY / minorStep) * minorStep; y <= visibleMaxY; y += minorStep) {
    const screen = worldToScreen({ x: 0, y }, view);
    context.beginPath();
    context.moveTo(0, screen.y);
    context.lineTo(rect.width, screen.y);
    context.stroke();
  }

  context.strokeStyle = "rgba(148, 163, 184, 0.18)";
  for (let x = Math.floor(visibleMinX / majorStep) * majorStep; x <= visibleMaxX; x += majorStep) {
    const screen = worldToScreen({ x, y: 0 }, view);
    context.beginPath();
    context.moveTo(screen.x, 0);
    context.lineTo(screen.x, rect.height);
    context.stroke();
  }
  for (let y = Math.floor(visibleMinY / majorStep) * majorStep; y <= visibleMaxY; y += majorStep) {
    const screen = worldToScreen({ x: 0, y }, view);
    context.beginPath();
    context.moveTo(0, screen.y);
    context.lineTo(rect.width, screen.y);
    context.stroke();
  }

  if (mapRaster && mapMatchesDocument(document, mapRaster)) {
    const worldWidth = mapRaster.width * document.map.resolution;
    const worldHeight = mapRaster.height * document.map.resolution;
    const topLeftScreen = worldToScreen(
      { x: document.map.origin[0], y: document.map.origin[1] + worldHeight },
      view,
    );

    context.imageSmoothingEnabled = false;
    context.save();
    context.globalAlpha = 0.92;
    context.drawImage(
      mapRaster.canvas,
      topLeftScreen.x,
      topLeftScreen.y,
      worldWidth * view.zoom,
      worldHeight * view.zoom,
    );
    context.restore();
  }
}

function screenPointFromEvent(event: PointerEvent, viewport: HTMLDivElement): Point {
  const rect = viewport.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function screenPointFromMouse(event: MouseEvent | ReactMouseEvent, viewport: HTMLDivElement): Point {
  const rect = viewport.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function screenPointFromWheel(event: ReactWheelEvent, viewport: HTMLDivElement): Point {
  const rect = viewport.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function getLocalPoint(
  event: ReactPointerEvent<Element> | PointerEvent,
  viewport: HTMLDivElement | null,
): Point {
  if (!viewport) {
    return { x: 0, y: 0 };
  }
  const rect = viewport.getBoundingClientRect();
  return {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top,
  };
}

function dedupe(values: string[]) {
  return Array.from(new Set(values));
}
