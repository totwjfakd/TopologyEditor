import { create } from "zustand";
import type {
  ClipboardData,
  NodeType,
  Point,
  SelectionState,
  TopologyDocument,
  ViewState,
} from "../types";
import {
  buildClipboard,
  cloneDocument,
  createEmptyDocument,
  createNodeRecord,
  deleteSelectionFromDocument,
  isNameUnique,
  mergeOrCreateEdge,
  normalizeName,
  pasteClipboard,
  recalculateEdgeDistances,
} from "../utils/topology";
import { DEFAULT_VIEW_STATE } from "../utils/viewState";

interface EditorState {
  document: TopologyDocument;
  selection: SelectionState;
  nodeType: NodeType;
  edgeMode: boolean;
  view: ViewState;
  mouseWorld: Point;
  clipboard: ClipboardData | null;
  historyPast: TopologyDocument[];
  historyFuture: TopologyDocument[];
  setNodeType: (nodeType: NodeType) => void;
  setEdgeMode: (edgeMode: boolean) => void;
  toggleEdgeMode: () => void;
  patchView: (view: Partial<ViewState>) => void;
  setMouseWorld: (point: Point) => void;
  setSelection: (selection: SelectionState) => void;
  clearSelection: () => void;
  replaceDocument: (
    document: TopologyDocument,
    selection?: SelectionState,
  ) => void;
  commitDocument: (
    document: TopologyDocument,
    selection?: SelectionState,
  ) => void;
  commitFrom: (
    previousDocument: TopologyDocument,
    nextDocument: TopologyDocument,
    selection?: SelectionState,
  ) => void;
  undo: () => void;
  redo: () => void;
  loadDocument: (document: TopologyDocument) => void;
  createNodeAt: (point: Point) => void;
  updateNode: (
    nodeId: string,
    updates: Partial<Pick<TopologyDocument["nodes"][number], "name" | "type">>,
  ) => { ok: true } | { ok: false; error: string };
  createEdge: (fromId: string, toId: string) => void;
  toggleEdgeDirection: (edgeId: string) => void;
  deleteEdge: (edgeId: string) => void;
  deleteSelection: () => void;
  updateMapMetadata: (
    updater: (document: TopologyDocument) => TopologyDocument,
    recordHistory?: boolean,
  ) => void;
  copySelection: () => void;
  pasteClipboardAt: (point: Point) => void;
  selectAll: () => void;
}

const emptySelection: SelectionState = {
  nodeIds: [],
  edgeIds: [],
};

function normalizeSelection(
  selection: SelectionState,
  document: TopologyDocument,
): SelectionState {
  const nodeIds = new Set(document.nodes.map((node) => node.id));
  const edgeIds = new Set(document.edges.map((edge) => edge.id));

  return {
    nodeIds: selection.nodeIds.filter((id) => nodeIds.has(id)),
    edgeIds: selection.edgeIds.filter((id) => edgeIds.has(id)),
  };
}

