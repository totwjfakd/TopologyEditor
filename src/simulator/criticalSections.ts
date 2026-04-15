import type { TopologyDocument, TopologyEdge, TopologyNode } from "../types";

export type SimulatorCriticalSection = {
  id: string;
  label: string;
  edgeIds: string[];
  nodeIds: string[];
  boundaryNodeIds: string[];
};

export type SimulatorCriticalSectionIndex = {
  sections: SimulatorCriticalSection[];
  byId: Map<string, SimulatorCriticalSection>;
  edgeToSectionId: Map<string, string>;
};

type RouteEdgeLike = {
  edgeId: string;
};

export function buildCriticalSectionIndex(document: TopologyDocument): SimulatorCriticalSectionIndex {
  const bidirectionalEdges = document.edges.filter((edge) => edge.direction === "bidirectional");
  const edgeMap = new Map(bidirectionalEdges.map((edge) => [edge.id, edge]));
  const nodeMap = new Map(document.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, string[]>();

  for (const edge of bidirectionalEdges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge.id]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge.id]);
  }

  const visited = new Set<string>();
  const sections: SimulatorCriticalSection[] = [];

  for (const edge of bidirectionalEdges) {
    if (visited.has(edge.id)) {
      continue;
    }

    const startNodeId = pickSectionStartNode(edge, adjacency, nodeMap);
    const walked = walkCriticalSection(edge, startNodeId, edgeMap, adjacency, nodeMap, visited);
    if (walked.edgeIds.length === 0) {
      continue;
    }

    sections.push({
      id: `section_${String(sections.length + 1).padStart(3, "0")}`,
      label: buildSectionLabel(walked.nodeIds, nodeMap, sections.length + 1),
      edgeIds: walked.edgeIds,
      nodeIds: walked.nodeIds,
      boundaryNodeIds: getBoundaryNodeIds(walked.nodeIds),
    });
  }

  const byId = new Map(sections.map((section) => [section.id, section]));
  const edgeToSectionId = new Map<string, string>();
  for (const section of sections) {
    for (const edgeId of section.edgeIds) {
      edgeToSectionId.set(edgeId, section.id);
    }
  }

  return {
    sections,
    byId,
    edgeToSectionId,
  };
}

export function getCriticalSectionRun<T extends RouteEdgeLike>(
  route: T[],
  startIndex: number,
  index: SimulatorCriticalSectionIndex,
) {
  const sectionId = index.edgeToSectionId.get(route[startIndex]?.edgeId ?? "");
  if (!sectionId) {
    return null;
  }

  if (startIndex > 0 && index.edgeToSectionId.get(route[startIndex - 1]?.edgeId ?? "") === sectionId) {
    return null;
  }

  let endIndex = startIndex;
  while (endIndex + 1 < route.length && index.edgeToSectionId.get(route[endIndex + 1].edgeId) === sectionId) {
    endIndex += 1;
  }

  const section = index.byId.get(sectionId);
  if (!section) {
    return null;
  }

  return {
    section,
    sectionId,
    startIndex,
    endIndex,
  };
}

export function getCriticalSectionRouteSpans<T extends RouteEdgeLike>(
  route: T[],
  sectionIndex: SimulatorCriticalSectionIndex,
) {
  const spans: Array<{
    section: SimulatorCriticalSection;
    sectionId: string;
    startIndex: number;
    endIndex: number;
  }> = [];

  for (let routeIndex = 0; routeIndex < route.length; routeIndex += 1) {
    const span = getCriticalSectionRun(route, routeIndex, sectionIndex);
    if (!span) {
      continue;
    }

    spans.push(span);
    routeIndex = span.endIndex;
  }

  return spans;
}

function pickSectionStartNode(
  edge: TopologyEdge,
  adjacency: Map<string, string[]>,
  nodeMap: Map<string, TopologyNode>,
) {
  const fromBoundary = isSectionBoundary(edge.from, adjacency, nodeMap);
  const toBoundary = isSectionBoundary(edge.to, adjacency, nodeMap);

  if (fromBoundary && !toBoundary) {
    return edge.from;
  }
  if (toBoundary && !fromBoundary) {
    return edge.to;
  }

  return edge.from;
}

function walkCriticalSection(
  startEdge: TopologyEdge,
  startNodeId: string,
  edgeMap: Map<string, TopologyEdge>,
  adjacency: Map<string, string[]>,
  nodeMap: Map<string, TopologyNode>,
  globalVisited: Set<string>,
) {
  const edgeIds: string[] = [];
  const nodeIds = [startNodeId];
  const localVisited = new Set<string>();
  let currentEdge: TopologyEdge | undefined = startEdge;
  let currentNodeId = startNodeId;

  while (currentEdge && !localVisited.has(currentEdge.id)) {
    localVisited.add(currentEdge.id);
    globalVisited.add(currentEdge.id);
    edgeIds.push(currentEdge.id);

    const nextNodeId = currentEdge.from === currentNodeId ? currentEdge.to : currentEdge.from;
    nodeIds.push(nextNodeId);

    if (isSectionBoundary(nextNodeId, adjacency, nodeMap)) {
      break;
    }

    const nextEdgeId = (adjacency.get(nextNodeId) ?? []).find((edgeId) => edgeId !== currentEdge?.id);
    if (!nextEdgeId) {
      break;
    }

    currentNodeId = nextNodeId;
    currentEdge = edgeMap.get(nextEdgeId);
  }

  return {
    edgeIds,
    nodeIds,
  };
}

function isSectionBoundary(
  nodeId: string,
  adjacency: Map<string, string[]>,
  nodeMap: Map<string, TopologyNode>,
) {
  const bidirectionalDegree = adjacency.get(nodeId)?.length ?? 0;
  const node = nodeMap.get(nodeId);
  if (!node) {
    return true;
  }

  return bidirectionalDegree !== 2 || node.type !== "waypoint";
}

function getBoundaryNodeIds(nodeIds: string[]) {
  if (nodeIds.length <= 1) {
    return nodeIds.slice();
  }

  return [nodeIds[0], nodeIds[nodeIds.length - 1]];
}

function buildSectionLabel(
  nodeIds: string[],
  nodeMap: Map<string, TopologyNode>,
  index: number,
) {
  const startNode = nodeMap.get(nodeIds[0]);
  const endNode = nodeMap.get(nodeIds[nodeIds.length - 1]);

  if (startNode && endNode && startNode.id !== endNode.id) {
    return `${startNode.name} <-> ${endNode.name}`;
  }

  return `Section ${String(index).padStart(3, "0")}`;
}
