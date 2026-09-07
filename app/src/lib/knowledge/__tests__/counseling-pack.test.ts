// app/src/lib/knowledge/__tests__/counseling-pack.test.ts
// 心理咨询纠纷领域包（`domain: counseling`）的内容守卫（设计稿 §16 / P4-W2）。
//
// 【这道闸守的不是"卡写得好不好"，而是三类会静默发生的坏事】
//  ① **索引与盘上不一致**：卡在盘上、index 里没有 domain（或反过来），
//     于是"按领域检索"在上线那天返回一个正确的 200 与一批别的领域的卡；
//  ② **核实状态被悄悄升档**：伦理守则条文只能人工核对 PDF，一旦有人把它标成"原文核实"，
//     未经核对的条号就会被写进伦理申诉答辩书——而没有任何一处会报错；
//  ③ **纪律条款被删掉**：四张解释存疑卡里的那句"本问题现行法律解释存疑：以下是依据原文与分歧点，土八鼠不下结论"、
//     热线卡里"只认 12356"的口径、对外文书的发出后果段——删掉之后卡片照常可读、照常被检索到。
//
// 判据一律读**真实的 knowledge/**（不是夹具），因为要防的正是"真实库与索引跑偏"。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { DEFAULT_DOMAIN } from '@/lib/domains/registry';

const KNOWLEDGE_DIR = path.resolve(__dirname, '../../../../../knowledge');
const COUNSELING_DIR = path.join(KNOWLEDGE_DIR, 'packs', 'counseling');
const DOMAIN = 'counseling';

interface IndexEntry {
  id: string;
  type: string;
  title: string;
  path: string;
  confidence: string;
  sources: string[];
  domain?: string;
  facts?: {
    hotlines?: Array<{ phone: string; status: string; hours?: string }>;
    case_facts?: Record<string, unknown>;
  };
}

const INDEX: IndexEntry[] = JSON.parse(
  fs.readFileSync(path.join(KNOWLEDGE_DIR, 'index.json'), 'utf-8'),
);
const COUNSELING = INDEX.filter((e) => e.domain === DOMAIN);

/** 卡片正文（剥掉 frontmatter），按 id 取 */
function body(id: string): string {
  const entry = COUNSELING.find((e) => e.id === id);
  if (!entry) throw new Error(`counseling 包里没有这张卡：${id}`);
  const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, entry.path), 'utf-8');
  const m = /^---\n[\s\S]*?\n---\n([\s\S]*)$/.exec(raw);
  if (!m) throw new Error(`${entry.path} 缺少 frontmatter`);
  return m[1];
}

/** 盘上 counseling 目录里的全部卡文件（相对 knowledge/） */
function filesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir)) {
      const p = path.join(dir, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (name.endsWith('.md')) out.push(path.relative(KNOWLEDGE_DIR, p));
    }
  };
  walk(COUNSELING_DIR);
  return out.sort();
}

