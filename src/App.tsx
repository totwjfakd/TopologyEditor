import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  type WheelEvent as ReactWheelEvent,
} from "react";
import type {
  ContextMenuState,
  MapRaster,
  NodeType,
  Point,
  SelectionBox,
  SelectionState,
  TopologyDocument,
  TopologyEdge,
  TopologyNode,
  ViewState,
} from "./types";
import { NODE_TYPE_META, NODE_TYPE_ORDER } from "./types";
import { useEditorStore } from "./store/editorStore";
import {
  clampZoom,
  documentBounds,
  fitViewToBounds,
  getNiceDistance,
  pointInBounds,
  screenDeltaToWorld,
  screenToWorld,
  selectionBoxToBounds,
  worldToScreen,
} from "./utils/geometry";
import {
  cloneDocument,
  createNodeRecord,
  getEdgeDistance,
  roundMeters,
  sanitizeLoadedDocument,
} from "./utils/topology";
import {
  fileBaseName,
  matchMapFiles,
  parseMapYamlFile,
  parsePgmFile,
} from "./utils/mapFiles";

type Message = {
  type: "error" | "info";
  text: string;
};

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

type LocalDraft = {
  version: 1;
  savedAt: string;
  document: TopologyDocument;
  view: ViewState;
};

const LOCAL_DRAFT_KEY = "fms-roi-topology-editor.local-draft.v1";

const FALLBACK_VIEW: ViewState = {
  zoom: 24,
  panX: 480,
  panY: 360,
};

