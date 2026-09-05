// app/src/lib/evidence/__tests__/extraction-e2e.test.ts
// 内容提取三模式 + 证据简报的端到端判据。要害八条：
//   ① ocr / asr / video 三条各一次真链路（假 sidecar 本地 http）：报价→确认→worker→文本落库→简报
//   ② 报价一分钱不扣（余额与 gongdao_ledger 行数逐字不变），确认才扣
//   ③ 确认幂等：同一张报价二次确认不二扣，也不排第二条队
//   ④ 简报 schema 校验：proves 缺失 / key_facts 不是数组一律不落库
//   ⑤ 简报版本冲突回 409（变异臂：brief_update 忽略 base_version ⇒ 红）
//   ⑥ 变异臂：提取完成后简报生成被跳过 ⇒ 红
//   ⑦ 他人的 evidence_id 零写入：报价、确认、改简报三条路都不落任何一行
//   ⑧ 模型编的引文被机器核掉（quote 不是提取文本的逐字子串 ⇒ 抹成空串，事实本身保留）
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import Database from 'better-sqlite3';

/**
 * 把「生产上给摘要卡挑模型」那一步换成假模型。
 *
 * 【为什么非得 mock 这一层】判据⑥要钉的是 **worker 的默认收尾动作**——不传 afterExtraction
 * 时它到底做不做。测试里显式传一个 afterExtraction 进去，钉住的只是"我传的那个函数被调了"，
 * 把默认值改成"不做"照样绿。mock 掉模型选择之后，runOnce(db) 可以一个参数都不传地跑真默认路径。
 */
vi.mock('../brief-llm', () => ({
  defaultBriefLlm: () => mockedLlm,
}));

process.env.LAWER_DATA_KEY = Buffer.alloc(32, 7).toString('base64');
const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-e2e-'));
process.env.FILES_DIR = FILES_DIR;

import { runMigrations } from '../../db/migrate';
import { getGongdao, gongdaoGrant } from '../../billing';
import { GONGDAO_LEDGER_TYPE } from '../../billing/pricing';
import { runOnce } from '../../jobs/extraction-worker';
import { generateBrief, saveBrief, validateBrief, type BriefLlm } from '../brief';
import {
  getEvidenceBrief,
  getEvidenceExtraction,
  quoteExtraction,
  startExtraction,
  updateEvidenceBrief,
} from '../extraction';
import { storeBytes } from '../files';

afterAll(() => {
  fs.rmSync(FILES_DIR, { recursive: true, force: true });
});

// ───────────────────────────── 夹具 ─────────────────────────────

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = mkUser(db, 'a@t.com');
  const other = mkUser(db, 'b@t.com');
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '本人案件').lastInsertRowid,
  );
  const otherCase = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(other, '别人的案件').lastInsertRowid,
  );
  gongdaoGrant(uid, 10_000, GONGDAO_LEDGER_TYPE.recharge, `top-${uid}`, null, db);
  gongdaoGrant(other, 10_000, GONGDAO_LEDGER_TYPE.recharge, `top-${other}`, null, db);
  return { db, uid, other, caseId, otherCase };
}

/** 实名闸只挡扣费那一步，所以夹具里的用户默认已实名（不实名的那条单独测）。 */
function mkUser(db: Database.Database, email: string): number {
  return Number(
    db
      .prepare("INSERT INTO users (email, auth_status) VALUES (?, '已实名')")
      .run(email).lastInsertRowid,
  );
}

function mkEvidence(
  db: Database.Database,
  uid: number,
  caseId: number,
  bytes: Buffer,
  mime: string,
  name: string,
): number {
  const { fileId } = storeBytes(db, bytes, mime);
  return Number(
    db
      .prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
      .run(caseId, uid, fileId, name).lastInsertRowid,
  );
}

/**
 * 一秒 16k 单声道 PCM WAV。**手搓头而不是调 ffmpeg 生成**：判据不该依赖跑测试的机器上
 * 装没装 ffmpeg——ffprobe 是被测代码自己的依赖，测试数据不必再多欠一个。
 */
