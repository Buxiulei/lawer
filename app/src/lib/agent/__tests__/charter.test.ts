// app/src/lib/agent/__tests__/charter.test.ts
// charter 漂移守卫：内嵌常量必须与 docs/agent/lawyer-agent-charter.md 逐字一致。
//
// 这不是形式主义。charter 是 manager 维护的行为契约，改的时候人只会去改 docs 那份；
// 内嵌副本悄悄落后一版，意味着线上 agent 遵守的是**旧准则**，而所有人都以为它遵守的是新的。
// 本测试是那个唯一会喊出来的地方。
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { CHARTER } from '../charter';

const CHARTER_PATH = path.resolve(__dirname, '../../../../../docs/agent/lawyer-agent-charter.md');

describe('CHARTER 常量', () => {
  it('与 docs/agent/lawyer-agent-charter.md 逐字一致', () => {
    const onDisk = readFileSync(CHARTER_PATH, 'utf8');
    expect(CHARTER).toBe(onDisk);
  });

  it('七条红线一条不少地进了 system prompt', () => {
    for (const line of [
      '不编造',
      '必须用户明确确认',
      '不建议任何违法取证',
      '不进行对公司人员的人身攻击',
      '发送后果说明',
      '已告知对方在使用辅助工具',
      '不劝找律师',
    ]) {
      expect(CHARTER).toContain(line);
    }
  });
});
