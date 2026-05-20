# Reunion Bot

Multi-platform chatbot (Telegram + Zalo) to help a graduating class organize their 10-year reunion.

## Stack

- **Runtime**: Node.js 20, TypeScript 5.4+, pnpm 9+
- **Reasoning**: LangGraph JS with StateGraph + ToolNode + PostgresSaver
- **LLM**: Gemini 2.5 Flash via `@langchain/google-genai`
- **Database**: PostgreSQL 16 + pgvector
- **Queue**: Redis 7 + BullMQ
- **Platforms**: Telegram (grammY) + Zalo (zca-js)

## Quick Start

```bash
# 1. Install dependencies
pnpm install

# 2. Copy env and configure
cp .env.example .env
# Edit .env with your GEMINI_API_KEY, TELEGRAM_BOT_TOKEN, etc.

# 3. Start infra (Postgres + Redis)
docker compose -f docker-compose.dev.yml up -d

# 4. Run migrations
pnpm --filter @reunion/db run db:migrate

# 5. Start bot-core (dev mode)
pnpm --filter @reunion/bot-core dev

# 6. Start Telegram adapter (in another terminal)
pnpm --filter @reunion/adapter-telegram dev
```

## Project Structure

```
reunion-bot/
├── apps/
│   ├── adapter-telegram/   # Telegram long-polling adapter
│   ├── adapter-zalo/       # Zalo adapter (M6)
│   ├── bot-core/           # LangGraph orchestration + tools
│   └── scheduler/          # Cron jobs (M2+)
├── packages/
│   ├── shared/             # Types, config, logger, queue
│   └── db/                 # Drizzle schema + migrations
└── infra/                  # Docker, Postgres init
```

## Milestones

- **M0**: Project bootstrap ✅
- **M1**: Telegram foundation
- **M2**: LangGraph + Memory
- **M3**: Event planning
- **M4**: Tasks
- **M5**: Finance
- **M6**: Zalo adapter
- **M7**: Hardening
