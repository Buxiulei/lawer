#!/usr/bin/env python3
"""从 knowledge/packs/**/*.md 的 frontmatter 再生成 knowledge/index.json。

用法：python3 scripts/gen-knowledge-index.py
校验：id 唯一、必填字段齐全、type/confidence 枚举合法；
facts 两面一致性（规范 §2.1）：values/hotlines 的数值与号码必须出现在本卡正文、
statute_quotes.text 必须与正文逐字一致（空白归一）、facts key 全库唯一、
status=forbidden 的号码不得出现在其他任何卡正文。失败即退出非零（构建即断）。
"""
import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent / "knowledge"
TYPES = {"法条卡", "判例卡", "计算规则", "流程SOP", "文书模板", "话术卡", "情绪指南", "数据卡", "审查规则", "方法卡"}
CONFIDENCES = {"原文核实", "二手转述", "待核实"}
REQUIRED = ["id", "type", "title", "keywords", "applies_to", "sources", "confidence", "updated"]
INDEX_FIELDS = ["id", "type", "title", "keywords", "applies_to", "region", "confidence", "updated"]


def die(msg: str) -> None:
    sys.exit(f"错误：{msg}")


def normalize(text: str) -> str:
    """正文归一：去空白/引用符/加粗符/全角空格/千分位逗号，供两面一致性比对。"""
    return re.sub(r"[\s>＞*　]|(?<=\d)[,，](?=\d)", "", text)


def parse(path: Path) -> tuple[dict, str]:
    text = path.read_text(encoding="utf-8")
    m = re.match(r"\A---\n(.*?)\n---\n(.*)", text, re.DOTALL)
    if not m:
        die(f"{path} 缺少 frontmatter")
    # title 可能以半角引号开头（如 title: "工资异议期"条款无效…），会让 YAML 误判为带引号
    # 标量；统一把 title 值整体转义成合法 YAML 字符串再解析。
    fm_text = re.sub(
        r"^(title:\s*)(.+)$",
        lambda mm: mm.group(1) + json.dumps(mm.group(2).strip(), ensure_ascii=False),
        m.group(1),
        flags=re.M,
    )
    try:
        fm = yaml.safe_load(fm_text)
    except yaml.YAMLError as e:
        die(f"{path} frontmatter YAML 解析失败：{e}")
    return fm, m.group(2)


