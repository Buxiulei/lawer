// app/src/lib/evidence/__tests__/caddy-upload-routes.test.ts
// deploy/Caddyfile 上传白名单的结构守卫 —— 纯文本断言，CI 不需要 caddy 二进制。
//
// 【这条测试是哪个 bug 长出来的】首轮上传体积闸只给 /api/v1/evidence* 开了 30MB，
// /api/v1/realname/passport* 漏了，落进默认 2MB —— 每一次护照实名提交都被静默掐断。
// 漏的原因不是疏忽，是形态：上传路由集合当时被独立写在三处（Caddyfile 两行 + 人的脑子），
// 独立写 N 次就会忘 N 次。
//
// 【为什么不能靠 caddy 自己】对"少写一条路径"，`caddy adapt` 与 `caddy validate` 退出码都是 0
// ——配置语法完全合法，只是语义上把一条路封了。变异实测：从 @uploads 删掉 passport，
// adapt 退出码仍为 0。所以这道闸只能由测试来立，且必须读 Caddyfile 原文。
//
// 【咬的是双向，缺一个方向就白立】
//   正向：清单里有、Caddyfile 缺 → 红（新增上传路由忘了同步 Caddy，就是首轮那个 bug）
//   反向：Caddyfile 有、清单里缺 → 红（只往 Caddyfile 加不进清单，真源就又散回两处）
//
// 【分档之后多咬一件事：档位本身】证据路径要收视频（200MB），护照实名仍是 30MB。
// 只咬"路由在不在名单里"的话，有人把两档合成一档、或把 200MB 那行改回 30MB，
// 全部断言照绿——而线上的形态是每一次视频上传都被 Caddy 掐断。所以 max_size 也钉。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { CADDY_BODY_TIERS, UPLOAD_ROUTE_PREFIXES } from '../upload-routes';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CADDYFILE = path.join(REPO_ROOT, 'deploy/Caddyfile');

/** Caddyfile 里的通配形态：清单存前缀，配置里带 `*` */
const WANTED = UPLOAD_ROUTE_PREFIXES.map((p) => `${p}*`);

/** 每一档在 Caddyfile 里的通配形态 */
const TIER_WANTED = CADDY_BODY_TIERS.map((t) => ({
  ...t,
  want: t.prefixes.map((p) => `${p}*`),
}));

/** 夹具找不到时的说明。**只写这一份**：自检断言与惰性读文件共用它，不许两处各写各的。 */
const MISSING_FIXTURE =
  `缺什么：读不到 ${CADDYFILE}。\n` +
  `为什么缺：本测试按 __dirname 上溯五级取仓库根（app/src/lib/evidence/__tests__ → 根），` +
  `Caddyfile 被挪走、或本测试文件被挪到别的深度，这个相对路径就会指空。\n` +
  `怎么办：确认 deploy/Caddyfile 还在，或按本文件的新位置修正 REPO_ROOT 的上溯级数。` +
  `不要因为这条红去动 Caddyfile —— 这条红说的是测试自己找错了地方。`;

test('夹具自检：deploy/Caddyfile 必须真的在这个路径上', () => {
  // 【为什么先要这一条】路径写错时下面每条断言都会以"读不到/没匹配到"的形态红，
  // 那种红和"Caddyfile 真的漏了一条路由"长得一样，会把人引去改配置而不是改测试路径。
  expect(fs.existsSync(CADDYFILE), MISSING_FIXTURE).toBe(true);
});

/**
 * 【为什么读文件必须在 test 体里，不能在模块顶层】
 * 这里原先是一句模块顶层的 `fs.readFileSync(CADDYFILE)`。路径一旦指空，
 * 它在**收集阶段**就抛 ENOENT，整个文件 0 条测试跑不起来——
 * 上面那条夹具自检连同它那段三段式文案**一次也没执行过**，等于不存在。
 * 实测（把 CADDYFILE 指向不存在的路径）：`0 test` + 一条裸 ENOENT 堆栈，
 * 读的人得自己从堆栈倒推「是测试找错地方还是配置真没了」——正是那条自检要替他答的问题。
 * 所以读文件改成惰性 + 记忆化，只在 test 体内触发；夹具自检因此真能红成它写好的样子，
 * 且**别的测试也不会退回裸 ENOENT**：这里先自己判存在，抛的是同一段三段式。
 */
let cachedLines: string[] | null = null;
function caddyLines(): string[] {
  if (cachedLines === null) {
    if (!fs.existsSync(CADDYFILE)) throw new Error(MISSING_FIXTURE);
    cachedLines = fs.readFileSync(CADDYFILE, 'utf8').split('\n');
  }
  return cachedLines;
}

/** 每一档匹配器的名字提到常量：test 名在收集阶段就要定下来，而那时还不许读文件 */
type Tier = (typeof TIER_WANTED)[number];

type PathLine = { lineNo: number; label: string; tokens: string[] };

function parsePathList(lineNo: number, label: string, text: string): PathLine {
  const m = /^\s*(?:@\w+\s+path|not\s+path)\s+(.+?)\s*$/.exec(text);
  return { lineNo, label, tokens: m ? m[1].split(/\s+/).filter(Boolean) : [] };
}

