import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  siteName?: string;
}

export interface WebSearchResult {
  query: string;
  items: WebSearchHit[];
  error?: string;
}

/** Bocha Web Search, using the same interface as cron-job-tool. */
@Injectable()
export class WebSearchService {
  private readonly logger = new Logger(WebSearchService.name);

  constructor(private readonly config: ConfigService) {}

  async search(query: string, count = 5): Promise<WebSearchResult> {
    const apiKey = this.config.get<string>('BOCHA_API_KEY');
    if (!apiKey) {
      return {
        query,
        items: [],
        error: 'BOCHA_API_KEY is not configured; web search is unavailable',
      };
    }

    const response = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        freshness: 'noLimit',
        summary: true,
        count: Math.min(Math.max(count, 1), 10),
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      this.logger.warn(`Bocha search failed: status=${response.status}`);
      return {
        query,
        items: [],
        error: `Search failed (${response.status}) ${detail.slice(0, 120)}`,
      };
    }

    const json = (await response.json()) as {
      code?: number;
      msg?: string;
      data?: {
        webPages?: {
          value?: Array<{
            name?: string;
            url?: string;
            summary?: string;
            snippet?: string;
            siteName?: string;
          }>;
        };
      };
    };

    if (json.code !== 200 || !json.data) {
      return {
        query,
        items: [],
        error: json.msg ?? 'The search API returned an unexpected response',
      };
    }

    const items = (json.data.webPages?.value ?? [])
      .filter((page) => page.url && page.name)
      .map((page) => ({
        title: page.name as string,
        url: page.url as string,
        snippet: (page.summary || page.snippet || '').trim(),
        siteName: page.siteName,
      }));

    return { query, items };
  }
}
