import { RoleCode } from '../common/constants/roles';
import type { AuthUser } from '../auth/auth-user.interface';
import { DocumentStatus } from './document-status';
import type { DocumentEntity } from './entities/document.entity';

/** Documents readable by the current user: public, team-shared, or authored by the user; admins/reviewers are unrestricted. */
export type DocumentAccessScope = {
  unrestricted: boolean;
  userId: string;
  teamIds: string[];
};

export function accessFromUser(user: AuthUser): DocumentAccessScope {
  const roles = user.roles ?? [];
  return {
    unrestricted:
      roles.includes(RoleCode.ADMIN) || roles.includes(RoleCode.REVIEWER),
    userId: user.userId,
    teamIds: user.teamIds ?? [],
  };
}

export function canReadDocument(
  doc: Pick<DocumentEntity, 'authorId' | 'teamId' | 'isPublic' | 'status'>,
  scope: DocumentAccessScope,
): boolean {
  if (scope.unrestricted) return true;
  if (doc.authorId && doc.authorId === scope.userId) return true;
  if (doc.status !== DocumentStatus.Published) return false;
  if (doc.isPublic) return true;
  return Boolean(doc.teamId && scope.teamIds.includes(doc.teamId));
}

export function canWriteDocument(
  doc: Pick<DocumentEntity, 'authorId'>,
  user: AuthUser,
): boolean {
  if (user.roles?.includes(RoleCode.ADMIN)) return true;
  return Boolean(doc.authorId && doc.authorId === user.userId);
}

export const ES_CHUNK_VISIBILITY_FIELDS = {
  isPublic: 'is_public',
  authorId: 'author_id',
  teamId: 'team_id',
};

export const ES_DOC_VISIBILITY_FIELDS = {
  isPublic: 'isPublic',
  authorId: 'authorId',
  teamId: 'teamId',
};

/**
 * Elasticsearch visibility filter (filters without affecting scores).
 * fields distinguishes kh_document (camelCase) from kh_chunk (snake_case).
 * Return null for admins/reviewers so callers add no filter.
 */
export function esVisibilityFilter(
  scope: DocumentAccessScope,
  fields: { isPublic: string; authorId: string; teamId: string },
): Record<string, unknown> | null {
  if (scope.unrestricted) return null;
  // Public or authored by the user; add the user's teams when present.
  // Do not check status because unpublished documents are assumed to be absent from indexes.
  const should: Record<string, unknown>[] = [
    { term: { [fields.isPublic]: true } },
    { term: { [fields.authorId]: scope.userId } },
  ];
  if (scope.teamIds.length) {
    should.push({ terms: { [fields.teamId]: scope.teamIds } });
  }
  // In a filter context, should means OR; at least one clause must match.
  return { bool: { should, minimum_should_match: 1 } };
}

/** Put relevance queries in must and visibility queries in filter so permissions do not affect scores. */
export function wrapEsQuery(
  query: Record<string, unknown>,
  filter: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!filter) return query;
  return {
    bool: {
      must: [query],
      filter: [filter],
    },
  };
}

export function neo4jAccessParams(scope?: DocumentAccessScope) {
  return {
    unrestricted: !scope || scope.unrestricted,
    accessUserId: scope?.userId ?? '',
    accessTeamIds: scope?.teamIds ?? [],
  };
}

/** Cypher predicate for whether a document node is visible to the current user. */
export function neo4jDocumentAccessWhere(alias = 'd'): string {
  return (
    `($unrestricted OR ${alias}.authorId = $accessUserId ` +
    `OR ${alias}.isPublic = true OR ${alias}.teamId IN $accessTeamIds)`
  );
}
