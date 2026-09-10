// app/src/app/api/__tests__/capability-ledger.test.ts
//
// 行为判据：**不走能力壳的那批写能力，经 MCP 与通用工具桥两道门调用时各落一行 agent_writes，
// endpoint / tool / case_id / target 都对；网页登录态（jwt）的同一次调用一行都不落。**
//
// ── 为什么要有这一整套（2026-09-10 复审 major#2）──
// 台账此前只有能力壳（withClientRef / writeOnce）在记，而没走能力壳的 13 条写能力
// **一行都不留**——挂守望、出证、删档案这些会花钱或不可逆的动作，用 api key 从这两道门
// 写进去查不到是谁写的，而两边都返回 200、没有一处报错。
//
// ── 为什么每条能力都要单验一遍，不抽样 ──
// 结构守卫（registry-guard）只能证明「这条能力声明了 ledger」。它证明不了那份元数据
// **指对了行**：target_table 抄了邻居、target_id 取的是回包里另一个数、case_id 取自
// 一个入参里根本没有的键——每一种都让台账在事后查起来指向另一行，而三种都不报错、不红，
// 回包一个字都不差。所以每条能力各钉一次真参数。
//
// ── 变异臂（同一份判据上手工验过，2026-09-10）──
//  ① 删掉任一道门里那句 recordCapabilityWrite ⇒ 该门下 13 条全红（行数 1→0）。
//  ② 把 recordCapabilityWrite 里的 `if (identity.via !== 'api_key') return` 删掉
//     ⇒ 全部 jwt 臂当场红（行数 0→1）。
//  ③ 把某条能力的 ledger.targetTable 抄成邻居那条 ⇒ 该条的 api_key 臂红。
//  ④ 去掉 `if (!ledger) return` 那一句（即给走能力壳的能力也记一行）
//     ⇒ 「能力壳那批不重复记行」一节当场红（行数 1→2）。
//  ⑤ 把 case_delete 的 rowsOf 改成无条件回一行（确认单那步也记）⇒ 那条的第一步断言红。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';

// 必须在任何加解密 / 建库调用之前就位
process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
process.env.DB_PATH = path.join(os.tmpdir(), `lawer-cap-ledger-${crypto.randomUUID()}.db`);
process.env.FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-cap-ledger-files-'));

import { generateApiKey, hashApiKey } from '@/lib/auth/api-key';
import { signToken } from '@/lib/auth/jwt';
import { CAPABILITIES } from '@/lib/capabilities';
import { findAttestationByOrderNo } from '@/lib/db/evidence';
import { setBriefGenerator } from '@/lib/evidence/brief';
import { storeBytes } from '@/lib/evidence/files';
import { findUploadToken } from '@/lib/evidence/upload-token';

const GOOD_BRIEF = {
  proves: '这份通知能证明公司在 2026-09-01 单方解除',
  key_facts: [],
  relation_to_claims: '支持赔偿金一项',
  weaknesses: [],
  suggested_followups: [],
  citations: [],
};

// 简报模型：regenerate 那条走 defaultBriefLlm()，真跑要 provider key。
// 换成一个照 schema 回话的假模型——本文件钉的是台账，不是简报生成质量。
vi.mock('@/lib/evidence/brief-llm', () => ({
  defaultBriefLlm: () => ({
    chatJSON: async () => JSON.stringify(GOOD_BRIEF),
    billingModel: 'test-brief-model',
  }),
}));

/** 两道跑能力的门。endpoint 前缀按门取值，其余（tool / case_id / target）两门必须一模一样。 */
const DOORS = ['mcp', 'rest-tools'] as const;
type Door = (typeof DOORS)[number];

let db: Database;
let mcpPost: (req: Request) => Promise<Response>;
let toolsPost: (req: Request, ctx: { params: Promise<{ name: string }> }) => Promise<Response>;

let uid: number;
let caseId: number;
let apiKey: string;
let keyId: number;
let jwt: string;

const FILES_DIR = process.env.FILES_DIR as string;
const JPEG = Buffer.from('\xff\xd8\xff\xe0 假 JPEG 字节', 'binary');

