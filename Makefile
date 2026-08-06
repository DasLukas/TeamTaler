.PHONY: install dev-backend dev-frontend test-server format-check lint test build verify

install:
	go mod download
	cd web && npm ci

dev-backend:
	go run ./cmd/teamtaler serve

dev-frontend:
	cd web && npm run dev

test-server:
	./scripts/test-server.sh

format-check:
	test -z "$$(gofmt -l cmd internal migrations)"
	cd web && npm run lint

lint:
	go vet ./cmd/... ./internal/... ./migrations
	cd web && npm run lint

test:
	go test ./cmd/... ./internal/... ./migrations
	cd web && npm test

build:
	cd web && npm run build
	go build -trimpath -o bin/teamtaler ./cmd/teamtaler

verify: format-check lint test build
