// app/src/lib/capabilities/families/emotion.ts
// I 族：情绪（设计稿 §2 I）。P1 只有记一笔这一条；危机词表检查是后续工单。
//
// 【转介的两道频控不在这里判】它们在 lib/cases.logEmotion 里，与站内对话同一个函数：
// 频控写两份的形态是，站内那条路守着「一案最多一次」，用户自己的 agent 这条路每轮都提，
// 而两边看起来都在守规矩。
import * as cases from '@/lib/cases';

import { caseIdProp, num, writeOnce } from '../shared';
import type { Capability } from '../registry';

export const emotionLog: Capability = {
  name: 'emotion_log',
  family: 'emotion',
  scope: 'case:write',
  kind: 'write',
  domains: ['*'],
  exposeTo: ['mcp'],
  precondition: [],
  idempotency: { clientRef: true },
  title: '记录情绪状态',
  description:
    '记一笔用户当前的情绪档位。识别到低落/焦虑/严重痛苦时都要记——这是长期陪跑看走向的依据，' +
    '不是评价。refer_nbdpsy 只在符合持续焦虑抑郁表现时置 true：档位没到「焦虑」以上、' +
    '或这个案子此前已经转介过一次，服务端都会把它降回 false 并在返回里说明原因（记录照常落库）。',
  inputSchema: {
    type: 'object',
    properties: {
      ...caseIdProp,
      level: { type: 'string', enum: [...cases.EMOTION_LEVELS], description: '情绪档位' },
      note: { type: 'string', description: '判断依据：用户说了什么（引原话片段）' },
      refer_nbdpsy: { type: 'boolean', description: '本次是否转介心理咨询，默认 false；一个案子最多一次' },
      client_ref: {
        type: 'string',
        description: '幂等键，一次业务操作给一个稳定值；重试用同一个 ref，服务端不会重复落库',
      },
    },
    required: ['case_id', 'level'],
  },
  run: (db, identity, args) => {
    const caseId = num(args.case_id);
    return writeOnce(
      db,
      { caseId, tool: 'emotion_log', clientRef: args.client_ref, keyId: identity.keyId ?? null },
      () =>
        cases.logEmotion(db, {
          caseId,
          userId: identity.uid,
          level: args.level,
          note: args.note,
          referNbdpsy: args.refer_nbdpsy,
        }),
      (res) => ({ table: 'emotion_log', id: res.id }),
    );
  },
};
