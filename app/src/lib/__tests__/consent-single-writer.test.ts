// app/src/lib/__tests__/consent-single-writer.test.ts
// 同意台账的**单一写入口**守卫（lib/db/consents.ts 抬头承诺的那条机检）。
//
// 【守的是哪种失效】同意有五个采集点（注册页、实名页、站内对话、设置页、MCP 闸门），
// 而"这次点头要落一行"这件事独立写五遍就会忘一遍。忘掉之后的形态最难发现：
// 页面上问过了、用户也点了头，库里没有那一行——于是闸门第二天又拦住他一次，
// 而两处看起来都在正常工作。「独立写 N 次就会忘 N 次」是默认形态，不是疏忽，
// 所以修法是**收唯一入口 + 结构守卫会点名**，不是叮嘱下一个人小心。
//
// 【为什么这条守卫值得存在，尽管它只是个 grep】同意的写入没有运行时痕迹可查：
// 某处自己写一句 INSERT INTO consents，行照样落、功能照样好，只是绕开了
// 版本号缺省、IP 摘要与 INSERT OR IGNORE 幂等这三件事。等到要回答"他当时同意的是哪一版"
// 时才发现那些行的 version 是空的——而那时台账已经花了。
//
// 【范围：只扫产线代码，不扫测试】测试要构造"存量用户从没同意过""同意被撤掉之后"
// 这类**写入口按设计造不出来**的状态，直接写 SQL 是对的。真正会漂的是产线代码。
// 这条边界是有意画的：把测试也扫进来的守卫，第一次挡住合理的夹具就会被人删掉。
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(__dirname, '..', '..');
/** 唯一允许直接写 consents 表的文件 */
const WRITER = path.join('lib', 'db', 'consents.ts');
/** 建表的地方当然要提到这张表 */
const MIGRATOR = path.join('lib', 'db', 'migrate.ts');

/** 递归收集产线 .ts/.tsx（跳过测试目录与测试文件） */
function productionFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === '__tests__' || entry === 'node_modules') continue;
      productionFiles(full, acc);
    } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * 直接操作 consents 表的 SQL。
 *
 * 【为什么连 SELECT 也管】读侧同样有唯一入口（hasConsent / consentAt / consentedKinds）。
 * 自己写一句 SELECT 的形态比写入更隐蔽：闸门多半会顺手比对 version，
 * 于是协议一改版，所有存量用户在下一次点击前被静默拦住——而那与
 * CONSENT_VERSIONS 抬头写明的裁决（闸门不比对版本）正好相反。
 */
const RAW_SQL = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM|FROM)\s+consents\b/i;

describe('同意台账：产线代码里只有一个文件碰得着这张表', () => {
  const files = productionFiles(SRC);

  it('前提自检：扫到的文件数量是正常量级（扫空了就是"假绿"）', () => {
    // 【为什么要自检】路径写错时 readdirSync 会抛，但过滤条件写错只会让集合变空，
    // 而空集合当然一条违规都没有——那种守卫看起来永远是绿的。
    expect(files.length).toBeGreaterThan(200);
    expect(files.some((f) => f.endsWith(WRITER)), '写入口本身必须在扫描范围内').toBe(true);
  });

  it('除 lib/db/consents.ts 外，没有第二处直接写/读 consents 表', () => {
    const offenders: string[] = [];
    for (const file of files) {
      if (file.endsWith(WRITER) || file.endsWith(MIGRATOR)) continue;
      const text = readFileSync(file, 'utf8');
      for (const [i, line] of text.split('\n').entries()) {
        if (RAW_SQL.test(line)) offenders.push(`${path.relative(SRC, file)}:${i + 1}  ${line.trim()}`);
      }
    }
    expect(
      offenders,
      '这些地方绕开了 lib/db/consents.ts：版本号缺省、IP 摘要、INSERT OR IGNORE 幂等三件事都会漏掉',
    ).toEqual([]);
  });

  it('写入口本身还在（守卫扫的那个名字不是空壳）', () => {
    const writer = readFileSync(path.join(SRC, WRITER), 'utf8');
    expect(writer).toContain('INSERT OR IGNORE INTO consents');
    // 幂等不是靠调用方自觉去查一遍再插：那是 check-then-act，两个标签页同时点就会各插一行
    expect(writer, '幂等必须由 SQL 自己保证').toMatch(/INSERT OR IGNORE/);
  });
});
