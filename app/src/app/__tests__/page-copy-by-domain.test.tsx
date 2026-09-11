// app/src/app/__tests__/page-copy-by-domain.test.tsx
// 六个**共用页**按案件领域说话（设计稿 §13「网页」行）。
//
// ─────────────── 为什么按文件拦还不够 ───────────────
// page-domain-guard 是**按文件**拦的：某个文件里出现「劳动/仲裁/…」就红。它挡得住
// 「把上一个行当的词写死进来」，挡不住另外三种同样静默的坏法：
//   ① 领域取对了、字取错了——`packOf(domain)` 写成 `packOf(DEFAULT_DOMAIN)`，
//      文件里一个领域词都没有，闸不响，而第二个领域的用户读到的还是缺省领域那句；
//   ② 问错了案子——`useCaseDomain(caseId)` 里传的不是这一页的 caseId
//      （抄来的一行、或者顺手传了 'demo'），照样一个词都不写死；
//   ③ 换成一句谁都不得罪的通用话——两个领域读到的是同一句正确的废话，
//      而"按领域说话"这件事已经没有了。
// 三种在按文件扫的那道闸下都全绿，页面也照常渲染。所以这一份**按渲染产物**再拦一遍：
// 每个包的话必须逐字出现，别的包**独有**的话一个字都不许出现。
//
// 【这六处是怎么选出来的】2026-09-07 复审逐个点名：它们当初以「这一页本来就只服务
// 缺省领域」的名义进了 page-domain-guard 的白名单，而这个理由对它们是假的——
// 第二个领域的用户照样会打开驾驶舱、设置页、证据页、文书页、关系图与解读页。
//
// 【领域从哪来是被 mock 的，接线另有判据】useCaseDomain / useMyDomain 要发请求，
// node 环境里跑不了 effect。所以这里把它换成一个**记参数的替身**：
// 领域由测试给，而「这一页问的是不是自己那个案子」由 asked 那条断言盯住（坏法②）。
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 替身当前该回哪个领域，以及被问过哪几个 caseId。 */
const probe = vi.hoisted(() => ({ domain: '', asked: [] as string[], askedMine: 0 }));

vi.mock('@/app/_ui/caseDomain', () => ({
  useCaseDomain: (caseId: string) => {
    probe.asked.push(caseId);
    return probe.domain;
  },
  useMyDomain: () => {
    probe.askedMine += 1;
    return probe.domain;
  },
}));
vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: false, setDiscreet: () => {}, toggle: () => {} }),
  DocumentTitle: () => null,
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));
vi.mock('@/components/ui/Toast', () => ({ useToast: () => () => {} }));
// 抽屉真身在 Radix 的 Portal 后面，SSR 出空串（同 graph/tier-labels 那份判据的处境）。
// 换成一个把 children 原样摆出来的壳：被验的是抽屉**里**那几句话，不是 Radix 的搬运。
vi.mock('@/components/shadcn/app-sheet', () => ({
  AppSheet: ({ children, footer }: { children: React.ReactNode; footer?: React.ReactNode }) => (
    <div>
      {children}
      {footer}
    </div>
  ),
}));

const { DOMAINS } = await import('@/lib/domains/registry');
const { DashboardBody } = await import('@/app/(app)/case/[id]/_components/Dashboard');
const { DraftsListView } = await import(
  '@/app/(app)/case/[id]/drafts/_components/DraftsListView'
);
const { RealDraftBody } = await import(
  '@/app/(app)/case/[id]/drafts/_components/RealDraftView'
);
const { DocActions } = await import('@/app/(app)/case/[id]/docs/_components/DocActions');
const { NodeSheet } = await import('@/app/(app)/case/[id]/graph/_components/NodeSheet');
const { EvidenceDetailSheet } = await import(
  '@/app/(app)/case/[id]/evidence/_components/EvidenceDetailSheet'
);
const { SetupPrompt } = await import('@/app/(app)/settings/_components/SetupPrompt');
const { CasePanel } = await import('@/app/(app)/case/[id]/_components/CasePanel');
const { TimelineSection } = await import('@/app/(app)/case/[id]/_components/CaseTimeline');
const { CompanyGraphView } = await import(
  '@/app/(app)/case/[id]/graph/_components/CompanyGraphView'
);
const { mockCompanyGraph } = await import('@/app/_mock/company-graph');

