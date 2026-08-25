import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../migrate';
import * as store from '../referral-offers';

let db: Database.Database;
let userId: number;
let caseId: number;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  userId = mkUser();
  caseId = mkCase(userId);
});

function mkUser(): number {
  return Number(db.prepare('INSERT INTO users DEFAULT VALUES').run().lastInsertRowid);
}

function mkCase(uid: number): number {
  return Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '测试案件').lastInsertRowid,
  );
}

function mkThread(cid: number): number {
  return Number(
    db.prepare("INSERT INTO threads (case_id, mode) VALUES (?, '陪跑')").run(cid).lastInsertRowid,
  );
}

function count(): number {
  return (db.prepare('SELECT COUNT(*) c FROM referral_offers').get() as { c: number }).c;
}

/** 五个可推位点（四个案件节点 + 情绪场景）。 */
const SCENES: store.ReferralScene[] = ['收到裁员通知', '立案后', '开庭前', '拿到结果后', '情绪场景'];

describe('tryOffer 频控闸门', () => {
  it('同一 (user, case, scene) 二次 tryOffer 返 false，且不落第二行', () => {
    expect(store.tryOffer(db, { userId, caseId, scene: '开庭前' })).toBe(true);
    expect(store.tryOffer(db, { userId, caseId, scene: '开庭前' })).toBe(false);
    expect(count()).toBe(1);
  });

  it('五个位点各可推一次，各落一行', () => {
    for (const scene of SCENES) {
      expect(store.tryOffer(db, { userId, caseId, scene }), scene).toBe(true);
      expect(store.tryOffer(db, { userId, caseId, scene }), `${scene} 二次`).toBe(false);
    }
    expect(count()).toBe(5);
  });

  it('不同用户互不影响（频控按人算）', () => {
    const other = mkUser();
    const otherCase = mkCase(other);
    expect(store.tryOffer(db, { userId, caseId, scene: '立案后' })).toBe(true);
    expect(store.tryOffer(db, { userId: other, caseId: otherCase, scene: '立案后' })).toBe(true);
  });

  it('落行内容完整：thread_id / note 如实存下（审计要能看到当时怎么说的）', () => {
    const threadId = mkThread(caseId);
    store.tryOffer(db, { userId, caseId, scene: '情绪场景', threadId, note: '连续三轮低落' });
    const [row] = store.listByUser(db, userId);
    expect(row).toMatchObject({
      user_id: userId,
      case_id: caseId,
      scene: '情绪场景',
      outcome: 'offered',
      thread_id: threadId,
      note: '连续三轮低落',
    });
  });
});

describe('recordDecline —— 拒绝全局永久生效', () => {
  it('拒绝后 shouldStopOffering 为 true', () => {
    expect(store.shouldStopOffering(db, userId)).toBe(false);
    store.recordDecline(db, { userId, caseId, scene: '立案后', note: '说了不需要' });
    expect(store.shouldStopOffering(db, userId)).toBe(true);
  });

  it('拒绝之后：其它 scene、其它 case 的 tryOffer 一律 false，且一行都不落', () => {
    store.recordDecline(db, { userId, caseId, scene: '立案后' });
    const otherCase = mkCase(userId);
    for (const scene of SCENES) {
      expect(store.tryOffer(db, { userId, caseId, scene }), `本案 ${scene}`).toBe(false);
      expect(store.tryOffer(db, { userId, caseId: otherCase, scene }), `他案 ${scene}`).toBe(false);
      expect(store.tryOffer(db, { userId, scene }), `无案 ${scene}`).toBe(false);
    }
    // 只有那一行 declined，被拒之后连「推过」的记录都不该新增
    expect(count()).toBe(1);
  });

  it('拒绝只约束本人，不殃及他人', () => {
    const other = mkUser();
    store.recordDecline(db, { userId, caseId, scene: '立案后' });
    expect(store.shouldStopOffering(db, other)).toBe(false);
    expect(store.tryOffer(db, { userId: other, scene: '情绪场景' })).toBe(true);
  });

  it('declined 可多行：不同场景各拒一次都留痕，不报错', () => {
    for (const scene of SCENES) {
      expect(() => store.recordDecline(db, { userId, caseId, scene })).not.toThrow();
    }
    expect(count()).toBe(5);
    expect(store.listByUser(db, userId).every((r) => r.outcome === 'declined')).toBe(true);
  });

  it('同一场景重复拒绝也各留一行（不去重）', () => {
    store.recordDecline(db, { userId, caseId, scene: '开庭前' });
    store.recordDecline(db, { userId, caseId, scene: '开庭前' });
    expect(count()).toBe(2);
  });
});

