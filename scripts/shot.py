import ctypes, struct
from ctypes import wintypes
import sys

user32 = ctypes.windll.user32
gdi32 = ctypes.windll.gdi32

def find_window(title_part="L4Director"):
    hwnds = []
    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def enum_proc(hwnd, lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        if length:
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            if title_part in buf.value and user32.IsWindowVisible(hwnd):
                hwnds.append((hwnd, buf.value))
        return True
    user32.EnumWindows(enum_proc, 0)
    return hwnds

wins = find_window()
deadline = 60.0
import time
start = time.time()
while not wins and time.time() - start < deadline:
    time.sleep(0.5)
    wins = find_window()
print(wins)
if not wins:
    sys.exit(1)

hwnd = wins[0][0]
rect = wintypes.RECT()
user32.GetWindowRect(hwnd, ctypes.byref(rect))
w = rect.right - rect.left
h = rect.bottom - rect.top
print(w, h)

hdc = user32.GetWindowDC(hwnd)
mfc = gdi32.CreateCompatibleDC(hdc)
bmp = gdi32.CreateCompatibleBitmap(hdc, w, h)
gdi32.SelectObject(mfc, bmp)

# PW_RENDERFULLCONTENT = 2
ok = user32.PrintWindow(hwnd, mfc, 2)
print("printwindow", ok)

class BITMAPINFOHEADER(ctypes.Structure):
    _fields_ = [
        ("biSize", wintypes.DWORD),
        ("biWidth", wintypes.LONG),
        ("biHeight", wintypes.LONG),
        ("biPlanes", wintypes.WORD),
        ("biBitCount", wintypes.WORD),
        ("biCompression", wintypes.DWORD),
        ("biSizeImage", wintypes.DWORD),
        ("biXPelsPerMeter", wintypes.LONG),
        ("biYPelsPerMeter", wintypes.LONG),
        ("biClrUsed", wintypes.DWORD),
        ("biClrImportant", wintypes.DWORD),
    ]

class BITMAPINFO(ctypes.Structure):
    _fields_ = [("bmiHeader", BITMAPINFOHEADER), ("bmiColors", wintypes.DWORD * 3)]

bi = BITMAPINFO()
bi.bmiHeader.biSize = ctypes.sizeof(BITMAPINFOHEADER)
bi.bmiHeader.biWidth = w
bi.bmiHeader.biHeight = -h
bi.bmiHeader.biPlanes = 1
bi.bmiHeader.biBitCount = 32
bi.bmiHeader.biCompression = 0

buf = ctypes.create_string_buffer(w * h * 4)
gdi32.GetDIBits(mfc, bmp, 0, h, buf, ctypes.byref(bi), 0)

# 逐行翻转（DIB 是自上而下，BMP 文件要求自下而上），并写 24 位 BMP
row_size = w * 3
padded = (row_size + 3) & ~3
pixels = bytearray()
raw = buf.raw
for y in range(h - 1, -1, -1):
    base = y * w * 4
    line = bytearray(row_size)
    for x in range(w):
        p = base + x * 4
        line[x * 3] = raw[p]
        line[x * 3 + 1] = raw[p + 1]
        line[x * 3 + 2] = raw[p + 2]
    pixels += line
    pixels += b"\x00" * (padded - row_size)

out = sys.argv[1] if len(sys.argv) > 1 else "shot.bmp"
if not out.lower().endswith(".bmp"):
    out = out.rsplit(".", 1)[0] + ".bmp"

file_size = 54 + len(pixels)
with open(out, "wb") as f:
    f.write(b"BM" + struct.pack("<IHHI", file_size, 0, 0, 54))
    f.write(struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(pixels), 2835, 2835, 0, 0))
    f.write(bytes(pixels))
print("saved", out)