function wavBytes(seconds = 1): Buffer {
  const rate = 16_000;
  const data = Buffer.alloc(rate * 2 * seconds);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); // PCM
  head.writeUInt16LE(1, 22); // 单声道
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

function snapshot(db: Database.Database, uid: number) {
  return {
    balance: getGongdao(uid, db),
    ledgerRows: (db.prepare('SELECT COUNT(*) AS n FROM gongdao_ledger').get() as { n: number }).n,
    jobs: (db.prepare('SELECT COUNT(*) AS n FROM extraction_jobs').get() as { n: number }).n,
    quotes: (db.prepare('SELECT COUNT(*) AS n FROM service_quotes').get() as { n: number }).n,
  };
}

function mustOk<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`期望成功，实得失败：${JSON.stringify(r)}`);
  return r as Extract<T, { ok: true }>;
}

function mustFail<T extends { ok: boolean }>(r: T): Extract<T, { ok: false }> {
  if (r.ok) throw new Error(`期望失败，实得成功：${JSON.stringify(r)}`);
  return r as Extract<T, { ok: false }>;
}

/** vi.mock 的 defaultBriefLlm 返回它。每条判据自己赋值，用完在 afterEach 复位成 null。 */
let mockedLlm: (BriefLlm & { calls: number }) | null = null;

/** 假模型：把喂进来的材料原样回一份合 schema 的简报，引文取自提取文本的开头。 */
function fakeBriefLlm(quote?: string): BriefLlm & { calls: number } {
  const llm = {
    calls: 0,
    billingModel: 'fake-model',
    async chatJSON(messages: { role: string; content: string }[]) {
      llm.calls += 1;
      const material = messages[messages.length - 1].content;
      const line = material.split('\n').find((l) => l.startsWith('【提取文本】'))?.slice(6) ?? '';
      return JSON.stringify({
        proves: '证明这份材料的来源与内容',
        key_facts: [
          { when: '2026-08-20', who: '公司', what: '发出通知', quote: quote ?? line.slice(0, 12), where: '第 1 段' },
        ],
        relation_to_claims: '支撑违法解除这一项',
        weaknesses: ['只有一份，没有旁证'],
        suggested_followups: ['再取一份同事的证言'],
        citations: ['第 1 段'],
      });
    },
  };
  return llm;
}

// ───────────────────────────── 假 sidecar ─────────────────────────────

interface FakeSidecar {
  hits: string[];
}

let server: http.Server;
let prevUrl: string | undefined;
const fake: FakeSidecar = { hits: [] };

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      fake.hits.push(req.url ?? '');
      const json = (body: unknown) => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(body));
      };
      if (req.url === '/ocr') {
        // 画面帧那条会带 prompt，回一个「第一行描述、其余是画面上的字」的答案
        const body = Buffer.concat(chunks).toString('utf8');
        return json(
          body.includes('先用一句话描述')
            ? { text: '会议室里两个人隔桌而坐\n解除通知 2026-08-20', model: 'fake-vl', request_id: 'f1' }
            : { text: '解除通知书\n甲方：某公司', model: 'fake-vl', request_id: 'o1' },
        );
      }
      if (req.url === '/asr') {
        return json({
          text: '你今天就办交接吧 我不同意',
          sentences: [
            { text: '你今天就办交接吧', begin_time: 1000, end_time: 3000, speaker_id: 0, sentence_id: 1 },
            { text: '我不同意', begin_time: 3200, end_time: 4500, speaker_id: 1, sentence_id: 2 },
          ],
          model: 'fake-asr',
          task_id: 't1',
        });
      }
      if (req.url === '/video') {
        return json({
          duration_s: 20,
          size_bytes: 100,
          audio_wav_b64: wavBytes().toString('base64'),
          audio_sample_rate: 16_000,
          audio_channels: 1,
          frames: [{ t_s: 0, jpeg_b64: Buffer.from('jpg').toString('base64') }],
          probe: { width: 640, height: 360, codec: 'h264' },
        });
      }
      res.writeHead(404).end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  prevUrl = process.env.SIDECAR_URL;
  process.env.SIDECAR_URL = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

