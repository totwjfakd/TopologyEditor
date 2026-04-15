import { useEffect, useMemo, useRef, useState } from "react";
import type { MapRaster, TopologyDocument, TopologyNode } from "../types";
import type {
  CompiledMissionSummary,
  SimulationSnapshot,
  SimulatorFleetConfig,
  SimulatorMissionDraft,
} from "../simulator/types";
import { TopologyPreview } from "./TopologyPreview";

const MISSION_CALL_PRESETS = [0.5, 1, 2, 5, 10];

export type SimulatorWorkspaceProps = {
  document: TopologyDocument;
  mapRaster: MapRaster | null;
  showNodeLabels: boolean;
  showEdgeLabels: boolean;
  destinationNodes: TopologyNode[];
  destinationNodeMap: Map<string, TopologyNode>;
  missions: SimulatorMissionDraft[];
  compiledMissionSummaries: CompiledMissionSummary[];
  customRateMissionId: string | null;
  fleet: SimulatorFleetConfig;
  snapshot: SimulationSnapshot;
  timelineMaxMs: number;
  onAddMission: () => void;
  onRemoveMission: (missionId: string) => void;
  onSetCustomRateMissionId: (missionId: string | null) => void;
  onUpdateMission: (
    missionId: string,
    updater: (mission: SimulatorMissionDraft) => SimulatorMissionDraft,
  ) => void;
  onRobotCountChange: (value: string) => void;
  onRobotSpeedChange: (value: string) => void;
  onSeedChange: (value: string) => void;
  onSeekTime: (timeMs: number) => void;
  clampMissionCalls: (value: string) => number;
};

