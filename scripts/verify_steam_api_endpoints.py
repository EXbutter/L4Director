# -*- coding: utf-8 -*-
"""验证：多端点 Steam API（国内优先）+ 失败提示 + 缺失补查。

不依赖外网也能跑的部分用 monkeypatch 造；真联网只做一次冒烟。
"""
import sys, time, types, urllib.error

sys.path.insert(0, r"G:\Work\L4D2 Manager\backend")
from services import workshop_downloader as wd

ok = 0
fail = []


def check(name, cond, extra=""):
    global ok
    if cond:
        ok += 1
        print(f"[PASS] {name}")
    else:
        fail.append(name)
        print(f"[FAIL] {name} {extra}")


print("== 1. 端点配置 ==")
check("国内端点排第一", wd.API_ENDPOINTS[0] == "api.steamchina.com", wd.API_ENDPOINTS)
check("国际端点仍保留", wd.API_HOST in wd.API_ENDPOINTS)
check("总预算大于单次读超时", wd.API_TOTAL_BUDGET >= wd.API_READ_TIMEOUT)

print("\n== 2. _endpoint_order 记忆上次成功 ==")
wd._LAST_OK.update(host="api.steampowered.com", at=time.time())
order = wd._endpoint_order()
check("上次成功的被提到最前", order[0] == "api.steampowered.com", order)
wd._LAST_OK.update(host="api.steamed.com", at=time.time())
check("不认识的 host 不影响顺序",
      wd._endpoint_order() == list(wd.API_ENDPOINTS))
wd._LAST_OK.update(host="api.steamchina.com", at=time.time() - 10_000)
check("过期记忆不再优先", wd._endpoint_order() == list(wd.API_ENDPOINTS))
wd._LAST_OK.update(host="", at=0.0)

print("\n== 3. 国内端点必须禁代理 ==")
seen = {}


class FakeResp:
    def __init__(self, payload):
        self._p = payload

    def read(self):
        return self._p

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_build_opener(*handlers):
    seen["handlers"] = handlers
    seen["built"] = True

    def open(req, data=None, timeout=None):
        seen["timeout"] = timeout
        seen["url"] = req.full_url if hasattr(req, "full_url") else req
        return FakeResp(b'{"response":{"publishedfiledetails":[]}}')

    return types.SimpleNamespace(open=open)


orig_build = wd.urllib.request.build_opener
wd.urllib.request.build_opener = fake_build_opener
try:
    wd._post_via_system(b"x", 5.0, host="api.steamchina.com", no_proxy=True)
    check("no_proxy 时注入空 ProxyHandler",
          bool(seen.get("handlers")) and isinstance(seen["handlers"][0], wd.urllib.request.ProxyHandler))
    check("URL 指向 steamchina", "api.steamchina.com" in seen.get("url", ""), seen.get("url"))
    seen.clear()
    wd._post_via_system(b"x", 5.0, host="api.steampowered.com")
    check("默认不加 ProxyHandler（吃系统代理）", not seen.get("handlers"))
finally:
    wd.urllib.request.build_opener = orig_build

print("\n== 4. 主端点失败后自动降级 ==")
calls = []
orig_host = wd._post_host


def stub(host, body, timeout, deadline):
    calls.append(host)
    if host == "api.steamchina.com":
        raise wd._EndpointError(host, ["直连：TimeoutError 模拟"])
    return {"response": {"publishedfiledetails": [
        {"publishedfileid": "1", "result": 1, "title": "国际站兜底"}]}}


