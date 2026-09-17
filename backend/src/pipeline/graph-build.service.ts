import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import neo4j, { Driver, Session } from 'neo4j-driver';
import { ChunkingService } from './chunking.service';
import { ExtractionService } from './extraction.service';
import { ExtractionResult, PipelineDocument } from './types/pipeline.types';
import { scalarToString } from '../common/scalar-string';
import {
  neo4jAccessParams,
  neo4jDocumentAccessWhere,
  type DocumentAccessScope,
} from '../document/document-access';

/**
 * KG knowledge graph builder.
 *
 * <p>Simplified graph model:</p>
 * <pre>
 * (KnowledgeDocument)-[:HAS_CHUNK]->(DocumentChunk)-[:MENTIONS]->(KnowledgeEntity)
 * (KnowledgeEntity)-[:RELATED_TO]->(KnowledgeEntity)
 * </pre>
 *
 * <p>Single-document build steps:</p>
 * <ol>
 *   <li>Delete existing graph data for the document (clear before build).</li>
 *   <li>MERGE the document node.</li>
 *   <li>Chunk with ChunkingService -> create DocumentChunk + HAS_CHUNK for each chunk.</li>
 *   <li>Extract entities/relations -> MERGE entities / RELATED_TO / MENTIONS.</li>
 * </ol>
 *
 * Skip writes when Neo4j is unavailable so publication consumption is not blocked.
 */
