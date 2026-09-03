// app/src/app/woo/users/_components/__tests__/realname-queue-guard.test.ts
//
// 审核台前端的三件事都有同一种失败形态：**做错了不报错、不崩，只是安安静静地错着**，
// 所以只能机检（测试环境是 node，没有 DOM，驱动不了组件自己的 useState——
// 同 admin-op-ref.test.ts 的处境，照仓库既有套路剥注释后扫源码结构，每条各配对照臂）。
//
//   ① 审核动作与 AdminUsersView 的 pending/runPending 状态机**零交集**：
//      那把状态机被两个测试文件逐字符钉着（钱不双发的跨请求幂等），
//      混进来的现象是那些精确计数变红，而唯一的"修法"是改断言数字——牙就此磨掉一颗；
//   ② 证件照必须 fetch+Bearer+objectURL 取，且卸载时 revoke。
//      写成 <img src="/api/v1/admin/..."> 的现象是一张裂图（浏览器不带 Authorization 头，
//      撞后台闸门的 404），页面上看不出原因；不 revoke 则是每看一张证件照泄一份内存；
//   ③ 每个审核动作都过二次确认，且 confirmLabel 写明后果——按下去是一次不可撤销的身份断言。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const QUEUE = path.join(HERE, '..', 'RealnamePendingQueue.tsx');
const VIEW = path.join(HERE, '..', 'AdminUsersView.tsx');
const PAGE = path.join(HERE, '..', '..', 'page.tsx');

/** 剥 TS 行/块注释成等长空格（保住结构）。抬头注释里反复写着被禁的那些串，直接 grep 全误判。 */
function stripComments(src: string): string {
  const out = src.split('');
  const blank = (from: number, to: number) => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < src.length) {
    const two = src.slice(i, i + 2);
    if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? src.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (two === '//') {
      let end = src.indexOf('\n', i);
      if (end === -1) end = src.length;
      blank(i, end);
      i = end;
    } else {
      i++;
    }
  }
  return out.join('');
}

const read = (f: string) => stripComments(fs.readFileSync(f, 'utf-8'));

