import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { AsyncLocalStorageProviderSingleton } from '@langchain/core/singletons';
import { z } from 'zod';
import { compactRewriteContext } from './chat-memory.util';
import type { ChunkHit } from '../pipeline/types/pipeline.types';

/**
 * During Agent streaming, callbacks are stored in AsyncLocalStorage.
 * Nested grading and rewriting calls would inherit that context and leak internal
 * JSON into the user-visible message stream. Run them with isolated callbacks.
 */
function invokeIsolated<T>(run: () => Promise<T>): Promise<T> {
  return AsyncLocalStorageProviderSingleton.runWithConfig(
    {
      callbacks: [],
      tags: ['kh-internal'],
      metadata: { khInternal: true },
    },
    run,
    true,
  );
}

/** Intent for this turn. kb means knowledge base. */
export const CHAT_INTENTS = [
  'chitchat', // Greetings, thanks, and unrelated conversation.
  'profile', // The user's own identity, team, or response preferences.
  'kb', // Company policies, processes, roles, systems, and documents.
  'web', // Public and time-sensitive information only.
  'kb_then_web', // Check the knowledge base first, then the web if needed.
] as const;

export type ChatIntent = (typeof CHAT_INTENTS)[number];

/** Intent classification plus the query and tools allowed for this turn. */
export type ChatRoutePlan = {
  intent: ChatIntent;
  label: string;
  /** Standalone query with references resolved, for RAG and web search. */
  query: string;
  /** Attach retrieve_knowledge only for kb and kb_then_web. */
  allowRetrieve: boolean;
  /** Attach web_search only for web and kb_then_web. */
  allowWeb: boolean;
};

/** Compact shape used by the JSON chat endpoint; streaming uses ChatRoutePlan. */
export type RetrieveQueryPlan = {
  query: string;
  needRetrieve: boolean;
};

/** Relevance judgment for one retrieval pass. Empty results skip the grader. */
export type HitGrade = {
  ok: boolean;
  reason:
    /** No chunk was found. */
    | 'empty'
    /** Hits can support the answer. */
    | 'relevant'
    /** Hits exist but cover a different topic. */
    | 'irrelevant';
  text: string;
};

/** Human-readable intent labels shown in the process trace. */
const INTENT_LABEL: Record<ChatIntent, string> = {
  chitchat: 'Conversation',
  profile: 'Profile',
  kb: 'Knowledge base',
  web: 'Web search',
  kb_then_web: 'Knowledge base, then web',
};

/** Structured output for intent routing. */
const routeSchema = z.object({
  intent: z
    .enum(CHAT_INTENTS)
    .describe(
      'chitchat=greetings, thanks, or unrelated conversation; profile=the user’s own identity or preferences; kb=company policies, processes, roles, systems, or documents; web=public time-sensitive information only; kb_then_web=check the knowledge base first, then the web if needed',
    ),
  standalone_query: z
    .string()
    .describe(
      'A standalone short search query in the user’s language with references resolved. Keep chitchat and profile queries unchanged when appropriate.',
    ),
});

/** Structured output for retrieval relevance grading. */
const gradeSchema = z.object({
  relevant: z
    .boolean()
    .describe(
      'True when the sources can support an answer; false when they only share keywords or cover a different topic.',
    ),
  reason: z
    .string()
    .describe(
      'One short sentence explaining why the sources are or are not relevant.',
    ),
});

/** Structured output for the fallback query rewrite. */
const retryRewriteSchema = z.object({
  query: z
    .string()
    .describe(
      'A different search query in the user’s language, under 40 words, focused on the original question.',
    ),
});

/** Judge whether retrieved sources address the user question. */
const GRADE_PROMPT =
  'You are a retrieval relevance grader for an enterprise knowledge base. Decide whether the retrieved sources can answer the user question.\n' +
  '\n' +
  '- Relevant: the same topic, policy, role, or process can support an answer; it does not need to cover every detail.\n' +
  '- Irrelevant: the sources only share keywords or describe a different matter.\n' +
  '- Judge only from the provided titles and excerpts; do not assume other documents exist.\n' +
  '- Return only the structured fields.';

