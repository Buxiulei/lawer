/**
 * 对账的裁决：这一轮的回答在库里了没有，找到怎么办、没找到等几次才认栽。
 *
 * 【判据 ↔ 变异臂】
 *  b) 历史里有该轮回答 ⇒ 认领它落定       —— 详见下一条
 *  «对账不比对 message_id ⇒ b 红»：只有上一轮的旧回答、这一轮还没落库时，必须返回 null；
 *     若改成「返回最后一条 assistant」，就会把**上一轮的旧答案**错认成这一轮的 ⇒ 本组红。
 *  c) 历史里没有 ⇒ 第一次「再等一窗」、第二次才「认栽」（STALLED）
 *  STALLED 错误帧带 message_id（重试走 retry_of）；进 reducer 落成 error 卡。
 */
import { describe, expect, it } from 'vitest';
import type { StreamedMessage } from '../../_components/Messages';
import {
  findReconciledAnswer,
  reconcileVerdict,
  stalledError,
  STALLED,
} from '../reconcile';
import { INITIAL, reduce } from '../useChatStream';

function msg(over: Partial<StreamedMessage> & { id: string }): StreamedMessage {
  return {
    threadId: 'th_1',
    role: 'assistant',
    content: '按 N+1 主张，先别签自愿离职。',
    createdAt: '2026-09-04T00:00:00.000Z',
    ...over,
  };
}

describe('b) findReconciledAnswer：认领这一轮的回答', () => {
  it('历史里有该轮的 assistant 回答（id = m_<message_id>）⇒ 返回它', () => {
    const rows = [
      msg({ id: 'm_50', content: '上一轮的旧回答。' }),
      msg({ id: 'm_60', role: 'user', content: '这一轮的问话' }),
      msg({ id: 'm_77', content: '这一轮的新回答。' }),
    ];
    expect(findReconciledAnswer(rows, '77')?.id).toBe('m_77');
  });

  it('«比对 message_id»：只有上一轮的旧回答、这一轮还没落库 ⇒ null（不能把旧的错认成新的）', () => {
    const rows = [
      msg({ id: 'm_50', content: '上一轮的旧回答。' }),
      msg({ id: 'm_60', role: 'user', content: '这一轮的问话' }),
      // 注意：这一轮的 assistant 行（m_77）还没进库
    ];
    expect(findReconciledAnswer(rows, '77')).toBeNull();
  });

  it('该轮落成的是失败行（failedCode 非空）⇒ null，交给失败卡+重试那条路', () => {
    const rows = [msg({ id: 'm_77', failedCode: 'AGENT_FAILED', content: '这一轮没能生成回答。' })];
    expect(findReconciledAnswer(rows, '77')).toBeNull();
  });

  it('该行是空正文 / 是 user 行 ⇒ null', () => {
    expect(findReconciledAnswer([msg({ id: 'm_77', content: '   ' })], '77')).toBeNull();
    expect(findReconciledAnswer([msg({ id: 'm_77', role: 'user', content: '问话' })], '77')).toBeNull();
  });

  it('没有 message_id（连都没连上、没有锚点）⇒ null，一律按「还没有」处理', () => {
    const rows = [msg({ id: 'm_77', content: '某条回答。' })];
    expect(findReconciledAnswer(rows, null)).toBeNull();
  });
});

describe('c) reconcileVerdict：找到落定 / 没找到先等一窗再认栽', () => {
  const answer = msg({ id: 'm_77' });

  it('找到 ⇒ recovered', () => {
    expect(reconcileVerdict(answer, 1, 2)).toEqual({ kind: 'recovered', message: answer });
  });
  it('第一次没找到 ⇒ pending（再等一窗）', () => {
    expect(reconcileVerdict(null, 1, 2)).toEqual({ kind: 'pending' });
  });
  it('第二次仍没找到 ⇒ stalled（认栽）', () => {
    expect(reconcileVerdict(null, 2, 2)).toEqual({ kind: 'stalled' });
  });
});

describe('STALLED 错误帧', () => {
  it('带 message_id（重试走 retry_of）+ 三段式文案', () => {
    const err = stalledError('77');
    expect(err.code).toBe(STALLED);
    expect(err.message_id).toBe('77');
    expect(err.message).toContain('连接断了');
    expect(err.message).toContain('刷新');
    expect(err.message).toContain('重试');
  });

  it('没有 message_id ⇒ 不硬编一个（重试退回照原文再发一次）', () => {
    expect(stalledError(null).message_id).toBeUndefined();
  });

  it('进 reducer ⇒ 落成 error 卡，error.messageId 留着给重试入口', () => {
    const next = reduce(
      { ...INITIAL, phase: 'reconnecting' },
      { type: 'frame', frame: stalledError('77') },
    );
    expect(next.phase).toBe('error');
    expect(next.error).toMatchObject({ code: STALLED, messageId: '77' });
  });
});
