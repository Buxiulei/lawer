// app/src/app/api/v1/share/__tests__/share-export.test.ts
// 分享链接与文书导出整条链的判据（设计稿 §2 E）：
//   share_create（MCP）→ GET /api/v1/share/{token}（免登录）→ share_revoke（MCP）
//   draft_export（MCP）→ GET /api/v1/files/download/{token}（免登录、一次性）
//
// 判据盯的是**闸在哪一步生效**，不只是返回码：
//   · 未实名走完整条 MCP 路由 ⇒ REALNAME_REQUIRED，且库里一条链接/一份文件都不多；
//   · 链接到期 ⇒ 410（不是 404，也不是照常展示内容）；
//   · 别人的草稿 ⇒ 「不存在」，与「不是你的」不可分辨；
//   · 下载地址只发一次 ⇒ 第二次 410；
//   · 💰 动作报价不扣钱 ⇒ 不带 quote_id 那一步余额与账本行数逐字不变。
//     这一条**必须在非零单价下测**（见 withExportPrice）：单价是 0 时，
//     「报价即扣费」与「报价不扣费」的余额、账本、回包完全一样，判据在 0 上永远是绿的。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// 必须在任何加解密/建库调用之前就位
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-share-${crypto.randomUUID()}.db`);
process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-share-files-'));

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import type { Identity } from '@/lib/auth/identity';
import { getCapability } from '@/lib/capabilities';
import { gongdaoGrant } from '@/lib/billing';
import { ENTITLEMENT_KIND, grantEntitlement, listUnconsumed } from '@/lib/billing/entitlements';
import { quoteService } from '@/lib/billing/service-quotes';
import { claimDownloadToken } from '@/lib/files/download-token';
import { SHARE_MAX_HOURS } from '@/lib/shares';

let shareGet: (req: Request, ctx: { params: Promise<{ token: string }> }) => Promise<Response>;
let downloadGet: (req: Request, ctx: { params: Promise<{ token: string }> }) => Promise<Response>;
let mcpPost: (req: Request) => Promise<Response>;
let db: Database;
let userA: number;
let userB: number;
let userNoRealname: number;
let caseA: number;
let caseB: number;
let caseNoRealname: number;

const PDF_BYTES = Buffer.from('%PDF-1.4 假的导出件\n%%EOF');

beforeAll(async () => {
  shareGet = (await import('../[token]/route')).GET;
  downloadGet = (await import('../../files/download/[token]/route')).GET;
  mcpPost = (await import('@/app/api/mcp/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  for (const table of [
    'file_download_tokens', 'share_links', 'agent_writes', 'service_quotes', 'entitlements',
    'gongdao_ledger', 'gongdao', 'drafts', 'evidence', 'files', 'api_keys', 'cases', 'users',
  ]) {
    db.prepare(`DELETE FROM ${table}`).run();
  }
  const insertUser = db.prepare(
    "INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, ?, '2026-08-19T00:00:00.000Z')",
  );
  userA = Number(insertUser.run(`a-${crypto.randomUUID()}`, '已实名').lastInsertRowid);
  userB = Number(insertUser.run(`b-${crypto.randomUUID()}`, '已实名').lastInsertRowid);
  userNoRealname = Number(insertUser.run(`c-${crypto.randomUUID()}`, '未认证').lastInsertRowid);
  const insertCase = db.prepare(
    "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, ?, '风声', '2026-08-19T00:00:00.000Z')",
  );
  caseA = Number(insertCase.run(userA, '甲的案子').lastInsertRowid);
  caseB = Number(insertCase.run(userB, '乙的案子').lastInsertRowid);
  caseNoRealname = Number(insertCase.run(userNoRealname, '丙的案子').lastInsertRowid);

  // sidecar 全程 mock：这条链路的判据在闸与落库，不在 reportlab 渲得好不好
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/draft-pdf')) {
        return new Response(new Uint8Array(PDF_BYTES), { status: 200 });
      }
      throw new Error(`未预期的 sidecar 调用: ${url}`);
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------- 小工具 ----------

function identity(uid: number): Identity {
  return { uid, via: 'jwt', scopes: ['case:read', 'case:write'] };
}

/** 直接跑能力（MCP 工具与它是同一个 run，路由那层只做鉴权与包壳） */
async function call(name: string, uid: number, args: Record<string, unknown>) {
  const cap = getCapability(name);
  if (!cap) throw new Error(`没有这个能力：${name}`);
  return (await cap.run(db, identity(uid), args)) as Record<string, unknown>;
}

/** 走完整条 MCP 路由（前置闸只在这一层，直接跑 run 是绕过它的） */
async function viaMcp(uid: number, name: string, args: Record<string, unknown>) {
  const key = generateApiKey();
  db.prepare(
    "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-08-19T00:00:00.000Z')",
  ).run(uid, hashApiKey(key), JSON.stringify(['case:read', 'case:write']));
  const res = await mcpPost(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        'mcp-protocol-version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  return (await res.json()) as { result: { isError?: boolean; content: { text: string }[] } };
}

function makeDraft(caseId: number, title = '异议函', content = '致某某公司：本人对解除决定提出异议。') {
  return Number(
    db
      .prepare(
        `INSERT INTO drafts (case_id, kind, title, content, version, status, created_at, updated_at)
         VALUES (?, '异议函', ?, ?, 1, 'draft', '2026-08-19 00:00:00', '2026-08-19 00:00:00')`,
      )
      .run(caseId, title, content).lastInsertRowid,
  );
}

function makeEvidenceRow(caseId: number, uid: number) {
  const fileId = Number(
    db
      .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, 10, 'image/jpeg', 'ab/x.enc')")
      .run(crypto.randomUUID().replace(/-/g, '')).lastInsertRowid,
  );
  return Number(
    db
      .prepare(
        `INSERT INTO evidence (case_id, user_id, file_id, name, category, prove_purpose, original_medium)
         VALUES (?, ?, ?, '工资流水.pdf', '工资', '证明月工资标准', '银行导出')`,
      )
      .run(caseId, uid, fileId).lastInsertRowid,
  );
}

function getShare(token: string) {
  return shareGet(new Request(`http://localhost/api/v1/share/${token}`), {
    params: Promise.resolve({ token }),
  });
}

