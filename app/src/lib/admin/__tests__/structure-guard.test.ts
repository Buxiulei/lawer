// app/src/lib/admin/__tests__/structure-guard.test.ts
//
// 结构守卫。这里钉的四件事都有同一种失败形态：**做错了不报错、不崩，只是安安静静地错着**，
// 所以只能靠机检，不能靠"记得"。
//   ① 后台发钱只经 lib/billing 唯一入口——绕过去直写账本表即红；
//   ② admin_audit 只有一个写入口——写点散开就等于"有没有落审计"取决于每个调用点的记性；
//   ③ /woo 不出现在任何普通用户可达的导航里——入口只有直接输 URL；
//   ④ 前端可选时长与服务端值域一致——分叉的现象是"下拉里有个选项，选了就报 400"。
//
// 每条都配一条**对照臂**（证明这把尺子确实能量出违规），防守卫本身失效后长期假绿。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { ADMIN_MEMBERSHIP_DAYS } from '../actions';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ADMIN_LIB = path.join(SRC, 'lib/admin');
const ADMIN_API = path.join(SRC, 'app/api/v1/admin');
// 后台页面目录。对外地址是 /woo（不叫 admin）；**接口仍在 /api/v1/admin，没跟着改名**，
// 所以页面里那些 apiFetch('/admin/...') 是接口路径、不是页面链接——见 ③ 的反向对照臂。
const ADMIN_UI = path.join(SRC, 'app/woo');
const VIEW = path.join(ADMIN_UI, 'users/_components/AdminUsersView.tsx');

/**
 * 把 TS 行注释、块注释与 SQL 的 `--` 注释抹成等长空格（保住行号）。
 * **必须先剥注释再扫**：本仓的中文注释里反复写着 `INSERT INTO gongdao_ledger`、`/woo/users`
 * 这些串（它们正是被禁的那些东西的名字），直接 grep 全是误判。
 * 同 migrate-idempotency-guard.test.ts 的 stripComments，此处不 import 它——
 * 跨 test 文件 import 会把那边的用例在这边再注册一遍。
 */
