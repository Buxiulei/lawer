// app/src/lib/agent/__tests__/facts-token-site.test.ts
// **站内自动携带**的判据（设计稿 §4.2-4「站内 runTurn 由 orchestrator 自动携带」）。
//
// 【站内这道闸挡什么、不挡什么——判据也要照实写】
// MCP/REST 那面，令牌证明的是「调用方读过当前档案」；站内**读档的就是服务端自己**，
// 事实卡每一轮由 prompt.ts 注入进上下文，那条性质是构造性成立的。
// 所以站内**不重算哈希**（本轮里先 timeline_add 再 claims_upsert 是正常顺序，
// 重算会让第二个工具无理由失败），站内闸真正挡得住的是——
// **一条根本没建过事实卡的通路**去调高危写工具。下面第一组测的就是它。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { issueFactsToken, verifyFactsToken, FACTS_TOKEN_TOOLS } from '@/lib/cases/facts-token';

import { factsCardFor, factsCardOf } from '../facts-entry';
import { loadCaseSnapshot } from '../snapshot';
import { runTurn } from '../orchestrator';
import { executeTool, newTurnState, type AgentToolContext } from '../tools';
import { CitationGuard } from '../citation-guard';
import { StatuteGuard } from '../statute-guard';
import { fixtureSearcher, makeAgentFixture, makeSink, scriptedProvider, type ScriptedRound } from './fixtures';

const SRC_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

function ctxFor(f: ReturnType<typeof makeAgentFixture>, factsToken?: string): AgentToolContext {
  return {
    db: f.db,
    caseId: f.caseId,
    userId: f.userId,
    domain: 'labor',
    threadId: 1,
    sourceMessageId: null,
    citations: new CitationGuard(),
    statutes: new StatuteGuard(),
    crisisCardAlreadyGiven: false,
    searcher: fixtureSearcher(),
    factsToken,
    state: newTurnState(),
    emit: makeSink().emit,
  };
}

const DRAFT_ARGS = {
  kind: '异议函',
  title: '异议函',
  content: '本人对解除决定提出异议。',
  send_consequences: '发出后视为明确表态，公司可能据此推进解除；这一步不可逆。',
};

const countDrafts = (f: ReturnType<typeof makeAgentFixture>) =>
  (f.db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number }).n;

describe('没建过事实卡的通路调高危写工具 ⇒ 拒收且零写入', () => {
  it.each([...FACTS_TOKEN_TOOLS].filter((n) => n !== 'case_update'))(
    '%s 缺 ctx.factsToken 时拒收（变异：删掉 executeTool 里那道判断 → 红：这条通路照常写库）',
    (name) => {
      const f = makeAgentFixture();
      const before = (f.db.prepare('SELECT COUNT(*) AS n FROM drafts').get() as { n: number }).n;
      const args =
        name === 'draft_write'
          ? DRAFT_ARGS
          : name === 'claims_upsert'
            ? { kind: '欠薪', amount_fen: 123_400 }
            : { kind: '仲裁时效', anchor_date: '2026-08-20' };
      const res = executeTool(name, JSON.stringify(args), ctxFor(f));
      expect(res.ok).toBe(false);
      // 自述三段式：缺什么 / 为什么缺 / 怎么办。裸报「令牌缺失」会让读日志的人
      // 重推一遍我们已经推过的那一遍。
      expect(res.content).toContain('没有写进档案');
      expect(res.content).toContain('facts_token');
      expect(res.content).toContain('怎么办');
      expect(before).toBe(0);
      expect(countDrafts(f)).toBe(0);
    },
  );

  it('带上令牌就照常写（变异：把这道判断写成恒拒 → 红，证明它不是一道死闸）', () => {
    const f = makeAgentFixture();
    const token = issueFactsToken(factsCardFor(f.db, f.caseId));
    const res = executeTool('draft_write', JSON.stringify(DRAFT_ARGS), ctxFor(f, token));
    expect(res.ok, res.content).toBe(true);
    expect(countDrafts(f)).toBe(1);
  });

  it('不挂闸的工具不受影响（变异：把 timeline_add 也拦上 → 红）', () => {
    const f = makeAgentFixture();
    const res = executeTool(
      'timeline_add',
      JSON.stringify({ happened_at: '2026-08-20T10:00:00+08:00', kind: '公司动作', title: '收到通知' }),
      ctxFor(f), // 故意不给令牌
    );
    expect(res.ok, res.content).toBe(true);
  });
});

describe('orchestrator 自动携带：真跑一轮', () => {
  const script: ScriptedRound[] = [
    { text: '我把异议函起草好了。', tools: [{ name: 'draft_write', args: DRAFT_ARGS }] },
    {
      text: '',
      tools: [
        {
          name: 'action_card',
          args: {
            what: '今天 18 点前把解除通知转发到个人邮箱',
            how: '打开公司邮箱 → 找到那封通知 → 转发到私人邮箱并截图',
            why: '公司随时可能停你的邮箱权限',
            due_at: '2026-08-20T18:00:00+08:00',
          },
        },
      ],
    },
  ];

  it('一轮站内对话里的 draft_write 真落库（变异：把 orchestrator 里 factsToken 那一行删掉 → 红：文书一份都写不进去）', async () => {
    const f = makeAgentFixture();
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '帮我写一份异议函',
      provider: scriptedProvider(script),
      searcher: fixtureSearcher(),
      emit: makeSink().emit,
      now: new Date('2026-08-19T12:40:00Z'),
    });
    expect(countDrafts(f), '站内高危写工具没能落库：多半是本轮的 facts_token 没被自动带上').toBe(1);
  });

  it('携带的那枚令牌 = 本轮注入的那张事实卡（变异：让两处各渲染一次不同的卡 → 红）', () => {
    // 站内的令牌与 prompt 注入的事实卡都经 factsCardOf(snapshot)（全仓唯一渲染入口），
    // 所以它们是同一串字节。这一条把"同一份"验成可执行的性质，而不是一句注释。
    const f = makeAgentFixture();
    const snapshot = loadCaseSnapshot(f.db, f.caseId);
    const token = issueFactsToken(factsCardOf(snapshot));
    expect(verifyFactsToken(token, factsCardFor(f.db, f.caseId))).toEqual({ ok: true });
  });

  it('orchestrator 的令牌按 factsCardOf(snapshot) 签，不是另拼一份（变异：改成现查库再渲一遍 → 红）', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'lib/agent/orchestrator.ts'), 'utf-8');
    expect(src).toContain('factsToken: issueFactsToken(factsCardOf(snapshot))');
  });
});
