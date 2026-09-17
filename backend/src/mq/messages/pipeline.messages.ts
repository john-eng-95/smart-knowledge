/** RAG reindex/delete message. */
export type ReindexType = 'BY_DOC_IDS' | 'DELETE_BY_DOC_IDS';

export interface ReindexMessage {
  taskId: string;
  type: ReindexType;
  documentIds?: string[];
}

/** ES search index message; the consumer loads the full text from MongoDB. */
export type SearchIndexType = 'INDEX' | 'DELETE';

export interface SearchIndexMessage {
  taskId: string;
  type: SearchIndexType;
  documentId: string;
}

/** Knowledge graph build/delete message. */
export type KgBuildType =
  'BUILD_ALL' | 'BUILD_BY_DOC_IDS' | 'DELETE_BY_DOC_IDS';

export interface KgBuildMessage {
  taskId: string;
  type: KgBuildType;
  documentIds?: string[];
}
