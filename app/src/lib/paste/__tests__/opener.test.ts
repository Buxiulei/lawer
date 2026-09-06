// 开场白的三条判据：三档都不超预算、指南段在任何档位任何数据形态下都完整、非本人案件当不存在。
//
// 【变异臂（手工跑过，2026-09-06）】
//  ① 把 opener.ts 里的指南从固定段挪进 optional 数组（让它参与裁剪）
//     ⇒「short 档也带完整指南」当场红。
//  ② 把 fitToRoom 的留痕注释去掉（静默截断）⇒「裁掉的要留痕」红。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { runMigrations } from '@/lib/db/migrate';
import { GUIDE_HEADING } from '../guide';
import { buildOpener, OPENER_TIERS, type OpenerTier } from '../opener';
import { FENCE_TAG, PROTOCOL_HEADING } from '../protocol';

const TIERS = Object.keys(OPENER_TIERS) as OpenerTier[];

/** 指南里四条纪律各自的锚句。少一条 = 助手少一条不会犯的错。 */
const GUIDE_ANCHORS = [
  '危机信号优先于案情',
  '引用纪律',
  '对外的东西由本人拍板',
  '不劝他去找律师',
];

/** 网页登录态的身份（api key 那一路只是多一个 keyId，与开场白无关） */
const asUser = (uid: number): Identity => ({ uid, via: 'jwt', scopes: ['case:read', 'case:write'] });

let db: Database.Database;
let uid: number;
let otherUid: number;
let caseId: number;

const me = () => asUser(uid);
const other = () => asUser(otherUid);

function insertEvidence(name: string, proves: string): void {
  const fileId = Number(
    db.prepare("INSERT INTO files (sha256, size, enc_path) VALUES (?, 10, '/x')").run(name)
      .lastInsertRowid,
  );
  db.prepare(
    'INSERT INTO evidence (case_id, user_id, file_id, name, category, prove_purpose, extraction_status, brief_json)' +
      " VALUES (?, ?, ?, ?, '沟通记录', '证明约谈发生过', 'done', ?)",
  ).run(
    caseId,
    uid,
    fileId,
    name,
    JSON.stringify({
      proves,
      key_facts: [],
      relation_to_claims: '支持欠薪一项',
      weaknesses: [],
      suggested_followups: [],
      citations: [],
    }),
  );
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('a').lastInsertRowid);
  otherUid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('b').lastInsertRowid);
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uid, '我的案子').lastInsertRowid,
  );
});

/** 把案子撑到远超任何一档预算：50 条时间线 + 30 件带简报的证据 */
function fatten(): void {
  const ev = db.prepare(
    "INSERT INTO timeline_events (case_id, happened_at, kind, title, detail) VALUES (?, ?, '公司动作', ?, ?)",
  );
  for (let i = 0; i < 50; i += 1) {
    ev.run(caseId, `2026-07-${String((i % 28) + 1).padStart(2, '0')}T09:00:00.000Z`, `第 ${i} 次约谈`, '细'.repeat(200));
  }
  for (let i = 0; i < 30; i += 1) insertEvidence(`材料${i}`, '这份材料能证明的事情'.repeat(20));
}

describe('三档预算', () => {
  it.each(TIERS)('%s 档不超上限（空案件）', (tier) => {
    const res = buildOpener(db, { caseId, identity: me(), tier });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.length).toBeLessThanOrEqual(OPENER_TIERS[tier]);
  });

  it.each(TIERS)('%s 档不超上限（数据量远超预算）', (tier) => {
    fatten();
    const res = buildOpener(db, { caseId, identity: me(), tier });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text.length).toBeLessThanOrEqual(OPENER_TIERS[tier]);
  });

  it('档位越宽给得越多（否则三档等于只有一档）', () => {
    fatten();
    const len = (tier: OpenerTier) => {
      const r = buildOpener(db, { caseId, identity: me(), tier });
      return r.ok ? r.text.length : 0;
    };
    expect(len('long')).toBeGreaterThan(len('medium'));
    expect(len('medium')).toBeGreaterThan(len('short'));
  });
});

describe('指南段永远在', () => {
  it.each(TIERS)('%s 档（空案件）带完整指南与回填约定', (tier) => {
    const res = buildOpener(db, { caseId, identity: me(), tier });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain(GUIDE_HEADING);
    for (const anchor of GUIDE_ANCHORS) expect(res.text).toContain(anchor);
    expect(res.text).toContain(PROTOCOL_HEADING);
    expect(res.text).toContain('```' + FENCE_TAG);
  });

  it.each(TIERS)('%s 档（数据量远超预算，逼出裁剪）指南一个字都没少', (tier) => {
    fatten();
    const res = buildOpener(db, { caseId, identity: me(), tier });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.text).toContain(GUIDE_HEADING);
    for (const anchor of GUIDE_ANCHORS) expect(res.text).toContain(anchor);
    expect(res.text).toContain(PROTOCOL_HEADING);
  });

  it('short 档真的被逼着裁了东西，且裁了有留痕（否则上一条是空过）', () => {
    fatten();
    const res = buildOpener(db, { caseId, identity: me(), tier: 'short' });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // 裁剪确实发生：要么整段没放下（omitted 有名字），要么段内截断（留痕句在）
    const trimmed = res.omitted.length > 0 || res.text.includes('此处按篇幅截断');
    expect(trimmed, 'short 档没有触发任何裁剪，这条判据没验到东西').toBe(true);
    // 被裁掉的东西必须让模型知道「有但没给你」
    expect(res.text).toMatch(/未附|没有附上/);
  });
});

describe('归属', () => {
  it('别人的案子回 CASE_NOT_FOUND（不区分不存在与不是你的）', () => {
    const res = buildOpener(db, { caseId, identity: other(), tier: 'long' });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('CASE_NOT_FOUND');
  });
});
