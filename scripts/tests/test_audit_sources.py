"""scripts/audit-sources.py 的判据：登记簿里 raw / text / 元数据是不是同一份文件。

**每一条都配正向对照。** 没有正向对照时，"审计在拦"与"夹具压根没跑起来"输出一模一样
（本仓 index-guard.test.ts 与 test_gen_guards.py 的头注释里各记过一次这个坑）。

【为什么这套判据非有不可】审计本身就是"发现没人在审"的那道闸。它坏掉的形态是**全绿**：
一个从不判红的审计与一个不存在的审计，在退出码上长得一模一样。所以下面每一条
"该红"的用例，都紧挨着一条"同一份夹具、只改这一处 ⇒ 变绿"的对照。
"""

from __future__ import annotations

import hashlib
import json

import pytest

from conftest import write_registry

BODY = "<html><body>第四十七条　经济补偿按劳动者在本单位工作的年限支付。</body></html>"
#: 2026-09-07 实见的那份 flk SPA 空壳（552 字节，正文由 JS 渲染）的骨架。
SHELL = '<!doctype html><html><head><title>国家法律法规数据库</title></head><body><div id="app"></div></body></html>'


def make_entry(root, source_id="s1", *, raw: str = BODY, text: str | None = None, ext="html", **overrides):
    """在临时知识库里造一条**自洽**的登记（raw/text/sha 三者对得上），再按 overrides 弄坏它。"""
    outdir = root / "sources" / "originals" / source_id
    outdir.mkdir(parents=True, exist_ok=True)
    raw_bytes = raw.encode("utf-8")
    (outdir / f"raw.{ext}").write_bytes(raw_bytes)
    entry = {
        "source_id": source_id,
        "kind": "法律",
        "name": "测试法源",
        "issuer": "某机关",
        "official_host": "flk.npc.gov.cn",
        "url": f"https://flk.npc.gov.cn/detail2.html?id={source_id}",
        "fetched_at": "2026-09-07T00:00:00+08:00",
        "content_sha256": hashlib.sha256(raw_bytes).hexdigest(),
        "version_label": "",
        "status": "现行",
        "files": {
            "raw": f"sources/originals/{source_id}/raw.{ext}",
            "text": f"sources/originals/{source_id}/text.txt",
        },
    }
    if text is None:
        # 缺省：用与 fetch-source 同一个抽取器抽出来的正文（即"本来就该长这样"）
        text = "第四十七条　经济补偿按劳动者在本单位工作的年限支付。"
    if text is not False:
        (outdir / "text.txt").write_text(text, encoding="utf-8")
    entry.update(overrides)
    return entry


def run(audit, root, *extra):
    try:
        return audit.main(["--knowledge-dir", str(root), *extra])
    except SystemExit as e:  # 兜底：本脚本用 return 不用 die，但别让退出码悄悄变形
        return e.code


def out(capsys):
    return capsys.readouterr().out


# ── 正向对照 ────────────────────────────────────────────────────────────
def test_clean_registry_is_green(audit, tmp_path, capsys):
    """一条完全自洽的登记必须绿。没有它，下面每条红都可能是别的原因红的。"""
    write_registry(tmp_path, [make_entry(tmp_path)])
    assert run(audit, tmp_path) == 0
    assert "复算一致 1" in out(capsys)


# ── ① sha256 ───────────────────────────────────────────────────────────
def test_sha_mismatch_is_red(audit, tmp_path, capsys):
    write_registry(tmp_path, [make_entry(tmp_path, content_sha256="0" * 64)])
    assert run(audit, tmp_path) == 1
    assert "sha256 对不上" in out(capsys)


# ── ② SPA 空壳 ─────────────────────────────────────────────────────────
def test_spa_shell_raw_is_red(audit, tmp_path, capsys):
    """2026-09-07 实见的那条：raw 是 flk 的 552 字节空壳，text 是从别处抓来的正文。"""
    write_registry(tmp_path, [make_entry(tmp_path, raw=SHELL, text="第四十七条　经济补偿按劳动者在本单位工作的年限支付。")])
    assert run(audit, tmp_path) == 1
    printed = out(capsys)
    assert "SPA 空壳" in printed
    # 同一条还会被③抓一次（text 不是从这份 raw 抽出来的）——两条都报，因为它们是两个病灶
    assert "不是从这份 raw 抽出来的" in printed


