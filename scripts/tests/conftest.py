"""扎根三件套（fetch-source / verify-quotes / gen-knowledge-index）的测试夹具。

运行：python3 -m pytest scripts/tests -q

【为什么要 load_script】三个 CLI 的文件名都带连字符，`import` 不了。
按仓内既有惯例（脚本名与命令名一致）不改名，测试这边用 importlib 按路径加载。
每个用例**重新加载一次**：gen-knowledge-index.py 的 ROOT 是模块级全局，
上一个用例把它指到自己的临时目录后不复位的话，下一个用例会在别人的库上跑——
而它会**照常通过**，只是验的不是自己那份数据（判据夹具绝对路径那类坑的同型）。
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest
import yaml

SCRIPTS = Path(__file__).resolve().parent.parent
REAL_KNOWLEDGE = SCRIPTS.parent / "knowledge"


def load_script(stem: str):
    """按路径加载 scripts/<stem>.py（文件名带连字符，import 不了）。"""
    path = SCRIPTS / f"{stem}.py"
    spec = importlib.util.spec_from_file_location(f"_script_{stem.replace('-', '_')}", path)
    assert spec and spec.loader
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


@pytest.fixture
def gen():
    return load_script("gen-knowledge-index")


@pytest.fixture
def fetch():
    return load_script("fetch-source")


@pytest.fixture
def verify():
    return load_script("verify-quotes")


@pytest.fixture
def audit():
    return load_script("audit-sources")


def write_card(
    root: Path,
    rel: str,
    *,
    card_id: str,
    confidence: str = "原文核实",
    sources: list[str] | None = None,
    quotes: list[dict] | None = None,
    case_quotes: list[dict] | None = None,
    body: str = "正文占位。",
    card_type: str = "法条卡",
) -> Path:
    """写一张合规的最小卡片。

    facts.statute_quotes / facts.case_quotes 的 text 会自动追加进正文——**卡内两面一致**
    是既有校验，与本轮要测的"卡片 ↔ 官方原件"是两件事，夹具不该在那里先绊倒。
    """
    fm: dict = {
        "id": card_id,
        "type": card_type,
        "title": f"测试卡 {card_id}",
        "keywords": ["测试"],
        "applies_to": ["欠薪"],
        "region": "全国",
        "sources": sources if sources is not None else ["https://flk.npc.gov.cn/detail.html?id=test"],
        "confidence": confidence,
        "updated": "2026-09-07",
    }
    text_blocks = ""
    facts: dict = {}
    if quotes:
        facts["statute_quotes"] = quotes
    if case_quotes:
        facts["case_quotes"] = case_quotes
    if facts:
        fm["facts"] = facts
        text_blocks = "\n\n" + "\n\n".join(
            f"> {q['text']}" for q in (list(quotes or []) + list(case_quotes or []))
        )
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        "---\n"
        + yaml.safe_dump(fm, allow_unicode=True, sort_keys=False)
        + "---\n\n"
        + body
        + text_blocks
        + "\n",
        encoding="utf-8",
    )
    return path


def write_original(root: Path, source_id: str, text: str, **overrides) -> dict:
    """在临时知识库里造一份"已抓取的原件"+ 登记簿条目。"""
    outdir = root / "sources" / "originals" / source_id
    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "raw.html").write_text(f"<html><body>{text}</body></html>", encoding="utf-8")
    (outdir / "text.txt").write_text(text, encoding="utf-8")
    entry = {
        "source_id": source_id,
        "kind": "法律",
        "name": overrides.pop("name", source_id),
        "issuer": "全国人民代表大会常务委员会",
        "official_host": "flk.npc.gov.cn",
        "url": f"https://flk.npc.gov.cn/detail.html?id={source_id}",
        "fetched_at": "2026-09-07T00:00:00+08:00",
        "content_sha256": "0" * 64,
        "version_label": "测试版",
        "status": "现行",
        "files": {
            "raw": f"sources/originals/{source_id}/raw.html",
            "text": f"sources/originals/{source_id}/text.txt",
        },
    }
    entry.update(overrides)
    return entry


def write_registry(root: Path, entries: list[dict]) -> None:
    import json

    (root / "sources.json").write_text(
        json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
