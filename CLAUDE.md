# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Infrastructure (always required first)
docker compose -f docker-compose.dev.yml up -d      # start postgres + redis
docker compose -f docker-compose.dev.yml down -v    # reset everything (wipe volumes)

# Migrations — must pass DATABASE_URL explicitly (pnpm does not load .env)
DATABASE_URL=postgres://reunion:reunion@localhost:5432/reunion pnpm --filter @reunion/db run db:migrate
pnpm --filter @reunion/db run db:generate           # generate migration after schema change
pnpm --filter @reunion/db run db:studio             # drizzle studio UI

# Dev (source .env first, or prefix each command with env vars)
set -a && source .env && set +a
pnpm --filter @reunion/bot-core dev                 # terminal 1
pnpm --filter @reunion/adapter-telegram dev         # terminal 2

# Build / check
pnpm build                                          # all packages
pnpm typecheck                                      # all packages
pnpm lint                                           # eslint monorepo-wide
pnpm format                                         # prettier write

# Single package
pnpm --filter @reunion/bot-core typecheck
pnpm --filter @reunion/shared build
```

> **Important**: `pnpm ... dev` does **not** auto-load `.env`. Either `source .env` in the shell first, or prefix commands with the required env vars. The Zod schema in `packages/shared/src/config/env.ts` throws at startup if `DATABASE_URL` or `REDIS_URL` is missing.

## Architecture

### Message Flow

```
Telegram group message
  → adapter-telegram (grammY long-polling)
      normalizes → NormalizedMessage
      enqueues → BullMQ [inbound-messages]  (jobId = "tg:{msg_id}:{chat_id}")
  → bot-core Worker (concurrency 3, 30 req/min)
      preprocess.ts:
        1. upsert chat_groups
        2. upsert user_identities
        3. auto-create canonical user if not linked
        4. insert messages (onConflictDoNothing — idempotency guard)
        5. if duplicate → early return (silent)
        6. if slash command → handleCommand() → outbound queue
        7. else classify() → tier
           - store_only: return (no reply)
           - flash / flash_lite: orchestrate() via LangGraph (M2+)
           - M1: placeholder reply for any bot-mention
  → BullMQ [outbound-messages]
  → adapter-telegram outbound Worker
      platform filter: skip if message.platform !== 'telegram'
      sends via bot.api.sendMessage()
