"""scripts/gen-knowledge-index.py 扎根守卫的判据。

(a) 隔离区排除 · (b) 官方 host 白名单 · (c) 引文对得上原件 · (d) --strict 点名 ·
(e) D 类「无外部断言」的自证

每一条都配正向对照。没有正向对照时，"守卫在拦"与"夹具压根没跑起来"输出一模一样——
本仓 index-guard.test.ts 的头注释里已经记过一次这个坑（M1 拆掉闸 9 条仍全绿）。
"""

from __future__ import annotations

import json
import shutil

import pytest

from conftest import REAL_KNOWLEDGE, write_card, write_original, write_registry

ORIGINAL = "第四十七条　经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。\n"
GOOD_SOURCE = "https://flk.npc.gov.cn/detail2.html?id=lhtf"


def run(gen, root, *extra):
    """跑生成器；die() 走 SystemExit，这里折成 (退出码, 索引内容或 None)。"""
    try:
        gen.main(["--knowledge-dir", str(root), *extra])
        code = 0
    except SystemExit as e:
        code = e.code if e.code is not None else 0
    index = root / "index.json"
    data = json.loads(index.read_text(encoding="utf-8")) if index.exists() else None
    return code, data


@pytest.fixture
def kb(tmp_path):
    write_registry(tmp_path, [write_original(tmp_path, "lhtf", ORIGINAL, name="中华人民共和国劳动合同法")])
    return tmp_path


# ── 正向对照 ────────────────────────────────────────────────────────────
def test_clean_library_generates_under_strict(gen, kb):
    """一张全合规的卡，strict 下也必须过。没有这条，下面的红都可能是别的原因。"""
    write_card(kb, "packs/statutes/ok.md", card_id="statute-ok", sources=[GOOD_SOURCE])
    code, data = run(gen, kb)
    assert code == 0
    assert [e["id"] for e in data] == ["statute-ok"]


# ── (a) 隔离区 ──────────────────────────────────────────────────────────
def test_quarantine_cards_never_enter_the_index(gen, kb):
    """两种摆法都要拦：knowledge/quarantine/** 与 packs/**/quarantine/**。

    进了索引的隔离卡与一张正常卡，在 agent 那里长得一模一样——
    而它恰恰是"追不到一手源"的那张。
    """
    write_card(kb, "packs/statutes/ok.md", card_id="statute-ok", sources=[GOOD_SOURCE])
    write_card(kb, "quarantine/statutes/bad.md", card_id="statute-bad", sources=["https://zh.wikisource.org/x"])
    write_card(kb, "packs/quarantine/worse.md", card_id="statute-worse", sources=["https://www.sohu.com/x"])
    code, data = run(gen, kb)
    assert code == 0, "隔离区里的坏卡不该拖垮生成"
    assert [e["id"] for e in data] == ["statute-ok"]


def test_quarantine_card_would_otherwise_be_rejected(gen, kb):
    """反证：同一张卡放回 packs/ 就必须被 (b) 拦下。

    证明上一条的绿不是"这张卡本来就合规"，而是"它真的被排除了"。
    """
    write_card(kb, "packs/statutes/bad.md", card_id="statute-bad", sources=["https://zh.wikisource.org/x"])
    code, _ = run(gen, kb)
    assert code != 0 and "statute-bad" in str(code)


# ── (b) 官方 host 白名单 ────────────────────────────────────────────────
@pytest.mark.parametrize(
    "url",
    [
        "https://zh.wikisource.org/wiki/某判决书",
        "https://www.sohu.com/a/792253141",
        "https://www.bj148.org/zf1/x.html",
        "https://mp.weixin.qq.com/s/x",
        "朝阳区仲裁办事指南附件《1.申请书.doc》",  # 散文出处：机器核不了
        "https://flk.npc.gov.cn.evil.com/x",  # 前缀像官方，host 不是
    ],
)
def test_non_official_source_rejected_for_verified_cards(gen, kb, url):
    write_card(kb, "packs/statutes/x.md", card_id="statute-x", sources=[url])
    code, _ = run(gen, kb)
    assert code != 0
    assert "statute-x" in str(code) and "非官方出处" in str(code)