type DashboardData = Awaited<
  ReturnType<typeof import('@/app/(app)/case/[id]/_components/dashboardData').fetchDashboard>
>;
type EvidenceView = import('@/app/(app)/case/[id]/evidence/_data').EvidenceView;
type DraftView = import('@/app/(app)/case/[id]/drafts/_components/draftsData').DraftView;

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

/** 本页固定用这个 caseId，好让「问的是不是自己那个案子」问得出来。 */
const CASE_ID = '4217';

const dashboardData = (domain: string): DashboardData => ({
  domain,
  track: null,
  actions: [],
  deadlines: [],
  attainments: [],
  records: [],
  timelineCount: 3,
});

const DRAFT: DraftView = {
  id: '1',
  kind: '其他',
  status: '草稿',
  title: '一份文书',
  content: '正文',
  version: 1,
  updatedAt: '2026-09-01T10:00:00Z',
};

const EVIDENCE: EvidenceView = {
  id: 'e1',
  name: '一份材料',
  category: '其他',
  provePurpose: '',
  originalMedium: '手机拍照',
  status: '已上传',
  sizeBytes: null,
  sha256: null,
  createdAt: '2026-09-01T10:00:00Z',
  voidedAt: null,
  voidReason: '',
  attestation: null,
  extraction: null,
  detailed: false,
};

const SETUP_URLS = {
  mcp_url: 'https://example.test/api/mcp',
  api_base: 'https://example.test/api/v1',
  manifest_url: 'https://example.test/api/manifest',
  openapi_url: 'https://example.test/api/openapi.json',
  skill_url: 'https://example.test/skill/SKILL.md',
};

/**
 * 六个共用面各自渲染出来的**整段产物**（含属性，因为证据页那一句在 placeholder 上）。
 * 每一项点名它负责 copy.pages 里的哪几个键——漏掉一个键，下面「每个键都有人验」那条会红。
 *
 * `domainFrom` 记的是**这一面的领域是从哪儿来的**，三种各有各的接线判据：
 *   · 'data' 驾驶舱：领域随取数那一趟一起回来（dashboardData 读 GET /cases/{id} 的整行），
 *     不另发请求。这一面没有"问错案子"的形态，接线由上面那条逐字判据兜住。
 *   · 'case' 另外四页：各自取数都不带领域，只能现问一次（useCaseDomain(caseId)）。
 *   · 'mine' 设置页：不在案件路由下，没有 caseId 可问（useMyDomain）。
 */
