/**
 * 「用你自己的 agent」这件事的计费口径守卫。
 *
 * 【为什么要一整组守卫，而不是"写的时候小心点"】这句话要出现在七个地方，
 * 而它的危险形态是**少半句**：把「在你自己的 agent 上处理的对话与案件分析不收费」
 * 写成「对话与案件分析不收费」，页面读起来通顺、排版正常、没有任何报错，
 * 但它承诺的是一件我们不做的事——网页里的每一轮对话都在扣公道值。
 * 这类错漏一次就够，而漏掉的那一处**看起来完全正常**。
 *
 * 所以这里守三层：
 *   ① 句式本身（J1/J2/J5/J6）——三要素齐不齐、低调变体泄不泄漏案情词；
 *   ② 落到文件里的字（J3）——扫七处正文，凡说「不收 / 不扣 / 免费」必须同处带上条件从句；
 *   ③ 文案所依据的事实（J4/J19）——存储那半句与代码是否对得上、
 *      api key 能碰到的扣费路由是不是仍是那两条具名的。
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  BYO,
  BYO_CONDITION,
  BYO_NAME_IS_KEY_NAME,
  byoBillingLine,
  byoConnectedBillingLine,
  byoConnectedLine,
} from '../byoAgent';

const APP = process.cwd();
const SRC = join(APP, 'src');

const NORMAL = byoBillingLine({ credit: '公道值', watch: '守望', discreet: false });
const DISCREET = byoBillingLine({ credit: '额度', watch: '关注', discreet: true });
const BOTH = [NORMAL, DISCREET];

/* ── J1 / J2：句式三要素 ───────────────────────────────── */

describe('J1 条件从句一句都不许掉', () => {
  it('两种模式的计费话术都带着「在你自己的 agent 上」', () => {
    for (const line of BOTH) expect(line).toContain(BYO_CONDITION);
  });

  it('凡是说「不收 / 不扣 / 免费」的输出，必同时带条件从句', () => {
    // 把本模块所有对外话术过一遍，而不是只过 byoBillingLine ——
    // 「已接入」那条短句同样在说"不扣"，漏掉它就是漏掉一整个形态。
    const sayings = [
      ...BOTH,
      byoConnectedBillingLine('公道值'),
      byoConnectedBillingLine('额度'),
      BYO.lead,
      BYO.how,
      BYO.title,
      BYO.titleNeutral,
      byoConnectedLine('claude-code', '2026/09/02 10:00'),
      BYO_NAME_IS_KEY_NAME,
    ];
    for (const s of sayings) {
      if (/免费|不收|不扣/.test(s)) {
        expect(s, `这句说了「不收/不扣/免费」却没带条件从句：${s}`).toContain(BYO_CONDITION);
      }
    }
    // 正对照：上面那个 if 至少进过一次，否则整条断言落在空集上永远绿
    expect(sayings.filter((s) => /免费|不收|不扣/.test(s)).length).toBeGreaterThan(0);
  });
});

describe('J2 三要素齐全——只说「不收」会被读成「接了就全免费」', () => {
  it('两种模式都写明「网页里的对话仍按轮计」与「订阅按用量收」', () => {
    for (const line of BOTH) {
      expect(line).toContain('网页里的对话仍按轮计');
      expect(line).toContain('订阅按用量收');
    }
  });
});

/* ── J5 / J6：低调模式与它的反向对照 ──────────────────── */

describe('J5 低调变体不带案情词', () => {
  it('「仲裁 / 案件 / 劳动 / 维权」一个都不许出现', () => {
    for (const leak of ['仲裁', '案件', '劳动', '维权']) {
      expect(DISCREET).not.toContain(leak);
    }
  });
});

describe('J6 常规变体不含「额度」——反向对照', () => {
  /*
   * 少了这条，把 credit 一律写死成「额度」也能让 J5 绿：
   * 那时低调模式确实不泄漏，代价是常规模式也不再说「公道值」，
   * 而「公道值」是用户在余额卡、流水、充值页看到的**同一个词**。
   */
  it('常规模式说「公道值」，不说「额度」', () => {
    expect(NORMAL).toContain('公道值');
    expect(NORMAL).not.toContain('额度');
  });
});

