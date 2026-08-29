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

describe('kb_cards：哨兵唯一能看见"卡数变没变"的面', () => {
  test('正常时给出真实卡数（>200）', async () => {
    process.env.BUILD_SHA = 'abc';
    const body = await (await GET()).json();
    expect(typeof body.kb_cards).toBe('number');
    expect(body.kb_cards).toBeGreaterThan(200);
  });

  test('🔑 索引坏掉时 kb_cards 为 null，而 sha 仍然给得出来', async () => {
    // 【为什么不让端点整个 500】这是哨兵唯一的外部可读面；索引坏时若它自己也挂，
    // **哨兵连 sha 都读不到**——一个在故障时自己也失灵的探针，正是要消灭的东西。
    // 【必须显式重置】索引是模块级缓存——不重置的话改 env 也拿不到新状态。
    // 这也正说明 kb_cards 反映的是「**本进程手里**那一份」，而不是每次去读盘：
    // manager 要的就是这个语义（运行中被掏空也能看见，因为进程重启才会重读）。
    const kb = await import('@/lib/knowledge');
    process.env.BUILD_SHA = 'abc';
    process.env.LAWER_KNOWLEDGE_DIR = '/definitely/not/a/knowledge/dir';
    kb.__resetForTest();
    const body = await (await GET()).json();
    delete process.env.LAWER_KNOWLEDGE_DIR;
    kb.__resetForTest();
    expect(body.kb_cards).toBeNull();
    expect(body.sha).toBe('abc');
    expect(body.ok).toBe(true);
  });

  test('🔑 内存结构被清空 → 端点必须跟着报 0（同源，不是另读 index.json）', async () => {
    // manager 2026-08-29 钉的负测：packs/ 丢了而 index.json 还在时，
    // 若端点自己另读一次 index.json，它会报 218 而 agent 手里是空的——
    // **两个真源在故障时各说各话，报出来的是好看的那个。**
    const fs2 = await import('node:fs');
    const os2 = await import('node:os');
    const path2 = await import('node:path');
    const kb = await import('@/lib/knowledge');
    const d = fs2.mkdtempSync(path2.join(os2.tmpdir(), 'kb-empty-'));
    fs2.writeFileSync(path2.join(d, 'index.json'), '[]');
    process.env.LAWER_KNOWLEDGE_DIR = d;
    process.env.KNOWLEDGE_ALLOW_EMPTY = '1'; // 让加载成功、里面是空的
    kb.__resetForTest();
    const body = await (await GET()).json();
    delete process.env.LAWER_KNOWLEDGE_DIR;
    delete process.env.KNOWLEDGE_ALLOW_EMPTY;
    kb.__resetForTest();
    fs2.rmSync(d, { recursive: true, force: true });
    expect(body.kb_cards).toBe(0);
    expect(body.kb_cards).not.toBeNull(); // 0 是"空了"，null 是"读不出来"
  });

  test('null 与 0 不许合并 —— 两种故障诊断路径不同', async () => {
    const kb2 = await import('@/lib/knowledge');
    process.env.LAWER_KNOWLEDGE_DIR = '/definitely/not/a/knowledge/dir';
    kb2.__resetForTest();
    const broken = await (await GET()).json();
    delete process.env.LAWER_KNOWLEDGE_DIR;
    kb2.__resetForTest();
    expect(broken.kb_cards).toBeNull();
    expect(broken.kb_cards).not.toBe(0);
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
