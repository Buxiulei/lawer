// crisis_check / crisis_hits / me_get / quote_list 的判据。
//
// 这一组盯的是三类**说谎时不报错**的失败：
//   ① 危机词表在 MCP 那侧悄悄变成第二份 —— 同一句话在网页上触发、在用户助手里不触发，
//      两边都跑得通、都不报错，而不触发的那次是安全关键路径；
//   ② 命中了不落痕 —— 事实卡首行干干净净，我们表现得像从没听见过；
//   ③ me_get 少一个字段 —— 对方 agent 的「要不要先引导实名」那条分支永远不成立，
//      于是用户填完一整份材料才在最后一步被拒。
// 每条的变异臂写在用例名里：照着改一处，那一条必须红。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import * as agent from '@/lib/agent';
import { assembleCrisisOpener, type CrisisOpenerText } from '@/lib/agent/crisis-opener';
import { DEFAULT_DOMAIN, DOMAINS, type DomainPack } from '@/lib/domains/registry';
import { crisisStatusMark, CRISIS_HIT_WINDOW_HOURS } from '@/lib/cases/crisis-hits';
import { runMigrations } from '@/lib/db/migrate';
import { toSql } from '@/lib/db/time';
import type { Identity } from '@/lib/auth/identity';

import { getCapability } from '..';

const SRC_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)), '..', '..');

/** 资源卡里声明为 forbidden 的两个号码（一个是公证处、一个查无此号）。任何回包里都不许出现。 */
const FORBIDDEN_PHONES = ['010-85961236', '010-65060953'];

let db: Database.Database;
let uidA: number;
let uidB: number;
let mine: number;
let theirs: number;
let me: Identity;

function call(name: string, args: Record<string, unknown> = {}, identity: Identity = me) {
  const cap = getCapability(name);
  expect(cap, `注册表里没有 ${name}`).toBeDefined();
  return cap!.run(db, identity, args) as Record<string, unknown>;
}

