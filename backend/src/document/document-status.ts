/**
 * Document statuses and transition rules.
 *
 * Values match kh_document.status:
 * - 0 Draft: not searchable.
 * - 1 Published: written to RAG / Search / KG indexes.
 * - 2 Archived: indexes cleared while content is retained.
 * - 3 PendingReview: not indexed and published only after approval.
 *
 * Whether review is required is controlled by DOCUMENT_REQUIRE_APPROVAL (see DocumentReviewService).
 */
export enum DocumentStatus {
  /** Draft. */
  Draft = 0,
  /** Published. */
  Published = 1,
  /** Archived. */
  Archived = 2,
  /** Pending review (after submission and before review completes). */
  PendingReview = 3,
}

/** Display labels for document statuses. */
export const DOCUMENT_STATUS_LABEL: Record<DocumentStatus, string> = {
  [DocumentStatus.Draft]: 'Draft',
  [DocumentStatus.Published]: 'Published',
  [DocumentStatus.Archived]: 'Archived',
  [DocumentStatus.PendingReview]: 'Pending review',
};

/**
 * States allowed as the source for PUT publish.
 * Archived can be republished; PendingReview is rejected separately by publish.
 */
export function canPublishFrom(status: DocumentStatus): boolean {
  return (
    status === DocumentStatus.Draft ||
    status === DocumentStatus.Published ||
    status === DocumentStatus.Archived ||
    status === DocumentStatus.PendingReview
  );
}

/**
 * Whether PATCH may update content or title.
 * Content changes are forbidden during review; archived documents allow metadata-only edits.
 */
export function canEditContent(status: DocumentStatus): boolean {
  return (
    status === DocumentStatus.Draft ||
    status === DocumentStatus.Published ||
    status === DocumentStatus.Archived
  );
}

/** Only published documents can be archived. */
export function canArchive(status: DocumentStatus): boolean {
  return status === DocumentStatus.Published;
}

/** Draft or published documents can be submitted for review; published indexes are cleared first. */
export function canSubmitReview(status: DocumentStatus): boolean {
  return status === DocumentStatus.Draft || status === DocumentStatus.Published;
}
