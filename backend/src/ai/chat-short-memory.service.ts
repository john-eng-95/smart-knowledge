import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  AIMessage,
  HumanMessage,
  mapChatMessagesToStoredMessages,
  mapStoredMessagesToChatMessages,
  type BaseMessage,
} from '@langchain/core/messages';
import { RedisService } from '../redis/redis.service';
import { isWorkingMessage } from './chat-memory.util';

/**
 * Short-term conversation memory: a hot window in Redis.
 * Callers reload from Postgres and save again on a miss or Redis failure.
 * Stores only original human/AI messages, excluding retrieved sources, reasoning, and Mem0 system messages.
 */
@Injectable()
export class ChatShortMemoryService {
  private readonly logger = new Logger(ChatShortMemoryService.name);
  private readonly ttlSeconds: number;
  private readonly maxMessages: number;
  private readonly keyPrefix: string;

  constructor(
    config: ConfigService,
    private readonly redis: RedisService,
  ) {
    this.ttlSeconds = Number(
      config.get('CHAT_SHORT_MEMORY_TTL_SECONDS', 86400),
    );
    this.maxMessages = Number(config.get('CHAT_SHORT_MEMORY_MAX_MESSAGES', 20));
    this.keyPrefix = config.get('CHAT_SHORT_MEMORY_KEY_PREFIX', 'kh:chat');
  }

  get windowSize() {
    return this.maxMessages;
  }

  /** Return messages on a hit; return null when the key is missing or Redis fails. */
  async tryLoad(
    userId: string,
    sessionId: string,
  ): Promise<BaseMessage[] | null> {
    try {
      const raw = await this.redis.get(this.key(userId, sessionId));
      if (!raw) return null;
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return null;
      const storedMessages = parsed as Parameters<
        typeof mapStoredMessagesToChatMessages
      >[0];
      return mapStoredMessagesToChatMessages(storedMessages).filter(
        isWorkingMessage,
      );
    } catch (error) {
      this.logger.warn(
        `Short-term memory Redis read failed; falling back to the database: ${error instanceof Error ? error.message : error}`,
      );
      return null;
    }
  }

  async save(
    userId: string,
    sessionId: string,
    messages: BaseMessage[],
  ): Promise<void> {
    const working = messages.filter(isWorkingMessage).slice(-this.maxMessages);
    try {
      const payload = JSON.stringify(mapChatMessagesToStoredMessages(working));
      await this.redis.set(
        this.key(userId, sessionId),
        payload,
        this.ttlSeconds,
      );
    } catch (error) {
      this.logger.warn(
        `Short-term memory Redis write failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  async appendTurn(
    userId: string,
    sessionId: string,
    history: BaseMessage[],
    question: string,
    answer: string,
  ): Promise<void> {
    await this.save(userId, sessionId, [
      ...history,
      new HumanMessage(question),
      new AIMessage(answer),
    ]);
  }

  async clear(userId: string, sessionId: string): Promise<void> {
    try {
      await this.redis.del(this.key(userId, sessionId));
    } catch (error) {
      this.logger.warn(
        `Short-term memory Redis delete failed: ${error instanceof Error ? error.message : error}`,
      );
    }
  }

  private key(userId: string, sessionId: string) {
    return `${this.keyPrefix}:${userId}:${sessionId}:messages`;
  }
}
