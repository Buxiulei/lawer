/**
 * 证据上传的实名闸（前移到上传那一刻，spec D1）。
 *
 * 主理人裁决：上传证据就要提示实名，未实名无法保存证据出证。真正的拦在服务端
 * requireRealname（见 upload-guard.test 的「实名闸」组，那一组盯的是「未实名时零落库零落盘」）；
 * 这一份盯的是前端那一半——未实名时入口收起来、给一张能点得动的「去实名」提示卡。
 *
 * 【为什么 UploadBar 走真渲染、别的走源码断言】UploadBar 是纯组件（只有 useRef），
 * realname 从 prop 进，能裸渲。EvidenceLibrary / UploadSheet 都吃 useDiscreet（无 Provider 直接抛）
 * 与 Radix 抽屉（node 里起不来），只能断源码——这是**明知其弱**的取舍：挡得住「闸被删/条件被改回去」，
 * 挡不住「条件写对了但渲染另有分支」。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { isRealnameVerified, type RealnameGate } from '@/app/_ui/realname';
import { CASE_WORDS } from '@/app/_ui/neutral';
import { allText } from '@/app/_ui/__tests__/unveiled';

// Button asChild 里那颗 <Link>——裸渲时换成一个真 <a>，好断 href
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

const { UploadBar } = await import('../UploadBar');

const OPEN: RealnameGate = { blocked: false, pending: false, discreet: false };
const BLOCKED: RealnameGate = { blocked: true, pending: false, discreet: false };
const PENDING: RealnameGate = { blocked: true, pending: true, discreet: false };
const BLOCKED_DISCREET: RealnameGate = { blocked: true, pending: false, discreet: true };

const noop = () => {};
/** disabled 属性渲染成 disabled=""，className 里的 `disabled:`/`disabled-` 不会被误数 */
const disabledCount = (html: string) => (html.match(/disabled=""/g) ?? []).length;

/**
 * 判定的那一条：只有落定的「已实名」放行，待审 / 未认证 / 未取到一律不放行。
 * 变异臂：把 isRealnameVerified 改成 `return false`——下面「已实名放行」翻红；
 * 改成 `return true`——「待审 / 未认证不放行」翻红。这条是整道闸的判定核心。
 */
describe('isRealnameVerified：只认「已实名」', () => {
  it('已实名 → 放行', () => {
    expect(isRealnameVerified('已实名')).toBe(true);
  });
  it('待审 / 未认证 / 空 → 不放行（与服务端 requireRealname 同口径）', () => {
    expect(isRealnameVerified('待审')).toBe(false);
    expect(isRealnameVerified('未认证')).toBe(false);
    expect(isRealnameVerified(null)).toBe(false);
    expect(isRealnameVerified(undefined)).toBe(false);
  });
});

