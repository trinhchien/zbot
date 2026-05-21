# Kiến trúc hệ thống — Reunion Bot

> Tài liệu mô tả chi tiết mô hình, luồng hoạt động, LLM, tools và observability của Reunion Bot.

---

## 1. Tổng quan

Reunion Bot là multi-platform chatbot (Telegram + Zalo) phục vụ nhóm lớp tổ chức họp lớp. Bot hoạt động theo mô hình **Agentic AI**: khi nhận tin nhắn từ người dùng, hệ thống phân loại ý định, nếu cần thiết sẽ gọi LLM kết hợp với một bộ tools có cấu trúc để truy vấn/cập nhật database, rồi trả về phản hồi tự nhiên bằng tiếng Việt.

```
┌──────────────────────────────────────────────────────────────────┐
│  Máy cá nhân (Win/Mac/Linux/RPi)  —  Docker Desktop              │
│                                                                    │
│  Telegram Group ──long-polling──► adapter-telegram                │
│  Zalo Group ─────websocket──────► adapter-zalo  (M6)             │
│                                        │                          │
│                                   BullMQ Redis                    │
│                                        │                          │
│                                   bot-core                        │
│                                   (LangGraph)                     │
│                                        │                          │
│                              PostgreSQL + pgvector                │
└──────────────────────────────────────────────────────────────────┘
```

---

## 2. Luồng xử lý tin nhắn

### 2.1. Inbound — từ Telegram đến bot-core

```
[Người dùng gõ tin vào group Telegram]
         │
         ▼
adapter-telegram (grammY on:message handler)
  • Kiểm tra TELEGRAM_ALLOWED_CHAT_IDS
  • normalizeTelegramMessage() → NormalizedMessage
  • getInboundQueue().add('inbound', { message },
      { jobId: "tg:{msg_id}:{chat_id}" })   ← BullMQ dedup layer 1
         │
         ▼
BullMQ Queue: [inbound-messages]  (Redis key: reunion:bull:inbound-messages)
         │
         ▼
bot-core  — Worker (concurrency=3, rate-limit=30 req/min)
  processInbound(msg):

  [1] isFromBot? → return (bỏ qua)

  [2] Upsert chat_groups
        platform + platformChatId = unique key
        cập nhật chatName nếu thay đổi

  [3] Upsert user_identities
        platform + platformUserId = unique key
        cập nhật lastSeenAt, displayName

  [4] Auto-create canonical user (users table)
        nếu identity.userId IS NULL:
          INSERT INTO users (canonicalName)
          UPDATE user_identities SET userId = new_user.id

  [5] INSERT messages (onConflictDoNothing)  ← DB dedup layer 2
        trùng lặp (platform + platformMessageId)? → return sớm

  [6] Enqueue embed-batch job
        jobId: "embed:{message_uuid}"
        background worker sẽ gọi Gemini text-embedding-004

  [7] Slash command? (/event, /rsvp, ...)
        → handleCommand() → outbound queue → return

  [8] classify(msg) → tier
        store_only | flash_lite | flash

  [9] tier === 'store_only'? → return (không reply)

  [10] orchestrate() — LangGraph pipeline
```

### 2.2. Outbound — từ bot-core đến Telegram

```
orchestrate() / handleCommand()
  → getOutboundQueue().add('outbound', { message })

BullMQ Queue: [outbound-messages]

adapter-telegram  — outbound Worker (concurrency=5)
  if (message.platform !== 'telegram') return  ← platform filter
  bot.api.sendMessage(chatId, text, { reply_parameters })
```

### 2.3. Background embedding

```
bot-core  — bgWorker (concurrency=2, queue: background-jobs)
  job.type === 'embed-batch':
    1. Đọc message từ DB (kiểm tra embeddingStatus === 'pending')
    2. embed([content]) → float32[768]  (Gemini text-embedding-004)
    3. updateMessageEmbedding(messageId, vector)
    4. embeddingStatus → 'done'
    Lỗi → markMessageEmbeddingFailed() + log warn
```