afterAll(async () => {
  if (prevUrl === undefined) delete process.env.SIDECAR_URL;
  else process.env.SIDECAR_URL = prevUrl;
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  fake.hits = [];
  mockedLlm = null;
});

/** 走完一次「报价 → 确认 → worker 跑完 → 写简报」。返回这件材料的最终读侧视图。 */
async function fullRun(
  db: Database.Database,
  uid: number,
  evidenceId: number,
  mode: 'ocr' | 'asr' | 'video',
  llm: BriefLlm,
) {
  const quoted = mustOk(quoteExtraction(db, { evidenceId, userId: uid, mode }));
  const started = mustOk(
    startExtraction(db, { evidenceId, userId: uid, mode, quoteId: quoted.quote.quote_id }),
  );
  const tick = await runOnce(db, {
    afterExtraction: async (d, job) => {
      await generateBrief(d, job.evidence_id, llm);
    },
  });
  expect(tick).toBe('done');
  return {
    quote: quoted.quote,
    started,
    view: mustOk(getEvidenceExtraction(db, { evidenceId, userId: uid, includeText: true })).evidence,
  };
}

// ───────────────────────────── ① 三模式端到端 ─────────────────────────────

describe('① 三种提取方式各一条端到端', () => {
  test('ocr：图片 → 文字落库 → 简报自动生成', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('假图片字节'), 'image/png', '解除通知.png');
    const llm = fakeBriefLlm();
    const { quote, view } = await fullRun(db, uid, evId, 'ocr', llm);

    expect(quote.units).toBe(1);
    expect(quote.unit_label).toBe('页');
    expect(view.extraction_status).toBe('done');
    expect(view.extracted_text).toBe('解除通知书\n甲方：某公司');
    expect(view.brief?.proves).toBe('证明这份材料的来源与内容');
    expect(view.brief_version).toBe(1);
    expect(view.brief_updated_by).toBe('system');
  });

  test('asr：录音 → 带说话人与时间轴的文字稿 → 简报', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, wavBytes(90), 'audio/wav', '约谈录音.wav');
    const { quote, view } = await fullRun(db, uid, evId, 'asr', fakeBriefLlm());

    // 90 秒 = 2 分钟（不足一分钟按一分钟）
    expect(quote.units).toBe(2);
    expect(quote.unit_label).toBe('分钟');
    expect(view.extracted_text).toContain('[00:00:01-00:00:03] 说话人0：你今天就办交接吧');
    expect(view.extracted_text).toContain('说话人1：我不同意');
    const meta = view.extracted_meta as { mode: string; speakers: number[]; timeline: unknown[] };
    expect(meta.mode).toBe('asr');
    expect(meta.speakers).toEqual([0, 1]);
    expect(meta.timeline).toHaveLength(2);
    expect(view.brief).not.toBeNull();
  });

  test('video：音轨走转写、关键帧走识别，合成一份正文', async () => {
    const { db, uid, caseId } = makeDb();
    // 字节是 wav、mime 标成视频：假 sidecar 不真跑 ffmpeg，ffprobe 只用来出报价的时长
    const evId = mkEvidence(db, uid, caseId, wavBytes(30), 'video/mp4', '约谈录像.mp4');
    const { quote, view } = await fullRun(db, uid, evId, 'video', fakeBriefLlm());

    expect(quote.units).toBe(1);
    expect(fake.hits).toContain('/video');
    expect(fake.hits).toContain('/asr');
    expect(fake.hits).toContain('/ocr');
    expect(view.extracted_text).toContain('【音轨转写】');
    expect(view.extracted_text).toContain('说话人1：我不同意');
    expect(view.extracted_text).toContain('【画面关键帧】');
    expect(view.extracted_text).toContain('[00:00:00] 会议室里两个人隔桌而坐');
    expect(view.extracted_text).toContain('画面文字：解除通知 2026-08-20');
    const meta = view.extracted_meta as { mode: string; frames: { t_s: number }[] };
    expect(meta.mode).toBe('video');
    expect(meta.frames).toHaveLength(1);
    expect(view.brief).not.toBeNull();
  });
});

// ───────────────────────────── ②③ 计费 ─────────────────────────────

