# Stage 1: Build deps (cairo, canvas native). Debian/glibc for canvas prebuilds or build from source.
FROM node:20-bookworm-slim AS build-deps
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    build-essential python3 pkg-config \
    libcairo2-dev libpango1.0-dev libjpeg-dev libgif-dev libpng-dev && \
    rm -rf /var/lib/apt/lists/*

##################################################################################

# Stage 2: Install npm dependencies
FROM build-deps AS npm-deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
    npm ci --loglevel=error

##################################################################################

# Stage 3: Build TypeScript
FROM npm-deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

##################################################################################

# Stage 3b: Tests
FROM npm-deps AS test
COPY tsconfig.json jest.config.js jest.setup.js ./
COPY src ./src
RUN npm test

##################################################################################

# Stage 4: Runtime base (Debian slim, runtime libs for canvas only)
FROM node:20-bookworm-slim AS runtime-deps
RUN apt-get update -y && apt-get install -y --no-install-recommends \
    libcairo2 libpango-1.0-0 libjpeg62-turbo libgif7 libpng16-16 && \
    rm -rf /var/lib/apt/lists/*

##################################################################################

# Stage 5: Runtime
FROM runtime-deps AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=npm-deps /app/node_modules ./node_modules
RUN npm prune --production
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
