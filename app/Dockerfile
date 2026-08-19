# app/Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
# better-sqlite3 / argon2 需要原生编译工具
RUN apk add --no-cache python3 make g++
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
# libc6-compat：部分 npm 包依赖 glibc 符号，alpine 默认只有 musl（冗余无害的兼容层）
RUN apk add --no-cache libc6-compat
# Next standalone 产物
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public
# 运行时数据目录（由 compose 挂载数据卷到 /data）
RUN mkdir -p /data/files
ENV DB_PATH=/data/lawer.db
ENV FILES_DIR=/data/files
# SIDECAR_URL / LAWER_DATA_KEY 等由 compose 注入，不烘进镜像
# Next standalone 的 server.js 直接拿 process.env.HOSTNAME 当监听地址，而 Docker 会把
# HOSTNAME 设成容器 ID → 只监听容器 eth0 IP，环回不监听，HEALTHCHECK 必然失败
# （实测 2026-08-19：容器内 wget 127.0.0.1:3000 → Connection refused）。必须显式覆盖为 0.0.0.0。
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s \
  CMD wget -qO- http://127.0.0.1:3000/api/health || exit 1
CMD ["node", "server.js"]
