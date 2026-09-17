/**
 * Shared pipeline type definitions.
 *
 * These structures flow through MQ messages, chunking results, and graph extraction results.
 */

/**
 * A text chunk created from a document.
 * RAG writes it to ES `kh_chunk` with an embedding (dense_vector); KG uses it as an extraction unit.
 */
export interface DocumentChunk {
  /** Stable ID: first 64 characters of sha256(documentId:index), replaceable during rebuilds. */
  chunkId: string;
  documentId: string;
  documentTitle: string;
  /** Text sent for embedding/extraction, usually prefixed with its section heading. */
  content: string;
  /** Markdown heading; null for an unheaded section. */
  heading?: string | null;
  /** Zero-based chunk index. */
  chunkIndex: number;
  /** Total chunks for the document, filled after chunking. */
  totalChunks: number;
  categoryId?: string | null;
  authorId?: string | null;
  teamId?: string | null;
  isPublic?: boolean;
  docStatus?: number | null;
  publishTime?: string | null;
  /** Embedding; empty during chunking and filled by EmbeddingService before ES dense_vector writes. */
  embedding?: number[];
}

/** kh_chunk retrieval hit shared by keyword, vector, and RRF results. */
export interface ChunkHit {
  chunkId: string;
  documentId: string;
  documentTitle: string;
  content: string;
  heading: string | null;
  /** Score for the current stage: raw retrieval, RRF, or rerank score. */
  score: number;
  bm25Score?: number;
  vectorScore?: number;
}

/** Graph entity (for example, a person, onboarding process, or knowledge base). */
export interface ExtractedEntity {
  name: string;
  /** PERSON / ORGANIZATION / CONCEPT / DOCUMENT / PROCESS / PRODUCT, etc.; see docs/kg-extraction-schema.md. */
  type: string;
  description?: string;
  aliases?: string[];
}

/** Relation between entities: source -[relation]-> target. */
export interface ExtractedRelation {
  source: string;
  target: string;
  relation: string;
  weight?: number;
}

/** Extraction result for one chunk. */
export interface ExtractionResult {
  chunkId?: string;
  entities: ExtractedEntity[];
  relations: ExtractedRelation[];
}

/**
 * Internal pipeline document snapshot:
 * Postgres metadata combined with Mongo content so services do not query both repeatedly.
 */
export interface PipelineDocument {
  id: string;
  title: string;
  content: string;
  summary?: string | null;
  categoryId?: string | null;
  authorId?: string | null;
  teamId?: string | null;
  status: number;
  tags?: string | null;
  isPublic?: boolean;
  viewCount?: number;
  likeCount?: number;
  commentCount?: number;
  publishTime?: Date | string | null;
  createdAt?: Date | string | null;
  updatedAt?: Date | string | null;
}
