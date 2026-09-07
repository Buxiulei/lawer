// app/src/lib/domains/__tests__/lawyer-mandatory-docs.test.ts
// **闭合清单在包之外的两条义务**：
//   ① 抄了"法律上只能由执业律师做的只有 N 件"的每一处，件数必须与领域包里那份清单对得上；
//   ② 诉讼代理那一条必须同时写出**非律师也能当代理人**的那几类（民诉法 §61），
//      否则这一条本身就在夸大律师的垄断范围——而它读起来完全像在讲法律。
//
// 【为什么要有这条】清单本身（DomainPack.lawyerMandatory）是给**我们自己的 agent**
// 下发的，逐轮由 lib/agent/lawyer-mandatory.ts 渲染；而用户的 agent 走 MCP/REST 接进来，
// 它读到的纪律在 skill/ 那几份说明书里——那几份是**手写区**，gen:docs 不管，
// 里面把件数与那两件事逐字抄了一遍。无工具模式（lib/paste/guide.ts）读不到清单，
// 同样把那两件抄了一份。
//
// 于是漏接的形态是：某个领域包将来加了第三条（比如公证类事项），
// system prompt 与评测按新清单走，而接入方手里那份仍然写着"只有两件"——
// 两边各自都是通顺的、`npm run gen:docs` 也只会报 unchanged，没有一处会红。
// 这条判据就是那个会喊出来的地方。
//
// 【为什么钉件数而不是逐条钉措辞】那几份文档是写给人读的，措辞本来就该各写各的
//（"由外人代你出庭打官司" / "由别人代他出庭打官司"）。逐字钉措辞的形态是：
// 判据逼着四份文档抄成同一句话，读起来像机器写的，而真正会漏的那件事（**多了一条**）
// 反而钉不住。件数是唯一一处"抄错了就一定是错的"的地方。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DOMAINS } from '../registry';

const REPO = path.resolve(__dirname, '../../../../../');

/**
 * 抄了这句话的五处。**它们的共同点是"手抄的第二份，清单改了不会跟着改"**：
 *   · skill/接入说明.md —— 接入方读的正本（手写区）；
 *   · skill/variants/claude-skill.md —— 它的 Claude 变体，由 gen:docs 整份生成，
 *     但内容来自正本的手写区，所以同样会跟着错；
 *   · skill/陪跑指南.md —— 用户的 agent 每轮读的那份纪律；
 *   · 律师函应对要点卡 —— 检索命中时直接进模型上下文的那张卡；
 *   · lib/paste/guide.ts —— **无工具模式**那份指南（第二次复审 2026-09-07 补进来的）。
 *     它是代码不是文档，但性质与上面四份一样：那条路径上的模型**读不到清单**，
 *     只有这一份，所以那两件事在这里是手抄的第二份。不把它绑进来的形态是：
 *     领域包加了第三条，上面四份被判据点名改了，而无工具模式仍然只说两件——
 *     它照常渲染、tsc 绿、没有一处会红。
 */
const DOCS = [
  'skill/接入说明.md',
  'skill/variants/claude-skill.md',
  'skill/陪跑指南.md',
  'knowledge/packs/counseling/templates/lvshihan-yingdui-yaodian.md',
  'app/src/lib/paste/guide.ts',
];

/** 件数 → 文档里写的那个字。只到十：超过十条时那几份文档本来就该重写，不该是这里凑数。 */
const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 四份文档共用的那半句话（各自的前半句不同，这半句是逐字相同的）。 */
const phrase = (n: number) => `只能由执业律师做的只有${CN[n]}件`;

