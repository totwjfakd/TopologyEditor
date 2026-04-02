import type { TopologyDocument, ViewState } from "../types";
import { sanitizeLoadedDocument } from "./topology";
import { sanitizeViewState } from "./viewState";

export type LocalDraft = {
  version: 1;
  savedAt: string;
  document: TopologyDocument;
  view: ViewState;
};

const LOCAL_DRAFT_KEY = "fms-roi-topology-editor.local-draft.v1";

function shouldPersistLocalDraft(document: TopologyDocument) {
  return Boolean(
    document.map.image ||
      document.nodes.length > 0 ||
      document.edges.length > 0,
  );
}

export function readLocalDraft(): LocalDraft | null {
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
      view: sanitizeViewState(parsed.view),
    };
  } catch {
    clearLocalDraft();
    return null;
  }
}

export function writeLocalDraft(draft: LocalDraft) {
  if (typeof window === "undefined") {
    return;
  }

  if (!shouldPersistLocalDraft(draft.document)) {
    clearLocalDraft();
    return;
  }

  window.localStorage.setItem(LOCAL_DRAFT_KEY, JSON.stringify(draft));
}

export function clearLocalDraft() {
  if (typeof window === "undefined") {
    return;
  }

  window.localStorage.removeItem(LOCAL_DRAFT_KEY);
}

export function formatDraftTimestamp(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "알 수 없는 시각";
  }

  return date.toLocaleString();
}