---

## 3. Phân loại tin nhắn (classify.ts)

Trước khi vào LangGraph, mỗi tin nhắn được phân tầng để tối ưu chi phí:

```
classify(msg) → Tier
```

| Tier | Điều kiện | Xử lý |
|------|-----------|-------|
| `store_only` | Không mention bot | Lưu vào DB, không reply |
| `flash_lite` | Mention bot + khớp pattern đơn giản | Gemini Lite |
| `flash` | Mention bot + phức tạp / mặc định | Gemini Primary |

**Patterns flash_lite** (regex):
- `ai (đã)? đóng tiền` — hỏi ai đóng tiền
- `ai đi` — hỏi ai tham gia
- `list (task|công việc)` — liệt kê task
- `(còn)? bao (nhiêu|lâu)` — hỏi số lượng / thời gian

**Patterns flash** (complex indicators — ưu tiên cao hơn):
- `tóm tắt` — yêu cầu tóm tắt
- Nhiều dấu `?` — nhiều câu hỏi
- Tin dài > 200 ký tự
- Từ liên kết: `và|hoặc|nhưng`

---

## 4. LLM — Gemini

### 4.1. Models

| Tier | Model | Dùng cho |
|------|-------|---------|
| primary | `gemini-2.5-flash` | Tin phức tạp, tóm tắt, multi-tool |
| lite | `gemini-2.5-flash-lite` | Truy vấn đơn giản |
| embedding | `text-embedding-004` | Vector 768d cho messages và user_facts |

**Temperature**: `0.4` — đủ sáng tạo cho văn phong, không hallucinate số liệu.

**MaxRetries**: `2` — tự retry khi Gemini trả 429/503.

### 4.2. Quota & Rate-limit (rate-limit.ts)

Quota được enforced **trước mỗi LLM call** qua LangChain callback:

```
checkAndConsume(tier):
  key = "reunion:quota:{tier}:YYYY-MM-DD"  (Redis)
  INCR key → used
  if used === 1: EXPIRE key 108000s (30h)
  return used <= BUDGET[tier]
```

| Tier | Budget mặc định | Redis key pattern |
|------|-----------------|-------------------|
| primary | 200 req/ngày | `reunion:quota:primary:2026-05-21` |
| lite | 800 req/ngày | `reunion:quota:lite:2026-05-21` |
| embedding | 1400 req/ngày | `reunion:quota:embedding:2026-05-21` |

Khi vượt quota: `QuotaExceededError` được bắt trong `orchestrate()`, bot trả về tin nhắn graceful thay vì crash.

```ts
// Xem usage hiện tại
import { getUsage } from './services/rate-limit';
const usage = await getUsage();
// { primary: 47, lite: 123, embedding: 891 }
```

---

## 5. LangGraph Pipeline

### 5.1. Graph topology

```
START
  │
  ▼
[agent node]  ← Gemini + bindTools(allTools)
  │
  ▼
shouldContinue()
  ├── tool_calls exist  ──► [tools node]  ← ToolNode(allTools)
  │                              │
  │                              └──────────────► [agent node]  (loop)
  │
  └── no tool_calls / stepCount >= MAX_STEPS ──► END
```

**MAX_STEPS = 6** — giới hạn vòng lặp agent↔tools để tránh chi phí vô hạn.

### 5.2. State schema

```typescript
GraphState = {
  // LangChain standard
  messages: BaseMessage[],       // lịch sử hội thoại của run này

  // Context từ preprocess, read-only trong graph
  ctxUserId: string,
  ctxIdentityId: string,
  ctxChatGroupId: string,
  ctxMessageId: string,          // UUID trong bảng messages
  ctxPlatform: 'telegram' | 'zalo' | 'messenger',
  ctxTier: Tier,

  // Đếm bước, reducer: (curr, next) => next ?? curr ?? 0
  stepCount: number,
}
```

### 5.3. Agent node

