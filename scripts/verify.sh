#!/bin/sh
set -eu

unformatted="$(gofmt -l cmd internal migrations)"
if [ -n "$unformatted" ]; then
  echo "Go files require formatting:"
  echo "$unformatted"
  exit 1
fi

go vet ./cmd/... ./internal/... ./migrations
go test -race -p 2 ./cmd/... ./internal/... ./migrations
(
  cd web
  npm run lint
  npm test
  npm run build
  npm audit --omit=dev --audit-level=high
)
go build -trimpath ./cmd/teamtaler
