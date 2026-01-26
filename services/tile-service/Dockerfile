# Stage 1: APK update
FROM node:20-alpine AS apk-update
RUN echo "=== Updating package index ===" && \
    apk update

# Stage 2: Install system dependencies
FROM apk-update AS apk-deps
RUN echo "=== Installing g++ (this may take a while) ===" && \
    apk add --no-cache g++ && \
    echo "=== Installing Python and build tools ===" && \
    apk add --no-cache python3 py3-pip make && \
    echo "=== Installing pkgconfig ===" && \
    apk add --no-cache pkgconfig && \
    echo "=== Installing Cairo dependencies ===" && \
    apk add --no-cache cairo-dev pixman-dev && \
    echo "=== Installing image libraries ===" && \
    apk add --no-cache jpeg-dev pango-dev giflib-dev libpng-dev && \
    echo "=== Creating python symlink ===" && \
    ln -sf python3 /usr/bin/python && \
    echo "=== Build dependencies installed successfully ==="

# Stage 3: Install npm dependencies
FROM apk-deps AS npm-deps
WORKDIR /app
COPY package*.json ./
RUN echo "=== Installing npm dependencies ===" && \
    npm ci && \
    echo "=== npm dependencies installed successfully ==="

# Stage 4: Build TypeScript
FROM npm-deps AS builder
COPY tsconfig.json ./
COPY src ./src
RUN echo "=== Building TypeScript ===" && \
    npm run build && \
    echo "=== Build completed successfully ==="

# Stage 5: Runtime
FROM node:20-alpine AS runtime

# Устанавливаем только runtime зависимости для canvas (без dev-зависимостей)
RUN echo "=== Updating package index ===" && \
    apk update && \
    echo "=== Installing runtime dependencies ===" && \
    apk add --no-cache cairo jpeg pango giflib && \
    echo "=== Runtime dependencies installed successfully ==="

WORKDIR /app

# Копируем package файлы
COPY package*.json ./

# Копируем собранные node_modules из npm-deps stage (canvas уже собран)
COPY --from=npm-deps /app/node_modules ./node_modules

# Удаляем dev-зависимости для уменьшения размера образа
RUN npm prune --production

# Копируем скомпилированный код из builder stage
COPY --from=builder /app/dist ./dist

# Для dev режима можно использовать volume mount и переопределить CMD в docker-compose
# Для production используем собранный код
CMD ["npm", "start"]
