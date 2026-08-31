// app/src/lib/company/__tests__/normalize.test.ts
// company_key 的行为判据 + **唯一入口的两条结构守卫**。
//
// 教训「修入口不修五处」：归一化规则散落多处时，补规则的人只会改手边那一处，
// 另外几处继续按旧规则算。两处算出不同的键时系统不报错，只是缓存不命中、
// 或者命中了错的那份——**独立写 N 次忘 N 次是默认形态，不是疏忽**。
// 所以这里不靠约定，靠两条会点名的机检（下半篇）。
//
// 本文件由两支合并而来（ws/dossier-pipeline × ws/dossier-billing），归一化强度按误差方向
// 取了保守的那一版（繁简与「有限责任公司≡有限公司」两条规则**不做**），命名空间前缀保留。
// 裁决与理由写在 ../normalize.ts 的文件头；下面「不该归一的绝不归一」那一组就是它的判据。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, test } from 'vitest';

import { companyKey, normalizeCompanyName } from '../normalize';

describe('该归一的归一（同一家公司的不同写法要落到同一个键）', () => {
  it('首尾与中间空白（含全角空格、不间断空格、换行）一律去掉', () => {
    const base = companyKey({ name: '北京甲科技有限公司' });
    for (const variant of [
      ' 北京甲科技有限公司 ',
      '北京甲科技有限公司　',
      '北京 甲 科技 有限公司',
      '北京甲科技\n有限公司',
    ]) {
      expect(companyKey({ name: variant }), `变体「${variant}」未归一`).toBe(base);
    }
  });

  it('全角括号/字母/数字折成半角（NFKC 一步到位，不靠手写标点表）', () => {
    expect(normalizeCompanyName('宜信普惠信息咨询（北京）有限公司')).toBe(
      normalizeCompanyName('宜信普惠信息咨询(北京) 有限公司'),
    );
    expect(normalizeCompanyName('北京（朝阳）甲科技')).toBe(normalizeCompanyName('北京(朝阳)甲科技'));
    expect(normalizeCompanyName('ＡＢＣ科技')).toBe(normalizeCompanyName('abc科技'));
    expect(normalizeCompanyName('甲１２３')).toBe(normalizeCompanyName('甲123'));
  });

  it('英文大小写归一', () => {
    expect(normalizeCompanyName('ABC Tech')).toBe(normalizeCompanyName('abc tech'));
    expect(normalizeCompanyName('ABC　科技\n有限公司')).toBe('abc科技有限公司');
  });
});

describe('不该归一的绝不归一（误合并方向比误分开严重得多）', () => {
  // 这一组是合并裁决的判据本身：任何一条转绿成 toBe，就意味着有人把归一化放宽了，
  // 而放宽的代价是「用户付了 A 家的钱、拿到 B 家的档案，且全程不报错」。
  it('「有限公司」与「有限责任公司」是两个 key——工商登记的是全称精确串', () => {
    expect(companyKey({ name: '北京甲科技有限公司' })).not.toBe(
      companyKey({ name: '北京甲科技有限责任公司' }),
    );
  });

  it('「股份有限公司」与「有限公司」是两个不同的法律主体', () => {
    expect(normalizeCompanyName('某某科技股份有限公司')).not.toBe(
      normalizeCompanyName('某某科技有限公司'),
    );
  });

  it('去掉公司后缀之后同名的两家，仍是两个 key（后缀不删）', () => {
    expect(companyKey({ name: '甲' })).not.toBe(companyKey({ name: '甲有限公司' }));
  });

  it('繁简不归一（没有可核对的对照表就不做，凑几个常用字的假表比不做更危险）', () => {
    expect(normalizeCompanyName('臺北甲')).not.toBe(normalizeCompanyName('台北甲'));
    expect(companyKey({ name: '廣州甲科技有限公司' })).not.toBe(
      companyKey({ name: '广州甲科技有限公司' }),
    );
    expect(normalizeCompanyName('某某鑫源有限公司')).not.toBe(normalizeCompanyName('某某金源有限公司'));
  });

  it('括号里的地名不删——（北京）与（上海）是两家公司', () => {
    expect(normalizeCompanyName('某某咨询（北京）有限公司')).not.toBe(
      normalizeCompanyName('某某咨询（上海）有限公司'),
    );
  });
});

