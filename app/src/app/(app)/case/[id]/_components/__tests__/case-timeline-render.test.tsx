/**
 * 卷宗栏时间线**渲染的是这个案子的真实事件**，不是演示值。
 *
 * 立这组的由头：这一块此前是 `<TimelineBlock events={demoTimeline} />`——
 * caseId 传进去却一次都没被用来取数，二十条写死的演示事件对每一个案件照样渲染。
 * 与 RecentRecords / Dashboard 当年那两处逐字同款：页面不报错、条数也对，
 * 只是打开它的人看到的每一条都不是自己的事。
 *
 * 【量具边界】本仓没有 jsdom（见 components/__tests__/touch-targets.test.tsx 抬头），
 * 所以这里只渲染**渲染面**（TimelineSection：不取数、不写数）。
 * 「表单发出去那份体真端点收得下」在 ./timeline-entry-contract.test.ts，
 * 它走的是真路由 + 真库，不是替身。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const probe = vi.hoisted(() => ({ domain: '' }));
vi.mock('@/app/_ui/caseDomain', () => ({
  useCaseDomain: () => probe.domain,
  useMyDomain: () => probe.domain,
}));
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
  DocumentTitle: () => null,
}));

const { TimelineSection } = await import('../CaseTimeline');
const { prependEvent, replaceEvent, toTimelineView } = await import('../timelineData');
const { DEFAULT_DOMAIN, DOMAINS } = await import('@/lib/domains/registry');
const { tierMark } = await import('@/lib/cases/source-tier');

const COMPONENTS = join(process.cwd(), 'src/app/(app)/case/[id]/_components');
const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

/** 类型 id / label 逐字取自领域包：本文件不认识任何一个行当的取值。 */
const COMPANY_TYPES = DOMAINS[DEFAULT_DOMAIN].timelineEventTypes['公司动作'];
/** 这一类在缺省领域里**不分型**（空数组是结论不是待填项），「选类型」对它整个不出现 */
const SYSTEM_TYPES = DOMAINS[DEFAULT_DOMAIN].timelineEventTypes['系统动作'];

/** 真接口回来的那几行，字段名逐字照后端行（lib/db/cases.TimelineEventRow） */
const API_ROWS = [
  {
    id: 91,
    happened_at: '2026-07-24T10:00:00+08:00',
    kind: '公司动作',
    title: '收到一份书面通知',
    detail: '当面给的，要求当天签字',
    source_tier: '书证',
    event_type: COMPANY_TYPES[0].id,
  },
  {
    id: 90,
    happened_at: '2026-07-01T09:00:00+08:00',
    kind: '公司动作',
    title: '被叫去谈话',
    detail: '',
    source_tier: '自述',
    event_type: null,
  },
  {
    id: 89,
    happened_at: '2026-06-30T09:00:00+08:00',
    kind: '系统动作',
    title: '档案已建立',
    detail: '',
    source_tier: '自述',
    event_type: null,
  },
];

function render(over: Partial<Parameters<typeof TimelineSection>[0]> = {}): string {
  return ssr(
    <TimelineSection
      caseId="4217"
      events={API_ROWS.map(toTimelineView)}
      failure={null}
      canWrite
      onAdd={() => {}}
      onPickType={() => {}}
      {...over}
    />,
  );
}

describe('逐条渲染', () => {
  it('🔴 每条都有：日期、kind 徽标、类型标签、标题、来源档后缀（变异：删掉其中一格 → 红）', () => {
    const out = text(render());

    expect(out, '量具自检：什么都没渲染出来时下面每一条都在验空集').toContain('时间线');
    // 日期（按 Asia/Shanghai 渲染，判据自带时区口径）
    expect(out).toContain('2026/07/24');
    // kind 徽标：三条各自的类别名都印出来了
    expect(out).toContain('公司动作');
    expect(out).toContain('系统动作');
    // 类型标签：**取自领域包的 label**，不是库里那个 id
    expect(out).toContain(COMPANY_TYPES[0].label);
    expect(out, '落库那个不透明串不该印给用户读').not.toContain(COMPANY_TYPES[0].id);
    // 标题与详情
    expect(out).toContain('收到一份书面通知');
    expect(out).toContain('当面给的');
    // 来源档后缀由 tierMark 推出，不在组件里另写一套
    expect(out).toContain(tierMark('书证'));
    expect(out).toContain(tierMark('自述'));
  });

  it('🔴 档位认不出的那一行渲染成〔未记录〕，不悄悄折成最弱档', () => {
    const out = text(
      render({
        events: [toTimelineView({ ...API_ROWS[0], source_tier: '某个写坏的值' })],
      }),
    );
    expect(out).toContain(tierMark(null));
    expect(out, '把脏数据渲染成〔自述〕＝把"没有这条事实"读成"有，只是没人证"').not.toContain(
      tierMark('自述'),
    );
  });

  it('没选过类型的那一行不显示标签（而不是显示一个空标签或那个 id）', () => {
    const out = text(render({ events: [toTimelineView(API_ROWS[1])] }));
    expect(out).toContain('被叫去谈话');
    for (const t of COMPANY_TYPES) expect(out).not.toContain(t.label);
  });

  it('库里存着一个领域包不认识的类型 id ⇒ 不显示标签，也不把 id 印出来', () => {
    const out = text(
      render({ events: [toTimelineView({ ...API_ROWS[0], event_type: '一个没人认识的串' })] }),
    );
    expect(out).not.toContain('一个没人认识的串');
  });
});

