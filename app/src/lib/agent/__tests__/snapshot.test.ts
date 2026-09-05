// app/src/lib/agent/__tests__/snapshot.test.ts
// 事实卡的**取数侧**判据：loadCaseSnapshot 从真库把 identity / evidence / historyStats
// 取对了没有，以及这三样接到渲染器之后卡上写的是不是同一件事。
//
// 【为什么单独一个文件、为什么必须用真库】case-facts.test.ts 全部吃手工 snapshot 夹具，
// 于是「库 → snapshot」这一段完全没人守：复审实测把 snapshot.loadIdentity 里的
// `row.auth_status !== '已实名'` 删掉（= 待审/未认证用户只要有密文就把真名解出来发给模型）、
// 把 evidence 恒置空（= 对着 19 条证据的用户说「证据共 0 条 / 合同 0」），
// 全套 3811 例零失败（rd-case-facts/rv-fabrication-mutation.log 变异 A；
// rd-case-facts/rv-budget-mutation.log m36/m37/m38/m40）。
//
// 姓名明文出境是 manager 裁决①批准的，条件是**两条**：auth_status 已实名 **且** 密文解得开。
// PII 闸门不能裸奔，所以这里走真 encryptField / 真 decryptField，四态各一条断言。
import crypto from 'node:crypto';

import { describe, expect, it } from 'vitest';

// 主密钥必须在 lib/crypto 第一次用到之前就位（模块内缓存 masterKey，且缺失即抛错）
process.env.LAWER_DATA_KEY = crypto.randomBytes(32).toString('base64');

import { encryptField } from '@/lib/crypto';

import { buildCaseFacts, renderCaseFacts } from '../case-facts';
import { runTurn } from '../orchestrator';
import { loadCaseSnapshot } from '../snapshot';
import { makeAgentFixture, makeSink, scriptedProvider } from './fixtures';

const card = (db: Parameters<typeof loadCaseSnapshot>[0], caseId: number) =>
  renderCaseFacts(buildCaseFacts(loadCaseSnapshot(db, caseId)));

