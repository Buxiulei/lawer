// app/src/lib/agent/__tests__/crisis-card-by-domain.test.ts
// 危机资源卡**按案件领域取**（设计稿 §13「危机」行 / §16 的 crisis）。
//
// 【这一组拦的是一个已经复现过的空号事故】词表、首段、窗内限制句都已经按领域走了，
// 但号码不在包里——它在知识卡上，由 `searcher.get(resourcePackId)` 取回来。
// 而 get 那一面按缺省领域闸，三处调用都没传本案的领域，于是：
//   · MCP crisis_check：`hit: true`、first_segment 照常生成、`hotlines: []`，HTTP 200，
//     没有一处报错——一个正在处置危机的人拿到的是一段**一个号码都没有**的指引；
//   · 站内对话：走进 KNOWLEDGE_UNAVAILABLE，把"这一层不知道这轮是谁的案子"
//     报成"知识库没装好"，而知识库好好的；
//   · 无工具模式回填：同 MCP，静静地少掉号码。
//
// 【为什么答案是"不过闸"而不是"传本案的域"】这个 id 来自 DomainPack.crisis.resourcePackId,
// 是我们自己的配置，不是用户或模型报上来的——领域闸防的是"按可猜的 id 取回别的行当的卡"，
// 与它无关。而按本案的域闸住它，会连"新领域先共用缺省域那张危机卡"这种正当写法一起挡掉，
// 同样是静静地回空数组。所以三处都传 domain: null，并由下面那条**逐包普查**兜底。
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it } from 'vitest';

import { runTurn } from '@/lib/agent/orchestrator';
import { makeAgentFixture, makeSink, scriptedProvider } from './fixtures';

import { createKnowledgeSearcher } from '@/lib/agent/knowledge-adapter';
import { crisisHotlines } from '@/lib/agent/crisis';
import { getCapability } from '@/lib/capabilities';
import { runMigrations } from '@/lib/db/migrate';
import { DEFAULT_DOMAIN, DOMAINS, DOMAINS_ENABLED_ENV } from '@/lib/domains/registry';
import { crisisNotice } from '@/lib/paste';
import type { Identity } from '@/lib/auth/identity';

const COUNSELING = DOMAINS.counseling;
const LABOR = DOMAINS[DEFAULT_DOMAIN];

/** 这个领域的卡上唯一 usable 的心理援助号码（官方，国卫医政函〔2024〕259 号）。 */
const OFFICIAL_HOTLINE = '12356';
/** 同一张卡上标 forbidden 的那个：非官方发布，任何回包里都不许出现。 */
const FORBIDDEN_HOTLINE = '400-161-9995';
/** 一句咨询师侧的危机表述（命中本领域词表，不命中缺省领域那份）。 */
const COUNSELING_CRISIS_TEXT = '来访今天说他有自杀计划，现在联系不上他';

/** 缺省领域那张卡上的可用号码（对照臂逐条比它）。 */
function laborPhones(): string[] {
  const card = createKnowledgeSearcher().get?.(LABOR.crisis.resourcePackId, { domain: null });
  return crisisHotlines(card!.facts).map((h) => h.phone);
}

let db: Database.Database;
let uid: number;
let counselingCase: number;
let me: Identity;

beforeEach(() => {
  process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('crisiscard').lastInsertRowid);
  counselingCase = Number(
    db
      .prepare('INSERT INTO cases (user_id, title, domain) VALUES (?, ?, ?)')
      .run(uid, '一件投诉', 'counseling').lastInsertRowid,
  );
  me = { uid, via: 'api_key', scopes: ['case:read', 'case:write'], keyId: 1 };
});