describe('②③ 报价不扣钱、确认才扣且幂等', () => {
  test('★报价一分钱不动，只多一行报价（变异：报价里调 gongdaoSettle → 红）', () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    const before = snapshot(db, uid);

    const q = mustOk(quoteExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr' }));
    const after = snapshot(db, uid);

    expect(after.balance).toBe(before.balance);
    expect(after.ledgerRows).toBe(before.ledgerRows);
    expect(after.jobs).toBe(before.jobs);
    expect(after.quotes).toBe(before.quotes + 1);
    expect(q.quote.amount).toBeGreaterThan(0);
    expect(q.quote.note).toContain('没有扣任何费用');
  });

  test('★同一张报价二次确认：不二扣、不排第二条队（变异：去掉 quote_id 查重 → 红）', () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    const q = mustOk(quoteExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr' }));

    const first = mustOk(
      startExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr', quoteId: q.quote.quote_id }),
    );
    expect(first.charged).toBe(q.quote.amount);
    const afterFirst = snapshot(db, uid);

    const second = mustOk(
      startExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr', quoteId: q.quote.quote_id }),
    );
    const afterSecond = snapshot(db, uid);

    expect(second.job_id).toBe(first.job_id);
    expect(second.charged).toBe(0);
    expect(second.deduped).toBe(true);
    expect(afterSecond.balance).toBe(afterFirst.balance);
    expect(afterSecond.jobs).toBe(afterFirst.jobs);
  });

  test('拿给别的材料报的价来提取这一件 ⇒ 409，且一分钱不扣', () => {
    const { db, uid, caseId } = makeDb();
    const a = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    const b = mkEvidence(db, uid, caseId, Buffer.from('y'), 'image/png', 'b.png');
    const q = mustOk(quoteExtraction(db, { evidenceId: a, userId: uid, mode: 'ocr' }));
    const before = snapshot(db, uid);

    const f = mustFail(
      startExtraction(db, { evidenceId: b, userId: uid, mode: 'ocr', quoteId: q.quote.quote_id }),
    );
    expect(f.errorCode).toBe('QUOTE_MISMATCH');
    expect(f.status).toBe(409);
    expect(snapshot(db, uid)).toEqual(before);
  });

  test('没实名 ⇒ 报价照出（免费），确认被 403 挡住且不扣钱', () => {
    const { db, caseId } = makeDb();
    const plain = Number(
      db.prepare('INSERT INTO users (email) VALUES (?)').run('c@t.com').lastInsertRowid,
    );
    db.prepare('UPDATE cases SET user_id=? WHERE id=?').run(plain, caseId);
    gongdaoGrant(plain, 1000, GONGDAO_LEDGER_TYPE.recharge, `top-${plain}`, null, db);
    const evId = mkEvidence(db, plain, caseId, Buffer.from('x'), 'image/png', 'a.png');

    const q = mustOk(quoteExtraction(db, { evidenceId: evId, userId: plain, mode: 'ocr' }));
    const before = snapshot(db, plain);
    const f = mustFail(
      startExtraction(db, { evidenceId: evId, userId: plain, mode: 'ocr', quoteId: q.quote.quote_id }),
    );
    expect(f.errorCode).toBe('REALNAME_REQUIRED');
    expect(snapshot(db, plain)).toEqual(before);
  });
});

// ───────────────────────────── ④⑤⑧ 简报 ─────────────────────────────

describe('④ 简报 schema 校验', () => {
  test('缺 proves ⇒ 不过；key_facts 不是数组 ⇒ 不过', () => {
    expect(validateBrief({ key_facts: [] }).ok).toBe(false);
    expect(validateBrief({ proves: '   ' }).ok).toBe(false);
    expect(validateBrief({ proves: '能证明解除', key_facts: '一条' }).ok).toBe(false);
    expect(validateBrief('一份简报').ok).toBe(false);
  });

  test('只有 proves 也算合格；schema 外的字段被丢掉而不是整份作废', () => {
    const v = validateBrief({ proves: '能证明解除', summary: '模型多写的' });
    expect(v.ok).toBe(true);
    expect(v.brief).toEqual({
      proves: '能证明解除',
      key_facts: [],
      relation_to_claims: '',
      weaknesses: [],
      suggested_followups: [],
      citations: [],
    });
    expect(v.problems.join('')).toContain('已忽略');
  });

  test('五个字段全空的关键事实是凑数用的空壳，不落库', () => {
    const v = validateBrief({
      proves: 'x',
      key_facts: [{ when: '', who: '', what: '', quote: '', where: '' }],
    });
    expect(mustOkBrief(v).key_facts).toHaveLength(0);
  });
});

