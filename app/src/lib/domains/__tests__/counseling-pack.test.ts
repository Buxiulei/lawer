// app/src/lib/domains/__tests__/counseling-pack.test.ts
// 第二个领域包（心理咨询纠纷）的判据，逐条对着设计稿 §16。
//
// 【这一组判据要拦的是哪一类事】领域包的每一项漏掉或写歪，**都不会让程序崩溃**：
//   · 少一个 stage ⇒ 那个阶段的案子永远校验不过，而错误信息看起来像用户填错了；
//   · calculatorKinds 多列一项 ⇒ 模型会调它，然后拿到一个我们编的数；
//   · 危机词表写成第一个领域那份 ⇒ 咨询师说「来访有自杀计划」不触发，而首段照常不出现；
//   · interpretationDisputed 少一条 ⇒ 模型对那一件事给出干脆的答案，而它读起来很像答案。
// 所以这里逐项钉住，而不是只做一次 assertDomainPack（那只查"在不在"，不查"是不是这一份"）。
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildCaseFacts, renderCaseFacts } from '@/lib/agent/case-facts';
import { bannedHotlines, crisisHotlines } from '@/lib/agent/crisis-opener';
import { renderLawyerMandatory } from '@/lib/agent/lawyer-mandatory';
import { buildSystemPrompt } from '@/lib/agent/prompt';
import type { KnowledgePack } from '@/lib/agent/retrieval';
import type { CaseSnapshot } from '@/lib/agent/snapshot';
import * as cases from '@/lib/cases';
import { bootstrapReport, getReport } from '@/lib/cases/report';
import { DEADLINE_RULES } from '@/lib/deadline';
import type { CaseRow } from '@/lib/db/cases';
import { runMigrations } from '@/lib/db/migrate';
import * as knowledge from '@/lib/knowledge';

import { COUNSELING } from '../counseling';
import {
  DEFAULT_DOMAIN,
  DOMAINS,
  DOMAINS_ENABLED_ENV,
  assertDomainPack,
  enabledDomainKeys,
  getDomainPack,
  isDomainEnabled,
  requireEnabledDomain,
} from '../registry';

const LABOR = DOMAINS[DEFAULT_DOMAIN];

describe('counseling 领域包挂在注册表上（设计稿 §16 分期：W3 挂包）', () => {
  it('取得到，且过结构守卫', () => {
    expect(getDomainPack('counseling')).toBe(COUNSELING);
    expect(() => assertDomainPack(COUNSELING)).not.toThrow();
  });

  it('key 与 label 是设计稿那两个字面量（变异：改 key → 全库 39 张卡的 domain 当场对不上）', () => {
    expect(COUNSELING.key).toBe('counseling');
    expect(COUNSELING.label).toBe('心理咨询纠纷');
  });
});

describe('§16 parties：我方是咨询师/机构，对面可能同时好几方', () => {
  it('self 是我方（咨询师/咨询机构），不是来访者', () => {
    expect(COUNSELING.parties.self).toContain('咨询师');
    expect(COUNSELING.parties.self).toContain('机构');
    // 【方向错了会怎样】self 写成「来访者」的形态是：整套工具面改口去替**对面**说话，
    // 而每一句话读起来都通顺，没有一处会报错。
    expect(COUNSELING.parties.self).not.toContain('来访者');
  });

  it('counterparts 覆盖 §16 那六方，且第一个是最典型的那一个', () => {
    expect(COUNSELING.parties.counterparts[0]).toBe('来访者');
    for (const who of ['来访者', '监护人', '平台', '协会', '监管', '媒体']) {
      expect(
        COUNSELING.parties.counterparts.some((c) => c.includes(who)),
        `§16 列的对方主体少了「${who}」`,
      ).toBe(true);
    }
  });

  it('multiParty=true（同一场纠纷里对面可能同时不止一方）', () => {
    expect(COUNSELING.parties.multiParty).toBe(true);
    // 【为什么这里不拿第一个领域做反例】它也是 true（关联公司/用工平台可能好几家）。
    // 本领域为 true 的理由不同：来访、监护人、平台、协会、监管、媒体可能**同时**在对面，
    // 所以真正分得开两个领域的是 counterparts 那份清单（见上一条），不是这个布尔。
    expect(COUNSELING.parties.counterparts.length).toBeGreaterThan(LABOR.parties.counterparts.length);
  });
});

describe('§16 stages + tracks：非线性主线 + 一条并行轨', () => {
  it('主线七档，逐字照设计稿的顺序', () => {
    expect(COUNSELING.stages).toEqual([
      '日常合规',
      '来访投诉',
      '协商（退费/和解）',
      '协会伦理申诉',
      '监管或消协投诉',
      '仲裁或诉讼',
      '执行',
    ]);
  });

  it('并行轨只有「危机事件处置」，且**不与任何主线阶段重名**', () => {
    expect(COUNSELING.tracks).toEqual(['危机事件处置']);
    // 重名的形态是：「当前轨」与「当前阶段」互相覆盖，而两边各自看都正常
    for (const t of COUNSELING.tracks) expect(COUNSELING.stages).not.toContain(t);
  });

  it('第一个领域没有并行轨（自证 tracks 不是所有包都一样）', () => {
    expect(LABOR.tracks).toEqual([]);
  });
});

