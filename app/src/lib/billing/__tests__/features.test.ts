// app/src/lib/billing/__tests__/features.test.ts
// 用量功能键 → 中文标签单一事实源：全部已登记键须为纯中文标签、未知键回退「其他」。
import { describe, expect, test } from 'vitest';
import { FEATURE_LABELS, KNOWN_FEATURE_KEYS, featureLabel, UNKNOWN_FEATURE_LABEL } from '../features';
import { DOSSIER_MODULE_FEATURE, DOSSIER_MODULES } from '@/lib/company/dossier-billing';

/** 生产在用的 feature 键全集（新增计费功能须同步补此表与 FEATURE_LABELS）。
 *  companywatch 目前只记量不扣费（扣费口径待 M3），但用量明细同样要出中文标签，故一并登记。
 *
 *  公司档案六模块**不照抄字符串、直接取生产映射表**：gongdaoSettle 实际写进账本的 feature
 *  就是 DOSSIER_MODULE_FEATURE 的值，在这里再手抄一份，改了模块键名两边各说各话、
 *  测试照绿，而用量明细里悄悄多出六个「其他」。取生产源即让改名当场变红。 */
const PRODUCTION_FEATURE_KEYS = [
  'intake', 'companion', 'draft', 'ocr', 'asr', 'attest', 'export', 'knowledge', 'companywatch',
  'contract_review',
  ...DOSSIER_MODULES.map((m) => DOSSIER_MODULE_FEATURE[m]),
];

describe('用量功能标签单一事实源', () => {
  test('全部已登记键均有非空、纯中文标签（无英文/内部标记）', () => {
    for (const key of KNOWN_FEATURE_KEYS) {
      const label = FEATURE_LABELS[key];
      expect(label, `键「${key}」缺标签`).toBeTruthy();
      expect(label, `键「${key}」标签「${label}」含英文字母`).not.toMatch(/[A-Za-z]/);
      expect(label, `键「${key}」标签含内部标记`).not.toMatch(/§|【|引擎|规格/);
    }
  });

  test('生产实际使用的每个 feature 键都已登记中文标签（不落「其他」）', () => {
    expect([...KNOWN_FEATURE_KEYS].sort()).toEqual([...PRODUCTION_FEATURE_KEYS].sort());
    for (const key of PRODUCTION_FEATURE_KEYS) {
      expect(FEATURE_LABELS[key], `生产键「${key}」未登记`).toBeDefined();
      expect(featureLabel(key)).not.toBe(UNKNOWN_FEATURE_LABEL);
    }
  });

  test('关键键映射正确', () => {
    expect(featureLabel('intake')).toBe('问诊');
    expect(featureLabel('attest')).toBe('证据固化');
    expect(featureLabel('export')).toBe('材料导出');
  });

  test('未知键回退「其他」，不直出原始英文键', () => {
    expect(featureLabel('weird_unknown_key')).toBe('其他');
    expect(featureLabel('')).toBe('其他');
  });
});
