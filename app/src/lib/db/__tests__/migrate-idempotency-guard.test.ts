// app/src/lib/db/__tests__/migrate-idempotency-guard.test.ts
//
// 守卫测试：禁止往 migrate.ts 里写非幂等迁移。
//
// ── 为什么要有这条测试 ──
// runMigrations() 里是 37 个连续的 db.exec()，**没有包在事务里**。
// 2026-08-26 实测：在中途人为抛错，库里留下 22/38 张表，**不回滚**。
// 现在之所以没出事，只因所有迁移都是纯加法、靠 IF NOT EXISTS 能重跑自愈——
// **安全是「改动足够简单」给的，不是框架给的**。
// 一旦有人写了一条不能靠 IF NOT EXISTS 幂等的迁移（改列 / 数据回填 / 拆表 /
// 加 NOT NULL 无默认值），中断就会留下一个**无法自愈的生产库**：重跑既不会
// 前进也不会回退，只能人肉修。
//
// 事务化改造已排期但未落地。在它落地之前，本仓**禁止非幂等迁移**。
// 这条约定此前只存在于口头，现改为机检——口头约定拦不住半夜赶工的人。
//
// ── 解除 / 放宽的正确姿势（别删掉这个文件）──
// 事务化改造（外层 db.transaction() + PRAGMA user_version + 每步版本守卫）落地那天，
// 「非幂等」本身就不再是致命的了——中断会整体回滚，版本号决定下次从哪一步接着跑。
// 那天该做的**不是删掉本测试**，而是：
//   1. 把 RULES 收窄成「只拦没有版本守卫的裸语句」：凡是写在 migrationStep(n, ...)
//      （或届时的等价包装）里的语句一律放行，写在包装之外的照旧拦；
//   2. 保留 stripComments + 对照臂两块不动——它们防的是「检查函数本身失效」，
//      与事务化无关，任何时候都还需要；
//   3. 把本段注释改写成新规则的说明，别让下一个人以为这个文件只能整个删掉；
//   4. 「ALTER TABLE 只许出现在 addColumnIfMissing 函数体内」这条（连同「唯一写点」那条
//      计数测试）改成「只许出现在 addColumnIfMissing 或 migrationStep(n, ...) 体内」——
//      有了版本守卫，每步只跑一次，包装里的裸 ADD COLUMN 不会再撞 duplicate column name。
//      但**放行仍按函数体区间给、不按语句文本给**（按文本豁免的话改个变量名就绕过去了），
//      且计数断言仍写 toBe(N) 不写 <= N：「零处 ALTER TABLE」意味着封装被整段删了、
//      此后所有加列静默失效，那是必须报红的事，不是「更干净了」。
// 在第 1 步真正落地之前，任何「先豁免一下这条迁移」的诉求都应该被拒绝：
// 单条豁免等于把整个守卫变成装饰。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, test, expect } from 'vitest';

const SELF_BASENAME = path.basename(fileURLToPath(import.meta.url));
const MIGRATE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'migrate.ts',
);

// ───────────────────────── 剥注释 ─────────────────────────

/**
 * 把 TS 的行注释、块注释与 SQL 的 `--` 注释整段抹成空格，保留换行。
 *
 * **必须先剥注释再扫**——这是 2026-08-26 亲自踩过的坑：migrate.ts 里有中文注释
 * 写着「永不 UPDATE 旧行」，直接 grep 会把它当成命中；第 12 行的 JSDoc 里写着
 * 「ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS」，也会被 ALTER 规则误判。
 * 只剥 `--` 不够：该文件是 TS，SQL 写在模板字符串里，两种注释都存在。
 *
 * 抹成等长空格（而不是删掉）是为了**保住行号与字符偏移**：违规行号直接可用，
 * 报错时还能回原始文本取整行原文。
 *
 * 刻意**不做字符串识别**：SQL 的 `--` 注释本来就写在模板字符串里面，一旦按
 * 字符串跳过就等于不剥它们。代价是理论上字符串里的 `/*` 会吃掉后文——
 * 用真文件测试里的 sanity 锚点（见 `扫描真文件` 一节）兜住这种「剥过头」。
 */
export function stripComments(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (two === '//' || two === '--') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      blank(i, end);
      i = end;
    } else {
      i++;
    }
  }
  return out.join('');
}

// ──────────────── 定位 addColumnIfMissing 函数体 ────────────────

