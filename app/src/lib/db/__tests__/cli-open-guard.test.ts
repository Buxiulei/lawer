// app/src/lib/db/__tests__/cli-open-guard.test.ts
// 守卫：CLI 不许自己裸开库。
//
// 【为什么要有守卫，而不是写条规矩】2026-08-29 第十一窗那次崩，
// 起因不是某个脚本作者忘了跑迁移，是**五个 CLI 全都忘了**——
// 独立写五次、忘五次，说明这是这类代码的默认形态，不是个人疏忽。
// 「下次记得用 openCliDb」这种规矩，会被下一个写 CLI 的人绕过（他不知道有这条规矩）；
// 守卫不会自己长回来。
//
// 【判据钉在哪】凡是含有 `xxxCli(` 入口的 lib 文件，都不许出现 `new Database(` / `new BetterSqlite3(`。
// 开库统一走 cli-open.ts —— 那里决定可写就补迁移、只读就给自述错误。
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'vitest';

const LIB = path.join(__dirname, '..', '..');
/** cli-open 是开库实现本体；client.ts 是 app 自己的连接池，两者本来就该开库。 */
const ALLOWED = new Set(['db/cli-open.ts', 'db/client.ts']);

function walk(dir: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '__tests__' && e.name !== 'node_modules') walk(p, out);
    } else if (e.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

describe('守卫：CLI 开库只准走 cli-open', () => {
  const files = walk(LIB);

  test('扫描范围非空（守卫自己不能空跑通过）', () => {
    expect(files.length).toBeGreaterThan(30);
    // 并且真的扫到了已知的 CLI 文件，否则"零违规"只是没找到文件
    const cliFiles = files.filter((f) => /export\s+(async\s+)?function\s+\w+Cli\s*\(/.test(fs.readFileSync(f, 'utf8')));
    expect(cliFiles.map((f) => path.basename(f)).sort()).toEqual(
      expect.arrayContaining(['backfill.ts', 'deadline-reminder.ts', 'filesGc.ts', 'reconcile.ts']),
    );
  });

  test('没有 CLI 自己 new Database / new BetterSqlite3', () => {
    const bad: string[] = [];
    for (const f of files) {
      const rel = path.relative(LIB, f).split(path.sep).join('/');
      if (ALLOWED.has(rel)) continue;
      const src = fs.readFileSync(f, 'utf8');
      if (!/export\s+(async\s+)?function\s+\w+Cli\s*\(/.test(src)) continue;
      if (/new\s+(BetterSqlite3|Database)\s*\(/.test(src)) bad.push(rel);
    }
    expect(bad, `这些 CLI 自己开了库，绕过了迁移：${bad.join('、')}｜改用 openCliDb()`).toEqual([]);
  });
});