describe('index ⇄ packs/counseling/ 双向一致（变异：删掉任一张卡的 domain 字段 → 红）', () => {
  it('判据自身不是空跑：counseling 包不是空的', () => {
    expect(COUNSELING.length).toBeGreaterThan(30);
  });

  it('盘上的每张 counseling 卡都在 index 里、且带 domain=counseling', () => {
    const disk = filesOnDisk();
    const indexed = COUNSELING.map((e) => e.path).sort();
    expect(
      indexed,
      '盘上有卡而 index 里没有（或 index 里那条缺 domain）⇒ 按领域检索会静默漏掉它',
    ).toEqual(disk);
  });

  it('index 里标 counseling 的每一条，文件都在 packs/counseling/ 下且真实存在', () => {
    for (const e of COUNSELING) {
      expect(e.path.startsWith('packs/counseling/'), `${e.id} 的 path 不在 counseling 包内：${e.path}`).toBe(true);
      expect(fs.existsSync(path.join(KNOWLEDGE_DIR, e.path)), `${e.id} 指向的文件不存在`).toBe(true);
    }
  });

  /**
   * 【本条在 P4-W3 改过口径，原因写在这里】W2 写它时生成器只给显式声明了 domain 的卡
   * 导出这个字段，于是"既有卡一张都没有 domain"是可观测的。W1 把生成器改成
   * **每一条都导出 domain**（没声明的补成缺省领域），这条按原样只能整条删掉。
   *
   * 它真正要守的是同一件事的另一面：**这一票只往里加，不把既有的卡挪进新领域**。
   * 挪走一张的形态是——那张卡从此对缺省领域的用户不可见，而检索照常返回 200。
   */
  it('标 counseling 的卡与 packs/counseling/ 目录**互为充要**（变异：把一张既有卡的 domain 改成 counseling → 红）', () => {
    const strayDomain = INDEX.filter((e) => e.domain === DOMAIN && !e.path.startsWith('packs/counseling/'));
    const strayPath = INDEX.filter((e) => e.path.startsWith('packs/counseling/') && e.domain !== DOMAIN);
    expect(
      strayDomain.map((e) => `${e.id}（${e.path}）`),
      '这些卡不在 counseling 目录下却标了 counseling：既有卡被挪进了新领域',
    ).toEqual([]);
    expect(
      strayPath.map((e) => `${e.id}（domain=${e.domain ?? '（无）'}）`),
      '这些卡在 counseling 目录下却不标 counseling：它们对两边的用户都不可见',
    ).toEqual([]);
  });
});

describe('设计稿 §16 的知识包清单齐备（变异：删掉任一张卡 → 红）', () => {
  const REQUIRED_IDS: Record<string, string[]> = {
    法条卡: [
      'statute-jswsf-23-zixun-bianjie',
      'statute-jswsf-28-30-31-weiji-songyi',
      'statute-grxxbhf-28-31-mingan-xinxi',
      'statute-mfd-1032-1033-yinsi',
      'statute-mfd-933-weituo-jiechu',
      'statute-mfd-188-susong-shixiao',
      'statute-xbf-26-55-geshi-tiaokuan-chengfa',
      // 伦理卡沿用「法条卡」这一类型（卡片类型体系跨领域不变，设计稿 §13）
      'ethic-lunli-3-2-baomi-liwai',
      'ethic-lunli-1-8-1-10-shuangchong-guanxi',
      'ethic-lunli-8-2-8-3-yuancheng-fuwu',
    ],
    流程SOP: [
      'sop-tuifei-zhengyi',
      'sop-liaoxiao-zhengyi',
      'sop-jianguan-xiehui-tousu',
      'sop-mingyu-qinquan-yingdui',
      'sop-yinsi-xielou-zhikong',
      'sop-lunli-shensu-yingdui',
      'sop-zishang-shijian-zhuize',
      'sop-zhiqing-tongyi-quexian',
    ],
    文书模板: [
      'template-zhiqing-tongyishu',
      'template-baomi-gaozhi-liwai',
      'template-weiji-chuzhi-jilu',
      'template-zhuanjie-han',
      'template-tousu-dafu-han',
      'template-tuifei-xieyi',
      'template-tingzhi-fuwu-tongzhi',
      'template-lvshihan-yingdui-yaodian',
      'template-lunli-shensu-dabianshu',
    ],
    数据卡: ['data-counseling-weiji-rexian', 'data-counseling-shixiao-qixian'],
    // 判例卡原有 3 张。2026-09-07 核实员第 3 批复核：case-guge-mingyu-quan（唯一来源是
    // 代理律所官网宣传文章，追不到 .gov.cn 或法院/协会自己发布的原文）与
    // case-dongni-lisongwei-weizhongshen（卡片自述"未终审"，且唯一来源是新闻转载）均已移入
    // knowledge/quarantine/counseling/cases/（原因见各卡【隔离原因】块与 knowledge/quarantine/README.md
    // 第 13 批），不再进 index，故不再要求这两个 id 在 counseling 包内。
    // case-sichuan-tuifei-7500 已在四川省高级人民法院官网找到官方原文并核实，confidence 升为原文核实。
    判例卡: ['case-sichuan-tuifei-7500'],
    方法卡: [
      'method-counseling-panli-heyan',
      'risk-qiangzhi-baogao-zhuti',
      'risk-hetong-dingxing',
      'risk-jilu-baocun-nianxian',
      'risk-difang-xuke-beian',
    ],
    话术卡: ['script-laifang-tousu-goutong', 'script-weiji-tonghua-huashu'],
  };

  for (const [type, ids] of Object.entries(REQUIRED_IDS)) {
    it(`${type}：${ids.length} 张都在，且 type 对得上`, () => {
      for (const id of ids) {
        const e = COUNSELING.find((x) => x.id === id);
        expect(e, `counseling 包缺卡：${id}`).toBeDefined();
        expect(e!.type, `${id} 的 type 不对`).toBe(type);
      }
    });
  }

  it('SOP 恰好覆盖 8 类纠纷，文书模板恰好 9 类（多写少写都要有人看见）', () => {
    expect(COUNSELING.filter((e) => e.type === '流程SOP')).toHaveLength(8);
    expect(COUNSELING.filter((e) => e.type === '文书模板')).toHaveLength(9);
  });
});

