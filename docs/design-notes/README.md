# 设计过程记录（WS2 后台技术线，2026-08-22 ~ 08-25）

**这里是"为什么这么做"，代码是"做了什么"。** 多数文档对应的改动已落码；
保留它们是因为 **commit message 记得下结论，记不下当时否掉的那几个方案**。

## 为什么入库（判别依据，非重要性判断）

> **凡在会话级临时目录里产生的、被多方引用过的产物，必须在当次会话结束前入库。**
> **判别：如果它被第二个人引用过，它就不再是草稿。**

这条的好处是**不需要判断重要性**——"被第二个人引用过"是可观察的事实，
而重要性判断恰恰是反复失效的那种东西（"它在我脑子里的分类是报告不是代码"）。
**本目录按此通则全量入库，未做取舍**：取舍本身就是那个失效的动作。

## 状态说明（如实标注，不假装整齐）

- **多数已落码**：补丁稿类（`patch-*.md`）内容已进代码与 commit message，此处是过程留档；
- **少数是待办**：`alias-lexicon-spec.md`（别名词表主线）、`post-release-iter1-breakdown.md`
  （上线后迭代分解）、`s19-assertions-spec.md`（深会话剧本判据面）等尚未落地；
- **未整理**：无统一格式、无交叉索引、按时间自然生成。**先入库再整理——"存在"比"整齐"优先。**

## 主要文档

| 文档 | 内容 | 状态 |
|---|---|---|
| `charter-s5-draft.md` | charter §5/§7 改写（依 D14/D15 用户拍板） | 待落 |
| `empty-pack-directive-draft.md` | 空手感知指令措辞（含期限例外、EMPTY_PACK 指标） | 已落码 |
| `injection-observability-spec.md` | 注入产物可观测四字段（三态语义） | 已落码 |
| `s19-assertions-spec.md` | 深会话剧本判据面（跨轮断言形态） | 待落 |
| `proposal-first-consult-core-articles.md` | 首诊核心条来源（S1/S2/S3/S4 分层） | 已落码 |
| `emotion-trigger-and-geo-tax.md` | 情绪场景触发注入 + 地名税修法 | 待落 |
| `alias-lexicon-spec.md` | 「口语↔法言法语」别名词表（战略主线） | 待落 |
| `post-release-iter1-breakdown.md` | 上线后第一迭代窗工作分解 | 排期中 |
| `turnrecord-contract-change.md` | TurnRecord 契约变更（三态、双字段） | 已落码 |
| `fix-direction-memo.md` | 缺陷① 行为面修向（三缺陷 A/B/C） | 已落码 |
| `prep-defect6.md` | 危机轮零推销执法权移交（机械锚 112 轮实测） | 已落码 |
| `pending-cards-v2.md` | 补卡清单 v2（三节分流：外勤/WS4/存量候选） | 已交付 |

**教训与通则不在这里**，在 `docs/lessons/A系教训册.md`。
