#!/usr/bin/env python3
"""登记簿同源审计：`knowledge/sources.json` 的每一条，raw / text / 元数据是不是同一份文件。

用法：

    python3 scripts/audit-sources.py            # 全库，逐条报告，有红即非零退出
    python3 scripts/audit-sources.py --json     # 机器可读，退出码不变
    python3 scripts/audit-sources.py --source-id <id>   # 只审一条

【它防的是哪一种失效】verify-quotes 只读 `files.text`，gen-knowledge-index 只看 host。
两者都**默认** text 是从 raw 抽出来的、raw 是从 url 抓下来的。这个默认一旦不成立，
整条链子照常全绿：

    2026-09-07 实见：statute-gerensuodeshuifa 的 raw 是 flk.npc.gov.cn 的 552 字节
    SPA 空壳（`<div id="app"></div>`，正文由 JS 渲染），text 是从 chinatax.gov.cn
    另外抓来的正文，被人工写进 text.txt。登记簿里 url、sha256、fetched_at 一应俱全，
    verify-quotes 判「一致」——一致于一份**没人登记过、也没人核过来源**的文件。

所以这里做的四件事，每一件都对着这条链子的一节：

  ① sha256 复算：`files.raw` 的字节哈希必须等于 `content_sha256`
     （挡"原件被换过/被改过，登记簿还是旧哈希"）。
  ② 空壳判定：raw 很小且带着 SPA 骨架标记 ⇒ 这不是正文，是个壳
     （挡"抓了个 JS 站的首页当原件"）。
  ③ text 复算：用 **fetch-source.py 同一个抽取器**从 raw 重抽一遍，
     归一后 text.txt 必须等于重抽结果、或是它的子串
     （挡"text 与 raw 无对应关系"，即上面那个真实事故）。
  ④ needs_text：抽不出文本的条目由 fetch-source 标 `needs_text: true`，
     这里一律判红——"还没抽出正文"与"抽出来了"不能在退出码上长得一样。

【为什么③只对一部分 ext 真的复算】只有**不依赖任何第三方库**就能重抽的格式
（html/htm/xml/txt/docx）才复算。pdf 要 pypdf、xls/zip 里的 .doc 要 LibreOffice——
这些依赖装没装因机器而异，跟着变的审计结论比没有审计更坏（同一份库，这台机器红、
那台机器绿，人只会挑绿的那台）。不复算的条目**逐条印出来并计数**，不静默放过；
它们仍要过 ①②④ 与下面这条对所有格式都成立的量级判据：

  ⑤ 量级：text 的字符数不得超过 raw 的字节数。压缩件（docx/pdf/zip）与网页抽出的正文
     恒小于原件本身；反过来只可能是 text 与 raw 不是一回事——上面那条 552 字节 raw
     配 23874 字 text 的记录，正是被这条抓住的第二重保险。

【与 verify-quotes 的分工】那个问"卡里这句话是不是原件里的话"，这个问"这份原件是不是
它自称的那份文件"。两把尺量的不是一件事，缺哪一把，另一把量出来的都可能是好看的假数。
"""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
import knowledge_sources as ks  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent / "knowledge"

#: 不依赖第三方库就能重抽的原件格式。**这份名单是审计的量程**：
#: 名单内的条目复算不过即红，名单外的条目只报"未复算"。
#: pdf 不在名单里不是遗漏——pypdf 装没装因机器而异，而且实测同一份 PDF 在两个 pypdf
#: 版本下抽出的文本不同（页码被插进正文），拿它当判据等于让审计结论随环境漂。
DERIVABLE_EXTS = {"html", "htm", "xml", "txt", "docx"}

#: 空壳判定：小于这个字节数**且**带着下面任一标记，就是个由 JS 渲染的壳，不是正文。
#: 2KB 这个数不是拍的：本库 96 份原件里最小的正文件是 22KB，而 flk 的空壳是 552 字节，
#: 中间隔着一个数量级。
SHELL_MAX_BYTES = 2048
SHELL_MARKS = ('id="app"', "id='app'", 'id="root"', "id='root'", "<div id=app")