function getDownload(token: string) {
  return downloadGet(new Request(`http://localhost/api/v1/files/download/${token}`), {
    params: Promise.resolve({ token }),
  });
}

/** 把某条分享链接的到期点改到过去（不动别的列），造「已到期」这一态 */
function expireShare(shareId: number) {
  db.prepare("UPDATE share_links SET expires_at='2000-01-01 00:00:00' WHERE id=?").run(shareId);
}

/** 把某张报价的到期点改到过去（不动别的列），造「报价过期」这一态 */
function expireQuote(quoteId: number) {
  db.prepare("UPDATE service_quotes SET expires_at='2000-01-01 00:00:00' WHERE id=?").run(quoteId);
}

/**
 * 走完整两步导出：先报价，再带 quote_id 确认。
 * 【为什么要有这个小工具】盯别的东西（下载地址、文件名、券）的判据也得先走完两步。
 * 让每条判据各抄一遍两步的形态是：抄的那几份里哪天有人图省事只留了一步，
 * 判据照样绿——而它本该拦的正是"少了一步"。第一步就失败时原样把失败抛回去。
 */
async function exportTwoStep(uid: number, args: Record<string, unknown>) {
  const quoted = await call('draft_export', uid, args);
  if (quoted.ok !== true) return quoted;
  expect(quoted.stage).toBe('quote');
  return call('draft_export', uid, { ...args, quote_id: quoted.quote_id });
}

/** 当前公道值余额（没有那一行就是 0） */
function balanceOf(uid: number): number {
  const row = db.prepare('SELECT balance FROM gongdao WHERE user_id=?').get(uid) as
    | { balance: number }
    | undefined;
  return row?.balance ?? 0;
}

/** 把导出单价改成非零，跑完一段判据后恢复。0 元看不出差别的事，只有在这里面才看得见。 */
function withExportPrice(price: number, body: () => Promise<void>): Promise<void> {
  db.prepare('INSERT OR REPLACE INTO pricing_config (key, value_int) VALUES (?,?)').run(
    'draft_export.per_pdf',
    price,
  );
  return body().finally(() => {
    db.prepare("DELETE FROM pricing_config WHERE key='draft_export.per_pdf'").run();
  });
}

// ---------- 1. share_create ----------

