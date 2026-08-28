.PHONY: dev build test docker-up docker-down docker-build docker-logs docker-clean

dev:
	@npm run dev

build:
	@npm run build

test:
	@npm test

# ── Docker Compose ───────────────────────────────────────────────────────────

docker-up:
	@docker compose up -d --build

docker-down:
	@docker compose down

docker-build:
	@docker compose build

docker-logs:
	@docker compose logs -f

docker-clean:
	@docker compose down -v
