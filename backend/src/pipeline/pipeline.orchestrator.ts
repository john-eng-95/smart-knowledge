import { Injectable, Logger } from '@nestjs/common';
import { InjectEntityManager } from '@nestjs/typeorm';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { EntityManager } from 'typeorm';
import {
  DocumentEntity,
  DocumentStatus,
} from '../document/entities/document.entity';
import {
  DocumentContent,
  DocumentContentDocument,
} from '../document/schemas/document-content.schema';
import { ChunkingService } from './chunking.service';
import { EmbeddingService } from './embedding.service';
import { GraphBuildService } from './graph-build.service';
import { SearchIndexService } from './search-index.service';
import { VectorIndexService } from './vector-index.service';
import { PipelineDocument } from './types/pipeline.types';

/**
 * Post-publication knowledge pipeline orchestrator.
 *
 * <p>RAG: chunking -> embedding -> ES kh_chunk.</p>
 * <p>Search: Mongo full text -> ES kh_document.</p>
 * <p>KG: chunking -> entity/relation extraction -> Neo4j.</p>
 *
 * <p>Called by {@link DocumentPipelineConsumer} after consuming an MQ message.</p>
 * <p>This class loads documents and delegates to services; it does not access RabbitMQ directly.</p>
 */
@Injectable()
export class PipelineOrchestrator {
  private readonly logger = new Logger(PipelineOrchestrator.name);

  constructor(
    @InjectEntityManager()
    private readonly em: EntityManager,
    @InjectModel(DocumentContent.name)
    private readonly contentModel: Model<DocumentContentDocument>,
    private readonly chunkingService: ChunkingService,
    private readonly embeddingService: EmbeddingService,
    private readonly vectorIndexService: VectorIndexService,
    private readonly searchIndexService: SearchIndexService,
    private readonly graphBuildService: GraphBuildService,
  ) {}

  /**
   * Handle RAG rebuild/delete messages.
   *
   * Rebuild one document: clear old chunks -> chunk -> embed -> write ES kh_chunk.
   */
  async handleRagReindex(type: string, documentIds?: string[]) {
    if (type === 'DELETE_BY_DOC_IDS' && documentIds?.length) {
      for (const id of documentIds) {
        await this.vectorIndexService.deleteByDocId(id);
      }
      return;
    }

    if (type !== 'BY_DOC_IDS' || !documentIds?.length) {
      this.logger.warn(`Ignoring unsupported RAG message: type=${type}`);
      return;
    }

    const docs = await this.loadDocumentsByIds(documentIds);
    this.logger.log(`RAG indexing started: type=${type}, total=${docs.length}`);

    for (const doc of docs) {
      try {
        await this.reindexOne(doc);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(
          `RAG indexing failed: documentId=${doc.id}, ${message}`,
        );
      }
    }
  }

  /**
   * Update visibility for a published document by synchronizing all three indexes.
   * Do not rerun embedding or entity extraction.
   */
  async updateVisibility(doc: DocumentEntity) {
    const vis = {
      isPublic: doc.isPublic ?? false,
      teamId: doc.teamId ?? null,
      authorId: doc.authorId ?? null,
    };
    this.logger.log(
      `Synchronizing visibility: documentId=${doc.id}, isPublic=${vis.isPublic}, teamId=${vis.teamId ?? '-'}`,
    );
    await Promise.all([
      this.searchIndexService.updateVisibility(doc.id, vis),
      this.vectorIndexService.updateVisibility(doc.id, vis),
      this.graphBuildService.updateVisibility(doc.id, vis),
    ]);
  }

  /**
   * Handle Search index messages.
   * INDEX: load full text from Postgres + Mongo by documentId and write ES kh_document.
   * DELETE: delete by documentId.
   */
  async handleSearchIndex(type: string, documentId: string) {
    if (type === 'DELETE') {
      await this.searchIndexService.deleteDocument(documentId);
      return;
    }

    if (type === 'INDEX') {
      const docs = await this.loadDocumentsByIds([documentId]);
      const doc = docs[0];
      if (!doc) {
        this.logger.warn(
          `Search INDEX document not found: documentId=${documentId}`,
        );
        return;
      }
      await this.searchIndexService.indexDocument(this.toSearchIndexDoc(doc));
      return;
    }

    this.logger.warn(`Ignoring unsupported Search message: type=${type}`);
  }

