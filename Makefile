.PHONY: setup up down reset health logs pull diagram

setup:
	@echo "Setting up AI Migration Assistant..."
	@if [ ! -f "agent-skills/skills/clickhouse-best-practices/AGENTS.md" ]; then \
		echo "Cloning agent-skills from GitHub..."; \
		rm -rf agent-skills && git clone https://github.com/ClickHouse/agent-skills.git agent-skills; \
	fi
	@bash scripts/build-instructions.sh
	@if [ ! -f .env ]; then cp .env.example .env && echo "✅ .env created — add your LLM API key and ClickHouse Cloud credentials"; fi
	@echo "✅ Setup complete. Run: make up"

up:
	@echo "Pulling images..."
	docker compose pull
	@echo "Building custom containers..."
	docker compose build
	@echo "Starting services..."
	docker compose up -d
	@echo ""
	@echo "Container status:"
	@docker compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}"
	@echo ""
	@echo "Open http://localhost:3080 when LibreChat shows '(healthy)'."
	@echo "First run: allow 5–10 min for Postgres to seed (~10M rows)."
	@echo "Watch seed: docker compose logs postgres -f"

down:
	docker compose down

reset:
	@bash scripts/reset.sh

health:
	@bash scripts/healthcheck.sh

logs:
	docker compose logs -f --tail=50

pull:
	docker compose pull

diagram:
	@bash scripts/generate-diagram.sh
