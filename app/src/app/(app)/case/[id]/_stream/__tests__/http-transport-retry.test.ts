/**
 * 真端点这一段：`retryOf` 必须写进请求体的 `retry_of`（数字），不然服务端把重试
 * 当成一条新消息——档案里那句问话就多出一份（naive-qa-2 F-203 的后半段）。
 *
 * 单独一个文件，是因为同目录 failed-turn-retry 那组把 httpTransport 整个换成了替身，
 * 而这里要验的正是**真的那一份**。
 *
 * 【变异臂】
 *  · M-C3 body 里去掉 retry_of ⇒ 第一条红
 *  · M-C4 retry_of 传字符串（不 Number()）⇒ 第一条红（服务端按 Number.isInteger 判 400）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/auth', () => ({ readToken: () => 'jwt-token', TOKEN_STORAGE_KEY: 'k' }));

const { createHttpTransport } = await import('../httpTransport');

const calls: { body: Record<string, unknown> }[] = [];

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
    calls.push({ body: JSON.parse(String(init.body)) });
    // 非 event-stream ⇒ 归一成一帧 error 就返回，本组不验收帧
    return new Response('{"ok":false,"error_code":"X","message":"y"}', {
      status: 500,
      headers: { 'content-type': 'application/json' },
    });
  });
});

async function post(req: { message: string; mode?: string; retryOf?: string }) {
  const send = createHttpTransport().send({
    caseId: '9',
    signal: new AbortController().signal,
    ...req,
  });
  for await (const frame of send) void frame;
}

describe('POST body', () => {
  it('★带 retryOf ⇒ body 里是 retry_of 数字，message 仍在（服务端不看它，但不许缺字段）', async () => {
    await post({ message: '', retryOf: '77' });
    expect(calls[0].body).toEqual({ message: '', retry_of: 77 });
  });

  /** 反向对照：正常发消息时不许凭空多出一个 retry_of（那会被当成重试，插不进用户行） */
  it('普通发送 ⇒ body 里没有 retry_of', async () => {
    await post({ message: 'HR 让我今天签字。' });
    expect(calls[0].body).toEqual({ message: 'HR 让我今天签字。' });
  });

  it('带 mode 时三个字段并存', async () => {
    await post({ message: '在吗', mode: '陪跑', retryOf: '5' });
    expect(calls[0].body).toEqual({ message: '在吗', mode: '陪跑', retry_of: 5 });
  });
});
