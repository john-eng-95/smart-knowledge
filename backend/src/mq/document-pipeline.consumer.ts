import { Injectable, Logger } from '@nestjs/common';
import { ConsumeMessage } from 'amqplib';
import { PipelineOrchestrator } from '../pipeline/pipeline.orchestrator';
import {
  KG_GRAPH_QUEUE,
  RAG_REINDEX_QUEUE,
  SEARCH_INDEX_QUEUE,
} from './mq.constants';
import {
  KgBuildMessage,
  ReindexMessage,
  SearchIndexMessage,
} from './messages/pipeline.messages';
import { RabbitMqService } from './rabbitmq.service';

/**
 * MQ consumer for the post-publication document pipeline.
 *
 * <p>Consumes RAG vectorization, full-text search indexing, and KG construction tasks.</p>
 * <p>Handlers are registered in the constructor with `registerHandler` before
 * {@link RabbitMqService.onModuleInit} binds consumers.</p>
 */
@Injectable()
export class DocumentPipelineConsumer {
  private readonly logger = new Logger(DocumentPipelineConsumer.name);

  constructor(
    private readonly rabbit: RabbitMqService,
    private readonly orchestrator: PipelineOrchestrator,
  ) {
    this.rabbit.registerHandler(RAG_REINDEX_QUEUE, (msg) =>
      this.handleRag(msg),
    );
    this.rabbit.registerHandler(SEARCH_INDEX_QUEUE, (msg) =>
      this.handleSearch(msg),
    );
    this.rabbit.registerHandler(KG_GRAPH_QUEUE, (msg) => this.handleKg(msg));
  }

  /** RAG: chunking, vectorization, and ES kh_chunk (dense_vector). */
  private async handleRag(msg: ConsumeMessage) {
    const body = this.parseJson<ReindexMessage>(msg);
    this.logger.log(
      `[RAG] type=${body.type}, taskId=${body.taskId}, documentIds=${JSON.stringify(body.documentIds ?? [])}`,
    );
    await this.orchestrator.handleRagReindex(body.type, body.documentIds);
  }

  /** Search: document-level keyword index (Elasticsearch kh_document). */
  private async handleSearch(msg: ConsumeMessage) {
    const body = this.parseJson<SearchIndexMessage>(msg);
    this.logger.log(
      `[Search] type=${body.type}, taskId=${body.taskId}, documentId=${body.documentId}`,
    );
    await this.orchestrator.handleSearchIndex(body.type, body.documentId);
  }

  /** KG: chunking, entity/relation extraction, and Neo4j persistence. */
  private async handleKg(msg: ConsumeMessage) {
    const body = this.parseJson<KgBuildMessage>(msg);
    this.logger.log(
      `[KG] type=${body.type}, taskId=${body.taskId}, documentIds=${JSON.stringify(body.documentIds ?? [])}`,
    );
    await this.orchestrator.handleKgBuild(body.type, body.documentIds);
  }

  private parseJson<T>(msg: ConsumeMessage): T {
    return JSON.parse(msg.content.toString('utf8')) as T;
  }
}