describe('统一社会信用代码优先，且两个命名空间不互撞', () => {
  it('填了 uscc 就完全不看公司名（更名不换档）', () => {
    const a = companyKey({ name: '北京甲科技有限公司', uscc: '91110105MA01ABCD2X' });
    const b = companyKey({ name: '北京甲科技（更名后）有限公司', uscc: '91110105MA01ABCD2X' });
    expect(a).toBe(b);
    expect(a).toBe('uscc:91110105MA01ABCD2X');
  });

  it('uscc 归一：去空白、转大写', () => {
    expect(companyKey({ name: '甲', uscc: ' 91110105ma01abcd2x ' })).toBe('uscc:91110105MA01ABCD2X');
  });

  it('uscc 为空串/纯空白 → 回落公司名，不产生空 key', () => {
    expect(companyKey({ uscc: '  ', name: '某某科技有限公司' })).toBe(
      companyKey({ name: '某某科技有限公司' }),
    );
    expect(companyKey({ uscc: ' ', name: '某某科技有限公司' })).toBe('name:某某科技有限公司');
  });

  it('前缀让「按代码认」与「按名字认」永远分得开', () => {
    expect(companyKey({ uscc: '123456', name: 'x' })).not.toBe(companyKey({ name: '123456' }));
  });
});

describe('空名必须抛，绝不返回空键（空键=全站共用一份档案）', () => {
  it('名与码都空时抛错', () => {
    expect(() => companyKey({ name: '   ' })).toThrow(/company_key 算不出来/);
    expect(() => companyKey({})).toThrow(/至少提供公司全名/);
  });

  it('错误文案三段式：缺什么 / 为什么不行 / 怎么办', () => {
    let message = '';
    try {
      companyKey({ name: ' 　\t\n' });
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain('公司名为空'); // 缺什么
    expect(message).toMatch(/共用同一条档案/); // 为什么不行
    expect(message).toMatch(/公司全称|统一社会信用代码/); // 怎么办
  });
});

// ───────────────────── 结构守卫 ─────────────────────

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_SRC = path.resolve(HERE, '..', '..', '..'); // app/src
const REPO_SCRIPTS = path.resolve(HERE, '..', '..', '..', '..', '..', 'scripts');

/** 递归收集 .ts/.tsx，跳过 __tests__ 与 node_modules。 */
function collect(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '__tests__') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collect(p, out);
    else if (/\.tsx?$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 报告：哪些文件碰了 company_key / companyKey，哪些文件绕开 companyKey 直接调归一化函数。
 * 抽成纯函数是为了给它配对照臂——**检查函数本身失效**时，
 * 「没有违规」与「压根没检查」输出一模一样。
 */
export function keyTouchReport(
  files: { rel: string; src: string }[],
  allowlist: string[],
): { unexpected: string[]; missing: string[]; rawNormalizeUsers: string[] } {
  const touched = files
    .filter((f) => /\bcompany_key\b|\bcompanyKey\b/.test(f.src))
    .map((f) => f.rel)
    .sort();
  const rawNormalizeUsers = files
    .filter((f) => f.rel !== 'lib/company/normalize.ts' && /\bnormalizeCompanyName\b/.test(f.src))
    .map((f) => f.rel)
    .sort();
  return {
    unexpected: touched.filter((f) => !allowlist.includes(f)),
    missing: allowlist.filter((f) => !touched.includes(f)),
    rawNormalizeUsers,
  };
}

describe('结构守卫一：company_key 只有一个产地', () => {
  const files = [
    ...collect(APP_SRC).map((p) => ({ rel: path.relative(APP_SRC, p), src: fs.readFileSync(p, 'utf8') })),
    ...collect(REPO_SCRIPTS).map((p) => ({
      rel: `../../scripts/${path.relative(REPO_SCRIPTS, p)}`,
      src: fs.readFileSync(p, 'utf8'),
    })),
  ];

  // 允许碰 company_key 的几处，各有各的理由；多一处少一处都要有人解释。
  const ALLOW = [
    'lib/db/migrate.ts', // 建表 DDL
    'lib/company/normalize.ts', // 唯一产地
    'lib/company/dossier.ts', // 采集侧消费方（查/写 company_dossiers）
    'lib/company/probe.ts', // 免费前置探测：按 companyKey 读/写 company_probe_cache（§2.3）
    'lib/company/dossier-billing.ts', // 计费侧消费方（报价/确认走同一把键，见文件头 import 别名）
    // 只把已经算好的 company_key 原样透出给前端，不参与计算——出现在这里是因为它提到了列名。
    'app/api/v1/company/dossiers/[id]/route.ts',
    // 案件 → 档案适配端点。**自己不算键**：解析走 lib/company/dossier.findDossierBySubject，
    // 出现在这里同样是因为文件头的注释里写了这把键的名字（那段注释讲的正是"键不在这儿算"）。
    'app/api/v1/cases/[id]/dossier/route.ts',
    // 演示件：探测/报价 mock 里各有一个**写死的**键值，不参与任何查或写（demo 案件不落库）。
    // 出现在这里同样是因为它提到了字段名，不是因为它自己算了一把键。
    'app/_mock/company-dossier.ts',
  ];

  it('先证明扫描真的扫到了东西（否则「零违规」只是没检查）', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.rel === 'lib/company/normalize.ts')).toBe(true);
  });

  it('没有多余文件碰 company_key，也没有文件绕开 companyKey 自己归一化', () => {
    const r = keyTouchReport(files, ALLOW);
    expect(
      r.unexpected,
      '\n有新文件直接碰了 company_key。归一化规则必须只有一处：\n' +
        '两处规则不一致时系统不报错，只是缓存不命中、或者命中了别人家的档案。\n' +
        '请改成调用 lib/company/normalize 的 companyKey()，或把该文件加进本测试的 ALLOW 并说明理由。\n',
    ).toEqual([]);
    expect(
      r.missing,
      '\nALLOW 里的文件不再碰 company_key 了——多半是入口被改名或挪走了，\n' +
        '此时这条守卫已经没有检查对象，请同步更新 ALLOW。\n',
    ).toEqual([]);
    expect(
      r.rawNormalizeUsers,
      '\n有文件绕开 companyKey() 直接调 normalizeCompanyName()：\n' +
        'companyKey 还负责 uscc 优先与命名空间前缀，绕开它算出来的键与库里的不是一套。\n',
    ).toEqual([]);
  });

  // 对照臂：检查函数被架空时必须自己报出来。
  it('对照臂：塞一个自造归一化的假文件，守卫必须点名', () => {
    const fake = [
      ...files,
      { rel: 'app/some-new-route.ts', src: "const k = 'company_key'; normalizeCompanyName(x);" },
    ];
    const r = keyTouchReport(fake, ALLOW);
    expect(r.unexpected).toEqual(['app/some-new-route.ts']);
    expect(r.rawNormalizeUsers).toContain('app/some-new-route.ts');
  });

  it('对照臂：入口被挪走时 missing 必须报出来', () => {
    const without = files.filter((f) => f.rel !== 'lib/company/normalize.ts');
    expect(keyTouchReport(without, ALLOW).missing).toEqual(['lib/company/normalize.ts']);
  });
});

