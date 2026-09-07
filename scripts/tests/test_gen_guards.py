"""scripts/gen-knowledge-index.py 扎根守卫的判据。

(a) 隔离区排除 · (b) 官方 host 白名单 · (c) 引文对得上原件 · (d) --strict 点名 ·
(e) D 类「无外部断言」的自证

每一条都配正向对照。没有正向对照时，"守卫在拦"与"夹具压根没跑起来"输出一模一样——
本仓 index-guard.test.ts 的头注释里已经记过一次这个坑（M1 拆掉闸 9 条仍全绿）。
"""

from __future__ import annotations

import json
import shutil
import sys

import pytest

from conftest import SCRIPTS, REAL_KNOWLEDGE, write_card, write_original, write_registry

sys.path.insert(0, str(SCRIPTS))
import knowledge_sources as ks  # noqa: E402

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
    # 隔离卡的 confidence 只能是「待核实」/「二手转述」（守卫 (h)，见本文件末尾那一组）——
    # 这里写 待核实 不是为了绕开 (h)，而是因为**隔离卡本来就该长这样**。
    write_card(kb, "quarantine/statutes/bad.md", card_id="statute-bad", confidence="待核实",
               sources=["https://zh.wikisource.org/x"])
    write_card(kb, "packs/quarantine/worse.md", card_id="statute-worse", confidence="待核实",
               sources=["https://www.sohu.com/x"])
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
    """现库在 **默认 --strict** 下一条守卫都不红，且重新生成的索引与仓里那份逐字节相同。

    【这条判据换过三次方向，记在这】
    · 守卫刚上线时（2026-09-07 上午）钉的是"strict 下必须红"（当时 60 张待核实）；
    · 核实闭卷后换成"strict 下必须绿"；
    · (f)（判例卡必须有核得过的 case_quotes）落地当天**机制先于内容**：42 张存量判例卡
      还没补引文，于是现库又红了，判据一度钉的是"红的形状"——报错里必须有 (f)、
      且不能有别的守卫编号，免得"反正它本来就红"盖过 (b)(c)(d)(e)(g)(h) 的回归；
    · case_quotes 补齐后（2026-09-07 收口）回到"必须绿"。上一版的注释里写着
      "补完之后这条会以「(f) 不再出现」的形式失败，届时把断言改成一条都不红"——就是这一版。

    **绿也有形状**：不是只看退出码。还要求重新生成的 index.json 与拷进来的那份
    （即仓库里提交的那份）逐字节相同——少了这一条，"改了卡没重跑生成器"会让索引与卡片
    静默分叉，而退出码照常是 0。CI 里那条 `git diff --exit-code knowledge/index.json`
    守的是同一件事，这里是它的离线形态。

    全程在临时副本上跑，不碰仓内 knowledge/。
    """
    root = tmp_path / "kb"
    shutil.copytree(REAL_KNOWLEDGE, root)
    before = (root / "index.json").read_bytes()
    code, _ = run(gen, root)
    assert code == 0, f"现库在 strict 下红了，这是回归不是已知欠账：\n{str(code)[:2000]}"
    assert (root / "index.json").read_bytes() == before, (
        "strict 过了，但重新生成的 index.json 与仓库里那份不同"
        "——有人改了卡没重跑生成器，或手改过索引"
    )


