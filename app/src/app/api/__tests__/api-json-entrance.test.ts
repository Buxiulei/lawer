// app/src/app/api/__tests__/api-json-entrance.test.ts
// 结构守卫：**HTTP 面回 JSON 只有一个出口**（lib/http/json 的 apiJson）。
//
// 【为什么要机检，不靠人记】时间字段的 +08:00 转换挂在 apiJson 上。新开一条路由时
// 顺手写 `NextResponse.json(...)` 是最自然的动作——它照常返回 200，串看起来完全正常，
// 只是里面的时间没有时区标记，收到它的 agent 会按自己的本地时区解析，跨日那一段差一天。
// 漏掉的那一条与"这个接口没有时间字段"在外部完全同形，人工复审看不出来。
// 所以这条由判据点名：谁绕过入口，这里当场说出是哪个文件哪一行。
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const API_ROOT = path.resolve(__dirname, '..');

function routeFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === '__tests__') continue;
      out.push(...routeFiles(full));
    } else if (entry.name === 'route.ts') {
      out.push(full);
    }
  }
  return out;
}

describe('回 JSON 的唯一出口', () => {
  test('route.ts 里不许出现 NextResponse.json —— 一律走 apiJson', () => {
    const offenders: string[] = [];
    for (const file of routeFiles(API_ROOT)) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, i) => {
        if (line.includes('NextResponse.json')) {
          offenders.push(`${path.relative(API_ROOT, file)}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(
      offenders,
      '缺什么：下面这些地方直接用了 NextResponse.json，绕过了对外时间的格式化入口。\n' +
        offenders.join('\n') +
        '\n为什么不能这么写：+08:00 的转换挂在 apiJson 上（见 lib/http/json）。绕过去的回包里，' +
        '时间是没有时区标记的 UTC 裸串，对方按本地时区解析会差八小时、跨日差一天，而且不报任何错。\n' +
        "怎么办：改成 `import { apiJson } from '@/lib/http/json';` 再把 NextResponse.json 换成 apiJson，签名一样。",
    ).toEqual([]);
  });

  test('守卫本身认得出违规（喂一行假的进去要能被抓到）', () => {
    const fake = ['const a = 1;', 'return NextResponse.json({ ok: true });'];
    expect(fake.filter((l) => l.includes('NextResponse.json'))).toHaveLength(1);
  });
});
