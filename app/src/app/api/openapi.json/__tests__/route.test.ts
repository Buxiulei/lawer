// /api/openapi.json 的路由判据：基址来自 env、profile 只认一个值、公开无鉴权。
//
// 生成逻辑本身的判据在 lib/capabilities/__tests__/openapi.test.ts；这里只验路由这一段接线——
// 接线写错的形态是「文档内容完全正确，但 servers 指着容器内的 localhost」，
// 对方按它生成的客户端一个请求都发不出去，而文档看起来毫无问题。
import { afterEach, describe, expect, test } from 'vitest';

import { GET } from '../route';

const PUBLIC_URL = 'https://law.example.com';

afterEach(() => {
  delete process.env.LAWER_PUBLIC_URL;
});

async function doc(url = 'http://container.internal:3000/api/openapi.json') {
  const res = await GET(new Request(url));
  return { res, json: (await res.json()) as Record<string, unknown> };
}

function servers(json: Record<string, unknown>): { url: string }[] {
  return json.servers as { url: string }[];
}

describe('/api/openapi.json', () => {
  test('servers 用 LAWER_PUBLIC_URL，而不是本次请求打到的那个 host', async () => {
    process.env.LAWER_PUBLIC_URL = PUBLIC_URL;
    const { res, json } = await doc();
    expect(res.status).toBe(200);
    expect(servers(json)[0].url).toBe(PUBLIC_URL);
    expect(JSON.stringify(json)).not.toContain('container.internal');
  });

  test('末尾斜杠的 LAWER_PUBLIC_URL 不会生出双斜杠', async () => {
    process.env.LAWER_PUBLIC_URL = `${PUBLIC_URL}/`;
    expect(servers((await doc()).json)[0].url).toBe(PUBLIC_URL);
  });

  test('没配 env 时退回本次请求的 origin（本地开发够用，不会指向生产）', async () => {
    const { json } = await doc('http://localhost:3000/api/openapi.json');
    expect(servers(json)[0].url).toBe('http://localhost:3000');
  });

  test('不带任何凭据也能取到（对方还没有 key 的时候就要读它）', async () => {
    const { res } = await doc();
    expect(res.status).toBe(200);
  });

  test('?profile=actions 出精简集，条数比全量少且 ≤30', async () => {
    process.env.LAWER_PUBLIC_URL = PUBLIC_URL;
    const full = await doc(`${PUBLIC_URL}/api/openapi.json`);
    const slim = await doc(`${PUBLIC_URL}/api/openapi.json?profile=actions`);
    const count = (j: Record<string, unknown>) =>
      Object.values(j.paths as Record<string, object>).reduce(
        (n, item) => n + Object.keys(item).length,
        0,
      );
    expect(count(slim.json)).toBeLessThanOrEqual(30);
    expect(count(slim.json)).toBeLessThan(count(full.json));
    expect(JSON.stringify(slim.json)).toContain('case_facts');
  });

  test('profile 写错（少个 s）退回全量，不回 400——面板只会显示「导入失败」', async () => {
    const typo = await doc('http://localhost:3000/api/openapi.json?profile=action');
    const full = await doc('http://localhost:3000/api/openapi.json');
    expect(typo.res.status).toBe(200);
    expect(Object.keys(typo.json.paths as object).length).toBe(
      Object.keys(full.json.paths as object).length,
    );
  });

  test('info.version 跟着注册表指纹走（对方存下它，变了就该重读）', async () => {
    const { json } = await doc();
    const { toolsVersion } = await import('@/lib/capabilities/version');
    expect((json.info as { version: string }).version).toBe(toolsVersion());
  });
});
