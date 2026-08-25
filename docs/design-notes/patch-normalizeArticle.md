# 修法补丁：normalizeArticle 跨数字体系 + 剥项/款（评测侧，判据版链在 15039bd 之上）

> 现状核对（15039bd 已落，**不用再做**）：`citationKey` 复合键 ✅；`normLaw` 全称↔简称
> 且明确拒绝包含匹配（防「劳动合同法」吃掉「劳动争议调解仲裁法」）✅。
> **仍缺**：条号跨数字体系互认 + 剥「第N项/第N款」后缀 —— 即 Bug B。

## 病灶

```ts
export function normalizeArticle(a: string): string {
  return a.replace(/[《》\s]/g, '').replace(/^.*?(第[一二三四五六七八九十百零〇0-9]+条)/, '$1');
}
```
- `^.*?(…)` 只把**前缀**替成 `$1`，**尾巴原样留着** → `第46条第2项` 归一后仍是 `第46条第2项`；
- 阿拉伯与汉字各存各的 → `第46条` ≠ `第四十六条`（卡里全是汉字）。

两者叠加：模型光秃引用核心条文 → 键对不上 → 判 **pending_card（库里没原文）** → **真挂被洗成"等卡"**。

## 补丁（替换 normalizeArticle，新增一个私有 helper）

```ts
/** 汉字数字 → 整数（覆盖 1–999：四十六=46、十九=19、二十=20、一百零八=108）。非法返回 null。 */
function cnNumeral(s: string): number | null {
  if (/^[0-9]+$/.test(s)) return Number(s);
  const D: Record<string, number> = { 〇: 0, 零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0;
  let section = 0;
  let seen = false;
  for (const ch of s) {
    if (ch in D) { section = D[ch]; seen = true; }
    else if (ch === '十') { total += (section || 1) * 10; section = 0; seen = true; }
    else if (ch === '百') { total += (section || 1) * 100; section = 0; seen = true; }
    else return null;
  }
  return seen ? total + section : null;
}

/**
 * 条号归一：统一成 `第<阿拉伯数字><条|问>`，**跨数字体系互认并剥掉「第N项/第N款」**。
 *
 * 【为什么必须跨数字体系】卡里一律存汉字（`第四十六条`），而模型惯写阿拉伯
 * （实测原话「《劳动合同法》第46条第2项」）。不互认 → 键对不上 →
 * 库里**明明有** 280 字原文的核心条文被判成 `pending_card`「等卡」，
 * **真挂被洗成 N/A**。这个方向是漏判：成绩单显示「0 光秃」，读起来像修法生效。
 *
 * 【为什么必须剥项/款】卡按「条」存原文，引用常带到项/款
 * （`bareArticleCitations` 的正则也会把「第2项」一起捕获）。不剥 → 同样对不上键。
 *
 * 【为什么保留单位】`第55问`（534号解答）与 `第55条` 不是一回事，单位不能丢。
 */
export function normalizeArticle(a: string): string {
  const flat = a.replace(/[《》\s]/g, '');
  // 【之N 必须进 key】第四十七条之一 与 第四十七条 是**两条不同的条文**（中文立法通例）。
  // 合并它们的错误方向与「短法名吞长法名」同族：不互认看得见（键对不上），
  // 张冠李戴看不见（拿甲条的原文去要求乙条）。库里目前无之N 型，但补卡一扩就会出现。
  const m = /第([0-9]+|[一二三四五六七八九十百零〇两]+)(条|问)(之([0-9]+|[一二三四五六七八九十]+))?/.exec(flat);
  if (!m) return flat;
  const n = cnNumeral(m[1]);
  const head = n === null ? `第${m[1]}${m[2]}` : `第${n}${m[2]}`;
  if (!m[4]) return head;
  const sub = cnNumeral(m[4]);
  return `${head}之${sub === null ? m[4] : sub}`;
}
```

**改动面**：只动 `normalizeArticle`（+1 个私有 helper）。`citationKey` / `normLaw` /
`quotedArticlesFromCards` / `classifyPending` 都经由它，**一处改、两侧同时生效**
（卡侧与引用侧共用同一个函数，天然不会再分叉）。

## 测试：`scratchpad/normalizeArticle.test.ts`（**24 个，全绿**）

正/反/边界三类齐：正（`第46条第2项`→`第46条`且≡`第四十六条`；`第四十六条第二款`→`第46条`）；
反（`第46条`≠`第四十七条`、`第4条`≠`第40条`、`第十条`≠`第十九条`、`第二十条`≠`第二条`）；
边界（空格/书名号、十位整十百位、`第55问`≠`第55条`、孤立`第2项`不误伤、
**之N 不与本条合并且之一≠之二**）。

## 落地后预期效果（本批实测数据）

| 清单条目 | 现状 | 补丁后 |
|---|---|---|
| 《劳动合同法》第46条第2项 | pending_card（假） | 匹配到 `劳动合同法\|第46条` → **FAIL 真挂** |
| 第40条（法域未知） | pending_card（假） | 匹配到 `第40条` → **FAIL 真挂**（法名仍需 nearestLaw 取到） |
| 《解答（一）》第73条 | pending_card | 仍 pending（库里 534 号存的是 `第N问`，确无 `第73条`）→ **真 pending，正确** |

⚠️ 所以补丁落地后 **「G4 机械 0 光秃」会变成非 0**——那不是退步，是**先前的 0 是虚的**。
