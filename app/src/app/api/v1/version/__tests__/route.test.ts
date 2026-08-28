// app/src/app/api/v1/version/__tests__/route.test.ts
// 这个端点存在的唯一理由是让**别人**核验线上跑的是哪一版。
// 所以两条底线：① 取不到就说取不到，绝不给一个能被误读成"核验通过"的值；
// ② 不许被缓存——缓存住的 SHA 会让核验方核到上一版，而且看起来一切正常。
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

let GET: () => Promise<Response>;
const SAVED = { sha: process.env.BUILD_SHA, at: process.env.BUILD_AT };

beforeEach(async () => {
  GET = (await import('../route')).GET;
});
afterEach(() => {
  if (SAVED.sha === undefined) delete process.env.BUILD_SHA;
  else process.env.BUILD_SHA = SAVED.sha;
  if (SAVED.at === undefined) delete process.env.BUILD_AT;
  else process.env.BUILD_AT = SAVED.at;
});

describe('正常构建', () => {
  test('如实返回烙进产物的 sha 与时刻', async () => {
    process.env.BUILD_SHA = '095836f0a260051531833cfa6e19b9cf9529b8c5';
    process.env.BUILD_AT = '2026-08-28T12:00:00.000Z';
    const body = await (await GET()).json();
    expect(body).toMatchObject({
      ok: true,
      sha: '095836f0a260051531833cfa6e19b9cf9529b8c5',
      built_at: '2026-08-28T12:00:00.000Z',
    });
  });

  test('免鉴权：不带任何 Authorization 也能读', async () => {
    process.env.BUILD_SHA = 'abc';
    expect((await GET()).status).toBe(200);
  });
});

describe('🔴 取不到 SHA 时必须说"取不到"', () => {
  test('BUILD_SHA 缺失 → sha 为 null', async () => {
    delete process.env.BUILD_SHA;
    const body = await (await GET()).json();
    expect(body.sha).toBeNull();
  });

  test('BUILD_SHA 为空串 → 同样是 null，不是 ""', async () => {
    // 【为什么要单独钉空串】next.config 里 env 值必须是字符串，取不到时写的是 ''。
    // 如果这里原样透出空串，核验方拿到的是一个**假值**：
    // `sha === expected` 会是 false 没错，但日志里 `sha: ""` 读起来像"字段存在但为空"，
    // 而不是"这一版无法核验"。两者该走不同的处置。
    process.env.BUILD_SHA = '';
    const body = await (await GET()).json();
    expect(body.sha).toBeNull();
    expect(body.sha).not.toBe('');
  });

  test('绝不回落成一个看起来合法的 SHA', async () => {
    delete process.env.BUILD_SHA;
    const raw = await (await GET()).text();
    // 40 位十六进制串一个都不许出现——回落成上次构建值、或编一个，
    // 都会让一次坏滚更看起来"已核验通过"，那比没有这个端点更坏。
    expect(raw).not.toMatch(/[0-9a-f]{40}/);
  });
});

describe('🔴 不许被缓存', () => {
  test('响应带 no-store', async () => {
    process.env.BUILD_SHA = 'abc';
    // 缓存住的 SHA 会让核验方核到上一版，**而且看起来一切正常**——
    // 这正是这个端点要消灭的那种失败，不该由它自己制造一遍。
    expect((await GET()).headers.get('cache-control')).toContain('no-store');
  });
});
