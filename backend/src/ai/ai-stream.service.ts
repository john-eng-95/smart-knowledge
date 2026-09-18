import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  createUIMessageStream,
  pipeUIMessageStreamToResponse,
  type UIMessage,
  type UIMessageStreamWriter,
} from 'ai';
import { toUIMessageStream } from '@ai-sdk/langchain';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, type BaseMessage } from '@langchain/core/messages';
import type { StructuredToolInterface } from '@langchain/core/tools';
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
import {
  ChatQueryRewriteService,
  type ChatRoutePlan,
} from './chat-query-rewrite.service';
import { retrieveAndGrade, type RetrieveEval } from './agentic-retrieve';
import { WebSearchService } from './web-search.service';
import { dbRowsToMessages } from './chat-memory.util';
import type { AuthUser } from '../auth/auth-user.interface';
import type { ChatSource } from './chat.types';
import type { ChatStreamDto } from './dto/chat-stream.dto';
import type { ChunkHit } from '../pipeline/types/pipeline.types';

/** Maximum citation excerpt length in characters. */
const EXCERPT_LEN = 200;

type KhUIMessage = UIMessage<
  unknown,
  {
    /** Process trace status text, such as intent classification. */
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
    /** Intent classification card. */
    intent: {
      intent: ChatRoutePlan['intent'];
      label: string;
      query: string;
      allowRetrieve: boolean;
      allowWeb: boolean;
    };
    /** Retrieval relevance card. */
    eval: RetrieveEval;
    session: { sessionId: string };
  }
>;

@Injectable()
export class AiStreamService {
  private readonly logger = new Logger(AiStreamService.name);
  private readonly llm?: ChatOpenAI;
  private readonly compactLlm?: ChatOpenAI;

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

