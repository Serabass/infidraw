# deps (BuildKit cache mount: npm cache across builds)
FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm ci --loglevel=error

##################################################################################

# build
FROM deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

##################################################################################

# runtime
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package*.json ./
COPY --from=deps /app/node_modules ./node_modules
RUN npm prune --production
COPY --from=builder /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
