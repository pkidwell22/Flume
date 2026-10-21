# syntax=docker/dockerfile:1.7
FROM node:26.8.1-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
COPY tools ./tools
COPY tsconfig.json tsconfig.base.json ./
RUN npm ci --ignore-scripts
RUN npm run build --workspace=@flume/domain \
 && npm run build --workspace=@flume/client \
 && npm run build --workspace=@flume/worker \
 && npm run build --workspace=@flume/web

FROM node:26.8.1-trixie-slim AS runtime-dependencies
WORKDIR /app
COPY package.json package-lock.json .npmrc ./
COPY apps ./apps
COPY packages ./packages
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

FROM node:26.8.1-trixie-slim AS runtime
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && groupadd --gid 10001 flume \
 && useradd --uid 10001 --gid 10001 --create-home --home-dir /home/flume --shell /usr/sbin/nologin flume
WORKDIR /app
COPY --from=runtime-dependencies /app/node_modules ./node_modules
COPY --from=build /app/package.json /app/package-lock.json /app/.npmrc ./
COPY --from=build /app/apps ./apps
COPY --from=build /app/packages ./packages
RUN mkdir -p /data/media /data/chat \
 && chown -R 10001:10001 /data/media /data/chat /home/flume \
 && find /data/media /data/chat -type d -exec chmod 0700 {} +
ENV NODE_ENV=production \
    FLUME_STORAGE_ROOT=/data/media \
    FLUME_STATIC_ROOT=/app/apps/web/dist \
    FLUME_FFMPEG_PATH=/usr/bin/ffmpeg \
    FLUME_FFPROBE_PATH=/usr/bin/ffprobe
USER 10001:10001
EXPOSE 8080
ENTRYPOINT ["node", "--import", "tsx", "apps/server/src/container-main.ts"]
