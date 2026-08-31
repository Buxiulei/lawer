// app/src/lib/company/__tests__/normalize.test.ts
// company_key 的行为判据 + **唯一入口的结构守卫**。
//
// 教训「修入口不修五处」：归一化规则散落多处时，补规则的人只会改手边那一处，
// 另外几处继续按旧规则算。两处算出不同的键时系统不报错，只是缓存不命中、
// 或者命中了错的那份——**独立写 N 次忘 N 次是默认形态，不是疏忽**。
// 所以这里不靠约定，靠一条会点名的机检。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

import { companyKey, normalizeCompanyName } from '../normalize';

describe('归一化行为', () => {
  it('全角括号/空白/大小写拉齐后同键', () => {
    expect(normalizeCompanyName('宜信普惠信息咨询（北京）有限公司')).toBe(
      normalizeCompanyName('宜信普惠信息咨询(北京) 有限公司'),
    );
    expect(normalizeCompanyName('ABC　科技\n有限公司')).toBe('abc科技有限公司');
  });

  it('有限责任公司 ≡ 有限公司；股份有限公司**不**并进去', () => {
    expect(normalizeCompanyName('某某科技有限责任公司')).toBe(normalizeCompanyName('某某科技有限公司'));
    expect(normalizeCompanyName('某某科技股份有限公司')).not.toBe(
      normalizeCompanyName('某某科技有限公司'),
    );
  });

  it('括号里的地名不删——（北京）与（上海）是两家公司', () => {
    expect(normalizeCompanyName('某某咨询（北京）有限公司')).not.toBe(
      normalizeCompanyName('某某咨询（上海）有限公司'),
    );
  });

  it('企业名常见繁体字归到简体', () => {
    expect(normalizeCompanyName('某某國際貿易有限責任公司')).toBe(
      normalizeCompanyName('某某国际贸易有限公司'),
    );
  });

  it('表里没有的繁体字原样保留 ⇒ 至多不命中缓存，绝不错误合并', () => {
    // 失效方向是安全的那一侧：认不出来就当成另一家，而不是当成同一家
    expect(normalizeCompanyName('某某鑫源有限公司')).not.toBe(normalizeCompanyName('某某金源有限公司'));
  });

  it('uscc 优先于名称，且两个命名空间不互撞', () => {
    expect(companyKey({ uscc: '91110108MA01ABCD2X', name: '随便什么名字' })).toBe(
      'uscc:91110108MA01ABCD2X',
    );
    expect(companyKey({ uscc: ' ', name: '某某科技有限公司' })).toBe('name:某某科技有限公司');
    expect(companyKey({ uscc: '123456', name: 'x' })).not.toBe(companyKey({ name: '123456' }));
  });

  it('名与码都空时抛错，绝不返回空键（空键=全站共用一份档案）', () => {
    expect(() => companyKey({ name: '   ' })).toThrow(/company_key 算不出来/);
    expect(() => companyKey({})).toThrow(/至少提供公司全名/);
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

describe('结构守卫：company_key 只有一个产地', () => {
  const files = [
    ...collect(APP_SRC).map((p) => ({ rel: path.relative(APP_SRC, p), src: fs.readFileSync(p, 'utf8') })),
    ...collect(REPO_SCRIPTS).map((p) => ({
      rel: `../../scripts/${path.relative(REPO_SCRIPTS, p)}`,
      src: fs.readFileSync(p, 'utf8'),
    })),
  ];

  // 允许碰 company_key 的三处，各有各的理由；多一处少一处都要有人解释。
  const ALLOW = [
    'lib/db/migrate.ts', // 建表 DDL
    'lib/company/normalize.ts', // 唯一产地
    'lib/company/dossier.ts', // 唯一消费方（查/写 company_dossiers）
  ];

  it('先证明扫描真的扫到了东西（否则「零违规」只是没检查）', () => {
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.rel === 'lib/company/normalize.ts')).toBe(true);
  });

  it('没有第四个文件碰 company_key，也没有文件绕开 companyKey 自己归一化', () => {
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