/**
 * 在剥完注释的源码里定位 `function addColumnIfMissing` 的函数体字符区间。
 *
 * 加列的**唯一合法写点**就是这个封装：它先 `PRAGMA table_info` 判断列在不在、不在才 ALTER，
 * 所以可重跑。SQLite 的 `ALTER TABLE ... ADD COLUMN` **没有 `IF NOT EXISTS`**
 * （2026-08-28 实测：写了报 `near "EXISTS": syntax error`），裸写的那条第二次执行
 * 报 `duplicate column name`，runMigrations 当场抛错 ⇒ **应用起不来**。
 * 比「半途炸掉留个残库」更直接一档：残库还能读，起不来的应用连读都没有。
 *
 * 放行按**位置**给，不按语句文本给。按文本豁免（比如放过长得像
 * `ALTER TABLE ${table} ADD COLUMN` 的那一串）等于把变量名改一改就能绕过去。
 *
 * 找不到函数、或花括号不配对，一律返回 null——此时全文任何 ALTER TABLE 都算违规。
 * **定位失效时的方向是「全拦」不是「全放」**：放行的失败是静默的，拦截的失败会红给人看。
 */
export function addColumnIfMissingBody(scrubbed: string): { start: number; end: number } | null {
  const sig = /\bfunction\s+addColumnIfMissing\b/.exec(scrubbed);
  if (!sig) return null;
  const open = scrubbed.indexOf('{', sig.index + sig[0].length);
  if (open === -1) return null;
  let depth = 0;
  for (let i = open; i < scrubbed.length; i++) {
    if (scrubbed[i] === '{') depth++;
    else if (scrubbed[i] === '}' && --depth === 0) return { start: open, end: i + 1 };
  }
  return null;
}

// ───────────────────────── 扫描规则 ─────────────────────────

export type Violation = { rule: string; line: number; text: string; matched: string };

/** 二次判定要用到的、正则自己看不见的整份源码上下文。 */
type ScanCtx = {
  /** 该字符偏移是否落在 addColumnIfMissing 的函数体里 */
  inAddColumnHelper: (index: number) => boolean;
};

type Rule = {
  /** 规则名，出现在报错里 */
  name: string;
  /** 在剥完注释的源码上跑的正则 */
  re: RegExp;
  /** 二次判定：返回 true 才算违规。缺省即「匹配到就算违规」 */
  violates?: (m: RegExpExecArray, ctx: ScanCtx) => boolean;
  /** 为什么拦它 */
  why: string;
};