describe('§16 intakeSchema：来访者身份只收化名或编号', () => {
  const byKey = (k: string) => COUNSELING.intakeSchema.find((f) => f.key === k)!;

  it('键名与对外参数名与第一个领域**逐字相同**（跨领域不变的对外契约）', () => {
    // 【为什么这条要钉】按领域改键名等于换接口，而用户的 agent 手里握着上一版工具清单。
    // 校验、落库、MCP 入参、网页表单四处会各自认两套名字，而没有一处会报错。
    expect(COUNSELING.intakeSchema.map((f) => f.key)).toEqual(LABOR.intakeSchema.map((f) => f.key));
    expect(COUNSELING.intakeSchema.map((f) => f.param)).toEqual(LABOR.intakeSchema.map((f) => f.param));
  });

  it('问法全部重写过：没有一格的 description 与第一个领域相同', () => {
    for (const f of COUNSELING.intakeSchema) {
      const same = LABOR.intakeSchema.find((x) => x.key === f.key)!;
      expect(f.description, `${f.key} 的问法还是第一个领域那句`).not.toBe(same.description);
    }
  });

  it('对方那一格逐字写着「不要填真实姓名」，问法与错误信息两处都写（变异：删掉任一处 → 红）', () => {
    const f = byKey('companyName');
    expect(f.description).toContain('化名');
    expect(f.description).toContain('不要填真实姓名');
    // 【为什么错误信息也要写】用户第一次填空了被拒，看到的是错误信息不是 description；
    // 只在 description 里写的形态是：他补填时照着自己脑子里的"姓名"填了真名。
    expect(f.invalidMessage).toContain('不要填真实姓名');
  });

  it('必填只有三项：走到哪一步、对方是谁（化名）、想要什么结果', () => {
    expect(COUNSELING.intakeSchema.filter((f) => f.required).map((f) => f.key)).toEqual([
      'stage',
      'companyName',
      'goals',
    ]);
  });

  it('stage 那一格的取值集合就是本包的 stages（不是抄的第二份）', () => {
    expect(byKey('stage').values).toEqual(COUNSELING.stages);
  });

  it('首诊不自动落期限：本领域拿不到可指认的起算点（省略是结论，不是漏填）', () => {
    expect(COUNSELING.intakeLimitation).toBeUndefined();
  });
});

describe('§16 factsSections / reportSections：十节各一份', () => {
  it('事实卡分节键与第一个领域同一套，标题全部按本领域重写', () => {
    expect(COUNSELING.factsSections.map((s) => s.key)).toEqual(LABOR.factsSections.map((s) => s.key));
    const laborTitles = new Set(LABOR.factsSections.map((s) => s.title));
    const reused = COUNSELING.factsSections.filter((s) => laborTitles.has(s.title)).map((s) => s.key);
    // 「案件抬头」「本案对话」「法定期限」这类中性抬头两边同名是对的；
    // 真正要拦的是**带行当味道**的那几节还留着上一个领域的字。
    expect(COUNSELING.factsSections.find((s) => s.key === 'basics')!.title).toContain('咨询关系');
    expect(COUNSELING.factsSections.find((s) => s.key === 'evidence')!.title).toContain('敏感级');
    expect(COUNSELING.factsSections.find((s) => s.key === 'counterparts')!.title).toContain('化名');
    expect(reused, '这几节的抬头还在讲另一个行当的事').not.toContain('basics');
  });

  it('报告十节的标题逐字照 §16（顺序即渲染顺序）', () => {
    expect(COUNSELING.reportSections.map((s) => s.title)).toEqual([
      '机构与执业基本盘',
      '咨询关系与合同',
      '事件经过与危机记录',
      '争议焦点',
      '各方立场与谈判纪律',
      '证据地图（含敏感级）',
      '期限',
      '待办与下一步',
      '风险与解释存疑',
      '变更日志',
    ]);
  });
});

describe('§16 deadlineKinds：待核实那几类不给缺省天数', () => {
  it('七类齐备（三类已知 + 三类待核实 + 自定义）', () => {
    expect(COUNSELING.deadlineKinds).toEqual([
      '诉讼时效3年',
      '答辩期15日',
      '举证期限',
      '协会申诉答复时限',
      '监管投诉答复期限',
      '记录保存年限',
      '自定义',
    ]);
  });

  /**
   * 【这条是本组里最要紧的一条】给一个编出来的天数，用户会按一个不存在的期限安排事情，
   * 而到期日看起来完全正常。所以"没有推算规则"必须是**可观测的事实**，不是我们记得没写。
   * 判据直接问推算规则表：这三类必须查不到规则，deadline_set 才会如实说「这一类没有推算规则」。
   */
  it('协会申诉答复时限 / 监管投诉答复期限 / 记录保存年限：推算规则表里没有它们（变异：给任一条补一条规则 → 红）', () => {
    const stored = new Set(Object.values(DEADLINE_RULES).map((r) => r.storedKind));
    for (const kind of ['协会申诉答复时限', '监管投诉答复期限', '记录保存年限']) {
      expect(stored, `「${kind}」有了推算规则 ⇒ 服务端会替用户算出一个我们没核实过的到期日`).not.toContain(
        kind,
      );
    }
  });

  it('判据自身不空跑：规则表里确实装着别的种类（否则上一条恒真）', () => {
    expect(Object.values(DEADLINE_RULES).length).toBeGreaterThan(0);
  });
});

describe('§16 docKinds：九类，内部件不进对外清单', () => {
  it('九类逐字照设计稿', () => {
    expect(COUNSELING.docKinds).toEqual([
      '知情同意书',
      '保密告知与例外说明',
      '危机处置记录',
      '转介函',
      '投诉答复函',
      '退费协议',
      '停止服务通知',
      '律师函应对要点',
      '伦理申诉答辩书',
    ]);
  });

  it('对外七类；危机处置记录与律师函应对要点是内部件，**不带发送后果**', () => {
    expect(COUNSELING.outboundDocKinds).not.toContain('危机处置记录');
    expect(COUNSELING.outboundDocKinds).not.toContain('律师函应对要点');
    // 其余七类都必须在对外清单里：漏一类的形态是，那一类文书起草完不要求 send_consequences，
    // 而它照样会被发到对方手里（charter 红线 5）。
    for (const k of COUNSELING.docKinds) {
      if (k === '危机处置记录' || k === '律师函应对要点') continue;
      expect(COUNSELING.outboundDocKinds, `对外文书清单少了「${k}」`).toContain(k);
    }
  });
});