Mỗi lần gọi:
1. Kiểm tra `stepCount >= MAX_STEPS` — nếu đạt giới hạn, trả về tin "đang xử lý hơi lâu"
2. `buildLLM({ tier })` — khởi tạo ChatGoogleGenerativeAI với `RateLimitCallback`
3. `llm.bindTools(allTools)` — đính kèm 20 tools dưới dạng function declarations
4. `llmWithTools.invoke(messages, { configurable: ctx })` — truyền context vào config để tools đọc
5. Trả về `{ messages: [aiResponse], stepCount: stepCount + 1 }`

### 5.4. Tools node

`ToolNode(allTools)` xử lý `tool_calls` trong AIMessage:
- Gọi từng tool theo tên, truyền arguments đã parse
- Trả về `ToolMessage` với kết quả JSON
- Nếu tool throw → `ToolMessage` chứa error message (LangGraph tự wrap)

### 5.5. Checkpointing (PostgresSaver)

```
thread_id = "chat:{chatGroupId}:{persistedMessageId}"
```

- Mỗi message = 1 thread riêng → context cô lập, không bị pha trộn giữa các cuộc hội thoại
- State được lưu sau mỗi node → crash giữa chừng có thể resume
- Schema: `langgraph` (tách biệt với schema `public` của app)
- Pool riêng: `max=5` connections, không dùng chung với app pool

### 5.6. Input vào graph

```typescript
{
  messages: [
    SystemMessage(systemPrompt({
      botName, user, userFacts,
      recentSnippet,   // 15 messages gần nhất dạng text, cắt 2000 chars
      nowIso,
    })),
    HumanMessage(msg.content.text),
  ],
  ctxUserId, ctxIdentityId, ctxChatGroupId,
  ctxMessageId, ctxPlatform, ctxTier,
  stepCount: 0,
}
```

---

## 6. System Prompt

Prompt được build động mỗi lần orchestrate (không cache), bao gồm:

| Phần | Nội dung |
|------|---------|
| Vai trò | Bot là trợ lý lớp 12A1, xưng "mình", gọi "các bạn" |
| Nguyên tắc | Luôn dùng tool khi cần dữ liệu, không bịa số liệu, không tự xóa data |
| Định dạng | Tiền VND (1.500.000đ), ngày DD/MM/YYYY HH:mm (UTC+7), emoji vừa phải |
| Ngữ cảnh động | Thời gian hiện tại, tên+vai trò người dùng, facts đã biết (tối đa 8) |
| Lịch sử chat | 15 tin nhắn gần nhất, truncated 2000 ký tự |

**Nguyên tắc quan trọng:**
- Không bao giờ tự bịa số tiền — phải gọi tool
- `verify_contribution` chỉ thủ quỹ mới được ra lệnh
- Khi không chắc → hỏi lại 1 câu, không hỏi nhiều lần

---

## 7. Tool Registry

### 7.1. Context truyền vào tools

Tất cả tools nhận context thông qua `RunnableConfig.configurable`, được set bởi `agentNode`:

```typescript
extractContext(config) → {
  userId,       // UUID trong bảng users
  identityId,   // UUID trong bảng user_identities
  chatGroupId,  // UUID trong bảng chat_groups
  messageId,    // UUID trong bảng messages (source message)
  platform,     // 'telegram' | 'zalo' | 'messenger'
}
```

### 7.2. Permission system

```typescript
requireRole(userId, required)
  → SELECT role FROM users WHERE id = userId
  → ROLE_ORDER = { member:0, organizer:1, treasurer:1, admin:2 }
  → throw nếu user.role < required
```

| Role | Level | Ghi chú |
|------|-------|---------|
| `member` | 0 | Tất cả thành viên |
| `organizer` | 1 | Ban tổ chức — set qua `ORGANIZER_TELEGRAM_IDS` env |
| `treasurer` | 1 | Thủ quỹ — set qua `TREASURER_USER_IDS` env |
| `admin` | 2 | Chưa dùng (M7) |

