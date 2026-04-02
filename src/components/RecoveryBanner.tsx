import type { LocalDraft } from "../utils/localDraft";
import { formatDraftTimestamp } from "../utils/localDraft";

export type RecoveryBannerProps = {
  draft: LocalDraft;
  onRestore: () => void;
  onDiscard: () => void;
};

export function RecoveryBanner(props: RecoveryBannerProps) {
  return (
    <div className="draft-banner" role="status">
      <div className="draft-banner-copy">
        <strong>이전 작업 임시저장본이 있습니다.</strong>
        <span>{formatDraftTimestamp(props.draft.savedAt)}에 저장됨</span>
      </div>
      <div className="draft-banner-actions">
        <button type="button" className="ghost-button" onClick={props.onRestore}>
          복원
        </button>
        <button type="button" className="ghost-button danger" onClick={props.onDiscard}>
          버리기
        </button>
      </div>
    </div>
  );
}
