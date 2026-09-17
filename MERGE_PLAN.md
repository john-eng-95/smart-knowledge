# Smart Knowledge Monorepo Merge Plan

## 1. Goal

Merge the following projects into one public GitHub repository while keeping
the backend history and using the current frontend code as a clean snapshot:

- Backend source: `1knowledge-hub-backend`
- Frontend source: `knowledge-hub-frontend`
- Target repository: `smart-knowledge`

The final repository must be reproducible from a fresh clone, contain no
private credentials or personal data, have an English `README.md`, and pass
all automated and manual acceptance checks before delivery.

The backend Git history will be preserved. The frontend repository history
will not be imported into the public repository; only the selected current
frontend working tree will be copied into `frontend/`. The original frontend
repository will remain available locally as a backup and reference.

The source repositories remain untouched. A sanitized local monorepo
candidate has been assembled; it has not been pushed or published.

## 2. Pre-Migration Baseline

Checks performed before migration on 2026-09-17:

| Area | Result |
| --- | --- |
| Backend production build | Passed |
| Backend lint | Failed: 1,842 findings, mainly Prettier/style mismatch |
| Backend unit tests | No matching unit tests |
| Backend e2e test | Failed before running tests because Jest cannot load the ESM-only `ai` dependency |
| Frontend lint | Passed with 26 warnings |
| Frontend production build | Failed because `StrictMode` is imported but unused |
| Frontend automated tests | No test framework or test script |
| Backend working tree | Contains existing uncommitted changes to `package.json` and `pnpm-lock.yaml` |
| Frontend working tree | Clean on branch `v15` |
| Secret/history review | Frontend `.env` is tracked and exists in Git history |
| Open-source metadata | No license, CI workflow, contributing guide, or security policy |

These baseline results describe the source projects before migration.

## 3. Execution Status

Status checked on 2026-09-17:

- Completed: backend history was relocated to `backend/`, retaining 23 backend
  commits. The monorepo snapshot is on branch `main` with 29 commits total.
- Completed: frontend snapshot from `v15` commit `f209569` was imported into
  `frontend/`; its `.git` directory, history, and tracked `.env` were not
  imported. The historical `VITE_API_BASE` value was a relative path.
- Completed: root pnpm workspace, English README, MIT license, contribution and
  security documents, GitHub workflow/templates, Dockerfiles, and Compose
  configuration were added.
- Completed: frozen-lockfile installation, type checks, unit tests, backend
  e2e smoke test, lint, production builds, Compose configuration validation,
  Docker image builds, and frontend Nginx HTTP smoke test passed locally.
- Completed: an isolated Compose stack started with all nine services healthy.
  Frontend routing, valid and invalid login, document listing, keyword search,
  and graph overview endpoints passed HTTP smoke checks.
- Completed: Gitleaks scanned the complete reachable candidate history and the current
  repository tree with no findings. Historical credentials and a copied
  template token were replaced in the candidate history.
- Pending: frontend lint reports 25 warnings, including hook dependency,
  render-time ref access, and Fast Refresh warnings.
- Pending: browser-based Playwright coverage is not implemented. Upload parsing,
  vectorization, chat, and other external-provider workflows were not exercised;
  those require provider credentials.
- Pending: GitHub Actions has not run because no destination repository was
  provided. The candidate is not tagged or pushed; publication still requires
  the destination URL and explicit authorization.
- Note: the original backend history scan could not process all non-imported
  DOCX blobs. Supported source history contained generic credential findings;
  the candidate history was sanitized and passed its own full-history scan.
  Rotate any external credential that reused a historical local default.

The local candidate is ready for further acceptance testing, but it does not
yet satisfy the complete Definition of Done below.

## 4. Proposed Repository Layout

