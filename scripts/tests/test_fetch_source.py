"""scripts/fetch-source.py 的判据：host 闸与幂等。

**全程不打网络**：download() 被换成返回固定字节的假货。测的是"这个脚本让不让抓、
抓完写成什么样"，不是"那个网站今天在不在"——后者的红是噪音，会训练人忽略这套判据。
"""

from __future__ import annotations

import json

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
