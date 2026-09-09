// app/src/lib/cases/__tests__/facts-token.test.ts
// facts_token 的三臂判据（设计稿 §4.2-4）：**缺 / 过期 / 有效**，外加"档案变过"那一臂。
//
// 每条后面括号里是让它变红的变异。
import { describe, expect, it } from 'vitest';

import {
  FACTS_TOKEN_TOOLS,
  FACTS_TOKEN_TTL_MS,
  FACTS_TOKEN_WHY,
  factsHash,
  issueFactsToken,
  verifyFactsToken,
} from '../facts-token';

const CARD = '## 案件事实卡\n- 案件：#2 阶段：已收通知〔已核验〕';
const CHANGED = `${CARD}\n- 又记了一条事件〔自述〕`;
const T0 = new Date('2026-09-10T10:00:00+08:00');
const plus = (ms: number) => new Date(T0.getTime() + ms);

describe('三臂：有效 / 缺 / 过期', () => {
  it('① 有效：同一份事实卡、十分钟内 ⇒ ok（变异：把 TTL 改成 0 → 红）', () => {
    const token = issueFactsToken(CARD, T0);
    expect(verifyFactsToken(token, CARD, T0)).toEqual({ ok: true });
    // 卡在有效期边界上仍然算数（写成 `>=` 会让恰好第十分钟那一次莫名失败）
    expect(verifyFactsToken(token, CARD, plus(FACTS_TOKEN_TTL_MS))).toEqual({ ok: true });
  });

  it('② 缺：没带 / 空串 / 不是字符串 ⇒ missing（变异：把 missing 折进 malformed → 红：两者出路不同）', () => {
    for (const bad of [undefined, null, '', '   ', 42, {}]) {
      expect(verifyFactsToken(bad, CARD, T0), String(bad)).toEqual({ ok: false, reason: 'missing' });
    }
  });

  it('③ 过期：签发超过十分钟 ⇒ expired（变异：把 TTL 改成一天 → 红）', () => {
    const token = issueFactsToken(CARD, T0);
    expect(verifyFactsToken(token, CARD, plus(FACTS_TOKEN_TTL_MS + 1))).toEqual({
      ok: false,
      reason: 'expired',
    });
  });
});

describe('第四臂与形状校验', () => {
  it('档案变过 ⇒ stale，且**先于** expired 报（变异：把两个判定对调 → 红）', () => {
    // 两者同时成立时，该告诉对方的是"档案变过"——那才是他必须重读的真正理由。
    const token = issueFactsToken(CARD, T0);
    expect(verifyFactsToken(token, CHANGED, T0)).toEqual({ ok: false, reason: 'stale' });
    expect(verifyFactsToken(token, CHANGED, plus(FACTS_TOKEN_TTL_MS + 1))).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  it('手拼的令牌 ⇒ malformed（变异：只比哈希、不看前缀与形状 → 红）', () => {
    for (const bad of [
      'ft1.abc',
      `ft2.${factsHash(CARD)}.${T0.getTime()}`,
      `ft1.${factsHash(CARD)}.not-a-number`,
      `ft1.${factsHash(CARD)}.-1`,
      `ft1.NOTHEX${factsHash(CARD).slice(6)}.${T0.getTime()}`,
    ]) {
      expect(verifyFactsToken(bad, CARD, T0), bad).toEqual({ ok: false, reason: 'malformed' });
    }
  });

  it('签发时间在未来一律按过期处理（变异：只判上界 → 调用方可以把 TTL 拱手拿走）', () => {
    const future = issueFactsToken(CARD, plus(60_000));
    expect(verifyFactsToken(future, CARD, T0)).toEqual({ ok: false, reason: 'expired' });
  });

  it('哈希只认字节：差一个空格就是另一份卡（变异：先 trim 再哈希 → 红）', () => {
    expect(factsHash(CARD)).not.toBe(factsHash(`${CARD} `));
    expect(factsHash(CARD)).toBe(factsHash(CARD));
  });
});

describe('自述三段式与名单', () => {
  it('四种失败各有一句「缺什么 / 为什么缺」，且互不相同（变异：合成一句「令牌无效」 → 红）', () => {
    const whys = Object.values(FACTS_TOKEN_WHY);
    expect(whys).toHaveLength(4);
    expect(new Set(whys).size).toBe(4);
    for (const w of whys) expect(w.length).toBeGreaterThan(30);
  });

  it('挂闸的名单恰好是设计稿点名的四条（变异：把某条从名单里摘掉 → 红）', () => {
    expect([...FACTS_TOKEN_TOOLS]).toEqual([
      'case_update',
      'claims_upsert',
      'deadline_set',
      'draft_write',
    ]);
    // timeline_add / emotion_log **不在**名单里：低危高频，挂上去会让模型干脆不记
    expect(FACTS_TOKEN_TOOLS as readonly string[]).not.toContain('timeline_add');
    expect(FACTS_TOKEN_TOOLS as readonly string[]).not.toContain('emotion_log');
  });
});