/** Rewrite the query when the first retrieval is insufficient. */
const RETRY_REWRITE_PROMPT =
  'You rewrite search queries for an enterprise knowledge base after an insufficient retrieval.\n' +
  '\n' +
  '- Stay focused on the original question.\n' +
  '- Do not repeat the previous query.\n' +
  '- Use synonyms or restore key policy, role, benefit, or process entities when supported by the question.\n' +
  '- Do not invent clause numbers or proper nouns.\n' +
  '- Return one query in the user’s language, preferably under 40 words.';

/** Classify intent and produce a suggested query before starting the Agent. */
const ROUTE_PROMPT =
  'You route enterprise knowledge assistant requests and rewrite queries for retrieval. Determine the intent of this turn and produce a short searchable query.\n' +
  '\n' +
  '## intent\n' +
  '- chitchat: greetings, thanks, or unrelated conversation\n' +
  '- profile: the user’s own name, team, identity, or response preferences; the subject must be the user\n' +
  '- kb: company policies, processes, roles, internal systems, and documents\n' +
  '- web: public and time-sensitive information that is clearly not an internal policy\n' +
  '- kb_then_web: an internal question that may also need external or time-sensitive context\n' +
  '\n' +
  '## Important distinctions\n' +
  '- “Which department am I in?” and “Keep future answers shorter” -> profile\n' +
  '- “Which department does the budget reviewer belong to?” -> kb; do not classify it as profile just because it mentions a department\n' +
  '- User memory must not change the intent of the current question\n' +
  '\n' +
  '## standalone_query\n' +
  '- Resolve references such as “this”, “who is responsible”, and “what should I do”, and restore omitted topics.\n' +
  '- Do not invent proper nouns or clause numbers that are not in the conversation.\n' +
  '- Do not repeat policy text already stated by the assistant.\n' +
  '- Keep chitchat and profile queries unchanged.\n' +
  '- Return only the structured result.';

/**
 * Routes the conversation and produces a suggested search query.
 * Chitchat and profile turns skip retrieval; internal questions use the knowledge
 * base; public time-sensitive questions use the web; mixed questions use both.
 * Retrieval grading and fallback rewriting are implemented below.
 */