const SURFACES: {
  name: string;
  keys: string[];
  domainFrom: 'data' | 'case' | 'mine';
  render: () => string;
}[] = [
  {
    name: '驾驶舱·档案入口卡',
    keys: ['dossierEntryTitle', 'dossierEntryDetail'],
    domainFrom: 'data',
    render: () => ssr(<DashboardBody caseId={CASE_ID} data={dashboardData(probe.domain)} />),
  },
  {
    name: '文书页·导语',
    domainFrom: 'case',
    keys: ['draftsIntroBefore', 'draftsIntroAfter'],
    render: () => ssr(<DraftsListView caseId={CASE_ID} drafts={[DRAFT]} />),
  },
  {
    name: '文书页·空态',
    domainFrom: 'case',
    keys: ['draftsEmptyDescription'],
    render: () => ssr(<DraftsListView caseId={CASE_ID} drafts={[]} />),
  },
  {
    // 生成合成内容的显式标识（标识办法 §4）。**后半截**「所以它不是什么」按行当走：
    // 这个位置写死一句通用话的形态是，两个行当的用户读到同一句正确的废话
    // ——而他们各自最容易误当成的那种专业意见，一个都没被点名（坏法③）。
    name: '文书页·生成合成内容标识',
    domainFrom: 'case',
    keys: ['aiLabelDisclaimer'],
    render: () => ssr(<RealDraftBody caseId={CASE_ID} draft={DRAFT} />),
  },
  {
    name: '解读页·接下来',
    domainFrom: 'case',
    keys: ['docActionsHint'],
    render: () => ssr(<DocActions caseId={CASE_ID} docTitle="一份文件" />),
  },
  {
    name: '关系图·节点抽屉',
    domainFrom: 'case',
    keys: ['graphLitigationNote'],
    render: () =>
      ssr(
        <NodeSheet
          caseId={CASE_ID}
          graph={mockCompanyGraph}
          node={mockCompanyGraph.nodes[0]}
          onClose={() => {}}
          onSelect={() => {}}
        />,
      ),
  },
  {
    name: '证据页·证明目的那一栏',
    domainFrom: 'case',
    keys: ['evidencePurposePlaceholder'],
    render: () =>
      ssr(
        <EvidenceDetailSheet
          caseId={CASE_ID}
          item={EVIDENCE}
          onClose={() => {}}
          onRequestFreeze={() => {}}
          onIssue={() => {}}
          onSavePurpose={() => {}}
          onDownload={() => {}}
          onRequestExtract={() => {}}
        />,
      ),
  },
  {
    // 卷宗栏（PC 右栏 / 手机抽屉）里按行当变的两句：图谱那一格的引言、诉求表脚注的口径。
    // 这一面同时验两个键，是因为它们在同一个组件里由同一次 useCaseDomain 取。
    //
    // 【为什么传 demo】这两块底下还是演示数据，只在演示案件下渲染（见 CasePanel 抬头）。
    // 不传的形态是：这一面渲染出来的只有时间线，而下面两条断言在验一个不存在的字符串。
    name: '卷宗栏·图谱引言与诉求脚注',
    domainFrom: 'case',
    keys: ['graphIntro', 'claimsFootnote'],
    render: () => ssr(<CasePanel caseId={CASE_ID} demo actions={[]} />),
  },
  {
    // 卷宗栏时间线：登记入口上的动词 + 一条都还没有时那一段。
    // **用渲染面而不是整块 CasePanel**：取数在 effect 里，node 环境跑不了 effect，
    // 整块渲染出来的恒是骨架屏（events===null），那两句一句都不会出现。
    name: '卷宗栏·时间线空态与登记入口',
    domainFrom: 'case',
    keys: ['timelineAddLabel', 'timelineEmpty'],
    render: () =>
      ssr(
        <TimelineSection
          caseId={CASE_ID}
          events={[]}
          failure={null}
          canWrite
          onAdd={() => {}}
          onPickType={() => {}}
        />,
      ),
  },
  {
    // 关系图整页的引言首句。**用空图那一支渲染**：这一句在有图和没图两屏上是同一个
    // Header，空图那支不必造一整份图数据，而 Header 渲染不出来时下面的长度自检会红。
    name: '关系图·引言首句',
    domainFrom: 'case',
    keys: ['graphIntro'],
    render: () => ssr(<CompanyGraphView caseId={CASE_ID} graph={null} />),
  },
  {
    name: '设置页·一键接入话术',
    domainFrom: 'mine',
    keys: ['agentSetupOpening', 'agentSetupAbilities', 'agentSetupBoundary'],
    render: () => ssr(<SetupPrompt info={SETUP_URLS} apiKey="lw_test_key" />),
  },
];

beforeEach(() => {
  probe.domain = '';
  probe.asked = [];
  probe.askedMine = 0;
});

/** 这个键上，别的包写的是不是**另一句话**（同字面的键不算串味，如「说一句就行。」）。 */
function rivalPhrases(key: string, mineKey: string): string[] {
  const mine = DOMAINS[mineKey].copy.pages[key];
  return Object.entries(DOMAINS)
    .filter(([k]) => k !== mineKey)
    .map(([, pack]) => pack.copy.pages[key])
    .filter((phrase) => typeof phrase === 'string' && phrase !== mine);
}

