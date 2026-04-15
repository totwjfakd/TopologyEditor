import type { Point, TopologyNode } from "../types";

export const DEFAULT_NODE_HEADING_RAD = 0;

export function normalizeHeadingRad(value: number) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

export function roundHeadingRad(value: number) {
  return Math.round(normalizeHeadingRad(value) * 1000) / 1000;
}

export function getNodeHeadingRad(node: Pick<TopologyNode, "headingRad">) {
  return typeof node.headingRad === "number" && Number.isFinite(node.headingRad)
    ? roundHeadingRad(node.headingRad)
    : null;
}

export function legacyHeadingDegToRad(value: number) {
  return roundHeadingRad((value * Math.PI) / 180);
}

export function getScreenHeadingVector(headingRad: number, length: number): Point {
  const normalized = normalizeHeadingRad(headingRad);
  return {
    x: Math.cos(normalized) * length,
    y: -Math.sin(normalized) * length,
  };
}

export function getHeadingRadBetweenPoints(from: Point, to: Point) {
  return roundHeadingRad(Math.atan2(to.y - from.y, to.x - from.x));
}