function mustOkBrief(v: ReturnType<typeof validateBrief>) {
  if (!v.ok || !v.brief) throw new Error(`期望 schema 通过：${v.problems.join('；')}`);
  return v.brief;
}

describe('⑤ 简报改写的乐观锁', () => {
  const brief = {
    proves: '改写后的结论',
    key_facts: [],
    relation_to_claims: '',
    weaknesses: [],
    suggested_followups: [],
    citations: [],
  };

  test('★base_version 对不上 ⇒ 409，且库里那一版一个字不改（变异：忽略 base_version → 红）', () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    saveBrief(db, { evidenceId: evId, brief: { ...brief, proves: '第一版' }, updatedBy: 'system' });

    const f = mustFail(
      updateEvidenceBrief(db, {
        evidenceId: evId,
        userId: uid,
        brief,
        reason: '补充',
        baseVersion: 0, // 库里已经是 1
        updatedBy: 'agent:9',
      }),
    );
    expect(f.status).toBe(409);
    expect(f.errorCode).toBe('BRIEF_VERSION_CONFLICT');
    expect(f.message).toContain('库里现在是第 1 版');

    const now = mustOk(getEvidenceBrief(db, { evidenceId: evId, userId: uid }));
    expect(now.brief?.proves).toBe('第一版');
    expect(now.version).toBe(1);
  });

  test('base_version 对得上 ⇒ 版本 +1，改写者留痕', () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    saveBrief(db, { evidenceId: evId, brief: { ...brief, proves: '第一版' }, updatedBy: 'system' });

    const r = mustOk(
      updateEvidenceBrief(db, {
        evidenceId: evId,
        userId: uid,
        brief,
        reason: '补充了弱点',
        baseVersion: 1,
        updatedBy: 'agent:9',
      }),
    );
    expect(r.version).toBe(2);
    const now = mustOk(getEvidenceBrief(db, { evidenceId: evId, userId: uid }));
    expect(now.brief?.proves).toBe('改写后的结论');
    expect(now.updated_by).toBe('agent:9');
  });
});

describe('⑧ 模型编的引文被机器核掉', () => {
  test('quote 不是提取文本的逐字子串 ⇒ 抹成空串，但这条事实本身留着', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    const llm = fakeBriefLlm('这句话原文里根本没有');
    const { view } = await fullRun(db, uid, evId, 'ocr', llm);

    expect(view.brief?.key_facts).toHaveLength(1);
    expect(view.brief?.key_facts[0].quote).toBe('');
    expect(view.brief?.key_facts[0].what).toBe('发出通知');
  });
});

// ───────────────────────────── ⑥ 变异臂：简报不能被跳过 ─────────────────────────────

