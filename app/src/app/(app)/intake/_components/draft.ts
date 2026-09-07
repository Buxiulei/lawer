/**
 * 首诊草稿：全程存在浏览器本地，不上传。
 * 用户可能在地铁上填一半、被叫走、换个场合再打开，所以每次改动都落盘。
 */

import type { CaseStage } from '@/app/_mock/types';
import type { ContractCount, HasDocAnswer } from '@/app/_mock/intake-evidence';
import type { FieldValue } from './schemaFlow';

export const DRAFT_KEY = 'lawer.intake.draft';
const DRAFT_VERSION = 1;

export interface EventNote {
  id: string;
  /** YYYY-MM-DD，可以留空——记不清日期不该挡住记录 */
  date: string;
  text: string;
}

export interface IntakeDraft {
  version: number;
  step: number;
  /**
   * 这份草稿是给哪个领域填的（空串＝还不知道，存量草稿就是这样）。
   *
   * 【为什么要记】草稿存在本机，而一个人名下的案件是哪个领域在服务端定。
   * 不记的形态是：他先在 A 领域填了三步、账号其实是 B 领域，回来接着填时
   * **上一批答案还躺在 fields 里**，按 B 的 schema 一路提交上去——每一格都对得上某个键，
   * 没有一处会报错。记下来之后，领域对不上就整份重来（见 IntakeFlow 的挂载 effect）。
   */
  domain: string;
  /**
   * 按 schema 排步的那条路（非缺省领域）各格的答案，键即 IntakeFieldSpec.key。
   * 缺省领域走的是下面那些手写字段，这个袋子始终是空的。
   */
  fields: Record<string, FieldValue>;
  stage: CaseStage | '';
  hiredOn: string;
  monthlyWage: string;
  position: string;
  companyName: string;
  contractCount: ContractCount | '';
  events: EventNote[];
  freeText: string;
  terminationNotice: HasDocAnswer | '';
  settlementAgreement: HasDocAnswer | '';
  otherPaper: HasDocAnswer | '';
  companyWording: string;
  goals: string[];
  bottomLine: string;
  savedAt: string;
}

export const EMPTY_DRAFT: IntakeDraft = {
  version: DRAFT_VERSION,
  step: 0,
  domain: '',
  fields: {},
  stage: '',
  hiredOn: '',
  monthlyWage: '',
  position: '',
  companyName: '',
  contractCount: '',
  events: [],
  freeText: '',
  terminationNotice: '',
  settlementAgreement: '',
  otherPaper: '',
  companyWording: '',
  goals: [],
  bottomLine: '',
  savedAt: '',
};

/** 判断草稿里有没有用户真填过的内容，决定要不要提示"接着上次填"。 */
export function draftHasContent(d: IntakeDraft): boolean {
  return Boolean(
    d.stage ||
      d.hiredOn ||
      d.monthlyWage ||
      d.position ||
      d.companyName ||
      d.contractCount ||
      d.events.length ||
      d.freeText ||
      d.terminationNotice ||
      d.settlementAgreement ||
      d.otherPaper ||
      d.companyWording ||
      d.goals.length ||
      d.bottomLine ||
      // schema 那条路的答案全在这个袋子里；不数它的形态是：非缺省领域的人填了五步、
      // 回来时「上次填到第 N 步」一个字都不提，页面看起来像是从头开始。
      Object.keys(d.fields ?? {}).length,
  );
}

/**
 * 这份草稿要不要给 `domain` 这个领域接着用。
 *
 * 【四态，第一态是"什么都不做"】
 *   · **领域还没问出来（空串）→ 一格都不动**，见下；
 *   · 同一个领域 → 原样接着填（对象**原样返回**，好让 React 认得出没变）；
 *   · 草稿没记领域（存量草稿都没有这一列）→ 只补上领域，答案一格不动；
 *   · 换了领域 → **整份作废**。留着的形态是：上一个领域的答案按字段键一格不落地
 *     被按这个领域的 schema 提交上去——键名跨领域同名（IntakeFieldSpec 的约定），
 *     每一格都对得上某个键，服务端照收，回包 201，没有一处会报错。
 *
 * 【空串那一支不能省】首诊页问「我名下那个案子属于哪个领域」是**挂载之后**的一次请求：
 * 在它回来之前，这一页手里只有空串。把空串当成一个领域去比对的形态是——
 * 第二个领域的用户每刷新一次，都会先被判成"换了领域"清空一次（因为那一帧的对照物是
 * 缺省领域），等答案回来时他上次填的每一格已经没了，而屏幕上只是显示"从头开始"，
 * 一处报错都没有。**空串是"还不知道"，不是"某个领域"。**
 *
 * 【为什么是个纯函数，不留在那个 effect 里】留在 effect 里的形态是：这几态只能靠点页面
 * 才验得到（本仓 vitest 跑在 node 环境，effect 根本不执行），而它错的时候页面照常能用——
 * 错的是**交上去的是谁的答案**、以及**上次填的还在不在**。
 */
export function draftForDomain(prev: IntakeDraft, domain: string): IntakeDraft {
  if (domain === '') return prev;
  if (prev.domain === domain) return prev;
  if (prev.domain === '') return { ...prev, domain };
  return { ...EMPTY_DRAFT, domain };
}

export function loadDraft(): IntakeDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IntakeDraft>;
    if (parsed.version !== DRAFT_VERSION) return null;
    return { ...EMPTY_DRAFT, ...parsed, fields: parsed.fields ?? {}, version: DRAFT_VERSION };
  } catch {
    return null;
  }
}

export function saveDraft(draft: IntakeDraft): void {
  try {
    localStorage.setItem(
      DRAFT_KEY,
      JSON.stringify({ ...draft, savedAt: new Date().toISOString() }),
    );
  } catch {
    // 隐私模式下不可写：本次会话内照常填写，只是关掉页面会丢
  }
}

export function clearDraft(): void {
  try {
    localStorage.removeItem(DRAFT_KEY);
  } catch {
    // 同上
  }
}