describe('抄了"只有 N 件"的每一处都跟着 DomainPack.lawyerMandatory 走', () => {
  const counts = [...new Set(Object.values(DOMAINS).map((p) => p.lawyerMandatory.length))];

  /**
   * 【先问"还能不能只说一个数"】各领域件数不再一致时，那几份文档就不能再写死一个数了
   *（它们是跨领域的通用纪律）。这时该做的是把那句话改成按领域说，而不是挑一个数继续写。
   */
  it('各领域的件数一致（不一致时那句话本身就不能再写死一个数）', () => {
    expect(
      counts.length,
      `各领域的闭合清单条数不再一致（${Object.values(DOMAINS)
        .map((p) => `${p.key}:${p.lawyerMandatory.length}`)
        .join('，')}）。\n` +
        '缺什么：对外那几份文档里写着一个跨领域的固定件数。\n' +
        '为什么缺：件数原来各领域相同，那句话才写得下去。\n' +
        `怎么办：把 ${DOCS.join('、')} 里那句话改成按领域说，并把本判据改成逐领域比对。`,
    ).toBe(1);
    expect(counts[0], '清单空了：空清单会让下面几条恒真').toBeGreaterThan(0);
    expect(counts[0], `件数超过 ${CN.length - 1} 条，那几份文档该重写而不是在这里加字`).toBeLessThan(CN.length);
  });

  it.each(DOCS)('%s 里写的件数与清单一致（变异：给任一领域包加第三条 → 红）', (relPath) => {
    const text = fs.readFileSync(path.join(REPO, relPath), 'utf8');
    const want = phrase(counts[0]);
    expect(
      text.includes(want),
      `这一份里的件数与领域包对不上（清单现在是 ${counts[0]} 条，里面找不到「${want}」）。\n` +
        '为什么缺：清单在领域包里改了，而这一份是人手抄的第二份，gen:docs 只管标记之间那几段。\n' +
        `怎么办：把 ${relPath} 里那句话改成「${want}」，并把新增的那一条**是什么、依据哪条法**` +
        '一并补进去——只改数字不补事项，接入方读到的仍然是一份缺项的清单。',
    ).toBe(true);
  });

  /**
   * 【自证这条判据分得出对错】件数写成别的数时必须找不到。少了这条，
   * 上面那几条在"文档里恰好有一句形近的话"时会误绿。
   */
  it('件数写成别的数就对不上（否则上面那几条不是在比对，只是在碰运气）', () => {
    const other = counts[0] === 3 ? 4 : 3;
    for (const relPath of DOCS) {
      const text = fs.readFileSync(path.join(REPO, relPath), 'utf8');
      expect(text.includes(phrase(other)), `${relPath} 里同时写着两个件数`).toBe(false);
    }
  });
});

/**
 * **诉讼代理那一条不许把民诉法 §61 只念半句。**
 *
 * 【这一条拦的是什么】《律师法》第十三条说的是"没有律师执业证书的人不得从事诉讼代理业务"，
 * 而《民事诉讼法》第六十一条第（一）项把**基层法律服务工作者**与律师并列写进了可被委托的
 * 诉讼代理人，第（二）（三）项还列了近亲属、工作人员、社区/单位/社会团体推荐的公民。
 * 只念前半句的形态是：清单条目每个字都对得上一条法，读起来严谨，而它给用户的印象是
 *「要找人代理就只能花钱请律师」——**这正是主理人 2026-09-07 裁决要禁的那种把人支出去**，
 * 只是这一次是靠一句不完整的法律陈述做到的，比"建议咨询律师"更难被发现。
 *
 * 【为什么按 key 找而不按下标】条目顺序会变；下标点名会在插入一条之后指到另一条上。
 * 没有这个 key 的领域跳过（第三个行当未必有诉讼这一环），但至少得有一个领域有它——
 * 否则本条退化成空循环，而空循环与"每个领域都写全了"在报告里长得一模一样。
 */
describe('诉讼代理那一条同时给出非律师的代理途径（民诉法 §61）', () => {
  const withAgency = Object.values(DOMAINS)
    .map((p) => ({ key: p.key, item: p.lawyerMandatory.find((x) => x.key === 'litigation-agency') }))
    .filter((x): x is { key: string; item: NonNullable<typeof x.item> } => x.item !== undefined);

  it('至少一个领域有 litigation-agency 这一条（空循环会让下面几条永远绿）', () => {
    expect(withAgency.length).toBeGreaterThan(0);
  });

  it.each(withAgency.map((x) => [x.key, x.item] as const))(
    '%s：why 里写着基层法律服务工作者与它的条号（变异：删掉那半句 → 红）',
    (_key, item) => {
      const why = item.why;
      expect(
        why,
        '缺什么：这一条只说了"没有律师证不能做诉讼代理"，没说民诉法 §61 还允许谁做。\n' +
          '为什么缺：半句法律陈述读起来比整句更干脆，也更像在讲法律。\n' +
          '怎么办：把《民事诉讼法》第六十一条第一项的「基层法律服务工作者」补回 why，' +
          '并保留近亲属/工作人员/推荐的公民那几类——用户要的是"还有谁能替我出面"，' +
          '不是"你只能请律师"。',
      ).toContain('基层法律服务工作者');
      expect(why, '补了人却没给条号：读的人无从核对是哪一条这么定的').toContain('《民事诉讼法》第六十一条');
      expect(why, '没说本人出庭是默认路径，这一条读起来仍然像"必须找人代理"').toMatch(/本人(出庭|到庭)/);
    },
  );
});