/** `@<匹配器> path ...` 那一行 */
function findMatcherLine(matcher: string): PathLine | null {
  const lines = caddyLines();
  const re = new RegExp(`^\\s*${matcher}\\s+path\\s+`);
  const i = lines.findIndex((l) => re.test(l));
  return i < 0 ? null : parsePathList(i + 1, `${matcher} path`, lines[i]);
}

/** `@non_uploads { ... }` 块里的 `not path ...` 那一行（只认块内的，不认别处同名指令） */
function findNonUploadsLine(): PathLine | null {
  const lines = caddyLines();
  const start = lines.findIndex((l) => /^\s*@non_uploads\s*\{/.test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\}/.test(lines[i])) return null; // 块读完了也没见到 not path
    if (/^\s*not\s+path\s+/.test(lines[i])) {
      return parsePathList(i + 1, '@non_uploads 的 not path', lines[i]);
    }
  }
  return null;
}

/** `request_body @<匹配器> { max_size X }` 里的那个 X；读不到回 null */
function findMaxSize(matcher: string): string | null {
  const lines = caddyLines();
  const re = new RegExp(`^\\s*request_body\\s+${matcher}\\s*\\{`);
  const start = lines.findIndex((l) => re.test(l));
  if (start < 0) return null;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^\s*\}/.test(lines[i])) return null;
    const m = /^\s*max_size\s+(\S+)\s*$/.exec(lines[i]);
    if (m) return m[1];
  }
  return null;
}

describe('deploy/Caddyfile 的匹配器行必须被解析到', () => {
  // 解析不到时，下面"某条路由不在列表里"的断言会以空列表全红，
  // 那种红指向的是配置而不是这里的正则 —— 所以先把"读没读懂"单独判掉。
  for (const tier of TIER_WANTED) {
    test(`${tier.matcher} path 行存在且能解析出路径列表`, () => {
      const line = findMatcherLine(tier.matcher);
      expect(
        line !== null && line.tokens.length > 0,
        `缺什么：deploy/Caddyfile 里找不到可解析的 \`${tier.matcher} path ...\` 行。\n` +
          `为什么缺：匹配器被改名、被拆成多行、被并进别的档，或改用了 path_regexp 等别的写法，` +
          `本测试的行级正则就读不到它。${tier.matcher} 这一档的理由是：${tier.why}。\n` +
          `怎么办：若确实改了写法，同步改 app/src/lib/evidence/upload-routes.ts 的 CADDY_BODY_TIERS ` +
          `与本文件的 findMatcherLine()；若是误删，把 \`${tier.matcher} path ${tier.want.join(' ')}\` 加回去。`,
      ).toBe(true);
    });
  }

  test('@non_uploads 块里的 not path 行存在且能解析出路径列表', () => {
    const nonUploads = findNonUploadsLine();
    expect(
      nonUploads !== null && nonUploads.tokens.length > 0,
      `缺什么：deploy/Caddyfile 的 \`@non_uploads { ... }\` 块里找不到可解析的 \`not path ...\` 行。\n` +
        `为什么缺：块被改名/删除，或 not path 挪出了这个块。` +
        `几个匹配器是互斥组，少了这一半，非上传路由要么不受 2MB 约束、要么把上传路由也收进 2MB。\n` +
        `怎么办：恢复 \`@non_uploads { not path ${WANTED.join(' ')} }\`，` +
        `或在改了写法后同步改本文件的 findNonUploadsLine()。`,
    ).toBe(true);
  });
});

describe('🔴 正向：清单里的每条上传路由都必须出现在它那一档与 not path 行里', () => {
  for (const tier of TIER_WANTED) {
    for (const want of tier.want) {
      test(`${want} 出现在 ${tier.matcher} path`, () => {
        const line = findMatcherLine(tier.matcher);
        expect(
          line !== null && line.tokens.includes(want),
          `缺什么：deploy/Caddyfile 第 ${line?.lineNo ?? '?'} 行 \`${tier.matcher} path\` 里没有 ${want}` +
            `（该行现有：${line?.tokens.join(' ') || '(空)'}）。\n` +
            `为什么缺：该前缀在 upload-routes.ts 的 CADDY_BODY_TIERS 里登记在 ${tier.matcher} 这一档` +
            `（${tier.why}），但 Caddy 那一行没收录它。几个匹配器互斥，漏掉就落进 @non_uploads 的 2MB` +
            ` —— 每一次上传都被 Caddy 直接掐断，用户只看到"上传失败"。` +
            `caddy adapt / caddy validate 对这种漏写退出码都是 0，指望不上。\n` +
            `怎么办：把 ${want} 加进 \`${tier.matcher} path\` 那一行，再重跑本测试。`,
        ).toBe(true);
      });

      test(`${want} 出现在 @non_uploads 的 not path`, () => {
        const line = findNonUploadsLine();
        expect(
          line !== null && line.tokens.includes(want),
          `缺什么：deploy/Caddyfile 第 ${line?.lineNo ?? '?'} 行 \`not path\` 里没有 ${want}` +
            `（该行现有：${line?.tokens.join(' ') || '(空)'}）。\n` +
            `为什么缺：not path 那一行必须列出**全部**上传路由，它是其余路由 2MB 的补集。` +
            `漏掉一条，这条路由会同时匹配它自己那一档与 @non_uploads —— ` +
            `同名指令叠加以更严的为准，于是它被收成 2MB，每一次上传都被掐断。\n` +
            `怎么办：把 ${want} 加进 \`@non_uploads { not path ... }\` 那一行。`,
        ).toBe(true);
      });
    }
  }
});

