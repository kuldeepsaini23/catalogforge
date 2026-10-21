# One image runs both the web server and the worker: the web process stores uploads and the
# worker reads them, so they share a volume mounted at STORAGE_DIR (/data).
FROM node:22-bookworm-slim

RUN npm install -g bun@1.3.11
WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY . .

# The build prerenders storefront pages, which read published products, so it needs a database
# reachable at build time (on Railway: the public URL; the running app uses the private one).
ARG DATABASE_PUBLIC_URL
ARG PUBLIC_BASE_URL
ENV NEXT_TELEMETRY_DISABLED=1
RUN test -n "$DATABASE_PUBLIC_URL" || (echo "DATABASE_PUBLIC_URL build arg is required" && exit 1)
RUN DATABASE_URL="$DATABASE_PUBLIC_URL" bun run db:migrate && DATABASE_URL="$DATABASE_PUBLIC_URL" bun run build

ENV NODE_ENV=production
CMD ["bash", "scripts/start.sh"]
