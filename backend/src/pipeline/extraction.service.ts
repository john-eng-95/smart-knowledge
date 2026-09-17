import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChatOpenAI } from '@langchain/openai';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { Runnable } from '@langchain/core/runnables';
import { BaseLanguageModelInput } from '@langchain/core/language_models/base';
import {
  buildExtractionSystemPrompt,
  kgExtractionResultSchema,
  KgExtractionLlmOutput,
  normalizeEntityType,
  normalizeRelationType,
} from './kg-extraction.schema';
import { ExtractionResult } from './types/pipeline.types';

/**
 * Entity and relation extraction service.
 *
 * <p>Used by KG building: extract entities and relations from each chunk, then write them to Neo4j.</p>
 * <p>ChatOpenAI.withStructuredOutput with no method specified; qwen-plus defaults to jsonSchema.</p>
 *
 * <p>Environment variables: OPENAI_API_KEY / OPENAI_BASE_URL / MODEL_NAME / KG_MAX_ENTITIES / KG_MAX_RELATIONS / KG_LLM_TIMEOUT_MS</p>
 */
@Injectable()
export class ExtractionService {
  private readonly logger = new Logger(ExtractionService.name);
  /** Maximum entities per chunk to prevent graph explosion. */
  private readonly maxEntities: number;
  private readonly maxRelations: number;
  private readonly structuredLlm?: Runnable<
    BaseLanguageModelInput,
    KgExtractionLlmOutput
  >;

  constructor(config: ConfigService) {
    const apiKey =
      config.get<string>('OPENAI_API_KEY') ||
      config.get<string>('LLM_API_KEY') ||
      config.get<string>('DASHSCOPE_API_KEY') ||
      undefined;
    this.maxEntities = Number(config.get('KG_MAX_ENTITIES', 12));
    this.maxRelations = Number(config.get('KG_MAX_RELATIONS', 15));

    if (!apiKey) return;

    const baseUrl =
      config.get<string>('OPENAI_BASE_URL') ||
      config.get<string>('LLM_BASE_URL') ||
      'https://dashscope.aliyuncs.com/compatible-mode/v1';
    const model =
      config.get<string>('MODEL_NAME') ||
      config.get<string>('LLM_MODEL') ||
      'qwen-plus';
    const timeout = Number(config.get('KG_LLM_TIMEOUT_MS', 60000));
    const timeoutMs = Number.isFinite(timeout) && timeout > 0 ? timeout : 60000;

    const llm = new ChatOpenAI({
      apiKey,
      model,
      temperature: 0.1,
      timeout: timeoutMs,
      maxRetries: 0,
      // Use Chat Completions for DashScope; do not switch to the OpenAI Responses API.
      useResponsesApi: false,
      configuration: { baseURL: baseUrl },
    });

    this.structuredLlm = llm.withStructuredOutput(kgExtractionResultSchema, {
      name: 'extract_knowledge_graph',
    });
  }

  /**
   * Extract entities and relations from one chunk.
   * @param content Chunk content.
   * @param heading Section heading supplied as LLM context.
   * @param documentTitle Document title.
   */
  async extract(
    content: string,
    heading: string | null | undefined,
    documentTitle: string,
  ): Promise<ExtractionResult> {
    if (!content?.trim()) {
      return { entities: [], relations: [] };
    }

    return this.extractByLlm(content, heading, documentTitle);
  }

  /**
   * LLM extraction: system prompt provides rules and the user message contains title and content,
   * truncated to 4,000 characters to protect the context window.
   */
  private async extractByLlm(
    content: string,
    heading: string | null | undefined,
    documentTitle: string,
  ): Promise<ExtractionResult> {
    if (!this.structuredLlm) {
      throw new Error(
        'No API key is configured for KG extraction (OPENAI_API_KEY / LLM_API_KEY / DASHSCOPE_API_KEY)',
      );
    }

    const system = buildExtractionSystemPrompt(
      this.maxEntities,
      this.maxRelations,
    );
    const user = `Document title: ${documentTitle}\nSection: ${heading ?? 'None'}\n\nContent:\n${content.slice(0, 4000)}`;

    const started = Date.now();
    const parsed = await this.structuredLlm.invoke([
      new SystemMessage(system),
      new HumanMessage(user),
    ]);
    this.logger.log(
      `KG extraction completed: title=${documentTitle}, elapsed=${Date.now() - started}ms, chars=${content.length}, entities=${parsed.entities?.length ?? 0}`,
    );

    return this.toExtractionResult(parsed);
  }

  /** Limit counts, normalize types, and discard relations with missing entities. */
  private toExtractionResult(parsed: KgExtractionLlmOutput): ExtractionResult {
    const entityNames = new Set<string>();
    const entities: ExtractionResult['entities'] = [];
    for (const e of (parsed.entities ?? []).slice(0, this.maxEntities)) {
      const name = (e.name ?? '').trim();
      if (!name) continue;
      entityNames.add(name);
      entities.push({
        name,
        type: normalizeEntityType(e.type),
        description: (e.description ?? '').trim(),
        aliases: (e.aliases ?? []).map((a) => String(a).trim()).filter(Boolean),
      });
    }

    const relations: ExtractionResult['relations'] = [];
    for (const r of (parsed.relations ?? []).slice(0, this.maxRelations)) {
      const source = (r.source ?? '').trim();
      const target = (r.target ?? '').trim();
      if (
        !source ||
        !target ||
        !entityNames.has(source) ||
        !entityNames.has(target)
      ) {
        continue;
      }
      relations.push({
        source,
        target,
        relation: normalizeRelationType(r.relation ?? r.type),
        weight: typeof r.weight === 'number' ? r.weight : 0.5,
      });
    }

    return { entities, relations };
  }
}
