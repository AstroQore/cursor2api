# Build the single-file bundle, then ship it on a bare runtime. The image carries
# no node_modules: everything except the .proto files is bundled by esbuild.
FROM node:20-alpine AS build
WORKDIR /build
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY tsconfig.json ./
COPY src ./src
COPY proto ./proto
RUN npx esbuild src/index.ts --bundle --platform=node --target=node20 \
      --format=cjs --outfile=dist/index.cjs

FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache curl
COPY --from=build /build/dist/index.cjs ./dist/index.cjs
COPY proto ./proto
COPY scripts ./scripts

ENV CURSOR_DIRECT_HOST=0.0.0.0 \
    CURSOR_DIRECT_PORT=8790 \
    CURSOR_DIRECT_PROTO_DIR=/app/proto \
    CURSOR_DIRECT_AUTH_FILE=/data/accounts.json

VOLUME ["/data"]
EXPOSE 8790

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8790/health || exit 1

CMD ["node", "dist/index.cjs"]
