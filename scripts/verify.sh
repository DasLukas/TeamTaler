#!/bin/sh
set -eu

unformatted="$(gofmt -l cmd internal migrations)"
if [ -n "$unformatted" ]; then
  echo "Go files require formatting:"
  echo "$unformatted"
  exit 1
fi

go vet ./cmd/... ./internal/... ./migrations
go test -race ./cmd/... ./internal/... ./migrations
(
  cd web
  npm run lint
  npm test
  npm run build
)
go build -trimpath ./cmd/teamtaler
