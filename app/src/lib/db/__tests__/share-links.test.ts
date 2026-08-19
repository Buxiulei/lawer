import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import * as store from '../share-links';

let db: Database.Database;
let caseId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('h').lastInsertRowid);
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uid, '测试案件').lastInsertRowid,
  );
});

/** 相对当下 h 小时的 canonical 串，由 SQLite 自己算，免得测试与库对不上时区 */
function at(h: number): string {
  return (db.prepare("SELECT datetime('now', ?) AS t").get(`${h} hours`) as { t: string }).t;
}

describe('share_links', () => {
  it('未过期未撤销的链接能按 token 找到', () => {
    store.create(db, { caseId, token: 'tok-ok', scope: '档案只读', expiresAt: at(24) });
    const got = store.findActive(db, 'tok-ok')!;
    expect(got.case_id).toBe(caseId);
    expect(got.scope).toBe('档案只读');
    expect(got.revoked_at).toBeNull();
  });

  it('已过期的链接找不到（过去时间）', () => {
    store.create(db, { caseId, token: 'tok-expired', scope: '档案只读', expiresAt: at(-1) });
    expect(store.findActive(db, 'tok-expired')).toBeUndefined();
    // 行还在，只是不活跃
    expect(store.listByCase(db, caseId)).toHaveLength(1);
  });

  it('撤销后立刻失效，且不删行（保留审计）', () => {
    const id = store.create(db, { caseId, token: 'tok-rev', scope: '单文件下载', expiresAt: at(24) });
    expect(store.findActive(db, 'tok-rev')).toBeDefined();
    store.revoke(db, id);
    expect(store.findActive(db, 'tok-rev')).toBeUndefined();
    expect(store.listByCase(db, caseId)[0].revoked_at).not.toBeNull();
  });

  it('重复撤销幂等：不改首次撤销时点', () => {
    const id = store.create(db, { caseId, token: 'tok-twice', scope: '档案只读', expiresAt: at(24) });
    db.prepare("UPDATE share_links SET revoked_at = '2020-01-01 00:00:00' WHERE id = ?").run(id);
    store.revoke(db, id);
    expect(store.listByCase(db, caseId)[0].revoked_at).toBe('2020-01-01 00:00:00');
  });

  it('expiresAt 收 ISO 串也归一成 canonical，不原样落库', () => {
    store.create(db, { caseId, token: 'tok-iso', scope: '档案只读', expiresAt: '2099-01-02T03:04:05.678Z' });
    expect(store.listByCase(db, caseId)[0].expires_at).toBe('2099-01-02 03:04:05');
    // 归一之后过期判定才成立（原样存 ISO 串会因 'T' > ' ' 排序错乱）
    expect(store.findActive(db, 'tok-iso')).toBeDefined();
  });

  it('token 唯一：同 token 二次创建被拒', () => {
    store.create(db, { caseId, token: 'dup', scope: '档案只读', expiresAt: at(24) });
    expect(() =>
      store.create(db, { caseId, token: 'dup', scope: '档案只读', expiresAt: at(24) }),
    ).toThrow(/UNIQUE/);
  });

  it('findActive 查不存在的 token 回 undefined（与过期/撤销不作区分）', () => {
    expect(store.findActive(db, 'nope')).toBeUndefined();
  });

  it('listByCase 新到旧，过期与已撤销的也列出来', () => {
    const a = store.create(db, { caseId, token: 't1', scope: '档案只读', expiresAt: at(-1) });
    const b = store.create(db, { caseId, token: 't2', scope: '档案只读', expiresAt: at(24) });
    store.revoke(db, b);
    expect(store.listByCase(db, caseId).map((r) => r.id)).toEqual([b, a]);
  });
});
