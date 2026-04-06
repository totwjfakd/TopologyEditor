import { useEffect, useMemo, useRef, useState } from "react";
import type { EdgeDirection, MapRaster, Point, TopologyDocument, ViewState } from "../types";
import { NODE_TYPE_META } from "../types";
import { documentBounds, fitViewToBounds, worldToScreen } from "../utils/geometry";
import { drawTopologyBackgroundCanvas } from "../utils/topologyBackground";
import { mapMatchesDocument } from "../utils/editorDocument";
import { DEFAULT_VIEW_STATE } from "../utils/viewState";
import type { SimulatorRobotSnapshot } from "../simulator/types";

const ROBOT_COLORS = ["#22c55e", "#f97316", "#38bdf8", "#e879f9", "#facc15", "#fb7185"];

export type TopologyPreviewProps = {
  document: TopologyDocument;
  mapRaster: MapRaster | null;
  showNodeLabels?: boolean;
  showEdgeLabels?: boolean;
  robots?: SimulatorRobotSnapshot[];
};

export function TopologyPreview(props: TopologyPreviewProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);
  const [view, setView] = useState<ViewState>(DEFAULT_VIEW_STATE);
  const nodeMap = useMemo(
    () => new Map(props.document.nodes.map((node) => [node.id, node])),
    [props.document.nodes],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const fitPreview = () => {
      const bounds = documentBounds(
        props.document,
        props.mapRaster && mapMatchesDocument(props.document, props.mapRaster)
          ? { width: props.mapRaster.width, height: props.mapRaster.height }
          : undefined,
      );

      setView({
        ...DEFAULT_VIEW_STATE,
        showNodeLabels: props.showNodeLabels ?? true,
        showEdgeLabels: props.showEdgeLabels ?? true,
        ...fitViewToBounds(bounds, viewport.clientWidth, viewport.clientHeight, 36),
      });
    };

    fitPreview();

    const resizeObserver = new ResizeObserver(() => {
      fitPreview();
    });

    resizeObserver.observe(viewport);
    return () => resizeObserver.disconnect();
  }, [props.document, props.mapRaster, props.showEdgeLabels, props.showNodeLabels]);

  useEffect(() => {
    drawTopologyBackgroundCanvas(
      backgroundCanvasRef.current,
      viewportRef.current,
      view,
      props.document,
      props.mapRaster,
    );
  }, [props.document, props.mapRaster, view]);

  return (
    <div ref={viewportRef} className="simulator-topology-preview" aria-hidden="true">
      <canvas ref={backgroundCanvasRef} className="background-canvas" />
      <svg className="overlay" width="100%" height="100%">
        {props.document.edges.map((edge) => {
          const from = nodeMap.get(edge.from);
          const to = nodeMap.get(edge.to);
          if (!from || !to) {
            return null;
          }

          const fromScreen = worldToScreen(from, view);
          const toScreen = worldToScreen(to, view);
          const edgeVisual = getSimulatorEdgeVisual(fromScreen, toScreen, edge.direction);
          const midX = edgeVisual.labelPoint.x;
          const midY = edgeVisual.labelPoint.y;

          return (
            <g key={edge.id}>
              <line
                x1={edgeVisual.start.x}
                y1={edgeVisual.start.y}
                x2={edgeVisual.end.x}
                y2={edgeVisual.end.y}
                className={`simulator-edge-line simulator-edge-line-${edge.direction}`}
              />
              {edgeVisual.arrowPoints.map((points, arrowIndex) => (
                <polygon
                  key={`${edge.id}-arrow-${arrowIndex}`}
                  points={points}
                  className={`simulator-edge-arrow simulator-edge-arrow-${edge.direction}`}
                />
              ))}
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

        {props.document.nodes.map((node) => {
          const point = worldToScreen(node, view);
          const color = NODE_TYPE_META[node.type].color;

          return (
            <g key={node.id} transform={`translate(${point.x} ${point.y})`}>
              <circle r="13" className="node-ring" style={{ fill: `${color}18`, stroke: color }} />
              <circle r="7.5" className="node-core" style={{ fill: color }} />
              {view.showNodeLabels ? <text x="16" y="-14" className="node-tag">{node.name}</text> : null}
            </g>
          );
        })}

        {(props.robots ?? []).map((robot, index) => {
          const point = worldToScreen(robot.point, view);
          const color = ROBOT_COLORS[index % ROBOT_COLORS.length];
          const angleDeg = (robot.headingRad * 180) / Math.PI;
          const path = robot.pathPoints
            .map((pathPoint) => {
              const screenPoint = worldToScreen(pathPoint, view);
              return `${screenPoint.x},${screenPoint.y}`;
            })
            .join(" ");

          return (
            <g key={robot.id}>
              {robot.pathPoints.length > 1 ? (
                <polyline
                  points={path}
                  className="simulator-robot-route"
                  style={{ stroke: color }}
                />
              ) : null}
              <g transform={`translate(${point.x} ${point.y}) rotate(${-angleDeg})`}>
                <rect
                  x="-18"
                  y="-11"
                  width="36"
                  height="22"
                  rx="10"
                  className="simulator-robot-ring"
                  style={{ stroke: color }}
                />
                <rect
                  x="-15"
                  y="-8"
                  width="30"
                  height="16"
                  rx="8"
                  className="simulator-robot-core"
                  style={{ fill: color }}
                />
                <circle cx="-10" cy="0" r="3.5" className="simulator-robot-tail" />
                <polygon points="17,0 7,-7 7,7" className="simulator-robot-front" />
                {robot.status === "waiting_resource" || robot.blockedByRobotId ? (
                  <circle r="21" className="simulator-robot-blocked" />
                ) : null}
              </g>
              <g transform={`translate(${point.x} ${point.y})`}>
                <text x="0" y="-18" textAnchor="middle" className="simulator-robot-name">
                  {robot.name}
                </text>
              </g>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function getSimulatorEdgeVisual(from: Point, to: Point, direction: EdgeDirection) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const ux = dx / length;
  const uy = dy / length;
  const nodeInset = 18;
  const start = {
    x: from.x + ux * nodeInset,
    y: from.y + uy * nodeInset,
  };
  const end = {
    x: to.x - ux * nodeInset,
    y: to.y - uy * nodeInset,
  };

  const arrowPoints = [makeArrowPoints(end, ux, uy)];
  if (direction === "bidirectional") {
    arrowPoints.push(makeArrowPoints(start, -ux, -uy));
  }

  return {
    start,
    end,
    labelPoint: {
      x: (start.x + end.x) / 2 - uy * 10,
      y: (start.y + end.y) / 2 + ux * 10,
    },
    arrowPoints,
  };
}

function makeArrowPoints(tip: Point, ux: number, uy: number) {
  const arrowLength = 12;
  const arrowWidth = 8;
  const baseCenter = {
    x: tip.x - ux * arrowLength,
    y: tip.y - uy * arrowLength,
  };
  const perp = {
    x: -uy,
    y: ux,
  };
  const left = {
    x: baseCenter.x + perp.x * (arrowWidth / 2),
    y: baseCenter.y + perp.y * (arrowWidth / 2),
  };
  const right = {
    x: baseCenter.x - perp.x * (arrowWidth / 2),
    y: baseCenter.y - perp.y * (arrowWidth / 2),
  };

  return `${tip.x},${tip.y} ${left.x},${left.y} ${right.x},${right.y}`;
}
