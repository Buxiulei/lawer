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
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { UPLOAD_ROUTE_PREFIXES } from '../upload-routes';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const CADDYFILE = path.join(REPO_ROOT, 'deploy/Caddyfile');

/** Caddyfile 里的通配形态：清单存前缀，配置里带 `*` */
const WANTED = UPLOAD_ROUTE_PREFIXES.map((p) => `${p}*`);

test('夹具自检：deploy/Caddyfile 必须真的在这个路径上', () => {
  // 【为什么先要这一条】路径写错时下面每条断言都会以"读不到/没匹配到"的形态红，
  // 那种红和"Caddyfile 真的漏了一条路由"长得一样，会把人引去改配置而不是改测试路径。
  expect(
    fs.existsSync(CADDYFILE),
    `缺什么：读不到 ${CADDYFILE}。\n` +
      `为什么缺：本测试按 __dirname 上溯五级取仓库根（app/src/lib/evidence/__tests__ → 根），` +
      `Caddyfile 被挪走、或本测试文件被挪到别的深度，这个相对路径就会指空。\n` +
      `怎么办：确认 deploy/Caddyfile 还在，或按本文件的新位置修正 REPO_ROOT 的上溯级数。` +
      `不要因为这条红去动 Caddyfile —— 这条红说的是测试自己找错了地方。`,
  ).toBe(true);
});

const src = fs.readFileSync(CADDYFILE, 'utf8');
const lines = src.split('\n');

type PathLine = { lineNo: number; label: string; tokens: string[] };

function parsePathList(lineNo: number, label: string, text: string): PathLine {
  const m = /^\s*(?:@uploads\s+path|not\s+path)\s+(.+?)\s*$/.exec(text);
  return { lineNo, label, tokens: m ? m[1].split(/\s+/).filter(Boolean) : [] };
}

/** `@uploads path ...` 那一行 */
function findUploadsLine(): PathLine | null {
  const i = lines.findIndex((l) => /^\s*@uploads\s+path\s+/.test(l));
  return i < 0 ? null : parsePathList(i + 1, '@uploads path', lines[i]);
}

