// app/src/app/api/v1/__tests__/rest-agent-writes-guard.test.ts
//
// 结构守卫：**凡是 api key 够得着的 REST 写路由，都必须记一行 agent_writes。**
//
// ── 为什么要有这条测试（2026-09-07 case 2）──
// 那次事故的形态是：同一把 api key，走 MCP 写进去的动作在台账里查得到，
// 走 REST 端点直接写进去的查不到。两条路都返回 200、都没有一处报错，
// 于是"这条是谁写的"只能靠翻应用日志绕一圈才归得出因。
// 根因不是某一条路由写漏了，是**每条路由各自记得或忘记**——独立写 N 次就会忘 N 次。
// 修法是收唯一入口（lib/audit/agent-writes）+ 这条守卫点名谁没接上。
//
// ── 覆盖判据长什么样 ──
// 逐个 route.ts 扫：有写方法（POST/PATCH/PUT/DELETE）且 api key 够得着（requireIdentity）
// 的，必须出现 recordAgentWriteFromRest( 的调用；漏掉的当场报出文件名。
// **变异臂**：删掉任意一处 recordAgentWriteFromRest 调用 ⇒ 这条红（下方 MUTATION 一节
// 用同一个纯函数在样本上证明了检查函数本身是活的）。
//
// ── 三类不在覆盖内的路由，各有各的理由，都写在这儿 ──
//  ① 面级白名单（auth/oauth/keys/tools/admin/consents）：这些口要么不带案件维度、
//     要么本身就是凭据与后台管理，不属于"agent 替用户改档案"的那一类。
//  ② 只认网页登录态（requireWebSession）：api key 一律 403，**结构上到不了**。
//     不靠名单豁免、由代码形态判定——哪天它改成 requireIdentity，本守卫立刻要求它接台账。
//  ③ EXEMPT 逐条列名并写明原因，且每一条都会被反查（见「豁免不许长草」一节）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const V1_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 台账的唯一 REST 调用点。文件里出现它才算接上了（改名要连着本常量一起改）。 */
const MARKER = 'recordAgentWriteFromRest(';

/** 面级白名单：整个子树都不在覆盖内。派单给定的那六个，不许再往里加。 */
const SURFACE_WHITELIST = ['auth', 'oauth', 'keys', 'tools', 'admin', 'consents'] as const;

/**
 * 逐条豁免。**key 是相对 api/v1 的路径，value 是为什么**。
 *
 * 写理由不是礼貌：一条没有理由的豁免，与"当时嫌麻烦"在下一个读到它的人那里同形。
 */
const EXEMPT: Record<string, string> = {
  'cases/[id]/actions/route.ts':
    '写入交给能力注册表（runCapabilityRest → action_add），台账由能力壳 withClientRef 在事务里记。' +
    '路由再记一行 = 同一次写入在台账里占两行，计数从此说谎。',
  'cases/[id]/chat/route.ts':
    '对话是 SSE 流，一轮里的写入全部发生在 lib/agent 编排层（工具调用经能力壳记台账）。' +
    '路由这一层没有单一 target 可指，且流一开 HTTP 状态就定死 200，事后补记也无处安放。',
  'company/dossiers/quote/route.ts': '只读端点（scope case:read，文件头写明「不扣费、不建档、纯只读」）。',
  'company/probe/route.ts': '只读探测（scope case:read，文件头写明「不动钱，也不建档」）。',
  'company/dossiers/confirm/route.ts':
    '无案件维度：档案下单不挂在任何案件上，而 agent_writes.case_id 是 NOT NULL 外键。' +
    '放宽那一列要重建表，本迁移框架没有事务（见 migrate-idempotency-guard）。账目侧仍有 gongdao_ledger 可查。',
  'redeem/route.ts':
    '同上，无案件维度：兑换是账户级入账，流水在 gongdao_ledger（一码一兑的幂等也在那儿）。',
  'verify/[orderNo]/recheck/route.ts':
    '不带任何鉴权闸（凭订单号复核存证，公开面），没有 identity 可归属，也就没有"哪把 key 写的"可记。',
};

