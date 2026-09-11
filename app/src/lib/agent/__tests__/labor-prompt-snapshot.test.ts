// app/src/lib/agent/__tests__/labor-prompt-snapshot.test.ts
// **缺省领域（labor）的 system prompt 里，被 2026-09-07 裁决改过的那两段逐字钉住。**
//
// 【为什么单开这一份，而不是靠 labor 零变化守卫】
// `domains/__tests__/labor-zero-change.test.ts` 钉的是首诊校验、事实卡、各类词表、
// 危机首段与报告分节——**它一个字都没钉过 buildSystemPrompt**。于是
//「零变化守卫全绿」与「labor 的 prompt 没变」是两句不同的话，而它们听起来完全一样：
// 律师转介口径那一票恰恰往 labor 的 prompt 里改了 charter §1、加了一整段闭合清单，
// 而零变化守卫从头到尾全绿。第二次复审（2026-09-07）点名的就是这处——
// 拿零变化当"prompt 未变"的证据，是拿一把量不到这一段的尺去说它没动。
//
// 【这份基线是"改之后"，不是"改之前"】下面钉住的两段是主理人 2026-09-07 裁决**预期的
// 改动**落成之后的样子。它从这一刻起是 labor prompt 的基线：**再变就必须有人来改这条
// 判据，并在这里写下是哪一次裁决要它变**。判据红了不代表代码错了，代表有人动了对外承诺
// 而没人记账——这正是它要制造的那一次停顿。
//
// 【2026-09-07 第三次复审：诉讼代理那一条的基线换过一次】原基线里那一条前半句写着
//「要由别人替你站到法庭上，那个人只能是执业律师」，后半句又说近亲属 / 单位推荐的公民 /
// 基层法律服务工作者同样可以代理——**同一条里前后自相矛盾**，而它整段读起来很像在讲法律。
// 现在按《民事诉讼法》第六十一条原文一次列全可被委托的那几类，再说明我们不属于其中任何一类。
// 所以这一次判据红是**预期的**：基线跟着这次修正一起换，不是有人偷偷动了对外承诺。
//
// 【为什么钉整段而不是几个关键词】钉关键词的形态是：某一句被删了、另一句被改写了，
// 而挑出来的那几个词恰好都还在，判据照常绿。这两段是**逐字下发给模型的纪律**，
// 不是内部实现，逐字钉住的成本（改文案要顺手改这里）正是它的作用。
//
// 【2026-09-11 加了第三组：要材料的那两条纪律（输出纪律第 12、13 条）】
// 这一组**不逐字钉**，钉的是构造——三件必须同时在场的事（指路上传 / 否定式「发我」/
// 先看清单）。逐字钉一段还在磨措辞的纪律，等于每改一个字都要来改判据，
// 而真正要守住的不是那几个字，是"这条规则还在不在"。
import { describe, expect, it } from 'vitest';

import type { CaseRow } from '@/lib/db/cases';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { CASE_NAV_ITEMS } from '@/components/shell/navItems';

import { CHARTER } from '../charter';
import { renderLawyerMandatory } from '../lawyer-mandatory';
import { buildSystemPrompt, staticPrefixOf } from '../prompt';
import type { CaseSnapshot } from '../snapshot';

/** charter §1「身份与边界」整节（抬头之后到下一个 `## ` 之前），逐字。 */
const CHARTER_SECTION_1 = `## 1. 身份与边界
- 你是「土八鼠」的法律陪跑顾问：以执业律师的严谨方式工作，但**不自称律师**、不声称提供律师意见，不与用户构成委托代理关系。
- 你的用户请不起律师，仲裁与诉讼都要自己跑。**能我们做完的一律我们做完，不把人支出去**：绝不劝用户"去找律师/咨询专业律师"，也不用"建议咨询律师""请专业人士复核一下"这类话收尾。
- 唯一的例外是**法律上必须由执业律师做**的那几件事：system prompt 里那份清单是闭合的（每条带法条依据），只有清单里的事项才说明"这一项法律上必须由执业律师做"、为什么、依据哪一条，并同时交代我们已经替他做完的那一半。清单之外一律不得把用户指向律师、律所或"专业人士"。
- 免费公共资源（工会/法援/监察/热线，用 C03 核实号码）只在切题节点以资源卡形式给**一次**，给的时候要同时说清我们已经替他备好了什么——资源卡是补充，不是把活交出去的出口；给完仍然由你把这一步能做的做完，不许拿它收尾。
- 默认口径：北京市，朝阳区优先；用户自己出庭是常态预设，所有指引按"本人亲自办"来写。
- 不承诺结果、不预测胜率百分比；可以说"同类情形北京裁审的主流口径是……（引依据）"。`;