/** 一条真证据（evidence.file_id 有外键，得先建 files 行） */
function insertEvidence(
  f: ReturnType<typeof makeAgentFixture>,
  name: string,
  category: string,
  purpose: string,
) {
  const fileId = Number(
    f.db.prepare("INSERT INTO files (sha256, size, enc_path) VALUES (?, 10, '/x')").run(name).lastInsertRowid,
  );
  f.db
    .prepare(
      'INSERT INTO evidence (case_id, user_id, file_id, name, category, prove_purpose) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(f.caseId, f.userId, fileId, name, category, purpose);
}

describe('G-F9 姓名接线：明文出境的两条前置条件，四态各一条断言', () => {
  it('★已实名 + 密文可解 → 注入明文姓名 + 使用约束（变异：loadIdentity 不解密 → 红）', () => {
    const f = makeAgentFixture(); // 夹具建的用户就是 auth_status='已实名'
    f.db.prepare('UPDATE users SET real_name_enc = ? WHERE id = ?').run(encryptField('王小明'), f.userId);

    const s = loadCaseSnapshot(f.db, f.caseId);
    expect(s.identity).toEqual({ realName: '王小明', authStatus: '已实名', nameUnreadable: false });
    const text = card(f.db, f.caseId);
    expect(text).toContain('姓名：王小明〔已实名｜已核验〕');
    expect(text).toContain('只用于用户明确要求的文书填写');
    expect(text).toContain('正文对话里不复述');
  });

  it('★待审 / 未认证 + 有密文 → 姓名一个字都不出库（变异：删掉 auth_status 闸 → 红）', () => {
    const f = makeAgentFixture();
    const cipher = encryptField('王小明');
    for (const status of ['待审', '未认证']) {
      f.db.prepare('UPDATE users SET real_name_enc = ?, auth_status = ? WHERE id = ?').run(cipher, status, f.userId);
      const s = loadCaseSnapshot(f.db, f.caseId);
      expect(s.identity, `auth_status=${status}`).toEqual({
        realName: null,
        authStatus: status,
        nameUnreadable: false,
      });
      const text = card(f.db, f.caseId);
      // 姓名故意取夹具案件标题里没有的字：标题是「王小明诉某安全公司…」的话，
      // 「不许出现」会被标题碰撞成永远失败的假红
      expect(text, `auth_status=${status} 不许出现明文姓名`).not.toContain('王小明');
      expect(text).toContain('姓名：未实名，档案里没有你的姓名，文书里我不会替你填');
    }
  });

  it('★已实名 + 密文解不开 → 说成我们的故障，不冒充"未实名"（变异：catch 里返回未实名 → 红）', () => {
    const f = makeAgentFixture();
    f.db.prepare("UPDATE users SET real_name_enc = 'v1:garbage' WHERE id = ?").run(f.userId);
    const s = loadCaseSnapshot(f.db, f.caseId);
    expect(s.identity.nameUnreadable).toBe(true);
    expect(s.identity.realName).toBeNull();
    const text = card(f.db, f.caseId);
    expect(text).toContain('解密失败');
    expect(text).not.toContain('姓名：未实名');
  });

  /**
   * ★已实名但 real_name_enc 为 NULL：认证过了、姓名没落库。
   * 原来这一态复用「未实名」那句，等于对着刚做完实名的用户说"你未实名"——
   * 系统在否认他刚办完的事，而且把该做的动作说反了（要补的是姓名，不是再实名一遍）。
   * 变异：把这一态与未实名合并成一句 → 本条红。
   */
  it('★已实名但没有姓名记录 → 说"实名已通过、档案里没有姓名"，既不谎报未实名也不谎报读取失败', () => {
    const f = makeAgentFixture();
    const s = loadCaseSnapshot(f.db, f.caseId);
    expect(s.identity).toEqual({ realName: null, authStatus: '已实名', nameUnreadable: false });
    const text = card(f.db, f.caseId);
    expect(text).toContain('姓名：实名已通过，但档案里没有姓名记录，文书里我不会替你填');
    expect(text).not.toContain('姓名：未实名');
    expect(text).not.toContain('解密失败');
  });

  it('★未认证用户仍走未实名那句（两态不许合并）', () => {
    const f = makeAgentFixture();
    f.db.prepare("UPDATE users SET auth_status = '未认证' WHERE id = ?").run(f.userId);
    const text = card(f.db, f.caseId);
    expect(text).toContain('姓名：未实名，档案里没有你的姓名，文书里我不会替你填');
    expect(text).not.toContain('实名已通过');
  });

  it('★端到端：runTurn 真的把姓名与约束行送进了 system prompt', async () => {
    const f = makeAgentFixture();
    f.db.prepare('UPDATE users SET real_name_enc = ? WHERE id = ?').run(encryptField('王小明'), f.userId);
    const provider = scriptedProvider([
      {
        text: 'ok',
        tools: [
          {
            name: 'create_action_item',
            args: { title: '留证', detail: '把通知拍照存档', due_at: '2026-08-21T18:00:00+08:00' },
          },
        ],
      },
      { text: '' },
    ]);
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      mode: '问诊',
      message: '你好',
      provider,
      emit: makeSink().emit,
    });
    const system = provider.calls[0][0].content;
    expect(system).toContain('姓名：王小明〔已实名｜已核验〕');
    expect(system).toContain('只用于用户明确要求的文书填写');
  });
});

/**
 * G-F11 时间线的真总数与真锚点。
 *
 * 【为什么必须走真库】case-facts.test.ts 的夹具是手搓 snapshot，窗口截断这一刀
 * 只发生在 loadCaseSnapshot 里（TIMELINE_WINDOW=30）——45 条事件的库里，
 * 「共 N 条」写窗口长度、锚点取窗口末行，这两个错误在纯夹具下永远看不见。
 */
