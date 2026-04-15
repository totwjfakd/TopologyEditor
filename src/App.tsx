import {
  type ComponentProps,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import type {
  ContextMenuState,
  MapRaster,
  NodeType,
  Point,
  SelectionState,
  TopologyDocument,
  TopologyEdge,
  TopologyNode,
} from "./types";
import { nodeSupportsHeading } from "./types";
import { useEditorStore } from "./store/editorStore";
import {
  documentBounds,
  fitViewToBounds,
  getNiceDistance,
} from "./utils/geometry";
import {
  cloneDocument,
  createNodeRecord,
  sanitizeLoadedDocument,
} from "./utils/topology";
import { roundHeadingRad } from "./utils/nodeHeading";
import {
  fileBaseName,
  matchMapFiles,
  parseMapYamlFile,
  parsePgmFile,
} from "./utils/mapFiles";
import {
  clearLocalDraft,
  readLocalDraft,
  type LocalDraft,
  writeLocalDraft,
} from "./utils/localDraft";
import { mapMatchesDocument } from "./utils/editorDocument";
import { RecoveryBanner } from "./components/RecoveryBanner";
import { Toolbar } from "./components/Toolbar";
import { InspectorPanel } from "./components/InspectorPanel";
import { StatusBar } from "./components/StatusBar";
import { ContextMenuView } from "./components/ContextMenuView";
import { NodeEditorDialog } from "./components/NodeEditorDialog";
import { SimulatorScreen } from "./components/SimulatorScreen";
import { TopologyCanvas } from "./components/TopologyCanvas";

type Message = {
  type: "error" | "info";
  text: string;
};

type ScreenMode = "editor" | "simulator";

type PendingNodeHeadingSession = {
  nodeId: string;
  previousDocument: TopologyDocument;
  previousSelection: SelectionState;
};

function App() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const mapInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const setNodeType = useEditorStore((state) => state.setNodeType);
  const toggleEdgeMode = useEditorStore((state) => state.toggleEdgeMode);
  const patchView = useEditorStore((state) => state.patchView);
  const commitDocument = useEditorStore((state) => state.commitDocument);
  const replaceDocument = useEditorStore((state) => state.replaceDocument);
  const commitFrom = useEditorStore((state) => state.commitFrom);
  const loadDocument = useEditorStore((state) => state.loadDocument);
  const undo = useEditorStore((state) => state.undo);
  const redo = useEditorStore((state) => state.redo);
  const updateNode = useEditorStore((state) => state.updateNode);
  const updateMapMetadata = useEditorStore((state) => state.updateMapMetadata);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);
  const copySelection = useEditorStore((state) => state.copySelection);
  const pasteClipboardAt = useEditorStore((state) => state.pasteClipboardAt);
  const selectAll = useEditorStore((state) => state.selectAll);

  const [mapRaster, setMapRaster] = useState<MapRaster | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
  const [pendingNodeHeading, setPendingNodeHeading] = useState<PendingNodeHeadingSession | null>(null);
  const [spacePressed, setSpacePressed] = useState(false);
  const [draftOffer, setDraftOffer] = useState<LocalDraft | null>(() => readLocalDraft());
  const [screenMode, setScreenMode] = useState<ScreenMode>("editor");
  const [simulatorShowNodeLabels, setSimulatorShowNodeLabels] = useState(true);
  const [simulatorShowEdgeLabels, setSimulatorShowEdgeLabels] = useState(true);
  const pendingNodeHeadingId = pendingNodeHeading?.nodeId ?? null;

  const editingNodeExists = useEditorStore((state) =>
    editingNodeId ? state.document.nodes.some((node) => node.id === editingNodeId) : false,
  );
  const pendingNodeHeadingExists = useEditorStore((state) =>
    pendingNodeHeadingId
      ? state.document.nodes.some(
          (node) => node.id === pendingNodeHeadingId && nodeSupportsHeading(node.type),
        )
      : false,
  );
  const mapRasterRef = useRef<MapRaster | null>(null);

  useEffect(() => {
    mapRasterRef.current = mapRaster;
  }, [mapRaster]);

  function fitScene() {
    if (!viewportRef.current) {
      return;
    }

    const currentDocument = useEditorStore.getState().document;
    const currentMapRaster = mapRasterRef.current;
    const bounds = documentBounds(
      currentDocument,
      currentMapRaster && mapMatchesDocument(currentDocument, currentMapRaster)
        ? { width: currentMapRaster.width, height: currentMapRaster.height }
        : undefined,
    );

    patchView(
      fitViewToBounds(
        bounds,
        viewportRef.current.clientWidth,
        viewportRef.current.clientHeight,
      ),
    );
  }

  async function handleMapUpload(event: ChangeEvent<HTMLInputElement>) {
    try {
      const { yamlFile, pgmFile } = matchMapFiles(event.target.files);
      const [metadata, raster] = await Promise.all([
        parseMapYamlFile(yamlFile),
        parsePgmFile(pgmFile),
      ]);

      if (fileBaseName(metadata.image) !== fileBaseName(pgmFile.name)) {
        throw new Error("YAML의 image와 업로드한 PGM 파일명이 일치하지 않습니다.");
      }

      setMapRaster(raster);
      updateMapMetadata(
        (draft) => ({
          ...draft,
          map: {
            image: metadata.image,
            resolution: metadata.resolution,
            origin: metadata.origin,
          },
        }),
        true,
      );
      setMessage({
        type: "info",
        text: `${pgmFile.name} 맵을 불러왔습니다.`,
      });
      requestAnimationFrame(() => fitScene());
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "맵을 불러오지 못했습니다.",
      });
    } finally {
      event.target.value = "";
    }
  }

  async function handleJsonLoad(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    try {
      const text = await file.text();
      const parsed = JSON.parse(text);
      const nextDocument = sanitizeLoadedDocument(parsed);
      const currentMapRaster = mapRasterRef.current;
      const keepCurrentRaster = mapMatchesDocument(nextDocument, currentMapRaster);
      setPendingNodeHeading(null);
      loadDocument(nextDocument);
      setMapRaster(keepCurrentRaster ? currentMapRaster : null);
      setMessage({
        type: "info",
        text: keepCurrentRaster
          ? "토폴로지를 불러왔습니다. 기존 배경 맵을 유지합니다."
          : nextDocument.map.image
            ? "토폴로지를 불러왔습니다. 배경 맵은 다시 업로드해 주세요."
            : "토폴로지를 불러왔습니다.",
      });
      requestAnimationFrame(() => fitScene());
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "JSON을 불러오지 못했습니다.",
      });
    } finally {
      event.target.value = "";
    }
  }

  function handleJsonSave() {
    const currentDocument = pendingNodeHeading
      ? pendingNodeHeading.previousDocument
      : useEditorStore.getState().document;
    const blob = new Blob([JSON.stringify(currentDocument, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const anchor = documentCreateAnchor(url, `topology-${formatDateStamp()}.json`);
    anchor.click();
    URL.revokeObjectURL(url);
    anchor.remove();
    setMessage({ type: "info", text: "토폴로지 JSON을 다운로드했습니다." });
  }

  function handleResolutionCommit(value: number) {
    if (!Number.isFinite(value) || value <= 0) {
      setMessage({ type: "error", text: "resolution은 0보다 큰 숫자여야 합니다." });
      return;
    }

    updateMapMetadata(
      (draft) => ({
        ...draft,
        map: {
          ...draft.map,
          resolution: value,
        },
      }),
      true,
    );
  }

  function handleNodeDialogSave(name: string, type: NodeType, headingRad: number | null) {
    if (!editingNodeId) {
      return;
    }

    const result = updateNode(editingNodeId, { name, type, headingRad });
    if (!result.ok) {
      setMessage({ type: "error", text: result.error });
      return;
    }

    setPendingNodeHeading((current) => (current?.nodeId === editingNodeId ? null : current));
    setEditingNodeId(null);
  }

  function startNodeCreation(type: NodeType, world: Point) {
    const { document: currentDocument, selection: currentSelection } = useEditorStore.getState();
    const nextDocument = cloneDocument(currentDocument);
    const node = createNodeRecord(nextDocument, world, type);
    nextDocument.nodes.push(node);
    const nextSelection = { nodeIds: [node.id], edgeIds: [] } satisfies SelectionState;

    if (nodeSupportsHeading(type)) {
      replaceDocument(nextDocument, nextSelection);
      setPendingNodeHeading({
        nodeId: node.id,
        previousDocument: cloneDocument(currentDocument),
        previousSelection: currentSelection,
      });
      return;
    }

    commitDocument(nextDocument, nextSelection);
    setPendingNodeHeading(null);
  }

  function handleCreateNodeFromContext(type: NodeType, world: Point) {
    startNodeCreation(type, world);
    setContextMenu(null);
  }

  function cancelPendingNodeHeading(restorePreview = true) {
    if (!pendingNodeHeading) {
      return;
    }

    if (restorePreview) {
      replaceDocument(
        cloneDocument(pendingNodeHeading.previousDocument),
        pendingNodeHeading.previousSelection,
      );
    }
    setPendingNodeHeading(null);
  }

  function commitPendingNodeHeading(nodeId: string, headingRad: number) {
    if (!pendingNodeHeading || pendingNodeHeading.nodeId !== nodeId) {
      return;
    }

    const currentDocument = useEditorStore.getState().document;
    const nextDocument = cloneDocument(currentDocument);
    const node = nextDocument.nodes.find((entry) => entry.id === nodeId);
    if (!node || !nodeSupportsHeading(node.type)) {
      cancelPendingNodeHeading(false);
      return;
    }

    node.headingRad = roundHeadingRad(headingRad);
    commitFrom(pendingNodeHeading.previousDocument, nextDocument, {
      nodeIds: [nodeId],
      edgeIds: [],
    });
    setPendingNodeHeading(null);
  }

  function handleRestoreDraft() {
    if (!draftOffer) {
      return;
    }

    setPendingNodeHeading(null);
    loadDocument(draftOffer.document);
    patchView(draftOffer.view);
    setMapRaster(null);
    setContextMenu(null);
    setEditingNodeId(null);
    setDraftOffer(null);
    setMessage({
      type: "info",
      text: draftOffer.document.map.image
        ? "브라우저 임시 저장본을 복원했습니다. 배경 맵은 다시 업로드해 주세요."
        : "브라우저 임시 저장본을 복원했습니다.",
    });
  }

  function handleDiscardDraft() {
    clearLocalDraft();
    setDraftOffer(null);
    setMessage({ type: "info", text: "브라우저 임시 저장본을 삭제했습니다." });
  }

  function handleOpenSimulator() {
    const currentView = useEditorStore.getState().view;
    cancelPendingNodeHeading();
    setContextMenu(null);
    setEditingNodeId(null);
    setSpacePressed(false);
    setSimulatorShowNodeLabels(currentView.showNodeLabels);
    setSimulatorShowEdgeLabels(currentView.showEdgeLabels);
    setScreenMode("simulator");
  }

  function handleReturnToEditor() {
    setScreenMode("editor");
  }

  useEffect(() => {
    if (!message) {
      return;
    }

    const timeout = window.setTimeout(() => setMessage(null), 4200);
    return () => window.clearTimeout(timeout);
  }, [message]);

  useEffect(() => {
    const onWindowPointerDown = () => {
      setContextMenu(null);
    };

    window.addEventListener("pointerdown", onWindowPointerDown);
    return () => window.removeEventListener("pointerdown", onWindowPointerDown);
  }, []);

  useEffect(() => {
    if (editingNodeId && !editingNodeExists) {
      setEditingNodeId(null);
    }
  }, [editingNodeExists, editingNodeId]);

  useEffect(() => {
    if (!pendingNodeHeadingId) {
      return;
    }

    if (!pendingNodeHeadingExists) {
      setPendingNodeHeading(null);
    }
  }, [pendingNodeHeadingExists, pendingNodeHeadingId]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (screenMode === "simulator") {
        return;
      }

      if (event.key === " " && !isEditableTarget(event.target)) {
        setSpacePressed(true);
        event.preventDefault();
      }

      const hotkey = event.ctrlKey || event.metaKey;
      if (hotkey) {
        const lowerKey = event.key.toLowerCase();
        if (lowerKey === "z") {
          event.preventDefault();
          if (pendingNodeHeadingId) {
            cancelPendingNodeHeading();
            return;
          }
          if (event.shiftKey) {
            redo();
          } else {
            undo();
          }
          return;
        }
        if (lowerKey === "y") {
          event.preventDefault();
          redo();
          return;
        }
        if (lowerKey === "a") {
          event.preventDefault();
          selectAll();
          return;
        }
        if (lowerKey === "c") {
          event.preventDefault();
          copySelection();
          return;
        }
        if (lowerKey === "v") {
          event.preventDefault();
          pasteClipboardAt(useEditorStore.getState().mouseWorld);
          return;
        }
        if (lowerKey === "s") {
          event.preventDefault();
          handleJsonSave();
          return;
        }
        if (lowerKey === "o") {
          event.preventDefault();
          jsonInputRef.current?.click();
          return;
        }
        if (event.key === "0") {
          event.preventDefault();
          fitScene();
          return;
        }
      }

      if (!isEditableTarget(event.target)) {
        if (event.key === "Delete" || event.key === "Backspace") {
          event.preventDefault();
          deleteSelection();
          return;
        }
        if (event.key === "1") {
          event.preventDefault();
          setNodeType("destination");
          return;
        }
        if (event.key === "2") {
          event.preventDefault();
          setNodeType("waypoint");
          return;
        }
        if (event.key === "3") {
          event.preventDefault();
          setNodeType("charge_station");
          return;
        }
        if (event.key === "4") {
          event.preventDefault();
          setNodeType("waiting_position");
          return;
        }
        if (event.key.toLowerCase() === "e") {
          event.preventDefault();
          toggleEdgeMode();
        }
      }
    }

    function onKeyUp(event: KeyboardEvent) {
      if (event.key === " ") {
        setSpacePressed(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [
    copySelection,
    pendingNodeHeadingId,
    deleteSelection,
    pasteClipboardAt,
    redo,
    screenMode,
    selectAll,
    setNodeType,
    toggleEdgeMode,
    undo,
  ]);

  return (
    <div className="app-shell">
      <input
        ref={mapInputRef}
        hidden
        type="file"
        accept=".yaml,.yml,.pgm"
        multiple
        onChange={handleMapUpload}
      />
      <input
        ref={jsonInputRef}
        hidden
        type="file"
        accept="application/json,.json"
        onChange={handleJsonLoad}
      />

      <AutoSaveBridge paused={Boolean(draftOffer || pendingNodeHeading)} />

      {screenMode === "editor" ? (
        <ToolbarContainer
          onUploadMap={() => mapInputRef.current?.click()}
          onLoadJson={() => jsonInputRef.current?.click()}
          onSaveJson={handleJsonSave}
          onOpenSimulator={handleOpenSimulator}
          onUndo={undo}
          onRedo={redo}
          onSetNodeType={setNodeType}
          onToggleEdgeMode={toggleEdgeMode}
          onCommitResolution={handleResolutionCommit}
        />
      ) : (
        <SimulatorScreen
          mapRaster={mapRaster}
          showNodeLabels={simulatorShowNodeLabels}
          showEdgeLabels={simulatorShowEdgeLabels}
          onToggleNodeLabels={() => setSimulatorShowNodeLabels((current) => !current)}
          onToggleEdgeLabels={() => setSimulatorShowEdgeLabels((current) => !current)}
          onBackToEditor={handleReturnToEditor}
          onShowInfo={(text) => setMessage({ type: "info", text })}
          onShowError={(text) => setMessage({ type: "error", text })}
        />
      )}

      {draftOffer ? (
        <RecoveryBanner
          draft={draftOffer}
          onRestore={handleRestoreDraft}
          onDiscard={handleDiscardDraft}
        />
      ) : null}

      {screenMode === "editor" ? (
        <div className="workspace">
          <div className="workspace-main">
            <TopologyCanvas
              viewportRef={viewportRef}
              mapRaster={mapRaster}
              spacePressed={spacePressed}
              pendingNodeHeadingId={pendingNodeHeadingId}
              onCreateNodeAt={startNodeCreation}
              onOpenNodeEditor={setEditingNodeId}
              onOpenContextMenu={setContextMenu}
              onCancelNodeHeading={() => cancelPendingNodeHeading()}
              onCommitNodeHeading={(nodeId, headingRad) => commitPendingNodeHeading(nodeId, headingRad)}
            />
            <StatusBarContainer mapRaster={mapRaster} />
          </div>
          <InspectorContainer
            mapRaster={mapRaster}
            onOpenNodeEditor={(nodeId) => setEditingNodeId(nodeId)}
            onShowError={(text) => setMessage({ type: "error", text })}
            onFitScene={fitScene}
          />
        </div>
      ) : null}

      {message ? <div className={`notice notice-${message.type}`}>{message.text}</div> : null}

      {screenMode === "editor" && contextMenu ? (
        <ContextMenuContainer
          menu={contextMenu}
          onClose={() => setContextMenu(null)}
          onCreateNode={handleCreateNodeFromContext}
          onPasteAt={(world) => {
            pasteClipboardAt(world);
            setContextMenu(null);
          }}
          onEditNode={(nodeId) => {
            setEditingNodeId(nodeId);
            setContextMenu(null);
          }}
          onShowError={(text) => setMessage({ type: "error", text })}
          onAfterAction={() => setContextMenu(null)}
        />
      ) : null}

      {screenMode === "editor" ? (
        <NodeEditorDialogContainer
          nodeId={editingNodeId}
          onClose={() => setEditingNodeId(null)}
          onSave={handleNodeDialogSave}
        />
      ) : null}
    </div>
  );
}

type AutoSaveBridgeProps = {
  paused: boolean;
};

function AutoSaveBridge(props: AutoSaveBridgeProps) {
  const document = useEditorStore((state) => state.document);
  const view = useEditorStore((state) => state.view);

  useEffect(() => {
    if (props.paused) {
      return;
    }

    const timeout = window.setTimeout(() => {
      writeLocalDraft({
        version: 1,
        savedAt: new Date().toISOString(),
        document,
        view,
      });
    }, 400);

    return () => window.clearTimeout(timeout);
  }, [document, props.paused, view]);

  return null;
}

function ToolbarContainer(
  props: Omit<
    ComponentProps<typeof Toolbar>,
    | "nodeType"
    | "edgeMode"
    | "resolution"
    | "showNodeLabels"
    | "showEdgeLabels"
    | "canUndo"
    | "canRedo"
    | "nodeCount"
    | "edgeCount"
    | "mapLabel"
    | "canOpenSimulator"
    | "onToggleNodeLabels"
    | "onToggleEdgeLabels"
  >,
) {
  const document = useEditorStore((state) => state.document);
  const nodeType = useEditorStore((state) => state.nodeType);
  const edgeMode = useEditorStore((state) => state.edgeMode);
  const resolution = useEditorStore((state) => state.document.map.resolution);
  const showNodeLabels = useEditorStore((state) => state.view.showNodeLabels);
  const showEdgeLabels = useEditorStore((state) => state.view.showEdgeLabels);
  const canUndo = useEditorStore((state) => state.historyPast.length > 0);
  const canRedo = useEditorStore((state) => state.historyFuture.length > 0);
  const patchView = useEditorStore((state) => state.patchView);
  const canOpenSimulator = Boolean(
    document.map.image ||
      document.nodes.length > 0 ||
      document.edges.length > 0,
  );

  return (
    <Toolbar
      {...props}
      nodeType={nodeType}
      edgeMode={edgeMode}
      resolution={resolution}
      showNodeLabels={showNodeLabels}
      showEdgeLabels={showEdgeLabels}
      canOpenSimulator={canOpenSimulator}
      canUndo={canUndo}
      canRedo={canRedo}
      nodeCount={document.nodes.length}
      edgeCount={document.edges.length}
      mapLabel={document.map.image}
      onToggleNodeLabels={() => patchView({ showNodeLabels: !showNodeLabels })}
      onToggleEdgeLabels={() => patchView({ showEdgeLabels: !showEdgeLabels })}
    />
  );
}

type InspectorContainerProps = {
  mapRaster: MapRaster | null;
  onOpenNodeEditor: (nodeId: string) => void;
  onShowError: (text: string) => void;
  onFitScene: () => void;
};

function InspectorContainer(props: InspectorContainerProps) {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const updateNode = useEditorStore((state) => state.updateNode);
  const toggleEdgeDirection = useEditorStore((state) => state.toggleEdgeDirection);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);

  const selectedNode = useMemo(() => {
    if (selection.nodeIds.length !== 1 || selection.edgeIds.length !== 0) {
      return null;
    }

    return document.nodes.find((node) => node.id === selection.nodeIds[0]) ?? null;
  }, [document.nodes, selection.edgeIds.length, selection.nodeIds]);

  const selectedEdge = useMemo(() => {
    if (selection.edgeIds.length !== 1 || selection.nodeIds.length !== 0) {
      return null;
    }

    return document.edges.find((edge) => edge.id === selection.edgeIds[0]) ?? null;
  }, [document.edges, selection.edgeIds, selection.nodeIds.length]);

  return (
    <InspectorPanel
      document={document}
      selection={selection}
      selectedNode={selectedNode}
      selectedEdge={selectedEdge}
      mapRaster={props.mapRaster}
      onUpdateNode={(nodeId, name, type, headingRad) => {
        const result = updateNode(nodeId, { name, type, headingRad });
        if (!result.ok) {
          props.onShowError(result.error);
        }
      }}
      onOpenNodeEditor={() => {
        if (selectedNode) {
          props.onOpenNodeEditor(selectedNode.id);
        }
      }}
      onToggleEdgeDirection={toggleEdgeDirection}
      onDeleteSelection={deleteSelection}
      onFitScene={props.onFitScene}
    />
  );
}

type StatusBarContainerProps = {
  mapRaster: MapRaster | null;
};

function StatusBarContainer(props: StatusBarContainerProps) {
  const mouseWorld = useEditorStore((state) => state.mouseWorld);
  const zoom = useEditorStore((state) => state.view.zoom);
  const document = useEditorStore((state) => state.document);
  const scaleDistance = getNiceDistance(140 / zoom);
  const scaleWidthPx = Math.max(40, scaleDistance * zoom);
  const mapLabel = props.mapRaster && mapMatchesDocument(document, props.mapRaster)
    ? props.mapRaster.name
    : null;

  return (
    <StatusBar
      mouseWorld={mouseWorld}
      zoom={zoom}
      scaleDistance={scaleDistance}
      scaleWidthPx={scaleWidthPx}
      nodeCount={document.nodes.length}
      edgeCount={document.edges.length}
      mapLabel={mapLabel}
    />
  );
}

type ContextMenuContainerProps = {
  menu: ContextMenuState;
  onClose: () => void;
  onCreateNode: (type: NodeType, world: Point) => void;
  onPasteAt: (world: Point) => void;
  onEditNode: (nodeId: string) => void;
  onShowError: (text: string) => void;
  onAfterAction: () => void;
};

function ContextMenuContainer(props: ContextMenuContainerProps) {
  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const clipboard = useEditorStore((state) => state.clipboard);
  const updateNode = useEditorStore((state) => state.updateNode);
  const toggleEdgeDirection = useEditorStore((state) => state.toggleEdgeDirection);
  const copySelection = useEditorStore((state) => state.copySelection);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);
  const selectionCount = selection.nodeIds.length + selection.edgeIds.length;

  return (
    <ContextMenuView
      menu={props.menu}
      document={document}
      canPaste={Boolean(clipboard)}
      selectionCount={selectionCount}
      onClose={props.onClose}
      onCreateNode={props.onCreateNode}
      onPaste={() => props.onPasteAt(props.menu.target.world)}
      onEditNode={props.onEditNode}
      onChangeNodeType={(nodeId, nextType) => {
        const result = updateNode(nodeId, { type: nextType });
        if (!result.ok) {
          props.onShowError(result.error);
        }
        props.onAfterAction();
      }}
      onCopy={() => {
        copySelection();
        props.onAfterAction();
      }}
      onDelete={() => {
        deleteSelection();
        props.onAfterAction();
      }}
      onToggleEdgeDirection={(edgeId) => {
        toggleEdgeDirection(edgeId);
        props.onAfterAction();
      }}
    />
  );
}

type NodeEditorDialogContainerProps = {
  nodeId: string | null;
  onClose: () => void;
  onSave: (name: string, type: NodeType, headingRad: number | null) => void;
};

function NodeEditorDialogContainer(props: NodeEditorDialogContainerProps) {
  const node = useEditorStore((state) =>
    props.nodeId ? state.document.nodes.find((item) => item.id === props.nodeId) ?? null : null,
  );

  if (!node) {
    return null;
  }

  return <NodeEditorDialog node={node} onClose={props.onClose} onSave={props.onSave} />;
}

function documentCreateAnchor(url: string, fileName: string) {
  const anchor = window.document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  window.document.body.appendChild(anchor);
  return anchor;
}

function formatDateStamp() {
  const now = new Date();
  return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}${String(now.getDate()).padStart(2, "0")}-${String(now.getHours()).padStart(2, "0")}${String(now.getMinutes()).padStart(2, "0")}`;
}

function isEditableTarget(target: EventTarget | null) {
  return target instanceof HTMLElement && (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.tagName === "SELECT" ||
    target.isContentEditable
  );
}

export default App;