describe('🔴 反向：每行的 path 集合必须与清单精确相等（不许只往 Caddyfile 加）', () => {
  const cases: { label: string; wanted: string[]; find: () => PathLine | null }[] = [
    ...TIER_WANTED.map((t: Tier) => ({
      label: `${t.matcher} path`,
      wanted: [...t.want],
      find: () => findMatcherLine(t.matcher),
    })),
    { label: '@non_uploads 的 not path', wanted: [...WANTED], find: findNonUploadsLine },
  ];
  for (const c of cases) {
    test(`${c.label} 的集合与清单一一对应`, () => {
      const line = c.find();
      const got = line?.tokens ?? [];
      const onlyInCaddy = got.filter((t) => !c.wanted.includes(t));
      const onlyInList = c.wanted.filter((t) => !got.includes(t));
      expect(
        [...got].sort(),
        `缺什么：deploy/Caddyfile 第 ${line?.lineNo ?? '?'} 行 \`${c.label}\` 的路径集合与清单不相等。\n` +
          `　　Caddyfile 有、清单没有：${onlyInCaddy.join(' ') || '(无)'}\n` +
          `　　清单有、Caddyfile 没有：${onlyInList.join(' ') || '(无)'}\n` +
          `为什么缺：前一组说明有人只改了 Caddyfile 没进清单 —— 上传路由集合又变回"独立写两处"，` +
          `下一个改动者照样会漏；后一组是 Caddy 白名单真漏了一条路由（上面"正向"那组会点名是哪条、` +
          `漏在哪一行），首轮 passport 被 2MB 掐死就是这么来的。\n` +
          `怎么办：按 app/src/lib/evidence/upload-routes.ts 的 UPLOAD_ROUTE_PREFIXES / CADDY_BODY_TIERS ` +
          `补齐或删除；若某条其实不是上传路由，三处一起删。`,
      ).toEqual([...c.wanted].sort());
    });
  }
});

describe('🔴 档位本身：每一档的 max_size 必须与清单相等', () => {
  // 【为什么单钉这一条】路由名单全对、档位被人从 200MB 改回 30MB，上面每条断言都绿，
  // 而线上的形态是每一次视频上传都被 Caddy 掐断 —— 应用侧那条说得清原因的 413 根本没机会发出来。
  for (const tier of TIER_WANTED) {
    test(`request_body ${tier.matcher} 的 max_size 是 ${tier.maxSize}`, () => {
      const got = findMaxSize(tier.matcher);
      expect(
        got,
        `缺什么：deploy/Caddyfile 的 \`request_body ${tier.matcher} { max_size ... }\` 读到的是 ` +
          `${got ?? '(读不到)'}，清单要求 ${tier.maxSize}。\n` +
          `为什么缺：这一档存在的理由是「${tier.why}」；调小了，超过新上限的上传会被 Caddy 掐断连接，` +
          `用户只看到"上传失败"；调大了，超出应用侧内存预算的字节会白白灌进进程。\n` +
          `怎么办：改回 ${tier.maxSize}，或者在 upload-routes.ts 的 CADDY_BODY_TIERS 里连同理由一起改。`,
      ).toBe(tier.maxSize);
    });
  }
});

describe('清单里的前缀必须对得上真实存在的路由文件', () => {
  // 【补这条的理由】前缀在清单和 Caddyfile 里被同样地拼错时，上面的文本断言全绿，
  // 而 Caddy 守的是一条不存在的路、真路由仍在 2MB 里。这条把清单钉回文件系统。
  for (const prefix of UPLOAD_ROUTE_PREFIXES) {
    test(`${prefix} 有对应的 route.ts`, () => {
      const routeFile = path.join(REPO_ROOT, 'app/src/app', `${prefix}/route.ts`);
      expect(
        fs.existsSync(routeFile),
        `缺什么：清单里的 ${prefix} 找不到对应的路由文件 ${routeFile}。\n` +
          `为什么缺：前缀拼错了，或该路由被删/挪走。前缀拼错时 Caddyfile 只要拼成同样的错，` +
          `文本断言会全绿，而 Caddy 守的是一条不存在的路，真路由仍落在 2MB 里。\n` +
          `怎么办：核对真实路由路径，改正 UPLOAD_ROUTE_PREFIXES 与 deploy/Caddyfile 各行；` +
          `若该上传路由已下线，三处一起删。`,
      ).toBe(true);
    });
  }
});
