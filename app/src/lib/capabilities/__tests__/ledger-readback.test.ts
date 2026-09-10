// app/src/lib/capabilities/__tests__/ledger-readback.test.ts
//
// 行为判据：**「这次没写东西」与「写了但回读不到那一行」是两件事，台账层对两者的反应不同。**
//   · 没写   ⇒ 0 行、0 条日志（给什么都没发生记一行，事后复盘时那个不可撤销的动作
//              在台账里比实际多发生过几次）；
//   · 回读失败 ⇒ 0 行、**1 条 console.error**，三段式且点得出能力名与那个 id。
//
// ── 这组补的是哪个缺口（2026-09-10 复审）──
// 有六处 rowsOf 的目标行要回读一次才知道（分享链接、转介、两条证据简报、逐件出证、一次性上传地址），
// 回读不到时它们一律回空数组——而空数组的约定就是「这次没写东西」。于是：
// 用户真的撤了一条链接、真的出了一份证（花了钱、不可撤销），台账里没有那一行，
// 回包 200、日志干净、没有任何一处会说。缺一行与本来就没有那一行，事后长得一模一样。
//
// ── 为什么直接喂 rowsOf 而不是走两道门 ──
// 要复现的是「业务写成了，回读那一刻那行不在了」。经门跑一遍拿不到这个状态
//（写成功的调用回读一定成功），而这份判据要钉的正是台账元数据在那一刻的反应。
// 所以这里按真实回包的形状喂给 recordCapabilityWrite——它就是两道门各自调的那一句。
//
// ── 变异臂（同一份判据上手工验过，2026-09-10）──
//  ① 把任一处 rowsOf 的 `{ unresolved }` 改回 `[]`（两种情况混回一种）
//     ⇒ 该条的「有日志」当场红。
//  ② 反过来把 case_delete 确认单那一步也改成回 unresolved
//     ⇒ 「没写就别报警」那条红（正常的两步确认每天报一条 error）。
//  ③ 把 ledger.ts 里 `'unresolved' in entry` 那一段删掉 ⇒ 六条全红（回读失败重新变静默）。
import BetterSqlite3, { type Database } from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { runMigrations } from '@/lib/db/migrate';
import { issueUploadToken } from '@/lib/evidence/upload-token';

import { getCapability } from '..';
import { recordCapabilityWrite } from '../ledger';

let db: Database;
let caseId: number;
let identity: Identity;
let errors: string[];

/** 库里绝不存在的 id：回读必然落空，正是要复现的那一刻 */
const GONE = 999_999;

/** 同上，按明文哈希查的那一条（evidence_upload_tokens 只存哈希，不存明文） */
const TOKEN_GONE = 'tok-已经不在了';

