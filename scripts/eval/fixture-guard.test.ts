/**
 * 夹具守卫：**判据依赖的对照物必须受版控**（manager 2026-08-28 提，我今天撞了两次）。
 *
 * 【两次撞法】
 *  ① `corpus-list.sh` 把 `scripts/eval/results/` 当语料根 —— 那目录**随检出而变**，
 *     于是同一条命令在 eval 克隆里数出 11 次碰撞、在 backend 克隆里数出 38 次。
 *  ② 债#1 的三条正对照第一版读的就是 `results/` —— 而那三份转录**只存在于那里**
 *     （归档里一份都没有），且该目录被 gitignore。
 *
 * 🔑 **换个检出，哨会因"文件不在"而失效——而「哨失效」与「哨没响」长得一模一样。**
 * 所以这条守卫不看内容，只看一件事：**测试读的对照物，路径在不在仓内。**
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';

const REPO = '/home/roots/caiyuan-ws/eval';
const TEST_DIR = `${REPO}/scripts/eval`;
/** 受版控的对照物只该放这里；`results/` 被 gitignore 且随检出而变 */
const FIXTURE_DIR = `${REPO}/docs/eval-evidence/fixtures`;

describe('夹具守卫：对照物必须受版控', () => {
  const files = readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.ts'));

  it('🔒 地板：确实扫到了测试文件', () => {
    expect(files.length).toBeGreaterThanOrEqual(3);
  });

  it('测试文件里不许出现指向 `scripts/eval/results/` 的读取路径', () => {
    const bad: string[] = [];
    // 【自排除，且这是同一形状的第二次】守卫**必然要写出它所守的那个形状**：
    // 2026-08-27 是写在注释里（剥注释解决），**这次写在 `it()` 的标题字符串里——剥注释解决不了**。
    // 自排除是唯一诚实的解法（把路径拆成片段拼起来只是把问题藏进混淆）；
    // 代价是**这条守卫守不了它自己**，所以上面那条"地板"断言必须在。
    for (const f of files.filter((x) => x !== 'fixture-guard.test.ts')) {
      const src = readFileSync(`${TEST_DIR}/${f}`, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');   // 剥注释：注释里提到路径不算违规
      if (/scripts\/eval\/results\//.test(src)) bad.push(f);
    }
    expect(
      bad,
      `这些测试读 gitignore 的 results/ —— 换个检出它们会静默失效：${bad.join('、')}`,
    ).toEqual([]);
  });

  it('仓内夹具目录存在且非空（**它自己就是那条"文件不在"的哨**）', () => {
    expect(existsSync(FIXTURE_DIR), '夹具目录不在').toBe(true);
    const fx = readdirSync(FIXTURE_DIR).filter((f) => f.endsWith('.json'));
    expect(fx.length).toBeGreaterThanOrEqual(4);
    for (const f of fx) expect(statSync(`${FIXTURE_DIR}/${f}`).size).toBeGreaterThan(100);
  });
});