def test_real_library_generates_with_no_strict_and_has_no_unverified_confidence(gen, tmp_path):
    """现库 --no-strict 下出得来索引，且索引里一张 `二手转述`／`待核实` 都没有。

    (d) 那条"全库原文核实"的成果在这里独立钉一次——上面那条只看报错文本，
    看不见索引内容；两条合起来才既盯住"没有新的红"又盯住"旧的绿没退化"。
    """
    root = tmp_path / "kb"
    shutil.copytree(REAL_KNOWLEDGE, root)
    code, data = run(gen, root, "--no-strict")
    assert code == 0
    assert len(data) > 100, "夹具没拷对？现库不该只有这么几张卡"
    # 【2026-09-07 收口：现库已没有豁免目录】counseling 包核实完毕、GROUNDING_PENDING 已删，
    # 于是这里不再需要"豁免内/豁免外"分两句数——**全库一张都不许有**。
    # 分两句那版留在下面 test_real_library_has_no_grounding_pending_left：
    # 它盯的是"豁免目录数为 0"这件事本身，一旦有人再放一个 GROUNDING_PENDING 进来就红；
    # 本条盯的是索引内容，两条合起来才既拦住"卡退化"又拦住"用豁免文件把退化盖住"。
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


# ── (f) 判例卡必须有核得过的 case_quotes ────────────────────────────────
CASE_ORIGINAL = "第九个典型案例指出，劳动者未履行请假手续且请假合理性存疑，其擅自离岗构成旷工。\n"


@pytest.fixture
def kb_with_case_source(tmp_path):
    """一个既有法条原件、又有官方案例原件的临时库。"""
    write_registry(
        tmp_path,
        [
            write_original(tmp_path, "lhtf", ORIGINAL, name="中华人民共和国劳动合同法"),
            write_original(tmp_path, "dxal", CASE_ORIGINAL, kind="官方案例", name="某法院典型案例发布页"),
        ],
    )
    return tmp_path


def test_case_card_with_a_verified_case_quote_passes(gen, kb_with_case_source):
    """正向对照：判例卡带一条对得上官方页的 case_quotes ⇒ strict 下必须过。

    没有它，下面每条红都可能是"判例卡怎么写都过不了"。
    """
    write_card(
        kb_with_case_source, "packs/cases/ok.md", card_id="case-ok", card_type="判例卡",
        sources=[GOOD_SOURCE],
        case_quotes=[{"source_id": "dxal", "text": "劳动者未履行请假手续且请假合理性存疑，其擅自离岗构成旷工。", "note": "案例九要旨"}],
    )
    code, data = run(gen, kb_with_case_source)
    assert code == 0, code
    assert [e["id"] for e in data] == ["case-ok"]


def test_case_card_without_case_quotes_is_rejected(gen, kb_with_case_source):
    """判例卡一条 case_quotes 都没有 ⇒ 拒绝生成并点名。

    【为什么这道闸非有不可】判例卡最常见的失效不是"没有出处"，而是**出处是真的、
    案情是转载站编的**：官方通稿只给一句话要旨，卡里却写着当事人姓名、金额、
    大段"裁判理由原文"。要求至少一句逐字对得上官方页，等于逼这张卡至少有一句话
    是从原件上抄下来的。
    """
    write_card(kb_with_case_source, "packs/cases/bad.md", card_id="case-bad", card_type="判例卡", sources=[GOOD_SOURCE])
    code, _ = run(gen, kb_with_case_source)
    assert code != 0
    assert "(f)" in str(code) and "case-bad" in str(code)


def test_case_quote_that_does_not_match_the_original_does_not_count(gen, kb_with_case_source):
    """有 case_quotes 但对不上原件 ⇒ 照样不算数（"有这个字段"不是判据）。

    只数字段个数的话，往卡里塞一句自己编的话就能过闸——而那正是这道闸要防的东西。
    """
    write_card(
        kb_with_case_source, "packs/cases/bad.md", card_id="case-bad", card_type="判例卡",
        sources=[GOOD_SOURCE],
        case_quotes=[{"source_id": "dxal", "text": "劳动者未履行请假手续的，一律构成旷工并可解除劳动合同。"}],
    )
    code, _ = run(gen, kb_with_case_source)
    assert code != 0
    assert "(c)" in str(code) and "(f)" in str(code), "既要报「引文对不上」也要报「这张卡没有核得过的引文」"