/** `@non_uploads { ... }` 块里的 `not path ...` 那一行（只认块内的，不认别处同名指令） */
function findNonUploadsLine(): PathLine | null {
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

const uploads = findUploadsLine();
const nonUploads = findNonUploadsLine();

describe('deploy/Caddyfile 的两行 path 列表必须被解析到', () => {
  // 解析不到时，下面"某条路由不在列表里"的断言会以空列表全红，
  // 那种红指向的是配置而不是这里的正则 —— 所以先把"读没读懂"单独判掉。
  test('@uploads path 行存在且能解析出路径列表', () => {
    expect(
      uploads !== null && uploads.tokens.length > 0,
      `缺什么：deploy/Caddyfile 里找不到可解析的 \`@uploads path ...\` 行。\n` +
        `为什么缺：匹配器被改名（不叫 @uploads 了）、被拆成多行、或改用了 path_regexp 等别的写法，` +
        `本测试的行级正则就读不到它。\n` +
        `怎么办：若确实改了写法，同步改本文件的 findUploadsLine()；` +
        `若是误删，把 \`@uploads path ${WANTED.join(' ')}\` 加回去。`,
    ).toBe(true);
  });

  test('@non_uploads 块里的 not path 行存在且能解析出路径列表', () => {
    expect(
      nonUploads !== null && nonUploads.tokens.length > 0,
      `缺什么：deploy/Caddyfile 的 \`@non_uploads { ... }\` 块里找不到可解析的 \`not path ...\` 行。\n` +
        `为什么缺：块被改名/删除，或 not path 挪出了这个块。` +
        `两个匹配器是互斥对，少了这一半，非上传路由要么不受 2MB 约束、要么把上传路由也收进 2MB。\n` +
        `怎么办：恢复 \`@non_uploads { not path ${WANTED.join(' ')} }\`，` +
        `或在改了写法后同步改本文件的 findNonUploadsLine()。`,
    ).toBe(true);
  });
});

describe('🔴 正向：清单里的每条上传路由都必须同时出现在两行里', () => {
  for (const prefix of UPLOAD_ROUTE_PREFIXES) {
    const want = `${prefix}*`;
    for (const line of [uploads, nonUploads]) {
      test(`${want} 出现在 ${line?.label ?? '(未解析到的行)'}`, () => {
        expect(
          line !== null && line.tokens.includes(want),
          `缺什么：deploy/Caddyfile 第 ${line?.lineNo ?? '?'} 行 \`${line?.label ?? '?'}\` 里没有 ${want}` +
            `（该行现有：${line?.tokens.join(' ') || '(空)'}）。\n` +
            `为什么缺：${prefix} 在 app/src/lib/evidence/upload-routes.ts 的 UPLOAD_ROUTE_PREFIXES 里` +
            `登记为上传路由，但 Caddy 的上传白名单没收录它。两个匹配器是互斥对，漏掉任意一行，` +
            `该路由都会落进 @non_uploads 的 2MB —— 每一次上传都被 Caddy 直接掐断，` +
            `用户只看到"上传失败"。caddy adapt / caddy validate 对这种漏写退出码都是 0，指望不上。\n` +
            `怎么办：把 ${want} 同时加进第 ${uploads?.lineNo ?? '?'} 行的 \`@uploads path\` ` +
            `与第 ${nonUploads?.lineNo ?? '?'} 行的 \`not path\`（两行都要），再重跑本测试。` +
            `另：deploy/Caddyfile 只是模板，上产还要把 request_body 段同步进服务器的` +
            ` /etc/caddy/conf.d/lawer.caddy 并 reload，否则线上一个字节都不会变。`,
        ).toBe(true);
      });
    }
  }
});

describe('🔴 反向：两行的 path 集合必须与清单精确相等（不许只往 Caddyfile 加）', () => {
  for (const line of [uploads, nonUploads]) {
    test(`${line?.label ?? '(未解析到的行)'} 的集合与 UPLOAD_ROUTE_PREFIXES 一一对应`, () => {
      const got = line?.tokens ?? [];
      const onlyInCaddy = got.filter((t) => !WANTED.includes(t));
      const onlyInList = WANTED.filter((t) => !got.includes(t));
      expect(
        [...got].sort(),
        `缺什么：deploy/Caddyfile 第 ${line?.lineNo ?? '?'} 行 \`${line?.label ?? '?'}\` 的路径集合` +
          `与 UPLOAD_ROUTE_PREFIXES 不相等。\n` +
          `　　Caddyfile 有、清单没有：${onlyInCaddy.join(' ') || '(无)'}\n` +
          `　　清单有、Caddyfile 没有：${onlyInList.join(' ') || '(无)'}\n` +
          `为什么缺：前一组说明有人只改了 Caddyfile 没进清单 —— 上传路由集合又变回"独立写两处"，` +
          `下一个改动者照样会漏；后一组是 Caddy 白名单真漏了一条路由（上面"正向"那组会点名是哪条、` +
          `漏在哪一行），首轮 passport 被 2MB 掐死就是这么来的。\n` +
          `怎么办：前一组按"Caddyfile 有、清单没有"的路由（去掉末尾 \`*\`）补进 ` +
          `app/src/lib/evidence/upload-routes.ts 的 UPLOAD_ROUTE_PREFIXES；` +
          `若它其实不是上传路由，就把它从 Caddyfile 这两行里删掉。后一组按上面正向断言的指引补 Caddyfile。`,
      ).toEqual([...WANTED].sort());
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
          `怎么办：核对真实路由路径，改正 UPLOAD_ROUTE_PREFIXES 与 deploy/Caddyfile 两行；` +
          `若该上传路由已下线，三处一起删。`,
      ).toBe(true);
    });
  }
});