const RULES: Rule[] = [
  {
    name: 'DROP',
    re: /\bDROP\b/gi,
    why: 'DROP 不可逆：中断后重跑要么已经没了要么再也建不回来',
  },
  {
    // ALTER TABLE 只允许 ADD（ADD COLUMN 由 addColumnIfMissing 的 PRAGMA table_info 守卫，
    // 是幂等的）。RENAME / DROP / MODIFY 以及未来任何新动作一律拦——白名单而非黑名单，
    // 免得 SQLite 加了新语法就漏网。
    name: 'ALTER-TABLE-非ADD',
    re: /\bALTER\s+TABLE\s+(\S+)\s+([A-Za-z_]+)/gi,
    violates: (m) => m[2].toUpperCase() !== 'ADD',
    why: 'ALTER TABLE 除 ADD COLUMN 外都会改变既有列/表，重跑不自愈',
  },
  {
    // 上一条按**语法**开白名单（放行 ADD），2026-08-27 那版就漏在这儿：
    // 「绕开封装、裸 db.exec 一条 ALTER TABLE t ADD COLUMN c」四条规则一条都不命中。
    // 白名单粒度改成按**唯一写点**开：放行的不是 ADD COLUMN 这个语法，
    // 是 addColumnIfMissing 这个封装（区间判定，见 addColumnIfMissingBody 的注释）。
    // 上一条保留：它管的是 RENAME / DROP / MODIFY 那一类，与本条各拦各的。
    name: 'ALTER-TABLE-绕开-addColumnIfMissing',
    re: /\bALTER\s+TABLE\b/gi,
    violates: (m, ctx) => !ctx.inAddColumnHelper(m.index),
    why: '加列一律走 addColumnIfMissing（它用 PRAGMA table_info 守卫，可重跑）；裸 ALTER TABLE ADD COLUMN 第二次执行必报 duplicate column name（SQLite 没有 ADD COLUMN IF NOT EXISTS），runMigrations 抛错、应用起不来',
  },
  {
    // 注意与 `ON DELETE CASCADE` / `ON DELETE SET NULL` 区分：那是外键引用动作，
    // 满篇都是，误杀了这条规则就没法用。要 FROM 才算。
    name: 'DELETE-FROM',
    re: /\bDELETE\s+FROM\b/gi,
    why: '迁移里删数据 = 数据回填的反面，中断后无从判断删到哪一行',
  },
  {
    // 同样要躲开外键的 `ON UPDATE SET NULL` / `ON UPDATE CASCADE`：
    // 用 `UPDATE <目标> SET` 三段式，并显式排除 UPDATE 后面直接跟 SET 的情形。
    name: 'UPDATE-SET',
    re: /\bUPDATE\s+(?:OR\s+\w+\s+)?(?!SET\b)\S+\s+SET\b/gi,
    why: '数据回填不幂等：重跑会二次改写已改过的行',
  },
  {
    name: 'INSERT-INTO',
    re: /\bINSERT\s+(?:OR\s+\w+\s+)?INTO\b/gi,
    why: '迁移里写数据要靠唯一索引兜幂等，很容易写漏；种子数据请走独立的 seed 函数',
  },
  {
    name: 'CREATE-缺IF-NOT-EXISTS',
    re: /\bCREATE\s+(?:TEMP(?:ORARY)?\s+)?(?:UNIQUE\s+)?(?:VIRTUAL\s+)?(?:TABLE|INDEX|VIEW|TRIGGER)\b(?!\s+IF\s+NOT\s+EXISTS\b)/gi,
    why: '不带 IF NOT EXISTS 的 CREATE 第二次执行就报错，整条迁移路径从此卡死',
  },
  {
    // 超出派单清单的一条：ADD COLUMN 加 NOT NULL 而不给 DEFAULT。
    // SQLite 会直接报错（Cannot add a NOT NULL column with default value NULL），
    // 于是在没有事务的 runMigrations 里就是「跑到一半炸掉、前面的改动全留着」。
    name: 'ADD-COLUMN-NOT-NULL-无DEFAULT',
    re: /addColumnIfMissing\s*\([\s\S]*?\)/g,
    violates: (m) => /NOT\s+NULL/i.test(m[0]) && !/DEFAULT/i.test(m[0]),
    why: 'SQLite 拒绝给已有表加无默认值的 NOT NULL 列，会在迁移中途抛错',
  },
];

/**
 * 纯函数：吃源码文本，吐违规列表。真文件与对照臂样本走的是同一个它。
 * 抽成纯函数是为了让对照臂能证明「检查函数本身是活的」——
 * 没有对照，「检查通过」和「正则写错了 / 文件没读到 / 注释把整个文件剥空了」
 * 三者的输出一模一样。
 */
export function scanForNonIdempotent(src: string): Violation[] {
  const scrubbed = stripComments(src);
  const originalLines = src.split('\n');
  const found: Violation[] = [];

  const body = addColumnIfMissingBody(scrubbed);
  const ctx: ScanCtx = {
    inAddColumnHelper: (i) => body !== null && i >= body.start && i < body.end,
  };

  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags);
    let m: RegExpExecArray | null;
    while ((m = re.exec(scrubbed)) !== null) {
      if (m[0].length === 0) { re.lastIndex++; continue; }   // 防零宽匹配死循环
      if (rule.violates && !rule.violates(m, ctx)) continue;
      const line = scrubbed.slice(0, m.index).split('\n').length;
      found.push({
        rule: rule.name,
        line,
        text: (originalLines[line - 1] ?? '').trim(),
        matched: m[0].replace(/\s+/g, ' ').trim().slice(0, 80),
      });
    }
  }
  return found.sort((a, b) => a.line - b.line || a.rule.localeCompare(b.rule));
}

/** 报错要能直接照着改：给行号、给原文、给拦它的理由。 */
export function formatViolations(vs: Violation[]): string {
  if (vs.length === 0) return '';
  const why = new Map(RULES.map((r) => [r.name, r.why]));
  return vs
    .map((v) => `  migrate.ts:${v.line}  [${v.rule}] ${v.text}\n      命中：${v.matched}\n      拦它的理由：${why.get(v.rule) ?? ''}`)
    .join('\n');
}

// ───────────────────────── 剥注释本身的测试 ─────────────────────────

/** 抹注释留下的是行尾空格（为了保住偏移），比对时统一削掉。 */
const rtrimLines = (s: string) => s.split('\n').map((l) => l.replace(/\s+$/, '')).join('\n');

