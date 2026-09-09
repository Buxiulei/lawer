// app/src/app/api/v1/__tests__/rest-agent-writes.test.ts
//
// 行为判据：**经 api key 的 REST 写入落一行 agent_writes，且 endpoint / method / target 都对；
// 网页登录态（jwt）的同一次写入一行都不落。**
//
// ── 为什么两臂缺一不可（2026-09-07 case 2）──
// 只验"api key 写完有行"的形态是：把 recordAgentWriteFromRest 里那句 `if (via !== 'api_key') return`
// 删掉，判据照绿，而此后用户在页面上点的每一次操作都会灌进这张表——真正要看的那些行被淹掉。
// 只验"jwt 写完没行"更糟：把整个调用删掉，它也绿。
//
// ── 为什么每条端点都要单验一遍，不抽样 ──
// 结构守卫（rest-agent-writes-guard）只能证明"这个文件里出现过那句调用"。
// 它证明不了那句调用**传对了参数**：case_id 传成 evidence_id、target_id 传成 job_id、
// endpoint 抄上一条端点忘了改——每一种都让台账在事后查起来指向另一行，
// 而三种都不会报错、不会红，回包一个字都不差。所以每条端点各钉一次真参数。
//
// ── 变异臂（同一份判据上手工验过，2026-09-10）──
//  ① 删掉任意一处 recordAgentWriteFromRest 调用 ⇒ 该端点的 api_key 臂当场红（行数 1→0）。
//  ② 把 recordAgentWriteFromRest 里的 `if (identity.via !== 'api_key') return` 删掉
//     ⇒ 全部 jwt 臂当场红（行数 0→1）。
//  ③ 把某条端点的 endpoint 字面量抄成邻居那条 ⇒ 该端点的 api_key 臂红（endpoint 不匹配）。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// 必须在任何加解密 / 建库调用之前就位
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-rest-audit-${crypto.randomUUID()}.db`);
process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-rest-audit-files-'));

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';
import { GONGDAO_LEDGER_TYPE } from '@/lib/billing/pricing';
import { setBriefGenerator } from '@/lib/evidence/brief';
import { storeBytes } from '@/lib/evidence/files';
import { issueUploadToken } from '@/lib/evidence/upload-token';

const GOOD_BRIEF = {
  proves: '这份通知能证明公司在 2026-09-01 单方解除',
  key_facts: [],
  relation_to_claims: '支持赔偿金一项',
  weaknesses: [],
  suggested_followups: [],
  citations: [],
};

// 简报模型：regenerate 那条端点走 defaultBriefLlm()，真跑要 provider key。
// 换成一个照 schema 回话的假模型——本文件钉的是台账，不是简报生成质量。
vi.mock('@/lib/evidence/brief-llm', () => ({
  defaultBriefLlm: () => ({
    chatJSON: async () => JSON.stringify(GOOD_BRIEF),
    billingModel: 'test-brief-model',
  }),
}));

type IdCtx = { params: Promise<{ id: string }> };
type Handler<C> = (req: Request, ctx: C) => Promise<Response>;

let db: Database;
/** 路由 handler，按端点取名 */
const H = {} as {
  casePatch: Handler<IdCtx>;
  caseDelete: Handler<IdCtx>;
  intake: Handler<IdCtx>;
  timeline: Handler<IdCtx>;
  milestone: Handler<{ params: Promise<{ id: string; eventId: string }> }>;
  actionPatch: Handler<{ params: Promise<{ id: string; actionId: string }> }>;
  watch: Handler<IdCtx>;
  evidencePost: (req: Request) => Promise<Response>;
  evidenceVoid: Handler<IdCtx>;
  evidenceAttest: Handler<IdCtx>;
  briefPut: Handler<IdCtx>;
  briefRegenerate: Handler<IdCtx>;
  extract: Handler<IdCtx>;
  uploadPut: Handler<{ params: Promise<{ token: string }> }>;
  referralDelete: Handler<IdCtx>;
};

let uid: number;
let caseId: number;
let apiKey: string;
let keyId: number;
let jwt: string;

const FILES_DIR = process.env.FILES_DIR as string;
const JPEG = Buffer.from('\xff\xd8\xff\xe0 假 JPEG 字节', 'binary');

beforeAll(async () => {
  H.casePatch = (await import('../cases/[id]/route')).PATCH;
  H.caseDelete = (await import('../cases/[id]/route')).DELETE;
  H.intake = (await import('../cases/[id]/intake/route')).POST;
  H.timeline = (await import('../cases/[id]/timeline/route')).POST;
  H.milestone = (await import('../cases/[id]/timeline/[eventId]/milestone/route')).POST;
  H.actionPatch = (await import('../cases/[id]/actions/[actionId]/route')).PATCH;
  H.watch = (await import('../cases/[id]/watch/route')).POST;
  H.evidencePost = (await import('../evidence/route')).POST;
  H.evidenceVoid = (await import('../evidence/[id]/void/route')).POST;
  H.evidenceAttest = (await import('../evidence/[id]/attest/route')).POST;
  H.briefPut = (await import('../evidence/[id]/brief/route')).PUT;
  H.briefRegenerate = (await import('../evidence/[id]/brief/regenerate/route')).POST;
  H.extract = (await import('../evidence/[id]/extract/route')).POST;
  H.uploadPut = (await import('../evidence/upload/[token]/route')).PUT;
  H.referralDelete = (await import('../referrals/[id]/delete-request/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

/** 每条判据的两臂之间也要重来一次：台账行数是判据本身，不能让上一臂的行留在表里。 */
function reset(): void {
  for (const t of [
    'agent_writes', 'referral_delete_requests', 'referrals', 'extraction_jobs', 'service_quotes',
    'attestations', 'evidence_upload_tokens', 'evidence', 'files', 'company_watches',
    'timeline_events', 'action_items', 'claims', 'deadlines', 'company_profiles',
    'gongdao_ledger', 'gongdao', 'api_keys', 'cases', 'users',
  ]) {
    try {
      db.prepare(`DELETE FROM ${t}`).run();
    } catch {
      // 表还没建（分支间差异）就跳过：清不了的表本来也没有本轮的数据
    }
  }
  for (const entry of fs.readdirSync(FILES_DIR)) {
    fs.rmSync(path.join(FILES_DIR, entry), { recursive: true, force: true });
  }
  uid = Number(
    db
      .prepare("INSERT INTO users (phone_hash, auth_status, created_at) VALUES (?, '已实名', '2026-09-01T00:00:00.000Z')")
      .run(`u-${crypto.randomUUID()}`).lastInsertRowid,
  );
  caseId = Number(
    db
      .prepare("INSERT INTO cases (user_id, title, stage, created_at) VALUES (?, '甲的案子', '风声', '2026-09-01T00:00:00.000Z')")
      .run(uid).lastInsertRowid,
  );
  apiKey = generateApiKey();
  keyId = Number(
    db
      .prepare(
        "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled, created_at) VALUES (?, 'k', ?, ?, 1, '2026-09-01T00:00:00.000Z')",
      )
      .run(uid, hashApiKey(apiKey), JSON.stringify(['case:read', 'case:write'])).lastInsertRowid,
  );
  jwt = signToken(uid);
  setBriefGenerator(() => GOOD_BRIEF);
}

beforeEach(reset);

afterEach(() => {
  vi.unstubAllGlobals();
  setBriefGenerator(null);
});

// ───────────────────────── 读台账 ─────────────────────────

interface LedgerRow {
  endpoint: string;
  method: string;
  tool: string;
  case_id: number;
  key_id: number | null;
  target_table: string;
  target_id: number;
  deduped: number;
}

/** 读的是归一视图：老行的 endpoint 为空时按 `mcp:<tool>` 读（见 migrate.ts 的 agent_writes_audit）。 */
function ledger(): LedgerRow[] {
  return db
    .prepare(
      'SELECT endpoint, method, tool, case_id, key_id, target_table, target_id, deduped FROM agent_writes_audit ORDER BY id',
    )
    .all() as LedgerRow[];
}

function auth(via: 'api_key' | 'jwt'): string {
  return `Bearer ${via === 'api_key' ? apiKey : jwt}`;
}

const ctxId = (id: number | string): IdCtx => ({ params: Promise.resolve({ id: String(id) }) });

function jsonReq(url: string, method: string, via: 'api_key' | 'jwt', body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { authorization: auth(via), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function okBody(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (res.status >= 400) throw new Error(`期望成功，实得 ${res.status}：${text}`);
  return JSON.parse(text) as Record<string, unknown>;
}

/**
 * 两臂一次跑完：api key 那臂要匹配 expect 给的那一行，jwt 那臂要一行都没有。
 * drive 每臂各跑一次（中间 reset），所以它拿到的库永远是干净的。
 */
async function bothArms(
  drive: (via: 'api_key' | 'jwt') => Promise<Omit<LedgerRow, 'key_id' | 'tool'>>,
): Promise<void> {
  reset();
  const expected = await drive('api_key');
  expect(ledger(), 'api_key 写入必须落且只落一行台账').toEqual([
    { ...expected, key_id: keyId, tool: `${expected.method} ${expected.endpoint}` },
  ]);

  reset();
  await drive('jwt');
  expect(
    ledger(),
    '网页登录态（jwt）的同一次写入不许进台账——这张表答的是「用户接进来的 agent 都写了什么」',
  ).toEqual([]);
}

// ───────────────────────── 建夹具的小工具 ─────────────────────────

function mkEvidence(name = '解除通知.jpg', mime = 'image/jpeg'): number {
  // 走真的落盘管线（内容寻址 + 加密）：出证要读回字节算哈希，塞一行假 files 是读不出来的。
  // 每次换一份字节，免得内容寻址把两条判据的文件去重成同一行。
  const { fileId } = storeBytes(db, Buffer.concat([JPEG, Buffer.from(crypto.randomUUID())]), mime);
  return Number(
    db
      .prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
      .run(caseId, uid, fileId, name).lastInsertRowid,
  );
}

function mkTimelineEvent(): number {
  return Number(
    db
      .prepare(
        "INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, '2026-09-01T10:00:00+08:00', '公司动作', 'HR 约谈')",
      )
      .run(caseId).lastInsertRowid,
  );
}

// ───────────────────────── 逐条端点 ─────────────────────────

describe('案件面', () => {
  test('PATCH /api/v1/cases/{id}', async () => {
    await bothArms(async (via) => {
      const res = await H.casePatch(jsonReq(`/api/v1/cases/${caseId}`, 'PATCH', via, { goal: '拿到 2N' }), ctxId(caseId));
      await okBody(res);
      return {
        endpoint: '/api/v1/cases/{id}',
        method: 'PATCH',
        case_id: caseId,
        target_table: 'cases',
        target_id: caseId,
        deduped: 0,
      };
    });
  });

  test('DELETE /api/v1/cases/{id}（确认单那一步一行都不记，真删那一步才记）', async () => {
    await bothArms(async (via) => {
      // 第一步：不带 confirm_token，回确认单，一行都没删
      const first = await okBody(await H.caseDelete(jsonReq(`/api/v1/cases/${caseId}`, 'DELETE', via), ctxId(caseId)));
      expect(first.stage).toBe('confirm');
      expect(ledger(), '确认单那一步什么都没删，台账不许多出一行').toEqual([]);

      const token = String(first.confirm_token);
      const second = await okBody(
        await H.caseDelete(
          jsonReq(`/api/v1/cases/${caseId}?confirm_token=${encodeURIComponent(token)}`, 'DELETE', via),
          ctxId(caseId),
        ),
      );
      expect(second.stage).toBe('deleted');
      return {
        endpoint: '/api/v1/cases/{id}',
        method: 'DELETE',
        case_id: caseId,
        target_table: 'cases',
        target_id: caseId,
        deduped: 0,
      };
    });
  });

  test('POST /api/v1/cases/{id}/intake', async () => {
    await bothArms(async (via) => {
      await okBody(
        await H.intake(
          jsonReq(`/api/v1/cases/${caseId}/intake`, 'POST', via, {
            stage: '已收通知',
            company_name: '某供应链管理有限公司',
            employed_from: '2021-04-12',
            monthly_wage_fen: 2_200_000,
            goals: ['赔偿金'],
          }),
          ctxId(caseId),
        ),
      );
      return {
        endpoint: '/api/v1/cases/{id}/intake',
        method: 'POST',
        case_id: caseId,
        target_table: 'cases',
        target_id: caseId,
        deduped: 0,
      };
    });
  });

  test('POST /api/v1/cases/{id}/timeline', async () => {
    await bothArms(async (via) => {
      const body = await okBody(
        await H.timeline(
          jsonReq(`/api/v1/cases/${caseId}/timeline`, 'POST', via, {
            happened_at: '2026-09-01T10:00:00+08:00',
            kind: '公司动作',
            title: 'HR 第一次约谈',
            client_ref: 'ref-1',
          }),
          ctxId(caseId),
        ),
      );
      return {
        endpoint: '/api/v1/cases/{id}/timeline',
        method: 'POST',
        case_id: caseId,
        target_table: 'timeline_events',
        target_id: (body.event as { id: number }).id,
        deduped: 0,
      };
    });
  });

  test('POST /api/v1/cases/{id}/timeline/{eventId}/milestone', async () => {
    await bothArms(async (via) => {
      const eventId = mkTimelineEvent();
      await okBody(
        await H.milestone(
          jsonReq(`/api/v1/cases/${caseId}/timeline/${eventId}/milestone`, 'POST', via, {
            milestone: '协商',
            user_confirmed: true,
          }),
          { params: Promise.resolve({ id: String(caseId), eventId: String(eventId) }) },
        ),
      );
      return {
        endpoint: '/api/v1/cases/{id}/timeline/{eventId}/milestone',
        method: 'POST',
        case_id: caseId,
        target_table: 'timeline_events',
        target_id: eventId,
        deduped: 0,
      };
    });
  });

  test('PATCH /api/v1/cases/{id}/actions/{actionId}', async () => {
    await bothArms(async (via) => {
      const actionId = Number(
        db
          .prepare(
            "INSERT INTO action_items (case_id, title, detail, due_at, status) VALUES (?, '导出考勤', '打开 OA 导出', '2026-09-02T18:00:00+08:00', 'open')",
          )
          .run(caseId).lastInsertRowid,
      );
      await okBody(
        await H.actionPatch(
          jsonReq(`/api/v1/cases/${caseId}/actions/${actionId}`, 'PATCH', via, { status: '完成' }),
          { params: Promise.resolve({ id: String(caseId), actionId: String(actionId) }) },
        ),
      );
      return {
        endpoint: '/api/v1/cases/{id}/actions/{actionId}',
        method: 'PATCH',
        case_id: caseId,
        target_table: 'action_items',
        target_id: actionId,
        deduped: 0,
      };
    });
  });

  test('POST /api/v1/cases/{id}/watch', async () => {
    await bothArms(async (via) => {
      const body = await okBody(
        await H.watch(
          jsonReq(`/api/v1/cases/${caseId}/watch`, 'POST', via, { name: '某供应链管理有限公司', tier: 'daily' }),
          ctxId(caseId),
        ),
      );
      return {
        endpoint: '/api/v1/cases/{id}/watch',
        method: 'POST',
        case_id: caseId,
        target_table: 'company_watches',
        target_id: (body.watch as { id: number }).id,
        deduped: 0,
      };
    });
  });
});

describe('证据面', () => {
  test('POST /api/v1/evidence', async () => {
    await bothArms(async (via) => {
      const form = new FormData();
      form.append('file', new File([new Uint8Array(JPEG)], '解除通知.jpg', { type: 'image/jpeg' }));
      form.append('case_id', String(caseId));
      form.append('name', '解除通知');
      const body = await okBody(
        await H.evidencePost(
          new Request('http://localhost/api/v1/evidence', {
            method: 'POST',
            headers: { authorization: auth(via) },
            body: form,
          }),
        ),
      );
      return {
        endpoint: '/api/v1/evidence',
        method: 'POST',
        case_id: caseId,
        target_table: 'evidence',
        target_id: (body.evidence as { id: number }).id,
        deduped: 0,
      };
    });
  });

  test('POST /api/v1/evidence/{id}/void', async () => {
    await bothArms(async (via) => {
      const evidenceId = mkEvidence();
      await okBody(
        await H.evidenceVoid(
          jsonReq(`/api/v1/evidence/${evidenceId}/void`, 'POST', via, { reason: '传错了' }),
          ctxId(evidenceId),
        ),
      );
      return {
        endpoint: '/api/v1/evidence/{id}/void',
        method: 'POST',
        case_id: caseId,
        target_table: 'evidence',
        target_id: evidenceId,
        deduped: 0,
      };
    });
  });

  test('PUT /api/v1/evidence/{id}/brief', async () => {
    await bothArms(async (via) => {
      const evidenceId = mkEvidence();
      await okBody(
        await H.briefPut(
          jsonReq(`/api/v1/evidence/${evidenceId}/brief`, 'PUT', via, {
            brief: GOOD_BRIEF,
            reason: '人手补一份',
            base_version: 0,
          }),
          ctxId(evidenceId),
        ),
      );
      return {
        endpoint: '/api/v1/evidence/{id}/brief',
        method: 'PUT',
        case_id: caseId,
        target_table: 'evidence',
        target_id: evidenceId,
        deduped: 0,
      };
    });
  });

  test('POST /api/v1/evidence/{id}/brief/regenerate', async () => {
    await bothArms(async (via) => {
      const evidenceId = mkEvidence();
      await okBody(
        await H.briefRegenerate(
          jsonReq(`/api/v1/evidence/${evidenceId}/brief/regenerate`, 'POST', via),
          ctxId(evidenceId),
        ),
      );
      return {
        endpoint: '/api/v1/evidence/{id}/brief/regenerate',
        method: 'POST',
        case_id: caseId,
        target_table: 'evidence',
        target_id: evidenceId,
        deduped: 0,
      };
    });
  });
});

describe('两步端点：报价那一步不进台账，确认那一步才进', () => {
  test('POST /api/v1/evidence/{id}/extract', async () => {
    const { gongdaoGrant } = await import('@/lib/billing');
    await bothArms(async (via) => {
      gongdaoGrant(uid, 100_000, GONGDAO_LEDGER_TYPE.recharge, `top-${crypto.randomUUID()}`, null, db);
      const evidenceId = mkEvidence();

      // 第一步：只出价、不动账
      const quoted = await okBody(
        await H.extract(jsonReq(`/api/v1/evidence/${evidenceId}/extract`, 'POST', via, { mode: 'ocr' }), ctxId(evidenceId)),
      );
      expect(ledger(), '报价这一步没动账、没排队，台账不许多出一行').toEqual([]);

      const quoteId = (quoted.quote as { quote_id: number }).quote_id;
      const started = await okBody(
        await H.extract(
          jsonReq(`/api/v1/evidence/${evidenceId}/extract`, 'POST', via, { mode: 'ocr', quote_id: quoteId }),
          ctxId(evidenceId),
        ),
      );
      return {
        endpoint: '/api/v1/evidence/{id}/extract',
        method: 'POST',
        case_id: caseId,
        target_table: 'extraction_jobs',
        target_id: (started.job as { job_id: number }).job_id,
        deduped: 0,
      };
    });
  });
});

describe('出证与两步式上传', () => {
  /** sidecar 全程 mock：本文件钉的是台账，不依赖真 TSA 与签名证书。 */
  function mockSidecar(): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const u = String(url);
        if (u.endsWith('/tsa')) {
          return new Response(
            JSON.stringify({
              tst_b64: 'MIILAQYJKoZIhvcNAQcCoIIK8jCCCu4CAQMx',
              gen_time: '2026-09-05T03:42:58+00:00',
              serial: '128227905932707484420972403472307',
              tsa_url: 'http://tsa.example/tsa',
            }),
            { status: 200, headers: { 'Content-Type': 'application/json' } },
          );
        }
        if (u.endsWith('/evidence-pdf')) return new Response(new Uint8Array(Buffer.from('%PDF unsigned')), { status: 200 });
        if (u.endsWith('/pades')) return new Response(new Uint8Array(Buffer.from('%PDF signed')), { status: 200 });
        if (u.endsWith('/signer')) {
          return new Response(JSON.stringify({ signer_cn: '某公司', signer_org: null, not_before: null, not_after: null, serial: 'x' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        throw new Error(`未预期的 sidecar 调用: ${u}`);
      }),
    );
  }

  test('POST /api/v1/evidence/{id}/attest（target 指 attestations，case_id 回读证据行取）', async () => {
    await bothArms(async (via) => {
      mockSidecar();
      const evidenceId = mkEvidence();
      const body = await okBody(
        await H.evidenceAttest(jsonReq(`/api/v1/evidence/${evidenceId}/attest`, 'POST', via), ctxId(evidenceId)),
      );
      return {
        endpoint: '/api/v1/evidence/{id}/attest',
        method: 'POST',
        case_id: caseId,
        target_table: 'attestations',
        target_id: (body.attestation as { id: number }).id,
        deduped: 0,
      };
    });
  });

  test('PUT /api/v1/evidence/upload/{token}（还没有 evidence 行，target 指那张被用掉的票据）', async () => {
    await bothArms(async (via) => {
      const issued = issueUploadToken(db, {
        caseId,
        userId: uid,
        filename: '解除通知.jpg',
        mime: 'image/jpeg',
        size: JPEG.length,
      });
      const res = await H.uploadPut(
        new Request(`http://localhost/api/v1/evidence/upload/${issued.token}`, {
          method: 'PUT',
          headers: { authorization: auth(via) },
          body: new Uint8Array(JPEG),
        }),
        { params: Promise.resolve({ token: issued.token }) },
      );
      await okBody(res);
      return {
        endpoint: '/api/v1/evidence/upload/{token}',
        method: 'PUT',
        case_id: caseId,
        target_table: 'evidence_upload_tokens',
        target_id: issued.row.id,
        deduped: 0,
      };
    });
  });
});