// ───────────────────────── 扫描 ─────────────────────────

/**
 * 剥掉 // 与 /* *\/ 注释，抹成等长空格（保住行号）。
 *
 * **必须先剥再扫**：本仓的路由注释里成段地写着 `requireIdentity` / `requireWebSession`
 * 这类词（例如 complaints/route.ts 的注释逐字解释「为什么走 requireWebSession，不走
 * requireIdentity」）。直接 grep 会把那段解释读成"这条路由 api key 够得着"，
 * 于是一条**结构上就到不了**的路由被要求接台账——而写的人会照做，加上一段永不执行的代码。
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
    } else if (two === '//') {
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

export interface RouteFacts {
  /** 相对 api/v1 的路径，如 `evidence/[id]/void/route.ts` */
  rel: string;
  /** 导出的写方法 */
  writeMethods: string[];
  /** 面级白名单子树里 */
  whitelisted: boolean;
  /** 出现 requireIdentity( ⇒ api key 够得着 */
  apiKeyReachable: boolean;
  /** 只出现 requireWebSession( ⇒ 结构上 api key 到不了 */
  webSessionOnly: boolean;
  /** 出现台账调用点 */
  records: boolean;
  /** 调用点出现了几次（一个文件可以有 PATCH + DELETE 两条写方法，各记各的） */
  recordCalls: number;
}

