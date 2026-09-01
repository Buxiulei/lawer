// app/src/lib/billing/__tests__/ledger-entrance-guard.test.ts
//
// 结构守卫 · 公道值账本只有一个入口。
//
// 【为什么要这一条，而不是靠 redeem 那几个用例】
// 兑换码那条线的所有断言（面值到账、余额 ≡ Σledger、一码一兑、并发只成一次）
// 都建立在「入账走 lib/billing 的 gongdaoGrant」这个前提上——幂等（ref_id 唯一索引）、
// 事务、余额与流水同写，全长在那一个函数里。把 gongdaoGrant 换成五行等价的直写 SQL、
// 两侧都写对，上面那些用例**会全部照绿**：这一轮的账确实平了。丢掉的是下一轮——
// 重放、并发、部分失败时，两条 UPDATE 里只成一条，账面上什么都不会发生，只有对账才发现。
// 所以这条按「写语句」扫源码，不靠人记得。
//
// 【读是允许的】getGongdao / 对账 / 列表都要 SELECT 账本。禁读只会逼人把读也搬进
// lib/billing，换来一层没有意义的转发，且读账本不会让账本说谎。
//
// 【与 lib/company 那条的关系】dossier-billing.test.ts 里有一条同形的守卫，只扫 lib/company。
// 这一条扫**整个 src**，所以覆盖了兑换码这条线（lib/billing/redeem.ts 与 app/api/v1/redeem/route.ts），
// 也覆盖了将来任何一处新的发钱面。两条并存不是重复：那一条把 lib/company 的失败信息说得更具体。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'vitest';

/** src 根：本文件在 src/lib/billing/__tests__/ 下，往上四层。 */
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * 豁免名单：**只有**这两个具名文件可以直写账本，它们就是那个入口本身。
 *
 * 【为什么不豁免整个 lib/billing 目录】那正是「最像扣费/发钱的新代码会落在哪」的目录。
 * 本仓已经吃过一次这个亏：self-host-hint.test.tsx 里那条 gongdaoSettle 守卫原来豁免整个
 * `lib/billing/`，跑变异时存活了——在该目录下新建一个包一层的文件，扣费就真的发生了，断言照样绿。
 * 名单按文件给，加一个文件就得改这一行，改这一行就得说清为什么。
 */
const EXEMPT = ['lib/billing/index.ts', 'lib/billing/fulfillment.ts'];

/**
 * 直写账本的语句。`gongdao` 是余额表，`gongdao_ledger` 是流水事实源，两张都算。
 * 交替顺序无所谓：`gongdao` 先匹配上时 `\b` 会因为后面是 `_` 而失败，回溯到长的那支。
 */
const DIRECT_WRITE_RE =
  /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+`?(gongdao|gongdao_ledger)`?\b/gi;

/**
 * 剥掉注释再扫。
 *
 * 【为什么必须剥】本文件上面这段说明里就写着 `INSERT INTO gongdao_ledger` 的字样，
 * 生产代码的注释里同样会有（解释「为什么不许直写」时几乎一定会引一句）。不剥注释，
 * 守卫会在**只是提到它的注释**上报红，红几次之后就会有人把守卫本身放宽——那是真正的代价。
 *
 * 【为什么手写扫描而不是一行正则】`str.replace(/\/\/.*$/gm, '')` 会把
 * `'https://x'` 里的 `//x'` 一起吃掉，若同一行后面还跟着 SQL 串，就变成**漏报**。
 * 所以这里跟着字符串字面量的状态走：引号里的 `//` 不是注释。
 */
