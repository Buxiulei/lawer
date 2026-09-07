"""scripts/fetch-source.py 的判据：host 闸与幂等。

**全程不打网络**：download() 被换成返回固定字节的假货。测的是"这个脚本让不让抓、
抓完写成什么样"，不是"那个网站今天在不在"——后者的红是噪音，会训练人忽略这套判据。
"""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from conftest import write_registry

GOV_URL = "https://flk.npc.gov.cn/detail2.html?id=abc"
NON_GOV_URL = "https://zh.wikisource.org/wiki/某判决书"
NORM_URL = "https://www.example-society.org/ethics.html"

BASE = ["--name", "测试法源", "--issuer", "某机关"]


def run(fetch, tmp_path, argv, content=b"<html>\xe6\xad\xa3\xe6\x96\x87</html>", ctype="text/html"):
    """跑一次 CLI，download 换成假货。返回退出码（SystemExit 也折成退出码）。"""
    fetch.download = lambda url: (content, {"http_status": 200, "content_type": ctype, "fetch_method": "fake", "fetch_url": url})
    try:
        return fetch.main([*argv, "--knowledge-dir", str(tmp_path)])
    except SystemExit as e:
        return e.code


def registry(tmp_path):
    p = tmp_path / "sources.json"
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else []


# ── host 闸 ─────────────────────────────────────────────────────────────
def test_gov_host_passes(fetch, tmp_path):
    """正向对照：.gov.cn 能抓。没有它，下面每条"拒绝"都可能是任何别的原因拒的。"""
    code = run(fetch, tmp_path, ["--source-id", "ok-1", "--kind", "法律", "--url", GOV_URL, *BASE])
    assert code == 0
    assert [e["source_id"] for e in registry(tmp_path)] == ["ok-1"]
    assert (tmp_path / "sources/originals/ok-1/raw.html").exists()
    assert (tmp_path / "sources/originals/ok-1/text.txt").exists()
    assert (tmp_path / "sources/originals/ok-1/meta.json").exists()


def test_non_gov_host_rejected(fetch, tmp_path, capsys):
    code = run(fetch, tmp_path, ["--source-id", "bad-1", "--kind", "法律", "--url", NON_GOV_URL, *BASE])
    assert code != 0
    # 拒绝理由必须点名 host 并给出出路——裸报错会让人以为脚本坏了，转头去别处抓
    msg = str(code)
    assert "zh.wikisource.org" in msg and "行业规范" in msg
    assert not (tmp_path / "sources.json").exists(), "被拒的源绝不能留下登记条目"


def test_non_gov_download_never_happens(fetch, tmp_path):
    """闸必须在下载**之前**。落到磁盘之后再拒，等于转载件已经进了工作目录。"""

    def boom(url):
        raise AssertionError(f"不该下载：{url}")

    fetch.download = boom
    with pytest.raises(SystemExit):
        fetch.main(["--source-id", "bad-2", "--kind", "法律", "--url", NON_GOV_URL, *BASE, "--knowledge-dir", str(tmp_path)])


def test_industry_norm_with_issuer_host_passes(fetch, tmp_path):
    """行业规范 + 显式 --issuer-host 是唯一的非 .gov.cn 出路。"""
    code = run(
        fetch,
        tmp_path,
        ["--source-id", "ethics-1", "--kind", "行业规范", "--url", NORM_URL, "--issuer-host", "www.example-society.org", *BASE],
    )
    assert code == 0
    assert registry(tmp_path)[0]["official_host"] == "www.example-society.org"


def test_industry_norm_without_issuer_host_rejected(fetch, tmp_path):
    code = run(fetch, tmp_path, ["--source-id", "ethics-2", "--kind", "行业规范", "--url", NORM_URL, *BASE])
    assert code != 0