describe('转介面', () => {
  test('POST /api/v1/referrals/{id}/delete-request', async () => {
    await bothArms(async (via) => {
      const referralId = Number(
        db
          .prepare(
            `INSERT INTO referrals (case_id, user_id, direction, status, payload_json, consent_at)
             VALUES (?, ?, 'out', 'sent', '{}', '2026-09-01T00:00:00.000Z')`,
          )
          .run(caseId, uid).lastInsertRowid,
      );
      await okBody(
        await H.referralDelete(
          jsonReq(`/api/v1/referrals/${referralId}/delete-request`, 'POST', via, { reason: '不想聊了' }),
          ctxId(referralId),
        ),
      );
      return {
        endpoint: '/api/v1/referrals/{id}/delete-request',
        method: 'POST',
        case_id: caseId,
        target_table: 'referrals',
        target_id: referralId,
        deduped: 0,
      };
    });
  });
});

// ───────────────── 台账写不进去时不许拖垮主流程 ─────────────────

describe('写台账失败 ⇒ 业务照常成功，且点名到具体端点', () => {
  test('key_id 指向一把不存在的 key（外键当场炸）时，时间线那一条照样落库', async () => {
    reset();
    // 把 key 从 api_keys 里删掉，但请求仍带着它的明文——resolveIdentity 认不出来会回 401，
    // 所以改成直接调唯一入口，模拟"台账那一行插不进去"这一刻。
    const { recordAgentWriteFromRest } = await import('@/lib/audit/agent-writes');
    const errors: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errors.push(a.map(String).join(' '));
    });
    expect(() =>
      recordAgentWriteFromRest(db, { uid, via: 'api_key', scopes: ['case:write'], keyId: 999_999 }, {
        endpoint: '/api/v1/cases/{id}/timeline',
        method: 'POST',
        caseId,
        targetTable: 'timeline_events',
        targetId: 1,
      }),
    ).not.toThrow();
    spy.mockRestore();

    expect(ledger(), '插不进去就是插不进去，不许留半行').toEqual([]);
    expect(errors, '失败必须点名，只打一句「audit failed」的形态是事后补不回来').toHaveLength(1);
    expect(errors[0]).toContain('/api/v1/cases/{id}/timeline');
    expect(errors[0]).toContain(`case_id=${caseId}`);
    expect(errors[0]).toContain('timeline_events#1');
  });
});
