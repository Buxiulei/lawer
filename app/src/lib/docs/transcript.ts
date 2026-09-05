// app/src/lib/docs/transcript.ts
// 录音转写的要点归纳与**时间线事件建议**（设计稿 §2 J：transcript_submit）。
//
// ─────────────────── 这里最要紧的一条：不自动写时间线 ───────────────────
// 本函数只**建议**事件，一条都不落库。时间线是只追加的档案，一条错事件补不回来
// （更正只能再追加一条，原来那条永远在上面）。而录音里最常见的恰恰是「说岔了的日期」
// 与「后来被否掉的口头承诺」——模型把它们当成既成事实写进去，用户下次翻档案时，
// 看到的是一段自己从没确认过的经历，且分不清哪几条是他自己记的。
// 所以这里回的是候选清单，由 agent/用户逐条过目后再调 timeline_add。
// 判据在 __tests__/transcript.test.ts：跑完之后 timeline_events 行数必须一条不多。
// ───────────────────────────────────────────────────────────────────────
import type { Database } from 'better-sqlite3';

import { TIMELINE_KINDS, type DomainFailure, type Result } from '@/lib/cases';
import type { ChatMessage } from '@/lib/llm';

/** 模型侧的最小依赖面，与来文解读同形。 */
export interface TranscriptLlm {
  chatJSON(messages: ChatMessage[]): Promise<string>;
  readonly billingModel?: string;
}

export interface TranscriptDeps {
  llm: TranscriptLlm;
}

/** 一条候选时间线事件。字段名与 timeline_add 的入参逐字对齐，agent 确认后可原样转发。 */
export interface SuggestedEvent {
  happened_at: string;
  kind: string;
  title: string;
  detail: string | null;
}

export interface TranscriptResult {
  evidence_id: number;
  case_id: number;
  /** 这段录音里值得记住的话（原文要点，不是转述） */
  points: string[];
  /** 建议追加的时间线事件——**尚未写入**，要写须由调用方再调 timeline_add */
  suggested_events: SuggestedEvent[];
  /** 提示语：把「没写」这件事写在回包里，别让调用方以为已经记好了 */
  note: string;
  /** 被丢掉的候选事件数（日期不成形 / 类别不在词表里） */
  dropped_events: number;
  model: string | null;
}

const NOT_WRITTEN_NOTE =
  '以上事件**还没有写进时间线**。逐条与用户核对（尤其是日期）之后，' +
  '再对确认过的那几条调 timeline_add 落库；不确认的就不要写。';

const SYSTEM_PROMPT =
  '你在读一段谈话录音的文字转写稿。只依据稿子作答，稿子里没有的一个字都不要补。\n' +
  '两件事：① 提炼要点，尽量保留原话；② 挑出稿子里明确提到的、发生过或将要发生的事，' +
  '整理成候选时间线事件（日期写成 YYYY-MM-DD；说不清具体哪天的就不要写这一条）。\n' +
  `kind 只能取：${TIMELINE_KINDS.join(' / ')}。\n` +
  '只输出 JSON：{"points":["..."],"events":[{"happened_at":"YYYY-MM-DD","kind":"...","title":"一句话",' +
  '"detail":"补充，可省略"}]}';