describe('share_create', () => {
  test('分享一份文书：回链接与到期；免登录能读到正文', async () => {
    const draftId = makeDraft(caseA, '异议函', '致某某公司：本人对解除决定提出异议。');
    const created = await call('share_create', userA, { draft_id: draftId, expires_in: 24 });
    expect(created.ok).toBe(true);
    expect(created.token).toMatch(/^[0-9a-f]{32}$/);
    expect(created.url).toBe(`/s/${created.token}`);
    // 到期点是 canonical 串（ADR-002），不是 ISO
    expect(created.expires_at).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);

    const res = await getShare(created.token as string);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.share.kind).toBe('draft');
    expect(body.share.body).toContain('本人对解除决定提出异议');
  });

  test('分享一件材料：只给元数据与证明目的，回包里没有文件字节也没有存储路径', async () => {
    const evidenceId = makeEvidenceRow(caseA, userA);
    const created = await call('share_create', userA, { evidence_id: evidenceId });
    const body = await (await getShare(created.token as string)).json();
    expect(body.share.kind).toBe('evidence');
    expect(body.share.body).toBeNull();
    expect(body.share.meta['证明目的']).toBe('证明月工资标准');
    // 免登录页拿到文件字节/落盘路径就等于把原始材料公开了
    expect(JSON.stringify(body)).not.toContain('enc_path');
    expect(JSON.stringify(body)).not.toContain('.enc');
  });

  test('draft_id 与 evidence_id 都给或都不给一律 400，服务端不替用户挑一个', async () => {
    const draftId = makeDraft(caseA);
    const evidenceId = makeEvidenceRow(caseA, userA);
    for (const args of [{}, { draft_id: draftId, evidence_id: evidenceId }]) {
      const r = await call('share_create', userA, args);
      expect(r.ok).toBe(false);
      expect(r.errorCode).toBe('INVALID_SHARE_TARGET');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM share_links').get()).toEqual({ n: 0 });
  });

  test('有效期越界一律 400，且不签发（上限存在的意义就是它拦得住）', async () => {
    const draftId = makeDraft(caseA);
    for (const hours of [0, -1, SHARE_MAX_HOURS + 1, 1.5]) {
      const r = await call('share_create', userA, { draft_id: draftId, expires_in: hours });
      expect(r.ok, `expires_in=${hours}`).toBe(false);
      expect(r.errorCode).toBe('INVALID_EXPIRES_IN');
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM share_links').get()).toEqual({ n: 0 });
  });

  test('同一个 client_ref 重试不会签出第二条链接', async () => {
    const draftId = makeDraft(caseA);
    const first = await call('share_create', userA, { draft_id: draftId, client_ref: 'ref-1' });
    const again = await call('share_create', userA, { draft_id: draftId, client_ref: 'ref-1' });
    expect(again.deduped).toBe(true);
    expect(again.id).toBe(first.share_id);
    expect(db.prepare('SELECT COUNT(*) AS n FROM share_links').get()).toEqual({ n: 1 });
  });
});

// ---------- 2. 到期与撤销 ----------

describe('链接失效', () => {
  test('到期后 410 SHARE_EXPIRED，且正文一个字都不再回（变异：到期不拦 ⇒ 红）', async () => {
    const draftId = makeDraft(caseA, '异议函', '这句话到期之后不该再被任何人读到。');
    const created = await call('share_create', userA, { draft_id: draftId, expires_in: 1 });
    expect((await getShare(created.token as string)).status).toBe(200);

    expireShare(created.share_id as number);

    const res = await getShare(created.token as string);
    // 410 而不是 404：「这里曾经有东西、现在没了」，拿到链接的人据此去要一条新的
    expect(res.status).toBe(410);
    const text = await res.text();
    expect(text).toContain('SHARE_EXPIRED');
    expect(text).not.toContain('这句话到期之后不该再被任何人读到');
  });

  test('撤销后 410 SHARE_REVOKED；重复撤销幂等，首次撤销时点不变', async () => {
    const draftId = makeDraft(caseA);
    const created = await call('share_create', userA, { draft_id: draftId });

    const first = await call('share_revoke', userA, { share_id: created.share_id });
    expect(first.ok).toBe(true);
    expect(first.already_revoked).toBe(false);

    const res = await getShare(created.token as string);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('SHARE_REVOKED');

    const second = await call('share_revoke', userA, { share_id: created.share_id });
    expect(second.ok).toBe(true);
    expect(second.already_revoked).toBe(true);
    expect(second.revoked_at).toBe(first.revoked_at);
  });

  test('不存在的 token 是 404，不是 410（两者对拿到链接的人说的话不同）', async () => {
    const res = await getShare('0'.repeat(32));
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('SHARE_NOT_FOUND');
  });

  test('别人的链接撤不掉，且回「不存在」而不是「不是你的」', async () => {
    const draftId = makeDraft(caseA);
    const created = await call('share_create', userA, { draft_id: draftId });
    const r = await call('share_revoke', userB, { share_id: created.share_id });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('SHARE_NOT_FOUND');
    // 真的没撤：原链接还能打开
    expect((await getShare(created.token as string)).status).toBe(200);
  });
});

