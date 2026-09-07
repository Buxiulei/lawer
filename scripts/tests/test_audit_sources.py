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
