#!/usr/bin/env python3
"""从 knowledge/packs/**/*.md 的 frontmatter 再生成 knowledge/index.json。

用法：python3 scripts/gen-knowledge-index.py [--no-strict] [--knowledge-dir DIR]
校验：id 唯一、必填字段齐全、type/confidence 枚举合法；
facts 两面一致性（规范 §2.1）：values/hotlines 的数值与号码必须出现在本卡正文、
statute_quotes.text 必须与正文逐字一致（空白归一）、facts key 全库唯一、
status=forbidden 的号码不得出现在其他任何卡正文。失败即退出非零（构建即断）。

【扎根守卫（主理人 2026-09-07 裁决：知识库里不允许「二手转述」「待核实」）】
在上面那批"卡片自洽"的校验之外，另有几道守卫管"卡片与外部世界一致"：
  (b) confidence=原文核实 的卡，每一条 source 都必须是官方 host
      （.gov.cn，或登记簿 knowledge/sources.json 里 kind∈{行业规范, 机构官网} 的机构官网）；
  (c) 带 facts.statute_quotes / facts.case_quotes 的卡，每条引文都要与登记在册的官方原件
      逐字对得上（scripts/verify-quotes.py 的三态判定，"找不到原件"同样不算过）；
  (d) --strict（默认开）：索引里出现 confidence 既非「原文核实」也非「无外部断言」的卡即拒绝生成并逐张点名；
  (e) 自称「无外部断言」（D 类，见 knowledge/README.md §2.2）的卡必须真的没有外部断言——
      带 facts、带 law_refs、或 sources 里有 http(s) 出处的，一律拒绝：那说明它有原件可核，
      该走「原文核实」并接受 (b)(c) 的检查，而不是从这个口子绕过去；
  (f) packs/cases/ 下的判例卡必须有 ≥1 条**核得过**的 facts.case_quotes——
      判例卡最常见的失效不是没出处，而是出处是真的、案情是转载站编的；
  (g) kind=机构官网 的源只能被数据卡引用（热线/地址/收费这类"这家机构自己的事"），
      法条卡/判例卡/SOP/计算规则引它即红；
  (h) 隔离区里的卡不许挂「原文核实」「无外部断言」这两个"可进索引"的标签——
      它进隔离区的全部理由就是没核动，标签撒谎会让下一个人误把它搬回去。

**`--no-strict` 把这几道整体降为警告**，只在核实作业期间用。
降的是这几道，**前面那批卡片自洽的校验一条不降**——
一个开关只有一种含义，才不会有人以为自己关掉的是别的东西。

隔离区 knowledge/quarantine/** 一律不进索引（追不到一手源的卡整张移进去，带原因）。
"""
import argparse
import json
import re
import sys
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).resolve().parent))
import knowledge_sources as ks  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent / "knowledge"
TYPES = {"法条卡", "判例卡", "计算规则", "流程SOP", "文书模板", "话术卡", "情绪指南", "数据卡", "审查规则", "方法卡"}
# 领域键（设计稿 §13：知识库按领域独立成包但共用机制）。
# **正本在 app/src/lib/domains/registry.ts 的 DOMAINS**；这里是它的影子，
# 由 app/src/lib/knowledge/__tests__/domain-index.test.ts **两向**逐键比对。
# 影子而不是共享一份，是因为这个脚本是 python、注册表是 ts，中间没有便宜的共享方式；
# 有判据点名就不会出现"两份悄悄分叉"。
#
# 【为什么必须严格相等，而不是"这里宽一点也没关系"】(复审 2026-09-06 点名)
# 两个方向的分叉后果完全不同，而"宽一点"那个方向更坏：
#   · 这里**少**一个注册表有的领域 ⇒ 那个领域的卡当场被判非法 domain，生成即失败，有人看见；
#   · 这里**多**一个注册表没有的领域 ⇒ 生成器放行、index.json 提交进仓库，
#     而加载器（lib/knowledge/index.ts loadIndex）按经理 2026-09-07 的裁决**把那批卡排除**、
#     只在 console.error 里点一次名 —— 于是那批卡对谁都检索不到，
#     而检索照常返回 200 与一个更短的列表：**页面上什么都不缺**，只有日志里那一行说了实话。
#     （这道闸立起来时加载器还是「未注册即抛」那一版，那时的后果是全站每一轮对话 500；
#      裁决把后果从"全站 500"换成了"静默少一批卡"——**换掉的是响度，不是这道闸的必要性**：
#      生成即失败是有人一定看得见的那一档，日志里一行不是。）
#     先写卡后挂包这个顺序本身是合理的工作方式，所以不能靠"记得按顺序合入"来防，
#     只能让这里放行不了还没挂上的领域。
DOMAINS = {"labor", "counseling"}
DEFAULT_DOMAIN = "labor"
# confidence 的四档。前三档是"核到什么程度"，第四档 `无外部断言` 不在那条轴上：
# 它说的是**这张卡压根没有可核的外部原件**（纯方法论/陪伴话术，全部内容是本库自己写的），
# 见 knowledge/README.md §2.2。第四档由 (e) 自证守卫兜底，不是一句可以随手贴的免检标签。
CONFIDENCES = {"原文核实", "二手转述", "待核实", "无外部断言"}
#: D 类（无外部断言卡）。放在这里而不是散在各处：它同时是 (b)(d)(e) 三道守卫的分支条件。
NO_EXTERNAL_CLAIM = "无外部断言"
REQUIRED = ["id", "type", "title", "keywords", "applies_to", "sources", "confidence", "updated"]
# sources 必须导出：卡片正文里虽然常常也带着官方 URL，但那是散文，代码读不到。
# 呈现层（VenueCard.sources）要把出处**结构化**地摆在卡片下方——一张说不出出处的
# 「官方流程」卡与一段我们自己编的话，在用户那里长得一模一样。
INDEX_FIELDS = ["id", "type", "title", "keywords", "applies_to", "region", "domain", "sources", "confidence", "updated"]


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
    # case_quotes（规范 §2.1）：判例卡从官方页逐字摘下来的那几句。
    # source_id 必填——判例没有"法名"可以拿去和登记簿互为子串匹配（见 verify-quotes 头注释）。
    for q in facts.get("case_quotes", []):
        for field in ("source_id", "text"):
            if field not in q or not str(q[field]).strip():
                die(f"{path} facts.case_quotes 缺字段 {field}：{q}")
        for field in q:
            if field not in ("source_id", "text", "note"):
                die(f"{path} facts.case_quotes 含未知字段 {field}（只允许 source_id / text / note）：{q}")
        if normalize(q["text"]) not in body_norm:
            die(f"{path} case_quotes（{str(q['text'])[:24]}…）与正文不逐字一致")


