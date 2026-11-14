"""创意工坊下载器（由项目根目录的 L4D2创意工坊下载器.pyw 移植）

不走 Steam 客户端、不需要登录订阅，直接走 Steam 的 UGC CDN 取 vpk：
多线程分段 Range 下载 + SHA1 校验，最后按 Steam 的命名规则落成 <工坊ID>.vpk
（L4D2 只认这个命名）。支持断点续传、创意工坊合集自动展开、封面抓取。

与原脚本的差异：
  * 去掉了 tkinter 界面和 argparse（由 FastAPI 接口 + React 页面承担）；
  * 进度/日志改为回调，交给 DownloadManager 汇总成状态快照供前端轮询；
  * download_one 返回状态字符串（done/skip/fail/cancel），便于区分「跳过」和「完成」；
  * 默认输出目录优先用软件里已配置的 addons 路径下的 workshop 目录。
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import queue
import re
import socket
import ssl
import struct
import threading
import time
import urllib.parse
import urllib.request
from collections import deque
from typing import Optional

APPID = 550                     # Left 4 Dead 2
SEG = 1 << 20                   # 每段 1MB
DEFAULT_THREADS = 24            # 实测 24 路吞吐最好；再高反而下降
CDN_HOST = "cdn.steamusercontent.com"
IMG_HOST = "images.steamusercontent.com"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
# API 地址在下面「元数据」一节定义（那附近解释了直连与走系统解析的取舍）

SSL_CTX = ssl.create_default_context()


class Cancelled(Exception):
    """用户手动停止。单独一个类型，免得被重试逻辑当成网络错误再重试 8 次。"""


class ResolveError(RuntimeError):
    """解析工坊 ID 失败（多为网络/API 不可达）。"""


# ---------------------------------------------------------------- 小工具

def fmt_size(n) -> str:
    n = float(n or 0)
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f}{unit}" if unit != "B" else f"{int(n)}B"
        n /= 1024.0
    return f"{n:.1f}GB"


# ---------------------------------------------------------------- DNS 兜底
# 国内很多加速器会把 steam 域名写进 hosts 指向 127.0.0.1；加速器没开时
# 系统解析就废了。这里直接问公共 DNS，拿到真实 IP 走直连。

def dns_a(name, servers=("223.5.5.5", "119.29.29.29", "8.8.8.8")):
    labels = b"".join(bytes([len(p)]) + p.encode() for p in name.split(".") if p) + b"\x00"
    pkt = struct.pack("!HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + labels + struct.pack("!HH", 1, 1)
    for sv in servers:
        s = None
        try:
            s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
            s.settimeout(3.0)
            s.sendto(pkt, (sv, 53))
            data, _ = s.recvfrom(4096)
        except Exception:
            continue
        finally:
            if s:
                try:
                    s.close()
                except Exception:
                    pass
        try:
            an = struct.unpack("!H", data[6:8])[0]
            off = 12
            while data[off] != 0:
                off += data[off] + 1
            off += 5
            out = []
            for _ in range(an):
                if data[off] & 0xC0 == 0xC0:
                    off += 2
                else:
                    while data[off] != 0:
                        off += data[off] + 1
                    off += 1
                atype = struct.unpack("!H", data[off:off + 2])[0]
                rdlen = struct.unpack("!H", data[off + 8:off + 10])[0]
                off += 10
                rd = data[off:off + rdlen]
                off += rdlen
                if atype == 1 and rdlen == 4:
                    ip = ".".join(str(b) for b in rd)
                    if not ip.startswith("127."):
                        out.append(ip)
            if out:
                return sorted(set(out))
        except Exception:
            continue
    return []


_IP_CACHE: dict = {}


def resolve_ips(host, cache=None):
    """返回可用的直连 IP 列表（跳过 hosts 里指向 127.0.0.1 的劫持）。"""
    cache = _IP_CACHE if cache is None else cache
    if host in cache:
        return cache[host]
    ips = []
    try:
        for ai in socket.getaddrinfo(host, 443, proto=socket.IPPROTO_TCP):
            ip = ai[4][0]
            if ":" not in ip and not ip.startswith("127."):
                ips.append(ip)
    except Exception:
        pass
    if not ips:
        ips = dns_a(host)
    ips = sorted(set(ips))
    if ips:
        cache[host] = ips
    return ips


def clear_ip_cache(host=None):
    """丢弃缓存的解析结果（网络刚恢复 / 加速器开关切换后要重新解析）。"""
    if host is None:
        _IP_CACHE.clear()
    else:
        _IP_CACHE.pop(host, None)


# ---------------------------------------------------------------- 元数据
# 查工坊元数据只有 HTTPS 一条路，但「怎么出网」有好几种，选错就会
# 「不开加速器查不了 / 开了加速器还是超时」：
#
#   * api.steamchina.com（蒸汽平台）：DNS 不被加速器劫持，国内直连 0.3~0.7s，
#     返回字段与 api.steampowered.com 完全一致（已逐字段对比过）。优先走它。
#     这条必须**绕开系统代理**：解析到的是国内 IP，塞进境外代理反而超时。
#   * api.steampowered.com：国内直连基本不通（184.26.x 读超时），只能靠
#     加速器把域名写进 hosts 指向 127.0.0.1，再由它在本地 443 反代出去。
#     加速器没开但 hosts 残留时，连接立刻被拒 —— 这就是老版「不开加速器
#     检查更新永远失败」的原因；这时自己解析真实 IP 带 SNI 直连也只是碰运气。
#
# 所以顺序是：国内端点（直连）→ 国际端点（先加速器反代，再直连真实 IP），
# 全程有时间预算，断网时几秒内报错，而不是让界面一直「检查中…」。

API_HOST = "api.steampowered.com"     # 国际站：国内多数网络直连被墙，只能靠加速器/系统代理
API_HOST_CN = "api.steamchina.com"    # 蒸汽平台：国内直连可用（实测 0.3~0.7s），字段与国际站一致
API_PATH = "/ISteamRemoteStorage/GetPublishedFileDetails/v1/"
API_URL = f"https://{API_HOST}{API_PATH}"

# 端点顺序：先国内再国际。国内这条不依赖 hosts/加速器，是「开了加速器也超时」的解药；
# 国际站留作兜底，毕竟个别条目（下架、锁区）可能只在国际站查得到。
API_ENDPOINTS = (API_HOST_CN, API_HOST)
API_CONNECT_TIMEOUT = 3.5     # 单个 IP 建连 + TLS 握手的时间上限
API_READ_TIMEOUT = 10.0       # 单次请求收响应的时间上限
API_MAX_IPS = 2               # 每条路最多试几个 IP
API_TOTAL_BUDGET = 18.0       # 一次 _api_post 的总预算，超了就认输

# 记住上次成功的端点，10 分钟内优先用它，省掉一次无用超时
_LAST_OK = {"host": "", "at": 0.0}
ENDPOINT_MEMORY_TTL = 600.0

_PROXY_PROBE = {"at": 0.0, "ok": False}


def _proxy_listening(host="127.0.0.1", port=443, ttl=5.0) -> bool:
    """本机 443 上有没有加速器的反向代理在跑（同一个结论缓存几秒）。"""
    now = time.time()
    if now - _PROXY_PROBE["at"] < ttl:
        return bool(_PROXY_PROBE["ok"])
    ok = False
    s = None
    try:
        s = socket.create_connection((host, port), timeout=0.25)
        ok = True
    except Exception:
        ok = False
    finally:
        if s:
            try:
                s.close()
            except Exception:
                pass
    _PROXY_PROBE.update(at=now, ok=ok)
    return ok


_SYS_DNS_CACHE: dict = {}


def _system_ips(host) -> list:
    """系统解析结果（保留 127.x，加速器的本地代理就是靠它工作的）。

    getaddrinfo 没有超时参数，DNS 被劫持/断网时能一直卡住，所以放到线程里
    等最多 3 秒，卡住就当作没有结果，别让调用方陪着等。
    """
    hit = _SYS_DNS_CACHE.get(host)
    if hit and time.time() - hit[0] < hit[2]:
        return hit[1]
    box: list = []

    def run():
        try:
            box.extend(ai[4][0] for ai in socket.getaddrinfo(
                host, 443, proto=socket.IPPROTO_TCP) if ":" not in ai[4][0])
        except Exception:
            pass

    t = threading.Thread(target=run, daemon=True, name="api-dns")
    t.start()
    t.join(2.5)
    ips = list(dict.fromkeys(box))
    # 卡住/失败的结论只记一小会儿，网络恢复后还能再问一次
    _SYS_DNS_CACHE[host] = (time.time(), ips, 300.0 if ips else 15.0)
    return ips


def _dechunk(data: bytes) -> bytes:
    """解 HTTP/1.1 的 chunked 编码（Steam 接口一般不用，防个万一）。"""
    out = bytearray()
    i, n = 0, len(data)
    while i < n:
        j = data.find(b"\r\n", i)
        if j < 0:
            break
        try:
            size = int(data[i:j].split(b";")[0].strip(), 16)
        except ValueError:
            break
        i = j + 2
        if size == 0:
            break
        out += data[i:i + size]
        i += size + 2
    return bytes(out)


def _parse_http_response(buf: bytes) -> dict:
    head, _, payload = buf.partition(b"\r\n\r\n")
    lines = head.split(b"\r\n")
    status = lines[0].decode("latin-1", "replace")
    parts = status.split(" ")
    if len(parts) < 2 or parts[1] != "200":
        raise IOError(f"HTTP {status[:60]}")
    low = head.lower()
    if b"transfer-encoding:" in low and b"chunked" in low:
        payload = _dechunk(payload)
    if b"content-encoding:" in low and b"gzip" in low:
        payload = gzip.decompress(payload)
    return json.loads(payload.decode("utf-8", "replace"))


def _post_direct(ip, body: bytes, read_timeout: float,
                 host: str = API_HOST, path: str = API_PATH) -> dict:
    """直连指定 IP 发 POST（自带 SNI 和 Host 头，证书照样校验）。"""
    raw = socket.create_connection((ip, 443), timeout=API_CONNECT_TIMEOUT)
    try:
        s = SSL_CTX.wrap_socket(raw, server_hostname=host)
    except Exception:
        try:
            raw.close()
        except Exception:
            pass
        raise
    try:
        s.settimeout(read_timeout)
        req = (f"POST {path} HTTP/1.1\r\n"
               f"Host: {host}\r\n"
               f"User-Agent: {UA}\r\n"
               f"Accept: application/json\r\n"
               f"Content-Type: application/x-www-form-urlencoded\r\n"
               f"Content-Length: {len(body)}\r\n"
               f"Connection: close\r\n\r\n")
        s.sendall(req.encode() + body)
        buf = bytearray()
        want = -1          # Content-Length；拿到就按长度收，不硬等服务器断开
        chunked = False
        while True:
            d = s.recv(65536)
            if not d:
                break
            buf += d
            if want < 0 and not chunked and b"\r\n\r\n" in buf:
                head = bytes(buf[:buf.index(b"\r\n\r\n")]).lower()
                for line in head.split(b"\r\n"):
                    if line.startswith(b"content-length:"):
                        try:
                            want = int(line.split(b":", 1)[1].strip())
                        except ValueError:
                            want = -1
                chunked = b"transfer-encoding:" in head and b"chunked" in head
            if want >= 0:
                sep = buf.find(b"\r\n\r\n")
                if sep >= 0 and len(buf) - (sep + 4) >= want:
                    break
            elif chunked and bytes(buf).endswith(b"0\r\n\r\n"):
                # chunked 的结束标记：不必等服务器关连接
                break
            if len(buf) > (16 << 20):
                raise IOError("响应体过大")
    finally:
        try:
            s.close()
        except Exception:
            pass
    return _parse_http_response(bytes(buf))


def _post_via_system(body: bytes, read_timeout: float,
                     host: str = API_HOST, path: str = API_PATH,
                     no_proxy: bool = False) -> dict:
    """走系统解析（urllib）发 POST。

    no_proxy=True 时忽略 HTTP(S)_PROXY 与注册表代理 —— 国内端点必须这样，
    否则会把打给 211.97.x 的请求塞进境外代理，白等一轮超时。
    """
    req = urllib.request.Request(f"https://{host}{path}", data=body, headers={
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded",
    })
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({})) if no_proxy else None
    open_fn = opener.open if opener else urllib.request.urlopen
    with open_fn(req, timeout=read_timeout) as r:
        return json.loads(r.read().decode("utf-8", "replace"))



class _EndpointError(RuntimeError):
    """某个端点把它该试的走法都试完了；errs 是每次尝试的一句话原因。"""

    def __init__(self, host: str, errs: list):
        self.host = host
        self.errs = list(errs)
        super().__init__(" | ".join(self.errs) or "未知原因")


def _endpoint_order() -> list:
    """端点顺序：上次成功的优先（10 分钟内），其余保持「国内 → 国际」。"""
    hosts = list(API_ENDPOINTS)
    last = _LAST_OK["host"]
    if last in hosts and time.time() - _LAST_OK["at"] < ENDPOINT_MEMORY_TTL:
        hosts.remove(last)
        hosts.insert(0, last)
    return hosts


def _host_label(host: str) -> str:
    return {API_HOST_CN: "国内", API_HOST: "国际"}.get(host, host)


def _post_host(host: str, body: bytes, timeout: float, deadline: float) -> dict:
    """在单个端点内把可用的走法试完；全失败抛 _EndpointError。"""
    errs: list = []

    if host == API_HOST_CN:
        # 国内站解析到国内 IP，必须绕开代理：塞进境外代理只会白等一轮超时。
        # 用 urllib 而不是自己挑 IP，因为它会依次试 getaddrinfo 的每个地址。
        left = min(timeout, deadline - time.time())
        if left > 0.5:
            try:
                return _post_via_system(body, max(1.0, left), host=host, no_proxy=True)
            except Exception as e:
                errs.append(f"直连：{type(e).__name__} {e}")
        # 系统 DNS 若被劫持成 127.x，就问公共 DNS 拿真地址再直连
        for ip in [x for x in resolve_ips(host) if not x.startswith("127.")][:API_MAX_IPS]:
            left = min(timeout, deadline - time.time())
            if left <= 0.5:
                break
            try:
                return _post_direct(ip, body, max(1.0, left), host=host)
            except Exception as e:
                errs.append(f"直连 {ip}：{type(e).__name__}")
        raise _EndpointError(host, errs)

    # 国际站：先看系统解析长什么样，再决定先走哪条路
    #   * 127.x + 本机 443 有反代（加速器在跑）→ 系统路径，由它转发出去；
    #   * 127.x 但没人听（加速器关了、hosts 残留）→ 先直连；
    #   * 解析正常 → 系统路径最便宜，也顺带吃系统代理设置；
    #   * 解析不出东西 → 直连，用公共 DNS 拿到的真实 IP。
    sys_ips = _system_ips(host)
    hijacked = (not sys_ips) or all(ip.startswith("127.") for ip in sys_ips)
    prefer_system = _proxy_listening() if hijacked else True
    order = ("system", "direct") if prefer_system else ("direct", "system")
    if hijacked and not sys_ips and not prefer_system:
        clear_ip_cache(host)   # 系统 DNS 完全废了，先清掉可能过期的缓存

    for mode in order:
        left = min(timeout, deadline - time.time())
        if left <= 0.5:
            errs.append("超出时间预算")
            break
        if mode == "system":
            try:
                return _post_via_system(body, max(1.0, left), host=host)
            except Exception as e:
                errs.append(f"系统解析：{type(e).__name__} {e}")
            continue
        ips = [x for x in resolve_ips(host) if not x.startswith("127.")]
        if not ips:
            errs.append(f"解析不到 {host}")
            continue
        for ip in ips[:API_MAX_IPS]:
            left = min(timeout, deadline - time.time())
            if left <= 0.5:
                break
            try:
                return _post_direct(ip, body, max(1.0, left), host=host)
            except Exception as e:
                errs.append(f"直连 {ip}：{type(e).__name__}")
    raise _EndpointError(host, errs)


def _api_post(payload, timeout=API_READ_TIMEOUT, skip_host=None):
    body = urllib.parse.urlencode(payload).encode()
    deadline = time.time() + API_TOTAL_BUDGET
    hosts = _endpoint_order()
    if skip_host in hosts and len(hosts) > 1:
        hosts.remove(skip_host)
        hosts.append(skip_host)     # 补查时把上次那个端点排到最后
    errs: list = []

    for idx, host in enumerate(hosts):
        remain = deadline - time.time()
        if remain <= 1.0:
            errs.append("超出时间预算")
            break
        # 第一个端点别把预算吃光，兜底端点至少留三成机会
        share = remain * 0.7 if idx == 0 and len(hosts) > 1 else remain
        try:
            data = _post_host(host, body, min(timeout, max(1.0, share)),
                              time.time() + share)
        except Exception as e:
            sub = getattr(e, "errs", None) or [f"{type(e).__name__} {e}"]
            errs.extend(f"{_host_label(host)}·{x}" for x in sub)
            clear_ip_cache(host)
            continue
        if _LAST_OK["host"] != host:
            _LAST_OK.update(host=host, at=time.time())
        return data

    for h in hosts:                # 下次重新解析，别一直拿坏 IP / 坏端点
        clear_ip_cache(h)
    _LAST_OK.update(host="", at=0.0)   # 全挂了就别再优先上次那个，回到「国内优先」
    print(f"[SteamApi] 请求失败（{' → '.join(hosts)}）：" + " | ".join(errs))
    raise ResolveError(_api_fail_hint(errs))


def _api_fail_hint(errs: list) -> str:
    """把技术性的失败原因翻成一句用户能照做的话。

    走到这里说明国内、国际两条线都失败了 —— 单纯「再开一次加速器」已经不
    是有效建议（用户多半早就开着），要指出下一步该看什么。原始错误压到 80 字
    以内附在末尾：界面是普通段落，太长会占掉半屏。
    """
    joined = " ".join(errs)
    tail = " | ".join(errs[-2:])
    if len(tail) > 60:
        tail = tail[:57] + "…"

    if "ConnectionRefused" in joined or "RefusedError" in joined or "10061" in joined:
        base = ("连不上 Steam 接口：hosts 里 api.steampowered.com → 127.0.0.1 已经失效"
                "（加速器关了没清）。重开一次加速器再彻底退出，或删掉 hosts 里那一行")
    elif "TimeoutError" in joined or "timed out" in joined:
        base = ("连不上 Steam 接口：国内、国际两条线都超时。浏览器能打开 api.steamchina.com，"
                "就是本机拦了 Python（防火墙 / 代理只放行浏览器）；打不开就换网络再试")
    elif ("gaierror" in joined or "getaddrinfo" in joined
          or "Name or service not known" in joined or "解析不到" in joined):
        base = "连不上 Steam 接口：两条线的域名都解析失败，把网卡 DNS 临时改成 223.5.5.5 再试"
    else:
        base = "连不上 Steam 接口"
    return f"{base}（{tail}）" if tail else base



def _details_payload(ids) -> dict:
    payload = {"itemcount": str(len(ids))}
    for i, v in enumerate(ids):
        payload[f"publishedfileids[{i}]"] = str(v)
    return payload


def fetch_details(ids) -> list[dict]:
    ids = [str(i) for i in ids]
    data = _api_post(_details_payload(ids))
    res = [f for f in data.get("response", {}).get("publishedfiledetails", [])
           if int(f.get("result", 0)) == 1]
    got = {str(f.get("publishedfileid")) for f in res}
    missing = [i for i in ids if i not in got]
    if missing:
        # 端点的库未必一样全（下架、锁区条目常只在一边能查到），换另一条线补一次。
        # 补不到就算了：已经拿到的结果照常返回，不该因为个别条目把整批判失败。
        try:
            data2 = _api_post(_details_payload(missing),
                              timeout=min(API_READ_TIMEOUT, 6.0),
                              skip_host=_LAST_OK["host"])
            res.extend(f for f in data2.get("response", {}).get("publishedfiledetails", [])
                       if int(f.get("result", 0)) == 1)
        except ResolveError:
            pass
    return res


def expand_collections(items, depth=0, log=None) -> list[dict]:
    """合集条目没有 file_url 但带 children，展开成子条目。"""
    log = log or (lambda _m: None)
    out = []
    for it in items:
        kids = it.get("children") or []
        if not it.get("file_url") and kids and depth < 3:
            ids = [str(c["publishedfileid"]) for c in kids if c.get("publishedfileid")]
            log(f"[合集] {it.get('title') or it['publishedfileid']} 含 {len(ids)} 个条目，展开中…")
            try:
                out.extend(expand_collections(fetch_details(ids), depth + 1, log))
            except ResolveError as e:
                log(f"[合集] 展开失败：{e}")
        else:
            out.append(it)
    return out


def sha1_from_url(url):
    if not url:
        return None
    parts = urllib.parse.urlsplit(url).path.strip("/").split("/")
    for p in parts:
        if re.fullmatch(r"[0-9A-Fa-f]{40}", p):
            return p.upper()
    return None


# ---------------------------------------------------------------- 下载核心

def _connect(ip, host, timeout):
    raw = socket.create_connection((ip, 443), timeout=timeout)
    try:
        s = SSL_CTX.wrap_socket(raw, server_hostname=host)
    except Exception:
        raw.close()
        raise
    s.settimeout(timeout)
    return s


def fetch_segment(host, path, ips, fpath, off, end, deadline, cancel=None):
    want = end - off + 1
    last = None
    for attempt in range(8):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        s = None
        try:
            s = _connect(ips[attempt % len(ips)], host, 15)
            req = (f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: {UA}\r\n"
                   f"Accept: */*\r\nRange: bytes={off}-{end}\r\nConnection: close\r\n\r\n")
            s.sendall(req.encode())
            buf = b""
            while b"\r\n\r\n" not in buf:
                d = s.recv(16384)
                if not d:
                    raise IOError("响应头被截断")
                buf += d
            head, body = buf.split(b"\r\n\r\n", 1)
            status = head.split(b"\r\n")[0]
            if b" 206 " in status:
                pass
            elif b" 200 " in status:
                # 服务器忽略了 Range，body 是完整文件的开头，不能塞到 off 去
                if off != 0:
                    raise IOError("服务器忽略 Range（返回 200）")
            else:
                raise IOError("HTTP " + status.decode("latin-1", "replace"))
            got = 0
            with open(fpath, "r+b", buffering=0) as fh:
                fh.seek(off)
                if body:
                    n = min(len(body), want)
                    fh.write(body[:n])
                    got = n
                while got < want:
                    if cancel is not None and cancel.is_set():
                        raise Cancelled()
                    if time.time() > deadline:
                        raise IOError("段超时")
                    d = s.recv(min(65536, want - got))
                    if not d:
                        break
                    fh.write(d)
                    got += len(d)
            if got != want:
                raise IOError(f"读少了 {got}/{want}")
            return
        except Cancelled:
            raise
        except Exception as e:
            last = e
            time.sleep(min(0.4 * (attempt + 1), 3.0))
        finally:
            if s:
                try:
                    s.close()
                except Exception:
                    pass
    raise IOError(f"段 {off} 失败: {type(last).__name__}: {last}")


def file_sha1(path) -> str:
    h = hashlib.sha1()
    with open(path, "rb") as f:
        while True:
            blk = f.read(4 << 20)
            if not blk:
                break
            h.update(blk)
    return h.hexdigest().upper()


def download_one(item, outdir, threads, force, log=None, prog=None, cancel=None,
                 _retry=True) -> str:
    """下载单个条目。返回 'done' | 'skip' | 'fail' | 'cancel'。"""
    log = log or (lambda _m: None)
    say = log

    wid = str(item["publishedfileid"])
    title = (item.get("title") or "").strip() or wid
    size = int(item.get("file_size") or 0)
    url = item.get("file_url") or ""
    if not url and item.get("hcontent_file"):
        url = f"https://{CDN_HOST}/ugc/{item['hcontent_file']}/"
    if not url:
        say(f"[跳过] {wid} {title} — 没有可用直链（可能是 DLC/合集/已下架），请在 Steam 里订阅")
        return "skip"

    want_sha = sha1_from_url(url)
    host = urllib.parse.urlsplit(url).hostname or CDN_HOST
    path = urllib.parse.urlsplit(url).path
    outp = os.path.join(outdir, wid + ".vpk")
    part = outp + ".part"
    meta = part + ".json"

    if os.path.exists(outp) and not force:
        actual = os.path.getsize(outp)
        if want_sha:
            if file_sha1(outp) == want_sha:
                say(f"[已存在] {wid}.vpk  {fmt_size(actual)}  校验通过，跳过")
                _grab_thumb(item, outdir, wid)
                return "skip"
            say(f"[重下] {wid}.vpk 校验不通过")
        elif size and actual == size:
            say(f"[已存在] {wid}.vpk  {fmt_size(actual)}  跳过")
            _grab_thumb(item, outdir, wid)
            return "skip"

    ips = resolve_ips(host)
    if not ips:
        say(f"[失败] {wid} 解析不到 {host}（DNS 被劫持且公共 DNS 也不通）")
        return "fail"

    # 段尺寸已知才按大小下；否则单流全量
    nseg = (size + SEG - 1) // SEG if size else 1
    done = set()
    if os.path.exists(part) and os.path.exists(meta):
        try:
            with open(meta, "r", encoding="utf-8") as fh:
                m = json.load(fh)
            if m.get("size") == size and m.get("sha1") == want_sha:
                done = set(int(x) for x in (m.get("done") or []))
                if done:
                    say(f"发现未完成的任务，续传 {len(done)}/{nseg} 段")
        except Exception:
            done = set()
    elif os.path.exists(part):
        try:
            os.remove(part)
        except Exception:
            pass

    say(f"下载 {wid}.vpk  {title}")
    say(f"{fmt_size(size) if size else '未知大小'}  |  {len(ips)} 个 CDN IP  |  {threads} 线程"
        + (f"  |  SHA1 {want_sha[:12]}…" if want_sha else "  |  无 SHA1 可校验"))

    # 关键：续传时绝不能 "wb" 打开——那会把已下好的段清零。
    with open(part, "r+b" if (done and os.path.exists(part)) else "wb") as fh:
        if size and os.path.getsize(part) != size:
            fh.truncate(size)

    q: "queue.Queue[int]" = queue.Queue()
    for i in range(nseg):
        if i not in done:
            q.put(i)

    lock = threading.Lock()
    state = {"done": len(done), "fail": []}
    completed = set(done)
    stop = [False]

    def worker():
        while not stop[0]:
            if cancel is not None and cancel.is_set():
                return
            try:
                idx = q.get_nowait()
            except queue.Empty:
                return
            off = idx * SEG
            end = (min(off + SEG, size) if size else 0) - 1
            try:
                if size:
                    fetch_segment(host, path, ips, part, off, end, time.time() + 240, cancel)
                else:
                    _download_stream(host, path, ips, part, cancel)
                with lock:
                    state["done"] += 1
                    completed.add(idx)
            except Cancelled:
                return
            except Exception as e:
                with lock:
                    state["fail"].append((idx, str(e)))

    def save_meta():
        with lock:
            snap = sorted(completed)
        try:
            with open(meta, "w", encoding="utf-8") as fh:
                json.dump({"size": size, "sha1": want_sha, "done": snap}, fh)
        except Exception:
            pass

    def saver():
        """定期把已完成段落到 .part.json，中断后能续传。"""
        while not stop[0]:
            time.sleep(5)
            if stop[0]:
                return
            save_meta()

    t0 = time.time()
    tick = 0.4 if prog else 2.0
    ts = [threading.Thread(target=worker, daemon=True) for _ in range(max(1, min(threads, 64)))]
    for t in ts:
        t.start()

    def show():
        while not stop[0]:
            time.sleep(tick)
            if stop[0]:
                return
            with lock:
                d = state["done"]
                f = len(state["fail"])
            el = max(time.time() - t0, 0.001)
            spd = d * SEG / el
            p = {"wid": wid, "done": d, "nseg": nseg, "size": size,
                 "bytes": d * SEG if size else (os.path.getsize(part) if os.path.exists(part) else 0),
                 "speed": spd, "fail": f, "elapsed": el}
            if size:
                p["pct"] = d * 100.0 / nseg
                if spd > 20000:
                    eta = (nseg - d) * SEG / spd
                    p["eta_txt"] = time.strftime("%M:%S", time.gmtime(eta))
                else:
                    p["eta_txt"] = "剩 --:--"
            else:
                p["pct"] = None
                p["eta_txt"] = ""
            if prog:
                try:
                    prog(p)
                except Exception:
                    pass

    mon = threading.Thread(target=show, daemon=True)
    mon.start()
    sv = threading.Thread(target=saver, daemon=True)
    sv.start()
    for t in ts:
        t.join()
    stop[0] = True
    sv.join(timeout=7.0)

    if cancel is not None and cancel.is_set():
        save_meta()
        log("已停止，已下好的段保留，下次自动续传")
        return "cancel"

    with lock:
        fails = list(state["fail"])
    if fails:
        save_meta()
        say(f"[失败] {wid} 有 {len(fails)} 段没下下来，已保留 .part 供续传：")
        for i, e in fails[:5]:
            say(f"段 {i}: {e}")
        return "fail"

    # 收尾
    if size and os.path.getsize(part) != size:
        say(f"[失败] {wid} 大小不符 {os.path.getsize(part)} != {size}")
        return "fail"

    if want_sha:
        if file_sha1(part) != want_sha:
            for p in (part, meta):
                try:
                    if os.path.exists(p):
                        os.remove(p)
                except Exception:
                    pass
            if _retry:
                say(f"[!] {wid} SHA1 不匹配（可能是续传的残段或 CDN 抖动），丢弃后完整重下一次…")
                return download_one(item, outdir, threads, True, log=log, prog=prog,
                                    cancel=cancel, _retry=False)
            say(f"[失败] {wid} SHA1 仍然不匹配，放弃")
            return "fail"
    os.replace(part, outp)
    try:
        if os.path.exists(meta):
            os.remove(meta)
    except Exception:
        pass
    el = time.time() - t0
    say(f"[完成] {wid}.vpk  {fmt_size(os.path.getsize(outp))}  {el:.0f}s  "
        f"{fmt_size((size or 0) / max(el, 0.001))}/s  SHA1 OK")
    _grab_thumb(item, outdir, wid)
    return "done"


def _download_stream(host, path, ips, part, cancel=None):
    """大小未知时单流下载（少见）。"""
    for attempt in range(6):
        if cancel is not None and cancel.is_set():
            raise Cancelled()
        s = None
        try:
            s = _connect(ips[attempt % len(ips)], host, 20)
            s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: {UA}\r\n"
                       f"Accept: */*\r\nConnection: close\r\n\r\n").encode())
            buf = b""
            while b"\r\n\r\n" not in buf:
                d = s.recv(16384)
                if not d:
                    raise IOError("响应头被截断")
                buf += d
            _head, body = buf.split(b"\r\n\r\n", 1)
            with open(part, "r+b" if os.path.exists(part) else "wb") as fh:
                fh.seek(0)
                fh.truncate()
                fh.write(body)
                while True:
                    if cancel is not None and cancel.is_set():
                        raise Cancelled()
                    d = s.recv(65536)
                    if not d:
                        break
                    fh.write(d)
            return
        except Cancelled:
            raise
        except Exception:
            time.sleep(1.5 * (attempt + 1))
        finally:
            if s:
                try:
                    s.close()
                except Exception:
                    pass
    raise IOError("单流下载失败")


def fetch_bytes(url, timeout=15, attempts=3) -> Optional[bytes]:
    """走同样的直连 IP 逻辑抓一张图片（封面）。返回 None 表示失败。

    查询串必须一起带上：图床的缩放参数（`?imw=…&imh=…`）全在 query 里，
    以前只取 `urlsplit().path` 把它丢掉了，等于「加了缩放参数也拿回原图」——
    一张 11.8 MB 的动图缩不下来，白费流量和显存。
    """
    parts = urllib.parse.urlsplit(url)
    host = parts.hostname or IMG_HOST
    path = parts.path + (("?" + parts.query) if parts.query else "")
    ips = resolve_ips(host)
    for _ in range(attempts):
        for ip in (ips or [host]):
            s = None
            try:
                s = _connect(ip, host, timeout)
                s.sendall((f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUser-Agent: {UA}\r\n"
                           f"Connection: close\r\n\r\n").encode())
                buf = b""
                while b"\r\n\r\n" not in buf:
                    d = s.recv(16384)
                    if not d:
                        raise IOError("no headers")
                    buf += d
                head, body = buf.split(b"\r\n\r\n", 1)
                if b" 200 " not in head.split(b"\r\n")[0]:
                    raise IOError("status")
                data = bytearray(body)
                while True:
                    d = s.recv(65536)
                    if not d:
                        break
                    data += d
                if len(data) < 512:
                    raise IOError("too small")
                return bytes(data)
            except Exception:
                continue
            finally:
                if s:
                    try:
                        s.close()
                    except Exception:
                        pass
        time.sleep(1.0)
    return None


def _grab_thumb(item, outdir, wid):
    url = item.get("preview_url")
    if not url:
        return
    dst = os.path.join(outdir, wid + ".jpg")
    if os.path.exists(dst) and os.path.getsize(dst) > 1024:
        return
    data = fetch_bytes(url)
    if data:
        try:
            with open(dst, "wb") as fh:
                fh.write(data)
        except Exception:
            pass


# ---------------------------------------------------------------- 目录

def steam_libraries():
    libs = []
    sp = None
    try:
        import winreg
        with winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Valve\Steam") as k:
            sp = winreg.QueryValueEx(k, "SteamPath")[0]
    except Exception:
        pass
    if sp:
        libs.append(sp.replace("/", "\\"))
        vdf = os.path.join(sp, "steamapps", "libraryfolders.vdf")
        try:
            with open(vdf, "r", encoding="utf-8", errors="replace") as fh:
                txt = fh.read()
            for m in re.finditer(r'"path"\s+"([^"]+)"', txt):
                p = m.group(1).replace("\\\\", "\\")
                if p not in libs:
                    libs.append(p)
        except Exception:
            pass
    return libs


def find_workshop_dir():
    env = os.environ.get("L4D2_WORKSHOP_DIR")
    if env and os.path.isdir(env):
        return env
    for lib in steam_libraries():
        d = os.path.join(lib, "steamapps", "common", "Left 4 Dead 2",
                         "left4dead2", "addons", "workshop")
        if os.path.isdir(d):
            return d
        d2 = os.path.join(lib, "steamapps", "common", "Left 4 Dead 2",
                          "left4dead2", "addons")
        if os.path.isdir(d2):
            return os.path.join(d2, "workshop")
    return None


def default_outdir() -> str:
    """下载落点：优先用软件里已配置的 addons/workshop，其次自动探测。"""
    env = os.environ.get("L4D2_WORKSHOP_DIR")
    if env and os.path.isdir(env):
        return env
    try:
        from services.data_store import get_addons_path
        ap = get_addons_path()
        if ap and os.path.isdir(ap):
            ws = os.path.join(ap, "workshop")
            return ws if os.path.isdir(ws) else ap
    except Exception:
        pass
    ws = find_workshop_dir()
    if ws and os.path.isdir(ws):
        return ws
    return os.path.join(os.path.expanduser("~"), "Downloads", "L4D2")


def outdir_hint(outdir: str) -> str:
    """目标目录不是 workshop 根时提醒一句：游戏只加载 workshop 根下的 .vpk。"""
    try:
        if os.path.basename(os.path.normpath(outdir)).lower() == "workshop":
            return ""
    except Exception:
        return ""
    return "注意：文件存在这里，游戏不会自动加载；要进游戏请把 .vpk 挪到 …\\left4dead2\\addons\\workshop\\"


def parse_targets(raw: str) -> list[str]:
    """从一段文本里解析工坊 ID / 链接（每行一个，也支持空格分隔）。"""
    ids: list[str] = []
    for t in re.split(r"[\s,;]+", raw or ""):
        t = t.strip().strip('"').strip("'")
        if not t:
            continue
        m = re.search(r"[?&]id=(\d+)", t) or re.search(r"(\d{6,})", t)
        if m:
            wid = m.group(1)
            if wid not in ids:
                ids.append(wid)
    return ids


# ---------------------------------------------------------------- 任务管理

_STATE_PENDING = "pending"
_STATE_RUNNING = "running"
_STATE_DONE = "done"
_STATE_SKIP = "skip"
_STATE_FAIL = "fail"
_STATE_CANCEL = "cancel"


class DownloadManager:
    """单例任务管理器：维护队列、进度、日志，供 /api/download/* 使用。"""

    def __init__(self):
        self._lock = threading.RLock()
        self._jobs: list[dict] = []
        self._items: dict[str, dict] = {}
        self._logs: deque = deque(maxlen=300)
        self._thread: Optional[threading.Thread] = None
        self._cancel = threading.Event()
        self.running = False
        self.outdir = default_outdir()
        self.threads = DEFAULT_THREADS
        self.force = False
        self._started_at: Optional[float] = None
        self._finished_at: Optional[float] = None
        self._load_prefs()

    # ---------- 配置持久化 ----------
    def _load_prefs(self):
        try:
            from services.data_store import get_setting
            t = get_setting("download_threads", None)
            if isinstance(t, int) and 1 <= t <= 64:
                self.threads = t
            od = get_setting("download_outdir", None)
            # 目录可能被用户删掉/挪走（或上次指向了临时目录）——不存在就回退到自动探测
            if isinstance(od, str) and od.strip() and os.path.isdir(od):
                self.outdir = od
            f = get_setting("download_force", None)
            if isinstance(f, bool):
                self.force = f
        except Exception:
            pass

    def _save_prefs(self):
        try:
            from services.data_store import set_setting
            set_setting("download_threads", int(self.threads))
            set_setting("download_outdir", self.outdir)
            set_setting("download_force", bool(self.force))
        except Exception:
            pass

    # ---------- 日志 ----------
    def _log(self, msg: str):
        line = f"{time.strftime('%H:%M:%S')} {msg}".rstrip()
        with self._lock:
            self._logs.append(line)
        try:
            print(f"[Download] {msg}")
        except Exception:
            pass

    # ---------- 解析/入队 ----------
    def add_targets(self, text: str) -> dict:
        ids = parse_targets(text)
        if not ids:
            return {"added": [], "ignored": [], "error": "没有解析到有效的创意工坊 ID"}

        with self._lock:
            known = {j["wid"] for j in self._jobs}
        todo = [i for i in ids if i not in known]
        if not todo:
            return {"added": [], "ignored": ids, "error": ""}

        self._log(f"解析 {len(todo)} 个工坊 ID…")
        try:
            items = fetch_details(todo)
            items = expand_collections(items, log=self._log)
        except ResolveError as e:
            self._log(str(e))
            return {"added": [], "ignored": ids, "error": str(e)}

        got = {str(it.get("publishedfileid")) for it in items}
        added = []
        with self._lock:
            for it in items:
                wid = str(it.get("publishedfileid"))
                if any(j["wid"] == wid for j in self._jobs):
                    continue
                self._items[wid] = it
                size = int(it.get("file_size") or 0)
                job = {
                    "wid": wid,
                    "title": (it.get("title") or "").strip() or wid,
                    "size": size,
                    "preview": it.get("preview_url") or "",
                    "state": _STATE_PENDING,
                    "pct": 0.0,
                    "done": 0,
                    "nseg": (size + SEG - 1) // SEG if size else 1,
                    "speed": 0.0,
                    "eta": "",
                    "error": "",
                    "exists": os.path.exists(os.path.join(self.outdir, wid + ".vpk")),
                }
                self._jobs.append(job)
                added.append(wid)
        self._log(f"已添加 {len(added)} 个条目到队列")
        return {"added": added, "ignored": [i for i in ids if i not in got], "error": ""}

    def remove(self, wids: list[str]):
        with self._lock:
            if self.running:
                # 正在跑的不允许移除，避免状态错乱
                self._jobs = [j for j in self._jobs
                              if not (j["wid"] in wids and j["state"] == _STATE_PENDING)]
            else:
                self._jobs = [j for j in self._jobs if j["wid"] not in wids]

    def clear(self):
        with self._lock:
            if self.running:
                return
            self._jobs = []
            self._items = {}

    # ---------- 启动/停止 ----------
    def start(self, outdir: Optional[str] = None, threads: Optional[int] = None,
              force: Optional[bool] = None) -> dict:
        with self._lock:
            if self.running:
                return {"ok": False, "error": "已有下载任务在运行"}
            if outdir:
                self.outdir = outdir.strip()
            if threads:
                self.threads = max(1, min(int(threads), 64))
            if force is not None:
                self.force = bool(force)
            if not self.outdir:
                return {"ok": False, "error": "请先指定输出目录"}
            try:
                os.makedirs(self.outdir, exist_ok=True)
            except Exception as e:
                return {"ok": False, "error": f"无法创建输出目录：{e}"}

            todo = [j for j in self._jobs if j["state"] in (_STATE_PENDING, _STATE_FAIL, _STATE_CANCEL)]
            if not todo:
                return {"ok": False, "error": "队列里没有待下载的条目"}

            for j in todo:
                j.update({"state": _STATE_PENDING, "pct": 0.0, "done": 0, "speed": 0.0,
                          "eta": "", "error": ""})

            self._cancel.clear()
            self.running = True
            self._started_at = time.time()
            self._finished_at = None
            self._save_prefs()
            self._thread = threading.Thread(target=self._run, args=(list(todo),),
                                            daemon=True, name="workshop-downloader")
            self._thread.start()
        self._log(f"开始下载：{len(todo)} 项，{self.threads} 线程 → {self.outdir}")
        return {"ok": True}

    def stop(self) -> dict:
        with self._lock:
            if not self.running:
                return {"ok": False, "error": "当前没有正在运行的任务"}
            self._cancel.set()
        self._log("正在停止…（已下好的段会保留，下次自动续传）")
        return {"ok": True}

    def _run(self, jobs: list[dict]):
        outdir = self.outdir
        threads = self.threads
        force = self.force
        canceled = False
        try:
            for job in jobs:
                if self._cancel.is_set():
                    canceled = True
                    break
                wid = job["wid"]
                item = self._items.get(wid)
                if not item:
                    with self._lock:
                        job["state"] = _STATE_FAIL
                        job["error"] = "条目信息丢失，请重新添加"
                    continue
                with self._lock:
                    job["state"] = _STATE_RUNNING
                    job["pct"] = 0.0
                try:
                    result = download_one(
                        item, outdir, threads, force,
                        log=self._log,
                        prog=lambda p, _wid=wid: self._on_prog(_wid, p),
                        cancel=self._cancel,
                    )
                except Cancelled:
                    result = _STATE_CANCEL
                except Exception as e:
                    self._log(f"[异常] {wid}: {type(e).__name__}: {e}")
                    result = _STATE_FAIL
                with self._lock:
                    if result == _STATE_DONE:
                        # 收尾时监控线程已停，done 可能停在 nseg-1，这里归位
                        job.update({"state": _STATE_DONE, "pct": 100.0, "speed": 0.0,
                                    "eta": "", "done": job["nseg"], "exists": True})
                    elif result == _STATE_SKIP:
                        job.update({"state": _STATE_SKIP, "pct": 100.0, "speed": 0.0,
                                    "eta": "", "done": job["nseg"], "exists": True})
                    elif result == _STATE_CANCEL:
                        job.update({"state": _STATE_CANCEL, "speed": 0.0, "eta": ""})
                        canceled = True
                    else:
                        job.update({"state": _STATE_FAIL, "speed": 0.0, "eta": ""})
                if canceled:
                    break
            if canceled:
                with self._lock:
                    for j in jobs:
                        if j["state"] in (_STATE_PENDING, _STATE_RUNNING):
                            j["state"] = _STATE_CANCEL
        finally:
            with self._lock:
                self.running = False
                self._finished_at = time.time()
                ok = sum(1 for j in jobs if j["state"] in (_STATE_DONE, _STATE_SKIP))
                bad = sum(1 for j in jobs if j["state"] == _STATE_FAIL)
            self._log("已停止" if canceled else f"全部结束：成功 {ok} 项，失败 {bad} 项")

    def _on_prog(self, wid: str, p: dict):
        with self._lock:
            for j in self._jobs:
                if j["wid"] != wid:
                    continue
                if p.get("pct") is not None:
                    j["pct"] = round(float(p["pct"]), 1)
                j["done"] = int(p.get("done") or 0)
                j["nseg"] = int(p.get("nseg") or j["nseg"] or 1)
                j["speed"] = float(p.get("speed") or 0.0)
                j["eta"] = p.get("eta_txt") or ""
                break

    # ---------- 状态快照 ----------
    def snapshot(self) -> dict:
        with self._lock:
            jobs = [dict(j) for j in self._jobs]
            logs = list(self._logs)[-120:]
            running = self.running
            outdir = self.outdir
            threads = self.threads
            force = self.force
            started = self._started_at
            finished = self._finished_at

        total = len(jobs)
        finished_jobs = [j for j in jobs if j["state"] in (_STATE_DONE, _STATE_SKIP)]
        failed_jobs = [j for j in jobs if j["state"] == _STATE_FAIL]
        # 总体进度：已完成的按 100% 计入
        if total:
            overall = sum(100.0 if j["state"] in (_STATE_DONE, _STATE_SKIP) else float(j["pct"] or 0)
                          for j in jobs) / total
        else:
            overall = 0.0
        speed = sum(j["speed"] for j in jobs if j["state"] == _STATE_RUNNING)
        return {
            "running": running,
            "outdir": outdir,
            "hint": outdir_hint(outdir),
            "threads": threads,
            "force": force,
            "jobs": jobs,
            "logs": logs,
            "summary": {
                "total": total,
                "done": len(finished_jobs),
                "failed": len(failed_jobs),
                "overall_pct": round(overall, 1),
                "speed": speed,
            },
            "started_at": started,
            "finished_at": finished,
        }


_manager: Optional[DownloadManager] = None
_manager_lock = threading.Lock()


def get_manager() -> DownloadManager:
    global _manager
    if _manager is None:
        with _manager_lock:
            if _manager is None:
                _manager = DownloadManager()
    return _manager
