import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EntityManager } from 'typeorm';
import { nextSnowflakeId } from '../common/snowflake-id';
import { CreateDocumentDto } from './dto/create-document.dto';
import { UpdateDocumentDto } from './dto/update-document.dto';
import { QueryDocumentDto } from './dto/query-document.dto';
import { UploadParseDto } from './dto/upload-parse.dto';
import { DocumentEntity } from './entities/document.entity';
import {
  canArchive,
  canEditContent,
  canPublishFrom,
  DocumentStatus,
} from './document-status';
import {
  DocumentContent,
  DocumentContentDocument,
} from './schemas/document-content.schema';
import { RustfsService } from '../storage/rustfs.service';
import { DocumentPipelinePublisher } from '../mq/document-pipeline.publisher';
import { FileParserService } from './parser/file-parser.service';
import {
  decodeUploadFilename,
  getExtension,
  titleFromFilename,
} from './parser/utils/markdown.util';
import { DocumentReviewService } from './document-review.service';
import { PipelineOrchestrator } from '../pipeline/pipeline.orchestrator';
import { AuthUser } from '../auth/auth-user.interface';
import {
  accessFromUser,
  canReadDocument,
  canWriteDocument,
} from './document-access';

/**
 * Document service.
 * - Metadata: PostgreSQL (kh_document).
 * - Content: MongoDB (document_content).
 * - Link: content_id <-> Mongo _id and documentId <-> document id.
 */
@Injectable()
export class DocumentService {
  private readonly logger = new Logger(DocumentService.name);

  constructor(
    /** Postgres entity manager. */
    @InjectEntityManager()
    private readonly em: EntityManager,
    /** Mongo content model. */
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
    private readonly fileParserService: FileParserService,
    private readonly rustfs: RustfsService,
    private readonly pipelinePublisher: DocumentPipelinePublisher,
    /** Publication review: whether required, plus submit/approve/reject operations. */
    private readonly reviewService: DocumentReviewService,
    private readonly pipeline: PipelineOrchestrator,
  ) {}

  /**
   * Create a document.
   * Flow: generate a Snowflake ID -> write Mongo content (get ObjectId) -> write Postgres metadata.
   * If the Postgres write fails, remove the Mongo content to avoid orphaned data.
   */
  async create(dto: CreateDocumentDto, actor: AuthUser) {
    const requestedStatus = dto.status ?? DocumentStatus.Draft;
    // Do not allow Archived or PendingReview as the initial status.
    if (
      requestedStatus !== DocumentStatus.Draft &&
      requestedStatus !== DocumentStatus.Published
    ) {
      throw new BadRequestException(
        'A new document can only be Draft or Published.',
      );
    }
    // When DOCUMENT_REQUIRE_APPROVAL=true, create a draft first and use publish/submit for review.
    if (
      requestedStatus === DocumentStatus.Published &&
      this.reviewService.isRequireApproval()
    ) {
      throw new BadRequestException(
        'When review is enabled, create a draft first and then submit it for publication/review.',
      );
    }

    const id = nextSnowflakeId();
    const wordCount = this.countWords(dto.content);
    const status = requestedStatus;
    // Use a content preview as contentSummary when summary is omitted.
    const contentSummary = dto.summary ?? this.buildContentSummary(dto.content);

    // Write Mongo first; the driver generates the ObjectId.
    const contentDoc = await this.contentModel.create({
      documentId: id,
      content: dto.content,
      contentLength: dto.content.length,
      contentSummary,
      version: 1,
      deleted: false,
    });
    // Store the ObjectId as a string in Postgres content_id.
    const contentId = String(contentDoc._id);

    try {
      const doc = this.em.create(DocumentEntity, {
        id,
        title: dto.title,
        contentId,
        summary: dto.summary,
        categoryId: dto.categoryId,
        teamId: dto.teamId,
        authorId: actor.userId,
        coverImage: dto.coverImage,
        tags: dto.tags,
        status,
        remark: dto.remark,
        isPublic: dto.isPublic ?? false,
        wordCount,
        // Record the publication time when creating an already-published document.
        publishTime: status === DocumentStatus.Published ? new Date() : null,
        createBy: actor.userId,
        updateBy: actor.userId,
        deleted: false,
      });

      const saved = await this.em.save(doc);

      // Index only Published documents. An initial Published status was rejected above when
      // review is required, so reaching this point means review is disabled; drafts do not enqueue MQ work.
      if (status === DocumentStatus.Published) {
        await this.safePublish(saved);
      }

      return { ...saved, content: dto.content };
    } catch (error) {
      // Postgres failure: physically remove the newly written Mongo content.
      await this.contentModel.deleteOne({ _id: contentDoc._id });
      throw error;
    }
  }

