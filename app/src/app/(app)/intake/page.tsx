import type { Metadata } from 'next';
import * as knowledge from '@/lib/knowledge';
import { readSanbeiCap, SANBEI_CAP_PACK_ID, type SanbeiCap } from '@/lib/cap/sanbei';
import { IntakeFlow } from './_components/IntakeFlow';

export const metadata: Metadata = { title: '首诊' };

/**
 * 三倍社平封顶基数在服务端取：知识卡走文件系统，浏览器读不到。
 * **取不到就传 null**，让金额表如实说「这次没算」——绝不回落到任何写死的旧数字，
 * 那正是 `_mock/demo.ts` 的 35283 混进真实用户金额表的路子。
 */
function currentCap(): SanbeiCap | null {
  try {
    return readSanbeiCap(knowledge.get(SANBEI_CAP_PACK_ID).facts);
  } catch {
    return null;
  }
}

export default function IntakePage() {
  return <IntakeFlow cap={currentCap()} />;
}
