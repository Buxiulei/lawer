// app/src/lib/auth/__tests__/admin.test.ts
// ADMIN_UIDS 的解析。这一层看着像字符串处理，实际上它决定「谁能凭空造公道值」。
import { describe, expect, test } from 'vitest';

import { adminUids, isAdminUid } from '../admin';

describe('ADMIN_UIDS 解析', () => {
  test('逗号分隔、容忍空格', () => {
    expect([...adminUids('2, 7 ,13')]).toEqual([2, 7, 13]);
    expect(isAdminUid(7, '2, 7 ,13')).toBe(true);
    expect(isAdminUid(8, '2, 7 ,13')).toBe(false);
  });

  test('没配 / 空串 / 全是分隔符 → 空集（谁都不是管理员）', () => {
    for (const raw of [undefined, '', '   ', ',,,', ' , ']) {
      expect([...adminUids(raw)], `raw=${JSON.stringify(raw)}`).toEqual([]);
      expect(isAdminUid(2, raw as string | undefined)).toBe(false);
    }
  });

  /**
   * 【这条防的是 `Number('')===0`】用 Number 做宽松解析时，`ADMIN_UIDS=","` 里的空段
   * 会解出 0 并落进白名单。uid 0 现实中不存在（AUTOINCREMENT 从 1 起），
   * 所以这个洞不会让任何人真的登录成管理员——但它会让「配错了」和「配对了」在测试里同形。
   */
  test('垃圾值不入集：非纯数字、0、负数、小数、科学计数法一律丢弃', () => {
    expect([...adminUids('2x, abc, 0, -1, 3.5, 1e3, , 2')]).toEqual([2]);
  });

  test('默认读 process.env.ADMIN_UIDS', () => {
    const saved = process.env.ADMIN_UIDS;
    try {
      process.env.ADMIN_UIDS = '42';
      expect(isAdminUid(42)).toBe(true);
      expect(isAdminUid(43)).toBe(false);
      // 改 env 立刻生效（不缓存）：改了配置重启即可，不必怀疑是不是被某个模块冻住了
      process.env.ADMIN_UIDS = '43';
      expect(isAdminUid(42)).toBe(false);
      expect(isAdminUid(43)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.ADMIN_UIDS;
      else process.env.ADMIN_UIDS = saved;
    }
  });
});
