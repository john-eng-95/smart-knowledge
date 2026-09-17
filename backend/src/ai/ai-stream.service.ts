import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
} from 'ai';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import {
  createAgent,
  modelCallLimitMiddleware,
  summarizationMiddleware,
  tool,
} from 'langchain';
import { z } from 'zod';
import type { Response } from 'express';
import { HybridRetrievalService } from './hybrid-retrieval.service';
import { ChatSessionService } from './chat-session.service';
import { ChatShortMemoryService } from './chat-short-memory.service';
import { ChatLongMemoryService } from './chat-long-memory.service';
import { ChatQueryRewriteService } from './chat-query-rewrite.service';
import { WebSearchService } from './web-search.service';
import { dbRowsToMessages } from './chat-memory.util';
import type { AuthUser } from '../auth/auth-user.interface';
import type { ChatSource } from './chat.types';
import type { ChatStreamDto } from './dto/chat-stream.dto';
import type { ChunkHit } from '../pipeline/types/pipeline.types';

const EXCERPT_LEN = 200;

const SYSTEM =
  'You are an enterprise knowledge base assistant. Prefer the retrieved sources when answering. ' +
  'Use conversation history and user background from memory, but treat sources from this turn as authoritative for policies and procedures; never replace documents with memory. ' +
  'For greetings without retrieved sources, respond directly without calling web_search. ' +
  'When sources are insufficient, current information is required, or external public information is needed, call web_search. ' +
  'End source-based statements with the matching source number, such as [1]. ' +
  'Describe web results with their title and link; do not fabricate information. Say you do not know when the available information is insufficient.';

type KhUIMessage = UIMessage<
  unknown,
  {
    status: { stage: string; text: string };
    think: { text: string };
    sources: ChatSource[];
    retrieve: {
      query: string;
      items: Array<{
        index: number;
        documentId: string;
        documentTitle: string;
        heading: string | null;
      }>;
    };
    session: { sessionId: string };
  }
>;

@Injectable()
export class AiStreamService {
  private readonly logger = new Logger(AiStreamService.name);
  private readonly agent?: ReturnType<typeof createAgent>;

