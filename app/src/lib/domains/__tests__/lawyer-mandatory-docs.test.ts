// app/src/lib/domains/__tests__/lawyer-mandatory-docs.test.ts
// **对外那几份文档里"法律上只能由执业律师做的只有 N 件"，必须与领域包里那份清单对得上。**
//
// 【为什么要有这条】清单本身（DomainPack.lawyerMandatory）是给**我们自己的 agent**
// 下发的，逐轮由 lib/agent/lawyer-mandatory.ts 渲染；而用户的 agent 走 MCP/REST 接进来，
// 它读到的纪律在 skill/ 那几份说明书里——那几份是**手写区**，gen:docs 不管，
// 里面把件数与那两件事逐字抄了一遍。
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
 * 抄了这句话的四份文档。**它们的共同点是"人写给人、gen:docs 不管"**：
 *   · skill/接入说明.md —— 接入方读的正本（手写区）；
 *   · skill/variants/claude-skill.md —— 它的 Claude 变体，由 gen:docs 整份生成，
 *     但内容来自正本的手写区，所以同样会跟着错；
 *   · skill/陪跑指南.md —— 用户的 agent 每轮读的那份纪律；
 *   · 律师函应对要点卡 —— 检索命中时直接进模型上下文的那张卡。
 */
const DOCS = [
  'skill/接入说明.md',
  'skill/variants/claude-skill.md',
  'skill/陪跑指南.md',
  'knowledge/packs/counseling/templates/lvshihan-yingdui-yaodian.md',
];

/** 件数 → 文档里写的那个字。只到十：超过十条时那几份文档本来就该重写，不该是这里凑数。 */
const CN = ['零', '一', '两', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 四份文档共用的那半句话（各自的前半句不同，这半句是逐字相同的）。 */
const phrase = (n: number) => `只能由执业律师做的只有${CN[n]}件`;

describe('对外文档里的"只有 N 件"跟着 DomainPack.lawyerMandatory 走', () => {
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
      `这份文档里的件数与领域包对不上（清单现在是 ${counts[0]} 条，文档里找不到「${want}」）。\n` +
        '为什么缺：清单在领域包里改了，而这份是人手抄的第二份，gen:docs 只管标记之间那几段。\n' +
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