describe('取卡这一面：三态的 domain 各管一件事', () => {
  it('每个已挂上的领域包，它自己声明的危机资源卡都取得回来、且至少有一个可用号码', () => {
    // 【这条是本文件的正题】它不认识任何一个具体领域：新挂一个包、或者哪天有人把
    // resourcePackId 写成一个不存在的 id、或者把闸改回"按缺省域"，这一条都会当场红，
    // 而它红的时候点得出是哪个包。逐包普查比逐个领域各写一条更难被绕过。
    for (const [key, pack] of Object.entries(DOMAINS)) {
      const card = createKnowledgeSearcher().get?.(pack.crisis.resourcePackId, { domain: null });
      expect(card, `${key} 声明的危机资源卡 ${pack.crisis.resourcePackId} 取不到`).toBeDefined();
      const phones = crisisHotlines(card!.facts).map((h) => h.phone);
      expect(phones.length, `${key} 的危机卡上一个可用号码都没有`).toBeGreaterThan(0);
    }
    expect(Object.keys(DOMAINS).length, '只剩一个包时这条普查退化成自说自话').toBeGreaterThanOrEqual(2);
  });

  it('counseling 那张卡上的号码是它自己的：有官方那个、没有卡上标 forbidden 的那个', () => {
    const card = createKnowledgeSearcher().get?.(COUNSELING.crisis.resourcePackId, { domain: null });
    const phones = crisisHotlines(card!.facts).map((h) => h.phone);
    expect(phones).toContain(OFFICIAL_HOTLINE);
    expect(phones).not.toContain(FORBIDDEN_HOTLINE);
    // 也不是把另一个领域那张卡端了过来（两张卡都有 12356，只看它会一起绿）
    expect(phones).not.toEqual(laborPhones());
  });

  it('用户报上来的 id 仍然过闸：不传域时按缺省领域闸（knowledge_get 那条路没被这次改动放开）', () => {
    // 【为什么这条要一起钉】三处调用方改成"不过闸"之后，最容易顺手做的事就是把闸整个删掉。
    // 闸的存在理由是 id 可猜（`<域单数>-<slug>`）而 knowledge_get 是暴露给 MCP 的只读能力。
    expect(createKnowledgeSearcher().get?.(COUNSELING.crisis.resourcePackId)).toBeUndefined();
    expect(createKnowledgeSearcher().get?.(LABOR.crisis.resourcePackId)).toBeDefined();
    // 显式传域时按那个域闸
    expect(
      createKnowledgeSearcher().get?.(COUNSELING.crisis.resourcePackId, { domain: 'counseling' }),
    ).toBeDefined();
    expect(
      createKnowledgeSearcher().get?.(LABOR.crisis.resourcePackId, { domain: 'counseling' }),
    ).toBeUndefined();
  });
});

describe('出口一·MCP crisis_check：counseling 案件拿得到号码', () => {
  function check(text: string, caseId?: number) {
    const cap = getCapability('crisis_check');
    expect(cap, '注册表里没有 crisis_check').toBeDefined();
    return cap!.run(db, me, caseId === undefined ? { text } : { text, case_id: caseId }) as Record<
      string,
      unknown
    >;
  }

  it('命中后 hotlines 不是空数组，且首段里有那个官方号码', () => {
    const r = check(COUNSELING_CRISIS_TEXT, counselingCase);
    expect(r.hit, '这句话没命中本领域词表，下面的断言就成了空跑').toBe(true);
    const phones = (r.hotlines as { phone: string }[]).map((h) => h.phone);
    expect(phones, '命中了却一个号码都没给——正在处置危机的人拿到的是一段空指引').not.toEqual([]);
    expect(phones).toContain(OFFICIAL_HOTLINE);
    expect(phones).not.toContain(FORBIDDEN_HOTLINE);
    expect(r.first_segment as string).toContain(OFFICIAL_HOTLINE);
  });

  it('给的是本领域那张卡上的号码，不是另一个领域那张卡的', () => {
    const r = check(COUNSELING_CRISIS_TEXT, counselingCase);
    const phones = new Set((r.hotlines as { phone: string }[]).map((h) => h.phone));
    const laborOnly = laborPhones().filter((p) => p !== OFFICIAL_HOTLINE);
    expect(laborOnly.length, '两张卡的号码完全一样时这条是空跑').toBeGreaterThan(0);
    for (const p of laborOnly) expect(phones.has(p), `本领域回包里出现了另一个领域的号码 ${p}`).toBe(false);
  });

  it('缺省领域的案子逐字不变（自证不是"谁来都给 counseling 那张卡"）', () => {
    const laborCase = Number(
      db.prepare('INSERT INTO cases (user_id, title) VALUES (?, ?)').run(uid, '缺省领域的案子').lastInsertRowid,
    );
    const r = check('我不想活了', laborCase);
    expect(r.hit).toBe(true);
    const phones = (r.hotlines as { phone: string }[]).map((h) => h.phone);
    expect(phones).toEqual(laborPhones());
  });
});

