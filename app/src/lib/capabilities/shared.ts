// app/src/lib/capabilities/shared.ts
// 各族能力共用的入参小工具与片段。从 lib/mcp/tools.ts 原样搬来，行为逐字不变。
import type { Database } from 'better-sqlite3';

import { factsCardFor } from '@/lib/agent';
import * as cases from '@/lib/cases';
import type { DomainFailure } from '@/lib/cases';
import { SOURCE_TIERS, type AssertedBy } from '@/lib/cases/source-tier';
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
 * 从能力回包里按路径取一个正整数 id；取不到（路径断了、不是正整数）回 0。
 *
 * 台账元数据（Capability.ledger.rowsOf）拿它读 run 的结果——那一层看到的回包类型只剩
 * `Record<string, unknown>`，各条能力自己写一遍 `(r.event as { id: number }).id` 的形态是：
 * 哪天那条能力换了回包字段名，它照常返回 200，而台账那一行的 target_id 静默变成 undefined。
 * 回 0 是个**读得出来的坏值**：记账那一层认它，点名报出来并跳过这一行，不写一行假的。
 */
export function idAt(source: unknown, ...path: string[]): number {
  let cur: unknown = source;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return 0;
    cur = (cur as Record<string, unknown>)[key];
  }
  return typeof cur === 'number' && Number.isInteger(cur) && cur > 0 ? cur : 0;
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

// ───────────────────────── 来源档位与事实令牌 ─────────────────────────

/**
 * 这次写入是**谁**写的（落进 source_tier 那一对列里的 asserted_by）。
 *
 * 【为什么由这一层判，而不是收调用方的入参】asserted_by 回答的是「这句话是谁写进档案的」，
 * 服务端自己就知道（网页登录态 / 一把 api key）。开成入参的形态是：调用方把自己推断出来的
 * 东西标成 `user`，展示层于是不再标黄，那句话从此看起来像本人说过的——
 * 回包 200、字段合法、没有一处会报错（设计稿 §4.4-5「对方 agent 写入标黄」的前提就是它）。
 */
export function assertedByOf(identity: { via: string }): AssertedBy {
  return identity.via === 'api_key' ? 'agent_inferred' : 'user';
}

/** 四档的含义逐字对外，与事实卡上的〔〕同一套。**每条能力各说各的「不传会怎样」**，见下。 */
const SOURCE_TIER_MEANINGS =
  '自述 = 只有当事人自己的说法；书证 = 有已上传的材料支撑；' +
  '对方认可 = 对方书面认过（这一档不必再由本人举证）；裁审认定 = 办案机构认定过。' +
  '**没有把握就不要传**：标高一档会让一句没有支撑的话看起来已经坐实。';

/**
 * 写能力上那一格「这条事实有多硬」。
 *
 * @param blankMeans **不传这一格会发生什么**，由调用点逐字给出。
 *
 * 【为什么这一句不能共用】三条写能力的写入语义不是一回事：时间线是**追加**（新行总要有个档位）、
 * claims 是**覆盖**（同案同 kind 只有一条，再调一次是改这一条）、公司主体是**补充**
 *（命中既有行就在那行上补字段）。于是"不传档位"在三处是三件事——落最弱档、宣告这一版没有支撑、
 * 一个字节都不动已有的档位。此前三处共用同一句「留空落最弱档」，那句话对补充型是**假的**：
 * 对方 agent 照着它以为自己把一行降回了自述（或反过来，以为覆盖型会沿用上一版的「裁审认定」），
 * 而两种误解都读不出来——它调什么都返回 200，档位那一列只是与它以为的不同。
 * 说明书是对方 agent 唯一能读到的用法说明，写一句对三分之二的能力才成立的话，等于没写。
 */
export function sourceTierProp(blankMeans: string) {
  return {
    source_tier: {
      type: 'string',
      enum: [...SOURCE_TIERS],
      description: `这条事实的来源档位。${SOURCE_TIER_MEANINGS}${blankMeans}`,
    },
  } as const;
}

/** 高危写能力上那一格 facts_token。描述逐字对外——它是对方 agent 唯一能读到的用法说明。 */
export const factsTokenProp = {
  facts_token: {
    type: 'string',
    description:
      '事实令牌：从 case_facts 或 case_report_get 的回包里原样取走再传回来，证明这次写入基于当前档案。' +
      '十分钟内有效；档案在这期间变过（你自己刚写的也算）就要重新读一次。' +
      '缺失或过期会拿到 FACTS_STALE，**错误体里直接夹着最新的事实卡与一枚新令牌**，照着重试一次即可。',
  },
} as const;

/**
 * 此刻这个案子的事实卡逐字内容。**全站只有这一个取法**（case_facts 能力、
 * facts_token 的签发与核验都经它）。
 *
 * 【本函数只负责归属那一道门】渲染本身在 lib/agent/facts-entry（全仓唯一入口，
 * 理由见那个文件的头注释）。这里加的是「这个案子是不是这个人的」——
 * 直接 factsCardFor 是能跑通的，那样会把**别人的**事实卡整张交出去，且返回 200。
 */
export function renderCurrentFacts(
  db: Database,
  caseId: number,
  userId: number,
): { ok: true; text: string } | DomainFailure {
  // 归属校验借 lib/cases 的门：直接 loadCaseSnapshot 只按 caseId 取数、不认识 user_id，
  // 那样会把**别人的**事实卡整张交出去，而且返回 200、格式完全正常。
  const owned = cases.getCase(db, { caseId, userId, timelineLimit: 1 });
  if (!owned.ok) return owned;
  return { ok: true, text: factsCardFor(db, caseId) };
}
