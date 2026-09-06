// app/src/app/__tests__/page-domain-guard.test.ts
// 页面层的领域中立守卫（设计稿 §13「网页」行：页面与组件共用，按领域换的只有文案词典）。
//
// 【为什么按文件拦，不靠人记性拦】第二个领域接进来时，共用页面里上一个领域留下的硬编码
// 看起来都很正常——它们是通顺的中文，渲染不报错，测试也不红，只有那个行当的用户读到的
// 每一句都在讲另一件事。lib/capabilities 那侧早就有同样一条守卫（registry-guard），
// 这一份把它扩到 app/src/app 与 app/src/components。
//
// 【白名单里的是「这一页本来就只服务缺省领域」】它们不是欠账清单上的待办，而是**已知的、
// 逐文件点过名的豁免**：演示数据、缺省领域的手写首诊向导、那个行当的公司情报页与存证页。
// 新文件默认在闸内——所以「不得新增领域字面量」这条不靠复审时有没有人注意到。
//
// 【三个方向都要红，少一个这份名单就会慢慢烂掉】
//   · 闸内文件出现领域词        → 红（本来要挡的那件事）
//   · 白名单里写了不存在的文件   → 红（文件改名/删了，名单还留着，看起来仍然完整）
//   · 白名单里的文件已经不含领域词 → 红（那一行该删了；留着等于给它一张以后还能再写回来的通行证）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** app/src */
const SRC_ROOT = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');

// 与 lib/capabilities/__tests__/registry-guard.test.ts 同一份词。
// 「用人单位」是对方主体在某一个领域里的称呼（领域包 parties.counterparts[0]），
// 它最容易被顺手写进共用组件——总要有个词指代"对面那家"。
const FORBIDDEN = ['劳动', '仲裁', '用人单位', '劳动者'];

/**
 * 逐文件豁免：这些页面/组件**只服务缺省领域**，里面的领域字面量是它们的正文，不是漏网。
 * 路径相对 app/src。加一行之前先问一句：这一页第二个领域的用户会不会打开？
 * 会打开的，字要搬进 lib/domains/<key>.ts，由 app/_ui/domain.ts 取。
 */
const DOMAIN_SPECIFIC_FILES = [
  'app/layout.tsx',
  'app/page.tsx',
  'app/welcome/page.tsx',
  'app/_ui/DiscreetCollapse.tsx',
  'app/_ui/byoAgent.ts',
  'app/_ui/motion.ts',
  'app/_ui/neutral.ts',
  'app/woo/users/page.tsx',
  'app/(app)/case/[id]/_components/CaseStatusBar.tsx',
  'app/(app)/case/[id]/_components/CommandSearch.tsx',
  'app/(app)/case/[id]/_components/Dashboard.tsx',
  'app/(app)/case/[id]/_components/MilestoneTrack.tsx',
  'app/(app)/case/[id]/_components/RichText.tsx',
  'app/(app)/case/[id]/_components/dashboardData.ts',
  'app/(app)/case/[id]/_components/milestones.ts',
  'app/(app)/case/[id]/evidence/_components/EvidenceDetailSheet.tsx',
  'app/(app)/case/[id]/evidence/_components/UploadSheet.tsx',
  'app/(app)/case/[id]/drafts/page.tsx',
  'app/(app)/case/[id]/drafts/_components/DraftsListView.tsx',
  'app/(app)/case/[id]/drafts/_components/badges.tsx',
  'app/(app)/case/[id]/drafts/_components/draftsData.ts',
  'app/(app)/case/[id]/_stream/caseHistory.ts',
  'app/(app)/case/[id]/docs/_components/DocActions.tsx',
  'app/(app)/case/[id]/docs/_components/UploadSheet.tsx',
  'app/(app)/case/[id]/docs/_components/docsData.ts',
  'app/(app)/case/[id]/graph/_components/NodeSheet.tsx',
  'app/(app)/case/[id]/dossier/page.tsx',
  'app/(app)/case/[id]/dossier/_components/DossierBody.tsx',
  'app/(app)/case/[id]/dossier/_components/DossierLoader.tsx',
  'app/(app)/case/[id]/dossier/_components/StatsSection.tsx',
  'app/(app)/case/[id]/dossier/_components/VenueCards.tsx',
  'app/(app)/case/[id]/dossier/order/_components/OrderQuote.tsx',
  'app/(app)/intake/_components/StepBasics.tsx',
  'app/(app)/intake/_components/StepPreview.tsx',
  'app/(app)/intake/_components/validate.ts',
  'app/(app)/account/_components/RechargePanel.tsx',
  'app/(app)/settings/_components/AgentSetupCard.tsx',
  'app/(app)/settings/_components/agentSetup.ts',
  'app/(app)/settings/agent/_components/ConnectGuide.tsx',
  'app/_mock/authpay.ts',
  'app/_mock/company-dossier.ts',
  'app/_mock/company-graph.ts',
  'app/_mock/demo.ts',
  'app/_mock/docs-drafts.ts',
  'app/_mock/intake-evidence.ts',
  'app/_mock/types.ts',
  'app/_mock/workbench.ts',
  'app/verify/[no]/_verification.ts',
  'app/verify/[no]/page.tsx',
  'app/verify/[no]/_components/RecheckPanel.tsx',
  'app/verify/[no]/_components/VerifyResult.tsx',
  'app/api/manifest/route.ts',
  'app/api/v1/cases/[id]/messages/route.ts',
  'app/api/v1/company/dossiers/quote/route.ts',
  'app/api/v1/verify/[orderNo]/route.ts',
  'app/api/v1/verify/[orderNo]/recheck/route.ts',
];