/* ── J3：落到文件里的字 ────────────────────────────────── */

/** 这句话实际印在哪几个文件里。改口径要动的就是这一串，少列一个等于漏守一处。 */
const COPY_FILES = [
  'src/app/page.tsx',
  'src/app/welcome/page.tsx',
  'src/app/_ui/byoAgent.ts',
  'src/app/_ui/ByoAgentEntry.tsx',
  'src/app/_ui/useConnectedAgent.ts',
  'src/app/(app)/case/[id]/_components/Dashboard.tsx',
  'src/app/(app)/case/[id]/_components/ByoAgentNotice.tsx',
  'src/app/(app)/case/[id]/_components/Workbench.tsx',
  'src/app/(app)/account/_components/AccountView.tsx',
  'src/app/(app)/settings/agent/_components/ConnectGuide.tsx',
  'src/app/(app)/settings/_components/ApiKeysCard.tsx',
  '../skill/接入说明.md',
];

/**
 * 具名整行豁免。**只给整行，不给整个文件**——把某个文件整个排除在外，
 * 排除掉的正是最该看的地方（同 self-host-hint.test 里那条 `lib/billing/` 目录豁免的教训）。
 * 每条都必须在对应文件里**恰好命中一行**，否则本组自己红：豁免过期了要有人回来重读。
 */
const EXEMPT: { file: string; line: string; why: string }[] = [
  {
    file: 'src/app/page.tsx',
    line: '申请劳动仲裁，仲裁委不收费',
    why: '说的是仲裁委不向劳动者收费（《劳动争议调解仲裁法》第五十三条），与本服务的计费无关',
  },
  {
    file: 'src/app/page.tsx',
    line: '依据：《劳动争议调解仲裁法》第五十三条，劳动争议仲裁不收费。',
    why: '同上，法条原文',
  },
  {
    file: 'src/app/(app)/account/_components/AccountView.tsx',
    line: '想省着用：把这里接到你自己的 AI 助手上',
    why:
      'SelfHostHint 是既有段落，字面被 self-host-hint.test 九条钉死（含「href="/settings"」' +
      '必须落在同一段里），本单一个字都不许改。它自带等价的条件表述与更严的一组守卫。',
  },
  {
    file: 'src/app/(app)/account/_components/AccountView.tsx',
    line: '除此之外，任何操作都不扣。',
    why: '同上，SelfHostHint 段内',
  },
  {
    file: 'src/app/(app)/case/[id]/_components/Dashboard.tsx',
    line: '公司档案：先免费查有没有货',
    why:
      '说的是**公司档案自己的免费预览档**（查得到什么先白看，买不买另说），' +
      '与「在你自己的 agent 上处理不收费」是两笔账。买那一步走 dossiers/quote 报价 → ' +
      'dossiers/confirm 扣费，《接入说明》计费节的例外二写着它。' +
      '（本行随 fcc4cb8 的 DossierEntry 一起进入本文件的扫描范围。）',
  },
  {
    file: 'src/app/(app)/case/[id]/_components/Dashboard.tsx',
    line: '这家公司被仲裁过几次、赔没赔、有没有关联主体——免费的那部分先看着。',
    why: '同上，DossierEntry 段内的副标题',
  },
];

/** 那两条 SelfHostHint 豁免的附带条件：它们必须仍与自己的条件从句同段 */
const SELF_HOST_CONDITION = '把这里接到你自己的 AI 助手上';

function read(rel: string): string {
  const p = join(APP, rel);
  if (!existsSync(p)) {
    throw new Error(
      `缺什么：读不到 ${p}。\n` +
        `为什么缺：COPY_FILES 里列的文件被改名或挪走了，本守卫就扫了个空。\n` +
        `怎么办：把 COPY_FILES 里那一项改成新路径。**不要直接删掉它**——` +
        `删掉等于那一处文案从此无人看守，而它看起来一切正常。`,
    );
  }
  return readFileSync(p, 'utf8');
}

/**
 * 抹掉注释，保留行号。
 * 注释不是印在页面上的话，拿它当文案查会让守卫变成跟一段散文较劲
 * （AccountView 的说明注释里就逐字写着「不扣」）。
 * 只抹注释，**字符串与 JSX 文本一律照查**。
 */
