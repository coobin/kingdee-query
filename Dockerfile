FROM node:20-alpine

WORKDIR /app
RUN apk add --no-cache tzdata

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY src ./src
COPY public ./public
COPY views ./views
COPY config ./config

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production TZ=Asia/Shanghai
EXPOSE 8092

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8092/healthz >/dev/null || exit 1

CMD ["node", "server.js"]
