/**
 * 402 这一档必须原样过到页面：错误码 + **余额那个数**。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 传输层把非流响应归一成一帧 error 时，只抄了 error_code / message / retry_after。
 * `balance` 不抄，页面就只能从 message 里抠数字——而低调模式下横幅换的是整句说法，
 * 那条路在换词的那一刻就断了，屏幕上会出现一句「你的额度余额是 」后面什么都没有。
 *
 * 【变异臂】
 *  · M-F7 errorFrameFrom 不抄 balance      ⇒「带回余额」红
 *  · M-F8 balance 缺席时补 0（而不是缺席）  ⇒「不编一个 0」红
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/auth', () => ({ readToken: () => 'jwt-token', TOKEN_STORAGE_KEY: 'k' }));
vi.mock('@/app/_ui/api', () => ({ classifyAuthStatus: () => 'ok' as const }));

const { createHttpTransport } = await import('../httpTransport');
const { GONGDAO_EXHAUSTED } = await import('../frames');

/** 让传输层收到一个指定的非流响应，返回它吐出来的帧 */
function respondWith(body: unknown, status: number) {
  vi.stubGlobal('fetch', async () =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  );
  return (async () => {
    const frames = [];
    for await (const f of createHttpTransport().send({
      caseId: '9',
      message: '在吗',
      signal: new AbortController().signal,
    })) {
      frames.push(f);
    }
    return frames;
  })();
}

const EXHAUSTED = {
  ok: false,
  error_code: GONGDAO_EXHAUSTED,
  message: '公道值余额 0，这一轮开不了。……',
  balance: 0,
};

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('402 GONGDAO_EXHAUSTED', () => {
  it('★归一成一帧 error，带回错误码与余额（余额 0 也要带，它不是「没有值」）', async () => {
    const frames = await respondWith(EXHAUSTED, 402);
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({
      type: 'error',
      code: GONGDAO_EXHAUSTED,
      balance: 0,
    });
  });

  it('负余额（上一轮透支）照样带回', async () => {
    const frames = await respondWith({ ...EXHAUSTED, balance: -5 }, 402);
    expect(frames[0]).toMatchObject({ balance: -5 });
  });

  it('★服务端没给 balance ⇒ 缺席，不编一个 0（0 是一个真实且不同的余额）', async () => {
    const frames = await respondWith({ ok: false, error_code: GONGDAO_EXHAUSTED, message: 'x' }, 402);
    expect(frames[0]).toMatchObject({ code: GONGDAO_EXHAUSTED });
    expect((frames[0] as { balance?: number }).balance).toBeUndefined();
  });

  it('正对照：别的错误照旧，没有凭空多出 balance', async () => {
    const frames = await respondWith({ ok: false, error_code: 'AGENT_FAILED', message: 'y' }, 500);
    expect(frames[0]).toMatchObject({ type: 'error', code: 'AGENT_FAILED' });
    expect((frames[0] as { balance?: number }).balance).toBeUndefined();
  });
});
