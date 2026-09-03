// app/src/app/skill/__tests__/route.test.ts
// /skill/{filename} 是话术里「第一步」指向的地址：对方 agent 还没配好密钥就要能取到它。
// 所以这里守两件事——三份文件都取得到（不然第一步就断），以及**只**取得到这三份。
import { beforeAll, describe, expect, test } from 'vitest';

import { PUBLIC_SKILL_FILES } from '@/lib/mcp/setup';

type Handler = (req: Request, ctx: { params: Promise<{ filename: string }> }) => Promise<Response>;
let GET: Handler;

const get = (filename: string) =>
  GET(new Request(`http://localhost/skill/${filename}`), {
    params: Promise.resolve({ filename }),
  });

beforeAll(async () => {
  GET = (await import('../[filename]/route')).GET;
});

describe('公开取 skill 包', () => {
  test('三份文件都取得到，且是 Markdown 正文不是壳', async () => {
    // 正对照：清单非空，否则下面这条 for 落在空集上永远绿
    expect(PUBLIC_SKILL_FILES.length).toBe(3);
    for (const name of PUBLIC_SKILL_FILES) {
      const res = await get(name);
      expect(res.status, name).toBe(200);
      expect(res.headers.get('content-type'), name).toContain('text/markdown');
      expect((await res.text()).length, name).toBeGreaterThan(200);
    }
  });

  test('入口那份要能指路到另外两份——否则第一步读完就没有下一步了', async () => {
    const text = await (await get('SKILL.md')).text();
    expect(text).toContain('接入说明.md');
    expect(text).toContain('陪跑指南.md');
    // 总纲的唯一直接指令：先读事实卡
    expect(text).toContain('case_facts');
  });

  test('无鉴权也能取——话术里的第一步跑在"还没有密钥"的时候', async () => {
    // 请求里一个 Authorization 头都没有（上面 get() 就没带），照样 200
    expect((await get('SKILL.md')).status).toBe(200);
  });

  /**
   * 白名单之外一律 404。**尤其是路径穿越**：把白名单去掉、直接拿 URL 段拼路径读文件，
   * 下面这几条就会开始返回 200 或抛出带绝对路径的异常。
   */
  test('非白名单文件名 → 404，且路径穿越拿不到任何东西', async () => {
    for (const bad of [
      '../../etc/passwd',
      '..%2F..%2Fetc%2Fpasswd',
      '../app/.env',
      'variants/claude-skill.md',
      'SKILL.md.bak',
      '',
    ]) {
      const res = await get(bad);
      expect(res.status, bad).toBe(404);
      const text = await res.text();
      expect(text, bad).not.toContain('root:');
      // 自述三段式：告诉对方该去读哪一份，而不是一句裸 not found
      expect(text, bad).toContain('SKILL.md');
    }
  });
});
