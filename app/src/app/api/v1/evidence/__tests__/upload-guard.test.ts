// app/src/app/api/v1/evidence/__tests__/upload-guard.test.ts
// 上传路由的两道内存闸门。判据盯的是「闸在哪一步之前生效」，不只是「返回了什么码」：
// 体积闸如果挪到 req.formData() 之后，请求体已经进内存，闸就白设了——所以这里用
// 一个会炸的 formData 桩来证明它根本没被调用。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// 必须在任何加解密/建库调用之前就位
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-upload-guard-${crypto.randomUUID()}.db`);
process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-upload-guard-files-'));

import { signToken } from '@/lib/auth/jwt';
import {
  MAX_CONCURRENT_UPLOADS,
  MAX_UPLOAD_BYTES,
  activeUploadCount,
  parseContentLength,
  tryAcquireUploadSlot,
} from '@/lib/evidence/upload-guard';

let post: (req: Request) => Promise<Response>;
let db: Database;
let userA: number;
let caseA: number;

beforeAll(async () => {
  post = (await import('../route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of ['evidence', 'files', 'cases', 'users']) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  // 体积/并发闸这几组要的是「文件真的走到读请求体那一步」，所以 userA 必须已实名——
  // 上传前置的实名闸（见 route.ts）会把未实名的人在读请求体之前就挡掉。实名闸本身
  // 由下面「实名闸」那一组单独钉。
  userA = Number(
    db
      .prepare(
        "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '已实名', '2026-08-19T00:00:00.000Z')",
      )
      .run(`a-${crypto.randomUUID()}`).lastInsertRowid,
  );
  caseA = Number(
    db
      .prepare(
        "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '甲的案子', '风声', '2026-08-19T00:00:00.000Z')",
      )
      .run(userA).lastInsertRowid,
  );
});

/** 正常的 multipart 上传请求 */
function uploadRequest(sizeBytes = 16): Request {
  const form = new FormData();
  form.set('file', new File([new Uint8Array(sizeBytes)], '解除通知.jpg', { type: 'image/jpeg' }));
  form.set('case_id', String(caseA));
  return new Request('http://localhost/api/v1/evidence', {
    method: 'POST',
    headers: { authorization: `Bearer ${signToken(userA)}` },
    body: form,
  });
}

/**
 * 不带 Content-Length 的请求（真实世界里是 chunked 传输）。
 * undici 的 Request 只要给了 body 就会算出长度，构造不出这种情况，所以直接搭一个
 * 只有路由用得到的两个成员的壳：requireIdentity 读 headers，路由读 formData。
 */
function chunkedRequest(file: File): Request {
  const form = new FormData();
  form.set('file', file);
  form.set('case_id', String(caseA));
  return {
    headers: new Headers({ authorization: `Bearer ${signToken(userA)}` }),
    formData: async () => form,
  } as unknown as Request;
}

describe('体积闸', () => {
  test('Content-Length 超上限：413，且请求体根本没被读进内存', async () => {
    const explode = vi.fn(async () => {
      throw new Error('formData() 不该被调用——体积闸必须在读请求体之前生效');
    });
    const req = new Request('http://localhost/api/v1/evidence', {
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
    expect(body.message).toContain('压缩');
    expect(explode).not.toHaveBeenCalled();
  });

  test('Content-Length 在上限内：放行并落库', async () => {
    const res = await post(uploadRequest());
    expect(res.status).toBe(201);
    expect((await res.json()).evidence.name).toBe('解除通知.jpg');
  });

  test('没有 Content-Length 时由后备闸按真实文件大小拦下', async () => {
    const big = new File([new Uint8Array(MAX_UPLOAD_BYTES + 1)], 'big.wav', { type: 'audio/wav' });
    const res = await post(chunkedRequest(big));
    expect(res.status).toBe(413);
    expect((await res.json()).error_code).toBe('FILE_TOO_LARGE');
    // 拦下了就不该留下任何痕迹
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 0 });
  });

  test('parseContentLength：只认十进制非负整数，其余交给后备闸', () => {
    expect(parseContentLength('0')).toBe(0);
    expect(parseContentLength(' 1024 ')).toBe(1024);
    expect(parseContentLength(null)).toBeNull();
    expect(parseContentLength('')).toBeNull();
    expect(parseContentLength('-1')).toBeNull();
    expect(parseContentLength('1.5')).toBeNull();
    expect(parseContentLength('99999999999999999999')).toBeNull();
  });
});

describe('并发闸', () => {
  test('槽位占满时第 5 个请求立即 429，释放后恢复', async () => {
    const held = Array.from({ length: MAX_CONCURRENT_UPLOADS }, () => tryAcquireUploadSlot());
    expect(held.every((r) => r !== null)).toBe(true);
    expect(activeUploadCount()).toBe(MAX_CONCURRENT_UPLOADS);

    const busy = await post(uploadRequest());
    expect(busy.status).toBe(429);
    const body = await busy.json();
    expect(body.error_code).toBe('UPLOAD_BUSY');
    // 自述三段式：受理不了 / 为什么不排队 / 该怎么办
    expect(body.message).toContain('上限');
    expect(body.message).toContain('内存');
    expect(body.message).toContain('重新点一次上传');
    // 不排队 = 被拒的请求不占槽位
    expect(activeUploadCount()).toBe(MAX_CONCURRENT_UPLOADS);
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 0 });

    for (const release of held) release!();
    expect(activeUploadCount()).toBe(0);

    const ok = await post(uploadRequest());
    expect(ok.status).toBe(201);
    // 路由用完必须把槽位还回来，否则跑几次就永久 429
    expect(activeUploadCount()).toBe(0);
  });

  test('失败路径也归还槽位', async () => {
    const bad = new Request('http://localhost/api/v1/evidence', {
      method: 'POST',
      headers: { authorization: `Bearer ${signToken(userA)}` },
      body: 'not-a-multipart-body',
    });
    expect((await post(bad)).status).toBe(400);
    expect(activeUploadCount()).toBe(0);
  });

  test('信号量本身：占满返回 null，重复释放不把计数放成负数', () => {
    const held = Array.from({ length: MAX_CONCURRENT_UPLOADS }, () => tryAcquireUploadSlot());
    expect(tryAcquireUploadSlot()).toBeNull();

    const first = held[0]!;
    first();
    first(); // 幂等：重复释放不再减
    expect(activeUploadCount()).toBe(MAX_CONCURRENT_UPLOADS - 1);

    const extra = tryAcquireUploadSlot();
    expect(extra).not.toBeNull();
    expect(activeUploadCount()).toBe(MAX_CONCURRENT_UPLOADS);

    extra!();
    for (const release of held) release?.();
    expect(activeUploadCount()).toBe(0);
  });
});

/**
 * 实名闸（前移到上传）。判据盯的不只是「返回了 403」，而是**未实名时一条记录、一个文件都不落**——
 * 闸若被挪到落库之后，返回码可能还对，证据却已经进了库/进了盘。
 *
 * 变异臂：把 route.ts 里的 requireRealname 那三行删掉，「未认证 ⇒ 403」这条会翻红
 *（未实名会一路走到 201 落库），这正是这道闸唯一的存在理由。
 */
describe('实名闸', () => {
  /** 建一个指定实名态的用户 + 他名下一个案子，返回可直接上传的请求 */
  function makeUserUpload(authStatus: '未认证' | '待审' | '已实名'): Request {
    const uid = Number(
      db
        .prepare(
          "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, ?, '2026-08-19T00:00:00.000Z')",
        )
        .run(`r-${crypto.randomUUID()}`, authStatus).lastInsertRowid,
    );
    const cid = Number(
      db
        .prepare(
          "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '证据案子', '风声', '2026-08-19T00:00:00.000Z')",
        )
        .run(uid).lastInsertRowid,
    );
    const form = new FormData();
    form.set('file', new File([new Uint8Array(16)], '解除通知.jpg', { type: 'image/jpeg' }));
    form.set('case_id', String(cid));
    return new Request('http://localhost/api/v1/evidence', {
      method: 'POST',
      headers: { authorization: `Bearer ${signToken(uid)}` },
      body: form,
    });
  }

  /** 递归数一个目录下的文件数，验证「零落盘」——落盘可能落进按哈希分的子目录 */
  function fileCount(dir: string): number {
    let n = 0;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      n += ent.isDirectory() ? fileCount(path.join(dir, ent.name)) : 1;
    }
    return n;
  }

  test('未认证上传：403 REALNAME_REQUIRED，且 evidence 零新增、文件零落盘', async () => {
    const filesBefore = fileCount(process.env.FILES_DIR!);
    const res = await post(makeUserUpload('未认证'));

    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error_code).toBe('REALNAME_REQUIRED');
    // 自述三段式：怎么了 / 为什么 / 怎么办
    expect(body.message).toContain('实名认证');
    expect(body.message).toContain('无法保存');
    expect(body.message).toContain('设置');

    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
    expect(fileCount(process.env.FILES_DIR!)).toBe(filesBefore);
  });

  test('待审与未认证同等对待：同样 403 REALNAME_REQUIRED，零落库', async () => {
    const res = await post(makeUserUpload('待审'));
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('REALNAME_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 0 });
  });

  test('已实名上传：照常 201 落库', async () => {
    const res = await post(makeUserUpload('已实名'));
    expect(res.status).toBe(201);
    expect((await res.json()).evidence.name).toBe('解除通知.jpg');
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 });
  });
});
