# Stage 1: Install deps (needs build tools for native modules)
FROM node:22-slim AS deps

# Install build tools for better-sqlite3 + sharp
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    make \
    g++ \
    libvips-dev \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm ci

# Stage 2: Build the SvelteKit app
FROM deps AS build
COPY . .
RUN npm run build
# Prune devDependencies
RUN npm prune --production

# Stage 3: Runtime (minimal image)
FROM node:22-slim

# Install yt-dlp + runtime deps for sharp + better-sqlite3
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    libvips42 \
    ca-certificates \
    curl \
    && curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp \
    && chmod a+rx /usr/local/bin/yt-dlp \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/build ./build
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json .
COPY --from=build /app/static ./static

# Create cache dir for SQLite + resource cache
RUN mkdir -p /app/.cache/untether

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
    CMD curl -f http://localhost:3000/ || exit 1

CMD ["node", "build"]
