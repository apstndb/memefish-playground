SHELL := /bin/sh

GO ?= go
GOLANGCI_LINT ?= golangci-lint
VITE_BASE ?= /
TMPDIR ?= /tmp
GOCACHE ?= $(TMPDIR)/memefish-playground-go-build
GOLANGCI_LINT_CACHE ?= $(TMPDIR)/memefish-playground-golangci-lint

export GOTOOLCHAIN := local
export GOCACHE
export GOLANGCI_LINT_CACHE

.PHONY: build build-wasm check dev e2e fmt format-check lint module-verify test typecheck verify vet

dev:
	npm run build:wasm
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
	$(GO) test -race -shuffle=on -coverprofile=$(TMPDIR)/memefish-playground-coverage.out ./...
	$(GO) test -tags=memefish_pre_v0_8 -run='^TestHandlerRejectsUnsupportedSchemaType$$' ./internal/bridge
	npm run test:unit

typecheck:
	npm run typecheck

vet:
	$(GO) vet ./...
	GOOS=js GOARCH=wasm CGO_ENABLED=0 $(GO) vet ./cmd/wasm

module-verify:
	$(GO) mod verify

build-wasm:
	npm run build:wasm:verified

build: build-wasm
	npm run build:ui -- --base="$(VITE_BASE)"

e2e:
	npm run test:e2e

verify: format-check lint typecheck test vet module-verify

check: verify build
