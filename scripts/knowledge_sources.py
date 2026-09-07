#!/usr/bin/env python3
"""法源登记簿（knowledge/sources.json）的读写与机械核验的共用面。

三个消费者共用这一份：`fetch-source.py`（写登记簿）、`verify-quotes.py`（比引文）、
`gen-knowledge-index.py`（生成前的守卫）。**只有一份**是刻意的：
"这条引文算不算与原件一致"、"这个 host 算不算官方"是**同一件事**，
三处各写一份的形态是"抓取时认了、生成时不认"，而两边都不报错。

登记簿条目（knowledge/sources.json，顶层是数组）：

    {
      "source_id": "beijing-gongzi-zhifu-guiding",
      "kind": "地方规章",
      "name": "北京市工资支付规定",
      "issuer": "北京市人民政府",
      "official_host": "www.beijing.gov.cn",
      "url": "https://www.beijing.gov.cn/...",
      "fetched_at": "2026-09-07T12:00:00+08:00",
      "content_sha256": "…",
      "version_label": "2007年修订",
      "effective_from": "2007-11-01",       # 可选
      "status": "现行",
      "files": {"raw": "sources/originals/<id>/raw.html",
                "text": "sources/originals/<id>/text.txt"}
    }

`files` 的路径**相对 knowledge/**，与 index.json 的 `path` 同一口径。
`files.text` 允许为 null：PDF 在本机没有抽取依赖时只落 raw，等人另转（见 fetch-source.py）。
"""

from __future__ import annotations

import json
import re
import unicodedata
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

# ── 受控词表 ─────────────────────────────────────────────────────────────
KINDS = {
    "法律",
    "行政法规",
    "司法解释",
    "部门规章",
    "地方规章",
    "规范性文件",
    "官方案例",
    "官方数据",
    "行业规范",
    "机构官网",
}
STATUSES = {"现行", "已修正", "已废止"}
#: 行业规范：学会守则一类**规范文件**，一手源就是发布它的行业组织官网。
NON_GOV_KIND = "行业规范"
#: 机构官网（2026-09-07 经理裁定新增）：不是规范文件，是**一家机构在自己官网上讲自己的事**
#: ——热线号码、办公地址、自己的收费公示。它与"行业规范"必须分开，因为两者的可信范围不同：
#: 一份学会守则说的是行业该怎么做，一个机构的官网说的只是它自己。前者可以被任何卡当依据引，
#: 后者**只配给数据卡里那几个"打这个号码/去这个地址/这家收多少钱"的事实做出处**。
#: 混在一个 kind 里的形态是：某天一张法条卡拿某医院的科普文当法律依据，而 host 闸放行，
#: 因为那个 host 早就为了一条热线号码进过白名单。
INSTITUTION_KIND = "机构官网"
#: 这两类的一手源可以不在 .gov.cn 上（机构自己的官网），且必须在登记簿里写明。
NON_GOV_KINDS = frozenset({NON_GOV_KIND, INSTITUTION_KIND})
#: 机构官网条目只允许被这个 type 的卡引用（见 gen-knowledge-index.py 守卫 (g)）。
INSTITUTION_ONLY_CARD_TYPE = "数据卡"

REGISTRY_NAME = "sources.json"
ORIGINALS_DIR = "sources/originals"

# ── 归一 ────────────────────────────────────────────────────────────────
#: 引号族一律折成半角双引号：原件（PDF 抽出的直角引号、HTML 里的弯引号）与卡片
#: （编辑器自动配对的弯引号）在这一位上恒不一致，而它不是实质差异。
_QUOTE_FOLD = str.maketrans({c: '"' for c in "“”‘’「」『』〝〞＂"})
#: 归一后要整体删掉的字符：空白（含 NFKC 后仍在的）、markdown 强调/引用符。
_DROP = re.compile(r"[\s*_>`]")


def normalize_quote(text: str) -> str:
    """把「同一段条文的两种写法」折成同一个串，供子串判定。

    做四件事，缺一不可（每一条都是真实差异，不是防御性编程）：
    1. NFKC：全角括号/逗号/冒号/数字/字母 → 半角（PDF 抽出的常是全角，HTML 常是半角）；
       全角空格 U+3000 也在这一步变成普通空格。
    2. 引号族折成 `"`（见 _QUOTE_FOLD）。
    3. 删掉全部空白与 markdown 的 `*` `_` `>` `` ` ``：卡片正文里条文是加粗引用块，
       原件里是纯文本，差的全是这些。
    4. 不动 `。`『、』『；』这些中文标点——它们在两边都一样，折掉反而会让
       "第三款" 与 "第三项" 之外的真实差异更难看见。

    **不复用 gen-knowledge-index.py 里的 normalize()**：那一个管的是"卡片正文 ↔ 本卡
    facts 两面一致"，两面同出一人之手，弱归一就够；这一个管的是"卡片 ↔ 官方原件"，
    跨了排版体系。两把尺量的不是同一件事，共用会让其中一把变松。
    """
    s = unicodedata.normalize("NFKC", str(text))
    s = s.translate(_QUOTE_FOLD)
    return _DROP.sub("", s)