// ---------- 3. 归属 ----------

describe('别人的草稿/材料', () => {
  test('share_create 拿别人的 draft_id：DRAFT_NOT_FOUND，且不签发', async () => {
    const otherDraft = makeDraft(caseB, '乙的异议函');
    const r = await call('share_create', userA, { draft_id: otherDraft });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('DRAFT_NOT_FOUND');
    expect(db.prepare('SELECT COUNT(*) AS n FROM share_links').get()).toEqual({ n: 0 });
  });

  test('share_create 拿别人的 evidence_id：EVIDENCE_NOT_FOUND，且不签发', async () => {
    const otherEvidence = makeEvidenceRow(caseB, userB);
    const r = await call('share_create', userA, { evidence_id: otherEvidence });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('EVIDENCE_NOT_FOUND');
    expect(db.prepare('SELECT COUNT(*) AS n FROM share_links').get()).toEqual({ n: 0 });
  });

  test('draft_export 拿别人的 draft_id：DRAFT_NOT_FOUND，不渲染、不落文件、不落报价', async () => {
    const otherDraft = makeDraft(caseB, '乙的异议函');
    const r = await call('draft_export', userA, { draft_id: otherDraft });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('DRAFT_NOT_FOUND');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_quotes').get()).toEqual({ n: 0 });
  });
});

// ---------- 4. 实名闸 ----------

describe('实名闸（变异：去掉 precondition 里的 realname ⇒ 红）', () => {
  test('未实名走 MCP 调 share_create：REALNAME_REQUIRED，且一条链接都没签', async () => {
    const draftId = makeDraft(caseNoRealname);
    const payload = await viaMcp(userNoRealname, 'share_create', { draft_id: draftId });
    expect(payload.result.isError).toBe(true);
    expect(JSON.stringify(payload.result)).toContain('REALNAME_REQUIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM share_links').get()).toEqual({ n: 0 });
  });

  test('未实名走 MCP 调 draft_export：REALNAME_REQUIRED，不渲染也不落文件', async () => {
    const draftId = makeDraft(caseNoRealname);
    const payload = await viaMcp(userNoRealname, 'draft_export', { draft_id: draftId });
    expect(payload.result.isError).toBe(true);
    expect(JSON.stringify(payload.result)).toContain('REALNAME_REQUIRED');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
  });

  test('已实名的同一条调用能过（证明上面两条被拒的原因是实名，不是别的）', async () => {
    const draftId = makeDraft(caseA);
    const payload = await viaMcp(userA, 'share_create', { draft_id: draftId });
    expect(payload.result.isError).toBeFalsy();
    expect(db.prepare('SELECT COUNT(*) AS n FROM share_links').get()).toEqual({ n: 1 });
  });

  test('两条写能力都声明了实名前置；撤销刻意不挂（收回不该被前置挡住）', () => {
    for (const name of ['share_create', 'draft_export']) {
      expect(getCapability(name)?.precondition, name).toContain('realname');
    }
    expect(getCapability('share_revoke')?.precondition).toEqual([]);
  });
});

// ---------- 5. draft_export 的两步：报价 → 确认 ----------
//
// 这一组盯的不是返回码，是**钱在哪一步动**。今天单价是 0，一步式与两步式的回包长得一模一样，
// 所以每条"不扣钱"的判据都在 withExportPrice 里跑——把单价调成非零，
// 「报价那步动没动账」才第一次可见。设计稿 §4.2：所有 💰 工具两步。

