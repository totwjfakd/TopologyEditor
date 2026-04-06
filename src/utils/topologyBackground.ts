import type { MapRaster, TopologyDocument, ViewState } from "../types";
import { getNiceDistance, screenToWorld, worldToScreen } from "./geometry";
import { mapMatchesDocument } from "./editorDocument";

export function drawTopologyBackgroundCanvas(
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
