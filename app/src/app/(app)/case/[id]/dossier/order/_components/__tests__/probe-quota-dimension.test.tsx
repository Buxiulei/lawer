/**
 * F-207：免费查的次数说明必须说清**按什么减**。
 *
 * 报的现象：连点两次「免费查」（换了公司名），屏幕上「今日还剩 2 次免费查」一动不动。
 * 那句话其实是对的——配额只由「真去采集侧现查一次」消耗（lib/company/probe：
 * 只有 status='collected' 才往 company_probe_events 落一行），本机没接采集器，
 * 两次都走 no_collector，什么都没采到，当然不减。
 * 但**一个永远不动的计数器和一个坏掉的计数器在屏幕上长得一模一样**：
 * 用户没有办法判断每日限额到底生没生效。
 *
 * 所以这一组分两半：
 *   ① 真库断言——把「按什么减」量出来。同一家连查两次只减 1（第二次读存档不减），
 *      换一家真现查再减 1，配额用完不再减；事件表行数与「真现查次数」一一对上。
 *      它同时证伪两种误解：不是「按点击次数减」，也不是「按公司去重后永不减」。
 *   ② 文案断言——屏幕上那一行必须把这条维度写出来，四种结局各说各的「这次减没减」。
 *
 * 变异臂：
 *   · probe.ts 去掉 recordProbeEvent（真现查也不计数）→ ①红
 *   · probeQuotaNote 把 dimension 抹成空串（只剩数字）→ ②红
 */
import Database from 'better-sqlite3';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import { runMigrations } from '@/lib/db/migrate';
import { probeCompany, type ProbePayload, type ProbeResult } from '@/lib/company/probe';
import { PROBE_QUOTA_DIMENSION, probeQuotaNote } from '@/lib/dossier/order';
import { CASE_WORDS } from '@/app/_ui/neutral';
import { ProbeCard } from '../OrderQuote';

const NOW = '2026-09-01 10:00:00';

function seed() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare("INSERT INTO users (id, auth_status) VALUES (1, '未实名')").run();
  return db;
}

const payload = (name: string): ProbePayload => ({
  entity_matched: true,
  entity_name: name,
  uscc: null,
  gs_status: '存续',
  relation_count: 1,
  litigation_count: 2,
  labor_count: 1,
  doc_url_count: 0,
  as_of: '2026-09-01',
});

const events = (db: Database.Database) =>
  (db.prepare('SELECT COUNT(*) AS n FROM company_probe_events').get() as { n: number }).n;

const text = (node: React.ReactNode) =>
  renderToStaticMarkup(<>{node}</>).replace(/<[^>]+>/g, '');

describe('F-207 ①真库：免费次数按「真去现查一次」减，不按点击、也不是永不减', () => {
  it('同一家连查两次只减 1；换一家再减 1；用完不再减，事件表行数与真现查次数一一对上', async () => {
    const db = seed();
    const collect = (name: string) => async () => payload(name);

    const a1 = await probeCompany(
      db,
      { name: '北京甲科技有限公司', userId: 1 },
      { now: NOW, collect: collect('北京甲科技有限公司') },
    );
    expect(a1.status).toBe('collected');
    expect(a1.quota_left, '真现查一次，2 → 1').toBe(1);
    expect(events(db)).toBe(1);

    // 同一家再点一次：命中刚写下的缓存，0 成本、不限次、**不减**
    const a2 = await probeCompany(
      db,
      { name: '北京甲科技有限公司', userId: 1 },
      { now: NOW, collect: collect('北京甲科技有限公司') },
    );
    expect(a2.status).toBe('hit');
    expect(
      a2.quota_left,
      '缺什么：读存档那一次把免费次数也减掉了。\n' +
        '为什么缺：命中缓存的边际成本是 0，减它等于替用户白花一次额度；' +
        '而屏幕上那句维度说明写的正是「读存档不减」，两边打架比不写更糟。\n' +
        '怎么办：lib/company/probe 里只有 status=collected 才 recordProbeEvent。',
    ).toBe(1);
    expect(events(db), '读存档不该落事件行').toBe(1);

    // 换一家：真现查，再减 1
    const b1 = await probeCompany(
      db,
      { name: '上海乙信息技术有限公司', userId: 1 },
      { now: NOW, collect: collect('上海乙信息技术有限公司') },
    );
    expect(b1.status).toBe('collected');
    expect(
      b1.quota_left,
      '缺什么：第二家公司真现查了一次，免费次数却没减。\n' +
        '为什么缺：那样每日限额等于形同虚设，屏幕上的数字是个永远不动的摆设——' +
        'F-207 报的就是「数字一动不动，没法确认限流生没生效」。\n' +
        '怎么办：probeCompany 的 collected 分支必须 recordProbeEvent 一行。',
    ).toBe(0);
    expect(events(db)).toBe(2);

    // 第三家：额度已尽，降级且不再减
    const c1 = await probeCompany(
      db,
      { name: '广州丙实业有限公司', userId: 1 },
      { now: NOW, collect: collect('广州丙实业有限公司') },
    );
    expect(c1.status).toBe('quota_exhausted');
    expect(c1.quota_left).toBe(0);
    expect(events(db), '额度用完那一次没采到东西，不该落事件行').toBe(2);
  });

  it('反向对照：没接采集器时连查两家，两次都不减——这正是那份报告看到的真相', async () => {
    const db = seed();
    const r1 = await probeCompany(db, { name: '北京星际虚构科技有限公司', userId: 1 }, { now: NOW });
    const r2 = await probeCompany(db, { name: '京东科技信息技术有限公司', userId: 1 }, { now: NOW });
    expect(r1.status).toBe('no_collector');
    expect(r2.status).toBe('no_collector');
    expect(r1.quota_left).toBe(2);
    expect(r2.quota_left).toBe(2);
    expect(events(db)).toBe(0);
  });
});

