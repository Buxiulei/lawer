// app/src/lib/db/__tests__/soft-delete-scope.test.ts
//
// 结构守卫 · 按 case_id 取数的地方不许看见已删的档案。
//
// 【为什么要这一条】删除回包对用户说的是：这份档案与它的全部内容，**此刻起在所有页面与
// 接口上都不再出现**。而硬删要等 30 天，中间这一段全靠读侧过滤 `deleted_at IS NULL`。
// 过滤原本只加在 lib/db/cases 的两个读入口上，于是**不经那两个入口的地方各自写了一句
// 裸 `SELECT ... FROM cases WHERE id=? AND user_id=?`**：归属对，软删那半句没有。
// 表现是——用户删完档案，用自己的 agent 照样读得到来文解读、照样能对它报价扣费，
// 而站内任何一页都查不到这个案子。复审（2026-09-07）在按量报价、文书审查、crisis_check、
// 来文解读四处各抓到一份，期限提醒与守望计费两条后台任务也各漏一处（照发信、照收费）。
//
// **独立写 N 次就会忘 N 次**：所以判据不问人记没记得，直接扫源码里每一句提到 cases 表的 SQL。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

/** src 根：本文件在 src/lib/db/__tests__/ 下，往上三层。 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * 豁免名单：**按文件给**，每一条都要说清"这里为什么可以看见已删的行"。
 * 加一个文件就得改这一行，改这一行就得写清理由——这正是这份名单的用处。
 */
const EXEMPT: Record<string, string> = {
  // 软删/硬删本身就长在这两个文件里：它们必须看得见被删的行
  'lib/db/cases.ts': '读入口本身（findCaseByIdIncludingDeleted 等生命周期专用取数口）',
  'lib/lifecycle/case-export.ts': '导出整案副本要把 cases 那一行原样打进包里',
  // 按 case_id 反查一个属性，不是归属闸；调用方各自已经过了归属
  'lib/lifecycle/consents.ts': '由 case_id 反查属主 user_id，与"这个案子还在不在"无关',
  'lib/sensitive.ts': '取本案领域用于敏感级判定；取不到自有兜底口径',
  'lib/referral/packet.ts': '取本案领域用于转介包脱敏；取不到自有兜底口径',
  'lib/cases/report-stale.ts': '只判 case_id 存在性，用来决定要不要落一行报告占位',
  // 统计/审计：口径是"盘上与库里此刻有什么"，软删还没释放任何字节
  'lib/db/storageAudit.ts': '存储用量按物理字节算，软删的案件仍占着盘',
  'lib/admin/users.ts': '后台台账：管理员要看到的就是全量',
  'lib/billing/backfill.ts': '历史用量回填，按已落库的流水重算，与当下可见性无关',
};

/** 提到 cases 表的取数语句。UPDATE/DELETE 不在此列：写侧本来就要按 deleted_at 抢占。 */
const READS_CASES = /\b(?:FROM|JOIN)\s+`?cases`?\b/i;

/**
 * 把源码里的字符串/模板字面量逐个取出来（注释不算）。
 *
 * 【为什么按"整条字面量"判，而不是按行或按窗口】这些 SQL 都写在一个模板字面量里，
 * 而 `deleted_at IS NULL` 可能落在 FROM 之后好几行。按行判会全员误报，
 * 按固定窗口判则会被同一文件里另一句无关的 deleted_at 蒙混过去。
 *
 * 【为什么必须剥注释】本文件与生产代码的注释里都会引到 `FROM cases` 的字样
 * （解释"为什么必须带 deleted_at"时几乎一定会引一句）。不剥注释，守卫会在只是提到它的
 * 注释上报红，红几次之后就会有人把守卫本身放宽——那才是真正的代价。
 */
export function stringLiterals(src: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '/' && next === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i += 1;
      let lit = '';
      while (i < src.length) {
        if (src[i] === '\\') {
          lit += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        if (src[i] === c) {
          i += 1;
          break;
        }
        lit += src[i];
        i += 1;
      }
      out.push(lit);
      continue;
    }
    i += 1;
  }
  return out;
}

/** 一段源码里"读了 cases 却没带 deleted_at"的语句（已归一空白，便于在失败信息里读）。 */
export function unscopedReads(src: string): string[] {
  return stringLiterals(src)
    .filter((lit) => READS_CASES.test(lit) && !/deleted_at/i.test(lit))
    .map((lit) => lit.replace(/\s+/g, ' ').trim());
}

/** 待扫的生产文件（相对 src 的 POSIX 路径 + 内容）。测试目录不扫：判据要自己造被删的行。 */
function productionFiles(): { rel: string; src: string }[] {
  const out: { rel: string; src: string }[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
        let text: string;
        try {
          text = fs.readFileSync(full, 'utf-8');
        } catch (err) {
          // 只放过 ENOENT（并发跑批里别的判据会写临时副本再删掉）；别的读失败必须抛，
          // 一条读不动就静默略过的守卫会在没人察觉时变瞎。
          if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw err;
        }
        out.push({ rel: path.relative(SRC, full).split(path.sep).join('/'), src: text });
      }
    }
  };
  walk(SRC);
  return out;
}

/** 名单外、读 cases 却不带软删过滤的地方。判据本体，对照臂喂合成文件调的也是它。 */
export function offenders(files: { rel: string; src: string }[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    if (f.rel in EXEMPT) continue;
    for (const hit of unscopedReads(f.src)) hits.push(`${f.rel}: ${hit}`);
  }
  return hits;
}