  /**
   * Handle KG build messages.
   * BUILD_*: read content -> chunk -> extract entities/relations -> write Neo4j.
   * DELETE_*: delete document nodes, chunks, and orphan entities.
   */
  async handleKgBuild(type: string, documentIds?: string[]) {
    if (type === 'DELETE_BY_DOC_IDS' && documentIds?.length) {
      for (const id of documentIds) {
        await this.graphBuildService.deleteForDocument(id);
      }
      return;
    }

    const docs =
      type === 'BUILD_BY_DOC_IDS' && documentIds?.length
        ? await this.loadDocumentsByIds(documentIds)
        : type === 'BUILD_ALL'
          ? await this.loadAllPublishedDocuments()
          : [];

    if (!docs.length) {
      this.logger.warn(
        `Ignoring unsupported or empty KG message: type=${type}`,
      );
      return;
    }

    this.logger.log(
      `KG graph build started: type=${type}, total=${docs.length}`,
    );
    await this.graphBuildService.buildBatch(docs);
  }

  /** One document: chunk -> batch embed -> persist. */
  private async reindexOne(doc: PipelineDocument) {
    if (!doc.content?.trim()) {
      this.logger.warn(
        `Document content is empty; skipping RAG: documentId=${doc.id}`,
      );
      return;
    }

    // Clear old chunks first so repeated publication does not leave stale data.
    await this.vectorIndexService.deleteByDocId(doc.id);

    const chunks = await this.chunkingService.chunk({
      content: doc.content,
      documentId: doc.id,
      documentTitle: doc.title,
      categoryId: doc.categoryId,
      authorId: doc.authorId,
      teamId: doc.teamId,
      isPublic: doc.isPublic,
      docStatus: doc.status,
      publishTime: this.toIsoDate(doc.publishTime),
    });

    if (!chunks.length) return;

    const embeddings = await this.embeddingService.embedBatch(
      chunks.map((c) => c.content),
    );
    for (let i = 0; i < chunks.length; i++) {
      chunks[i].embedding = embeddings[i];
    }

    await this.vectorIndexService.indexChunks(chunks);
    this.logger.log(
      `RAG indexing completed: documentId=${doc.id}, chunks=${chunks.length}`,
    );
  }

  /** ES date fields require ISO-8601; Date#toString() is rejected. */
  private toIsoDate(value?: Date | string | null): string | null {
    if (value == null) return null;
    if (value instanceof Date) {
      return Number.isNaN(value.getTime()) ? null : value.toISOString();
    }
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
  }

  /** Load metadata and Mongo content by ID list. */
  private async loadDocumentsByIds(ids: string[]): Promise<PipelineDocument[]> {
    const result: PipelineDocument[] = [];
    for (const id of ids) {
      const doc = await this.em.findOne(DocumentEntity, {
        where: { id, deleted: false },
      });
      if (!doc) continue;
      const contentDoc = await this.contentModel
        .findOne({ _id: doc.contentId, deleted: false })
        .lean();
      result.push(this.toPipelineDoc(doc, contentDoc?.content ?? ''));
    }
    return result;
  }

  /** Load all published, non-deleted documents (BUILD_ALL). */
  private async loadAllPublishedDocuments(): Promise<PipelineDocument[]> {
    const docs = await this.em.find(DocumentEntity, {
      where: { deleted: false, status: DocumentStatus.Published },
    });
    const result: PipelineDocument[] = [];
    for (const doc of docs) {
      const contentDoc = await this.contentModel
        .findOne({ _id: doc.contentId, deleted: false })
        .lean();
      result.push(this.toPipelineDoc(doc, contentDoc?.content ?? ''));
    }
    return result;
  }

  /** Convert Postgres metadata and Mongo full text into an ES kh_document record. */
  private toSearchIndexDoc(doc: PipelineDocument): Record<string, unknown> {
    return {
      id: doc.id,
      title: doc.title,
      summary: doc.summary ?? null,
      content: doc.content ?? '',
      categoryId: doc.categoryId ?? null,
      tags: doc.tags ?? null,
      status: doc.status,
      isPublic: doc.isPublic,
      viewCount: doc.viewCount,
      likeCount: doc.likeCount,
      commentCount: doc.commentCount,
      authorId: doc.authorId ?? null,
      teamId: doc.teamId ?? null,
      publishTime: this.toIsoDate(doc.publishTime),
      createdAt: this.toIsoDate(doc.createdAt),
      updatedAt: this.toIsoDate(doc.updatedAt),
    };
  }

  /** Convert Postgres entity and Mongo content into the shared pipeline DTO. */
  private toPipelineDoc(
    doc: DocumentEntity,
    content: string,
  ): PipelineDocument {
    return {
      id: doc.id,
      title: doc.title,
      content,
      summary: doc.summary,
      categoryId: doc.categoryId,
      authorId: doc.authorId,
      teamId: doc.teamId,
      status: doc.status,
      tags: doc.tags,
      isPublic: doc.isPublic,
      viewCount: doc.viewCount,
      likeCount: doc.likeCount,
      commentCount: doc.commentCount,
      publishTime: doc.publishTime,
      createdAt: doc.createdAt,
      updatedAt: doc.updatedAt,
    };
  }
}
