// 能力注册表的结构守卫 + 共用层领域中立守卫。
//
// 这两条都是「读得出来的清单」类判据：注册表是全站唯一真源（MCP tools/list、
// /api/manifest、接入说明能力表都由它生成），一条填错的元数据会同时错在三个出口，
// 而三处看起来都完全正常。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { CAPABILITIES, getCapability, listCapabilities } from '..';

const CAP_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC_ROOT = path.resolve(CAP_ROOT, '..', '..');

const FAMILIES = [
  'case',
  'timeline',
  'actions',
  'claims',
  'deadlines',
  'evidence',
  'knowledge',
  'drafts',
  'company',
  'emotion',
  'docs',
  'report',
  'account',
  'referral',
];
const SCOPES = ['case:read', 'case:write'];
const KINDS = ['read', 'write', 'spend'];
const SURFACES = ['mcp', 'site'];
const PRECONDITIONS = ['realname', 'balance', 'emotion_consent', 'facts_token'];

describe('注册表结构守卫', () => {
  it('name 唯一（变异：复制一条能力改个别字段但留同名 → 红）', () => {
    const names = CAPABILITIES.map((c) => c.name);
    const dup = names.filter((n, i) => names.indexOf(n) !== i);
    expect(dup, `注册表里有重名能力：${dup.join(', ')}`).toEqual([]);
  });

  it('每条的 family / scope / kind / exposeTo / domains / precondition 都合法', () => {
    for (const c of CAPABILITIES) {
      expect(FAMILIES, `${c.name}.family`).toContain(c.family);
      expect(SCOPES, `${c.name}.scope`).toContain(c.scope);
      expect(KINDS, `${c.name}.kind`).toContain(c.kind);

      // 空 exposeTo 的能力谁都看不见——它不是"暂时不暴露"，它是一条写了等于没写的条目
      expect(c.exposeTo.length, `${c.name}.exposeTo 不能为空`).toBeGreaterThan(0);
      for (const s of c.exposeTo) expect(SURFACES, `${c.name}.exposeTo`).toContain(s);

      // 同理：空 domains 会被 listCapabilities 的领域过滤全部滤掉
      expect(c.domains.length, `${c.name}.domains 不能为空`).toBeGreaterThan(0);
      for (const p of c.precondition) expect(PRECONDITIONS, `${c.name}.precondition`).toContain(p);
    }
  });

  /**
   * kind 与 scope 必须对得上。**这条比"取值在枚举里"更有牙**：
   * 一条 kind:'write' 却挂着 case:read 的能力，会让只读 key 写档案——
   * 鉴权那侧只看 scope，它不会觉得有任何不对。
   */
  it('read 的能力用 case:read，write/spend 的用 case:write（变异：把某条写能力的 scope 改成 case:read → 红）', () => {
    for (const c of CAPABILITIES) {
      expect(c.scope, `${c.name} 的 kind=${c.kind}`).toBe(
        c.kind === 'read' ? 'case:read' : 'case:write',
      );
    }
  });

  it('每条都有 title / description / object 型 inputSchema / run', () => {
    for (const c of CAPABILITIES) {
      expect(c.title, `${c.name}.title`).toBeTruthy();
      expect(c.description, `${c.name}.description`).toBeTruthy();
      expect(c.inputSchema.type, `${c.name}.inputSchema.type`).toBe('object');
      expect(typeof c.run, `${c.name}.run`).toBe('function');
    }
  });

  it('读能力不声明幂等约定（idempotency 是写侧的东西）', () => {
    for (const c of CAPABILITIES) {
      if (c.kind === 'read') expect(c.idempotency, `${c.name}`).toBeUndefined();
    }
  });

  it('listCapabilities 按暴露面与领域过滤，且保持注册表顺序', () => {
    const mcp = listCapabilities({ exposeTo: 'mcp' });
    expect(mcp.map((c) => c.name)).toEqual(
      CAPABILITIES.filter((c) => c.exposeTo.includes('mcp')).map((c) => c.name),
    );
    // domains 全是 ['*'] 时，给不给 domain 结果一样；给一个谁都不认的领域也一样
    expect(listCapabilities({ exposeTo: 'mcp', domain: '不存在的领域' }).map((c) => c.name)).toEqual(
      mcp.map((c) => c.name),
    );
  });

  it('getCapability 按名取，取不到回 undefined', () => {
    expect(getCapability('case_get')?.name).toBe('case_get');
    expect(getCapability('没有这个能力')).toBeUndefined();
  });
});

