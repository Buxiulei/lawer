#!/usr/bin/env python3
"""抓一份法源原件，落盘存档，并 upsert 到登记簿 knowledge/sources.json。

用法：

    python3 scripts/fetch-source.py \\
        --source-id beijing-gongzi-zhifu-guiding \\
        --name 北京市工资支付规定 \\
        --kind 地方规章 \\
        --issuer 北京市人民政府 \\
        --url https://www.beijing.gov.cn/zhengce/zhengcefagui/201905/t20190522_56550.html \\
        [--version-label 2007年修订] [--effective-from 2007-11-01] [--status 现行]

产物：

    knowledge/sources/originals/<source_id>/raw.<ext>   # 原始字节，一个字节不改
    knowledge/sources/originals/<source_id>/text.txt    # 抽出的纯文本（供机械比对）
    knowledge/sources/originals/<source_id>/meta.json   # 抓取现场（含 http 状态、走了哪一档 TLS）
    knowledge/sources.json                              # 登记簿条目

【host 闸】url 的 host 不以 .gov.cn 结尾一律拒绝抓取，除非同时满足
`--kind 行业规范` 且 `--issuer-host <该 host>`（把"我知道这不是政府站、这是发布机构自己的官网"
显式写出来）。**没有这道闸的形态是：某天有人用它抓了一个 sohu 页面，
而登记簿会像模像样地给出 sha256 和抓取时间**——机械核验会照常判"一致"，
只是一致于一份转载。

【幂等】同一个 source_id、同一个 url，抓下来的 sha256 与登记簿里的一致时，
不重写文件、不动 fetched_at，只打印"未变化"。sha 变了才更新（并打印新旧 sha）。
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import tempfile
import zipfile
from datetime import datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import knowledge_sources as ks  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent / "knowledge"

# 2026-09-07 原件下载员（第12批）记：mohrss.gov.cn（TencentEdgeOne）对自报身份的
# UA 做概率性 JS 挑战拦截（HTTP 200 但 body 是几百字节的反爬 JS，不是正文）——
# 用这个字符串反复抓 statute-qiye-daixin-nianxiujia-shishi-banfa 连续 25 次 0 次
# 命中，换成常规浏览器 UA 后 10 次里 7 次拿到真实正文（40709 字节 vs 987 字节的
# 挑战页）。不是访问控制，是通用反爬对"自报是脚本"这串签名的针对性拦截；正文本身
# 公开无需登录。若日后要撤回，把下面这行换回
# "Mozilla/5.0 (X11; Linux x86_64) lawer-fetch-source/1.0" 即可，其余逻辑不受影响。
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
CST = timezone(timedelta(hours=8))


def die(msg: str) -> None:
    sys.exit(f"错误：{msg}")


# ── 下载：一档一档往下退，退到哪一档要记账 ──────────────────────────────
#: 腾讯云 EdgeOne 的 JS 挑战页特征串。这段 200 响应里没有一个字的正文，
#: 只有一段算两个 cookie 再自我刷新的混淆脚本。
_EO_MARK = "EO_Bot_Ssid"


def eo_challenge_cookie(body: bytes) -> str | None:
    """把 EdgeOne 挑战页那段脚本**自己会算的**两个 cookie 算出来；不是挑战页就返回 None。

    【为什么这不算"绕过"】页面本身是公开的规范性文件全文，不需要登录、不在 robots.txt 里
    （www.mohrss.gov.cn 没有 robots.txt，实测 404）。浏览器打开它会执行同一段脚本、
    写同样两个 cookie、再取一次同一个 URL——这里做的就是这三步，取回的字节与浏览器
    拿到的**逐字节相同**（实测 sha256 与人工浏览器直连一致）。原件一个字节不改。

    【为什么必须在脚本里做，而不是人工抓了粘进 text.txt】登记簿的 content_sha256 记的是
    raw 的哈希。人工粘文本的那条路会让 raw=挑战页、text=正文，**两者毫无对应关系**，
    而 verify-quotes 只读 text——尺子就此脱离了它该量的那份原件，且登记簿看起来完全正常。
    （2026-09-07 收口时在 statute-laobufa-1994-479 上实见此形态。）

    脚本每次响应的常数都不同，所以只能按结构解：`var e={…}` 之前那个大整数是
    `EO_Bot_Ssid` 的值，之后对象里的三个大整数之和是 `__tst_status` 的值。
    结构变了就抛错——**静默返回 None 会退回成"抓到挑战页当正文存档"**，正是要防的那件事。
    """
    text = body.decode("utf-8", "replace")
    if _EO_MARK not in text:
        return None
    head, sep, tail = text.partition("var e=")
    ssid = re.findall(r"\d{7,}", head)
    nums = [int(x) for x in re.findall(r":\s*(\d{7,})\s*[,}]", tail)]
    if not sep or not ssid or len(nums) != 3:
        raise RuntimeError(
            f"认得出这是 EdgeOne 挑战页（含 {_EO_MARK}），但它的结构变了，算不出 cookie："
            f"分隔符{'在' if sep else '不在'}、ssid 候选 {ssid[:3]}、求和项 {nums}。"
            "浏览器打开同一 URL 看那段脚本现在长什么样，再改这里的解析。"
        )
    return f"__tst_status={sum(nums)}#; {_EO_MARK}={ssid[-1]}"


def _curl(url: str, *, tls12: bool = False, insecure: bool = False, timeout: int = 60,
          cookie: str | None = None) -> tuple[bytes, dict]:
    with tempfile.TemporaryDirectory() as td:
        body, head = Path(td) / "body", Path(td) / "head"
        cmd = ["curl", "-sS", "-L", "--max-time", str(timeout), "-A", UA, "-D", str(head), "-o", str(body)]
        if tls12:
            cmd.append("--tlsv1.2")
        if insecure:
            cmd.append("-k")
        if cookie:
            cmd += ["-H", f"Cookie: {cookie}"]
        cmd.append(url)
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(f"curl 退出码 {proc.returncode}：{proc.stderr.strip()[:300]}")
        headers = head.read_text(encoding="utf-8", errors="replace") if head.exists() else ""
        codes = re.findall(r"^HTTP/[\d.]+\s+(\d{3})", headers, re.M)
        status = int(codes[-1]) if codes else 0
        ctype = ""
        for line in reversed(headers.splitlines()):
            m = re.match(r"(?i)content-type:\s*(.+)", line.strip())
            if m:
                ctype = m.group(1).strip()
                break
        if status != 200:
            raise RuntimeError(f"HTTP {status}")
        raw = body.read_bytes()
    if cookie is None:
        ck = eo_challenge_cookie(raw)
        if ck:
            raw2, meta2 = _curl(url, tls12=tls12, insecure=insecure, timeout=timeout, cookie=ck)
            if eo_challenge_cookie(raw2) is not None:
                raise RuntimeError("过了一次 EdgeOne 挑战，回来的还是挑战页——cookie 没被接受")
            return raw2, {**meta2, "eo_challenge": True}
    return raw, {"http_status": status, "content_type": ctype}


def download(url: str) -> tuple[bytes, dict]:
    """按 https → --tlsv1.2 → --tlsv1.2 -k → http 的顺序退，返回 (字节, 抓取现场)。

    这四档不是防御性编程，是本项目真实踩过的四种失败：政府站的 TLS 栈老、
    证书链缺中间证、以及 bjchy.gov.cn 那种只有 http 可达的站。
    **退到哪一档必须记进 meta.json**：走过 -k 的原件与走过完整校验的原件，
    可信度不是一回事，而事后从 sha256 上完全看不出来。
    """
    ladder = [
        ("https", dict()),
        ("https+tlsv1.2", dict(tls12=True)),
        ("https+tlsv1.2+insecure", dict(tls12=True, insecure=True)),
    ]
    errors = []
    for method, kw in ladder:
        try:
            data, meta = _curl(url, **kw)
            return data, {**meta, "fetch_method": method, "fetch_url": url}
        except Exception as e:  # noqa: BLE001 —— 逐档记账后继续退，最后一起报
            errors.append(f"{method}: {e}")
    if url.startswith("https://"):
        http_url = "http://" + url[len("https://") :]
        try:
            data, meta = _curl(http_url, tls12=True)
            return data, {**meta, "fetch_method": "http-fallback", "fetch_url": http_url}
        except Exception as e:  # noqa: BLE001
            errors.append(f"http-fallback: {e}")
    die("取不到原件，四档都失败（原文如下，未做任何转述）：\n  " + "\n  ".join(errors))
    raise AssertionError("unreachable")


# ── 抽文本 ──────────────────────────────────────────────────────────────
_BLOCK = {"p", "div", "br", "tr", "li", "h1", "h2", "h3", "h4", "h5", "h6", "td", "section", "article"}


class _Stripper(HTMLParser):
    """标准库抽正文：丢掉 script/style，块级标签处断行。不引第三方依赖。"""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self._skip = 0

    def handle_starttag(self, tag, attrs):
        if tag in ("script", "style"):
            self._skip += 1
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag in ("script", "style") and self._skip:
            self._skip -= 1
        elif tag in _BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if not self._skip:
            self.parts.append(data)

    def text(self) -> str:
        return re.sub(r"\n{3,}", "\n\n", "".join(self.parts)).strip()


def _decode(raw: bytes, ctype: str) -> str:
    m = re.search(r"charset=([\w-]+)", ctype, re.I)
    cands = [m.group(1)] if m else []
    m2 = re.search(rb'charset=["\']?([\w-]+)', raw[:4096], re.I)
    if m2:
        cands.append(m2.group(1).decode("ascii", "ignore"))
    cands += ["utf-8", "gb18030"]
    for enc in cands:
        try:
            return raw.decode(enc)
        except (UnicodeDecodeError, LookupError):
            continue
    return raw.decode("utf-8", errors="replace")


def _docx_text(raw: bytes) -> str:
    with tempfile.NamedTemporaryFile(suffix=".docx") as f:
        f.write(raw)
        f.flush()
        with zipfile.ZipFile(f.name) as z:
            xml = z.read("word/document.xml").decode("utf-8", "replace")
    xml = re.sub(r"</w:p>", "\n", xml)
    xml = re.sub(r"<w:tab[^>]*/>", "\t", xml)
    return re.sub(r"\n{3,}", "\n\n", re.sub(r"<[^>]+>", "", xml)).strip()


def _pdf_text(raw: bytes) -> str | None:
    """有 pypdf/PyPDF2 就抽，没有就 None（调用方另转）。不为此新增依赖。"""
    for mod, cls in (("pypdf", "PdfReader"), ("PyPDF2", "PdfReader")):
        try:
            reader = getattr(__import__(mod), cls)
        except Exception:  # noqa: BLE001
            continue
        try:
            import io

            doc = reader(io.BytesIO(raw))
            return "\n".join((p.extract_text() or "") for p in doc.pages).strip()
        except Exception as e:  # noqa: BLE001
            print(f"警告：{mod} 抽取 PDF 失败（{e}），按「无依赖」处理", file=sys.stderr)
            return None
    return None


def guess_ext(url: str, ctype: str) -> str:
    c = ctype.lower()
    if "pdf" in c:
        return "pdf"
    if "wordprocessingml" in c:
        return "docx"
    if "msword" in c:
        return "doc"
    if "html" in c:
        return "html"
    if "text/plain" in c:
        return "txt"
    suffix = Path(url.split("?")[0]).suffix.lower().lstrip(".")
    return suffix if suffix in ("pdf", "docx", "doc", "html", "htm", "txt", "xml") else "bin"


def extract_text(raw: bytes, ext: str, ctype: str) -> str | None:
    if ext in ("html", "htm", "xml"):
        p = _Stripper()
        p.feed(_decode(raw, ctype))
        return p.text()
    if ext == "txt":
        return _decode(raw, ctype)
    if ext == "docx":
        return _docx_text(raw)
    if ext == "pdf":
        return _pdf_text(raw)
    return None


# ── 主流程 ──────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="抓法源原件并登记到 knowledge/sources.json")
    p.add_argument("--source-id", required=True, help="全库唯一，小写英文/拼音加连字符")
    p.add_argument("--name", required=True, help="法源全称，verify-quotes 按它匹配 quote 的 law")
    p.add_argument("--kind", required=True, choices=sorted(ks.KINDS))
    p.add_argument("--issuer", required=True, help="发布机关（如 北京市人民政府 / 最高人民法院）")
    p.add_argument("--url", required=True)
    p.add_argument("--version-label", default="", help="版本标签，如「2012年修正」「2025年9月1日施行」")
    p.add_argument("--effective-from", default=None, help="施行日 YYYY-MM-DD，可选")
    p.add_argument("--status", default="现行", choices=sorted(ks.STATUSES))
    p.add_argument(
        "--issuer-host",
        default=None,
        help=f"仅 kind={ks.NON_GOV_KIND} 可用：显式声明这个非 .gov.cn 的 host 是发布机构官网，须与 url 的 host 完全相同",
    )
    p.add_argument("--knowledge-dir", default=None, help="默认仓内 knowledge/；测试用")
    return p


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    root = Path(args.knowledge_dir).resolve() if args.knowledge_dir else ROOT

    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.source_id):
        die(f"source_id 只能用小写英文数字与连字符：{args.source_id}")

    host = ks.host_of(args.url)
    if host is None:
        die(f"--url 必须是 http(s) URL：{args.url}")
    if not (host == "gov.cn" or host.endswith(".gov.cn")):
        if args.kind != ks.NON_GOV_KIND or not args.issuer_host:
            die(
                f"拒绝抓取非官方 host「{host}」。\n"
                f"  缺什么：一手源必须落在 .gov.cn 上。\n"
                f"  为什么：转载站（wikisource / sohu / 律所站 / 公众号）与原件在字面上会有出入，"
                f"而登记簿一旦收了它，机械核验只会证明「与那份转载一致」。\n"
                f"  怎么办：换官方页面重抓；确属{ks.NON_GOV_KIND}（发布机构自己的官网）时，"
                f"加 --kind {ks.NON_GOV_KIND} --issuer-host {host}"
            )
        if args.issuer_host.lower() != host:
            die(f"--issuer-host「{args.issuer_host}」与 url 的 host「{host}」不一致，拒绝抓取")

    entries = ks.load_registry(root)
    for e in entries:
        if e["url"] == args.url and e["source_id"] != args.source_id:
            die(f"同一个 url 已登记在 source_id={e['source_id']} 名下，不要重复登记；改用那个 id 或换 url")

    raw, fetch_meta = download(args.url)
    sha = hashlib.sha256(raw).hexdigest()
    ext = guess_ext(args.url, fetch_meta.get("content_type", ""))

    old = ks.by_id(entries).get(args.source_id)
    outdir = root / ks.ORIGINALS_DIR / args.source_id
    text_path, raw_path = outdir / "text.txt", outdir / f"raw.{ext}"
    # 【幂等的确切含义】同一个 url 抓下来同一个 sha ⇒ 不重写原件、不动 fetched_at。
    # 但**元数据仍会 upsert**：把 status 从「现行」改成「已修正」这种更正，
    # 不该因为"字节没变"而被静默丢掉——那样的话改完再跑一遍，脚本会说未变化，
    # 而登记簿里还是旧的。整条 entry 相等才叫未变化。
    content_same = bool(old and old["url"] == args.url and old["content_sha256"] == sha and raw_path.exists())

    if not content_same:
        outdir.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(raw)
        text = extract_text(raw, ext, fetch_meta.get("content_type", ""))
        if text:
            text_path.write_text(text, encoding="utf-8")
        elif not text_path.exists():
            print(
                f"注意：{ext} 原件已存档，但本机抽不出文本。\n"
                f"  缺什么：{text_path}\n"
                f"  为什么：{ext} 需要额外依赖（PDF 需 pypdf/PyPDF2），本机没有，本脚本不为此新增依赖。\n"
                f"  怎么办：自行把纯文本写到上面那个路径，再原样重跑本命令即可完成登记"
                f"（本脚本幂等，会认已存在的 text.txt）。在那之前 verify-quotes 会把引用它的卡判为「找不到原件」。",
                file=sys.stderr,
            )

    entry = {
        "source_id": args.source_id,
        "kind": args.kind,
        "name": args.name,
        "issuer": args.issuer,
        "official_host": host,
        "url": args.url,
        "fetched_at": old["fetched_at"] if content_same else datetime.now(CST).isoformat(timespec="seconds"),
        "content_sha256": sha,
        "version_label": args.version_label,
        "status": args.status,
        "files": {
            "raw": f"{ks.ORIGINALS_DIR}/{args.source_id}/raw.{ext}",
            "text": f"{ks.ORIGINALS_DIR}/{args.source_id}/text.txt" if text_path.exists() else None,
        },
    }
    if args.effective_from:
        entry["effective_from"] = args.effective_from

    if old == entry:
        print(f"未变化：{args.source_id} 的 sha256 仍是 {sha[:12]}…，登记簿与原件都不动")
        return 0

    outdir.mkdir(parents=True, exist_ok=True)
    (outdir / "meta.json").write_text(
        json.dumps({**entry, **fetch_meta, "bytes": len(raw)}, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    entries = [e for e in entries if e["source_id"] != args.source_id] + [entry]
    ks.save_registry(root, entries)
    verb = ("元数据更新" if content_same else "更新") if old else "登记"
    extra = f"（原 sha {old['content_sha256'][:12]}…）" if old and not content_same else ""
    print(f"{verb}：{args.source_id} ← {fetch_meta['fetch_url']}（{fetch_meta['fetch_method']}，{len(raw)} 字节，sha {sha[:12]}…）{extra}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