describe('stripComments', () => {
  test('剥掉 // 行注释', () => {
    expect(rtrimLines(stripComments('a // DROP TABLE x\nb'))).toBe('a\nb');
  });

  test('剥掉 -- SQL 行注释（写在模板字符串里的那种）', () => {
    const src = 'CREATE TABLE IF NOT EXISTS t (\n  s TEXT -- sent | failed\n);';
    expect(stripComments(src)).not.toMatch(/sent \| failed/);
    expect(stripComments(src)).toContain('CREATE TABLE IF NOT EXISTS t');
  });

  test('剥掉 /* */ 块注释，跨行也剥', () => {
    expect(stripComments('a /* DROP\nTABLE */ b').replace(/ +/g, ' ')).toBe('a \n b');
  });

  test('保留行号：抹成等长空格而不是删行', () => {
    const src = 'l1 // x\n/* l2\nl3 */\nl4';
    const out = stripComments(src);
    expect(out.split('\n')).toHaveLength(4);
    expect(out.length).toBe(src.length);
    expect(out.split('\n')[3]).toBe('l4');
  });

  test('未闭合的块注释剥到文件尾（不至于抛错）', () => {
    expect(stripComments('a /* b').trim()).toBe('a');
  });

  test('真实踩坑复现：注释里的 UPDATE / ALTER 不该被当成命中', () => {
    // 两条都抄自 migrate.ts 真身：第 376 行与第 12 行。
    const src = [
      '  //    永不 UPDATE 旧行。这张表将来可能要用来证明「我们没有反复骚扰用户」，',
      '/** SQLite ALTER TABLE ADD COLUMN 不支持 IF NOT EXISTS；用 PRAGMA table_info 判断后跳过。 */',
      '// 一律 CREATE TABLE / INDEX IF NOT EXISTS',
      '// 幂等由唯一索引 + INSERT OR IGNORE 保证',
    ].join('\n');
    expect(stripComments(src).trim()).toBe('');
    expect(scanForNonIdempotent(src)).toEqual([]);
  });
});

// ───────────────────────── 对照臂：已知的坏样本必须报错 ─────────────────────────
//
// 硬要求：对照必须**在本文件内、走同一个 scanForNonIdempotent**。
// 外挂的一次性验证脚本可以被跳过、被注释掉、被「这次先不跑」——那种哨形同虚设。

/** 每一条都必须被抓住。用与真文件同样的写法（db.exec + 模板字符串）。 */
const NON_IDEMPOTENT_SAMPLE = `
// 对照臂样本。注释里的这些字样必须被剥掉、不能凑数：DROP TABLE / DELETE FROM / INSERT INTO
export function badMigration(db: Database.Database): void {
  db.exec(\`DROP TABLE foo;\`);
  db.exec(\`CREATE TABLE bar (id INTEGER PRIMARY KEY);\`);
  db.exec(\`CREATE UNIQUE INDEX idx_bar ON bar (id);\`);
  db.exec(\`ALTER TABLE bar RENAME COLUMN id TO bar_id;\`);
  db.exec(\`ALTER TABLE bar DROP COLUMN legacy;\`);
  db.exec(\`ALTER TABLE bar ADD COLUMN tier TEXT NOT NULL DEFAULT 'daily'\`);
  db.exec(\`DELETE FROM bar WHERE id > 0;\`);
  db.exec(\`UPDATE bar SET status = 'x' WHERE status IS NULL;\`);
  db.exec(\`INSERT INTO bar (id) VALUES (1);\`);
  addColumnIfMissing(db, 'bar', 'nn', 'TEXT NOT NULL');
}
`;

/** 每一条都是合法写法，一条都不许误杀。 */
const IDEMPOTENT_SAMPLE = `
export function goodMigration(db: Database.Database): void {
  db.exec(\`
    CREATE TABLE IF NOT EXISTS bar (
      id      INTEGER PRIMARY KEY AUTOINCREMENT,
      case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
      ref_id  INTEGER REFERENCES refs(id) ON DELETE SET NULL ON UPDATE SET NULL,
      peer_id INTEGER REFERENCES refs(id) ON UPDATE CASCADE,
      status  TEXT NOT NULL DEFAULT 'sent',   -- sent | failed | skipped
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_bar_case ON bar (case_id, id);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_bar ON bar (case_id) WHERE status = 'sent';
  \`);
  addColumnIfMissing(db, 'bar', 'intake_stage', 'TEXT');
  addColumnIfMissing(db, 'bar', 'tier', "TEXT NOT NULL DEFAULT 'daily'");
}

// 封装本体。**同类正对照**：函数体区间内的这一处 ALTER TABLE 必须放行——
// 否则「加列只许走 addColumnIfMissing」那条规则会把唯一那个写点也拦掉，等于禁止加列。
function addColumnIfMissing(db: Database.Database, table: string, col: string, ddl: string): void {
  const exists = (db.prepare(\`PRAGMA table_info(\${table})\`).all() as { name: string }[]).some((r) => r.name === col);
  if (!exists) db.exec(\`ALTER TABLE \${table} ADD COLUMN \${col} \${ddl}\`);
}
`;