  /**
   * Return a paginated document list (Postgres metadata only, without content).
   * Supports fuzzy title, category, team, author, and status filters.
   * Regular users can see authored documents, published public documents, and published team documents.
   */
  async findAll(query: QueryDocumentDto, user: AuthUser) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const scope = accessFromUser(user);

    // Exclude soft-deleted records by default.
    const qb = this.em
      .createQueryBuilder(DocumentEntity, 'doc')
      .where('doc.deleted = :deleted', { deleted: false });

    if (!scope.unrestricted) {
      if (scope.teamIds.length) {
        qb.andWhere(
          `(doc.author_id = :me OR (doc.status = :published AND (doc.is_public = true OR doc.team_id IN (:...teamIds))))`,
          {
            me: scope.userId,
            published: DocumentStatus.Published,
            teamIds: scope.teamIds,
          },
        );
      } else {
        qb.andWhere(
          `(doc.author_id = :me OR (doc.status = :published AND doc.is_public = true))`,
          { me: scope.userId, published: DocumentStatus.Published },
        );
      }
    }

    // Case-insensitive fuzzy title match.
    if (query.title) {
      qb.andWhere('doc.title ILIKE :title', { title: `%${query.title}%` });
    }
    if (query.categoryId) {
      qb.andWhere('doc.category_id = :categoryId', {
        categoryId: query.categoryId,
      });
    }
    if (query.teamId) {
      qb.andWhere('doc.team_id = :teamId', { teamId: query.teamId });
    }
    if (query.authorId) {
      qb.andWhere('doc.author_id = :authorId', { authorId: query.authorId });
    }
    if (query.status !== undefined) {
      qb.andWhere('doc.status = :status', { status: query.status });
    }

    // Sort by creation time descending, then paginate.
    qb.orderBy('doc.created_at', 'DESC')
      .skip((page - 1) * pageSize)
      .take(pageSize);

    const [items, total] = await qb.getManyAndCount();