wd._post_host = stub
try:
    wd._LAST_OK.update(host="", at=0.0)
    data = wd._api_post({"itemcount": "1", "publishedfileids[0]": "1"})
    check("先试国内", calls[0] == "api.steamchina.com", calls)
    check("国内挂了会试国际", "api.steampowered.com" in calls, calls)
    check("返回国际站数据",
          data["response"]["publishedfiledetails"][0]["title"] == "国际站兜底")
    check("成功端点被记忆", wd._LAST_OK["host"] == "api.steampowered.com", wd._LAST_OK)

    print("\n== 5. 两条线全挂 → ResolveError + 提示可执行 ==")
    calls.clear()

    def stub_all_fail(host, body, timeout, deadline):
        calls.append(host)
        raise wd._EndpointError(host, [f"{host}：TimeoutError 模拟"])

    wd._post_host = stub_all_fail
    t0 = time.time()
    try:
        wd._api_post({"itemcount": "0"})
        check("全挂应抛 ResolveError", False)
    except wd.ResolveError as e:
        msg = str(e)
        check("两条线都试过", len(set(calls)) == 2, calls)
        check("提示提到国内/国际或蒸汽平台",
              ("蒸汽平台" in msg) or ("国内" in msg) or ("两条线" in msg), msg[:80])
        check("提示给出可执行动作", ("浏览器" in msg) or ("hosts" in msg) or ("DNS" in msg), msg[:80])
    check("失败后不再优先旧端点", wd._LAST_OK["host"] == "", wd._LAST_OK)
    check("失败耗时受预算约束", time.time() - t0 < wd.API_TOTAL_BUDGET + 2,
          f"{time.time()-t0:.1f}s")
finally:
    wd._post_host = orig_host

print("\n== 6. 缺失条目换端点补查 ==")
orig_api = wd._api_post
seq = []


def fake_api(payload, timeout=wd.API_READ_TIMEOUT, skip_host=None):
    n = payload["itemcount"]
    ids = []
    i = 0
    while f"publishedfileids[{i}]" in payload:
        ids.append(payload[f"publishedfileids[{i}]"])
        i += 1
    seq.append((ids, skip_host))
    if len(seq) == 1:
        # 第一次只认识第一个 ID，另一个用 result=9 表示查不到
        return {"response": {"publishedfiledetails": [
            {"publishedfileid": ids[0], "result": 1, "title": "主端点"},
            {"publishedfileid": ids[1], "result": 9},
        ]}}
    return {"response": {"publishedfiledetails": [
        {"publishedfileid": x, "result": 1, "title": "补查"} for x in ids]}}


wd._api_post = fake_api
try:
    res = wd.fetch_details(["111", "222"])
    check("两次请求", len(seq) == 2, seq)
    check("补查只带缺失的 ID", seq[1][0] == ["222"], seq)
    check("两次结果合并", {r["title"] for r in res} == {"主端点", "补查"}, res)
    check("result!=1 的不返回", all(r["result"] == 1 for r in res))
finally:
    wd._api_post = orig_api

print("\n== 7. 补查失败不影响主结果 ==")
orig_api = wd._api_post
seq2 = []


def fake_api2(payload, timeout=wd.API_READ_TIMEOUT, skip_host=None):
    seq2.append(payload["itemcount"])
    if len(seq2) > 1:
        raise wd.ResolveError("模拟补查失败")
    return {"response": {"publishedfiledetails": [
        {"publishedfileid": "111", "result": 1, "title": "主端点"}]}}


wd._api_post = fake_api2
try:
    res = wd.fetch_details(["111", "222"])
    check("补查失败仍返回已拿到的", len(res) == 1 and res[0]["title"] == "主端点", res)
finally:
    wd._api_post = orig_api

print("\n== 8. 真联网冒烟（优先国内端点）==")
wd._LAST_OK.update(host="", at=0.0)
t0 = time.time()
try:
    items = wd.fetch_details(["3558049615"])
    dt = time.time() - t0
    check("查到 1 条", len(items) == 1, items)
    check("耗时 < 5s", dt < 5.0, f"{dt:.2f}s")
    if items:
        it = items[0]
        print(f"     title={it.get('title')!r} file={it.get('filename')!r} "
              f"size={it.get('file_size')} updated={it.get('time_updated')}")
        check("拿到 hcontent_file", bool(it.get("hcontent_file")))
        check("用的是国内端点", wd._LAST_OK["host"] == "api.steamchina.com", wd._LAST_OK)
except Exception as e:
    print(f"  SKIP 联网冒烟（{type(e).__name__}: {e}）")

print(f"\n结果：{ok} 通过，{len(fail)} 失败")
if fail:
    print("失败项：", fail)
    sys.exit(1)
