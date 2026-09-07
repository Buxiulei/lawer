"""scripts/verify-quotes.py 的判据：一致 / 不一致 / 找不到原件**三态**各一条。

【为什么三态必须分开测】"找不到原件"是本工具最危险的一态：把它并进"通过"，
"核过了"与"根本没核"在退出码上就长得一模一样，而知识库正是靠这个退出码
声称自己是逐字核实过的。所以既测它默认必红，也测 --allow-missing 下它只是警告。
"""

from __future__ import annotations

import json

import pytest

from conftest import write_card, write_original, write_registry

ORIGINAL = (
    "中华人民共和国劳动合同法\n\n"
    "第三十八条　用人单位有下列情形之一的，劳动者可以解除劳动合同：\n"
    "（一）未按照劳动合同约定提供劳动保护或者劳动条件的；\n"
    "（二）未及时足额支付劳动报酬的；\n"
    "第四十七条　经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。\n"
)


@pytest.fixture
def kb(tmp_path):
    """一个只有一张卡、一份原件的最小知识库。"""
    write_registry(tmp_path, [write_original(tmp_path, "lhtf", ORIGINAL, name="中华人民共和国劳动合同法")])
    return tmp_path


def run(verify, root, *extra):
    try:
        return verify.main(["--knowledge-dir", str(root), *extra])
    except SystemExit as e:  # argparse 的 --card 走 return，不会到这里；兜底
        return e.code


# ── ① 一致 ──────────────────────────────────────────────────────────────
def test_match_exits_zero(verify, kb, capsys):
    write_card(
        kb,
        "packs/statutes/a.md",
        card_id="statute-a",
        quotes=[{"law": "中华人民共和国劳动合同法", "article": "第四十七条",
                 "text": "第四十七条　经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。"}],
    )
    assert run(verify, kb) == 0
    assert "一致 1" in capsys.readouterr().out


def test_match_survives_markdown_and_width_differences(verify, kb):
    """卡片里条文是**加粗引用块**、全角空格、弯引号；原件是纯文本。

    这些差异每一条都真实存在（本轮实测的两份 .gov.cn 原件都是），归一不掉的话
    工具会把 100% 的引文判成"不一致"，然后没人再看它的输出。
    """
    write_card(
        kb,
        "packs/statutes/b.md",
        card_id="statute-b",
        quotes=[{"law": "劳动合同法", "article": "第三十八条",
                 "text": "**第三十八条**　用人单位有下列情形之一的，劳动者可以解除劳动合同：\n"
                         "（一）未按照劳动合同约定提供劳动保护或者劳动条件的；"}],
    )
    assert run(verify, kb) == 0


def test_law_name_matches_by_containment(verify, kb):
    """卡里写简称「劳动合同法」，登记簿里是全称——互为子串即算同一部法。"""
    write_card(
        kb,
        "packs/statutes/c.md",
        card_id="statute-c",
        quotes=[{"law": "劳动合同法", "article": "第四十七条", "text": "每满一年支付一个月工资的标准向劳动者支付。"}],
    )
    assert run(verify, kb) == 0


# ── ② 不一致 ────────────────────────────────────────────────────────────
def test_mismatch_exits_nonzero_and_points_at_the_divergence(verify, kb, capsys):
    """本轮实测抓到的真实形态：卡里多写了两个字（工资支付「记录」表）。"""
    write_card(
        kb,
        "packs/statutes/d.md",
        card_id="statute-d",
        quotes=[{"law": "劳动合同法", "article": "第四十七条",
                 "text": "第四十七条　经济补偿按劳动者在本单位工作的实际年限，每满一年支付一个月工资的标准向劳动者支付。"}],
    )
    assert run(verify, kb) == 1
    out = capsys.readouterr().out
    assert "[不一致]" in out and "statute-d" in out and "第四十七条" in out
    assert "字起分叉" in out, "报告必须说清从第几个字开始不一样，否则要人自己用眼睛找"
    assert "卡内：" in out and "原件：" in out


def test_mismatch_from_first_char_says_so(verify, kb, capsys):
    """整段都不在原件里，多半是认错了原件而不是抄错了字——两种病要给不同的话。"""
    write_card(
        kb,
        "packs/statutes/e.md",
        card_id="statute-e",
        quotes=[{"law": "劳动合同法", "article": "第九十九条", "text": "本条完全不在这份原件里出现过。"}],
    )
    assert run(verify, kb) == 1
    assert "认错了原件" in capsys.readouterr().out


# ── ③ 找不到原件 ────────────────────────────────────────────────────────
def test_missing_original_is_not_a_pass(verify, kb, capsys):
    write_card(
        kb,
        "packs/statutes/f.md",
        card_id="statute-f",
        quotes=[{"law": "中华人民共和国社会保险法", "article": "第五十八条", "text": "用人单位应当自用工之日起三十日内为其职工申请办理社会保险登记。"}],
    )
    assert run(verify, kb) == 1, "登记簿里没有这部法的原件 ⇒ 没核过 ⇒ 不能算通过"
    out = capsys.readouterr().out
    assert "[找不到原件]" in out and "fetch-source.py" in out, "得告诉人下一步做什么"


