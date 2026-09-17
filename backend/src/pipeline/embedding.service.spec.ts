import { ConfigService } from '@nestjs/config';
import { EmbeddingService } from './embedding.service';

describe('EmbeddingService', () => {
  it('allows the application to start without an embedding provider', () => {
    const config = {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    } as unknown as ConfigService;

    expect(() => new EmbeddingService(config)).not.toThrow();
  });

  it('reports missing provider configuration when vectorization is requested', async () => {
    const config = {
      get: (_key: string, defaultValue?: unknown) => defaultValue,
    } as unknown as ConfigService;
    const service = new EmbeddingService(config);

    await expect(service.embedBatch(['sample text'])).rejects.toThrow(
      'Set EMBEDDING_API_KEY, DASHSCOPE_API_KEY, or OPENAI_API_KEY',
    );
  });
});
