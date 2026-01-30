# Stage 1: Build deps (cairo, canvas native). Cache apk between builds.
FROM node:20-alpine AS apk-deps
RUN --mount=type=cache,target=/var/cache/apk \
    apk update && apk add --no-cache \
    build-base python3 py3-pip pkgconfig \
    cairo-dev pixman-dev jpeg-dev pango-dev giflib-dev libpng-dev && \
    ln -sf python3 /usr/bin/python

##################################################################################

# Stage 2: Install npm dependencies
FROM apk-deps AS npm-deps
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

# Stage 4: Runtime (minimal: only runtime libs for canvas, no build tools)
FROM node:20-alpine AS apk-runtime-deps
RUN apk add --no-cache cairo jpeg pango giflib

##################################################################################

# Stage 5: Runtime
FROM apk-runtime-deps AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=npm-deps /app/node_modules ./node_modules
RUN npm prune --production
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