function stripComments(src: string): string {
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

/**
 * 递归列出目录下的 .ts/.tsx（可选跳过 __tests__）。
 *
 * 跳过 `*.mutant-*.ts`：storageAudit 那组变异测试会在 src 里**临时**生成又删掉这类文件
 *（`storageAudit.mutant-829746-4.ts`）。全量跑时它们与本文件的扫描并发，
 * 于是"列目录时在、读的时候没了"。它们不是仓库的一部分，不该进扫描面。
 */
function walk(dir: string, opts: { withTests?: boolean } = {}): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!opts.withTests && entry.name === '__tests__') continue;
      out.push(...walk(full, opts));
    } else if (/\.tsx?$/.test(entry.name) && !/\.mutant-/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 读一个文件并剥注释。列目录与读文件之间还有一个窗口（见 walk 的注释），
 * 这一刻消失的文件按「不存在」处理——真实存在的文件不会在这里返回空串，
 * 因为路径就是刚刚从目录里读出来的。
 */
function read(f: string): string {
  try {
    return stripComments(fs.readFileSync(f, 'utf-8'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw err;
  }
}
const rel = (f: string) => path.relative(SRC, f);

// ───────────────────── ① 发钱只经 lib/billing 唯一入口 ─────────────────────

const LEDGER_WRITE = [
  { name: '直写 gongdao_ledger', re: /INSERT\s+(OR\s+\w+\s+)?INTO\s+gongdao_ledger/i },
  { name: '直改 gongdao 余额', re: /UPDATE\s+gongdao\b/i },
  { name: '直写 gongdao 余额行', re: /INSERT\s+(OR\s+\w+\s+)?INTO\s+gongdao\s*\(/i },
];

describe('① 后台发钱必走 lib/billing 唯一入口', () => {
  const surface = [...walk(ADMIN_LIB), ...walk(ADMIN_API), ...walk(ADMIN_UI)];

  test('扫描面非空（守卫真的扫到了文件）', () => {
    expect(surface.length).toBeGreaterThanOrEqual(6);
  });

  test('admin 面**任何文件**都不许自己动账本表', () => {
    const hits: string[] = [];
    for (const file of surface) {
      const src = read(file);
      for (const rule of LEDGER_WRITE) if (rule.re.test(src)) hits.push(`${rel(file)} → ${rule.name}`);
    }
    expect(hits, `绕过 gongdaoGrant 直写账本：\n${hits.join('\n')}`).toEqual([]);
  });

  test('正向锚：actions.ts 确实调了 gongdaoGrant（整段删掉不该还是绿的）', () => {
    const src = read(path.join(ADMIN_LIB, 'actions.ts'));
    expect(src).toMatch(/gongdaoGrant\s*\(/);
    expect(src).toMatch(/from '@\/lib\/billing\/index'/);
  });

  test('对照臂：同一把尺子量违规样本必须报红', () => {
    const bad = stripComments(`
      // 注释里写 INSERT INTO gongdao_ledger 不算
      db.prepare('INSERT INTO gongdao_ledger (user_id, delta) VALUES (?,?)').run(1, 2);
    `);
    expect(LEDGER_WRITE.some((r) => r.re.test(bad))).toBe(true);
    // 只有注释的样本不该报红（证明剥注释这一步没白做）
    const commentOnly = stripComments(`// INSERT INTO gongdao_ledger 只是提了一句`);
    expect(LEDGER_WRITE.some((r) => r.re.test(commentOnly))).toBe(false);
  });
});

// ───────────────────── ② admin_audit 唯一写入口 ─────────────────────

describe('② admin_audit 只有一个写入口', () => {
  const AUDIT_WRITE = /INSERT\s+(OR\s+\w+\s+)?INTO\s+admin_audit/i;

  test('全 src 里写 admin_audit 的非测试文件恰好一个，且是 lib/admin/audit.ts', () => {
    const writers = walk(SRC).filter((f) => AUDIT_WRITE.test(read(f)));
    expect(writers.map(rel)).toEqual(['lib/admin/audit.ts']);
  });

  test('两个动作都经 writeAudit（不是各写各的）', () => {
    const src = read(path.join(ADMIN_LIB, 'actions.ts'));
    expect(src.match(/writeAudit\s*\(/g) ?? []).toHaveLength(2);
  });

  test('admin_audit 没有 UPDATE / DELETE 入口（能被后台自己改的审计表等于没有）', () => {
    for (const file of walk(SRC)) {
      const src = read(file);
      expect(src, rel(file)).not.toMatch(/UPDATE\s+admin_audit/i);
      expect(src, rel(file)).not.toMatch(/DELETE\s+FROM\s+admin_audit/i);
    }
  });
});

// ───────────────────── ③ 后台不出现在任何普通用户可达的导航里 ─────────────────────

describe('③ /woo 只能靠直接输 URL 进', () => {
  /**
   * 字符串字面量形态的 /woo 路径。
   *
   * **只认页面地址，不认接口地址**：后台页面搬到 /woo 后，页面里的 apiFetch 仍打
   * '/admin/users'（接口没改名，前缀 /api/v1）。若这把尺子还盯着 /admin，
   * 它量到的就永远是那些接口串——一把恒亮的尺子等于没有尺子。
   */
  const WOO_HREF = /['"`]\/woo(\/|['"`])/;
  const OUTSIDE = walk(SRC, { withTests: true }).filter(
    (f) => !f.startsWith(ADMIN_UI) && !f.startsWith(ADMIN_API) && !f.startsWith(ADMIN_LIB),
  );

  test('扫描面非空且含壳层导航三件套', () => {
    const names = OUTSIDE.map(rel);
    expect(names).toContain('components/shell/navItems.tsx');
    expect(names).toContain('components/shell/AppSidebar.tsx');
    expect(names).toContain('components/shell/bottomBar.ts');
  });

  test('后台目录之外没有任何指向 /woo 的链接', () => {
    const hits = OUTSIDE.filter((f) => WOO_HREF.test(read(f))).map(rel);
    expect(hits, `这些文件里出现了 /woo 链接：${hits.join(', ')}`).toEqual([]);
  });

  test('后台页不在 (app) 路由组里（在里面就必然要在导航上有个位置）', () => {
    expect(fs.existsSync(path.join(SRC, 'app/woo/users/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(SRC, 'app/woo/codes/page.tsx'))).toBe(true);
    expect(fs.existsSync(path.join(SRC, 'app/(app)/woo'))).toBe(false);
  });

  test('旧地址 /admin 的页面目录不复存在（改名不能留下第二个入口）', () => {
    // 留着旧目录 = 两个地址都通，等于没改名；构建产物里也会同时冒出 /admin/* 两条路由。
    expect(fs.existsSync(path.join(SRC, 'app/admin'))).toBe(false);
    expect(fs.existsSync(path.join(SRC, 'app/(app)/admin'))).toBe(false);
  });

  test('对照臂：同一把尺子量「导航里挂了后台链接」的坏样本必须命中', () => {
    // 违规的两种真实形态：模板里的 href、代码里的跳转
    expect(WOO_HREF.test(stripComments('<Link href="/woo/users">后台</Link>'))).toBe(true);
    expect(WOO_HREF.test(stripComments("router.push('/woo/codes');"))).toBe(true);
  });

  test('反向对照臂：三种不该命中的形态（否则守卫恒红或恒绿，都等于没有）', () => {
    // ① 后台页自己那些 apiFetch('/admin/...') 是接口路径，不是页面链接——不该被认作违规
    expect(WOO_HREF.test(read(VIEW))).toBe(false);
    // ② 前缀撞上但不是这条路由
    expect(WOO_HREF.test("const u = '/woohoo';")).toBe(false);
    // ③ 只写在注释里的地址（read 先剥注释；本页 page.tsx 的抬头就是这种）
    expect(WOO_HREF.test(stripComments('// /woo/users 管理后台。'))).toBe(false);
  });
});

// ───────────────────── ④ 前端值域与服务端一致 + 二次确认 ─────────────────────

describe('④ 管理页：可选时长同源、每个变更都过二次确认', () => {
  const src = read(VIEW);

  test('前端 DAYS 与服务端 ADMIN_MEMBERSHIP_DAYS 逐值相等', () => {
    const m = /const\s+DAYS\s*=\s*\[([^\]]*)\]/.exec(src);
    expect(m, '没找到前端 DAYS 常量').toBeTruthy();
    const days = m![1].split(',').map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
    expect(days).toEqual([...ADMIN_MEMBERSHIP_DAYS]);
  });

  test('挂了 ConfirmDialog，且确认按钮走的是 runPending', () => {
    expect(src).toMatch(/<ConfirmDialog/);
    expect(src).toMatch(/onConfirm=\{\(\) => void runPending\(\)\}/);
  });

  test('两个变更都只在 runPending 里发请求，按钮本身只 setPending', () => {
    // 变更请求恰好两条（调会员 + 发公道值），都在 runPending 内
    const posts = src.match(/method:\s*'POST'/g) ?? [];
    expect(posts).toHaveLength(2);
    const runPending = src.slice(src.indexOf('const runPending'), src.indexOf('const totalPages'));
    expect(runPending).toContain('/membership');
    expect(runPending).toContain('/gongdao');
    // 两个动作按钮各自只登记待确认动作
    expect(src.match(/setPending\(\{\s*kind:/g) ?? []).toHaveLength(2);
    // 任何 onClick 里都不许直接发请求（那就绕过弹层了）
    for (const line of src.split('\n')) {
      if (line.includes('onClick=')) expect(line, line.trim()).not.toContain('apiFetch');
    }
  });

  test('确认文案写明后果，不是「确定」', () => {
    expect(src).toMatch(/confirmLabel=/);
    expect(src).not.toMatch(/confirmLabel="确定"/);
    expect(src).toContain('确认发放');
    expect(src).toContain('确认调为');
  });
});

// ───────────────────── ⑤ 每条后台路由都过 requireAdmin ─────────────────────

describe('⑤ 后台每条路由都过同一个闸门', () => {
  const routes = walk(ADMIN_API).filter((f) => path.basename(f) === 'route.ts');

  test('路由非空，且每条都调 requireAdmin', () => {
    expect(routes.length).toBeGreaterThanOrEqual(4);
    for (const file of routes) {
      const src = read(file);
      expect(src, `${rel(file)} 没过 requireAdmin`).toMatch(/requireAdmin\s*\(/);
      expect(src, `${rel(file)} 没在失败时直接 return`).toMatch(/if\s*\(!guard\.ok\)\s*return guard\.response/);
    }
  });

  test('路由不自己判白名单（判两次就有两套口径）', () => {
    for (const file of routes) {
      expect(read(file), rel(file)).not.toMatch(/ADMIN_UIDS|isAdminUid|adminUids/);
    }
  });
});