def _load_fetch_source():
    """按路径加载 scripts/fetch-source.py（文件名带连字符，import 不了）。

    **必须是同一个抽取器**：另写一份"差不多的"HTML 抽取，会让审计在一堆排版差异上报红，
    然后没人再看它的输出——而真正的病（text 与 raw 无关）淹没在噪音里。
    """
    path = Path(__file__).resolve().parent / "fetch-source.py"
    spec = importlib.util.spec_from_file_location("_fetch_source_for_audit", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


def _ext_of(rel_raw: str) -> str:
    return Path(rel_raw).suffix.lower().lstrip(".")


def audit_entry(root: Path, entry: dict[str, Any], fetch: Any) -> dict[str, Any]:
    """审一条登记。返回 {source_id, problems: [...], derived: 一致|未复算, ...}。"""
    sid = str(entry.get("source_id", "?"))
    row: dict[str, Any] = {"source_id": sid, "problems": [], "derived": None}
    problems: list[str] = row["problems"]
    files = entry.get("files") or {}
    rel_raw, rel_text = files.get("raw"), files.get("text")

    # ── 元数据自洽 ──────────────────────────────────────────────────────
    if entry.get("kind") not in ks.KINDS:
        problems.append(f"kind 非受控词：{entry.get('kind')}（受控集 {sorted(ks.KINDS)}）")
    if entry.get("status") not in ks.STATUSES:
        problems.append(f"status 非受控词：{entry.get('status')}")
    url_host = ks.host_of(str(entry.get("url", "")))
    if url_host is None:
        problems.append(f"url 不是 http(s)：{str(entry.get('url'))[:80]}")
    elif url_host != str(entry.get("official_host", "")).lower():
        problems.append(
            f"official_host「{entry.get('official_host')}」与 url 的 host「{url_host}」不一致"
            "——登记簿说的和它自己写的 url 说的不是同一个站"
        )

    if not rel_raw:
        problems.append("files.raw 为空：这条登记没有原件")
        return row
    raw_path = root / rel_raw
    if not raw_path.exists():
        problems.append(f"原件不存在：{raw_path}")
        return row
    raw = raw_path.read_bytes()

    # ── ① sha256 复算 ───────────────────────────────────────────────────
    sha = hashlib.sha256(raw).hexdigest()
    row["bytes"] = len(raw)
    if sha != str(entry.get("content_sha256", "")):
        problems.append(
            f"sha256 对不上：登记 {str(entry.get('content_sha256'))[:12]}…，"
            f"盘上 {sha[:12]}…（原件被换过或被改过；重跑 fetch-source.py 重抓）"
        )

    # ── ② 空壳判定 ──────────────────────────────────────────────────────
    head = raw[:SHELL_MAX_BYTES].decode("utf-8", "replace")
    if len(raw) < SHELL_MAX_BYTES and any(mark in head for mark in SHELL_MARKS):
        problems.append(
            f"raw 是 SPA 空壳（{len(raw)} 字节且含 {next(m for m in SHELL_MARKS if m in head)}）："
            "正文由 JS 渲染，这份存档里一个字的正文都没有。"
            "换一个服务端就渲染出正文的官方页面（同一文件的 HTML/DOCX 版）重抓"
        )

    # ── ④ needs_text ───────────────────────────────────────────────────
    if entry.get("needs_text"):
        problems.append(
            "needs_text=true：抽不出正文的条目，在换到抽得动的官方 URL 之前不算数"
            "（引用它的卡会被 verify-quotes 判「找不到原件」）"
        )
        if rel_text:
            problems.append("needs_text=true 却同时登记了 files.text——两句话互相矛盾，必有一句是假的")
        return row

    if not rel_text:
        problems.append(
            "files.text 为 null 却没标 needs_text：无从判断这条是「还没抽」还是「抽过了忘了登记」。"
            "重跑 fetch-source.py 让它自己写这两个字段"
        )
        return row
    text_path = root / rel_text
    if not text_path.exists():
        problems.append(f"正文不存在：{text_path}")
        return row
    stored = text_path.read_text(encoding="utf-8")
    row["text_chars"] = len(stored)

    # ── ⑤ 量级 ─────────────────────────────────────────────────────────
    if len(stored) > len(raw):
        problems.append(
            f"text 比 raw 还大（{len(stored)} 字 vs {len(raw)} 字节）："
            "抽出来的正文不可能比它的原件长，这两个文件多半不是一回事"
        )

    # ── ③ text 复算 ────────────────────────────────────────────────────
    ext = _ext_of(rel_raw)
    if ext not in DERIVABLE_EXTS:
        row["derived"] = "未复算"
        row["derived_reason"] = f"{ext or '无扩展名'} 的抽取需要外部依赖，本脚本不引入（见 DERIVABLE_EXTS 注释）"
        return row
    extracted = fetch.extract_text(raw, ext, "")
    if not extracted:
        problems.append(f"用 fetch-source 的抽取器从 raw 抽不出任何文本，但登记簿里有 text.txt（{len(stored)} 字）")
        return row
    a, b = ks.normalize_quote(extracted), ks.normalize_quote(stored)
    if b in a:
        row["derived"] = "一致"
        return row
    n, orig_frag, card_frag = ks.divergence(a, b)
    row["derived"] = "不一致"
    row["prefix_len"] = n
    problems.append(
        f"text.txt 不是从这份 raw 抽出来的："
        + (
            f"前 {n} 字与重抽结果一致，第 {n + 1} 字起分叉"
            if n >= ks.MIN_ANCHOR
            else f"与重抽结果锚不上（共同前缀只有 {n} 字，不足 {ks.MIN_ANCHOR}）——多半是两份不同的文件"
        )
        + f"\n      重抽：{orig_frag[:80]}\n      登记：{card_frag[:80]}"
    )
    return row


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="登记簿 knowledge/sources.json 的同源审计")
    p.add_argument("--knowledge-dir", default=None, help="默认仓内 knowledge/；测试用")
    p.add_argument("--source-id", default=None, help="只审这一条")
    p.add_argument("--json", action="store_true", help="输出 JSON（逐条 + 汇总），退出码不变")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.knowledge_dir).resolve() if args.knowledge_dir else ROOT
    entries = ks.load_registry(root)
    if args.source_id:
        entries = [e for e in entries if e.get("source_id") == args.source_id]
        if not entries:
            print(f"错误：登记簿里没有 source_id={args.source_id}", file=sys.stderr)
            return 2

    fetch = _load_fetch_source()
    rows = [audit_entry(root, e, fetch) for e in entries]
    bad = [r for r in rows if r["problems"]]
    underived = [r for r in rows if r["derived"] == "未复算"]

    if args.json:
        print(json.dumps({"total": len(rows), "bad": len(bad), "underived": len(underived), "rows": rows},
                         ensure_ascii=False, indent=2))
    else:
        for r in bad:
            print(f"[红] {r['source_id']}")
            for msg in r["problems"]:
                print(f"    · {msg}")
        if underived:
            # 【为什么绿的时候也要印】"没复算"与"复算过了"在退出码上长得一样，
            # 唯一的区别只能是这几行。静默放过它们，等于把量程外的东西说成量过了。
            print(f"未复算（抽取需外部依赖，本脚本量程之外）：{len(underived)} 条")
            for r in underived:
                print(f"    · {r['source_id']}：{r['derived_reason']}"
                      f"（raw {r.get('bytes')} 字节 → text {r.get('text_chars')} 字，已过 sha256/空壳/量级三关）")
        ok = sum(1 for r in rows if r["derived"] == "一致")
        print(f"合计 {len(rows)} 条登记：复算一致 {ok}，未复算 {len(underived)}，有问题 {len(bad)}")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