def test_case_quote_without_source_id_is_not_verifiable(gen, kb_with_case_source):
    """case_quotes 不写 source_id ⇒ 当场拒绝（判例没有"法名"可以拿去猜原件）。"""
    write_card(
        kb_with_case_source, "packs/cases/bad.md", card_id="case-bad", card_type="判例卡",
        sources=[GOOD_SOURCE],
        case_quotes=[{"text": "劳动者未履行请假手续且请假合理性存疑，其擅自离岗构成旷工。"}],
    )
    code, _ = run(gen, kb_with_case_source)
    assert code != 0 and "source_id" in str(code)


def test_case_quote_must_also_appear_in_the_card_body(gen, kb_with_case_source):
    """两面一致对 case_quotes 同样成立：facts 里写着、正文里没有 ⇒ 拒绝。

    这条属于"卡片自洽"那一批，**--no-strict 也不降**。
    """
    path = write_card(
        kb_with_case_source, "packs/cases/bad.md", card_id="case-bad", card_type="判例卡",
        sources=[GOOD_SOURCE],
        case_quotes=[{"source_id": "dxal", "text": "劳动者未履行请假手续且请假合理性存疑，其擅自离岗构成旷工。"}],
    )
    head, body = path.read_text(encoding="utf-8").split("---\n", 2)[1:]
    path.write_text("---\n" + head + "---\n正文里没有那句话。\n", encoding="utf-8")
    code, _ = run(gen, kb_with_case_source, "--no-strict")
    assert code != 0 and "与正文不逐字一致" in str(code)


def test_non_case_card_needs_no_case_quotes(gen, kb_with_case_source):
    """负对照：法条卡不受 (f) 管。闸若写成"所有卡都要有 case_quotes"，全库当场停摆。"""
    write_card(kb_with_case_source, "packs/statutes/ok.md", card_id="statute-ok", sources=[GOOD_SOURCE])
    assert run(gen, kb_with_case_source)[0] == 0


def test_case_type_card_outside_cases_dir_is_still_covered(gen, kb_with_case_source):
    """判例卡放到 packs/statutes/ 下也一样要过 (f)——闸认的是类型，不只是目录。

    只认目录的话，把文件挪个位置就能绕过去，而挪位置不需要理由。
    """
    write_card(kb_with_case_source, "packs/statutes/sneaky.md", card_id="case-sneaky",
               card_type="判例卡", sources=[GOOD_SOURCE])
    code, _ = run(gen, kb_with_case_source)
    assert code != 0 and "case-sneaky" in str(code)


# ── (g) 机构官网只给数据卡用 ────────────────────────────────────────────
INST_URL = "https://www.example-hospital.org/kepu/4049.html"


def _kb_with_institution(tmp_path):
    entry = write_original(tmp_path, "inst", ORIGINAL, name="某机构官网页")
    entry.update(
        {
            "kind": "机构官网",
            "official_host": "www.example-hospital.org",
            "url": INST_URL,
            "justification": "这条热线由该机构自己运行，号码与服务时间是它自己公布的",
        }
    )
    write_registry(tmp_path, [write_original(tmp_path, "lhtf", ORIGINAL, name="中华人民共和国劳动合同法"), entry])
    return tmp_path


def test_institution_source_is_allowed_on_a_data_card(gen, kb):
    """正向对照：数据卡引机构官网 ⇒ 过。这是这个 kind 存在的全部理由。"""
    root = _kb_with_institution(kb)
    write_card(root, "packs/data/x.md", card_id="data-x", card_type="数据卡", sources=[INST_URL])
    assert run(gen, root)[0] == 0