function App() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const mapInputRef = useRef<HTMLInputElement>(null);
  const jsonInputRef = useRef<HTMLInputElement>(null);

  const setNodeType = useEditorStore((state) => state.setNodeType);
  const toggleEdgeMode = useEditorStore((state) => state.toggleEdgeMode);
  const setView = useEditorStore((state) => state.setView);
  const commitDocument = useEditorStore((state) => state.commitDocument);
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
  const [spacePressed, setSpacePressed] = useState(false);
  const [draftOffer, setDraftOffer] = useState<LocalDraft | null>(() => readLocalDraft());

  const editingNodeExists = useEditorStore((state) =>
    editingNodeId ? state.document.nodes.some((node) => node.id === editingNodeId) : false,
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

    setView(
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
      loadDocument(nextDocument);
      setMapRaster(null);
      setMessage({
        type: "info",
        text: nextDocument.map.image
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
    const currentDocument = useEditorStore.getState().document;
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

  function handleNodeDialogSave(name: string, type: NodeType) {
    if (!editingNodeId) {
      return;
    }

    const result = updateNode(editingNodeId, { name, type });
    if (!result.ok) {
      setMessage({ type: "error", text: result.error });
      return;
    }

    setEditingNodeId(null);
  }

  function handleCreateNodeFromContext(type: NodeType, world: Point) {
    const currentDocument = useEditorStore.getState().document;
    const nextDocument = cloneDocument(currentDocument);
    const node = createNodeRecord(nextDocument, world, type);
    nextDocument.nodes.push(node);
    commitDocument(nextDocument, { nodeIds: [node.id], edgeIds: [] });
    setContextMenu(null);
  }

  function handleRestoreDraft() {
    if (!draftOffer) {
      return;
    }

    loadDocument(draftOffer.document);
    setView(draftOffer.view);
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
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === " " && !isEditableTarget(event.target)) {
        setSpacePressed(true);
        event.preventDefault();
      }

      const hotkey = event.ctrlKey || event.metaKey;
      if (hotkey) {
        const lowerKey = event.key.toLowerCase();
        if (lowerKey === "z") {
          event.preventDefault();
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
    deleteSelection,
    pasteClipboardAt,
    redo,
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

      <AutoSaveBridge paused={Boolean(draftOffer)} />

      <ToolbarContainer
        onUploadMap={() => mapInputRef.current?.click()}
        onLoadJson={() => jsonInputRef.current?.click()}
        onSaveJson={handleJsonSave}
        onUndo={undo}
        onRedo={redo}
        onSetNodeType={setNodeType}
        onToggleEdgeMode={toggleEdgeMode}
        onCommitResolution={handleResolutionCommit}
      />

      {draftOffer ? (
        <RecoveryBanner
          draft={draftOffer}
          onRestore={handleRestoreDraft}
          onDiscard={handleDiscardDraft}
        />
      ) : null}

      <div className="workspace">
        <TopologyCanvas
          viewportRef={viewportRef}
          mapRaster={mapRaster}
          spacePressed={spacePressed}
          onOpenNodeEditor={setEditingNodeId}
          onOpenContextMenu={setContextMenu}
        />
        <InspectorContainer
          mapRaster={mapRaster}
          onOpenNodeEditor={(nodeId) => setEditingNodeId(nodeId)}
          onShowError={(text) => setMessage({ type: "error", text })}
          onFitScene={fitScene}
        />
      </div>

      <StatusBarContainer mapRaster={mapRaster} />

      {message ? <div className={`notice notice-${message.type}`}>{message.text}</div> : null}

      {contextMenu ? (
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

      <NodeEditorDialogContainer
        nodeId={editingNodeId}
        onClose={() => setEditingNodeId(null)}
        onSave={handleNodeDialogSave}
      />
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

type RecoveryBannerProps = {
  draft: LocalDraft;
  onRestore: () => void;
  onDiscard: () => void;
};

function RecoveryBanner(props: RecoveryBannerProps) {
  return (
    <div className="draft-banner">
      <div className="draft-banner-copy">
        <strong>이전 작업 임시저장본이 있습니다.</strong>
        <span>{formatDraftTimestamp(props.draft.savedAt)}에 저장됨</span>
      </div>
      <div className="draft-banner-actions">
        <button type="button" className="ghost-button compact" onClick={props.onRestore}>
          복원
        </button>
        <button type="button" className="ghost-button compact" onClick={props.onDiscard}>
          버리기
        </button>
      </div>
    </div>
  );
}

function ToolbarContainer(
  props: Omit<ToolbarProps, "nodeType" | "edgeMode" | "resolution" | "canUndo" | "canRedo">,
) {
  const nodeType = useEditorStore((state) => state.nodeType);
  const edgeMode = useEditorStore((state) => state.edgeMode);
  const resolution = useEditorStore((state) => state.document.map.resolution);
  const canUndo = useEditorStore((state) => state.historyPast.length > 0);
  const canRedo = useEditorStore((state) => state.historyFuture.length > 0);

  return (
    <Toolbar
      {...props}
      nodeType={nodeType}
      edgeMode={edgeMode}
      resolution={resolution}
      canUndo={canUndo}
      canRedo={canRedo}
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
      onUpdateNode={(nodeId, name, type) => {
        const result = updateNode(nodeId, { name, type });
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
  const clipboard = useEditorStore((state) => state.clipboard);
  const updateNode = useEditorStore((state) => state.updateNode);
  const toggleEdgeDirection = useEditorStore((state) => state.toggleEdgeDirection);
  const copySelection = useEditorStore((state) => state.copySelection);
  const deleteSelection = useEditorStore((state) => state.deleteSelection);

  return (
    <ContextMenuView
      menu={props.menu}
      document={document}
      canPaste={Boolean(clipboard)}
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
  onSave: (name: string, type: NodeType) => void;
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

type ToolbarProps = {
  nodeType: NodeType;
  edgeMode: boolean;
  resolution: number;
  canUndo: boolean;
  canRedo: boolean;
  onUploadMap: () => void;
  onLoadJson: () => void;
  onSaveJson: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onSetNodeType: (type: NodeType) => void;
  onToggleEdgeMode: () => void;
  onCommitResolution: (value: number) => void;
};

function Toolbar(props: ToolbarProps) {
  const [resolutionInput, setResolutionInput] = useState(String(props.resolution));

  useEffect(() => {
    setResolutionInput(String(props.resolution));
  }, [props.resolution]);

  return (
    <header className="toolbar">
      <div className="toolbar-group toolbar-brand">
        <div>
          <div className="toolbar-kicker">FMS ROI Research</div>
          <h1>Topology Map Editor</h1>
        </div>
      </div>

      <div className="toolbar-group toolbar-actions">
        <button type="button" className="ghost-button" onClick={props.onUploadMap}>
          Map Upload
        </button>
        <button type="button" className="ghost-button" onClick={props.onLoadJson}>
          JSON Load
        </button>
        <button type="button" className="ghost-button" onClick={props.onSaveJson}>
          JSON Save
        </button>
        <button type="button" className="ghost-button" onClick={props.onUndo} disabled={!props.canUndo}>
          Undo
        </button>
        <button type="button" className="ghost-button" onClick={props.onRedo} disabled={!props.canRedo}>
          Redo
        </button>
      </div>

      <div className="toolbar-group toolbar-types">
        {NODE_TYPE_ORDER.map((type) => {
          const meta = NODE_TYPE_META[type];
          return (
            <button
              key={type}
              type="button"
              className={`type-button ${props.nodeType === type ? "is-active" : ""}`}
              onClick={() => props.onSetNodeType(type)}
              style={{ ["--type-color" as string]: meta.color }}
            >
              <span>{meta.label}</span>
              <kbd>{meta.key}</kbd>
            </button>
          );
        })}
        <button
          type="button"
          className={`edge-toggle ${props.edgeMode ? "is-active" : ""}`}
          onClick={props.onToggleEdgeMode}
        >
          Edge Mode <kbd>E</kbd>
        </button>
      </div>

      <div className="toolbar-group toolbar-resolution">
        <label>
          <span>Resolution</span>
          <input
            value={resolutionInput}
            onChange={(event) => setResolutionInput(event.target.value)}
            onBlur={() => props.onCommitResolution(Number(resolutionInput))}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                props.onCommitResolution(Number(resolutionInput));
              }
            }}
          />
          <em>m/px</em>
        </label>
      </div>
    </header>
  );
}

type InspectorProps = {
  document: TopologyDocument;
  selection: SelectionState;
  selectedNode: TopologyNode | null;
  selectedEdge: TopologyEdge | null;
  mapRaster: MapRaster | null;
  onUpdateNode: (nodeId: string, name: string, type: NodeType) => void;
  onOpenNodeEditor: () => void;
  onToggleEdgeDirection: (edgeId: string) => void;
  onDeleteSelection: () => void;
  onFitScene: () => void;
};

function InspectorPanel(props: InspectorProps) {
  const [name, setName] = useState("");
  const [type, setType] = useState<NodeType>("destination");

  useEffect(() => {
    if (props.selectedNode) {
      setName(props.selectedNode.name);
      setType(props.selectedNode.type);
    }
  }, [props.selectedNode]);

  return (
    <aside className="inspector">
      <section className="panel">
        <div className="panel-header">
          <h2>Scene</h2>
          <button type="button" className="ghost-button compact" onClick={props.onFitScene}>
            Fit View
          </button>
        </div>
        <dl className="inspector-list">
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
            <dt>Counts</dt>
            <dd>
              {props.document.nodes.length} nodes / {props.document.edges.length} edges
            </dd>
          </div>
        </dl>
      </section>

      <section className="panel">
        <div className="panel-header">
          <h2>Selection</h2>
          <button type="button" className="ghost-button compact" onClick={props.onDeleteSelection}>
            Delete
          </button>
        </div>
        {props.selectedNode ? (
          <div className="inspector-form">
            <label>
              <span>Name</span>
              <input value={name} onChange={(event) => setName(event.target.value)} />
            </label>
            <label>
              <span>Type</span>
              <select value={type} onChange={(event) => setType(event.target.value as NodeType)}>
                {NODE_TYPE_ORDER.map((nodeType) => (
                  <option key={nodeType} value={nodeType}>
                    {NODE_TYPE_META[nodeType].label}
                  </option>
                ))}
              </select>
            </label>
            <div className="inline-metrics">
              <span>X {props.selectedNode.x.toFixed(2)} m</span>
              <span>Y {props.selectedNode.y.toFixed(2)} m</span>
            </div>
            <div className="inspector-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={() => props.onUpdateNode(props.selectedNode!.id, name, type)}
              >
                Apply
              </button>
              <button type="button" className="ghost-button" onClick={props.onOpenNodeEditor}>
                Open Dialog
              </button>
            </div>
          </div>
        ) : null}

        {props.selectedEdge ? (
          <div className="inspector-form">
            <div className="inline-metrics">
              <span>Distance {props.selectedEdge.distance_m.toFixed(2)} m</span>
              <span>{props.selectedEdge.direction}</span>
            </div>
            <button
              type="button"
              className="ghost-button"
              onClick={() => props.onToggleEdgeDirection(props.selectedEdge!.id)}
            >
              Toggle Direction
            </button>
          </div>
        ) : null}

        {!props.selectedNode && !props.selectedEdge ? (
          <p className="empty-copy">
            Select a node or edge to inspect properties. Double click a node to open quick edit.
          </p>
        ) : null}
      </section>
    </aside>
  );
}

type StatusBarProps = {
  mouseWorld: Point;
  zoom: number;
  scaleDistance: number;
  scaleWidthPx: number;
  nodeCount: number;
  edgeCount: number;
  mapLabel: string | null;
};

function StatusBar(props: StatusBarProps) {
  return (
    <footer className="statusbar">
      <div className="status-group">
        <span>
          x: {props.mouseWorld.x.toFixed(2)}m y: {props.mouseWorld.y.toFixed(2)}m
        </span>
        <span>Zoom {Math.round((props.zoom / 24) * 100)}%</span>
        <span>
          {props.nodeCount} nodes / {props.edgeCount} edges
        </span>
        {props.mapLabel ? <span>{props.mapLabel}</span> : <span>Grid mode available</span>}
      </div>
      <div className="scale-bar-wrap">
        <span>{props.scaleDistance.toFixed(props.scaleDistance < 1 ? 2 : 0)} m</span>
        <div className="scale-bar" style={{ width: `${props.scaleWidthPx}px` }} />
      </div>
    </footer>
  );
}

type ContextMenuViewProps = {
  menu: ContextMenuState;
  document: TopologyDocument;
  canPaste: boolean;
  onClose: () => void;
  onCreateNode: (type: NodeType, world: Point) => void;
  onPaste: () => void;
  onEditNode: (nodeId: string) => void;
  onChangeNodeType: (nodeId: string, type: NodeType) => void;
  onCopy: () => void;
  onDelete: () => void;
  onToggleEdgeDirection: (edgeId: string) => void;
};

function ContextMenuView(props: ContextMenuViewProps) {
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

  return (
    <div className="context-menu" style={menuStyle} onPointerDown={(event) => event.stopPropagation()}>
      {props.menu.target.kind === "canvas" ? (
        <>
          <div className="menu-title">Create Node</div>
          {NODE_TYPE_ORDER.map((type) => (
            <button key={type} type="button" onClick={() => props.onCreateNode(type, props.menu.target.world)}>
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
          <div className="menu-title">{targetNode.name}</div>
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
          <button type="button" onClick={props.onDelete}>
            Delete
          </button>
        </>
      ) : null}

      {targetEdge ? (
        <>
          <div className="menu-title">Edge</div>
          <button type="button" onClick={() => props.onToggleEdgeDirection(targetEdge.id)}>
            Toggle Direction
          </button>
          <button type="button" onClick={props.onDelete}>
            Delete
          </button>
        </>
      ) : null}

      <button type="button" className="menu-dismiss" onClick={props.onClose}>
        Close
      </button>
    </div>
  );
}

type NodeEditorDialogProps = {
  node: TopologyNode;
  onClose: () => void;
  onSave: (name: string, type: NodeType) => void;
};

function NodeEditorDialog(props: NodeEditorDialogProps) {
  const [name, setName] = useState(props.node.name);
  const [type, setType] = useState<NodeType>(props.node.type);

  useEffect(() => {
    setName(props.node.name);
    setType(props.node.type);
  }, [props.node]);

  return (
    <div className="dialog-backdrop" onPointerDown={props.onClose}>
      <div className="dialog" onPointerDown={(event) => event.stopPropagation()}>
        <div className="panel-header">
          <h2>Node Properties</h2>
          <button type="button" className="ghost-button compact" onClick={props.onClose}>
            Close
          </button>
        </div>
        <label>
          <span>Name</span>
          <input value={name} onChange={(event) => setName(event.target.value)} autoFocus />
        </label>
        <label>
          <span>Type</span>
          <select value={type} onChange={(event) => setType(event.target.value as NodeType)}>
            {NODE_TYPE_ORDER.map((nodeType) => (
              <option key={nodeType} value={nodeType}>
                {NODE_TYPE_META[nodeType].label}
              </option>
            ))}
          </select>
        </label>
        <div className="inline-metrics">
          <span>X {props.node.x.toFixed(2)} m</span>
          <span>Y {props.node.y.toFixed(2)} m</span>
        </div>
        <div className="inspector-actions">
          <button type="button" className="ghost-button" onClick={() => props.onSave(name, type)}>
            Save
          </button>
        </div>
      </div>
    </div>
  );
}

type TopologyCanvasProps = {
  viewportRef: RefObject<HTMLDivElement>;
  mapRaster: MapRaster | null;
  spacePressed: boolean;
  onOpenNodeEditor: (nodeId: string) => void;
  onOpenContextMenu: (menu: ContextMenuState | null) => void;
};

function TopologyCanvas(props: TopologyCanvasProps) {
  const backgroundCanvasRef = useRef<HTMLCanvasElement>(null);

  const document = useEditorStore((state) => state.document);
  const selection = useEditorStore((state) => state.selection);
  const view = useEditorStore((state) => state.view);
  const edgeMode = useEditorStore((state) => state.edgeMode);

  const setView = useEditorStore((state) => state.setView);
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
    drawBackgroundCanvas(backgroundCanvasRef.current, props.viewportRef.current, view, document, props.mapRaster);
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
      setView({
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
  }, [clearSelection, commitFrom, props.viewportRef, replaceDocument, setMouseWorld, setSelection, setView]);

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
    setView({
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
    setSelection({ nodeIds: [node.id], edgeIds: [] });
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
    setSelection({ nodeIds: [], edgeIds: [edge.id] });
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
            <path d="M 0 0 L 12 6 L 0 12 z" fill="#1f2937" />
          </marker>
          <marker id="arrow-selected" viewBox="0 0 12 12" refX="10" refY="6" markerWidth="8" markerHeight="8" orient="auto-start-reverse">
            <path d="M 0 0 L 12 6 L 0 12 z" fill="#f97316" />
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
              <rect x={midX - 28} y={midY - 12} width="56" height="20" rx="10" className="edge-label-bg" />
              <text x={midX} y={midY + 3} textAnchor="middle" className="edge-label">
                {edge.distance_m.toFixed(2)}m
              </text>
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
              <circle r={selected || pending ? 17 : 14} className="node-ring" style={{ fill: `${color}22`, stroke: color }} />
              <circle r="9" className="node-core" style={{ fill: color }} />
              <text x="18" y="-16" className="node-tag">{node.name}</text>
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
          {document.edges.find((edge) => edge.id === hoveredEdgeId)?.direction}
        </div>
      ) : null}

      <div className="canvas-overlay-hint">
        {edgeMode ? "Edge mode: click A then B, or drag A to B" : "Double click empty space to add node"}
      </div>
      <div className="canvas-overlay-corner">
        {pendingEdgeFromId ? "Pending edge source selected" : edgeMode ? "Edge mode" : "Node mode"}
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
  context.fillStyle = "#f5f1e7";
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
  context.strokeStyle = "rgba(15, 23, 42, 0.08)";
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

  context.strokeStyle = "rgba(15, 23, 42, 0.15)";
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
    context.globalAlpha = 0.95;
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

function shouldPersistLocalDraft(document: TopologyDocument) {
  return Boolean(
    document.map.image ||
      document.nodes.length > 0 ||
      document.edges.length > 0,
  );
}

function sanitizeDraftView(view: unknown): ViewState {
  if (!view || typeof view !== "object") {
    return FALLBACK_VIEW;
  }

  const candidate = view as Partial<ViewState>;
  const zoom = typeof candidate.zoom === "number" && Number.isFinite(candidate.zoom)
    ? candidate.zoom
    : FALLBACK_VIEW.zoom;
  const panX = typeof candidate.panX === "number" && Number.isFinite(candidate.panX)
    ? candidate.panX
    : FALLBACK_VIEW.panX;
  const panY = typeof candidate.panY === "number" && Number.isFinite(candidate.panY)
    ? candidate.panY
    : FALLBACK_VIEW.panY;

  return { zoom, panX, panY };
}

function readLocalDraft(): LocalDraft | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(LOCAL_DRAFT_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as Partial<LocalDraft> & {
      document?: unknown;
      view?: unknown;
    };
    if (parsed.version !== 1 || !parsed.document) {
      clearLocalDraft();
      return null;
    }

    const document = sanitizeLoadedDocument(parsed.document);
    if (!shouldPersistLocalDraft(document)) {
      clearLocalDraft();
      return null;
    }

    return {
      version: 1,
      savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : new Date().toISOString(),
      document,
      view: sanitizeDraftView(parsed.view),
    };
  } catch {
    clearLocalDraft();
    return null;
  }
}

function writeLocalDraft(draft: LocalDraft) {
  if (typeof window === "undefined") {
    return;
  }

  if (!shouldPersistLocalDraft(draft.document)) {
    clearLocalDraft();
    return;
  }

  window.localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(draft));
}

function clearLocalDraft() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(LOCAL_DRAFT_KEY);
}

function formatDraftTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "알 수 없는 시각";
  }

  return date.toLocaleString();
}

function mapMatchesDocument(document: TopologyDocument, raster: MapRaster | null): boolean {
  return Boolean(raster && fileBaseName(document.map.image) === fileBaseName(raster.name));
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

export default App;
