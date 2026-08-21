// app/src/lib/agent/index.ts
// 律师 agent 出口（spec §3.2：跨模块只经本文件导出的接口）。
// 路由层只需要 runTurn + encodeSse；其余导出供评测脚本与同层模块使用。
export { runTurn, THREAD_MODES, type RunTurnInput, type RunTurnOutcome, type RunTurnResult } from './orchestrator';
export {
  encodeSse,
  startHeartbeat,
  HEARTBEAT_INTERVAL_MS,
  type AgentEvent,
  type AgentEventSink,
  type Heartbeat,
  type NoticeCode,
  type RecordTool,
} from './events';
export { CHARTER } from './charter';
export { intakeStage, intakeDirective, recapBrief, TIMELINE_DONE_THRESHOLD, type IntakeStage } from './intake';
export { loadCaseSnapshot, type CaseSnapshot } from './snapshot';
export { CALC_KINDS } from './tools';
export {
  assessCrisis,
  CRISIS_DIRECTIVE,
  CRISIS_RESOURCE_PACK_ID,
  CRISIS_CARD_MARKER,
  bannedHotlines,
  stripDuplicateHotlineList,
  isLandlineOnly,
  LANDLINE_MARK,
  buildCrisisOpener,
  compactCrisisCard,
  extractHotlines,
  crisisHotlines,
  type HotlineFact,
  detectEmotionalLeverage,
  responseGaveCrisisCard,
  shouldInjectCrisisCard,
  type CrisisAssessment,
} from './crisis';
// G4 依据纪律：注入侧的引用块拼装 + 出口侧的光秃条号检测。
// 评测侧断言直接复用 bareArticleCitations，保证「产品认为哪几处光秃，评测就判哪几处」。
export { bareArticleCitations, packCitationGuide, statuteBlocks, valueBlocks } from './citation-block';
export { classifyTask, criticalReasons, type TaskClassInput } from './task-class';
export { buildSystemPrompt, caseDigest, packsSection, beijingNow } from './prompt';
export {
  AGENT_TOOLS,
  executeTool,
  newTurnState,
  MAX_ACTION_CARDS,
  CLAIM_KINDS,
  DRAFT_KINDS,
  EMOTION_LEVELS,
  COMPANY_ROLES,
  type AgentToolContext,
  type ToolOutcome,
  type TurnState,
} from './tools';
export { createKnowledgeSearcher } from './knowledge-adapter';
export {
  KNOWLEDGE_MISS_DIRECTIVE,
  MAX_INJECTED_PACKS,
  type KnowledgePack,
  type KnowledgeSearcher,
  type KnowledgeSearchResult,
} from './retrieval';