@pytest.mark.parametrize("card_type", ["法条卡", "判例卡", "流程SOP", "计算规则", "情绪指南"])
def test_institution_source_rejected_on_every_other_card_type(gen, kb, card_type):
    """机构官网被数据卡之外的卡引用 ⇒ 拒绝生成并点名。

    【为什么不能并进 (b) 的 host 闸】(b) 问"这是不是一手源"，答案是"是——机构自己的官网"；
    (g) 问"这份一手源能拿来断言什么"，答案是"只有它自己的事"。合成一道的形态是：
    某个 host 为了一条热线号码进了白名单，从此一张法条卡可以拿某医院的科普文当法律依据。
    """
    root = _kb_with_institution(kb)
    rel = "packs/cases/x.md" if card_type == "判例卡" else "packs/statutes/x.md"
    write_card(root, rel, card_id="card-x", card_type=card_type, sources=[INST_URL])
    code, _ = run(gen, root)
    assert code != 0
    assert "(g)" in str(code) and "card-x" in str(code)


def test_institution_source_rejected_when_referenced_only_by_source_id(gen, kb):
    """从 sources 里拿掉、只在 facts 的 source_id 里引 ⇒ 照样红。

    只查 sources 的话，把 URL 从 sources 删掉、留着 facts 里的 source_id 就能绕过去，
    而**代码消费的恰恰是 facts 那一面**。
    """
    root = _kb_with_institution(kb)
    write_card(
        root, "packs/statutes/x.md", card_id="statute-x", sources=[GOOD_SOURCE],
        quotes=[{"law": "某机构官网页", "article": "收费表", "source_id": "inst", "text": ORIGINAL.strip()}],
    )
    code, _ = run(gen, root)
    assert code != 0 and "(g)" in str(code) and "inst" in str(code)


def test_industry_norm_is_not_restricted_to_data_cards(gen, kb):
    """负对照：`行业规范`（真正的规范文件）不受 (g) 管，任何卡都能引。

    两个 kind 若在这里表现一致，那就说明 (g) 认的不是 kind 而是别的东西。
    """
    entry = write_original(kb, "ethics", ORIGINAL, name="某学会伦理守则")
    entry.update({"kind": "行业规范", "official_host": "www.example-society.org",
                  "url": "https://www.example-society.org/ethics.html"})
    write_registry(kb, [write_original(kb, "lhtf", ORIGINAL, name="中华人民共和国劳动合同法"), entry])
    write_card(kb, "packs/statutes/x.md", card_id="statute-x",
               sources=["https://www.example-society.org/ethics.html"])
    assert run(gen, kb)[0] == 0


# ── (h) 隔离区的标签不许撒谎 ────────────────────────────────────────────
@pytest.mark.parametrize("rel", ["quarantine/cases/x.md", "packs/cases/quarantine/x.md"])
@pytest.mark.parametrize("confidence", ["原文核实", "无外部断言"])
def test_quarantine_card_may_not_claim_an_indexable_confidence(gen, kb, rel, confidence):
    """隔离卡挂「原文核实」/「无外部断言」⇒ 拒绝生成并点名。

    隔离区的卡本来就不进索引，所以这道闸管的**不是**它会不会被检索到，
    而是**标签会不会撒谎**：搬回 packs/ 只是一次 mv，搬的人看到"原文核实"
    会以为核实这一步已经有人做过了——而它进隔离区的全部理由就是核不动。
    两种摆法都要拦：闸认的是**目录段**，不是某一条固定路径。
    """
    write_card(kb, "packs/statutes/ok.md", card_id="statute-ok", sources=[GOOD_SOURCE])
    write_card(kb, rel, card_id="case-q", confidence=confidence, sources=["本卡没有出处。"])
    code, _ = run(gen, kb)
    assert code != 0
    assert "(h)" in str(code) and "x.md" in str(code) and confidence in str(code)


@pytest.mark.parametrize("confidence", ["待核实", "二手转述"])
def test_quarantine_card_with_an_honest_label_passes(gen, kb, confidence):
    """负对照：诚实的标签放行。闸若写成"隔离区一律红"，整个隔离区当场没法存在。"""
    write_card(kb, "packs/statutes/ok.md", card_id="statute-ok", sources=[GOOD_SOURCE])
    write_card(kb, "quarantine/cases/x.md", card_id="case-q", confidence=confidence,
               sources=["https://www.sohu.com/x"])
    code, data = run(gen, kb)
    assert code == 0
    assert [e["id"] for e in data] == ["statute-ok"]


