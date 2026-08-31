/**
 * 快捷键唯一入口的判据。
 *
 * 两类断言，缺一不可：
 *  - **纯函数**（认键、认输入框、下发次序）：这些是「谁先吃这一下」的全部规则，
 *    在没有 DOM 的环境里也能一条条钉住。
 *  - **结构守卫**：除 hotkeys.ts 外，src 下不许再出现文档级 keydown 监听。
 *    守卫自己带变异用例——喂一段含该模式的假源码，扫描器必须报出来。
 *    没有这一条，「扫了个寂寞」和「真没有」在外部完全同形。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  comboOf,
  dispatchCombo,
  isTypingTarget,
  orderedLayers,
  type Combo,
  type HotkeyBindings,
} from '../hotkeys';

const SRC = join(process.cwd(), 'src');

describe('认键', () => {
  it('⌘B 与 Ctrl+B 是同一个键位', () => {
    expect(comboOf({ key: 'b', metaKey: true })).toBe('mod+b');
    expect(comboOf({ key: 'b', ctrlKey: true })).toBe('mod+b');
  });

  it('裸 b 不是快捷键', () => {
    expect(comboOf({ key: 'b' })).toBeNull();
  });

  it('长按连发一律不认——⌘B 按住不放会让面板抽搐', () => {
    expect(comboOf({ key: 'b', metaKey: true, repeat: true })).toBeNull();
  });

  it('⌘⇧H 认大写 H：shift 会把 key 变成大写', () => {
    expect(comboOf({ key: 'H', metaKey: true, shiftKey: true })).toBe('mod+shift+h');
    expect(comboOf({ key: 'h', ctrlKey: true, shiftKey: true })).toBe('mod+shift+h');
  });

  it('⌘B 带上 shift 就不是 ⌘B 了（别把 ⌘⇧B 也吃掉）', () => {
    expect(comboOf({ key: 'b', metaKey: true, shiftKey: true })).toBeNull();
  });

  it('F6 与 ⇧F6 分得开', () => {
    expect(comboOf({ key: 'F6' })).toBe('f6');
    expect(comboOf({ key: 'F6', shiftKey: true })).toBe('shift+f6');
  });

  it('Esc 不管带什么修饰键都算 Esc', () => {
    expect(comboOf({ key: 'Escape' })).toBe('escape');
    expect(comboOf({ key: 'Escape', shiftKey: true })).toBe('escape');
  });

  it('裸斜杠是搜索，⌘/ 不是', () => {
    expect(comboOf({ key: '/' })).toBe('slash');
    expect(comboOf({ key: '/', metaKey: true })).toBeNull();
  });
});

describe('认输入框', () => {
  it('文本输入区里打字时不该被抢键', () => {
    expect(isTypingTarget({ tagName: 'TEXTAREA' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT' })).toBe(true);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'email' })).toBe(true);
    expect(isTypingTarget({ isContentEditable: true, tagName: 'DIV' })).toBe(true);
  });

  it('勾选框上打不了字，`/` 不该被它拦住', () => {
    expect(isTypingTarget({ tagName: 'INPUT', type: 'checkbox' })).toBe(false);
    expect(isTypingTarget({ tagName: 'INPUT', type: 'radio' })).toBe(false);
    expect(isTypingTarget({ tagName: 'BUTTON' })).toBe(false);
    expect(isTypingTarget(null)).toBe(false);
  });
});

/** 造一层。read 返回当前这份绑定。 */
const layer = (priority: number, seq: number, bindings: HotkeyBindings) => ({
  priority,
  seq,
  read: () => bindings,
});

describe('下发次序', () => {
  const ev = {} as KeyboardEvent;

  it('优先级高的先看到；同级时后挂载的先看到', () => {
    const order = orderedLayers([
      layer(0, 1, {}),
      layer(20, 2, {}),
      layer(0, 3, {}),
      layer(-10, 4, {}),
    ]);
    expect(order.map((l) => l.priority)).toEqual([20, 0, 0, -10]);
    expect(order[1].seq).toBe(3); // 同为 0，seq 大的在前
  });

  it('第一个认领的就停下，后面的看不到', () => {
    const seen: string[] = [];
    const handled = dispatchCombo('escape', ev, [
      layer(20, 1, { escape: () => (seen.push('查看器'), true) }),
      layer(-10, 2, { escape: () => (seen.push('低调'), true) }),
    ]);
    expect(handled).toBe(true);
    expect(seen).toEqual(['查看器']);
  });

  it('Esc 层序：查看器没开就往下传，低调模式才数得到这一下', () => {
    const seen: string[] = [];
    const handled = dispatchCombo('escape', ev, [
      // 查看器没开 → 返回 false（不是「吃掉不作声」）
      layer(20, 1, { escape: () => (seen.push('查看器'), false) }),
      layer(-10, 2, { escape: () => (seen.push('低调'), true) }),
    ]);
    expect(handled).toBe(true);
    expect(seen).toEqual(['查看器', '低调']);
  });

  it('没人认领就返回 false——F6 走到末栏靠的正是这个（放行给浏览器）', () => {
    expect(dispatchCombo('f6', ev, [layer(20, 1, { f6: () => false })])).toBe(false);
    expect(dispatchCombo('mod+k', ev, [layer(0, 1, {})])).toBe(false);
  });
});

