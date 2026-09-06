// app/src/lib/evidence/__tests__/brief-failure-visible.test.ts
// 简报生成失败必须**看得见**（生产 09-06：OCR 成功、简报没有、日志里一个字都没有）。
//
// 判据钉的是三件事：
//   ① 每一档失败（模型抛错 / 不是 JSON / 不合 schema）都落进 evidence.brief_error 并打一行 warn；
//   ② evidence_get 与 evidence_list 回 brief_status（none/ok/failed + error），三档分得开；
//   ③ evidence_brief_regenerate 成功后 brief_error 清空、brief_status 回 ok。
// 变异臂：把 generateBrief 的 failed() 换回裸 return ⇒ ①③当场红。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

process.env.LAWER_DATA_KEY = Buffer.alloc(32, 5).toString('base64');

import type { Identity } from '@/lib/auth/identity';
import { getCapability } from '@/lib/capabilities';
import { runMigrations } from '@/lib/db/migrate';
import * as evidence from '@/lib/evidence';
import { BRIEF_LLM_TIMEOUT_MS, briefStatusOf, generateBrief, type BriefLlm } from '@/lib/evidence/brief';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let db: Database;
let uid: number;
let caseId: number;
let tmpDir: string;

const GOOD_BRIEF = JSON.stringify({
  proves: '这份通知能证明公司在 2026-09-01 单方解除了劳动合同',
  key_facts: [],
  relation_to_claims: '支持违法解除赔偿金',
  weaknesses: [],
  suggested_followups: [],
  citations: [],
});

