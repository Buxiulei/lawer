// app/src/lib/docs/__tests__/transcript.test.ts
// 录音要点归纳与事件建议。要害四条：
//   ① **一条时间线都不写**（变异臂：把建议改成自动 timeline_add → 红）
//   ② 建议的事件字段与 timeline_add 的入参逐字对齐，agent 确认后可原样转发
//   ③ 日期不成形、类别不在词表里的候选一律丢掉并计数（不替模型补默认值）
//   ④ 没有**可用的**转写稿（状态不是 done、或没文本）一律回 EXTRACTION_REQUIRED 并指路 evidence_extract
//      （变异臂：只判文本不判状态 → 红，半截稿会被当完整稿归纳）
import { describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

import { TIMELINE_KINDS } from '../../cases';
import { runMigrations } from '../../db/migrate';
import { submitTranscript } from '../transcript';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('a@t.com').lastInsertRowid);
  const other = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('b@t.com').lastInsertRowid);
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '本人案件').lastInsertRowid,
  );
  const fileId = Number(
    db
      .prepare("INSERT INTO files (sha256, size, mime, enc_path) VALUES (?,?,?,?)")
      .run('a'.repeat(64), 10, 'audio/mp3', 'aa/a.enc').lastInsertRowid,
  );
  return { db, uid, other, caseId, fileId };
}

function mkAudio(
  db: Database.Database,
  uid: number,
  caseId: number,
  fileId: number,
  text: string | null,
  status = 'done',
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO evidence (case_id, user_id, file_id, name, category, extraction_status, extracted_text)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(caseId, uid, fileId, '约谈录音.mp3', '录音', status, text).lastInsertRowid,
  );
}

const TRANSCRIPT =
  'HR：9 月 12 号那天我们跟你谈过一次，公司的意思是给 N，不是 N+1。\n' +
  '我：那我 9 月 20 号会把书面异议交上来。';

function fakeLlm(payload?: unknown) {
  const calls: string[] = [];
  return {
    calls,
    billingModel: 'fake-json-model',
    chatJSON: async (messages: { role: string; content: string }[]) => {
      calls.push(messages[messages.length - 1].content);
      return JSON.stringify(
        payload ?? {
          points: ['公司口头给 N，不是 N+1', '我方将于 9 月 20 日提交书面异议'],
          events: [
            { happened_at: '2026-09-12', kind: '公司动作', title: 'HR 约谈，口头提出按 N 补偿' },
            { happened_at: '2026-09-20', kind: '我方动作', title: '提交书面异议', detail: '当面递交' },
            // 下面两条是要被丢掉的：类别不在词表里 / 日期说不清
            { happened_at: '2026-09-21', kind: '随便什么', title: '类别不对' },
            { happened_at: '过几天', kind: '我方动作', title: '日期不成形' },
          ],
        },
      );
    },
  };
}

describe('① 不自动写时间线', () => {
  test('跑完之后 timeline_events 一条都不多', async () => {
    const { db, uid, caseId, fileId } = makeDb();
    const evId = mkAudio(db, uid, caseId, fileId, TRANSCRIPT);
    const before = (db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get() as { n: number }).n;

    const r = await submitTranscript(db, { userId: uid, evidenceId: evId }, { llm: fakeLlm() });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const after = (db.prepare('SELECT COUNT(*) AS n FROM timeline_events').get() as { n: number }).n;
    expect(after).toBe(before);
    expect(after).toBe(0);
    // 正对照：确实建议出了事件（断言不是落在「一条建议都没有」上）
    expect(r.suggested_events.length).toBeGreaterThan(0);
    // 回包必须自己说清「还没写」，别让调用方以为已经记好了
    expect(r.note).toContain('还没有写进时间线');
  });
});

describe('② / ③ 建议的形状与逐条校验', () => {
  test('字段与 timeline_add 对齐；类别与日期不合格的被丢掉并计数', async () => {
    const { db, uid, caseId, fileId } = makeDb();
    const evId = mkAudio(db, uid, caseId, fileId, TRANSCRIPT);
    const llm = fakeLlm();

    const r = await submitTranscript(db, { userId: uid, evidenceId: evId }, { llm });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    expect(r.suggested_events).toHaveLength(2);
    expect(r.dropped_events).toBe(2);
    for (const e of r.suggested_events) {
      expect(TIMELINE_KINDS).toContain(e.kind as (typeof TIMELINE_KINDS)[number]);
      expect(e.happened_at).toMatch(/^\d{4}-\d{2}-\d{2}/);
      expect(e.title.length).toBeGreaterThan(0);
    }
    expect(r.points).toHaveLength(2);
    expect(r.case_id).toBe(caseId);
    // 喂给模型的是转写稿本身
    expect(llm.calls[0]).toContain('书面异议');
  });
});

describe('④ 没有转写稿时明说没有', () => {
  test('从没转过 → 指路去做转写', async () => {
    const { db, uid, caseId, fileId } = makeDb();
    const evId = mkAudio(db, uid, caseId, fileId, null, 'none');
    const r = await submitTranscript(db, { userId: uid, evidenceId: evId }, { llm: fakeLlm() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('EXTRACTION_REQUIRED');
    // 指路必须点名那条真能做转写的路（带 mode），只说「去做转写」等于让 agent 自己找。
    expect(r.message).toContain('evidence_extract mode=asr');
  });

  test('正在转写 → 说清是在排队，别让人再排一条', async () => {
    const { db, uid, caseId, fileId } = makeDb();
    const evId = mkAudio(db, uid, caseId, fileId, null, 'running');
    const r = await submitTranscript(db, { userId: uid, evidenceId: evId }, { llm: fakeLlm() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('EXTRACTION_REQUIRED');
    expect(r.message).toContain('已经在跑');
    expect(r.message).toContain('不必重新排队');
  });

  // 负例：提取半途而废的行——**有文本、但状态不是 done**。
  // 只判文本就会把半截稿子当完整稿归纳：用户读到一份看起来结论完整的要点，
  // 而后半段谈话（往往是真正定调的那几句）从没进过模型。
  test('有半截文本但状态不是 done → 照样回 EXTRACTION_REQUIRED，一次模型都不调', async () => {
    const { db, uid, caseId, fileId } = makeDb();
    const evId = mkAudio(db, uid, caseId, fileId, 'HR：9 月 12 号那天我们跟你谈过一次，', 'running');
    const llm = fakeLlm();
    const r = await submitTranscript(db, { userId: uid, evidenceId: evId }, { llm });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('EXTRACTION_REQUIRED');
    expect(llm.calls.length).toBe(0);
  });

  // 正对照：同一件材料状态转成 done 就该放行，免得上面几条其实是落在「谁都不放行」上。
  test('状态 done 且有稿 → 放行', async () => {
    const { db, uid, caseId, fileId } = makeDb();
    const evId = mkAudio(db, uid, caseId, fileId, TRANSCRIPT, 'done');
    const r = await submitTranscript(db, { userId: uid, evidenceId: evId }, { llm: fakeLlm() });
    expect(r.ok).toBe(true);
  });

  test('别人的录音一律「不存在」', async () => {
    const { db, uid, other, caseId, fileId } = makeDb();
    const evId = mkAudio(db, uid, caseId, fileId, TRANSCRIPT);
    const r = await submitTranscript(db, { userId: other, evidenceId: evId }, { llm: fakeLlm() });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errorCode).toBe('EVIDENCE_NOT_FOUND');
  });
});
