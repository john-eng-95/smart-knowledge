import { Client } from '@elastic/elasticsearch';
import type { estypes } from '@elastic/elasticsearch';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { scalarToString } from '../common/scalar-string';
import { ChunkHit, DocumentChunk } from './types/pipeline.types';
import {
  ES_CHUNK_VISIBILITY_FIELDS,
  esVisibilityFilter,
  wrapEsQuery,
  type DocumentAccessScope,
} from '../document/document-access';

/** RAG chunk vector index name. */
const CHUNK_INDEX = 'kh_chunk';

/**
 * Vector index storage.
 *
 * <p>Writes to Elasticsearch `kh_chunk`, including dense_vector(embedding) for kNN and hybrid retrieval.</p>
 *
 * <p>Responsibilities:</p>
 * - Ensure the index mapping exists at startup, including dense_vector.
 * - Delete old chunks by document_id before rebuilding.
 * - Bulk-write chunks with embeddings.
 */
@Injectable()
export class VectorIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(VectorIndexService.name);
  private es: Client | null = null;
  private readonly esEnabled: boolean;
  private readonly embeddingDims: number;

  constructor(private readonly config: ConfigService) {
    this.esEnabled =
      this.config.get<string>('ELASTICSEARCH_ENABLED', 'true') !== 'false';
    this.embeddingDims = Number(config.get('EMBEDDING_DIMENSION', 1024));
  }

  async onModuleInit() {
    if (!this.esEnabled) {
      this.logger.warn(
        'Elasticsearch is disabled; skipping RAG vector index writes',
      );
      return;
    }

    const node = this.config.get<string>(
      'ELASTICSEARCH_NODE',
      'http://localhost:9200',
    );
    this.es = new Client({ node });
    try {
      const health = await this.es.cluster.health();
      this.logger.log(
        `VectorIndex ES connected: ${node}, status=${health.status}`,
      );
      await this.createIndexIfNotExists();
      await this.ensureVisibilityMapping();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Elasticsearch unavailable; skipping RAG vector writes: ${message}`,
      );
      this.es = null;
    }
  }

  async onModuleDestroy() {
    await this.es?.close();
  }

  /** Batch-update chunk visibility for published documents without recomputing embeddings. */
  async updateVisibility(
    documentId: string,
    vis: { isPublic: boolean; teamId: string | null; authorId: string | null },
  ) {
    if (!this.es) {
      this.logger.warn(
        `Skipping vector visibility update (ES unavailable): documentId=${documentId}`,
      );
      return;
    }
    try {
      const result = await this.es.updateByQuery({
        index: CHUNK_INDEX,
        refresh: true,
        query: { term: { document_id: documentId } },
        script: {
          source:
            'ctx._source.is_public = params.is_public; ctx._source.team_id = params.team_id; ctx._source.author_id = params.author_id;',
          params: {
            is_public: vis.isPublic,
            team_id: vis.teamId,
            author_id: vis.authorId,
          },
        },
      });
      this.logger.log(
        `Vector chunk visibility updated: documentId=${documentId}, updated=${result.updated ?? 0}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Vector chunk visibility update failed: documentId=${documentId}, ${message}`,
      );
    }
  }

  /** Delete all vector chunks for a document (used during publication rebuilds or unpublishing). */
  async deleteByDocId(documentId: string) {
    if (!this.es) {
      this.logger.warn(
        `Skipping vector chunk deletion (ES unavailable): documentId=${documentId}`,
      );
      return;
    }

    try {
      await this.es.deleteByQuery({
        index: CHUNK_INDEX,
        query: {
          term: { document_id: documentId },
        },
        refresh: true,
      });
      this.logger.log(
        `Document vector chunks deleted from ES: documentId=${documentId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // Ignore a missing index.
      if (message.includes('index_not_found')) {
        return;
      }
      this.logger.error(
        `ES document chunk deletion failed: documentId=${documentId}, error=${message}`,
      );
    }
  }

  /** Bulk-write or replace chunks (_id = chunkId). */
  async indexChunks(chunks: DocumentChunk[]) {
    if (!chunks.length) return;

    if (!this.es) {
      this.logger.warn(
        `Skipping vector index write (ES unavailable): chunks=${chunks.length}`,
      );
      return;
    }

    await this.createIndexIfNotExists();

    const operations = chunks.flatMap((chunk) => [
      { index: { _index: CHUNK_INDEX, _id: chunk.chunkId } },
      this.buildDocMap(chunk),
    ]);

    const response = await this.es.bulk({
      refresh: true,
      operations,
    });

    if (response.errors) {
      const failed = response.items
        .filter((item) => item.index?.error)
        .map(
          (item) =>
            `${item.index?._id}: ${item.index?.error?.reason ?? 'unknown'}`,
        );
      this.logger.error(
        `Some ES bulk index operations failed: ${failed.join(', ')}`,
      );
      throw new Error(
        `Some ES bulk index operations failed: ${failed.length} items`,
      );
    }

    this.logger.log(
      `ES bulk index completed: ${chunks.length} chunks -> ${CHUNK_INDEX}`,
    );
  }

  /**
   * BM25 keyword search (content + document_title, ik_smart).
   * Return [] when ES is unavailable.
   */
  async keywordSearch(
    query: string,
    topK = 20,
    scope?: DocumentAccessScope,
  ): Promise<ChunkHit[]> {
    if (!this.es) {
      this.logger.warn('Skipping keyword search (ES unavailable)');
      return [];
    }
    const trimmed = query.trim();
    if (!trimmed) return [];

    const k = this.clampTopK(topK);
    const vis = scope
      ? esVisibilityFilter(scope, ES_CHUNK_VISIBILITY_FIELDS)
      : null;
    try {
      const response = await this.es.search({
        index: CHUNK_INDEX,
        size: k,
        query: wrapEsQuery(
          {
            multi_match: {
              query: trimmed,
              fields: ['document_title^2', 'content'],
              analyzer: 'ik_smart',
            },
          },
          vis,
        ),
        _source: [
          'chunk_id',
          'document_id',
          'document_title',
          'content',
          'heading',
        ],
      });
      return this.mapHits(response.hits.hits);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Keyword search failed: ${message}`);
      return [];
    }
  }

  /**
   * kNN search for knowledge chunks (cosine).
   * Return [] when ES is unavailable or the index is empty.
   */
  async knnSearch(
    queryVector: number[],
    topK = 20,
    scope?: DocumentAccessScope,
  ): Promise<ChunkHit[]> {
    if (!this.es) {
      this.logger.warn('Skipping vector search (ES unavailable)');
      return [];
    }
    if (!queryVector.length) return [];

    const k = this.clampTopK(topK);
    const vis = scope
      ? esVisibilityFilter(scope, ES_CHUNK_VISIBILITY_FIELDS)
      : null;
    try {
      const knn: estypes.KnnSearch = {
        field: 'embedding',
        query_vector: queryVector,
        k,
        num_candidates: Math.max(k * 10, 50),
      };
      if (vis) knn.filter = vis;
      const response = await this.es.search({
        index: CHUNK_INDEX,
        size: k,
        knn,
        _source: [
          'chunk_id',
          'document_id',
          'document_title',
          'content',
          'heading',
        ],
      });
      return this.mapHits(response.hits.hits);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Vector search failed: ${message}`);
      return [];
    }
  }

  /**
   * Hybrid retrieval: retrieve keywords and vectors in parallel, then fuse by chunkId with RRF.
   * Use keyword retrieval only when embeddings fail or are not provided.
   */
  async searchHybrid(params: {
    query: string;
    queryVector?: number[] | null;
    hybridTopK?: number;
    rrfC?: number;
    scope?: DocumentAccessScope;
  }): Promise<ChunkHit[]> {
    const hybridTopK = this.clampTopK(params.hybridTopK ?? 20);
    const rrfC = params.rrfC && params.rrfC > 0 ? params.rrfC : 60;

    const [keywordHits, vectorHits] = await Promise.all([
      this.keywordSearch(params.query, hybridTopK, params.scope),
      params.queryVector?.length
        ? this.knnSearch(params.queryVector, hybridTopK, params.scope)
        : Promise.resolve([] as ChunkHit[]),
    ]);

    const fused = this.rrfFuse(keywordHits, vectorHits, rrfC);
    this.logger.log(
      `Hybrid retrieval RRF: keyword=${keywordHits.length}, vector=${vectorHits.length}, fused=${fused.length}`,
    );
    return fused;
  }

  private clampTopK(topK: number): number {
    return Math.min(Math.max(topK, 1), 50);
  }

  private mapHits(
    hits: Array<{
      _id?: string;
      _score?: number | null;
      _source?: unknown;
    }>,
  ): ChunkHit[] {
    return hits.map((hit) => {
      const src = (hit._source ?? {}) as Record<string, unknown>;
      return {
        chunkId: scalarToString(src.chunk_id, hit._id ?? ''),
        documentId: scalarToString(src.document_id),
        documentTitle: scalarToString(src.document_title),
        content: scalarToString(src.content),
        heading: typeof src.heading === 'string' ? src.heading : null,
        score: hit._score ?? 0,
      };
    });
  }

  /**
   * Reciprocal Rank Fusion：score(d) = Σ 1 / (C + rank_r(d))
   * Sort each result stream by its raw score before calculating ranks.
   */
  private rrfFuse(
    keywordHits: ChunkHit[],
    vectorHits: ChunkHit[],
    rrfC: number,
  ): ChunkHit[] {
    const fused = new Map<string, ChunkHit>();

    const addChannel = (hits: ChunkHit[], channel: 'keyword' | 'vector') => {
      const sorted = [...hits].sort((a, b) => b.score - a.score);
      sorted.forEach((hit, rank) => {
        const rrf = 1 / (rrfC + rank + 1);
        const existing = fused.get(hit.chunkId);
        if (!existing) {
          fused.set(hit.chunkId, {
            ...hit,
            score: rrf,
            bm25Score: channel === 'keyword' ? hit.score : 0,
            vectorScore: channel === 'vector' ? hit.score : 0,
          });
          return;
        }
        existing.score += rrf;
        if (channel === 'keyword') existing.bm25Score = hit.score;
        if (channel === 'vector') existing.vectorScore = hit.score;
      });
    };

    addChannel(keywordHits, 'keyword');
    addChannel(vectorHits, 'vector');

    return [...fused.values()].sort((a, b) => b.score - a.score);
  }

  /**
   * Create the kh_chunk index (dense_vector + IK).
   * Use keyword for document_id because Snowflake IDs are strings and JavaScript long precision is limited.
   */
  private async createIndexIfNotExists() {
    if (!this.es) return;

    const exists = await this.es.indices.exists({ index: CHUNK_INDEX });
    if (exists) return;

    try {
      await this.es.indices.create({
        index: CHUNK_INDEX,
        settings: {
          number_of_shards: 1,
          number_of_replicas: 0,
          refresh_interval: '5s',
        },
        mappings: {
          properties: {
            chunk_id: { type: 'keyword' },
            document_id: { type: 'keyword' },
            document_title: {
              type: 'text',
              analyzer: 'ik_max_word',
              search_analyzer: 'ik_smart',
              fields: { keyword: { type: 'keyword' } },
            },
            content: {
              type: 'text',
              analyzer: 'ik_max_word',
              search_analyzer: 'ik_smart',
            },
            heading: { type: 'keyword' },
            chunk_index: { type: 'integer' },
            total_chunks: { type: 'integer' },
            category_id: { type: 'keyword' },
            author_id: { type: 'keyword' },
            team_id: { type: 'keyword' },
            is_public: { type: 'boolean' },
            doc_status: { type: 'integer' },
            publish_time: { type: 'date' },
            indexed_at: { type: 'date' },
            embedding: {
              type: 'dense_vector',
              dims: this.embeddingDims,
              index: true,
              similarity: 'cosine',
            },
          },
        },
      });
      this.logger.log(
        `ES index created: index=${CHUNK_INDEX}, dims=${this.embeddingDims}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('resource_already_exists')) {
        return;
      }
      this.logger.error(`ES index creation failed: ${message}`);
      throw error;
    }
  }

  /** Add visibility fields to an existing index whose mapping lacks is_public. */
  private async ensureVisibilityMapping() {
    if (!this.es) return;
    try {
      await this.es.indices.putMapping({
        index: CHUNK_INDEX,
        properties: {
          is_public: { type: 'boolean' },
          author_id: { type: 'keyword' },
          team_id: { type: 'keyword' },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`kh_chunk visibility mapping update failed: ${message}`);
    }
  }

  private buildDocMap(chunk: DocumentChunk): Record<string, unknown> {
    const doc: Record<string, unknown> = {
      chunk_id: chunk.chunkId,
      document_id: chunk.documentId,
      document_title: chunk.documentTitle,
      content: chunk.content,
      heading: chunk.heading ?? null,
      chunk_index: chunk.chunkIndex,
      total_chunks: chunk.totalChunks,
      category_id: chunk.categoryId ?? null,
      author_id: chunk.authorId ?? null,
      team_id: chunk.teamId ?? null,
      is_public: chunk.isPublic ?? false,
      doc_status: chunk.docStatus ?? null,
      publish_time: chunk.publishTime ?? null,
      indexed_at: new Date().toISOString(),
    };
    if (chunk.embedding?.length) {
      doc.embedding = chunk.embedding;
    }
    return doc;
  }
}
