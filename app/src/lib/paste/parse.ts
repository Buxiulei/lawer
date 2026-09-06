// app/src/lib/paste/parse.ts
// 把用户粘回来的一整段 AI 回复解析成待写入的条目（设计稿 §15 路径 D ③）。
//
// 【本文件不碰 db、不写入】解析与校验是纯函数：同样的文本任何时候都得出同样的条目。
// 写入在 apply.ts，去重预测在 index.ts——那两件事要读库，这一件不该。
//
// 【三种坏输入必须长得不一样】没有块 / 块里不是合法 JSON / 块里是合法 JSON 但形状不对，
// 在用户那里是三件不同的事，对应三种不同的下一步动作（让 AI 补一个块 / 让它重发一次 /
// 逐条改内容）。合成一句「解析失败」的形态是：用户把同一段又粘三遍，每次都得到同一句话。
import * as cases from '@/lib/cases';
import type { DomainPack } from '@/lib/domains/registry';

import { BLOCK_KEYS, FENCE_TAG, type BlockKey } from './protocol';

/** 一条待写入的条目：解析后、写入前的中间形态 */
export interface PasteItem {
  /** 全批唯一序号（跨类别连续）。client_ref 与「用户勾了哪几条」都按它认条目 */
  index: number;
  kind: BlockKey;
  /** 给人看的一句话：这一条要写什么 */
  summary: string;
  /** 写入时传给能力的入参（已归一：金额换成分、时间换成 ISO） */
  args: Record<string, unknown>;
  /** 校验没过的原因；有值就不可写入 */
  error: { code: string; message: string } | null;
}

export type ParseFailure = {
  ok: false;
  status: number;
  errorCode: 'NO_BLOCK' | 'BAD_JSON' | 'BAD_SHAPE';
  message: string;
};

export interface ParseSuccess {
  ok: true;
  items: PasteItem[];
  /** 块里出现了但我们不认的顶层键，原样报给用户（不静默吞） */
  unknownKeys: string[];
}

/**
 * 取最后一个 ```tubashu 围栏块的内容。
 *
 * 【为什么自己扫而不是一条正则】反引号围栏可以是三个以上，块里也可能出现三个反引号
 * （模型示范 JSON 时常见）。逐行扫按「同长度以上的围栏才收尾」处理，比正则可读，
 * 也不会在贪婪匹配下把两个块之间的正文吞进来。
 */
