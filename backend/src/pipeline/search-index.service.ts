import { Client } from '@elastic/elasticsearch';
import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { scalarToString } from '../common/scalar-string';
import {
  ES_DOC_VISIBILITY_FIELDS,
  esVisibilityFilter,
  type DocumentAccessScope,
} from '../document/document-access';

/** ES document-level full-text search index name. */
const ES_INDEX = 'kh_document';

/**
 * Document-level full-text search index.
 *
 * <p>Difference from the RAG vector index:</p>
 * - This stores one record per whole document (title/summary/content) for keyword search.
 * - RAG stores multiple chunks and vectors for conversational retrieval.
 *
 * <p>Writes only to Elasticsearch `kh_document`; skips writes and logs when ES is unavailable.</p>
 */
@Injectable()
export class SearchIndexService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SearchIndexService.name);
  private es: Client | null = null;
  private readonly esEnabled: boolean;

  constructor(private readonly config: ConfigService) {
    this.esEnabled =
      this.config.get<string>('ELASTICSEARCH_ENABLED', 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.esEnabled) {
      this.logger.warn(
        'Elasticsearch is disabled; skipping search index writes',
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
        `SearchIndex ES connected: ${node}, status=${health.status}`,
      );
      await this.ensureEsIndex();
      await this.ensureVisibilityMapping();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Elasticsearch unavailable; skipping search index writes: ${message}`,
      );
      this.es = null;
    }
  }

  async onModuleDestroy() {
    await this.es?.close();
  }

  /**
   * Upsert a document search record, including full Mongo content.
   */
  async indexDocument(doc: Record<string, unknown>) {
    if (!this.es) {
      this.logger.warn(
        `Skipping search index write (ES unavailable): documentId=${String(doc.id)}`,
      );
      return;
    }

    const id = String(doc.id);
    await this.es.index({
      index: ES_INDEX,
      id,
      document: {
        ...doc,
        indexedAt: new Date().toISOString(),
      },
      refresh: true,
    });

    this.logger.log(`Search index written to ES: documentId=${id}`);
  }

  /** Update visibility fields for published documents without reindexing the whole document. */
  async updateVisibility(
    documentId: string,
    vis: { isPublic: boolean; teamId: string | null; authorId: string | null },
  ) {
    if (!this.es) {
      this.logger.warn(
        `Skipping search visibility update (ES unavailable): documentId=${documentId}`,
      );
      return;
    }
    try {
      await this.es.update({
        index: ES_INDEX,
        id: documentId,
        doc: {
          isPublic: vis.isPublic,
          teamId: vis.teamId,
          authorId: vis.authorId,
        },
        refresh: true,
      });
      this.logger.log(
        `Search index visibility updated: documentId=${documentId}`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Search index visibility update failed: documentId=${documentId}, ${message}`,
      );
    }
  }

  /** Remove from ES when unpublished or deleted. */
  async deleteDocument(documentId: string) {
    if (!this.es) {
      this.logger.warn(
        `Skipping search index deletion (ES unavailable): documentId=${documentId}`,
      );
      return;
    }

    try {
      await this.es.delete({
        index: ES_INDEX,
        id: documentId,
        refresh: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!message.includes('404')) {
        this.logger.warn(
          `ES deletion failed: documentId=${documentId}, ${message}`,
        );
      }
    }

    this.logger.log(`Search index deleted: documentId=${documentId}`);
  }

  /**
   * Keyword search across kh_document.
   * Return an empty page without throwing when ES is unavailable.
   */
  async searchDocuments(params: {
    keyword: string;
    page?: number;
    pageSize?: number;
    categoryId?: string;
    authorId?: string;
    scope?: DocumentAccessScope;
  }) {
    const page = params.page ?? 1;
    const pageSize = Math.min(params.pageSize ?? 10, 50);
    const from = (page - 1) * pageSize;

    if (!this.es) {
      this.logger.warn('Skipping search query (ES unavailable)');
      return { items: [], total: 0, page, pageSize };
    }

    const filters: Record<string, unknown>[] = [];
    const vis = params.scope
      ? esVisibilityFilter(params.scope, ES_DOC_VISIBILITY_FIELDS)
      : null;
    if (vis) filters.push(vis);
    if (params.categoryId) {
      filters.push({ term: { categoryId: params.categoryId } });
    }
    if (params.authorId) {
      filters.push({ term: { authorId: params.authorId } });
    }

    const keyword = params.keyword.trim();
    // title^3 / summary^2: title and summary matches outweigh content; filters do not affect scores.
    const query =
      filters.length > 0
        ? {
            bool: {
              must: [
                {
                  multi_match: {
                    query: keyword,
                    fields: ['title^3', 'summary^2', 'content'],
                    analyzer: 'ik_smart',
                  },
                },
              ],
              filter: filters,
            },
          }
        : {
            multi_match: {
              query: keyword,
              fields: ['title^3', 'summary^2', 'content'],
              analyzer: 'ik_smart',
            },
          };

    try {
      const response = await this.es.search({
        index: ES_INDEX,
        from,
        size: pageSize,
        query,
        // Do not return full content in the list; still use content for matching and highlighting.
        _source: {
          excludes: ['content'],
        },
        // Wrap matching fragments in <em> for frontend snippets; use up to three content fragments and the full title.
        highlight: {
          fields: {
            title: { number_of_fragments: 0 },
            content: { fragment_size: 160, number_of_fragments: 3 },
            summary: { fragment_size: 120, number_of_fragments: 1 },
          },
        },
      });

      const totalRaw = response.hits.total;
      const total =
        typeof totalRaw === 'number' ? totalRaw : (totalRaw?.value ?? 0);

      const items = (response.hits.hits ?? []).map((hit) => {
        const src = (hit._source ?? {}) as Record<string, unknown>;
        const highlight = hit.highlight ?? {};
        return {
          id: scalarToString(src.id, hit._id ?? ''),
          title: src.title ?? '',
          summary: src.summary ?? null,
          categoryId: src.categoryId ?? null,
          tags: src.tags ?? null,
          authorId: src.authorId ?? null,
          teamId: src.teamId ?? null,
          isPublic: src.isPublic ?? null,
          status: src.status ?? null,
          publishTime: src.publishTime ?? null,
          score: hit._score ?? 0,
          highlight: {
            title: highlight.title ?? [],
            summary: highlight.summary ?? [],
            content: highlight.content ?? [],
          },
        };
      });

      return { items, total, page, pageSize };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Search query failed: ${message}`);
      return { items: [], total: 0, page, pageSize };
    }
  }

  /** For Chinese text, index with fine tokenization (ik_max_word) and search with coarse tokenization (ik_smart). */
  private readonly ikText = {
    type: 'text' as const,
    analyzer: 'ik_max_word',
    search_analyzer: 'ik_smart',
  };

  /** Create the index when absent (title / summary / content use IK). */
  private async ensureEsIndex() {
    if (!this.es) return;
    const exists = await this.es.indices.exists({ index: ES_INDEX });
    if (exists) return;

    await this.es.indices.create({
      index: ES_INDEX,
      mappings: {
        properties: {
          id: { type: 'keyword' },
          title: this.ikText,
          summary: this.ikText,
          content: this.ikText,
          tags: { type: 'keyword' },
          status: { type: 'integer' },
          categoryId: { type: 'keyword' },
          authorId: { type: 'keyword' },
          teamId: { type: 'keyword' },
          isPublic: { type: 'boolean' },
          publishTime: { type: 'date' },
        },
      },
    });
    this.logger.log(`ES index created: ${ES_INDEX}`);
  }

  /** Add visibility fields to an existing index whose mapping lacks isPublic. */
  private async ensureVisibilityMapping() {
    if (!this.es) return;
    try {
      await this.es.indices.putMapping({
        index: ES_INDEX,
        properties: {
          isPublic: { type: 'boolean' },
          teamId: { type: 'keyword' },
          authorId: { type: 'keyword' },
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `kh_document visibility mapping update failed: ${message}`,
      );
    }
  }
}
