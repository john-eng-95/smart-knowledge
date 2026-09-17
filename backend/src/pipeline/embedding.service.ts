import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OpenAIEmbeddings } from '@langchain/openai';

/**
 * Text embedding service (based on LangChain OpenAIEmbeddings).
 *
 * <p>Converts chunk text into fixed-dimension float vectors for similarity retrieval.</p>
 *
 * <p>Relevant environment variables:</p>
 * - EMBEDDING_API_KEY / DASHSCOPE_API_KEY / OPENAI_API_KEY
 * - EMBEDDING_BASE_URL, EMBEDDING_MODEL, EMBEDDING_DIMENSION, EMBEDDING_BATCH_SIZE
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  /** Vector dimension, which must match ES dense_vector.dims (kh_chunk.embedding). */
  private readonly dimension: number;
  private readonly embeddings: OpenAIEmbeddings | null;

  constructor(config: ConfigService) {
    this.dimension = Number(config.get('EMBEDDING_DIMENSION', 1024));
    // DashScope text-embedding-v3 accepts at most 10 items per request; larger batches return 400 InvalidParameter.
    const configuredBatch = Number(config.get('EMBEDDING_BATCH_SIZE', 10));
    const batchSize = Math.min(
      Number.isFinite(configuredBatch) && configuredBatch > 0
        ? configuredBatch
        : 10,
      10,
    );
    if (configuredBatch > 10) {
      this.logger.warn(
        `EMBEDDING_BATCH_SIZE=${configuredBatch} exceeds the DashScope limit; clamped to 10`,
      );
    }

    const apiKey =
      config.get<string>('EMBEDDING_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      config.get<string>('OPENAI_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        'Embedding provider is not configured; vectorization is unavailable',
      );
      this.embeddings = null;
      return;
    }

    const baseUrl = config.get<string>(
      'EMBEDDING_BASE_URL',
      'https://dashscope.aliyuncs.com/compatible-mode/v1',
    );
    const model = config.get<string>('EMBEDDING_MODEL', 'text-embedding-v3');

    this.embeddings = new OpenAIEmbeddings({
      apiKey,
      model,
      dimensions: this.dimension,
      batchSize,
      // Preserve line breaks in Markdown chunks so their semantics are not flattened.
      stripNewLines: false,
      configuration: {
        baseURL: baseUrl,
      },
    });
  }

  /** Embed one text. */
  async embed(text: string): Promise<number[]> {
    const [vec] = await this.embedBatch([text]);
    return vec;
  }

  /** Embed a batch of texts (the provider handles EMBEDDING_BATCH_SIZE batching). */
  async embedBatch(texts: string[]): Promise<number[][]> {
    if (!texts.length) return [];
    if (!this.embeddings) {
      throw new Error(
        'Set EMBEDDING_API_KEY, DASHSCOPE_API_KEY, or OPENAI_API_KEY to enable vectorization',
      );
    }

    const vectors = await this.embeddings.embedDocuments(texts);
    this.logger.debug(`Embedding completed: count=${vectors.length}`);
    return vectors;
  }
}
