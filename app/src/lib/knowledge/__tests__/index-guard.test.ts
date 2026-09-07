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

import { afterEach, describe, expect, test, vi } from 'vitest';

import { DEFAULT_DOMAIN } from '@/lib/domains/registry';

import { __resetForTest, listPacks, get } from '../index';

const REAL_DIR = path.resolve(__dirname, '../../../../../knowledge');
/**
 * 真实索引里有多少条。**从 index.json 现读，不写死一个数**：
 * 写死的那个数在核实作业把 61 张卡移进隔离区的那天变成了假的
 *（`> 200` 那条从"库是全的"退化成"库还剩一大半"，而它照常绿）。
 */
const REAL_COUNT: number = (
  JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'index.json'), 'utf8')) as unknown[]
).length;
let tmp: string | null = null;

/** 抓一次 console.error：被排除的卡必须**出声**，静默排除与"这卡从来不存在"长得一样 */
function captureStderr(fn: () => void): string {
  const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    fn();
    return spy.mock.calls.map((c) => c.join(' ')).join('\n');
  } finally {
    spy.mockRestore();
  }
}

/**
 * 复制一份真实知识库到临时目录，再按 mutate 弄坏它。
 *
 * **只复制加载器真正会读的那几样**（index.json / aliases.json / packs/）：
 * 2026-09-07 起 `knowledge/sources/originals/` 里存着 16MB 官方原件，而加载器一个字节都不读它。
 * 整目录 cpSync 会让这个文件里每条用例各拷 19MB，纯属白烧 CI 时间。
 */
function brokenDir(mutate: (dir: string) => void): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lawer-kb-guard-'));
  for (const name of ['index.json', 'aliases.json', 'packs']) {
    const src = path.join(REAL_DIR, name);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(tmp, name), { recursive: true });
  }
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
    expect(packs.length).toBe(REAL_COUNT);
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

  /**
   * ⑨ domain 是注册表不认识的 → **排除那一条并 console.error 点名**，其余照常启动
   *（manager 2026-09-07 裁决，改自此前的"拒绝启动"）。
   *
   * 【为什么改】拒绝启动是放大故障：loadIndex 抛错且不缓存 ⇒ 之后每一次预检索、
   * knowledge_search、危机资源卡取卡都重抛一次 ⇒ **全站每一轮对话 500**，
   * 连 domain 正常的那批用户一起断。而这一条的正确后果是"少这一张卡"。
   * 构建期仍然严格：scripts/gen-knowledge-index.py 见到非法 domain 一律拒绝生成（CI 即红）。
   *
   * 【为什么"排除"必须连着"点名"一起测】只测"没抛错"的话，把整段闸删掉也全绿——
   * 而那条卡就此静默进了检索面。只测"少了一张"的话，静默排除同样全绿——
   * 那是另一种坏：日志里"这卡被排除了"与"这卡从来不存在"长得一模一样。
   */
  test('⑨ domain 是注册表不认识的 → 排除该条并点名，其余卡照常可用', () => {
    let victim = '';
    brokenDir((d) => {
      const p2 = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p2, 'utf8')) as { id: string; domain?: string }[];
      victim = idx[0].id;
      idx[0].domain = '还没挂上包的领域';
      fs.writeFileSync(p2, JSON.stringify(idx));
    });
    let packs: ReturnType<typeof listPacks> = [];
    const err = captureStderr(() => {
      packs = listPacks();
    });
    // 不拒绝启动：其余卡一张不少
    expect(packs.length).toBe(REAL_COUNT - 1);
    expect(packs.some((p) => p.id === victim)).toBe(false);
    // 但必须出声，且点名到卡与那个 domain，并说**怎么办**
    expect(err).toContain(victim);
    expect(err).toContain('还没挂上包的领域');
    expect(err).toMatch(/领域包/);
  });

  test('⑨ 没写 domain 的存量条目照常放行（补成缺省领域，不是拒绝）', () => {
    // 【为什么这条是上一条的必要配套】只测"拒绝"的话，把闸改成"一律拒绝"也全绿，
    // 而那会让整个存量知识库（一张卡都没写 domain）当场启动不了。
    brokenDir((d) => {
      const p2 = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p2, 'utf8')) as Record<string, unknown>[];
      for (const e of idx) delete e.domain;
      fs.writeFileSync(p2, JSON.stringify(idx));
    });
    const packs = listPacks();
    expect(packs.length).toBe(REAL_COUNT);
    expect(new Set(packs.map((p) => p.domain))).toEqual(new Set([DEFAULT_DOMAIN]));
  });
});