# ── 现库的两条数据判据（本轮裁定②⑥的落地面）────────────────────────────
REVIVED_CASE = "case-qingjia-shouxu-maodun-kuanggong-2025"


def test_revived_case_card_is_grounded_and_not_in_the_case_quotes_gap(gen, tmp_path):
    """搬回 packs/cases/ 的那张卡（三中院 2025 典型案例·案例九）必须**自己过 (f)**。

    【为什么要单独钉】它是"从隔离区复活"的样板：复活的正确做法是把卡改成只断言官方页
    逐字写着的那一句，再用 case_quotes 把那一句钉到原件上。若哪天有人把它的 case_quotes
    删了、或把案情细节又加回来，这条会以"它出现在 (f) 名单里"的形式失败，
    并且**直接点出是哪张卡**——上面那条 test_real_library_is_green_under_strict 只会说
    "现库红了"，而红的原因可能是任意一张卡的任意一条守卫。
    """
    root = tmp_path / "kb"
    shutil.copytree(REAL_KNOWLEDGE, root)
    assert (root / "packs" / "cases" / f"{REVIVED_CASE[len('case-'):]}.md").exists(), "卡不在 packs/cases/ 下"
    code, _ = run(gen, root)
    lines = [ln for ln in str(code).splitlines() if REVIVED_CASE in ln]
    assert lines == [], f"复活的那张卡自己没站住：{lines}"


@pytest.mark.parametrize("needle", ["wikisource", "sohu"])
def test_packs_never_name_a_reprint_site(needle):
    """`packs/` 的说明文字里不许再出现转载站的站名（经理 2026-09-07 裁定⑥）。

    【为什么连"说明里提一句"都不行】这些字样出现在卡里时，形态永远是
    "此前版本来自 sohu.com，已删除"——一句本意是自证清白的话。但它同时在**卡的正文里**
    留下了一个可检索的站名，而卡的正文是要喂给模型的：模型看到的是"这张卡与 sohu 有关"，
    看不到那半句"已删除"。统一改写成「非官方转载站」，语义一个字不少，站名不进上下文。
    """
    hits = [
        f"{p}:{i}"
        for p in sorted((REAL_KNOWLEDGE / "packs").glob("**/*.md"))
        for i, line in enumerate(p.read_text(encoding="utf-8").splitlines(), 1)
        if needle in line
    ]
    assert hits == [], f"packs/ 里还留着「{needle}」：\n" + "\n".join(hits)


# ── 显式豁免 GROUNDING_PENDING ──────────────────────────────────────────
#
# 【这几条守的是什么】豁免是一个"合法地不合规"的口子，它最容易长歪的三种形态：
#   · 罩得太宽——一个文件让全库都不检；
#   · 撕不掉——删了文件还照样豁免（那它就不是豁免，是永久放行）；
#   · 到期不失效——到期日变成一句没人看的说明，而"还没到期"与"根本没人管"在外部同形。
# 下面四条各钉一个，外加一条正对照（不带这个文件的目录必须照常判红）。
BAD_QUOTE = {"law": "中华人民共和国劳动合同法", "article": "第四十七条",
             "text": "本句完全不在这份原件里出现过，而且它自称原文核实。"}


def _pending_file(root, rel_dir, until="2099-01-01"):
    d = root / rel_dir
    d.mkdir(parents=True, exist_ok=True)
    (d / ks.GROUNDING_PENDING).write_text(
        f"# 测试用豁免\n\n最迟: {until}\n\n欠账：判据夹具。\n", encoding="utf-8"
    )