def domain_of(path: Path, fm: dict) -> str:
    """这张卡属于哪个领域。

    优先 frontmatter 的 domain；没写就看 packs/ 下的第一层目录是不是一个领域键
    （允许 packs/<domain>/… 的分包布局，设计稿 §13）；都不是就算缺省领域
    （存量卡片写于只有一个领域的时候）。

    写了一个没人认识的 domain 一律当场拒绝：那批卡按领域过滤时对谁都不可见，
    而检索会照常返回 200 与一个更短的列表——没有任何一处会报错。
    """
    declared = fm.get("domain")
    if declared:
        if declared not in DOMAINS:
            die(f"{path} 的 domain 非法：{declared}（已注册：{sorted(DOMAINS)}）")
        return declared
    parts = path.relative_to(ROOT).parts  # ('packs', <第一层>, …)
    if len(parts) >= 2 and parts[1] in DOMAINS:
        return parts[1]
    return DEFAULT_DOMAIN


QUARANTINE = "quarantine"


CASE_TYPE = "判例卡"
CASES_DIR = "cases"


def quarantine_labels() -> list[str]:
    """隔离区里挂着「可进索引」标签的卡（守卫 (h)）。

    隔离区的卡本来就不进索引，所以这道闸管的**不是**它们会不会被检索到，
    而是**标签会不会撒谎**：一张 `confidence: 原文核实` 的卡在隔离区里躺着，
    有人把它搬回 packs/ 时会以为它已经核过了——而它进隔离区的全部理由正是没核动。
    `无外部断言` 同理：那是 D 类的免检标签，隔离区的卡凭定义不可能是 D 类
    （它有断言、只是追不到源）。这两档之外（`待核实`／`二手转述`）都放行。
    """
    bad = []
    # 隔离区有两种摆法（knowledge/quarantine/** 与 packs/**/quarantine/**），
    # 生成器的排除逻辑认的是**目录段**，这里必须用同一个口径——只认其中一种的话，
    # 另一种摆法下的卡可以挂着「原文核实」躺着，而两处代码看起来都在做同一件事。
    for path in sorted(ROOT.glob("**/*.md")):
        if QUARANTINE not in path.relative_to(ROOT).parts:
            continue
        text = path.read_text(encoding="utf-8")
        m = re.match(r"\A---\n(.*?)\n---\n", text, re.DOTALL)
        if not m:
            continue
        conf = re.search(r"^confidence:\s*(\S+)\s*$", m.group(1), re.M)
        if conf and conf.group(1) in ("原文核实", NO_EXTERNAL_CLAIM):
            bad.append(
                f"  · {path.relative_to(ROOT)}：confidence={conf.group(1)}"
                f"（隔离区的卡只能是「待核实」或「二手转述」——它在这里就是因为没核动）"
            )
    return bad


