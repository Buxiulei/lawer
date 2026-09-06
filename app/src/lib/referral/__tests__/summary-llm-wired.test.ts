/**
 * 【生产壳到底把模型接上了没有】判据（设计稿 §14 决定 4：情绪状态摘要由模型总结 ≤200 字）。
 *
 * 【为什么单独一个文件、且非 mock 不可】lib/referral 那份判据全部**自己传 llm 进去**，
 * 钉住的只是「我传的那个假模型被用了」。而生产上真正决定有没有模型的，是工具壳
 * families/referral.ts 传不传 —— 它不传的形态是：buildPacket 恒走兜底摘要，
 * 「模型总结」这件事从未发生过，可对方收到的那段话依然通顺（兜底也是完整句子），
 * 从产物上看不出任何异常。2026-09-06 复核实测：把 summary-llm.ts 整个删掉，
 * tsc 与全套判据照样全绿——即它当时是死代码。
 * 只有把「挑模型」这一层 mock 掉，才能让 cap.run 一个额外参数都不传地跑真默认路径。
 *
 * 【判据 ↔ 变异臂】
 *  1) 壳会把模型注入 buildPacket：模型被调恰好一次，产物是模型写的那段，不是兜底那段
 *     «families/referral.ts 去掉 `llm: defaultSummaryLlm()` ⇒ 红»
 *  2) 喂给模型的原料同时含近 30 天情绪记录与最近对话
 *     «buildPacket 取了 talk 却不传给 draftSummary ⇒ 红»
 *  3) 挑模型回 null（缺 key / 那家不实现 chatJSON）⇒ 转介照常成功，回落兜底
 *     «工具壳把 null 当成致命错而不是回落 ⇒ 红»。注意本文件 mock 掉了挑模型那一层，
 *     所以 defaultSummaryLlm 自己「不抛错」那条另在 summary-llm-null.test.ts 钉
 */
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { getCapability } from '@/lib/capabilities';
import { encryptField, hashLookup } from '@/lib/crypto';
import { runMigrations } from '@/lib/db/migrate';
import * as referralStore from '@/lib/db/referrals';

import type { SummaryLlm } from '../packet';

/** vi.mock 的 defaultSummaryLlm 回它。每条判据自己赋值，afterEach 复位。 */
let mockedLlm: SummaryLlm | null = null;

vi.mock('@/lib/referral/summary-llm', () => ({
  defaultSummaryLlm: () => mockedLlm,
}));

const PHONE = '13800138001';
const NOTE = '半夜三点还醒着';
const TALK = '我今天又什么都不想做';
/** 模型写的那段：措辞全部避开中立化词表，好让「产物 = 模型这段」这条断言说得清。 */
const MODEL_SUMMARY = '最近两周入睡困难，白天精力很差，自我评价偏低，但仍愿意找人聊聊。';
/** 兜底摘要的指纹（packet.fallbackSummary 的末句）。 */
const FALLBACK_MARK = '这段是按记录统计生成的';

let db: Database.Database;
let uid: number;
let caseId: number;
let identity: Identity;
let seen: string[] = [];

beforeAll(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
});

beforeEach(() => {
  seen = [];
  mockedLlm = {
    chatJSON: async (messages) => {
      seen.push(messages.map((m) => m.content).join('\n'));
      return JSON.stringify({ summary: MODEL_SUMMARY });
    },
  };

  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);

  uid = Number(
    db
      .prepare('INSERT INTO users (phone_enc, phone_hash) VALUES (?, ?)')
      .run(encryptField(PHONE), hashLookup(PHONE)).lastInsertRowid,
  );
  const keyId = Number(
    db
      .prepare(
        "INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?, '测试钥匙', 'kh2', '[\"case:read\",\"case:write\"]')",
      )
      .run(uid).lastInsertRowid,
  );
  identity = { uid, via: 'api_key', scopes: ['case:read', 'case:write'], keyId };

  caseId = Number(
    db
      .prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '我的案件', '约谈中')")
      .run(uid).lastInsertRowid,
  );
  db.prepare("INSERT INTO emotion_log (case_id, level, note) VALUES (?, '焦虑', ?)").run(caseId, NOTE);
  const threadId = Number(
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '陪跑')").run(caseId).lastInsertRowid,
  );
  db.prepare("INSERT INTO messages (thread_id, role, content) VALUES (?, 'user', ?)").run(
    threadId,
    TALK,
  );
});

afterEach(() => {
  mockedLlm = null;
  db.close();
});

async function create(): Promise<{ ok: boolean; referral_id: number }> {
  const cap = getCapability('referral_create')!;
  const out = (await cap.run(db, identity, {
    case_id: caseId,
    consent: true,
    reason: '想找人聊聊',
    needs: ['情绪疏导'],
  })) as { ok: boolean; referral_id: number; message?: string };
  if (out.ok !== true) throw new Error(`转介失败：${out.message}`);
  return out;
}

describe('生产壳会把模型注入 buildPacket', () => {
  it('模型被调恰好一次，落库那份是模型写的，不是兜底（变异：壳不传 llm ⇒ 红）', async () => {
    const out = await create();

    expect(seen.length, '工具壳没有把模型传进 buildPacket：一次都没调').toBe(1);

    const payload = referralStore.findReferralById(db, out.referral_id)!.payload_json;
    const packet = JSON.parse(payload) as { emotion_summary: string };
    expect(packet.emotion_summary).toContain('入睡困难');
    expect(packet.emotion_summary, '产物落回了兜底摘要，说明模型没接上').not.toContain(
      FALLBACK_MARK,
    );
    // 单变量对照的另一臂：兜底那段确实与模型这段截然不同，上一条不是恒真。
    expect(MODEL_SUMMARY).not.toContain(FALLBACK_MARK);
  });

  it('喂给模型的原料同时含近 30 天情绪记录与最近对话（变异：talk 取了不传 ⇒ 红）', async () => {
    await create();
    expect(seen[0], '情绪记录没进原料').toContain(NOTE);
    expect(seen[0], '最近对话取了却没进原料').toContain(TALK);
  });

  it('挑模型回 null ⇒ 转介照常成功并回落兜底（缺 key 不该让已同意的转介失败）', async () => {
    mockedLlm = null;
    const out = await create();
    const packet = JSON.parse(
      referralStore.findReferralById(db, out.referral_id)!.payload_json,
    ) as { emotion_summary: string };
    expect(packet.emotion_summary).toContain(FALLBACK_MARK);
  });
});