/**
 * ⑩ 隔离区（knowledge/quarantine/**）的卡进了 index.json → 拒绝启动。
 *
 * 【它是什么】主理人 2026-09-07 裁决：知识库里不允许「二手转述」「待核实」，
 * 追不到一手源的卡整张移进 knowledge/quarantine/<原子目录>/（带原因与试过的信源）。
 * 生成器 scripts/gen-knowledge-index.py 不收隔离区（那边另有 python 判据）。
 *
 * 【为什么加载器也要拦】与 ⑨ 同型：生成器管的是"从卡片到 index.json"，
 * 管不着**别人手里那份 index.json**——部署时换掉的、别的分支带来的、手改过的。
 * 失效形态是静默的：那张我们自己判定"来源不可信"的卡照常被检索、照常被引用，
 * 而它与一张核实过的卡在 agent 那里长得一模一样。
 */
describe('🔴 隔离区不得进入检索面（主理人 2026-09-07 裁决；排除口径 manager 2026-09-07）', () => {
  test('索引里出现 quarantine 路径 → 排除该条并点名，其余卡照常可用', () => {
    let victim = '';
    brokenDir((d) => {
      const p = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p, 'utf8')) as { id: string; path: string }[];
      victim = idx[0].id;
      idx[0].path = 'quarantine/statutes/追不到一手源.md';
      fs.writeFileSync(p, JSON.stringify(idx));
    });
    let packs: ReturnType<typeof listPacks> = [];
    const err = captureStderr(() => {
      packs = listPacks();
    });
    expect(packs.length).toBe(REAL_COUNT - 1);
    expect(packs.some((p) => p.id === victim)).toBe(false);
    expect(err).toContain(victim);
    expect(err).toContain('隔离区');
    // 点名要说**怎么办**，不是只说"不行"
    expect(err).toMatch(/gen-knowledge-index\.py/);
  });

  test('packs/ 里层出现 quarantine 目录同样排除（隔离区不止一种摆法）', () => {
    brokenDir((d) => {
      const p = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p, 'utf8')) as { path: string }[];
      idx[0].path = 'packs/statutes/quarantine/x.md';
      fs.writeFileSync(p, JSON.stringify(idx));
    });
    let packs: ReturnType<typeof listPacks> = [];
    const err = captureStderr(() => {
      packs = listPacks();
    });
    expect(packs.length).toBe(REAL_COUNT - 1);
    expect(err).toContain('隔离区');
  });

  test('全是隔离卡 → 排除到一张不剩时改为拒绝启动（少几张卡可以，一张不剩不行）', () => {
    // 【为什么这条是"排除不拒绝"的必要配套】排除是为了"少几张卡好过全站 500"；
    // 一张不剩时这个权衡反过来——那正是 ⑤ 要防的形态（没有知识却照常作答）。
    // 若 ⑤ 数的是排除**之前**那个数，一份全是隔离卡的索引会带着 0 张可用卡静默启动。
    delete process.env.KNOWLEDGE_ALLOW_EMPTY;
    brokenDir((d) => {
      const p = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p, 'utf8')) as { path: string }[];
      for (const e of idx) e.path = `quarantine/cases/${Math.random()}.md`;
      fs.writeFileSync(p, JSON.stringify(idx));
    });
    expect(() => captureStderr(() => listPacks())).toThrow(/索引是空的/);
    expect(() => captureStderr(() => listPacks())).toThrow(/全部被上面的排除规则挡下/);
  });

  test('路径里只是**含**这几个字母的正常卡照常放行（不是拿子串瞎匹）', () => {
    // 【为什么这条是上一条的必要配套】把闸写成 path.includes('quarantine') 也能让上面全绿，
    // 而那会误伤 packs/statutes/quarantine-notice.md 这种正常卡名。闸认的是**目录段**。
    brokenDir((d) => {
      const p = path.join(d, 'index.json');
      const idx = JSON.parse(fs.readFileSync(p, 'utf8')) as { path: string }[];
      const src = path.join(d, idx[0].path);
      const dest = 'packs/statutes/quarantine-notice.md';
      fs.renameSync(src, path.join(d, dest));
      idx[0].path = dest;
      fs.writeFileSync(p, JSON.stringify(idx));
    });
    expect(listPacks().length).toBe(REAL_COUNT);
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

/**
 * 隔离区里的卡不许挂「可进索引」的 confidence（经理 2026-09-07 裁定）。
 *
 * 【它防的是什么】隔离区的卡本来就不进索引，所以这里管的**不是**它们会不会被检索到
 *（那由上面 ⑩ 那组管），而是**标签会不会撒谎**：一张 `confidence: 原文核实` 的卡在
 * `knowledge/quarantine/` 里躺着，而它进隔离区的**全部理由**就是核不动。
 * 搬回 `packs/` 只是一次 `mv`，搬的人看到"原文核实"会以为这一步已经有人做过了。
 * 2026-09-07 本仓实见 52 张这样的卡。
 *
 * 【为什么判据摆在这里，而不是只留在 python 侧】`gen-knowledge-index.py` 的守卫 (h)
 * 管的是"生成索引的那一次"；这条断言管的是**仓库里现在躺着的这一批文件**。
 * 两者会分叉的真实路径：有人只 `mv` 不重跑生成器（隔离区的卡本来就不进索引，
 * 生成器的输出一个字都不会变，于是"没重跑"这件事在 index.json 上看不出来）。
 */
describe('🔴 隔离区的卡不许挂「可进索引」的 confidence（标签不能撒谎）', () => {
  const QUARANTINE_DIR = path.join(REAL_DIR, 'quarantine');
  /** 递归收集 quarantine 下的卡；不用 glob 依赖 */
  function quarantineCards(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) return quarantineCards(full);
      return e.isFile() && e.name.endsWith('.md') && e.name !== 'README.md' ? [full] : [];
    });
  }
  const cards = quarantineCards(QUARANTINE_DIR);
  const confidenceOf = (file: string): string | null => {
    const raw = fs.readFileSync(file, 'utf8');
    const fm = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
    return fm ? (/^confidence:\s*(\S+)\s*$/m.exec(fm[1])?.[1] ?? null) : null;
  };

  test('夹具有效：隔离区里确实有卡，且每张都读得出 confidence（否则下面那条是空跑）', () => {
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.filter((f) => confidenceOf(f) === null)).toEqual([]);
  });

  test('没有一张隔离卡挂着「原文核实」或「无外部断言」', () => {
    const INDEXABLE = ['原文核实', '无外部断言'];
    const bad = cards
      .filter((f) => INDEXABLE.includes(confidenceOf(f)!))
      .map((f) => `${path.relative(REAL_DIR, f)} → ${confidenceOf(f)}`);
    expect(
      bad,
      `隔离区的卡挂着"可进索引"的标签，而它在那儿的理由就是核不动：\n${bad.join('\n')}`,
    ).toEqual([]);
  });
});

