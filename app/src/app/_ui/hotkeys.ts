'use client';

import { useEffect, useRef } from 'react';

/**
 * 全站快捷键的**唯一入口**。
 *
 * 立这个模块的由头：`shadcn/sidebar.tsx` 曾自己 `window.addEventListener('keydown')`
 * 挂了一个 ⌘B。第二个人要加 F6、第三个人要加 Esc，各挂各的之后，
 * 「Esc 先关谁」「F6 走到末栏该不该放行」这类**跨键的次序问题**没有任何一处能回答——
 * 每处都只看得见自己那一个键。所以这里收成一个监听器 + 一张声明表：
 * 组件只声明「我要 mod+b，处理成功就返回 true」，次序由本模块统一裁决。
 *
 * 配套的结构守卫在 `__tests__/hotkeys.test.ts`：**除本文件外，src 下不许再出现
 * `addEventListener('keydown')`**。守卫自己也有变异用例钉着（喂一段含该模式的
 * 假源码，扫描器必须报出来），否则「扫了个寂寞」和「真没有」在外部同形。
 *
 * 元素自己的 onKeyDown（Composer 的 ⌘↵、按钮的 Enter/Space）**不在收编范围**：
 * 那些是字段级行为，作用域就该跟着那个字段走，提到文档级反而要重新实现
 * 「焦点在不在我身上」。本模块只管**文档级**的键。
 */

/** 已登记在册的组合键。B 路要加新键就在这里加一行，别再另挂监听器。 */
export type Combo =
  | 'mod+b'
  | 'mod+k'
  | 'mod+shift+h'
  | 'slash'
  | 'f6'
  | 'shift+f6'
  | 'escape';

/** 返回 true = 「我处理了」：本模块随即 preventDefault 并停止下发。 */
export type HotkeyHandler = (event: KeyboardEvent) => boolean | void;

export type HotkeyBindings = Partial<Record<Combo, HotkeyHandler>>;

/** 只认这几个字段，测试里传个字面量对象即可，不需要真 KeyboardEvent。 */
export interface KeyLike {
  key: string;
  metaKey?: boolean;
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  repeat?: boolean;
}

/** 光标在输入区时仍然放行的键：带修饰键的、以及 Esc / F6 这类导航键。 */
const ALLOWED_WHILE_TYPING: ReadonlySet<Combo> = new Set<Combo>([
  'mod+b',
  'mod+k',
  'mod+shift+h',
  'escape',
  'f6',
  'shift+f6',
]);

/**
 * 事件 → 组合键名。认不出的返回 null。
 *
 * `repeat` 一律不认：⌘B 按住不放会连发，开合面板会抽搐。
 */
export function comboOf(e: KeyLike): Combo | null {
  if (e.repeat) return null;
  const mod = Boolean(e.metaKey || e.ctrlKey);

  if (e.key === 'Escape') return 'escape';
  if (e.key === 'F6') return e.shiftKey ? 'shift+f6' : 'f6';

  const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  // ⌘⇧H：macOS 上 shift 会把 key 变成大写，所以统一小写后再比
  if (mod && e.shiftKey && !e.altKey && k === 'h') return 'mod+shift+h';
  if (mod && !e.shiftKey && !e.altKey) {
    if (k === 'b') return 'mod+b';
    if (k === 'k') return 'mod+k';
  }
  if (!mod && !e.altKey && !e.shiftKey && k === '/') return 'slash';
  return null;
}

/** 只认这几个字段，测试里传字面量对象即可。 */
export interface TargetLike {
  tagName?: string;
  isContentEditable?: boolean;
  type?: string;
}

/** 光标是不是正落在能打字的地方。裸 `/` 在这种地方必须让位给输入。 */
export function isTypingTarget(el: TargetLike | null | undefined): boolean {
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = (el.tagName ?? '').toLowerCase();
  if (tag === 'textarea' || tag === 'select') return true;
  if (tag !== 'input') return false;
  // 勾选框 / 单选 / 按钮型 input 上打不了字，不该拦住 `/`
  const type = (el.type ?? 'text').toLowerCase();
  return !['checkbox', 'radio', 'button', 'submit', 'reset', 'range'].includes(type);
}

interface Layer {
  priority: number;
  seq: number;
  read: () => HotkeyBindings;
}

const layers = new Set<Layer>();
let seq = 0;

/** 优先级高的先看；同级时**后挂载的先看**（越深的组件越具体）。 */
export function orderedLayers(all: Iterable<Layer>): Layer[] {
  return [...all].sort((a, b) => b.priority - a.priority || b.seq - a.seq);
}

/**
 * 把一个组合键下发给各层，返回是否有人认领。
 * 抽成纯函数是为了能在没有 DOM 的测试环境里直接验次序。
 */
export function dispatchCombo(
  combo: Combo,
  event: KeyboardEvent,
  all: Iterable<Layer> = layers,
): boolean {
  for (const layer of orderedLayers(all)) {
    const handler = layer.read()[combo];
    if (!handler) continue;
    if (handler(event) === true) return true;
  }
  return false;
}

function onKeyDown(e: KeyboardEvent) {
  const combo = comboOf(e);
  if (!combo) return;
  if (
    !ALLOWED_WHILE_TYPING.has(combo) &&
    isTypingTarget(e.target as unknown as TargetLike)
  ) {
    return;
  }
  // 没人认领就**什么都不做**——F6 走到末栏要把焦点交还给浏览器地址栏，
  // 这里如果无条件 preventDefault，那条平台惯例当场就断了。
  if (!dispatchCombo(combo, e)) return;
  e.preventDefault();
  e.stopPropagation();
}

let installed = false;

function sync() {
  const want = layers.size > 0;
  if (want === installed) return;
  installed = want;
  if (typeof document === 'undefined') return;
  if (want) document.addEventListener('keydown', onKeyDown, true);
  else document.removeEventListener('keydown', onKeyDown, true);
}

/**
 * 声明一层快捷键。`priority` 大的先看到事件（Esc 的层序就是靠它定的：
 * 查看器 > 抽屉 > 低调模式的双击 Esc）。
 */
export function useHotkeys(bindings: HotkeyBindings, priority = 0): void {
  const ref = useRef(bindings);
  useEffect(() => {
    ref.current = bindings;
  });

  useEffect(() => {
    const layer: Layer = { priority, seq: ++seq, read: () => ref.current };
    layers.add(layer);
    sync();
    return () => {
      layers.delete(layer);
      sync();
    };
  }, [priority]);
}

/** Esc 的层序里，Radix 的模态自己会吃掉这一下，我们不要抢在它前面。 */
export function hasOpenModal(): boolean {
  if (typeof document === 'undefined') return false;
  return Boolean(
    document.querySelector('[data-slot="sheet-content"], [data-slot="dialog-content"]'),
  );
}
