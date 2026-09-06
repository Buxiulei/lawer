// app/src/lib/knowledge/__tests__/counseling-pack.test.ts
// 心理咨询纠纷领域包（`domain: counseling`）的内容守卫（设计稿 §16 / P4-W2）。
//
// 【这道闸守的不是"卡写得好不好"，而是三类会静默发生的坏事】
//  ① **索引与盘上不一致**：卡在盘上、index 里没有 domain（或反过来），
//     于是"按领域检索"在上线那天返回一个正确的 200 与一批别的领域的卡；
//  ② **核实状态被悄悄升档**：伦理守则条文只能人工核对 PDF，一旦有人把它标成"原文核实"，
//     未经核对的条号就会被写进伦理申诉答辩书——而没有任何一处会报错；
//  ③ **纪律条款被删掉**：四张待律师复核卡里的那句"未经律师书面确认不得作为结论输出"、
//     热线卡里"只认 12356"的口径、对外文书的发出后果段——删掉之后卡片照常可读、照常被检索到。
//
// 判据一律读**真实的 knowledge/**（不是夹具），因为要防的正是"真实库与索引跑偏"。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

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
    hotlines?: Array<{ phone: string; status: string }>;
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

  it('既有劳动卡一张都没有被打上 domain（本票只加不改）', () => {
    const others = INDEX.filter((e) => e.domain !== undefined && e.domain !== DOMAIN);
    expect(others.map((e) => e.id)).toEqual([]);
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
    判例卡: ['case-guge-mingyu-quan', 'case-dongni-lisongwei-weizhongshen', 'case-sichuan-tuifei-7500'],
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

describe('🔴 核实纪律：伦理守则只能人工核对 PDF，不得机器抽取后升档', () => {
  const ETHIC_IDS = [
    'ethic-lunli-3-2-baomi-liwai',
    'ethic-lunli-1-8-1-10-shuangchong-guanxi',
    'ethic-lunli-8-2-8-3-yuancheng-fuwu',
  ];

  it.each(ETHIC_IDS)('%s 必须标「待核实」且正文写明需人工核对 PDF（变异：改成原文核实 → 红）', (id) => {
    const e = COUNSELING.find((x) => x.id === id)!;
    expect(e.confidence, `${id} 被升档了——伦理守则官方 PDF 机器抽取不可靠，本票只能标待核实`).toBe('待核实');
    expect(body(id)).toMatch(/待核实（需人工核对\s*PDF）/);
  });

  it('伦理卡不得把条文塞进 facts.statute_quotes（那是给代码当逐字依据用的面）', () => {
    for (const id of ETHIC_IDS) {
      const raw = fs.readFileSync(path.join(KNOWLEDGE_DIR, COUNSELING.find((x) => x.id === id)!.path), 'utf-8');
      expect(raw.includes('statute_quotes'), `${id} 把未核实条文放进了 statute_quotes`).toBe(false);
    }
  });
});

describe('🔴 核实纪律：标「原文核实」的卡，来源必须是官方源', () => {
  // 白名单只收官方域（国家法律法规数据库、人大、政府网、法院、检察院、网信办）。
  // 变异：把某张法条卡的 source 换成期刊/新闻页而保留「原文核实」→ 红。
  const OFFICIAL = /^https?:\/\/([a-z0-9-]+\.)*(npc\.gov\.cn|gov\.cn|court\.gov\.cn|spp\.gov\.cn)\//;

  it('每张 confidence=原文核实 的 counseling 卡，其 sources 全部落在官方域', () => {
    const verified = COUNSELING.filter((e) => e.confidence === '原文核实');
    expect(verified.length, '一张原文核实的卡都没有 ⇒ 这条判据在空跑').toBeGreaterThan(6);
    for (const e of verified) {
      for (const s of e.sources) {
        // 方法卡的 source 是库内相对路径（引用劳动包的方法本体），不是外部 URL
        if (s.startsWith('knowledge/packs/')) continue;
        expect(OFFICIAL.test(s), `${e.id} 标了原文核实，但来源不是官方源：${s}`).toBe(true);
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

describe('🔴 四张待律师复核风险卡：那句输出闸不能被删', () => {
  const RISK_IDS = [
    'risk-qiangzhi-baogao-zhuti',
    'risk-hetong-dingxing',
    'risk-jilu-baocun-nianxian',
    'risk-difang-xuke-beian',
  ];

  it.each(RISK_IDS)('%s 正文含「未经律师书面确认不得作为结论输出」（变异：删掉该句 → 红）', (id) => {
    expect(body(id)).toContain('未经律师书面确认不得作为结论输出');
  });

  it('四张风险卡都标 待核实（拿不准的事不许标已核实）', () => {
    for (const id of RISK_IDS) expect(COUNSELING.find((e) => e.id === id)!.confidence, id).toBe('待核实');
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
    expect(t).toContain('我委协调工业和信息化部设置"12356"作为全国统一心理援助热线电话号码。');
    // 官方给的是「每日不少于18小时」，不是 24 小时——升级成 24 小时就是编数字
    expect(t).toContain('每日提供不少于18小时心理援助服务');
    expect(t).not.toMatch(/12356[^\n]*24\s*小时/);
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
  const CASE_IDS = ['case-guge-mingyu-quan', 'case-dongni-lisongwei-weizhongshen', 'case-sichuan-tuifei-7500'];

  it.each(CASE_IDS)('%s 的 facts.case_facts 不含 case_no（没有就是没有，不填占位）', (id) => {
    const e = COUNSELING.find((x) => x.id === id)!;
    expect(e.facts?.case_facts).toBeDefined();
    expect(Object.keys(e.facts!.case_facts!)).not.toContain('case_no');
  });

  it('三张判例卡都不出现形如 (2024)京0491民初1号 的案号（编造案号的典型形态）', () => {
    for (const id of CASE_IDS) {
      expect(body(id), `${id} 出现了案号样式的字符串`).not.toMatch(/[（(]\s*\d{4}\s*[)）]\s*[一-龥]/);
    }
  });

  it('冬妮案必须标「未终审」，并禁止被当作裁判倾向', () => {
    const t = body('case-dongni-lisongwei-weizhongshen');
    expect(t).toContain('未终审');
    expect(t).toContain('不可用（仅内部参考）');
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