describe('§16 claimKinds / calculatorKinds：能记的比能算的多', () => {
  it('算钱器**只有退费一项**（变异：把精神损害抚慰金或名誉侵权赔偿列进来 → 红）', () => {
    // 那两项没有可计算的公式，只有判例与地方口径的**区间**。列进算钱器的形态是：
    // 模型会调，然后拿到一个数——而那个数是我们编的。
    expect(COUNSELING.calculatorKinds).toEqual(['退费']);
    expect(COUNSELING.calculatorKinds).not.toContain('精神损害抚慰金');
    expect(COUNSELING.calculatorKinds).not.toContain('名誉侵权赔偿');
  });

  it('那两项照样能**登记**一笔账（只是算不出来），claimKinds 里有它们', () => {
    expect(COUNSELING.claimKinds).toContain('精神损害抚慰金');
    expect(COUNSELING.claimKinds).toContain('名誉侵权赔偿');
    expect(COUNSELING.claimKinds).toContain('退费');
  });

  it('两份清单不是同一份（变异：把其中一处改成引用另一处 → 红）', () => {
    expect(COUNSELING.calculatorKinds).not.toEqual(COUNSELING.claimKinds);
    expect(COUNSELING.claimKinds.filter((k) => !COUNSELING.calculatorKinds.includes(k)).length).toBeGreaterThan(0);
  });
});

describe('§16 crisis：咨询师侧词表 + 处置骨架首段', () => {
  /**
   * 【这条不要求两份词表零重合，原因写在这里】「自杀」「想死」这类词在哪个行当里都是危机信号，
   * 两份都收是对的。真正要分开的是**只有这个行当才会说出口的那些**：
   * 咨询师说的是「来访有计划」「来访失联了」「他打了他母亲」——那些词在第一个领域里
   * 一个都不会出现，而它们不在词表里的形态是：危机首段整轮不出现，
   * 而这一轮的回复照常生成、看起来只是"这次没触发"。
   */
  it('咨询师侧独有的那几类都在，且不是照抄第一个领域那份（变异：把词表改成 LABOR.crisis.lexicon → 红）', () => {
    expect(COUNSELING.crisis.lexicon).not.toEqual(LABOR.crisis.lexicon);
    // §16 点名的类别逐条在场
    for (const kind of ['自杀', '自伤', '伤人', '失联', '未遂']) {
      expect(
        COUNSELING.crisis.lexicon.some((w) => w.includes(kind)),
        `咨询师侧词表少了「${kind}」这一类`,
      ).toBe(true);
    }
    // 本领域独有的那批必须真的存在（否则上面那条"不相等"可以靠删一个词就满足）
    const onlyHere = COUNSELING.crisis.lexicon.filter((w) => !LABOR.crisis.lexicon.includes(w));
    expect(onlyHere.length, '这份词表与第一个领域几乎一样，看不出是咨询师侧的').toBeGreaterThan(10);
  });

  it('否定标记收了病历句式（否认 / 未发现 / 排除）', () => {
    for (const neg of ['否认', '未发现', '排除']) {
      expect(COUNSELING.crisis.negations, `否定标记少了病历里最常见的「${neg}」`).toContain(neg);
    }
  });

  it('首段是**处置骨架**：评估 → 联系 → 记录 → 随访，顺序即内容（变异：调换任两步 → 红）', () => {
    // 【为什么按"第 n 步那一行"取，不用 indexOf】首段的引子里就出现了「记录」二字
    //（"记录本身也是日后最要紧的那份材料"），拿裸词 indexOf 会把那句引子当成第三步，
    // 于是这条判据测的是引子写在哪儿，而不是四步的顺序。
    const numbered = COUNSELING.crisis.openerText.head.filter((line) => /^\d\.\s/.test(line.trim()));
    expect(numbered.length, '首段里没有编号的四步').toBe(4);
    for (const [i, step] of ['评估', '联系', '记录', '随访'].entries()) {
      expect(numbered[i], `第 ${i + 1} 步不是「${step}」`).toContain(step);
    }
  });

  it('首段不是给来访者的热线话术（不出现第一个领域那种"打给你自己"的措辞）', () => {
    const head = COUNSELING.crisis.openerText.head.join('\n');
    expect(head).toContain('号码');
    // 它明说这些号码是**处置现场**用的，不是给来访的推荐清单
    expect(COUNSELING.crisis.openerText.tail).toContain('不是给来访的推荐清单');
    expect(COUNSELING.crisis.openerText.tail).toContain('顺序');
  });

  it('号码一个都不写在包里：全从卡取（变异：把号码写进 openerText → 本条红）', () => {
    const all = JSON.stringify({
      head: COUNSELING.crisis.openerText.head,
      tail: COUNSELING.crisis.openerText.tail,
      directive: COUNSELING.crisis.directive,
      fallback: COUNSELING.crisis.safeFallback,
    });
    for (const found of all.match(/\d[\d-]{4,}/g) ?? []) {
      // 条号（第二十八条这类）是中文数字，不会被这条正则捞到；捞到的一律算号码
      expect(found, `危机首段/指令里写死了号码 ${found}——卡上换号时它不会跟着变`).toBeUndefined();
    }
  });

  it('资源卡取得到，12356 在里面，且**希望 24 热线取不出来**（卡上标 forbidden）', () => {
    const card = knowledge.get(COUNSELING.crisis.resourcePackId);
    expect(card, `资源卡 ${COUNSELING.crisis.resourcePackId} 取不到`).toBeDefined();
    const usable = crisisHotlines(card!.facts).map((h) => h.phone);
    expect(usable).toContain('12356');
    // 设计稿 §16：「希望 24 热线」标非官方不进 usable
    const banned = bannedHotlines(card!.facts);
    expect(banned.size, '卡上一个 forbidden 号码都没有 ⇒ 下面那条恒真').toBeGreaterThan(0);
    for (const b of banned) expect(usable, `被禁的 ${b} 出现在可用号码里`).not.toContain(b);
  });

  it('危机窗内那句话由本包给：带传进来的号码，且**必须带拨打顺序**', () => {
    const note = COUNSELING.crisis.repeatCardNote(['12356', '110']);
    expect(note).toContain('12356');
    expect(note).toContain('顺序');
    // 第一个领域那三个号码一个都不许出现在这里（本票修掉的就是这件事）
    for (const phone of ['800-810-1117', '010-82951332']) expect(note).not.toContain(phone);
  });

  it('一个号码都抽不到时也说得出话（不回空串，否则那张卡后面什么限制都没有）', () => {
    expect(COUNSELING.crisis.repeatCardNote([]).trim().length).toBeGreaterThan(20);
  });
});

