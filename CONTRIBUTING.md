# Contributing

## Development Setup

Use the Node.js and pnpm versions specified in `.nvmrc` and `package.json`.
Copy `.env.example` to `.env`, install dependencies with
`pnpm install --frozen-lockfile`, and start required services with Docker
Compose.

## Before Opening a Pull Request

Run the following commands and include relevant test results in the pull
request description:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
pnpm build
```

Keep changes focused, add or update tests for behavior changes, and never
include credentials, generated output, or real personal documents. Do not
commit `.env` files.

## Pull Requests

Describe the user-visible behavior, implementation approach, and validation.
Include screenshots for frontend changes when they help reviewers verify the
result. Keep unrelated formatting or generated-file changes out of the
change.
