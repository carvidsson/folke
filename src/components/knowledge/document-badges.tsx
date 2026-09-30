import { StatusBadge, type StatusTone } from "@/components/common/status-badge";
import { PROCESSING_LABELS, VALIDITY_LABELS } from "@/lib/domain/labels";
import type { DocumentProcessingState, DocumentValidity } from "@/lib/domain/types";

const VALIDITY_TONES: Record<DocumentValidity, StatusTone> = {
  valid: "success",
  expiring: "warning",
  expired: "danger",
  upcoming: "info",
};

const PROCESSING_TONES: Record<DocumentProcessingState, StatusTone> = {
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