describe('① 审核台是独立组件，与「钱」的 pending 状态机零交集', () => {
  const queue = read(QUEUE);
  const view = read(VIEW);

  test('组件存在，并且挂在 /woo/users 页上', () => {
    expect(fs.existsSync(QUEUE)).toBe(true);
    const page = read(PAGE);
    expect(page).toContain('RealnamePendingQueue');
    expect(page).toMatch(/<RealnamePendingQueue\s*\/>/);
  });

  test('🔴 队列组件里没有 setPending / runPending / opRequestBody / newOpRef', () => {
    for (const forbidden of ['setPending', 'runPending', 'opRequestBody', 'newOpRef', 'op_ref']) {
      expect(queue, `审核台碰了 AdminUsersView 的状态机：${forbidden}`).not.toContain(forbidden);
    }
  });

  test('🔴 AdminUsersView 那边的精确计数没被本次改动挪动（钱路径的守卫仍是原样）', () => {
    // 这两条与 structure-guard ④ / admin-op-ref 同一口径，在这里再钉一次：
    // 有人"顺手"把审核合并进去时，最先动的就是它们。
    expect(view.match(/method:\s*'POST'/g) ?? []).toHaveLength(2);
    expect(view.match(/setPending\(\{\s*kind:/g) ?? []).toHaveLength(2);
    expect(view.match(/opRef:\s*newOpRef\(/g) ?? []).toHaveLength(2);
  });

  test('对照臂：同一把尺子量「审核塞进 pending」的坏样本必须命中', () => {
    const bad = stripComments(`
      // setPending 写在注释里不算
      onClick={() => setPending({ kind: 'approve', uid })}
    `);
    expect(bad).toContain('setPending');
    expect(stripComments('// setPending({ kind: 只是提了一句')).not.toContain('setPending');
  });
});

describe('② 证件照：fetch + Bearer + objectURL，卸载即 revoke', () => {
  const queue = read(QUEUE);

  test('🔴 没有任何 <img src="/api/..."> 这种直连写法（浏览器不带 Authorization 头）', () => {
    // 违规形态：src 里直接写接口地址。命中即说明那张图注定 404。
    expect(queue).not.toMatch(/src=\{?['"`]\/api\//);
    expect(queue).not.toMatch(/src=\{`\/api\//);
  });

  test('🔴 取图手动带 Authorization: Bearer，并转成 objectURL', () => {
    expect(queue).toContain('readToken');
    expect(queue).toMatch(/Authorization:\s*`Bearer \$\{token\}`/);
    expect(queue).toContain('URL.createObjectURL');
  });

  test('🔴 有 revoke，且在 useEffect 的清理函数里（不 revoke = 每看一张证件照泄一份内存）', () => {
    expect(queue).toContain('URL.revokeObjectURL');
    // 清理函数：`return () => {` 之后到该 effect 结束之间必须出现 revoke
    const ret = queue.indexOf('return () => {');
    expect(ret, '没找到 useEffect 的清理函数').toBeGreaterThanOrEqual(0);
    expect(queue.slice(ret)).toContain('URL.revokeObjectURL');
  });

  test('对照臂：坏样本（直接 <img src="/api/...">）必须被上面那把尺子命中', () => {
    const bad = stripComments('<img src={`/api/v1/admin/realname/${id}/photo/id_page`} />');
    expect(/src=\{`\/api\//.test(bad)).toBe(true);
    // 反向：正常写法（objectURL 变量）不该被误判
    expect(/src=\{`\/api\//.test(stripComments('<img src={urls[m.kind]} />'))).toBe(false);
  });
});

describe('③ 每个审核动作都过二次确认，确认文案写明后果', () => {
  const queue = read(QUEUE);

  test('挂了 ConfirmDialog，确认按钮走 runReview，且没有绕过弹层直接发请求的 onClick', () => {
    expect(queue).toMatch(/<ConfirmDialog/);
    expect(queue).toMatch(/onConfirm=\{\(\) => void runReview\(\)\}/);
    for (const line of queue.split('\n')) {
      if (line.includes('onClick=')) expect(line, line.trim()).not.toContain('apiFetch');
    }
  });

  test('🔴 confirmLabel 不是「确定」，且通过/驳回两条各说各的后果', () => {
    expect(queue).toContain('confirmLabel=');
    expect(queue).not.toMatch(/confirmLabel="确定"/);
    expect(queue).toContain('确认驳回');
    expect(queue).toContain('确认认定为');
  });

  test('🔴 驳回原因为空时按钮禁用（服务端会 400，但不该让人先撞一次墙）', () => {
    expect(queue).toMatch(/disabled=\{busy \|\| !\(reasons\[row\.verification_id\] \?\? ''\)\.trim\(\)\}/);
  });

  test('🔴 只有一个渲染出口：队列空掉时也要出 flash（真机上真踩过这一脚）', () => {
    // 【这条判据的来由】原来这里有一条早退分支：rows 为空就整块换成一句"当前没有待审"。
    // 于是"审完最后一条"那一刻 flash 被一起吞掉——操作者刚点完确认，屏幕上没有一个字
    // 说刚才那一下成没成，只有一块突然空掉的面板。真机跑出来的就是这个（flash=(none)）。
    // 尺子：除 `if (gone) return null` 之外只许有一个顶层 return，且 flash 只渲染一处。
    const body = queue.slice(queue.indexOf('export function RealnamePendingQueue'));
    expect(body.length, '没找到组件本体').toBeGreaterThan(0);
    expect(body.match(/^  return \(/gm) ?? []).toHaveLength(1);
    expect(body.match(/^  if \(.*\) return /gm) ?? []).toHaveLength(1); // 只许 gone 那一条早退
    expect(body.match(/\{flash && /g) ?? []).toHaveLength(1);
    expect(queue).toContain('当前没有等待人工核验');
  });

  test('🔴 确认文案里没有裸的 markdown 星号（JSX 会把 **原样** 原样打出来）', () => {
    // 真机截图里那四颗星就是这么来的。强调要用 <b>，不是 **。
    const jsxText = queue.replace(/\/\*[\s\S]*?\*\//g, '');
    expect(jsxText).not.toMatch(/\*\*[^\s*]+\*\*/);
  });

  test('低调模式不适用后台：不套 Sensitive、不加 data-veil（与 users/page.tsx 同一条既有约定）', () => {
    expect(queue).not.toContain('Sensitive');
    expect(queue).not.toContain('data-veil');
  });
});