def test_issuer_host_must_match_url_host(fetch, tmp_path):
    """--issuer-host 写成别的 host 就放行的话，这个参数等于一个万能开关。"""
    code = run(
        fetch,
        tmp_path,
        ["--source-id", "ethics-3", "--kind", "行业规范", "--url", NORM_URL, "--issuer-host", "www.other.org", *BASE],
    )
    assert code != 0
    assert "www.other.org" in str(code)


def test_non_gov_kind_law_with_issuer_host_still_rejected(fetch, tmp_path):
    """--issuer-host 只对 kind=行业规范 开口；对法律/司法解释一律不认。"""
    code = run(
        fetch,
        tmp_path,
        ["--source-id", "bad-3", "--kind", "法律", "--url", NON_GOV_URL, "--issuer-host", "zh.wikisource.org", *BASE],
    )
    assert code != 0


# ── 幂等 ────────────────────────────────────────────────────────────────
def test_same_url_same_sha_is_noop(fetch, tmp_path, capsys):
    argv = ["--source-id", "idem-1", "--kind", "法律", "--url", GOV_URL, *BASE]
    assert run(fetch, tmp_path, argv) == 0
    first = registry(tmp_path)[0]
    capsys.readouterr()
    assert run(fetch, tmp_path, argv) == 0
    assert "未变化" in capsys.readouterr().out
    assert registry(tmp_path)[0] == first, "同 URL 同 sha 不该动登记簿（fetched_at 也不该刷新）"


def test_changed_content_updates_sha(fetch, tmp_path):
    argv = ["--source-id", "idem-2", "--kind", "法律", "--url", GOV_URL, *BASE]
    assert run(fetch, tmp_path, argv) == 0
    before = registry(tmp_path)[0]
    assert run(fetch, tmp_path, argv, content=b"<html>\xe6\x94\xb9\xe4\xba\x86</html>") == 0
    after = registry(tmp_path)[0]
    assert after["content_sha256"] != before["content_sha256"]
    assert "改了" in (tmp_path / "sources/originals/idem-2/text.txt").read_text(encoding="utf-8")


def test_metadata_only_change_is_written(fetch, tmp_path):
    """字节没变但 status 改了，也必须落盘——否则改完重跑会被"未变化"吞掉。"""
    argv = ["--source-id", "idem-3", "--kind", "法律", "--url", GOV_URL, *BASE]
    assert run(fetch, tmp_path, argv) == 0
    assert registry(tmp_path)[0]["status"] == "现行"
    before_sha = registry(tmp_path)[0]["content_sha256"]
    assert run(fetch, tmp_path, [*argv, "--status", "已废止"]) == 0
    updated = registry(tmp_path)[0]
    assert updated["status"] == "已废止"
    assert updated["content_sha256"] == before_sha, "字节没变，sha 不该变"


def test_metadata_only_change_keeps_fetched_at(fetch, tmp_path):
    argv = ["--source-id", "idem-4", "--kind", "法律", "--url", GOV_URL, *BASE]
    assert run(fetch, tmp_path, argv) == 0
    stamp = registry(tmp_path)[0]["fetched_at"]
    assert run(fetch, tmp_path, [*argv, "--status", "已修正"]) == 0
    assert registry(tmp_path)[0]["fetched_at"] == stamp, "元数据更正不代表重新取过原件，时间戳不该被改写"


def test_same_url_under_two_ids_rejected(fetch, tmp_path):
    """一份原件挂两个 id 的形态是：核验时随机命中其中一个，另一个永远是死条目。"""
    assert run(fetch, tmp_path, ["--source-id", "dup-a", "--kind", "法律", "--url", GOV_URL, *BASE]) == 0
    code = run(fetch, tmp_path, ["--source-id", "dup-b", "--kind", "法律", "--url", GOV_URL, *BASE])
    assert code != 0 and "dup-a" in str(code)


def test_registry_is_sorted_and_reloadable(fetch, tmp_path):
    for sid in ("zeta", "alpha", "mid"):
        assert run(fetch, tmp_path, ["--source-id", sid, "--kind", "法律", "--url", f"{GOV_URL}&s={sid}", *BASE]) == 0
    assert [e["source_id"] for e in registry(tmp_path)] == ["alpha", "mid", "zeta"]