describe('recordAccept', () => {
  it('落 accepted 行；用户主动找上门成交也记这里', () => {
    store.recordAccept(db, { userId, caseId, scene: '情绪场景', note: '用户自己问的，已预约' });
    const [row] = store.listByUser(db, userId);
    expect(row.outcome).toBe('accepted');
  });

  it('accepted 即停推（已经在接受心理支持的人，不该再被提醒一次"你需要心理帮助"）', () => {
    store.recordAccept(db, { userId, caseId, scene: '情绪场景' });
    expect(store.shouldStopOffering(db, userId)).toBe(true);
  });

  it('accepted 后：任何未推过的位点 tryOffer 一律 false，且一行都不新增', () => {
    // 守的是「对刚迈出那一步的人，重复推荐是一种否定」：accepted 与 declined 语义相反，
    // 后续动作却相同——都停止主动推荐。此前实现只认 declined，成交之后其它位点仍会放行，
    // 那正是"已经在咨询了还被推第二次"。这条断言钉住的就是那个口子已经堵上。
    store.tryOffer(db, { userId, caseId, scene: '情绪场景' });
    store.recordAccept(db, { userId, caseId, scene: '情绪场景' });
    const before = count();
    for (const scene of SCENES) {
      expect(store.tryOffer(db, { userId, caseId, scene }), scene).toBe(false);
    }
    expect(store.tryOffer(db, { userId, caseId: mkCase(userId), scene: '立案后' })).toBe(false);
    expect(count()).toBe(before);
  });

  it('declined 与 accepted 后续动作相同，但仍分两态存（要能分辨导流有效与用户反感）', () => {
    store.recordAccept(db, { userId, caseId, scene: '情绪场景' });
    const other = mkUser();
    store.recordDecline(db, { userId: other, scene: '情绪场景' });
    expect(store.shouldStopOffering(db, userId)).toBe(true);
    expect(store.shouldStopOffering(db, other)).toBe(true);
    // 两个人都停推，但台账里分得出谁是成交、谁是反感
    expect(store.listByUser(db, userId)[0].outcome).toBe('accepted');
    expect(store.listByUser(db, other)[0].outcome).toBe('declined');
  });
});

describe('拒绝记录必须比案件活得久', () => {
  it('删掉 cases 行后，referral_offers 行仍在且 case_id 变 NULL', () => {
    store.tryOffer(db, { userId, caseId, scene: '开庭前' });
    store.recordDecline(db, { userId, caseId, scene: '开庭前', note: '不需要' });
    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);

    const rows = store.listByUser(db, userId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.case_id === null)).toBe(true);
    // 核心不变量：销案之后这个人依然是"说过不需要"的人，不会被重新推一遍
    expect(store.shouldStopOffering(db, userId)).toBe(true);
  });

  it('删掉 threads 行后，thread_id 置 NULL，行仍在', () => {
    const threadId = mkThread(caseId);
    store.tryOffer(db, { userId, caseId, scene: '情绪场景', threadId });
    db.prepare('DELETE FROM threads WHERE id = ?').run(threadId);

    const rows = store.listByUser(db, userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].thread_id).toBeNull();
    expect(rows[0].case_id).toBe(caseId);
  });

  it('user_id 不级联：仍被引用的 users 行删不掉（拒绝记录跟人走）', () => {
    store.recordDecline(db, { userId, caseId, scene: '立案后' });
    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);
    expect(() => db.prepare('DELETE FROM users WHERE id = ?').run(userId)).toThrow(/FOREIGN KEY/);
  });
});

describe('listByUser', () => {
  it('按 id DESC，最新在前；limit 生效；只返回本人的行', () => {
    const other = mkUser();
    store.recordAccept(db, { userId: other, scene: '情绪场景' });
    for (const scene of SCENES) store.tryOffer(db, { userId, caseId, scene });

    const rows = store.listByUser(db, userId);
    expect(rows).toHaveLength(5);
    expect(rows.map((r) => r.scene)).toEqual([...SCENES].reverse());
    expect(store.listByUser(db, userId, 2)).toHaveLength(2);
  });
});

describe('不挂案件的位点同样只推一次（COALESCE(case_id, 0) 哨兵）', () => {
  it('无 caseId 的同一 scene 二次 tryOffer 返 false，只落一行', () => {
    // 守的是「情绪场景不挂案件时频控失效」这个洞：SQLite 唯一索引视 NULL 互不相等，
    // 若索引用 case_id 裸列，这里第二次会返 true——而情绪场景恰恰最可能不挂案件，
    // 又正是「会反复触发」要防的重点。此断言在于：频控不依赖调用方记得传 caseId。
    expect(store.tryOffer(db, { userId, scene: '情绪场景' })).toBe(true);
    expect(store.tryOffer(db, { userId, scene: '情绪场景' })).toBe(false);
    expect(store.tryOffer(db, { userId, caseId: null, scene: '情绪场景' })).toBe(false);
    expect(count()).toBe(1);
  });

  it('不带 caseId 与带 caseId 的同 scene 视为两个位点', () => {
    // COALESCE 语义的必然结果：哨兵 0 与真实 case id 是不同的键。如实钉住。
    expect(store.tryOffer(db, { userId, scene: '情绪场景' })).toBe(true);
    expect(store.tryOffer(db, { userId, caseId, scene: '情绪场景' })).toBe(true);
    expect(count()).toBe(2);
  });
});