def test_missing_original_downgraded_by_allow_missing(verify, kb):
    write_card(
        kb,
        "packs/statutes/g.md",
        card_id="statute-g",
        quotes=[{"law": "中华人民共和国社会保险法", "article": "第五十八条", "text": "用人单位应当自用工之日起三十日内为其职工申请办理社会保险登记。"}],
    )
    assert run(verify, kb, "--allow-missing") == 0


def test_allow_missing_does_not_forgive_mismatch(verify, kb):
    """--allow-missing 只放过"还没抓"，不放过"抓了但对不上"。"""
    write_card(
        kb,
        "packs/statutes/h.md",
        card_id="statute-h",
        quotes=[{"law": "劳动合同法", "article": "第四十七条", "text": "经济补偿按劳动者在本单位工作的实际年限支付。"}],
    )
    assert run(verify, kb, "--allow-missing") == 1


def test_source_id_pointing_nowhere_is_missing_not_match(verify, kb, capsys):
    write_card(
        kb,
        "packs/statutes/i.md",
        card_id="statute-i",
        quotes=[{"source_id": "no-such-source", "law": "劳动合同法", "article": "第四十七条",
                 "text": "每满一年支付一个月工资的标准向劳动者支付。"}],
    )
    assert run(verify, kb) == 1
    assert "no-such-source" in capsys.readouterr().out


def test_registered_but_text_missing_is_missing(verify, kb, capsys):
    """登记了 PDF、还没转出文本的常态：必须报"找不到原件"并给出补法。"""
    entry = write_original(kb, "pdf-only", "占位", name="某部门规章")
    entry["files"]["text"] = None
    write_registry(kb, [entry])
    write_card(
        kb,
        "packs/statutes/j.md",
        card_id="statute-j",
        quotes=[{"source_id": "pdf-only", "law": "某部门规章", "article": "第一条", "text": "占位"}],
    )
    assert run(verify, kb) == 1
    assert "text.txt" in capsys.readouterr().out


def test_ambiguous_law_name_requires_source_id(verify, kb, capsys):
    """两份原件的 name 都能匹上时，"随便挑一条"等于随机选一份原件来核验。"""
    write_registry(
        kb,
        [
            write_original(kb, "lhtf", ORIGINAL, name="中华人民共和国劳动合同法"),
            write_original(kb, "lhtf-jieshi", ORIGINAL, name="中华人民共和国劳动合同法实施条例"),
        ],
    )
    write_card(
        kb,
        "packs/statutes/k.md",
        card_id="statute-k",
        quotes=[{"law": "中华人民共和国劳动合同法", "article": "第四十七条", "text": "每满一年支付一个月工资的标准向劳动者支付。"}],
    )
    assert run(verify, kb) == 1
    assert "source_id" in capsys.readouterr().out


# ── 其他面 ──────────────────────────────────────────────────────────────
def test_json_output_shape(verify, kb, capsys):
    write_card(
        kb,
        "packs/statutes/l.md",
        card_id="statute-l",
        quotes=[
            {"law": "劳动合同法", "article": "第四十七条", "text": "每满一年支付一个月工资的标准向劳动者支付。"},
            {"law": "劳动合同法", "article": "第四十七条", "text": "每满一年支付两个月工资。"},
        ],
    )
    assert run(verify, kb, "--json") == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["total"] == 2 and payload["ok"] == 1 and payload["mismatch"] == 1
    assert {r["state"] for r in payload["rows"]} == {"一致", "不一致"}
    assert payload["rows"][0]["card_id"] == "statute-l"


def test_quarantine_cards_are_not_verified(verify, kb):
    """隔离区的卡不进索引，也不该拖垮核验——它本来就是"追不到源"的存档。"""
    write_card(
        kb,
        "quarantine/statutes/m.md",
        card_id="statute-m",
        quotes=[{"law": "根本没有这部法", "article": "第一条", "text": "随便什么"}],
    )
    write_card(
        kb,
        "packs/quarantine/n.md",
        card_id="statute-n",
        quotes=[{"law": "根本没有这部法", "article": "第一条", "text": "随便什么"}],
    )
    assert run(verify, kb) == 0


# ── ④ case_quotes（判例卡的官方页逐字节选）────────────────────────────
CASE_ORIGINAL = (
    "北京市第三中级人民法院召开新闻发布会。\n"
    "第九个典型案例指出，劳动者未履行请假手续且请假合理性存疑，其擅自离岗构成旷工。\n"
)