export function extractBlock(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let last: string | null = null;
  let open: { fence: string; body: string[] } | null = null;
  for (const line of lines) {
    if (open) {
      const close = /^\s*(`{3,})\s*$/.exec(line);
      if (close && close[1].length >= open.fence.length) {
        last = open.body.join('\n');
        open = null;
      } else {
        open.body.push(line);
      }
      continue;
    }
    const start = new RegExp(`^\\s*(\`{3,})\\s*${FENCE_TAG}\\s*$`, 'i').exec(line);
    if (start) open = { fence: start[1], body: [] };
  }
  // 只有开头没有收尾（客户端把回复截断了）：仍按已收到的部分算一个块，
  // 让 JSON 解析去判它完不完整——那一步的报错比「没有块」更贴近真实原因。
  if (open && open.body.length) last = open.body.join('\n');
  return last;
}

function noBlock(): ParseFailure {
  return {
    ok: false,
    status: 400,
    errorCode: 'NO_BLOCK',
    message:
      '这段文字里没有找到 ```' +
      FENCE_TAG +
      ' 结构块。' +
      '原因通常是助手忘了在回复末尾附上它（这类客户端每轮都要被提醒一次）。' +
      '回到那个对话里说一句「把这一轮的 ' +
      FENCE_TAG +
      ' 结构块补上」，再把它的回复整段复制回来。',
  };
}

function badJson(reason: string): ParseFailure {
  return {
    ok: false,
    status: 400,
    errorCode: 'BAD_JSON',
    message:
      `找到了结构块，但里面不是合法 JSON（${reason}）。` +
      '常见原因是复制时漏了半截、或助手在 JSON 里写了注释。' +
      '回到那个对话里说「把结构块重新发一遍，只要 JSON 本身」，再整段复制回来。',
  };
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown): string | null =>
  typeof v === 'string' && v.trim() ? v.trim() : null;

/** ISO8601 时刻；合法则归一成 ISO 串 */
function isoTime(v: unknown): string | null {
  const s = str(v);
  if (!s) return null;
  const ms = Date.parse(s);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** YYYY-MM-DD；不做时区换算（锚点是「哪一天」，不是「哪一刻」） */
function isoDate(v: unknown): string | null {
  const s = str(v);
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  return Number.isNaN(Date.parse(`${s}T00:00:00Z`)) ? null : s;
}

/**
 * 元 → 分。
 *
 * 【为什么不用 Math.round(v * 100)】0.29 * 100 在浮点里是 28.999999999999996，
 * 四舍五入回来是对的，但 12000.005 这类输入会静默变成另一个数。这里要求换算后
 * 必须落在整分上（差值小于半分才收），落不上就报错让人去改，不替他四舍五入——
 * 替他舍进去的那一分，是他拿去跟对方谈的那个数的一部分。
 */
function yuanToFen(v: unknown): number | null {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return null;
  const fen = n * 100;
  const rounded = Math.round(fen);
  return Math.abs(fen - rounded) < 0.005 ? rounded : null;
}

function invalid(code: string, message: string): { code: string; message: string } {
  return { code, message };
}

/**
 * 解析 + 逐条校验。校验不过的条目**照样返回**（error 有值），不整批拒收：
 * 一条日期写错就整段作废的形态是，用户要么放弃、要么回去让 AI 重写一遍全部内容。
 */
export function parsePasteBack(text: string, pack: DomainPack): ParseSuccess | ParseFailure {
  const raw = extractBlock(text);
  if (raw === null) return noBlock();

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return badJson(e instanceof Error ? e.message : String(e));
  }
  if (!isObject(parsed)) {
    return {
      ok: false,
      status: 400,
      errorCode: 'BAD_SHAPE',
      message:
        '结构块里是合法 JSON，但最外层不是一个对象（应该是 {"timeline": [...], ...} 这样）。' +
        '回到那个对话里，把开场白「回填约定」那一段再贴给助手一次，让它照那个形状重发。',
    };
  }

  const unknownKeys = Object.keys(parsed).filter(
    (k) => !(BLOCK_KEYS as readonly string[]).includes(k),
  );
  const items: PasteItem[] = [];
  let index = 0;

  const arrayOf = (key: BlockKey): unknown[] => {
    const v = parsed[key];
    return Array.isArray(v) ? v : [];
  };

  for (const entry of arrayOf('timeline')) {
    const it = isObject(entry) ? entry : {};
    const happenedAt = isoTime(it.happened_at);
    const kind = str(it.kind);
    const title = str(it.title);
    const error = !happenedAt
      ? invalid('INVALID_HAPPENED_AT', 'happened_at 不是合法的 ISO8601 时间串（例：2026-09-01T10:00:00+08:00）')
      : !kind || !(cases.TIMELINE_KINDS as readonly string[]).includes(kind)
        ? invalid('INVALID_KIND', `kind 只能是 ${cases.TIMELINE_KINDS.join(' / ')}`)
        : !title
          ? invalid('INVALID_TITLE', 'title 不能为空')
          : null;
    items.push({
      index: index++,
      kind: 'timeline',
      summary: `时间线：${title ?? '（无标题）'}${happenedAt ? `（${happenedAt.slice(0, 10)}）` : ''}`,
      args: {
        happened_at: happenedAt,
        kind,
        title,
        detail: str(it.detail) ?? undefined,
      },
      error,
    });
  }

  for (const entry of arrayOf('actions')) {
    const it = isObject(entry) ? entry : {};
    const what = str(it.what);
    const how = str(it.how);
    const why = str(it.why);
    const dueAt = isoTime(it.due_at);
    const error = !what || !how || !why
      ? invalid('INVALID_ACTION', 'what / how / why 三样都不能为空')
      : !dueAt
        ? invalid('INVALID_DUE_AT', 'due_at 不是合法的 ISO8601 时刻（「今天下班前」要换算成具体时刻）')
        : null;
    items.push({
      index: index++,
      kind: 'actions',
      summary: `行动卡：${what ?? '（无标题）'}`,
      args: { items: [{ what, how, why, due_at: dueAt }] },
      error,
    });
  }

  for (const entry of arrayOf('claims')) {
    const it = isObject(entry) ? entry : {};
    const kind = str(it.kind);
    const fen = it.amount_yuan === undefined ? 0 : yuanToFen(it.amount_yuan);
    const error = !kind || !pack.calculatorKinds.includes(kind)
      ? invalid('INVALID_KIND', `kind 只能是 ${pack.calculatorKinds.join(' / ')}`)
      : fen === null
        ? invalid('INVALID_AMOUNT', 'amount_yuan 必须是非负数，且换算成分之后是整数')
        : null;
    items.push({
      index: index++,
      kind: 'claims',
      summary: `诉求：${kind ?? '（无种类）'}${fen ? ` ${(fen / 100).toFixed(2)} 元` : ''}`,
      args: { kind, amount_fen: fen ?? 0, basis: str(it.basis) ?? undefined },
      error,
    });
  }

  for (const entry of arrayOf('deadlines')) {
    const it = isObject(entry) ? entry : {};
    const kind = str(it.kind);
    const anchor = isoDate(it.anchor_date);
    const daysGiven = it.days !== undefined && it.days !== null;
    const days = daysGiven ? Number(it.days) : undefined;
    const error = !kind || !pack.deadlineKinds.includes(kind)
      ? invalid('INVALID_KIND', `kind 只能是 ${pack.deadlineKinds.join(' / ')}`)
      : !anchor
        ? invalid('INVALID_ANCHOR', 'anchor_date 必须是 YYYY-MM-DD')
        : daysGiven && (!Number.isInteger(days) || (days as number) <= 0)
          ? invalid('INVALID_DAYS', 'days 要么不填，要么是正整数（照通知书上写的填）')
          : null;
    // note 不入库：期限行里存的是推算结果与推算过程，没有备注位。
    // 静默丢掉会让用户以为备注记上了，所以在 summary 里明说它去哪了。
    const note = str(it.note);
    items.push({
      index: index++,
      kind: 'deadlines',
      summary:
        `期限：${kind ?? '（无种类）'}，起算 ${anchor ?? '（无锚点）'}` +
        `${daysGiven ? `，${it.days} 天` : ''}` +
        `${note ? `（备注「${note}」不入库，需要留痕请另记一条时间线）` : ''}`,
      args: { kind, anchor_date: anchor, days },
      error,
    });
  }

  for (const entry of arrayOf('report_updates')) {
    const it = isObject(entry) ? entry : {};
    items.push({
      index: index++,
      kind: 'report_updates',
      summary: `个案报告：${str(it.section) ?? '（未指明分节）'}`,
      args: {},
      // 自述三段式：缺什么 / 为什么缺 / 怎么办
      error: invalid(
        'REPORT_NOT_AVAILABLE',
        '个案报告（长期记忆那一份）还没上线，这一条写不进去。' +
          '原因是本站现在只有五张档案表，没有报告的存放位。' +
          '要留住这段结论，请让助手把它改写成一条时间线或一张行动卡再回填。',
      ),
    });
  }

  return { ok: true, items, unknownKeys };
}