def test_a_real_page_that_merely_mentions_app_is_not_a_shell(audit, tmp_path):
    """负对照：正常长度的页面里出现 id="app" 不算空壳（闸认的是"又小又只有骨架"）。

    只按标记判的话，任何用了这个 id 的正常页面都会被误伤，而误伤会训练人忽略这条报警。
    """
    page = '<html><body><div id="app"></div>' + "第四十七条　经济补偿按劳动者在本单位工作的年限支付。" * 200 + "</body></html>"
    write_registry(tmp_path, [make_entry(tmp_path, raw=page)])
    assert run(audit, tmp_path) == 0


# ── ③ text 复算 ────────────────────────────────────────────────────────
def test_text_not_derived_from_raw_is_red(audit, tmp_path, capsys):
    """本票的病灶本体：text 是另一份文件的正文，raw 里根本没有这些字。"""
    write_registry(tmp_path, [make_entry(tmp_path, text="用人单位应当自用工之日起三十日内办理社会保险登记。")])
    assert run(audit, tmp_path) == 1
    assert "不是从这份 raw 抽出来的" in out(capsys)


def test_text_may_be_a_subset_of_the_extraction(audit, tmp_path):
    """正向对照：text 是重抽结果的**子串**也算过（登记时可能只留了正文段）。

    要求"完全相等"的话，抽取器改一行（多一个换行、少一个空格）就会让全库变红，
    而那种红没有任何信息量。
    """
    write_registry(tmp_path, [make_entry(tmp_path, text="经济补偿按劳动者在本单位工作的年限支付。")])
    assert run(audit, tmp_path) == 0


def test_whitespace_and_markdown_differences_do_not_count(audit, tmp_path):
    """归一之后比：全角空格、换行、加粗记号的差异不是实质差异。"""
    write_registry(tmp_path, [make_entry(tmp_path, text="第四十七条\n经济补偿按劳动者在\n本单位工作的年限支付。")])
    assert run(audit, tmp_path) == 0


def test_pdf_is_reported_as_underived_not_silently_passed(audit, tmp_path, capsys):
    """抽取需外部依赖的格式：**印出来并计数**，不静默放过，也不假装复算过。

    这是"量程"而不是"口子"：新登记的条目抽不出文本会被 fetch-source 标 needs_text，
    由 ④ 判红（见 test_needs_text_is_red）。
    """
    write_registry(
        tmp_path,
        [make_entry(tmp_path, ext="pdf", raw="%PDF-1.4 " + "x" * 5000, text="随便什么正文")],
    )
    assert run(audit, tmp_path) == 0
    printed = out(capsys)
    assert "未复算" in printed and "s1" in printed and "复算一致 0" in printed


# ── ④ needs_text ───────────────────────────────────────────────────────
def test_needs_text_is_red(audit, tmp_path, capsys):
    entry = make_entry(tmp_path, text=False, needs_text=True)
    entry["files"]["text"] = None
    write_registry(tmp_path, [entry])
    assert run(audit, tmp_path) == 1
    assert "needs_text=true" in out(capsys)


def test_needs_text_with_a_text_file_is_a_contradiction(audit, tmp_path, capsys):
    """既说抽不出正文、又登记了正文——必有一句是假的。"""
    write_registry(tmp_path, [make_entry(tmp_path, needs_text=True)])
    assert run(audit, tmp_path) == 1
    assert "互相矛盾" in out(capsys)


def test_null_text_without_needs_text_is_red(audit, tmp_path, capsys):
    """text=null 却没标 needs_text：无从判断是"还没抽"还是"抽过了忘了登记"。"""
    entry = make_entry(tmp_path, text=False)
    entry["files"]["text"] = None
    write_registry(tmp_path, [entry])
    assert run(audit, tmp_path) == 1
    assert "没标 needs_text" in out(capsys)


# ── ⑤ 量级 ─────────────────────────────────────────────────────────────
def test_text_longer_than_raw_is_red_even_for_underivable_types(audit, tmp_path, capsys):
    """对**所有**格式都成立的那一条：抽出来的正文不可能比它的原件长。

    它是③的第二重保险——③只覆盖抽得动的格式，这一条覆盖全部；
    2026-09-07 那条 552 字节 raw 配 23874 字 text 的记录，两条都抓得住。
    """
    write_registry(tmp_path, [make_entry(tmp_path, ext="pdf", raw="%PDF-1.4", text="正" * 500)])
    assert run(audit, tmp_path) == 1
    assert "比 raw 还大" in out(capsys)


# ── 元数据自洽 ──────────────────────────────────────────────────────────
def test_official_host_must_match_url_host(audit, tmp_path, capsys):
    write_registry(tmp_path, [make_entry(tmp_path, official_host="www.sohu.com")])
    assert run(audit, tmp_path) == 1
    assert "不一致" in out(capsys)


