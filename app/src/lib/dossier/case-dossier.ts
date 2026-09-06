// app/src/lib/dossier/case-dossier.ts
// 「案件 → 对方主体 → 档案」这一次解析的**唯一入口**。网页那条 HTTP 口
// （GET /api/v1/cases/{id}/dossier）与用户 agent 那条工具（dossier_get）都调它。
//
// 【为什么要抽出来，而不是让工具再写一遍】这段里有三条判据是并排的：归属（非本人案件当作
// 不存在）、解析（案件里的对方主体 → company_key → 档案）、可见性（没买过就当没有）。
// 抄第二份的形态是：某天有人在其中一处放宽了半条，两条路径就开始各自演化，
// 而两边看起来都完全正常——只是 agent 那条能读到网页那条读不到的东西。
//
// 【没有档案不是错误】三种情况在用户那里是同一件事——「这个案子还没建过档」：
//   ① 案里还没落对方主体；② 这家全站没人建过档；③ 建过，但这个账号没买过。
// 一律 status='none'。**三种不分开说**：分开说等于把「这家有没有人建过档」做成一个
// 人人可查的探针（同 /company/dossiers/{id} 把「无权限」与「不存在」合并成 404 的理由）。
import type { Database } from 'better-sqlite3';

import * as cases from '@/lib/cases';
import { findDossierBySubject } from '@/lib/company/dossier';
import { getDossierBillingView } from '@/lib/company/dossier-billing';
import { listProfiles } from '@/lib/db/company-graph';

import { buildDossierView, pickRespondent, venueOfDistrict } from './build';
import type { DossierView } from './contract';

export interface CaseDossierResult {
  /** none = 这案还没建过档（不是错误）；ready = 有档案且这个账号买过 */
  status: 'none' | 'ready';
  dossier: DossierView | null;
  /** 网页下单入口，页面不必自己拼路径 */
  orderPath: string;
}

export function getCaseDossier(
  db: Database,
  input: { caseId: number; userId: number },
): cases.Result<CaseDossierResult> {
  const { caseId, userId } = input;
  // 归属校验走 lib/cases 的既有入口，不在这里另写一遍 user_id 比对：
  // 「非本人案件一律当作不存在」是条红线，红线复制第二份的那天，两份就开始各自演化了。
  const owned = cases.getCase(db, { caseId, userId, timelineLimit: 1 });
  if (!owned.ok) return owned;

  const orderPath = `/case/${caseId}/dossier/order`;
  const none = { ok: true as const, status: 'none' as const, dossier: null, orderPath };

  const respondent = pickRespondent(listProfiles(db, caseId));
  if (!respondent) return none;

  // 键怎么算是 lib/company 的事（uscc 优先 + 命名空间前缀），这里不自己算一遍：
  // 两处算出不同键时系统一句话都不报，只是命中不了、或者命中了别人家的档案。
  const dossier = findDossierBySubject(db, { uscc: respondent.uscc, name: respondent.name });
  if (!dossier) return none;

  // 可见性判据与 /company/dossiers/{id} 同一条：没下过单、也没为它付过费的账号看不到。
  // 档案是跨案共享的付费资产——「我的案子的对方恰好是这家」不构成看它的理由。
  const billing = getDossierBillingView(db, dossier.id, userId);
  if (!billing) return none;

  return {
    ok: true,
    status: 'ready',
    orderPath,
    dossier: buildDossierView(db, {
      dossier,
      venue: venueOfDistrict(owned.case.district),
      refundedGongdao: billing.modules.reduce((sum, m) => sum + m.refunded, 0),
    }),
  };
}
