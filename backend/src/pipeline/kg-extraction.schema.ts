/**
 * Generic knowledge graph extraction schema.
 *
 * @see docs/kg-extraction-schema.md
 */
import { z } from 'zod';

/** Core and extended entity types. */
export const KG_ENTITY_TYPES = [
  'PERSON',
  'ORGANIZATION',
  'CONCEPT',
  'DOCUMENT',
  'PROCESS',
  'PRODUCT',
  'LOCATION',
  'TIME',
  'POLICY',
  'RESOURCE',
] as const;

export type KgEntityType = (typeof KG_ENTITY_TYPES)[number];

/** Semantic relations between entities (Neo4j edge property relation; edge type remains RELATED_TO). */
export const KG_RELATION_TYPES = [
  'HAS_PART',
  'BELONGS_TO',
  'RELATED_TO',
  'DEFINES',
  'REQUIRES',
  'USES',
  'RESPONSIBLE_FOR',
  'PARTICIPATES_IN',
  'LOCATED_IN',
  'OCCURS_AT',
  'CAUSES',
  'CONFLICTS_WITH',
] as const;

export type KgRelationType = (typeof KG_RELATION_TYPES)[number];

const ENTITY_TYPE_SET = new Set<string>(KG_ENTITY_TYPES);
const RELATION_TYPE_SET = new Set<string>(KG_RELATION_TYPES);

/** Normalize an LLM type to the enum; unknown values use the fallback. */
export function normalizeEntityType(
  raw: string | undefined | null,
): KgEntityType {
  const upper = (raw ?? '').trim().toUpperCase();
  if (ENTITY_TYPE_SET.has(upper)) return upper as KgEntityType;
  return 'CONCEPT';
}

export function normalizeRelationType(
  raw: string | undefined | null,
): KgRelationType {
  const upper = (raw ?? '').trim().toUpperCase();
  if (RELATION_TYPE_SET.has(upper)) return upper as KgRelationType;
  return 'RELATED_TO';
}

/** Structured LLM output: entity. */
export const kgExtractedEntitySchema = z.object({
  name: z.string().describe('Entity name as written in the source text'),
  // Use string rather than enum because models may return localized or extra types; normalizeEntityType classifies them.
  type: z.string().describe('Entity type').optional(),
  description: z
    .string()
    .describe('Short description, may be empty')
    .optional(),
  aliases: z.array(z.string()).describe('Aliases').optional(),
});

/** Structured LLM output: relation. */
export const kgExtractedRelationSchema = z.object({
  source: z
    .string()
    .describe('Source entity name; must be an extracted entity'),
  target: z
    .string()
    .describe('Target entity name; must be an extracted entity'),
  // Use string rather than enum because models may write type or invent a relation such as APPLIES_TO.
  relation: z
    .string()
    .describe('Relation type; the field must be relation')
    .optional(),
  type: z
    .string()
    .describe(
      'Compatibility field read when a model incorrectly puts the relation type in type',
    )
    .optional(),
  weight: z
    .number()
    .min(0)
    .max(1)
    .describe('Confidence from 0 to 1')
    .optional(),
});

/** Structured LLM output: extraction result for one chunk. */
export const kgExtractionResultSchema = z
  .object({
    entities: z.array(kgExtractedEntitySchema).describe('Entity list'),
    relations: z.array(kgExtractedRelationSchema).describe('Relation list'),
  })
  .describe('Knowledge entities and relations extracted from a document chunk');

export type KgExtractionLlmOutput = z.infer<typeof kgExtractionResultSchema>;

/** Build the LLM system prompt. */
export function buildExtractionSystemPrompt(
  maxEntities: number,
  maxRelations: number,
): string {
  return `You are an expert in building knowledge graphs. Extract knowledge entities and relations strictly from the document chunk.

## Extraction rules
1. Extract only meaningful entities explicitly mentioned in the text; do not speculate.
2. Do not extract overly generic words such as "system", "feature", "data", or "issue".
3. Keep entity names as written in the source text; put alternate names in aliases.
4. Every relation must be supported by the text (the same or an adjacent sentence), and source/target must be names of extracted entities.
5. Extract at most ${maxEntities} entities and ${maxRelations} relations per chunk.
6. Use entity type CONCEPT and relation type RELATED_TO when classification is uncertain.

## Entity types
- PERSON: people or roles (for example, Alice or a reviewer)
- ORGANIZATION: organizations or departments (for example, the Engineering Center or Finance Department)
- CONCEPT: terms or concepts (for example, distributed transactions or a probation period)
- DOCUMENT: documents or standards (for example, an employee handbook)
- PROCESS: processes or activities (for example, onboarding or publication)
- PRODUCT: products or systems (for example, a knowledge base, CRM, or Redis)
- LOCATION: places (for example, Beijing or a meeting room)
- TIME: times or periods (for example, 2026-Q1 or every Monday)
- POLICY: policies or policy clauses
- RESOURCE: files, tools, or equipment (for example, Docker or training materials)

## Relation types
- HAS_PART: consists of or contains
- BELONGS_TO: belongs to
- RELATED_TO: generic relation (fallback)
- DEFINES: defines or explains
- REQUIRES: requires or depends on
- USES: uses
- RESPONSIBLE_FOR: responsible for
- PARTICIPATES_IN: participates in
- LOCATED_IN: located in
- OCCURS_AT: occurs at a time
- CAUSES: causes or leads to
- CONFLICTS_WITH: conflicts with or is an exception to

Return JSON only; do not include Markdown or other commentary. The relation object field must be relation, not type. Example:
{"entities":[{"name":"Finance Department","type":"ORGANIZATION","description":"","aliases":[]}],"relations":[{"source":"Finance Department","target":"Travel Reimbursement","relation":"RESPONSIBLE_FOR","weight":0.8}]}`;
}
