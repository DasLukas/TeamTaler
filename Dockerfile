# syntax=docker/dockerfile:1.7

FROM node:24-alpine AS web-builder
ARG VERSION=dev
ARG REVISION=unknown
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN VITE_BUILD_ID="${VERSION}@${REVISION}" npm run build

FROM golang:1.27-alpine AS go-builder
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd/ ./cmd/
COPY internal/ ./internal/
COPY migrations/ ./migrations/
ARG VERSION=dev
ARG REVISION=unknown
RUN CGO_ENABLED=0 go build \
    -trimpath \
    -ldflags "-s -w -X main.version=${VERSION} -X main.commit=${REVISION}" \
    -o /out/teamtaler ./cmd/teamtaler

FROM alpine:3.24 AS runtime
RUN apk add --no-cache ca-certificates tzdata \
    && addgroup -S -g 10001 teamtaler \
    && adduser -S -D -H -u 10001 -G teamtaler teamtaler \
    && mkdir -p /app/web /var/lib/teamtaler /usr/share/licenses/teamtaler \
    && chown -R teamtaler:teamtaler /var/lib/teamtaler
ARG VERSION=dev
ARG REVISION=unknown
LABEL org.opencontainers.image.title="TeamTaler" \
      org.opencontainers.image.description="Lightweight self-hosted group expense management" \
      org.opencontainers.image.version="${VERSION}" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.source="https://github.com/DasLukas/TeamTaler" \
      org.opencontainers.image.licenses="AGPL-3.0-only"
COPY --from=go-builder /out/teamtaler /usr/local/bin/teamtaler
COPY --from=web-builder /src/web/dist/ /app/web/
COPY LICENSE /usr/share/licenses/teamtaler/LICENSE

ENV TEAMTALER_LISTEN=0.0.0.0:8080 \
    TEAMTALER_DATA_DIR=/var/lib/teamtaler \
    TEAMTALER_DATABASE_PATH=/var/lib/teamtaler/teamtaler.db \
    TEAMTALER_WEB_DIR=/app/web

USER 10001:10001
WORKDIR /app
VOLUME ["/var/lib/teamtaler"]
EXPOSE 8080
ENTRYPOINT ["/usr/local/bin/teamtaler"]
CMD ["serve"]
