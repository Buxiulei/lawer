// app/src/lib/capabilities/shared.ts
// 各族能力共用的入参小工具与片段。从 lib/mcp/tools.ts 原样搬来，行为逐字不变。
import type { Database } from 'better-sqlite3';

import type { DomainFailure } from '@/lib/cases';
import type { DomainPack } from '@/lib/domains/registry';

import { withClientRef, type AgentWriteTarget } from './idempotent';

/** case_id 在多数能力里都是必填整数，抽出来免得七份重复 */
export const caseIdProp = {
  case_id: { type: 'integer', description: '案件 id' },
} as const;

export function num(value: unknown): number {
  return typeof value === 'number' ? value : Number.NaN;
}

/**
 * 元 → 分。对着人给的是「元」，落库口径全仓是「分」（*_fen）。
 * 非数一律回 NaN，交给领域层的 INVALID_MONTHLY_WAGE 报字段级错，不在这里静默兜底成某个数。
 * 有些客户端把入参一律序列化成字符串，故数字串也认。
 */
export function yuanToFen(value: unknown): number {
  const yuan =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(yuan) ? Math.round(yuan * 100) : Number.NaN;
}

/**
 * 写能力的统一外壳：**领域函数成功才记台账，失败连同台账一起回滚。**
 *
 * 【为什么不是「先调领域函数、成了再记一笔」】那样写在正常路径上看不出问题，
 * 出问题的是两步之间：业务行已经落库、记台账时进程被杀，于是这次写入在台账里不存在——
 * 客户端拿同一个 client_ref 重试，去重查不到那一行，用户档案里就多了一条一模一样的。
 * 这里把两件事放进同一个事务（withClientRef 内部），要么都有要么都没有。
 *
 * 【领域失败怎么回滚】领域函数回的是值（ok:false）不是异常，事务不会自己撤销。
 * 所以这里把失败包成一个私有异常抛出去让事务回滚，在外面拆回原来那个失败结构——
 * 调用方看到的仍是普通的 DomainFailure，一个字都没变。
 */
class DomainAbort extends Error {
  constructor(readonly failure: DomainFailure) {
    super('DOMAIN_FAILURE');
  }
}

/** 重放命中时的说明。客户端要如实告诉用户「这条之前已经写过了」，不要当成又写了一条。 */
export const DEDUPED_NOTE =
  '这次调用与之前某次用了同一个 client_ref，服务端按上次的结果返回，未重复写入。';

export function writeOnce<T extends { ok: true }>(
  db: Database,
  ctx: { caseId: number; tool: string; clientRef?: unknown; keyId?: number | null },
  exec: () => T | DomainFailure,
  targetOf: (result: T) => AgentWriteTarget,
):
  | (T & { deduped: false })
  | { ok: true; deduped: true; id: number; note: string }
  | DomainFailure {
  let fresh: T | undefined;
  try {
    const outcome = withClientRef(db, ctx, () => {
      const res = exec();
      if (res.ok !== true) throw new DomainAbort(res);
      fresh = res;
      return targetOf(res);
    });
    if (!outcome.deduped && fresh) return { ...fresh, deduped: false };
    // 重放命中：exec 根本没跑，手上只有上次落在哪一行。回 id 让调用方自己去读那一行，
    // 不去替它重新拼一份"上次大概是什么样"的载荷——那份东西没人核对得了。
    return { ok: true, deduped: true, id: outcome.target.id, note: DEDUPED_NOTE };
  } catch (err) {
    if (err instanceof DomainAbort) return err.failure;
    throw err;
  }
}

/**
 * 首诊工具的入参 schema，**从领域包的 intakeSchema 生成**（设计稿 §13「首诊」行）。
 *
 * 【为什么不手写第二份】手写的形态是：领域包加了一个必填字段，服务端开始拒收，
 * 而工具清单里根本没有这个参数——调用方照着说明书填齐了仍然被拒，且错误信息里
 * 提到的那个字段它在 schema 里找不到。一处定义、两处消费（校验 + 说明书），就没有这个缝。
 *
 * `tools/list` 拿不到案件上下文，所以调用方给的是缺省领域的包（与其它 enum 同一口径）。
 */
export function intakeInputSchema(pack: DomainPack): Record<string, unknown> {
  const properties: Record<string, unknown> = { ...caseIdProp };
  const required: string[] = ['case_id'];

  for (const f of pack.intakeSchema) {
    switch (f.kind) {
      case 'enum':
        properties[f.param] = { type: 'string', enum: [...(f.values ?? [])], description: f.description };
        break;
      case 'money':
        properties[f.param] = { type: 'number', description: f.description };
        break;
      case 'stringList':
        properties[f.param] = { type: 'array', items: { type: 'string' }, description: f.description };
        break;
      case 'eventList':
        properties[f.param] = {
          type: 'array',
          description: f.description,
          items: {
            type: 'object',
            properties: {
              date: { type: 'string', description: 'YYYY-MM-DD，记不清就留空' },
              text: { type: 'string', description: '发生了什么' },
            },
            required: ['text'],
          },
        };
        break;
      case 'record':
        properties[f.param] = {
          type: 'object',
          description: f.description,
          properties: Object.fromEntries(
            (f.fields ?? []).map((sub) => [sub.key, { type: 'string', description: sub.label }]),
          ),
        };
        break;
      default:
        // text / date 都是一行字符串；日期的格式要求写在 description 里（对外逐字）
        properties[f.param] = { type: 'string', description: f.description };
    }
    if (f.required) required.push(f.param);
  }

  return { type: 'object', properties, required };
}

/**
 * 首诊入参：**对外 param 名 → 内部 key 名**，同样从 `intakeSchema` 派生。
 *
 * 【为什么这一份也不能手写】`intakeInputSchema` 只解决了「说明书从哪来」；工具壳里那份
 * `company_name → companyName` 的对照表是**同一份定义的第二个手抄本**。手抄本的失败形态是：
 * 领域包加了一个字段 ⇒ 说明书宣告了它、服务端也要它，只有壳不认识它，于是它被静默丢弃——
 * 调用方照说明书填齐了仍被拒，而错误信息指名的那个字段它明明填了。
 * 一处定义、三处消费（说明书 / 映射 / 校验），就没有这个缝。
 *
 * 【元→分在这里换】`kind: 'money'` 的字段对外收「元」、落库存「分」（param 名上写着 `_yuan`，
 * key 名上写着 `Fen`）。换算只此一处：非数一律 NaN，交给领域层报字段级错，不在这里兜底成某个数。
 *
 * 【`record` 补空对象】没填时给 `{}` 而不是 `undefined`，与本壳原来的写法逐字一致。
 *
 * 归属那两项（caseId / userId）不在首诊表里——它们来自调用者身份，不是用户填的答案，
 * 所以由调用方自己补上。
 */
export function intakeArgsToInput(
  pack: DomainPack,
  args: Record<string, unknown>,
): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  for (const f of pack.intakeSchema) {
    const raw = args[f.param];
    input[f.key] =
      f.kind === 'money'
        ? yuanToFen(raw)
        : f.kind === 'record'
          ? ((raw ?? {}) as Record<string, unknown>)
          : raw;
  }
  return input;
}