  constructor(
    config: ConfigService,
    private readonly retrieval: HybridRetrievalService,
    private readonly sessions: ChatSessionService,
    private readonly webSearch: WebSearchService,
    private readonly shortMemory: ChatShortMemoryService,
    private readonly longMemory: ChatLongMemoryService,
    private readonly queryRewrite: ChatQueryRewriteService,
  ) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      '';
    const baseURL =
      config.get<string>('OPENAI_BASE_URL') ||
      config.get<string>('LLM_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const modelName =
      config.get<string>('MODEL_NAME') ||
      config.get<string>('LLM_MODEL') ||
      'qwen-plus';
    const enableThinking =
      config.get<string>('LLM_ENABLE_THINKING') !== 'false';

    if (!apiKey) return;

    const llm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0.2,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      streamUsage: false,
      configuration: { baseURL },
      modelKwargs: enableThinking ? { enable_thinking: true } : undefined,
    });
    // Disable reasoning for summaries and classification so structured output is more reliable.
    const compactLlm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });

    const search = this.webSearch;
    this.agent = createAgent({
      model: llm,
      tools: [
        tool(
          async (input: { query: string; count?: number }) =>
            search.search(input.query, input.count ?? 5),
          {
            name: 'web_search',
            description:
              'Bocha web search. Use it only when the knowledge base is insufficient or current/external public information is needed. Do not use it to replace existing knowledge base content.',
            schema: z.object({
              query: z.string().min(1).describe('Search query'),
              count: z
                .number()
                .int()
                .min(1)
                .max(10)
                .optional()
                .describe('Result count, defaults to 5'),
            }),
          },
        ),
      ],
      systemPrompt: SYSTEM,
      middleware: [
        summarizationMiddleware({
          model: compactLlm,
          trigger: { messages: 12 },
          keep: { messages: 6 },
          summaryPrompt:
            'Summarize the conversation concisely in English: topic, confirmed conclusions, and action items. Do not turn knowledge base policy text into memory.\n\nConversation to summarize:\n{messages}\n\nSummary:',
        }),
        // Limit each invocation to four model calls to prevent web_search loops; end normally when the limit is reached.
        modelCallLimitMiddleware({ runLimit: 4, exitBehavior: 'end' }),
      ],
    });
  }

  async streamChat(dto: ChatStreamDto, user: AuthUser, res: Response) {
    const question = lastUserText(dto.messages);
    const topK = dto.topK ?? 5;
    let persistSessionId = dto.sessionId;
    let persistSources: ChatSource[] = [];
    let persistHistory: BaseMessage[] = [];

    // The SDK provides only the UI Message protocol; orchestrate sessions, RAG, data-* events, and the agent stream here.
    const stream = createUIMessageStream<KhUIMessage>({
      execute: async ({ writer }) => {
        writer.write({ type: 'start' });

        if (!question) {
          writer.write({ type: 'text-start', id: 'empty' });
          writer.write({
            type: 'text-delta',
            id: 'empty',
            delta: 'Please enter a question.',
          });
          writer.write({ type: 'text-end', id: 'empty' });
          writer.write({ type: 'finish' });
          return;
        }

        const session = dto.sessionId
          ? await this.sessions.touchTitle(user.userId, dto.sessionId, question)
          : await this.sessions.create(user.userId, {
              title: titleFromQuestion(question),
            });
        persistSessionId = session.id;
        writer.write({
          type: 'data-session',
          data: { sessionId: session.id },
        });

        const history = await this.loadWorkingHistory(user.userId, session.id);
        persistHistory = history;

        if (history.length) {
          writer.write({
            type: 'data-status',
            data: { stage: 'rewrite', text: 'Understanding the question…' },
          });
        }
        const plan = await this.queryRewrite.rewrite(question, history);

        if (plan.needRetrieve) {
          writer.write({
            type: 'data-status',
            data: { stage: 'retrieve', text: 'Searching the knowledge base…' },
          });
        }

        const [hits, memHits] = await Promise.all([
          plan.needRetrieve
            ? this.retrieval.retrieve(plan.query, topK, user).catch((error) => {
                const detail =
                  error instanceof Error ? error.message : String(error);
                this.logger.warn(`RAG retrieval failed: ${detail}`);
                return [] as ChunkHit[];
              })
            : Promise.resolve([] as ChunkHit[]),
          this.longMemory.search(user.userId, session.id, plan.query),
        ]);

        const sources = this.toSources(hits);
        persistSources = sources;
        writer.write({
          type: 'data-retrieve',
          data: {
            query: plan.query,
            items: sources.map((src) => ({
              index: src.index,
              documentId: src.documentId,
              documentTitle: src.documentTitle,
              heading: src.heading,
            })),
          },
        });
        writer.write({ type: 'data-sources', data: sources });
        for (const src of sources) {
          writer.write({
            type: 'source-document',
            sourceId: src.documentId,
            mediaType: 'text/markdown',
            title: `[${src.index}] ${src.documentTitle}`,
          });
        }

        if (!this.agent) {
          writer.write({
            type: 'error',
            errorText:
              'No LLM key is configured; unable to generate a response',
          });
          writer.write({ type: 'finish' });
          return;
        }

        const prompt = hits.length
          ? `Retrieved sources:\n${this.buildContext(hits)}\n\nUser question: ${question}`
          : plan.needRetrieve
            ? `No relevant content was retrieved from the knowledge base.\n\nUser question: ${question}`
            : `User question: ${question}`;

        const memoryMsg = this.longMemory.buildSystemMessage(memHits);
        const langchainStream = await this.agent.stream(
          {
            messages: [
              ...(memoryMsg ? [memoryMsg] : []),
              ...history,
              new HumanMessage(prompt),
            ],
          },
          // messages: model tokens/reasoning; tools: web_search calls converted to tool-* events by the adapter.
          { streamMode: ['messages', 'tools'] },
        );

        writer.merge(
          toUIMessageStream(mapReasoningStream(langchainStream) as never, {
            // The outer execute already wrote start; createUIMessageStream closes the stream to avoid duplicates.
            sendStart: false,
            sendFinish: false,
            onError: (error) => {
              this.logger.warn(`LangChain stream failed: ${error.message}`);
            },
          }) as never,
        );
      },
      onFinish: async ({ responseMessage }) => {
        const parts = responseMessage?.parts ?? [];
        const answer = parts
          .filter((p): p is { type: 'text'; text: string } => p.type === 'text')
          .map((p) => p.text)
          .join('')
          .trim();
        const used = new Set(
          [...answer.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1])),
        );
        const sources = used.size
          ? persistSources.filter((s) => used.has(s.index))
          : [];
        if (!question || !persistSessionId) return;
        const finalAnswer = answer || 'Unable to generate a response.';
        try {
          await this.sessions.appendTurn(
            user.userId,
            persistSessionId,
            question,
            finalAnswer,
            sources,
          );
          await this.shortMemory.appendTurn(
            user.userId,
            persistSessionId,
            persistHistory,
            question,
            finalAnswer,
          );
        } catch (error) {
          this.logger.warn(
            `Failed to persist streaming chat: ${error instanceof Error ? error.message : error}`,
          );
        }
        void this.longMemory.rememberTurn(
          user.userId,
          persistSessionId,
          question,
          finalAnswer,
        );
      },
      onError: (error) =>
        error instanceof Error ? error.message : String(error),
    });

    await pipeUIMessageStreamToResponse({ response: res, stream });
  }

  private async loadWorkingHistory(userId: string, sessionId: string) {
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
      this.logger.log(
        `Short-term memory reloaded from the database: sessionId=${sessionId}, n=${history.length}`,
      );
    }
    return history;
  }

  private toSources(hits: ChunkHit[]): ChatSource[] {
    return hits.map((hit, i) => ({
      index: i + 1,
      documentId: hit.documentId,
      documentTitle: hit.documentTitle,
      heading: hit.heading,
      excerpt: excerpt(hit.content),
      score: hit.score,
    }));
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
}