function stripComments(src: string, isMarkdown: boolean): string {
  if (isMarkdown) return src;
  const blank = (m: string) => m.replace(/[^\n]/g, ' ');
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, blank)
    .replace(/\/\*[\s\S]*?\*\//g, blank)
    // 前面加一个非 `:` 字符，免得把 https:// 里的双斜杠当成注释
    .replace(/(^|[^:])\/\/[^\n]*/g, (m, p1: string) => p1 + ' '.repeat(m.length - p1.length));
}

describe('J3 结构守卫：文件里凡说「不收 / 不扣 / 免费」，同处必带条件从句', () => {
  it('每条豁免都还恰好命中一行——过期的豁免要有人回来重读', () => {
    for (const e of EXEMPT) {
      const hits = read(e.file)
        .split('\n')
        .filter((l) => l.includes(e.line)).length;
      expect(
        hits,
        `缺什么：豁免「${e.line}」在 ${e.file} 里命中 ${hits} 行，期望恰好 1 行。\n` +
          `为什么缺：那行被改写、删掉或复制成了两份，这条豁免要么已经失效、要么正在替一段` +
          `你没读过的新文案背书。\n怎么办：回去读那一行，确认它还符合豁免理由（${e.why}），` +
          `再决定是改文案还是改这条豁免。`,
      ).toBe(1);
    }
  });

  it('SelfHostHint 的两条豁免仍与它自己的条件从句同段', () => {
    // 豁免不是免检：那段之所以可以不带 BYO_CONDITION，是因为它有一套等价表述。
    // 等价表述被删掉、只剩「不扣公道值」的那天，豁免必须当场作废。
    const text = read('src/app/(app)/account/_components/AccountView.tsx');
    expect(
      text.includes(SELF_HOST_CONDITION),
      `缺什么：AccountView 里找不到「${SELF_HOST_CONDITION}」。\n` +
        `为什么缺：SelfHostHint 那段的条件表述被删或改写了，而 EXEMPT 里那两条豁免` +
        `正是靠它才成立——现在它们在替两句无条件的「不扣」背书。\n` +
        `怎么办：把条件表述加回那一段，或改用 byoBillingLine 统一口径并删掉这两条豁免。`,
    ).toBe(true);
  });

  it('七处正文没有一句无条件的「不收 / 不扣 / 免费」', () => {
    const offenders: string[] = [];
    for (const rel of COPY_FILES) {
      const raw = read(rel);
      const lines = stripComments(raw, rel.endsWith('.md')).split('\n');
      lines.forEach((line, i) => {
        if (!/免费|不收|不扣/.test(line)) return;
        if (EXEMPT.some((e) => e.file === rel && line.includes(e.line))) return;
        // 同行或相邻两行内出现条件从句即可——一句话在源码里换行是常事。
        // 插值 `${BYO_CONDITION}` 同样算数：那是这句话的**唯一来源**，比抄一遍字面更该鼓励。
        const near = lines.slice(Math.max(0, i - 1), i + 2).join('\n');
        if (near.includes(BYO_CONDITION) || near.includes('BYO_CONDITION')) return;
        offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
      });
    }
    expect(
      offenders,
      `缺什么：这些行说了「不收 / 不扣 / 免费」，却没在同行或相邻两行里带上「${BYO_CONDITION}」：\n` +
        `${offenders.join('\n')}\n` +
        `为什么缺：计费口径只对**在用户自己 agent 上处理**的那部分成立。少了这半句，` +
        `页面承诺的是网页对话也不收费——而网页里每一轮都在扣。这个错的形态是静默的：` +
        `排版正常、语句通顺、没有任何报错。\n` +
        `怎么办：用 _ui/byoAgent 的 byoBillingLine() / byoConnectedBillingLine() 生成这句话，` +
        `别手写；确实与本服务计费无关的（如法条里的「仲裁不收费」）加进 EXEMPT 并写明理由。`,
    ).toEqual([]);
  });

  it('正对照：扫到的文件里确实有「不收 / 不扣」这类字样', () => {
    // 否则上一条在"一行都没匹配到"的情况下也永远绿——那时它守的是个空集
    const total = COPY_FILES.reduce(
      (n, rel) => n + (read(rel).match(/免费|不收|不扣/g)?.length ?? 0),
      0,
    );
    expect(total).toBeGreaterThan(3);
  });
});

