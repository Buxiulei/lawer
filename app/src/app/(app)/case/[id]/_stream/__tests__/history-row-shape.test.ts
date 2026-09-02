/**
 * 后端历史行 → 页面消息的那一次形状转换（`toHistoryMessage`）。
 *
 * ─────────────── 这组补的是哪个缺口 ───────────────
 * 取历史这条链此前只有"取没取、取不到怎么办"受判据看守，**取回来之后那一步没有**。
 * 这一步只有两件事，两件都是"错了页面照样正常"的那种坏法：
 *
 *  ① 气泡画哪一边（`role`）。认不出的 role 一律当 assistant 画，方向是有讲究的：
 *    把助手的话画成用户气泡，用户会以为那句"你现在该做什么"是自己说过的话，
 *    于是这条建议对他就不存在了——而屏幕上一个报错都没有。
 *  ② 型号两件套（`served_model` / `served_mismatch`）直传。丢了它们，历史消息底下
 *    要么不标、要么退回请求值——**退回请求值就是把一个可能不对的型号标成"实际"**。
 *    用户按型号付费，翻回去看昨天那一轮时读到的是个假答案。
 *
 * 【变异臂】
 *  · C13 `toHistoryMessage` 删掉 `servedModel` / `modelMismatch` 两行（不直传）⇒ 「型号两件套」那条红
 *  · C14 `toRole` 兜底翻向（`raw === 'assistant' ? 'assistant' : 'user'`）⇒ 「认不出当助手画」那条红
 */
import { describe, expect, it } from 'vitest';
import { toHistoryMessage, type ApiMessageRow } from '../caseHistory';

/** 一行真实的助手历史：请求 opus、实际由 sonnet 服务（中转换过型号） */
function row(extra: Partial<ApiMessageRow> = {}): ApiMessageRow {
  return {
    id: 42,
    role: 'assistant',
    content: '先别签任何文件。',
    created_at: '2026-08-20T10:00:12+08:00',
    model: 'claude-opus-5',
    served_model: 'claude-sonnet-5',
    served_mismatch: true,
    ...extra,
  };
}

describe('历史行 → 页面消息', () => {
  /** 变异臂 C14 */
  it('assistant → 助手气泡，user → 用户气泡', () => {
    expect(toHistoryMessage(row({ role: 'assistant' })).role).toBe('assistant');
    expect(toHistoryMessage(row({ role: 'user' })).role).toBe('user');
  });

  /** 变异臂 C14 的兜底方向：宁可把用户的话画成助手，也不能反过来 */
  it('认不出的 role 当助手画（绝不把助手的话画成用户气泡）', () => {
    expect(toHistoryMessage(row({ role: 'system' })).role).toBe('assistant');
    expect(toHistoryMessage(row({ role: '' })).role).toBe('assistant');
  });

  /** 变异臂 C13：整组的由头 */
  it('型号两件套原样直传（历史消息也要标**实际**那个）', () => {
    const message = toHistoryMessage(row());
    expect(message.servedModel).toBe('claude-sonnet-5');
    expect(message.modelMismatch).toBe(true);
    // 请求值同样留着：它是落款的退路，不是落款本身
    expect(message.model).toBe('claude-opus-5');
  });

  it('厂商没回显过 ⇒ 实际值仍是 null、mismatch 仍是 false，不替它编一个', () => {
    const message = toHistoryMessage(
      row({ model: 'deepseek-v4-pro', served_model: null, served_mismatch: false }),
    );
    expect(message.servedModel).toBeNull();
    expect(message.modelMismatch).toBe(false);
    expect(message.model).toBe('deepseek-v4-pro');
  });

  it('用户行没有型号 ⇒ model 为 undefined（落款整行不出现）', () => {
    const message = toHistoryMessage(
      row({ id: 41, role: 'user', model: null, served_model: null, served_mismatch: false }),
    );
    expect(message.model).toBeUndefined();
    expect(message.id).toBe('m_41');
    expect(message.createdAt).toBe('2026-08-20T10:00:12+08:00');
  });
});
