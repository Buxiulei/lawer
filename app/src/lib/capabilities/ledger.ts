// app/src/lib/capabilities/ledger.ts
// 「跑完一条能力，往 agent_writes 记那一行」——**两道门共用的唯一实现**。
//
// 【为什么会有这一层（2026-09-10 复审 major#2）】台账此前只有能力壳（withClientRef /
// writeOnce）在记，而**没走能力壳的写能力一行都不留**：截至这一票有 13 条，
// 其中不乏会花钱或不可逆的动作（挂守望、出证、删档案）。它们经 POST /api/mcp 的
// tools/call 与 POST /api/v1/tools/{name} 两道门都是 api key 够得着的，
// 两边都返回 200，事后追「这条是谁写的」时才发现台账是空的——与 2026-09-07 case 2
// 同一个形态：独立写 N 次就会忘 N 次，这次忘的不是幂等，是审计。
//
// 【为什么不在能力自己的 run 里各写一句】那正是被这一票修掉的形态。记账要么长在
// 能力壳里（走幂等那条路的），要么长在门上（本文件）——两处都不长的能力由
// __tests__/registry-guard.test.ts 当场点名。
//
// 【为什么按门记，不在 invokeCapability 里记】派单原话是「invokeCapability 统一调」，
// 落地时改成了按门调，理由是实测的调用图与那句话预设的不一样，**这一条留待经理复核**：
//   · 跑能力的门有两道，而只有一道（工具桥）经 invokeCapability——MCP 那道自己拿着
//     tool.run 跑，放进 invokeCapability 也够不着它；让它改道 invokeCapability 会连带
//     打开一道它此刻并不执行的前置闸（见本次交付的开放问题），那是另一张票的事。
//   · **另一批 REST 路由也调 invokeCapability**（PATCH /cases/{id}、DELETE /cases/{id}、
//     转介删除请求），它们各自按自己的对外路径记过一行了。放进 invokeCapability 的形态是：
//     那几条路由的同一次写入变成台账里的两行，计数从此说谎——除非再给它们加一格
//     「我自己记过了」的开关，而那个开关忘了传就是双写，且不会报错。
// 两道门都调了这一处，由 __tests__/registry-guard.test.ts 逐个文件钉着。
//
// ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
// 不得出现具体领域的字面量（见 registry.ts 抬头，由 __tests__/registry-guard.test.ts 机检）。
// ─────────────────────────────────────────────────────
import type { Database } from 'better-sqlite3';

import { mcpEndpoint, recordAgentWrite, restToolsEndpoint } from '@/lib/audit/agent-writes';
import type { Identity } from '@/lib/auth/identity';

import { isKnownReplay } from './idempotent';
import type { Capability, CapabilityEntrance, CapabilityWriteRow } from './registry';

/** 门 → endpoint 串。别在调用点手拼前缀。 */
function endpointOf(entrance: CapabilityEntrance, tool: string): string {
  return entrance === 'mcp' ? mcpEndpoint(tool) : restToolsEndpoint(tool);
}

/**
 * 这次调用带的 client_ref。
 *
 * **只认在注册表里声明过 `idempotency.clientRef` 的能力**。照单全收 args.client_ref 的形态是：
 * 一个不认这把键的能力（同案覆盖就是覆盖的那一类）被调用方带着同一个 ref 调了两次，
 * 业务侧照常写了两次，而台账因为撞上 uq_agent_writes_client_ref 只留下一行——
 * 台账少一行，且少得毫无痕迹。
 */