describe('§16 解释存疑：四条固定条目 + 一句纪律', () => {
  it('四条各说一件事，逐条覆盖 §16 点名的那四项', () => {
    const items = COUNSELING.interpretationDisputed!.items;
    expect(items.length).toBe(4);
    const joined = items.join('\n');
    for (const topic of ['强制报告', '合同定性', '保存年限', '许可']) {
      expect(joined, `解释存疑少了「${topic}」那一条`).toContain(topic);
    }
  });

  /**
   * 【这句话 2026-09-07 换过一次，换的是理由不是闸】原话是"未经律师书面确认不得作为结论输出"。
   * 主理人裁决：**没有律师签字这回事**——所以闸留着（只给依据原文与分歧点、不下结论），
   * 理由改成"现行法律解释存疑"。钉逐字是因为这句话本身就是这一节的作用；
   * 换掉半句（比如只剩"不下结论"、丢掉"以下是依据原文与分歧点"）的形态是：
   * 模型照旧不下结论，但也不再把依据原文摆出来，于是用户读到的是一句"这事说不清"。
   */
  it('纪律那句话逐字写着「本问题现行法律解释存疑：以下是依据原文与分歧点，土八鼠不下结论」', () => {
    expect(COUNSELING.interpretationDisputed!.discipline).toContain(
      '本问题现行法律解释存疑：以下是依据原文与分歧点，土八鼠不下结论',
    );
    // 旧口径一个字都不许剩：只改一半的形态是两种说法在同一节里并存
    expect(COUNSELING.interpretationDisputed!.discipline, '这一节里还留着"律师"，旧口径没改干净').not.toContain(
      '律师',
    );
  });

  it('纪律不止说"不许下结论"，还说了不许据此做哪些不可逆的动作', () => {
    // 【为什么这半句不能省】只说"不得下结论"的形态是：模型不说"你必须报"，
    // 改说"那你先把记录销毁吧"——它没下结论，但用户做了一件收不回的事。
    const d = COUNSELING.interpretationDisputed!.discipline;
    expect(d).toContain('不可逆');
    expect(d).toContain('销毁记录');
  });

  it('抬头与报告里那一节同名（两处读同一份措辞，不是抄的第二份）', () => {
    expect(COUNSELING.reportSections.find((s) => s.source === 'risks')!.title).toBe(
      COUNSELING.interpretationDisputed!.title,
    );
  });

  it('第一个领域没有这一节（自证它是包的字段，不是全站恒有的一段）', () => {
    expect(LABOR.interpretationDisputed).toBeUndefined();
  });

  /**
   * 【这一条钉的是"同一份 prompt 里两条指令互斥"】这四条每轮随事实卡渲染，
   * 逐条写着"现行法律解释存疑"；而主理人 2026-09-07 裁决之后，同一份 system prompt 里
   * 还有一段闭合清单，写着"清单以外的每一件事都由你做完""不许用建议咨询律师收尾"。
   *
   * 谁优先不写下来的形态是：用户问"我们机构算不算强制报告主体"，模型按清单那段办
   * 就给出是/否结论（正是这四条要禁的），按这四条办就把人指向了律师（正是那段要禁的），
   * **两种都不会报错**。所以裁法必须出现在下发给模型的字里 —— 见
   * lib/agent/lawyer-mandatory.ts 的 interpretationDisputedTiebreak。
   */
  it('闭合清单那一段点名了这一节，并写死"它限制结论、不是把人支出去的理由"', () => {
    const seg = renderLawyerMandatory(COUNSELING);
    expect(seg, '清单段没点名这一节，模型不知道说的是哪一节').toContain(COUNSELING.interpretationDisputed!.title);
    expect(seg).toContain('不得**当成把用户支给律师的理由');
    expect(seg, '只堵不给出路的话，模型只能在两条禁令之间挑一条违反').toContain('照第 1 条由你写清楚');
  });
});

describe('§16 敏感级：三处出口读同一份声明', () => {
  it('subject 是「来访者」，三段话都不是空的', () => {
    expect(COUNSELING.sensitive!.subject).toBe('来访者');
    expect(COUNSELING.sensitive!.factsNotice).toContain('敏感');
    expect(COUNSELING.sensitive!.redactNotice).toContain('脱敏');
  });

  it('事实卡那句话逐字说清「只给元数据与化名」以及要用内容该怎么办', () => {
    const n = COUNSELING.sensitive!.factsNotice;
    expect(n).toContain('元数据');
    expect(n).toContain('evidence_get');
  });

  it('分享页那句话告诉读者去找谁核对（不是只说"已脱敏"）', () => {
    expect(COUNSELING.sensitive!.redactNotice).toContain('分享方');
  });

  it('第一个领域没有敏感级声明（自证它是包的字段）', () => {
    expect(LABOR.sensitive).toBeUndefined();
  });
});

