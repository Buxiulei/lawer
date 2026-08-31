/**
 * 档案呈现的诚实守卫（工单 C 的 C1–C7 判据）。
 *
 * 这组测试的共同形状是**断言界面拒绝显示什么**。理由：这一块所有的错误
 * 都不是"显示坏了"，而是"显示得太自信"——一个没有样本量的百分数、
 * 一条没有出处的套路、一句给没核实过的辖区用的通用话术，
 * 都会照常渲染、照常好看，然后被用户拿去决定告谁、要多少钱。
 *
 * 每条测试的注释里写着它对应的变异臂（把哪一行改坏它就该变红）。
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ discreet: false }));

vi.mock('@/app/_ui/discreet', () => ({
  useDiscreet: () => ({ discreet: state.discreet, setDiscreet: () => {}, toggle: () => {} }),
}));
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

import type {
  DossierPattern,
  DossierView,
  DurationStats,
  OutcomeStats,
  VenueSection,
} from '@/lib/dossier/contract';
import { VENUE_NOT_COVERED } from '@/lib/dossier/present';
import { venueSection } from '@/lib/dossier/venue';
import { mockDossier } from '@/app/_mock/company-dossier';
import { DossierBody } from '../DossierBody';
import { OutcomeCard, DurationCards } from '../StatsSection';
import { PatternSection } from '../PatternSection';
import { VenueCards } from '../VenueCards';

const ssr = (node: React.ReactNode) => renderToStaticMarkup(<>{node}</>);

/** 只取可见文字，把标签与属性剔掉——断言「屏幕上有没有百分号」不该被 class 名影响。 */
function visibleText(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/**
 * 取出**不在被 `isCut` 认出的那种子树里**的可见文字。
 * 用来问两种问题：「不点开折叠块能读到什么」「没被打码的还剩什么」。
 *
 * 用配对标签整棵子树剔除，不用正则一把梭：非贪婪匹配会停在第一个闭合标签上，
 * 遇到嵌套会少剔一截，于是守卫看起来在守、其实漏（同 dashboard-discreet 那条教训）。
 */
function textOutside(html: string, isCut: (tagName: string, rawTag: string) => boolean): string {
  const tokens = html.split(/(<[^>]+>)/);
  const out: string[] = [];
  const stack: string[] = [];
  let skipDepth = 0;
  const VOID = new Set(['img', 'br', 'hr', 'input', 'meta', 'link']);

  for (const tok of tokens) {
    if (!tok) continue;
    if (!tok.startsWith('<')) {
      if (skipDepth === 0) out.push(tok);
      continue;
    }
    const closing = tok.startsWith('</');
    const name = (tok.match(/^<\/?([a-zA-Z0-9]+)/)?.[1] ?? '').toLowerCase();
    if (closing) {
      stack.pop();
      if (skipDepth > 0 && stack.length < skipDepth) skipDepth = 0;
      continue;
    }
    if (tok.endsWith('/>') || VOID.has(name)) continue;
    stack.push(name);
    if (skipDepth === 0 && isCut(name, tok)) skipDepth = stack.length;
  }
  return out.join('');
}

const textOutsideDetails = (html: string) => textOutside(html, (name) => name === 'details');
/** 剔掉所有打码子树后剩下的清晰文字 */
const unmaskedText = (html: string) =>
  textOutside(html, (_n, tag) => /discreet-blur/.test(tag));

const AS_OF = '2026-08-20T00:00:00.000Z';
const SOURCE = '裁判文书网·人机接力取证';

function outcome(over: Partial<OutcomeStats> = {}): OutcomeStats {
  return {
    docsTotal: 41,
    docsFulltext: 17,
    docsOutcomeDecided: 12,
    workerFavorableN: 7,
    minSample: 5,
    // 三档的分母是入档全集（docsTotal 41），不是可判定的 12：8 + 4 + 29 = 41
    byApplicant: { worker: 8, employer: 4, unknown: 29 },
    sampleN: 12,
    asOf: AS_OF,
    source: SOURCE,
    ...over,
  };
}

/* ── C1 三件套缺一不渲染数字 ───────────────────────────── */

describe('C1 三件套（样本量/截止日/来源）缺一 ⇒ 不出数字', () => {
  /**
   * 变异臂：把 OutcomeCard 里的 `if (!hasProvenance(stats))` 去掉
   * （或把 hasProvenance 改成恒 true），这条会红——界面会印出一个
   * 谁也说不出可信度的 58%。
   */
  it('缺 as_of ⇒ 出样本不足态，整块搜不到任何百分号', () => {
    const html = ssr(<OutcomeCard stats={outcome({ asOf: null })} />);
    expect(visibleText(html)).not.toContain('%');
    expect(html).toContain('出不了这个数');
    expect(html).toContain('采集截止日');
  });

  it('缺 source、缺 sampleN 同样不出数字，且说清缺的是哪一项', () => {
    expect(visibleText(ssr(<OutcomeCard stats={outcome({ source: null })} />))).not.toContain('%');
    expect(ssr(<OutcomeCard stats={outcome({ source: null })} />)).toContain('来源');

    expect(visibleText(ssr(<OutcomeCard stats={outcome({ sampleN: null })} />))).not.toContain('%');
    expect(ssr(<OutcomeCard stats={outcome({ sampleN: null })} />)).toContain('样本量');
  });

  /**
   * `sampleN === 0` 是**齐的**，不是缺的。
   * 变异臂：把 hasProvenance 里的 `p.sampleN !== null` 写成 `!!p.sampleN`，这条会红——
   * 那会让「我们查了，一条都没有」和「我们没查」在界面上长成同一个样子。
   */
  it('样本量为 0 算「有这项」，走的是样本不足而不是缺元数据', () => {
    const html = ssr(
      <OutcomeCard stats={outcome({ sampleN: 0, docsOutcomeDecided: 0, docsTotal: 0, docsFulltext: 0 })} />,
    );
    expect(html).not.toContain('这张卡缺');
    expect(html).toContain('样本不足：已入档 0 条');
  });

  it('三件套齐且样本够时才出百分数，并把三件套一起摆出来', () => {
    const html = ssr(<OutcomeCard stats={outcome()} />);
    expect(visibleText(html)).toContain('58%'); // 7/12
    expect(html).toContain('样本');
    expect(html).toContain(SOURCE);
  });
});

/* ── C2 样本不足的那一整句 ─────────────────────────────── */

describe('C2 样本不足时出完整的那一句（四个数都在）', () => {
  it('可判定 3 篇 < 门槛 5 ⇒ 出全句，且不出比例', () => {
    const html = ssr(
      <OutcomeCard stats={outcome({ docsTotal: 41, docsFulltext: 9, docsOutcomeDecided: 3 })} />,
    );
    expect(visibleText(html)).toContain(
      '样本不足：已入档 41 条，其中取到全文 9 篇、可判定结果 3 篇，不足 5 篇不出比例',
    );
    expect(visibleText(html)).not.toContain('%');
  });

  /**
   * 门槛来自 pricing_config，**界面不许写死 5**。
   * 变异臂：把 canShowOutcomeRatio 里的 `s.minSample` 换成字面量 5，这条会红。
   */
  it('门槛跟着数据走：门槛 8 时，可判定 6 篇照样不出比例', () => {
    const html = ssr(<OutcomeCard stats={outcome({ docsOutcomeDecided: 6, minSample: 8 })} />);
    expect(visibleText(html)).not.toContain('%');
    expect(visibleText(html)).toContain('不足 8 篇不出比例');
  });

  it('门槛调低到 3 时，可判定 3 篇就出比例（说明门槛真的在起作用）', () => {
    const html = ssr(
      <OutcomeCard stats={outcome({ docsOutcomeDecided: 3, workerFavorableN: 3, minSample: 3 })} />,
    );
    expect(visibleText(html)).toContain('100%');
  });

  /** 申请人方分布必须与比例同屏：不区分谁告谁的比率会把方向读反。 */
  it('出比例时，申请人方分布同屏并列', () => {
    const text = visibleText(ssr(<OutcomeCard stats={outcome()} />));
    expect(text).toContain('劳动者提起 8 件');
    expect(text).toContain('单位提起 4 件');
  });

  /**
   * 申请人三档是在**全部入档行**上数的（lib/company/stats），所以那句话的分母
   * 必须是入档数，且屏幕上三个数要加得起来。
   *
   * 变异臂：把 StatsSection 那句的分母改回 `stats.docsOutcomeDecided`（「这 12 篇里」），
   * 这条会红——8 + 4 + 29 = 41，摆在 12 后面就是一道谁都算不平的算术题，
   * 而它照常渲染、照常好看。
   */
  it('申请人三档的分母是入档数，且三个数加得起来', () => {
    const stats = outcome();
    const text = visibleText(ssr(<OutcomeCard stats={stats} />));
    expect(text).toContain('已入档的 41 篇里');
    expect(text).toContain('看不出是谁提起的 29 件');
    const { worker, employer, unknown } = stats.byApplicant;
    expect(worker + employer + unknown).toBe(stats.docsTotal);
    // 借上面那个可判定分母的写法一律不许再出现
    expect(text).not.toContain('这 12 篇里');
  });

  /**
   * 两块统计**同屏、各标各的样本量口径**：胜率那段说「可判定结果的 12 篇里」，
   * 三件套页脚也跟着可判定数走；申请人那段说「已入档的 41 篇里」。
   * 变异臂：把胜率块的分母也换成入档数（`workerFavorableN / docsTotal`），这条会红——
   * 58% 会变成 17%，一个"劳动者赢面很小"的数，而它照常渲染、照常带着三件套。
   */
  it('胜率块仍按可判定子集，两个分母各自写在自己那句话里', () => {
    const text = visibleText(ssr(<OutcomeCard stats={outcome()} />));
    expect(text).toContain('58%'); // 7/12，不是 7/41
    expect(text).toContain('可判定结果的 12 篇里');
    expect(text).toContain('已入档的 41 篇里');
    expect(text).toContain('样本 12 篇');
  });
});

/* ── 时长四段各自独立 ─────────────────────────────────── */

describe('时长四段各自独立，且没有「平均时长」这种合成数', () => {
  const duration: DurationStats = {
    minSample: 5,
    segments: [
      { key: 'arbitration', n: 8, medianDays: 58, sampleN: 8, asOf: AS_OF, source: SOURCE },
      { key: 'firstInstance', n: 6, medianDays: 104, sampleN: 6, asOf: AS_OF, source: SOURCE },
      { key: 'secondInstance', n: 2, medianDays: null, sampleN: 2, asOf: AS_OF, source: SOURCE },
      { key: 'execution', n: 5, medianDays: 33, sampleN: 5, asOf: AS_OF, source: SOURCE },
    ],
  };

  /**
   * 变异臂：把 canShowSegment 里的 `seg.n >= minSample` 去掉，这条会红。
   * 一段不足牵连全表，等于让最难取到的那一段决定了其它三段说不说话。
   */
  it('二审段样本不足 ⇒ 只有那一段不出数，其它三段照常出', () => {
    const text = visibleText(ssr(<DurationCards stats={duration} />));
    expect(text).toContain('58');
    expect(text).toContain('104');
    expect(text).toContain('33');
    expect(text).toContain('样本不足：这一段只有 2 篇载明日期的文书，不足 5 篇不出中位数');
  });

  /**
   * **样本不足但中位数算得出来**，是这里最危险的一种输入：
   * 统计层拿 2 篇文书照样能算出一个中位数，界面若只看「有没有值」就会把它印出来。
   * 上一条测不到这个——它那一段的 medianDays 恰好是 null，
   * 于是「按 n 判」和「按有没有值判」在那份数据上表现一模一样（我把 seg.n 那半边
   * 去掉跑过，上一条仍绿）。这一条专门把两者分开。
   */
  it('n 不够但中位数算得出来时，照样不出数字', () => {
    const risky: DurationStats = {
      minSample: 5,
      segments: [
        { key: 'secondInstance', n: 2, medianDays: 211, sampleN: 2, asOf: AS_OF, source: SOURCE },
      ],
    };
    const text = visibleText(ssr(<DurationCards stats={risky} />));
    expect(text).not.toContain('211');
    expect(text).toContain('样本不足：这一段只有 2 篇载明日期的文书，不足 5 篇不出中位数');
  });

  it('四段标题都在，且界面上没有「平均」这种合成口径', () => {
    const text = visibleText(ssr(<DurationCards stats={duration} />));
    for (const label of ['仲裁受理→裁决', '一审立案→判决', '二审立案→判决', '判决生效→执行立案']) {
      expect(text).toContain(label);
    }
    expect(text).not.toContain('平均');
  });

  /** 契约层的结构守卫：形状里就不该有这个键，不然迟早有人渲染它。 */
  it('契约与 mock 里都没有任何 avg/average/平均 字段', () => {
    const json = JSON.stringify(mockDossier);
    expect(json).not.toMatch(/avg|average/i);
    expect(json).not.toContain('平均');
  });
});

/* ── C3 没有出处的套路渲染不出来 ───────────────────────── */

describe('C3 没有 evidence 的 pattern 不出现在 DOM', () => {
  const withEvidence: DossierPattern = {
    id: 'p1',
    pattern: '解除理由写两个都不举证',
    evidence: [{ caseNo: '（示例）京0X民初1号', quote: '未提交证据证明', docUrl: null }],
    model: 'm',
    generatedAt: AS_OF,
  };
  const noEvidence: DossierPattern = {
    id: 'p2',
    pattern: '这条是模型编的，没有任何案号支撑',
    evidence: [],
    model: 'm',
    generatedAt: AS_OF,
  };

  /**
   * 变异臂：把 PatternSection 里的 `.filter((p) => p.evidence.length > 0)` 去掉，这条会红。
   * 后端已经拦过一道，这里是第二道——两道拦的是不同的失败：
   * 后端拦模型编造，这里拦接口哪天松了口径。
   */
  it('无出处的那条整条不渲染，有出处的照常渲染', () => {
    const html = ssr(<PatternSection patterns={[withEvidence, noEvidence]} dropped={0} />);
    expect(html).toContain('解除理由写两个都不举证');
    expect(html).not.toContain('这条是模型编的');
  });

  it('每条套路下面都带着案号与逐字引文', () => {
    const text = visibleText(ssr(<PatternSection patterns={[withEvidence]} dropped={0} />));
    expect(text).toContain('（示例）京0X民初1号');
    expect(text).toContain('未提交证据证明');
  });

  /** 丢弃计数是编造率唯一的体温计，藏起来等于没有这条红线。 */
  it('被丢弃的条数在界面上看得见', () => {
    const text = visibleText(ssr(<PatternSection patterns={[withEvidence]} dropped={3} />));
    expect(text).toContain('3');
    expect(text).toContain('丢弃');
  });
});

/* ── C4 未覆盖的仲裁地只出那一句 ───────────────────────── */

describe('C4 非北京朝阳只出「暂不覆盖」，不出任何风格描述', () => {
  const uncovered: VenueSection = { venue: '上海浦东', covered: false, cards: [] };
  const covered: VenueSection = {
    venue: '北京朝阳',
    covered: true,
    cards: [
      {
        id: 'sop-chaoyang-lian-sop',
        title: '朝阳区仲裁立案 SOP',
        body: '## 一、去之前先确认的坐标\n地址：将台路 5 号院',
        sources: ['http://www.bjchy.gov.cn/x'],
        confidence: '待核实',
        updated: '2026-08-19',
      },
    ],
  };

  /**
   * 变异臂：在 VenueCards 的 `!covered` 分支里塞一段通用话术
   *（"各地仲裁流程大同小异，一般需要……"），这条会红。
   * 那种句子读起来像内容，实际是没核实过的辖区在冒充核实过的辖区。
   */
  it('未覆盖时**只有**那一句，没有任何别的正文', () => {
    const text = visibleText(ssr(<VenueCards section={uncovered} />)).trim();
    expect(text).toBe(VENUE_NOT_COVERED);
  });

  it('覆盖时出原文与可信度、更新日、来源', () => {
    const html = ssr(<VenueCards section={covered} />);
    expect(html).toContain('朝阳区仲裁立案 SOP');
    expect(html).toContain('将台路 5 号院');
    expect(html).toContain('待核实');
    expect(html).toContain('2026-08-19');
    expect(html).toContain('http://www.bjchy.gov.cn/x');
  });

  /**
   * 上面那条喂的是**手写的**卡，出处是测试自己编的一串；它证明的只是
   * 「给了 sources 就会渲染」。真链路上 sources 恒空了很久，这条测试全程绿着——
   * 这正是「判据与被判的东西并存」的形态。
   *
   * 所以这条从**真索引**走一遍：knowledge/index.json → lib/knowledge → venueSection →
   * VenueCards，断言屏幕上真的出现了一条官方来源。
   * 变异臂：把 venue.cardOf 的 `sources: hit.sources` 改回 `sources: []`，这条会红。
   */
  it('真索引走一遍：朝阳这一节在屏幕上摆得出官方来源', () => {
    const html = ssr(<VenueCards section={venueSection('北京朝阳')} />);
    expect(html).toContain('http://www.bjchy.gov.cn/');
    const text = visibleText(html);
    expect(text).toContain('bjchy.gov.cn');
  });
});

/* ── C6 低调模式：公司名不进标题 ───────────────────────── */

describe('C6 低调模式下公司全名不出现在标题层', () => {
  const view: DossierView = { ...mockDossier, companyName: '星曜网络科技（北京）有限公司' };

  /**
   * 变异臂：把 DossierBody 的 h1 改成 `{dossier.companyName} 的档案`，这条会红。
   * 顶栏与标题是最容易被旁人瞥见的一条。
   */
  it('h1 里只有栏目名，没有公司名', () => {
    state.discreet = true;
    try {
      const html = ssr(<DossierBody caseId="demo" dossier={view} />);
      const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/)?.[1] ?? '';
      expect(visibleText(h1)).not.toContain('星曜');
      // 低调模式下连「公司档案」都换成中性词
      expect(visibleText(h1)).toContain('档案');
    } finally {
      state.discreet = false;
    }
  });

  /**
   * 断言的是「剔掉所有打码子树之后，清晰的那部分文字里没有公司名」——
   * 不是「公司名的直接父元素带打码 class」。后者会因为多包一层 `<p>` 就误报通过/失败，
   * 而真正要守的是"整棵子树在不在糊层里"。
   */
  it('剔掉打码块后，剩下的清晰文字里没有公司名', () => {
    state.discreet = true;
    try {
      const html = ssr(<DossierBody caseId="demo" dossier={view} />);
      expect(html).toContain('星曜网络科技（北京）有限公司'); // 确实渲染了
      expect(unmaskedText(html)).not.toContain('星曜');
    } finally {
      state.discreet = false;
    }
  });

  it('页面 metadata 的标题里没有公司名', async () => {
    const mod = await import('../../page');
    expect(mod.metadata.title).toBe('公司档案');
  });
});

