// app/src/app/api/v1/evidence/upload/__tests__/token-flow.test.ts
// 一次性上传地址整条链的判据：evidence_upload_url（MCP）→ PUT 字节 → evidence_register（MCP）
// → evidence_attest（MCP）→ attest_verify（MCP）。
//
// 判据盯的是**闸在哪一步之前生效**，不只是返回码：未实名、超档、token 重用这三档，
// 判完之后盘上与库里都必须一个字节都不多——闸挪到落盘之后，返回码可能还对，文件却已经进了盘。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// 必须在任何加解密/建库调用之前就位
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-upload-token-${crypto.randomUUID()}.db`);
process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-upload-token-files-'));

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';
import { getCapability } from '@/lib/capabilities';
import type { Identity } from '@/lib/auth/identity';
import { setBriefGenerator } from '@/lib/evidence/brief';
import {
  MAX_AUDIO_UPLOAD_BYTES,
  MAX_UPLOAD_BYTES,
  MAX_VIDEO_UPLOAD_BYTES,
  maxUploadBytesFor,
  tryAcquireUploadSlot,
  UPLOAD_MEMORY_BUDGET_BYTES,
} from '@/lib/evidence/upload-guard';
import { claimUploadToken, UPLOAD_TOKEN_TTL_MS } from '@/lib/evidence/upload-token';

let put: (req: Request, ctx: { params: Promise<{ token: string }> }) => Promise<Response>;
let db: Database;
let userA: number;
let userNoRealname: number;
let caseA: number;
let caseNoRealname: number;

const FILES_DIR = process.env.FILES_DIR as string;

beforeAll(async () => {
  put = (await import('../[token]/route')).PUT;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of [
    'evidence_upload_tokens', 'attestations', 'agent_writes', 'evidence', 'files',
    'api_keys', 'cases', 'users',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  for (const entry of fs.readdirSync(FILES_DIR)) {
    fs.rmSync(path.join(FILES_DIR, entry), { recursive: true, force: true });
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, ?, '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`, '已实名').lastInsertRowid);
  userNoRealname = Number(insertUser.run(`b-${crypto.randomUUID()}`, '未认证').lastInsertRowid);
  const insertCase = db.prepare(
    "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, ?, '风声', '2026-08-19T00:00:00.000Z')",
  );
  caseA = Number(insertCase.run(userA, '甲的案子').lastInsertRowid);
  caseNoRealname = Number(insertCase.run(userNoRealname, '乙的案子').lastInsertRowid);
  setBriefGenerator(null);
});

afterEach(() => {
  vi.unstubAllGlobals();
  setBriefGenerator(null);
});

// ---------- 小工具 ----------

function identity(uid: number): Identity {
  // via jwt：网页登录态没有 key_id，agent_writes.key_id 落 NULL，
  // 免得为了造一行台账再去造一把 key（key_id 有外键指向 api_keys）
  return { uid, via: 'jwt', scopes: ['case:read', 'case:write'] };
}

/** 直接跑能力（MCP 工具与它是同一个 run，路由那层只做鉴权与包壳） */
async function call(name: string, uid: number, args: Record<string, unknown>) {
  const cap = getCapability(name);
  if (!cap) throw new Error(`没有这个能力：${name}`);
  return (await cap.run(db, identity(uid), args)) as Record<string, unknown>;
}

function putRequest(token: string, bytes: Buffer, uid = userA, contentLength?: number): [Request, { params: Promise<{ token: string }> }] {
  const headers: Record<string, string> = { authorization: `Bearer ${signToken(uid)}` };
  if (contentLength !== undefined) headers['content-length'] = String(contentLength);
  const req = new Request(`http://localhost/api/v1/evidence/upload/${token}`, {
    method: 'PUT',
    headers,
    body: new Uint8Array(bytes),
  });
  return [req, { params: Promise.resolve({ token }) }];
}

function countFilesOnDisk(): number {
  let n = 0;
  for (const dir of fs.readdirSync(FILES_DIR)) {
    const full = path.join(FILES_DIR, dir);
    if (fs.statSync(full).isDirectory()) n += fs.readdirSync(full).length;
  }
  return n;
}