@Injectable()
export class ChatQueryRewriteService {
  private readonly logger = new Logger(ChatQueryRewriteService.name);
  private readonly router?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof routeSchema>>;
  };
  private readonly grader?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof gradeSchema>>;
  };
  private readonly retryWriter?: {
    invoke: (
      messages: unknown[],
    ) => Promise<z.infer<typeof retryRewriteSchema>>;
  };

  constructor(config: ConfigService) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      '';
    if (!apiKey) return;

    const baseURL =
      config.get<string>('OPENAI_BASE_URL') ||
      config.get<string>('LLM_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const modelName =
      config.get<string>('MODEL_NAME') ||
      config.get<string>('LLM_MODEL') ||
      'qwen-plus';

    const llm = new ChatOpenAI({
      apiKey,
      model: modelName,
      temperature: 0,
      timeout: Number(config.get('AI_QUERY_REWRITE_TIMEOUT_MS', 15000)),
      maxRetries: 0,
      streaming: false,
      useResponsesApi: false,
      configuration: { baseURL },
    });
    this.router = llm.withStructuredOutput(
      routeSchema,
    ) as ChatQueryRewriteService['router'];
    this.grader = llm.withStructuredOutput(
      gradeSchema,
    ) as ChatQueryRewriteService['grader'];
    this.retryWriter = llm.withStructuredOutput(
      retryRewriteSchema,
    ) as ChatQueryRewriteService['retryWriter'];
  }

  /** Fall back to kb on classification failure so internal questions are not missed. */
  async classify(
    question: string,
    history: BaseMessage[],
  ): Promise<ChatRoutePlan> {
    const fallback = this.toPlan('kb', question);
    if (!this.router) return fallback;

    const context = compactRewriteContext(history);
    try {
      const result = await invokeIsolated(() =>
        this.router!.invoke([
          new SystemMessage(ROUTE_PROMPT),
          new HumanMessage(
            context
              ? `Conversation:\n${context}\n\nCurrent question: ${question}`
              : `Current question: ${question}`,
          ),
        ]),
      );
      const query = result.standalone_query.trim() || question;
      const plan = this.toPlan(result.intent, query);
      this.logger.log(
        `Intent: ${plan.intent} query=${plan.query.slice(0, 80)}`,
      );
      return plan;
    } catch (error) {
      this.logger.warn(
        `Intent classification failed; falling back to kb: ${error instanceof Error ? error.message : error}`,
      );
      return fallback;
    }
  }

  /** Used by the non-streaming /ai/chat endpoint when only retrieval is needed. */
  async rewrite(
    question: string,
    history: BaseMessage[],
  ): Promise<RetrieveQueryPlan> {
    const plan = await this.classify(question, history);
    return { query: plan.query, needRetrieve: plan.allowRetrieve };
  }

  /** Grade non-empty hits; allow hits through if grading fails to avoid false negatives. */
  async gradeHits(question: string, hits: ChunkHit[]): Promise<HitGrade> {
    if (!hits.length) {
      return { ok: false, reason: 'empty', text: 'No sources were found.' };
    }
    if (!this.grader) {
      return {
        ok: true,
        reason: 'relevant',
        text: 'Sources found; no grader is configured.',
      };
    }
    try {
      const result = await invokeIsolated(() =>
        this.grader!.invoke([
          new SystemMessage(GRADE_PROMPT),
          new HumanMessage(
            `User question: ${question}\n\nRetrieved sources:\n${summarizeHits(hits)}`,
          ),
        ]),
      );
      const ok = result.relevant;
      const text =
        result.reason.trim() ||
        (ok ? 'Sources are relevant.' : 'Sources are not relevant.');
      this.logger.log(
        `Retrieval grading: ${ok ? 'relevant' : 'irrelevant'} ${text.slice(0, 80)}`,
      );
      return { ok, reason: ok ? 'relevant' : 'irrelevant', text };
    } catch (error) {
      this.logger.warn(
        `Retrieval grading failed; allowing non-empty hits: ${error instanceof Error ? error.message : error}`,
      );
      return {
        ok: true,
        reason: 'relevant',
        text: 'Grading failed; treating non-empty hits as relevant.',
      };
    }
  }

  /**
   * Rewrite the query after an empty or irrelevant first pass.
   * If rewriting fails or repeats the previous query, fall back to the original
   * question; return an empty string when that is also unchanged.
   */
  async rewriteAfterRetrieve(
    question: string,
    previousQuery: string,
    grade: HitGrade,
    hits: ChunkHit[],
  ): Promise<string> {
    const fallback = distinctQuery(question, previousQuery);
    if (!this.retryWriter) return fallback;

    try {
      const hitBlock = hits.length
        ? `\nPrevious irrelevant hits:\n${summarizeHits(hits, 3)}`
        : '\nNo previous hits.';
      const result = await invokeIsolated(() =>
        this.retryWriter!.invoke([
          new SystemMessage(RETRY_REWRITE_PROMPT),
          new HumanMessage(
            `User question: ${question}\nPrevious query: ${previousQuery}\nReason for insufficiency: ${grade.text}${hitBlock}`,
          ),
        ]),
      );
      const query = distinctQuery(result.query.trim(), previousQuery);
      if (query) {
        this.logger.log(
          `Query rewrite: ${previousQuery.slice(0, 40)} -> ${query.slice(0, 40)}`,
        );
        return query;
      }
      return fallback;
    } catch (error) {
      this.logger.warn(
        `Query rewrite failed; falling back to the original question: ${error instanceof Error ? error.message : error}`,
      );
      return fallback;
    }
  }

  /** Map intent to tool availability. Classification failure falls back to kb. */
  private toPlan(intent: ChatIntent, query: string): ChatRoutePlan {
    const kb = intent === 'kb' || intent === 'kb_then_web';
    return {
      intent,
      label: INTENT_LABEL[intent],
      query,
      allowRetrieve: kb,
      allowWeb: intent === 'web' || intent === 'kb_then_web',
    };
  }
}

function summarizeHits(hits: ChunkHit[], limit = 5): string {
  return hits
    .slice(0, limit)
    .map((hit, i) => {
      const heading = hit.heading ? ` / ${hit.heading}` : '';
      const snippet = hit.content.replace(/\s+/g, ' ').trim().slice(0, 180);
      const score = Number.isFinite(hit.score) ? hit.score.toFixed(2) : '-';
      return `${i + 1}. ${hit.documentTitle}${heading} (score=${score})\n${snippet}`;
    })
    .join('\n');
}

function distinctQuery(next: string, previous: string): string {
  const query = next.replace(/\s+/g, ' ').trim();
  if (!query) return '';
  if (query === previous.replace(/\s+/g, ' ').trim()) return '';
  return query;
}
