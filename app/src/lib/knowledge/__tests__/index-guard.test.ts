// app/src/lib/knowledge/__tests__/index-guard.test.ts
// 知识库启动自检那道闸的**负对照**（manager 2026-08-29 派，哨兵问出来的）。
//
// 【为什么这条测试必须存在】那道闸 08-25 就立了，但**从没被负测过**——
// 而「从不拒绝的闸」与「不存在的闸」输出一模一样：都是启动成功、都没有红。
// 只有喂它一个真的坏 index、看它真的拒绝，这道闸才从"写过"变成"验过"。
//
// 【全程临时目录】绝不碰 dev 的 knowledge/：负测的代价不该是把开发环境弄坏。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, test } from 'vitest';

import { __resetForTest, listPacks, get } from '../index';

const REAL_DIR = path.resolve(__dirname, '../../../../../knowledge');
let tmp: string | null = null;

/** 复制一份真实知识库到临时目录，再按 mutate 弄坏它 */
function brokenDir(mutate: (dir: string) => void): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-kb-guard-'));
  fs.cpSync(REAL_DIR, tmp, { recursive: true });
  mutate(tmp);
  process.env.LAWER_KNOWLEDGE_DIR = tmp;
  __resetForTest();
  return tmp;
}

afterEach(() => {
  delete process.env.LAWER_KNOWLEDGE_DIR;
  __resetForTest();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
  tmp = null;
});

describe('正向对照：好的知识库必须能正常加载', () => {
  test('原样复制一份不做破坏 → 加载成功且卡数与真实库一致', () => {
    // 【为什么先要这一条】没有它，下面每条「抛错」都可能是**任何原因**抛的，
    // 包括"临时目录压根没建对"。正向对照证明这套夹具本身是活的。
    brokenDir(() => {});
    const packs = listPacks();
    expect(packs.length).toBeGreaterThan(200);
    expect(packs.every((p) => p.id && p.path)).toBe(true);
  });
});

describe('🔴 负对照：坏 index 必须拒绝启动，且报错指名文件', () => {
  test('index.json 不存在 → 抛出**这道闸自己的**错，不是 Node 的 ENOENT', () => {
    // 【第一版写错过，记在这】原来断言的是"错误里含 index.json 的路径"——
    // 而**没有这道闸时 readFileSync 自己会抛 ENOENT，错误里同样含路径**，
    // 于是拆掉闸测试照样全绿：这条断言分不出「闸在」和「闸不在」。
    // 变异实测：M1 拆掉该闸 → 9 条仍全绿。
    // 改成钉住闸自己那句独有的话（它给的是**怎么办**，ENOENT 只给"没有这个文件"）。
    brokenDir((d) => fs.rmSync(path.join(d, 'index.json')));
    expect(() => listPacks()).toThrow(/knowledge 索引不存在/);
    expect(() => listPacks()).toThrow(/LAWER_KNOWLEDGE_DIR/);
  });

  test('index.json 顶层不是数组 → 抛错并指出该文件路径', () => {
    const dir = brokenDir((d) => fs.writeFileSync(path.join(d, 'index.json'), JSON.stringify({ oops: true })));
    expect(() => listPacks()).toThrow(/顶层应为数组/);
    expect(() => listPacks()).toThrow(new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  test('index.json 不是合法 JSON → 抛错（不能把半截文件当成空库放行）', () => {
    brokenDir((d) => fs.writeFileSync(path.join(d, 'index.json'), '[{"id":"x",'));
    expect(() => listPacks()).toThrow();
  });

  test('条目缺 id 或 path → 抛错并把那条原样印出来', () => {
    brokenDir((d) => {
      const p = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>[];
      idx.push({ title: '缺了 id 和 path 的条目' });
      fs.writeFileSync(p, JSON.stringify(idx));
    });
    expect(() => listPacks()).toThrow(/缺少 id 或 path/);
    expect(() => listPacks()).toThrow(/缺了 id 和 path 的条目/);
  });

  test('🔑 index 指向的卡文件不存在 → 抛错并同时指名 id 与路径', () => {
    // 【这条是 index 与 packs/ 不一致的典型形态】索引说有这张卡、盘上没有。
    // 报错必须同时给 id 与绝对路径——只说"文件不存在"的话，
    // 修的人得自己回去翻 index 才知道是哪一条。
    let victim = '';
    brokenDir((d) => {
      const p = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p, 'utf8')) as { id: string; path: string }[];
      victim = idx[0].id;
      fs.rmSync(path.join(d, idx[0].path));
    });
    expect(() => get(victim)).toThrow(new RegExp(victim));
    expect(() => get(victim)).toThrow(/index\.json 与 packs\/ 不一致/);
  });

  test('卡文件缺 frontmatter → 抛错并指名是哪张卡', () => {
    let victim = '';
    brokenDir((d) => {
      const p = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p, 'utf8')) as { id: string; path: string }[];
      victim = idx[0].id;
      fs.writeFileSync(path.join(d, idx[0].path), '没有 frontmatter 的正文');
    });
    expect(() => get(victim)).toThrow(new RegExp(victim));
    expect(() => get(victim)).toThrow(/缺少 frontmatter/);
  });
});

describe('自证：夹具真的坏了，不是测试在空转', () => {
  test('破坏动作确实改变了磁盘上的内容', () => {
    const dir = brokenDir((d) => fs.rmSync(path.join(d, 'index.json')));
    // 【为什么要这一条】若 brokenDir 因为路径写错而什么都没改，
    // 上面那些「抛错」仍可能因为别的原因通过——**那时测的就不是这道闸了**。
    expect(fs.existsSync(path.join(dir, 'index.json'))).toBe(false);
    expect(fs.existsSync(path.join(dir, 'packs'))).toBe(true);
  });

  test('绝不碰真实知识库', () => {
    brokenDir((d) => fs.rmSync(path.join(d, 'index.json')));
    expect(fs.existsSync(path.join(REAL_DIR, 'index.json'))).toBe(true);
    expect(tmp).not.toBe(REAL_DIR);
  });
});
