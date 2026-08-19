/**
 * 首诊草稿：全程存在浏览器本地，不上传。
 * 用户可能在地铁上填一半、被叫走、换个场合再打开，所以每次改动都落盘。
 */

import type { CaseStage } from '@/app/_mock/types';
import type { ContractCount, HasDocAnswer } from '@/app/_mock/intake-evidence';

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
      d.bottomLine,
  );
}

export function loadDraft(): IntakeDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<IntakeDraft>;
    if (parsed.version !== DRAFT_VERSION) return null;
    return { ...EMPTY_DRAFT, ...parsed, version: DRAFT_VERSION };
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