### 7.3. Danh sách 20 tools

#### Memory (3 tools)

| Tool | Mô tả | Permission | DB operation |
|------|-------|-----------|--------------|
| `remember_user_fact` | Lưu fact về user (embed → insert user_facts) | member | INSERT user_facts + pgvector |
| `recall_user_info` | Truy xuất facts (semantic search hoặc by category) | member | SELECT user_facts ORDER BY embedding <=> query |
| `search_past_messages` | Tìm tin nhắn cũ qua semantic search | member | SELECT messages ORDER BY embedding <=> query |

#### Event (4 tools)

| Tool | Mô tả | Permission | DB operation |
|------|-------|-----------|--------------|
| `create_event` | Tạo sự kiện mới | organizer | INSERT events |
| `update_event_decision` | Ghi lại quyết định đã chốt | member | INSERT event_decisions |
| `list_event_status` | Xem đầy đủ thông tin sự kiện + RSVP counts + decisions | member | SELECT events + rsvps + event_decisions |
| `set_event_status` | Đổi trạng thái sự kiện, cập nhật ngày/địa điểm | organizer | UPDATE events |

#### RSVP (2 tools)

| Tool | Mô tả | Permission | DB operation |
|------|-------|-----------|--------------|
| `set_rsvp` | Đăng ký tham gia / không tham gia / chưa chắc | member | INSERT/UPDATE rsvps (upsert) |
| `list_rsvp` | Xem danh sách RSVP theo nhóm | member | SELECT rsvps JOIN users |

#### Task (4 tools)

| Tool | Mô tả | Permission | DB operation |
|------|-------|-----------|--------------|
| `create_task` | Tạo task mới, tùy chọn giao ngay | member | INSERT tasks |
| `assign_task` | Giao task cho thành viên | member | UPDATE tasks SET assigneeUserId |
| `update_task_status` | Cập nhật trạng thái task | member | UPDATE tasks SET status |
| `list_tasks` | Liệt kê task (mine/all/unassigned, filter by status) | member | SELECT tasks LEFT JOIN users, ORDER BY priority CASE WHEN |

#### Finance (6 tools)

| Tool | Mô tả | Permission | DB operation |
|------|-------|-----------|--------------|
| `create_contribution_campaign` | Mở đợt thu tiền | treasurer | INSERT contribution_campaigns |
| `record_contribution` | Ghi nhận đóng góp (status=pending) | member | INSERT contributions |
| `verify_contribution` | Xác nhận / từ chối đóng góp + audit log | treasurer | UPDATE contributions + INSERT audit_log |
| `list_contribution_status` | Xem ai đóng rồi, ai chưa, tổng đã xác nhận | member | SELECT contributions JOIN users |
| `record_expense` | Ghi khoản chi (self-approved) | organizer | INSERT expenses |
| `financial_summary` | Tổng quan thu chi: số dư, phân loại chi phí | member | SELECT SUM CASE WHEN (contributions + expenses) |

#### Meta (1 tool)

| Tool | Mô tả | Permission | DB operation |
|------|-------|-----------|--------------|
| `summarize_conversation` | Lấy N tin nhắn gần nhất để bot viết tóm tắt | member | SELECT messages LEFT JOIN users + userIdentities |

### 7.4. Tool output format

Tất cả tools trả về `JSON.stringify({ ok: boolean, ... })`. Pattern lỗi:

```json
{ "ok": false, "error": "Mô tả lỗi bằng tiếng Việt" }
```

Pattern thành công:

```json
{ "ok": true, "message": "Xác nhận ngắn gọn", ...data }
```

Agent đọc kết quả này và viết phản hồi tự nhiên cho người dùng — không bao giờ paste raw JSON.

---

## 8. Identity Model

