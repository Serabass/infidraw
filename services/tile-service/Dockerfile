# Stage 1: Build
FROM node:20-alpine AS builder

# Устанавливаем зависимости для сборки canvas и компиляции TypeScript
RUN apk add --no-cache \
    python3 \
    py3-pip \
    make \
    g++ \
    pkgconfig \
    cairo-dev \
    jpeg-dev \
    pango-dev \
    giflib-dev \
    pixman-dev \
    libpng-dev \
    && ln -sf python3 /usr/bin/python

WORKDIR /app

# Копируем package файлы (для лучшего кэширования слоёв)
COPY package*.json ./
# Устанавливаем все зависимости (включая devDependencies для TypeScript)
RUN npm ci

# Копируем исходный код и конфигурацию
COPY tsconfig.json ./
COPY src ./src

# Компилируем TypeScript
RUN npm run build

# Stage 2: Runtime
FROM node:20-alpine AS runtime

# Устанавливаем только runtime зависимости для canvas (без dev-зависимостей)
RUN apk add --no-cache cairo jpeg pango giflib

WORKDIR /app

# Копируем package файлы
COPY package*.json ./

# Копируем собранные node_modules из builder stage (canvas уже собран)
COPY --from=builder /app/node_modules ./node_modules

# Удаляем dev-зависимости для уменьшения размера образа
RUN npm prune --production

# Копируем скомпилированный код из builder stage
COPY --from=builder /app/dist ./dist

# Для dev режима можно использовать volume mount и переопределить CMD в docker-compose
# Для production используем собранный код
CMD ["npm", "start"]
