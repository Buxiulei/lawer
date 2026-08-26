# forensics —— 产出过**已提交结论**的那几个一次性脚本

## 为什么它们在这里，而不在某个临时目录里

**它们本来就在临时目录里。** 2026-08-26 的多份成绩单里的数字，是这几个脚本跑出来的，
而脚本只存在于会话级 scratchpad（`/tmp/claude-1000/<session>/…`）——**一个到期即删、且别人搜不到的位置**。
同一天已经因此出过一次真实近失：S08 两跑的**底稿**只存在于一次性 worktree 里，删掉后
评测官全机 `find` 零命中（幸而删前拷过，但拷去的仍是会话临时目录）。

> **规矩（WS2 提，manager 2026-08-26 批准）：跑批产物的落点不许在一次性目录
> （worktree / scratchpad / 会话级临时目录）里。**
> 理由：**一次性目录的语义就是"到期即删"，把需要长期存在的东西产在那里，
> 等于让它的存活依赖于没有人执行那个语义。**
> 「跑完即归档」是第二道，不是第一道——**只归档不改落点，下次仍然靠人记得拷。**

**证据可以归档，产出证据的工具也要能被找到**：否则那些数字只能被相信，不能被重新推导。

## 每个脚本产出过哪条已提交的结论

| 脚本 | 产出 | 落在哪份已提交文档 |
|---|---|---|
| `gate-3way-replay.ts` | A/B/C 三版杠杆闸对同一份转录的处置（clean·stripped·fallback）+ 被剥原句 | `2026-08-26-S08两跑-成绩单.md` §二 |
| `assert-repro.ts` | 复现评测断言的假 L1，并**拆因子**（少传 userSaid vs 判定面）| 同上 §三 |
| `ship-check.ts` | 滚更包那棵树在两份真实转录上的处置（A=stripped / SHIP=clean）| 报 manager 的滚更包验收 |
| `card-occurrence-probe.ts` | 「整卡齐现」逐轮次数 vs 现行逐轮布尔口径 | `2026-08-26-S08两跑-成绩单.md` §四更正块、断代档断代点二 |
| `b1-replay-diff.mjs` | B-1 修前/修后逐轮 `added` 差异（新开火 16 / 失去开火 1 / 内容变 1 / 仅产物变 4）| `2026-08-26-B1保底渲染闸-成绩单.md` §二 |

## 怎么跑

```sh
sh scripts/eval/forensics/prepare-gates.sh            # 先把各版 crisis.ts 原样导出到 _gates/（零转写）
cd app
npx tsx ../scripts/eval/forensics/gate-3way-replay.ts <转录.json> <标签>
npx tsx ../scripts/eval/forensics/assert-repro.ts <转录.json> [更多…]
npx tsx ../scripts/eval/forensics/ship-check.ts <转录.json> [更多…]
npx tsx ../scripts/eval/forensics/card-occurrence-probe.ts <转录.json> [更多…]
node ../scripts/eval/forensics/b1-replay-diff.mjs <含 b1-before.json / b1-after.json 的目录>
```
`b1-replay-diff.mjs` 的两份输入由 `scripts/replay-render-fallback.ts --json` 在**修前/修后两棵树**上各产一次。

**转录底稿**：`/home/roots/caiyuan-ws/eval-evidence-archive/`（含 S08 两跑的抢救副本与校验和）。

## `_gates/` 为什么不入库

它是 `git show <SHA>:app/src/lib/agent/crisis.ts` 的**原样导出**，随时可重建，
入库反而制造第二个真源。`prepare-gates.sh` 把 SHA 写死在脚本里，**SHA 即版本声明**。

## 这些脚本的性质，要说清

**它们是取证工具，不是判据。** 判据在 `scripts/eval/assertions.ts` 与产线里，受两态样本约束；
这里的脚本只回答"当时那批数字是怎么来的"。**别把它们的输出当成新口径引用**——
尤其 `card-occurrence-probe.ts` 用的是"三号码出现次数取最小值"这个**粗略探针**，
它只为演示现行口径的盲区而写，**不是提议中的 `cardOccurrences` 实现**。

## 为什么本目录被 `app/tsconfig.json` 排除在 tsc 之外

这几个脚本 `import './_gates/gateX'`，而 `_gates/` 是 `prepare-gates.sh` 现场生成、**不入库**的。
**新克隆上 tsc 会因此报 6 条 `TS2307`**——我落库前先把 `_gates/` 挪开跑了一遍，**确认它真的会红，不是推断**。
所以在 `tsconfig.json` 的 `exclude` 里加了本目录。

**代价要说清，别让它看起来是免费的**：**本目录不受 tsc 保护**。
产线接口一旦改名，这些脚本会在**跑的时候**才报错，而不是在编译时。
这是有意的取舍——它们是取证工具，**用途是回答"当年那批数字怎么来的"，
所以它们本来就应该跟着当年的接口，而不是跟着今天的接口漂**。
真要跑不起来了，去 `prepare-gates.sh` 里那几个 SHA 对应的树上跑。