```
user_identities                    users
┌─────────────────────┐           ┌──────────────────┐
│ platform='telegram' │           │ id (UUID)         │
│ platformUserId=123  │──userId──►│ canonicalName     │
│ displayName='Minh'  │           │ nickname          │
└─────────────────────┘           │ role              │
                                   └──────────────────┘
┌─────────────────────┐                    ▲
│ platform='zalo'     │                    │
│ platformUserId=456  │──userId────────────┘
│ displayName='Minh'  │
└─────────────────────┘
```

- Mỗi lần nhắn = auto-upsert identity → auto-create user nếu chưa có
- Merge 2 platform vào 1 user qua `/link` + `/redeem`:
  - `/link` tạo mã 6 ký tự (nanoid, 10 phút)
  - `/redeem <CODE>` trên platform kia → update identity.userId + xóa orphan user

---

## 9. Database Schema (chi tiết)

```sql
-- Identity
users(id, canonicalName, nickname, role, embedding[768], createdAt)
user_identities(id, platform, platformUserId, platformDisplayName, userId→users, linkedAt, lastSeenAt)

-- Chat history
chat_groups(id, platform, platformChatId, name, createdAt)
messages(id, chatGroupId→chat_groups, platform, platformMessageId,
         senderIdentityId→user_identities, content TEXT,
         botMentioned, mentions[], attachments JSONB,
         embedding[768], embeddingStatus ENUM, createdAt)

-- Event planning
events(id, name, description, eventDate, location, status ENUM,
       budgetTotal, createdByUserId→users, createdAt, updatedAt)
event_decisions(id, eventId→events, topic, decision,
                decidedByUserId→users, sourceMessageId→messages,
                decidedAt, createdAt)
rsvps(id, eventId→events, userId→users, status ENUM(yes/no/maybe),
      plusOnes, notes, respondedAt)

-- Tasks
tasks(id, eventId→events, title, description, status ENUM,
      priority ENUM(high/normal/low), dueDate,
      assigneeUserId→users, createdByUserId→users, createdAt, updatedAt)

-- Finance
contribution_campaigns(id, name, eventId→events, status ENUM(open/closed),
                        amountPerHead BIGINT, deadline,
                        createdByUserId→users, createdAt)
contributions(id, campaignId→campaigns, userId→users,
              amount BIGINT, status ENUM(pending/verified/rejected),
              paidAt, paymentProof, verifiedByUserId→users, verifiedAt,
              note, createdAt)
expenses(id, eventId→events, description, amount BIGINT,
         paidByUserId→users, category, receipt, spentAt,
         approved, approvedByUserId→users, createdAt)

-- Audit
audit_log(id, actorUserId→users, actorType, action, entityType, entityId,
          before JSONB, after JSONB, context JSONB, createdAt)

-- Memory
user_facts(id, userId→users, fact TEXT, category ENUM, confidence FLOAT,
           embedding[768], sourceMessageId→messages, createdAt)
```

**Lưu ý kỹ thuật:**
- `amount`, `amountPerHead`, `budgetTotal` — `BIGINT` số nguyên VND, không decimal
- `embedding[768]` — pgvector, index HNSW, cosine similarity (`<=>`)
- `embeddingStatus` — `pending | processing | done | failed`
- Amount fields dùng `{ mode: 'number' }` trong Drizzle để JS nhận `number` thay vì `bigint`

---

## 10. Queue System (BullMQ)

| Queue | Key Redis | Producer | Consumer | Concurrency |
|-------|-----------|---------|---------|-------------|
| `inbound-messages` | `reunion:bull:inbound-messages` | adapter-telegram/zalo | bot-core Worker | 3 |
| `outbound-messages` | `reunion:bull:outbound-messages` | bot-core | adapter-telegram outbound Worker | 5 |
| `background-jobs` | `reunion:bull:background-jobs` | bot-core | bot-core bgWorker | 2 |

**Deduplication inbound:**
- Layer 1 (BullMQ): `jobId = "tg:{msg_id}:{chat_id}"` — BullMQ bỏ qua job trùng
- Layer 2 (DB): `onConflictDoNothing` trên `(platform, platformMessageId)` — guard cuối