beforeAll(async () => {
  mcpPost = (await import('../mcp/route')).POST;
  toolsPost = (await import('../v1/tools/[name]/route')).POST;
  db = (await import('@/lib/db/client')).getDb();
});

function reset(): void {
  for (const t of [
    // agent_writes 排最前：key_id 外键指向 api_keys 且没有级联。
    'agent_writes', 'referral_delete_requests', 'referrals', 'attestations',
    'evidence_upload_tokens', 'evidence', 'files', 'company_watches', 'share_links',
    'timeline_events', 'action_items', 'api_keys', 'cases', 'users',
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

// ───────────────────────── 调门 ─────────────────────────

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

/** 读的是归一视图（老行按 mcp:<tool> 读），与生产上查台账的口径一致。 */
function ledger(): LedgerRow[] {
  return db
    .prepare(
      'SELECT endpoint, method, tool, case_id, key_id, target_table, target_id, deduped FROM agent_writes_audit ORDER BY id',
    )
    .all() as LedgerRow[];
}

function bearer(via: 'api_key' | 'jwt'): string {
  return `Bearer ${via === 'api_key' ? apiKey : jwt}`;
}

/** 跑一条能力，回它的回包（两道门的回包逐字相同，所以判据两边共用）。 */
async function callTool(
  door: Door,
  name: string,
  args: Record<string, unknown>,
  via: 'api_key' | 'jwt',
): Promise<Record<string, unknown>> {
  const headers = { 'content-type': 'application/json', authorization: bearer(via) };
  if (door === 'rest-tools') {
    const res = await toolsPost(
      new Request(`http://localhost/api/v1/tools/${name}`, { method: 'POST', headers, body: JSON.stringify(args) }),
      { params: Promise.resolve({ name }) },
    );
    const text = await res.text();
    if (res.status >= 400) throw new Error(`${name} 期望成功，实得 ${res.status}：${text}`);
    return JSON.parse(text) as Record<string, unknown>;
  }
  const res = await mcpPost(
    new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
    }),
  );
  const body = (await res.json()) as {
    result?: { isError: boolean; content: { text: string }[] };
    error?: { message: string };
  };
  if (!body.result) throw new Error(`${name} 走 MCP 拿到协议层错误：${body.error?.message}`);
  const payload = JSON.parse(body.result.content[0].text) as Record<string, unknown>;
  if (body.result.isError) throw new Error(`${name} 期望成功，实得 isError：${body.result.content[0].text}`);
  return payload;
}

/** 一条能力在一道门下的期望台账行（endpoint / tool / key_id 由门与能力名推出来，不逐条手写）。 */
type Expected = Omit<LedgerRow, 'endpoint' | 'method' | 'tool' | 'key_id'>;

/**
 * 两臂一次跑完：api key 那臂要匹配 drive 回的那一行，jwt 那臂要一行都没有。
 * 每臂各自 reset，所以 drive 拿到的库永远是干净的。
 */
async function bothArms(
  door: Door,
  name: string,
  drive: (via: 'api_key' | 'jwt') => Promise<Expected | Expected[]>,
): Promise<void> {
  reset();
  const expected = await drive('api_key');
  const rows = Array.isArray(expected) ? expected : [expected];
  expect(ledger(), `${name} 经 ${door} 的 api_key 写入必须逐行落台账`).toEqual(
    rows.map((r) => ({
      ...r,
      endpoint: door === 'mcp' ? `mcp:${name}` : `rest-tools:${name}`,
      method: 'POST',
      // tool 一列答的是「哪条能力干的」：两道门必须同值，否则查 tool='x' 的人会漏掉一整道门。
      tool: name,
      key_id: keyId,
    })),
  );

  reset();
  await drive('jwt');
  expect(
    ledger(),
    '网页登录态（jwt）的同一次调用不许进台账——这张表答的是「用户接进来的 agent 都写了什么」',
  ).toEqual([]);
}

// ───────────────────────── 夹具 ─────────────────────────

function mkEvidence(name = '解除通知.jpg', mime = 'image/jpeg'): number {
  // 走真的落盘管线（内容寻址 + 加密）：出证要读回字节算哈希。每次换一份字节，免得被去重成同一行。
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

function mkActionItem(): number {
  return Number(
    db
      .prepare(
        "INSERT INTO action_items (case_id, title, detail, due_at, status) VALUES (?, '导出考勤', '打开 OA 导出', '2026-09-02T18:00:00+08:00', 'open')",
      )
      .run(caseId).lastInsertRowid,
  );
}

function mkShare(): number {
  return Number(
    db
      .prepare(
        "INSERT INTO share_links (case_id, token, scope, expires_at) VALUES (?, ?, '档案只读', '2030-01-01T00:00:00.000Z')",
      )
      .run(caseId, `t-${crypto.randomUUID()}`).lastInsertRowid,
  );
}

function mkReferral(): number {
  return Number(
    db
      .prepare(
        "INSERT INTO referrals (case_id, user_id, status, payload_json, consent_at) VALUES (?, ?, 'sent', '{}', '2026-09-01T00:00:00.000Z')",
      )
      .run(caseId, uid).lastInsertRowid,
  );
}

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
        return new Response(
          JSON.stringify({ signer_cn: '某公司', signer_org: null, not_before: null, not_after: null, serial: 'x' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`未预期的 sidecar 调用: ${u}`);
    }),
  );
}