#: 少于这么多字的"共同前缀"不算锚点。
#: 【为什么不是 0】判据实测：引文「本条完全不在这份原件里出现过。」与一份毫不相干的原件
#: 也有 1 字前缀（"本"在"本单位"里），于是报告会说"前 1 字一致，第 2 字起分叉"，
#: 并印出原件里那个"本"字附近的一段——一句技术上为真、实际上把人引向错误方向的话。
#: 中文单字命中是必然事件，锚点必须是一个词组级别的长度。
MIN_ANCHOR = 8


def divergence(original: str, quote: str, window: int = 60) -> tuple[int, str, str]:
    """引文与原件在第几个字分叉，以及两边分叉处各是什么样。

    做法是二分"引文的多长前缀还能在原件里找到"——直接回答"从哪儿开始不一样了"，
    比给一段"最相近的片段"有用：后者要人自己用眼睛找差异。

    返回 (一致前缀长度, 原件片段, 卡内文本片段)。前缀短于 MIN_ANCHOR 时视为没锚上，
    印的是**原件开头**而不是那个偶然命中处——此时读者要判断的是"我是不是拿错了文件"，
    而原件开头正是回答这个问题的地方。
    """
    lo, hi = 0, len(quote)
    while lo < hi:
        mid = (lo + hi + 1) // 2
        if quote[:mid] in original:
            lo = mid
        else:
            hi = mid - 1
    n = lo
    if n < MIN_ANCHOR:
        return n, original[:window], quote[:window]
    pos = original.find(quote[:n])
    return n, original[max(0, pos + n - 10) : pos + n + window], quote[max(0, n - 10) : n + window]


# ── 登记簿 ──────────────────────────────────────────────────────────────
def registry_path(knowledge_dir: Path) -> Path:
    return knowledge_dir / REGISTRY_NAME


def load_registry(knowledge_dir: Path) -> list[dict[str, Any]]:
    """读登记簿；没有这个文件就是空登记簿（还没抓过任何原件）。

    格式坏了直接抛——一个"读不懂就当空的"的登记簿，会让白名单静默收紧成
    只剩 .gov.cn，而那一天所有行业规范卡会一起变成"非官方源"，且没有任何一处报错。
    """
    path = registry_path(knowledge_dir)
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise ValueError(f"{path} 不是合法 JSON：{e}") from e
    if not isinstance(data, list):
        raise ValueError(f"{path} 顶层应为数组（登记簿是条目列表），实际是 {type(data).__name__}")
    for e in data:
        for field in ("source_id", "kind", "name", "issuer", "official_host", "url", "content_sha256", "status", "files"):
            if field not in e:
                raise ValueError(f"{path} 条目缺字段 {field}：{json.dumps(e, ensure_ascii=False)[:120]}")
        # 机构官网是**唯一**一类"非 .gov.cn 且不是规范文件"的源，它凭什么算数只有一个答案：
        # 这家机构在讲它自己的事。那句话必须写下来（--justification），否则这个 kind 会变成
        # 一个"填了就能进白名单"的下拉框选项。
        if e["kind"] == INSTITUTION_KIND and not str(e.get("justification", "")).strip():
            raise ValueError(
                f"{path} 的 {e['source_id']} 是 kind={INSTITUTION_KIND} 却没有 justification："
                f"必须写明该机构与它自述信息的关系（如「12356 是该中心自己运行的热线，号码与服务时间由它自己公布」）。"
                f"用 scripts/fetch-source.py --kind {INSTITUTION_KIND} --issuer-host <host> --justification <说明> 重新登记。"
            )
    return data


def save_registry(knowledge_dir: Path, entries: list[dict[str, Any]]) -> None:
    entries = sorted(entries, key=lambda e: e["source_id"])
    registry_path(knowledge_dir).write_text(
        json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )


def by_id(entries: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    return {e["source_id"]: e for e in entries}


# ── host 白名单 ─────────────────────────────────────────────────────────
def extra_allowed_hosts(entries: list[dict[str, Any]]) -> set[str]:
    """登记簿里 kind∈{行业规范, 机构官网} 的机构官网 host——白名单在 .gov.cn 之外的唯一来源。

    刻意做成"必须先进登记簿才算数"：白名单若能在代码里随手加一行字符串，
    它迟早会长出 sohu.com。要加一个非 .gov.cn 的源，就得先真的抓一份原件下来。

    **进了这个白名单只是"能被引"，不等于"谁都能引"**：机构官网那批还要过
    gen-knowledge-index.py 的守卫 (g)（只有数据卡能引）。两道分开，是因为它们答的是
    不同的问题——host 闸问"这是不是一手源"，(g) 问"这份一手源能拿来断言什么"。
    """
    return {
        str(e.get("official_host", "")).lower().strip()
        for e in entries
        if e.get("kind") in NON_GOV_KINDS and e.get("official_host")
    }


def institution_hosts(entries: list[dict[str, Any]]) -> set[str]:
    """kind=机构官网 的 host 集合。引用它们的卡只能是数据卡（守卫 (g)）。"""
    return {
        str(e.get("official_host", "")).lower().strip()
        for e in entries
        if e.get("kind") == INSTITUTION_KIND and e.get("official_host")
    }


def institution_source_ids(entries: list[dict[str, Any]]) -> set[str]:
    """kind=机构官网 的 source_id 集合（facts 里按 source_id 指名原件的那条路）。"""
    return {str(e["source_id"]) for e in entries if e.get("kind") == INSTITUTION_KIND}


def host_of(url: str) -> str | None:
    try:
        u = urlparse(str(url))
    except ValueError:
        return None
    if u.scheme not in ("http", "https") or not u.hostname:
        return None
    return u.hostname.lower()


def is_official_host(host: str, extra: set[str]) -> bool:
    return host == "gov.cn" or host.endswith(".gov.cn") or host in extra


def check_source_url(url: str, extra: set[str]) -> str | None:
    """这个 source 能不能作为「原文核实」的出处。返回 None=可以，否则返回拒绝理由。"""
    host = host_of(url)
    if host is None:
        return f"不是 http(s) URL（散文出处、本地副本描述都不算机器可核的出处）：{str(url)[:60]}"
    if not is_official_host(host, extra):
        return (
            f"host「{host}」不是官方源：只认 .gov.cn，或登记簿里 "
            f"kind∈{{{NON_GOV_KIND}, {INSTITUTION_KIND}}} 的机构官网"
            f"（当前登记在册的有 {sorted(extra) or '无'}）"
        )
    return None


# ── 引文 ↔ 原件 ─────────────────────────────────────────────────────────
_MISSING = "找不到原件"
_MATCH = "一致"
_MISMATCH = "不一致"
QUOTE_STATES = (_MATCH, _MISMATCH, _MISSING)


def _names_match(registry_name: str, law: str) -> bool:
    a, b = normalize_quote(registry_name), normalize_quote(law)
    return bool(a) and bool(b) and (a in b or b in a)


def resolve_original(
    knowledge_dir: Path, entries: list[dict[str, Any]], quote: dict[str, Any]
) -> tuple[dict[str, Any] | None, str | None, str | None]:
    """给一条 statute_quote 找到它的原件正文。

    返回 (登记条目, 原件正文, 找不到的理由)；找到时理由为 None。
    优先 quote 自带的 `source_id`；没写就拿 `law` 去和登记簿的 `name` 互为子串匹配
    （"劳动合同法" ↔ "中华人民共和国劳动合同法"）。匹配到多条一律判为找不到，
    并要求写明 source_id——"随便挑一条"在这里等于随机选一个原件来核验。
    """
    sid = quote.get("source_id")
    if sid:
        entry = by_id(entries).get(str(sid))
        if entry is None:
            return None, None, f"登记簿里没有 source_id={sid}；先用 scripts/fetch-source.py 抓一份原件"
    else:
        law = str(quote.get("law", "")).strip()
        if not law:
            return None, None, "quote 既没有 source_id 也没有 law，无法定位原件"
        cands = [e for e in entries if _names_match(e["name"], law)]
        if not cands:
            return None, None, (
                f"登记簿里没有名称匹配「{law}」的原件；先用 scripts/fetch-source.py 抓一份，"
                f"或给这条 quote 补 source_id"
            )
        if len(cands) > 1:
            ids = "、".join(e["source_id"] for e in cands)
            return None, None, f"名称「{law}」同时匹配到 {ids}；请在 quote 上写明 source_id 消歧"
        entry = cands[0]
    rel = (entry.get("files") or {}).get("text")
    if not rel:
        return entry, None, (
            f"登记条目 {entry['source_id']} 只有原件 raw、没有 text："
            f"多半是 PDF 且本机没有抽取依赖。把纯文本写到 "
            f"{ORIGINALS_DIR}/{entry['source_id']}/text.txt 后重跑 fetch-source.py 即可登记"
        )
    path = knowledge_dir / rel
    if not path.exists():
        return entry, None, f"登记条目 {entry['source_id']} 指向的原件文本不存在：{path}"
    return entry, path.read_text(encoding="utf-8"), None


#: 引文的两种形态。共用同一套归一与三态判定——"这段字是不是逐字出自那份原件"是同一件事，
#: 两处各写一份的形态是"法条核得动、判例核不动"，而两边都不报错。
STATUTE_QUOTE = "statute_quotes"
CASE_QUOTE = "case_quotes"


def verify_quote(
    knowledge_dir: Path,
    entries: list[dict[str, Any]],
    card_id: str,
    card_path: str,
    quote: dict[str, Any],
    field: str = STATUTE_QUOTE,
) -> dict[str, Any]:
    """核一条引文。三态：一致 / 不一致 / 找不到原件。

    `field` 说这条引文来自 facts 的哪个字段：`statute_quotes`（法条逐字条文，可按 law 名
    匹配登记簿）或 `case_quotes`（判例卡摘的官方页原文，**必须写 source_id**）。
    判例没有"法名"这种可以互为子串匹配的东西——一句"第九个典型案例指出…"能匹上哪份原件，
    只有写卡的人知道；靠猜的形态是随机挑一份发布会通稿来核，且照样报"一致"。
    """
    law = str(quote.get("law", "") or quote.get("source_id", ""))
    article = str(quote.get("article", "") or quote.get("note", ""))
    text = str(quote.get("text", ""))
    row: dict[str, Any] = {
        "card_id": card_id,
        "path": card_path,
        "field": field,
        "law": law,
        "article": article,
        "source_id": quote.get("source_id"),
    }
    if field == CASE_QUOTE and not str(quote.get("source_id", "")).strip():
        row["state"] = _MISSING
        row["detail"] = (
            "case_quotes 缺 source_id：判例引文不能按名字猜原件（一句案例要旨匹不到任何"
            "「法名」，猜中的那份多半不是它）。先用 scripts/fetch-source.py 抓官方发布页，"
            "再把它的 source_id 写到这条 quote 上。"
        )
        return row
    entry, original, reason = resolve_original(knowledge_dir, entries, quote)
    if entry is not None:
        row["source_id"] = entry["source_id"]
    if original is None:
        row["state"] = _MISSING
        row["detail"] = reason
        return row
    q = normalize_quote(text)
    o = normalize_quote(original)
    if not q:
        row["state"] = _MISMATCH
        row["detail"] = "引文归一后是空串（text 只有排版符号？）"
        return row
    if q in o:
        row["state"] = _MATCH
        return row
    n, orig_frag, card_frag = divergence(o, q)
    row["state"] = _MISMATCH
    row["prefix_len"] = n
    row["card_excerpt"] = card_frag
    row["original_excerpt"] = orig_frag
    row["detail"] = (
        f"卡内文本前 {n} 字与原件一致，第 {n + 1} 字起分叉"
        if n >= MIN_ANCHOR
        else f"卡内文本在原件里锚不上（共同前缀只有 {n} 字，不足 {MIN_ANCHOR}）"
        f"——多半是认错了原件，不是抄错了字；下面印的是原件开头，先确认拿的是不是同一份文件"
    )
    return row


def verify_cards(
    knowledge_dir: Path, cards: list[tuple[str, str, list[dict[str, Any]]]], field: str = STATUTE_QUOTE
) -> list[dict[str, Any]]:
    """cards: [(card_id, 相对 knowledge/ 的 path, 该字段的引文列表)]"""
    entries = load_registry(knowledge_dir)
    rows = []
    for card_id, card_path, quotes in cards:
        for q in quotes:
            rows.append(verify_quote(knowledge_dir, entries, card_id, card_path, q, field))
    return rows


def format_rows(rows: list[dict[str, Any]]) -> str:
    """逐条报告。只印有问题的行——全绿时印 220 行"一致"没人会看。"""
    bad = [r for r in rows if r["state"] != _MATCH]
    out = []
    for r in bad:
        tag = "判例引文" if r.get("field") == CASE_QUOTE else "法条引文"
        out.append(f"[{r['state']}]（{tag}）{r['card_id']} · {r['law']}{r['article']}（{r['path']}）")
        out.append(f"    {r.get('detail', '')}")
        if r["state"] == _MISMATCH and "card_excerpt" in r:
            out.append(f"    卡内：{r['card_excerpt']}")
            out.append(f"    原件：{r['original_excerpt']}")
    ok = len(rows) - len(bad)
    out.append(
        f"合计 {len(rows)} 条引文：一致 {ok}，"
        f"不一致 {sum(1 for r in bad if r['state'] == _MISMATCH)}，"
        f"找不到原件 {sum(1 for r in bad if r['state'] == _MISSING)}"
    )
    return "\n".join(out)
