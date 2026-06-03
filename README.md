# Reunion Bot

A Telegram + Zalo bot for organizing class reunions: event management, RSVP, tasks, finance, and natural AI conversation.

**Stack:** Node.js 20 · TypeScript · pnpm workspaces · LangGraph JS · Gemini 2.5 Flash · PostgreSQL 16 + pgvector · Redis + BullMQ · grammY · zca-js

---

## Requirements

- **Node.js** ≥ 20 and **pnpm** ≥ 9
- **Docker Desktop** (to run Postgres + Redis locally)
- Google AI Studio API key (`GEMINI_API_KEY`)
- Telegram Bot Token from @BotFather

---

## First-time setup

```bash
# 1. Install dependencies
pnpm install

# 2. Create .env and fill in values
cp .env.example .env
# Required: TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, TELEGRAM_ALLOWED_CHAT_IDS

# 3. Start Postgres + Redis
docker compose -f docker-compose.dev.yml up -d
```

---

## Running in development

```bash
# Load environment variables into the shell (once per terminal session)
set -a && source .env && set +a

# Terminal 1 — bot core (processing pipeline, AI, slash commands)
# Runs DB migrations automatically on startup
pnpm --filter @reunion/bot-core dev

# Terminal 2 — Telegram adapter (receives messages, sends replies)
pnpm --filter @reunion/adapter-telegram dev
```

The bot is ready after ~3–5 seconds once DB, Redis, and the LangGraph checkpointer have initialized.

---

## Common commands

```bash
# Typecheck all packages / a single package
pnpm typecheck
pnpm --filter @reunion/bot-core typecheck
pnpm --filter @reunion/db typecheck

# Lint / format
pnpm lint
pnpm format

# Build all packages
pnpm build

# Browse and edit data via Drizzle Studio (web UI)
pnpm --filter @reunion/db run db:studio

# After changing the schema — generate a new migration file
pnpm --filter @reunion/db run db:generate

# Full reset (wipes all data)
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d
```

---

## Configuration (.env)

| Variable | Required | Notes |
|----------|----------|-------|
| `DATABASE_URL` | ✅ | `postgres://reunion:reunion@localhost:5432/reunion` |
| `REDIS_URL` | ✅ | `redis://localhost:6379` |
| `TELEGRAM_BOT_TOKEN` | ✅ | Token from @BotFather |
| `GEMINI_API_KEY` | ✅ | Google AI Studio |
| `TELEGRAM_ALLOWED_CHAT_IDS` | ✅ | Comma-separated Telegram group IDs. **Group IDs are negative integers** (e.g. `-1001234567890`). A positive value silently drops all group messages. |
| `TELEGRAM_BOT_USERNAME` | | Bot username without @, used to detect mentions |
| `ORGANIZER_TELEGRAM_IDS` | | Telegram user IDs of organizers (comma-separated) |
| `TREASURER_USER_IDS` | | DB user UUIDs with treasurer permissions (comma-separated) |
| `PRIMARY_EVENT_NAME` | | Event name (default: `Họp lớp 10 năm 2/9`) |
| `PRIMARY_EVENT_DATE` | | ISO 8601 datetime (default: `2025-09-02T11:00:00+07:00`) |
| `GEMINI_DAILY_REQUEST_BUDGET` | | Max requests/day for primary model (default: 200) |
| `GEMINI_LITE_DAILY_BUDGET` | | Max requests/day for lite model (default: 800) |
| `LANGFUSE_PUBLIC_KEY` | | Enable Langfuse tracing (get from cloud.langfuse.com) |
| `LANGFUSE_SECRET_KEY` | | Required alongside `LANGFUSE_PUBLIC_KEY` |
| `LANGFUSE_HOST` | | Default `https://cloud.langfuse.com`, change for self-hosted |
| `ZALO_ENABLED` | | Set `true` to enable the Zalo adapter (M6) |

---

## Architecture

### Message flow

```
Telegram group message
  → adapter-telegram  (grammY long-polling)
      normalize → NormalizedMessage
      enqueue  → BullMQ [inbound-messages]  (jobId = "tg:{msg_id}:{chat_id}")

  → bot-core Worker  (concurrency 3, 30 req/min)
      preprocess.ts:
        1. Upsert chat_groups
        2. Upsert user_identities + auto-create canonical user if missing
        3. Insert messages  (onConflictDoNothing — idempotency guard)
        4. Duplicate? → early return (silent)
        5. Slash command? → handleCommand() → outbound queue
        6. classify() → tier:
             store_only  — no bot mention → persist, no reply
             flash_lite  — mention + simple pattern → Gemini Lite
             flash       — mention + complex/default → Gemini primary

  → BullMQ [outbound-messages]

  → adapter-telegram outbound Worker
      filter: platform !== 'telegram'? skip
      send via bot.api.sendMessage()
```

### Packages