describe('结构守卫二：别处不许再写一遍 NFKC 归一', () => {
  // 与上一条互补：上一条按「碰没碰 company_key」抓，这一条按**归一化的手法**抓——
  // 有人可以不提 company_key 三个字，照样在别的文件里 NFKC + 折大小写地自己算一把键。
  const SRC_DIR = APP_SRC;

  function walk(dir: string, out: string[] = []): string[] {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (/\.tsx?$/.test(entry.name)) out.push(full);
    }
    return out;
  }

  test('全仓只有 normalize.ts 自己在做 NFKC 公司名归一，别处一律调 companyKey', () => {
    const offenders: string[] = [];
    for (const file of walk(SRC_DIR)) {
      if (file.endsWith(path.join('company', 'normalize.ts'))) continue;
      if (file.endsWith('normalize.test.ts')) continue;
      const src = fs.readFileSync(file, 'utf-8');
      if (/normalize\(\s*['"]NFKC['"]\s*\)/.test(src)) offenders.push(path.relative(SRC_DIR, file));
    }
    expect(offenders, `这些文件在自己做公司名归一化，应改调 companyKey：${offenders.join(', ')}`).toEqual([]);
  });

  // 对照臂：证明上面那条正则是活的（写错了它对任何文件都放行，与「零违规」同形）。
  test('对照臂：正则本身抓得住 NFKC 归一的写法', () => {
    const RE = /normalize\(\s*['"]NFKC['"]\s*\)/;
    expect(RE.test("const k = s.normalize('NFKC').toLowerCase();")).toBe(true);
    expect(RE.test('const k = s.normalize("NFKC");')).toBe(true);
    expect(RE.test('const k = s.trim().toLowerCase();')).toBe(false);
  });
});