```

### Package Responsibilities

| Package | Role |
|---------|------|
| `@reunion/shared` | Types (`NormalizedMessage`, `OutboundMessage`), env validation, Pino logger, BullMQ queue factories, time utils |
| `@reunion/db` | Drizzle schema, migrations, `db` client singleton, repositories |
| `@reunion/bot-core` | Inbound Worker, preprocess pipeline, slash commands, LangGraph orchestration (M2+) |
| `@reunion/adapter-telegram` | grammY bot, inbound normalizer, outbound worker, healthcheck :3001 |
| `@reunion/adapter-zalo` | Zalo stub — exits unless `ZALO_ENABLED=true` (M6) |
| `@reunion/scheduler` | Cron stub for background jobs (M2+) |

### BullMQ Queues

All queued with prefix from `REDIS_PREFIX` (default `reunion:`):

| Queue constant | Queue name | Producer | Consumer |
|----------------|------------|----------|----------|
| `QUEUE_INBOUND` | `inbound-messages` | adapters | bot-core |
| `QUEUE_OUTBOUND` | `outbound-messages` | bot-core | adapters (per-platform filter) |
| `QUEUE_JOBS` | `background-jobs` | bot-core / scheduler | scheduler (M2+) |

Inbound jobs use `jobId: "tg:{message_id}:{chat_id}"` for BullMQ-level deduplication (second layer; DB `onConflictDoNothing` is the primary guard).

### LangGraph Pipeline (bot-core)

`graph.ts` builds a `StateGraph` with two nodes — **agent** (Gemini call + tool binding) and **tools** (ToolNode). The loop is: `agent → shouldContinue → tools → agent`, capped at 6 steps. Checkpointing uses `PostgresSaver` (thread_id = `chat:{chatGroupId}:{msgId}`). The pipeline is only invoked for `flash` / `flash_lite` tiers (M2+); M1 sends a hardcoded placeholder instead.

### Classify Tiers

`classify.ts` determines how a message is handled:
- `store_only` — no bot mention → silent persist
- `flash_lite` — bot mentioned + simple Vietnamese query pattern → Gemini Lite
- `flash` — bot mentioned + complex / default → Gemini primary

### DB Patterns

- **Primary event**: always the latest by `created_at` (`getPrimaryEvent()`). Bootstrapped from `PRIMARY_EVENT_NAME` + `PRIMARY_EVENT_DATE` env vars on bot-core startup.
- **Identity model**: `user_identities` (per-platform) → `users` (canonical). Auto-link on first message; phone verification merges cross-platform identities automatically; `/link` + `/redeem` is the fallback.
- **Phone = canonical identity**: `users.phone` is UNIQUE. One user = one phone number. `phoneVerifiedAt` on both `users` and `user_identities` tracks verification status.
- **Verification flow**: DM-only. User sends `/start` to bot in private chat → bot sends requestContact keyboard → user taps → `handlePhoneContact()` in preprocess pipeline. Never in group chat.
- **Permission guards**: `requireRole(userId, required)` checks role level; `requireVerified(userId)` checks `phoneVerifiedAt IS NOT NULL`. Sensitive slash commands call `checkVerified()` before executing.
- **Amount fields**: stored as `bigint` (integer VND, no decimals).
- **Embeddings**: `vector(768)` columns on `messages` and `user_facts`; `embeddingStatus` enum tracks backfill state. Populated by `embed-batch` background job (M2+).
- **New repositories**: add to `packages/db/src/repositories/`, export from there (not from schema).

### Outbound Platform Filter

Every platform adapter's outbound worker **must** filter by platform before sending:
```ts
if (job.data.message.platform !== 'telegram') return;
```
This is what prevents a Telegram worker from consuming Zalo outbound jobs when M6 lands. Do not remove this check.

## Milestone Status

| Milestone | Status | What's live |
|-----------|--------|-------------|
| M0 | ✅ Done | Schema, migrations, adapters scaffold, queue wiring |
| M1 | ✅ Done | Telegram polling, auto-register, slash commands, idempotency |
| M2 | ✅ Done | LangGraph orchestration, memory tools, embed-batch worker |
| M3 | ✅ Done | Event tools (create, decision, status, set_status), RSVP tools (set_rsvp, list_rsvp) |
| M4 | ✅ Done | Task tools (create_task, assign_task, update_task_status, list_tasks); /mytasks + /tasks commands wired |
| M5 | ✅ Done | Finance tools (campaign, record, verify+audit, status, expense, summary); summarize_conversation; /mydues wired |
| M6 | 🔲 Next | Zalo adapter (zca-js session, normalizer, outbound worker) |
| M7 | 🔲 Planned | Hardening (admin DM commands, scheduler jobs, backup cron) |

Stubs to be aware of: `adapter-zalo/src/index.ts` exits unless `ZALO_ENABLED=true`; `scheduler/src/index.ts` is a no-op.

## Key Env Vars

CSV fields (split on `,`): `TELEGRAM_ALLOWED_CHAT_IDS`, `ORGANIZER_TELEGRAM_IDS`, `ORGANIZER_ZALO_IDS`, `TREASURER_USER_IDS`, `ZALO_ALLOWED_GROUP_IDS`.

Telegram group chat IDs are **negative** integers (e.g. `-1001234567890`). A positive value in `TELEGRAM_ALLOWED_CHAT_IDS` will silently filter all group messages.

`GEMINI_DAILY_REQUEST_BUDGET` / `GEMINI_LITE_DAILY_BUDGET` are enforced via Redis counters (key pattern `reunion:quota:*:YYYY-MM-DD`). Hitting the budget throws `QuotaExceededError`, caught in `orchestrate()`.