describe('🔴 核实纪律：伦理守则第二版已用官方 HTML 全文逐字核实（2026-09-07 解除 H1）', () => {
  // 【前提变了，闸门跟着改】原判据钉的是"学会官方 PDF 机器抽取不可靠，不许凭机抽结果升档"——
  // 这句话本身没错，但它挡的是"PDF"，不是"这份守则永远核不动"。2026-09-07 核实员找到
  // 同一份《守则（第二版）》的**非 PDF** 一手源：journal.psych.ac.cn 的期刊网页版
  // （《心理学报》2018 年第 50 卷第 11 期，中国心理学会主办、临床心理学注册工作委员会撰写并
  // 代表学会发布），已按 kind=行业规范 登记（knowledge/sources.json 的 lunli-shouze-di2ban），
  // HTML 属 fetch-source.py DERIVABLE_KINDS 的确定性抽取格式，三张卡共 10 条 statute_quotes
  // 逐条经 scripts/verify-quotes.py 核对一致。继续钉着「待核实」会变成把"防止机抽 PDF 蒙混"
  // 的旧纪律，用在一个已经不涉及 PDF 抽取的新状态上——纪律没有跟着解除条件走。
  const ETHIC_IDS = [
    'ethic-lunli-3-2-baomi-liwai',
    'ethic-lunli-1-8-1-10-shuangchong-guanxi',
    'ethic-lunli-8-2-8-3-yuancheng-fuwu',
  ];

  it.each(ETHIC_IDS)('%s 标「原文核实」，来源是登记在册的行业规范页（journal.psych.ac.cn）', (id) => {
    const e = COUNSELING.find((x) => x.id === id)!;
    expect(e.confidence, `${id} 的 confidence 应为原文核实`).toBe('原文核实');
    expect(
      e.sources.some((s) => s.startsWith('https://journal.psych.ac.cn/')),
      `${id} 的来源应指向守则第二版的登记页`,
    ).toBe(true);
  });

  it.each(ETHIC_IDS)('%s 带逐字核过的 facts.statute_quotes，并写明 source_id 消歧', (id) => {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, COUNSELING.find((x) => x.id === id)!.path), 'utf-8');
    expect(raw.includes('statute_quotes'), `${id} 应带 facts.statute_quotes（逐字核过才可标原文核实）`).toBe(
      true,
    );
    expect(raw.includes('lunli-shouze-di2ban'), `${id} 的引文应写明 source_id 指名登记原件`).toBe(true);
  });
});

