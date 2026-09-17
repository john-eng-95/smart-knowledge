import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectEntityManager } from '@nestjs/typeorm';
import { EntityManager, IsNull } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import { DocumentPipelinePublisher } from '../mq/document-pipeline.publisher';
import { canSubmitReview, DocumentStatus } from './document-status';
import { DocumentEntity } from './entities/document.entity';
import {
  DocumentReviewEntity,
  ReviewResult,
} from './entities/document-review.entity';
import { QueryReviewTasksDto } from './dto/review.dto';
import { AuthUser } from '../auth/auth-user.interface';
import { canWriteDocument } from './document-access';

/**
 * Document publication review service.
 *
 * Maps to kh_document_review: insert one record per submission and fill the result on approve/reject.
 * Controlled by DOCUMENT_REQUIRE_APPROVAL (true by default; when false, publish skips this service).
 */
@Injectable()
export class DocumentReviewService {
  private readonly logger = new Logger(DocumentReviewService.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    private readonly pipelinePublisher: DocumentPipelinePublisher,
    private readonly config: ConfigService,
  ) {}

  /** Whether publication review is enabled (true by default). */
  isRequireApproval(): boolean {
    return (
      this.config.get<string>('DOCUMENT_REQUIRE_APPROVAL', 'true') !== 'false'
    );
  }

  /**
   * Submit for review: Draft / Published -> PendingReview.
   * Clear indexes first when submitted from Published so it cannot be searched during review.
   */
  async submitForReview(
    documentId: string,
    actor?: AuthUser,
  ): Promise<DocumentEntity> {
    const doc = await this.findDocumentOrThrow(documentId);
    if (actor && !canWriteDocument(doc, actor)) {
      throw new ForbiddenException(
        'You do not have permission to submit this document for review.',
      );
    }

    if (!canSubmitReview(doc.status)) {
      throw new BadRequestException(
        'Only draft or published documents can be submitted for review.',
      );
    }

    const pending = await this.em.findOne(DocumentReviewEntity, {
      where: { documentId, reviewResult: IsNull() },
    });
    // A document can have only one pending review at a time.
    if (pending) {
      throw new BadRequestException(
        'This document already has a pending review.',
      );
    }

    const beforeStatus = doc.status;
    // Write the review record; a null review_result means pending.
    const review = this.em.create(DocumentReviewEntity, {
      id: nextSnowflakeId(),
      documentId,
      beforeStatus,
    });
    await this.em.save(review);

    doc.status = DocumentStatus.PendingReview;
    if (actor?.userId) doc.updateBy = actor.userId;
    const saved = await this.em.save(doc);

    if (beforeStatus === DocumentStatus.Published) {
      await this.safeUnpublish(documentId);
    }

    this.logger.log(
      `Document submitted for review: documentId=${documentId}, reviewId=${review.id}, beforeStatus=${beforeStatus}`,
    );
    return saved;
  }

  /** Approve review -> Published + rebuild indexes. */
  async approveReview(
    reviewId: string,
    reviewerId: string,
    reviewerName: string,
    reviewComment?: string,
  ): Promise<DocumentEntity> {
    const review = await this.findPendingReviewOrThrow(reviewId);

    review.reviewResult = ReviewResult.Approved;
    review.reviewerId = reviewerId;
    review.reviewerName = reviewerName;
    review.reviewComment = reviewComment ?? null;
    review.reviewedAt = new Date();
    await this.em.save(review);

    const doc = await this.findDocumentOrThrow(review.documentId);
    doc.status = DocumentStatus.Published;
    doc.publishTime = new Date();
    const saved = await this.em.save(doc);
    await this.safePublish(saved);

    this.logger.log(
      `Review approved: reviewId=${reviewId}, documentId=${doc.id}`,
    );
    return saved;
  }

  /** Reject review -> Draft. */
  async rejectReview(
    reviewId: string,
    reviewComment: string,
    reviewerId: string,
    reviewerName: string,
  ): Promise<DocumentEntity> {
    if (!reviewComment?.trim()) {
      throw new BadRequestException('A rejection comment is required.');
    }

    const review = await this.findPendingReviewOrThrow(reviewId);

    review.reviewResult = ReviewResult.Rejected;
    review.reviewerId = reviewerId;
    review.reviewerName = reviewerName;
    review.reviewComment = reviewComment.trim();
    review.reviewedAt = new Date();
    await this.em.save(review);

    const doc = await this.findDocumentOrThrow(review.documentId);
    doc.status = DocumentStatus.Draft;
    const saved = await this.em.save(doc);

    this.logger.log(
      `Review rejected: reviewId=${reviewId}, documentId=${doc.id}`,
    );
    return saved;
  }

  /** List pending, approved, or rejected reviews. */
  async listTasks(query: QueryReviewTasksDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const qb = this.em.createQueryBuilder(DocumentReviewEntity, 'r');

    if (query.status === 'pending' || !query.status) {
      qb.andWhere('r.review_result IS NULL');
    } else if (query.status === 'approved') {
      qb.andWhere('r.review_result = :result', {
        result: ReviewResult.Approved,
      });
    } else if (query.status === 'rejected') {
      qb.andWhere('r.review_result = :result', {
        result: ReviewResult.Rejected,
      });
    }

    qb.orderBy('r.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();
    return { items, total, page, pageSize };
  }

  async getPendingCount(): Promise<number> {
    return this.em.count(DocumentReviewEntity, {
      where: { reviewResult: IsNull() },
    });
  }

  /** Return the document's current pending review, or null. */
  async getCurrentReview(documentId: string) {
    return this.em.findOne(DocumentReviewEntity, {
      where: { documentId, reviewResult: IsNull() },
      order: { createdAt: 'DESC' },
    });
  }

  /** Return all review records for the document, including approved and rejected records. */
  async getReviewHistory(documentId: string) {
    return this.em.find(DocumentReviewEntity, {
      where: { documentId },
      order: { createdAt: 'DESC' },
    });
  }

  private async findPendingReviewOrThrow(reviewId: string) {
    const review = await this.em.findOne(DocumentReviewEntity, {
      where: { id: reviewId },
    });
    if (!review) {
      throw new NotFoundException(`Review ${reviewId} not found`);
    }
    if (review.reviewResult != null) {
      throw new BadRequestException(
        'This review task has already been processed.',
      );
    }
    return review;
  }

  private async findDocumentOrThrow(id: string) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    return doc;
  }

  private async safePublish(doc: DocumentEntity) {
    try {
      await this.pipelinePublisher.afterPublish(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to enqueue indexes after approval: documentId=${doc.id}, ${message}`,
      );
    }
  }

  private async safeUnpublish(documentId: string) {
    try {
      await this.pipelinePublisher.afterUnpublish(documentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to clean indexes after review submission: documentId=${documentId}, ${message}`,
      );
    }
  }
}