// ========== 共用层领域中立 ==========

/** 递归收集 .ts 文件，跳过 __tests__ */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      walk(full, out);
    } else if (name.endsWith('.ts')) {
      out.push(full);
    }
  }
  return out;
}

describe('共用层不许写死领域内容（设计稿 §13-6）', () => {
  /**
   * 领域词一旦散落进共用层，第二个领域接进来时就得去共用代码里把上一个领域留下的
   * 硬编码一条条翻出来——而它们看起来都很正常。所以这里按**文件**拦，不按人记性拦。
   *
   * 领域文案的正本在 lib/domains/<key>.ts；能力条目引用它，对外那几句话逐字不变。
   */
  // 「用人单位」是**对方主体在某一个领域里的称呼**（领域包的 parties.counterparts[0]）。
  // 它比前两个词更容易被顺手写进共用层——工具描述里总要有个词指代"对面那家"，
  // 而写死它的形态是：第二个领域接进来时，它的用户在工具清单里读到的仍是上一个领域的称呼，
  // 工具照常可用、回包照常正确，只是每句话都在跟他讲另一个行当的事，没有一处会报错。
  const FORBIDDEN = ['劳动', '仲裁', '用人单位'];

  const SHARED_FILES = [
    ...walk(CAP_ROOT),
    path.join(SRC_ROOT, 'lib/domains/registry.ts'),
    // lib/jobs/** 同属共用层：后台任务面向的是「一件材料 + 一种处理方式」，
    // 一旦有人在里面写死了某个领域的词，第二个领域接进来时就得回到任务代码里逐条翻找。
    ...walk(path.join(SRC_ROOT, 'lib/jobs')),
    // lib/cases/report* 同属共用层：个案报告的分节骨架由领域包给，生成器只认 source 键。
    ...['lib/cases/report.ts', 'lib/cases/report-stale.ts'].map((f) => path.join(SRC_ROOT, f)),
    // ↓ P4-W1 清干净并纳入守卫的五处（设计稿 §13-6）。每一处都曾经写着领域字面量，
    //   现在字都搬进了领域包，这里只留机制：
    ...[
      'lib/agent/crisis-opener.ts', // 危机首段的拼装/拆分骨架（话在 DomainPack.crisis）
      'lib/cases/intake.ts', // 首诊校验与落库（字段与逐字回话在 DomainPack.intakeSchema）
      'lib/cases/drafts.ts', // 文书种类与对外清单（在 DomainPack.docKinds / outboundDocKinds）
      'lib/paste/parse.ts', // 粘贴回填的逐条校验（词表按案件领域取）
      'app/_ui/bootstrap.ts', // 低调模式词典（在 DomainPack.copy.neutral）
      // ↓ P4-W3 新增的共用层：敏感级三个出口读的那一份声明（内容全在 DomainPack.sensitive）。
      //   它天生就该进这份名单——这个文件里出现任何一个领域词，都意味着"哪一类信息要保护、
      //   保护它的那句话怎么说"被写死在了共用层，而第二个声明敏感级的领域接进来时，
      //   它的分享页会印着上一个行当的措辞，且照常返回 200。
      'lib/sensitive.ts',
      // ↓ P4-W3 清干净并纳入守卫：首诊「现在做这三件事」的种子表整份搬进了
      //   DomainPack.intakeStageActions，本文件只剩到期时刻与轻重顺序两个换算。
      //   它此前是这份名单外最大的一处敞口——一张**按某个领域的阶段名建键**、
      //   写满那个行当做法的表，住在共用层；第二个领域接进来时 stage 一个都对不上，
      //   `?? []` 给 0 条种子，首诊回包 actionsAdded=0 且不报错。
      'lib/cases/intake-actions.ts',
      // ↓ S2 闸链补齐（2026-09-08）新落的三处共用层。**新写的文件必须当场进这份名单**——
      //   不进的形态是：守卫全绿，因为它没在看那个文件。三处各自的敞口都是具体的：
      //   · gate-chain.ts    闸链顺序表。写死某个领域的失败模式，第二个领域接进来时
      //                      顺序表读起来仍然对，只是它描述的是另一个行当的闸。
      //   · statute-guard.ts 条号闸。它的**回喂指令与 notice 文案会到达模型与用户**，
      //                      写死领域词就等于对第二个领域的用户讲上一个行当的话。
      //   · value-guard.ts   数值闸。同上，且它的单位表（元/倍/%）本身必须保持通用。
      'lib/agent/gate-chain.ts',
      'lib/agent/statute-guard.ts',
      'lib/agent/value-guard.ts',
    ].map((f) => path.join(SRC_ROOT, f)),
  ];

  it('共用层（lib/capabilities/**、lib/domains/registry.ts、lib/jobs/**、lib/cases/report*、危机骨架、首诊、文书、粘贴、低调模式词典）里没有领域字面量（变异：往 registry.ts 写一句带「仲裁」的注释、或把工具描述里的「对方主体」写死成某个领域的称呼 → 红）', () => {
    const hits: string[] = [];
    for (const file of SHARED_FILES) {
      const text = fs.readFileSync(file, 'utf-8');
      for (const word of FORBIDDEN) {
        if (text.includes(word)) hits.push(`${path.relative(SRC_ROOT, file)} 里出现「${word}」`);
      }
    }
    expect(
      hits,
      `共用层出现了领域字面量：\n  ${hits.join('\n  ')}\n` +
        '把这些文案挪到 lib/domains/<key>.ts 的领域包里，由能力条目引用（见 LABOR_CAPABILITY_COPY）。',
    ).toEqual([]);
  });

  it('守卫扫到的确实是那几个文件（空名单会让上面那条永远绿）', () => {
    expect(SHARED_FILES.length).toBeGreaterThanOrEqual(15);
    for (const f of SHARED_FILES) expect(fs.existsSync(f), f).toBe(true);
  });

  /**
   * **lib/cases 里那两份零依赖词表的待清理清单**（不是豁免，2026-09-07 复审点名）。
   *
   * `lib/cases/stages.ts` 与 `lib/cases/milestones.ts` 住在共用层 `lib/cases`，
   * 但两份词表本身是**缺省领域的内容**（阶段名、里程碑名）。领域包引它们
   *（labor.ts 的 `stages` / `journey`），第二个领域自己写自己那份。
   *
   * 【它们为什么不在 SHARED_FILES 里，也不该是盲区】进那份名单会当场红——里面本来就有
   * 领域词。而不写进任何一份名单的形态是：`lib/cases` 这个目录既不在共用层守卫的扫描面里
   *（那份只点名到 report*、intake、drafts 几个文件），也不在页面守卫的扫描面里
   *（那份只扫 app/ 与 components/），于是**往这两个文件里再加一格领域词，两道闸都不响**。
   * 复审当场点过：milestones.ts 是从 index.ts 搬出来的，搬家不算新增违规，
   * 但搬完之后它落在了两道闸中间。
   *
   * 【这条守什么】守「**别再多**」：现存的领域词逐行钉住，多一行即红。
   * 真把词表搬进领域包了（`lib/cases` 只剩机制），这条也会红——那时把文件加进 SHARED_FILES
   * 并删掉本条。
   */
  it('lib/cases 的词表文件里领域字面量只剩已知那几行（变异：往 milestones.ts 再加一格带「仲裁」的里程碑 → 红）', () => {
    const known: Record<string, string[]> = {
      'lib/cases/stages.ts': ["  '仲裁准备',"],
      'lib/cases/milestones.ts': ["  '仲裁申请',"],
    };
    for (const [rel, expected] of Object.entries(known)) {
      const file = path.join(SRC_ROOT, rel);
      expect(fs.existsSync(file), `${rel} 不在了：把本条里对应那一项删掉`).toBe(true);
      const hits = fs
        .readFileSync(file, 'utf-8')
        .split('\n')
        .filter((line) => FORBIDDEN.some((w) => line.includes(w)));
      expect(
        hits,
        `${rel} 的领域字面量清单变了。\n` +
          '缺什么：这个文件不在任何一道闸的扫描面里（共用层守卫按文件点名、页面守卫只扫 app/ 与 components/）。\n' +
          '为什么缺：它是从 lib/cases/index.ts 搬出来的零依赖词表，搬家时没人把闸跟着挪。\n' +
          '怎么办：新加的那一格搬进 lib/domains/<key>.ts；真把整份词表搬走了，' +
          '把这个文件加进 SHARED_FILES 并删掉本条对应的那一项。',
      ).toEqual(expected);
    }
  });

  /**
   * **lib/agent/crisis.ts 的待清理清单**（不是豁免）。
   *
   * 危机层是共用层，但它现在还进不了上面那份名单：出口闸的 `LEGAL_MONEY_CONTEXT`
   * 正则与解释它的那段注释里，写着一个领域的钱款词表——那份词表要搬进领域包才算清完，
   * 而搬它会动到一条带否决权的红线，不该顺手做（本票 notDone 已点名，留给后续票）。
   *
   * 【那这条判据在守什么】守「**别再多**」。crisis.ts 不在扫描名单里意味着往它任何一处
   * 写下领域字面量都不会红——这一票就在新加的一段头注释里写进过一个「劳动者」，
   * 没有任何一条判据点它的名。所以这里把现存的那几处逐行钉住：多一处即红，
   * 少一处（真搬走了）也红，提醒把 crisis.ts 挪进 SHARED_FILES。
   */
  it('lib/agent/crisis.ts 里的领域字面量只剩已知那几行（变异：往 crisis.ts 任一注释里写一个「劳动」 → 红）', () => {
    const file = path.join(SRC_ROOT, 'lib/agent/crisis.ts');
    const hits = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => FORBIDDEN.some((w) => line.includes(w)));

    // 只有两处，且都属于出口闸的「法律钱款语境」那一段（正则本身 + 解释它的注释）
    expect(
      hits,
      'crisis.ts 的领域字面量清单变了。多出来的那行请搬进 DomainPack；' +
        '真把 LEGAL_MONEY_CONTEXT 搬进领域包了，就把 crisis.ts 加进 SHARED_FILES 并删掉这条。',
    ).toEqual([
      '* 【为什么必须有这条（评测官 2026-08-26 造对抗样本查实）】劳动补偿的语言天生长成单价形状：',
      String.raw`/补偿|赔偿|工资|薪资|加班费|年假|社保|公积金|双倍|违法解除|经济性裁员|裁员|离职|解除|仲裁|诉讼|律师费|开庭|协议|调解|折算|工龄|欠薪|拖欠|押金|罚款|代通知金|N\s*[+＋]\s*1|2\s*N|方案是\s*N/;`,
    ]);
  });

  /**
   * **lib/agent/case-facts.ts 的待清理清单**（同上，不是豁免）。
   *
   * 事实卡渲染器是共用层，但它也还进不了 SHARED_FILES：实名那一节里逐字写着
   *「姓名只用于……（某某申请书、通知函、授权书）」，那句话要搬进领域包才算清完。
   *
   * 【这条在守什么】守「**别再多**」。本文件此前一整节（basics 四行）都写着上一个行当的
   * 名词（入职日期 / 岗位 / 月工资 / 合同签订次数），而 FORBIDDEN 那三个词一个都不沾——
   * 于是没有任何一条判据点它的名，直到有人逐行读第二个领域的事实卡才发现。
   * 那四行现在按 DomainPack.factsBasics 取（判据在 domains/__tests__/counseling-pack.test.ts），
   * 这里把剩下的那一处钉住：多一处即红，少一处（真搬走了）也红。
   */
  it('lib/agent/case-facts.ts 里的领域字面量只剩已知那一行（变异：往它任一注释里写一个「劳动」 → 红）', () => {
    const file = path.join(SRC_ROOT, 'lib/agent/case-facts.ts');
    const hits = fs
      .readFileSync(file, 'utf-8')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => FORBIDDEN.some((w) => line.includes(w)));

    expect(
      hits,
      'case-facts.ts 的领域字面量清单变了。多出来的那行请搬进 DomainPack（分节抬头看 factsSections，' +
        'basics 那四行看 factsBasics）；这一行真搬走了，就把 case-facts.ts 加进 SHARED_FILES 并删掉这条。',
    ).toEqual([
      "'- 这个姓名只用于用户明确要求的文书填写（仲裁申请书、通知函、授权书等）；' +",
    ]);
  });
});