describe('🔴 核实纪律：标「原文核实」的卡，来源必须是官方源', () => {
  // 白名单收官方域（国家法律法规数据库、人大、政府网、法院、检察院、网信办），
  // 外加登记在册的 kind=行业规范 机构官网（学会伦理守则一类，见 knowledge/sources.json）。
  // 变异：把某张法条卡的 source 换成期刊/新闻页而保留「原文核实」→ 红。
  const OFFICIAL = /^https?:\/\/([a-z0-9-]+\.)*(npc\.gov\.cn|gov\.cn|court\.gov\.cn|spp\.gov\.cn)\//;
  // kind=行业规范，issuer=中国心理学会，登记见 knowledge/sources.json 的 lunli-shouze-di2ban。
  const INDUSTRY_STANDARD = /^https?:\/\/journal\.psych\.ac\.cn\//;

  it('每张 confidence=原文核实 的 counseling 卡，其 sources 全部落在官方域或登记在册的行业规范域', () => {
    const verified = COUNSELING.filter((e) => e.confidence === '原文核实');
    expect(verified.length, '一张原文核实的卡都没有 ⇒ 这条判据在空跑').toBeGreaterThan(6);
    for (const e of verified) {
      for (const s of e.sources) {
        expect(
          OFFICIAL.test(s) || INDUSTRY_STANDARD.test(s),
          `${e.id} 标了原文核实，但来源不是官方源也不是登记在册的行业规范域：${s}`,
        ).toBe(true);
      }
    }
  });

  it('七张法条卡（非伦理卡）全部是原文核实，且正文带取回日期', () => {
    const ids = [
      'statute-jswsf-23-zixun-bianjie',
      'statute-jswsf-28-30-31-weiji-songyi',
      'statute-grxxbhf-28-31-mingan-xinxi',
      'statute-mfd-1032-1033-yinsi',
      'statute-mfd-933-weituo-jiechu',
      'statute-mfd-188-susong-shixiao',
      'statute-xbf-26-55-geshi-tiaokuan-chengfa',
    ];
    for (const id of ids) {
      expect(COUNSELING.find((e) => e.id === id)!.confidence, id).toBe('原文核实');
      expect(body(id), `${id} 正文没写取回日期`).toMatch(/取回日期\s*2026-09-06/);
    }
  });
});

