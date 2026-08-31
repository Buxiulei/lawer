// app/src/lib/dossier/venue.ts
// 仲裁地风格卡：**只引存档，一个字都不生成**。
//
// 数据源只有 knowledge loader，按固定 id 取卡。LLM 在这块的唯一职责是"选哪几张卡"
// （给它 title/keywords，让它返回 id 数组）——那一步不在本工单里；这里先把
// 「id → 卡」这半边钉死，并保证**返回的 id 不在索引里就丢弃**，
// 使得将来接上 LLM 选卡时，编出来的 id 无法变成界面上的一张卡。
//
// 【首发只做北京朝阳】别的仲裁地一律走 covered:false，界面出 VENUE_NOT_COVERED
// 那一句，不给任何风格描述。用通用话术填坑等于让没核实过的辖区冒充核实过的辖区。

import * as knowledge from '@/lib/knowledge';
import type { VenueCard, VenueSection } from './contract';

/** 已逐字核实、可以出这一块的仲裁地。**加一个地方＝加一批逐字核实过的卡**，不是改这行。 */
export const COVERED_VENUES = ['北京朝阳'] as const;

/**
 * 北京朝阳这一块引哪几张卡。顺序即展示顺序：先管辖与时效（去之前该确认的），
 * 再立案 SOP（到了现场怎么走），再开庭流程，最后是案量数据（心里有个底）。
 */
const CHAOYANG_CARD_IDS = [
  'sop-zhongcai-guanxia-shixiao',
  'sop-chaoyang-lian-sop',
  'sop-kaiting-liucheng-sop',
  'data-beijing-zhongcai-anliang',
];

export function isCoveredVenue(venue: string): boolean {
  return (COVERED_VENUES as readonly string[]).includes(venue);
}

/**
 * 按 id 取卡，取不到就丢。
 *
 * 【为什么吞掉这个错误】knowledge.get 对不存在的 id 直接抛（它的文件头写着
 * "少给一张法条卡等于给劳动者错误答案，绝不静默返回空结果"）——那条纪律针对的是
 * **检索**：搜不到就该炸，因为调用方以为自己拿到了全部。
 * 这里是另一回事：id 可能来自 LLM 的选卡结果，编造的 id 是**预期内输入**，
 * 让它炸掉整页反而是把编造变成了拒绝服务。丢弃是这条路径上的正确处置。
 */
function cardOf(id: string): VenueCard | null {
  try {
    const hit = knowledge.get(id);
    return {
      id: hit.id,
      title: hit.title,
      body: hit.content,
      // 出处直接透传存档卡 frontmatter 里的 sources（官方 URL 或本地存档副本路径），
      // 一个字不改写、不补充：这一块的全部价值就是"这句话是从哪儿抄来的"，
      // 我们替它润色一个来源，等于替官方签了字。
      sources: hit.sources,
      confidence: hit.confidence,
      updated: hit.updated,
    };
  } catch {
    return null;
  }
}

/**
 * 组一节仲裁地风格。
 * @param venue 案件的仲裁地，如「北京朝阳」
 * @param cardIds 选卡结果；不传则用北京朝阳的固定清单。索引里没有的 id 一律丢弃。
 */
export function venueSection(venue: string, cardIds?: string[]): VenueSection {
  if (!isCoveredVenue(venue)) {
    return { venue, covered: false, cards: [] };
  }
  const ids = cardIds ?? CHAOYANG_CARD_IDS;
  return {
    venue,
    covered: true,
    cards: ids.map(cardOf).filter((c): c is VenueCard => c !== null),
  };
}
