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

  /**
   * 开场指令：先 `case_list` 认领案件（单案直接用、不开口问用户要编号），再 `case_facts`。
   * 守两头——新指令在、旧毛病不在。旧毛病是「不知道 case_id 就问用户」，它让绝大多数
   * 只有一个案件的用户被无端问一句编号（主理人真机测试里 GPT 就这么反问了）。
   * 【注意】不能笼统地禁「问用户」——「缺哪一项就问用户」讲的是缺字段，那句要保留。
   */
  test('总纲先教 case_list 认领案件，不再一上来就问用户要 case_id', async () => {
    const text = await (await get('SKILL.md')).text();
    expect(text).toContain('case_list');
    // 单案直接用它的 id、不必问编号——这条新指令必须在
    expect(text).toContain('不要再问用户要编号');
    // 旧毛病：不知道 case_id 就回头问用户要编号——不许再出现
    expect(text).not.toMatch(/不知道\s*`?case_id`?\s*就问/);
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

  /**
   * 畸形百分号编码。
   *
   * 【这条判据的形状是真机改出来的，读它之前先读这段】第一版把畸形串当成
   * 「params 里给的原样字符串」，单测全绿——而真机 polish-browser.mjs 三条 FAIL
   * 指出线上照旧 500。实测（next 16.2.9 生产模式）：/skill/% 这类请求在 Next
   * **匹配动态段那一步**就 500 了，这个 handler 一次都没进；且全站每条动态路由同形
   * （/verify/%、/case/%/ask、/api/v1/keys/%/secret 一律 500）。那是入口层的事，
   * 已上报，不在本单。
   *
   * 所以下面两条量的是本路由自己那一份责任：params 解不开时不再由我们再补一发 500，
   * 以及「解得开但仍非法」照旧 404。**别把它们读成「/skill/% 线上会回 404」。**
   */
  test('畸形百分号编码：params 解不开时也落到同一句 404 自述，不是 500', async () => {
    const getBroken = (raw: string) =>
      GET(new Request(`http://localhost/skill/${raw}`), {
        // Next 对畸形段就是这么炸的：拿不到 filename，只有一个 rejected promise
        params: Promise.reject(new URIError('URI malformed')),
      });
    for (const bad of ['%', '%zz', 'SKILL%.md']) {
      const res = await getBroken(bad);
      expect(res.status, bad).toBe(404);
      expect(res.headers.get('content-type'), bad).toContain('text/plain');
      const text = await res.text();
      for (const part of ['缺什么', '为什么缺', '怎么办']) expect(text, bad).toContain(part);
      // 自述里点名的是他真的敲进去的那一段，不是一个空文件名
      expect(text, bad).toContain(bad);
      expect(text, bad).not.toContain('URI');
    }
  });

  /* 保险起见把「已解码但仍畸形」那一档也留着：换个 Next 版本它可能真交进来 */
  test('畸形串当作已解码段交进来时同样 404', async () => {
    for (const bad of ['%', '%zz', '%E4%A', 'SKILL%.md']) {
      const res = await get(bad);
      expect(res.status, bad).toBe(404);
      expect(res.headers.get('content-type'), bad).toContain('text/plain');
      const text = await res.text();
      // 与上面那组一字不差的同一句自述：缺什么/为什么缺/怎么办
      for (const part of ['缺什么', '为什么缺', '怎么办']) expect(text, bad).toContain(part);
      expect(text, bad).toContain('SKILL.md');
      // 不许把 URIError 的原文或堆栈端给对方
      expect(text, bad).not.toContain('URI');
    }
  });

  /*
   * 正对照：合法的百分号编码照旧解得开——接住异常不等于从此不解码。
   * 少了这一条，把 decodeURIComponent 整个删掉上面那组也全绿，
   * 而中文文件名（/skill/%E6%8E%A5%E5%85%A5%E8%AF%B4%E6%98%8E.md）会开始 404。
   */
  test('合法百分号编码照旧解得开（正对照）', async () => {
    const res = await get(encodeURIComponent('接入说明.md'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/markdown');
  });
});