@pytest.fixture
def kb_case(tmp_path):
    write_registry(
        tmp_path,
        [
            write_original(tmp_path, "lhtf", ORIGINAL, name="中华人民共和国劳动合同法"),
            write_original(tmp_path, "dxal", CASE_ORIGINAL, kind="官方案例", name="某法院典型案例发布页"),
        ],
    )
    return tmp_path


def test_case_quote_match(verify, kb_case, capsys):
    write_card(
        kb_case, "packs/cases/a.md", card_id="case-a", card_type="判例卡",
        case_quotes=[{"source_id": "dxal", "text": "劳动者未履行请假手续且请假合理性存疑，其擅自离岗构成旷工。"}],
    )
    assert run(verify, kb_case) == 0
    assert "一致 1" in capsys.readouterr().out


def test_case_quote_mismatch_is_reported_as_a_case_quote(verify, kb_case, capsys):
    """报告要说清这是**判例引文**——法条引文与判例引文的修法完全不同。"""
    write_card(
        kb_case, "packs/cases/b.md", card_id="case-b", card_type="判例卡",
        case_quotes=[{"source_id": "dxal", "text": "劳动者未履行请假手续的，一律构成旷工并可解除劳动合同。"}],
    )
    assert run(verify, kb_case) == 1
    printed = capsys.readouterr().out
    assert "[不一致]" in printed and "判例引文" in printed and "case-b" in printed


def test_case_quote_without_source_id_is_missing_not_match(verify, kb_case, capsys):
    """判例引文不写 source_id ⇒ 判「找不到原件」，不是按 law 名去猜。

    猜的形态是：一句"第九个典型案例指出…"匹上了另一场发布会的通稿，然后报「一致」。
    """
    write_card(
        kb_case, "packs/cases/c.md", card_id="case-c", card_type="判例卡",
        case_quotes=[{"text": "劳动者未履行请假手续且请假合理性存疑，其擅自离岗构成旷工。"}],
    )
    assert run(verify, kb_case) == 1
    printed = capsys.readouterr().out
    assert "[找不到原件]" in printed and "source_id" in printed


def test_case_quote_pointing_at_an_unregistered_source_is_missing(verify, kb_case, capsys):
    write_card(
        kb_case, "packs/cases/d.md", card_id="case-d", card_type="判例卡",
        case_quotes=[{"source_id": "no-such", "text": "随便什么"}],
    )
    assert run(verify, kb_case) == 1
    assert "no-such" in capsys.readouterr().out


def test_both_quote_kinds_are_verified_in_one_run(verify, kb_case, capsys):
    """一张卡同时带两种引文时，两种都要核——只核其中一种的形态是另一种从不报错。"""
    write_card(
        kb_case, "packs/cases/e.md", card_id="case-e", card_type="判例卡",
        quotes=[{"law": "中华人民共和国劳动合同法", "article": "第四十七条", "text": "经济补偿按劳动者在本单位工作的年限"}],
        case_quotes=[{"source_id": "dxal", "text": "其擅自离岗构成旷工。"}],
    )
    assert run(verify, kb_case, "--json") == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["total"] == 2 and payload["ok"] == 2
    assert {r["field"] for r in payload["rows"]} == {"statute_quotes", "case_quotes"}


def test_case_quote_header_separates_source_id_from_note(verify, kb_case, capsys):
    """判例引文那一行里，source_id 与 note 之间要有分隔——它是人去找原件的唯一线索。

    法条引文的同两格连读就是条名（「劳动合同法第三十九条」），所以这里刻意只给判例引文加
    分隔符；粘在一起的形态是「cases-bj3zy-2025-dxal案例九的裁判要旨」，
    读的人得先猜哪儿是原件 id 才能去 sources.json 里找它。
    """
    write_card(
        kb_case, "packs/cases/f.md", card_id="case-f", card_type="判例卡",
        case_quotes=[{"source_id": "dxal", "note": "案例九的裁判要旨", "text": "本句完全不在那份通稿里出现过。"}],
    )
    assert run(verify, kb_case) == 1
    printed = capsys.readouterr().out
    assert "dxal · 案例九的裁判要旨" in printed
    assert "dxal案例九" not in printed


def test_statute_quote_header_stays_glued(verify, kb, capsys):
    """反向对照：法条引文那一行不许被这次改动改成「劳动合同法 · 第三十九条」。

    没有这一条，把分隔符无差别加到两种引文上也照样绿——而那会让全库 200 多行法条报告
    的条名裂开，且没有任何一处报错。
    """
    write_card(
        kb, "packs/statutes/g.md", card_id="statute-g",
        quotes=[{"law": "中华人民共和国劳动合同法", "article": "第四十七条", "text": "本句完全不在这份原件里出现过。"}],
    )
    assert run(verify, kb) == 1
    assert "中华人民共和国劳动合同法第四十七条" in capsys.readouterr().out


