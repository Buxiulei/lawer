// app/src/lib/jobs/__tests__/extraction-worker.test.ts
// 内容提取 worker 的状态机。要害六条：
//   ① 入队→领取→心跳→完成，任务与材料两边的状态同步推进（假 handler）
//   ② 租约过期的任务会被回收重领（伪造一条过期租约，等价于「上一个领取者的进程死了」）
//   ③ 跑的过程中**持续续租**：租约到期时刻之后仍在跑的任务不许被别人抢走
//   ④ 领取次数用尽即 failed，且不再调 handler
//   ⑤ handler 抛错不打断 worker 循环，没用完次数就退回 queued 等重试
//   ⑥ ocr handler 端到端：假 sidecar 回的文本真的落进 evidence.extracted_text
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Database from 'better-sqlite3';

// 加密主密钥与文件库目录都在函数体内惰性读 env，故在这里赋值即可（不必先于 import）。
process.env.LAWER_DATA_KEY = Buffer.alloc(32, 9).toString('base64');
const FILES_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'extraction-worker-'));
process.env.FILES_DIR = FILES_DIR;

import { runMigrations } from '../../db/migrate';
import { storeBytes } from '../../evidence/files';
import {
  MAX_ATTEMPTS,
  enqueueExtraction,
  getJob,
  runOnce,
  type ExtractionHandler,
  type ExtractionJob,
} from '../extraction-worker';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const uid = Number(db.prepare('INSERT INTO users (email) VALUES (?)').run('a@t.com').lastInsertRowid);
  const caseId = Number(
    db.prepare('INSERT INTO cases (user_id, title) VALUES (?,?)').run(uid, '测试案件').lastInsertRowid,
  );
  return { db, uid, caseId };
}

/** 登记一件材料（真落一份加密文件，ocr 那条端到端判据要读回它）。 */
function mkEvidence(
  db: Database.Database,
  uid: number,
  caseId: number,
  bytes: Buffer,
  mime = 'image/jpeg',
  name = '来函.jpg',
): number {
  const { fileId } = storeBytes(db, bytes, mime);
  return Number(
    db
      .prepare('INSERT INTO evidence (case_id, user_id, file_id, name) VALUES (?,?,?,?)')
      .run(caseId, uid, fileId, name).lastInsertRowid,
  );
}

function evidenceRow(db: Database.Database, id: number) {
  return db
    .prepare('SELECT extraction_status, extracted_text, extracted_meta_json, extracted_at FROM evidence WHERE id=?')
    .get(id) as {
    extraction_status: string;
    extracted_text: string | null;
    extracted_meta_json: string | null;
    extracted_at: string | null;
  };
}

afterAll(() => {
  fs.rmSync(FILES_DIR, { recursive: true, force: true });
});

describe('① 入队→领取→心跳→完成', () => {
  test('状态机逐档推进，任务与材料两边同步', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'));

    const job = enqueueExtraction(db, { evidenceId: evId, caseId, userId: uid, mode: 'ocr', cost: 20 });
    expect(job.status).toBe('queued');
    expect(job.attempts).toBe(0);
    expect(evidenceRow(db, evId).extraction_status).toBe('queued');

    // handler 跑的时候观察一次「此刻库里是什么样」——收尾之后再查是查不到 running 这一档的
    let seen: ExtractionJob | null = null;
    const handler: ExtractionHandler = async (innerDb, running) => {
      seen = getJob(innerDb, running.id);
      return { text: '识别出来的文字', meta: { mode: 'ocr' } };
    };

    expect(await runOnce(db, { handlers: { ocr: handler } })).toBe('done');

    expect(seen!.status).toBe('running');
    expect(seen!.attempts).toBe(1);
    expect(seen!.lease_until).not.toBeNull();
    expect(seen!.heartbeat_at).not.toBeNull();
    expect(seen!.started_at).not.toBeNull();

    const finished = getJob(db, job.id)!;
    expect(finished.status).toBe('done');
    expect(finished.finished_at).not.toBeNull();
    expect(finished.error).toBeNull();
    expect(finished.lease_until).toBeNull(); // 收尾即交还租约，读侧不会以为它还在跑

    const ev = evidenceRow(db, evId);
    expect(ev.extraction_status).toBe('done');
    expect(ev.extracted_text).toBe('识别出来的文字');
    expect(JSON.parse(ev.extracted_meta_json!)).toEqual({ mode: 'ocr' });
    expect(ev.extracted_at).not.toBeNull();
  });

  test('队列空时回 idle，不是错误', async () => {
    const { db } = makeDb();
    expect(await runOnce(db)).toBe('idle');
  });

  test('先进先出：两条任务按 id 顺序领', async () => {
    const { db, uid, caseId } = makeDb();
    const a = mkEvidence(db, uid, caseId, Buffer.from('a'));
    const b = mkEvidence(db, uid, caseId, Buffer.from('b'), 'image/jpeg', '第二件.jpg');
    const j1 = enqueueExtraction(db, { evidenceId: a, caseId, userId: uid, mode: 'ocr' });
    const j2 = enqueueExtraction(db, { evidenceId: b, caseId, userId: uid, mode: 'ocr' });

    const picked: number[] = [];
    const handler: ExtractionHandler = async (_db, job) => {
      picked.push(job.id);
      return { text: '' };
    };
    await runOnce(db, { handlers: { ocr: handler } });
    await runOnce(db, { handlers: { ocr: handler } });
    expect(picked).toEqual([j1.id, j2.id]);
  });
});

