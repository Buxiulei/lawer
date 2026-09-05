/**
 * P1-W2 七条能力的判据：文书读写、公司主体、情绪、时间线分页与里程碑。
 *
 * 走的是能力的 `run(db, identity, args)` —— 与 /api/mcp 的 tools/call 调的是同一个函数，
 * 所以这里验到的行为就是用户自己的 agent 真正拿到的行为。
 *
 * 【判据 ↔ 变异臂】
 *  1) 对外文书缺 send_consequences ⇒ 拒收且**零写入**
 *     «闸门只回错误但仍落库 ⇒ 红»：这里不只看返回值，还数 drafts 表的行数。
 *     只看返回值的判据挡不住"先插入再报错"，而那正是最像成功的失败。
 *  2) 同案 + 同 kind + 同 title 再写 ⇒ 新版本，旧版本仍可读
 *     «版本按 kind 算（不看 title）⇒ 红»：另起一题的文书会变成第 2 版。
 *  3) refer_nbdpsy 第二次被拒（spec §10 一案最多一次），但情绪记录照落
 *     «频控只写在站内那份 ⇒ 红»：MCP 这条路第二次会 referred:true。
 *  4) timeline_list 的分页与 kind 过滤：两页不重叠、末页 next_offset 为 null、
 *     total 是过滤后的真总数
 *     «total 用本页长度冒充 ⇒ 红»；«next_offset 恒给数字 ⇒ 红»。
 *  5) 换一把别人的 key：七条能力一条都不许读到或写进本案 ⇒ 库里行数纹丝不动
 *     «归属校验漏在某一条上 ⇒ 红»（逐条调一遍，不是抽查一条）。
 *  6) client_ref 重放不双写（writeOnce 把业务写入与台账放进同一个事务）
 *     «先写业务再记台账 ⇒ 红»：领域失败时业务行会留下。
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Identity } from '@/lib/auth/identity';
import { runMigrations } from '@/lib/db/migrate';

import { getCapability } from '..';

let db: Database.Database;
let alice: Identity;
let bob: Identity;
let caseId: number;

function call(name: string, identity: Identity, args: Record<string, unknown>) {
  const cap = getCapability(name);
  if (!cap) throw new Error(`注册表里没有 ${name}`);
  return cap.run(db, identity, args) as Record<string, unknown>;
}

function count(table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function addUser(phoneHash: string): number {
  return Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run(phoneHash).lastInsertRowid);
}

function addKey(userId: number, keyHash: string): number {
  return Number(
    db
      .prepare("INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?, '测试钥匙', ?, '[\"case:read\",\"case:write\"]')")
      .run(userId, keyHash).lastInsertRowid,
  );
}

const OUTBOUND = { kind: '被迫解除通知', title: '关于拖欠工资的被迫解除通知', body: '致贵司：【填写公司全称】' };

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uidA = addUser('hash-a');
  const uidB = addUser('hash-b');
  // 台账的 key_id 有外键指向 api_keys，所以两把钥匙也得是真的存在的行
  alice = { uid: uidA, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: addKey(uidA, 'kh-a') };
  bob = { uid: uidB, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: addKey(uidB, 'kh-b') };
  caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uidA, '甲的案子').lastInsertRowid,
  );
});

describe('判据 1：对外文书缺发出后果 ⇒ 服务端拒收，零写入', () => {
  it('缺 send_consequences 时回 SEND_CONSEQUENCES_REQUIRED，且 drafts 一行都没多', () => {
    const res = call('draft_write', alice, { case_id: caseId, ...OUTBOUND });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('SEND_CONSEQUENCES_REQUIRED');
    expect(count('drafts'), '被拒的写入不许落库').toBe(0);
    // 台账也不许留痕：留了的话同一个 client_ref 重试会被当成"已经写过"而被去重掉
    expect(count('agent_writes')).toBe(0);
  });

  it('带上后果就写得进去，正文附固定尾注、后果原文单独成列', () => {
    const res = call('draft_write', alice, {
      case_id: caseId,
      ...OUTBOUND,
      send_consequences: '发出后劳动关系即解除，不可撤回',
    });
    expect(res.ok).toBe(true);
    const draft = (res as { draft: { id: number; content: string; send_consequences: string } }).draft;
    expect(draft.content).toContain('【发出前必读】');
    expect(draft.send_consequences).toBe('发出后劳动关系即解除，不可撤回');
    expect(count('drafts')).toBe(1);
  });

  it('对内文书（谈判话术）不要求后果说明，也不加尾注', () => {
    const res = call('draft_write', alice, {
      case_id: caseId,
      kind: '谈判话术',
      title: '明天约谈话术',
      body: '只听多问少答',
    });
    expect(res.ok).toBe(true);
    expect((res as { draft: { content: string } }).draft.content).not.toContain('【发出前必读】');
  });
});

describe('判据 2：同题重写是新版本，旧版本仍读得到', () => {
  function write(body: string) {
    return call('draft_write', alice, {
      case_id: caseId,
      ...OUTBOUND,
      body,
      send_consequences: '不可撤回',
    }) as { ok: true; draft: { id: number; version: number } };
  }

  it('同 kind 同 title 第二次 ⇒ version 2，第一版原文照旧读得出来', () => {
    const first = write('第一稿');
    const second = write('第二稿');
    expect(first.draft.version).toBe(1);
    expect(second.draft.version).toBe(2);

    const old = call('draft_get', alice, { draft_id: first.draft.id }) as {
      ok: true;
      draft: { version: number; body: string };
    };
    expect(old.draft.version).toBe(1);
    expect(old.draft.body).toContain('第一稿');
  });

  it('同 kind 换一题 ⇒ 另起一份（version 回到 1），不冒充上一份的新版本', () => {
    write('第一稿');
    const other = call('draft_write', alice, {
      case_id: caseId,
      kind: OUTBOUND.kind,
      title: '关于违法调岗的被迫解除通知',
      body: '另一件事',
      send_consequences: '不可撤回',
    }) as { ok: true; draft: { version: number } };
    expect(other.draft.version, '两封不同题的同类文书不该互称版本').toBe(1);
  });

  it('draft_list 给出版本与标题但**不含正文**', () => {
    write('第一稿');
    const list = call('draft_list', alice, { case_id: caseId }) as {
      ok: true;
      drafts: Record<string, unknown>[];
    };
    expect(list.drafts).toHaveLength(1);
    expect(list.drafts[0].version).toBe(1);
    expect(list.drafts[0].has_send_consequences).toBe(true);
    expect(Object.keys(list.drafts[0])).not.toContain('content');
    expect(Object.keys(list.drafts[0])).not.toContain('body');
  });

  it('based_on_draft_id 指向别的案子的稿 ⇒ 按「不存在」拒，零写入', () => {
    const bobCase = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(bob.uid, '乙的案子').lastInsertRowid,
    );
    const bobDraft = call('draft_write', bob, {
      case_id: bobCase,
      kind: '谈判话术',
      title: '乙的话术',
      body: '乙的正文',
    }) as { ok: true; draft: { id: number } };

    const res = call('draft_write', alice, {
      case_id: caseId,
      ...OUTBOUND,
      send_consequences: '不可撤回',
      based_on_draft_id: bobDraft.draft.id,
    });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('DRAFT_NOT_FOUND');
    expect(count('drafts'), '只有乙那一份').toBe(1);
  });
});

describe('判据 3：refer_nbdpsy 一案一次，第二次被拒但情绪照记', () => {
  it('第一次转介成功，第二次 referred:false 并给出原因，emotion_log 仍是两行', () => {
    const first = call('emotion_log', alice, {
      case_id: caseId,
      level: '严重',
      note: '提到不想活',
      refer_nbdpsy: true,
    });
    expect(first.referred).toBe(true);

    const second = call('emotion_log', alice, {
      case_id: caseId,
      level: '焦虑',
      note: '整夜睡不着',
      refer_nbdpsy: true,
    });
    expect(second.referred, '一案最多一次（spec §10）').toBe(false);
    expect(second.refuse_reason).toContain('已转介过一次');

    expect(count('emotion_log'), '被拒的是转介，不是这一笔情绪记录').toBe(2);
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM emotion_log WHERE referred_nbdpsy = 1').get() as { n: number }).n,
    ).toBe(1);
  });

  it('档位没到「焦虑」以上 ⇒ 不转介（趁人之危闸门），记录照落', () => {
    const res = call('emotion_log', alice, { case_id: caseId, level: '低落', refer_nbdpsy: true });
    expect(res.referred).toBe(false);
    expect(res.refuse_reason).toContain('焦虑');
    expect(count('emotion_log')).toBe(1);
  });

  it('非法档位 ⇒ 拒收零写入', () => {
    const res = call('emotion_log', alice, { case_id: caseId, level: '还行' });
    expect(res.ok).toBe(false);
    expect(res.errorCode).toBe('INVALID_EMOTION_LEVEL');
    expect(count('emotion_log')).toBe(0);
  });
});

describe('判据 4：timeline_list 的分页与 kind 过滤', () => {
  beforeEach(() => {
    const rows: [string, string, string][] = [
      ['2026-01-01T00:00:00Z', '公司动作', '口头通知裁员'],
      ['2026-02-01T00:00:00Z', '我方动作', '书面异议'],
      ['2026-03-01T00:00:00Z', '公司动作', '发解除通知'],
      ['2026-04-01T00:00:00Z', '我方动作', '申请仲裁'],
      ['2026-05-01T00:00:00Z', '公司动作', '寄送退工单'],
    ];
    for (const [at, kind, title] of rows) {
      call('timeline_add', alice, { case_id: caseId, happened_at: at, kind, title });
    }
  });

  it('limit 分页：两页不重叠、合起来就是全部，末页 next_offset 为 null', () => {
    const p1 = call('timeline_list', alice, { case_id: caseId, limit: 3 }) as {
      ok: true;
      events: { id: number }[];
      total: number;
      next_offset: number | null;
    };
    expect(p1.total).toBe(5);
    expect(p1.events).toHaveLength(3);
    expect(p1.next_offset).toBe(3);

    const p2 = call('timeline_list', alice, { case_id: caseId, limit: 3, offset: p1.next_offset }) as {
      ok: true;
      events: { id: number }[];
      total: number;
      next_offset: number | null;
    };
    expect(p2.events).toHaveLength(2);
    expect(p2.next_offset, '没有下一页时明写 null').toBeNull();

    const ids = [...p1.events, ...p2.events].map((e) => e.id);
    expect(new Set(ids).size, '两页不许重叠').toBe(5);
  });

  it('kind 过滤：只回该类，且 total 是过滤后的真总数（不是全案总数、也不是本页长度）', () => {
    const res = call('timeline_list', alice, { case_id: caseId, kind: '公司动作', limit: 2 }) as {
      ok: true;
      events: { kind: string }[];
      total: number;
      next_offset: number | null;
    };
    expect(res.events.map((e) => e.kind)).toEqual(['公司动作', '公司动作']);
    expect(res.total, '过滤后共 3 条').toBe(3);
    expect(res.next_offset).toBe(2);
  });

  it('since 过滤按发生时间取下界；limit 超上限被夹到 200', () => {
    const res = call('timeline_list', alice, { case_id: caseId, since: '2026-03-01T00:00:00Z', limit: 9999 }) as {
      ok: true;
      events: { title: string }[];
      total: number;
    };
    expect(res.total).toBe(3);
    expect(res.events.map((e) => e.title)).toEqual(['寄送退工单', '申请仲裁', '发解除通知']);
  });

  it('timeline_milestone 要用户确认才盖得上，同一格再盖一次结果不变（幂等）', () => {
    const list = call('timeline_list', alice, { case_id: caseId, limit: 1 }) as {
      ok: true;
      events: { id: number }[];
    };
    const eventId = list.events[0].id;

    const noConfirm = call('timeline_milestone', alice, {
      case_id: caseId,
      event_id: eventId,
      milestone: '仲裁申请',
    });
    expect(noConfirm.ok).toBe(false);
    expect(noConfirm.errorCode).toBe('MILESTONE_NOT_CONFIRMED');

    const args = { case_id: caseId, event_id: eventId, milestone: '仲裁申请', user_confirmed: true };
    const first = call('timeline_milestone', alice, args) as { ok: true; event: { milestone: string } };
    const again = call('timeline_milestone', alice, args) as { ok: true; event: { milestone: string } };
    expect(first.event.milestone).toBe('仲裁申请');
    expect(again.event.milestone).toBe('仲裁申请');
    expect(
      (db.prepare("SELECT COUNT(*) AS n FROM timeline_events WHERE milestone IS NOT NULL").get() as { n: number }).n,
      '盖章是改列不是加行',
    ).toBe(1);
  });
});

describe('判据 5：别人的案件——七条一条都读不到、写不进', () => {
  it('乙拿自己的身份调甲的案件：读能力回 CASE_NOT_FOUND，写能力零写入', () => {
    // 先由甲写一份文书，好让"读得到别人的东西"这件事有东西可读
    const mine = call('draft_write', alice, {
      case_id: caseId,
      ...OUTBOUND,
      send_consequences: '不可撤回',
    }) as { ok: true; draft: { id: number } };
    const before = {
      drafts: count('drafts'),
      company: count('company_profiles'),
      emotion: count('emotion_log'),
      timeline: count('timeline_events'),
      writes: count('agent_writes'),
    };

    const attempts: [string, Record<string, unknown>][] = [
      ['timeline_list', { case_id: caseId }],
      ['timeline_milestone', { case_id: caseId, event_id: 1, milestone: '立案', user_confirmed: true }],
      ['draft_list', { case_id: caseId }],
      ['draft_get', { draft_id: mine.draft.id }],
      ['draft_write', { case_id: caseId, ...OUTBOUND, send_consequences: '不可撤回' }],
      ['company_profile_upsert', { case_id: caseId, name: '乙硬塞的公司' }],
      ['emotion_log', { case_id: caseId, level: '严重' }],
    ];
    for (const [name, args] of attempts) {
      const res = call(name, bob, args);
      expect(res.ok, `${name} 不该让别人得手`).toBe(false);
      expect(['CASE_NOT_FOUND', 'DRAFT_NOT_FOUND'], `${name} 的错误码`).toContain(res.errorCode);
    }

    expect({
      drafts: count('drafts'),
      company: count('company_profiles'),
      emotion: count('emotion_log'),
      timeline: count('timeline_events'),
      writes: count('agent_writes'),
    }).toEqual(before);
  });
});

describe('判据 6：client_ref 重放不双写', () => {
  it('同一个 client_ref 第二次进来：业务表与台账都只有一行，回 deduped:true', () => {
    const args = {
      case_id: caseId,
      name: '华衡永泰供应链管理有限公司',
      client_ref: 'op-1',
    };
    const first = call('company_profile_upsert', alice, args);
    expect(first.deduped).toBe(false);

    const replay = call('company_profile_upsert', alice, args);
    expect(replay.deduped).toBe(true);
    expect(replay.id).toBe(first.id);

    expect(count('company_profiles')).toBe(1);
    expect(count('agent_writes')).toBe(1);
  });

  it('同案同名再写一次（不带 ref）是补充而不是新建一条', () => {
    call('company_profile_upsert', alice, { case_id: caseId, name: '华衡永泰供应链管理有限公司' });
    const again = call('company_profile_upsert', alice, {
      case_id: caseId,
      name: '华衡永泰供应链管理有限公司',
      uscc: '91110105MA01ABCD2X',
    });
    expect(again.created).toBe(false);
    expect(count('company_profiles')).toBe(1);
    const row = db.prepare('SELECT uscc FROM company_profiles').get() as { uscc: string };
    expect(row.uscc).toBe('91110105MA01ABCD2X');
  });

  it('领域校验不过时台账一起回滚：drafts 与 agent_writes 都不留行', () => {
    const res = call('draft_write', alice, {
      case_id: caseId,
      ...OUTBOUND,
      client_ref: 'op-2',
    });
    expect(res.ok).toBe(false);
    expect(count('drafts')).toBe(0);
    expect(count('agent_writes'), '失败的写入不许在台账里占掉这个 client_ref').toBe(0);

    // 台账没被占掉，补齐后果后同一个 ref 还能正常写进去
    const retry = call('draft_write', alice, {
      case_id: caseId,
      ...OUTBOUND,
      send_consequences: '不可撤回',
      client_ref: 'op-2',
    });
    expect(retry.ok).toBe(true);
    expect(count('drafts')).toBe(1);
  });
});