| Package | Role |
|---------|------|
| `@reunion/shared` | Types, env validation (Zod, throws on missing vars), Pino logger, BullMQ queue factories, date utils |
| `@reunion/db` | Drizzle schema, migration runner, `db` singleton, repositories |
| `@reunion/bot-core` | Inbound Worker, preprocess pipeline, slash commands, LangGraph orchestration |
| `@reunion/adapter-telegram` | grammY bot, normalizer, outbound worker, healthcheck :3001 |
| `@reunion/adapter-zalo` | Zalo stub — exits immediately unless `ZALO_ENABLED=true` |
| `@reunion/scheduler` | Cron job stub |

### LangGraph pipeline

```
START → agent (Gemini + bindTools) → shouldContinue
                                         ├─ tool_calls → ToolNode → agent  (max 6 steps)
                                         └─ END → enqueue reply
```

- **State**: `MessagesAnnotation` + custom fields (`ctxUserId`, `ctxChatGroupId`, etc.)
- **Checkpointing**: `PostgresSaver` (thread_id = `chat:{chatGroupId}:{msgId}`)
- **Quota**: Redis counter `reunion:quota:*:YYYY-MM-DD`. Quota exceeded → graceful reply, no crash
- **Context passed to tools**: `config.configurable.ctxUserId`, `ctxChatGroupId`, etc. — tools read via `extractContext(config!)`

### Slash commands

| Command | Description |
|---------|-------------|
| `/help`, `/start` | Usage instructions |
| `/event` | Primary event status + RSVP count |
| `/rsvp yes\|no\|maybe` | Register or update attendance |
| `/who` | RSVP list grouped by response |
| `/mytasks` | Tasks assigned to you (active only) |
| `/tasks` | All non-cancelled tasks |
| `/mydues` | Your contribution history |
| `/link` | Generate a 6-character code to link Zalo ↔ Telegram |
| `/redeem <CODE>` | Enter a link code to merge two platform identities into one user |

### Tool registry (20 tools)

| Group | Tools | Minimum permission |
|-------|-------|--------------------|
| Memory | `remember_user_fact`, `recall_user_facts`, `search_facts` | member |
| Event | `create_event`, `update_event_decision`, `list_event_status`, `set_event_status` | organizer / member |
| RSVP | `set_rsvp`, `list_rsvp` | member |
| Task | `create_task`, `assign_task`, `update_task_status`, `list_tasks` | member |
| Finance | `create_contribution_campaign`, `record_contribution`, `verify_contribution`, `list_contribution_status`, `record_expense`, `financial_summary` | treasurer / organizer / member |
| Meta | `summarize_conversation` | member |

---

## Database schema

```
users                   — canonical user (nickname, role, embedding)
user_identities         — 1 user : N identities (telegram / zalo)
chat_groups             — chat group per platform
messages                — chat history, 768d vector (text-embedding-004)
events                  — events (name, date, location, status)
event_decisions         — event decision log
rsvps                   — (event_id, user_id) → yes/no/maybe + plus_ones
tasks                   — tasks (title, assignee, priority, due_date, status)
contribution_campaigns  — fundraising rounds (open/closed)
contributions           — contributions: pending → verified / rejected
expenses                — event expenses (organizer self-approve)
audit_log               — immutable log of all financial operations (before/after JSONB)
user_facts              — facts about users stored by the bot (768d vector)
```

**Notes:**
- Amounts are stored as `bigint` integer VND, no decimals.
- Primary event = the most recent event by `created_at`. Bootstrapped from `PRIMARY_EVENT_NAME/DATE` on bot-core startup.
- Outbound workers **must** include `if (message.platform !== 'telegram') return` to avoid consuming jobs for other platforms.
- `onConflictDoNothing` on the messages table is the DB-level deduplication layer; BullMQ jobId is the second layer.

---

## Production deployment

```bash
# Update .env with a strong POSTGRES_PASSWORD and production values

# Start the main stack (Postgres, Redis, bot-core, adapter-telegram, scheduler)
docker compose up -d

# Include the Zalo adapter (M6)
docker compose --profile full up -d

# View logs
docker compose logs -f bot-core
docker compose logs -f adapter-telegram
```

---

## Milestones

| Milestone | Status | Scope |
|-----------|--------|-------|
| M0 | ✅ Done | Schema, migrations, adapters scaffold, queue wiring |
| M1 | ✅ Done | Telegram polling, auto-register, slash commands, idempotency |
| M2 | ✅ Done | LangGraph orchestration, memory tools, embed-batch worker |
| M3 | ✅ Done | Event tools (create, decision, status), RSVP tools |
| M4 | ✅ Done | Task tools, /mytasks + /tasks with real data |
| M5 | ✅ Done | Finance tools + audit log, summarize_conversation, /mydues |
| M6 | 🔲 Next | Zalo adapter (zca-js session, normalizer, outbound worker) |
| M7 | 🔲 Planned | Hardening (admin DM commands, scheduler jobs, backup cron) |