describe('结构守卫 · 已删档案不许从任何取数口漏出来', () => {
  const files = productionFiles();

  test('扫描面确实盖住了出过事的那几处（每条锚点恰好一处）', () => {
    expect(path.basename(SRC)).toBe('src');
    expect(files.length).toBeGreaterThan(100);
    for (const anchor of [
      'lib/notify/deadline-reminder.ts',
      'lib/company/watch-billing.ts',
      'lib/docs/read.ts',
      'lib/db/cases.ts',
    ]) {
      expect(files.filter((f) => f.rel === anchor), `锚点 ${anchor} 没被扫到（或被扫到多次）`).toHaveLength(1);
    }
    // 豁免名单里的文件也必须真实存在：名单写错一个字，等于悄悄多放一条路
    for (const rel of Object.keys(EXEMPT)) {
      expect(files.filter((f) => f.rel === rel), `豁免名单里的 ${rel} 不在扫描结果里`).toHaveLength(1);
    }
  });

  /**
   * 名单不许发胖：一条豁免如果已经没在豁免任何东西（那个文件早就不裸查 cases 了），
   * 它就只是在无声地扩大放行面——日后有人在那个文件里新写一句裸查，谁都不会知道。
   * 所以每一条都必须还有它当初要放行的那句话。
   */
  test('豁免名单每一条都还在真的豁免着某一句（名单不许发胖）', () => {
    for (const [rel, why] of Object.entries(EXEMPT)) {
      const src = files.find((f) => f.rel === rel)!.src;
      expect(unscopedReads(src), `${rel} 已经不需要豁免了（理由：${why}），把它从名单里删掉`).not.toEqual([]);
    }
  });

  test('名单外没有任何一处读 cases 时忘了 deleted_at', () => {
    const bad = offenders(files);
    expect(
      bad,
      `这些地方能读到用户已经删掉的档案（删除回包答应过"所有接口上都不再出现"）：\n${bad.join('\n')}`,
    ).toEqual([]);
  });

  // ── 对照臂：没有它，「扫不出违规」与「正则写错 / 文件没读到」输出一模一样 ──

  test('扫描器是活的：各种写法都抓得住，带了过滤的不误伤', () => {
    expect(unscopedReads("db.prepare('SELECT id FROM cases WHERE id=? AND user_id=?')")).toHaveLength(1);
    expect(unscopedReads("db.prepare('select * from cases where id=?')")).toHaveLength(1);
    expect(unscopedReads('db.prepare(`SELECT d.id FROM deadlines d\n JOIN cases c ON c.id=d.case_id`)')).toHaveLength(1);
    // 带了过滤的不报
    expect(unscopedReads("db.prepare('SELECT id FROM cases WHERE id=? AND deleted_at IS NULL')")).toEqual([]);
    expect(
      unscopedReads('db.prepare(`SELECT 1 FROM deadlines d JOIN cases c ON c.id=d.case_id\n WHERE c.deleted_at IS NULL`)'),
    ).toEqual([]);
    // 别的表不误伤（case_reports / company_watches 里都有 case 这几个字）
    expect(unscopedReads("db.prepare('SELECT * FROM case_reports WHERE case_id=?')")).toEqual([]);
    expect(unscopedReads("db.prepare('SELECT * FROM company_watches WHERE case_id=?')")).toEqual([]);
    // 写侧不扫：软删本身就是一句 UPDATE cases
    expect(unscopedReads("db.prepare('UPDATE cases SET deleted_at=? WHERE id=?')")).toEqual([]);
  });

  test('注释被剥掉：只是提到这句 SQL 的注释不算违规，同一文件里真写了就算', () => {
    expect(unscopedReads('// 不许裸写 SELECT id FROM cases WHERE id=?\nconst a = 1;')).toEqual([]);
    expect(unscopedReads('/* 见 SELECT * FROM cases ... */\nconst a = 1;')).toEqual([]);
    // 反向对照：少了这条，把 stringLiterals 写成「返回空数组」也能让上面两条绿
    expect(
      unscopedReads("// 说明：不许裸查 FROM cases\ndb.prepare('SELECT id FROM cases WHERE id=?')"),
    ).toHaveLength(1);
  });

  test('豁免按文件生效：名单内放行，名单外同一句话报红', () => {
    const q = "db.prepare('SELECT id FROM cases WHERE id=? AND user_id=?')";
    expect(offenders([{ rel: 'lib/db/cases.ts', src: q }])).toEqual([]);
    for (const rel of ['lib/billing/service-quotes.ts', 'lib/docs/review.ts', 'lib/futures/new-face.ts']) {
      expect(offenders([{ rel, src: q }]), `${rel} 裸查却没报红`).toHaveLength(1);
    }
  });

  /**
   * 变异臂：把期限提醒的软删过滤去掉——那条线的全部既有用例照绿（它们都不建被删的案子），
   * 只有这条守卫与新加的那条行为判据会红。没有这一臂，这份守卫可能只是恰好没抓到东西。
   */
  test('变异臂 L1：deadline-reminder 去掉 c.deleted_at IS NULL → 转红', () => {
    const rel = 'lib/notify/deadline-reminder.ts';
    const real = files.find((f) => f.rel === rel)!.src;
    expect(offenders([{ rel, src: real }]), '前置：现在它是干净的').toEqual([]);

    const mutated = real.replace(' AND c.deleted_at IS NULL', '');
    expect(mutated, '变异没生效：replace 没匹配上，这条对照臂在空转').not.toBe(real);
    expect(offenders([{ rel, src: mutated }])).toHaveLength(1);
  });
});
