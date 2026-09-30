# 小剧场网页走词台 —— 单镜像：内置 node:sqlite，无需任何原生编译/外部服务
FROM node:22.14-bookworm-slim

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0 \
    CONTROL_TTL=30 \
    DB_PATH=/data/prompter.db

WORKDIR /app

# 仅一个纯 JS 依赖（ws），利用 Docker 层缓存
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund

COPY server.js ./
COPY public ./public

RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 8080

# node:sqlite 在 Node 22 为实验特性，需显式开启（已在 package.json 的 start 中开启，
# 这里直接给出 node 参数，确保镜像内一致）
CMD ["node", "--experimental-sqlite", "server.js"]
