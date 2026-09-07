// app/src/app/__tests__/kinds-by-domain.test.tsx
// 期限种类与文书种类按**案件所属领域**的词表认（设计稿 §13「网页」行、§16）。
//
// ─────────────── 这一组守的是什么 ───────────────
// 驾驶舱与文书页各挂过一份**写死的缺省领域词表**，词表外的一律折成其中一档
//（期限折成「自定义」，文书折成「其他」）。第二个领域的坏法因此是：
//   · 库里落着 kind='诉讼时效3年' 的期限 → 卡面标题写着「自定义」；
//   · 库里落着「知情同意书」的文书 → 列表里的类型徽标写着「其他」。
// 两处都**返回正常、条数正常、时间正常**，只有那一格字不是这个人的事；
// 轨道那侧的判据（dashboard-by-domain）盯的是格子，一条都不会红。
//
// 【为什么按渲染产物验，而不是只验数据层】只验数据层的形态是：转换函数把 kind 留住了，
// 而卡片上印的是另一个字段（title 曾经被赋成折算后的 kind）。这里两侧都验：
// 数据层留住原值，卡面与徽标印的就是那个原值。
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, toggle: () => {} }),
  DocumentTitle: () => null,
}));
// 文书列表按领域取导语（DraftsListView 已有判据盯），这里只要它别去发请求
const probe = vi.hoisted(() => ({ domain: '' }));
vi.mock('@/app/_ui/caseDomain', () => ({
  useCaseDomain: () => probe.domain,
  useMyDomain: () => probe.domain,
}));

/** 接口替身：按前缀回预置的行，形状照后端路由的真实响应 */
const responses: Record<string, unknown> = {};
vi.mock('@/app/_ui/api', () => ({
  apiFetch: (path: string) => {
    const key = Object.keys(responses).find((k) => path.startsWith(k));
    return key === undefined
      ? Promise.reject(new Error(`测试没给 ${path} 预置响应`))
      : Promise.resolve(responses[key]);
  },
  apiFetchAll: (path: string) => {
    const key = Object.keys(responses).find((k) => path.startsWith(k));
    return key === undefined
      ? Promise.reject(new Error(`测试没给 ${path} 预置响应`))
      : Promise.resolve(responses[key] as unknown[]);
  },
  ApiError: class ApiError extends Error {},
  humanError: (err: unknown) => (err instanceof Error ? err.message : '出错了'),
}));

const { fetchDashboard } = await import('@/app/(app)/case/[id]/_components/dashboardData');
const { DeadlineTiles } = await import('@/app/(app)/case/[id]/_components/DeadlineTiles');
const { toDraftView, unknownKinds } = await import(
  '@/app/(app)/case/[id]/drafts/_components/draftsData'
);
const { DraftsListView } = await import(
  '@/app/(app)/case/[id]/drafts/_components/DraftsListView'
);
const { fetchEvidenceList } = await import('@/app/(app)/case/[id]/evidence/_data');
const { EVIDENCE_CATEGORIES: PICKER_CATEGORIES } = await import('@/app/_mock/intake-evidence');
const { EVIDENCE_CATEGORIES: SPEC_CATEGORIES } = await import('@/lib/evidence/categories');
const { DOMAINS } = await import('@/lib/domains/registry');

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);
const text = (html: string) => html.replace(/<[^>]+>/g, '');

/** 这个包**独有**的那几类（别的包也有的不算——共有的值验不出"按谁的词表认"）。 */
function soleKinds(key: string, pick: (k: string) => readonly string[]): string[] {
  const others = new Set(
    Object.keys(DOMAINS)
      .filter((k) => k !== key)
      .flatMap((k) => [...pick(k)]),
  );
  return [...pick(key)].filter((v) => !others.has(v));
}

/** 一份「整套都在」的驾驶舱回包，期限那一段由调用方给。 */
function seed(domain: string, kinds: string[]) {
  for (const k of Object.keys(responses)) delete responses[k];
  responses['/cases/9?'] = {
    case: { id: 9, title: '我的案件', stage: [...DOMAINS[domain].stages][0], domain },
    timeline: [],
  };
  responses['/cases/9/actions'] = [];
  responses['/cases/9/evidence'] = [];
  responses['/cases/9/deadlines'] = kinds.map((kind, i) => ({
    id: 100 + i,
    case_id: 9,
    kind,
    due_at: '2026-12-01T00:00:00+08:00',
    derived_from: null,
  }));
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
});