def test_corrupt_registry_refuses_rather_than_treating_as_empty(fetch, tmp_path):
    """读不懂的登记簿当空的，会让白名单静默收紧，且没有一处报错。"""
    write_registry(tmp_path, [])
    (tmp_path / "sources.json").write_text("{不是数组}", encoding="utf-8")
    with pytest.raises(ValueError):
        fetch.main(["--source-id", "x", "--kind", "法律", "--url", GOV_URL, *BASE, "--knowledge-dir", str(tmp_path)])


# ── kind=机构官网（经理 2026-09-07 裁定新增）─────────────────────────────
HOSP_URL = "https://www.example-hospital.org/kepu/1.html"
JUSTIFY = ["--justification", "这条热线由该机构自己运行，号码与服务时间是它自己公布的"]


def test_institution_kind_needs_issuer_host_and_justification(fetch, tmp_path):
    """两样都齐才放行。这是白名单上唯一凭「机构自述」成立的一类，理由必须写下来。"""
    code = run(fetch, tmp_path, ["--source-id", "inst-1", "--kind", "机构官网", "--url", HOSP_URL,
                                 "--issuer-host", "www.example-hospital.org", *JUSTIFY, *BASE])
    assert code == 0
    entry = registry(tmp_path)[0]
    assert entry["kind"] == "机构官网" and entry["justification"].startswith("这条热线")


def test_institution_kind_without_justification_rejected(fetch, tmp_path):
    """不写理由就放行的话，这个 kind 会退化成一个填了就能进白名单的下拉框选项。"""
    code = run(fetch, tmp_path, ["--source-id", "inst-2", "--kind", "机构官网", "--url", HOSP_URL,
                                 "--issuer-host", "www.example-hospital.org", *BASE])
    assert code != 0 and "justification" in str(code)
    assert not (tmp_path / "sources.json").exists()


def test_institution_kind_without_issuer_host_rejected(fetch, tmp_path):
    code = run(fetch, tmp_path, ["--source-id", "inst-3", "--kind", "机构官网", "--url", HOSP_URL, *JUSTIFY, *BASE])
    assert code != 0


def test_justification_is_rejected_on_other_kinds(fetch, tmp_path):
    """--justification 用在别的 kind 上是无意义的，静默忽略会让人以为自己写下了理由。"""
    code = run(fetch, tmp_path, ["--source-id", "law-1", "--kind", "法律", "--url", GOV_URL, *JUSTIFY, *BASE])
    assert code != 0 and "justification" in str(code)


# ── text.txt 只能由抽取器写（经理 2026-09-07 裁定）───────────────────────
def test_unextractable_content_is_registered_as_needs_text(fetch, tmp_path, capsys):
    """抽不出文本 ⇒ 只落 raw、files.text=null、needs_text=true。

    旧行为是"让人自己把正文写进 text.txt，脚本认已存在的文件"，产物是
    **raw 与 text 毫无对应关系**的条目，而登记簿看起来完全正常。
    """
    code = run(fetch, tmp_path, ["--source-id", "pdf-1", "--kind", "法律", "--url", GOV_URL, *BASE],
               content=b"%PDF-1.4 binary", ctype="application/pdf")
    assert code == 0
    entry = registry(tmp_path)[0]
    assert entry["files"]["text"] is None and entry["needs_text"] is True
    assert (tmp_path / "sources/originals/pdf-1/raw.pdf").exists()
    assert not (tmp_path / "sources/originals/pdf-1/text.txt").exists()
    assert "needs_text" in capsys.readouterr().err