const INTAKE_ARGS = {
  stage: '已收通知',
  company_name: '华衡永泰供应链管理有限公司',
  employed_from: '2021-04-12',
  monthly_wage_yuan: 22000,
  position: '仓储主管',
  contract_count: '只签过一次',
  goals: ['违法解除赔偿金（2N）'],
  bottom_line: '低于 2N 不签。',
};

// ───────────────────────── 逐条能力 × 两道门 ─────────────────────────

describe.each(DOORS)('%s 这道门', (door) => {
  test('case_update', async () => {
    await bothArms(door, 'case_update', async (via) => {
      await callTool(door, 'case_update', { case_id: caseId, goal: '拿到 2N' }, via);
      return { case_id: caseId, target_table: 'cases', target_id: caseId, deduped: 0 };
    });
  });

  test('case_delete（确认单那一步一行都不记，真删那一步才记）', async () => {
    await bothArms(door, 'case_delete', async (via) => {
      const first = await callTool(door, 'case_delete', { case_id: caseId }, via);
      expect(first.stage).toBe('confirm');
      expect(ledger(), '确认单那一步什么都没删，台账不许多出一行').toEqual([]);

      const second = await callTool(
        door,
        'case_delete',
        { case_id: caseId, confirm_token: String(first.confirm_token) },
        via,
      );
      expect(second.stage).toBe('deleted');
      return { case_id: caseId, target_table: 'cases', target_id: caseId, deduped: 0 };
    });
  });

  test('intake_submit（一次写十几行，台账记的是这份档案）', async () => {
    await bothArms(door, 'intake_submit', async (via) => {
      await callTool(door, 'intake_submit', { case_id: caseId, ...INTAKE_ARGS }, via);
      return { case_id: caseId, target_table: 'cases', target_id: caseId, deduped: 0 };
    });
  });

  test('timeline_add', async () => {
    await bothArms(door, 'timeline_add', async (via) => {
      const body = await callTool(
        door,
        'timeline_add',
        { case_id: caseId, happened_at: '2026-09-01T10:00:00+08:00', kind: '公司动作', title: 'HR 第一次约谈' },
        via,
      );
      return {
        case_id: caseId,
        target_table: 'timeline_events',
        target_id: (body.event as { id: number }).id,
        deduped: 0,
      };
    });
  });

  test('timeline_milestone', async () => {
    await bothArms(door, 'timeline_milestone', async (via) => {
      const eventId = mkTimelineEvent();
      await callTool(
        door,
        'timeline_milestone',
        { case_id: caseId, event_id: eventId, milestone: '协商', user_confirmed: true },
        via,
      );
      return { case_id: caseId, target_table: 'timeline_events', target_id: eventId, deduped: 0 };
    });
  });

  test('action_complete', async () => {
    await bothArms(door, 'action_complete', async (via) => {
      const actionId = mkActionItem();
      await callTool(door, 'action_complete', { case_id: caseId, action_id: actionId, status: '完成' }, via);
      return { case_id: caseId, target_table: 'action_items', target_id: actionId, deduped: 0 };
    });
  });

  test('company_watch_set', async () => {
    await bothArms(door, 'company_watch_set', async (via) => {
      const body = await callTool(
        door,
        'company_watch_set',
        { case_id: caseId, name: '华衡永泰供应链管理有限公司', tier: 'daily' },
        via,
      );
      return {
        case_id: caseId,
        target_table: 'company_watches',
        target_id: (body.watch as { id: number }).id,
        deduped: 0,
      };
    });
  });

  test('share_revoke（入参里没有案件号，case_id 回读那一行取）', async () => {
    await bothArms(door, 'share_revoke', async (via) => {
      const shareId = mkShare();
      await callTool(door, 'share_revoke', { share_id: shareId }, via);
      return { case_id: caseId, target_table: 'share_links', target_id: shareId, deduped: 0 };
    });
  });

  test('referral_delete_request（同上，case_id 回读转介取）', async () => {
    await bothArms(door, 'referral_delete_request', async (via) => {
      const referralId = mkReferral();
      await callTool(door, 'referral_delete_request', { referral_id: referralId }, via);
      return { case_id: caseId, target_table: 'referrals', target_id: referralId, deduped: 0 };
    });
  });

  test('evidence_upload_url（target 指那张还没被用掉的票据）', async () => {
    await bothArms(door, 'evidence_upload_url', async (via) => {
      const body = await callTool(
        door,
        'evidence_upload_url',
        { case_id: caseId, filename: '解除通知.jpg', mime: 'image/jpeg', size: JPEG.length },
        via,
      );
      const row = findUploadToken(db, String(body.upload_token));
      expect(row, '签发的票据应当查得到').not.toBeNull();
      return { case_id: caseId, target_table: 'evidence_upload_tokens', target_id: row!.id, deduped: 0 };
    });
  });

  test('evidence_attest（逐件一行，target 指 attestations）', async () => {
    await bothArms(door, 'evidence_attest', async (via) => {
      mockSidecar();
      const first = mkEvidence('解除通知.jpg');
      const second = mkEvidence('考勤表.jpg');
      const body = await callTool(door, 'evidence_attest', { evidence_ids: [first, second] }, via);
      const results = body.results as { ok: boolean; order_no: string }[];
      expect(results.every((r) => r.ok), `两件都要出证成功：${JSON.stringify(body)}`).toBe(true);
      // 一次调用两件 ⇒ 台账两行。只记一行的形态是「出证过几件」永远是 1，而证明文件是 2 份。
      return results.map((r) => ({
        case_id: caseId,
        target_table: 'attestations',
        target_id: findAttestationByOrderNo(db, r.order_no)!.id,
        deduped: 0,
      }));
    });
  });

  test('evidence_brief_update', async () => {
    await bothArms(door, 'evidence_brief_update', async (via) => {
      const evidenceId = mkEvidence();
      await callTool(
        door,
        'evidence_brief_update',
        { evidence_id: evidenceId, brief: GOOD_BRIEF, reason: '人手补一份', base_version: 0 },
        via,
      );
      return { case_id: caseId, target_table: 'evidence', target_id: evidenceId, deduped: 0 };
    });
  });

  test('evidence_brief_regenerate', async () => {
    await bothArms(door, 'evidence_brief_regenerate', async (via) => {
      const evidenceId = mkEvidence();
      await callTool(door, 'evidence_brief_regenerate', { evidence_id: evidenceId }, via);
      return { case_id: caseId, target_table: 'evidence', target_id: evidenceId, deduped: 0 };
    });
  });
});