**Job options:**
- Inbound: `removeOnComplete: 1000`, `removeOnFail: 5000`
- Embed-batch: `removeOnComplete: 500`, `removeOnFail: 1000`

---

## 11. Observability

### 11.1. Pino Logs

```
Development → pino-pretty (colorized, format: HH:mm:ss.ms)
Production  → JSON to stdout → docker compose logs
```

Log level: `trace < debug < info < warn < error`

Mặc định `info`. Quan trọng:
- `info` — job processed, user auto-created, primary event bootstrapped
- `debug` — classify tier, duplicate message skipped, embedding done
- `warn` — embedding failed, quota exhausted
- `error` — job failed, DB error, graph invocation failed

Tăng detail:
```bash
LOG_LEVEL=debug pnpm --filter @reunion/bot-core dev
```

### 11.2. Langfuse (tracing LangGraph)

Langfuse là giải pháp observability cho LLM — **free tier 50k observations/tháng**, hoặc self-hosted miễn phí không giới hạn.

**Cấu hình** (thêm vào `.env`):

```bash
LANGFUSE_PUBLIC_KEY=pk-lf-...   # cloud.langfuse.com → Settings → API Keys
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_HOST=https://cloud.langfuse.com   # self-hosted: đổi URL này
```

**Cơ chế hoạt động** (`services/tracer.ts`):

```
getTracer()
  → nếu PUBLIC_KEY + SECRET_KEY có: khởi tạo CallbackHandler (singleton)
  → nếu thiếu key: trả về undefined → callbacks: [] → tracing tắt hoàn toàn
```

CallbackHandler được pass vào `graph.invoke({ ..., callbacks: [tracer] })`. LangGraph tự forward callback xuống từng node và tool call — không cần sửa code tool.

Sau khi restart bot-core, mỗi tin nhắn qua LangGraph tạo 1 trace:
- Xem từng node agent/tools theo timeline
- Input/output từng tool call (arguments + kết quả JSON)
- Latency từng bước, tổng token/cost
- So sánh run theo thời gian
- Self-hosted: dữ liệu không rời server của bạn

### 11.3. Xem quota Gemini (Redis)

```bash
# Kiểm tra usage hôm nay
redis-cli -u redis://localhost:6379 GET "reunion:quota:primary:2026-05-21"
redis-cli -u redis://localhost:6379 GET "reunion:quota:lite:2026-05-21"
redis-cli -u redis://localhost:6379 GET "reunion:quota:embedding:2026-05-21"
```

Hoặc trong code:
```typescript
import { getUsage } from './services/rate-limit';
const { primary, lite, embedding } = await getUsage();
```

### 11.4. Xem queue (Redis)

```bash
# Số job đang chờ trong queue inbound
redis-cli -u redis://localhost:6379 LLEN "reunion:bull:inbound-messages:wait"

# Job failed
redis-cli -u redis://localhost:6379 ZCARD "reunion:bull:inbound-messages:failed"
```

---

## 12. Hệ thống phân quyền & xác thực danh tính

### 12.1. Nguyên tắc thiết kế

- **1 user = 1 số điện thoại** — SĐT là identity canonical, không phải Telegram/Zalo ID
- **Xác thực KHÔNG diễn ra trong group chat** — group là môi trường mở, ai cũng có thể join và đọc. Mọi flow nhạy cảm (chia sẻ SĐT, xác nhận danh tính) phải qua DM riêng với bot
- **Auto-register nhưng unverified** — ai nhắn trong group đều được tạo account tạm, nhưng phải verify phone mới dùng được tính năng nhạy cảm

### 12.2. Phone Verification Flow