def test_a_hand_pasted_text_file_is_deleted_not_adopted(fetch, tmp_path, capsys):
    """人工粘进去的 text.txt 不但不采信，还要删掉——留着就是一把脱离了原件的尺子。

    2026-09-07 实见的事故形态：raw 是 SPA 空壳、text 是从另一个站抓来的正文，
    verify-quotes 照常判「一致」，只是一致于一份没人登记过的文件。
    """
    pasted = tmp_path / "sources/originals/pdf-2/text.txt"
    pasted.parent.mkdir(parents=True, exist_ok=True)
    pasted.write_text("这段正文是人从别处粘进来的。", encoding="utf-8")
    code = run(fetch, tmp_path, ["--source-id", "pdf-2", "--kind", "法律", "--url", GOV_URL, *BASE],
               content=b"%PDF-1.4 binary", ctype="application/pdf")
    assert code == 0
    assert not pasted.exists(), "人工粘贴的正文必须被删掉，不能被当成这份 raw 的抽取结果"
    assert registry(tmp_path)[0]["files"]["text"] is None
    assert "已删除" in capsys.readouterr().err


def test_extractable_content_never_gets_needs_text(fetch, tmp_path):
    """负对照：抽得出文本的正常路径一如既往（闸若写成"一律 needs_text"，全库当场作废）。"""
    assert run(fetch, tmp_path, ["--source-id", "html-1", "--kind", "法律", "--url", GOV_URL, *BASE]) == 0
    entry = registry(tmp_path)[0]
    assert entry["files"]["text"].endswith("text.txt") and "needs_text" not in entry


def test_needs_text_survives_a_metadata_only_rerun(fetch, tmp_path):
    """字节没变、只改元数据时，needs_text 不能被悄悄抹掉。

    抹掉的形态是：一条抽不出正文的登记，改一次 status 就变成"看起来正常"的条目。
    """
    argv = ["--source-id", "pdf-3", "--kind", "法律", "--url", GOV_URL, *BASE]
    assert run(fetch, tmp_path, argv, content=b"%PDF-1.4 binary", ctype="application/pdf") == 0
    assert run(fetch, tmp_path, [*argv, "--status", "已修正"], content=b"%PDF-1.4 binary", ctype="application/pdf") == 0
    entry = registry(tmp_path)[0]
    assert entry["status"] == "已修正" and entry["needs_text"] is True and entry["files"]["text"] is None


