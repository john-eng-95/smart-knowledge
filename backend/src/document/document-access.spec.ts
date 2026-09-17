import type { AuthUser } from '../auth/auth-user.interface';
import { DocumentStatus } from './document-status';
import {
  accessFromUser,
  canReadDocument,
  canWriteDocument,
  esVisibilityFilter,
  wrapEsQuery,
} from './document-access';

const reader: AuthUser = {
  userId: 'user-1',
  username: 'reader',
  roles: ['ROLE_USER'],
  permissions: [],
  teamIds: ['team-1'],
};

describe('document access rules', () => {
  const scope = accessFromUser(reader);

  it('allows owners to read their own unpublished documents', () => {
    expect(
      canReadDocument(
        {
          authorId: 'user-1',
          teamId: null,
          isPublic: false,
          status: DocumentStatus.Draft,
        },
        scope,
      ),
    ).toBe(true);
  });

  it('restricts unpublished documents and documents outside the reader teams', () => {
    expect(
      canReadDocument(
        {
          authorId: 'user-2',
          teamId: null,
          isPublic: false,
          status: DocumentStatus.Draft,
        },
        scope,
      ),
    ).toBe(false);
    expect(
      canReadDocument(
        {
          authorId: 'user-2',
          teamId: 'team-2',
          isPublic: false,
          status: DocumentStatus.Published,
        },
        scope,
      ),
    ).toBe(false);
  });

  it('allows published public and team documents', () => {
    expect(
      canReadDocument(
        {
          authorId: 'user-2',
          teamId: null,
          isPublic: true,
          status: DocumentStatus.Published,
        },
        scope,
      ),
    ).toBe(true);
    expect(
      canReadDocument(
        {
          authorId: 'user-2',
          teamId: 'team-1',
          isPublic: false,
          status: DocumentStatus.Published,
        },
        scope,
      ),
    ).toBe(true);
  });

  it('grants reviewers read access and administrators write access', () => {
    const reviewer = accessFromUser({
      ...reader,
      roles: ['ROLE_REVIEWER'],
    });
    const admin = { ...reader, roles: ['ROLE_ADMIN'] };
    const draft = {
      authorId: 'user-2',
      teamId: null,
      isPublic: false,
      status: DocumentStatus.Draft,
    };

    expect(canReadDocument(draft, reviewer)).toBe(true);
    expect(canWriteDocument({ authorId: 'user-2' }, admin)).toBe(true);
  });

  it('applies Elasticsearch visibility filters to restricted readers', () => {
    const filter = esVisibilityFilter(scope, {
      isPublic: 'isPublic',
      authorId: 'authorId',
      teamId: 'teamId',
    });
    expect(filter).toMatchObject({
      bool: {
        minimum_should_match: 1,
      },
    });
    expect(wrapEsQuery({ match_all: {} }, filter)).toHaveProperty(
      'bool.filter',
    );
    expect(
      esVisibilityFilter(accessFromUser({ ...reader, roles: ['ROLE_ADMIN'] }), {
        isPublic: 'isPublic',
        authorId: 'authorId',
        teamId: 'teamId',
      }),
    ).toBeNull();
  });
});