// ── 结构守卫 ────────────────────────────────────────────────────
/** 文档级键盘监听的写法。React 的 onKeyDown 属性是字段级的，不在此列。 */
const GLOBAL_KEYDOWN = /(?:window|document)\s*\.\s*addEventListener\s*\(\s*['"]keydown['"]/;

/** 唯一豁免：入口本身。 */
const ALLOWED = new Set(['app/_ui/hotkeys.ts']);

/** 测试文件不算产品代码：本文件的变异用例里就带着那个模式。 */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === '__tests__') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** 注释里提到某个禁用写法不算犯规——守卫看的是代码。 */
export function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*(\/\/|\*).*$/gm, '');
}

function offenders(): string[] {
  return walk(SRC)
    .filter((p) => GLOBAL_KEYDOWN.test(codeOf(p)))
    .map((p) => relative(SRC, p))
    .filter((rel) => !ALLOWED.has(rel.split('\\').join('/')));
}

describe('结构守卫：文档级键盘监听只许有一处', () => {
  it('src 下除 _ui/hotkeys.ts 外没有第二处', () => {
    expect(offenders()).toEqual([]);
  });

  it('变异核：扫描器对真的违例会报出来（否则上一条是空转）', () => {
    const 假源码 = `useEffect(() => {\n  window.addEventListener('keydown', onKey);\n}, []);`;
    expect(GLOBAL_KEYDOWN.test(假源码)).toBe(true);
    // 双引号、document、以及中间夹空格的写法都要认
    expect(GLOBAL_KEYDOWN.test(`document.addEventListener("keydown", f, true)`)).toBe(true);
    expect(GLOBAL_KEYDOWN.test(`window . addEventListener ( 'keydown' , f )`)).toBe(true);
    // 字段级的 onKeyDown 属性不该被误伤
    expect(GLOBAL_KEYDOWN.test(`<textarea onKeyDown={(e) => send(e)} />`)).toBe(false);
  });

  it('豁免名单里的文件真的存在（改名后守卫会静默失效）', () => {
    for (const rel of ALLOWED) {
      expect(() => statSync(join(SRC, rel))).not.toThrow();
    }
  });

  it('入口本身确实装了那个监听（不然守卫守的是一片荒地）', () => {
    expect(GLOBAL_KEYDOWN.test(codeOf(join(SRC, 'app/_ui/hotkeys.ts')))).toBe(true);
  });

  it('剥注释这一步没把代码也剥掉', () => {
    const code = codeOf(join(SRC, 'app/_ui/hotkeys.ts'));
    expect(code).toContain('export function comboOf');
    // 注释里出现的禁用写法确实被剥掉了
    expect(codeOf(join(SRC, 'components/shadcn/sidebar.tsx'))).not.toContain('window keydown');
  });
});

describe('登记在册的键', () => {
  it('每一个 Combo 都能被某个真实按键还原出来', () => {
    const all: Record<Combo, boolean> = {
      'mod+b': false,
      'mod+k': false,
      'mod+shift+h': false,
      slash: false,
      f6: false,
      'shift+f6': false,
      escape: false,
    };
    const events = [
      { key: 'b', metaKey: true },
      { key: 'k', metaKey: true },
      { key: 'H', metaKey: true, shiftKey: true },
      { key: '/' },
      { key: 'F6' },
      { key: 'F6', shiftKey: true },
      { key: 'Escape' },
    ];
    for (const e of events) {
      const c = comboOf(e);
      if (c) all[c] = true;
    }
    expect(Object.entries(all).filter(([, v]) => !v).map(([k]) => k)).toEqual([]);
  });
});