function fail(status: number, errorCode: string, message: string): DomainFailure {
  return { ok: false, status, errorCode, message };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/**
 * 校验候选事件。日期不成形、类别不在词表里的一律丢掉并计数。
 *
 * 【为什么丢而不是补一个默认值】补默认值的形态是：模型说不清是哪天，系统替它填了今天，
 * 用户看到一条日期精确的候选事件，照单确认——错的日期就这样带着「用户确认过」的身份进了档案。
 */
export function verifyEvents(raw: unknown): { events: SuggestedEvent[]; dropped: number } {
  const list = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : [];
  const events: SuggestedEvent[] = [];
  let dropped = 0;
  for (const item of list) {
    const happenedAt = str(item.happened_at);
    const kind = str(item.kind);
    const title = str(item.title);
    if (
      !happenedAt ||
      !/^\d{4}-\d{2}-\d{2}/.test(happenedAt) ||
      !kind ||
      !(TIMELINE_KINDS as readonly string[]).includes(kind) ||
      !title
    ) {
      dropped += 1;
      continue;
    }
    events.push({ happened_at: happenedAt, kind, title, detail: str(item.detail) });
  }
  return { events, dropped };
}

export interface SubmitTranscriptInput {
  userId: number;
  evidenceId: number;
}

/**
 * 对一件**已经转写好**的录音做要点归纳与事件建议。
 *
 * 【为什么不在这里顺手做转写】转写按分钟计价（asr.per_minute），要报价就得先知道时长，
 * 而时长只有真去解一遍音频才知道——那一步本身就是转写。所以转写走它自己的报价确认流，
 * 这里只消费它的产物。没转写就明说没转写，不静默做一次免费的转写。
 */
export async function submitTranscript(
  db: Database,
  input: SubmitTranscriptInput,
  deps: TranscriptDeps,
): Promise<Result<TranscriptResult>> {
  const row = db
    .prepare(
      `SELECT id, case_id, name, extraction_status, extracted_text
         FROM evidence WHERE id=? AND user_id=?`,
    )
    .get(input.evidenceId, input.userId) as
    | { id: number; case_id: number; name: string; extraction_status: string; extracted_text: string | null }
    | undefined;
  if (!row) {
    return fail(
      404,
      'EVIDENCE_NOT_FOUND',
      `录音 ${input.evidenceId} 不存在，或不属于本人（两者刻意不区分）。` +
        '怎么办：先用 evidence_list 取本人名下真实的证据编号。',
    );
  }

  // 两个条件缺一不可：状态必须是 done，且真有转写文本。
  // 【为什么不能只看文本】提取中途失败/被打断的行会留下半截文本而状态还停在 running 或 failed，
  // 只判文本就会拿半份稿子当完整稿归纳，用户看到的是一份「结论完整」的要点，而后半段谈话从没读过。
  // 【为什么不能只看状态】done 而文本为空的行同样存在（识别出零个字）；只判状态就会把空稿喂给模型，
  // 模型照样能编出一份要点。
  const text = str(row.extracted_text);
  if (row.extraction_status !== 'done' || !text) {
    const running = row.extraction_status === 'queued' || row.extraction_status === 'running';
    return fail(
      409,
      'EXTRACTION_REQUIRED',
      `《${row.name}》还没有可用的转写稿（当前提取状态 ${row.extraction_status}` +
        `${text ? '，已有文本但提取尚未完成' : ''}）。` +
        '为什么：本工具只做要点归纳与事件建议，读的是转写结果，它自己不做转写、也不收费。' +
        (running
          ? '怎么办：这件材料的提取已经在跑了，等它跑完再调一次本工具，不必重新排队。'
          : '怎么办：先调 evidence_extract mode=asr 做转写（那一步走报价确认、按分钟计价），' +
            '提取状态变成 done 之后再调一次本工具。'),
    );
  }

  let rawJson: string;
  try {
    rawJson = await deps.llm.chatJSON([
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: `【录音】${row.name}\n【转写稿】\n${text}` },
    ]);
  } catch (err) {
    return fail(
      502,
      'TRANSCRIPT_ANALYSIS_FAILED',
      `这段录音的要点归纳没做成：${(err as Error).message}。怎么办：稍后再调一次即可，转写稿还在，不必重新转写。`,
    );
  }

  let parsed: { points?: unknown; events?: unknown };
  try {
    parsed = JSON.parse(rawJson) as { points?: unknown; events?: unknown };
  } catch {
    return fail(
      502,
      'TRANSCRIPT_BAD_JSON',
      '归纳模型这次没有交回可解析的结果。怎么办：稍后再调一次即可。',
    );
  }

  const points = Array.isArray(parsed.points)
    ? (parsed.points as unknown[]).map(str).filter((p): p is string => p !== null)
    : [];
  const { events, dropped } = verifyEvents(parsed.events);

  return {
    ok: true,
    evidence_id: row.id,
    case_id: row.case_id,
    points,
    suggested_events: events,
    note: NOT_WRITTEN_NOTE,
    dropped_events: dropped,
    model: deps.llm.billingModel ?? null,
  };
}
