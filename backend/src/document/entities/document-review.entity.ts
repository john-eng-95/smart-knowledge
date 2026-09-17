import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import { bigintTransformer } from '../../common/transformers/bigint.transformer';

/** Review result: 1 approved, 2 rejected. */
export enum ReviewResult {
  Approved = 1,
  Rejected = 2,
}

/**
 * Document review record (PostgreSQL kh_document_review).
 *
 * Lifecycle: submitForReview creates it (review_result=null), then approve/reject closes it.
 * A document may have many historical records but at most one pending record.
 */
@Entity('kh_document_review')
export class DocumentReviewEntity {
  @PrimaryColumn({ type: 'bigint', transformer: bigintTransformer })
  id: string;

  @Column({
    name: 'document_id',
    type: 'bigint',
    transformer: bigintTransformer,
  })
  documentId: string;

  @Column({
    name: 'reviewer_id',
    type: 'bigint',
    nullable: true,
    transformer: bigintTransformer,
  })
  reviewerId?: string | null;

  @Column({ name: 'reviewer_name', type: 'varchar', nullable: true })
  reviewerName?: string | null;

  /** NULL=pending, 1=approved, 2=rejected. */
  @Column({ name: 'review_result', type: 'smallint', nullable: true })
  reviewResult?: ReviewResult | null;

  @Column({ name: 'review_comment', type: 'varchar', nullable: true })
  reviewComment?: string | null;

  /** Document status before review submission. */
  @Column({ name: 'before_status', type: 'smallint' })
  beforeStatus: number;

  @Column({ name: 'reviewed_at', type: 'timestamp', nullable: true })
  reviewedAt?: Date | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamp' })
  createdAt: Date;
}
