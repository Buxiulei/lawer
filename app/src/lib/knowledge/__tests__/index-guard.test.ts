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

import { DEFAULT_DOMAIN, DOMAINS } from '@/lib/domains/registry';

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

describe('🔴 manager 2026-08-29 裁定新加的四道（此前全部放行）', () => {
  test('⑤ 零张卡 → 默认拒绝启动', () => {
    // 【为什么这是产品决策不是实现细节】manager 裁：一个没有任何知识、
    // 却照常回答法律问题的 agent，是本产品最不可接受的静默故障形态——**比宕机糟**：
    // 宕机用户知道坏了。一次把 packs/ 弄丢的部署，此前会静默上线这样一个 agent。
    delete process.env.KNOWLEDGE_ALLOW_EMPTY;
    brokenDir((d) => fs.writeFileSync(path.join(d, 'index.json'), '[]'));
    expect(() => listPacks()).toThrow(/索引是空的/);
    expect(() => listPacks()).toThrow(/KNOWLEDGE_ALLOW_EMPTY/);
  });

  test('⑤ 豁免开着时放行 —— 本地空跑是正当需求，但要明说', () => {
    process.env.KNOWLEDGE_ALLOW_EMPTY = '1';
    brokenDir((d) => fs.writeFileSync(path.join(d, 'index.json'), '[]'));
    expect(listPacks()).toEqual([]);
    delete process.env.KNOWLEDGE_ALLOW_EMPTY;
  });

  test('⑤ 豁免只认字面 1，别的真值不算 —— 免得 "0"/"false" 被当成开', () => {
    process.env.KNOWLEDGE_ALLOW_EMPTY = 'false';
    brokenDir((d) => fs.writeFileSync(path.join(d, 'index.json'), '[]'));
    expect(() => listPacks()).toThrow(/索引是空的/);
    delete process.env.KNOWLEDGE_ALLOW_EMPTY;
  });

  test('⑥ 重复 id → 拒绝，并指名是哪个 id', () => {
    // id 是索引／卡内 frontmatter／检索三处共用的主键；重复时 get(id) 返回先到的那张，
    // **不报错、只是从此拿错卡**。
    let dup = '';
    brokenDir((d) => {
      const p2 = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p2, 'utf8')) as { id: string }[];
      dup = idx[0].id;
      idx.push({ ...idx[0] });
      fs.writeFileSync(p2, JSON.stringify(idx));
    });
    expect(() => listPacks()).toThrow(/id 重复/);
    expect(() => listPacks()).toThrow(new RegExp(dup));
  });

  test('⑦ 卡内 id 与索引不一致 → 拒绝，两个 id 都印出来', () => {
    // 【为什么启动闸要管这条】此前只有 CI 里的全量测试查它——
    // 而测试跑在 CI，数据在部署环节被换掉的话那条测试管不着。
    let victim = '';
    brokenDir((d) => {
      const p2 = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p2, 'utf8')) as { id: string; path: string }[];
      victim = idx[0].id;
      const f = path.join(d, idx[0].path);
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(/^id: .*/m, 'id: 完全不同的-id'));
    });
    expect(() => get(victim)).toThrow(/卡内 id 与索引不一致/);
    expect(() => get(victim)).toThrow(/完全不同的-id/);
  });

  test('⑧ path 越界 → 因**越界**被拒，而不是碰巧撞上别的墙', () => {
    // 【为什么理由必须对】改之前它也"被拒"了，但理由是「缺少 frontmatter」——
    // 那个库外文件**真的被读进来了**，只是内容不像卡。哪天它恰好有 frontmatter 形状的头，
    // 同一段代码就放行，**而在此之前日志里一直显示"拒绝了"**。
    // 一个从未因自己的理由生效过的闸，和一个不存在的闸，在日志里长得一样。（哨兵语）
    let victim = '';
    brokenDir((d) => {
      const p2 = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p2, 'utf8')) as { id: string; path: string }[];
      victim = idx[0].id;
      idx[0].path = '../../../etc/hostname';
      fs.writeFileSync(p2, JSON.stringify(idx));
    });
    expect(() => get(victim)).toThrow(/指向知识库目录之外/);
    expect(() => get(victim)).not.toThrow(/缺少 frontmatter/);
  });
});