describe('§16 copy：低调模式词典按本行当来', () => {
  it('要挡的词与第一个领域完全不同（屏幕对面可能正坐着一位来访）', () => {
    const words = COUNSELING.copy.neutral.forbiddenWords;
    for (const w of ['来访', '咨询', '投诉']) expect(words).toContain(w);
    // 两份词表没有重合项：重合的形态是这份是照抄改的，而"什么词会暴露"完全取决于行当
    expect(words.filter((w) => LABOR.copy.neutral.forbiddenWords.includes(w))).toEqual([]);
  });

  it('兜底措辞里一个禁词都不出现（低调模式挡的是这个人的事，不是别人的）', () => {
    const { title, appTitle, notice, forbiddenWords } = COUNSELING.copy.neutral;
    for (const w of forbiddenWords) for (const t of [title, appTitle, notice]) expect(t).not.toContain(w);
  });

  it('站内文案按本领域重写：建档那条欢迎事件明说只写化名', () => {
    expect(COUNSELING.copy.site.welcomeEventDetail).toContain('化名');
    expect(COUNSELING.copy.site.welcomeEventDetail).not.toBe(LABOR.copy.site.welcomeEventDetail);
  });

  it('能力文案的键与第一个领域**一一对应**（对不上的形态是：接线那天要一句句去猜，而猜错不报错）', () => {
    expect(Object.keys(COUNSELING.copy.capabilities).sort()).toEqual(
      Object.keys(LABOR.copy.capabilities).sort(),
    );
  });

  /**
   * 【为什么这一条要单列】登记对方主体的那句文案与包字段（aliasRoles / defaultCompanyRole）
   * 是同一件事的两个读者：文案叫 agent 把机构填进哪一格，脱敏按哪一格洗。
   * 两者分叉的形态是——文案叫他填 A、脱敏在洗 B，两边各自读都通顺，
   * 而产物（要寄出去的答复函）里机构全称成了占位符，HTTP 200、PDF 照常生成。
   */
  it('登记对方主体那句话逐字点到两个角色位，且与包字段同值', () => {
    const desc = COUNSELING.copy.capabilities.companyProfileUpsertDescription;
    const roleParam = COUNSELING.copy.capabilities.companyRoleParam;
    const alias = COUNSELING.sensitive!.aliasRoles[0];
    for (const text of [desc, roleParam]) {
      expect(text, '没告诉 agent 化名该填哪一格').toContain(alias);
      expect(text, '没告诉 agent 机构该填哪一格').toContain(COUNSELING.defaultCompanyRole);
    }
    // 【它同时要拦的自相矛盾】此前这句话读起来像"这张表整张只登记化名"，
    // 而下一句 companyNameParam 又说机构用全称——agent 读完两句不知道机构到底登不登记。
    expect(desc, '「只登记化名」读起来管整张表，与「机构用全称」自相矛盾').not.toContain(
      '这里只登记化名或编号',
    );
    expect(COUNSELING.copy.capabilities.companyNameParam).toContain('机构全称');
  });
});

// ========== 灰度开关（设计稿 §16 分期：LAWER_DOMAINS_ENABLED=labor,counseling）==========

describe('counseling 只有在灰度开关里才可见', () => {
  const ORIGINAL = process.env[DOMAINS_ENABLED_ENV];
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env[DOMAINS_ENABLED_ENV];
    else process.env[DOMAINS_ENABLED_ENV] = ORIGINAL;
  });

  it('开关没配 ⇒ 只有缺省领域，counseling 不可见（变异：把缺省值改成全部注册包 → 红）', () => {
    delete process.env[DOMAINS_ENABLED_ENV];
    expect(enabledDomainKeys()).toEqual([DEFAULT_DOMAIN]);
    expect(isDomainEnabled('counseling')).toBe(false);
  });

  it('开关只写了缺省领域 ⇒ 选它建案回 DOMAIN_NOT_ENABLED（不是 UNKNOWN_DOMAIN）', () => {
    process.env[DOMAINS_ENABLED_ENV] = DEFAULT_DOMAIN;
    const got = requireEnabledDomain('counseling');
    expect('ok' in got && got.ok === false).toBe(true);
    const fail = got as { errorCode: string; message: string };
    // 两个错误码分得开：一个是"这套代码里没有"，一个是"有但没开"。合成一个的形态是
    // 运维照着"没有这个领域"去补代码，而代码早就在了、只差开关里一行。
    expect(fail.errorCode).toBe('DOMAIN_NOT_ENABLED');
    expect(fail.message).toContain(DOMAINS_ENABLED_ENV);
  });

  it('开关写了两个 ⇒ counseling 可见，且取回的是这个包本身', () => {
    process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
    expect(enabledDomainKeys()).toEqual([DEFAULT_DOMAIN, 'counseling']);
    expect(isDomainEnabled('counseling')).toBe(true);
    expect(requireEnabledDomain('counseling')).toBe(COUNSELING);
  });

  it('灰度关掉不影响**已存在**的案子读自己的档案（读路径不看开关）', () => {
    process.env[DOMAINS_ENABLED_ENV] = DEFAULT_DOMAIN;
    // getDomainPack 是读路径的入口，它刻意不看开关（见 registry 的头注释）
    expect(getDomainPack('counseling')).toBe(COUNSELING);
  });
});

// ========== 建案 + 事实卡：包真的被用上了 ==========

