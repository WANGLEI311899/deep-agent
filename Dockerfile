# deepCodex — 可部署到 Railway / Render / 任意 Docker 主机
# 构建：docker build -t deep-codex .
# 运行：见 README「在线部署」

FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json* pnpm-lock.yaml* ./
RUN npm ci

COPY tsconfig.json tsup.config.ts ./
COPY src ./src
COPY web ./web
COPY .deepcodex/skills ./.deepcodex/skills
COPY tests ./tests

RUN npm run build

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=5173
ENV PUBLIC_MODE=true

COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY web ./web
COPY .deepcodex/skills ./.deepcodex/skills

RUN mkdir -p /app/output /app/.deepcodex \
  && addgroup -S app && adduser -S app -G app \
  && chown -R app:app /app

USER app

EXPOSE 5173

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||5173)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server.mjs"]