describe.each(Object.keys(DOMAINS))('%s：期限种类', (key) => {
  const mine = soleKinds(key, (k) => DOMAINS[k].deadlineKinds);

  it('这个包独有的那几类，kind 与卡面标题都是库里那个字（变异：把 title 折成词表里某一档 → 红）', async () => {
    expect(mine.length, `${key} 的 deadlineKinds 与别的包完全重合，本条恒真`).toBeGreaterThan(0);
    seed(key, mine);
    const data = await fetchDashboard('9');

    expect(data.deadlines.map((d) => d.kind)).toEqual(mine);
    // 卡面上那行字取的就是 kind（库里没有 title 这一列），两者必须同字
    expect(data.deadlines.map((d) => d.title)).toEqual(mine);

    const out = text(ssr(<DeadlineTiles deadlines={data.deadlines} now={new Date('2026-09-07')} />));
    for (const kind of mine) {
      expect(out, `期限卡上没有「${kind}」这行字`).toContain(kind);
    }
  });

  it('词表里的种类一声不吭（把别的领域那份词表当成"未知"来喊的形态是：满屏告警而屏幕上看不出）', async () => {
    seed(key, [...DOMAINS[key].deadlineKinds]);
    await fetchDashboard('9');
    expect(warn, `${key} 自己词表里的种类被当成了未知`).not.toHaveBeenCalled();
  });

  it('词表外的种类：照原样渲染 + 出声（变异：把那句 console.warn 删掉 → 红）', async () => {
    const alien = '这个词表里没有的一类';
    seed(key, [alien]);
    const data = await fetchDashboard('9');
    // 出声是为了让"库里落了本领域认不出的值"这件事有人看得见；
    // 但屏幕上那行字**一个都不许改**——改了用户就再也找不到这张卡说的是什么。
    expect(data.deadlines[0]).toMatchObject({ kind: alien, title: alien });
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[1] ?? '')).toBe(alien);
  });
});

describe.each(Object.keys(DOMAINS))('%s：文书种类', (key) => {
  const mine = soleKinds(key, (k) => DOMAINS[k].docKinds);

  const rowOf = (kind: string, id: number) => ({
    id,
    case_id: 9,
    kind,
    title: `一份${kind}`,
    content: '正文',
    version: 1,
    status: 'draft',
    created_at: '2026-09-01T10:00:00Z',
    updated_at: '2026-09-01T10:00:00Z',
  });

  it('这个包独有的那几类原样透传，列表里的类型徽标印的就是它（变异：把 kind 折成某一档 → 红）', () => {
    expect(mine.length, `${key} 的 docKinds 与别的包完全重合，本条恒真`).toBeGreaterThan(0);
    probe.domain = key;
    const views = mine.map((kind, i) => toDraftView(rowOf(kind, 200 + i)));
    expect(views.map((v) => v.kind)).toEqual(mine);

    const out = text(ssr(<DraftsListView caseId="9" drafts={views} />));
    for (const kind of mine) {
      expect(out, `文书列表里没有「${kind}」这个类型徽标`).toContain(kind);
    }
  });

  it('「哪几类不在本领域词表里」按这个包的 docKinds 算（变异：把入参换成写死一份词表 → 红）', () => {
    // 自己的词表：一个都不该被点名
    expect(unknownKinds([...DOMAINS[key].docKinds], DOMAINS[key].docKinds)).toEqual([]);
    // 别的包独有的那几类：在这个领域里就是认不出的（这正是从前被静默折成一档的那些）
    for (const other of Object.keys(DOMAINS)) {
      if (other === key) continue;
      const alien = soleKinds(other, (k) => DOMAINS[k].docKinds);
      if (alien.length === 0) continue;
      expect(unknownKinds(alien, DOMAINS[key].docKinds)).toEqual(alien);
    }
    // 去重且保序：同一类出现两次只点一次名，否则一页十份文书能刷十行告警
    expect(unknownKinds(['甲', '乙', '甲'], [])).toEqual(['甲', '乙']);
  });
});

/* ── 证据分类：不按领域取，但也不许各抄各的 ───────────────────── */

/**
 * 证据分类**不是**按领域取的：`evidence.category` 是 spec §7 表定义里的固定枚举，
 * 上传那一侧（lib/evidence/index.ts）对所有领域按同一份校验、写不进第九个值。
 * 复审把它与期限/文书两份词表列在同一条里，这里把它与那两份的**分野**钉下来：
 * 那两份各领域一份（DomainPack），这一份全站一份（spec §7），
 * 而全站一份的失效方式是**被抄成好几份**——页面选择器一份、页面收口一份、上传校验一份，
 * 哪天岔开，用户在选择器里选得到的类别上传时被 400 拒掉，而每一侧各自看都正常。
 *
 * 按领域各给一份词表是另一件事：那要先动 spec §7 与上传校验，不在页面这一层。
 */
describe('证据分类只有一份（spec §7）', () => {
  it('页面选择器摆的就是 spec 那一份（变异：往 _mock/intake-evidence 里抄回一份手写的 → 红）', () => {
    expect([...PICKER_CATEGORIES]).toEqual([...SPEC_CATEGORIES]);
  });

  it('spec 里的每一类都原样收下，不折成「其他」（变异：页面另抄一份少一类 → 那一类红）', async () => {
    for (const k of Object.keys(responses)) delete responses[k];
    responses['/cases/9/evidence'] = SPEC_CATEGORIES.map((category, i) => ({
      id: 300 + i,
      case_id: 9,
      name: `一份${category}`,
      category,
      prove_purpose: null,
      status: '已上传',
      created_at: '2026-09-01T10:00:00Z',
    }));
    const list = await fetchEvidenceList('9');
    expect(list.map((e) => e.category)).toEqual([...SPEC_CATEGORIES]);
  });
});