describe('⑥ 变异臂：提取完成后必须自动写简报', () => {
  test('★不传任何选项跑 worker，简报照样落库（变异：把默认收尾动作改成"不做" → 红）', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    const q = mustOk(quoteExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr' }));
    mustOk(startExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr', quoteId: q.quote.quote_id }));

    mockedLlm = fakeBriefLlm();
    // **一个参数都不传**：走 runOnce 自己的默认收尾动作（模型选择已被 vi.mock 换成假的）
    expect(await runOnce(db)).toBe('done');

    expect(mockedLlm.calls).toBe(1);
    const view = mustOk(getEvidenceExtraction(db, { evidenceId: evId, userId: uid })).evidence;
    expect(view.brief_version).toBe(1);
    expect(view.brief_updated_by).toBe('system');
    expect(view.brief_summary).not.toBe('');
  });

  test('没有可用模型时只是没有简报，提取结果照旧（不静默把任务判失败）', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    const q = mustOk(quoteExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr' }));
    mustOk(startExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr', quoteId: q.quote.quote_id }));

    mockedLlm = null; // defaultBriefLlm 回 null = 缺 key / 那家不实现 chatJSON
    expect(await runOnce(db)).toBe('done');
    const view = mustOk(getEvidenceExtraction(db, { evidenceId: evId, userId: uid })).evidence;
    expect(view.extraction_status).toBe('done');
    expect(view.brief).toBeNull();
  });

  test('★简报写不出来不改判提取结果（变异：把简报失败当成任务失败 → 红）', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    const q = mustOk(quoteExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr' }));
    mustOk(startExtraction(db, { evidenceId: evId, userId: uid, mode: 'ocr', quoteId: q.quote.quote_id }));

    const tick = await runOnce(db, {
      afterExtraction: async () => {
        throw new Error('模型今天不在');
      },
    });
    expect(tick).toBe('done');
    const view = mustOk(getEvidenceExtraction(db, { evidenceId: evId, userId: uid, includeText: true }))
      .evidence;
    expect(view.extraction_status).toBe('done');
    expect(view.extracted_text).toBe('解除通知书\n甲方：某公司');
    expect(view.brief).toBeNull();
  });
});

// ───────────────────────────── ⑦ 他人的材料 ─────────────────────────────

describe('⑦ 他人的 evidence_id 零写入', () => {
  test('★报价 / 确认 / 改简报三条路都 404，且库里一行都不多（变异：去掉归属判定 → 红）', () => {
    const { db, uid, other, otherCase } = makeDb();
    const theirs = mkEvidence(db, other, otherCase, Buffer.from('x'), 'image/png', '别人的.png');
    const theirQuote = mustOk(quoteExtraction(db, { evidenceId: theirs, userId: other, mode: 'ocr' }));

    const before = snapshot(db, uid);
    const briefRows = () =>
      db.prepare('SELECT brief_version AS v, extraction_status AS s FROM evidence WHERE id=?').get(theirs);
    const beforeBrief = briefRows();

    expect(mustFail(quoteExtraction(db, { evidenceId: theirs, userId: uid, mode: 'ocr' })).status).toBe(404);
    expect(
      mustFail(
        startExtraction(db, {
          evidenceId: theirs,
          userId: uid,
          mode: 'ocr',
          quoteId: theirQuote.quote.quote_id,
        }),
      ).status,
    ).toBe(404);
    expect(
      mustFail(
        updateEvidenceBrief(db, {
          evidenceId: theirs,
          userId: uid,
          brief: mustOkBrief(validateBrief({ proves: '我改的' })),
          reason: '越界',
          baseVersion: 0,
          updatedBy: 'agent:1',
        }),
      ).status,
    ).toBe(404);
    expect(mustFail(getEvidenceBrief(db, { evidenceId: theirs, userId: uid })).status).toBe(404);
    expect(mustFail(getEvidenceExtraction(db, { evidenceId: theirs, userId: uid })).status).toBe(404);

    expect(snapshot(db, uid)).toEqual(before);
    expect(briefRows()).toEqual(beforeBrief);
  });
});

// ───────────────────────────── 读侧 ─────────────────────────────

describe('读侧：正文截断与 include_text', () => {
  test('include_text 不开 ⇒ 不回正文但回字数；开了且超长 ⇒ 截断并标 truncated', () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', 'a.png');
    const long = '字'.repeat(9000);
    db.prepare("UPDATE evidence SET extraction_status='done', extracted_text=? WHERE id=?").run(long, evId);

    const closed = mustOk(getEvidenceExtraction(db, { evidenceId: evId, userId: uid })).evidence;
    expect(closed.extracted_text).toBeNull();
    expect(closed.extracted_text_chars).toBe(9000);
    expect(closed.truncated).toBe(false);

    const opened = mustOk(
      getEvidenceExtraction(db, { evidenceId: evId, userId: uid, includeText: true }),
    ).evidence;
    expect(opened.extracted_text).toHaveLength(8000);
    expect(opened.truncated).toBe(true);
  });
});