@pytest.mark.parametrize(
    "url",
    [
        "https://flk.npc.gov.cn/detail2.html?id=1",
        "http://www.bjchy.gov.cn/dynamic/notice/1.html",  # 只有 http 可达的站
        "https://rsj.beijing.gov.cn/xxgk/tzgg/1.html",
        "https://www.court.gov.cn/zixun/xiangqing/1.html",
    ],
)
def test_gov_sources_pass(gen, kb, url):
    write_card(kb, "packs/statutes/x.md", card_id="statute-x", sources=[url])
    assert run(gen, kb)[0] == 0


def test_industry_norm_host_allowed_only_after_registration(gen, kb):
    """非 .gov.cn 的行业规范 host，只有先进了登记簿才算白名单。

    白名单若能在代码里随手加一行字符串，它迟早会长出 sohu.com。
    """
    card_url = "https://www.example-society.org/ethics.html"
    write_card(kb, "packs/statutes/x.md", card_id="statute-x", sources=[card_url])
    code, _ = run(gen, kb)
    assert code != 0, "还没登记之前，这个 host 不该被认"

    entry = write_original(kb, "ethics", ORIGINAL, name="某学会伦理守则")
    entry.update({"kind": "行业规范", "official_host": "www.example-society.org", "url": card_url})
    write_registry(kb, [write_original(kb, "lhtf", ORIGINAL, name="中华人民共和国劳动合同法"), entry])
    assert run(gen, kb)[0] == 0


def test_industry_norm_registration_does_not_whitelist_other_kinds(gen, kb):
    """登记的是「行业规范」才开口；同一个 host 以别的 kind 登记不算数。"""
    card_url = "https://www.example-society.org/ethics.html"
    entry = write_original(kb, "ethics", ORIGINAL, name="某学会伦理守则")
    entry.update({"kind": "规范性文件", "official_host": "www.example-society.org", "url": card_url})
    write_registry(kb, [entry])
    write_card(kb, "packs/statutes/x.md", card_id="statute-x", sources=[card_url])
    assert run(gen, kb)[0] != 0


def test_unverified_card_sources_are_not_host_checked(gen, kb):
    """待核实的卡本来就还没扎根，(b) 不重复点它——它由 (d) 点名。

    否则同一张卡会在两处各报一次，报告长度翻倍而信息量不变。
    """
    write_card(kb, "packs/statutes/x.md", card_id="statute-x", confidence="待核实", sources=["https://www.sohu.com/x"])
    code, _ = run(gen, kb, "--no-strict")
    assert code == 0
    code, _ = run(gen, kb)
    assert "非官方出处" not in str(code) and "statute-x" in str(code)


# ── (c) 引文对得上原件 ──────────────────────────────────────────────────
def test_quote_mismatch_blocks_generation(gen, kb):
    write_card(
        kb,
        "packs/statutes/q.md",
        card_id="statute-q",
        sources=[GOOD_SOURCE],
        quotes=[{"law": "中华人民共和国劳动合同法", "article": "第四十七条",
                 "text": "第四十七条　经济补偿按劳动者在本单位工作的实际年限，每满一年支付一个月工资的标准向劳动者支付。"}],
    )
    code, _ = run(gen, kb)
    assert code != 0 and "不一致" in str(code) and "statute-q" in str(code)


def test_quote_without_original_blocks_generation(gen, kb):
    write_card(
        kb,
        "packs/statutes/q.md",
        card_id="statute-q",
        sources=[GOOD_SOURCE],
        quotes=[{"law": "中华人民共和国社会保险法", "article": "第五十八条", "text": "用人单位应当自用工之日起三十日内办理社会保险登记。"}],
    )
    code, _ = run(gen, kb)
    assert code != 0 and "找不到原件" in str(code)


def test_matching_quote_passes(gen, kb):
    write_card(
        kb,
        "packs/statutes/q.md",
        card_id="statute-q",
        sources=[GOOD_SOURCE],
        quotes=[{"law": "中华人民共和国劳动合同法", "article": "第四十七条",
                 "text": "**第四十七条**　经济补偿按劳动者在本单位工作的年限，每满一年支付一个月工资的标准向劳动者支付。"}],
    )
    assert run(gen, kb)[0] == 0


