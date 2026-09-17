FROM node:22.22.0-bookworm-slim

WORKDIR /workspace
RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY backend/package.json backend/package.json
COPY frontend/package.json frontend/package.json
RUN pnpm install --frozen-lockfile

COPY backend backend
RUN pnpm --filter knowledge-hub-backend run build

EXPOSE 3000
CMD ["pnpm", "--filter", "knowledge-hub-backend", "run", "start:prod"]