describe('scanForNonIdempotent 对照臂', () => {
  const hits = scanForNonIdempotent(NON_IDEMPOTENT_SAMPLE);

  test('坏样本必须被判违规（否则说明检查函数本身已经失效）', () => {
    expect(hits.length).toBeGreaterThan(0);
  });

  test.each([
    ['DROP', 'DROP TABLE foo'],
    ['CREATE-缺IF-NOT-EXISTS', 'CREATE TABLE bar'],
    ['CREATE-缺IF-NOT-EXISTS', 'CREATE UNIQUE INDEX idx_bar'],
    ['ALTER-TABLE-非ADD', 'ALTER TABLE bar RENAME'],
    ['ALTER-TABLE-非ADD', 'ALTER TABLE bar DROP'],
    ['ALTER-TABLE-绕开-addColumnIfMissing', 'ALTER TABLE bar ADD COLUMN tier'],
    ['DELETE-FROM', 'DELETE FROM bar'],
    ['UPDATE-SET', 'UPDATE bar SET'],
    ['INSERT-INTO', 'INSERT INTO bar'],
    ['ADD-COLUMN-NOT-NULL-无DEFAULT', "addColumnIfMissing(db, 'bar', 'nn'"],
  ])('规则 %s 抓到了 %s', (rule, snippet) => {
    const norm = snippet.replace(/\s+/g, ' ');
    expect(
      hits.some((h) => h.rule === rule && h.text.replace(/\s+/g, ' ').includes(norm)),
      `没抓到：[${rule}] ${snippet}\n实际命中：\n${formatViolations(hits)}`,
    ).toBe(true);
  });

  test('报错信息带行号与原文（不是干巴巴一句「发现非幂等语句」）', () => {
    const msg = formatViolations(hits);
    expect(msg).toMatch(/migrate\.ts:\d+/);
    expect(msg).toContain('DROP TABLE foo');
    expect(msg).toContain('拦它的理由');
  });

  test('合法写法一条都不许误杀（外键 ON DELETE/ON UPDATE、封装内的 ADD COLUMN、部分索引）', () => {
    const v = scanForNonIdempotent(IDEMPOTENT_SAMPLE);
    expect(formatViolations(v)).toBe('');
  });

  // 放行按**位置**给，不按**语句文本**给。这条钉的就是这个差别：
  // 下面这句和 addColumnIfMissing 体内那句**一模一样**（连变量名都一样），
  // 只因为它写在封装外面就必须被拦。按文本豁免的实现会在这里放行。
  test('同一条 ALTER 写在封装外照样拦（豁免按区间给、不按语句文本给）', () => {
    const sneaky =
      IDEMPOTENT_SAMPLE +
      '\nfunction sneakyMigration(db, table, col, ddl) {\n' +
      '  db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);\n' +
      '}\n';
    const v = scanForNonIdempotent(sneaky);
    expect(
      v.filter((x) => x.rule === 'ALTER-TABLE-绕开-addColumnIfMissing'),
      `封装外的那条 ALTER 没被拦住：\n${formatViolations(v)}`,
    ).toHaveLength(1);
  });

  // 定位失效时的方向：封装找不到（改名/删掉/花括号不配对）⇒ 全文 ALTER TABLE 一律拦。
  // 这条钉的是「失败要红，不要静默放行」——放行的失败没人看得见。
  test('找不到 addColumnIfMissing 时，连封装内那条也拦（fail closed）', () => {
    const renamed = IDEMPOTENT_SAMPLE.replace(/addColumnIfMissing/g, 'addCol2');
    expect(addColumnIfMissingBody(renamed)).toBeNull();
    expect(
      scanForNonIdempotent(renamed).some((x) => x.rule === 'ALTER-TABLE-绕开-addColumnIfMissing'),
    ).toBe(true);
  });
});