def test_missing_raw_file_is_red(audit, tmp_path, capsys):
    entry = make_entry(tmp_path)
    (tmp_path / entry["files"]["raw"]).unlink()
    write_registry(tmp_path, [entry])
    assert run(audit, tmp_path) == 1
    assert "原件不存在" in out(capsys)


def test_institution_kind_without_justification_refuses_to_load(audit, tmp_path):
    """kind=机构官网 却没写理由 ⇒ 登记簿加载即抛，不是"审计报一条"。

    它必须在**读登记簿**这一步炸：verify-quotes 与 gen-knowledge-index 都读同一个登记簿，
    只在审计里报的话，那两个照常拿着它跑。
    """
    entry = make_entry(tmp_path, kind="机构官网", official_host="www.example.org")
    entry["url"] = "https://www.example.org/x.html"
    write_registry(tmp_path, [entry])
    with pytest.raises(ValueError, match="justification"):
        audit.main(["--knowledge-dir", str(tmp_path)])


# ── CLI 面 ─────────────────────────────────────────────────────────────
def test_source_id_filter(audit, tmp_path, capsys):
    write_registry(tmp_path, [make_entry(tmp_path, "good"), make_entry(tmp_path, "bad", content_sha256="0" * 64)])
    assert run(audit, tmp_path, "--source-id", "good") == 0
    assert run(audit, tmp_path, "--source-id", "bad") == 1


def test_json_output_shape(audit, tmp_path, capsys):
    write_registry(tmp_path, [make_entry(tmp_path, "good"), make_entry(tmp_path, "bad", content_sha256="0" * 64)])
    assert run(audit, tmp_path, "--json") == 1
    payload = json.loads(out(capsys))
    assert payload["total"] == 2 and payload["bad"] == 1
    assert {r["source_id"] for r in payload["rows"]} == {"good", "bad"}


# ── 现库正对照 ────────────────────────────────────────────────────────
def test_real_registry_is_green(audit):
    """仓里这份登记簿必须审得过（2026-09-07 修完 statute-gerensuodeshuifa 之后的目标态）。

    跑的是**仓库里躺着的那一份**，不是副本——审计只读不写，没有弄坏它的路径。
    """
    assert audit.main([]) == 0


def test_real_registry_goes_red_when_one_raw_is_swapped(audit, tmp_path, capsys):
    """负对照：把现库拷一份、只把**一条**的 raw 换成 SPA 空壳 ⇒ 立刻红并点名。

    【为什么这条非有不可】上面那条"现库绿"单独存在时，把 audit_entry 整个改成
    `return {"problems": []}` 也照样绿——一个从不判红的审计与一个不存在的审计，
    在退出码上长得一模一样。
    """
    import shutil

    from conftest import REAL_KNOWLEDGE

    root = tmp_path / "kb"
    shutil.copytree(REAL_KNOWLEDGE, root)
    registry = json.loads((root / "sources.json").read_text(encoding="utf-8"))
    victim = next(e for e in registry if e["files"]["raw"].endswith(".html"))
    (root / victim["files"]["raw"]).write_text(SHELL, encoding="utf-8")
    assert run(audit, root) == 1
    printed = out(capsys)
    assert victim["source_id"] in printed and "SPA 空壳" in printed


#: 现库里复算不动的两条，都是 pdf（见 knowledge/README.md §7.5）。
#: 原先还有 zip 与 xls 那两条，它们的 text.txt 产自**旧路线**（fetch-source 还允许人工落 text
#: 的年代，块里甚至留着"补记：libreoffice 转换取得以上纯文本"这样的人写说明）。
#: 2026-09-07 收口时给 fetch-source 补了 .doc/.xls/.zip 的机械抽取器并整份重抽，
#: 两条都进了复算量程，于是从这份名单上划掉。
UNDERIVED_PIN = {
    "statute-beijing-gongzi-zhifu-guiding-doc",
    "statute-minsufa",
}


