import ctypes, sys, time
from ctypes import wintypes

u = ctypes.windll.user32

def find_window(title_part="L4Director"):
    hwnds = []
    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h, l):
        n = u.GetWindowTextLengthW(h)
        if n:
            b = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, b, n + 1)
            if title_part in b.value and u.IsWindowVisible(h):
                hwnds.append(h)
        return True
    u.EnumWindows(cb, 0)
    return hwnds

hwnd = find_window()[0]
rect = wintypes.RECT()
u.GetWindowRect(hwnd, ctypes.byref(rect))
u.SetForegroundWindow(hwnd)
time.sleep(0.4)

x = rect.left + int(sys.argv[1])
y = rect.top + int(sys.argv[2])
u.SetCursorPos(x, y)
time.sleep(0.2)
u.mouse_event(0x0002, 0, 0, 0, 0)
time.sleep(0.05)
u.mouse_event(0x0004, 0, 0, 0, 0)
print("clicked", x, y)