/* ── J4 / J19：文案所依据的事实 ────────────────────────── */

/**
 * 抄自 self-host-hint.test 的调用点扫描：只算真正的 `fn(`，
 * 不算 import 那行与注释里提到的名字。
 */
function callers(fn: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p);
      } else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) {
        const text = readFileSync(p, 'utf8');
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (t.startsWith('*') || t.startsWith('//') || t.startsWith('import')) continue;
          if (new RegExp(`\\b${fn}\\s*\\(`).test(line)) {
            out.push(p.slice(SRC.length + 1));
            break;
          }
        }
      }
    }
  };
  walk(SRC);
  return out;
}

describe('J4 「与存储」那半句：文案与代码必须同时有或同时没有', () => {
  /*
   * 存储计费本仓尚未实现（lib/billing / lib/company 全域无存储结算点）。
   * 口径原文里那半句「与存储」因此**故意没写**——写上，页面当天就在说谎。
   *
   * 这条是双向的：
   *   文案提了存储、代码没有结算点 → 红（抢跑，页面在收一笔收不到的钱）
   *   代码有了结算点、文案还没提   → 红（口径没跟上，用户被扣了没被告知过的钱）
   * 后一种方向同样要红：它才是「悄悄开始收费」的形态。
   */
  it('两边一致', () => {
    const mentionsStorage = BOTH.some((line) => line.includes('存储'));
    const settlePoints = callers('gongdaoSettle');
    const hasStoragePoint = settlePoints.some((p) => /storage/i.test(p));
    expect(
      mentionsStorage,
      `缺什么：计费话术${mentionsStorage ? '提到了' : '没提'}存储，` +
        `而扣费点里${hasStoragePoint ? '有' : '没有'}存储相关文件（当前扣费点：${settlePoints.join(' / ')}）。\n` +
        `为什么缺：这半句只有在存储真的开始计费时才成立。提前写＝页面说谎；` +
        `落地了不写＝用户被扣一笔从没被告知过的钱。\n` +
        `怎么办：存储计费落地那天，在 _ui/byoAgent 的 byoBillingLine 里把「与存储」加上，` +
        `两边一起动。价目须先按实测占用核定（npm run audit:storage），不许拿云厂商公开价当我们的成本。`,
    ).toBe(hasStoragePoint);
  });
});