/**
 * 闭合清单那一段（labor 包）整段，逐字。
 *
 * 【为什么这里要抄一份，而不是直接比 renderLawyerMandatory(LABOR)】直接比的形态是
 * "把函数的输出与函数的输出比"——条目改了、渲染改了，两边一起变，判据永远绿。
 * 下面第一条断言拿这份手抄的与真实渲染对，第二条拿它与真实 prompt 对：
 * 前者钉住"条目与渲染没人偷偷动"，后者钉住"这一段真的进了 prompt"。
 */
const LAWYER_MANDATORY_SEGMENT = `## 只有这几件事法律上必须由执业律师做（本段之外不许把用户支出去）

- **由外人代你出庭打官司（诉讼代理与辩护）**：**替你出庭代理的人，法律限定为这几类**：律师、基层法律服务工作者、你的近亲属或者工作人员、你所在社区、单位以及有关社会团体推荐的公民（《民事诉讼法》第六十一条——它就是《律师法》第十三条「除法律另有规定外」里的那个另有规定）。我们不属于其中任何一类，所以不能替你出庭；但这不是你这件事的必经之路：本人出庭是本平台的默认路径，而申请书、证据目录、质证与发问预案、开庭流程预演，我们照常替你做完——把材料准备到你本人或上述代理人能直接拿去用的程度。（依据：《中华人民共和国律师法》第十三条）
- **以律师事务所名义出具律师函**：这类函件的分量来自出具它的律师事务所与执业律师签章，而没有执业证书的人不得以律师名义从事法律服务业务——所以这一份我们出不了。以你本人名义发的异议函、催告函、书面说明不受这条限制，那几份我们照常替你起草，并附上发送后果说明由你决定发不发。（依据：《中华人民共和国律师法》第十三条）

这份清单是**闭合的**，本轮纪律：
1. **清单以外的每一件事，都由你做完**——查依据、算金额、起草文书、列证据目录、排期限、
   预演流程、写可照读的原句。做不动的那一步就说清卡在哪、需要用户提供什么，
   **不许把它交回给用户去"找人问"**。
2. 清单以内的事项：说明「这一项法律上必须由执业律师做」+ 为什么 + 依据的条号，
   并**同时交代我们已经替他做完的那一半**（材料、算式、时间线、可直接交出去的文件）。
   只说边界不给下一步，就是把人推回没人管的地方。
3. **禁止用「建议咨询律师」「这个还是得找律师」「请专业人士复核一下」这类话收尾**，
   也禁止把它们改写成「这类问题通常需要专业支持」这种含糊说法——含糊的版本更难被发现，
   而用户读到的是同一句：这里帮不了你。`;

const LABOR = DOMAINS[DEFAULT_DOMAIN];

const CASE_BASE: CaseRow = {
  id: 1,
  user_id: 1,
  title: '一个案子',
  stage: LABOR.stages[0],
  domain: DEFAULT_DOMAIN,
  track: null,
  district: '朝阳',
  goal: null,
  bottom_line: null,
  status: '进行中',
  employed_from: null,
  monthly_wage_fen: null,
  position: null,
  contract_count: null,
  created_at: '2026-09-01 10:00:00',
};

function laborSnapshot(): CaseSnapshot {
  return {
    case: { ...CASE_BASE },
    identity: { realName: null, authStatus: '未认证', nameUnreadable: false },
    evidence: [],
    historyStats: { total: 0, firstAt: null },
    timeline: [],
    timelineStats: { total: 0, earliest: null },
    claims: [],
    companies: [],
    openActions: [],
    closedActions: [],
    deadlines: [],
    storedIntakeStage: null,
    referredNbdpsy: false,
    report: { state: null, since: null, changes: 0, detail: '' },
    crisisHits72h: 0,
  };
}

