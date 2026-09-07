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

归一口径见 knowledge_sources.normalize_quote（NFKC + 引号折叠 + 去空白与 markdown 记号）。

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


def iter_cards(root: Path):
    """遍历 packs/ 下的卡，产出 (id, 相对路径, statute_quotes, case_quotes)。跳过隔离区。"""
    for path in sorted(root.glob("packs/**/*.md")):
        rel = path.relative_to(root)
        if "quarantine" in rel.parts:
            continue
        text = path.read_text(encoding="utf-8")
        m = re.match(r"\A---\n(.*?)\n---\n", text, re.DOTALL)
        if not m:
            continue
        fm_text = re.sub(
            r"^(title:\s*)(.+)$",
            lambda mm: mm.group(1) + json.dumps(mm.group(2).strip(), ensure_ascii=False),
            m.group(1),
            flags=re.M,
        )
        try:
            fm = yaml.safe_load(fm_text) or {}
        except yaml.YAMLError:
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
    cards = [c for c in iter_cards(root) if args.card is None or c[0] == args.card]
    if args.card and not cards:
        print(f"错误：没有 id={args.card} 的卡，或它既没有 statute_quotes 也没有 case_quotes", file=sys.stderr)
        return 2
    rows = ks.verify_cards(root, [(cid, rel, q) for cid, rel, q, _ in cards], ks.STATUTE_QUOTE)
    rows += ks.verify_cards(root, [(cid, rel, q) for cid, rel, _, q in cards], ks.CASE_QUOTE)
    mismatch = [r for r in rows if r["state"] == "不一致"]
    missing = [r for r in rows if r["state"] == "找不到原件"]

    if args.json:
        print(
            json.dumps(
                {
                    "total": len(rows),
                    "ok": len(rows) - len(mismatch) - len(missing),
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
    return 0


if __name__ == "__main__":
    sys.exit(main())
