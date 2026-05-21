# Reunion Bot

Bot Telegram + Zalo hỗ trợ tổ chức họp lớp: quản lý sự kiện, RSVP, công việc, quỹ, và hội thoại AI tự nhiên bằng tiếng Việt.

**Stack:** Node.js 20 · TypeScript · pnpm workspaces · LangGraph JS · Gemini 2.5 Flash · PostgreSQL 16 + pgvector · Redis + BullMQ · grammY · zca-js

---

## Yêu cầu

- **Node.js** ≥ 20 và **pnpm** ≥ 9
- **Docker Desktop** (để chạy Postgres + Redis local)
- Google AI Studio API key (`GEMINI_API_KEY`)
- Telegram Bot Token từ @BotFather

---

## Cài đặt lần đầu

```bash
# 1. Cài dependencies
pnpm install

# 2. Tạo file .env và điền các giá trị
cp .env.example .env
# Bắt buộc: TELEGRAM_BOT_TOKEN, GEMINI_API_KEY, TELEGRAM_ALLOWED_CHAT_IDS

# 3. Khởi động Postgres + Redis
docker compose -f docker-compose.dev.yml up -d

# 4. Chạy migration (phải truyền DATABASE_URL vì pnpm không tự load .env)
DATABASE_URL=postgres://reunion:reunion@localhost:5432/reunion pnpm --filter @reunion/db run db:migrate
```

---

## Chạy development

```bash
# Load biến môi trường vào shell (làm 1 lần mỗi terminal session)
set -a && source .env && set +a

# Terminal 1 — bot core (pipeline xử lý, AI, slash commands)
pnpm --filter @reunion/bot-core dev

# Terminal 2 — adapter Telegram (nhận tin từ Telegram, gửi reply)
pnpm --filter @reunion/adapter-telegram dev
```

Bot hoạt động sau ~3-5 giây khi DB, Redis và LangGraph checkpointer khởi xong.

---

## Các lệnh hay dùng

```bash
# Typecheck toàn bộ / từng package
pnpm typecheck
pnpm --filter @reunion/bot-core typecheck
pnpm --filter @reunion/db typecheck

# Lint / format
pnpm lint
pnpm format

# Build toàn bộ
pnpm build

# Xem và chỉnh data qua Drizzle Studio (UI web)
pnpm --filter @reunion/db run db:studio

# Sau khi sửa schema — tạo file migration
pnpm --filter @reunion/db run db:generate

# Reset hoàn toàn (xóa hết data)
docker compose -f docker-compose.dev.yml down -v
docker compose -f docker-compose.dev.yml up -d
DATABASE_URL=postgres://reunion:reunion@localhost:5432/reunion pnpm --filter @reunion/db run db:migrate
```

---

## Cấu hình (.env)

| Biến | Bắt buộc | Ghi chú |
|------|----------|---------|
| `DATABASE_URL` | ✅ | `postgres://reunion:reunion@localhost:5432/reunion` |
| `REDIS_URL` | ✅ | `redis://localhost:6379` |
| `TELEGRAM_BOT_TOKEN` | ✅ | Token từ @BotFather |
| `GEMINI_API_KEY` | ✅ | Google AI Studio |
| `TELEGRAM_ALLOWED_CHAT_IDS` | ✅ | ID nhóm Telegram, phân cách bởi dấu phẩy. **Group ID là số âm** (ví dụ `-1001234567890`). Giá trị dương sẽ lọc hết tin nhóm. |
| `TELEGRAM_BOT_USERNAME` | | Username bot không có @, dùng để detect mention |
| `ORGANIZER_TELEGRAM_IDS` | | Telegram user IDs của ban tổ chức |
| `TREASURER_USER_IDS` | | UUID người dùng DB có quyền thủ quỹ |
| `PRIMARY_EVENT_NAME` | | Tên sự kiện (mặc định: `Họp lớp 10 năm 2/9`) |
| `PRIMARY_EVENT_DATE` | | Ngày giờ ISO 8601 (mặc định: `2025-09-02T11:00:00+07:00`) |
| `GEMINI_DAILY_REQUEST_BUDGET` | | Giới hạn request/ngày model chính (mặc định: 200) |
| `GEMINI_LITE_DAILY_BUDGET` | | Giới hạn request/ngày model lite (mặc định: 800) |
| `LANGSMITH_TRACING` | | `true` để bật LangSmith tracing |
| `ZALO_ENABLED` | | `true` để bật Zalo adapter (M6) |

---

## Kiến trúc tổng quan

### Luồng xử lý tin nhắn

```
Tin nhắn Telegram group
  → adapter-telegram  (grammY long-polling)
      normalize → NormalizedMessage
      enqueue  → BullMQ [inbound-messages]  (jobId = "tg:{msg_id}:{chat_id}")

  → bot-core Worker  (concurrency 3, 30 req/min)
      preprocess.ts:
        1. Upsert chat_groups
        2. Upsert user_identities + auto-tạo canonical user nếu chưa có
        3. Insert messages  (onConflictDoNothing — idempotency guard)
        4. Trùng lặp? → dừng sớm (silent)
        5. Slash command? → handleCommand() → outbound queue
        6. classify() → tier:
             store_only  — không mention bot → lưu, không reply
             flash_lite  — mention + pattern đơn giản → Gemini Lite
             flash       — mention + phức tạp/mặc định → Gemini primary

  → BullMQ [outbound-messages]

  → adapter-telegram outbound Worker
      filter: platform !== 'telegram'? bỏ qua
      gửi qua bot.api.sendMessage()
```

