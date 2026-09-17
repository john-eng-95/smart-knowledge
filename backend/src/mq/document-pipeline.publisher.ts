import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { DocumentEntity } from '../document/entities/document.entity';
import {
  KG_GRAPH_EXCHANGE,
  KG_RK_BUILD_BY_IDS,
  KG_RK_DELETE,
  RAG_REINDEX_EXCHANGE,
  RAG_RK_BY_IDS,
  RAG_RK_DELETE,
  SEARCH_INDEX_EXCHANGE,
  SEARCH_RK_DELETE,
  SEARCH_RK_INDEX,
} from './mq.constants';
import {
  KgBuildMessage,
  ReindexMessage,
  SearchIndexMessage,
} from './messages/pipeline.messages';
import { RabbitMqService } from './rabbitmq.service';

/**
 * Producer for the post-publication knowledge pipeline.
 *
 * <p>Triggers RAG vectorization, full-text search indexing, and KG construction.</p>
 * <p>Delivery failures are logged and do not roll back the published document state.</p>
 */
@Injectable()
export class DocumentPipelinePublisher {
  private readonly logger = new Logger(DocumentPipelinePublisher.name);

  constructor(private readonly rabbit: RabbitMqService) {}

  /** Called after publication succeeds; publishes RAG, Search, and KG tasks in parallel. */
  async afterPublish(document: DocumentEntity) {
    await Promise.all([
      this.triggerRagReindex(document.id),
      this.triggerSearchIndex(document.id),
      this.triggerKgBuild(document.id),
    ]);
  }

  /** After archiving/deletion, notify RAG, Search, and KG to clean up by document ID. */
  async afterUnpublish(documentId: string) {
    await Promise.all([
      this.triggerRagDelete(documentId),
      this.triggerSearchDelete(documentId),
      this.triggerKgDelete(documentId),
    ]);
  }

  /** Rebuild vector chunks for a document in RAG. */
  private async triggerRagReindex(documentId: string) {
    const message: ReindexMessage = {
      taskId: randomUUID(),
      type: 'BY_DOC_IDS',
      documentIds: [documentId],
    };
    const ok = await this.rabbit.publish(
      RAG_REINDEX_EXCHANGE,
      RAG_RK_BY_IDS,
      message,
    );
    this.logger.log(
      `RAG reindex ${ok ? 'published' : 'failed'}: documentId=${documentId}, taskId=${message.taskId}`,
    );
  }

  private async triggerRagDelete(documentId: string) {
    const message: ReindexMessage = {
      taskId: randomUUID(),
      type: 'DELETE_BY_DOC_IDS',
      documentIds: [documentId],
    };
    await this.rabbit.publish(RAG_REINDEX_EXCHANGE, RAG_RK_DELETE, message);
  }

  /**
   * Search publishes only the documentId. The consumer loads the full text from
   * PostgreSQL and MongoDB before writing to ES, avoiding large MQ payloads.
   */
  private async triggerSearchIndex(documentId: string) {
    const message: SearchIndexMessage = {
      taskId: randomUUID(),
      type: 'INDEX',
      documentId,
    };
    const ok = await this.rabbit.publish(
      SEARCH_INDEX_EXCHANGE,
      SEARCH_RK_INDEX,
      message,
    );
    this.logger.log(
      `ES search index ${ok ? 'published' : 'failed'}: documentId=${documentId}, taskId=${message.taskId}`,
    );
  }

  private async triggerSearchDelete(documentId: string) {
    const message: SearchIndexMessage = {
      taskId: randomUUID(),
      type: 'DELETE',
      documentId,
    };
    await this.rabbit.publish(SEARCH_INDEX_EXCHANGE, SEARCH_RK_DELETE, message);
  }

  /** Build the knowledge graph for a document. */
  private async triggerKgBuild(documentId: string) {
    const message: KgBuildMessage = {
      taskId: randomUUID(),
      type: 'BUILD_BY_DOC_IDS',
      documentIds: [documentId],
    };
    const ok = await this.rabbit.publish(
      KG_GRAPH_EXCHANGE,
      KG_RK_BUILD_BY_IDS,
      message,
    );
    this.logger.log(
      `KG build ${ok ? 'published' : 'failed'}: documentId=${documentId}, taskId=${message.taskId}`,
    );
  }

  private async triggerKgDelete(documentId: string) {
    const message: KgBuildMessage = {
      taskId: randomUUID(),
      type: 'DELETE_BY_DOC_IDS',
      documentIds: [documentId],
    };
    await this.rabbit.publish(KG_GRAPH_EXCHANGE, KG_RK_DELETE, message);
  }
}
