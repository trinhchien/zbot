/**
 * LangGraph-based orchestration (v2).
 * Replaces the manual ReAct loop from v1.
 *
 * Flow: START → agent → (tool_calls?) → tools → agent (loop) → END
 */
import { StateGraph, MessagesAnnotation, START, END, Annotation } from '@langchain/langgraph';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { AIMessage, SystemMessage, HumanMessage } from '@langchain/core/messages';
import { buildLLM, QuotaExceededError } from '../services/llm';
import { getCheckpointer } from '../services/checkpointer';
import { allTools } from '../tools/index';
import { systemPrompt } from '../prompts/system';
import type { NormalizedMessage } from '@reunion/shared/types/platform';
import type { Tier } from './classify';
import { db } from '@reunion/db/client';
import { users, userFacts, messages as messagesTable } from '@reunion/db/schema';
import { eq, desc } from 'drizzle-orm';
import { getOutboundQueue } from '@reunion/shared/queue';
import { logger } from '@reunion/shared/logger';
import { getTracer } from '../services/tracer';

// ===== Custom state =====
const GraphState = Annotation.Root({
  ...MessagesAnnotation.spec,
  ctxUserId: Annotation<string>(),
  ctxIdentityId: Annotation<string>(),
  ctxChatGroupId: Annotation<string>(),
  ctxMessageId: Annotation<string>(),
  ctxPlatform: Annotation<'telegram' | 'zalo' | 'messenger'>(),
  ctxTier: Annotation<Tier>(),
  stepCount: Annotation<number>({
    reducer: (curr, next) => next ?? curr ?? 0,
    default: () => 0,
  }),
});

type State = typeof GraphState.State;

const MAX_STEPS = 6;

// ===== Nodes =====
async function agentNode(state: State): Promise<Partial<State>> {
  if (state.stepCount >= MAX_STEPS) {
    return {
      messages: [new AIMessage('Mình đang xử lý hơi lâu, các bạn thử lại sau chút nhé.')],
      stepCount: state.stepCount + 1,
    };
  }

  const llm = buildLLM({ tier: state.ctxTier === 'flash_lite' ? 'lite' : 'primary' });
  const llmWithTools = llm.bindTools(allTools);

  const response = await llmWithTools.invoke(state.messages, {
    configurable: {
      ctxUserId: state.ctxUserId,
      ctxIdentityId: state.ctxIdentityId,
      ctxChatGroupId: state.ctxChatGroupId,
      ctxMessageId: state.ctxMessageId,
      ctxPlatform: state.ctxPlatform,
    },
  });

  return {
    messages: [response],
    stepCount: state.stepCount + 1,
  };
}

function shouldContinue(state: State): 'tools' | typeof END {
  const last = state.messages[state.messages.length - 1] as AIMessage;
  if (state.stepCount >= MAX_STEPS) return END;
  if (last.tool_calls && last.tool_calls.length > 0) return 'tools';
  return END;
}

// ===== Build graph =====
async function buildGraph() {
  const checkpointer = await getCheckpointer();
  const toolNode = new ToolNode(allTools);

  const graph = new StateGraph(GraphState)
    .addNode('agent', agentNode)
    .addNode('tools', toolNode)
    .addEdge(START, 'agent')
    .addConditionalEdges('agent', shouldContinue, {
      tools: 'tools',
      [END]: END,
    })
    .addEdge('tools', 'agent')
    .compile({ checkpointer });

  return graph;
}

let _graphPromise: ReturnType<typeof buildGraph> | undefined;
function getGraph() {
  if (!_graphPromise) _graphPromise = buildGraph();
  return _graphPromise;
}

// ===== Public API =====
interface OrchestrationContext {
  message: NormalizedMessage;
  persistedMessageId: string;
  chatGroupId: string;
  userId: string;
  identityId: string;
  tier: Tier;
}

export async function orchestrate(ctx: OrchestrationContext): Promise<void> {
  // Build prompt context
  const [user] = await db.select().from(users).where(eq(users.id, ctx.userId));
  if (!user) {
    logger.error({ userId: ctx.userId }, 'User not found for orchestration');
    return;
  }

  const recentMsgs = await db
    .select()
    .from(messagesTable)
    .where(eq(messagesTable.chatGroupId, ctx.chatGroupId))
    .orderBy(desc(messagesTable.createdAt))
    .limit(15);
  recentMsgs.reverse();

  const userFactsList = await db.select().from(userFacts).where(eq(userFacts.userId, ctx.userId)).limit(8);

  const sys = systemPrompt({
    botName: 'Trợ lý Lớp',
    user: { id: user.id, name: user.canonicalName, nickname: user.nickname ?? undefined, role: user.role },
    userFacts: userFactsList.map((f) => f.fact),
    recentSnippet: recentMsgs
      .map((m) => `[${m.createdAt.toISOString()}] ${m.content ?? ''}`)
      .join('\n')
      .slice(-2000),
    nowIso: new Date().toISOString(),
  });

  const graph = await getGraph();
  const threadId = `chat:${ctx.chatGroupId}:${ctx.persistedMessageId}`;

  let finalText: string | undefined;

  try {
    const tracer = getTracer();
    const result = await graph.invoke(
      {
        messages: [new SystemMessage(sys), new HumanMessage(ctx.message.content.text ?? '')],
        ctxUserId: ctx.userId,
        ctxIdentityId: ctx.identityId,
        ctxChatGroupId: ctx.chatGroupId,
        ctxMessageId: ctx.persistedMessageId,
        ctxPlatform: ctx.message.platform,
        ctxTier: ctx.tier,
        stepCount: 0,
      },
      {
        configurable: { thread_id: threadId },
        recursionLimit: 12,
        callbacks: tracer ? [tracer] : [],
      },
    );

    const last = result.messages[result.messages.length - 1];
    if (last instanceof AIMessage && (!last.tool_calls || last.tool_calls.length === 0)) {
      finalText = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    }
  } catch (e) {
    if (e instanceof QuotaExceededError) {
      logger.warn({ tier: ctx.tier }, 'Gemini quota exhausted');
      finalText =
        '⚠️ Mình hết quota AI hôm nay rồi 😅 các bạn thử lại sau 24h, hoặc dùng các lệnh /event, /rsvp, /mytasks bình thường nhé.';
    } else {
      logger.error({ err: e }, 'Graph invocation failed');
      finalText = 'Mình gặp lỗi khi xử lý, các bạn thử lại nhé.';
    }
  }

  if (!finalText) {
    finalText = 'Mình chưa hiểu lắm, các bạn nói rõ hơn được không?';
  }

  const outboundQueue = getOutboundQueue();
  await outboundQueue.add('outbound', {
    message: {
      platform: ctx.message.platform,
      chatId: ctx.message.chatId,
      text: finalText,
      replyToPlatformMessageId: ctx.message.platformMessageId,
    },
  });
}
