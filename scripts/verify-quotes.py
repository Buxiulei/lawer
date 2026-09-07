#!/usr/bin/env python3
"""把卡片里的 facts.statute_quotes 与 facts.case_quotes 逐条拿去和登记在册的官方原件比对。

用法：

    python3 scripts/verify-quotes.py                  # 全库，逐条报告，有问题即非零退出
    python3 scripts/verify-quotes.py --json           # 机器可读，同样的退出码
    python3 scripts/verify-quotes.py --card statute-x # 只核一张卡
    python3 scripts/verify-quotes.py --allow-missing  # 「找不到原件」只警告不算失败（核实作业期间）

三态，缺一不可：

  一致        引文归一后是原件的子串。
  不一致      找到了原件，但对不上——报告会指出**第几个字开始分叉**，并把两边
              分叉处各印一段。（"给一段最相近的片段"要人自己用眼睛找差异，没用。）
  找不到原件  登记簿里没有这条 quote 指向的原件（或只有 raw 没有 text）。
              **这一态必须与"一致"分开**：把它算作通过，等于"没核过"和"核过了"
              在退出码上长得一模一样——而知识库最危险的失效形态正是这种。

归一口径见 knowledge_sources.normalize_quote（NFKC + 去空白与 markdown 记号；
**引号字形一律不折**——全角 “ ” 与半角 " 在这把尺子下不是同一个字）。
生成器 gen-knowledge-index.py 用的是同一个函数，不另立一把尺。

**两种引文共用同一把尺**（`facts.statute_quotes` 法条逐字条文、`facts.case_quotes`
判例卡从官方页摘的原文）："这段字是不是逐字出自那份原件"是同一件事。唯一的区别是
case_quotes **必须写 source_id**：判例没有"法名"这种能互为子串匹配的东西，
靠 law 名去猜的形态是随机挑一份发布会通稿来核，并且照样报「一致」。
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import knowledge_sources as ks  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent / "knowledge"


def iter_cards(root: Path, broken: list[str] | None = None):
    """遍历 packs/ 下的卡，产出 (id, 相对路径, statute_quotes, case_quotes)。跳过隔离区。

    @param broken 前言 YAML 解析不了的卡，路径与错因追加到这个列表里。

    【为什么解析不了不能静默跳过】这张卡的 facts 里可能写着十条引文。前言坏掉时
    `continue` 的形态是：它一条都不核，而报告里**没有它的任何一行**——
    "这张卡全绿"与"这张卡压根没被核过"在输出上一模一样，退出码还是 0。
    改坏一个缩进就能让一整包卡悄悄退出核验，这正是本工具最该拦的那种失效。
    所以坏卡算**错误**，由调用方计入退出码（不是警告：警告在 CI 里没人看）。
    """
    for path in sorted(root.glob("packs/**/*.md")):
        rel = path.relative_to(root)
        if "quarantine" in rel.parts:
            continue
        text = path.read_text(encoding="utf-8")
        m = re.match(r"\A---\n(.*?)\n---\n", text, re.DOTALL)
        if not m:
            # 没有前言 = 这不是一张卡（README、说明文件都长这样），不是"卡坏了"
            continue
        fm_text = re.sub(
            r"^(title:\s*)(.+)$",
            lambda mm: mm.group(1) + json.dumps(mm.group(2).strip(), ensure_ascii=False),
            m.group(1),
            flags=re.M,
        )
        try:
            fm = yaml.safe_load(fm_text) or {}
        except yaml.YAMLError as e:
            if broken is not None:
                broken.append(f"  · {rel}：前言 YAML 解析失败（{type(e).__name__}: {e}）")
            continue
        if not isinstance(fm, dict):
            # 前言解析成了字符串/列表：facts 一定取不到，与解析失败是同一种失效
            if broken is not None:
                broken.append(f"  · {rel}：前言不是一张 YAML 映射（解析成了 {type(fm).__name__}）")
            continue
        facts = fm.get("facts") or {}
        statutes = facts.get("statute_quotes") or []
        cases = facts.get("case_quotes") or []
        if statutes or cases:
            yield str(fm.get("id", rel)), str(rel), statutes, cases


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="卡片引文 ↔ 官方原件的机械核验")
    p.add_argument("--knowledge-dir", default=None, help="默认仓内 knowledge/；测试用")
    p.add_argument("--card", default=None, help="只核这张卡的 id")
    p.add_argument("--json", action="store_true", help="输出 JSON（逐条 + 汇总），退出码不变")
    p.add_argument(
        "--allow-missing",
        action="store_true",
        help="「找不到原件」降为警告（核实作业期间用；「不一致」永远算失败）",
    )
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.knowledge_dir).resolve() if args.knowledge_dir else ROOT
    broken: list[str] = []
    cards = [c for c in iter_cards(root, broken) if args.card is None or c[0] == args.card]
    if broken:
        print(
            "\n".join(
                ["错误：下列卡片的前言读不了，它们的引文一条都没有被核："]
                + broken
                + ["修好前言再跑；在此之前本轮的「一致」只覆盖读得了的那些卡。"]
            ),
            file=sys.stderr,
        )
    if args.card and not cards:
        print(f"错误：没有 id={args.card} 的卡，或它既没有 statute_quotes 也没有 case_quotes", file=sys.stderr)
        return 2
    rows = ks.verify_cards(root, [(cid, rel, q) for cid, rel, q, _ in cards], ks.STATUTE_QUOTE)
    rows += ks.verify_cards(root, [(cid, rel, q) for cid, rel, _, q in cards], ks.CASE_QUOTE)

    # 【显式豁免】带 GROUNDING_PENDING 的目录：**照常核、照常印**，只是不参与成败判定。
    # 不是"跳过不核"——跳过的话，那一包欠了多少账在报告里与"它全绿"长得一模一样。
    # 到期即失效（ks.expired_pending），那天起这批行重新算数。
    pending = ks.load_pending(root)
    expired = ks.expired_pending(pending)
    if expired:
        print("\n".join(["错误：扎根守卫的豁免已过期，本轮不再豁免。"] + expired), file=sys.stderr)
    for r in rows:
        r["pending"] = None if expired else ks.pending_for(r["path"], pending)
    counted = [r for r in rows if not r["pending"]]
    if pending and not expired:
        n = len(rows) - len(counted)
        print(
            f"警告：其中 {n} 条来自带 {ks.GROUNDING_PENDING} 的目录"
            f"（{ '、'.join(f'{d}，最迟 {i["until"]}' for d, i in sorted(pending.items())) }），"
            f"照常核、照常印，但不计入退出码。",
            file=sys.stderr,
        )
    mismatch = [r for r in counted if r["state"] == "不一致"]
    missing = [r for r in counted if r["state"] == "找不到原件"]

    if args.json:
        print(
            json.dumps(
                {
                    "total": len(rows),
                    "counted": len(counted),
                    "ok": len([r for r in rows if r["state"] == "一致"]),
                    "mismatch": len(mismatch),
                    "missing": len(missing),
                    "allow_missing": args.allow_missing,
                    "rows": rows,
                },
                ensure_ascii=False,
                indent=2,
            )
        )
    else:
        print(ks.format_rows(rows))

    if mismatch:
        return 1
    if missing and not args.allow_missing:
        return 1
    # 【读不了的卡照样算失败】它们没有出现在上面任何一类里——不一致、找不到原件都轮不到它们，
    # 因为它们根本没被核。不在这里返回非零的形态是：一包卡的前言全坏掉，报告照常印
    # "一致 N 条"、退出码 0，而 N 里一条都不是那包卡的。
    if broken:
        return 1
    # 【豁免过期无条件判红，与 gen-knowledge-index.py 同一口径】上面只是把这些行重新计入，
    # 而"重新计入之后恰好全都一致"是常态（欠的是原件登记，不是引文对不上）。
    # 于是过期那天报告里印着一行错误、退出码却是 0——CI 绿着，没有人会去读那一行。
    # 到期即恢复全部守卫这件事，只有退出码说了才算数。
    if expired:
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