beforeEach(() => {
  db = new BetterSqlite3(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(
    db.prepare("INSERT INTO users (phone_hash, auth_status) VALUES ('h', '已实名')").run().lastInsertRowid,
  );
  caseId = Number(
    db.prepare("INSERT INTO cases (user_id, title, stage) VALUES (?, ?, '已收通知')").run(uid, '本人的案子')
      .lastInsertRowid,
  );
  // agent_writes.key_id 是真外键：拿一个不存在的 id 会在写台账那一步撞 FK，
  // 而那个报错离病因隔着好几层。所以夹具里发一把真的 key。
  const keyId = Number(
    db
      .prepare(
        "INSERT INTO api_keys (user_id, name, key_hash, scopes, enabled) VALUES (?, 'k', 'h', '[\"case:read\",\"case:write\"]', 1)",
      )
      .run(uid).lastInsertRowid,
  );
  identity = { uid, via: 'api_key', scopes: ['case:read', 'case:write'], keyId };

  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    errors.push(args.map(String).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** 按两道门的调法记一次台账（门里那一句逐字就是它）。 */
function record(name: string, args: Record<string, unknown>, result: Record<string, unknown>): void {
  const capability = getCapability(name);
  expect(capability, `注册表里没有 ${name}`).toBeDefined();
  recordCapabilityWrite(db, identity, capability!, args, result, 'mcp');
}

function ledgerRows(): { tool: string; target_table: string; target_id: number }[] {
  return db
    .prepare('SELECT tool, target_table, target_id FROM agent_writes ORDER BY id')
    .all() as { tool: string; target_table: string; target_id: number }[];
}

/** 六条要回读案件号（或目标行）的能力，各配一份「那一行已经不在了」的真实回包形状。 */
const READBACK: [string, Record<string, unknown>, Record<string, unknown>, string][] = [
  ['share_revoke', { share_id: GONE }, { already_revoked: false }, `share_id=${GONE}`],
  [
    'referral_delete_request',
    { referral_id: GONE },
    { already_requested: false },
    `referral_id=${GONE}`,
  ],
  ['evidence_brief_update', { evidence_id: GONE }, { evidence_id: GONE }, `evidence_id=${GONE}`],
  ['evidence_brief_regenerate', { evidence_id: GONE }, { evidence_id: GONE }, `evidence_id=${GONE}`],
  [
    'evidence_attest',
    { evidence_ids: [GONE] },
    { results: [{ ok: true, evidence_id: GONE, order_no: 'ORD-1' }] },
    `evidence_id=${GONE}`,
  ],
  // 这一条按 token 明文回读（回包里不给行 id）。回读不到 = 地址已经签出去了、
  // 对方拿着它就能往案卷里写字节，而台账里没有这一行。
  [
    'evidence_upload_url',
    { case_id: GONE },
    { upload_token: TOKEN_GONE },
    `upload_token=${TOKEN_GONE}`,
  ],
];

describe('写了但回读失败：点名，且不落假行', () => {
  it.each(READBACK)(
    '%s 回读不到 ⇒ 一条 error 日志（点名能力与 id），台账零行',
    (name, args, result, idHint) => {
      record(name, args, result);

      expect(ledgerRows(), `${name}：定位不到行时不许拿猜的 case_id 落一行`).toEqual([]);
      expect(errors, `${name}：回读失败静默过去 = 台账缺一行且没有任何一处会说`).toHaveLength(1);
      // 三段式：缺什么（哪条能力、哪道门、哪个 id）/ 为什么缺 / 怎么办
      expect(errors[0]).toContain(name);
      expect(errors[0]).toContain(idHint);
      expect(errors[0]).toContain('为什么：');
      expect(errors[0]).toContain('怎么办：');
      // 出路要说对：这一次业务写入是成功的，照着日志去重放会写第二遍
      expect(errors[0]).toContain('不要重放这次调用');
    },
  );
});

describe('这次没写东西：不记，也不报警', () => {
  /**
   * 两步删除的第一步只出确认单，一行都没删。它与上面五条在**回包**上没有任何区别可言
   *（都是一次 ok 的调用、台账都不该多行），区别只在语义——所以两者必须在
   * rowsOf 那一层就分成两个东西。混成一种的形态是二选一：
   * 要么正常的两步确认每天报一条 error，要么真出了事的那五条继续静默。
   */
  it('case_delete 出确认单那一步 ⇒ 0 行且**没有** error 日志（变异：把它也改成 unresolved → 红）', () => {
    record('case_delete', { case_id: caseId }, { stage: 'confirm' });
    expect(ledgerRows()).toEqual([]);
    expect(errors, '什么都没发生的一步不该在生产日志里报错').toEqual([]);
  });

  it('evidence_attest 里失败的那一件 ⇒ 不记也不报警（没成的件本来就没写东西）', () => {
    record(
      'evidence_attest',
      { evidence_ids: [GONE] },
      { results: [{ ok: false, evidence_id: GONE, error_code: 'TSA_UNREACHABLE' }] },
    );
    expect(ledgerRows()).toEqual([]);
    expect(errors).toEqual([]);
  });
});

describe('对照臂：回读得到时照常落行、不报警（否则上面几条可能只是恒不记）', () => {
  it('share_revoke 那条链接还在 ⇒ 台账一行，零日志', () => {
    const shareId = Number(
      db
        .prepare(
          "INSERT INTO share_links (case_id, token, scope, expires_at) VALUES (?, 't-1', '档案只读', '2030-01-01T00:00:00.000Z')",
        )
        .run(caseId).lastInsertRowid,
    );
    record('share_revoke', { share_id: shareId }, { already_revoked: false });

    expect(ledgerRows()).toEqual([
      { tool: 'share_revoke', target_table: 'share_links', target_id: shareId },
    ]);
    expect(errors).toEqual([]);
  });

  it('evidence_upload_url 那条 token 还在 ⇒ 台账一行，零日志', () => {
    const issued = issueUploadToken(db, {
      caseId,
      userId: identity.uid,
      filename: '面谈录音.m4a',
      mime: 'audio/m4a',
      size: 1024,
    });
    record('evidence_upload_url', { case_id: caseId }, { upload_token: issued.token });

    expect(ledgerRows()).toEqual([
      {
        tool: 'evidence_upload_url',
        target_table: 'evidence_upload_tokens',
        target_id: issued.row.id,
      },
    ]);
    expect(errors).toEqual([]);
  });
});