# ── 抽取器：认格式看魔数，打包件逐成员分派 ────────────────────────────────
def _docx_bytes(text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(
            "word/document.xml",
            f"<w:document><w:body><w:p><w:r><w:t>{text}</w:t></w:r></w:p></w:body></w:document>",
        )
    return buf.getvalue()


def _zip_bytes(members: list[tuple[str, bytes]]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        for name, data in members:
            z.writestr(name, data)
    return buf.getvalue()


def test_content_kind_reads_the_magic_bytes_not_the_extension(fetch):
    """认格式先认魔数。**扩展名说了不算**——本库两份原件的 raw 都叫 `raw.bin`。

    政府站把 .zip / .xls 走 octet-stream 发下来，guess_ext 只能落成 bin。
    只按扩展名分派的形态是：它们永远归进"抽不出"，于是 text.txt 里那份人工转出来的正文
    永远没人复算（2026-09-07 实见，两条都是）。
    """
    assert fetch.content_kind(_zip_bytes([("a.txt", b"x")]), "bin") == "zip"
    assert fetch.content_kind(_docx_bytes("正文"), "bin") == "docx"
    assert fetch.content_kind(b"%PDF-1.4 xxx", "bin") == "pdf"
    # 负对照：认不出魔数时才退回扩展名，别把 HTML 也判成别的东西
    assert fetch.content_kind(b"<html><body>x</body></html>", "html") == "html"


def test_zip_members_are_extracted_each_by_its_own_kind(fetch):
    """打包件逐成员抽：docx / txt 出正文，图片出**抽取器生成的**占位行。

    占位行必须由抽取器写，不能是人手打的一句说明——前者复算时逐字可重现，
    后者就是本轮清掉的那种存量（旧 text.txt 里留着"补记：libreoffice 转换取得以上纯文本"）。
    """
    raw = _zip_bytes(
        [
            ("材料/规则.docx", _docx_bytes("第一条　这是规则正文。")),
            ("材料/说明.txt", "这是说明正文。".encode("utf-8")),
            ("材料/流程图.jpg", b"\xff\xd8\xff\xe0not an image really"),
        ]
    )
    text = fetch.extract_text(raw, "bin", "")
    assert "【文件】材料/规则.docx" in text and "第一条　这是规则正文。" in text
    assert "这是说明正文。" in text
    assert "【文件】材料/流程图.jpg" in text and "[jpg：未抽取。" in text
    # 抽两遍必须逐字相同——审计的③就是拿这个和盘上的 text.txt 比
    assert fetch.extract_text(raw, "bin", "") == text


def test_word97_doc_inside_the_real_package_yields_its_real_text(fetch):
    """真件对照：现库那个朝阳办事材料包里的《中华人民共和国劳动法》.doc 必须抽出真正文。

    这条不用夹具用真件，是因为 .doc 的分片表解析只有拿真文件才验得动——
    自己造一份 OLE 复合文档来验自己写的解析器，等于用同一套理解验它自己
    （"仪器错 vs 范围错"：自造对照有系统性折价）。
    """
    from conftest import REAL_KNOWLEDGE

    raw = (REAL_KNOWLEDGE / "sources/originals/bjchy-banli-cailiao-baofuzhuang/raw.bin").read_bytes()
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        name = next(n for n in z.namelist() if n.endswith("中华人民共和国劳动法.doc"))
        text = fetch._doc_text(z.read(name))
    assert "第一条　为了保护劳动者的合法权益" in text
    assert "\x07" not in text and "\r" not in text, "单元格/段落标记没折成换行"


# ── --reextract：不下载，用当前抽取器重写 text.txt ─────────────────────────
def test_reextract_rewrites_text_without_touching_raw_or_sha(fetch, tmp_path):
    """抽取器改好之后，已存档的 text.txt 靠这条路跟上；raw / sha256 / fetched_at 一个字节不动。

    【为什么非有这条路不可】幂等分支的条件正是"字节没变"，所以重跑原命令只会打印
    "未变化"、**不重写 text.txt**。没有 --reextract 的话，一份被截断的、或者当年人工
    粘进去的正文就只能一直烂在登记簿里——而修它的唯一办法又变回了手写 text.txt。
    """
    assert run(fetch, tmp_path, ["--source-id", "html-9", "--kind", "法律", "--url", GOV_URL, *BASE]) == 0
    before = registry(tmp_path)[0]
    text_path = tmp_path / "sources/originals/html-9/text.txt"
    text_path.write_text("被谁改坏了的正文", encoding="utf-8")

    def _never(url):  # noqa: ANN001
        raise AssertionError("--reextract 不许下载：它的输入只有盘上那份 raw")

    fetch.download = _never
    assert fetch.main(["--reextract", "--source-id", "html-9", "--knowledge-dir", str(tmp_path)]) == 0
    assert text_path.read_text(encoding="utf-8") == "正文"
    after = registry(tmp_path)[0]
    assert after == before, "重抽改动了登记簿：raw/sha256/fetched_at 都不该动"


def test_reextract_flips_needs_text_when_the_extractor_learns_a_new_format(fetch, tmp_path):
    """一条原来抽不出的登记，在抽取器学会那个格式之后重抽 ⇒ needs_text 撤掉、files.text 补上。

    负对照在下一句：抽取器**没**学会的时候，重抽不许把 needs_text 抹掉
    （那会让一条没有正文的登记看起来正常）。
    """
    argv = ["--source-id", "zip-1", "--kind", "法律", "--url", GOV_URL, *BASE]
    body = _zip_bytes([("材料/规则.docx", _docx_bytes("第一条　包里的正文。"))])
    real_extract = fetch.extract_text
    fetch.extract_text = lambda raw, ext, ctype: None  # 假装本机还不会抽打包件
    assert run(fetch, tmp_path, argv, content=body, ctype="application/octet-stream") == 0
    assert registry(tmp_path)[0]["needs_text"] is True

    fetch.extract_text = real_extract  # 抽取器学会了
    assert fetch.main(["--reextract", "--knowledge-dir", str(tmp_path)]) == 0
    entry = registry(tmp_path)[0]
    assert "needs_text" not in entry and entry["files"]["text"].endswith("text.txt")
    assert "第一条　包里的正文。" in (tmp_path / "sources/originals/zip-1/text.txt").read_text(encoding="utf-8")


def test_reextract_never_touches_formats_outside_the_recompute_range(fetch, tmp_path, capsys):
    """量程外的格式（今天只有 pdf）一律跳过，`text.txt` 一个字节不动。

    【这条是拿事故换来的】第一版 `--reextract` 没有这道闸，一次全库重抽就用本机的
    pypdf 6.17 覆盖了两份 pdf 的存档（`statute-minsufa` 的目录被抽成"第四章回避**2**第五章"，
    页码插进了正文）。而审计对 pdf 只报"未复算"、照常退 0 ⇒ **一次审计看不见的存档漂移**。
    写者与审计者必须共用同一份 `DERIVABLE_KINDS`，不能各有各的政策。

    没有这道闸时本条的失败形态有两种，都被下面那句断言接住：本机装了 pypdf ⇒ 存档被覆盖；
    没装 ⇒ `_pdf_text` 返回 None，`text.txt` 被删掉、条目被标 needs_text。
    """
    assert run(fetch, tmp_path, ["--source-id", "pdf-9", "--kind", "法律", "--url", GOV_URL, *BASE],
               content=b"%PDF-1.4 binary", ctype="application/pdf") == 0
    archived = tmp_path / "sources/originals/pdf-9/text.txt"
    archived.write_text("这是当年另行取得、登记在册的正文。", encoding="utf-8")
    entry = registry(tmp_path)[0]
    entry["files"]["text"] = "sources/originals/pdf-9/text.txt"
    entry.pop("needs_text", None)
    write_registry(tmp_path, [entry])

    assert fetch.main(["--reextract", "--knowledge-dir", str(tmp_path)]) == 0
    assert archived.read_text(encoding="utf-8") == "这是当年另行取得、登记在册的正文。"
    assert registry(tmp_path)[0] == entry, "跳过的条目连登记簿都不该动"
    assert "跳过" in capsys.readouterr().out


def test_reextract_is_idempotent_when_the_archive_contains_crlf(fetch, tmp_path, capsys):
    """刚抓完就重抽 ⇒ 必须报"未变化"，哪怕正文里带着 \\r\\n。

    【它防的是一种只在输出里说谎的不幂等】`Path.read_text` 走通用换行：盘上是 \\r\\n，
    读回来变 \\n，于是"写进去的"和"读出来的"永远不等 ⇒ 每跑一次都判"变了"、每跑一次都重写。
    写下去的字节其实一个没变，所以 **git 看不见、审计看不见**，唯一的痕迹是这条命令
    每次都报一串"重抽：9680 字 → 9801 字"——一串技术上为真、实际上把人引向
    "存档一直在变"的假消息。2026-09-07 第一版实见。
    """
    body = "<html><body><p>第一条</p>\r\n<p>第二条</p>\r\n</body></html>".encode("utf-8")
    assert run(fetch, tmp_path, ["--source-id", "crlf-1", "--kind", "法律", "--url", GOV_URL, *BASE],
               content=body) == 0
    assert "\r" in (tmp_path / "sources/originals/crlf-1/text.txt").read_bytes().decode("utf-8"), "夹具没造出 \\r"
    capsys.readouterr()
    assert fetch.main(["--reextract", "--knowledge-dir", str(tmp_path)]) == 0
    printed = capsys.readouterr().out
    assert "未变化" in printed and "重抽" not in printed, printed