```text
smart-knowledge/
|-- .github/
|   |-- workflows/
|   |   `-- ci.yml
|   |-- ISSUE_TEMPLATE/
|   `-- pull_request_template.md
|-- backend/
|   |-- src/
|   |-- test/
|   |-- package.json
|   `-- Dockerfile
|-- frontend/
|   |-- src/
|   |-- public/
|   |-- package.json
|   `-- Dockerfile
|-- infra/
|   |-- elasticsearch/
|   `-- init-scripts/
|-- docs/
|   |-- architecture.md
|   `-- images/
|-- .env.example
|-- .gitignore
|-- .nvmrc
|-- docker-compose.yml
|-- package.json
|-- pnpm-lock.yaml
|-- pnpm-workspace.yaml
|-- README.md
|-- CONTRIBUTING.md
|-- SECURITY.md
`-- LICENSE
```

Use one root `pnpm` workspace and one lock file. Pin the Node.js and pnpm
versions used by CI and local development. Root scripts should provide a
single interface for `install`, `dev`, `lint`, `test`, `build`, and
integration checks.

## 5. Execution Phases

### Phase 0: Freeze and Back Up the Source State

1. Record source branches, tags, remotes, and current commit IDs.
2. Back up both repositories before any history rewrite.
3. Resolve the backend's existing uncommitted `mem0ai` dependency changes:
   preserve and commit them on a migration branch if they are intentional.
4. Use the backend `master` branch and frontend `v15` branch as the migration
   sources unless a different release branch is explicitly selected.
5. Do all migration work in `smart-knowledge`; leave the two source
   repositories available as rollback references.
6. Record the exact frontend snapshot commit used for the clean import.

Exit criteria: both source snapshots are recoverable and all intended local
changes are represented by commits.

### Phase 1: Security and Public-Release Sanitization

1. Treat the committed frontend `.env` as exposed:
   rotate any reusable credentials and remove the file from all Git history.
2. Scan every branch and tag in both repositories with a secret scanner such
   as Gitleaks.
3. Review `body.json`, `curl*.md`, `tmp.md`, `.vscode`, and all test documents
   for tokens, internal URLs, credentials, personal data, and copyrighted or
   company-confidential content.
4. Remove real resumes, medical documents, attendance sheets, and internal
   policy files from the public tree and history. Replace required fixtures
   with small synthetic samples.
5. Add complete root and package-level ignore rules for `.env`, build output,
   dependency folders, coverage, volumes, logs, and editor state.
6. Add `.env.example` with safe placeholders and explanatory comments. No
   value in that file may grant access to an external service.
7. Replace demonstration passwords in Compose and seed files with clearly
   documented local-only values or environment substitutions.

Exit criteria: a full-history secret scan has no unresolved finding, and the
repository contains no private or personal data.

### Phase 2: Preserve Backend History and Build the Monorepo

1. Create sanitized clones of both repositories.
2. Rewrite the backend clone into the `backend/` subdirectory with
   `git filter-repo`.
3. Initialize the target repository from the rewritten backend history.
4. Copy the selected current frontend snapshot into `frontend/` without
   copying its `.git` directory, then commit it as a new monorepo commit.
5. Preserve relevant backend tags with a `backend-` prefix. Do not import
   frontend branches or tags into the public repository.
6. Move infrastructure assets to `infra/` and update all relative paths in
   Docker Compose and scripts.
7. Create the root pnpm workspace and regenerate a single lock file from the
   two package manifests.
8. Add root commands that run both applications consistently.
9. Add backend and frontend Dockerfiles plus health checks so the complete
   local stack can be started with one documented command.

Exit criteria: `git log --follow` retains meaningful history for backend
files, the frontend snapshot is present without a nested `.git` directory,
and a fresh dependency install succeeds from the root.

### Phase 3: Repair Quality Gates and Add Tests

Backend:

1. Align ESLint and Prettier rules with the established TypeScript style.
2. Split `lint` and `lint:fix`; CI must never modify files.
3. Fix the ESM/Jest incompatibility and make the e2e suite independent of
   real external AI credentials.
4. Add focused unit tests for authentication, permissions, document state
   changes, parsing, retrieval, and error handling.
5. Add integration tests for PostgreSQL, MongoDB, Redis, RabbitMQ,
   Elasticsearch, Neo4j, and object storage where those services are part of
   a user-visible workflow.

Frontend:

1. Fix the current TypeScript build failure and resolve meaningful lint
   warnings, especially hook dependencies and ref access during render.
2. Add Vitest and React Testing Library for authentication guards, API error
   handling, permission-based navigation, and core page behavior.
3. Add Playwright smoke tests for login, document management, search, chat,
   graph navigation, review, and administration flows.
4. Mock external AI and web-search providers in CI so tests are deterministic
   and do not consume paid APIs.

Exit criteria: lint, type checks, builds, unit tests, integration tests, and
browser smoke tests all pass locally with zero test failures.

### Phase 4: Open-Source Documentation

Create the root `README.md` entirely in English. It should include:

1. Project name and concise purpose.
2. Real product screenshots and a high-level architecture diagram.
3. Main features and supported document formats.
4. Technology stack and repository structure.
5. Prerequisites with exact supported versions.
6. Quick start using Docker Compose.
7. Local backend and frontend development instructions.
8. Environment variable reference with required versus optional values.
9. Test, lint, build, and troubleshooting commands.
10. Default local demo accounts, clearly marked as development-only.
11. Security limitations and production deployment warnings.
12. Contribution, security, roadmap, and license links.

Also add:

- `CONTRIBUTING.md`
- `SECURITY.md`
- `CODE_OF_CONDUCT.md`
- GitHub issue and pull request templates
- A selected open-source license, recommended: MIT for a showcase repository

All commands in the English README must be executed during final validation;
documentation is not accepted based only on visual review.

### Phase 5: GitHub CI and Repository Hygiene

1. Add GitHub Actions using the pinned Node.js and pnpm versions.
2. Run frozen dependency installation, lint, type checks, builds, unit tests,
   and secret scanning on every pull request.
3. Run service-backed integration and Playwright smoke tests on `main` and on
   release pull requests.
4. Add dependency update automation and dependency/license review.
5. Protect `main` and require the CI workflow before merge.
6. Add repository description, topics, social preview, and release notes for
   the first public version.

Exit criteria: the GitHub Actions run is green from a clean GitHub checkout,
not merely from the existing local dependency folders.

### Phase 6: Final Verification and Publication

Verify from a brand-new clone in an empty directory:

```bash
corepack enable
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
docker compose config
docker compose up -d --build
pnpm test:integration
pnpm test:e2e
```

Then perform these manual smoke checks:

1. All containers become healthy and remain stable.
2. Frontend loads without console errors at desktop and mobile widths.
3. User, reviewer, and administrator login and authorization behave correctly.
4. A synthetic document can be uploaded, parsed, reviewed, published,
   searched, opened, and deleted.
5. Chat streaming and citations work with the deterministic test provider.
6. Knowledge graph pages render and query successfully.
7. Invalid credentials, forbidden actions, unavailable dependencies, and
   unsupported files show controlled errors.
8. Restarting the stack preserves expected data and does not require manual
   repair.
9. Every English README command works exactly as written.
10. Gitleaks passes against the complete Git history.

Only after all checks pass:

1. Tag the verified commit as `v1.0.0`.
2. Push `main` and sanitized tags to the new GitHub repository.
3. Confirm the public GitHub page contains no secrets or private artifacts.
4. Deliver the repository URL, commit/tag, CI run link, and a concise test
   report containing commands, versions, results, and any documented
   limitations.

## 6. Definition of Done

The merge is complete only when all of the following are true:

- One GitHub repository contains both applications.
- Backend files retain their useful Git history.
- Frontend is imported as a clean current-code snapshot without its original
  `.git` directory.
- `README.md` and public-facing repository documentation are in English.
- A fresh clone installs with the frozen root lock file.
- Lint and builds pass for both applications.
- Unit, integration, and browser e2e suites pass.
- Docker Compose starts the documented development stack successfully.
- CI is green on the exact public commit.
- Full-history secret scanning passes.
- No real personal, confidential, or licensed test data is published.
- The working tree is clean and the verified commit is tagged.

## 7. Expected Deliverables

- Public-ready monorepo at the repository root
- English `README.md`
- Sanitized backend Git history
- Clean frontend snapshot import
- Root development and Docker workflows
- Automated unit, integration, and browser tests
- GitHub Actions CI
- Open-source governance and license files
- Final verification report
- GitHub repository URL after explicit publication authorization