describe('② 租约过期回收', () => {
  test('伪造一条过期租约的 running 任务，下一轮被重新领取并跑完', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'));
    const job = enqueueExtraction(db, { evidenceId: evId, caseId, userId: uid, mode: 'ocr' });

    // 等价于「上一个领取者领了它，然后进程被 kill」：状态停在 running，租约留在过去。
    db.prepare(
      "UPDATE extraction_jobs SET status='running', lease_until='2000-01-01 00:00:00', attempts=1 WHERE id=?",
    ).run(job.id);

    expect(await runOnce(db, { handlers: { ocr: async () => ({ text: '重跑成功' }) } })).toBe('done');
    const after = getJob(db, job.id)!;
    expect(after.status).toBe('done');
    expect(after.attempts).toBe(2); // 领取次数照加，毒任务不会被无限重领
    expect(evidenceRow(db, evId).extracted_text).toBe('重跑成功');
  });

  test('租约未过期的 running 任务不会被领走', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'));
    const job = enqueueExtraction(db, { evidenceId: evId, caseId, userId: uid, mode: 'ocr' });
    db.prepare(
      "UPDATE extraction_jobs SET status='running', lease_until='2999-01-01 00:00:00' WHERE id=?",
    ).run(job.id);
    expect(await runOnce(db)).toBe('idle');
  });
});

describe('③ 跑的过程中持续续租', () => {
  test(
    '租约 2 秒、任务跑 2.5 秒：期间租约被心跳推后，并发的一轮扫描抢不走它',
    async () => {
      const { db, uid, caseId } = makeDb();
      const evId = mkEvidence(db, uid, caseId, Buffer.from('x'));
      const job = enqueueExtraction(db, { evidenceId: evId, caseId, userId: uid, mode: 'ocr' });

      let leaseAtStart = '';
      let leaseBeforeEnd = '';
      let stolen: string | null = null;

      const slow: ExtractionHandler = async (innerDb, running) => {
        leaseAtStart = getJob(innerDb, running.id)!.lease_until!;
        await sleep(2500); // 超过 2 秒的租约：不续租的话此刻它已经是「可回收」的了
        leaseBeforeEnd = getJob(innerDb, running.id)!.lease_until!;
        // 另一轮扫描：抢到就说明这条任务同时被两个领取者跑着（同一份材料跑两遍、计费只一笔）
        stolen = await runOnce(innerDb, {
          handlers: { ocr: async () => ({ text: '被抢走的那一轮' }) },
          leaseMs: 2000,
          heartbeatMs: 200,
        });
        return { text: '正主跑完' };
      };

      expect(await runOnce(db, { handlers: { ocr: slow }, leaseMs: 2000, heartbeatMs: 200 })).toBe('done');

      expect(leaseBeforeEnd > leaseAtStart, `租约没被推后：${leaseAtStart} → ${leaseBeforeEnd}`).toBe(true);
      expect(stolen, '租约还在有效期内，这一轮不该领到任何任务').toBe('idle');
      expect(getJob(db, job.id)!.attempts).toBe(1); // 只被领过一次
      expect(evidenceRow(db, evId).extracted_text).toBe('正主跑完');
    },
    10_000,
  );
});