function expectNothingLanded() {
  expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
  expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 0 });
  expect(countFilesOnDisk()).toBe(0);
}

/** 走完「签发 → PUT」两步，返回 token */
async function uploadedToken(bytes: Buffer, mime = 'image/jpeg', filename = '解除通知.jpg') {
  const issued = await call('evidence_upload_url', userA, {
    case_id: caseA,
    filename,
    mime,
    size: bytes.length,
  });
  expect(issued.ok).toBe(true);
  const token = issued.upload_token as string;
  const res = await put(...putRequest(token, bytes));
  expect(res.status).toBe(201);
  return token;
}

// ---------- 1. token 的一次性与有效期 ----------

describe('一次性上传地址：一次性与 10 分钟有效期', () => {
  test('签发的有效期正好是 10 分钟', async () => {
    const before = Date.now();
    const issued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: '录音.m4a',
      mime: 'audio/m4a',
      size: 1024,
    });
    expect(UPLOAD_TOKEN_TTL_MS).toBe(10 * 60 * 1000);
    const expires = new Date(`${(issued.expires_at as string).replace(' ', 'T')}Z`).getTime();
    // 允许一秒的取整误差（canonical 串是秒精度）
    expect(expires - before).toBeGreaterThanOrEqual(10 * 60 * 1000 - 1500);
    expect(expires - before).toBeLessThanOrEqual(10 * 60 * 1000 + 1500);
  });

  /**
   * 🔴 变异臂「token 可重用」：把 upload-token.ts 的 claimUploadToken 改成不带
   * `AND consumed_at IS NULL`（或改成 UPDATE 之前先查一次），这条会翻红。
   */
  test('同一个 token 只收一次文件：第二次 409，且盘上不多一份', async () => {
    const token = await uploadedToken(Buffer.from('第一份'));
    expect(countFilesOnDisk()).toBe(1);

    const again = await put(...putRequest(token, Buffer.from('第二份完全不同的内容')));
    expect(again.status).toBe(409);
    const body = await again.json();
    expect(body.error_code).toBe('UPLOAD_TOKEN_USED');
    expect(body.message).toContain('用过');
    // 零落盘：被拒的那一份不该留下文件，也不该多一行 files
    expect(countFilesOnDisk()).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 1 });
  });

  /**
   * 🔴 变异臂「token 可重用」的正主：把 claimUploadToken 里的 `AND consumed_at IS NULL`
   * 删掉（或改成先查再写），这两条会翻红——上面那条 409 由**抢占之前**的只读预检拦下，
   * 删掉抢占条件它照样绿，所以一次性不能只靠那一条钉。
   */
  test('抢占本身是一次性的：同一个 token 抢第二次必须落空', async () => {
    const issued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 8,
    });
    const token = issued.upload_token as string;
    expect(claimUploadToken(db, token)).not.toBeNull();
    expect(claimUploadToken(db, token)).toBeNull();
  });

  test('两个 PUT 同时到：只有一个成功，盘上只有一份', async () => {
    const issued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 64,
    });
    const token = issued.upload_token as string;
    // 两份内容不同，落盘两次就是两个哈希、两个文件——数得出来
    const [r1, r2] = await Promise.all([
      put(...putRequest(token, Buffer.from('并发的第一份'))),
      put(...putRequest(token, Buffer.from('并发的第二份'))),
    ]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([201, 409]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 1 });
    expect(countFilesOnDisk()).toBe(1);
  });

  test('过期的 token 一律 410，且零落盘', async () => {
    const issued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: '录音.m4a',
      mime: 'audio/m4a',
      size: 16,
    });
    const token = issued.upload_token as string;
    // 把有效期改到过去：等 10 分钟不是判据，能不能拒才是
    db.prepare("UPDATE evidence_upload_tokens SET expires_at = '2020-01-01 00:00:00'").run();

    const res = await put(...putRequest(token, Buffer.from('迟到的字节')));
    expect(res.status).toBe(410);
    expect((await res.json()).error_code).toBe('UPLOAD_TOKEN_EXPIRED');
    expectNothingLanded();
  });

  test('别人的 token 与不存在的 token 回同一个 404（不可分辨）', async () => {
    const issued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 8,
    });
    const mine = await put(...putRequest(issued.upload_token as string, Buffer.from('x'), userNoRealname));
    // 未实名的人连 token 有效性都走不到（实名闸在前），这里换一个已实名但不是主人的账号
    expect(mine.status).toBe(403);

    const otherOwner = Number(
      db
        .prepare(
          "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '已实名', '2026-08-19T00:00:00.000Z')",
        )
        .run(`c-${crypto.randomUUID()}`).lastInsertRowid,
    );
    const stolen = await put(...putRequest(issued.upload_token as string, Buffer.from('x'), otherOwner));
    const ghost = await put(...putRequest('0'.repeat(32), Buffer.from('x'), otherOwner));
    expect(stolen.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(await stolen.json()).toEqual(await ghost.json());
    expectNothingLanded();
  });
});