describe('G-F11 时间线窗口：卡上的「共 N 条」与起点锚点都是全案真值', () => {
  it('★45 条事件的库 → 窗口 30 条，但卡里写「共 45 条」、锚点是第 1 条', () => {
    const f = makeAgentFixture();
    const ins = f.db.prepare(
      'INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, ?, ?, ?)',
    );
    // 第 1 条最早（2026-01-01），第 45 条最新
    for (let i = 1; i <= 45; i += 1) {
      const d = new Date(Date.UTC(2026, 0, 1) + (i - 1) * 86400000).toISOString().slice(0, 10);
      ins.run(f.caseId, `${d} 09:00:00`, '公司动作', `第 ${i} 号事件`);
    }

    const s = loadCaseSnapshot(f.db, f.caseId);
    expect(s.timeline).toHaveLength(30); // 窗口只给最近 30 条
    expect(s.timelineStats.total).toBe(45); // 但总数是真的
    expect(s.timelineStats.earliest!.title).toBe('第 1 号事件');
    // 窗口末行是第 16 条——原实现拿它当入职锚点，工龄少算 15 天
    expect(s.timeline[s.timeline.length - 1].title).toBe('第 16 号事件');

    const text = renderCaseFacts(buildCaseFacts(s));
    expect(text).toMatch(/共 45 条，此处只列 \d+ 条/);
    expect(text).not.toMatch(/共 30 条，此处只列/);
    const lines = text.split('\n');
    const anchorLine = lines[lines.findIndex((l) => l.includes('起点锚点')) + 1];
    expect(anchorLine).toContain('第 1 号事件');
    expect(anchorLine).toContain('2026-01-01');
  });

  it('★事件不超窗口 → 总数就是条数，锚点不重复印', () => {
    const f = makeAgentFixture();
    const ins = f.db.prepare(
      'INSERT INTO timeline_events (case_id, happened_at, kind, title) VALUES (?, ?, ?, ?)',
    );
    for (let i = 1; i <= 5; i += 1) ins.run(f.caseId, `2026-03-0${i} 09:00:00`, '公司动作', `第 ${i} 号事件`);

    const s = loadCaseSnapshot(f.db, f.caseId);
    expect(s.timelineStats).toMatchObject({ total: 5 });
    expect(s.timelineStats.earliest!.title).toBe('第 1 号事件');
    const text = renderCaseFacts(buildCaseFacts(s));
    expect(text).not.toContain('此处只列'); // 没裁就没有留痕
    expect(text.split('第 1 号事件').length - 1).toBe(1); // 锚点不重复
  });
});

describe('G-F10 证据与历史接线：库里有什么，卡上就得数出什么', () => {
  it('★库里 3 条证据（含 1 条合同）→ snapshot 带出来 → 卡里计数与明细都对（变异：evidence 恒空 → 红）', () => {
    const f = makeAgentFixture();
    insertEvidence(f, '劳动合同.pdf', '合同', '证明劳动关系');
    insertEvidence(f, '工资流水.pdf', '工资', '证明月薪基数');
    insertEvidence(f, '打卡记录.png', '考勤', '证明加班');

    const s = loadCaseSnapshot(f.db, f.caseId);
    expect(s.evidence).toHaveLength(3);
    const text = card(f.db, f.caseId);
    expect(text).toContain('证据共 3 条');
    expect(text).toContain('合同 1');
    expect(text).toContain('工资 1');
    expect(text).toContain('考勤 1');
    expect(text).toContain('社保 0'); // 0 的类别照列
    expect(text).toContain('《劳动合同.pdf》｜合同｜已上传｜证明目的：证明劳动关系');
    // 没提取过的条目要在同一行明说「没读过内容」，别让模型以为文件名之外还有别的
    expect(text).toContain('未提取（没读过内容）');
  });

  it('★库里没有证据 → 卡上写「证据共 0 条」，免责句仍在（变异：0 条时省略免责句 → 红）', () => {
    const f = makeAgentFixture();
    expect(loadCaseSnapshot(f.db, f.caseId).evidence).toHaveLength(0);
    const text = card(f.db, f.caseId);
    expect(text).toContain('证据共 0 条');
    expect(text).toContain('「简报」是系统读过文件内容之后写下的结论');
  });

  it('★historyStats 数的是本案跨线程的真实条数（变异：countCaseMessages 换成按线程数 → 红）', async () => {
    const f = makeAgentFixture();
    expect(loadCaseSnapshot(f.db, f.caseId).historyStats).toEqual({ total: 0, firstAt: null });

    const round = () => [
      {
        text: '好',
        tools: [
          {
            name: 'create_action_item',
            args: { title: '留证', detail: '把通知拍照存档', due_at: '2026-08-21T18:00:00+08:00' },
          },
        ],
      },
      { text: '' },
    ];
    // 问诊一轮 + 陪跑一轮 = 两条线程、四条消息（各一问一答）
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      mode: '问诊',
      message: '第一句',
      provider: scriptedProvider(round()),
      emit: makeSink().emit,
    });
    await runTurn({
      db: f.db,
      caseId: f.caseId,
      userId: f.userId,
      mode: '陪跑',
      message: '第二句',
      provider: scriptedProvider(round()),
      emit: makeSink().emit,
    });

    const s = loadCaseSnapshot(f.db, f.caseId);
    expect(s.historyStats.total).toBe(4);
    expect(s.historyStats.firstAt).not.toBeNull();
    const text = renderCaseFacts(buildCaseFacts(s));
    expect(text).toContain(`本案历史消息共 4 条（最早 ${s.historyStats.firstAt!.slice(0, 10)}）`);
  });
});