```
[Lần đầu nhắn vào group]
  → auto-create user_identities + users (phoneVerifiedAt = NULL)
  → có thể xem /event, /help

[Muốn dùng RSVP, task, quỹ, ...]
  → bot trả về: "🔒 Cần xác thực SĐT. DM bot /start"

[User DM bot /start]
  → bot gửi Telegram keyboard: nút "📱 Chia sẻ số điện thoại" (requestContact)
  → user nhấn → Telegram tự gửi contact message

[contact message nhận được]
  → adapter-telegram: normalize → NormalizedMessage { content.contact }
  → enqueue inbound queue (jobId: tg:contact:{userId}:{msgId})
  → preprocess.ts: phát hiện content.contact → handlePhoneContact()

handlePhoneContact(phone):
  Case A — SĐT chưa tồn tại trong DB:
    UPDATE users SET phone=phone, phoneVerifiedAt=now()
    UPDATE user_identities SET phoneVerifiedAt=now()
    → reply: "✅ Đã liên kết SĐT"

  Case B — SĐT đã thuộc user khác (cross-platform merge):
    UPDATE user_identities SET userId=existingUser.id, phoneVerifiedAt=now()
    DELETE users nếu user cũ không còn identity nào
    → reply: "✅ Đã hợp nhất với tài khoản [tên]"

  Case C — Identity đã verified rồi:
    → reply: "✅ Đã xác thực rồi"
```

**Phone normalization:** strip whitespace, đảm bảo có `+` prefix. `+84901234567` không `84901234567`.

### 12.3. Role System

```
member (0) ──── mặc định cho mọi user đã verify
organizer (1) ── set qua ORGANIZER_TELEGRAM_IDS env var khi first message
treasurer (1) ── set qua TREASURER_USER_IDS env var (UUID-based)
admin (2) ────── chưa dùng (M7)
```

**Gán role tự động khi first message** (trong preprocess.ts — auto-create user):
- Nếu `platformUserId` của Telegram nằm trong `ORGANIZER_TELEGRAM_IDS` → role=organizer
- Nếu sau khi verify, UUID nằm trong `TREASURER_USER_IDS` → role=treasurer

**`requireRole(userId, required)`** (tools/index.ts):
```
SELECT role FROM users WHERE id = userId
ROLE_ORDER = { member:0, organizer:1, treasurer:1, admin:2 }
throw nếu user.role < required
```

**`requireVerified(userId)`** (tools/index.ts):
```
SELECT phoneVerifiedAt FROM users WHERE id = userId
throw nếu phoneVerifiedAt IS NULL
→ message: "Cần xác thực SĐT trước. DM bot /start"
```

### 12.4. Ma trận quyền

| Hành động | Cần verify? | Cần role |
|-----------|------------|---------|
| `/help`, `/event` | ❌ | — |
| `/who`, `/rsvp` | ✅ | member |
| `/mytasks`, `/tasks` | ✅ | member |
| `/mydues` | ✅ | member |
| `/link`, `/redeem` | ✅ | member |
| `create_task`, `assign_task`, `update_task_status` | ✅ | member |
| `set_rsvp`, `list_rsvp` | ✅ | member |
| `record_contribution` | ✅ | member |
| `list_contribution_status`, `financial_summary` | ✅ | member |
| `create_event`, `set_event_status` | ✅ | organizer |
| `record_expense` | ✅ | organizer |
| `create_contribution_campaign`, `verify_contribution` | ✅ | treasurer |

### 12.5. Cross-platform identity merge

Trước đây `/link` + `/redeem` là cách duy nhất merge Telegram ↔ Zalo. Với phone verification:

```
Telegram user verify SĐT +84901234567
         ↓
Zalo user verify SĐT +84901234567  (cùng SĐT)
         ↓
handlePhoneContact() Case B: auto-merge
→ cả 2 identity trỏ vào 1 user
→ RSVP, task, quỹ được hợp nhất
```

`/link` + `/redeem` vẫn hoạt động như fallback cho trường hợp không thể share SĐT.

### 12.6. Schema thay đổi (so với ban đầu)

