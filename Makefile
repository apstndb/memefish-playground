SHELL := /bin/sh

GO ?= go
GOLANGCI_LINT ?= golangci-lint
GOVULNCHECK ?= go run golang.org/x/vuln/cmd/govulncheck@v1.6.0
VITE_BASE ?= /

export GOTOOLCHAIN := local

.PHONY: build build-wasm check dev e2e fmt format-check lint test vet vuln

dev: build-wasm
	npm run dev:ui

fmt:
	@gofmt -w $$(find cmd internal -type f -name '*.go')
	npm run format

format-check:
	@files="$$(gofmt -l $$(find cmd internal -type f -name '*.go'))"; \
		if [ -n "$$files" ]; then \
			echo "Go files need formatting:"; \
			echo "$$files"; \
			exit 1; \
		fi
	npm run format:check

lint:
	$(GOLANGCI_LINT) run ./...
	npm run lint

test:
	$(GO) test -race -shuffle=on -coverprofile=/tmp/memefish-playground-coverage.out ./...
	npm run test:unit

vet:
	$(GO) vet ./...
	GOOS=js GOARCH=wasm CGO_ENABLED=0 $(GO) vet ./cmd/wasm

vuln:
	$(GO) mod verify
	$(GOVULNCHECK) ./...

build-wasm:
	npm run build:wasm

build: build-wasm
	npm run build:ui -- --base="$(VITE_BASE)"

e2e:
	npm run test:e2e

check: format-check lint test vet vuln build