/** 递归收集 .ts/.tsx，跳过 __tests__ */
function walk(dir: string, out: string[] = []): string[] {
  for (const name of fs.readdirSync(dir).sort()) {
    const full = path.join(dir, name);
    if (fs.statSync(full).isDirectory()) {
      if (name === '__tests__') continue;
      walk(full, out);
    } else if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      out.push(full);
    }
  }
  return out;
}

const SCANNED = [...walk(path.join(SRC_ROOT, 'app')), ...walk(path.join(SRC_ROOT, 'components'))];
const rel = (file: string) => path.relative(SRC_ROOT, file);
const allowed = new Set(DOMAIN_SPECIFIC_FILES);
const wordsIn = (file: string) => {
  const text = fs.readFileSync(file, 'utf-8');
  return FORBIDDEN.filter((w) => text.includes(w));
};

describe('页面与共享组件里不许写死领域内容（设计稿 §13-6）', () => {
  it('白名单之外的页面/组件一个领域词都没有（变异：往 app/_ui/domain.ts 写一句带「仲裁」的注释 → 红）', () => {
    const hits: string[] = [];
    for (const file of SCANNED) {
      if (allowed.has(rel(file))) continue;
      const words = wordsIn(file);
      if (words.length) hits.push(`${rel(file)} 里出现「${words.join('、')}」`);
    }
    expect(
      hits,
      `页面层出现了领域字面量：\n  ${hits.join('\n  ')}\n` +
        '缺什么：这几处的字只对缺省领域成立，第二个领域的用户会读到另一个行当的话。\n' +
        '为什么缺：页面渲染不报错、测试也不红，所以这类硬编码只有靠这条闸拦。\n' +
        '怎么办：把文案搬进 lib/domains/<key>.ts 的 copy，由 app/_ui/domain.ts 取；' +
        '确实只服务缺省领域的整页，把文件路径加进本文件的 DOMAIN_SPECIFIC_FILES 并说明理由。',
    ).toEqual([]);
  });

  it('白名单里的每个文件都真的存在（改名或删掉之后名单还留着 → 红）', () => {
    const missing = DOMAIN_SPECIFIC_FILES.filter(
      (f) => !fs.existsSync(path.join(SRC_ROOT, f)),
    );
    expect(missing, `白名单里这些文件已经不在了，删掉对应的行：\n  ${missing.join('\n  ')}`).toEqual(
      [],
    );
  });

  it('白名单里的每个文件都还含着领域词（清干净了就该出名单，别留一张通行证）', () => {
    const clean = DOMAIN_SPECIFIC_FILES.filter(
      (f) => fs.existsSync(path.join(SRC_ROOT, f)) && wordsIn(path.join(SRC_ROOT, f)).length === 0,
    );
    expect(
      clean,
      `这些文件已经不含领域字面量了，把它们从 DOMAIN_SPECIFIC_FILES 里删掉：\n  ${clean.join('\n  ')}\n` +
        '留着的形态是：以后有人往这里写回一句领域文案，闸不会响。',
    ).toEqual([]);
  });

  it('扫到的确实是那一堆文件（空名单会让上面那条永远绿）', () => {
    expect(SCANNED.length).toBeGreaterThan(200);
    // 本轮新写的这几个共用件必须在闸内——它们正是「按领域渲染」的那几处，
    // 漏进白名单或漏出扫描范围，这条守卫就白立了。
    for (const f of [
      'app/_ui/domain.ts',
      'app/_ui/DomainChoice.tsx',
      'app/(app)/intake/_components/schemaFlow.ts',
      'app/(app)/intake/_components/SchemaField.tsx',
      'app/api/v1/domains/route.ts',
    ]) {
      expect(SCANNED.map(rel), `${f} 不在扫描范围里`).toContain(f);
      expect(allowed.has(f), `${f} 不该在白名单里`).toBe(false);
    }
  });
});
