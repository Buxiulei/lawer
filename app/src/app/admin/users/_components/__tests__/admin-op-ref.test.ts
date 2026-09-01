// app/src/app/admin/users/_components/__tests__/admin-op-ref.test.ts
//
// 后台操作台的**跨请求幂等键（op_ref）**在前端这一侧的落点。要害两条，都对着「钱/权益双发洞」：
//   ① op_ref 在点「发放/调整」那一刻生成一次、随 pending 存下，**重试复用同一把**——
//      服务端据此短路，会员期不叠成 730、公道值不双发。
//   ② runPending 成功才清 pending；**catch 不清 pending**——弹层因此保持打开，
//      下一次确认拼出的 op_ref 与首发同一把。catch 里一旦清了 pending，重试会换新 ref → 双发。
//
// 测试环境是 node，没有 DOM，驱动不了组件自己的 useState（同 login-flow.test.tsx 的处境）。
// 所以能纯函数验的（opRequestBody / newOpRef）直接跑真产物；够不着的 state 翻转（清没清 pending）
// 照仓库既有套路（structure-guard.test.ts）剥注释后扫源码结构，并各配一条对照臂证明尺子有牙。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { newOpRef, opRequestBody } from '../AdminUsersView';
import { isAdminGrantRef } from '@/lib/admin/actions';

// ───────────────────── ① op_ref 生成一次、重试复用同一把 ─────────────────────

describe('op_ref：点确认那一刻生成一次，重试复用', () => {
  it('newOpRef 的形状恰好被服务端 isAdminGrantRef 认作本操作者的操作痕', () => {
    const ref = newOpRef(7);
    expect(isAdminGrantRef(ref, 7)).toBe(true);
    // 不是本人的 uid 就认不出——前端拼错 self_uid，服务端会 400 挡下（不会记到别人头上）
    expect(isAdminGrantRef(ref, 8)).toBe(false);
    // 形状锚：admin-<uid>-<毫秒>-<8 位十六进制>
    expect(ref).toMatch(/^admin-7-\d{10,}-[0-9a-f]{8}$/);
  });

  it('opRequestBody 恒把 pending.opRef 原样带进请求体（会员 + 公道值两条路都是）', () => {
    const memBody = opRequestBody({ kind: 'membership', uid: 3, plan: 'pro', days: 365, opRef: 'admin-9-1788220800000-aaaaaaaa' });
    expect(memBody.op_ref).toBe('admin-9-1788220800000-aaaaaaaa');
    expect(memBody).toMatchObject({ plan: 'pro', days: 365 });

    const gdBody = opRequestBody({ kind: 'gongdao', uid: 3, delta: 500, note: 'x', opRef: 'admin-9-1788220800001-bbbbbbbb' });
    expect(gdBody.op_ref).toBe('admin-9-1788220800001-bbbbbbbb');
    expect(gdBody).toMatchObject({ delta: 500, note: 'x' });
  });

  it('同一个 pending 反复拼包（模拟重试）→ op_ref 每次同一把', () => {
    // 关键：op_ref 存在 pending 里，opRequestBody 只读不生成。故只要 pending 不被清，
    // 首发与重试拿到的就是同一把 ref。这正是「catch 不清 pending」要守住的东西。
    const pending = { kind: 'gongdao' as const, uid: 3, delta: 500, note: 'x', opRef: newOpRef(9) };
    const first = opRequestBody(pending).op_ref;
    const retry = opRequestBody(pending).op_ref;
    expect(retry).toBe(first);

    // 对照臂：若真在每次拼包时新生成（下面模拟这种坏实现），两次就会不同 → 上面的相等断言会红
    const badFirst = newOpRef(9);
    const badRetry = newOpRef(9);
    expect(badRetry).not.toBe(badFirst);
  });
});

// ───────────────────── ② pending 生命周期：成功才清，catch 不清 ─────────────────────

/** 剥 TS 行/块注释成等长空格（保住结构），再扫源码——注释里反复写着 setPending/pending，直接 grep 全误判。 */
function stripComments(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (two === '//') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      blank(i, end);
      i = end;
    } else {
      i++;
    }
  }
  return out.join('');
}

const SRC = stripComments(
  readFileSync(join(process.cwd(), 'src/app/admin/users/_components/AdminUsersView.tsx'), 'utf-8'),
);

/** runPending 的函数体（从声明到下一个顶层 const）。 */
function runPendingBody(src: string): string {
  const start = src.indexOf('const runPending');
  const end = src.indexOf('const totalPages');
  expect(start, '没找到 runPending').toBeGreaterThanOrEqual(0);
  expect(end, '没找到 totalPages 锚点').toBeGreaterThan(start);
  return src.slice(start, end);
}

/** runPending 里 catch(...) 到 finally 之间那一段（失败路径）。 */
function catchBlock(body: string): string {
  const c = body.search(/catch\s*\(/);
  const f = body.indexOf('finally', c);
  expect(c, 'runPending 没有 catch').toBeGreaterThanOrEqual(0);
  expect(f, 'runPending 没有 finally').toBeGreaterThan(c);
  return body.slice(c, f);
}

describe('pending 生命周期（结构守卫，含对照臂）', () => {
  const body = runPendingBody(SRC);

  it('两个动作按钮各自把 opRef 存进 pending（op_ref 在点击那刻定死）', () => {
    // 会员 + 公道值两个 setPending 都带 opRef: newOpRef(
    const stamped = SRC.match(/opRef:\s*newOpRef\(/g) ?? [];
    expect(stamped.length).toBe(2);
  });

  it('两条请求都经 opRequestBody 拼包（op_ref 因此必随行）', () => {
    expect(body.match(/opRequestBody\(pending\)/g) ?? []).toHaveLength(2);
  });

  it('成功路径清 pending，catch 路径不清 pending', () => {
    // runPending 里 setPending(null) 恰好一处，且在 catch 之外（成功路径）
    expect(body.match(/setPending\(null\)/g) ?? []).toHaveLength(1);
    expect(catchBlock(body)).not.toContain('setPending');
  });

  it('对照臂：同一把尺子在「catch 里清 pending」的坏样本上必须报红', () => {
    const bad = `
      const runPending = async () => {
        try { await go(); setPending(null); }
        catch (err) { setPending(null); setFlash(err); }
        finally { setBusy(false); }
      };
      const totalPages = 1;
    `;
    const badBody = runPendingBody(bad);
    // 坏样本里 catch 段确实含 setPending → 说明检测逻辑抓得到违规
    expect(catchBlock(badBody)).toContain('setPending');
    // 且坏样本的 setPending(null) 有两处（成功 + catch），不满足「恰好一处」
    expect((badBody.match(/setPending\(null\)/g) ?? []).length).toBeGreaterThan(1);
  });
});