def test_card_in_a_pending_dir_is_exempt_from_grounding_guards(gen, kb, capsys):
    """带 GROUNDING_PENDING 的目录：一张 (c) 必红的卡也放行，且 stderr 说清楚欠了几张、欠到哪天。"""
    write_card(kb, "packs/pending/bad.md", card_id="statute-pending-bad", quotes=[BAD_QUOTE])
    _pending_file(kb, "packs/pending")
    code, data = run(gen, kb)
    assert code == 0, f"豁免目录里的卡不该拦住生成：{code}"
    assert [e["id"] for e in data] == ["statute-pending-bad"], "豁免的是守卫，不是入索引"
    err = capsys.readouterr().err
    assert "packs/pending" in err and "1 张" in err and "2099-01-01" in err


def test_the_same_card_outside_the_pending_dir_still_goes_red(gen, kb):
    """正对照：同一张卡放在**没有**豁免文件的目录里 ⇒ 照常判红并点名。

    没有这一条，把守卫整个删掉上面那条也绿——"豁免生效"与"守卫不存在"输出一模一样。
    """
    write_card(kb, "packs/elsewhere/bad.md", card_id="statute-elsewhere-bad", quotes=[BAD_QUOTE])
    _pending_file(kb, "packs/pending")   # 豁免文件在另一个目录里，罩不到这张
    code, _ = run(gen, kb)
    assert code != 0 and "statute-elsewhere-bad" in str(code)


def test_deleting_the_pending_file_restores_the_guards(gen, kb):
    """删掉那个文件即恢复守卫——豁免必须是撕得掉的。

    【为什么单测"删掉"这一步】豁免若靠脚本里一份名单实现，删起来要改代码、要过 review，
    于是它会留着。这条钉的是"这个口子的开关就是这个文件本身"。
    """
    write_card(kb, "packs/pending/bad.md", card_id="statute-pending-bad", quotes=[BAD_QUOTE])
    _pending_file(kb, "packs/pending")
    assert run(gen, kb)[0] == 0
    (kb / "packs/pending" / ks.GROUNDING_PENDING).unlink()
    code, _ = run(gen, kb)
    assert code != 0 and "statute-pending-bad" in str(code)


def test_expired_pending_stops_exempting_and_names_the_file(gen, kb):
    """到期即失效，且报错里印着那个文件与到期日。

    到期日若不被任何东西读，它与没有到期日是同一件事。
    """
    write_card(kb, "packs/pending/bad.md", card_id="statute-pending-bad", quotes=[BAD_QUOTE])
    _pending_file(kb, "packs/pending", until="2020-01-01")
    code, _ = run(gen, kb)
    assert code != 0
    assert "豁免已过期" in str(code) and "2020-01-01" in str(code)
    assert ks.GROUNDING_PENDING in str(code), "报错没说是哪个文件过期了"


def test_pending_file_without_a_deadline_is_rejected(gen, kb):
    """没写到期日的豁免文件一律抛错——一份不会到期的豁免等于永久放行。"""
    write_card(kb, "packs/pending/ok.md", card_id="statute-pending-ok",
               quotes=[{"law": "中华人民共和国劳动合同法", "article": "第四十七条",
                        "text": "经济补偿按劳动者在本单位工作的年限"}])
    d = kb / "packs/pending"
    d.mkdir(parents=True, exist_ok=True)
    (d / ks.GROUNDING_PENDING).write_text("先欠着，回头补。\n", encoding="utf-8")
    with pytest.raises(ValueError, match="没写到期日"):
        run(gen, kb)


