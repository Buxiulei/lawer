// app/src/lib/agent/__tests__/fixtures.ts
// agent 测试夹具：真实 migrate 建 :memory: 库 + 一个可编排的假模型。
//
// 假模型（scriptedProvider）按剧本逐轮回放「正文 + 工具调用」，这样整条编排循环
// ——包括工具执行、闸门拒绝、回喂重试、收口补救——都能在没有网络和 key 的情况下逐条断言。
import BetterSqlite3, { type Database } from 'better-sqlite3';

import { runMigrations } from '@/lib/db/migrate';
import type { ChatStreamResult, Provider, TokenUsage, ToolCall } from '@/lib/llm';
import { emptyUsage } from '@/lib/llm';
import type { AgentEvent } from '../events';
import type { KnowledgePack, KnowledgeSearcher } from '../retrieval';

export interface AgentFixture {
  db: Database;
  userId: number;
  caseId: number;
  /** 别人的案子，用来撞归属红线 */
  otherUserId: number;
  otherCaseId: number;
}

export function makeAgentFixture(): AgentFixture {
  const db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  const insertUser = db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES (?, '已实名')");
  const userId = Number(insertUser.run('hash-a').lastInsertRowid);
  const otherUserId = Number(insertUser.run('hash-b').lastInsertRowid);

  const insertCase = db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, ?, '已收通知')");
  const caseId = Number(insertCase.run(userId, '李哲诉某安全公司违法解除').lastInsertRowid);
  const otherCaseId = Number(insertCase.run(otherUserId, '别人的案子').lastInsertRowid);

  return { db, userId, caseId, otherUserId, otherCaseId };
}

/** 一轮模型输出：先流正文，再发起若干工具调用 */
export interface ScriptedRound {
  text?: string;
  tools?: { name: string; args: Record<string, unknown> }[];
  finishReason?: string;
  /**
   * 本轮回报的四桶。缺省 = 常规回报（prompt 100 / completion 20）；
   * 显式传 null = **本次流没回报计量**（四桶全 null）——计费侧对这种轮的处理
   * 与「用量为 0」完全不同（types.ts：null 不可当 0 结算），不给夹具这个开关就测不到那条路。
   */
  usage?: TokenUsage | null;
}

export interface ScriptedProvider extends Provider {
  /** 每次 chatStream 收到的完整消息数组，供断言上下文组装 */
  readonly calls: { role: string; content: string }[][];
  /** 已消费的剧本轮数 */
  readonly rounds: number;
}

/**
 * 按剧本回放的假 provider。剧本用完后回一轮空的 'stop'，
 * 这样「编排循环会不会无限转」这类问题会表现为测试超时而不是静默死循环。
 */
export function scriptedProvider(script: ScriptedRound[]): ScriptedProvider {
  const calls: { role: string; content: string }[][] = [];
  let cursor = 0;

  const p = {
    name: 'deepseek' as const,
    model: 'deepseek-v4-pro',
    billingModel: 'DeepSeek-V4-Pro-0813',
    get calls() {
      return calls;
    },
    get rounds() {
      return cursor;
    },
    async chatStream(messages: { role: string; content: string }[]) {
      calls.push(messages.map((m) => ({ role: m.role, content: m.content })));
      const round: ScriptedRound = script[cursor++] ?? {};
      return (async function* (): AsyncGenerator<string, ChatStreamResult, void> {
        // 按字符切片 yield，顺带验证调用方对增量的拼接是对的
        for (const ch of round.text ?? '') yield ch;
        const toolCalls: ToolCall[] = (round.tools ?? []).map((t, i) => ({
          id: `call_${cursor}_${i}`,
          type: 'function' as const,
          function: { name: t.name, arguments: JSON.stringify(t.args) },
        }));
        return {
          finishReason: round.finishReason ?? (toolCalls.length ? 'tool_calls' : 'stop'),
          toolCalls,
          usage: {
            model: 'DeepSeek-V4-Pro-0813',
            usage:
              round.usage === null
                ? emptyUsage()
                : { ...emptyUsage(), ...(round.usage ?? { prompt: 100, completion: 20 }) },
          },
        };
      })();
    },
  };
  return p as unknown as ScriptedProvider;
}

/** 收集 SSE 事件，附带按类型取的便捷方法 */
export function makeSink() {
  const events: AgentEvent[] = [];
  const emit = (e: AgentEvent) => {
    events.push(e);
  };
  return {
    emit,
    events,
    of<K extends AgentEvent['event']>(kind: K) {
      return events.filter((e) => e.event === kind) as Extract<AgentEvent, { event: K }>[];
    },
    /** 拼起来的正文，等价于用户屏幕上看到的 */
    get text() {
      return events
        .filter((e): e is Extract<AgentEvent, { event: 'delta' }> => e.event === 'delta')
        .map((e) => e.data.text)
        .join('');
    },
  };
}

/** 一张够真实的法条卡，够断言「逐字原文进了 system prompt」 */
export const FIXTURE_PACK: KnowledgePack = {
  id: 'statute-lhtf-38-beipo-jiechu',
  type: '法条卡',
  title: '劳动合同法第38条：被迫解除',
  keywords: ['被迫解除', '第38条', '拖欠工资'],
  applies_to: ['逼迫离职', '欠薪'],
  region: '北京',
  confidence: '原文核实',
  updated: '2026-08-19',
  body: '## 条文原文\n\n> 用人单位有下列情形之一的，劳动者可以解除劳动合同：\n> （二）未及时足额支付劳动报酬的；',
};

/** 命中就回固定卡；传空数组即恒空，用来测「检索不到」的降级路径。
 *  `get` 按 id 精确取——按 id 硬取是危机资源卡与封顶数据卡的实际用法，夹具必须支持，
 *  否则那两条路径在测试里永远走不到（曾因此漏测过）。 */
export function fixtureSearcher(packs: KnowledgePack[] = [FIXTURE_PACK]): KnowledgeSearcher {
  return {
    search: () => packs,
    get: (id: string) => packs.find((p) => p.id === id),
  };
}