// ---------- 2. 体积闸分档 ----------

describe('体积闸按 mime 分档', () => {
  /**
   * 🔴 变异臂「video 走 25MB 闸」：把 maxUploadBytesFor 里 video 那一档删掉
   * （或改成返回 MAX_UPLOAD_BYTES），这一组会翻红。
   */
  test('分档函数：图片/PDF 25MB、音频 100MB、视频 100MB，认不出的走最严那档', () => {
    expect(maxUploadBytesFor('image/jpeg')).toBe(MAX_UPLOAD_BYTES);
    expect(maxUploadBytesFor('application/pdf')).toBe(MAX_UPLOAD_BYTES);
    expect(maxUploadBytesFor('audio/m4a')).toBe(MAX_AUDIO_UPLOAD_BYTES);
    expect(maxUploadBytesFor('video/mp4')).toBe(MAX_VIDEO_UPLOAD_BYTES);
    // 带参数的头要先切分号；大小写也不该影响
    expect(maxUploadBytesFor('VIDEO/QUICKTIME; codecs=avc1')).toBe(MAX_VIDEO_UPLOAD_BYTES);
    expect(maxUploadBytesFor(null)).toBe(MAX_UPLOAD_BYTES);
    expect(maxUploadBytesFor('application/octet-stream')).toBe(MAX_UPLOAD_BYTES);
    // 媒体两档（音频、视频）现在同为 100 MiB（视频从 200 收到 100），但都必须严格大于
    // 25 MiB 的基础档，否则上面几条在"全都是 25MB"时也会绿。
    expect(MAX_UPLOAD_BYTES).toBeLessThan(MAX_AUDIO_UPLOAD_BYTES);
    expect(MAX_UPLOAD_BYTES).toBeLessThan(MAX_VIDEO_UPLOAD_BYTES);
  });

  test('签发这一步就按档位拒：图片报 30MB 被拒，视频报 100MB 放行', async () => {
    const tooBig = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: '扫描件.png',
      mime: 'image/png',
      size: 30 * 1024 * 1024,
    });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.errorCode).toBe('FILE_TOO_LARGE');
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence_upload_tokens').get()).toEqual({ n: 0 });

    const okVideo = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: '谈话录像.mp4',
      mime: 'video/mp4',
      size: 100 * 1024 * 1024,
    });
    expect(okVideo.ok).toBe(true);
    expect(okVideo.max_bytes).toBe(MAX_VIDEO_UPLOAD_BYTES);
  });

  test('PUT 超档：413，且请求体根本没被读进内存、盘上零文件', async () => {
    const issued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: '扫描件.png',
      mime: 'image/png',
      size: 1024,
    });
    const token = issued.upload_token as string;

    const explode = vi.fn(async () => {
      throw new Error('arrayBuffer() 不该被调用——体积闸必须在读请求体之前生效');
    });
    const req = new Request(`http://localhost/api/v1/evidence/upload/${token}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${signToken(userA)}`,
        'content-length': String(MAX_UPLOAD_BYTES + 1),
      },
      body: 'x',
    });
    Object.defineProperty(req, 'arrayBuffer', { value: explode });

    const res = await put(req, { params: Promise.resolve({ token }) });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error_code).toBe('FILE_TOO_LARGE');
    expect(body.message).toContain('25 MB');
    expect(explode).not.toHaveBeenCalled();
    expectNothingLanded();
    // 超档不消耗 token：拒的是这次请求，不是这条地址
    const row = db.prepare('SELECT consumed_at FROM evidence_upload_tokens').get() as {
      consumed_at: string | null;
    };
    expect(row.consumed_at).toBeNull();
  });

  test('video token：字面 101MB PUT ⇒ 413（体积闸），字面 100MB 放行落盘', async () => {
    // ⚠️ 用**字面字节数**而非 MAX_VIDEO_UPLOAD_BYTES±1：后者随常量浮动，把常量改回 200MB 也照样绿，
    // 等于没咬住「视频档 = 100MB」这件事。变异臂：常量改回 200MB ⇒ 字面 101MB 落进限内 ⇒ 第一段不再 413 ⇒ 红；
    // 常量收到 100MB 以下 ⇒ 字面 100MB 那次 ⇒ 413 ⇒ 第二段红。
    const MB = 1024 * 1024;
    const overIssued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: '谈话录像.mp4',
      mime: 'video/mp4',
      size: 1024,
    });
    const overToken = overIssued.upload_token as string;
    const explode = vi.fn(async () => {
      throw new Error('arrayBuffer() 不该被调用——体积闸必须在读请求体之前生效');
    });
    const overReq = new Request(`http://localhost/api/v1/evidence/upload/${overToken}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${signToken(userA)}`,
        'content-length': String(101 * MB),
      },
      body: 'x',
    });
    Object.defineProperty(overReq, 'arrayBuffer', { value: explode });
    const overRes = await put(overReq, { params: Promise.resolve({ token: overToken }) });
    expect(overRes.status).toBe(413);
    expect((await overRes.json()).error_code).toBe('FILE_TOO_LARGE');
    expect(explode).not.toHaveBeenCalled();

    // 字面 100MB（= 视频档上限）：体积闸放行，字节真正落盘、返回 201
    const okIssued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: '谈话录像2.mp4',
      mime: 'video/mp4',
      size: 1024,
    });
    const okToken = okIssued.upload_token as string;
    const okReq = new Request(`http://localhost/api/v1/evidence/upload/${okToken}`, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${signToken(userA)}`,
        'content-length': String(100 * MB),
      },
      body: 'video-bytes',
    });
    const okRes = await put(okReq, { params: Promise.resolve({ token: okToken }) });
    expect(okRes.status).toBe(201);
  });

  test('内存预算：大文件独占，队列非空时挤不进来', () => {
    const small = tryAcquireUploadSlot(MAX_UPLOAD_BYTES);
    expect(small).not.toBeNull();
    // 一个 100MB 视频要的副本占满整份预算（100×6=600MB），队列非空时必须被拒
    expect(tryAcquireUploadSlot(MAX_VIDEO_UPLOAD_BYTES)).toBeNull();
    small!();
    // 队列空了则放行（否则这一档等于没开）
    const big = tryAcquireUploadSlot(MAX_VIDEO_UPLOAD_BYTES);
    expect(big).not.toBeNull();
    // 它在跑的时候，别人一律排不进来
    expect(tryAcquireUploadSlot(1024)).toBeNull();
    big!();
    // 一个满档视频的副本（video×6）至少占满整份预算 ⇒ 它一进来别人就挤不动。
    // 视频收到 100MiB 后二者恰好相等（100×6 = 25×6×4 = 600MB），故用 ≤。
    expect(UPLOAD_MEMORY_BUDGET_BYTES).toBeLessThanOrEqual(MAX_VIDEO_UPLOAD_BYTES * 6);
  });
});

// ---------- 3. 实名闸 ----------

describe('实名闸', () => {
  test('未实名 PUT：403 REALNAME_REQUIRED，且零落盘', async () => {
    // 先用已实名账号签一条自己的 token，证明被拒的原因是实名而不是 token
    const issued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 8,
    });
    const res = await put(...putRequest(issued.upload_token as string, Buffer.from('字节'), userNoRealname));
    expect(res.status).toBe(403);
    expect((await res.json()).error_code).toBe('REALNAME_REQUIRED');
    expectNothingLanded();
  });

  test('三条写能力都声明了实名前置（MCP 那层据此统一拦）', () => {
    for (const name of ['evidence_upload_url', 'evidence_register', 'evidence_attest']) {
      expect(getCapability(name)?.precondition, name).toContain('realname');
    }
    // 核验是公开只读，不该挂实名前置
    expect(getCapability('attest_verify')?.precondition).toEqual([]);
  });

  test('未实名调 evidence_upload_url：连 token 都不签发', async () => {
    // 能力层本身不判实名（判定在 MCP 路由，由 precondition 驱动），
    // 所以这里直接钉住"未实名的人走完整条 MCP 路由拿不到 token"——见 api/mcp/route.ts。
    const { POST } = await import('@/app/api/mcp/route');
    const key = generateApiKey();
    db.prepare(
      "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
    ).run(userNoRealname, hashApiKey(key), JSON.stringify(['case:read', 'case:write']));

    const res = await POST(
      new Request('http://localhost/api/mcp', {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-06-18',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'evidence_upload_url',
            arguments: { case_id: caseNoRealname, filename: 'a.jpg', mime: 'image/jpeg', size: 8 },
          },
        }),
      }),
    );
    const payload = await res.json();
    expect(payload.result.isError).toBe(true);
    expect(JSON.stringify(payload.result)).toContain('REALNAME_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence_upload_tokens').get()).toEqual({ n: 0 });
  });
});

// ---------- 4. 登记 ----------

describe('evidence_register', () => {
  test('登记出条目；同一 client_ref 重放回 deduped，不多一条', async () => {
    const token = await uploadedToken(Buffer.from('解除通知的内容'));
    const first = await call('evidence_register', userA, {
      case_id: caseA,
      upload_token: token,
      name: '解除通知书',
      category: '公司文件',
      prove_purpose: '证明公司单方解除',
      original_medium: '手机拍照',
      client_ref: 'ref-1',
    });
    expect(first.ok).toBe(true);
    expect(first.deduped).toBe(false);
    const evidenceId = (first.evidence as { id: number }).id;

    const replay = await call('evidence_register', userA, {
      case_id: caseA,
      upload_token: token,
      name: '解除通知书',
      category: '公司文件',
      client_ref: 'ref-1',
    });
    expect(replay.ok).toBe(true);
    expect(replay.deduped).toBe(true);
    expect(replay.id).toBe(evidenceId);
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 });
  });

  test('没带 client_ref 的第二次登记被自然键挡住（一份上传只登记一条）', async () => {
    const token = await uploadedToken(Buffer.from('另一份内容'));
    const first = await call('evidence_register', userA, { case_id: caseA, upload_token: token, name: '一' });
    expect(first.ok).toBe(true);
    const second = await call('evidence_register', userA, { case_id: caseA, upload_token: token, name: '二' });
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('ALREADY_REGISTERED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 1 });
  });

  test('字节还没传就登记：409 UPLOAD_NOT_FINISHED', async () => {
    const issued = await call('evidence_upload_url', userA, {
      case_id: caseA,
      filename: 'a.jpg',
      mime: 'image/jpeg',
      size: 8,
    });
    const res = await call('evidence_register', userA, {
      case_id: caseA,
      upload_token: issued.upload_token,
      name: '还没传',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('UPLOAD_NOT_FINISHED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 0 });
  });

  test('分类不在词表里：拒收，不落库', async () => {
    const token = await uploadedToken(Buffer.from('内容三'));
    const res = await call('evidence_register', userA, {
      case_id: caseA,
      upload_token: token,
      name: '随便',
      category: '不存在的分类',
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_CATEGORY');
    expect(db.prepare('SELECT COUNT(*) AS n FROM evidence').get()).toEqual({ n: 0 });
  });
});
