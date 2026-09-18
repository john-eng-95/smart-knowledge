import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { HybridRetrievalService } from './hybrid-retrieval.service';
import { ChunkHit } from '../pipeline/types/pipeline.types';
import { ChatSessionService } from './chat-session.service';
import { ChatShortMemoryService } from './chat-short-memory.service';
import { ChatLongMemoryService } from './chat-long-memory.service';
import {
  ChatQueryRewriteService,
  type ChatIntent,
} from './chat-query-rewrite.service';
import { retrieveUntilRelevant } from './agentic-retrieve';
import { WebSearchService, type WebSearchResult } from './web-search.service';
import { dbRowsToMessages } from './chat-memory.util';
import type { AuthUser } from '../auth/auth-user.interface';
import type { ChatSource } from './chat.types';

export type { ChatSource } from './chat.types';

const EXCERPT_LEN = 200; // Maximum citation excerpt length in characters.
const CITATION_RE = /\[(\d+)\]/g; // Citation markers such as [1] and [2].

/**
 * Non-streaming Agentic RAG: route intent -> retrieve and grade -> rewrite and retry
 * when needed -> search the web when allowed -> generate an answer.
 */
@Injectable()
export class AiChatService {
  private readonly logger = new Logger(AiChatService.name);
  private readonly llm?: ChatOpenAI;

  constructor(
    config: ConfigService,
    private readonly retrieval: HybridRetrievalService,
    private readonly sessions: ChatSessionService,
    private readonly shortMemory: ChatShortMemoryService,
    private readonly longMemory: ChatLongMemoryService,
    private readonly queryRewrite: ChatQueryRewriteService,
    private readonly webSearch: WebSearchService,
  ) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      undefined;
    if (!apiKey) {
      return;
    }