def test_real_registry_underived_set_is_pinned(audit, capsys):
    """现库"未复算"名单钉死在这两条上——多一条就红。

    【它防的是什么】审计对 pdf/zip/xls 只报"未复算"并**照常退 0**（§7.5：拿 pypdf 当判据
    会让同一份库这台机器红、那台机器绿）。于是"登记一条 pdf + 自己写一份 text.txt"
    这条路走完之后全库仍然全绿——正是本轮封掉的那个形态（`statute-gerensuodeshuifa`：
    raw 是空壳、text 另有出处）的近亲，只是换了个抽不动的扩展名。

    `fetch-source.py` 那一侧已经封死（抽不出正文就只落 raw 并标 `needs_text`，审计判红）；
    这颗钉子管的是**绕开 fetch-source、手写登记簿**的那条路，以及"未复算"这个桶
    悄悄变大——它是全库唯一一处"审计明说自己没审"的地方，变大必须有人看见。

    多出来的条目只有两种正当结局：换成可复算的格式重抓，或者在这里显式记一笔。
    "谁都没发现"与"看见了并认了"必须在判据里长得不一样。

    **少一条也要红**（`==` 而不是 `<=`）：桶变小是好事，但那意味着有人扩了抽取器的量程，
    而这份名单旁边那段"为什么它抽不动"的说明就此过期。过期的理由比没有理由更难发现。
    """
    assert audit.main(["--json"]) == 0
    payload = json.loads(out(capsys))
    underived = {r["source_id"] for r in payload["rows"] if r.get("derived") == "未复算"}
    assert underived == UNDERIVED_PIN, (
        "现库的「未复算」名单变了。新增的条目意味着又一份 text.txt 的来历无人复算过；"
        "先确认它不是手写的，再决定是重抓成可复算格式，还是把它加进 UNDERIVED_PIN 并写明理由。"
        "少了条目则说明抽取器的量程扩了，把这里和 knowledge/README.md §7.5 的说明一起更新。"
    )


def test_zip_and_xls_are_recomputed_from_their_raw(audit, capsys):
    """现库那份打包件（.zip）与那张年鉴表（.xls）**必须是复算过的**，不是"未复算"。

    【为什么单独钉这两条】它们的 raw 都叫 `raw.bin`（政府站发的 octet-stream，
    guess_ext 认不出扩展名），而 2026-09-07 之前的审计**只按扩展名**判能不能复算 ⇒
    它们永远归进"未复算"，于是 text.txt 里那份人工用 libreoffice 转出来、
    还带着一句"补记：…逐字核对无损"的正文，从来没有任何一处机械核过。
    上面那颗钉子只管"桶不许变大"，管不到"这两条到底有没有被真的算过"——
    它们从桶里消失，也可能是因为有人把它们从登记簿里删了。
    """
    assert audit.main(["--json"]) == 0
    rows = {r["source_id"]: r for r in json.loads(out(capsys))["rows"]}
    for sid in ("bjchy-banli-cailiao-baofuzhuang", "data-beijing-shepin-fengding"):
        assert rows[sid]["derived"] == "一致", f"{sid} 没被复算：{rows[sid]}"


def test_missing_extraction_tool_is_red_not_quietly_underived(audit, tmp_path, capsys, monkeypatch):
    """本机缺 olefile/xlrd 时，审计必须**判红并说出装哪个包**，不许退回"未复算"。

    【这是整条新量程的兜底判据】把 .doc/.xls/.zip 纳入复算，代价是引入了两个第三方包。
    那个代价唯一不可接受的兑现方式是——某台机器上包没装，审计于是"抽不动"，
    把这两条归进未复算的桶里、**照常退 0**，而人看到的是一份全绿的报告。
    这里就把那条路堵死：缺工具 ⇒ 退出码 1，且报错里有 pip 命令。

    做法是把抽取器的 `_need`（唯一的 import 入口）换成"永远说没装"，
    其余一个字不改——模拟的是一台干净机器，不是一个坏掉的审计。
    """
    import shutil

    from conftest import REAL_KNOWLEDGE

    root = tmp_path / "kb"
    shutil.copytree(REAL_KNOWLEDGE, root)
    fetch = audit._load_fetch_source()

    def _no_tools(mod, pkg, why):
        raise fetch.MissingTool(f"缺什么：Python 包 {pkg}。\n  为什么：{why}\n  怎么办：pip install --user {pkg}")

    monkeypatch.setattr(fetch, "_need", _no_tools)
    monkeypatch.setattr(audit, "_load_fetch_source", lambda: fetch)
    assert run(audit, root, "--json") == 1, "缺工具却绿了——这正是本条判据要防的那份全绿报告"
    rows = {r["source_id"]: r for r in json.loads(out(capsys))["rows"]}
    # **逐条看，不看整篇**：只 assert"报告里出现过 pip 那句话"是过不了变异的——
    # 打包件那条被悄悄归进"未复算"、年鉴那条判红，整篇里照样有它。
    for sid in ("bjchy-banli-cailiao-baofuzhuang", "data-beijing-shepin-fengding"):
        row = rows[sid]
        assert row["derived"] != "未复算", f"{sid} 缺工具却被归进「未复算」并放过：{row}"
        assert row["problems"] and "pip install --user" in "\n".join(row["problems"]), row
    assert "olefile" in "\n".join(rows["bjchy-banli-cailiao-baofuzhuang"]["problems"])
