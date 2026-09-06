// app/src/lib/paste/batch.ts
// 预览批次的暂存。**进程内内存，不落库**。
//
// 【为什么不建表】判据要求「预览不写库（零新增）」，而这条判据背后的产品理由是：
// 预览是用户还没点头的那一步，它不该在档案里留下任何痕迹——包括一张只有我们看得懂的
// 批次表。用户看完预览决定全不要，档案就该和他粘贴之前一模一样。
//
// 【代价，写在明处】进程重启（发版、崩溃）后未确认的批次就没了，用户得把那段回复重粘一次
// （粘贴板还在他手上，代价是一次重贴，不是丢数据）。多实例部署时预览与确认必须落到同一个
// 实例——当前是单进程部署（deploy/ 里 lawer-app 一个服务），这条成立；**哪天要多开实例，
// 这里就得换成一张带 TTL 的表**，别默默指望粘性会话。
//
// 【为什么确认之后不立刻删】重放同一个 batch_id 是正常行为（用户手滑点两次、网络重试）。
// 留着批次 + 写入侧的 client_ref 幂等，重放会**原样回到同一批结果**且零双写；
// 删了的话第二次点会变成一句「批次不存在」，用户以为第一次也没成功，于是回去重粘一遍。
import crypto from 'node:crypto';

import type { PasteItem } from './parse';

/** 批次存活时长：一次「看完预览、勾几条、点确认」的操作窗口，给足一小时 */
export const BATCH_TTL_MS = 60 * 60 * 1000;

/** 同时最多存几个批次。超了先扔最老的——它们只是待确认的草稿 */
const MAX_BATCHES = 500;

export interface PasteBatch {
  id: string;
  caseId: number;
  userId: number;
  createdAt: number;
  items: PasteItem[];
}

const BATCHES = new Map<string, PasteBatch>();

function prune(now: number): void {
  for (const [id, b] of BATCHES) {
    if (now - b.createdAt >= BATCH_TTL_MS) BATCHES.delete(id);
  }
  while (BATCHES.size >= MAX_BATCHES) {
    const oldest = BATCHES.keys().next();
    if (oldest.done) break;
    BATCHES.delete(oldest.value);
  }
}

export function putBatch(
  input: { caseId: number; userId: number; items: PasteItem[] },
  now = Date.now(),
): PasteBatch {
  prune(now);
  const batch: PasteBatch = {
    // 随机 id：batch_id 会进 client_ref，猜得到就等于能替别人的批次占坑
    id: crypto.randomUUID(),
    caseId: input.caseId,
    userId: input.userId,
    createdAt: now,
    items: input.items,
  };
  BATCHES.set(batch.id, batch);
  return batch;
}

/**
 * 取批次。**归属与案件都要对得上**：只按 id 取的话，拿到别人 id 的人就能确认别人的批次，
 * 而写入侧只看得见「一个合法的 case_id + 一串条目」。
 */
export function getBatch(
  input: { id: unknown; caseId: number; userId: number },
  now = Date.now(),
): PasteBatch | null {
  if (typeof input.id !== 'string' || !input.id) return null;
  const batch = BATCHES.get(input.id);
  if (!batch) return null;
  if (now - batch.createdAt >= BATCH_TTL_MS) {
    BATCHES.delete(batch.id);
    return null;
  }
  if (batch.caseId !== input.caseId || batch.userId !== input.userId) return null;
  return batch;
}

/** 测试用：清空。产线没有调用点（批次靠 TTL 自然消亡）。 */
export function clearBatches(): void {
  BATCHES.clear();
}