def test_real_library_has_no_grounding_pending_left(gen):
    """现库**一个豁免目录都没有**（2026-09-07：counseling 包核实完毕，欠条已销）。

    【这条为什么不是"删掉就行"】豁免是唯一一个"合法地不合规"的口子。原判据钉的是
    "现库的豁免只有 counseling 一处、到期日是那天"——欠条销掉之后，那句话没有东西可钉了，
    但**口子还在**：下一个包只要抄一份 GROUNDING_PENDING 进来就整包免检，
    而全库判据一条都不会红（上面那条"索引里不许有待核实卡"会被豁免绕过去）。
    所以判据从"豁免恰好是这一处"改成"一处都没有"——机制判据（豁免生效/过期即红/
    没写到期日即拒）全部留在上面那批夹具测试里，一条没删：**机制照旧能用，
    只是现库不再用它**。将来某个包真要欠账，改这条并在这里写明欠的是什么、欠到哪天。
    """
    pending = ks.load_pending(REAL_KNOWLEDGE)
    assert pending == {}, (
        f"现库出现了扎根守卫豁免目录：{sorted(pending)}。"
        "豁免会让那个目录整包退出 (b)–(h)，且不会有任何一条全库判据变红——"
        "要用它就改这条判据并写明欠账内容与到期日。"
    )


# ── 两把尺子必须是同一把 ────────────────────────────────────────────────
def test_gen_and_verify_share_one_verbatim_ruler(gen, verify):
    """gen 的引文归一与 verify-quotes 的**是同一个函数对象**（经理 2026-09-07 裁定）。

    "卡片正文 ↔ 本卡 facts" 与 "卡片 ↔ 官方原件" 判的都是"这段字一不一样"。
    两处各写一把尺的形态是同一张卡在两把尺下一绿一红——而对外只报绿的那把。
    """
    assert gen.ks.normalize_quote is verify.ks.normalize_quote


def test_quote_ruler_does_not_drop_thousands_separators(gen, kb):
    """引文那把尺**不**吃千分位逗号：facts 写 1,000、正文写 1000 ⇒ 两面不一致，拒绝生成。

    【为什么这条是上一条的必要配套】上一条只比函数对象是不是同一个，
    把引文校验换回 `normalize()`（= 逐字尺 + 去千分位）照样绿——两者只在这一位上不同。
    这条钉的就是那一位：数值那一面可以把 2,032 与 2032 当同一个数，引文那一面不行，
    "逐字"里没有"顺手把标点抹平"这一档。
    """
    card = write_card(
        kb, "packs/statutes/thousands.md", card_id="statute-thousands",
        quotes=[{"law": "中华人民共和国劳动合同法", "article": "第四十七条", "text": "赔偿 1,000 元"}],
        body="正文占位。",
    )
    # write_card 把 quote 原样抄进正文；这里只把正文那一份的逗号去掉，facts 不动
    card.write_text(card.read_text(encoding="utf-8").replace("> 赔偿 1,000 元", "> 赔偿 1000 元"), encoding="utf-8")
    code, _ = run(gen, kb)
    assert code != 0 and "与正文不逐字一致" in str(code), code


def test_numeric_facts_still_tolerate_thousands_separators(gen, kb):
    """反向对照：`facts.values` 写 1000、正文写「1,000 元」⇒ 照常通过。

    没有这一条，把千分位那一层一并删掉上一条也绿，而那会让全库
    每一张写着「2,540 元/月」的计算卡当场判两面不一致。
    """
    card = kb / "packs/data/num.md"
    card.parent.mkdir(parents=True, exist_ok=True)
    card.write_text(
        "---\n"
        "id: data-num\ntype: 数据卡\ntitle: 测试数值卡\nkeywords: [\"测试\"]\napplies_to: [\"欠薪\"]\n"
        "region: 全国\nsources: [\"https://flk.npc.gov.cn/detail2.html?id=lhtf\"]\n"
        "confidence: 原文核实\nupdated: '2026-09-07'\n"
        "facts:\n  values:\n    - key: test_thousand\n      value: 1000\n      unit: 元\n"
        "      effective_from: '2026-01-01'\n      confidence: 原文核实\n      source_idx: 0\n"
        "---\n\n本卡口径：1,000 元。\n",
        encoding="utf-8",
    )
    code, data = run(gen, kb)
    assert code == 0, code
    assert [e["id"] for e in data] == ["data-num"]
