import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import {
  HumanMessage,
  SystemMessage,
  type BaseMessage,
} from '@langchain/core/messages';
import { z } from 'zod';
import { compactRewriteContext } from './chat-memory.util';

const rewriteSchema = z.object({
  standalone_query: z
    .string()
    .describe(
      'A standalone short search query in English that resolves references and omissions without greetings',
    ),
  need_retrieve: z
    .boolean()
    .describe(
      'Whether to search the knowledge base. Use false for greetings, thanks, and policy-unrelated conversation',
    ),
});

const REWRITE_PROMPT =
  'You rewrite the current question into a standalone short search query for an enterprise knowledge base.\n' +
  '\n' +
  '## Requirements\n' +
  '- Resolve references such as "this", "that", "who is responsible", and "what should I do", and restore omitted topics.\n' +
  '- Keep only searchable entities, subjects, and actions in one English sentence, preferably under 40 words.\n' +
  '- Do not invent proper nouns, clause numbers, or system names that do not appear in the conversation.\n' +
  '- Do not repeat policy text, deadlines, or process details stated by the assistant.\n' +
  '- If the current question is complete and independent, lightly refine it for standalone_query.\n' +
  '- For greetings, thanks, or knowledge-base-unrelated conversation, set need_retrieve=false and keep the original question in standalone_query.\n' +
  '- Return the structured result without explanation.';

export type RetrieveQueryPlan = {
  query: string;
  needRetrieve: boolean;
};

/**
 * Rewrite follow-up questions into standalone search queries before retrieval.
 * Fall back to the original question when the LLM is unavailable or rewriting fails.
 */
@Injectable()
export class ChatQueryRewriteService {
  private readonly logger = new Logger(ChatQueryRewriteService.name);
  private readonly rewriter?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof rewriteSchema>>;
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
      useResponsesApi: false,
      configuration: { baseURL },
    });
    this.rewriter = llm.withStructuredOutput(
      rewriteSchema,
    ) as ChatQueryRewriteService['rewriter'];
  }

  async rewrite(
    question: string,
    history: BaseMessage[],
  ): Promise<RetrieveQueryPlan> {
    const fallback: RetrieveQueryPlan = { query: question, needRetrieve: true };
    if (!history.length || !this.rewriter) return fallback;

    const context = compactRewriteContext(history);
    if (!context) return fallback;

    try {
      const result = await this.rewriter.invoke([
        new SystemMessage(REWRITE_PROMPT),
        new HumanMessage(
          `Conversation:\n${context}\n\nCurrent question: ${question}`,
        ),
      ]);
      const query = result.standalone_query.trim() || question;
      this.logger.log(
        `Query rewrite: needRetrieve=${result.need_retrieve} query=${query.slice(0, 80)}`,
      );
      return { query, needRetrieve: result.need_retrieve };
    } catch (error) {
      this.logger.warn(
        `Query rewrite failed; using the original question: ${error instanceof Error ? error.message : error}`,
      );
      return fallback;
    }
  }
}