@Injectable()
export class GraphBuildService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GraphBuildService.name);
  private driver: Driver | null = null;
  private readonly enabled: boolean;

  constructor(
    private readonly config: ConfigService,
    private readonly chunkingService: ChunkingService,
    private readonly extractionService: ExtractionService,
  ) {
    this.enabled = this.config.get<string>('NEO4J_ENABLED', 'true') !== 'false';
  }

  async onModuleInit() {
    if (!this.enabled) {
      this.logger.warn('Neo4j is disabled (NEO4J_ENABLED=false)');
      return;
    }
    const uri = this.config.get<string>('NEO4J_URI', 'bolt://localhost:7687');
    const user = this.config.get<string>('NEO4J_USER', 'neo4j');
    const password = this.config.get<string>(
      'NEO4J_PASSWORD',
      'local-only-neo4j-pass',
    );
    this.driver = neo4j.driver(uri, neo4j.auth.basic(user, password));
    try {
      await this.driver.verifyConnectivity();
      this.logger.log(`Neo4j connected: ${uri}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Neo4j unavailable; skipping KG writes: ${message}`);
      await this.driver.close();
      this.driver = null;
    }
  }

  async onModuleDestroy() {
    await this.driver?.close();
  }

  /**
   * Rebuild the graph for one document.
   * @returns Approximate number of entities written.
   */
  async buildForDocument(doc: PipelineDocument): Promise<number> {
    if (!this.driver) {
      this.logger.warn(
        `Skipping KG build (Neo4j unavailable): documentId=${doc.id}`,
      );
      return 0;
    }
    if (!doc.content?.trim()) {
      this.logger.log(
        `Document content is empty; skipping KG: documentId=${doc.id}`,
      );
      return 0;
    }

    // Clear before rebuilding so repeated publication does not duplicate nodes or edges.
    await this.deleteForDocument(doc.id);

    const session = this.driver.session();
    const now = new Date().toISOString();
    try {
      // 1. Document node: idempotent upsert by id, preserving the initial createdAt.
      await session.run(
        `
        // Use the document business ID as the unique key.
        MERGE (d:KnowledgeDocument {id: $id})
        // Refresh mutable metadata on every rebuild; write createdAt only on creation.
        SET d.title = $title, d.summary = $summary, d.categoryId = $categoryId,
            d.authorId = $authorId, d.teamId = $teamId, d.isPublic = $isPublic,
            d.status = $status, d.tags = $tags,
            d.updatedAt = $now, d.createdAt = coalesce(d.createdAt, $now)
        `,
        {
          id: doc.id,
          title: doc.title,
          summary: doc.summary ?? '',
          categoryId: doc.categoryId ?? null,
          authorId: doc.authorId ?? null,
          teamId: doc.teamId ?? null,
          isPublic: doc.isPublic ?? false,
          status: doc.status,
          tags: doc.tags ?? '',
          now,
        },
      );

      // 2. Reuse RAG chunking so graph and vector chunk granularity match.
      const chunks = await this.chunkingService.chunk({
        content: doc.content,
        documentId: doc.id,
        documentTitle: doc.title,
        categoryId: doc.categoryId,
        authorId: doc.authorId,
        teamId: doc.teamId,
        isPublic: doc.isPublic,
        docStatus: doc.status,
        publishTime:
          doc.publishTime instanceof Date
            ? doc.publishTime.toISOString()
            : doc.publishTime
              ? new Date(doc.publishTime).toISOString()
              : null,
      });

      let totalEntities = 0;
      for (const chunk of chunks) {
        // 3. Chunk node and document -> chunk edge: Document -[HAS_CHUNK]-> Chunk.
        await session.run(
          `
          // Idempotently create or update the chunk node by globally unique chunkId.
          MERGE (c:DocumentChunk {chunkId: $chunkId})
          SET c.documentId = $documentId, c.content = $content, c.heading = $heading,
              c.chunkIndex = $chunkIndex, c.totalChunks = $totalChunks, c.updatedAt = $now
          // Carry c into the next clause so the current chunk context is retained.
          WITH c
          // Find the owning document (guaranteed to exist by step 1).
          MATCH (d:KnowledgeDocument {id: $documentId})
          // One-to-many document -> chunk edge; store the index for ordered traversal.
          MERGE (d)-[r:HAS_CHUNK]->(c)
          SET r.chunkIndex = $chunkIndex
          `,
          {
            chunkId: chunk.chunkId,
            documentId: doc.id,
            content: chunk.content,
            heading: chunk.heading ?? null,
            chunkIndex: chunk.chunkIndex,
            totalChunks: chunk.totalChunks,
            now,
          },
        );

        // 4. Extract entities and relations; one failed chunk must not block the rest.
        let extracted: ExtractionResult;
        try {
          extracted = await this.extractionService.extract(
            chunk.content,
            chunk.heading,
            doc.title,
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          this.logger.error(
            `KG extraction failed; skipping chunk: documentId=${doc.id}, chunk=${chunk.chunkIndex}, ${message}`,
          );
          extracted = { entities: [], relations: [] };
        }
        // Bind the current chunk so writeExtraction can create MENTIONS edges.
        extracted.chunkId = chunk.chunkId;
        // Write entity nodes, MENTIONS edges, and RELATED_TO edges to Neo4j.
        const written = await this.writeExtraction(session, extracted);
        // Accumulate entities for logging; graph data was persisted above.
        totalEntities += written;
      }

      this.logger.log(
        `KG graph build completed: documentId=${doc.id}, chunks=${chunks.length}, entities=${totalEntities}`,
      );
      return totalEntities;
    } finally {
      await session.close();
    }
  }

  /** Build graphs in batch; log individual document failures. */
  async buildBatch(docs: PipelineDocument[]) {
    for (const doc of docs) {
      try {
        await this.buildForDocument(doc);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.error(`KG build failed: documentId=${doc.id}, ${message}`);
      }
    }
  }

  /** Update only document-node visibility for published documents without re-extracting entities. */
  async updateVisibility(
    documentId: string,
    vis: { isPublic: boolean; teamId: string | null; authorId: string | null },
  ) {
    if (!this.driver) {
      this.logger.warn(
        `Skipping graph visibility update (Neo4j unavailable): documentId=${documentId}`,
      );
      return;
    }
    const session = this.driver.session();
    try {
      await session.run(
        `
        MATCH (d:KnowledgeDocument {id: $id})
        SET d.isPublic = $isPublic, d.teamId = $teamId, d.authorId = $authorId,
            d.updatedAt = $now
        `,
        {
          id: documentId,
          isPublic: vis.isPublic,
          teamId: vis.teamId,
          authorId: vis.authorId,
          now: new Date().toISOString(),
        },
      );
      this.logger.log(`Graph visibility updated: documentId=${documentId}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(
        `Graph visibility update failed: documentId=${documentId}, ${message}`,
      );
    } finally {
      await session.close();
    }
  }

  /**
   * Delete a document and its chunks, then remove orphan entities with no MENTIONS edges.
   */
  async deleteForDocument(documentId: string) {
    if (!this.driver) return;
    const session = this.driver.session();
    try {
      // Delete the document and all chunks; DETACH removes connected edges as well.
      await session.run(
        `
        // Locate the document to delete.
        MATCH (d:KnowledgeDocument {id: $id})
        // Match child chunks when present; the document can still be deleted without chunks.
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(c:DocumentChunk)
        // DETACH DELETE removes all node relationships before deleting the node.
        // This clears HAS_CHUNK and other edges connected to c/d.
        DETACH DELETE c, d
        `,
        { id: documentId },
      );
      // Orphan cleanup: entities with no chunk MENTIONS edges are unreferenced and can be deleted.
      await session.run(
        `
        MATCH (e:KnowledgeEntity)
        // No incoming MENTIONS edges means no document chunk references the entity.
        WHERE NOT (e)<-[:MENTIONS]-()
        // DETACH also clears leftover RELATED_TO edges and prevents dangling edges.
        DETACH DELETE e
        `,
      );
      this.logger.log(`KG graph deleted: documentId=${documentId}`);
    } finally {
      await session.close();
    }
  }

  /**
   * Query entity nodes. Return [] when Neo4j is unavailable.
   */
  async listNodes(type?: string, limit = 200, scope?: DocumentAccessScope) {
    if (!this.driver) {
      this.logger.warn('Skipping graph node query (Neo4j unavailable)');
      return [];
    }
    const cap = Math.min(Math.max(limit, 1), 500);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (e:KnowledgeEntity)
        WHERE ($type IS NULL OR $type = '' OR e.type = $type)
          AND (
            $unrestricted OR EXISTS {
              MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e)
              WHERE ${neo4jDocumentAccessWhere('d')}
            }
          )
        RETURN DISTINCT e.name AS id, e.name AS name, e.type AS type,
               e.description AS description
        LIMIT $limit
        `,
        {
          type: type ?? null,
          limit: neo4j.int(cap),
          ...neo4jAccessParams(scope),
        },
      );
      return result.records.map((record) => ({
        id: record.get('id') as string,
        name: record.get('name') as string,
        type: (record.get('type') as string) ?? null,
        description: (record.get('description') as string) ?? null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Graph node query failed: ${message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Query RELATED_TO edges between entities. Return [] when Neo4j is unavailable.
   */
  async listEdges(limit = 500, scope?: DocumentAccessScope) {
    if (!this.driver) {
      this.logger.warn('Skipping graph edge query (Neo4j unavailable)');
      return [];
    }
    const cap = Math.min(Math.max(limit, 1), 1000);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
        WHERE $unrestricted OR (
          EXISTS {
            MATCH (d1:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(a)
            WHERE ${neo4jDocumentAccessWhere('d1')}
          }
          AND EXISTS {
            MATCH (d2:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(b)
            WHERE ${neo4jDocumentAccessWhere('d2')}
          }
        )
        RETURN a.name AS source, b.name AS target,
               r.relation AS relation, r.weight AS weight
        LIMIT $limit
        `,
        { limit: neo4j.int(cap), ...neo4jAccessParams(scope) },
      );
      return result.records.map((record) => ({
        source: record.get('source') as string,
        target: record.get('target') as string,
        relation: (record.get('relation') as string) ?? 'RELATED_TO',
        weight: this.toNumber(record.get('weight'), 0.5),
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Graph edge query failed: ${message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Graph keyword search: match entity names/descriptions, document titles/summaries, and chunk headings/content.
   * Return [] when Neo4j is unavailable or the keyword is empty.
   */
  async searchGraph(keyword: string, limit = 50, scope?: DocumentAccessScope) {
    if (!this.driver) {
      this.logger.warn('Skipping graph search (Neo4j unavailable)');
      return [];
    }
    const kw = keyword.trim();
    if (!kw) return [];

    const cap = Math.min(Math.max(limit, 1), 200);
    const session = this.driver.session();
    try {
      const result = await session.run(
        `
        MATCH (n)
        WHERE (
             toLower(coalesce(n.name, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.title, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.heading, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.description, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.summary, '')) CONTAINS toLower($kw)
          OR toLower(coalesce(n.content, '')) CONTAINS toLower($kw)
        )
        AND (
          $unrestricted
          OR (n:KnowledgeDocument AND ${neo4jDocumentAccessWhere('n')})
          OR (n:DocumentChunk AND EXISTS {
            MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(n)
            WHERE ${neo4jDocumentAccessWhere('d')}
          })
          OR (n:KnowledgeEntity AND EXISTS {
            MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(n)
            WHERE ${neo4jDocumentAccessWhere('d')}
          })
        )
        RETURN labels(n)[0] AS label,
               coalesce(n.name, n.title, n.heading, n.id, n.chunkId) AS name,
               coalesce(n.id, n.chunkId, n.name) AS id,
               n.type AS type,
               n.title AS title,
               n.description AS description,
               n.heading AS heading,
               n.documentId AS documentId,
               n.summary AS summary,
               CASE
                 WHEN n.content IS NULL THEN null
                 ELSE substring(n.content, 0, 160)
               END AS snippet
        ORDER BY label, name
        LIMIT $limit
        `,
        { kw, limit: neo4j.int(cap), ...neo4jAccessParams(scope) },
      );
      return result.records.map((record) => ({
        id: record.get('id') as string,
        name: record.get('name') as string,
        label: (record.get('label') as string) ?? null,
        type: (record.get('type') as string) ?? null,
        title: (record.get('title') as string) ?? null,
        description: (record.get('description') as string) ?? null,
        heading: (record.get('heading') as string) ?? null,
        documentId: (record.get('documentId') as string) ?? null,
        summary: (record.get('summary') as string) ?? null,
        snippet: (record.get('snippet') as string) ?? null,
      }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Graph search failed: ${message}`);
      return [];
    } finally {
      await session.close();
    }
  }

  /**
   * Graph overview: documents, mentioned entities, and tags; chunks are omitted because they are too granular for the canvas.
   * Document -> entity is "mentions", entity -> entity uses the RELATED_TO relation, and document -> tag is "tagged".
   */
  async getOverview(params: {
    keyword?: string;
    entityType?: string;
    from?: string;
    to?: string;
    docLimit?: number;
    scope?: DocumentAccessScope;
  }) {
    const empty = {
      nodes: [] as Array<{
        id: string;
        name: string;
        kind: 'document' | 'entity' | 'tag';
        type?: string | null;
        documentId?: string | null;
        updatedAt?: string | null;
        description?: string | null;
      }>,
      edges: [] as Array<{
        source: string;
        target: string;
        relation: string;
        kind: 'mentions' | 'related' | 'tagged';
      }>,
      stats: {
        nodeCount: 0,
        edgeCount: 0,
        documentCount: 0,
        entityCount: 0,
        tagCount: 0,
        mentionCount: 0,
        relatedCount: 0,
        entityTypes: [] as Array<{ type: string; count: number }>,
      },
      topEntities: [] as Array<{
        name: string;
        type: string | null;
        degree: number;
      }>,
      recentNodes: [] as Array<{
        id: string;
        name: string;
        kind: string;
        updatedAt: string | null;
      }>,
      entityTypes: [] as string[],
    };

    if (!this.driver) {
      this.logger.warn('Skipping graph overview (Neo4j unavailable)');
      return empty;
    }

    const kw = params.keyword?.trim() ?? '';
    const entityType = params.entityType?.trim() || null;
    const from = params.from?.trim() || null;
    const to = params.to?.trim() || null;
    const docLimit = Math.min(Math.max(params.docLimit ?? 24, 1), 80);
    const vis = neo4jAccessParams(params.scope);
    const session = this.driver.session();

    try {
      // Global statistics: count only documents and mentions visible to the current user.
      const statsResult = await session.run(
        `
        OPTIONAL MATCH (d:KnowledgeDocument)
        WHERE ${neo4jDocumentAccessWhere('d')}
        WITH count(d) AS documentCount
        OPTIONAL MATCH (d2:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE ${neo4jDocumentAccessWhere('d2')}
        WITH documentCount, count(DISTINCT e) AS entityCount
        OPTIONAL MATCH (a:KnowledgeEntity)-[rel:RELATED_TO]->(b:KnowledgeEntity)
        WHERE $unrestricted OR (
          EXISTS {
            MATCH (d3:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(a)
            WHERE ${neo4jDocumentAccessWhere('d3')}
          }
          AND EXISTS {
            MATCH (d4:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(b)
            WHERE ${neo4jDocumentAccessWhere('d4')}
          }
        )
        WITH documentCount, entityCount, count(rel) AS relatedCount
        OPTIONAL MATCH (d5:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e0:KnowledgeEntity)
        WHERE ${neo4jDocumentAccessWhere('d5')}
        RETURN documentCount, entityCount, relatedCount, count(e0) AS mentionCount
        `,
        vis,
      );
      const statsRow = statsResult.records[0];
      const documentCount = this.toNumber(statsRow?.get('documentCount'), 0);
      const entityCount = this.toNumber(statsRow?.get('entityCount'), 0);
      const relatedCount = this.toNumber(statsRow?.get('relatedCount'), 0);
      const mentionCount = this.toNumber(statsRow?.get('mentionCount'), 0);

      // Group counts by entity type for frontend filtering.
      const typeRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE ${neo4jDocumentAccessWhere('d')}
          AND e.type IS NOT NULL AND e.type <> ''
        RETURN e.type AS type, count(DISTINCT e) AS count
        ORDER BY count DESC
        `,
        vis,
      );
      const entityTypes = typeRows.records.map((record) => ({
        type: String(record.get('type')),
        count: this.toNumber(record.get('count'), 0),
      }));

      // Five entities with the most document-chunk MENTIONS (degree = mention count).
      const topRows = await session.run(
        `
        MATCH (e:KnowledgeEntity)<-[:MENTIONS]-(:DocumentChunk)<-[:HAS_CHUNK]-(d:KnowledgeDocument)
        WHERE ${neo4jDocumentAccessWhere('d')}
        RETURN e.name AS name, e.type AS type, count(*) AS degree
        ORDER BY degree DESC
        LIMIT 5
        `,
        vis,
      );
      const topEntities = topRows.records.map((record) => ({
        name: String(record.get('name')),
        type: (record.get('type') as string) ?? null,
        degree: this.toNumber(record.get('degree'), 0),
      }));

      // Eight recently updated documents, unaffected by keyword/time/type filters.
      const recentRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)
        WHERE ${neo4jDocumentAccessWhere('d')}
        RETURN d.id AS id, d.title AS name, d.updatedAt AS updatedAt
        ORDER BY d.updatedAt DESC
        LIMIT 8
        `,
        vis,
      );
      const recentNodes = recentRows.records.map((record) => ({
        id: `doc:${record.get('id') as string}`,
        name: String(record.get('name') ?? ''),
        kind: 'document',
        updatedAt: (record.get('updatedAt') as string) ?? null,
      }));

      // Main query: filter documents by title/summary/tags and time, then attach MENTIONS entities after LIMIT.
      const docRows = await session.run(
        `
        MATCH (d:KnowledgeDocument)
        WHERE ${neo4jDocumentAccessWhere('d')}
          AND ($kw = '' OR toLower(coalesce(d.title, '')) CONTAINS toLower($kw)
              OR toLower(coalesce(d.summary, '')) CONTAINS toLower($kw)
              OR toLower(coalesce(d.tags, '')) CONTAINS toLower($kw))
          AND ($from IS NULL OR d.updatedAt >= $from)
          AND ($to IS NULL OR d.updatedAt <= $to)
        WITH d ORDER BY d.updatedAt DESC LIMIT $docLimit
        OPTIONAL MATCH (d)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e:KnowledgeEntity)
        WHERE $entityType IS NULL OR e.type = $entityType
        RETURN d.id AS docId, d.title AS docTitle, d.summary AS summary,
               d.tags AS tags, d.updatedAt AS updatedAt,
               collect(DISTINCT CASE WHEN e IS NULL THEN NULL ELSE {
                 name: e.name, type: e.type, description: e.description
               } END) AS entities
        `,
        {
          kw,
          entityType,
          from,
          to,
          docLimit: neo4j.int(docLimit),
          ...vis,
        },
      );

      const docRecords = [...docRows.records];

      // Add documents that mention a keyword-matched entity when the document title did not match.
      if (kw) {
        const extra = await session.run(
          `
          MATCH (e:KnowledgeEntity)<-[:MENTIONS]-(:DocumentChunk)<-[:HAS_CHUNK]-(d:KnowledgeDocument)
          WHERE ${neo4jDocumentAccessWhere('d')}
            AND (toLower(coalesce(e.name, '')) CONTAINS toLower($kw)
             OR toLower(coalesce(e.description, '')) CONTAINS toLower($kw))
          WITH DISTINCT d
          WHERE ($from IS NULL OR d.updatedAt >= $from)
            AND ($to IS NULL OR d.updatedAt <= $to)
          OPTIONAL MATCH (d)-[:HAS_CHUNK]->(:DocumentChunk)-[:MENTIONS]->(e2:KnowledgeEntity)
          WHERE $entityType IS NULL OR e2.type = $entityType
          RETURN d.id AS docId, d.title AS docTitle, d.summary AS summary,
                 d.tags AS tags, d.updatedAt AS updatedAt,
                 collect(DISTINCT CASE WHEN e2 IS NULL THEN NULL ELSE {
                   name: e2.name, type: e2.type, description: e2.description
                 } END) AS entities
          LIMIT $docLimit
          `,
          {
            kw,
            entityType,
            from,
            to,
            docLimit: neo4j.int(docLimit),
            ...vis,
          },
        );
        const seen = new Set(docRecords.map((r) => String(r.get('docId'))));
        for (const record of extra.records) {
          const id = String(record.get('docId'));
          if (!seen.has(id)) docRecords.push(record);
        }
      }

      const nodeMap = new Map<
        string,
        {
          id: string;
          name: string;
          kind: 'document' | 'entity' | 'tag';
          type?: string | null;
          documentId?: string | null;
          updatedAt?: string | null;
          description?: string | null;
        }
      >();
      const edgeMap = new Map<
        string,
        {
          source: string;
          target: string;
          relation: string;
          kind: 'mentions' | 'related' | 'tagged';
        }
      >();
      const entityNames = new Set<string>();

      const addEdge = (
        source: string,
        target: string,
        relation: string,
        kind: 'mentions' | 'related' | 'tagged',
      ) => {
        const key = `${kind}|${source}|${target}|${relation}`;
        if (!edgeMap.has(key)) {
          edgeMap.set(key, { source, target, relation, kind });
        }
      };

      const splitTags = (raw: unknown) =>
        scalarToString(raw)
          .split(/[,，]/)
          .map((t) => t.trim())
          .filter(Boolean);

      for (const record of docRecords) {
        const docId = String(record.get('docId'));
        const docNodeId = `doc:${docId}`;
        nodeMap.set(docNodeId, {
          id: docNodeId,
          name: String(record.get('docTitle') ?? ''),
          kind: 'document',
          type: 'DOCUMENT',
          documentId: docId,
          updatedAt: (record.get('updatedAt') as string) ?? null,
          description: (record.get('summary') as string) ?? null,
        });
        for (const tag of splitTags(record.get('tags'))) {
          const tagId = `tag:${tag}`;
          nodeMap.set(tagId, {
            id: tagId,
            name: tag,
            kind: 'tag',
            type: 'TAG',
          });
          addEdge(docNodeId, tagId, 'tagged', 'tagged');
        }
        const entities = record.get('entities') as Array<{
          name?: string;
          type?: string;
          description?: string;
        } | null>;
        for (const entity of entities ?? []) {
          if (!entity?.name) continue;
          const entityId = `entity:${entity.name}`;
          entityNames.add(entity.name);
          nodeMap.set(entityId, {
            id: entityId,
            name: entity.name,
            kind: 'entity',
            type: entity.type ?? 'CONCEPT',
            description: entity.description ?? null,
          });
          addEdge(docNodeId, entityId, 'mentions', 'mentions');
        }
      }

      if (entityNames.size > 0) {
        // Keep RELATED_TO edges only between entities currently on the canvas.
        const relatedRows = await session.run(
          `
          MATCH (a:KnowledgeEntity)-[r:RELATED_TO]->(b:KnowledgeEntity)
          WHERE a.name IN $names AND b.name IN $names
          RETURN a.name AS source, b.name AS target,
                 r.relation AS relation, r.weight AS weight
          LIMIT 400
          `,
          { names: [...entityNames] },
        );
        for (const record of relatedRows.records) {
          const source = `entity:${record.get('source') as string}`;
          const target = `entity:${record.get('target') as string}`;
          const relation = (record.get('relation') as string) || 'related';
          addEdge(source, target, relation, 'related');
        }
      }

      const nodes = [...nodeMap.values()];
      const edges = [...edgeMap.values()];
      const tagCount = nodes.filter((n) => n.kind === 'tag').length;

      return {
        nodes,
        edges,
        stats: {
          nodeCount: nodes.length,
          edgeCount: edges.length,
          documentCount,
          entityCount,
          tagCount,
          mentionCount,
          relatedCount,
          entityTypes,
        },
        topEntities,
        recentNodes,
        entityTypes: entityTypes.map((t) => t.type),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`Graph overview query failed: ${message}`);
      return empty;
    } finally {
      await session.close();
    }
  }

  private toNumber(value: unknown, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (neo4j.isInt(value)) return value.toNumber();
    return fallback;
  }

  /**
   * Write extraction results to Neo4j:
   * - KnowledgeEntity (MERGE by name so same-named entities can be shared across documents).
   * - DocumentChunk -[:MENTIONS]-> Entity
   * - Entity -[:RELATED_TO]-> Entity
   */
  private async writeExtraction(
    session: Session,
    result: {
      chunkId?: string;
      entities: Array<{
        name: string;
        type: string;
        description?: string;
        aliases?: string[];
      }>;
      relations: Array<{
        source: string;
        target: string;
        relation: string;
        weight?: number;
      }>;
    },
  ): Promise<number> {
    const now = new Date().toISOString();
    let count = 0;

    for (const entity of result.entities) {
      await session.run(
        `
        MERGE (e:KnowledgeEntity {name: $name})
        ON CREATE SET e.type = $type, e.description = $description,
                      e.aliases = $aliases, e.createdAt = $now, e.updatedAt = $now
        ON MATCH SET e.type = coalesce($type, e.type),
                     e.description = CASE WHEN $description <> '' THEN $description ELSE e.description END,
                     e.updatedAt = $now
        `,
        {
          name: entity.name,
          type: entity.type,
          description: entity.description ?? '',
          aliases: entity.aliases ?? [],
          now,
        },
      );
      count++;

      if (result.chunkId) {
        await session.run(
          `
          MATCH (c:DocumentChunk {chunkId: $chunkId})
          MATCH (e:KnowledgeEntity {name: $name})
          MERGE (c)-[:MENTIONS]->(e)
          `,
          { chunkId: result.chunkId, name: entity.name },
        );
      }
    }

    for (const rel of result.relations) {
      await session.run(
        `
        MATCH (a:KnowledgeEntity {name: $source})
        MATCH (b:KnowledgeEntity {name: $target})
        MERGE (a)-[r:RELATED_TO]->(b)
        ON CREATE SET r.relation = $relType, r.weight = $weight, r.createdAt = datetime()
        ON MATCH SET r.weight = coalesce($weight, r.weight)
        `,
        {
          source: rel.source,
          target: rel.target,
          relType: rel.relation,
          weight: rel.weight ?? 0.5,
        },
      );
    }

    return count;
  }
}