describe('出口二·无工具模式回填：同一张卡，同一批号码', () => {
  it('counseling 的回填预览里有那个官方号码', () => {
    const notice = crisisNotice(COUNSELING_CRISIS_TEXT, 'counseling');
    expect(notice.triggered, '这句话没命中本领域词表').toBe(true);
    expect(notice.message!, '回填预览提示了危机却没给号码').toContain(OFFICIAL_HOTLINE);
    expect(notice.message!).not.toContain(FORBIDDEN_HOTLINE);
  });

  it('缺省领域的同一条路逐字不变', () => {
    const notice = crisisNotice('我不想活了', DEFAULT_DOMAIN);
    expect(notice.triggered).toBe(true);
    for (const phone of laborPhones()) expect(notice.message!).toContain(phone);
  });
});

describe('出口三·站内对话：取卡时说明白"这个 id 是我们自己给的"', () => {
  /**
   * 【为什么这条钉的是"传了什么"而不是"回包里有号码"】站内对话那条路的取卡结果
   * 会被喂进 system prompt，而 prompt 里有号码这件事，用一个恒返回卡片的假检索器也能造出来——
   * 那样的判据在真实的领域闸下照样绿。这里改成钉**递下去的那个 domain 值**：
   * 少了那个 null，真实的 get 面就按缺省领域闸，counseling 的卡取不回来，
   * 而这条路会把它报成 KNOWLEDGE_UNAVAILABLE（知识库故障），排查会从知识库开始查起。
   */
  it('counseling 案件的那一轮，取危机卡时明说不过闸（domain: null）', async () => {
    const f = makeAgentFixture();
    f.db.prepare('UPDATE cases SET domain = ? WHERE id = ?').run('counseling', f.caseId);
    const seen: { id: string; domain?: string | null }[] = [];
    const sink = makeSink();
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: COUNSELING_CRISIS_TEXT,
      provider: scriptedProvider([{ text: '我在。' }, { text: '' }]),
      searcher: {
        search: () => [],
        get: (id: string, options?: { domain?: string | null }) => {
          seen.push({ id, domain: options === undefined ? '（没传 options）' : options.domain });
          return undefined;
        },
      },
      emit: sink.emit,
    });
    const forCard = seen.find((x) => x.id === COUNSELING.crisis.resourcePackId);
    expect(forCard, '这一轮压根没去取本领域的危机资源卡').toBeDefined();
    expect(forCard!.domain, '取卡时没说明不过闸 ⇒ 真实闸下取不回来，且会被报成知识库故障').toBe(null);
  });

  it('缺省领域的那一轮走的是同一条路（自证这个 null 不是给某一个领域开的后门）', async () => {
    const f = makeAgentFixture();
    const seen: { id: string; domain?: string | null }[] = [];
    const sink = makeSink();
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      message: '有时候半夜想，要是人没了是不是就不用还房贷了。',
      provider: scriptedProvider([{ text: '我在。' }, { text: '' }]),
      searcher: {
        search: () => [],
        get: (id: string, options?: { domain?: string | null }) => {
          seen.push({ id, domain: options === undefined ? '（没传 options）' : options.domain });
          return undefined;
        },
      },
      emit: sink.emit,
    });
    const forCard = seen.find((x) => x.id === LABOR.crisis.resourcePackId);
    expect(forCard).toBeDefined();
    expect(forCard!.domain).toBe(null);
  });
});
