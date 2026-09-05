// app/src/lib/capabilities/families/index.ts
// 各族汇总成一张表。**这个数组的顺序就是对外顺序**（MCP tools/list 原样照抄），
// 所以它不是按族分组排的，而是照历史清单的既有次序排的：
// 客户端把工具清单原样展示给用户，往中间插一条等于面板重排；判据（api/mcp route.test
// 的 tools/list 一条）钉着这个顺序与个数。
//
// 【加新能力的规矩】追加在**末尾**，不插在中间。想按族分组读，看各自的 families/*.ts。
import { actionComplete, actionList } from './actions';
import { actionCreate } from './actions-write';
import { caseFacts, caseGet, caseList, caseUpdate, intakeSubmit } from './case';
import { claimCalc, claimsList, claimsUpsert } from './claims';
import { companyProfileUpsert } from './company';
import { deadlineList } from './deadlines';
import { deadlineResolve, deadlineSet } from './deadlines-write';
import { draftGet, draftList, draftWrite } from './drafts';
import { emotionLog } from './emotion';
import { evidenceList } from './evidence';
import { knowledgeSearch } from './knowledge';
import { timelineAdd, timelineList, timelineMilestone } from './timeline';

import type { Capability } from '../registry';

export const CAPABILITIES: Capability[] = [
  caseGet,
  caseUpdate,
  timelineAdd,
  actionList,
  actionComplete,
  deadlineList,
  evidenceList,
  // ──────── 以下按加入先后追加在末尾（理由见文件头）────────
  caseFacts,
  knowledgeSearch,
  caseList,
  intakeSubmit,
  claimCalc,
  claimsUpsert,
  claimsList,
  deadlineSet,
  deadlineResolve,
  actionCreate,
  timelineList,
  timelineMilestone,
  draftList,
  draftGet,
  draftWrite,
  companyProfileUpsert,
  emotionLog,
];