// ───────────────────────── 扫描真文件 ─────────────────────────

describe('migrate.ts 不含非幂等迁移', () => {
  const src = fs.readFileSync(MIGRATE_PATH, 'utf8');
  const scrubbed = stripComments(src);

  // sanity：先证明「我们真的读到了那个文件，而且没把它剥空」。
  // 少了这一步，一个读空 / 剥过头的 bug 会让下面的断言无脑通过。
  test('确实读到了 migrate.ts，且剥注释没把它剥空', () => {
    expect(src.length).toBeGreaterThan(10_000);
    expect(scrubbed).toContain('export function runMigrations');
    expect((scrubbed.match(/CREATE TABLE IF NOT EXISTS/gi) ?? []).length).toBeGreaterThanOrEqual(30);
    // 合法的 ALTER TABLE ADD COLUMN 必须还在——它是「不许误杀」那条的活靶子：
    // 它由 addColumnIfMissing 的 PRAGMA table_info 守卫，是幂等的、合法的。
    // 当前存量迁移区有 2 处调用（threads.intake_stage、company_watches.tier）。
    expect(scrubbed).toContain('ALTER TABLE ${table} ADD COLUMN');
    expect((scrubbed.match(/addColumnIfMissing\(db,/g) ?? []).length).toBeGreaterThanOrEqual(2);
  });

  // 两层防线的第二层：migrate.ts 顶部那段警示注释，在人**动手之前**就告诉他这里没有事务、
  // 该找谁。机检拦的是「写的人不知道有这条规矩」，注释省的是「写完被打回来」的那趟往返——
  // 覆盖时点不同，缺一个都留口子。
  // 这里锁的是注释里那句「本约束由 xxx 机检」的指针：文件一旦被改名/挪走，指针就成了假话，
  // 「这是机检的」也就变回一句劝告。用本文件的真实文件名比对，改名当场红，逼着把注释一起改。
  test('migrate.ts 顶部警示注释在，且指名了本测试文件', () => {
    expect(src).toContain(SELF_BASENAME);
    expect(src).toContain('本迁移框架没有事务');
    expect(src).toContain('先找数据表管理（WS1）');
  });

  // 「唯一写点」：全文 ALTER TABLE 必须**恰好一处**，且落在 addColumnIfMissing 体内。
  //
  // 为什么是 toBe(1) 而不是 <= 1：`<= 1` 会放过「零处」，而零处意味着 addColumnIfMissing
  // 的 ALTER 那句（甚至整个封装）被删了——此后每一次 addColumnIfMissing 调用都是空转，
  // 加列**静默失效**：迁移不报错、列却没加上，读侧拿到的是 no such column。
  // 「应为 0 的期望必须配一条同类应 >0」的另一种写法：这里两个方向各自会红。
  test('全文只有一处 ALTER TABLE，且落在 addColumnIfMissing 函数体内', () => {
    const hits = [...scrubbed.matchAll(/\bALTER\s+TABLE\b/gi)];
    expect(
      hits.length,
      `ALTER TABLE 出现了 ${hits.length} 处（应为 1）：\n` +
        hits
          .map((h) => `  migrate.ts:${scrubbed.slice(0, h.index).split('\n').length}`)
          .join('\n') +
        '\n多出来的那处 = 绕开了 addColumnIfMissing 的裸 ALTER，第二次执行报 duplicate column name；\n' +
        '一处都没有 = 封装里那句被删了，此后所有 addColumnIfMissing 调用空转、加列静默失效。\n',
    ).toBe(1);

    const body = addColumnIfMissingBody(scrubbed);
    expect(body, '没定位到 function addColumnIfMissing（被改名或挪走了？）').not.toBeNull();
    expect(hits[0].index).toBeGreaterThanOrEqual(body!.start);
    expect(hits[0].index).toBeLessThan(body!.end);
  });

  test('全文没有非幂等语句', () => {
    const v = scanForNonIdempotent(src);
    expect(
      formatViolations(v),
      '\nmigrate.ts 里出现了非幂等迁移语句。\n' +
        'runMigrations() 的 37 个 db.exec() 不在事务里，中途报错不回滚——\n' +
        '非幂等的那一条会留下一个重跑也修不好的生产库。\n' +
        '先做事务化（见本文件顶部注释的解除姿势），再来加这种迁移。\n',
    ).toBe('');
  });
});
