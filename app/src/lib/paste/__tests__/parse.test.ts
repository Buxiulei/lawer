// 结构块解析的容错三例 + 逐条校验。纯函数，不碰库。
//
// 三例分开报的理由（见 parse.ts 文件头）：没有块 / 块里不是 JSON / 块外正文，
// 在用户那里对应三种不同的下一步动作，合成一句「解析失败」等于让他把同一段粘三遍。
import { describe, expect, it } from 'vitest';

import * as cases from '@/lib/cases';
import { LABOR } from '@/lib/domains/labor';

import { extractBlock, parsePasteBack } from '../parse';
import { FENCE_TAG } from '../protocol';

const fence = (json: string) => '```' + FENCE_TAG + '\n' + json + '\n```';

describe('容错三例', () => {
  it('① 没有结构块 ⇒ NO_BLOCK，并告诉用户回去让助手补一个', () => {
    const res = parsePasteBack('你好，我建议你先把考勤导出来。', LABOR);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('NO_BLOCK');
    expect(res.message).toContain(FENCE_TAG);
  });

  it('② 有块但不是合法 JSON ⇒ BAD_JSON（与「没有块」是两种不同的下一步）', () => {
    const res = parsePasteBack('前言\n' + fence('{"timeline": [ // 少了收尾'), LABOR);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('BAD_JSON');
  });

  it('③ 块外正文全部丢弃，只认块里的内容', () => {
    const text = [
      '这是给用户看的正文，里面提到「2026-08-01 被通知调岗」但它不该被当成一条事件。',
      fence(JSON.stringify({ timeline: [{ happened_at: '2026-09-01T10:00:00+08:00', kind: '公司动作', title: '约谈' }] })),
      '块后面还有一段收尾的话。',
    ].join('\n');
    const res = parsePasteBack(text, LABOR);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(1);
    expect(res.items[0].summary).toContain('约谈');
  });

  it('空对象 ⇒ 解析成功、零条目（这一轮没什么可记是正常态，不是错误）', () => {
    const res = parsePasteBack(fence('{}'), LABOR);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toEqual([]);
  });

  it('最外层不是对象 ⇒ BAD_SHAPE', () => {
    const res = parsePasteBack(fence('[1,2,3]'), LABOR);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.errorCode).toBe('BAD_SHAPE');
  });
});

describe('取最后一个块', () => {
  it('示范块在前、真结论在后 ⇒ 取后面那个', () => {
    const text = [
      '格式像这样：',
      fence('{}'),
      '这一轮实际要记的：',
      fence(JSON.stringify({ actions: [{ what: '导出考勤', how: '打开 OA 导出', why: '离职后打不开', due_at: '2026-09-02T18:00:00+08:00' }] })),
    ].join('\n');
    const res = parsePasteBack(text, LABOR);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(1);
    expect(res.items[0].kind).toBe('actions');
  });

  it('extractBlock 只认带标记的围栏，普通 ``` 代码块不算', () => {
    expect(extractBlock('```json\n{}\n```')).toBeNull();
    expect(extractBlock('```' + FENCE_TAG + '\n{"a":1}\n```')).toBe('{"a":1}');
  });
});

describe('逐条校验', () => {
  it('时间线：非法时间 / 非法类别 / 空标题各自给出可执行的原因', () => {
    const res = parsePasteBack(
      fence(
        JSON.stringify({
          timeline: [
            { happened_at: '上周三', kind: '公司动作', title: '约谈' },
            { happened_at: '2026-09-01T10:00:00+08:00', kind: '老板动作', title: '约谈' },
            { happened_at: '2026-09-01T10:00:00+08:00', kind: '公司动作', title: '  ' },
          ],
        }),
      ),
      LABOR,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.map((i) => i.error?.code)).toEqual([
      'INVALID_HAPPENED_AT',
      'INVALID_KIND',
      'INVALID_TITLE',
    ]);
    expect(res.items[1].error?.message).toContain(cases.TIMELINE_KINDS.join(' / '));
  });

  it('诉求：金额按元收、换算成分；换算不到整分的拒收而不是替他四舍五入', () => {
    const res = parsePasteBack(
      fence(
        JSON.stringify({
          claims: [
            { kind: '欠薪', amount_yuan: 12000.55, basis: '自述' },
            { kind: '欠薪', amount_yuan: 0.001 },
            { kind: '加班工资', amount_yuan: 1 },
          ],
        }),
      ),
      LABOR,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0].error).toBeNull();
    expect(res.items[0].args.amount_fen).toBe(1200055);
    expect(res.items[1].error?.code).toBe('INVALID_AMOUNT');
    expect(res.items[2].error?.code).toBe('INVALID_KIND');
  });

  it('期限：种类与锚点日校验，note 明说不入库', () => {
    const res = parsePasteBack(
      fence(
        JSON.stringify({
          deadlines: [
            { kind: '举证期限', anchor_date: '2026-09-01', days: 10, note: '通知书上写的' },
            { kind: '举证期限', anchor_date: '2026/09/01' },
            { kind: '举证期限', anchor_date: '2026-09-01', days: 0 },
          ],
        }),
      ),
      LABOR,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items[0].error).toBeNull();
    expect(res.items[0].summary).toContain('不入库');
    expect(res.items[1].error?.code).toBe('INVALID_ANCHOR');
    expect(res.items[2].error?.code).toBe('INVALID_DAYS');
  });

  it('个案报告：明说写不进去、为什么、怎么办（三段式），不是静默丢弃', () => {
    const res = parsePasteBack(
      fence(JSON.stringify({ report_updates: [{ section: '争议焦点', content: '…', reason: '…' }] })),
      LABOR,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items).toHaveLength(1);
    expect(res.items[0].error?.code).toBe('REPORT_NOT_AVAILABLE');
    expect(res.items[0].error?.message).toContain('还没上线');
    expect(res.items[0].error?.message).toContain('时间线');
  });

  it('不认的顶层键原样报出来，不静默吞', () => {
    const res = parsePasteBack(fence(JSON.stringify({ evidence: [{ name: 'x' }] })), LABOR);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.unknownKeys).toEqual(['evidence']);
  });

  it('序号跨类别连续（client_ref 与用户勾选都按它认条目）', () => {
    const res = parsePasteBack(
      fence(
        JSON.stringify({
          timeline: [{ happened_at: '2026-09-01T10:00:00+08:00', kind: '公司动作', title: 'a' }],
          actions: [{ what: 'b', how: 'b', why: 'b', due_at: '2026-09-02T18:00:00+08:00' }],
          claims: [{ kind: '欠薪', amount_yuan: 0 }],
        }),
      ),
      LABOR,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.items.map((i) => i.index)).toEqual([0, 1, 2]);
  });
});
