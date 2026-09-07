// app/src/lib/knowledge/__tests__/grounding-pending.test.ts
// 扎根豁免的**到期判定**在 TS 侧与 python 侧必须是同一天。
//
// 【这组补的是哪个缺口】TS 侧此前用 `today.toISOString().slice(0, 10)` 取"今天"——
// 那是 UTC 日期；python 侧 `date.today()` 取的是服务器本地日期（UTC+8）。
// 每天有八小时（本地 00:00–08:00）两边不是同一天：豁免到期那天的凌晨，
// pytest 判红、vitest 判绿，而两条判据说的其实是同一件事。
// 偏差方向还特别差——TS 那侧偏向"豁免还在"，也就是偏向少报。
//
// 【为什么钉 00:30 这个时刻】它落在两边分叉的那八小时里，且离日界最近：
// 用中午的时刻测，UTC 与本地同一天，改回 toISOString() 判据照样绿。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { GROUNDING_PENDING, loadPending, localDateStamp, pendingFor } from './grounding-pending';

let tmp: string | null = null;

afterEach(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

/** 一个只有一份豁免文件的临时 knowledge/ */
function kbWithPending(until: string): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grounding-pending-'));
  const dir = path.join(tmp, 'packs', 'counseling');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, GROUNDING_PENDING),
    `这一包的引文还没逐字核实。\n最迟: ${until}\n`,
    'utf8',
  );
  return tmp;
}

/** 分叉窗口里的那一刻：本地 2026-09-14 00:30，UTC 还是 2026-09-13 16:30 */
const BOUNDARY = new Date('2026-09-14T00:30:00+08:00');

describe('豁免到期按 Asia/Shanghai 的日历日（与 python date.today() 同口径）', () => {
  it('00:30+08:00 那一刻，"今天"是 09-14 而不是 UTC 的 09-13（变异：改回 toISOString → 红）', () => {
    expect(BOUNDARY.toISOString().slice(0, 10), '这个时刻在 UTC 下确实还是前一天').toBe(
      '2026-09-13',
    );
    expect(localDateStamp(BOUNDARY)).toBe('2026-09-14');
  });

  it('最迟 09-13 的豁免，在 09-14 00:30+08:00 已经过期（python 侧同判）', () => {
    const kb = kbWithPending('2026-09-13');
    const [p] = loadPending(kb, BOUNDARY);
    expect(p.until).toBe('2026-09-13');
    expect(p.expired, '本地已是 09-14，这份豁免早该失效').toBe(true);
    // 过期的豁免罩不住任何卡——罩住了就等于"到期即恢复全部守卫"没有发生
    expect(pendingFor('packs/counseling/a.md', [p])).toBeNull();
  });

  it('最迟 09-14 的豁免，同一刻仍然有效（自证上面那条不是"恒过期"）', () => {
    const kb = kbWithPending('2026-09-14');
    const [p] = loadPending(kb, BOUNDARY);
    expect(p.expired).toBe(false);
    expect(pendingFor('packs/counseling/a.md', [p])).toBe('packs/counseling');
  });

  it('同一天 23:30+08:00 仍是 09-14（UTC+8 只会把日期往回错，不会往前）', () => {
    const late = new Date('2026-09-14T23:30:00+08:00');
    expect(localDateStamp(late)).toBe('2026-09-14');
    const kb = kbWithPending('2026-09-14');
    expect(loadPending(kb, late)[0].expired, '最后一天的深夜，豁免仍应有效').toBe(false);
  });

  it('跨过日界之后就过期了（09-15 00:30+08:00 → 最迟 09-14 的失效）', () => {
    const kb = kbWithPending('2026-09-14');
    const next = new Date('2026-09-15T00:30:00+08:00');
    expect(localDateStamp(next)).toBe('2026-09-15');
    expect(loadPending(kb, next)[0].expired).toBe(true);
  });
});