export const useEditorStore = create<EditorState>((set, get) => ({
  document: createEmptyDocument(),
  selection: emptySelection,
  nodeType: "destination",
  edgeMode: false,
  view: DEFAULT_VIEW_STATE,
  mouseWorld: { x: 0, y: 0 },
  clipboard: null,
  historyPast: [],
  historyFuture: [],
  setNodeType: (nodeType) => set({ nodeType, edgeMode: false }),
  setEdgeMode: (edgeMode) => set({ edgeMode }),
  toggleEdgeMode: () => set((state) => ({ edgeMode: !state.edgeMode })),
  patchView: (view) => set((state) => ({ view: { ...state.view, ...view } })),
  setMouseWorld: (mouseWorld) => set({ mouseWorld }),
  setSelection: (selection) =>
    set({
      selection: normalizeSelection(selection, get().document),
    }),
  clearSelection: () => set({ selection: emptySelection }),
  replaceDocument: (document, selection) =>
    set({
      document,
      selection: normalizeSelection(selection ?? get().selection, document),
    }),
  commitDocument: (document, selection) => {
    const currentDocument = get().document;
    set({
      document,
      selection: normalizeSelection(selection ?? get().selection, document),
      historyPast: [...get().historyPast, cloneDocument(currentDocument)],
      historyFuture: [],
    });
  },
  commitFrom: (previousDocument, nextDocument, selection) =>
    set({
      document: nextDocument,
      selection: normalizeSelection(selection ?? get().selection, nextDocument),
      historyPast: [...get().historyPast, cloneDocument(previousDocument)],
      historyFuture: [],
    }),
  undo: () => {
    const historyPast = get().historyPast;
    if (historyPast.length === 0) {
      return;
    }

    const previous = historyPast[historyPast.length - 1];
    set({
      document: cloneDocument(previous),
      selection: normalizeSelection(get().selection, previous),
      historyPast: historyPast.slice(0, -1),
      historyFuture: [cloneDocument(get().document), ...get().historyFuture],
    });
  },
  redo: () => {
    const historyFuture = get().historyFuture;
    if (historyFuture.length === 0) {
      return;
    }

    const next = historyFuture[0];
    set({
      document: cloneDocument(next),
      selection: normalizeSelection(get().selection, next),
      historyPast: [...get().historyPast, cloneDocument(get().document)],
      historyFuture: historyFuture.slice(1),
    });
  },
  loadDocument: (document) =>
    set({
      document,
      selection: emptySelection,
      historyPast: [],
      historyFuture: [],
    }),
  createNodeAt: (point) => {
    const document = cloneDocument(get().document);
    const node = createNodeRecord(document, point, get().nodeType);
    document.nodes.push(node);
    get().commitDocument(document, { nodeIds: [node.id], edgeIds: [] });
  },
  updateNode: (nodeId, updates) => {
    const document = cloneDocument(get().document);
    const node = document.nodes.find((entry) => entry.id === nodeId);
    if (!node) {
      return { ok: false, error: "노드를 찾을 수 없습니다." };
    }

    if (typeof updates.name === "string") {
      const normalizedName = normalizeName(updates.name);
      if (!normalizedName) {
        return { ok: false, error: "이름은 비워둘 수 없습니다." };
      }
      if (!isNameUnique(normalizedName, document.nodes, nodeId)) {
        return { ok: false, error: "노드 이름은 중복될 수 없습니다." };
      }
      node.name = normalizedName;
    }

    if (updates.type) {
      node.type = updates.type;
    }

    get().commitDocument(document, {
      nodeIds: [node.id],
      edgeIds: [],
    });

    return { ok: true };
  },
  createEdge: (fromId, toId) => {
    const { doc, edgeId } = mergeOrCreateEdge(get().document, fromId, toId);
    if (!edgeId) {
      return;
    }

    get().commitDocument(doc, {
      nodeIds: [],
      edgeIds: [edgeId],
    });
  },
  toggleEdgeDirection: (edgeId) => {
    const document = cloneDocument(get().document);
    const edge = document.edges.find((entry) => entry.id === edgeId);
    if (!edge) {
      return;
    }

    edge.direction =
      edge.direction === "bidirectional" ? "unidirectional" : "bidirectional";
    get().commitDocument(document, {
      nodeIds: [],
      edgeIds: [edge.id],
    });
  },
  deleteEdge: (edgeId) => {
    const document = cloneDocument(get().document);
    document.edges = document.edges.filter((edge) => edge.id !== edgeId);
    get().commitDocument(document, emptySelection);
  },
  deleteSelection: () => {
    const selection = get().selection;
    if (selection.nodeIds.length === 0 && selection.edgeIds.length === 0) {
      return;
    }

    const document = deleteSelectionFromDocument(get().document, selection);
    get().commitDocument(document, emptySelection);
  },
  updateMapMetadata: (updater, recordHistory = true) => {
    const nextDocument = recalculateEdgeDistances(updater(cloneDocument(get().document)));
    if (recordHistory) {
      get().commitDocument(nextDocument, get().selection);
    } else {
      get().replaceDocument(nextDocument, get().selection);
    }
  },
  copySelection: () => set({ clipboard: buildClipboard(get().document, get().selection) }),
  pasteClipboardAt: (point) => {
    const clipboard = get().clipboard;
    if (!clipboard) {
      return;
    }

    const { doc, selection } = pasteClipboard(get().document, clipboard, point);
    get().commitDocument(doc, selection);
  },
  selectAll: () =>
    set((state) => ({
      selection: {
        nodeIds: state.document.nodes.map((node) => node.id),
        edgeIds: state.document.edges.map((edge) => edge.id),
      },
    })),
}));