export function SimulatorWorkspace(props: SimulatorWorkspaceProps) {
  const compiledMissionMap = useMemo(
    () => new Map(props.compiledMissionSummaries.map((summary) => [summary.id, summary])),
    [props.compiledMissionSummaries],
  );
  const waitingPositionCount = useMemo(
    () => props.document.nodes.filter((node) => node.type === "waiting_position").length,
    [props.document.nodes],
  );
  const [expandedMissionId, setExpandedMissionId] = useState<string | null>(null);
  const previousMissionCountRef = useRef(0);
  const totalCallsPerHour = props.missions.reduce((sum, mission) => sum + mission.callsPerHour, 0);
  const timelineValue = Math.min(props.snapshot.currentTimeMs, props.timelineMaxMs);
  const queueFillPercent = props.snapshot.maxPendingMissionCount > 0
    ? Math.min(100, (props.snapshot.pendingMissionCount / props.snapshot.maxPendingMissionCount) * 100)
    : 0;

  useEffect(() => {
    if (props.missions.length === 0) {
      previousMissionCountRef.current = 0;
      if (expandedMissionId !== null) {
        setExpandedMissionId(null);
      }
      return;
    }

    const previousMissionCount = previousMissionCountRef.current;
    const hasExpandedMission =
      expandedMissionId !== null && props.missions.some((mission) => mission.id === expandedMissionId);
    const missionCountIncreased = props.missions.length > previousMissionCount;

    if (missionCountIncreased) {
      setExpandedMissionId(props.missions[props.missions.length - 1].id);
    } else if (expandedMissionId !== null && !hasExpandedMission) {
      setExpandedMissionId(props.missions[props.missions.length - 1].id);
    } else if (previousMissionCount === 0 && expandedMissionId === null) {
      setExpandedMissionId(props.missions[0].id);
    }

    previousMissionCountRef.current = props.missions.length;
  }, [expandedMissionId, props.missions]);

  return (
    <>
      <div className="workspace-main simulator-main">
        <section className="simulator-stage">
          <TopologyPreview
            document={props.document}
            mapRaster={props.mapRaster}
            showNodeLabels={props.showNodeLabels}
            showEdgeLabels={props.showEdgeLabels}
            robots={props.snapshot.robots}
          />

          <div className="simulator-stage-copy">
            <span className="simulator-eyebrow">DES Playback</span>
            <strong>Mission arrivals and A* robot routes are now time-driven.</strong>
            <p>
              The simulator advances with a discrete-event clock, while the stage interpolates robot
              motion between scheduled arrivals.
            </p>
          </div>

          <div className="simulator-stage-overlay">
            <span className="status-chip">{formatSimulationTime(props.snapshot.currentTimeMs)}</span>
            <span className="status-chip">{props.snapshot.robots.length} robots</span>
            <span className="status-chip">{props.snapshot.activeMissionCount} active missions</span>
            <span className="status-chip">{props.snapshot.pendingMissionCount} pending</span>
          </div>
        </section>

        <section className="simulator-timeline-panel">
          <div className="simulator-timeline-meta">
            <strong>{formatSimulationTime(props.snapshot.currentTimeMs)}</strong>
            <span>
              Next event:{" "}
              {props.snapshot.nextEventTimeMs === null
                ? "none"
                : formatSimulationTime(props.snapshot.nextEventTimeMs)}
            </span>
            <span>{formatSimulationTime(props.timelineMaxMs)}</span>
          </div>
          <input
            type="range"
            min="0"
            max={props.timelineMaxMs}
            step="1000"
            value={timelineValue}
            className="simulator-timeline-slider"
            onChange={(event) => props.onSeekTime(Number(event.target.value))}
          />
        </section>
      </div>

      <aside className="sidebar simulator-sidebar">
        <section className="sidebar-panel">
          <div className="sidebar-header">
            <div>
              <h2>Scenario</h2>
              <p>Current topology snapshot used by the simulator.</p>
            </div>
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
              <dt>Topology</dt>
              <dd>
                {props.document.nodes.length} nodes / {props.document.edges.length} edges
              </dd>
            </div>
            <div>
              <dt>Waiting</dt>
              <dd>{waitingPositionCount} positions</dd>
            </div>
          </dl>
        </section>

        <section className="sidebar-panel">
          <div className="sidebar-header">
            <div>
              <h2>Fleet</h2>
              <p>Runtime inputs for the DES engine.</p>
            </div>
          </div>
          <div className="sidebar-form">
            <label>
              <span>Robots</span>
              <input
                type="number"
                min="0"
                max="32"
                step="1"
                value={props.fleet.robotCount}
                onChange={(event) => props.onRobotCountChange(event.target.value)}
              />
            </label>
            <label>
              <span>Robot Speed</span>
              <div className="simulator-inline-field">
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  value={props.fleet.robotSpeedMps}
                  onChange={(event) => props.onRobotSpeedChange(event.target.value)}
                />
                <em>m/s</em>
              </div>
            </label>
            <label>
              <span>Seed</span>
              <input
                type="number"
                min="1"
                step="1"
                value={props.fleet.seed}
                onChange={(event) => props.onSeedChange(event.target.value)}
              />
            </label>
          </div>
        </section>

        <section className="sidebar-panel">
          <div className="sidebar-header">
            <div>
              <h2>Mission Mix</h2>
              <p>Mission arrivals follow the per-hour calls you define here.</p>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={props.onAddMission}
              disabled={props.destinationNodes.length < 2}
            >
              Add Mission
            </button>
          </div>
          <div className="sidebar-form">
            {props.destinationNodes.length < 2 ? (
              <div className="sidebar-empty">
                <p>Create at least two Destination nodes in the editor to define simulator missions.</p>
              </div>
            ) : null}

            {props.destinationNodes.length >= 2 ? (
              <>
                <div className="metric-row">
                  <span>{props.missions.length} configured</span>
                  <span>{totalCallsPerHour.toFixed(1)} calls/hour</span>
                  <span>{props.compiledMissionSummaries.filter((entry) => entry.isValid).length} valid</span>
                </div>

                <div className="simulator-mission-list">
                  {props.missions.map((mission, index) => {
                    const summary = compiledMissionMap.get(mission.id);
                    const isCustomRate =
                      props.customRateMissionId === mission.id || !MISSION_CALL_PRESETS.includes(mission.callsPerHour);
                    const isExpanded = expandedMissionId === mission.id;
                    const routeSummary = mission.stops
                      .map((stopId) => props.destinationNodeMap.get(stopId)?.name ?? "Unknown")
                      .join(" -> ");

                    return (
                      <section
                        key={mission.id}
                        className={`simulator-mission-card ${isExpanded ? "is-expanded" : "is-collapsed"}`}
                      >
                        <div className="simulator-mission-header">
                          <div className="simulator-mission-title">
                            <strong>{mission.name}</strong>
                            <span>
                              {mission.stops.length} stops · {mission.callsPerHour.toFixed(1)}/h
                            </span>
                          </div>
                          <div className="simulator-mission-actions">
                            <button
                              type="button"
                              className="ghost-button"
                              onClick={() =>
                                setExpandedMissionId((current) =>
                                  current === mission.id ? null : mission.id,
                                )
                              }
                            >
                              {isExpanded ? "Close" : "Edit"}
                            </button>
                            <button
                              type="button"
                              className="ghost-button danger"
                              onClick={() => props.onRemoveMission(mission.id)}
                            >
                              Remove
                            </button>
                          </div>
                        </div>

                        <div className="simulator-mission-overview">
                          <div className="simulator-mission-summary">{routeSummary}</div>

                          <div className={`simulator-mission-validity ${summary?.isValid ? "is-valid" : "is-invalid"}`}>
                            <strong>{summary?.isValid ? "Reachable" : "Invalid Route"}</strong>
                            <span>
                              {summary?.isValid
                                ? `${summary.loadedDistanceM.toFixed(2)}m loaded path`
                                : summary?.error ?? "Path unavailable"}
                            </span>
                          </div>
                        </div>

                        {isExpanded ? (
                          <>
                            <label>
                              <span>Name</span>
                              <input
                                value={mission.name}
                                onChange={(event) =>
                                  props.onUpdateMission(mission.id, (current) => ({
                                    ...current,
                                    name: event.target.value || `Mission ${index + 1}`,
                                  }))
                                }
                              />
                            </label>

                            <div className="simulator-rate-field">
                              <div className="simulator-rate-label">
                                <span>Calls / hour</span>
                                <strong>{mission.callsPerHour.toFixed(1)}/h</strong>
                              </div>
                              <div className="simulator-rate-toggle">
                                {MISSION_CALL_PRESETS.map((preset) => (
                                  <button
                                    key={`${mission.id}-${preset}`}
                                    type="button"
                                    className={`edge-toggle ${mission.callsPerHour === preset ? "is-active" : ""}`}
                                    onClick={() => {
                                      props.onSetCustomRateMissionId(null);
                                      props.onUpdateMission(mission.id, (current) => ({
                                        ...current,
                                        callsPerHour: preset,
                                      }));
                                    }}
                                  >
                                    {preset}/h
                                  </button>
                                ))}
                                <button
                                  type="button"
                                  className={`edge-toggle ${isCustomRate ? "is-active" : ""}`}
                                  onClick={() =>
                                    props.onSetCustomRateMissionId(
                                      props.customRateMissionId === mission.id ? null : mission.id,
                                    )
                                  }
                                >
                                  Custom
                                </button>
                              </div>
                              {isCustomRate ? (
                                <label className="simulator-rate-custom">
                                  <span>Direct input</span>
                                  <input
                                    type="number"
                                    min="0"
                                    step="0.1"
                                    value={mission.callsPerHour}
                                    onChange={(event) =>
                                      props.onUpdateMission(mission.id, (current) => ({
                                        ...current,
                                        callsPerHour: props.clampMissionCalls(event.target.value),
                                      }))
                                    }
                                  />
                                  <em>calls/hour</em>
                                </label>
                              ) : null}
                            </div>

                            <div className="simulator-stop-list">
                              {mission.stops.map((stopId, stopIndex) => (
                                <label key={`${mission.id}-stop-${stopIndex}`}>
                                  <span>Stop {stopIndex + 1}</span>
                                  <select
                                    value={stopId}
                                    onChange={(event) =>
                                      props.onUpdateMission(mission.id, (current) => ({
                                        ...current,
                                        stops: current.stops.map((entry, entryIndex) =>
                                          entryIndex === stopIndex ? event.target.value : entry,
                                        ),
                                      }))
                                    }
                                  >
                                    {props.destinationNodes.map((node) => (
                                      <option key={node.id} value={node.id}>
                                        {node.name}
                                      </option>
                                    ))}
                                  </select>
                                </label>
                              ))}
                            </div>

                            <div className="sidebar-actions">
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() =>
                                  props.onUpdateMission(mission.id, (current) => ({
                                    ...current,
                                    stops: current.stops.concat(current.stops[current.stops.length - 1]),
                                  }))
                                }
                              >
                                Add Stop
                              </button>
                              <button
                                type="button"
                                className="ghost-button"
                                onClick={() =>
                                  props.onUpdateMission(mission.id, (current) => ({
                                    ...current,
                                    stops: current.stops.slice(0, -1),
                                  }))
                                }
                                disabled={mission.stops.length <= 2}
                              >
                                Remove Stop
                              </button>
                            </div>
                          </>
                        ) : null}
                      </section>
                    );
                  })}
                </div>
              </>
            ) : null}
          </div>
        </section>

        <section className="sidebar-panel">
          <div className="sidebar-header">
            <div>
              <h2>Mission Queue</h2>
              <p>Pending missions wait here until a robot can actually depart.</p>
            </div>
          </div>
          <div className="sidebar-form">
            <div className="metric-row">
              <span>
                {props.snapshot.pendingMissionCount} / {props.snapshot.maxPendingMissionCount} pending
              </span>
              <span>
                Oldest{" "}
                {props.snapshot.oldestPendingWaitMs === null
                  ? "none"
                  : formatSimulationTime(props.snapshot.oldestPendingWaitMs)}
              </span>
              <span>{props.snapshot.droppedMissionCount} dropped</span>
            </div>

            <div className="simulator-queue-meter" aria-hidden="true">
              <div
                className={`simulator-queue-meter-fill ${props.snapshot.pendingMissionCount >= props.snapshot.maxPendingMissionCount ? "is-full" : ""}`}
                style={{ width: `${queueFillPercent}%` }}
              />
            </div>

            <div className="simulator-list">
              {props.snapshot.pendingMissions.map((mission) => (
                <div key={mission.id} className="simulator-list-card">
                  <div className="simulator-list-row">
                    <strong>{mission.name}</strong>
                    <span>{formatSimulationTime(mission.waitMs)}</span>
                  </div>
                  <div className="simulator-list-route">
                    {mission.stopNames.join(" -> ")}
                  </div>
                </div>
              ))}

              {props.snapshot.pendingMissions.length === 0 ? (
                <div className="sidebar-empty">
                  <p>모든 pending mission은 여기에서 backlog로 보입니다.</p>
                </div>
              ) : null}
            </div>
          </div>
        </section>

        <section className="sidebar-panel">
          <div className="sidebar-header">
            <div>
              <h2>Robots</h2>
              <p>Live robot state derived from the current simulation time.</p>
            </div>
          </div>
          <div className="simulator-list">
            {props.snapshot.robots.map((robot) => (
              <div key={robot.id} className="simulator-list-card">
                <div className="simulator-list-row">
                  <strong>{robot.name}</strong>
                  <span className={`simulator-status simulator-status-${robot.status}`}>
                    {formatRobotStatus(robot.status)}
                  </span>
                </div>
                <div className="simulator-list-row muted">
                  <span>
                    {robot.waitReason
                      ? `${formatWaitReason(robot.waitReason)} · ${robot.waitingForLabel ?? "resource"}`
                      : robot.currentMissionName ?? "Idle queue"}
                  </span>
                  <span>{robot.totalDistanceM.toFixed(1)}m</span>
                </div>
              </div>
            ))}

            {props.snapshot.robots.length === 0 ? (
              <div className="sidebar-empty">
                <p>
                  {props.fleet.robotCount <= 0
                    ? "Set robot count above zero to populate the fleet."
                    : waitingPositionCount <= 0
                      ? "Add at least one Waiting Position node in the editor to spawn robots."
                      : "No robots were spawned for the current scenario."}
                </p>
              </div>
            ) : null}
          </div>
        </section>

        <section className="sidebar-panel">
          <div className="sidebar-header">
            <div>
              <h2>Event Log</h2>
              <p>Recent DES events recorded in simulation time.</p>
            </div>
          </div>
          <div className="simulator-list">
            {props.snapshot.recentEvents.map((event) => (
              <div key={event.id} className="simulator-list-card">
                <div className="simulator-list-row">
                  <strong>{formatSimulationTime(event.timeMs)}</strong>
                  <span>{formatEventType(event.type)}</span>
                </div>
                <div className="simulator-event-message">{event.message}</div>
              </div>
            ))}

            {props.snapshot.recentEvents.length === 0 ? (
              <div className="sidebar-empty">
                <p>Press Start Simulation to begin generating mission and robot events.</p>
              </div>
            ) : null}
          </div>
        </section>
      </aside>
    </>
  );
}

