import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { z } from 'zod';
import { MemoryClient } from 'mem0ai';

const memorySchema = z.object({
  write_user: z
    .boolean()
    .describe(
      'Write to the user layer: identity, role, response preferences, and long-term constraints that should persist across conversations. Exclude the current task and knowledge base policy text.',
    ),
  write_session: z
    .boolean()
    .describe(
      'Write to the session layer: tasks, progress, action items, and temporary agreements for the current conversation only.',
    ),
  reason: z.string().describe('One-sentence classification reason'),
});

const CLASSIFIER_PROMPT =
  'You classify memories for an enterprise knowledge base assistant. Decide whether this turn contains new facts to write to Mem0.\n' +
  '\n' +
  '## user layer (across conversations)\n' +
  '- The user-provided identity, role, or team affiliation\n' +
  '- Long-term preferences: shorter answers, team-only policies, or examples in technical answers\n' +
  '- Persistent constraints: allergies, language, or preferred form of address\n' +
  '\n' +
  '## session layer (current conversation only)\n' +
  '- The issue being investigated, the document to write, or the next steps confirmed in this conversation\n' +
  '- Work context the user scopes to "this time" or "this turn"\n' +
  '\n' +
  '## Do not write\n' +
  '- Greetings, thanks, or simple confirmations\n' +
  '- Policies, procedures, owners, or system names stated by the assistant from knowledge base sources (these are document facts, not user memories)\n' +
  '- Web search results or citation numbers [n]\n' +
  '- Repetition without new information\n' +
  '\n' +
  '## Rules\n' +
  '1. Never write knowledge base content as a user memory.\n' +
  '2. "Review section three of the travel policy this time" belongs in session, not user.\n' +
  '3. user and session may both be true.\n' +
  '4. A one-off question with no agreement worth remembering across turns means both are false.';

export type LongMemoryHits = {
  user: string[];
  session: string[];
};

/**
 * Long-term conversation memory (Mem0). Skipped entirely when MEM0_API_KEY is not configured.
 * Memory is used only to rewrite questions and add context, never as a source of policy facts.
 */
@Injectable()
export class ChatLongMemoryService {
  private readonly logger = new Logger(ChatLongMemoryService.name);
  private readonly client?: MemoryClient;
  private readonly classifier?: {
    invoke: (messages: unknown[]) => Promise<z.infer<typeof memorySchema>>;
  };
  private readonly topK: number;

  constructor(config: ConfigService) {
    this.topK = Number(config.get('MEM0_TOP_K', 5));
    const mem0Key = config.get<string>('MEM0_API_KEY') || '';
    const host = config.get<string>('MEM0_HOST') || undefined;
    if (mem0Key) {
      this.client = new MemoryClient({
        apiKey: mem0Key,
        ...(host ? { host } : {}),
      });
    } else {
      this.logger.warn(
        'MEM0_API_KEY is not configured; skipping long-term memory',
      );
    }

    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      '';
    if (!apiKey || !this.client) return;

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
      timeout: Number(config.get('AI_CHAT_TIMEOUT_MS', 60000)),
      maxRetries: 0,
      useResponsesApi: false,
      configuration: { baseURL },
    });
    this.classifier = llm.withStructuredOutput(
      memorySchema,
    ) as ChatLongMemoryService['classifier'];
  }

  get enabled() {
    return Boolean(this.client);
  }

  async search(
    userId: string,
    sessionId: string | undefined,
    query: string,
  ): Promise<LongMemoryHits> {
    const empty: LongMemoryHits = { user: [], session: [] };
    if (!this.client) return empty;
    try {
      const userRes = await this.client.search(query, {
        filters: { user_id: userId },
        topK: this.topK,
      });
      const sessionRes = sessionId
        ? await this.client.search(query, {
            filters: {
              AND: [{ user_id: userId }, { run_id: sessionId }],
            },
            topK: this.topK,
          })
        : { results: [] };
      return {
        user: (userRes.results ?? [])
          .map((m) => m.memory)
          .filter((text): text is string => Boolean(text)),
        session: (sessionRes.results ?? [])
          .map((m) => m.memory)
          .filter((text): text is string => Boolean(text)),
      };
    } catch (error) {
      this.logger.warn(
        `Mem0 search failed: ${error instanceof Error ? error.message : error}`,
      );
      return empty;
    }
  }

  buildSystemMessage(hits: LongMemoryHits): SystemMessage | null {
    const blocks: string[] = [];
    if (hits.user.length) {
      blocks.push(
        `User long-term memory:\n${hits.user.map((line) => `- ${line}`).join('\n')}`,
      );
    }
    if (hits.session.length) {
      blocks.push(
        `Current conversation memory:\n${hits.session.map((line) => `- ${line}`).join('\n')}`,
      );
    }
    if (!blocks.length) return null;
    return new SystemMessage(
      `${blocks.join('\n\n')}\n\nThe above is background only. Treat sources retrieved in this turn as authoritative for policies and procedures; never replace documents with memory.`,
    );
  }

  async rememberTurn(
    userId: string,
    sessionId: string,
    question: string,
    answer: string,
  ): Promise<void> {
    if (!this.client || !this.classifier) return;
    const extractFrom = [{ role: 'user' as const, content: question }];
    try {
      const { write_user, write_session, reason } =
        await this.classifier.invoke([
          new SystemMessage(CLASSIFIER_PROMPT),
          new HumanMessage(
            `User: ${question}\nAssistant (for classification only, not a user fact): ${answer.slice(0, 300)}`,
          ),
        ]);

      const written: string[] = [];
      const addOpts = {
        customInstructions:
          'Extract memories only from the user messages and write one complete English sentence. ' +
          'Store only identity, role, preferences, constraints, or tasks the user explicitly scoped to this conversation. ' +
          'Do not store policy text, procedures, deadlines, owners, system names, or citation numbers. ' +
          'Do not translate user facts into another language.',
      };
      if (write_user) {
        await this.client.add(extractFrom, { userId, ...addOpts });
        written.push('user');
      }
      if (write_session) {
        await this.client.add(extractFrom, {
          userId,
          runId: sessionId,
          ...addOpts,
        });
        written.push('session');
      }
      this.logger.log(
        `Mem0 classification: ${reason}; written=${written.join(',') || 'none'}`,
      );
    } catch (error) {
      this.logger.warn(
        `Mem0 write failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async clearSession(userId: string, sessionId: string): Promise<void> {
    if (!this.client) return;
    try {
      await this.client.deleteAll({ userId, runId: sessionId });
    } catch (error) {
      this.logger.warn(
        `Mem0 session memory cleanup failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }
}