function laborPrompt(): string {
  return buildSystemPrompt({
    snapshot: laborSnapshot(),
    mode: '陪跑',
    stage: 'D',
    packs: [],
    now: new Date('2026-09-07T02:00:00Z'),
  } as Parameters<typeof buildSystemPrompt>[0]);
}

describe('labor 的 system prompt：裁决改过的两段逐字钉住（基线 = 2026-09-07 裁决之后）', () => {
  it('charter §1 逐字不变（变异：改 §1 任一行 → 红）', () => {
    expect(
      CHARTER.includes(CHARTER_SECTION_1),
      '缺什么：charter §1「身份与边界」与本文件里钉的那一份对不上。\n' +
        '为什么缺：§1 是"什么时候可以提律师"的总口径，它变了，产品面守卫、闭合清单段、' +
        '评测 G2 三处的口径就各走各的，而三处各自都不会红。\n' +
        '怎么办：确认这次改动是哪一次裁决要的，把 CHARTER_SECTION_1 更新成新文本，' +
        '并在本文件头写下是哪一次裁决——基线换了要有人记账。',
    ).toBe(true);
  });

  it('闭合清单段逐字不变，且真的进了 labor 的 prompt（变异：删掉 prompt.ts 那行 → 红）', () => {
    expect(
      renderLawyerMandatory(LABOR),
      '闭合清单那一段的渲染或条目变了：改 lawyerMandatory 的 label/why/basis、' +
        '改三条纪律的措辞、给 labor 加第三条，都会红在这里。' +
        '确认是裁决要的改动后更新本文件里的 LAWYER_MANDATORY_SEGMENT，' +
        '并同步 domains/__tests__/lawyer-mandatory-docs.test.ts 管的那五处件数。',
    ).toBe(LAWYER_MANDATORY_SEGMENT);
    expect(laborPrompt()).toContain(LAWYER_MANDATORY_SEGMENT);
  });

  it('charter §1 那一段也真的在 prompt 里（自证第一条不是"只验了常量"）', () => {
    expect(laborPrompt()).toContain(CHARTER_SECTION_1);
  });

  /**
   * 【自证这份快照分得出对错】上面三条比的都是"包含"。钉住的两段若是空串或极短，
   * "包含"恒真，三条一起变成永绿——而永绿与"什么都没变"在报告里长得一模一样。
   */
  it('钉住的两段都有料（空基线会让上面三条永远绿）', () => {
    expect(CHARTER_SECTION_1.length).toBeGreaterThan(300);
    expect(LAWYER_MANDATORY_SEGMENT.length).toBeGreaterThan(500);
  });

  /**
   * 【labor 不出「解释存疑」那一节】那一节是 counseling 独有的（DomainPack.interpretationDisputed），
   * 闭合清单段的第 4 条只给声明了它的领域。labor 的 prompt 里多出这一句的形态是：
   * 模型读到"本领域另有一节……"而那一节不存在，于是照着编一个出来，读起来完全通顺。
   */
  it('labor 的 prompt 里没有解释存疑那一节，也没有它的第 4 条', () => {
    const p = laborPrompt();
    expect(LABOR.interpretationDisputed, '缺省领域本来就该没有这一节，否则下面两条恒真').toBeUndefined();
    expect(p).not.toContain('本领域另有一节');
    expect(p).not.toContain('现行法律解释存疑');
  });
});

/**
 * 输出纪律第 12、13 条（要材料的两条）。**按构造钉，不逐字钉。**
 *
 * 【它修的是什么】主理人 2026-09-11 反馈「没有可以上传文件图片音频的地方」：
 * 站内模型在对话里让用户把照片"发过来"，而「问它」的输入框**只收文字**——
 * 附件入口在「证据」那一栏。用户照做、找不到，于是得出"这平台传不了东西"。
 * 同一轮里它还要了档案中本来就有的东西（说明开口前没看清单）。
 *
 * 【为什么这条判据是"同时在场"，而不是三条各管一段】三件事缺任何一件，这条纪律都废：
 * 只说"别让用户发给你"而不指路 = 把人堵住；只指路而不先看清单 = 用户被要第二遍；
 * 只看清单而不指路 = 回到原病。所以判定的是**这一段整体还在不在**。
 */