// ───────────────────────── 重放：认在 deduped 那一列上 ─────────────────────────

describe('重放与去重', () => {
  test('timeline_add 带同一个 client_ref 重放：台账仍然只有一行（不撞唯一索引、不报错）', async () => {
    const args = {
      case_id: caseId,
      happened_at: '2026-09-01T10:00:00+08:00',
      kind: '公司动作',
      title: 'HR 第一次约谈',
      client_ref: 'ref-1',
    };
    const first = await callTool('rest-tools', 'timeline_add', args, 'api_key');
    const errs: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => {
      errs.push(a.map(String).join(' '));
    });
    let second: Record<string, unknown>;
    try {
      second = await callTool('rest-tools', 'timeline_add', args, 'api_key');
    } finally {
      spy.mockRestore();
    }
    expect(second.deduped, '业务侧要如实回「这条之前记过了」').toBe(true);
    expect(
      ledger().map((r) => ({ tool: r.tool, target_id: r.target_id })),
      '同一个 client_ref 只该有一行台账（uq_agent_writes_client_ref 也不许有第二行）',
    ).toEqual([{ tool: 'timeline_add', target_id: (first.event as { id: number }).id }]);
    // 【为什么连日志也要钉】不先查就插的形态是：这条**设计之内的正常重放**每次都在生产日志里
    // 报一条 UNIQUE constraint failed，而照那条日志去补记会补出一行本不该存在的记录。
    expect(errs.filter((e) => e.includes('agent_writes'))).toEqual([]);
  });

  test('company_watch_set 连点两次：第二次记成 deduped=1（不是又挂了一条守望）', async () => {
    const args = { case_id: caseId, name: '华衡永泰供应链管理有限公司', tier: 'daily' };
    const first = await callTool('rest-tools', 'company_watch_set', args, 'api_key');
    await callTool('rest-tools', 'company_watch_set', args, 'api_key');
    const watchId = (first.watch as { id: number }).id;
    expect(
      ledger().map((r) => ({ target_id: r.target_id, deduped: r.deduped })),
      '第二次命中了已有那条盯梢，记成新建的形态是台账里的次数比真实的多，而每条对应一笔月费',
    ).toEqual([
      { target_id: watchId, deduped: 0 },
      { target_id: watchId, deduped: 1 },
    ]);
  });
});

