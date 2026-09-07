'use client';

/**
 * 按领域包的 `intakeSchema` 排出来的首诊流程（设计稿 §13「首诊」行：
 * 工具与校验框架跨领域共用，**字段、必填、校验规则、问法**按领域打包）。
 *
 * ───────────────── ⚠️ 本文件是共用层 ⚠️ ─────────────────
 * 一个具体领域的字段名、问法、词表都不许写死。这里只有「按 kind 怎么问、怎么验、怎么拼」，
 * 问的是什么全在 lib/domains/<key>.ts。由 app/__tests__/page-domain-guard.test.ts 机检。
 * ─────────────────────────────────────────────────────
 *
 * 【为什么缺省领域不走这条路】缺省领域的首诊是一份**手写的六步向导**：每一步有自己的
 * 白话说明、金额初算表、按阶段种的三件事。那些东西 schema 里没有、也不该有
 * （它们是这个行当的产品设计，不是字段元数据）。所以缺省领域**逐字不动**地留在 STEPS 里，
 * 这条路服务的是「还没有人为它手写向导」的领域——**有比没有强**：
 * 没有这条路，第二个领域的用户打开首诊，读到的是上一个行当的六个问题。
 *
 * 【判断与渲染分开】本文件是纯函数（排步、校验、拼请求体），能在 node 环境里逐条验；
 * 画法在 SchemaField.tsx。混在一起的形态是「这一步到底拦没拦住」只能靠点页面才知道。
 */

import { INTAKE_PARAM_OF_KEY } from '@/lib/cases/intake-params';
import { DEFAULT_DOMAIN, type DomainPack, type IntakeFieldSpec } from '@/lib/domains/registry';

/**
 * 有人为它**手写过**首诊向导的领域。
 *
 * 【为什么这份名单住在这里，而不是各处自己判一次】这条分流有两个隔着文件的读者：
 * 排步那一侧（IntakeFlow 的 HANDWRITTEN_FLOWS：手写稿 vs schemaSteps）与
 * 拼请求体那一侧（submit.toIntakePayload：手写映射 vs schemaPayload）。
 * 两侧各判一次的形态是——将来第二个领域也有了手写稿，页面按那份稿子问、
 * 请求体却按 schema 拼，于是**每一格都是空的**，而服务端照收、回包 201、
 * 页面照常跳进驾驶舱，一处报错都没有。收成一份之后，改这条政策只改这一行。
 *
 * 【为什么不是直接读 HANDWRITTEN_FLOWS】那张表的值是 JSX 步骤，住在客户端组件里，
 * 而 submit.ts 是 IntakeFlow 的**被引方**（IntakeFlow 引它取 saveIntake）——
 * 反过来引就成了循环依赖。所以这里放的是那张表的**键**，
 * 两份必须逐字相同由 schema-flow.test.tsx 钉住（多一个少一个都红）。
 */
export const HANDWRITTEN_DOMAINS: readonly string[] = [DEFAULT_DOMAIN];

/**
 * 这个领域有没有人为它手写过向导。有＝那份手写稿逐字不变（问法与请求体都走它），
 * 没有＝按 schema 排步、按 schema 拼请求体。
 */
export function hasHandwrittenFlow(domainKey: string): boolean {
  return HANDWRITTEN_DOMAINS.includes(domainKey);
}

/** 事件列表里的一条。id 只用于 React key 与增删，不进请求体。 */
export interface EventValue {
  id: string;
  /** YYYY-MM-DD，可以留空——记不清日期不该挡住记录 */
  date: string;
  text: string;
}

/** 一格的取值。形态由 field.kind 决定，见 emptyValue。 */
export type FieldValue = string | string[] | EventValue[] | Record<string, string>;

/** 一个字段没填时长什么样。**按 kind 给，不给 undefined**——undefined 会让受控输入框变成非受控。 */
export function emptyValue(field: IntakeFieldSpec): FieldValue {
  switch (field.kind) {
    case 'stringList':
      return [];
    case 'eventList':
      return [];
    case 'record':
      return {};
    default:
      return '';
  }
}

/**
 * 这一步的抬头。取 description 的第一句（到第一个逗号/括号为止）——
 * description 是**逐字对外**的那句话（MCP 工具清单里也是它），
 * 整句摆进 20px 的标题里会折成三行，而后半句本来就是解释，该待在说明那一行。
 */