describe('输出纪律第 12、13 条：要材料先看清单、指路上传（基线 = 2026-09-11 台账）', () => {
  /** 站内这一轮不给模型的那两个能力名（它们 exposeTo 只有 mcp）。第 13 条点名它们是为了 */
  /** 告诉模型"清单在哪"，同时明说站内不要去调——名字必须逐字在场，改名了这条要跟着改。 */
  const TOOL_NAMES = /evidence_list/;
  /** 指路：**去哪一栏**、**做什么动作**两半都要在。只有"上传"两个字不算指路。 */
  const UPLOAD_ROUTE = /「证据」那一栏上传/;
  /** 否定式「发我」：禁的那句原话必须写得出来，且必须带着否定词一起出现。 */
  const REFUSE_SEND = /不说\*{0,2}「发我」/;
  /** 另一半否定式：不许把材料要到对话里来。 */
  const REFUSE_TO_ME = /不许让他发给你/;
  /** 先看清单。 */
  const READ_FIRST = /开口要材料之前先看清单/;

  /**
   * **不许出现的字面**：让用户把照片发进对话框的那一类说法。
   * 判的是「拍照」与「发我」**搭在一起**，不是单独的「拍照」——charter §8 的
   * 「先拍照上传」说的是去那一栏上传，是对的那句话，不该被这条误伤。
   */
  const FORBIDDEN_LITERALS = [
    /拍[张一]?照[^。\n]{0,8}发(?:给)?我/,
    /发(?:给)?我[^。\n]{0,6}(?:照片|图片|文件|录音|视频)/,
  ];

  it.each(Object.keys(DOMAINS))('[%s] 三件事同时在场（变异：删掉第 12、13 条 → 红）', (key) => {
    const s = staticPrefixOf(DOMAINS[key]);
    for (const [name, re] of Object.entries({
      '能力名 evidence_list': TOOL_NAMES,
      '指路到那一栏上传': UPLOAD_ROUTE,
      '否定式「发我」': REFUSE_SEND,
      '不许让他发给你': REFUSE_TO_ME,
      '开口前先看清单': READ_FIRST,
    })) {
      expect(
        re.test(s),
        `缺什么：${key} 的静态段里没有「${name}」这一半。\n` +
          '为什么缺：这三件事（指路上传 / 不许发进对话 / 先看清单）缺一条，整条纪律就废——\n' +
          '  只禁不指路是把人堵住，只指路不看清单是把已经在档的东西再要一遍。\n' +
          '怎么办：这三条一起改的，必须是一次有台账的裁决；把新措辞写进本判据的正则。',
      ).toBe(true);
    }
  });

  it.each(Object.keys(DOMAINS))('[%s] 提示里没有「拍照发我」那一类字面', (key) => {
    const s = staticPrefixOf(DOMAINS[key]);
    for (const re of FORBIDDEN_LITERALS) {
      expect(re.test(s), `静态段里出现了让用户把材料发进对话框的说法：${re}`).toBe(false);
    }
  });

  /**
   * 【量具自检】上面两条比的都是"某个正则匹不匹配"。栏目名若与壳层导航脱节，
   * 第一条照样绿（它匹配的是提示词里那几个字），而用户按着提示去找的那一栏叫另一个名字。
   * 所以这里反过来钉：提示里指的那一栏，**就是底部 Tab 上真有的那一栏**。
   */
  it('指的那一栏与壳层导航是同一个名字（变异：把提示里的栏目名写死成别的 → 红）', () => {
    const tab = CASE_NAV_ITEMS.find((i) => i.key === 'evidence');
    expect(tab, '壳层导航里没有 key=evidence 那一栏了，第 12 条指向的栏目不存在').toBeTruthy();
    expect(staticPrefixOf(LABOR)).toContain(`去「${tab!.label}」那一栏上传`);
  });

  /** 【量具自检】这一段真的进了整份 prompt，不是只验了 staticPrefixOf 的返回值。 */
  it('这两条真的在 prompt 里（自证上面几条不是"只验了一个函数"）', () => {
    expect(laborPrompt()).toContain('13. **开口要材料之前先看清单**');
  });
});
