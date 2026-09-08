// app/src/lib/__tests__/terms-live-arm-cleanup.test.ts
// 协议生效旗的**测试臂收尾**守卫：把旗打开的那些用例组，必须自己再关上。
//
// 【守的是哪种失效】vitest 一个 worker 里顺跑多个测试文件，`process.env` 是**跨文件共享**的。
// 于是"把旗打开"这件事会漏到后面的文件里：一组本该在旗关那一臂上跑的判据，
// 实际跑在开臂上——而它**照常全绿**，因为开臂下那些行为大多也是对的。
// 唯一的症状是"某条闸的关臂从此没人验过"，而没人验过与验过之后没问题在报告里同形。
// terms-live-flag.test.ts 的 beforeAll 里已经写着这条泄漏的另一半（它自己 delete 一次防身），
// 那是被动防御：它只保护得了知道这件事的人写的文件。这条守卫补的是主动那一半——
// **谁打开谁负责关上**，于是下一组"以为默认关就不用管"的判据不必知道这件事也不会被咬到。
//
// 【为什么是 grep 而不是运行时断言】泄漏的后果发生在**别的文件**里，
// 而那个文件正因为泄漏而全绿；没有任何一次运行能在现场把它抓住。
// 能查的只有"这个文件有没有把自己开的旗关上"这个结构事实。
//
// 【范围：只扫测试，与 terms-live-single-read 正好互补】那条守卫问"产线里谁读这个旗"
// （答案必须只有唯一读取口），本条问"测试里谁开了这个旗"（答案是：开了就要关）。
// 两条画的边界相反，是因为它们守的是两种不同的失效。
//
// 【本文件自己一个字面量都不写】needle 由 TERMS_LIVE_ENV 这个**标识符**拼出来，
// 不出现环境变量名本身——写进来会撞上 terms-live-single-read 那条"产线里只有一处提它"。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');

/** 打开旗的写法（本仓现有三种写法都命中这一句） */
const TURN_ON = "TERMS_LIVE_ENV] = '1'";
/** 关上旗的写法 */
const TURN_OFF = 'delete process.env[TERMS_LIVE_ENV]';

function testFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) testFiles(full, acc);
    else if (/\.test\.tsx?$/.test(entry)) acc.push(full);
  }
  return acc;
}

describe('协议生效旗：把它打开的测试文件必须自己收尾', () => {
  const files = testFiles(SRC);
  // 【排掉自己】本文件的 TURN_ON 常量里就带着那句 needle，不排掉的话它会把自己数成违规
  // ——grep 型守卫的自匹配陷阱。排法用 __filename 而不是写死文件名，改名时不会悄悄失效；
  // 下面的自检钉住"确实排掉了自己、且自己确实在扫描范围内"。
  const openers = files.filter((f) => f !== __filename && readFileSync(f, 'utf-8').includes(TURN_ON));

  it('前提自检：确实扫到了打开旗的那几组、且本文件被排除（扫空了就是"假绿"）', () => {
    // 过滤条件写错只会让集合变空，而空集合当然一条违规都没有——那种守卫永远绿。
    expect(files.length).toBeGreaterThan(100);
    expect(files, '本文件不在扫描范围内 = 上面那句排除排了个空，自匹配随时会回来').toContain(
      __filename,
    );
    expect(openers).not.toContain(__filename);
    expect(openers.length).toBeGreaterThanOrEqual(5);
  });

  it('每一组都在 afterAll 里把旗删掉（变异：删掉某组的 afterAll → 本条红）', () => {
    const offenders = openers
      .filter((f) => {
        const src = readFileSync(f, 'utf-8');
        const after = src.indexOf('afterAll(');
        // afterAll 之后还得真的有那句 delete——只 import 了 afterAll 不算收尾
        return after < 0 || !src.slice(after).includes(TURN_OFF);
      })
      .map((f) => path.relative(SRC, f));
    expect(
      offenders,
      `这几组把旗打开后没关上，同一个 worker 里排在它们后面的判据会跑在开臂上：\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