describe('🔴 四张解释存疑风险卡：那句输出闸不能被删', () => {
  const RISK_IDS = [
    'risk-qiangzhi-baogao-zhuti',
    'risk-hetong-dingxing',
    'risk-jilu-baocun-nianxian',
    'risk-difang-xuke-beian',
  ];

  /**
   * 【这句话 2026-09-07 晚换过一次，换的是理由不是闸】原话是"未经律师书面确认不得作为
   * 结论输出"。主理人裁决：**没有律师签字这回事**——闸留着（只给依据原文与分歧点、
   * 不下结论），换掉的是它的理由：不是"等谁来签字"，是法律解释本身就存疑。
   *
   * 【为什么下一条把"律师"两个字一并钉成不许出现】只改闸不改理由的形态是：卡上写着
   * "解释存疑"，下一节仍写着"等律师书面确认"——两种说法在同一张卡上并存，
   * 而模型照旧照后一句办、把用户支给一个不会来的签字，卡片照常可读、照常被检索到。
   */
  it.each(RISK_IDS)('%s 正文含那句输出闸（变异：删掉该句 → 红）', (id) => {
    expect(body(id)).toContain('本问题现行法律解释存疑：以下是依据原文与分歧点，土八鼠不下结论');
  });

  it.each(RISK_IDS)('%s 卡内一处「律师」都不剩（变异：把旧口径写回任一节 → 红）', (id) => {
    const hit = body(id).split('\n').filter((l) => l.includes('律师'));
    expect(hit, `${id} 还留着旧口径（主理人裁决：没有律师签字这回事）：\n  ${hit.join('\n  ')}`).toEqual([]);
  });

  // 【2026-09-07 收口：这四张从「待核实」升到「原文核实」，升的是出处不是结论】
  // 原判据写着"拿不准的事不许标已核实"——那句话对的是**出处**那一面，而这四张卡拿不准的
  // 从来不是出处，是**法律结论**（强制报告主体范围、合同定性、记录年限、地方许可）。
  // 这类问题不是"再找一份官方文件就能解决"的：它要的是现行法律解释本身有定论。
  // 收口时把每一处外部原文都追到了官方原件并逐字核过（见下一条），于是：
  //   · confidence 记 `原文核实` —— 说的是"这张卡断言的每句外部事实都指得出原件在哪"；
  //   · 🔒 输出闸 + 标题里的「解释存疑」 —— 说的是"法律结论没定，不许当结论输出"。
  // 两件事分开记，是因为它们的解除条件不同：前者靠追源，后者靠法律解释有定论。
  // 继续钉 `待核实` 的代价不是"更保守"，而是这四张卡**整体退出可用索引**（扎根守卫 (d)
  // 只放行 原文核实/无外部断言），于是 agent 在本领域风险最高的四个话题上**一张卡都看不到**，
  // 那几道 🔒 输出闸也跟着消失——比"标错一个档"坏得多。
  it.each(RISK_IDS)('%s 标「原文核实」：出处这一面已逐字核过', (id) => {
    expect(COUNSELING.find((e) => e.id === id)!.confidence, id).toBe('原文核实');
  });

  it.each(RISK_IDS)('%s 带逐字核过的 facts 引文，且正文有【解释存疑】标记可 grep', (id) => {
    const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, COUNSELING.find((e) => e.id === id)!.path), 'utf-8');
    expect(
      /facts:\s*\n\s+(statute_quotes|case_quotes):/.test(raw),
      `${id} 标了原文核实却没有一条 facts 引文——那这张卡凭什么说"核过原文"`,
    ).toBe(true);
    expect(
      body(id),
      `${id} 正文没有【解释存疑】标记：grep 不到就等于没登记，` +
        '维护者会以为这张卡的结论已经可以直接用',
    ).toMatch(/【解释存疑】/);
  });

  it('四张风险卡都在 knowledge/TODO核实清单.md §H2 里被 id 点名（变异：删掉任一行 → 红）', () => {
    const doc = fs.readFileSync(path.join(KNOWLEDGE_DIR, 'TODO核实清单.md'), 'utf-8');
    const missing = RISK_IDS.filter((id) => !doc.includes(id));
    expect(missing, `这些风险卡没在清单里登记：${missing.join('、')}`).toEqual([]);
  });
});

describe('🔴 危机热线口径：只认 12356 及其官方出处', () => {
  it('counseling 域内 status=usable 的号码只有 12356 / 110 / 120', () => {
    const usable = COUNSELING.flatMap((e) => e.facts?.hotlines ?? [])
      .filter((h) => h.status === 'usable')
      .map((h) => h.phone)
      .sort();
    expect(usable).toEqual(['110', '120', '12356']);
  });

  it('「希望24热线」记为 forbidden（非官方发布，本包不输出）', () => {
    const forbidden = COUNSELING.flatMap((e) => e.facts?.hotlines ?? [])
      .filter((h) => h.status === 'forbidden')
      .map((h) => h.phone);
    expect(forbidden).toContain('400-161-9995');
  });

  it('12356 的官方出处（国卫医政函〔2024〕259号）逐字进了热线卡正文', () => {
    const t = body('data-counseling-weiji-rexian');
    expect(t).toContain('国卫医政函〔2024〕259 号');
    // 引号用官方页面的**弯引号**（gov.cn 原文如此）。判据钉直引号的形态是：
    // 后人照官方原文把引号改回去，判据反而红——把一个非逐字的形态钉成了标准。
    expect(t).toContain('我委协调工业和信息化部设置“12356”作为全国统一心理援助热线电话号码。');
    expect(t).toContain('实现拨打“12356”电话号码接通心理援助热线的功能。');
    // 官方给的是「每日不少于18小时」，不是 24 小时——升级成 24 小时就是编数字
    expect(t).toContain('每日提供不少于18小时心理援助服务');
    expect(t).not.toMatch(/12356[^\n]*24\s*小时/);
  });
});