def grounding_guards(entries: list[dict], strict: bool) -> None:
    """扎根守卫（(b) 官方 host / (c) 引文对得上原件 / (d) 全库原文核实 / (e) D 类自证 /
    (f) 判例卡的 case_quotes / (g) 机构官网只给数据卡用 / (h) 隔离区标签不撒谎）。

    strict=True 时任何一条不过就拒绝生成并逐张点名；--no-strict 时整体降为警告。
    **在写 index.json 之前跑**：一个通不过守卫的知识库不该留下一份看起来正常的索引，
    否则下一个人拿到的是"文件在、时间新、内容没人验过"。
    """
    registry = ks.load_registry(ROOT)
    extra_hosts = ks.extra_allowed_hosts(registry)
    inst_hosts = ks.institution_hosts(registry)
    inst_ids = ks.institution_source_ids(registry)
    unofficial, quote_bad, unverified, fake_d = [], [], [], []
    inst_misuse, no_case_quote = [], []

    for e in entries:
        if e["confidence"] == NO_EXTERNAL_CLAIM:
            # (e) D 类的自证：它豁免了 (b) 的 host 闸，所以必须自己证明"真的没有外部断言"。
            # 没有这一条，`无外部断言` 就是一句谁都能贴上去、贴上去就免检的话。
            bad = []
            if e.get("facts"):
                bad.append(f"带 facts（{'、'.join(sorted(e['facts']))}）")
            if e.get("law_refs"):
                bad.append(f"带 law_refs（{'、'.join(str(x) for x in e['law_refs'])}）")
            urls = [s for s in e["sources"] if ks.host_of(s)]
            if urls:
                bad.append(f"sources 里有 http(s) 出处（{urls[0]}）")
            if bad:
                fake_d.append(f"  · {e['id']}（{e['path']}）：{'；'.join(bad)}")
            continue
        if e["confidence"] != "原文核实":
            unverified.append(f"  · [{e['confidence']}] {e['id']}（{e['path']}）")
            continue  # 非原文核实的卡由 (d) 管，不必再挑它的 source
        for s in e["sources"]:
            reason = ks.check_source_url(s, extra_hosts)
            if reason:
                unofficial.append(f"  · {e['id']}（{e['path']}）：{reason}")

    # (g) 机构官网只配给数据卡的 facts（热线/地址/收费）当出处。
    # 【为什么单开一道，而不是并进 (b)】(b) 问的是"这是不是一手源"，答案是"是——
    # 这家机构自己的官网"；(g) 问的是"这份一手源能拿来断言什么"，答案是"只有它自己的事"。
    # 合成一道的形态是：某个 host 为了一条热线号码进了白名单，从此一张法条卡可以拿
    # 某医院的科普文当法律依据，而 host 闸一声不吭地放行。
    for e in entries:
        if e["type"] == ks.INSTITUTION_ONLY_CARD_TYPE:
            continue
        hit = sorted({h for h in (ks.host_of(s) for s in e["sources"]) if h and h in inst_hosts})
        facts = e.get("facts") or {}
        hit_ids = sorted(
            {
                str(q.get("source_id"))
                for key in ("statute_quotes", "case_quotes")
                for q in (facts.get(key) or [])
                if str(q.get("source_id", "")) in inst_ids
            }
        )
        if hit or hit_ids:
            inst_misuse.append(
                f"  · [{e['type']}] {e['id']}（{e['path']}）引了机构官网源"
                f"{'：' + '、'.join(hit) if hit else ''}"
                f"{'（source_id ' + '、'.join(hit_ids) + '）' if hit_ids else ''}"
                f"——机构官网只能被{ks.INSTITUTION_ONLY_CARD_TYPE}的 facts 引用"
                f"（热线/地址/收费这类「这家机构自己的事」）。"
                f"把这几个事实搬进一张数据卡，本卡改用 related 指过去"
            )

    facts_quotes = [
        (e["id"], e["path"], (e.get("facts") or {}).get("statute_quotes") or [])
        for e in entries
    ]
    case_quotes = [
        (e["id"], e["path"], (e.get("facts") or {}).get("case_quotes") or [])
        for e in entries
    ]
    verified_case_quotes: dict[str, int] = {}
    for r in ks.verify_cards(ROOT, [c for c in facts_quotes if c[2]], ks.STATUTE_QUOTE):
        if r["state"] != "一致":
            quote_bad.append(
                f"  · [{r['state']}] {r['card_id']} · {r['law']}{r['article']}：{r.get('detail', '')}"
            )
    for r in ks.verify_cards(ROOT, [c for c in case_quotes if c[2]], ks.CASE_QUOTE):
        if r["state"] != "一致":
            quote_bad.append(
                f"  · [{r['state']}]（判例引文）{r['card_id']} · {r['law']}{r['article']}：{r.get('detail', '')}"
            )
        else:
            verified_case_quotes[r["card_id"]] = verified_case_quotes.get(r["card_id"], 0) + 1

    # (f) 判例卡必须有 ≥1 条**核得过**的 case_quotes。
    # 【为什么"有这个字段"不算数】判例卡最常见的失效形态不是没有出处，而是**出处是真的、
    # 卡里的案情是转载站编的**：官方通稿只给一句话要旨，卡里却写着当事人姓名、金额、
    # 大段"裁判理由原文"。要求至少一条逐字对得上官方页的摘录，等于逼这张卡
    # 至少有一句话是从原件上抄下来的，而不是全篇转述。
    for e in entries:
        parts = re.split(r"[\\/]", str(e["path"]))
        in_cases_dir = len(parts) >= 2 and parts[0] == "packs" and parts[1] == CASES_DIR
        if e["type"] != CASE_TYPE and not in_cases_dir:
            continue
        if not verified_case_quotes.get(e["id"]):
            no_case_quote.append(
                f"  · {e['id']}（{e['path']}）：没有一条核得过的 facts.case_quotes"
                f"（规范 §2.1；至少要有官方页上逐字写着的裁判要旨或裁判结果一句）"
            )

    groups = [
        ("(b) 非官方出处（confidence=原文核实 却引了非 .gov.cn 的源）", unofficial),
        ("(c) 引文与官方原件对不上（scripts/verify-quotes.py 可单独复跑）", quote_bad),
        (f"(d) 索引里仍有既非「原文核实」也非「{NO_EXTERNAL_CLAIM}」的卡", unverified),
        (
            f"(e) 自称「{NO_EXTERNAL_CLAIM}」却带着外部断言的卡"
            f"（有 facts / law_refs / http(s) 出处 ⇒ 它有原件可核，应走「原文核实」并过 (b)(c)）",
            fake_d,
        ),
        (f"(f) {CASE_TYPE}没有核得过的 facts.case_quotes（官方页逐字节选，规范 §2.1）", no_case_quote),
        (
            f"(g) 机构官网源被{ks.INSTITUTION_ONLY_CARD_TYPE}之外的卡引用"
            f"（它只能给「这家机构自己的事」——热线/地址/收费——做出处）",
            inst_misuse,
        ),
        ("(h) 隔离区里的卡挂着「可进索引」的 confidence（标签不能撒谎）", quarantine_labels()),
    ]
    if not any(rows for _, rows in groups):
        return
    if not strict:
        summary = "，".join(f"{title.split(' ')[0]} {len(rows)} 条" for title, rows in groups if rows)
        print(
            f"警告（--no-strict，扎根守卫已整体降为警告）：{summary}。"
            f"逐条清单去掉 --no-strict 再跑一次即可看到。",
            file=sys.stderr,
        )
        return
    lines = ["错误：扎根守卫不通过，拒绝生成索引。"]
    for title, rows in groups:
        if rows:
            lines.append(f"{title}：共 {len(rows)} 条")
            lines.extend(rows)
    lines.append(
        "怎么办：逐张追一手源并逐字核实（scripts/fetch-source.py 抓原件 → "
        "scripts/verify-quotes.py 核引文）；追不到的整张移入 knowledge/quarantine/<原子目录>/ "
        "并写明原因与试过的信源。核实作业期间可加 --no-strict 让本脚本先出索引。"
    )
    sys.exit("\n".join(lines))


