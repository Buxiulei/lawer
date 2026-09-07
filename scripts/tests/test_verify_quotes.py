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
