FROM oven/bun:1 AS base
WORKDIR /app

# Install dependencies
FROM base AS install
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production

# Production image
FROM base AS release
COPY --from=install /app/node_modules ./node_modules
COPY src ./src
COPY package.json tsconfig.json ./

# Create directory for database persistence
RUN mkdir -p /app/data

# Set environment
ENV NODE_ENV=production

# Run the bot
USER bun
CMD ["bun", "run", "src/index.ts"]