def check_facts(path: Path, fm: dict, body_norm: str, seen_keys: dict) -> None:
    facts = fm.get("facts") or {}
    for v in facts.get("values", []):
        for field in ("key", "value", "unit", "effective_from", "confidence", "source_idx"):
            if field not in v:
                die(f"{path} facts.values 缺字段 {field}：{v}")
        if v["key"] in seen_keys:
            die(f"facts key 重复：{v['key']}（{seen_keys[v['key']]} 与 {path}）")
        seen_keys[v["key"]] = path
        if v["confidence"] not in CONFIDENCES:
            die(f"{path} facts.values[{v['key']}].confidence 非法：{v['confidence']}")
        if not 0 <= int(v["source_idx"]) < len(fm.get("sources", [])):
            die(f"{path} facts.values[{v['key']}].source_idx 越界")
        num = str(v["value"])
        if num not in body_norm:
            die(f"{path} facts 数值 {v['key']}={num} 未出现在正文（两面不一致）")
    for h in facts.get("hotlines", []):
        for field in ("name", "phone", "category", "status"):
            if field not in h:
                die(f"{path} facts.hotlines 缺字段 {field}：{h}")
        if h["status"] not in ("usable", "forbidden"):
            die(f"{path} hotlines status 非法：{h['status']}")
        if h["category"] not in ("crisis", "legal", "union", "inspection"):
            die(f"{path} hotlines category 非法：{h['category']}")
        if "note" in h:
            die(f"{path} hotlines[{h['phone']}] 使用已废弃的混受众字段 note——拆为 dial_hint（用户向）/agent_note（内部向）")
        if h["status"] == "usable" and not h.get("dial_hint"):
            die(f"{path} hotlines[{h['phone']}] status=usable 但缺 dial_hint（用户向拨打提示必填）")
        if any(w in str(h.get("hours", "")) for w in ("核验", "待核实", "官网载", "存疑")):
            die(f"{path} hotlines[{h['phone']}].hours 含内部词——核验状态进 agent_note，hours 只放纯服务时间")
        if normalize(h["phone"]) not in body_norm:
            die(f"{path} facts 号码 {h['phone']} 未出现在正文（两面不一致）")
    for r in facts.get("review_rules", []):
        for field in ("id", "severity", "title", "pattern_hint", "basis", "suggestion"):
            if field not in r or not r[field]:
                die(f"{path} review_rules 缺字段 {field}：{r.get('id', r)}")
        if r["severity"] not in ("must", "strong", "suggest"):
            die(f"{path} review_rules[{r['id']}].severity 非法：{r['severity']}")
        if r["id"] in seen_keys:
            die(f"review_rules id 重复：{r['id']}（{seen_keys[r['id']]} 与 {path}）")
        seen_keys[r["id"]] = path
        law_refs = fm.get("law_refs") or []
        for ref in re.split(r"[；;、]", str(r["basis"])):
            ref = ref.strip()
            if ref and not any(ref in str(lr) or str(lr) in ref for lr in law_refs):
                die(f"{path} review_rules[{r['id']}].basis「{ref}」在 law_refs 中无对应条目")
    SCENES = {"仲裁立案", "一审起诉", "二审上诉", "执行申请"}
    cf = facts.get("case_facts")
    if cf:
        for k, v in cf.items():
            if k not in ("case_no", "court", "judged_at", "gist", "issue", "holding", "reasoning"):
                die(f"{path} case_facts 含未知字段 {k}")
            if v and normalize(str(v)) not in body_norm:
                die(f"{path} case_facts.{k} 值未出现在正文（两面不一致）：{str(v)[:40]}")
    for a in facts.get("addresses", []):
        for field in ("name", "scene", "address", "status"):
            if field not in a or not a[field]:
                die(f"{path} facts.addresses 缺字段 {field}：{a}")
        if a["status"] not in ("usable", "unverified"):
            die(f"{path} addresses status 非法：{a['status']}")
        scenes = a["scene"] if isinstance(a["scene"], list) else [a["scene"]]
        for s in scenes:
            if s not in SCENES:
                die(f"{path} addresses[{a['name']}].scene 非法：{s}（受控集 {SCENES}）")
        if normalize(str(a["address"])) not in body_norm:
            die(f"{path} facts 地址「{a['address']}」未出现在正文（两面不一致）")
    for q in facts.get("statute_quotes", []):
        for field in ("law", "article", "text"):
            if field not in q:
                die(f"{path} facts.statute_quotes 缺字段 {field}：{q}")
        if normalize(q["text"]) not in body_norm:
            die(f"{path} statute_quotes {q['article']} 与正文不逐字一致")


def main() -> None:
    entries, seen_ids, seen_keys, forbidden = [], {}, {}, []
    bodies = {}
    for path in sorted(ROOT.glob("packs/**/*.md")):
        fm, body = parse(path)
        for field in REQUIRED:
            if field not in fm or fm[field] in ("", [], None):
                die(f"{path} 缺少必填字段 {field}")
        if fm["type"] not in TYPES:
            die(f"{path} type 非法：{fm['type']}")
        if fm["confidence"] not in CONFIDENCES:
            die(f"{path} confidence 非法：{fm['confidence']}")
        if fm["id"] in seen_ids:
            die(f"id 重复 {fm['id']}：{seen_ids[fm['id']]} 与 {path}")
        seen_ids[fm["id"]] = path
        body_norm = normalize(body)
        bodies[path] = body_norm
        check_facts(path, fm, body_norm, seen_keys)
        for h in (fm.get("facts") or {}).get("hotlines", []):
            if h["status"] == "forbidden":
                forbidden.append((normalize(h["phone"]), path))
        entry = {f: str(fm.get(f, "")) if f == "updated" else fm.get(f, "") for f in INDEX_FIELDS}
        entry["path"] = str(path.relative_to(ROOT))
        if fm.get("facts"):
            entry["facts"] = fm["facts"]
        entries.append(entry)
    # forbidden 号码不得出现在其他卡正文（登记它的资源卡本身除外）
    for phone, home in forbidden:
        for path, body_norm in bodies.items():
            if path != home and phone in body_norm:
                die(f"禁用号码 {phone} 出现在 {path}（仅允许存在于 {home}）")
    out = ROOT / "index.json"
    out.write_text(json.dumps(entries, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    print(f"OK：{len(entries)} packs → {out}（facts 卡 {sum(1 for e in entries if 'facts' in e)} 张，facts 校验通过）")


if __name__ == "__main__":
    main()
