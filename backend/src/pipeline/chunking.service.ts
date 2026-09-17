import { createHash } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RecursiveCharacterTextSplitter } from '@langchain/textsplitters';
import { DocumentChunk } from './types/pipeline.types';

/**
 * Document chunking service (based on LangChain RecursiveCharacterTextSplitter / Markdown).
 *
 * <p>Why chunk documents?</p>
 * RAG cannot embed or send an entire document to an LLM:
 * - Embeddings have length limits, so long input is truncated.
 * - Retrieval needs paragraph-level matches; retrieving a whole document adds too much noise.
 *
 * <p>Chunking strategy:</p>
 * <ol>
 *   <li>Recursively split with Markdown-aware separators (headings / code blocks / paragraphs).</li>
 *   <li>Control chunk size and overlap with chunkSize / chunkOverlap.</li>
 *   <li>Infer heading from heading lines, inherit the previous heading across chunks, and add prefixes when needed.</li>
 * </ol>
 *
 * <p>Configuration:</p>
 * - RAG_CHUNK_SIZE: target token count (default 512).
 * - RAG_CHUNK_OVERLAP: overlap token count (default 64).
 * - Conversion: CHARS_PER_TOKEN=2, so 512 tokens is approximately 1,024 characters.
 */
@Injectable()
export class ChunkingService {
  private readonly logger = new Logger(ChunkingService.name);
  private readonly splitter: RecursiveCharacterTextSplitter;

  /**
   * Approximate token-to-character conversion factor.
   * Conservative for mixed English/CJK content: approximately 1 token = 2 characters.
   */
  private static readonly CHARS_PER_TOKEN = 2.0;

  /** Match Markdown ATX heading lines in a chunk. */
  private static readonly HEADING_LINE = /^(#{1,6})\s+(.+)$/m;

  constructor(config: ConfigService) {
    const chunkSizeTokens = Number(config.get('RAG_CHUNK_SIZE', 512));
    const chunkOverlapTokens = Number(config.get('RAG_CHUNK_OVERLAP', 64));
    const chunkSize = Math.floor(
      chunkSizeTokens * ChunkingService.CHARS_PER_TOKEN,
    );
    const chunkOverlap = Math.floor(
      chunkOverlapTokens * ChunkingService.CHARS_PER_TOKEN,
    );

    // The built-in Markdown separators omit H1 (\n#); add it so top-level headings split chunks.
    this.splitter = new RecursiveCharacterTextSplitter({
      chunkSize,
      chunkOverlap,
      keepSeparator: true,
      separators: [
        '\n# ',
        ...RecursiveCharacterTextSplitter.getSeparatorsForLanguage('markdown'),
      ],
    });
  }

  /**
   * Split document content into indexable DocumentChunk records.
   *
   * @param params.content Markdown content.
   * @param params.documentId Document Snowflake ID (stored in chunk metadata for document-level deletion).
   * @param params.documentTitle Document title (shown in retrieval results).
   * @returns Chunked records; returns [] for empty content.
   */
  async chunk(params: {
    content: string;
    documentId: string;
    documentTitle: string;
    categoryId?: string | null;
    authorId?: string | null;
    teamId?: string | null;
    isPublic?: boolean;
    docStatus?: number | null;
    publishTime?: string | null;
  }): Promise<DocumentChunk[]> {
    const { content, documentId, documentTitle } = params;
    if (!content?.trim()) {
      this.logger.warn(
        `Document content is empty; skipping chunking: documentId=${documentId}`,
      );
      return [];
    }

    const texts = await this.splitter.splitText(content);
    const chunks: DocumentChunk[] = [];
    let currentHeading: string | null = null;

    for (const text of texts) {
      const trimmed = text.trim();
      if (!trimmed) continue;

      const headingInChunk = this.extractHeading(trimmed);
      if (headingInChunk) {
        currentHeading = headingInChunk;
      }

      // Later chunks in the same section often have no heading; add a prefix to preserve context in retrieval.
      let chunkContent = trimmed;
      if (currentHeading && !ChunkingService.HEADING_LINE.test(trimmed)) {
        chunkContent = `${currentHeading}\n\n${trimmed}`;
      }

      chunks.push({
        chunkId: createHash('sha256')
          .update(`${documentId}:${chunks.length}`)
          .digest('hex')
          .slice(0, 64),
        documentId,
        documentTitle,
        content: chunkContent,
        heading: currentHeading,
        chunkIndex: chunks.length,
        totalChunks: 0,
        categoryId: params.categoryId,
        authorId: params.authorId,
        teamId: params.teamId,
        isPublic: params.isPublic,
        docStatus: params.docStatus,
        publishTime: params.publishTime,
      });
    }

    const total = chunks.length;
    chunks.forEach((c) => {
      c.totalChunks = total;
    });

    this.logger.debug(
      `Document chunking completed: documentId=${documentId}, totalChunks=${total}`,
    );
    return chunks;
  }

  /** Get the first ATX heading text in a chunk, without # markers. */
  private extractHeading(text: string): string | null {
    const match = text.match(ChunkingService.HEADING_LINE);
    return match?.[2]?.trim() || null;
  }
}