# ── (d) --strict 点名 ───────────────────────────────────────────────────
@pytest.mark.parametrize("confidence", ["待核实", "二手转述"])
def test_strict_names_every_unverified_card(gen, kb, confidence):
    write_card(kb, "packs/statutes/ok.md", card_id="statute-ok", sources=[GOOD_SOURCE])
    write_card(kb, "packs/statutes/x.md", card_id="statute-x", confidence=confidence, sources=[GOOD_SOURCE])
    code, data = run(gen, kb)
    assert code != 0
    assert "statute-x" in str(code) and confidence in str(code), "die 必须点名，不能只报个数"
    assert data is None, "守卫没过就不该留下一份看起来正常的 index.json"


def test_strict_is_the_default(gen, kb):
    """默认必须是 strict。默认宽松的形态是：所有人都在跑那个不检查的版本。"""
    write_card(kb, "packs/statutes/x.md", card_id="statute-x", confidence="待核实", sources=[GOOD_SOURCE])
    assert run(gen, kb)[0] != 0


def test_no_strict_still_generates(gen, kb, capsys):
    write_card(kb, "packs/statutes/x.md", card_id="statute-x", confidence="待核实", sources=["https://www.sohu.com/x"])
    code, data = run(gen, kb, "--no-strict")
    assert code == 0 and [e["id"] for e in data] == ["statute-x"]
    assert "警告" in capsys.readouterr().err, "降级为警告，但不能一声不吭"


def test_no_strict_does_not_relax_the_pre_existing_checks(gen, kb):
    """--no-strict 只降那三道扎根守卫；卡片自洽那批校验一条不降。

    一个开关只有一种含义，才不会有人以为自己关掉的是别的东西。
    这里用的是既有的"facts 数值必须出现在正文"那条。
    """
    path = write_card(kb, "packs/data/x.md", card_id="data-x", card_type="数据卡", sources=[GOOD_SOURCE])
    text = path.read_text(encoding="utf-8").replace(
        "confidence: 原文核实",
        "confidence: 原文核实\nfacts:\n  values:\n    - {key: test_v, value: 12345, unit: 元, effective_from: '2026-01-01', confidence: 原文核实, source_idx: 0}",
    )
    path.write_text(text, encoding="utf-8")
    code, _ = run(gen, kb, "--no-strict")
    assert code != 0 and "两面不一致" in str(code)


# ── (e) D 类「无外部断言」的自证（README §2.2）────────────────────────
D = "无外部断言"


def test_d_class_card_passes_strict_without_any_url_source(gen, kb):
    """真的没有外部断言的卡：sources 是一段散文，strict 下也必须过。

    这是 D 类存在的全部理由——纯方法论/陪伴话术卡没有原件可核，
    给它记「原文核实」是个类别错误（说核过原文，而根本没有那份原文）。
    """
    write_card(
        kb, "packs/emotion/d.md", card_id="emotion-d", card_type="情绪指南",
        confidence=D, sources=["本卡不含外部事实断言：正文全部是本项目自己写的陪伴话术。"],
    )
    code, data = run(gen, kb)
    assert code == 0
    assert [e["id"] for e in data] == ["emotion-d"]


@pytest.mark.parametrize(
    "mutate, needle",
    [
        pytest.param(
            lambda fm: fm.__setitem__("law_refs", ["劳动合同法§47"]),
            "law_refs",
            id="带 law_refs",
        ),
        pytest.param(
            lambda fm: fm.__setitem__("sources", ["https://flk.npc.gov.cn/detail.html?id=x"]),
            "http",
            id="sources 里有官方 URL",
        ),
    ],
)
def test_d_class_must_really_have_no_external_claim(gen, kb, mutate, needle):
    """自称 D 类却带着外部断言 ⇒ 拒绝生成并点名。

    【为什么这道闸非有不可】D 类豁免了 (b) 的 host 闸。没有 (e) 的话，
    「无外部断言」就是一句谁都能贴、贴上就免检的话：随手写一张引着法条、
    报着数字的卡，标上 D，(b)(c)(d) 一道都不管它。
    注意第二个用例给的是一个**完全合规的官方 URL**——它照样要红，
    因为红的理由不是"这个出处不好"，而是"你说你没有出处"。
    """
    import yaml

    path = write_card(kb, "packs/emotion/d.md", card_id="emotion-d", card_type="情绪指南",
                      confidence=D, sources=["本卡不含外部事实断言。"])
    raw = path.read_text(encoding="utf-8")
    head, body = raw.split("---\n", 2)[1], raw.split("---\n", 2)[2]
    fm = yaml.safe_load(head)
    mutate(fm)
    path.write_text("---\n" + yaml.safe_dump(fm, allow_unicode=True, sort_keys=False) + "---\n" + body,
                    encoding="utf-8")
    code, _ = run(gen, kb)
    assert code != 0, "自称无外部断言却带着外部断言，居然过了"
    assert "emotion-d" in str(code) and needle in str(code)