export function stepTitleOf(field: IntakeFieldSpec): string {
  const head = field.description.split(/[，,。；;（(]/)[0].trim();
  return head || field.key;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** 是不是一个真实存在的日子（'2026-02-31' 要判否）。与服务端 normalizeDateOnly 同口径。 */
export function isRealDate(value: string): boolean {
  if (!DATE_ONLY.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

/** 输入框里那串字 → 分。不是正数就回 null（服务端也会再挡一次）。 */
export function fenOf(raw: string): number | null {
  const yuan = Number.parseFloat(raw);
  if (!Number.isFinite(yuan) || yuan <= 0) return null;
  return Math.round(yuan * 100);
}

/** 校验不过时说的那句话，`{values}` 换成本字段的取值集合（与服务端 checkField 同一条口径）。 */
function invalidMessageOf(field: IntakeFieldSpec): string {
  return (field.invalidMessage ?? '').replace('{values}', (field.values ?? []).join(' / '));
}

/**
 * 这一步还不能往下走的理由；null = 可以走。
 *
 * 【拦下来的话是**领域包自己说的**】说一句放之四海皆准的「有必填项未填」等于没说，
 * 而这句话在每个领域里该怎么说，只有领域包知道（invalidMessage / futureMessage）。
 *
 * 【不必填的字段一律放行】必填与否只看 `field.required`——它与 errorCode 由
 * assertDomainPack 两向锁死，这里不必再判一次「有没有错误码」。
 *
 * @param today 'YYYY-MM-DD'，用来挡住「填了一个将来的日子」
 */
export function fieldBlock(
  field: IntakeFieldSpec,
  value: FieldValue,
  today: string,
): string | null {
  if (!field.required) return null;
  const message = invalidMessageOf(field);
  switch (field.kind) {
    case 'enum':
      return typeof value === 'string' && (field.values ?? []).includes(value) ? null : message;
    case 'text':
      return typeof value === 'string' && value.trim() !== '' ? null : message;
    case 'date': {
      const raw = typeof value === 'string' ? value.trim() : '';
      if (!isRealDate(raw)) return message;
      // 晚于今天的日子格式完全合法，错的是它指向将来——回同一句「格式要写成 YYYY-MM-DD」
      // 的形态是：用户照着改格式，改完还是被拒。
      return raw > today ? (field.futureMessage ?? message) : null;
    }
    case 'money':
      return typeof value === 'string' && fenOf(value) !== null ? null : message;
    case 'stringList':
      return Array.isArray(value) && value.some((v) => typeof v === 'string' && v.trim() !== '')
        ? null
        : message;
    default:
      // eventList / record 没有必填形态（assertDomainPack 不会让它们带 errorCode）
      return null;
  }
}

/** 这一格填过东西没有。末步的「你的档案」按它决定列不列这一条。 */
export function isFilled(value: FieldValue): boolean {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) {
    return value.some((v) =>
      typeof v === 'string' ? v.trim() !== '' : Boolean((v as EventValue).text?.trim()),
    );
  }
  return Object.values(value).some((v) => typeof v === 'string' && v.trim() !== '');
}

/** 一格的值 → 请求体里那个值。转换按 kind，与服务端 checkField 收的形状对齐。 */
function bodyValueOf(field: IntakeFieldSpec, value: FieldValue): unknown {
  switch (field.kind) {
    case 'money':
      return typeof value === 'string' ? fenOf(value) : null;
    case 'stringList':
      return Array.isArray(value)
        ? (value as string[]).map((v) => String(v).trim()).filter((v) => v !== '')
        : [];
    case 'eventList':
      return Array.isArray(value)
        ? (value as EventValue[])
            .filter((e) => e.text.trim() !== '')
            .map((e) => ({ date: e.date, text: e.text }))
        : [];
    case 'record':
      return value;
    default:
      return typeof value === 'string' ? value.trim() : '';
  }
}

/**
 * 各格的值 → 首诊提交的请求体。
 *
 * 【body 上那个键从对照表取，不从 `field.param` 取】`param` 是 **MCP 面**的参数名，
 * 与 REST 面不总是同名（月工资对 MCP 收元、对 REST 收分）。拿 param 当 body 键的形态是：
 * 服务端读不到那一格，回一句「这项要填」，而用户明明填了。
 *
 * 【对照表里没有的键会原样用 param 发出去】那意味着这个字段**没有人接**——
 * 请求照常 201，那一格一路消失。这不是靠这里挡的，是靠
 * lib/cases/__tests__/intake-params.test.ts 在装载期就点名（每个领域包的每个首诊键
 * 都必须在对照表里）。这里保留 param 只是为了不把一个已经填好的值就地丢掉。
 */
export function schemaPayload(
  pack: DomainPack,
  values: Readonly<Record<string, FieldValue>>,
): Record<string, unknown> {
  const body: Record<string, unknown> = {};
  for (const field of pack.intakeSchema) {
    const param = INTAKE_PARAM_OF_KEY[field.key] ?? field.param;
    body[param] = bodyValueOf(field, values[field.key] ?? emptyValue(field));
  }
  return body;
}