describe('④⑤ 失败与领取次数上限', () => {
  test('handler 抛错不打断循环：没用完次数退回 queued，用完了置 failed', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'));
    const job = enqueueExtraction(db, { evidenceId: evId, caseId, userId: uid, mode: 'ocr' });

    const boom: ExtractionHandler = async () => {
      throw new Error('上游连不上');
    };

    for (let i = 1; i < MAX_ATTEMPTS; i++) {
      expect(await runOnce(db, { handlers: { ocr: boom } })).toBe('failed');
      const mid = getJob(db, job.id)!;
      expect(mid.status, `第 ${i} 次失败后应退回 queued 等重试`).toBe('queued');
      expect(mid.attempts).toBe(i);
      expect(mid.error).toBe('上游连不上');
      expect(mid.finished_at).toBeNull(); // 还没结束，别记结束时间
      // 「还会再试」与「不会再试了」在材料上必须分得开
      expect(evidenceRow(db, evId).extraction_status).toBe('queued');
    }

    expect(await runOnce(db, { handlers: { ocr: boom } })).toBe('failed');
    const last = getJob(db, job.id)!;
    expect(last.status).toBe('failed');
    expect(last.attempts).toBe(MAX_ATTEMPTS);
    expect(last.finished_at).not.toBeNull();
    expect(evidenceRow(db, evId).extraction_status).toBe('failed');

    // 已经 failed 的任务不会再被领
    expect(await runOnce(db, { handlers: { ocr: boom } })).toBe('idle');
  });

  test('领取次数已用尽的任务直接置 failed，handler 一次都不调', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'));
    const job = enqueueExtraction(db, { evidenceId: evId, caseId, userId: uid, mode: 'ocr' });
    // 等价于「领了三次，每次都崩在半路（既没成功也没写失败）」
    db.prepare("UPDATE extraction_jobs SET attempts=? WHERE id=?").run(MAX_ATTEMPTS, job.id);

    let called = 0;
    expect(
      await runOnce(db, {
        handlers: {
          ocr: async () => {
            called += 1;
            return { text: '不该被跑到' };
          },
        },
      }),
    ).toBe('failed');
    expect(called).toBe(0);

    const after = getJob(db, job.id)!;
    expect(after.status).toBe('failed');
    // 自述三段式：为什么不再试、该去看什么
    expect(after.error).toContain('不再重试');
    expect(evidenceRow(db, evId).extraction_status).toBe('failed');
  });

  test('未接线的提取方式明说没做，不退化成「提取出来是空的」', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'audio/wav', '录音.wav');
    const job = enqueueExtraction(db, { evidenceId: evId, caseId, userId: uid, mode: 'asr' });
    expect(await runOnce(db)).toBe('failed');
    expect(getJob(db, job.id)!.error).toContain('还没接线');
    expect(evidenceRow(db, evId).extracted_text).toBeNull();
  });
});

describe('⑥ ocr handler 端到端（假 sidecar）', () => {
  let server: http.Server;
  let seenBody: Buffer[] = [];
  let prevUrl: string | undefined;

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url !== '/ocr' || req.method !== 'POST') {
          res.writeHead(404).end('{}');
          return;
        }
        seenBody = chunks;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ text: '解除通知书\n甲方：某公司', model: 'fake-vl', request_id: 'req-1' }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as { port: number }).port;
    prevUrl = process.env.SIDECAR_URL;
    process.env.SIDECAR_URL = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (prevUrl === undefined) delete process.env.SIDECAR_URL;
    else process.env.SIDECAR_URL = prevUrl;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test('落盘的密文被解密后传给 sidecar，回来的文字写进 evidence', async () => {
    const { db, uid, caseId } = makeDb();
    const plain = Buffer.from('这是原始图片字节-可辨认串-7788');
    const evId = mkEvidence(db, uid, caseId, plain, 'image/png', '解除通知.png');
    const job = enqueueExtraction(db, { evidenceId: evId, caseId, userId: uid, mode: 'ocr' });

    // 不传 handlers：走真的 HANDLERS.ocr
    expect(await runOnce(db)).toBe('done');

    const ev = evidenceRow(db, evId);
    expect(ev.extraction_status).toBe('done');
    expect(ev.extracted_text).toBe('解除通知书\n甲方：某公司');
    expect(JSON.parse(ev.extracted_meta_json!)).toMatchObject({
      mode: 'ocr',
      model: 'fake-vl',
      request_id: 'req-1',
      mime: 'image/png',
    });
    expect(getJob(db, job.id)!.status).toBe('done');

    // sidecar 收到的是**明文**字节：走的是「app 解密 → multipart 传字节」，
    // 不是「sidecar 照路径去读那份密文」（密钥不在 sidecar，那条路根本走不通）
    const body = Buffer.concat(seenBody);
    expect(body.includes(plain)).toBe(true);
    expect(body.toString('utf8')).toContain('解除通知.png');
  });

  test('sidecar 报错时任务记下原文，材料不留半截结果', async () => {
    const { db, uid, caseId } = makeDb();
    const evId = mkEvidence(db, uid, caseId, Buffer.from('x'), 'image/png', '坏图.png');
    const job = enqueueExtraction(db, { evidenceId: evId, caseId, userId: uid, mode: 'ocr' });
    const good = process.env.SIDECAR_URL;
    process.env.SIDECAR_URL = 'http://127.0.0.1:1'; // 连不上
    try {
      expect(await runOnce(db)).toBe('failed');
    } finally {
      process.env.SIDECAR_URL = good;
    }
    expect(getJob(db, job.id)!.error).toBeTruthy();
    const ev = evidenceRow(db, evId);
    expect(ev.extracted_text).toBeNull();
    expect(ev.extraction_status).toBe('queued'); // 第一次失败，还会再试
  });
});
