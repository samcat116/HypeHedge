FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Production image
FROM base AS release
COPY --from=install --chown=bun:bun /app/node_modules ./node_modules
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun package.json tsconfig.json ./
COPY --chown=bun:bun drizzle.config.ts ./
COPY --chown=bun:bun drizzle ./drizzle

# Create directory for database persistence
RUN mkdir -p /app/data && chown bun:bun /app/data

# Set environment
ENV NODE_ENV=production

# Run the bot
USER bun
CMD ["bun", "run", "src/index.ts"]