function hits(where = '1=1'): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM crisis_hits WHERE ${where}`).get() as { n: number }).n;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uidA = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('a').lastInsertRowid);
  uidB = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('b').lastInsertRowid);
  mine = Number(db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uidA, '我的').lastInsertRowid);
  theirs = Number(db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uidB, '别人的').lastInsertRowid);
  me = { uid: uidA, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: 7 };
});

// ========== crisis_check 本身 ==========

describe('crisis_check：命中与不命中', () => {
  it('明确的求死表述命中，并回 must_say_first + 首段（变异：把 hit 改成恒 false → 红）', () => {
    const r = call('crisis_check', { text: '要是人没了是不是就不用还房贷了' });
    expect(r.hit).toBe(true);
    expect(r.must_say_first).toBe(true);
    expect(typeof r.first_segment).toBe('string');
  });

  it('普通抱怨不命中，且不回首段、不落痕（变异：把词表阈值放低到收「没意思」→ 红）', () => {
    const r = call('crisis_check', { text: '这破公司待着也没意思，我想换个工作' });
    expect(r.hit).toBe(false);
    expect(r.must_say_first).toBe(false);
    expect(r.first_segment).toBeNull();
    expect(r.hotlines).toEqual([]);
    // 对照臂：不命中一行都不许落。没有这一条，上面「命中落一行」可能只是别处顺手写的
    expect(hits()).toBe(0);
  });

  it('否定语境不算命中（「我不会想不开」）', () => {
    expect(call('crisis_check', { text: '我不会想不开的，就是这阵子太累' }).hit).toBe(false);
  });

  it('text 为空回 INVALID_TEXT，不落痕', () => {
    const r = call('crisis_check', { text: '   ' });
    expect(r.ok).toBe(false);
    expect(r.errorCode).toBe('INVALID_TEXT');
    expect(hits()).toBe(0);
  });
});

describe('crisis_check 的首段：热线逐字 + NBDpsy 那句 + 禁用号码永不出现', () => {
  const CRISIS_TEXT = '我不想活了';

  it('首段逐字包含资源卡里三条可用心理热线（变异：改任一个号码 → 红）', () => {
    const seg = call('crisis_check', { text: CRISIS_TEXT }).first_segment as string;
    const card = agent.createKnowledgeSearcher().get?.(agent.CRISIS_RESOURCE_PACK_ID);
    const usable = agent.crisisHotlines(card?.facts);
    expect(usable.length).toBeGreaterThanOrEqual(2);
    for (const h of usable) expect(seg, `首段缺号码 ${h.phone}`).toContain(h.phone);
  });

  it('首段含 NBDpsy 那句，且与产线常量逐字相同（变异：在工具里另写一句 → 红）', () => {
    const seg = call('crisis_check', { text: CRISIS_TEXT }).first_segment as string;
    expect(seg).toContain(agent.CRISIS_NBDPSY_LINE);
  });

  it('座机线带「手机打不通」的标记（变异：删掉 landline 那一格 → 红）', () => {
    const r = call('crisis_check', { text: CRISIS_TEXT });
    const seg = r.first_segment as string;
    expect(seg).toContain(agent.LANDLINE_MARK);
    const list = r.hotlines as { phone: string; landline_only: boolean }[];
    for (const h of list) expect(h.landline_only).toBe(agent.isLandlineOnly(h.phone));
  });

  it('forbidden 号码在首段与 hotlines 里都不出现（变异：把 status 过滤去掉 → 红）', () => {
    const r = call('crisis_check', { text: CRISIS_TEXT });
    const blob = JSON.stringify(r);
    for (const p of FORBIDDEN_PHONES) expect(blob, `禁用号码 ${p} 出现在回包里`).not.toContain(p);
    // 对照臂：这两个号码确实在卡里（否则上面那条是在断言一件本来就不存在的事）
    const card = agent.createKnowledgeSearcher().get?.(agent.CRISIS_RESOURCE_PACK_ID);
    const inCard = (card?.facts?.hotlines ?? []).map((h) => h.phone);
    for (const p of FORBIDDEN_PHONES) expect(inCard).toContain(p);
  });
});

// ========== 同源：不许有第二份词表 ==========

/**
 * 能力层是否**自带了一份词表/首段**。返回违规说明，空数组 = 同源。
 *
 * 【为什么按源码文本判】"两份词表慢慢分叉"这件事在行为上要等到它们真的不一样那天才看得见，
 * 而那天就是有人在最坏的那个夜里没拿到号码的那天。所以拦在"出现第二份"这一刻，
 * 不等它分叉。判据自身的牙由下面那条变异臂证明（把副本塞进源码文本 → 必须红）。
 */
function copiedWordListViolations(src: string): string[] {
  const bad: string[] = [];
  if (!src.includes('agent.assessCrisis(')) bad.push('没有调 lib/agent/crisis 的 assessCrisis');
  if (!src.includes('agent.buildCrisisOpener(')) bad.push('没有调 lib/agent/crisis 的 buildCrisisOpener');
  // 词表词与首段骨架的字面量一个都不许出现在能力层：出现即意味着这里开始自己判、自己写
  for (const term of ['不想活', '活不下去', '想死', '自杀', '一了百了', '我在。你刚才说的话我听见了']) {
    if (src.includes(term)) bad.push(`能力层里出现了词表/首段字面量「${term}」`);
  }
  return bad;
}

describe('同源守卫：crisis_check 不许有第二份词表', () => {
  const FILE = path.join(SRC_ROOT, 'lib/capabilities/families/emotion.ts');

  it('产线源码同源（变异：把词表副本抄进 emotion.ts → 红）', () => {
    const src = fs.readFileSync(FILE, 'utf-8');
    expect(copiedWordListViolations(src)).toEqual([]);
  });

  it('变异臂：给源码塞一份副本词表，守卫必须点名', () => {
    const mutated =
      fs.readFileSync(FILE, 'utf-8') + "\nconst MY_TERMS = ['不想活', '想死'] as const;\n";
    expect(copiedWordListViolations(mutated)).not.toEqual([]);
  });

  it('行为同源：一组样本上 crisis_check 的 hit 与 assessCrisis 逐条相等', () => {
    const samples = [
      '要是人没了是不是就不用还房贷了',
      '我不想活了',
      '我不会想不开的，就是这阵子太累',
      '这破公司待着也没意思',
      '终于解脱了，下家已经谈好了',
      '我今天想聊聊我的案子',
      '真的撑不下去了',
    ];
    for (const s of samples) {
      expect(call('crisis_check', { text: s }).hit, s).toBe(agent.assessCrisis(s).triggered);
    }
  });
});

/**
 * crisis_check 按**这个案件所属领域**的词表判、用那个领域的首段（设计稿 §13「危机」行）。
 *
 * 【为什么这条非有不可】(复审 2026-09-06 点名) 站内对话那条路已经按案件领域走了，
 * MCP 这条路此前仍取缺省领域——于是同一句话在网页上触发、在用户自己的助手里不触发，
 * **两边都跑得通、都不报错**，而不触发的那一次正是安全关键路径。
 * 这正是本文件抬头第①类失败的第二种形态（第一种是"抄了第二份词表"）。
 */
describe('crisis_check 按案件领域判（变异：把 case_id 的领域忽略掉 → 红）', () => {
  const FAKE_KEY = '假领域-MCP危机判据专用';
  const OPENER: CrisisOpenerText = {
    head: ['假领域 MCP 首段第一行。', '假领域 MCP 首段第二行：'],
    tail: '假领域 MCP 收束句。',
  };
  const LABOR_PACK = DOMAINS[DEFAULT_DOMAIN];
  const FAKE_PACK: DomainPack = {
    ...LABOR_PACK,
    key: FAKE_KEY,
    crisis: {
      ...LABOR_PACK.crisis,
      lexicon: ['甲乙丙'],
      openerText: OPENER,
      firstSegment: (c) => assembleCrisisOpener(OPENER, c.facts, { compact: c.compact }),
      // 资源卡仍指向真卡：这样首段里既有假包的话、又有真号码，
      // 一条断言同时证明"包换了"与"卡还取得到"。
    },
  };
  let fakeCase: number;

  beforeAll(() => {
    DOMAINS[FAKE_KEY] = FAKE_PACK;
  });
  afterAll(() => {
    delete DOMAINS[FAKE_KEY];
  });
  beforeEach(() => {
    fakeCase = Number(
      db
        .prepare('INSERT INTO cases (user_id, title, domain) VALUES (?, ?, ?)')
        .run(uidA, '假领域的案子', FAKE_KEY).lastInsertRowid,
    );
  });

  it('带上假领域的 case_id ⇒ 认假包的词，首段是假包的话 + 真卡的号码', () => {
    const r = call('crisis_check', { text: '我最近总是甲乙丙', case_id: fakeCase });
    expect(r.hit).toBe(true);
    expect(String(r.first_segment)).toContain(OPENER.head[0]);
    expect(String(r.first_segment)).not.toContain(LABOR_PACK.crisis.openerText.head[0]);
    expect((r.hotlines as unknown[]).length).toBeGreaterThan(0);
    expect(r.case_id).toBe(fakeCase);
  });

  it('缺省领域的词在假领域的案子里不触发（词表真的换了，不是两份并集）', () => {
    const term = LABOR_PACK.crisis.lexicon[0];
    expect(call('crisis_check', { text: `我最近总觉得${term}`, case_id: fakeCase }).hit).toBe(false);
    // 同一句话不带 case_id（按缺省领域判）照旧触发——自证上一条不是"这句话本来就不触发"
    expect(call('crisis_check', { text: `我最近总觉得${term}` }).hit).toBe(true);
  });

  it('不是本人的案子 / 不存在的编号 ⇒ 按无案（缺省领域）判，不报错也不少给号码', () => {
    // 安全关键路径上不能因为一个填错的编号就不给号码；这条同时钉住"归属查询挪到判定之前"
    // 没有把原来的宽容行为改掉。
    const r = call('crisis_check', { text: '我不想活了', case_id: theirs });
    expect(r.hit).toBe(true);
    expect(r.case_id).toBeNull();
    expect(String(r.first_segment)).toContain(LABOR_PACK.crisis.openerText.head[0]);
  });
});

// ========== crisis_hits：单一入口、落行、72 小时窗 ==========

describe('crisis_hits：单一落库入口', () => {
  it('全仓只有 lib/cases/crisis-hits.ts 里写 crisis_hits（变异：别处再写一句 INSERT → 红）', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const name of fs.readdirSync(dir)) {
        const full = path.join(dir, name);
        if (fs.statSync(full).isDirectory()) {
          if (name !== '__tests__' && name !== 'node_modules') walk(full);
        } else if (full.endsWith('.ts') || full.endsWith('.tsx')) {
          files.push(full);
        }
      }
    };
    walk(path.join(SRC_ROOT, 'lib'));
    walk(path.join(SRC_ROOT, 'app'));
    const writers = files.filter((f) => /INSERT\s+INTO\s+crisis_hits/i.test(fs.readFileSync(f, 'utf-8')));
    expect(writers.map((f) => path.relative(SRC_ROOT, f))).toEqual(['lib/cases/crisis-hits.ts']);
    // 对照臂：扫描确实覆盖到了那个文件（空名单会让上面那条永远绿）
    expect(files.length).toBeGreaterThan(50);
  });

  it('站内 chat 那条路调的是同一个函数（变异：orchestrator 里改成直写 SQL → 上一条红）', () => {
    const src = fs.readFileSync(path.join(SRC_ROOT, 'lib/agent/orchestrator.ts'), 'utf-8');
    expect(src).toContain('recordCrisisHit(db,');
  });

  it('MCP 命中落一行：source=mcp、绑到本人案子、不存原话', () => {
    const text = '我不想活了';
    call('crisis_check', { text, case_id: mine });
    const row = db.prepare('SELECT * FROM crisis_hits').get() as Record<string, unknown>;
    expect(hits()).toBe(1);
    expect(row.source).toBe('mcp');
    expect(row.case_id).toBe(mine);
    expect(row.user_id).toBe(uidA);
    expect(String(row.terms_hash)).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain('不想活');
  });

  it('无 case_id 也能调，落一行且 case_id 为空（变异：把 case_id 做成必填 → 红）', () => {
    const r = call('crisis_check', { text: '我不想活了' });
    expect(r.hit).toBe(true);
    expect(r.case_id).toBeNull();
    expect(hits('case_id IS NULL')).toBe(1);
  });

  it('别人的 case_id 不绑上去，但号码照给（安全关键路径不因编号填错而失效）', () => {
    const r = call('crisis_check', { text: '我不想活了', case_id: theirs });
    expect(r.hit).toBe(true);
    expect(r.first_segment).toContain('12356');
    expect(r.case_id).toBeNull();
    expect(hits(`case_id=${theirs}`)).toBe(0);
    expect(hits('case_id IS NULL')).toBe(1);
  });
});

describe('事实卡首行的 72 小时标记', () => {
  const facts = () => (call('case_facts', { case_id: mine }) as { case_facts: string }).case_facts;

  function seed(hoursAgo: number) {
    db.prepare('INSERT INTO crisis_hits (case_id, user_id, source, terms_hash, at) VALUES (?,?,?,?,?)').run(
      mine,
      uidA,
      'site',
      'x'.repeat(64),
      toSql(new Date(Date.now() - hoursAgo * 3600_000)),
    );
  }

  it('窗内有命中 → 首行出现「近 72 小时有危机信号（N 次）」（变异：不落 crisis_hits → 红）', () => {
    seed(1);
    seed(70);
    const text = facts();
    expect(text).toContain('> **状态**');
    expect(text).toContain(crisisStatusMark(2));
    expect(crisisStatusMark(2)).toBe(`近 ${CRISIS_HIT_WINDOW_HOURS} 小时有危机信号（2 次）`);
  });

  it('全部超过 72 小时 → 首行不提危机（变异：把窗口判据去掉 → 红）', () => {
    seed(73);
    seed(500);
    expect(facts()).not.toContain('危机信号');
  });

  it('零命中时首行整行不出现（不写「近期无危机信号」这种常驻噪音）', () => {
    expect(facts()).not.toContain('危机信号');
    expect(crisisStatusMark(0)).toBeNull();
  });

  it('与报告过期标记并存在同一行（变异：extra 覆盖掉前面的标记 → 红）', () => {
    db.prepare(
      `INSERT INTO case_reports (case_id, version, updated_at, updated_by, stale_since, stale_reason)
       VALUES (?,1,?,?,?,?)`,
    ).run(mine, '2026-09-01 09:00:00', 'web', '2026-09-02 09:00:00', '{"时间线":1}');
    seed(2);
    const line = facts().split('\n')[0];
    expect(line).toContain('报告过期');
    expect(line).toContain('危机信号');
  });
});

// ========== me_get ==========

describe('me_get：字段齐', () => {
  const REQUIRED = [
    'auth_status',
    'plan',
    'balance',
    'storage',
    'connected_agent',
    'nbdpsy_linked',
  ];

  it('六个字段一个都不少（变异：删掉 auth_status → 红）', () => {
    const r = call('me_get');
    for (const key of REQUIRED) expect(Object.keys(r), `me_get 少了 ${key}`).toContain(key);
  });

  it('不接受任何入参：inputSchema 无必填、传了也不影响结果', () => {
    const cap = getCapability('me_get')!;
    expect((cap.inputSchema as { required?: string[] }).required).toEqual([]);
    expect(call('me_get', { user_id: uidB })).toEqual(call('me_get'));
  });

  it('auth_status 照实回，不编默认值（变异：无 users 行时回「已实名」→ 红）', () => {
    expect(call('me_get').auth_status).toBe('未认证');
    db.prepare("UPDATE users SET auth_status='已实名' WHERE id=?").run(uidA);
    expect(call('me_get').auth_status).toBe('已实名');
  });

  it('plan 取 memberships 的未过期行；过期的不算', () => {
    db.prepare(
      "INSERT INTO memberships (user_id, plan, order_no, expires_at) VALUES (?,?,?, datetime('now','-1 day'))",
    ).run(uidA, 'entry', 'M-old');
    expect(call('me_get').plan).toEqual({ active: false, name: null, expires_at: null });
    db.prepare(
      "INSERT INTO memberships (user_id, plan, order_no, expires_at) VALUES (?,?,?, datetime('now','+31 days'))",
    ).run(uidA, 'entry', 'M-new');
    const plan = call('me_get').plan as { active: boolean; name: string };
    expect(plan.active).toBe(true);
    expect(plan.name).toBe('entry');
  });

  it('connected_agent 看的是「还启用着的 key」，停用的不算（变异：改成看 last_used_at → 红）', () => {
    expect(call('me_get').connected_agent).toBe(false);
    const keyId = Number(
      db
        .prepare("INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?,?,?,'[]')")
        .run(uidA, 'k', 'h1').lastInsertRowid,
    );
    // 从没用过（last_used_at 为 NULL）也算连着——它照样能读写这个账号
    expect(call('me_get').connected_agent).toBe(true);
    db.prepare('UPDATE api_keys SET enabled=0 WHERE id=?').run(keyId);
    expect(call('me_get').connected_agent).toBe(false);
  });

  it('别人的 key 不算我的连接（归属）', () => {
    db.prepare("INSERT INTO api_keys (user_id, name, key_hash, scopes) VALUES (?,?,?,'[]')").run(uidB, 'k', 'h2');
    expect(call('me_get').connected_agent).toBe(false);
  });

  it('nbdpsy_linked 是占位，恒 false（字段存在本身就是判据：缺字段与 false 在对方那里不一样）', () => {
    expect(call('me_get').nbdpsy_linked).toBe(false);
  });

  it('balance 与 storage 取既有真源，不自己算', () => {
    const r = call('me_get');
    expect(r.balance).toBe(0);
    expect(r.storage).toMatchObject({ file_count: 0, total_bytes: 0 });
  });
});

// ========== quote_list ==========

describe('quote_list：只见本人', () => {
  function quote(userId: number, caseId: number, over: Record<string, unknown> = {}): number {
    const cols = {
      user_id: userId,
      case_id: caseId,
      service: 'asr',
      payload_json: JSON.stringify({ units: 3 }),
      amount: 24,
      expires_at: toSql(new Date(Date.now() + 30 * 60_000)),
      confirmed_at: null,
      order_ref: null,
      entitlement_id: null,
      ...over,
    };
    const keys = Object.keys(cols);
    return Number(
      db
        .prepare(`INSERT INTO service_quotes (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
        .run(...keys.map((k) => (cols as Record<string, unknown>)[k])).lastInsertRowid,
    );
  }
  const listed = (args: Record<string, unknown> = {}) =>
    (call('quote_list', args).quotes as { quote_id: number; status: string; paid_by: string | null }[]);

  it('别人的报价一条都看不到（变异：按 case_id 查而不是按 user_id → 红）', () => {
    const mineQ = quote(uidA, mine);
    quote(uidB, theirs);
    expect(listed().map((q) => q.quote_id)).toEqual([mineQ]);
    // 明确点名别人的案子，也只能看到自己的（一条都没有）
    expect(listed({ case_id: theirs })).toEqual([]);
  });

  it('未过期的未确认单看得到，过期又没确认的看不到（变异：去掉过期过滤 → 红）', () => {
    const live = quote(uidA, mine);
    quote(uidA, mine, { expires_at: toSql(new Date(Date.now() - 60_000)) });
    expect(listed().map((q) => q.quote_id)).toEqual([live]);
  });

  it('已确认的单照回，且分得清是扣的余额还是用的券', () => {
    const past = toSql(new Date(Date.now() - 3600_000));
    const byMoney = quote(uidA, mine, { expires_at: past, confirmed_at: past, order_ref: 'svc-1-u1' });
    const ent = Number(
      db
        .prepare("INSERT INTO entitlements (user_id, kind) VALUES (?, 'asr')")
        .run(uidA).lastInsertRowid,
    );
    const byCoupon = quote(uidA, mine, { expires_at: past, confirmed_at: past, entitlement_id: ent });
    const rows = listed();
    expect(rows.map((q) => q.quote_id).sort()).toEqual([byMoney, byCoupon].sort());
    expect(rows.find((q) => q.quote_id === byMoney)!.paid_by).toBe('gongdao');
    expect(rows.find((q) => q.quote_id === byCoupon)!.paid_by).toBe('entitlement');
    for (const r of rows) expect(r.status).toBe('confirmed');
  });

  it('case_id 收窄到某个案子', () => {
    const other = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uidA, '第二个').lastInsertRowid,
    );
    const q1 = quote(uidA, mine);
    quote(uidA, other);
    expect(listed({ case_id: mine }).map((q) => q.quote_id)).toEqual([q1]);
  });
});

// ========== 注册表与暴露面 ==========

describe('三条能力都在注册表里，且都是只读', () => {
  it('crisis_check / me_get / quote_list 追加在末尾、exposeTo=mcp、kind=read', () => {
    for (const name of ['crisis_check', 'me_get', 'quote_list']) {
      const cap = getCapability(name)!;
      expect(cap, name).toBeDefined();
      expect(cap.kind, name).toBe('read');
      expect(cap.scope, name).toBe('case:read');
      expect(cap.exposeTo, name).toContain('mcp');
      expect(cap.idempotency, `${name} 是读能力，不该声明幂等`).toBeUndefined();
    }
  });
});