/**
 * 索引里的 sources 必须**全部是官方 host**（主理人 2026-09-07 裁决：知识库里不允许
 * 「二手转述」「待核实」，每条信息都要追到一手信源）。
 *
 * 【为什么这条判据摆在这里而不是只留在 python 侧】`scripts/gen-knowledge-index.py` 的
 * 扎根守卫 (b) 管的是"生成这份 index.json 的那一次"；这条断言管的是**仓库里现在躺着的
 * 那份 index.json**。两者会分叉的真实路径：有人手改索引、有人从别的分支带一份过来、
 * 有人拿 `--no-strict` 生成后提交。那种索引在 CI 里跑 python 之前不会有任何一处报错。
 *
 * 【口径】判的是 host，不是"看着像不像官网"：
 * · `.gov.cn`（含 `gov.cn` 本身）恒可；
 * · 非 .gov.cn 只有两个口子——`knowledge/sources.json` 里 `kind=行业规范`（行业组织发的规范文件）
 *   与 `kind=机构官网`（机构讲自己的事：热线/地址/收费）的机构官网，
 *   且必须是**先真的抓过一份原件**才会出现在登记簿里（白名单不能在代码里随手加一行字符串）；
 * · `机构官网` 那批还**只能被数据卡引**（规范 §7.1.1）：进白名单答的是"这是不是一手源"，
 *   引用范围答的是"这份一手源能拿来断言什么"，两个问题分开问；
 * · 不是 http(s) URL 的 source 只允许出现在 `confidence: 无外部断言` 的 D 类卡上
 *   （见 knowledge/README.md §2.2）——那类卡压根没有可核的外部原件，它的 sources 是一段
 *   说明自己为什么没有出处的话。任何一张有外部断言的卡拿散文当出处，都在这里红。
 */