describe('draft_export 两步报价', () => {
  test('不带 quote_id 只出价：不渲染、不落文件、不动账，那张报价停在未确认', async () => {
    const draftId = makeDraft(caseA, '关于解除决定的异议函');
    const q = await call('draft_export', userA, { draft_id: draftId });
    expect(q.ok).toBe(true);
    expect(q.stage).toBe('quote');
    expect(q.quote_id).toEqual(expect.any(Number));
    expect(q.price_key).toBe('draft_export.per_pdf');
    expect(q.unit_label).toBe('份');
    expect(q.units).toBe(1);
    // 报价单必须自带下一步怎么走，否则 agent 只会把它当一次失败重试
    expect(String(q.next)).toContain(`quote_id=${q.quote_id}`);
    // 出价这一步一个字节都不该渲染
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM file_download_tokens').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT confirmed_at FROM service_quotes').get()).toEqual({ confirmed_at: null });
  });

  test(
    '单价非零时，只报价那一步余额一分不少' +
      '（变异：报价后无条件 confirmService ⇒ 红）',
    async () => {
      await withExportPrice(30, async () => {
        gongdaoGrant(userA, 100, '管理员调整', 'test-grant-price', null, db);
        const before = balanceOf(userA);
        const draftId = makeDraft(caseA);

        const q = await call('draft_export', userA, { draft_id: draftId });
        expect(q.ok).toBe(true);
        expect(q.stage).toBe('quote');
        expect(q.amount).toBe(30);
        expect(q.unit_price).toBe(30);
        // 用户还没看见过这个价、更没点过头——余额与账本行数必须逐字不变
        expect(balanceOf(userA)).toBe(before);
        expect(
          db.prepare("SELECT COUNT(*) AS n FROM gongdao_ledger WHERE type='消耗'").get(),
        ).toEqual({ n: 0 });
        expect(vi.mocked(fetch)).not.toHaveBeenCalled();
      });
    },
  );

  test('单价非零时，带 quote_id 确认才扣，扣的正是报价单上那个数', async () => {
    await withExportPrice(30, async () => {
      gongdaoGrant(userA, 100, '管理员调整', 'test-grant-price', null, db);
      const draftId = makeDraft(caseA);
      const q = await call('draft_export', userA, { draft_id: draftId });
      const r = await call('draft_export', userA, { draft_id: draftId, quote_id: q.quote_id });

      expect(r.ok).toBe(true);
      expect(r.stage).toBe('done');
      // 确认时扣的价必须就是报价时报的价（价目中途被改也认报价单上那个数）
      expect(r.amount).toBe(q.amount);
      expect(r.charged).toBe(30);
      expect(balanceOf(userA)).toBe(70);
      expect(r.download_url).toBeTruthy();
    });
  });

  test('报价过期就不能再据它扣费：QUOTE_EXPIRED，不渲染、不落文件', async () => {
    const draftId = makeDraft(caseA);
    const q = await call('draft_export', userA, { draft_id: draftId });
    expireQuote(q.quote_id as number);

    const r = await call('draft_export', userA, { draft_id: draftId, quote_id: q.quote_id });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('QUOTE_EXPIRED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM file_download_tokens').get()).toEqual({ n: 0 });
  });

  test('一张报价只导出一份：同一个 quote_id 再确认一次 409，且不多签一条下载地址', async () => {
    const draftId = makeDraft(caseA);
    const q = await call('draft_export', userA, { draft_id: draftId });
    const first = await call('draft_export', userA, { draft_id: draftId, quote_id: q.quote_id });
    expect(first.ok).toBe(true);

    const second = await call('draft_export', userA, { draft_id: draftId, quote_id: q.quote_id });
    expect(second.ok).toBe(false);
    expect(second.errorCode).toBe('QUOTE_ALREADY_USED');
    // 放行的形态是：付一次、之后拿同一张报价无限次导出，每次 charged=0
    expect(db.prepare('SELECT COUNT(*) AS n FROM file_download_tokens').get()).toEqual({ n: 1 });
  });

  test('别人的报价号：QUOTE_NOT_FOUND（与"不存在"同码），不渲染不扣费', async () => {
    const otherDraft = makeDraft(caseB, '乙的异议函');
    const theirs = await call('draft_export', userB, { draft_id: otherDraft });
    const mine = makeDraft(caseA);

    const r = await call('draft_export', userA, { draft_id: mine, quote_id: theirs.quote_id });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('QUOTE_NOT_FOUND');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(db.prepare('SELECT confirmed_at FROM service_quotes WHERE id=?').get(theirs.quote_id)).toEqual({
      confirmed_at: null,
    });
  });

  test('拿别的服务的报价来确认：QUOTE_SERVICE_MISMATCH，且那张报价不被扣掉', async () => {
    const draftId = makeDraft(caseA);
    // 一张文字识别的报价（价目比导出高）：不校验的形态是按它的价结账，同一件事两个价
    const ocr = quoteService(db, {
      userId: userA,
      caseId: caseA,
      service: 'ocr',
      payload: { units: 1 },
    });
    expect(ocr.ok).toBe(true);
    const ocrQuoteId = ocr.ok ? ocr.quote.quoteId : 0;

    const r = await call('draft_export', userA, { draft_id: draftId, quote_id: ocrQuoteId });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('QUOTE_SERVICE_MISMATCH');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    // 校验在 confirmService 之前：这张报价必须原封不动（不是"先扣了再退"）
    expect(db.prepare('SELECT confirmed_at FROM service_quotes WHERE id=?').get(ocrQuoteId)).toEqual({
      confirmed_at: null,
    });
    expect(db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get()).toEqual({ n: 0 });
  });

  test('拿同一个人另一个案子的报价来确认：QUOTE_CASE_MISMATCH，那张报价原封不动', async () => {
    // 本人名下的第二个案子——归属这一关它过得去，所以「是不是这个案子的报价」必须另判
    const caseA2 = Number(
      db
        .prepare(
          "INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '甲的第二个案子', '风声', '2026-08-19T00:00:00.000Z')",
        )
        .run(userA).lastInsertRowid,
    );
    const other = quoteService(db, {
      userId: userA,
      caseId: caseA2,
      service: 'export',
      payload: { units: 1 },
    });
    expect(other.ok).toBe(true);
    const otherQuoteId = other.ok ? other.quote.quoteId : 0;

    const draftId = makeDraft(caseA);
    const r = await call('draft_export', userA, { draft_id: draftId, quote_id: otherQuoteId });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('QUOTE_CASE_MISMATCH');
    // 不校验的形态是：这份导出记到了 caseA2 的账上，两个案子的用量都对不上
    expect(db.prepare('SELECT confirmed_at FROM service_quotes WHERE id=?').get(otherQuoteId)).toEqual({
      confirmed_at: null,
    });
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });

  test('两步都要过实名闸，不是只拦第一步', async () => {
    const draftId = makeDraft(caseNoRealname);
    const payload = await viaMcp(userNoRealname, 'draft_export', { draft_id: draftId, quote_id: 1 });
    expect(payload.result.isError).toBe(true);
    expect(JSON.stringify(payload.result)).toContain('REALNAME_REQUIRED');
  });

  test('工具面上必须给得出 quote_id 这个入参，否则两步在 agent 那头根本走不通', () => {
    const cap = getCapability('draft_export');
    expect(cap?.kind).toBe('spend');
    expect(cap?.inputSchema.properties).toHaveProperty('quote_id');
    // 报价那步是免费的，quote_id 不能必填
    expect(cap?.inputSchema.required).not.toContain('quote_id');
    expect(String(cap?.description)).toContain('quote_id');
  });
});