describe('F-207 ②文案：数字后面必须跟着计数维度', () => {
  const of = (status: ProbeResult['status'], left: number): ProbeResult => ({
    company_key: 'name:x',
    status,
    cache_state: status === 'hit' ? 'fresh' : 'none',
    quota_left: left,
    ...(status === 'hit' || status === 'collected'
      ? { payload: payload('北京甲科技有限公司') }
      : { reason: '这一刻没去查，不是查无此公司。' }),
  });

  it('四种结局各说各的「这次减没减」，四句互不相同', () => {
    const spent = (['hit', 'collected', 'no_collector', 'quota_exhausted'] as const).map(
      (s) => probeQuotaNote(of(s, 1)).spent,
    );
    expect(new Set(spent).size, '四种结局共用一句等于没说').toBe(4);
    expect(probeQuotaNote(of('collected', 1)).spent).toContain('减掉 1 次');
    expect(probeQuotaNote(of('hit', 1)).spent).toContain('没减');
    expect(probeQuotaNote(of('no_collector', 2)).spent).toContain('没减');
  });

  it('维度说明写明「按真去现查一次减 1，读存档、没查着都不减」', () => {
    for (const piece of ['现查', '减 1', '读存档', '不减']) {
      expect(
        PROBE_QUOTA_DIMENSION.includes(piece),
        `缺什么：免费次数的维度说明里没有「${piece}」。\n` +
          '为什么缺：不说维度，用户连查两次看见数字一动不动，跟「限流根本没生效」分不开；' +
          '而真相是那两次都没采到东西，本来就不该减。\n' +
          '怎么办：措辞收在 lib/dossier/order 的 PROBE_QUOTA_DIMENSION，别在组件里现写。',
      ).toBe(true);
    }
  });

  it('探测卡两个分支（有数字 / 降级）都把维度说明摆在屏幕上', () => {
    for (const [name, probe] of [
      ['命中', of('hit', 1)],
      ['降级', of('no_collector', 2)],
    ] as const) {
      const t = text(<ProbeCard probe={probe} />);
      expect(
        t.includes(PROBE_QUOTA_DIMENSION),
        `缺什么：探测卡的「${name}」分支只写了还剩几次，没写按什么减。\n` +
          '为什么缺：这一行的失败形态是静默的——数字照常渲染、页面照常好看，' +
          '只是用户永远确认不了每日限额有没有生效。\n' +
          '怎么办：两个分支都过 QuotaNote（OrderQuote.tsx），别只改一处。',
      ).toBe(true);
      expect(t).toContain('今日还剩');
    }
  });

  it('这几句在低调模式下也清晰可读，所以一个案情词都不能有', () => {
    const all = PROBE_QUOTA_DIMENSION + (['hit', 'collected', 'no_collector', 'quota_exhausted'] as const)
      .map((s) => probeQuotaNote(of(s, 1)).spent)
      .join('');
    for (const word of CASE_WORDS) {
      expect(all.includes(word), `免费次数说明里写着「${word}」`).toBe(false);
    }
  });
});