function formatSimulationTime(timeMs: number) {
  const totalSeconds = Math.max(0, Math.floor(timeMs / 1000));
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");

  return `${hours}:${minutes}:${seconds}`;
}

function formatRobotStatus(status: string) {
  if (status === "moving_loaded") {
    return "Loaded";
  }
  if (status === "moving_empty") {
    return "Empty";
  }
  if (status === "waiting_resource") {
    return "Blocked";
  }

  return "Idle";
}

function formatEventType(type: string) {
  if (type === "mission_created") {
    return "Created";
  }
  if (type === "mission_dropped") {
    return "Dropped";
  }
  if (type === "mission_assigned") {
    return "Assigned";
  }
  if (type === "parking_assigned") {
    return "Parking";
  }
  if (type === "parking_skipped") {
    return "No Parking";
  }
  if (type === "parking_arrived") {
    return "Parked";
  }
  if (type === "robot_ready_to_enter_edge") {
    return "Ready";
  }
  if (type === "edge_blocked") {
    return "Edge Blocked";
  }
  if (type === "edge_enter_granted") {
    return "Granted";
  }
  if (type === "edge_entered") {
    return "Edge";
  }
  if (type === "robot_wait_started") {
    return "Wait Start";
  }
  if (type === "robot_wait_finished") {
    return "Wait End";
  }
  if (type === "node_conflict") {
    return "Node Conflict";
  }
  if (type === "reservation_released") {
    return "Released";
  }
  if (type === "node_arrived") {
    return "Arrived";
  }

  return "Done";
}

function formatWaitReason(reason: string) {
  if (reason === "node_occupancy") {
    return "Node";
  }
  if (reason === "critical_section") {
    return "Section";
  }
  if (reason === "minimum_headway") {
    return "Headway";
  }
  if (reason === "bidirectional_mutual_exclusion") {
    return "Opposite";
  }

  return "Edge";
}
