// app/src/app/api/v1/realname/passport/__tests__/upload-guard.test.ts
// 护照实名路由的两道内存闸门。判据与证据路由那套（evidence/__tests__/upload-guard.test.ts）
// 逐条镜像，因为两条路打的是同一块进程内存、用的是同一个信号量：
//   ① 体积闸必须在 req.formData() **之前**生效——用会炸的 formData 桩证明它根本没被调用；
//   ② 槽位占满时第 5 个请求立即 429，且不留下半条流水；
//   ③ 槽位来自 lib/evidence/upload-guard 那**同一个**池——本文件持有的 4 个槽是从那里取的，
//      如果护照路由自己另开一个池，持满这 4 个不会让它 429，这条就会绿着放它过去。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// 必须在任何加解密/建库调用之前就位
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-passport-guard-${crypto.randomUUID()}.db`);
process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-passport-guard-files-'));

import { signToken } from '@/lib/auth/jwt';
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_UPLOAD_BYTES,
  activeUploadCount,
  tryAcquireUploadSlot,
} from '@/lib/evidence/upload-guard';

let post: (req: Request) => Promise<Response>;
let db: Database;
let userA: number;

beforeAll(async () => {
  post = (await import('../route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of ['realname_verifications', 'evidence', 'files', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  userA = Number(
    db
      .prepare(
        "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '未认证', '2026-08-19T00:00:00.000Z')",
      )
      .run(`p-${crypto.randomUUID()}`).lastInsertRowid,
  );
});

/** 一份合法的护照实名表单：姓名 + 护照号 + 两件必填材料 */
function passportForm(materialBytes = 64): FormData {
  const form = new FormData();
  form.set('real_name', '张三');
  form.set('passport_no', 'E12345678');
  form.set('id_page', new File([new Uint8Array(materialBytes)], 'page.jpg', { type: 'image/jpeg' }));
  form.set('selfie', new File([new Uint8Array(materialBytes)], 'selfie.jpg', { type: 'image/jpeg' }));
  return form;
}

function passportRequest(): Request {
  return new Request('http://localhost/api/v1/realname/passport', {
    method: 'POST',
    headers: { authorization: `Bearer ${signToken(userA)}` },
    body: passportForm(),
  });
}

/** 待审流水条数——被闸挡下时必须仍是 0 */
function verificationCount(): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM realname_verifications').get() as { n: number }).n;
}

describe('体积闸', () => {
  test('Content-Length 超上限：413，且请求体根本没被读进内存', async () => {
    const explode = vi.fn(async () => {
      throw new Error('formData() 不该被调用——体积闸必须在读请求体之前生效');
    });
    const req = new Request('http://localhost/api/v1/realname/passport', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signToken(userA)}`,
        'content-length': String(MAX_UPLOAD_BYTES + 1),
      },
      body: 'x',
    });
    Object.defineProperty(req, 'formData', { value: explode });

    const res = await post(req);
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error_code).toBe('FILE_TOO_LARGE');
    // 自述三段式：超了多少 / 为什么不放行 / 该怎么办
    expect(body.message).toContain('25 MB');
    expect(body.message).toContain('内存');
    expect(body.message).toContain('8MB');
    expect(explode).not.toHaveBeenCalled();
    expect(verificationCount()).toBe(0);
    // 挡在闸一的请求没占过槽位
    expect(activeUploadCount()).toBe(0);
  });

  test('Content-Length 在上限内：放行并落一条待审流水', async () => {
    const res = await post(passportRequest());
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.auth_status).toBe('待审');
    expect(verificationCount()).toBe(1);
    // 路由用完必须把槽位还回来，否则跑几次就永久 429
    expect(activeUploadCount()).toBe(0);
  });
});

describe('并发闸', () => {
  test('槽位占满时第 5 个请求立即 429，释放后恢复', async () => {
    const held = Array.from({ length: MAX_CONCURRENT_UPLOADS }, () => tryAcquireUploadSlot());
    expect(held.every((r) => r !== null)).toBe(true);
    expect(activeUploadCount()).toBe(MAX_CONCURRENT_UPLOADS);

    const busy = await post(passportRequest());
    expect(busy.status).toBe(429);
    const body = await busy.json();
    expect(body.error_code).toBe('UPLOAD_BUSY');
    // 自述三段式：受理不了 / 为什么不排队 / 该怎么办
    expect(body.message).toContain('上限');
    expect(body.message).toContain('内存');
    expect(body.message).toContain('重新提交');
    // 不排队 = 被拒的请求不占槽位，也不留痕
    expect(activeUploadCount()).toBe(MAX_CONCURRENT_UPLOADS);
    expect(verificationCount()).toBe(0);

    for (const release of held) release!();
    expect(activeUploadCount()).toBe(0);

    const ok = await post(passportRequest());
    expect(ok.status).toBe(201);
    expect(activeUploadCount()).toBe(0);
  });

  test('在办的护照提交占的是与证据同一个池的槽位', async () => {
    // 先占掉 4 个里的 3 个，只留一个空位给下面这条护照请求
    const held = Array.from({ length: MAX_CONCURRENT_UPLOADS - 1 }, () => tryAcquireUploadSlot());
    expect(activeUploadCount()).toBe(MAX_CONCURRENT_UPLOADS - 1);

    // 把 formData() 卡在半路，好在「请求正在办」这一刻观察计数
    let unblock!: () => void;
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const form = passportForm();
    const inflight = post({
      headers: new Headers({ authorization: `Bearer ${signToken(userA)}` }),
      formData: async () => {
        await gate;
        return form;
      },
    } as unknown as Request);

    // 让上面那条请求跑到 await formData()
    await Promise.resolve();
    // 它必须已经从**共享**池里拿走了第 4 个槽：另开一个池的话这里还是 3
    expect(activeUploadCount()).toBe(MAX_CONCURRENT_UPLOADS);
    // 池满了，此刻再来一条护照提交只能 429
    expect((await post(passportRequest())).status).toBe(429);

    unblock();
    expect((await inflight).status).toBe(201);
    for (const release of held) release!();
    expect(activeUploadCount()).toBe(0);
  });

  test('失败路径也归还槽位', async () => {
    const bad = new Request('http://localhost/api/v1/realname/passport', {
      method: 'POST',
      headers: { authorization: `Bearer ${signToken(userA)}` },
      body: 'not-a-multipart-body',
    });
    expect((await post(bad)).status).toBe(400);
    expect(activeUploadCount()).toBe(0);
  });

  test('领域层拒绝（材料缺失）也归还槽位', async () => {
    const form = new FormData();
    form.set('real_name', '张三');
    form.set('passport_no', 'E12345678');
    const res = await post(
      new Request('http://localhost/api/v1/realname/passport', {
        method: 'POST',
        headers: { authorization: `Bearer ${signToken(userA)}` },
        body: form,
      }),
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error_code).toBe('MISSING_MATERIAL');
    expect(activeUploadCount()).toBe(0);
  });
});