    const baseUrl =
      config.get<string>('OPENAI_BASE_URL') ||
      config.get<string>('LLM_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const model =
      config.get<string>('MODEL_NAME') ||
      config.get<string>('LLM_MODEL') ||
      'qwen-plus';

    this.llm = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0.2,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL: baseUrl },
    });
  }

  async chat(question: string, topK = 5, user?: AuthUser, sessionId?: string) {
    const trimmed = question.trim();
    if (!trimmed) {
      return {
        sessionId: sessionId ?? null,
        answer: 'Please enter a question.',
        sources: [] as ChatSource[],
      };
    }

    const history = user
      ? await this.loadWorkingHistory(user.userId, sessionId)
      : [];
    const plan = await this.queryRewrite.classify(trimmed, history);
    const memHitsP = user
      ? this.longMemory.search(user.userId, sessionId, plan.query)
      : Promise.resolve({ user: [] as string[], session: [] as string[] });
    // The non-streaming path has no tool loop, but uses the same retrieve-grade-rewrite flow.
    let hits = [] as ChunkHit[];
    let kbInsufficient = false;
    let searchQuery = plan.query || trimmed;
    if (plan.allowRetrieve) {
      const retrieved = await retrieveUntilRelevant({
        question: trimmed,
        query: plan.query,
        topK,
        user,
        retrieval: this.retrieval,
        rewrite: this.queryRewrite,
      });
      hits = retrieved.hits;
      kbInsufficient = !retrieved.eval.ok;
      searchQuery = retrieved.usedQuery || searchQuery;
    }
    const web =
      plan.allowWeb && (!plan.allowRetrieve || kbInsufficient)
        ? await this.webSearch.search(searchQuery)
        : undefined;
    const memHits = await memHitsP;
    if (plan.intent === 'kb' && kbInsufficient) {
      const empty = {
        answer: 'No relevant content was found in the knowledge base.',
        sources: [] as ChatSource[],
      };
      const session = user
        ? await this.sessions.appendTurn(
            user.userId,
            sessionId,
            trimmed,
            empty.answer,
            empty.sources,
          )
        : null;
      if (user && session) {
        await this.shortMemory.appendTurn(
          user.userId,
          session.id,
          history,
          trimmed,
          empty.answer,
        );
        void this.longMemory.rememberTurn(
          user.userId,
          session.id,
          trimmed,
          empty.answer,
        );
      }
      return { sessionId: session?.id ?? sessionId ?? null, ...empty };
    }

    if (!this.llm) {
      throw new ServiceUnavailableException(
        'OPENAI_API_KEY, LLM_API_KEY, or DASHSCOPE_API_KEY is not configured; unable to generate a response',
      );
    }

    const memoryMsg = this.longMemory.buildSystemMessage(memHits);
    const parts: string[] = [];
    if (hits.length)
      parts.push(`Knowledge base sources:\n${this.buildContext(hits)}`);
    if (web) parts.push(`Web search results:\n${this.buildWebContext(web)}`);
    parts.push(`User question: ${trimmed}`);
    const userTurn = parts.join('\n\n');
    const response = await this.llm.invoke([
      new SystemMessage(
        this.buildSystemPrompt(plan.intent, Boolean(hits.length), web),
      ),
      ...(memoryMsg ? [memoryMsg] : []),
      ...history,
      new HumanMessage(userTurn),
    ]);

    const answer =
      typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content);

    const sources = this.toCitedSources(answer, hits);
    this.logger.log(
      `RAG chat completed: hits=${hits.length}, cited=${sources.length}, answerLength=${answer.length}`,
    );

    const session = user
      ? await this.sessions.appendTurn(
          user.userId,
          sessionId,
          trimmed,
          answer,
          sources,
        )
      : null;

    if (user && session) {
      await this.shortMemory.appendTurn(
        user.userId,
        session.id,
        history,
        trimmed,
        answer,
      );
      void this.longMemory.rememberTurn(
        user.userId,
        session.id,
        trimmed,
        answer,
      );
    }

    return { sessionId: session?.id ?? sessionId ?? null, answer, sources };
  }

  private async loadWorkingHistory(
    userId: string,
    sessionId: string | undefined,
  ): Promise<BaseMessage[]> {
    if (!sessionId) return [];
    const cached = await this.shortMemory.tryLoad(userId, sessionId);
    if (cached) return cached;
    const rows = await this.sessions.listRecentMessages(
      userId,
      sessionId,
      this.shortMemory.windowSize,
    );
    const history = dbRowsToMessages(rows);
    if (history.length) {
      await this.shortMemory.save(userId, sessionId, history);
    }
    return history;
  }

  /** Extract [n] citations and return only cited sources; fall back to all excerpts when uncited. */
  private toCitedSources(answer: string, hits: ChunkHit[]): ChatSource[] {
    const cited = new Set<number>();
    for (const match of answer.matchAll(CITATION_RE)) {
      const n = Number(match[1]);
      if (n >= 1 && n <= hits.length) cited.add(n);
    }

    const indexes =
      cited.size > 0
        ? [...cited].sort((a, b) => a - b)
        : hits.map((_, i) => i + 1);

    return indexes.map((index) => this.toSource(index, hits[index - 1]));
  }

  private toSource(index: number, hit: ChunkHit): ChatSource {
    return {
      index,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      heading: hit.heading,
      excerpt: this.excerpt(hit.content),
      score: hit.score,
    };
  }

  private excerpt(content: string): string {
    const text = content.replace(/\s+/g, ' ').trim();
    if (text.length <= EXCERPT_LEN) return text;
    return `${text.slice(0, EXCERPT_LEN)}...`;
  }

  private buildContext(hits: ChunkHit[]): string {
    return hits
      .map((src, i) => {
        const heading = src.heading ? ` / ${src.heading}` : '';
        const snippet =
          src.content.length > 800
            ? `${src.content.slice(0, 800)}...`
            : src.content;
        return `[${i + 1}] ${src.documentTitle}${heading}\n${snippet}`;
      })
      .join('\n\n');
  }

  private buildWebContext(web: WebSearchResult): string {
    if (web.error) return web.error;
    if (!web.items.length) return 'No results.';
    return web.items
      .map((hit, i) => `${i + 1}. ${hit.title}\n${hit.url}\n${hit.snippet}`)
      .join('\n\n');
  }

  private buildSystemPrompt(
    intent: ChatIntent,
    hasKb: boolean,
    web?: WebSearchResult,
  ): string {
    let prompt =
      'You are an enterprise knowledge base assistant. Use conversation history and relevant user memory when answering. ' +
      'Treat knowledge base sources from this turn as authoritative for policies and procedures; never replace documents with memory.';
    if (hasKb) {
      prompt +=
        'Every statement based on a source must end with the matching source number, such as [1] or [2]. ' +
        'Source numbers must match the provided list; do not cite unused numbers or invent document titles or links.';
    } else if (intent === 'kb' || intent === 'kb_then_web') {
      prompt +=
        'No relevant knowledge base sources were found; do not invent internal policies.';
    }
    if (web?.items.length) {
      prompt +=
        'Use web results only as supplemental public information, citing their titles and links; do not present them as internal policy.';
    }
    if (intent === 'chitchat' || intent === 'profile') {
      prompt +=
        'You may answer greetings or profile questions, but do not invent company policy.';
    }
    prompt +=
      'When the available information is insufficient, say that you do not know. Keep the answer concise and use lists when helpful.';
    return prompt;
  }
}