### Packages

| Package | Vai trò |
|---------|---------|
| `@reunion/shared` | Types, env validation (Zod, throw khi thiếu biến), Pino logger, BullMQ queue factories, date utils |
| `@reunion/db` | Drizzle schema, migration runner, `db` singleton, repositories |
| `@reunion/bot-core` | Inbound Worker, preprocess pipeline, slash commands, LangGraph orchestration |
| `@reunion/adapter-telegram` | grammY bot, normalizer, outbound worker, healthcheck :3001 |
| `@reunion/adapter-zalo` | Zalo stub — exit ngay trừ khi `ZALO_ENABLED=true` |
| `@reunion/scheduler` | Stub cron jobs |

### LangGraph pipeline

```
START → agent (Gemini + bindTools) → shouldContinue
                                         ├─ tool_calls → ToolNode → agent  (tối đa 6 bước)
                                         └─ END → enqueue reply
```

- **State**: `MessagesAnnotation` + custom fields (`ctxUserId`, `ctxChatGroupId`, v.v.)
- **Checkpointing**: `PostgresSaver` (thread_id = `chat:{chatGroupId}:{msgId}`)
- **Quota**: Redis counter `reunion:quota:*:YYYY-MM-DD`. Hết quota → graceful reply, không crash
- **Context truyền vào tools**: `config.configurable.ctxUserId`, `ctxChatGroupId`, v.v. — tools đọc qua `extractContext(config!)`

### Slash commands

| Command | Mô tả |
|---------|-------|
| `/help`, `/start` | Hướng dẫn sử dụng |
| `/event` | Trạng thái sự kiện chính + số người RSVP |
| `/rsvp yes\|no\|maybe` | Đăng ký / cập nhật tham dự |
| `/who` | Danh sách RSVP theo nhóm |
| `/mytasks` | Task được giao cho bạn (đang active) |
| `/tasks` | Toàn bộ task chưa cancelled |
| `/mydues` | Lịch sử đóng quỹ của bạn |
| `/link` | Tạo mã 6 ký tự để liên kết Zalo ↔ Telegram |
| `/redeem <CODE>` | Nhập mã, merge identity 2 platform vào 1 user |

### Tool registry (20 tools)

| Nhóm | Tools | Quyền tối thiểu |
|------|-------|-----------------|
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
chat_groups             — nhóm chat per platform
messages                — lịch sử chat, vector 768d (text-embedding-004)
events                  — sự kiện (name, date, location, status)
event_decisions         — log quyết định về sự kiện
rsvps                   — (event_id, user_id) → yes/no/maybe + plus_ones
tasks                   — công việc (title, assignee, priority, due_date, status)
contribution_campaigns  — đợt thu quỹ (open/closed)
contributions           — đóng góp: pending → verified / rejected
expenses                — chi tiêu sự kiện (organizer self-approve)
audit_log               — immutable log mọi thao tác tài chính (before/after JSONB)
user_facts              — facts về user được bot ghi nhớ (vector 768d)
```

**Lưu ý:**
- Số tiền lưu `bigint` số nguyên VND, không có decimal.
- Primary event = event mới nhất theo `created_at`. Bootstrap từ `PRIMARY_EVENT_NAME/DATE` khi bot-core khởi động.
- Outbound worker **phải** có `if (message.platform !== 'telegram') return` — tránh consume nhầm job platform khác.
- `onConflictDoNothing` trên bảng messages là lớp deduplication ở DB; BullMQ jobId là lớp thứ hai.

---

## Triển khai production

```bash
# Chỉnh .env với POSTGRES_PASSWORD mạnh và các biến production

# Khởi động stack chính (Postgres, Redis, bot-core, adapter-telegram, scheduler)
docker compose up -d

# Bao gồm Zalo adapter (M6)
docker compose --profile full up -d

# Xem logs
docker compose logs -f bot-core
docker compose logs -f adapter-telegram
```

---

## Milestone

| Milestone | Trạng thái | Nội dung |
|-----------|-----------|----------|
| M0 | ✅ Done | Schema, migrations, adapters scaffold, queue wiring |
| M1 | ✅ Done | Telegram polling, auto-register, slash commands, idempotency |
| M2 | ✅ Done | LangGraph orchestration, memory tools, embed-batch worker |
| M3 | ✅ Done | Event tools (create, decision, status), RSVP tools |
| M4 | ✅ Done | Task tools, /mytasks + /tasks với real data |
| M5 | ✅ Done | Finance tools + audit log, summarize_conversation, /mydues |
| M6 | 🔲 Next | Zalo adapter (zca-js session, normalizer, outbound worker) |
| M7 | 🔲 Planned | Hardening (admin DM, scheduler jobs, backup cron) |
