# Agent Readiness Scorer

Score how ready a product/service is for AI agent commerce.

## Run

```bash
bun install
bun run server.ts
```

Open http://localhost:3000

## Scoring

4 categories (0-10 each, total /40): Discovery, Purchase, Integration, Trust.

Grades: A (35-40), B (28-34), C (20-27), D (10-19), F (0-9).

The scorer crawls the target site's key pages and looks for signals like API docs, OpenAPI specs, pricing transparency, CAPTCHA presence, MCP/A2A support, crypto payments, sandbox environments, SLAs, and ToS.