def test_d_class_with_facts_is_rejected(gen, kb):
    """带 facts 的 D 类同样拒绝——facts 是被代码消费的**事实**，有它就是在断言外部世界。"""
    write_card(
        kb, "packs/emotion/d.md", card_id="emotion-d", card_type="情绪指南", confidence=D,
        sources=["本卡不含外部事实断言。"],
        quotes=[{"law": "中华人民共和国劳动合同法", "article": "第四十七条", "text": ORIGINAL.strip()}],
    )
    code, _ = run(gen, kb)
    assert code != 0 and "emotion-d" in str(code) and "facts" in str(code)


# ── 现库正对照 ────────────────────────────────────────────────────────
def test_real_library_is_green_under_strict(gen, tmp_path):
    """现库在 **默认 --strict** 下必须绿（2026-09-07 核实闭卷后的目标态）。

    【这条判据换过一次方向，记在这】守卫刚上线时（2026-09-07 上午）现库还有
    60 张待核实 + 21 张二手转述，那时这里钉的是**反过来的两条**：
    "--no-strict 下能出索引" + "strict 下必须红"。核实闭卷后现库全绿，
    那两条会以"现库居然不红了"的形式失败——**而那正是作业做完的标志**，不是回归。
    所以把它们换成现在这一条：现库 strict 绿，且索引里一张 `二手转述`／`待核实` 都没有。

    全程在临时副本上跑，不碰仓内 knowledge/。
    """
    root = tmp_path / "kb"
    shutil.copytree(REAL_KNOWLEDGE, root)
    code, data = run(gen, root)
    assert code == 0, f"现库 strict 下不再是绿的：{code}"
    assert len(data) > 100, "夹具没拷对？现库不该只有这么几张卡"
    bad = [e["id"] for e in data if e["confidence"] not in ("原文核实", "无外部断言")]
    assert bad == [], f"索引里还有既非原文核实也非无外部断言的卡：{bad}"


def test_real_library_goes_red_when_one_card_regresses(gen, tmp_path):
    """把现库的**一张**卡退回「二手转述 + 非官方源」⇒ strict 立刻红并点名。

    【为什么这条非有不可】上面那条"现库绿"单独存在时，把 grounding_guards 整个删掉
    也照样绿——一个从不拒绝的闸与一个不存在的闸，输出一模一样。
    这条是它的负对照：同一份现库、只坏一张卡，必须红，且报错里要有那张卡的 id。
    """
    root = tmp_path / "kb"
    shutil.copytree(REAL_KNOWLEDGE, root)
    victim = next(root.glob("packs/statutes/*.md"))
    text = victim.read_text(encoding="utf-8")
    text = text.replace("confidence: 原文核实", "confidence: 二手转述", 1)
    victim.write_text(text, encoding="utf-8")
    code, _ = run(gen, root)
    assert code != 0 and "扎根守卫不通过" in str(code)
    assert victim.stem in str(code), f"报错没点名是哪张卡：{code}"


def test_real_library_still_generates_with_no_strict(gen, tmp_path):
    """现库在 --no-strict 下同样出索引（这个开关本身还得能用）。

    闭卷后现库没有可降级的问题，所以这里不再断言"必有警告"——
    断言"必有警告"等于把"库里还有脏卡"写死成前提。
    """
    root = tmp_path / "kb"
    shutil.copytree(REAL_KNOWLEDGE, root)
    code, data = run(gen, root, "--no-strict")
    assert code == 0
    assert len(data) > 100