// ---------- 6. draft_export 的产物与一次性下载 ----------

describe('draft_export', () => {
  test('导出落 files 表，回一条能取回同一份字节的限时地址', async () => {
    const draftId = makeDraft(caseA, '关于解除决定的异议函');
    const r = await exportTwoStep(userA, { draft_id: draftId, format: 'pdf' });
    expect(r.ok).toBe(true);
    expect(r.stage).toBe('done');
    expect(r.filename).toBe('关于解除决定的异议函.pdf');
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 1 });

    const token = (r.download_url as string).split('/').pop() as string;
    const res = await getDownload(token);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    // 中文文件名走 RFC 5987，不能只给被洗成下划线的那份
    expect(res.headers.get('content-disposition')).toContain(
      `filename*=UTF-8''${encodeURIComponent('关于解除决定的异议函.pdf')}`,
    );
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PDF_BYTES);
  });

  test('下载地址只发一次：第二次 410，且一个字节都不再给', async () => {
    const draftId = makeDraft(caseA);
    const r = await exportTwoStep(userA, { draft_id: draftId });
    const token = (r.download_url as string).split('/').pop() as string;
    expect((await getDownload(token)).status).toBe(200);

    const second = await getDownload(token);
    expect(second.status).toBe(410);
    const text = await second.text();
    expect(text).toContain('DOWNLOAD_TOKEN_USED');
    expect(text).not.toContain('%PDF');
  });

  test('过期的下载地址 410，且不消费那一行（说的是过期，不是"已经用过"）', async () => {
    const draftId = makeDraft(caseA);
    const r = await exportTwoStep(userA, { draft_id: draftId });
    const token = (r.download_url as string).split('/').pop() as string;
    db.prepare("UPDATE file_download_tokens SET expires_at='2000-01-01 00:00:00'").run();

    const res = await getDownload(token);
    expect(res.status).toBe(410);
    expect(await res.text()).toContain('DOWNLOAD_TOKEN_EXPIRED');
    expect(db.prepare('SELECT consumed_at FROM file_download_tokens').get()).toEqual({ consumed_at: null });
  });

  test('免费也要留下账：报价一行 + 账本一笔，金额 0', async () => {
    const draftId = makeDraft(caseA);
    const r = await exportTwoStep(userA, { draft_id: draftId });
    expect(r.amount).toBe(0);
    expect(r.charged).toBe(0);
    const quote = db
      .prepare('SELECT service, amount, confirmed_at, order_ref FROM service_quotes WHERE id=?')
      .get(r.quote_id) as { service: string; amount: number; confirmed_at: string | null; order_ref: string };
    expect(quote.service).toBe('export');
    expect(quote.amount).toBe(0);
    expect(quote.confirmed_at).not.toBeNull();
    expect(
      db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger WHERE ref_id=?').get(quote.order_ref),
    ).toEqual({ n: 1 });
  });

  test('正文为空 422，不生成一份打开是空白的 PDF，也不先报一次价', async () => {
    const draftId = makeDraft(caseA, '还没写的稿子', '   ');
    const r = await call('draft_export', userA, { draft_id: draftId });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('DRAFT_EMPTY');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_quotes').get()).toEqual({ n: 0 });
  });

  test('渲染失败：502，不落文件、不签下载地址，那张报价停在未确认（未扣费）', async () => {
    const draftId = makeDraft(caseA);
    // 报价那步不碰 sidecar，所以先取报价号，再让渲染炸
    const q = await call('draft_export', userA, { draft_id: draftId });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ detail: '渲染炸了' }), { status: 500 })),
    );
    const r = await call('draft_export', userA, { draft_id: draftId, quote_id: q.quote_id });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('EXPORT_RENDER_FAILED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM files').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM file_download_tokens').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT confirmed_at FROM service_quotes').get()).toEqual({ confirmed_at: null });
  });

  test('抢占是原子的：同一条地址 claim 两次，第二次拿不到（变异：抢占条件里去掉「没用过」⇒ 红）', async () => {
    // 【为什么要直接打 claimDownloadToken】路由里先有一道 inspect，串行的第二次请求会被它挡在
    // 410 上——于是「抢占本身是不是原子的」这件事，从路由那层根本测不出来。而真正会同时
    // 走到抢占那一句的是两个**并发**请求：inspect 时它们都还没用过。
    const draftId = makeDraft(caseA);
    const r = await exportTwoStep(userA, { draft_id: draftId });
    const token = (r.download_url as string).split('/').pop() as string;

    expect(claimDownloadToken(db, token)).not.toBeNull();
    expect(claimDownloadToken(db, token)).toBeNull();
  });

  test('0 元的单不碰会员券：券是能抵真钱的，拿它抵一个 0 谁都看不见', async () => {
    grantEntitlement(db, userA, ENTITLEMENT_KIND.serviceExtract, 'test-grant-1');
    expect(listUnconsumed(db, userA, ENTITLEMENT_KIND.serviceExtract)).toHaveLength(1);

    const draftId = makeDraft(caseA);
    const r = await exportTwoStep(userA, { draft_id: draftId });
    expect(r.ok).toBe(true);
    expect(r.paid_by).toBe('gongdao');
    // 券原封不动
    expect(listUnconsumed(db, userA, ENTITLEMENT_KIND.serviceExtract)).toHaveLength(1);
    expect(
      db.prepare('SELECT entitlement_id FROM service_quotes WHERE id=?').get(r.quote_id),
    ).toEqual({ entitlement_id: null });
  });

  test('format 只认 pdf，别的一律 400（不静默按 pdf 处理），报价那步就拦下', async () => {
    const draftId = makeDraft(caseA);
    const r = await call('draft_export', userA, { draft_id: draftId, format: 'docx' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_FORMAT');
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    expect(db.prepare('SELECT COUNT(*) AS n FROM service_quotes').get()).toEqual({ n: 0 });
  });
});