describe('UploadBar：未实名收起入口 + 提示卡', () => {
  it('未认证：提示卡三段式齐 + 三个入口全禁用 + 按钮跳 /settings', () => {
    const html = renderToStaticMarkup(<UploadBar onPick={noop} realname={BLOCKED} />);
    const text = allText(html);
    // 怎么了 / 为什么 / 怎么办
    expect(text).toContain('上传前需先完成实名认证');
    expect(text).toContain('无法保存');
    expect(text).toContain('去实名认证');
    // 去实名的出口指向设置页
    expect(html).toMatch(/href="\/settings/);
    // 三个上传入口都 disabled（拍照 / 选文件 / 录音）
    expect(disabledCount(html)).toBe(3);
  });

  it('待审：文案是「审核中」，不再给去实名按钮，入口仍禁用', () => {
    const html = renderToStaticMarkup(<UploadBar onPick={noop} realname={PENDING} />);
    const text = allText(html);
    expect(text).toContain('实名审核中');
    expect(text).toContain('通过后即可上传');
    expect(text).not.toContain('去实名认证');
    expect(disabledCount(html)).toBe(3);
  });

  it('已实名：零变化——不渲染提示卡，三个入口都不禁用', () => {
    const html = renderToStaticMarkup(<UploadBar onPick={noop} realname={OPEN} />);
    const text = allText(html);
    expect(text).not.toContain('实名认证');
    expect(text).not.toContain('审核中');
    expect(disabledCount(html)).toBe(0);
    // 入口本身还在
    expect(text).toContain('拍照');
    expect(text).toContain('选文件');
    expect(text).toContain('录音');
  });

  /**
   * 已实名 DOM 与前移实名闸之前逐节点一致：顶层就是那张 grid，没有多包一层外层 div。
   * 变异臂：把返回从 fragment 改回常驻 `<div className="flex flex-col gap-2">` 外层——
   * 已实名用户就凭空多一层节点，本条翻红（顶层成了 flex 那个 div、且出现 flex-col）。
   */
  it('已实名：顶层元素就是 grid grid-cols-3，无外层 flex-col 包裹', () => {
    const html = renderToStaticMarkup(<UploadBar onPick={noop} realname={OPEN} />);
    // 顶层直接是 grid：前面没有任何外层节点
    expect(html.startsWith('<div class="grid grid-cols-3 gap-2"')).toBe(true);
    // 不含外层 `flex flex-col` 包裹——注意 PickButton 自身类名是 `flex min-h-[72px] flex-col`，
    // 相邻的 `flex flex-col` 只会来自被删掉的那层外层 div，拿它当签名不会误伤按钮。
    expect(html).not.toContain('flex flex-col');
  });

  /**
   * 变异臂（UI 条件改恒 false）：把 UploadBar 里 `{blocked && <RealnamePrompt.../>}`
   * 或 `const blocked = realname.blocked` 改成恒 false——上面「未认证」「待审」两条的
   * 提示卡与 disabled 断言一起翻红。
   */
  it('低调模式：提示卡不含任何案情词（证据 → 资料）', () => {
    const html = renderToStaticMarkup(<UploadBar onPick={noop} realname={BLOCKED_DISCREET} />);
    const text = allText(html);
    for (const word of CASE_WORDS) {
      expect(text.includes(word), `低调模式提示卡里明文写着「${word}」`).toBe(false);
    }
    // 换词后仍说清同一件事
    expect(text).toContain('资料');
    expect(text).toContain('无法保存');
    expect(text).toContain('去实名认证');
  });
});

/**
 * 装配那一半：EvidenceLibrary / UploadSheet 起不来 node，断源码。
 * 这几条挡的是「闸被摘掉」与「realname 没接到组件上」，不保证渲染分支。
 */
describe('装配（源码断言）', () => {
  const read = (p: string) => readFileSync(join(process.cwd(), 'src', p), 'utf8');
  const LIB = read('app/(app)/case/[id]/evidence/_components/EvidenceLibrary.tsx');
  const SHEET = read('app/(app)/case/[id]/evidence/_components/UploadSheet.tsx');

  it('rnGate.blocked 从 auth_status 算出来，且 demo 与加载态放行', () => {
    expect(LIB).toMatch(/blocked:\s*!isDemo\s*&&\s*!rnLoading\s*&&\s*!isRealnameVerified\(rnStatus\)/);
  });

  it('两个上传组件都接到了 rnGate', () => {
    expect(LIB).toMatch(/<UploadBar[^>]*realname=\{rnGate\}/);
    expect(LIB).toMatch(/realname=\{rnGate\}/);
  });

  it('拖入也拦：handleDropped 未实名早退、不发请求', () => {
    // 早退落在设置 pending / setDropped 之前
    expect(LIB).toMatch(/if \(rnGate\.blocked\)[\s\S]*?return;/);
  });

  it('UploadSheet 兜底：未实名禁用「存进证据库」并顶提示卡', () => {
    expect(SHEET).toMatch(/disabled=\{realname\.blocked\}/);
    expect(SHEET).toMatch(/realname\.blocked\s*&&\s*<RealnamePrompt/);
  });
});