// ───────────────────────── 对照臂：能力壳那批不许被记第二行 ─────────────────────────

describe('走能力壳的写能力不重复记行', () => {
  test('action_create 经工具桥只落一行，且 endpoint 仍是 mcp:action_create（能力壳记的那一行）', async () => {
    const body = await callTool(
      'rest-tools',
      'action_create',
      {
        case_id: caseId,
        items: [
          { what: '导出考勤', how: '打开 OA 导出近 12 个月', why: '加班要能自证', due_at: '2026-09-02T18:00:00+08:00' },
        ],
      },
      'api_key',
    );
    void body;
    const rows = ledger();
    expect(
      rows.map((r) => ({ endpoint: r.endpoint, tool: r.tool, target_table: r.target_table })),
      '能力壳已经在事务里记过一行，门再记一行 ⇒ 同一次写入占两行，计数从此说谎',
    ).toEqual([{ endpoint: 'mcp:action_create', tool: 'action_create', target_table: 'action_items' }]);
  });

  test('这条对照臂盯的确实是一条「走能力壳」的能力（它一旦改道，上面那条就该重写）', () => {
    const cap = CAPABILITIES.find((c) => c.name === 'action_create');
    expect(cap?.kind).toBe('write');
    expect(cap?.ledger, 'action_create 声明了 ledger 的话，它就不再是能力壳那一批了').toBeUndefined();
  });
});

// ───────────────────────── 覆盖面本身 ─────────────────────────

describe('覆盖面', () => {
  test('声明了 ledger 的写能力都在本文件里逐条验过（新增一条忘了写判据 ⇒ 红）', () => {
    const declared = CAPABILITIES.filter((c) => c.ledger !== undefined).map((c) => c.name).sort();
    const covered = [
      'action_complete', 'case_delete', 'case_update', 'company_watch_set', 'evidence_attest',
      'evidence_brief_regenerate', 'evidence_brief_update', 'evidence_upload_url', 'intake_submit',
      'referral_delete_request', 'share_revoke', 'timeline_add', 'timeline_milestone',
    ].sort();
    expect(
      declared,
      '注册表里声明 ledger 的能力与本文件验过的对不上。\n' +
        '多出来的那条：给它补一条 describe.each 里的判据——结构守卫只能证明"声明了"，' +
        '证明不了那份元数据指对了行。\n' +
        '少了一条：它改道走能力壳了，把这里的名字一起删掉。',
    ).toEqual(covered);
  });
});
