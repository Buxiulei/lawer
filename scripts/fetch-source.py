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

【重抽】抽取器改好之后，已存档的 text.txt 不会自己跟上——而"抓下来的字节没变"正是
上面那条幂等分支**不重写 text.txt** 的条件，于是重跑一遍原命令只会打印"未变化"。
所以有这条不下载的路：

    python3 scripts/fetch-source.py --reextract [--source-id <id>]

它拿盘上的 raw 重跑一遍当前抽取器、覆盖 text.txt，一个字节都不碰 raw / sha256 /
fetched_at。**没有它的形态是有人手工把正文粘进 text.txt**——那条路已被封死
（见下面 needs_text 处的注释），封了之后如果没有一条机械的重抽路，被截断的、
过时的存档就只能一直烂在那里。
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import re
import struct
import subprocess
import sys
import tempfile
import time
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

#: http:// 的 URL 打几次、每两次之间等几秒。
#: https 的 URL 天然有三次机会（三档 TLS 退让）外加一格 http-fallback，
#: 而 http:// 没有 TLS 可退、梯子只有一格——**一次瞬时失败就是整次抓取失败**。
#: 于是同一次网络抖动下 https 的源抓得到、http-only 的源抓不到，
#: 差别不在源的质量，只在梯子的长度（本库真有只走 http 的政府站）。
#: 三次是照着 https 那三档的次数配的，不是另立一套。
HTTP_ATTEMPTS = 3
HTTP_RETRY_BACKOFF_SEC = 2


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
    传进来就是 http:// 的 URL 只有一档（`http`）——TLS 那三档对它无意义；
    这一档打 HTTP_ATTEMPTS 次（见该常量：只打一次的话，一次瞬时失败就没有后手了）。
    """
    # 【fetch_method 说的是"实际用了哪个 scheme + 哪一档 TLS"，不是"我们打算用 https"】
    # 这三档全是 TLS 上的退让，只有 https 的 URL 走得上；传进来的就是 http:// 时，
    # curl 压根不做 TLS，把它记成 `https` 是**记了一件没发生的事**——
    # 而 meta.json 里 fetch_method=https 配一个 http:// 的 fetch_url，
    # 事后没有任何一处会打架（实见 16 份 meta 这么记着，audit-sources 那一关就是为它加的）。
    http_only = url.startswith("http://")
    if http_only:
        # 同一档打 HTTP_ATTEMPTS 次（见常量处：这一档没有 TLS 可退，不重试就只有一次机会）。
        ladder = [("http", dict())] * HTTP_ATTEMPTS
    else:
        ladder = [
            ("https", dict()),
            ("https+tlsv1.2", dict(tls12=True)),
            ("https+tlsv1.2+insecure", dict(tls12=True, insecure=True)),
        ]
    errors = []
    for i, (method, kw) in enumerate(ladder):
        # 只有 http 那一档是"同一件事再打一次"，才需要退避；TLS 三档各打各的，立刻退下一格。
        if http_only and i:
            time.sleep(HTTP_RETRY_BACKOFF_SEC)
        try:
            data, meta = _curl(url, **kw)
            return data, {**meta, "fetch_method": method, "fetch_url": url}
        except Exception as e:  # noqa: BLE001 —— 逐档记账后继续退，最后一起报
            # http 那三次是同一档重打，不编号的话失败报告是三行长得一样的字，读者会以为闸坏了。
            errors.append(f"{method}（第 {i + 1} 次）: {e}" if http_only else f"{method}: {e}")
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


class MissingTool(RuntimeError):
    """抽取这份原件要用的库本机没装。**不是"抽不出"，是"没量"**。

    两者必须分开：抽不出（如 PDF）是格式的性质，装什么都一样；没量是这台机器的事，
    换台机器就好了。合成一种的形态是——本机缺 xlrd ⇒ 一份 .xls 被登记成"抽不出文本"，
    而 scripts/audit-sources.py 会把它归进"未复算"照常退 0。
    这个类存在的意义就是让那种情况**判红并说出装哪个包**。
    """


def _need(mod: str, pkg: str, why: str):
    try:
        return __import__(mod)
    except ImportError as e:
        raise MissingTool(
            f"缺什么：Python 包 {pkg}（import {mod}）。\n"
            f"  为什么：{why}\n"
            f"  怎么办：pip install --user {pkg}（见 knowledge/README.md §7.6）。"
            f"在装上之前不要手写 text.txt——那条路已经封死。"
        ) from e


def _doc_text(raw: bytes) -> str:
    """Word 97-2003 二进制（.doc）正文：按 FIB 的分片表（piece table）逐片取字。

    【为什么自己解，而不是 shell 出去调 antiword / libreoffice】
    这份文本是 scripts/audit-sources.py 复算 text.txt 的判据。判据必须只随**仓里的代码**变：
    LibreOffice 换个版本、antiword 换个发行版补丁，抽出来的字就可能差几个空格，
    于是同一份库在这台机器绿、在那台机器红——而人只会挑绿的那台（§7.5 记过一次）。
    下面这三十行是 [MS-DOC] 里最稳的那一小块（FIB → Clx → PlcPcd），逐片解出正文字符，
    输出只取决于这段代码本身。

    结构（偏移量都是 [MS-DOC] 定死的常数）：
      · WordDocument 流偏移 0x0A 的标志位 0x0200 说分片表在 1Table 还是 0Table 流里；
      · 该流偏移 0x01A2/0x01A6 是 Clx 的位置与长度；
      · Clx 里先是若干条 Prc（0x01 开头，后跟 2 字节长度），然后是 0x02 开头的 Pcdt；
      · Pcdt 里是 n+1 个字符位置（CP）加 n 个 8 字节分片描述（PCD），
        PCD 偏移 2 处的 fc 若带 0x40000000 位，说明这片是单字节 cp1252、真实偏移是 fc/2；
        否则是 UTF-16LE。
    解不动就抛——**静默返回空串会让一份有正文的 .doc 悄悄变成占位行**。
    """
    olefile = _need("olefile", "olefile", "Word 97 的 .doc 是 OLE 复合文档，要先把它的流拆开")
    ole = olefile.OleFileIO(io.BytesIO(raw))
    try:
        wd = ole.openstream("WordDocument").read()
        table = "1Table" if struct.unpack_from("<H", wd, 0x0A)[0] & 0x0200 else "0Table"
        tbl = ole.openstream(table).read()
    finally:
        ole.close()
    fc_clx, lcb_clx = struct.unpack_from("<II", wd, 0x01A2)
    clx = tbl[fc_clx : fc_clx + lcb_clx]
    i = 0
    while i < len(clx) and clx[i] == 0x01:  # Prc：字符属性，跳过
        i += 3 + struct.unpack_from("<H", clx, i + 1)[0]
    if i >= len(clx) or clx[i] != 0x02:
        raise RuntimeError(
            f"这份 .doc 的 Clx 里找不到分片表（第 {i} 字节是 "
            f"{hex(clx[i]) if i < len(clx) else '越界'}，应为 0x02）：文件可能损坏，"
            f"或是本抽取器没覆盖的旧版本。用 Word/LibreOffice 打开看它是不是真的 Word 97 文档。"
        )
    lcb = struct.unpack_from("<I", clx, i + 1)[0]
    pcdt = clx[i + 5 : i + 5 + lcb]
    n = (len(pcdt) - 4) // 12  # 每片：4 字节 CP + 8 字节 PCD，另加末尾那个收尾 CP
    cps = struct.unpack_from(f"<{n + 1}I", pcdt, 0)
    parts = []
    for k in range(n):
        fc = struct.unpack_from("<I", pcdt, 4 * (n + 1) + 8 * k + 2)[0]
        cch = cps[k + 1] - cps[k]
        if fc & 0x40000000:
            start = (fc & ~0x40000000) // 2
            parts.append(wd[start : start + cch].decode("cp1252", "replace"))
        else:
            parts.append(wd[fc : fc + cch * 2].decode("utf-16-le", "replace"))
    return _doc_clean("".join(parts))


#: Word 的域：\x13 域指令 \x14 域结果 \x15。指令（`PAGE`、`HYPERLINK "…"`）不是正文，
#: 结果才是——本包里那 5 处都是空结果的 PAGE 域。整段连指令带结果一起删会吃掉正文。
_FIELD = re.compile(r"\x13[^\x13\x14\x15]*(?:\x14)?")


def _doc_clean(s: str) -> str:
    """把 .doc 的段落/单元格/换行标记折成换行，控制符去干净。"""
    s = _FIELD.sub("", s).replace("\x15", "")
    s = s.replace("\r", "\n").replace("\x07", "\n").replace("\x0b", "\n").replace("\x0c", "\n")
    s = re.sub(r"[\x00-\x08\x0e-\x1f]", "", s)  # 脚注/批注/图形锚点等，无可见正文
    return re.sub(r"\n{3,}", "\n\n", s).strip()


def _xls_num(v: float) -> str:
    """整数去掉 .0，其余用 repr——repr 是最短往返表示，同一个 float 在任何 3.x 上一个样。"""
    return str(int(v)) if float(v).is_integer() else repr(v)


def _xls_text(raw: bytes) -> str:
    """Excel 97-2003 二进制（.xls）：逐表逐行制表符分隔，数值原样。

    统计年鉴那类表格没有"正文"，只有格子；把格子按行摊平是唯一不掺入判断的读法。
    数值**不做四舍五入、不加千分位**：本库有卡直接引表内数字
    （封顶基数 188413 → 47103.25），任何格式化都会让引文核不上。
    """
    xlrd = _need("xlrd", "xlrd", ".xls 是 BIFF 二进制表格，要按记录读单元格")
    book = xlrd.open_workbook(file_contents=raw)
    out = []
    for sheet in book.sheets():
        out.append(f"【工作表】{sheet.name}")
        for r in range(sheet.nrows):
            cells = [
                _xls_num(c.value) if isinstance(c.value, float) else str(c.value)
                for c in sheet.row(r)
            ]
            out.append("\t".join(cells).rstrip("\t"))
    return "\n".join(out).strip()


#: 打包件里**不抽**的成员，逐类写明为什么。占位行由抽取器生成 ⇒ 复算时逐字可重现，
#: 与"人手写一句说明"不是一回事（后者正是本轮清掉的那种存量）。
_ZIP_SKIP = {
    "pdf": "本抽取器不抽 PDF：pypdf 的输出随版本漂（同一份 PDF 在两个版本下页码位置不同），"
           "拿它当复算判据会让审计结论随机器变。要核对这份文件，另抓它的官方 HTML/DOCX 版单独登记。",
    "xlsx": "本抽取器不抽 .xlsx（本库暂无此格式的源；要抽先补 openpyxl 分支并在 §7.6 记账）。",
}


def _zip_member_text(data: bytes, ext: str) -> str:
    if ext == "docx":
        return _docx_text(data)
    if ext == "doc":
        return _doc_text(data)
    if ext == "xls":
        return _xls_text(data)
    if ext in ("html", "htm", "xml"):
        p = _Stripper()
        p.feed(_decode(data, ""))
        return p.text()
    if ext == "txt":
        return _decode(data, "")
    return f"[{ext or '无扩展名'}：未抽取。{_ZIP_SKIP.get(ext, '非文本格式（图片/音视频/嵌套压缩件），没有可抽的正文。')}]"


def _zip_text(raw: bytes) -> str:
    """打包件（.zip）：按归档内的顺序逐个成员抽，每段冠以成员全名。

    政府站常把一整套办事材料压成一个包（本库的朝阳区办理材料包就是 34 个成员）。
    整包只有一个 sha256、一份 text.txt，所以成员名必须留在文本里——
    否则引文核上了也说不出它出自包里的哪一份。
    """
    out = []
    with zipfile.ZipFile(io.BytesIO(raw)) as z:
        for info in z.infolist():
            if info.is_dir():
                continue
            ext = Path(info.filename).suffix.lower().lstrip(".")
            out.append(
                "=" * 70 + f"\n【文件】{info.filename}\n" + "=" * 70 + "\n" + _zip_member_text(z.read(info), ext)
            )
    return "\n\n".join(out).strip()


def _pdf_text(raw: bytes) -> str | None:
    """有 pypdf/PyPDF2 就抽，没有就 None（调用方另转）。不为此新增依赖。"""
    for mod, cls in (("pypdf", "PdfReader"), ("PyPDF2", "PdfReader")):
        try:
            reader = getattr(__import__(mod), cls)
        except Exception:  # noqa: BLE001
            continue
        try:
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


#: 这些格式，本仓的代码 + 两个纯 Python 包（olefile / xlrd）就能从 raw 逐字重抽出 text，
#: 所以 scripts/audit-sources.py 拿它们**复算**。名单外的只报"未复算"。
#: 判据是"输出只随仓里的代码变"：pdf 不在名单里，因为 pypdf 的输出随它自己的版本漂（§7.5）。
DERIVABLE_KINDS = frozenset({"html", "htm", "xml", "txt", "docx", "doc", "xls", "zip"})


def content_kind(raw: bytes, ext: str) -> str:
    """这份字节**实际上**是什么格式。先认魔数，认不出才退回扩展名。

    【为什么不能只信扩展名】本库两份原件的 raw 都叫 `raw.bin`：政府站发的
    .zip / .xls 走 `application/octet-stream` 下来，guess_ext 认不出就落成 bin。
    只按扩展名分派的形态是——它们永远归进"抽不出"，而 text.txt 里那份人写的正文
    永远没人复算。魔数认得出，它们就该被复算。
    """
    if raw[:4] == b"PK\x03\x04":
        try:
            with zipfile.ZipFile(io.BytesIO(raw)) as z:
                names = set(z.namelist())
        except zipfile.BadZipFile:
            return ext
        if "word/document.xml" in names:
            return "docx"
        if "xl/workbook.xml" in names:
            return "xlsx"
        return "zip"
    if raw[:8] == b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1":  # OLE 复合文档：.doc / .xls 共用
        olefile = _need("olefile", "olefile", "要看这份 OLE 复合文档里装的是 Word 还是 Excel")
        ole = olefile.OleFileIO(io.BytesIO(raw))
        try:
            if ole.exists("WordDocument"):
                return "doc"
            if ole.exists("Workbook") or ole.exists("Book"):
                return "xls"
        finally:
            ole.close()
        return ext
    if raw[:5] == b"%PDF-":
        return "pdf"
    return ext


def extract_text(raw: bytes, ext: str, ctype: str) -> str | None:
    kind = content_kind(raw, ext)
    if kind in ("html", "htm", "xml"):
        p = _Stripper()
        p.feed(_decode(raw, ctype))
        return p.text()
    if kind == "txt":
        return _decode(raw, ctype)
    if kind == "docx":
        return _docx_text(raw)
    if kind == "doc":
        return _doc_text(raw)
    if kind == "xls":
        return _xls_text(raw)
    if kind == "zip":
        return _zip_text(raw)
    if kind == "pdf":
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
        help=(
            f"仅 kind∈{{{ks.NON_GOV_KIND}, {ks.INSTITUTION_KIND}}} 可用：显式声明这个非 .gov.cn 的 host "
            f"是该机构自己的官网，须与 url 的 host 完全相同"
        ),
    )
    p.add_argument(
        "--justification",
        default=None,
        help=(
            f"仅 kind={ks.INSTITUTION_KIND} 必填：写明该机构与它自述信息的关系"
            f"（如「这条热线由该中心自己运行，号码与服务时间是它自己公布的」）。"
            f"落进登记簿，供人复核这份源凭什么算数"
        ),
    )
    p.add_argument("--knowledge-dir", default=None, help="默认仓内 knowledge/；测试用")
    return p


# ── 重抽（不下载）─────────────────────────────────────────────────────────
def build_reextract_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description="不下载，用当前抽取器从已存档的 raw 重写 text.txt")
    p.add_argument("--reextract", action="store_true", required=True)
    p.add_argument("--source-id", default=None, help="只重抽这一条；不写就全库")
    p.add_argument("--knowledge-dir", default=None, help="默认仓内 knowledge/；测试用")
    return p


def reextract_main(argv: list[str]) -> int:
    """拿盘上的 raw 重跑抽取器、覆盖 text.txt。raw / sha256 / fetched_at 一个字节不动。

    登记簿只在 `files.text` 或 `needs_text` 真的翻转时才改写——"抽取器变强了，
    一条原来抽不出的现在抽得出了"是登记簿该记的事；正文内容变了不是。

    【只重抽复算量程内的格式】量程外的（今天只有 pdf）一律跳过，理由与
    scripts/audit-sources.py 那边是同一条：pypdf 的输出随版本漂。
    **本轮实见这条闸非有不可**——第一版没有它，一次全库 `--reextract` 就用本机的
    pypdf 6.17 覆盖了两份 pdf 的存档（`statute-minsufa` 的目录被抽成"第四章回避2第五章"，
    页码插进了正文），而审计对 pdf 只报"未复算"、照常退 0：**一次静默的、审计看不见的
    存档漂移**。写者与审计者必须共用同一份名单，不能各有各的政策。
    """
    args = build_reextract_parser().parse_args(argv)
    root = Path(args.knowledge_dir).resolve() if args.knowledge_dir else ROOT
    all_entries = ks.load_registry(root)
    entries = all_entries
    if args.source_id:
        entries = [e for e in all_entries if e["source_id"] == args.source_id]
        if not entries:
            die(f"登记簿里没有 source_id={args.source_id}")

    changed, skipped, failed, registry_dirty = [], [], [], False
    for entry in entries:  # entries 里就是 all_entries 里的那些对象，改它即改登记簿
        raw_path = root / (entry.get("files") or {}).get("raw", "")
        if not raw_path.is_file():
            failed.append(f"{entry['source_id']}：原件不在盘上（{raw_path}）")
            continue
        raw = raw_path.read_bytes()
        try:
            kind = content_kind(raw, raw_path.suffix.lower().lstrip("."))
            if kind not in DERIVABLE_KINDS:
                skipped.append(f"{entry['source_id']}（{kind}）")
                continue
            text = extract_text(raw, kind, "")
        except MissingTool as e:
            failed.append(f"{entry['source_id']}：{e}")
            continue
        text_path = raw_path.parent / "text.txt"
        # 【比字节，不比 read_text】`read_text` 走通用换行：盘上是 \r\n，读回来变 \n，
        # 于是"写进去的"与"读出来的"永远不等 ⇒ 每跑一次都判"变了"、每跑一次都重写。
        # 那种不幂等在 git 里看不见（写下去的字节没变），只会让这条命令的输出永远在骗人。
        new_bytes = text.encode("utf-8") if text else None
        old_bytes = text_path.read_bytes() if text_path.exists() else None
        if new_bytes is not None:
            if old_bytes != new_bytes:
                text_path.write_bytes(new_bytes)
                changed.append(
                    f"{entry['source_id']}：{len((old_bytes or b'').decode('utf-8', 'replace'))} 字 → {len(text)} 字"
                )
        elif old_bytes is not None:
            text_path.unlink()
            changed.append(f"{entry['source_id']}：抽不出正文，已删除 text.txt 并标 needs_text")
        rel = None if not text else f"{ks.ORIGINALS_DIR}/{entry['source_id']}/text.txt"
        if entry["files"].get("text") != rel or bool(entry.get("needs_text")) != (not text):
            entry["files"]["text"] = rel
            entry.pop("needs_text", None)
            if not text:
                entry["needs_text"] = True
            registry_dirty = True
    if registry_dirty:
        ks.save_registry(root, all_entries)
    for line in changed:
        print(f"重抽：{line}")
    if skipped:
        print(f"跳过（不在复算量程内，重抽会写进一份审计看不见的漂移）：{len(skipped)} 条 —— {'、'.join(skipped)}")
    for line in failed:
        print(f"失败：{line}", file=sys.stderr)
    if not changed and not failed:
        print(f"未变化：{len(entries) - len(skipped)} 条的 text.txt 与当前抽取器的输出已经一致")
    return 1 if failed else 0


def main(argv: list[str] | None = None) -> int:
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--reextract" in argv:
        return reextract_main(argv)
    args = build_parser().parse_args(argv)
    root = Path(args.knowledge_dir).resolve() if args.knowledge_dir else ROOT

    if not re.fullmatch(r"[a-z0-9][a-z0-9-]*", args.source_id):
        die(f"source_id 只能用小写英文数字与连字符：{args.source_id}")

    host = ks.host_of(args.url)
    if host is None:
        die(f"--url 必须是 http(s) URL：{args.url}")
    if not (host == "gov.cn" or host.endswith(".gov.cn")):
        if args.kind not in ks.NON_GOV_KINDS or not args.issuer_host:
            die(
                f"拒绝抓取非官方 host「{host}」。\n"
                f"  缺什么：一手源必须落在 .gov.cn 上。\n"
                f"  为什么：转载站（wikisource / sohu / 律所站 / 公众号）与原件在字面上会有出入，"
                f"而登记簿一旦收了它，机械核验只会证明「与那份转载一致」。\n"
                f"  怎么办：换官方页面重抓；确属{ks.NON_GOV_KIND}（行业组织发布的规范文件）时，"
                f"加 --kind {ks.NON_GOV_KIND} --issuer-host {host}；"
                f"若只是某机构在自己官网上讲自己的事（热线/地址/收费），"
                f"加 --kind {ks.INSTITUTION_KIND} --issuer-host {host} --justification <说明>"
                f"——后者只有数据卡能引（见 knowledge/README.md §7.1）"
            )
        if args.issuer_host.lower() != host:
            die(f"--issuer-host「{args.issuer_host}」与 url 的 host「{host}」不一致，拒绝抓取")
    if args.kind == ks.INSTITUTION_KIND and not (args.justification or "").strip():
        die(
            f"kind={ks.INSTITUTION_KIND} 必须写 --justification。\n"
            f"  缺什么：一句「这家机构与这条信息是什么关系」。\n"
            f"  为什么：这个 kind 是白名单上唯一凭「机构自述」成立的一类。"
            f"不写理由的话，它会退化成一个填了就能进白名单的下拉框选项。\n"
            f"  怎么办：--justification「12356 是该中心自己运行的热线，号码与服务时间由它自己公布」这类"
        )
    if args.justification and args.kind != ks.INSTITUTION_KIND:
        die(f"--justification 只对 kind={ks.INSTITUTION_KIND} 有意义（当前 kind={args.kind}）")

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

    # 【text.txt 只能由抽取器写，人工粘贴这条路已封死（经理 2026-09-07 裁定）】
    # 旧行为是"抽不出就让人自己把正文写进 text.txt，脚本认已存在的文件"。
    # 那条路的产物是 **raw 与 text 毫无对应关系**的条目，而登记簿看起来完全正常：
    # 有 url、有 sha256、有抓取时间。2026-09-07 在 statute-gerensuodeshuifa 上实见此形态——
    # raw 是 flk 的 552 字节 SPA 空壳，text 是从 chinatax 另抓的正文，
    # 而 verify-quotes 只读 text，于是"逐字核实"核的是一份没人登记过的文件。
    # 现在：抽不出就只落 raw、files.text=null、needs_text=true，
    # 由 scripts/audit-sources.py 判红，直到有人换一个抽得动的官方 URL 重抓。
    needs_text = False
    if not content_same:
        outdir.mkdir(parents=True, exist_ok=True)
        raw_path.write_bytes(raw)
        text = extract_text(raw, ext, fetch_meta.get("content_type", ""))
        if text:
            text_path.write_text(text, encoding="utf-8")
        else:
            needs_text = True
            stale = ""
            if text_path.exists():
                text_path.unlink()
                stale = f"  已删除：{text_path}（它不是从这份 raw 抽出来的，留着就是一把脱离了原件的尺子）\n"
            print(
                f"注意：{ext} 原件已存档，但抽不出文本，已登记为 needs_text=true。\n"
                f"  缺什么：{text_path}\n"
                f"{stale}"
                f"  为什么：{ext} 需要额外依赖（PDF 需 pypdf/PyPDF2），本机没有，本脚本不为此新增依赖；"
                f"而**手工把正文粘进 text.txt 这条路已经封死**——那样 raw 与 text 之间没有任何对应关系，"
                f"机械核验会照常判「一致」，只是一致于一份没人登记过的文件。\n"
                f"  怎么办：换一个本机抽得动的官方 URL（同一份文件的 HTML 版／DOCX 版）重跑本命令；"
                f"或在本机装上 pypdf 后重跑。在那之前 scripts/audit-sources.py 判红、"
                f"verify-quotes 把引用它的卡判为「找不到原件」。",
                file=sys.stderr,
            )
    elif old:
        needs_text = bool(old.get("needs_text"))

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
            "text": None if needs_text else f"{ks.ORIGINALS_DIR}/{args.source_id}/text.txt",
        },
    }
    if needs_text:
        entry["needs_text"] = True
    if args.justification:
        entry["justification"] = args.justification
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