describe('🔴 热线服务时间：盯的是 facts.hours（代码读的那一面），不是正文散文', () => {
  // 【为什么正文判据不够】README §2.1：代码只读 facts，禁啃正文。
  // knowledge_search 的可用热线表、危机路径输出的服务时间，取的都是 facts.hotlines[].hours。
  // 只盯正文的形态是——把 facts 的 hours 从「每日不少于18小时」改成「24小时」、正文一个字不动，
  // 生成器过、上面那条正文判据全绿，而 agent 转给来访的服务时间已经是编出来的 24 小时。
  const CARD = 'data-counseling-weiji-rexian';
  const hotlines = () => COUNSELING.find((e) => e.id === CARD)!.facts!.hotlines!;
  /** 空白/加粗符归一，与生成器 normalize 同口径（正文写「18 小时」、facts 写「18小时」） */
  const norm = (t: string) => t.replace(/[\s>＞*　]/g, '');

  it('12356 的 facts.hours 就是官方口径「每日不少于18小时」（变异：改成 24小时 → 红）', () => {
    const h = hotlines().find((x) => x.phone === '12356')!;
    expect(h.hours, '12356 的服务时间被改动了：官方 259 号文给的是最低要求「每日不少于18小时」').toBe(
      '每日不少于18小时',
    );
    expect(h.hours).not.toMatch(/24\s*小时/);
  });

  it('每条 usable 热线的 facts.hours 都能在正文号码表**它自己那一行**里逐字找到', () => {
    const t = body(CARD);
    const rows = t.split('\n').filter((line) => line.trim().startsWith('|'));
    for (const h of hotlines()) {
      if (h.status !== 'usable') continue;
      expect(h.hours, `${h.phone} 是 usable 却没有 hours（代码要拿它显示服务时间）`).toBeTruthy();
      const own = rows.filter((line) => norm(line).includes(norm(h.phone)));
      expect(own.length, `正文号码表里找不到 ${h.phone} 那一行，两面无从比对`).toBe(1);
      const cells = own[0].split('|').map(norm);
      expect(
        cells,
        `${h.phone}：facts 写「${h.hours}」，而正文那一行里没有这个服务时间——` +
          '两面分叉时代码用的是 facts，用户看到的是 facts，正文只是没人读的说明',
      ).toContain(norm(h.hours!));
    }
  });
});