describe.each(Object.keys(DOMAINS))('%s 的共用页', (key) => {
  for (const surface of SURFACES) {
    it(`${surface.name}：逐字说这个包的话（变异：把某一句写回页面里 → 红）`, () => {
      probe.domain = key;
      const html = surface.render();
      // 量具自检：渲染成空串时下面的 not.toContain 全都恒真
      expect(html.length, `${surface.name} 什么都没渲染出来，这一条在验空集`).toBeGreaterThan(50);
      for (const k of surface.keys) {
        const mine = DOMAINS[key].copy.pages[k];
        expect(mine, `${key} 的 copy.pages 缺键 ${k}`).toBeTruthy();
        expect(html, `${surface.name} 里没有 copy.pages.${k} 那句话`).toContain(mine);
      }
    });

    it(`${surface.name}：别的包**独有**的那几句一个字都不出现`, () => {
      probe.domain = key;
      const html = surface.render();
      for (const k of surface.keys) {
        for (const rival of rivalPhrases(k, key)) {
          expect(html, `${surface.name} 里混进了别的领域的 copy.pages.${k}`).not.toContain(rival);
        }
      }
    });
  }

  it('现问领域的那几页问的是**自己那个案子**（变异：把 useCaseDomain 的入参换成写死的 id → 红）', () => {
    probe.domain = key;
    for (const surface of SURFACES.filter((s) => s.domainFrom === 'case')) {
      probe.asked = [];
      surface.render();
      expect(probe.asked.length, `${surface.name} 压根没问过这个案子属于哪个领域`).toBeGreaterThan(
        0,
      );
      expect(
        [...new Set(probe.asked)],
        `${surface.name} 问的不是本页那个案子（问的是 ${probe.asked.join('、')}）`,
      ).toEqual([CASE_ID]);
    }
  });

  it('驾驶舱不为这一句再问一次：领域随取数那一趟回来（多问一次 = 每次进页面多一条请求）', () => {
    probe.domain = key;
    probe.asked = [];
    ssr(<DashboardBody caseId={CASE_ID} data={dashboardData(key)} />);
    expect(probe.asked, '驾驶舱又去现问了一次领域，而 data.domain 里本来就有').toEqual([]);
  });

  it('设置页问的是「我名下最新那个案子」（那一屏不在案件路由下，没有 caseId 可问）', () => {
    probe.domain = key;
    ssr(<SetupPrompt info={SETUP_URLS} apiKey="lw_test_key" />);
    expect(probe.askedMine, '接入话术没问过领域，那它只能按缺省领域说话').toBeGreaterThan(0);
    expect(probe.asked, '设置页不该拿某一个案子的 id 去问').toEqual([]);
  });
});

describe('这份判据自己的完整性', () => {
  it('copy.pages 的每一个键都有一处渲染面在验（新加一句没人验 → 红）', () => {
    const covered = new Set(SURFACES.flatMap((s) => s.keys));
    for (const [key, pack] of Object.entries(DOMAINS)) {
      const uncovered = Object.keys(pack.copy.pages).filter((k) => !covered.has(k));
      expect(
        uncovered,
        `${key} 的 copy.pages 里这几个键没有任何渲染面在验：${uncovered.join('、')}\n` +
          '缺什么：这几句话搬进了领域包，却没有一条判据看着它们真的印在了页面上。\n' +
          '为什么缺：包里改一句、页面照旧读旧键，两边都不会报错。\n' +
          '怎么办：把用到它的那一面加进 SURFACES，或者这个键已经没人用了就从包里删掉。',
      ).toEqual([]);
    }
  });

  it('两个包在这几个键上确实各说各的（都抄成同一句 = "按领域说话"名存实亡）', () => {
    const keys = Object.keys(DOMAINS);
    expect(keys.length, '注册表里只有一个包，本文件全部条目恒真').toBeGreaterThan(1);
    const differing = Object.keys(DOMAINS[keys[0]].copy.pages).filter(
      (k) => new Set(keys.map((x) => DOMAINS[x].copy.pages[k])).size > 1,
    );
    // 「说一句就行。」这类两个包本来就同字面的键允许存在，但不许**全部**都一样
    expect(differing.length, '两个包的 copy.pages 一字不差，那这一层没有在按领域换').toBeGreaterThan(
      4,
    );
  });
});