```sql
-- users: phone là canonical identity, unique
users.phone             TEXT UNIQUE  -- chuẩn E.164, vd +84901234567
users.phone_verified_at TIMESTAMPTZ  -- NULL = chưa verify

-- user_identities: track khi nào identity này được verified
user_identities.phone_verified_at TIMESTAMPTZ  -- NULL = chưa verify
```

---

## 13. Slash Commands (rule-based, không qua LLM)

Slash commands được xử lý trực tiếp trong `preprocess.ts` bước 7 — không đi qua LangGraph, không tốn Gemini quota.

| Command | Handler | DB calls |
|---------|---------|---------|
| `/help`, `/start` | Trả về HELP_TEXT static | — |
| `/event` | `getPrimaryEvent()` + `getRsvpCounts()` | 2 SELECT |
| `/rsvp yes\|no\|maybe` | `getPrimaryEvent()` + `upsertRsvp()` | 1 SELECT + 1 UPSERT |
| `/who` | `getPrimaryEvent()` + `getParticipantsWithNames()` | 2 SELECT (JOIN) |
| `/mytasks` | `listTasks({ assigneeUserId, limit:20 })` | 1 SELECT JOIN |
| `/tasks` | `listTasks({ limit:30 })` | 1 SELECT JOIN |
| `/mydues` | `getLatestOpenCampaign()` + `getUserContributions()` | 2 SELECT |
| `/link` | `INSERT linkCodes` (nanoid 6 chars, TTL 10 phút) | 1 INSERT |
| `/redeem <CODE>` | Lookup → update userIdentities → delete orphan user → mark consumed | 2-4 queries |

---

## 13. Data flows theo use case

### User nhắn "tớ đã chuyển khoản 300k"

```
[Telegram] "tớ đã chuyển khoản 300k"
  → normalize (botMentioned=true nếu có @bot)
  → classify → flash
  → orchestrate()
      → agentNode:
          SystemMessage + HumanMessage("tớ đã chuyển khoản 300k")
          Gemini quyết định gọi: record_contribution(amount=300000)
      → toolsNode:
          record_contribution:
            extractContext → userId, chatGroupId
            getLatestOpenCampaign() → campaign
            recordContribution({ campaignId, userId, amount:300000 })
            → { ok:true, contributionId, message: "Đã ghi nhận 300.000₫ — chờ thủ quỹ xác nhận" }
      → agentNode:
          Gemini đọc tool result → viết reply tự nhiên
          "Mình đã ghi nhận bạn chuyển 300.000₫ rồi nhé ✅ Đợi thủ quỹ xác nhận là xong!"
  → outboundQueue.add → adapter-telegram → sendMessage
```

### Thủ quỹ xác nhận "OK xác nhận cho Minh"

```
Gemini phân tích → cần contributionId
  → gọi list_contribution_status() để tìm pending của Minh
  → gọi verify_contribution({ contributionId, approved:true })
      repository:
        READ before state (contributions)
        UPDATE contributions SET status='verified', verifiedByUserId, verifiedAt
        INSERT audit_log { action:'contribution.verify', before, after, context:{platform, messageId} }
      → { ok:true, status:'verified' }
  → "Đã xác nhận ✅ Audit log đã ghi."
```

### User nhắn "tóm tắt hôm nay nói gì"

```
classify → flash (COMPLEX_INDICATORS: /tóm tắt/)
→ orchestrate()
    → agentNode → gọi summarize_conversation({ limit:50 })
    → toolsNode:
        SELECT messages + JOIN users + userIdentities
        WHERE chatGroupId = ctx.chatGroupId
        ORDER BY createdAt DESC LIMIT 50
        → { ok:true, count:42, messages:[...], instruction:"Dùng danh sách trên để viết tóm tắt..." }
    → agentNode:
        Gemini đọc 42 messages → viết tóm tắt ~5-10 bullet points
        "Hôm nay lớp mình thảo luận:
         • Chốt địa điểm: Nhà hàng ABC ✅
         • Minh và Lan sẽ đi cùng xe
         • Còn 3 người chưa trả lời RSVP..."
```