describe('🔴 索引里的 sources 全是官方 host（wikisource / sohu / 公众号一律不是信源）', () => {
  interface Row {
    id: string;
    path: string;
    type: string;
    confidence: string;
    sources: string[];
  }
  const NO_EXTERNAL_CLAIM = '无外部断言';
  const INSTITUTION_ONLY_CARD_TYPE = '数据卡';
  const rows: Row[] = JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'index.json'), 'utf8'));
  const registry: Array<{ kind?: string; official_host?: string }> = JSON.parse(
    fs.readFileSync(path.join(REAL_DIR, 'sources.json'), 'utf8'),
  );
  const hostsOfKind = (kind: string) =>
    new Set(
      registry.filter((e) => e.kind === kind && e.official_host).map((e) => e.official_host!.toLowerCase()),
    );
  const institutionHosts = hostsOfKind('机构官网');
  const extraHosts = new Set([...hostsOfKind('行业规范'), ...institutionHosts]);
  const hostOf = (s: string): string | null => {
    try {
      const u = new URL(s);
      return u.protocol === 'http:' || u.protocol === 'https:' ? u.hostname.toLowerCase() : null;
    } catch {
      return null;
    }
  };

  test('夹具有效：索引非空，且确实有卡带着 http(s) 出处（否则下面那条是空跑）', () => {
    expect(rows.length).toBe(REAL_COUNT);
    expect(rows.some((r) => r.sources.some((s) => hostOf(s) !== null))).toBe(true);
  });

  test('每一条 http(s) 出处的 host 都是 .gov.cn 或登记在册的行业规范发布机构官网', () => {
    const bad = rows.flatMap((r) =>
      r.sources
        .map((s) => ({ row: r, src: s, host: hostOf(s) }))
        .filter((x) => x.host !== null)
        .filter((x) => !(x.host === 'gov.cn' || x.host!.endsWith('.gov.cn') || extraHosts.has(x.host!)))
        .map((x) => `${x.row.id}（${x.row.path}）→ ${x.src}`),
    );
    expect(bad, `这些出处的 host 不是官方源：\n${bad.join('\n')}`).toEqual([]);
  });

  test(`非 URL 的 sources 只许出现在 confidence:${NO_EXTERNAL_CLAIM} 的 D 类卡上`, () => {
    const bad = rows
      .filter((r) => r.confidence !== NO_EXTERNAL_CLAIM)
      .flatMap((r) =>
        r.sources.filter((s) => hostOf(s) === null).map((s) => `[${r.confidence}] ${r.id} → ${s.slice(0, 60)}`),
      );
    expect(bad, `散文出处只有 D 类卡可以有，这几张不是 D 类：\n${bad.join('\n')}`).toEqual([]);
  });

  test('夹具有效：登记簿里确实有 kind=机构官网 的 host（否则下面那条是空跑）', () => {
    expect(institutionHosts.size).toBeGreaterThan(0);
  });

  test(`kind=机构官网 的 host 只出现在${INSTITUTION_ONLY_CARD_TYPE}上`, () => {
    // 【为什么这条要单独有】它与上一条各答一个问题：上一条问"这是不是一手源"，
    // 这一条问"这份一手源能拿来断言什么"。合成一条的形态是：某个 host 为了一条热线号码
    // 进了白名单，从此一张法条卡可以拿某医院的科普文当法律依据，而 host 闸一声不吭地放行。
    const bad = rows
      .filter((r) => r.type !== INSTITUTION_ONLY_CARD_TYPE)
      .flatMap((r) =>
        r.sources
          .map((s) => ({ src: s, host: hostOf(s) }))
          .filter((x) => x.host !== null && institutionHosts.has(x.host))
          .map((x) => `[${r.type}] ${r.id}（${r.path}）→ ${x.src}`),
      );
    expect(bad, `机构官网只能给数据卡的 facts（热线/地址/收费）做出处：\n${bad.join('\n')}`).toEqual([]);
  });

  test(`反向：${NO_EXTERNAL_CLAIM} 的卡不许带 http(s) 出处（有出处就该走原文核实并过 host 闸）`, () => {
    const bad = rows
      .filter((r) => r.confidence === NO_EXTERNAL_CLAIM)
      .flatMap((r) => r.sources.filter((s) => hostOf(s) !== null).map((s) => `${r.id} → ${s}`));
    expect(bad, `这几张自称没有外部断言，却带着 http(s) 出处：\n${bad.join('\n')}`).toEqual([]);
  });
});
