// app/src/lib/__tests__/ai-label-share.test.ts
// 免登录分享页的生成合成内容标识（《人工智能生成合成内容标识办法》§4）。
//
// 【为什么分享这一路要单独钉】站内那句提示只活在登录用户的屏幕上；
// 一条分享链接交出去之后，站在它前面的是一个**没有账号、也没读过我们任何说明**的人，
// 他手上没有任何别的线索能看出这份东西是模型写的。
//
// 【两侧都钉：该有的必须有，不该有的必须没有】
//   · 文书分享（正文整篇是生成合成内容）→ 必须给；
//   · 证据分享（用户自己的材料元数据与文件哈希，一个字都不是生成的）→ 必须**不给**。
// 只钉前一半的形态是：把 ai_label 改成恒给，判据照样全绿，而《存证证明》那条链路上
// 一份可以拿出去用的材料从此顶着一句「由人工智能生成」——往严重方向说的假话也是假话。
import crypto from 'node:crypto';

import Database from 'better-sqlite3';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as cases from '@/lib/cases';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';
import { createShare, readShare } from '@/lib/shares';

let db: Database.Database;
let uid: number;

beforeAll(() => {
  process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');
});

beforeEach(() => {
  process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('als').lastInsertRowid);
});

function makeCase(domain: string): number {
  const made = cases.ensureDefaultCase(db, uid, domain);
  if ('ok' in made) throw new Error(`建案失败：${JSON.stringify(made)}`);
  return made.caseId;
}

/** 挑一份**不进对外清单**的文书（对外件另要「发出后果说明」，与本判据无关）。 */
function internalKind(domain: string): string {
  const pack = DOMAINS[domain];
  return pack.docKinds.find((k) => !pack.outboundDocKinds.includes(k))!;
}

function sharedDraft(domain: string): { state: string; ai_label?: string | null } {
  const caseId = makeCase(domain);
  const made = cases.writeDraft(db, {
    caseId,
    userId: uid,
    kind: internalKind(domain),
    title: '一份文书',
    body: '正文若干。',
  });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const share = createShare(db, { userId: uid, draftId: made.draft.id });
  if (!share.ok) throw new Error(JSON.stringify(share));
  const read = readShare(db, share.token);
  if (read.state !== 'ok') return { state: read.state };
  return { state: 'ok', ai_label: read.view.ai_label };
}

describe('分享页的生成合成内容标识（标识办法 §4）', () => {
  it('文书分享带本领域那半句（变异：把 ai_label 改成恒 null → 红）', () => {
    const got = sharedDraft(DEFAULT_DOMAIN);
    expect(got.state).toBe('ok');
    expect(got.ai_label).toBe(DOMAINS[DEFAULT_DOMAIN].copy.pages.aiLabelDisclaimer);
  });

  it('第二个领域拿到的是它自己那半句（变异：写死成缺省包 → 红）', () => {
    const got = sharedDraft('counseling');
    expect(got.ai_label).toBe(DOMAINS.counseling.copy.pages.aiLabelDisclaimer);
    expect(got.ai_label, '分享页上印着另一个行当的那句话').not.toBe(
      DOMAINS[DEFAULT_DOMAIN].copy.pages.aiLabelDisclaimer,
    );
  });

  it('证据分享恒不带标识（变异：把 ai_label 改成恒给 → 红）', () => {
    const caseId = makeCase(DEFAULT_DOMAIN);
    const fileId = Number(
      db
        .prepare('INSERT INTO files (sha256, size, mime, enc_path) VALUES (?, ?, ?, ?)')
        .run('b'.repeat(64), 1, 'audio/mp4', '/dev/null').lastInsertRowid,
    );
    const evId = Number(
      db
        .prepare(
          `INSERT INTO evidence (case_id, user_id, file_id, name, category, status, prove_purpose, original_medium)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(caseId, uid, fileId, '一段录音', '录音', '已上传', '证明当时说过', '手机录音')
        .lastInsertRowid,
    );
    const share = createShare(db, { userId: uid, evidenceId: evId });
    if (!share.ok) throw new Error(JSON.stringify(share));
    const read = readShare(db, share.token);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') return;
    expect(
      read.view.ai_label,
      '一份用户自己的材料被标成了人工智能生成的内容',
    ).toBeNull();
  });
});