/** 纯函数：吃「相对路径 + 源码」，吐这条路由的形态。样本臂与真文件走的是同一个它。 */
export function factsOf(rel: string, src: string): RouteFacts {
  const s = stripComments(src);
  const writeMethods = [
    ...new Set(
      [...s.matchAll(/export\s+(?:async\s+)?function\s+(POST|PATCH|PUT|DELETE)\b/g)].map((m) => m[1]),
    ),
  ].sort();
  const head = rel.split('/')[0];
  const hasIdentity = /\brequireIdentity\s*\(/.test(s);
  const hasWebSession = /\brequireWebSession\s*\(/.test(s);
  return {
    rel,
    writeMethods,
    whitelisted: (SURFACE_WHITELIST as readonly string[]).includes(head),
    apiKeyReachable: hasIdentity,
    webSessionOnly: !hasIdentity && hasWebSession,
    records: s.includes(MARKER),
    recordCalls: s.split(MARKER).length - 1,
  };
}

/** 需要接台账的那一批（不含豁免）。 */
export function needsLedger(all: RouteFacts[]): RouteFacts[] {
  return all.filter(
    (f) =>
      f.writeMethods.length > 0 &&
      !f.whitelisted &&
      !f.webSessionOnly &&
      EXEMPT[f.rel] === undefined,
  );
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      out.push(...walk(full));
    } else if (name === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

const ROUTE_FILES = walk(V1_ROOT).sort();
const ALL: RouteFacts[] = ROUTE_FILES.map((f) =>
  factsOf(path.relative(V1_ROOT, f).split(path.sep).join('/'), fs.readFileSync(f, 'utf-8')),
);

// ───────────────────────── 真文件 ─────────────────────────

describe('REST 写路由都记 agent_writes', () => {
  // sanity：先证明扫到了东西。少了这一步，一个"读到空目录"的 bug 会让下面每条断言无脑通过。
  test('确实扫到了 api/v1 下的路由，且识别出了写方法', () => {
    expect(ROUTE_FILES.length).toBeGreaterThanOrEqual(60);
    expect(ALL.filter((f) => f.writeMethods.length > 0).length).toBeGreaterThanOrEqual(30);
    // 反向 sanity：注释里写着 requireIdentity 的那条网页专用路由，不许被判成 api key 够得着。
    const complaints = ALL.find((f) => f.rel === 'complaints/route.ts');
    expect(complaints?.webSessionOnly, 'complaints 只认网页登录态，注释里的 requireIdentity 不算数').toBe(true);
  });

  test('每一条 api key 够得着的写路由都调了 recordAgentWriteFromRest（变异：删掉任意一处 ⇒ 红）', () => {
    const missing = needsLedger(ALL).filter((f) => !f.records);
    expect(
      missing.map((f) => `${f.rel} [${f.writeMethods.join(',')}]`),
      '\n下面这些 REST 写路由 api key 够得着，却没有记 agent_writes：\n' +
        missing.map((f) => `  ${f.rel}  方法：${f.writeMethods.join(',')}`).join('\n') +
        `\n\n怎么办：在写入成功之后调 ${MARKER}db, guard.identity, {...})\n` +
        '（唯一入口在 app/src/lib/audit/agent-writes.ts；jwt 身份它自己会跳过，不必在路由里判）。\n' +
        '这条端点确实不该记的话，把它连同原因加进本文件的 EXEMPT——但先读一遍那张表里已有的理由。\n',
    ).toEqual([]);
  });

  // 「覆盖面不许缩水」：逐条规则拦得住单点删除，拦不住"把机制整个撤掉、顺手把大家都豁免了"。
  // 下限而不是等号：等号会在每次合并新端点时手改一次，而合并时五支各停在旧数——正是要避免的那类常数。
  test('台账调用点不少于 15 处（机制被整体撤掉时这条红）', () => {
    const calls = ALL.reduce((n, f) => n + f.recordCalls, 0);
    const covered = ALL.filter((f) => f.records).map((f) => `${f.rel}×${f.recordCalls}`);
    expect(
      calls,
      `全站只剩 ${calls} 处台账调用点，少于下限 15。当前分布：\n  ${covered.join('\n  ')}\n` +
        '这不是"更干净了"：它意味着写入点被大面积摘掉，而摘掉之后每条路由照常返回 200。\n' +
        '数的是调用点不是文件数——一个文件可以有 PATCH + DELETE 两条写方法，少记一条也要红。\n',
    ).toBeGreaterThanOrEqual(15);
  });
});

// ───────────────────────── 豁免不许长草 ─────────────────────────

describe('EXEMPT 这张表本身', () => {
  test('每一条豁免指向的文件都还在（改名/挪走 ⇒ 红，逼着连豁免一起改）', () => {
    const stale = Object.keys(EXEMPT).filter((rel) => !fs.existsSync(path.join(V1_ROOT, rel)));
    expect(stale, `这些豁免指向的文件已经不在了：\n  ${stale.join('\n  ')}`).toEqual([]);
  });

  test('每一条豁免都确实是一条 api key 够得着的写路由（否则这条豁免是多余的，删掉它）', () => {
    const pointless: string[] = [];
    for (const rel of Object.keys(EXEMPT)) {
      const f = ALL.find((x) => x.rel === rel);
      if (!f) continue; // 上一条已经管了
      const isWrite = f.writeMethods.length > 0;
      // recheck 那条没有任何鉴权闸：它既不是 apiKeyReachable 也不是 webSessionOnly，
      // 豁免仍然必要（没有 identity 可归属），所以这里只排除"根本不是写路由"与"网页专用"两种。
      if (!isWrite || f.whitelisted || f.webSessionOnly) pointless.push(rel);
    }
    expect(
      pointless,
      '这些豁免是多余的（那条路由本来就不在覆盖范围内），删掉它们——' +
        '多余的豁免会让人以为覆盖面比实际小：\n  ' + pointless.join('\n  '),
    ).toEqual([]);
  });

  test('每一条豁免都写了原因，且原因不是一句空话', () => {
    for (const [rel, why] of Object.entries(EXEMPT)) {
      expect(why.length, `${rel} 的豁免原因太短，写清楚"为什么这条不该记台账"`).toBeGreaterThanOrEqual(20);
    }
  });

  test('已经接上台账的路由不许还挂在 EXEMPT 里（陈旧豁免 ⇒ 红）', () => {
    const stale = Object.keys(EXEMPT).filter((rel) => ALL.find((f) => f.rel === rel)?.records);
    expect(
      stale,
      `这些路由已经调了 ${MARKER}，豁免条目是陈旧的，删掉它们：\n  ${stale.join('\n  ')}`,
    ).toEqual([]);
  });
});

// ───────────────────────── 对照臂：检查函数本身是活的 ─────────────────────────
//
// 没有对照，「一条都没漏」与「正则写错了 / 文件没读到 / 注释把整个文件剥空了」输出一模一样。

const SAMPLE_UNCOVERED = `
// 这条注释里写着 recordAgentWriteFromRest( 与 requireWebSession( ——都必须被剥掉、不能凑数
import { requireIdentity } from '@/lib/auth/guard';
export async function POST(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:write');
  if (!guard.ok) return guard.response;
  return apiJson({ ok: true });
}
`;

const SAMPLE_COVERED = SAMPLE_UNCOVERED.replace(
  "  return apiJson({ ok: true });",
  "  recordAgentWriteFromRest(getDb(), guard.identity, { endpoint: '/x', method: 'POST', caseId: 1, targetTable: 't', targetId: 1 });\n  return apiJson({ ok: true });",
);

const SAMPLE_WEB_ONLY = `
// 为什么走 requireWebSession，不走 requireIdentity：账号级动作只认网页登录态
import { requireWebSession } from '@/lib/auth/guard';
export async function POST(req: Request) {
  const guard = requireWebSession(getDb(), req);
  if (!guard.ok) return guard.response;
  return apiJson({ ok: true });
}
`;

const SAMPLE_READ_ONLY = `
import { requireIdentity } from '@/lib/auth/guard';
export async function GET(req: Request) {
  const guard = requireIdentity(getDb(), req, 'case:read');
  return apiJson({ ok: guard.ok });
}
`;

describe('MUTATION 对照臂', () => {
  test('写路由没接台账 ⇒ 判为缺口（这就是「删掉一处调用」的形态）', () => {
    const f = factsOf('x/route.ts', SAMPLE_UNCOVERED);
    expect(f.writeMethods).toEqual(['POST']);
    expect(f.apiKeyReachable).toBe(true);
    expect(f.records).toBe(false);
    expect(needsLedger([f]).map((r) => r.rel)).toEqual(['x/route.ts']);
  });

  test('同一份样本补上那一句调用 ⇒ 不再是缺口（证明两个方向都会动）', () => {
    const f = factsOf('x/route.ts', SAMPLE_COVERED);
    expect(f.records).toBe(true);
    expect(f.recordCalls).toBe(1);
    expect(needsLedger([f])).toHaveLength(1); // 仍在"需要接"的名单里
    expect(needsLedger([f]).filter((r) => !r.records)).toEqual([]);
  });

  test('注释里的 recordAgentWriteFromRest 不算数（剥注释真的在跑）', () => {
    const commentedOut = SAMPLE_UNCOVERED.replace(
      '  return apiJson({ ok: true });',
      '  // TODO 这里以后要 recordAgentWriteFromRest(...)\n  return apiJson({ ok: true });',
    );
    expect(factsOf('x/route.ts', commentedOut).records).toBe(false);
  });

  test('只认网页登录态的路由不进覆盖名单（注释里的 requireIdentity 不算数）', () => {
    const f = factsOf('x/route.ts', SAMPLE_WEB_ONLY);
    expect(f.webSessionOnly).toBe(true);
    expect(needsLedger([f])).toEqual([]);
  });

  test('只读路由不进覆盖名单', () => {
    expect(needsLedger([factsOf('x/route.ts', SAMPLE_READ_ONLY)])).toEqual([]);
  });

  test('白名单子树不进覆盖名单，非白名单同形文件进', () => {
    expect(needsLedger([factsOf('admin/x/route.ts', SAMPLE_UNCOVERED)])).toEqual([]);
    expect(needsLedger([factsOf('other/x/route.ts', SAMPLE_UNCOVERED)])).toHaveLength(1);
  });
});
