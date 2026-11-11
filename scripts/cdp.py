"""最小 CDP 客户端：通过 WebSocket 在渲染进程里执行 JS。

用法：
    python scripts/cdp.py "<js 表达式>"
    python scripts/cdp.py --file expr.js
"""
import base64
import json
import os
import socket
import struct
import sys
import urllib.request

HOST = '127.0.0.1'
PORT = 9222


def get_ws_url() -> str:
    raw = urllib.request.urlopen(f'http://{HOST}:{PORT}/json/list', timeout=5).read()
    for t in json.loads(raw):
        if t.get('type') == 'page' and t.get('webSocketDebuggerUrl'):
            return t['webSocketDebuggerUrl']
    raise RuntimeError('没有可用的 page 目标')


def handshake(url: str):
    rest = url.split('://', 1)[1]
    hostport, path = rest.split('/', 1)
    host, port = hostport.split(':')
    s = socket.create_connection((host, int(port)), timeout=15)
    key = base64.b64encode(os.urandom(16)).decode()
    req = (
        f'GET /{path} HTTP/1.1\r\n'
        f'Host: {host}:{port}\r\n'
        'Upgrade: websocket\r\nConnection: Upgrade\r\n'
        f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n'
    )
    s.sendall(req.encode())
    buf = b''
    while b'\r\n\r\n' not in buf:
        buf += s.recv(4096)
    if b'101' not in buf.split(b'\r\n', 1)[0]:
        raise RuntimeError('握手失败: ' + buf[:200].decode('latin-1'))
    return s


def send_text(s, text: str):
    payload = text.encode('utf-8')
    header = bytearray([0x81])
    n = len(payload)
    if n < 126:
        header.append(0x80 | n)
    elif n < 65536:
        header.append(0x80 | 126)
        header += struct.pack('>H', n)
    else:
        header.append(0x80 | 127)
        header += struct.pack('>Q', n)
    mask = os.urandom(4)
    header += mask
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    s.sendall(bytes(header) + masked)


def _read_exact(s, n):
    out = b''
    while len(out) < n:
        chunk = s.recv(n - len(out))
        if not chunk:
            raise RuntimeError('连接已关闭')
        out += chunk
    return out


def recv_text(s) -> str:
    while True:
        b0, b1 = _read_exact(s, 2)
        opcode = b0 & 0x0F
        masked = b1 & 0x80
        n = b1 & 0x7F
        if n == 126:
            n = struct.unpack('>H', _read_exact(s, 2))[0]
        elif n == 127:
            n = struct.unpack('>Q', _read_exact(s, 8))[0]
        mask = _read_exact(s, 4) if masked else b''
        chunk = _read_exact(s, n) if n else b''
        if mask:
            chunk = bytes(b ^ mask[i % 4] for i, b in enumerate(chunk))
        if opcode == 0x8:
            raise RuntimeError('收到 close 帧')
        if opcode in (0x1, 0x2):
            return chunk.decode('utf-8', 'replace')


def evaluate(expr: str, timeout: float = 15.0):
    s = handshake(get_ws_url())
    s.settimeout(timeout)
    send_text(s, json.dumps({
        'id': 1, 'method': 'Runtime.evaluate',
        'params': {'expression': expr, 'returnByValue': True, 'awaitPromise': True},
    }))
    try:
        while True:
            msg = json.loads(recv_text(s))
            if msg.get('id') == 1:
                return msg
    finally:
        try:
            s.close()
        except Exception:
            pass


def call(method: str, params: dict, timeout: float = 20.0):
    s = handshake(get_ws_url())
    s.settimeout(timeout)
    send_text(s, json.dumps({'id': 1, 'method': method, 'params': params}))
    try:
        while True:
            msg = json.loads(recv_text(s))
            if msg.get('id') == 1:
                return msg
    finally:
        try:
            s.close()
        except Exception:
            pass


def screenshot(out_path: str, clip: tuple[float, float, float, float] | None = None,
               scale: float = 1.0):
    params = {'format': 'png'}
    if clip:
        x, y, w, h = clip
        params['clip'] = {'x': x, 'y': y, 'width': w, 'height': h, 'scale': scale}
    res = call('Page.captureScreenshot', params)
    data = res.get('result', {}).get('data')
    if not data:
        print('截图失败:', json.dumps(res, ensure_ascii=False)[:400])
        return 1
    with open(out_path, 'wb') as f:
        f.write(base64.b64decode(data))
    print('saved', out_path)
    return 0


def main():
    if len(sys.argv) < 2:
        print('用法: cdp.py "<js>" | --file <path> | --shot <out.png> [x y w h] [scale]')
        return 2
    if sys.argv[1] == '--file':
        expr = open(sys.argv[2], encoding='utf-8').read()
    elif sys.argv[1] == '--shot':
        out = sys.argv[2]
        clip = None
        scale = 1.0
        if len(sys.argv) >= 7:
            clip = tuple(float(v) for v in sys.argv[3:7])
            if len(sys.argv) >= 8:
                scale = float(sys.argv[7])
        return screenshot(out, clip, scale)
    else:
        expr = sys.argv[1]

    res = evaluate(expr)
    r = res.get('result', {})
    if 'exceptionDetails' in r:
        print('EXCEPTION:', json.dumps(r['exceptionDetails'], ensure_ascii=False)[:800])
        return 1
    val = r.get('result', {}).get('value')
    if isinstance(val, (dict, list)):
        print(json.dumps(val, ensure_ascii=False, indent=2))
    else:
        print(val)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
