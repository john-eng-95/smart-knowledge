import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from '../pipeline/embedding.service';
import { VectorIndexService } from '../pipeline/vector-index.service';
import { ChunkHit } from '../pipeline/types/pipeline.types';
import { RerankerService } from './reranker.service';
import { accessFromUser } from '../document/document-access';
import type { AuthUser } from '../auth/auth-user.interface';

/**
 * Hybrid kh_chunk retrieval:
 * vector retrieval + keyword retrieval -> RRF fusion -> reranker refinement.
 */
@Injectable()
export class HybridRetrievalService {
  private readonly logger = new Logger(HybridRetrievalService.name);
  private readonly hybridTopK: number;
  private readonly rrfC: number;
  /** Minimum rerank relevance_score (0-1). */
  private readonly minScore: number;

  constructor(
    config: ConfigService,
    private readonly embedding: EmbeddingService,
    private readonly vectorIndex: VectorIndexService,
    private readonly reranker: RerankerService,
  ) {
    this.hybridTopK = Number(config.get('RAG_HYBRID_TOP_K', 20));
    this.rrfC = Number(config.get('RAG_RRF_C', 60));
    this.minScore = Number(config.get('RAG_MIN_SCORE', 0.4));
  }

  async retrieve(
    query: string,
    topK = 5,
    user?: AuthUser,
  ): Promise<ChunkHit[]> {
    const queryVector = await this.embedQuery(query);
    const scope = user
      ? accessFromUser(user)
      : { unrestricted: false, userId: '', teamIds: [] };
    const fused = await this.vectorIndex.searchHybrid({
      query,
      queryVector,
      hybridTopK: this.hybridTopK,
      rrfC: this.rrfC,
      scope,
    });

    if (!fused.length) {
      this.logger.log(
        `Hybrid retrieval returned no results: queryLength=${query.length}`,
      );
      return [];
    }

    const reranked = await this.reranker.rerank(query, fused, fused.length);
    if (reranked?.length) {
      const kept =
        this.minScore > 0
          ? reranked.filter((hit) => hit.score >= this.minScore)
          : reranked;
      const top = kept.slice(0, topK);
      this.logger.log(
        `Retrieval filter: rerank=${reranked.length}, minScore=${this.minScore}, ` +
          `best=${reranked[0]?.score?.toFixed(3) ?? '-'}, kept=${kept.length}, return=${top.length}`,
      );
      return top;
    }

    return fused.slice(0, topK);
  }

  private async embedQuery(query: string): Promise<number[] | null> {
    try {
      return await this.embedding.embed(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Query embedding failed; using keyword retrieval only: ${message}`,
      );
      return null;
    }
  }
}
