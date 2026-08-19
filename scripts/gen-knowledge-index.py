#!/usr/bin/env python3
"""从 knowledge/packs/**/*.md 的 frontmatter 再生成 knowledge/index.json。

用法：python3 scripts/gen-knowledge-index.py
校验：id 唯一、必填字段齐全、type/confidence 枚举合法；失败时报错并退出非零。
"""
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent / "knowledge"
TYPES = {"法条卡", "判例卡", "计算规则", "流程SOP", "文书模板", "话术卡", "情绪指南", "数据卡"}
CONFIDENCES = {"原文核实", "二手转述", "待核实"}
REQUIRED = ["id", "type", "title", "keywords", "applies_to", "sources", "confidence", "updated"]
INDEX_FIELDS = ["id", "type", "title", "keywords", "applies_to", "region", "confidence", "updated"]


def parse_frontmatter(text: str, path: Path) -> dict:
    m = re.match(r"\A---\n(.*?)\n---\n", text, re.DOTALL)
    if not m:
        sys.exit(f"错误：{path} 缺少 frontmatter")
    fm, key = {}, None
    for line in m.group(1).splitlines():
        if re.match(r"^\s*-\s+", line) and key:
            fm[key].append(line.split("-", 1)[1].strip())
        elif ":" in line:
            key, _, val = line.partition(":")
            key, val = key.strip(), val.strip()
            if val.startswith("[") and val.endswith("]"):
                fm[key] = [v.strip() for v in val[1:-1].split(",") if v.strip()]
            elif val == "":
                fm[key] = []
            else:
                fm[key] = val
    return fm


def main() -> None:
    entries, seen = [], {}
    for path in sorted(ROOT.glob("packs/**/*.md")):
        fm = parse_frontmatter(path.read_text(encoding="utf-8"), path)
        for field in REQUIRED:
            if field not in fm or fm[field] in ("", []):
                sys.exit(f"错误：{path} 缺少必填字段 {field}")
        if fm["type"] not in TYPES:
            sys.exit(f"错误：{path} type 非法：{fm['type']}")
        if fm["confidence"] not in CONFIDENCES:
            sys.exit(f"错误：{path} confidence 非法：{fm['confidence']}")
        if fm["id"] in seen:
            sys.exit(f"错误：id 重复 {fm['id']}：{seen[fm['id']]} 与 {path}")
        seen[fm["id"]] = path
        entry = {f: fm.get(f, "") for f in INDEX_FIELDS}
        entry["path"] = str(path.relative_to(ROOT))
        entries.append(entry)
    out = ROOT / "index.json"
    out.write_text(json.dumps(entries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"OK：{len(entries)} packs → {out}")


if __name__ == "__main__":
    main()
