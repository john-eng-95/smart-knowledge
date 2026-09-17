/**
 * RabbitMQ topology constants.
 *
 * Exchanges: rag.reindex / search.index / kg.graph.
 * Queue names use the `kh.` prefix to avoid collisions with other local projects.
 */

/** RAG reindex exchange (topic). */
export const RAG_REINDEX_EXCHANGE = 'rag.reindex.exchange';
/** Document-level search index exchange (topic). */
export const SEARCH_INDEX_EXCHANGE = 'search.index.exchange';
/** Knowledge graph build exchange (topic). */
export const KG_GRAPH_EXCHANGE = 'kg.graph.exchange';

/** Queues consumed by this service. */
export const RAG_REINDEX_QUEUE = 'kh.rag.reindex.queue';
export const SEARCH_INDEX_QUEUE = 'kh.search.index.queue';
export const KG_GRAPH_QUEUE = 'kh.kg.graph.queue';

/** Routing keys for document-level rebuild and deletion. */
export const RAG_RK_BY_IDS = 'rag.reindex.by_ids';
export const RAG_RK_DELETE = 'rag.reindex.delete';
export const SEARCH_RK_INDEX = 'search.index.document';
export const SEARCH_RK_DELETE = 'search.index.delete';
export const KG_RK_BUILD_BY_IDS = 'kg.graph.build.by_ids';
export const KG_RK_DELETE = 'kg.graph.delete';