export function stripComments(src: string): string {
  let out = '';
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
      out += c;
      i += 1;
      while (i < src.length) {
        if (src[i] === '\\') {
          out += src.slice(i, i + 2);
          i += 2;
          continue;
        }
        out += src[i];
        i += 1;
        if (src[i - 1] === c) break;
      }
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** 一段源码里的直写语句（已归一空白，便于在失败信息里读）。 */
export function findDirectWrites(src: string): string[] {
  return [...stripComments(src).matchAll(DIRECT_WRITE_RE)].map((m) => m[0].replace(/\s+/g, ' '));
}

/**
 * 待扫的生产文件（相对 src 的 POSIX 路径 + 内容）。测试目录不扫：测试要自己造账本行铺场景。
 *
 * 【为什么单独放过 ENOENT】同批并发跑的 storageAudit.test.ts 会往 src/lib/db/ 里写一批
 * `storageAudit.mutant-*.ts` 临时副本再删掉。readdir 与 readFile 之间那一瞬，文件可能已经没了——
 * 本仓已有一条守卫（theme-contrast.test.ts）正因此偶发 ENOENT（归 test-infra-fix 单专修，本单不碰）。
 * 已经不存在的文件不可能藏着一处直写，跳过它不削弱判据；但**只放过 ENOENT**，
 * 权限/编码等别的读失败必须原样抛出——一条读不动就静默略过的守卫，会在没人察觉时变瞎。
 * 真实生产文件不会在跑测试时消失，上面那组 count==1 的锚点就是这句话的凭据。
 */
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

/** 名单外的直写点。这是守卫的判据本体，对照臂喂合成文件调的也是它。 */
export function offenders(files: { rel: string; src: string }[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    if (EXEMPT.includes(f.rel)) continue;
    for (const hit of findDirectWrites(f.src)) hits.push(`${f.rel}: ${hit}`);
  }
  return hits;
}

describe('结构守卫 · 公道值账本只有 lib/billing 一个入口', () => {
  const files = productionFiles();

  /**
   * 扫描面锚点。
   *
   * 没有这一组，「一处违规都没扫出来」与「目录定位坏了，一个文件都没读到」输出一模一样——
   * 后者会让这条守卫在**永远全绿**的状态下活很久。这里按 count==1 钉死两条必须被覆盖的路径：
   * 兑换码的入账实现，和它的 HTTP 面。
   */
  test('扫描面确实盖住了兑换码这条线（每条锚点恰好一处）', () => {
    expect(path.basename(SRC)).toBe('src');
    expect(files.length).toBeGreaterThan(100);
    for (const anchor of ['lib/billing/redeem.ts', 'app/api/v1/redeem/route.ts']) {
      expect(files.filter((f) => f.rel === anchor), `锚点 ${anchor} 没被扫到（或被扫到多次）`).toHaveLength(1);
    }
    // 豁免名单里的文件也必须真实存在：名单写错一个字，等于悄悄取消了一条豁免/多放一条路
    for (const rel of EXEMPT) {
      expect(files.filter((f) => f.rel === rel), `豁免名单里的 ${rel} 不在扫描结果里`).toHaveLength(1);
    }
  });

  test('名单外没有任何一处直写 gongdao / gongdao_ledger', () => {
    expect(
      offenders(files),
      `这些地方绕过了 lib/billing 直写公道值账本，幂等/事务/余额与流水同写会一起丢：\n${offenders(files).join('\n')}`,
    ).toEqual([]);
  });

  // ── 对照臂：没有它，「扫不出违规」与「正则写错了 / 文件没读到」输出一模一样 ──

  test('扫描器是活的：写法各异的直写都抓得住，纯读取不误伤', () => {
    expect(findDirectWrites("db.prepare('INSERT INTO gongdao_ledger (user_id) VALUES (?)')")).toHaveLength(1);
    expect(findDirectWrites("db.prepare('INSERT OR IGNORE INTO gongdao_ledger (a) VALUES (?)')")).toHaveLength(1);
    expect(findDirectWrites("db.prepare('insert into gongdao_ledger (a) values (?)')")).toHaveLength(1);
    expect(findDirectWrites("db.prepare('UPDATE gongdao SET balance = balance + ?')")).toHaveLength(1);
    expect(findDirectWrites("db.prepare('DELETE FROM gongdao WHERE user_id=?')")).toHaveLength(1);
    expect(findDirectWrites('db.prepare(`INSERT INTO `gongdao_ledger` (a) VALUES (?)`)')).toHaveLength(1);
    // 纯读不误伤
    expect(findDirectWrites("db.prepare('SELECT 1 FROM gongdao_ledger WHERE ref_id=?')")).toEqual([]);
    expect(findDirectWrites("db.prepare('SELECT balance FROM gongdao WHERE user_id=?')")).toEqual([]);
    // 别的表不误伤（token_usage 里也有 gongdao 这几个字，但它不是账本）
    expect(findDirectWrites("db.prepare('INSERT INTO token_usage (cost_li) VALUES (?)')")).toEqual([]);
    expect(findDirectWrites("db.prepare('UPDATE skus SET gongdao=? WHERE id=?')")).toEqual([]);
  });

  test('注释被剥掉：只是提到这句 SQL 的注释不算违规，同一文件里真写了就算', () => {
    expect(findDirectWrites('// 不许 INSERT INTO gongdao_ledger\nconst a = 1;')).toEqual([]);
    expect(findDirectWrites('/* 见 UPDATE gongdao SET balance ... */\nconst a = 1;')).toEqual([]);
    // 反向对照：少了这条，把 stripComments 写成「返回空串」也能让上面两条绿
    expect(
      findDirectWrites("// 说明：不许 INSERT INTO gongdao_ledger\ndb.prepare('INSERT INTO gongdao_ledger (a) VALUES (?)')"),
    ).toHaveLength(1);
    // 字符串里的 `//` 不是注释开头——按行正则会把这行后半截吃掉，变成漏报
    expect(
      findDirectWrites("const u = 'https://x/y'; db.prepare('UPDATE gongdao SET balance = 0')"),
    ).toHaveLength(1);
  });

  test('豁免按文件生效：入口本身放行，名单外同样一句话报红', () => {
    const write = "db.prepare('INSERT INTO gongdao_ledger (user_id, delta) VALUES (?,?)')";
    expect(offenders([{ rel: 'lib/billing/index.ts', src: write }])).toEqual([]);
    expect(offenders([{ rel: 'lib/billing/fulfillment.ts', src: write }])).toEqual([]);
    // 名单外任一处：兑换码的两个文件、以及一个还不存在的将来的发钱面
    for (const rel of ['lib/billing/redeem.ts', 'app/api/v1/redeem/route.ts', 'lib/billing/mystery-grant.ts']) {
      expect(offenders([{ rel, src: write }]), `${rel} 直写却没报红`).toHaveLength(1);
    }
  });

  /**
   * 变异臂：把 redeem.ts 里的 `gongdaoGrant(...)` 换成等价的五行直写（两侧都写对），
   * 兑换码那一批用例会全绿——这条必须转红，否则这条守卫是摆设。
   * 这里不改磁盘上的文件，直接把变异后的源码喂给判据本体。
   */
  test('变异臂 L1：redeem.ts 把 gongdaoGrant 换成等价直写 → 转红', () => {
    const real = files.find((f) => f.rel === 'lib/billing/redeem.ts')!.src;
    // 前置：现在它确实是干净的（不然下面的红说明不了任何事）
    expect(offenders([{ rel: 'lib/billing/redeem.ts', src: real }])).toEqual([]);

    const mutated = real.replace(
      /gongdaoGrant\([\s\S]*?\);/,
      [
        "db.prepare('INSERT OR IGNORE INTO gongdao_ledger (user_id, delta, type, ref_id, meta_json) VALUES (?,?,?,?,?)')",
        "  .run(userId, faceValue, GONGDAO_LEDGER_TYPE.redemption, `redeem-${row.id}`, JSON.stringify({ code }));",
        "db.prepare('INSERT INTO gongdao (user_id, balance) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET balance = balance + ?')",
        '  .run(userId, faceValue, faceValue);',
      ].join('\n'),
    );
    expect(mutated, '变异没生效：replace 没匹配上，这条对照臂在空转').not.toBe(real);

    // 两侧都被点名：流水一条 + 余额一条。逐字断言，免得「抓到一条就算数」掩盖掉漏掉的那条。
    expect(offenders([{ rel: 'lib/billing/redeem.ts', src: mutated }])).toEqual([
      'lib/billing/redeem.ts: INSERT OR IGNORE INTO gongdao_ledger',
      'lib/billing/redeem.ts: INSERT INTO gongdao',
    ]);
  });

  /** 正向臂：入账确实是从 lib/billing 引进来的，不是本地另起了一个同名函数。 */
  test('正向臂：redeem.ts 的入账来自 lib/billing/index 的 gongdaoGrant', async () => {
    const billing = await import('../index');
    expect(typeof billing.gongdaoGrant).toBe('function');
    const src = files.find((f) => f.rel === 'lib/billing/redeem.ts')!.src;
    expect(src).toMatch(/import\s*\{[^}]*\bgongdaoGrant\b[^}]*\}\s*from\s*'\.\/index'/);
  });
});