function clientRefOf(capability: Capability, args: Record<string, unknown>): string | null {
  if (!capability.idempotency?.clientRef) return null;
  const raw = args.client_ref;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/**
 * 跑完一条能力之后记台账。**只在 run 成功之后调**，参数取真正落库的那一行。
 *
 * 四道闸，缺一条都会让这张表答错它要答的问题：
 *
 * 1. **网页登录态（jwt）一行不落**，与 REST 那侧同口径（recordAgentWriteFromRest 的第 1 条）。
 *    这张表答的是「用户接进来的那个 agent 都写了什么」；把用户自己在页面上点的每一次操作
 *    也灌进来，真正要看的那些行会被淹掉。
 * 2. **只记写能力**。读能力没写任何东西，spend 类的扣费流水在 gongdao_ledger 那边。
 * 3. **声明了 ledger 才由这里记**。没声明的写能力走的是能力壳，它在自己的事务里记过了；
 *    这里再记一行 = 同一次写入占两行。两者互斥由 registry-guard 机检。
 * 4. **写台账失败不拖垮主流程**，只 console.error 点名（同 recordAgentWriteFromRest 第 2 条）：
 *    业务行此刻已经落库，这里再抛出去用户会拿到 500 然后重试——于是那次写入真的发生了两遍。
 *    台账少一行是可查的，业务多一行是查不回来的。
 */
export function recordCapabilityWrite(
  db: Database,
  identity: Identity,
  capability: Capability,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
  entrance: CapabilityEntrance,
): void {
  if (identity.via !== 'api_key') return;
  if (capability.kind !== 'write') return;
  const ledger = capability.ledger;
  if (!ledger) return;

  const endpoint = endpointOf(entrance, capability.name);
  const clientRef = clientRefOf(capability, args);

  let rows: CapabilityWriteRow[];
  try {
    rows = ledger.rowsOf(db, args, result);
  } catch (err) {
    console.error(ledgerFailureNote(capability.name, endpoint, '算不出这次写到了哪一行', err));
    return;
  }

  for (const row of rows) {
    // 定位不到行就**点名**，别静默跳过：rowsOf 已经声明「这次没写东西就回空数组」，
    // 所以走到这里却拿着一个坏 id，说明那份元数据与能力回包对不上了（多半是字段改了名）。
    // 静默跳过的形态是：台账从此少一类行，而没有任何一处会说。
    if (!positive(row.caseId) || !positive(row.targetId)) {
      console.error(
        ledgerFailureNote(
          capability.name,
          endpoint,
          `这次写入定位不到行（case_id=${row.caseId} target=${ledger.targetTable}#${row.targetId}）——` +
            'ledger.rowsOf 回了一个不合法的 id。这次没写东西的话它该回空数组',
        ),
      );
      continue;
    }
    // 【带 ref 的重放不再记第二行】能力自己的幂等（同 client_ref 只落一条）命中时，
    // 第一次那一行已经在表里，且 uq_agent_writes_client_ref 也不许有第二行。
    // 不先查就插的形态是：一次**设计之内的正常重放**每天在生产日志里报一条 error，
    // 而照那条日志去补记会补出一行本不该存在的记录（2026-09-10 复审 major#1 讲的是同一件事）。
    if (clientRef !== null && isKnownReplay(db, { caseId: row.caseId, tool: capability.name, clientRef })) {
      continue;
    }
    try {
      recordAgentWrite(db, {
        caseId: row.caseId,
        keyId: identity.keyId ?? null,
        endpoint,
        method: 'POST',
        clientRef,
        targetTable: ledger.targetTable,
        targetId: row.targetId,
        deduped: row.deduped === true,
      });
    } catch (err) {
      console.error(
        ledgerFailureNote(
          capability.name,
          endpoint,
          `这一行的 INSERT 失败了（target=${ledger.targetTable}#${row.targetId} case_id=${row.caseId}）`,
          err,
        ),
      );
    }
  }
}

function positive(n: unknown): boolean {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

/** 三段式：缺什么 / 为什么缺 / 怎么办。裸报错让人重推一遍你已经推过的那一遍。 */
function ledgerFailureNote(tool: string, endpoint: string, what: string, err?: unknown): string {
  return (
    `[agent_writes] 台账少了一行：${endpoint}（能力 ${tool}）。` +
    `为什么：${what}${err === undefined ? '' : `——${err instanceof Error ? err.message : String(err)}`}；` +
    '而业务写入此刻已经落库，台账少一行是可查的，业务多一行是查不回来的，所以这里不抛。' +
    '怎么办：先照原因排查（能力名与入口都在本条日志里），确认是台账侧的故障再补记；' +
    '**不要重放这次调用**，那一次写入是成功的。'
  );
}
