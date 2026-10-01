import { StatusBadge, type StatusTone } from "@/components/common/status-badge";
import { PROCESSING_LABELS, REVIEW_LABELS, VALIDITY_LABELS } from "@/lib/domain/labels";
import type {
  DocumentAIDataClass,
  DocumentAIIndexStatus,
  DocumentProcessingState,
  DocumentReviewStatus,
  DocumentValidity,
} from "@/lib/domain/types";

const VALIDITY_TONES: Record<DocumentValidity, StatusTone> = {
  valid: "success",
  expiring: "warning",
  expired: "danger",
  upcoming: "info",
};

const PROCESSING_TONES: Record<DocumentProcessingState, StatusTone> = {
  queued: "info",
  ready: "neutral",
  processing: "info",
  failed: "danger",
};

export function ValidityBadge({
  validity,
  className,
}: {
  validity: DocumentValidity;
  className?: string;
}) {
  return (
    <StatusBadge tone={VALIDITY_TONES[validity]} className={className}>
      {VALIDITY_LABELS[validity]}
    </StatusBadge>
  );
}

export function ProcessingBadge({ state }: { state: DocumentProcessingState }) {
  return <StatusBadge tone={PROCESSING_TONES[state]}>{PROCESSING_LABELS[state]}</StatusBadge>;
}

const REVIEW_TONES: Record<DocumentReviewStatus, StatusTone> = {
  pending: "warning",
  approved: "success",
  rejected: "danger",
  archived: "neutral",
};

export function ReviewBadge({ status }: { status: DocumentReviewStatus }) {
  return <StatusBadge tone={REVIEW_TONES[status]}>{REVIEW_LABELS[status]}</StatusBadge>;
}

/** Whether the document may be used by OpenAI, and its indexing state. */
export function AIBadge({
  dataClass,
  indexStatus,
}: {
  dataClass: DocumentAIDataClass;
  indexStatus: DocumentAIIndexStatus;
}) {
  if (dataClass === "synthetic") return <StatusBadge tone="neutral">Syntetiskt test</StatusBadge>;
  if (dataClass === "internal") return <StatusBadge tone="neutral">OpenAI: ej godkänt</StatusBadge>;
  if (indexStatus === "failed") return <StatusBadge tone="danger">OpenAI: indexeringsfel</StatusBadge>;
  if (indexStatus === "ready") return <StatusBadge tone="success">OpenAI: godkänt</StatusBadge>;
  return <StatusBadge tone="info">OpenAI: indexeras</StatusBadge>;
}
