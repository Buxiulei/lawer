// app/src/lib/company/__tests__/runner.test.ts
// 「公司档案采集」这一轮的留痕判据：**运行粒度与逐项粒度不许混一格**。
import { describe, it, expect } from 'vitest';

import { getBlock } from '../blocks';
import { createDossier, getDossier, setStatus } from '../dossier';
import type { PatternLlm } from '../patterns';
import { advanceDossiers, runDossierJob } from '../runner';

import { mkChain, newDb, seedDoc } from './fixtures';

function fakeLlm(reply = '{"patterns":[]}'): PatternLlm & { calls: number } {
  const llm = {
    calls: 0,
    billingModel: 'test-model',
    async chatJSON(): Promise<string> {
      llm.calls += 1;
      return reply;
    },
  };
  return llm;
}

describe('runDossierJob 的 job_runs 留痕', () => {
  it('逐项失败进 items_failed，整轮仍 ok=1（两者不许混一格）', async () => {
    const db = newDb();
    const good = mkChain(db, '甲公司有限公司');
    seedDoc(db, good.profileId, good.dossierId, { case_no: 'G1', has_fulltext: 1, summary: '正文' });
    const bad = mkChain(db, '乙公司有限公司');
    seedDoc(db, bad.profileId, bad.dossierId, { case_no: 'B1', has_fulltext: 1, summary: '正文' });

    // 让乙那份的归纳炸掉：模型抛错 ⇒ 这一项失败，整轮不该跟着算失败
    const llm: PatternLlm = {
      billingModel: 'test-model',
      async chatJSON() {
        throw new Error('上游 502');
      },
    };
    const report = await runDossierJob(db, { llm });
    expect(report.examined).toBe(2);
    expect(report.ok).toBe(0);
    expect(report.failed).toBe(2);

    const run = db.prepare('SELECT * FROM job_runs ORDER BY id DESC LIMIT 1').get() as Record<
      string,
      unknown
    >;
    expect(run.job_name).toBe('公司档案采集');
    expect(run.ok).toBe(1); // 整轮跑通了
    expect(run.items_examined).toBe(2);
    expect(run.items_failed).toBe(2);
    expect(run.error_text).toBeNull(); // 整轮致命错误那一格必须是空的
    expect(run.finished_at).not.toBeNull();

    // 逐项的失败原因落在块上，不落在 job_runs
    expect(getBlock(db, bad.dossierId, 'patterns')!.status).toBe('failed');
    expect(String(getBlock(db, bad.dossierId, 'patterns')!.error_text)).toContain('502');
    db.close();
  });

  it('不配模型时不碰 patterns 块（连行都不插），状态停在 stats_ready', async () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    seedDoc(db, profileId, dossierId, { case_no: 'G1', has_fulltext: 1, summary: '正文' });

    const report = await runDossierJob(db);
    expect(report.ok).toBe(1);
    // 「这次没配模型」与「没有全文可喂」是两件事，不能都长成一个 skipped
    expect(getBlock(db, dossierId, 'patterns')).toBeUndefined();
    expect(getBlock(db, dossierId, 'stats')!.status).toBe('ok');
    expect(getDossier(db, dossierId)!.status).toBe('stats_ready');
    expect(report.note).toContain('未配归纳模型');
    db.close();
  });

  it('配了模型且归纳有结论 ⇒ 推到 done', async () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    seedDoc(db, profileId, dossierId, { case_no: 'G1', has_fulltext: 1, summary: '正文' });
    const llm = fakeLlm();
    await runDossierJob(db, { llm });
    expect(llm.calls).toBe(1);
    expect(getDossier(db, dossierId)!.status).toBe('done');
    db.close();
  });

  it('一条判例都没有的档案不进本轮（examined 不把它算进去）', async () => {
    const db = newDb();
    createDossier(db, { name: '还没开始采的公司有限公司' });
    const report = await advanceDossiers(db);
    expect(report.examined).toBe(0);
    db.close();
  });

  it('终态档案不再被推进', async () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    seedDoc(db, profileId, dossierId, { case_no: 'G1' });
    setStatus(db, dossierId, 'litigation_expired');
    expect((await advanceDossiers(db)).examined).toBe(0);
    db.close();
  });

  it('统计快照随每轮重算刷新', async () => {
    const db = newDb();
    const { profileId, dossierId } = mkChain(db);
    seedDoc(db, profileId, dossierId, { case_no: 'G1' });
    await runDossierJob(db);
    let snap = db
      .prepare('SELECT docs_total FROM company_dossier_stats WHERE dossier_id = ?')
      .get(dossierId) as { docs_total: number };
    expect(snap.docs_total).toBe(1);

    seedDoc(db, profileId, dossierId, { case_no: 'G2' });
    await runDossierJob(db);
    snap = db
      .prepare('SELECT docs_total FROM company_dossier_stats WHERE dossier_id = ?')
      .get(dossierId) as { docs_total: number };
    expect(snap.docs_total).toBe(2);
    db.close();
  });
});
