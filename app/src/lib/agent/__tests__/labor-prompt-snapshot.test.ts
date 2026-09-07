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
// 【为什么钉整段而不是几个关键词】钉关键词的形态是：某一句被删了、另一句被改写了，
// 而挑出来的那几个词恰好都还在，判据照常绿。这两段是**逐字下发给模型的纪律**，
// 不是内部实现，逐字钉住的成本（改文案要顺手改这里）正是它的作用。
import { describe, expect, it } from 'vitest';

import type { CaseRow } from '@/lib/db/cases';
import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

import { CHARTER } from '../charter';
import { renderLawyerMandatory } from '../lawyer-mandatory';
import { buildSystemPrompt } from '../prompt';
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

- **由外人代你出庭打官司（诉讼代理与辩护）**：没有取得律师执业证书的人，除法律另有规定外不得从事诉讼代理或者辩护业务——所以要**由别人替你站到法庭上**，那个人只能是执业律师。但这不是你这件事的必经之路：本人出庭是本平台的默认路径，近亲属、你所在单位或者社会团体推荐的公民、或基层法律服务工作者同样可以代理（《民事诉讼法》第六十一条；基层法律服务工作者见该条第一项），而申请书、证据目录、质证与发问预案、开庭流程预演，我们照常替你做完。（依据：《中华人民共和国律师法》第十三条）
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
