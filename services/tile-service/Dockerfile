# Stage 1: Build
FROM node:20-alpine AS builder

# Устанавливаем зависимости для сборки canvas и компиляции TypeScript
RUN apk add --no-cache python3 make g++ cairo-dev jpeg-dev pango-dev giflib-dev

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

# Устанавливаем только production зависимости
RUN npm ci --only=production && npm cache clean --force

# Копируем скомпилированный код из builder stage
COPY --from=builder /app/dist ./dist

# Для dev режима можно использовать volume mount и переопределить CMD в docker-compose
# Для production используем собранный код
CMD ["npm", "start"]