# ── 引号字形：这把尺子不折 ──────────────────────────────────────────────
#: 原件里带一对**全角**引号的一句（.gov.cn 的正文与 PDF 抽出的文本都是这个写法）。
QUOTE_ORIGINAL = (
    "北京市高级人民法院关于审理劳动争议案件解答（一）\n\n"
    "76．劳动者原岗位已被他人替代的，用人单位仅以此为由进行抗辩，"
    "不宜认定为“劳动合同确实无法继续履行的”情形。\n"
)


@pytest.fixture
def kb_quotes(tmp_path):
    write_registry(
        tmp_path,
        [write_original(tmp_path, "jieda", QUOTE_ORIGINAL, name="北京市高级人民法院关于审理劳动争议案件解答（一）")],
    )
    return tmp_path


def test_halfwidth_quote_against_fullwidth_original_is_a_mismatch(verify, kb_quotes, capsys):
    """卡里把原件的 “…” 写成 "…" ⇒ **不一致**，并指出第几个字起分叉。

    【为什么这条非有不可】(经理 2026-09-07 复审 major) 这把尺子此前会把引号族整体折成
    半角双引号，于是这一类差异恒判「一致」——而 gen 的两面一致校验不折引号，
    同一张卡在两把尺子下一绿一红，绿的那把正是我们对外说"逐字核过官方原件"时指的那把。
    实测：现库 26 条引文（11 张卡）属于这一类，折引号时全绿。

    **这不是吹毛求疵**：引号在法条里划的是定义的边界（「不宜认定为“劳动合同确实
    无法继续履行的”情形」），边界写错了就是抄错了字，而"抄错了字"正是这把尺子唯一的用途。
    """
    write_card(
        kb_quotes,
        "packs/statutes/halfwidth.md",
        card_id="statute-halfwidth",
        quotes=[{
            "law": "北京市高级人民法院关于审理劳动争议案件解答（一）",
            "article": "第76问",
            "text": '劳动者原岗位已被他人替代的，用人单位仅以此为由进行抗辩，不宜认定为"劳动合同确实无法继续履行的"情形。',
        }],
    )
    assert run(verify, kb_quotes) == 1
    printed = capsys.readouterr().out
    assert "不一致 1" in printed
    assert "第 34 字起分叉" in printed, printed  # 分叉处正是那个引号


def test_fullwidth_quote_matching_the_original_passes(verify, kb_quotes, capsys):
    """正对照：同一句、引号写法与原件一致（只差空白与 markdown 记号）⇒ **一致**。

    【为什么必须连着上一条一起测】只测"半角判红"的话，把归一整个删掉也全绿——
    而那会让全库每一条引文都判红（卡里条文是 `> **…**　` 的加粗引用块，原件是纯文本）。
    这一条钉的正是"空白/换行/markdown 记号仍然归一"这半边。
    """
    write_card(
        kb_quotes,
        "packs/statutes/fullwidth.md",
        card_id="statute-fullwidth",
        quotes=[{
            "law": "北京市高级人民法院关于审理劳动争议案件解答（一）",
            "article": "第76问",
            "text": "**劳动者原岗位已被他人替代的**，用人单位仅以此为由进行抗辩，\n"
                    "不宜认定为“劳动合同确实无法继续履行的”情形。",
        }],
    )
    assert run(verify, kb_quotes) == 0
    assert "一致 1" in capsys.readouterr().out


def test_fullwidth_and_halfwidth_are_not_equal_under_the_ruler():
    """尺子本身：全角 “ ” ‘ ’ 与半角 " ' 归一后必须仍然不同，空白仍然归一。

    上面两条走的是 CLI，这一条直接钉函数——CLI 那两条同时绿也可能是别的原因
    （夹具没写对、原件没找到）造成的巧合。
    """
    import sys
    sys.path.insert(0, str(__import__("pathlib").Path(__file__).resolve().parent.parent))
    import knowledge_sources as ks

    assert ks.normalize_quote("“甲”") != ks.normalize_quote('"甲"')
    assert ks.normalize_quote("‘甲’") != ks.normalize_quote("'甲'")
    assert ks.normalize_quote("＂甲＂") != ks.normalize_quote('"甲"'), "NFKC 顺手做的宽度折叠也要挡住"
    assert ks.normalize_quote("第 三\n条\u3000甲") == ks.normalize_quote("第三条甲")
    assert ks.normalize_quote("> **第三条**　甲") == ks.normalize_quote("第三条甲")
    # 千分位逗号**不在**这把尺子里：那一层只属于数值那一面（gen 的 normalize），
    # 引文这一面把 1,000 与 1000 判成同一个，就等于在"逐字"里放进了一档"顺手抹平"。
    assert ks.normalize_quote("赔偿1,000元") != ks.normalize_quote("赔偿1000元")
