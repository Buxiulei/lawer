// app/src/lib/company/__tests__/dossier.test.ts
// 建档 / 状态机 / 缓存命中 / 队列位次 + 分块三态。
import { describe, it, expect } from 'vitest';

import { finishBlock, getBlock, listBlocks, startBlock } from '../blocks';
import { createDossier, lookupCache, markRefreshed, queuePosition, setStatus } from '../dossier';
import { computeStats, saveStats } from '../stats';

import { mkChain, mkUser, newDb, seedDoc } from './fixtures';

describe('建档与状态机', () => {
  it('同 company_key 重复建档返回同一行（档案按公司唯一，不是按案件）', () => {
    const db = newDb();
    const uid = mkUser(db);
    // 归一化确实覆盖的等价写法：全角括号、内部空白、大小写。
    const a = createDossier(db, { name: '某某科技（北京）有限公司', orderedByUserId: uid });
    const b = createDossier(db, { name: '某某科技(北京) 有限公司 ', orderedByUserId: uid });
    expect(b.id).toBe(a.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM company_dossiers').get() as { n: number };
    expect(n).toBe(1);
    db.close();
  });

  it('「有限责任公司」不并进「有限公司」⇒ 两条档案（合并裁决：宁可多建，不可误合）', () => {
    // 归一化按误差方向取保守（见 ../normalize.ts 文件头）：后缀等价与繁简都**不做**。
    // 多建一条的代价是用户多付一次、可退可合并；误合的代价是付了 A 家的钱拿到 B 家的档案，
    // 而且没有任何一处会报错。这条转绿成 toBe 就意味着有人把归一化放宽了。
    const db = newDb();
    const uid = mkUser(db);
    const a = createDossier(db, { name: '某某科技有限责任公司', orderedByUserId: uid });
    const b = createDossier(db, { name: '某某科技有限公司', orderedByUserId: uid });
    expect(b.id).not.toBe(a.id);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM company_dossiers').get() as { n: number };
    expect(n).toBe(2);
    db.close();
  });

  it('uscc 相同、名字不同 ⇒ 同一份档案', () => {
    const db = newDb();
    const a = createDossier(db, { name: '旧名有限公司', uscc: '91110108MA01ABCD2X' });
    const b = createDossier(db, { name: '改名后有限公司', uscc: '91110108MA01ABCD2X' });
    expect(b.id).toBe(a.id);
    db.close();
  });

  it('未知状态当场抛错（静默落到默认档 = 这份档案从此没人推进）', () => {
    const db = newDb();
    const d = createDossier(db, { name: '甲公司有限公司' });
    expect(() => setStatus(db, d.id, 'graph_done')).not.toThrow();
    // @ts-expect-error 故意传非法值：值集由本层把关，库侧不加 CHECK
    expect(() => setStatus(db, d.id, '跑完了')).toThrow(/未知档案状态/);
    db.close();
  });

  it('membership_credit 必须留痕：paid_by + paid_ref 都写进去', () => {
    const db = newDb();
    const uid = mkUser(db);
    const d = createDossier(db, {
      name: '甲公司有限公司',
      orderedByUserId: uid,
      paidBy: 'membership_credit',
      paidRef: '42',
    });
    expect(d.paid_by).toBe('membership_credit');
    expect(d.paid_ref).toBe('42'); // 「这单为什么没扣钱」的唯一可查凭据
    db.close();
  });
});

describe('缓存命中判定', () => {
  it('未完成 / 过期 / 无此档案 各报各的原因（报价页要如实告诉用户按哪个价）', () => {
    const db = newDb();
    expect(lookupCache(db, { name: '查无此司有限公司' })).toMatchObject({
      hit: false,
      reason: '无此档案',
    });

    const d = createDossier(db, { name: '甲公司有限公司' });
    expect(lookupCache(db, { name: '甲公司有限公司' }).reason).toBe('档案未完成');

    setStatus(db, d.id, 'done');
    expect(lookupCache(db, { name: '甲公司有限公司' }).reason).toBe('工商快照已过期'); // 还没采过

    markRefreshed(db, d.id, 'graph', '2026-08-01');
    expect(lookupCache(db, { name: '甲公司有限公司' }, { now: '2026-08-10' }).hit).toBe(true);
    expect(lookupCache(db, { name: '甲公司有限公司' }, { now: '2026-09-15' })).toMatchObject({
      hit: false,
      reason: '工商快照已过期',
    });
    db.close();
  });

  it('TTL 从 pricing_config 读，不硬编码（改表即改行为，不重启进程）', () => {
    const db = newDb();
    const d = createDossier(db, { name: '甲公司有限公司' });
    setStatus(db, d.id, 'done');
    markRefreshed(db, d.id, 'graph', '2026-08-01');
    expect(lookupCache(db, { name: '甲公司有限公司' }, { now: '2026-08-20' }).hit).toBe(true);
    db.prepare('INSERT INTO pricing_config (key, value_int) VALUES (?,?)').run(
      'dossier.ttl_graph_days',
      7,
    );
    expect(lookupCache(db, { name: '甲公司有限公司' }, { now: '2026-08-20' }).hit).toBe(false);
    db.close();
  });

  // 完整性判据：判例行挂在案件私有的 company_profiles 上、随案件级联删除，
  // 而档案是跨案资产。第一个买家删掉自己的案件后，行没了、统计快照还在。
  // 此时若照常命中缓存，第二个用户会看到一份「分母还在、行已经没了」的统计。
  it('已入档条目与统计快照对不上 ⇒ 不命中（宁可重采，不给一份对不上的数）', () => {
    const db = newDb();
    const { caseId, profileId, dossierId } = mkChain(db, '甲公司有限公司');
    for (let i = 0; i < 3; i++) seedDoc(db, profileId, dossierId, { case_no: `C${i}` });
    saveStats(db, computeStats(db, dossierId));
    setStatus(db, dossierId, 'done');
    markRefreshed(db, dossierId, 'graph', '2026-08-25');
    expect(lookupCache(db, { name: '甲公司有限公司' }, { now: '2026-08-28' }).hit).toBe(true);

    // 第一个买家删掉自己的案件 ⇒ profile 与它下面的判例行被级联删掉
    db.prepare('DELETE FROM cases WHERE id = ?').run(caseId);
    const { n } = db
      .prepare('SELECT COUNT(*) AS n FROM company_litigation WHERE dossier_id = ?')
      .get(dossierId) as { n: number };
    expect(n).toBe(0);
    expect(lookupCache(db, { name: '甲公司有限公司' }, { now: '2026-08-28' })).toMatchObject({
      hit: false,
      reason: '已入档条目与统计快照对不上',
    });
    db.close();
  });
});

describe('队列位次', () => {
  it('同 status 内按 id 从 1 起；查无此档返回 0（不是 1）', () => {
    const db = newDb();
    const a = createDossier(db, { name: '甲公司有限公司' });
    const b = createDossier(db, { name: '乙公司有限公司' });
    const c = createDossier(db, { name: '丙公司有限公司' });
    expect(queuePosition(db, a.id)).toBe(1);
    expect(queuePosition(db, c.id)).toBe(3);
    setStatus(db, b.id, 'awaiting_relay');
    expect(queuePosition(db, c.id)).toBe(2); // b 走了，c 往前挪
    expect(queuePosition(db, 9999)).toBe(0);
    db.close();
  });
});

describe('分块三态', () => {
  it('无行 / running / 有结论 三态分得开', () => {
    const db = newDb();
    const d = createDossier(db, { name: '甲公司有限公司' });
    expect(getBlock(db, d.id, 'stats')).toBeUndefined(); // 没排过

    startBlock(db, d.id, 'stats');
    expect(getBlock(db, d.id, 'stats')!.finished_at).toBeNull(); // 在跑或崩了

    finishBlock(db, d.id, 'stats', { status: 'ok', note: '算完了' });
    const done = getBlock(db, d.id, 'stats')!;
    expect(done.finished_at).not.toBeNull();
    expect(done.status).toBe('ok');
    db.close();
  });

  it('重跑同一块会重置回 running 并清掉上一次的结论', () => {
    const db = newDb();
    const d = createDossier(db, { name: '甲公司有限公司' });
    startBlock(db, d.id, 'graph');
    finishBlock(db, d.id, 'graph', { status: 'failed', errorText: '工商站点 503' });
    startBlock(db, d.id, 'graph');
    const b = getBlock(db, d.id, 'graph')!;
    expect(b.status).toBe('running');
    expect(b.finished_at).toBeNull();
    expect(b.error_text).toBeNull();
    expect(listBlocks(db, d.id)).toHaveLength(1); // 重跑不长第二行
    db.close();
  });

  it('标失败必须写原因原文；没 startBlock 就 finishBlock 当场抛错', () => {
    const db = newDb();
    const d = createDossier(db, { name: '甲公司有限公司' });
    startBlock(db, d.id, 'litigation');
    expect(() => finishBlock(db, d.id, 'litigation', { status: 'failed', errorText: '  ' })).toThrow(
      /必须写明原因原文/,
    );
    expect(() => finishBlock(db, d.id, 'patterns', { status: 'ok' })).toThrow(/查无此行/);
    db.close();
  });
});