describe('counseling 案件建得出来，且事实卡按本包渲染', () => {
  let db: Database.Database;
  let uid: number;
  const ORIGINAL = process.env[DOMAINS_ENABLED_ENV];

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    uid = Number(db.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('hh').lastInsertRowid);
    process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  });

  afterEach(() => {
    db.close();
    if (ORIGINAL === undefined) delete process.env[DOMAINS_ENABLED_ENV];
    else process.env[DOMAINS_ENABLED_ENV] = ORIGINAL;
  });

  it('开关开着 ⇒ 建得出 counseling 案件，domain 落的就是它', () => {
    const made = cases.ensureDefaultCase(db, uid, 'counseling');
    expect('ok' in made).toBe(false);
    if ('ok' in made) return;
    const row = db.prepare('SELECT domain, track FROM cases WHERE id = ?').get(made.caseId) as {
      domain: string;
      track: string | null;
    };
    expect(row.domain).toBe('counseling');
    // 新建的案子不在任何并行轨上——NULL 是「只在主线」这个事实，不是「还没填」
    expect(row.track).toBeNull();
  });

  it('本领域的阶段收、别的领域的阶段拒（stage 校验按案件领域走）', () => {
    const made = cases.ensureDefaultCase(db, uid, 'counseling');
    if ('ok' in made) throw new Error('建案失败');
    const ok = cases.updateCase(db, { caseId: made.caseId, userId: uid, stage: '协会伦理申诉' });
    expect('ok' in ok && ok.ok === false).toBe(false);
    const bad = cases.updateCase(db, { caseId: made.caseId, userId: uid, stage: LABOR.stages[0] });
    expect('ok' in bad && bad.ok === false).toBe(true);
  });

  it('并行轨进得去、出得来；本领域没有的轨名拒收', () => {
    const made = cases.ensureDefaultCase(db, uid, 'counseling');
    if ('ok' in made) throw new Error('建案失败');
    const stageBefore = (
      db.prepare('SELECT stage FROM cases WHERE id = ?').get(made.caseId) as { stage: string }
    ).stage;

    const on = cases.updateCase(db, { caseId: made.caseId, userId: uid, track: '危机事件处置' });
    expect('ok' in on && on.ok === false).toBe(false);
    const after = db.prepare('SELECT stage, track FROM cases WHERE id = ?').get(made.caseId) as {
      stage: string;
      track: string | null;
    };
    expect(after.track).toBe('危机事件处置');
    // 【进轨不覆盖主线】这正是它不做成一个 stage 的理由
    expect(after.stage).toBe(stageBefore);

    // 出轨：传 null 是一个**动作**，不是"这次不动它"
    const off = cases.updateCase(db, { caseId: made.caseId, userId: uid, track: null });
    expect('ok' in off && off.ok === false).toBe(false);
    expect(
      (db.prepare('SELECT track FROM cases WHERE id = ?').get(made.caseId) as { track: string | null }).track,
    ).toBeNull();

    const bad = cases.updateCase(db, { caseId: made.caseId, userId: uid, track: '不存在的轨' });
    expect('ok' in bad && bad.ok === false).toBe(true);
    expect((bad as { errorCode: string }).errorCode).toBe('INVALID_TRACK');
  });

  it('缺省领域的案子传 track ⇒ 说清「本领域没有并行轨」，不回一句后面空着的清单', () => {
    const made = cases.ensureDefaultCase(db, uid, DEFAULT_DOMAIN);
    if ('ok' in made) throw new Error('建案失败');
    const bad = cases.updateCase(db, { caseId: made.caseId, userId: uid, track: '危机事件处置' });
    expect('ok' in bad && bad.ok === false).toBe(true);
    const f = bad as { errorCode: string; message: string };
    expect(f.errorCode).toBe('INVALID_TRACK');
    expect(f.message).toContain('没有并行轨');
    // 反例：不许出现「track 只能是 」后面空一片
    expect(f.message).not.toMatch(/只能是\s*，/);
  });
});