    this.llm = new ChatOpenAI({
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
    this.compactLlm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0,
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });
  }

  /**
   * Attach tools for this turn's intent. The Agent controls the loop; each tool performs one step.
   */
  private createTurnAgent(
    user: AuthUser,
    topK: number,
    persistSources: ChatSource[],
    writer: UIMessageStreamWriter<KhUIMessage>,
    plan: ChatRoutePlan,
    question: string,
  ) {
    if (!this.llm || !this.compactLlm) return undefined;
    const retrieval = this.retrieval;
    const queryRewrite = this.queryRewrite;
    const search = this.webSearch;
    const logger = this.logger;
    const tools: StructuredToolInterface[] = [];
    let retrieveCount = 0;
    let lastRetrieve: Awaited<ReturnType<typeof retrieveAndGrade>> | undefined;

    if (plan.allowRetrieve) {
      tools.push(
        tool(
          async (input: { query: string; topK?: number }) => {
            if (retrieveCount >= 2) {
              return {
                query: input.query,
                items: [],
                insufficient: true,
                error:
                  'The knowledge base can be queried at most twice per turn. Use the existing evaluation or search the web.',
              };
            }
            retrieveCount += 1;
            const result = await retrieveAndGrade({
              question,
              query: input.query,
              topK: input.topK ?? topK,
              user,
              retrieval,
              rewrite: queryRewrite,
              retried: retrieveCount > 1,
              previousQuery: lastRetrieve?.usedQuery,
            });
            lastRetrieve = result;
            writer.write({ type: 'data-eval', data: result.eval });
            if (result.eval.reason === 'error') {
              logger.warn(`RAG retrieval failed: ${result.eval.text}`);
              return {
                query: result.usedQuery,
                items: [],
                error: result.eval.text,
                insufficient: true,
                eval: result.eval,
              };
            }
            if (!result.eval.ok) {
              return packRetrieveResult(
                [],
                result.usedQuery,
                persistSources,
                writer,
                { insufficient: true, eval: result.eval },
              );
            }
            return packRetrieveResult(
              result.hits,
              result.usedQuery,
              persistSources,
              writer,
              { eval: result.eval },
            );
          },
          {
            name: 'retrieve_knowledge',
            description:
              'Retrieve the enterprise knowledge base once using only documents visible to the current user, then grade relevance. Do not retry automatically. If eval.ok is false, call rewrite_query first and call this tool again with the new query. At most two retrievals per turn.',
            schema: z.object({
              query: z
                .string()
                .min(1)
                .describe('Search keywords or a short query.'),
              topK: z
                .number()
                .int()
                .min(1)
                .max(10)
                .optional()
                .describe('Result count; defaults to the request value.'),
            }),
          },
        ),
      );
      tools.push(
        tool(
          async (input: { focus?: string }) => {
            if (!lastRetrieve) {
              return { error: 'Call retrieve_knowledge first.' };
            }
            if (lastRetrieve.eval.ok) {
              return {
                error:
                  'The current sources are relevant; rewriting is not needed.',
                query: lastRetrieve.usedQuery,
              };
            }
            writer.write({
              type: 'data-status',
              data: { stage: 'rewrite', text: 'Rewriting the search query…' },
            });
            const retryQuery = await queryRewrite.rewriteAfterRetrieve(
              question,
              lastRetrieve.usedQuery,
              lastRetrieve.grade,
              lastRetrieve.rawHits,
            );
            if (!retryQuery) {
              return {
                error:
                  'Unable to produce a query different from the previous one.',
                previousQuery: lastRetrieve.usedQuery,
                reason: lastRetrieve.eval.text,
              };
            }
            return {
              query: retryQuery,
              previousQuery: lastRetrieve.usedQuery,
              reason: lastRetrieve.eval.text,
              focus: input.focus,
            };
          },
          {
            name: 'rewrite_query',
            description:
              'Rewrite the query based on the previous retrieval evaluation. Call only after retrieve_knowledge returns insufficient, then pass the returned query to retrieve_knowledge.',
            schema: z.object({
              focus: z
                .string()
                .optional()
                .describe('Optional gap to emphasize when rewriting.'),
            }),
          },
        ),
      );
    }

    if (plan.allowWeb) {
      tools.push(
        tool(
          async (input: { query: string; count?: number }) =>
            search.search(input.query, input.count ?? 5),
          {
            name: 'web_search',
            description:
              'Search public information with Bocha. Call only when the knowledge base loop is still insufficient, or when this turn requires public time-sensitive information. Do not replace relevant knowledge base sources with web pages.',
            schema: z.object({
              query: z.string().min(1).describe('Search query.'),
              count: z
                .number()
                .int()
                .min(1)
                .max(10)
                .optional()
                .describe('Result count; defaults to 5.'),
            }),
          },
        ),
      );
    }

    return createAgent({
      model: this.llm,
      tools,
      systemPrompt: systemForPlan(plan),
      middleware: [
        summarizationMiddleware({
          model: this.compactLlm,
          trigger: { messages: 12 },
          keep: { messages: 6 },
          summaryPrompt:
            'Summarize the conversation concisely in the user’s language: topic, confirmed conclusions, and action items. Do not turn knowledge base policy text into memory.\n\nConversation to summarize:\n{messages}\n\nSummary:',
        }),
        modelCallLimitMiddleware({ runLimit: 6, exitBehavior: 'end' }),
      ],
    });
  }

  async streamChat(dto: ChatStreamDto, user: AuthUser, res: Response) {
    const question = lastUserText(dto.messages);
    const topK = dto.topK ?? 5;
    let persistSessionId = dto.sessionId;
    const persistSources: ChatSource[] = [];
    let persistHistory: BaseMessage[] = [];

    // The SDK only provides the UI Message protocol; orchestrate sessions, RAG, data-* events, and the Agent stream here.
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

        writer.write({
          type: 'data-status',
          data: { stage: 'intent', text: 'Classifying intent…' },
        });
        // Route before starting the Agent so the client can render the intent card immediately.
        const plan = await this.queryRewrite.classify(question, history);
        writer.write({
          type: 'data-intent',
          data: {
            intent: plan.intent,
            label: plan.label,
            query: plan.query,
            allowRetrieve: plan.allowRetrieve,
            allowWeb: plan.allowWeb,
          },
        });

        const memHitsP = this.longMemory.search(
          user.userId,
          session.id,
          question,
        );
        const memHits = await memHitsP;

        const agent = this.createTurnAgent(
          user,
          topK,
          persistSources,
          writer,
          plan,
          question,
        );
        if (!agent) {
          writer.write({
            type: 'error',
            errorText:
              'No LLM key is configured; unable to generate a response.',
          });
          writer.write({ type: 'finish' });
          return;
        }

        const memoryMsg = this.longMemory.buildSystemMessage(memHits);
        const humanParts = [
          plan.allowRetrieve
            ? `Suggested search query (the Agent may rewrite it): ${plan.query}`
            : '',
          `User question: ${question}`,
        ].filter(Boolean);
        const human = humanParts.join('\n\n');
        const langchainStream = await agent.stream(
          {
            messages: [
              ...(memoryMsg ? [memoryMsg] : []),
              ...history,
              new HumanMessage(human),
            ],
          },
          // messages: model tokens/reasoning; tools: retrieve/web_search calls converted to tool-* events.
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

/** Recursively map reasoning_content to reasoning.summary; seen prevents circular references. */
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

/** Agent loop: retrieve -> grade -> rewrite and retry -> search the web if still insufficient -> answer. */
function systemForPlan(plan: ChatRoutePlan) {
  let prompt =
    'You are an enterprise knowledge base assistant. Follow the Agentic RAG loop without skipping steps. ' +
    'Use conversation history and relevant user memory, but treat sources retrieved in this turn as authoritative for policies and procedures. ' +
    `Turn intent: ${plan.label}.`;
  if (plan.allowRetrieve) {
    prompt +=
      `Suggested query: "${plan.query}". Rewrite it when a more precise query is needed. ` +
      'Loop: 1) call retrieve_knowledge; 2) when eval.ok is true, answer from context and cite [n]; ' +
      '3) when insufficient, call rewrite_query, then call retrieve_knowledge again with its query (at most twice); ' +
      '4) consider web_search only after two insufficient retrievals. Do not retrieve or rewrite after eval.ok is true, and never make a third retrieval. ' +
      'Do not replace documents with memory.';
  } else {
    prompt += 'Do not call retrieve_knowledge or rewrite_query.';
  }
  if (plan.intent === 'chitchat') {
    prompt += 'This is casual conversation; answer directly without tools.';
  }
  if (plan.intent === 'profile') {
    prompt +=
      'This is a profile or preference question; answer from memory without querying the knowledge base.';
  }
  if (plan.intent === 'kb') {
    prompt +=
      'If two retrievals remain insufficient, say that the knowledge base has no relevant content, do not invent policy, and do not search the web.';
  }
  if (plan.intent === 'web') {
    prompt +=
      'Use web_search for public information and cite results with their titles and links. Do not fabricate information.';
  }
  if (plan.intent === 'kb_then_web') {
    prompt +=
      'Complete the knowledge base loop first; call web_search only after two insufficient retrievals. Cite web results with their titles and links, and do not present web pages as internal policy.';
  }
  if (!plan.allowWeb) {
    prompt += 'Do not call web_search.';
  }
  prompt += 'When information is insufficient, say that you do not know.';
  return prompt;
}

/** Number hits for citations and emit data-sources; context goes to the model, excerpts go to the client. */
function packRetrieveResult(
  hits: ChunkHit[],
  query: string,
  persistSources: ChatSource[],
  writer: UIMessageStreamWriter<KhUIMessage>,
  extra: Record<string, unknown> = {},
) {
  const offset = persistSources.length;
  const sources = hits.map((hit, i) => ({
    index: offset + i + 1,
    documentId: hit.documentId,
    documentTitle: hit.documentTitle,
    heading: hit.heading,
    excerpt: excerpt(hit.content),
    score: hit.score,
  }));
  persistSources.push(...sources);
  writer.write({
    type: 'data-sources',
    data: persistSources,
  });
  for (const src of sources) {
    writer.write({
      type: 'source-document',
      sourceId: src.documentId,
      mediaType: 'text/markdown',
      title: `[${src.index}] ${src.documentTitle}`,
    });
  }
  return {
    query,
    items: sources.map((src) => ({
      index: src.index,
      documentId: src.documentId,
      documentTitle: src.documentTitle,
      heading: src.heading,
      excerpt: src.excerpt,
    })),
    context: hits
      .map((hit, i) => {
        const src = sources[i];
        const heading = hit.heading ? ` / ${hit.heading}` : '';
        const snippet =
          hit.content.length > 800
            ? `${hit.content.slice(0, 800)}...`
            : hit.content;
        return `[${src.index}] ${hit.documentTitle}${heading}\n${snippet}`;
      })
      .join('\n\n'),
    ...extra,
  };
}