def main(argv: list[str] | None = None) -> None:
    global ROOT
    ap = argparse.ArgumentParser(description="再生成 knowledge/index.json")
    ap.add_argument(
        "--strict",
        action=argparse.BooleanOptionalAction,
        default=True,
        help="默认开；--no-strict 把三道扎根守卫降为警告，供核实作业期间使用",
    )
    ap.add_argument("--knowledge-dir", default=None, help="默认仓内 knowledge/；测试用")
    args = ap.parse_args(argv)
    if args.knowledge_dir:
        ROOT = Path(args.knowledge_dir).resolve()

    entries, seen_ids, seen_keys, forbidden = [], {}, {}, []
    bodies = {}
    for path in sorted(ROOT.glob("packs/**/*.md")):
        # 【隔离区不进索引】追不到一手源的卡整张移进 knowledge/quarantine/，
        # 它仍是一份存档（写着原因与试过的信源），但**绝不能被检索到**——
        # 一张进了索引的隔离卡与一张正常卡，在 agent 那里长得一模一样。
        if QUARANTINE in path.relative_to(ROOT).parts:
            continue
        fm, body = parse(path)
        for field in REQUIRED:
            if field not in fm or fm[field] in ("", [], None):
                die(f"{path} 缺少必填字段 {field}")
        if fm["type"] not in TYPES:
            die(f"{path} type 非法：{fm['type']}")
        if fm["confidence"] not in CONFIDENCES:
            die(f"{path} confidence 非法：{fm['confidence']}")
        # 【类型闸】keywords / applies_to 的每一项必须是**字符串**。
        #   检索端 matches() 首条是 `term.length >= MIN_KEYWORD_LEN`，
        #   而 JS 里 `(2032).length` 是 undefined、`undefined >= 2` 恒为 false
        #   ⇒ 数字词**从不参与匹配，且全程不报错**：卡片里有、index.json 里有、
        #   本脚本也曾放行——唯一的发现处是"拿它去搜搜不到"，而没人会去搜 87983310。
        #   2026-08-29 一次性修了 21 张卡 31 个词（YAML 把 `21.75` 解析成 float）。
        #   **修卡治已病，这道闸治未病**：写 `keywords: [2032]` 当场拒绝生成，
        #   而不是安静地生成一个少了一个词的索引。
        for _f in ("keywords", "applies_to"):
            for _v in fm.get(_f) or []:
                if not isinstance(_v, str):
                    die(f"{path} {_f} 含非字符串项 {_v!r}（{type(_v).__name__}）："
                        f"检索按子串匹配，非字符串项永远不会命中。请加引号写成 \"{_v}\"")
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
        # domain：领域键（设计稿 §13「知识库 index 增 domain 字段」）。**每条都导出显式值**：
        # 卡里没写就按 domain_of 的规则算（packs/<领域>/ 的目录布局，都不是就缺省领域）。
        # 【合并时清掉的那两行】ws/p4-w2 那一版是"只在卡片自己声明时导出"，
        # 与 ws/p4-w1 的 domain_of 合到一起后，后写的那个 if 恒被前一行的结果覆盖 ——
        # 代码只剩一种行为，注释却还写着另一种。留着的形态是：下一个人照注释改代码。
        entry["domain"] = domain_of(path, fm)
        entry["path"] = str(path.relative_to(ROOT))
        if fm.get("law_refs"):
            entry["law_refs"] = fm["law_refs"]
        if fm.get("facts"):
            entry["facts"] = fm["facts"]
        entries.append(entry)
    # forbidden 号码不得出现在其他卡正文（登记它的资源卡本身除外）
    for phone, home in forbidden:
        for path, body_norm in bodies.items():
            if path != home and phone in body_norm:
                die(f"禁用号码 {phone} 出现在 {path}（仅允许存在于 {home}）")
    grounding_guards(entries, args.strict)
    out = ROOT / "index.json"
    out.write_text(json.dumps(entries, ensure_ascii=False, indent=2, default=str) + "\n", encoding="utf-8")
    by_domain = {}
    for e in entries:
        by_domain[e["domain"]] = by_domain.get(e["domain"], 0) + 1
    spread = "，".join(f"{k} {v} 张" for k, v in sorted(by_domain.items()))
    print(
        f"OK：{len(entries)} packs → {out}"
        f"（facts 卡 {sum(1 for e in entries if 'facts' in e)} 张，facts 校验通过；领域分布：{spread}）"
    )


if __name__ == "__main__":
    main()