describe('⑦ domain 补齐（复审 P4-W2 二轮 minor④：此前这一步一条判据都没有）', () => {
  test('条目没写 domain → 加载后那条 meta.domain 恒有值（变异：拿掉 loadIndex 的 domain 补齐 → 红）', () => {
    // 【为什么读的是原始字段，不是 packDomain(meta)】packDomain 自带 `?? 缺省域`，
    // 拿它来判等于判了个恒真：补齐这一步整段删掉也照样绿。
    // 加载器补齐的价值恰恰在于"下游即使没写 ?? 也拿得到值"，那就得按下游那样读。
    let victim = '';
    brokenDir((d) => {
      const p = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p, 'utf8')) as { id: string; domain?: string }[];
      const target = idx.find((e) => e.domain !== undefined);
      if (!target) throw new Error('真实索引里没有任何条目写了 domain ⇒ 本条判据无从构造');
      victim = target.id;
      delete target.domain;
      fs.writeFileSync(p, JSON.stringify(idx));
    });
    const meta = listPacks().find((m) => m.id === victim);
    expect(meta, `${victim} 没被加载进来 ⇒ 夹具没改对`).toBeTruthy();
    expect(meta!.domain).toBe(DEFAULT_DOMAIN);
  });
});

describe('🔴 索引里的域 × 加载器的严格度（复审 P4-W2 二轮 major②：合并顺序闸）', () => {
  // 【这条守的不是本支的行为，是"两支合到一起"的那一刻】
  // 另一支（ws/p4-w1）的加载器对**注册表里没有的 domain** 直接抛错；本支的索引里带着
  // 尚未挂进 lib/domains 的域。两者单独看都对，合到一起而挂包的那一票还没到，形态是：
  // 任何一次 knowledge_search / knowledge_get / 条文注入 → 加载器抛错 ⇒
  // **全部用户的知识能力整体不可用**，而两支各自的判据都是绿的。
  // 本条不替谁裁"该不该拒未注册域"——它只保证这件事发生时**当场变红**，而不是上线后才知道。
  const PROBE_DOMAIN = '__probe-未注册的域__';

  /** 往索引里塞一条带未注册域的条目，返回被塞的那条 id */
  function plantUnregisteredDomain(): string {
    let victim = '';
    brokenDir((d) => {
      const p = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p, 'utf8')) as { id: string; domain?: string }[];
      idx[0].domain = PROBE_DOMAIN;
      victim = idx[0].id;
      fs.writeFileSync(p, JSON.stringify(idx));
    });
    return victim;
  }

  /** 探针：问加载器本身"你拒不拒注册表里没有的 domain"，而不是去读它的源码或版本号 */
  function loaderRejectsUnregisteredDomain(): boolean {
    plantUnregisteredDomain();
    try {
      listPacks();
      return false;
    } catch {
      return true;
    }
  }

  test('探针自身不空跑：那条被改过域的条目确实到达了加载器', () => {
    // 【这条证明的是探针的路径是活的】若夹具没写对、或加载器把 domain 覆盖掉，
    // 探针就会恒返回"不严格"，下面那条主判据从此永远绿——一个从不生效的闸。
    const victim = plantUnregisteredDomain();
    let threw = false;
    let loaded: string | undefined;
    try {
      loaded = listPacks().find((m) => m.id === victim)?.domain;
    } catch {
      threw = true; // 严格加载器拒了它 —— 同样说明那条改动到达了加载器
    }
    expect(
      threw || loaded === PROBE_DOMAIN,
      '塞进去的未注册域既没被拒、也没被原样读到 ⇒ 探针在空跑',
    ).toBe(true);
  });

  test('库里有未注册的域时，加载器不得是"未注册即抛"的那一版', () => {
    const declared = [
      ...new Set(
        (JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'index.json'), 'utf8')) as { domain?: string }[])
          .map((e) => e.domain)
          .filter((d): d is string => typeof d === 'string' && d.length > 0),
      ),
    ];
    const registered = Object.keys(DOMAINS);
    const unregistered = declared.filter((d) => !registered.includes(d));
    // 短路：域都挂上了 ⇒ 加载器严不严都安全，不必再建一份夹具去问
    const dangerous = unregistered.length > 0 && loaderRejectsUnregisteredDomain();
    expect(
      dangerous,
      `knowledge/index.json 里有这些域：${unregistered.join('、')}，` +
        `而 lib/domains/registry 的 DOMAINS 只注册了：${registered.join('、')}；` +
        '同时加载器已变成「未注册域即抛」。这两件事同时成立 = 任何一次知识检索都会对**全部**用户抛错。' +
        '出路只有两条（本判据不替谁选，选哪条由经手人裁）：把这些域的包挂进 DOMAINS，' +
        '或把这些卡从 index.json 撤下——在其中之一落地之前，这份索引与这个加载器就不能同时在库里。' +
        '第三条路（把加载器调宽）不算出路：那会让 domain 拼错的卡从此静默按缺省域算。',
    ).toBe(false);
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