describe('🔴 对外文书必带发出后果；内部记录不得带', () => {
  const OUTBOUND = [
    'template-zhiqing-tongyishu',
    'template-baomi-gaozhi-liwai',
    'template-zhuanjie-han',
    'template-tousu-dafu-han',
    'template-tuifei-xieyi',
    'template-tingzhi-fuwu-tongzhi',
    'template-lvshihan-yingdui-yaodian',
    'template-lunli-shensu-dabianshu',
  ];

  it.each(OUTBOUND)('%s 有「发出后果（send_consequences）」段（变异：删掉该段 → 红）', (id) => {
    expect(body(id)).toMatch(/##\s*发出后果（send_consequences）/);
  });

  it('危机处置记录是内部记录：不写发出后果，且明写不送达', () => {
    const t = body('template-weiji-chuzhi-jilu');
    expect(t).not.toMatch(/##\s*发出后果/);
    expect(t).toContain('**不送达。**');
  });
});

describe('🔴 判例纪律：无真实案号绝不编造；未终审要标出来', () => {
  // 原有 3 张判例卡，2026-09-07 核实员第 3 批复核后只剩 1 张在包内：
  // case-guge-mingyu-quan、case-dongni-lisongwei-weizhongshen 均已移入
  // knowledge/quarantine/counseling/cases/（原因同上一节的说明），不再是 COUNSELING 的一员，
  // 下面两条正文纪律改为直接读隔离区文件核对（内容一字未改，只是移动了位置）。
  const CASE_IDS = ['case-sichuan-tuifei-7500'];

  it.each(CASE_IDS)('%s 的 facts.case_facts 不含 case_no（没有就是没有，不填占位）', (id) => {
    const e = COUNSELING.find((x) => x.id === id)!;
    expect(e.facts?.case_facts).toBeDefined();
    expect(Object.keys(e.facts!.case_facts!)).not.toContain('case_no');
  });

  it('在包判例卡都不出现形如 (2024)京0491民初1号 的案号（编造案号的典型形态）', () => {
    for (const id of CASE_IDS) {
      expect(body(id), `${id} 出现了案号样式的字符串`).not.toMatch(/[（(]\s*\d{4}\s*[)）]\s*[一-龥]/);
    }
  });

  it('冬妮案（隔离区）仍标「未终审」，并禁止被当作裁判倾向', () => {
    const t = fs.readFileSync(
      path.join(KNOWLEDGE_DIR, 'quarantine/counseling/cases/dongni-lisongwei-weizhongshen.md'),
      'utf-8',
    );
    expect(t).toContain('未终审');
    expect(t).toContain('不可用（仅内部参考）');
  });
});

describe('🔴 收口后：counseling 包一张「待核实」/「二手转述」都不许有', () => {
  // 【这个 describe 换了盯的东西，不是删了】原来它盯的是"待核实的卡必须有【待核实】标记 +
  // 逐卡登记在清单里"——那套机制服务的是"库里长期躺着待核实卡"的形态。
  // 2026-09-07 收口后那个形态没有了：GROUNDING_PENDING 已删，扎根守卫 (d) 只放行
  // 原文核实/无外部断言，一张待核实卡进索引就是构建期红。
  // 于是这里改成盯**结果**（一张都没有），而"有标记 + 有登记"那套要求原样搬到了上面
  // 四张风险卡那个 describe 里——它们现在挂的是【解释存疑】，同样 grep 得到、
  // 同样逐卡登记在 §H2。**要求没降，只是换了挂钩的那个词。**
  it('counseling 包内没有 confidence=待核实 或 二手转述 的卡', () => {
    const bad = COUNSELING.filter((e) => e.confidence === '待核实' || e.confidence === '二手转述');
    expect(
      bad.map((e) => `${e.id}(${e.confidence})`),
      '这些卡还挂着不可进索引的档——要么核实到原文核实，要么整张移入 knowledge/quarantine/',
    ).toEqual([]);
  });

  it('判据自身不空跑：counseling 包确实有卡，且都落在两个可进索引的档里', () => {
    expect(COUNSELING.length, 'counseling 包一张卡都没读到 ⇒ 上一条恒真，本 describe 在空跑').toBeGreaterThan(
      30,
    );
    const allowed = new Set(['原文核实', '无外部断言']);
    const outliers = COUNSELING.filter((e) => !allowed.has(e.confidence)).map((e) => e.id);
    expect(outliers, `这些卡的 confidence 既非原文核实也非无外部断言：${outliers.join('、')}`).toEqual([]);
  });
});

describe('🔴 来访者信息最小化：全包不得出现真实个人信息样式的串', () => {
  it('没有一张 counseling 卡的正文出现 11 位手机号或 15/18 位证件号样式', () => {
    for (const e of COUNSELING) {
      const t = body(e.id);
      expect(t, `${e.id} 疑似出现手机号`).not.toMatch(/(?<!\d)1[3-9]\d{9}(?!\d)/);
      expect(t, `${e.id} 疑似出现身份证号`).not.toMatch(/(?<!\d)\d{17}[\dXx](?!\d)/);
    }
  });

  it('模板里的来访一律以化名/编号出现（知情同意书与退费协议不收真实姓名字段）', () => {
    expect(body('template-zhiqing-tongyishu')).toContain('本机构档案仅以化名/编号记载');
    expect(body('template-weiji-chuzhi-jilu')).toContain('来访化名/编号');
  });
});