/** 假模型：按脚本逐次返回，或抛错。 */
function llmOf(script: (string | Error)[]): BriefLlm {
  let i = 0;
  return {
    chatJSON: async () => {
      const next = script[Math.min(i++, script.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

function identity(): Identity {
  return { uid, via: 'jwt', scopes: ['case:read', 'case:write'] };
}

async function call(name: string, args: Record<string, unknown>) {
  const cap = getCapability(name);
  if (!cap) throw new Error(`没有这个能力：${name}`);
  return (await cap.run(db, identity(), args)) as Record<string, unknown>;
}

function makeEvidence(name = '解除通知.jpg') {
  const r = evidence.uploadEvidence(db, {
    caseId,
    userId: uid,
    bytes: Buffer.from(name),
    name,
    mime: 'image/jpeg',
    category: '公司文件',
    provePurpose: '证明公司单方解除',
  });
  if (!r.ok) throw new Error('造样本失败');
  return r.evidence.id;
}

function errorOf(id: number): string | null {
  return (db.prepare('SELECT brief_error FROM evidence WHERE id = ?').get(id) as {
    brief_error: string | null;
  }).brief_error;
}

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h-a', '已实名')").run().lastInsertRowid,
  );
  caseId = Number(
    db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '甲的案子', '风声')").run(uid).lastInsertRowid,
  );
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-brief-fail-'));
  process.env.FILES_DIR = tmpDir;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
  db.close();
});

describe('简报调用必须显式带长超时（provider 缺省 8s 在生产上一份简报都写不出来）', () => {
  test('generateBrief 传给 chatJSON 的 timeoutMs ≥ 30s', async () => {
    const seen: Array<{ timeoutMs?: number } | undefined> = [];
    const llm: BriefLlm = {
      chatJSON: async (_messages, opts) => {
        seen.push(opts);
        return GOOD_BRIEF;
      },
    };
    const id = makeEvidence();
    const r = await generateBrief(db, id, llm);
    expect(r.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.timeoutMs).toBe(BRIEF_LLM_TIMEOUT_MS);
    expect(BRIEF_LLM_TIMEOUT_MS).toBeGreaterThanOrEqual(30_000);
  });
});

describe('每一档失败都落 brief_error 并打日志', () => {
  test.each([
    ['模型/上游', new Error('connect ECONNREFUSED'), '调用简报模型失败'],
    ['不是 JSON', '这份材料看起来像一封解除通知。', '返回的不是 JSON'],
    ['不合 schema', '{"key_facts": []}', '不合 schema'],
  ])('%s 档：brief_error 非空且含原因', async (_label, scripted, expected) => {
    const id = makeEvidence();
    const r = await generateBrief(db, id, llmOf([scripted]));
    expect(r.ok).toBe(false);
    expect(errorOf(id)).toContain(expected);
    expect(console.warn).toHaveBeenCalled();
  });

  test('生成成功会把上一轮的旧账清掉——否则 failed 档永远退不出去', async () => {
    const id = makeEvidence();
    await generateBrief(db, id, llmOf([new Error('上游挂了')]));
    expect(errorOf(id)).not.toBeNull();

    const ok = await generateBrief(db, id, llmOf([GOOD_BRIEF]));
    expect(ok.ok).toBe(true);
    expect(errorOf(id)).toBeNull();
  });
});

describe('brief_status 三档从读侧看得见', () => {
  test('none / failed / ok 在 evidence_get 与 evidence_list 上一致', async () => {
    const id = makeEvidence();

    const none = await call('evidence_get', { evidence_id: id });
    expect((none.evidence as Record<string, unknown>).brief_status).toBe('none');

    await generateBrief(db, id, llmOf([new Error('上游挂了')]));
    const failed = await call('evidence_get', { evidence_id: id });
    expect((failed.evidence as Record<string, unknown>).brief_status).toBe('failed');
    expect(String((failed.evidence as Record<string, unknown>).brief_error)).toContain('上游挂了');

    const listed = (await call('evidence_list', { case_id: caseId })).evidence as Record<
      string,
      unknown
    >[];
    expect(listed[0].brief_status).toBe('failed');
    expect(String(listed[0].brief_error)).toContain('上游挂了');

    await generateBrief(db, id, llmOf([GOOD_BRIEF]));
    const okGet = await call('evidence_get', { evidence_id: id });
    expect((okGet.evidence as Record<string, unknown>).brief_status).toBe('ok');
    expect((okGet.evidence as Record<string, unknown>).brief_error).toBeNull();
  });

  test('briefStatusOf 不把 failed 归进 none（两档要做的事不一样）', () => {
    expect(briefStatusOf(null, null).brief_status).toBe('none');
    expect(briefStatusOf(null, '上游挂了').brief_status).toBe('failed');
    expect(briefStatusOf(GOOD_BRIEF, '陈年旧账').brief_status).toBe('ok');
  });
});

describe('evidence_brief_regenerate', () => {
  test('成功后 brief_error 清空、brief_status 回 ok，且这一次不计费', async () => {
    const id = makeEvidence();
    await generateBrief(db, id, llmOf([new Error('上游挂了')]));

    const briefLlm = await import('@/lib/evidence/brief-llm');
    vi.spyOn(briefLlm, 'defaultBriefLlm').mockReturnValue(llmOf([GOOD_BRIEF]));

    const res = await call('evidence_brief_regenerate', { evidence_id: id });
    expect(res.ok).toBe(true);
    expect(errorOf(id)).toBeNull();

    const got = await call('evidence_get', { evidence_id: id });
    expect((got.evidence as Record<string, unknown>).brief_status).toBe('ok');
    // 免费：这条路径一分账都不该记
    expect(db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get()).toEqual({ n: 0 });
  });

  test('再失败回错误原文，不翻译成一句「生成失败」', async () => {
    const id = makeEvidence();
    const briefLlm = await import('@/lib/evidence/brief-llm');
    vi.spyOn(briefLlm, 'defaultBriefLlm').mockReturnValue(llmOf([new Error('上游仍然挂着')]));

    const res = await call('evidence_brief_regenerate', { evidence_id: id });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('BRIEF_GENERATE_FAILED');
    expect(String(res.message)).toContain('上游仍然挂着');
  });

  test('已有简报的一律拒，不覆盖', async () => {
    const id = makeEvidence();
    await generateBrief(db, id, llmOf([GOOD_BRIEF]));
    const res = await call('evidence_brief_regenerate', { evidence_id: id });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('BRIEF_ALREADY_EXISTS');
  });
});