/* ── C7 覆盖度声明同屏同级、不折叠 ─────────────────────── */

describe('C7 覆盖度声明与统计卡同屏同级，不是可折叠脚注', () => {
  /**
   * 变异臂：把 DossierBody 里那块覆盖度声明换成 `<details><summary>覆盖度</summary>…</details>`，
   * 这条会红——因为它就不在「不点开就能读到」的那份文字里了。
   */
  it('不点开任何折叠块就能读到覆盖度声明全文', () => {
    const html = ssr(<DossierBody caseId="demo" dossier={mockDossier} />);
    const plain = visibleText(textOutsideDetails(html));
    expect(plain).toContain(mockDossier.coverageNote);
  });

  it('覆盖度声明与统计卡在同一节里，且排在统计数字之前', () => {
    const html = ssr(<DossierBody caseId="demo" dossier={mockDossier} />);
    const noteAt = html.indexOf(mockDossier.coverageNote);
    const ratioAt = html.indexOf('劳动者全部或部分获支持的比例');
    expect(noteAt).toBeGreaterThan(-1);
    expect(ratioAt).toBeGreaterThan(-1);
    expect(noteAt).toBeLessThan(ratioAt);
  });

  it('覆盖度声明没有被 hidden 之类的属性藏起来', () => {
    const html = ssr(<DossierBody caseId="demo" dossier={mockDossier} />);
    const block = html.match(/<div[^>]*data-testid="coverage-note"[^>]*>/)?.[0] ?? '';
    expect(block).not.toContain('hidden');
    expect(block).not.toContain('aria-hidden="true"');
  });
});

/* ── 在职年限的诚实标注 ───────────────────────────────── */

describe('在职年限不参与统计这一句必须在页面上', () => {
  it('填了年限就写明它不影响公司数据', () => {
    const text = visibleText(ssr(<DossierBody caseId="demo" dossier={mockDossier} />));
    expect(text).toContain('不参与上面任何公司数据的计算');
  });
});
