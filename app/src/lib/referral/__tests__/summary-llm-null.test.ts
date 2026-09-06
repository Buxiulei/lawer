/**
 * 【挑模型这一层缺 key 时回 null，不抛错】判据。
 *
 * 【为什么与 summary-llm-wired 分成两个文件】那份把 `@/lib/referral/summary-llm` 整个
 * mock 掉了（否则钉不住工具壳传不传模型），于是本文件要验的函数在那边根本不会执行。
 * 合在一处的形态是：判据写着「回 null 不抛错」，实际验的是 mock 自己回的 null。
 *
 * 【变异臂】去掉 defaultSummaryLlm 里的 try/catch ⇒ 红（getProvider 在没 key 时抛错，
 * 那一抛会顺着 buildPacket 冒到工具壳，让一次已经取得用户同意的转介失败）。
 */
import { afterEach, beforeEach, expect, it } from 'vitest';

import { REQUIRED_ENV } from '@/lib/llm/routing.config';

import { defaultSummaryLlm } from '../summary-llm';

const NAMES = [...new Set(Object.values(REQUIRED_ENV).flat())];
const backup = new Map<string, string | undefined>();

beforeEach(() => {
  for (const n of NAMES) {
    backup.set(n, process.env[n]);
    delete process.env[n];
  }
});

afterEach(() => {
  for (const [n, v] of backup) {
    if (v === undefined) delete process.env[n];
    else process.env[n] = v;
  }
  backup.clear();
});

it('一个 provider 的 key 都没有 ⇒ 回 null 而不是抛错（变异：去掉 try/catch ⇒ 红）', () => {
  expect(() => defaultSummaryLlm()).not.toThrow();
  expect(defaultSummaryLlm()).toBeNull();
});