    return {
      items,
      total,
      page,
      pageSize,
    };
  }

  /**
   * Get document details.
   * @param withContent Whether to include Mongo content; defaults to true.
   */
  async findOne(id: string, withContent = true, user?: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    if (user && !canReadDocument(doc, accessFromUser(user))) {
      throw new ForbiddenException(
        'You do not have permission to view this document.',
      );
    }

    if (!withContent) {
      return doc;
    }

    // Load non-deleted content through content_id.
    const contentDoc = await this.contentModel
      .findOne({ _id: doc.contentId, deleted: false })
      .lean();
    return {
      ...doc,
      content: contentDoc?.content ?? '',
    };
  }

  /**
   * Update a document.
   * - With content: update Mongo content and increment version.
   * - Summary only: update Mongo contentSummary.
   * - Other fields: update Postgres metadata only.
   */
  async update(id: string, dto: UpdateDocumentDto, actor: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    this.assertWritable(doc, actor);

    const oldStatus = doc.status;
    const oldIsPublic = doc.isPublic;
    const oldTeamId = doc.teamId ?? null;

    // Status and edit permissions (content cannot change during review).
    if (doc.status === DocumentStatus.PendingReview) {
      if (dto.content !== undefined || dto.title !== undefined) {
        throw new BadRequestException(
          'Documents under review cannot be edited.',
        );
      }
    } else if (!canEditContent(doc.status)) {
      throw new BadRequestException(
        'The current document status does not allow editing.',
      );
    }

    // PATCH does not allow arbitrary status changes; only Published -> Draft is supported here.
    if (dto.status !== undefined && dto.status !== doc.status) {
      if (
        dto.status === DocumentStatus.Draft &&
        doc.status === DocumentStatus.Published
      ) {
        doc.status = DocumentStatus.Draft;
      } else {
        throw new BadRequestException(
          'Use the publish, archive, save-draft, or review endpoints to change document status.',
        );
      }
    }

    let contentChanged = false;
    let newContent: string | undefined;

    // Content changes.
    if (dto.content !== undefined) {
      contentChanged = true;
      newContent = dto.content;
      const contentSummary =
        dto.summary ?? this.buildContentSummary(dto.content);
      const result = await this.contentModel.updateOne(
        { _id: doc.contentId, deleted: false },
        {
          $set: {
            content: dto.content,
            contentLength: dto.content.length,
            contentSummary,
          },
          $inc: { version: 1 }, // Increment the version.
        },
      );
      if (result.matchedCount === 0) {
        throw new BadRequestException(
          `Document content ${doc.contentId} not found`,
        );
      }
      doc.wordCount = this.countWords(dto.content);
    } else if (dto.summary !== undefined) {
      // Synchronize the Mongo preview field when only the summary changes.
      await this.contentModel.updateOne(
        { _id: doc.contentId, deleted: false },
        { $set: { contentSummary: dto.summary } },
      );
    }

    // Metadata fields (overwrite only fields that are provided).
    if (dto.title !== undefined) doc.title = dto.title;
    if (dto.summary !== undefined) doc.summary = dto.summary;
    if (dto.categoryId !== undefined) doc.categoryId = dto.categoryId;
    if (dto.teamId !== undefined) doc.teamId = dto.teamId;
    if (dto.coverImage !== undefined) doc.coverImage = dto.coverImage;
    if (dto.tags !== undefined) doc.tags = dto.tags;
    if (dto.remark !== undefined) doc.remark = dto.remark;
    if (dto.isPublic !== undefined) doc.isPublic = dto.isPublic;
    doc.updateBy = actor.userId;

    const saved = await this.em.save(doc);
    const finalContent = newContent ?? (await this.loadContent(doc.contentId));

    const visibilityChanged =
      saved.isPublic !== oldIsPublic || (saved.teamId ?? null) !== oldTeamId;

    // Synchronize RAG/Search/KG when published content changes or is unpublished.
    // In review mode, published edits are not rebuilt until republished.
    // Visibility changes must update indexes immediately or search will use stale isPublic values.
    await this.syncPipelineAfterUpdate(
      saved,
      oldStatus,
      saved.status,
      contentChanged,
      visibilityChanged,
    );

    return { ...saved, content: finalContent };
  }

  /**
   * Publish a document.
   * - Review enabled: Draft / Published -> PendingReview (not indexed).
   * - Review disabled: Draft / Published / Archived -> Published + indexed.
   */
  async publish(id: string, actor: AuthUser) {
    this.logger.log(`Publishing document: documentId=${id}`);

    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    this.assertWritable(doc, actor);

    if (!canPublishFrom(doc.status)) {
      throw new BadRequestException(
        'The current document status does not allow publishing.',
      );
    }

    if (doc.status === DocumentStatus.PendingReview) {
      throw new BadRequestException(
        'The document is under review. Wait for the review result.',
      );
    }

    if (this.reviewService.isRequireApproval()) {
      // Draft or Published enters review without indexing; submitForReview clears old indexes from Published.
      if (
        doc.status === DocumentStatus.Draft ||
        doc.status === DocumentStatus.Published
      ) {
        const saved = await this.reviewService.submitForReview(id, actor);
        const content = await this.loadContent(saved.contentId);
        return { ...saved, content };
      }
    }

    return this.directPublish(id, actor);
  }

  /**
   * Publish directly when review is disabled.
   * Also used indirectly by DocumentReviewService.approveReview after approval.
   */
  async directPublish(id: string, actor?: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }

    if (
      doc.status !== DocumentStatus.Draft &&
      doc.status !== DocumentStatus.Published &&
      doc.status !== DocumentStatus.Archived &&
      doc.status !== DocumentStatus.PendingReview
    ) {
      throw new BadRequestException(
        'The current document status does not allow publishing.',
      );
    }

    doc.status = DocumentStatus.Published;
    doc.publishTime = new Date();
    if (actor?.userId) doc.updateBy = actor.userId;
    const saved = await this.em.save(doc);
    const content = await this.loadContent(saved.contentId);
    await this.safePublish(saved);

    this.logger.log(`Document published: documentId=${id}`);
    return { ...saved, content };
  }

  /** Archive: Published -> Archived and clear indexes. */
  async archive(id: string, actor: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    this.assertWritable(doc, actor);
    if (!canArchive(doc.status)) {
      throw new BadRequestException(
        'Only published documents can be archived.',
      );
    }

    doc.status = DocumentStatus.Archived;
    doc.updateBy = actor.userId;
    const saved = await this.em.save(doc);
    await this.safeUnpublish(id);

    this.logger.log(`Document archived: documentId=${id}`);
    return saved;
  }

  /** Published -> Draft (save as draft) and clear indexes. */
  async saveAsDraft(id: string, actor: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    this.assertWritable(doc, actor);
    if (doc.status !== DocumentStatus.Published) {
      throw new BadRequestException(
        'Only published documents can be saved as drafts.',
      );
    }

    doc.status = DocumentStatus.Draft;
    doc.updateBy = actor.userId;
    const saved = await this.em.save(doc);
    await this.safeUnpublish(id);

    this.logger.log(`Document saved as draft: documentId=${id}`);
    return saved;
  }

  /**
   * Soft-delete a document.
   * Mark deleted as true in both Postgres and Mongo without physically deleting content.
   * Published documents asynchronously clear ES search indexes, vector chunks, and the Neo4j graph.
   */
  async remove(id: string, actor: AuthUser) {
    const doc = await this.em.findOne(DocumentEntity, {
      where: { id, deleted: false },
    });
    if (!doc) {
      throw new NotFoundException(`Document ${id} not found`);
    }
    this.assertWritable(doc, actor);

    if (doc.status === DocumentStatus.Published) {
      // Only Published requires index cleanup; do not enqueue unpublish for Draft, PendingReview, or Archived.
      await this.safeUnpublish(id);
    }

    doc.deleted = true;
    doc.updateBy = actor.userId;
    await this.em.save(doc);
    await this.contentModel.updateOne(
      { _id: doc.contentId },
      { $set: { deleted: true } },
    );

    return { id, deleted: true };
  }

  /** Upload and parse a file -> create a draft document. */
  async uploadAndCreateDocument(
    file: Express.Multer.File,
    meta: UploadParseDto = {},
    actor: AuthUser,
  ) {
    if (!file?.buffer?.length) {
      throw new BadRequestException('The file is required.');
    }

    const originalFilename = decodeUploadFilename(file.originalname);
    const extension = getExtension(originalFilename);

    if (!this.fileParserService.isSupported(extension)) {
      throw new BadRequestException(
        `Unsupported file format: ${extension}. Supported formats: ${this.fileParserService.supportedList()}`,
      );
    }

    this.logger.log(
      `Uploading and parsing file: name=${originalFilename}, size=${file.size}, ext=${extension}`,
    );

    let parsedContent: string;
    try {
      parsedContent = await this.fileParserService.parse({
        originalname: originalFilename,
        buffer: file.buffer,
        size: file.size,
      });
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `File parsing failed: name=${originalFilename}, error=${message}`,
      );
      throw new BadRequestException(`File parsing failed: ${message}`);
    }

    let fileUrl: string | null = null;
    if (this.rustfs.isEnabled()) {
      try {
        fileUrl = await this.rustfs.uploadBytes(file.buffer, {
          fileName: originalFilename,
          contentType: file.mimetype || 'application/octet-stream',
          prefix: 'documents',
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`Original file upload to RustFS failed: ${message}`);
        throw new BadRequestException(
          `Original file upload failed: ${message}`,
        );
      }
    } else {
      this.logger.warn('RustFS is disabled; skipping original file upload');
    }

    const title = titleFromFilename(originalFilename);

    const created = await this.create(
      {
        title,
        content: parsedContent,
        categoryId: meta.categoryId,
        teamId: meta.teamId,
        tags: meta.tags,
        remark: meta.remark,
        isPublic: meta.isPublic,
        status: DocumentStatus.Draft,
      },
      actor,
    );

    const previewLen = Math.min(200, parsedContent.length);
    const result = {
      documentId: created.id,
      title,
      fileUrl,
      fileSize: file.size,
      fileExtension: extension,
      contentLength: parsedContent.length,
      contentPreview: parsedContent.slice(0, previewLen),
      status: DocumentStatus.Draft,
    };

    this.logger.log(
      `File parsed and document created: documentId=${created.id}, title=${title}, ext=${extension}, chars=${parsedContent.length}, fileUrl=${fileUrl}`,
    );

    return result;
  }

  /**
   * Synchronize indexes after updates based on status changes.
   * - Published -> non-Published: clear indexes.
   * - Still Published with content changes: rebuild in review-disabled mode; wait for republish/approval in review mode.
   * - Still Published with visibility-only changes: immediately update visibility in all three indexes.
   */
  private async syncPipelineAfterUpdate(
    doc: DocumentEntity,
    oldStatus: DocumentStatus,
    newStatus: DocumentStatus,
    contentChanged: boolean,
    visibilityChanged: boolean,
  ) {
    const wasPublished = oldStatus === DocumentStatus.Published;
    const isPublished = newStatus === DocumentStatus.Published;

    if (wasPublished && !isPublished) {
      await this.safeUnpublish(doc.id);
      return;
    }

    if (
      isPublished &&
      contentChanged &&
      !this.reviewService.isRequireApproval()
    ) {
      await this.safePublish(doc);
      return;
    }

    if (isPublished && visibilityChanged) {
      try {
        await this.pipeline.updateVisibility(doc);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(
          `Visibility synchronization failed (document was saved): documentId=${doc.id}, ${message}`,
        );
      }
    }
  }

  /** Read content from Mongo (details / publication response). */
  private async loadContent(contentId: string): Promise<string> {
    const contentDoc = await this.contentModel
      .findOne({ _id: contentId, deleted: false })
      .lean();
    return contentDoc?.content ?? '';
  }

  /** Enqueue MQ work for RAG chunk vectors, full-text search, and KG building (failures do not roll back document status). */
  private async safePublish(doc: DocumentEntity) {
    try {
      await this.pipelinePublisher.afterPublish(doc);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to enqueue indexes (document status is unchanged): documentId=${doc.id}, ${message}`,
      );
    }
  }

  private assertWritable(doc: DocumentEntity, actor: AuthUser) {
    if (!canWriteDocument(doc, actor)) {
      throw new ForbiddenException(
        'You do not have permission to modify this document.',
      );
    }
  }

  /** Enqueue MQ work to remove the document from ES, Neo4j, and other indexes. */
  private async safeUnpublish(documentId: string) {
    try {
      await this.pipelinePublisher.afterUnpublish(documentId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Failed to enqueue index cleanup: documentId=${documentId}, ${message}`,
      );
    }
  }

  /**
   * Extract a preview summary from content.
   * Collapse whitespace and truncate to maxLen, appending an ellipsis when needed.
   */
  private buildContentSummary(content: string, maxLen = 200): string {
    const trimmed = content.trim().replace(/\s+/g, ' ');
    return trimmed.length <= maxLen
      ? trimmed
      : `${trimmed.slice(0, maxLen)}...`;
  }

  /**
   * Count content words for mixed CJK and Latin text.
   * - CJK characters count as one each.
   * - Latin text is split on whitespace and each word counts as one.
   */
  private countWords(content: string): number {
    const trimmed = content.trim();
    if (!trimmed) return 0;

    // Match all CJK Unified Ideographs (U+4E00-U+9FFF), counting each as one.
    const cjk = (trimmed.match(/[\u4e00-\u9fff]/g) ?? []).length;

    // Remove CJK characters, then split the remainder on whitespace to count Latin words.
    const latin = trimmed
      .replace(/[\u4e00-\u9fff]/g, ' ') // Replace CJK characters with spaces to avoid joining Latin text.
      .trim()
      .split(/\s+/) // Split on runs of whitespace.
      .filter(Boolean).length; // Remove empty strings.

    return cjk + latin;
  }
}
