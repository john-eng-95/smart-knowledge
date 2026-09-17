import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { scalarToString } from '../common/scalar-string';
import amqp, {
  AmqpConnectionManager,
  ChannelWrapper,
} from 'amqp-connection-manager';
import { ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  KG_GRAPH_EXCHANGE,
  KG_GRAPH_QUEUE,
  KG_RK_BUILD_BY_IDS,
  KG_RK_DELETE,
  RAG_REINDEX_EXCHANGE,
  RAG_REINDEX_QUEUE,
  RAG_RK_BY_IDS,
  RAG_RK_DELETE,
  SEARCH_INDEX_EXCHANGE,
  SEARCH_INDEX_QUEUE,
  SEARCH_RK_DELETE,
  SEARCH_RK_INDEX,
} from './mq.constants';

export type MessageHandler = (msg: ConsumeMessage) => Promise<void> | void;

@Injectable()
export class RabbitMqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RabbitMqService.name);
  private connection: AmqpConnectionManager | null = null;
  private channel: ChannelWrapper | null = null;
  private readonly enabled: boolean;
  private readonly handlers = new Map<string, MessageHandler>();

  constructor(private readonly config: ConfigService) {
    this.enabled =
      this.config.get<string>('RABBITMQ_ENABLED', 'true') !== 'false';
  }

  get isEnabled() {
    return this.enabled;
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('RabbitMQ is disabled (RABBITMQ_ENABLED=false)');
      return;
    }

    const url = this.config.get<string>(
      'RABBITMQ_URL',
      'amqp://knowledge_hub:local-only-change-me@localhost:5672',
    );
    const safeUrl = this.redactAmqpUrl(url);
    const timeoutMs = Number(
      this.config.get<string>('RABBITMQ_CONNECT_TIMEOUT_MS', '15000'),
    );

    this.logger.log(
      `Connecting to RabbitMQ: ${safeUrl} (timeout ${timeoutMs}ms)`,
    );

    this.connection = amqp.connect([url]);
    this.connection.on('connect', (arg) => {
      const connectedUrl =
        typeof arg === 'object' && arg && 'url' in arg
          ? String((arg as { url?: string }).url ?? url)
          : url;
      this.logger.log(
        `RabbitMQ connected: ${this.redactAmqpUrl(connectedUrl)}`,
      );
    });
    this.connection.on('disconnect', (err) =>
      this.logger.warn(
        `RabbitMQ disconnected: ${this.errorMessage(err?.err ?? err)}`,
      ),
    );
    this.connection.on('connectFailed', (err) =>
      this.logger.error(
        `RabbitMQ connection failed: ${this.errorMessage(err?.err ?? err)} (url=${safeUrl})`,
      ),
    );

    this.channel = this.connection.createChannel({
      json: true,
      setup: async (ch: ConfirmChannel) => {
        this.logger.log(
          'RabbitMQ channel setup: declaring topology and binding consumers',
        );
        await this.assertTopology(ch);
        await this.bindConsumers(ch);
      },
    });

    try {
      await Promise.race([
        this.channel.waitForConnect(),
        new Promise<never>((_, reject) => {
          setTimeout(() => {
            reject(
              new Error(
                `RabbitMQ connection timed out (${timeoutMs}ms): ${safeUrl}. Check that the service is running, port 5672 is not occupied by another container, and the credentials are correct`,
              ),
            );
          }, timeoutMs);
        }),
      ]);
      this.logger.log('RabbitMQ channel ready');
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.error(`RabbitMQ initialization failed: ${message}`);
      await this.connection.close().catch(() => undefined);
      this.connection = null;
      this.channel = null;
      throw error;
    }
  }

  /** Redact the AMQP password from logs. */
  private redactAmqpUrl(url: string) {
    return url.replace(/\/\/([^:/@]+):([^@]+)@/, '//$1:***@');
  }

  private errorMessage(error: unknown) {
    if (error instanceof Error) return error.message;
    if (
      typeof error === 'object' &&
      error &&
      'message' in error &&
      typeof error.message === 'string'
    ) {
      return (error as { message: string }).message;
    }
    return scalarToString(error, 'unknown');
  }

  async onModuleDestroy() {
    await this.channel?.close();
    await this.connection?.close();
  }

  /** Register a queue consumer; it takes effect when the connection is ready. */
  registerHandler(queue: string, handler: MessageHandler) {
    this.handlers.set(queue, handler);
  }

  async publish(
    exchange: string,
    routingKey: string,
    payload: unknown,
  ): Promise<boolean> {
    if (!this.enabled || !this.channel) {
      this.logger.warn(
        `Skipping message publish (MQ unavailable): exchange=${exchange}, rk=${routingKey}`,
      );
      return false;
    }

    try {
      await this.channel.publish(exchange, routingKey, payload, {
        contentType: 'application/json',
        persistent: true,
      });
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Message publish failed: exchange=${exchange}, rk=${routingKey}, error=${message}`,
      );
      return false;
    }
  }

  private async assertTopology(ch: ConfirmChannel) {
    await ch.assertExchange(RAG_REINDEX_EXCHANGE, 'topic', { durable: true });
    await ch.assertQueue(RAG_REINDEX_QUEUE, { durable: true });
    await ch.bindQueue(RAG_REINDEX_QUEUE, RAG_REINDEX_EXCHANGE, RAG_RK_BY_IDS);
    await ch.bindQueue(RAG_REINDEX_QUEUE, RAG_REINDEX_EXCHANGE, RAG_RK_DELETE);

    await ch.assertExchange(SEARCH_INDEX_EXCHANGE, 'topic', { durable: true });
    await ch.assertQueue(SEARCH_INDEX_QUEUE, { durable: true });
    await ch.bindQueue(
      SEARCH_INDEX_QUEUE,
      SEARCH_INDEX_EXCHANGE,
      SEARCH_RK_INDEX,
    );
    await ch.bindQueue(
      SEARCH_INDEX_QUEUE,
      SEARCH_INDEX_EXCHANGE,
      SEARCH_RK_DELETE,
    );

    await ch.assertExchange(KG_GRAPH_EXCHANGE, 'topic', { durable: true });
    await ch.assertQueue(KG_GRAPH_QUEUE, { durable: true });
    await ch.bindQueue(KG_GRAPH_QUEUE, KG_GRAPH_EXCHANGE, KG_RK_BUILD_BY_IDS);
    await ch.bindQueue(KG_GRAPH_QUEUE, KG_GRAPH_EXCHANGE, KG_RK_DELETE);

    this.logger.log('RabbitMQ topology declared (RAG + Search + KG)');
  }

  private async bindConsumers(ch: ConfirmChannel) {
    for (const [queue, handler] of this.handlers.entries()) {
      await ch.consume(queue, (msg) => {
        if (!msg) return;
        void Promise.resolve()
          .then(() => handler(msg))
          .then(() => ch.ack(msg))
          .catch((error: unknown) => {
            this.logger.error(
              `Message consumption failed queue=${queue}: ${this.errorMessage(error)}`,
            );
            ch.nack(msg, false, false);
          });
      });
      this.logger.log(`Consumer registered: ${queue}`);
    }
  }
}
