// app/src/lib/db/__tests__/client-guard.test.ts
// 「测试期不许落到默认库路径」这道闸（评测官 2026-08-28 提判据，我实现）。
//
// 【为什么需要它】惰性求值修掉了「谁先 import client.ts」那个顺序问题，
// **但没修兜底问题**：任何忘了设 DB_PATH 的测试仍会静默写进 <cwd>/data/lawer.db，
// 那是被 gitignore、没人 review 的开发库 ⇒「跑过测试的人开发库里混着测试数据」。
// 实测当前全量无人落到那里（把 app/data 挪走跑全量，目录没被造回来），
// **但那是"现在没有"不是"不可能"**。这条测试守的是后者。
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const SAVED = process.env.DB_PATH;

beforeEach(() => {
  delete process.env.DB_PATH;
  // client.ts 里 _db 是模块级单例；不重置模块的话，前面的测试可能已经把它建好，
  // 这几条就测不到那个分支了（会拿到缓存的实例直接返回）。
  vi.resetModules();
});
afterEach(() => {
  if (SAVED === undefined) delete process.env.DB_PATH;
  else process.env.DB_PATH = SAVED;
});

describe('测试期默认库路径闸', () => {
  test('未设 DB_PATH 时 getDb() 抛错，而不是静默写开发库', async () => {
    const mod = await import('../client');
    expect(() => mod.getDb()).toThrow(/测试期不许用默认库路径/);
  });

  test('错误信息里说清了该怎么做，不是干巴巴一句「不许」', async () => {
    const mod = await import('../client');
    try {
      mod.getDb();
      throw new Error('本该抛错');
    } catch (e) {
      const msg = String((e as Error).message);
      expect(msg).toContain('DB_PATH');
      expect(msg).toContain('beforeAll');
      // 说清后果，否则读的人不知道为什么要管
      expect(msg).toContain('开发库');
    }
  });

  test('设了 DB_PATH 就正常放行（闸不能把正常路也拦了）', async () => {
    const os = await import('node:os');
    const path = await import('node:path');
    const crypto = await import('node:crypto');
    process.env.DB_PATH = path.join(os.tmpdir(), `lawer-guard-${crypto.randomUUID()}.db`);
    const mod = await import('../client');
    expect(() => mod.getDb()).not.toThrow();
  });
});
