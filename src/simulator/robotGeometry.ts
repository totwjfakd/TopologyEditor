import type { Point } from "../types";

export const ROBOT_FRONT_OFFSET_M = 0.35;
export const ROBOT_REAR_OFFSET_M = 0.35;
export const ROBOT_HALF_WIDTH_M = 0.28;
export const ROBOT_FORWARD_CLEARANCE_M = 1;

export function getRobotAxes(headingRad: number) {
  const forward = {
    x: Math.cos(headingRad),
    y: Math.sin(headingRad),
  };
  const lateral = {
    x: -forward.y,
    y: forward.x,
  };

  return { forward, lateral };
}

export function getRobotFrontPoint(center: Point, headingRad: number): Point {
  const { forward } = getRobotAxes(headingRad);
  return {
    x: center.x + forward.x * ROBOT_FRONT_OFFSET_M,
    y: center.y + forward.y * ROBOT_FRONT_OFFSET_M,
  };
}

export function getRobotSupportExtent(headingRad: number, axis: Point) {
  const { forward, lateral } = getRobotAxes(headingRad);
  const forwardProjection = dot(axis, forward);
  const lateralProjection = dot(axis, lateral);
  const forwardExtent =
    Math.abs(forwardProjection) *
    (forwardProjection >= 0 ? ROBOT_FRONT_OFFSET_M : ROBOT_REAR_OFFSET_M);

  return forwardExtent + Math.abs(lateralProjection) * ROBOT_HALF_WIDTH_M;
}

function dot(a: Point, b: Point) {
  return a.x * b.x + a.y * b.y;
}