describe('两个入口出现的条件', () => {
  it('🔴 登记入口那行字取自领域包（变异：把它写死进组件 → 页面按领域说话那条判据红）', () => {
    const out = text(render());
    expect(out).toContain(DOMAINS[DEFAULT_DOMAIN].copy.pages.timelineAddLabel);
  });

  it('🔴 「选类型」只出现在**没选过类型、而这一类有类型可选**的行上', () => {
    const out = text(render({ events: [toTimelineView(API_ROWS[1])] }));
    expect(out, '这一行没选过类型，「公司动作」这一类又有取值可挑').toContain('选类型');

    expect(SYSTEM_TYPES, '前提变了：这一类在缺省领域里本来是不分型的').toHaveLength(0);
    const systemOnly = text(render({ events: [toTimelineView(API_ROWS[2])] }));
    expect(systemOnly, '不分型的那一类摆出「选类型」＝让人回答一个没有人会读的问题').not.toContain(
      '选类型',
    );

    const typed = text(render({ events: [toTimelineView(API_ROWS[0])] }));
    expect(typed, '已经选过类型的行不该再摆这个入口').not.toContain('选类型');
  });

  it('🔴 演示案件（canWrite=false）两个写入口一个都不出现——写进去会吃一条 404', () => {
    const out = text(render({ canWrite: false }));
    expect(out).not.toContain(DOMAINS[DEFAULT_DOMAIN].copy.pages.timelineAddLabel);
    expect(out).not.toContain('选类型');
    expect(out, '读侧照常渲染').toContain('收到一份书面通知');
  });
});

describe('三种"空"不许长成同一种', () => {
  it('还在读 ⇒ 画骨架，不说"你还没记过任何事"', () => {
    const out = text(render({ events: null }));
    expect(out).not.toContain(DOMAINS[DEFAULT_DOMAIN].copy.pages.timelineEmpty);
  });

  it('确实一条都没有 ⇒ 空态那段话（告诉他从哪天记起）', () => {
    const out = text(render({ events: [] }));
    expect(out).toContain(DOMAINS[DEFAULT_DOMAIN].copy.pages.timelineEmpty);
  });

  it('🔴 没读出来 ⇒ 失败块，且**不许**同时画空态（那等于告诉记过二十条的人：你什么都没记过）', () => {
    const out = text(render({ events: [], failure: '网络没连上，检查一下再试。' }));
    expect(out).toContain('网络没连上');
    expect(out).not.toContain(DOMAINS[DEFAULT_DOMAIN].copy.pages.timelineEmpty);
  });
});

describe('刚记下的那条', () => {
  it('🔴 头插，不是尾插（变异：改成 [...list, created] → 红）', () => {
    const [a, b] = API_ROWS.map(toTimelineView);
    expect(prependEvent([a], b).map((e) => e.id)).toEqual(['90', '91']);
  });

  it('同一条重放（deduped 回的是既有行）不会在列表里出现两次', () => {
    const a = toTimelineView(API_ROWS[0]);
    expect(prependEvent([a], a).map((e) => e.id)).toEqual(['91']);
  });

  it('改完类型就地换那一行，不凭空多一条', () => {
    const [a, b] = API_ROWS.map(toTimelineView);
    const out = replaceEvent([a, b], { ...b, eventType: COMPANY_TYPES[1].id });
    expect(out.map((e) => e.id)).toEqual(['91', '90']);
    expect(out[1].eventType).toBe(COMPANY_TYPES[1].id);
  });
});

/**
 * 结构守卫：**这条是「必须能红」的那条。**
 * 有人把 demoTimeline 接回卷宗栏（哪怕只是"临时先跑起来"），这里立刻红。
 * 断言 import 语句本身而不是渲染结果——演示值和真值长得像的时候，渲染结果看不出区别。
 */
describe('卷宗栏时间线不许再从 mock 取事件', () => {
  function importsOf(src: string): { from: string; bindings: string }[] {
    return [...src.matchAll(/import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g)].map((m) => ({
      bindings: m[1],
      from: m[2],
    }));
  }
  const read = (f: string) => readFileSync(join(COMPONENTS, f), 'utf8');
  const FILES = ['CasePanel.tsx', 'CaseTimeline.tsx', 'TimelineEntrySheet.tsx', 'timelineData.ts'];

  it('正对照：这四个文件确实解析得出 import，否则下面几条是在空集上断言', () => {
    for (const f of FILES) expect(importsOf(read(f)).length, f).toBeGreaterThan(0);
  });

  it('🔴 CasePanel 不再从 _mock/demo 取 demoTimeline（变异：引回来 → 红）', () => {
    for (const imp of importsOf(read('CasePanel.tsx')).filter(
      (i) => i.from === '@/app/_mock/demo',
    )) {
      expect(imp.bindings).not.toContain('demoTimeline');
    }
  });

  it('🔴 渲染面与两张抽屉一点 mock 都不碰——它们只认传进来的行', () => {
    for (const f of ['CaseTimeline.tsx', 'TimelineEntrySheet.tsx']) {
      expect(
        importsOf(read(f)).map((i) => i.from).filter((from) => from.includes('_mock')),
        `${f} 里不该有任何 _mock`,
      ).toEqual([]);
    }
  });

  it('演示数据只经数据层那一个函数进来（demoEvents），与真接口并排摆着', () => {
    const data = read('timelineData.ts');
    expect(data).toContain('export function demoEvents');
    expect(
      importsOf(data).filter((i) => i.from === '@/app/_mock/demo').map((i) => i.bindings.trim()),
      '数据层只取那一份演示时间线，别把整套演示案情拖进来',
    ).toEqual(['{ demoTimeline }']);
  });
});