describe('counseling 的事实卡：多一节「风险与解释存疑」，证据只给元数据', () => {
  /** 一份**合法**的简报（parseBrief 会逐字段校验；随手拼一个对象会被判无效，
   *  于是那条证据被当成"没有简报"，判据测的就成了另一件事）。 */
  const BRIEF_PROVES = '这一段简报正文绝不该出现在事实卡里';
  const BRIEF = {
    proves: BRIEF_PROVES,
    key_facts: [{ when: '2026-08-01', who: '对方', what: '在电话里承认了' }],
    relation_to_claims: '支持退费主张',
    weaknesses: ['录音里没有自报身份'],
    suggested_followups: ['补一份转账记录'],
    citations: ['00:03:12'],
  };

  const CASE_BASE: CaseRow = {
    id: 7,
    user_id: 7,
    title: '一件退费争议',
    stage: COUNSELING.stages[1],
    domain: 'counseling',
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

  function snapshotOf(over: Partial<CaseRow> = {}, evidence: CaseSnapshot['evidence'] = []): CaseSnapshot {
    return {
      case: { ...CASE_BASE, ...over },
      identity: { realName: null, authStatus: '未认证', nameUnreadable: false },
      evidence,
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

  it('四条解释存疑逐条印进事实卡，纪律那句话也在（变异：删掉 interpretationDisputedSection → 红）', () => {
    const card = renderCaseFacts(buildCaseFacts(snapshotOf()));
    expect(card).toContain(`### ${COUNSELING.interpretationDisputed!.title}`);
    for (const item of COUNSELING.interpretationDisputed!.items) {
      expect(card, '解释存疑少了一条').toContain(item);
    }
    expect(card).toContain(COUNSELING.interpretationDisputed!.discipline);
  });

  it('缺省领域的事实卡里**一个字都没多**（labor 零变化）', () => {
    const card = renderCaseFacts(buildCaseFacts(snapshotOf({ domain: DEFAULT_DOMAIN, stage: LABOR.stages[0] })));
    expect(card).not.toContain('本问题现行法律解释存疑');
    expect(card).not.toContain('当前轨');
  });

  /**
   * 【这一组拦的是哪一次事故】basics 那一节此前只有**抬头**按领域换，节里四行正文是共用层
   * 写死的字面量。于是本领域的事实卡长这样：抬头「咨询关系与执业基本盘」，下面接着
   *「入职日期：2026-01-10 / 月工资：500.00 元」——而这两列在本领域装的是
   * 服务关系开始日与**单次**咨询费用。模型每一轮都据此把一次咨询的收费当成月薪去算退费，
   * 值一个都没错、格式完全正常、没有任何一处会报错。
   *
   * 变异确认：把 case-facts.employmentSection 的四行改回写死的那四句 → 下面第二条断言红。
   */
  const FOUR_BASICS: Partial<CaseRow> = {
    employed_from: '2026-01-10',
    monthly_wage_fen: 50000,
    position: 'XX 心理工作室，注册咨询师',
    contract_count: '套餐 10 次，已做 3 次',
  };

  it('basics 四行的抬头按本领域来：说的是服务关系与单次费用，不是另一个行当的入职与月薪', () => {
    const card = renderCaseFacts(buildCaseFacts(snapshotOf(FOUR_BASICS)));
    expect(card).toContain(`### ${COUNSELING.factsSections.find((x) => x.key === 'basics')!.title}`);
    expect(card).toContain(`- ${COUNSELING.factsBasics.employedFrom}：2026-01-10`);
    expect(card).toContain(`- ${COUNSELING.factsBasics.monthlyWage}：500.00 元`);
    expect(card).toContain(`- ${COUNSELING.factsBasics.contractCount}：套餐 10 次，已做 3 次`);
    expect(card).toContain(`- ${COUNSELING.factsBasics.position}：`);
    // 四项都填了仍按「已记录 4/4」报——这一句是跨领域的统计口径，不随词表换
    expect(card).toContain('首诊四项已记录 4/4');
  });

  it('本领域的事实卡里没有另一个行当的那四句抬头（自证它们真是从包里取的）', () => {
    const card = renderCaseFacts(buildCaseFacts(snapshotOf(FOUR_BASICS)));
    for (const word of Object.values(LABOR.factsBasics)) {
      expect(card, `事实卡里出现了缺省领域的抬头「${word}」`).not.toContain(`- ${word}：`);
    }
  });

  it('缺省领域那四行**逐字不变**（labor 零变化；labor-baseline.json 的 caseFacts 同时钉着它们）', () => {
    const card = renderCaseFacts(
      buildCaseFacts(snapshotOf({ ...FOUR_BASICS, domain: DEFAULT_DOMAIN, stage: LABOR.stages[0] })),
    );
    expect(card).toContain(`- ${LABOR.factsBasics.employedFrom}：2026-01-10`);
    expect(card).toContain(`- ${LABOR.factsBasics.monthlyWage}：500.00 元`);
    for (const word of Object.values(COUNSELING.factsBasics)) {
      expect(card, `缺省领域的事实卡里出现了本领域的抬头「${word}」`).not.toContain(`- ${word}：`);
    }
  });

  it('「当前轨」两态都印，且都把主线阶段并排写出来（不在轨上时说清本领域有哪些轨）', () => {
    const off = renderCaseFacts(buildCaseFacts(snapshotOf()));
    expect(off).toContain('当前轨：主线');
    expect(off).toContain('危机事件处置'); // 告诉模型本领域有这么一条轨

    const on = renderCaseFacts(buildCaseFacts(snapshotOf({ track: '危机事件处置' })));
    expect(on).toContain('当前轨');
    // 【关键】轨与阶段并排出现，说清主线没有被覆盖
    expect(on).toContain(CASE_BASE.stage);
  });

  it('敏感级：有简报的证据**不印简报正文**，改说「要用先 evidence_get 按 id 读」', () => {
    const withBrief = [
      {
        id: 11,
        name: '与对方的通话录音',
        category: '录音',
        status: '已上传',
        prove_purpose: '证明对方口头承认',
        brief_json: JSON.stringify(BRIEF),
        extraction_status: 'done',
        extracted_at: '2026-09-02 10:00:00',
        created_at: '2026-09-02 09:00:00',
      },
    ] as unknown as CaseSnapshot['evidence'];

    const card = renderCaseFacts(buildCaseFacts(snapshotOf({}, withBrief)));
    expect(card, '简报正文被印进了每一轮 prompt').not.toContain(BRIEF_PROVES);
    expect(card).toContain('evidence_get');
    // 不说成"未提取"：模型会以为没人读过，去催用户做提取，而提取早就做完了
    expect(card).toContain('已有简报');
    expect(card).toContain(COUNSELING.sensitive!.factsNotice);
  });

  it('自证不空跑：同一份证据换到缺省领域的案子上，简报正文照旧会印出来', () => {
    const withBrief = [
      {
        id: 11,
        name: '与对方的通话录音',
        category: '录音',
        status: '已上传',
        prove_purpose: '证明对方口头承认',
        brief_json: JSON.stringify(BRIEF),
        extraction_status: 'done',
        extracted_at: '2026-09-02 10:00:00',
        created_at: '2026-09-02 09:00:00',
      },
    ] as unknown as CaseSnapshot['evidence'];
    const card = renderCaseFacts(
      buildCaseFacts(snapshotOf({ domain: DEFAULT_DOMAIN, stage: LABOR.stages[0] }, withBrief)),
    );
    expect(card).toContain(BRIEF_PROVES);
  });
});

// ========== 个案报告：当前轨 + 解释存疑那几条 ==========

describe('counseling 的个案报告：多一行「当前轨」，风险节先给固定条目', () => {
  let rdb: Database.Database;
  let ruid: number;
  const ORIG = process.env[DOMAINS_ENABLED_ENV];

  beforeEach(() => {
    rdb = new Database(':memory:');
    rdb.pragma('foreign_keys = ON');
    runMigrations(rdb);
    ruid = Number(rdb.prepare('INSERT INTO users (phone_hash) VALUES (?)').run('rep').lastInsertRowid);
    process.env[DOMAINS_ENABLED_ENV] = `${DEFAULT_DOMAIN},counseling`;
  });

  afterEach(() => {
    rdb.close();
    if (ORIG === undefined) delete process.env[DOMAINS_ENABLED_ENV];
    else process.env[DOMAINS_ENABLED_ENV] = ORIG;
  });

  function reportOf(domain: string, track: string | null): Record<string, string> {
    const made = cases.ensureDefaultCase(rdb, ruid, domain);
    if ('ok' in made) throw new Error(JSON.stringify(made));
    if (track !== null) {
      const up = cases.updateCase(rdb, { caseId: made.caseId, userId: ruid, track });
      if ('ok' in up && up.ok === false) throw new Error(JSON.stringify(up));
    }
    bootstrapReport(rdb, made.caseId);
    const got = getReport(rdb, { caseId: made.caseId, userId: ruid });
    if (!got.ok) throw new Error(JSON.stringify(got));
    return got.report.sections as Record<string, string>;
  }

  it('在轨上：基本盘那一节印「当前轨」，并把主线阶段并排写出来', () => {
    const sections = reportOf('counseling', COUNSELING.tracks[0]);
    const basics = sections['机构与执业基本盘'];
    expect(basics).toContain('当前轨');
    expect(basics).toContain(COUNSELING.tracks[0]);
    // 【关键】轨不覆盖阶段：两行并排出现才说得清"主线没动"
    expect(basics).toContain('主线阶段仍是');
  });

  it('不在轨上：也印一行，并告诉读者本领域有哪些轨（不印的形态是模型不知道有这条轨）', () => {
    const basics = reportOf('counseling', null)['机构与执业基本盘'];
    expect(basics).toContain('当前轨：主线');
    expect(basics).toContain(COUNSELING.tracks[0]);
  });

  it('缺省领域的报告里没有这一行（没有并行轨的领域印它是常驻噪音）', () => {
    const sections = reportOf(DEFAULT_DOMAIN, null);
    for (const text of Object.values(sections)) expect(text).not.toContain('当前轨');
  });

  it('风险节：四条固定条目 + 那句纪律排在「缺口」**之前**，两段分开', () => {
    const risks = reportOf('counseling', null)['风险与解释存疑'];
    for (const item of COUNSELING.interpretationDisputed!.items) expect(risks).toContain(item);
    expect(risks).toContain(COUNSELING.interpretationDisputed!.discipline);
    // 【为什么必须分成两段】混进缺口列表的形态是：模型看见"风险 6 条"，逐条去"解决"它们，
    // 而解决其中四条的唯一方式就是给出一个结论——那正是这几条要拦的事。
    const disciplineAt = risks.indexOf(COUNSELING.interpretationDisputed!.discipline);
    const gapAt = risks.indexOf('基本盘缺');
    expect(disciplineAt).toBeGreaterThanOrEqual(0);
    expect(gapAt, '这份报告里没有缺口，下面那句比较恒真').toBeGreaterThan(0);
    expect(disciplineAt, '固定条目排到缺口后面去了').toBeLessThan(gapAt);
  });

  it('缺省领域的风险节里一条固定条目都没有（自证它来自包）', () => {
    const risks = reportOf(DEFAULT_DOMAIN, null)['风险与未定项'] ?? '';
    expect(Object.values(reportOf(DEFAULT_DOMAIN, null)).join('\n')).not.toContain(
      '本问题现行法律解释存疑',
    );
    expect(typeof risks).toBe('string');
  });
});

// ========== 危机窗内的贴附指令：号码按域，不串行当 ==========

describe('counseling 危机窗内的贴附指令：号码来自本领域自己那张卡', () => {
  /** 本领域资源卡的一份注入包副本（正文与 facts 都取真卡，不另造一份号码）。 */
  function crisisCardPack(): KnowledgePack {
    const card = knowledge.get(COUNSELING.crisis.resourcePackId)!;
    return {
      id: card.id,
      type: card.type,
      title: card.title,
      keywords: card.keywords,
      applies_to: card.applies_to,
      region: card.region,
      confidence: card.confidence,
      updated: card.updated,
      body: card.content,
      facts: card.facts,
    } as KnowledgePack;
  }

  const CASE_ROW: CaseRow = {
    id: 9,
    user_id: 9,
    title: '一件危机处置',
    stage: COUNSELING.stages[0],
    domain: 'counseling',
    track: COUNSELING.tracks[0],
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

  function promptOf(): string {
    const snapshot: CaseSnapshot = {
      case: CASE_ROW,
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
      crisisHits72h: 1,
    };
    return buildSystemPrompt({
      snapshot,
      mode: '陪跑',
      stage: 'D',
      packs: [crisisCardPack()],
      now: new Date('2026-09-07T02:00:00Z'),
      crisis: true,
      crisisCardAlreadyGiven: true,
    } as Parameters<typeof buildSystemPrompt>[0]);
  }

  it('贴的是本包那句话，号码是本领域卡上的 12356（变异：号码源改回共用层写死 → 红）', () => {
    const p = promptOf();
    const at = p.indexOf(`### [${COUNSELING.crisis.resourcePackId}]`);
    expect(at, '本领域的资源卡没进 prompt').toBeGreaterThan(-1);
    const attached = p.slice(at);
    expect(attached).toContain('12356');
    expect(attached).toContain('顺序');
  });

  it('缺省领域那三个号码一个都不出现在这一轮里（本票修掉的就是这件事）', () => {
    const p = promptOf();
    for (const phone of ['800-810-1117', '010-82951332']) {
      expect(p, `counseling 的危机窗内出现了缺省领域的号码 ${phone}`).not.toContain(phone);
    }
  });

  it('卡上标 forbidden 的号码也不出现（希望 24 热线）', () => {
    const card = knowledge.get(COUNSELING.crisis.resourcePackId)!;
    const banned = [...bannedHotlines(card.facts)];
    expect(banned.length, '卡上没有 forbidden 号码，本条恒真').toBeGreaterThan(0);
    const p = promptOf();
    const at = p.indexOf('> ⚠️ **本卡使用限制**');
    expect(at).toBeGreaterThan(-1);
    for (const b of banned) expect(p.slice(at), `被禁的 ${b} 出现在贴附指令里`).not.toContain(b);
  });
});
