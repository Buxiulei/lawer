// app/src/app/api/v1/referrals/__tests__/route.test.ts
// 设置页那张卡吃的就是这条端点。两条底线：
// ① **没有转介记录时回空数组**——卡片据此整张不渲染。回一条占位、或回 404，
//    都会让设置页里冒出一段劝人去做心理咨询的话，而那个人从没提过这件事。
// ② **不回数据包全文**：payload_json 里有姓名与情绪摘要，那是给对方机构准备的，
//    不该在浏览器缓存里再躺一遍。
//
// 外加一条对齐判据：同意文案的每一项都对得上数据包里一个真字段。
// 「逐项列出会传什么」这句承诺，靠的就是这条——改了数据包却忘了改文案时当场红。
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

import type { Database } from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, test } from 'vitest';

import { REFERRAL_CONSENT_ITEMS } from '@/lib/referral';

let GET: (req: Request) => Promise<Response>;
let db: Database;
let signToken: (uid: number) => string;
let createReferral: typeof import('@/lib/referral').createReferral;

function req(auth?: string): Request {
  const headers: Record<string, string> = {};
  if (auth) headers.authorization = `Bearer ${auth}`;
  return new Request('http://localhost/api/v1/referrals', { headers });
}

beforeAll(async () => {
  process.env.JWT_SECRET = 'test-secret-do-not-use-in-prod';
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
  process.env.DB_PATH = path.join(os.tmpdir(), `lawer-referrals-${crypto.randomUUID()}.db`);
  GET = (await import('../route')).GET;
  signToken = (await import('@/lib/auth/jwt')).signToken;
  createReferral = (await import('@/lib/referral')).createReferral;
  db = (await import('@/lib/db/client')).getDb();
});

beforeEach(() => {
  db.exec('DELETE FROM referrals; DELETE FROM cases; DELETE FROM users;');
});

function seed(): { uid: number; caseId: number } {
  const uid = Number(
    db.prepare("INSERT INTO users (phone_hash) VALUES ('h-a')").run().lastInsertRowid,
  );
  const caseId = Number(
    db
      .prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, '我的案件', '约谈中')")
      .run(uid).lastInsertRowid,
  );
  return { uid, caseId };
}

describe('GET /api/v1/referrals', () => {
  test('无 token → 401', async () => {
    expect((await GET(req())).status).toBe(401);
  });

  test('从没转介过 → 空数组（卡片据此整张不渲染），不是 404 也不是占位', async () => {
    const { uid } = seed();
    const body = await (await GET(req(signToken(uid)))).json();
    expect(body.ok).toBe(true);
    expect(body.referrals).toEqual([]);
    expect(body.consent.shared.length).toBeGreaterThan(0);
  });

  test('有记录 → 带状态回来，且不含数据包全文', async () => {
    const { uid, caseId } = seed();
    const made = await createReferral(db, {
      caseId,
      userId: uid,
      reason: '想找人聊聊',
      needs: ['睡眠'],
      consent: true,
    });
    if (made.ok !== true) throw new Error('建包失败');

    const body = await (await GET(req(signToken(uid)))).json();
    expect(body.referrals).toHaveLength(1);
    expect(body.referrals[0]).toMatchObject({ status: 'pending', case_id: caseId });
    // 数据包全文不出网：台账行只有状态字段，摘要与姓名一个都不在里面。
    // （断言只盯 referrals 那一段——consent 段里本来就有 "emotion_summary" 这个**字段名**，
    //  拿整份响应搜关键词会把那句同意文案误判成泄漏。）
    const listRaw = JSON.stringify(body.referrals);
    expect(listRaw).not.toContain('emotion_summary');
    expect(listRaw).not.toContain('payload_json');
    expect(Object.keys(body.referrals[0]).sort()).toEqual([
      'attempts',
      'case_id',
      'consent_at',
      'created_at',
      'external_ref',
      'last_error',
      'referral_id',
      'status',
      'updated_at',
    ]);
  });

  test('只看得到自己的：乙拿不到甲的转介', async () => {
    const { uid, caseId } = seed();
    const made = await createReferral(db, {
      caseId,
      userId: uid,
      reason: '',
      needs: [],
      consent: true,
    });
    if (made.ok !== true) throw new Error('建包失败');
    const other = Number(
      db.prepare("INSERT INTO users (phone_hash) VALUES ('h-b')").run().lastInsertRowid,
    );
    const body = await (await GET(req(signToken(other)))).json();
    expect(body.referrals).toEqual([]);
  });
});

describe('同意文案 ↔ 数据包字段一一对应', () => {
  /**
   * 这两个键**刻意不在同意文案里**，各有理由：
   *   source_system —— 常量 'tubashu'，说的是「这条线索从哪来」，不是这个人的资料；
   *   emotion_summary_redactions —— 一个数字（挡掉了几个词），已并进摘要那一条的措辞里。
   * 名单写死在这里，是为了让**新加的字段**必须在两处之一现身：
   * 要么进同意文案，要么进这张名单并写清为什么。悄悄多传一个字段做不到。
   */
  const NOT_USER_DATA = ['source_system', 'emotion_summary_redactions'];

  test('文案里的每一项都是数据包里的真字段，反之亦然', async () => {
    const { uid, caseId } = seed();
    const made = await createReferral(db, {
      caseId,
      userId: uid,
      reason: '',
      needs: [],
      consent: true,
    });
    if (made.ok !== true) throw new Error('建包失败');

    const packetKeys = Object.keys(made.packet);
    const consentFields = REFERRAL_CONSENT_ITEMS.map((i) => i.field);

    for (const f of consentFields) {
      expect(packetKeys, `同意文案列了「${f}」，数据包里却没有这个字段`).toContain(f);
    }
    const uncovered = packetKeys.filter(
      (k) => !consentFields.includes(k) && !NOT_USER_DATA.includes(k),
    );
    expect(
      uncovered,
      `这些字段会发出去、却没在同意文案里列出：${uncovered.join(', ')}。` +
        '要么给它写一条同意项，要么并进 NOT_USER_DATA 并说明为什么它不算用户资料。',
    ).toEqual([]);
  });
});