describe('J19 api key 能碰到的扣费路由，仍是那两条具名的', () => {
  /*
   * 「在你自己的 agent 上处理不收费」这句承诺，机制上靠的是：
   * 照《接入说明》与 /api/manifest 接进来的 agent 只会碰到七个数据工具与对应 REST 端点，
   * 那些一行扣费都不走（self-host-hint.test 已钉死）。
   *
   * 但 api key 在**路由层**并非碰不到扣费路由。当前恰好两条，两条都不在 manifest 里：
   *   ① cases/[id]/chat          —— 让我们这边的模型跑一轮，按轮扣。
   *   ② company/dossiers/confirm —— 公司档案购买，先报价、用户确认才扣（主动下单）。
   * 多出第三条，这句承诺就需要重写——而它多出来的时候，页面看起来完全正常。
   *
   * 【为什么还要连着查文档】《接入说明》是给**对方的 agent** 看的那一份，它写过一版
   * 「⚠️ 唯一例外：POST /api/v1/cases/{id}/chat」——路由清单钉着两条，文档只写了一条，
   * 两边各自都读得通顺，合起来才看得出少了一条：照说明接进来的 agent 会以为
   * dossiers/confirm 不花钱，而用户是在账单上发现它的。所以下面第二条把
   * **文档写的例外数**与**守卫钉的路由数**绑在一起，两边必须一起动。
   */
  const API = join(SRC, 'app', 'api');
  const BILLING_ENTRIES = ['runTurn', 'confirmDossier', 'runWatchBilling', 'watchBillingCli'];

  const routeFiles = (): string[] => {
    const out: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (e.name !== '__tests__') walk(p);
        } else if (e.name === 'route.ts' || e.name === 'route.tsx') {
          out.push(p);
        }
      }
    };
    walk(API);
    return out;
  };

  /** api key 够得着的扣费路由。文档与代码两边都按它对齐。 */
  const EXPECTED = [
    'api/v1/cases/[id]/chat/route.ts',
    'api/v1/company/dossiers/confirm/route.ts',
  ];

  it('清单恰好是那两条', () => {
    const reachable: string[] = [];
    for (const p of routeFiles()) {
      const text = readFileSync(p, 'utf8');
      const code = text
        .split('\n')
        .filter((l) => {
          const t = l.trim();
          return !t.startsWith('*') && !t.startsWith('//') && !t.startsWith('import');
        })
        .join('\n');
      const bills = BILLING_ENTRIES.some((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(code));
      if (!bills) continue;
      // requireWebSession 一律拒 api key（keys 路由的注释写明了理由）；
      // requireIdentity / resolveIdentity 两态都收，api key 就能走到。
      const apiKeyReachable = /\b(requireIdentity|resolveIdentity)\s*\(/.test(code);
      if (apiKeyReachable) reachable.push(p.slice(join(SRC, 'app').length + 1));
    }
    expect(
      [...reachable].sort(),
      `缺什么：api key 能触发扣费的路由现在是 ${JSON.stringify(reachable)}。\n` +
        `为什么缺：多出一条，就等于「在你自己的 agent 上处理不收费」这句承诺多了一个` +
        `没写进《接入说明》的例外——而用户是在账单上发现它的。\n` +
        `怎么办：要么把新路由改成 requireWebSession（api key 一律 401），` +
        `要么在 skill/接入说明.md 的「计费」节写明这条例外并把它加进本清单。` +
        `注意：这两条都**不在** /api/manifest 里，照说明接进来的 agent 撞不上。`,
    ).toEqual([...EXPECTED].sort());
  });

  /** 路由文件路径 → 《接入说明》里该写的那个 REST 路径。派生，不手抄。 */
  const restPath = (routeFile: string): string =>
    '/' + routeFile.replace(/\/route\.tsx?$/, '').replace('[id]', '{id}');

  it('《接入说明》计费节写的例外，与上面这份清单逐条对得上', () => {
    const doc = read('../skill/接入说明.md');
    const billing = doc.slice(doc.indexOf('\n## 计费'), doc.indexOf('\n## 接入方式一'));
    expect(billing, '《接入说明》里找不到「## 计费」与它后面那节').not.toBe('');

    const bullets = billing.split('\n').filter((l) => l.trim().startsWith('- ⚠️'));
    expect(
      bullets.length,
      `缺什么：计费节写了 ${bullets.length} 条例外，而 api key 够得着的扣费路由有 ${EXPECTED.length} 条。\n` +
        `为什么缺：这份说明是给对方的 agent 看的。少写一条，它会以为那条端点不花钱，` +
        `照着调下去——用户是在账单上发现的。多写一条，它会绕开一条根本不扣费的端点。\n` +
        `怎么办：例外要与上面那份路由清单一一对应，一条路由一条 bullet，写明什么时候扣。`,
    ).toBe(EXPECTED.length);

    for (const route of EXPECTED) {
      const path = restPath(route);
      expect(
        billing.includes(path),
        `缺什么：计费节里没有 \`${path}\`。\n` +
          `为什么缺：这条路由 api key 够得着且会扣费，而给 agent 看的说明里没提它。\n` +
          `怎么办：在「## 计费」节补一条 ⚠️ 例外，写清什么时候扣、扣多少怎么定。`,
      ).toBe(true);
    }
  });

  it('正对照：扫描确实认得出扣费路由（否则上一条在空集上永远绿）', () => {
    const chat = join(API, 'v1', 'cases', '[id]', 'chat', 'route.ts');
    expect(existsSync(chat)).toBe(true);
    expect(readFileSync(chat, 'utf8')).toMatch(/\brunTurn\s*\(/);
  });
});
