// app/src/lib/__tests__/terms-live-single-read.test.ts
// 协议生效旗的**单一读取口**守卫（lib/auth/consent.termsLive 抬头承诺的那条机检）。
//
// 【守的是哪种失效】旗关着时全站有四处行为要跟着变（注册闸、台账落行、出境判定、
// 三张条款页的横幅），而"这一处也要看旗"这件事独立写四次就会忘一次。忘掉之后最难发现：
// 忘的那一处照常工作、照常出结果，只是它按**另一臂**在跑——比如出境闸看了旗、
// 而某条新加的取模型的路没看，于是协议没生效的站照样把对话送出境，一处报错都没有。
// 「独立写 N 次就会忘 N 次」是默认形态，修法是收唯一入口 + 守卫会点名。
//
// 【为什么盯的是环境变量名而不是 termsLive 的调用点】调用点越多越好——四处都该调它。
// 会漂的是**另一条读取路**：某处自己写一句 `process.env.LAWER_TERMS_LIVE === '1'`，
// 判得对不对全看它自己抄得准不准（'TRUE' 认不认？空白剥不剥？），
// 而两处口径不一致的形态是：同一次部署里，注册页认为协议生效了、条款页认为没有。
//
// 【范围：只扫产线文件，不扫测试】判据必须说得出自己跑在哪一臂，
// 那句话里就要出现这个变量名（见 consent-gate.test.ts 等三处的文件头）。
// 把测试也扫进来的守卫，第一次挡住这种说明就会被人删掉——这条边界与
// lib/__tests__/consent-single-writer.test.ts 画的是同一条。
//
// 【变异矩阵】2026-09-07 实跑，本文件 4 例：
//  · G-1 在 /api/v1/me 路由里改成自己写一句 `process.env.LAWER_TERMS_LIVE === '1'`
//        （最像"顺手写一下"的那种第二条读取路）⇒ 1 失败 / 3 通过。
//
// 【本文件自己一个字面量都不写】needle 取自 TERMS_LIVE_ENV 常量：
// 守卫里再抄一遍变量名的形态是——产线那边改了名，守卫盯着一个没人再用的旧名字，
// 于是它永远绿。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { TERMS_LIVE_ENV } from '@/lib/auth/consent';

/** 仓根：本文件在 app/src/lib/__tests__ 下 */
const REPO = path.resolve(__dirname, '..', '..', '..', '..');

/** 唯一允许读这个变量的产线文件 */
const READER = path.join('app', 'src', 'lib', 'auth', 'consent.ts');
/** 除了读取口之外，还允许提到它的地方：运维要照着配的样例，与给人读的文档 */
const DOCS = [path.join('app', '.env.example'), 'docs' + path.sep];

const SKIP_DIRS = new Set(['.git', 'node_modules', '.next', '__pycache__', '.pytest_cache']);
const TEXT = /\.(ts|tsx|js|mjs|cjs|json|md|ya?ml|sh|py|example|env|toml|conf|css)$/;
/** 大文件不是配置也不是代码（知识库原件、锁文件），扫它们只是让这条判据变慢 */
const MAX_BYTES = 512 * 1024;

function textFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = path.join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      if (entry === '__tests__') continue;
      textFiles(full, acc);
    } else if (
      (TEXT.test(entry) || entry === '.env.example') &&
      !/\.test\.tsx?$/.test(entry) &&
      st.size <= MAX_BYTES
    ) {
      acc.push(full);
    }
  }
  return acc;
}

describe('协议生效旗：产线里只有一个文件读得着这个环境变量', () => {
  const files = textFiles(REPO);
  const hits = files
    .filter((f) => readFileSync(f, 'utf-8').includes(TERMS_LIVE_ENV))
    .map((f) => path.relative(REPO, f));

  it('前提自检：扫到的文件是正常量级，且读取口本身在扫描范围内（扫空了就是"假绿"）', () => {
    // 【为什么要自检】路径写错时 readdirSync 会抛，但过滤条件写错只会让集合变空，
    // 而空集合当然一条违规都没有——那种守卫看起来永远是绿的。
    expect(files.length).toBeGreaterThan(400);
    expect(
      files.some((f) => path.relative(REPO, f) === READER),
      '读取口本身没被扫到，下面那条"只有它"什么也没证明',
    ).toBe(true);
    expect(hits, '连读取口都没命中 = needle 或扫描坏了').toContain(READER);
  });

  it('除了读取口，只有 .env.example 与 docs 提得到它（变异：在别处加一句 process.env 读它 → 本条红）', () => {
    const offenders = hits.filter(
      (rel) => rel !== READER && !DOCS.some((d) => rel === d || rel.startsWith(d)),
    );
    expect(
      offenders,
      `旗多出了第二条读取路（或第二处说明），口径会各说各的：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('读取口里这个名字只出现一次，就是那个常量声明', () => {
    const src = readFileSync(path.join(REPO, READER), 'utf-8');
    const lines = src.split('\n').filter((l) => l.includes(TERMS_LIVE_ENV));
    expect(lines.length, `读取口里出现了 ${lines.length} 次，多出来的那次绕开了常量`).toBe(1);
    expect(lines[0]).toContain(`export const TERMS_LIVE_ENV = '${TERMS_LIVE_ENV}'`);
    expect(src, '读它的时候没走常量（改名时会漏掉这一处）').toContain(
      'process.env[TERMS_LIVE_ENV]',
    );
  });

  it('.env.example 里有这一项：运维照着配的那份样例漏了它，等于这个旗没有说明书', () => {
    const example = readFileSync(path.join(REPO, 'app', '.env.example'), 'utf-8');
    expect(example).toContain(`${TERMS_LIVE_ENV}=`);
  });
});