/**
 * The DashScope-compatible endpoint puts reasoning in reasoning_content, while
 * the adapter expects additional_kwargs.reasoning.summary. Convert it here.
 */
async function* mapReasoningStream(
  stream: AsyncIterable<unknown>,
): AsyncIterable<unknown> {
  for await (const event of stream) {
    attachDashScopeReasoning(event);
    yield event;
  }
}

/** Recursively map additional_kwargs.reasoning_content to reasoning.summary; seen prevents circular references. */
function attachDashScopeReasoning(
  value: unknown,
  seen = new Set<object>(),
): void {
  if (value == null || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const item of value) attachDashScopeReasoning(item, seen);
    return;
  }
  const obj = value as Record<string, unknown>;
  const kwargs = obj.additional_kwargs as Record<string, unknown> | undefined;
  if (
    typeof kwargs?.reasoning_content === 'string' &&
    kwargs.reasoning_content
  ) {
    kwargs.reasoning = {
      summary: [{ type: 'summary_text', text: kwargs.reasoning_content }],
    };
  }
  attachDashScopeReasoning(obj.chunk, seen);
  attachDashScopeReasoning(obj.data, seen);
  attachDashScopeReasoning(obj.kwargs, seen);
  attachDashScopeReasoning(obj.messages, seen);
}

function lastUserText(messages: ChatStreamDto['messages'] | undefined): string {
  if (!messages?.length) return '';
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const msg = messages[i];
    if (msg.role !== 'user') continue;
    const text = (msg.parts ?? [])
      .filter((p) => p.type === 'text' && p.text)
      .map((p) => p.text)
      .join('');
    return text.trim();
  }
  return '';
}

function titleFromQuestion(question: string) {
  const text = question.replace(/\s+/g, ' ').trim();
  return text.length > 30 ? `${text.slice(0, 30)}…` : text;
}

function excerpt(content: string) {
  const text = content.replace(/\s+/g, ' ').trim();
  if (text.length <= EXCERPT_LEN) return text;
  return `${text.slice(0, EXCERPT_LEN)}...`;
}
