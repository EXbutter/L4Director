"""UI 操作小工具：把窗口拉到前台并点击/滚动，坐标按窗口客户区像素给。

用法：
    python ui.py click 1364 100        # 点击窗口内 (x, y)
    python ui.py move 1364 100         # 只移动鼠标（看 hover 效果）
    python ui.py scroll 800 500 -300   # 在窗口内 (x, y) 处滚轮滚动，负数为向下
"""
import ctypes
import sys
import time
from ctypes import wintypes

u = ctypes.windll.user32
k = ctypes.windll.kernel32


def find_window(title="L4Director"):
    found = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def cb(h, _l):
        n = u.GetWindowTextLengthW(h)
        if n:
            b = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(h, b, n + 1)
            if title in b.value and u.IsWindowVisible(h):
                found.append(h)
        return True

    u.EnumWindows(cb, 0)
    return found[0]


def activate(hwnd):
    """强行把窗口弄到前台：SetForegroundWindow 在非前台进程里常被系统忽略，
    所以先 AttachThreadInput 到当前前台线程，再 SetForegroundWindow。"""
    if u.IsIconic(hwnd):
        u.ShowWindow(hwnd, 9)  # SW_RESTORE
        time.sleep(0.3)

    fg = u.GetForegroundWindow()
    if fg == hwnd:
        return True

    fg_tid = u.GetWindowThreadProcessId(fg, None) if fg else 0
    my_tid = k.GetCurrentThreadId()
    attached = False
    if fg_tid and fg_tid != my_tid:
        attached = bool(u.AttachThreadInput(my_tid, fg_tid, True))

    u.BringWindowToTop(hwnd)
    u.SetForegroundWindow(hwnd)
    u.SetFocus(hwnd)

    if attached:
        u.AttachThreadInput(my_tid, fg_tid, False)

    time.sleep(0.4)
    return u.GetForegroundWindow() == hwnd


def to_screen(hwnd, x, y):
    rect = wintypes.RECT()
    u.GetWindowRect(hwnd, ctypes.byref(rect))
    return rect.left + int(x), rect.top + int(y)


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else "click"
    hwnd = find_window()
    ok = activate(hwnd)
    print("foreground:", ok)

    if cmd == "click":
        x, y = to_screen(hwnd, sys.argv[2], sys.argv[3])
        u.SetCursorPos(x, y)
        time.sleep(0.15)
        u.mouse_event(0x0002, 0, 0, 0, 0)  # LEFTDOWN
        time.sleep(0.06)
        u.mouse_event(0x0004, 0, 0, 0, 0)  # LEFTUP
        print("clicked", x, y)
    elif cmd == "move":
        x, y = to_screen(hwnd, sys.argv[2], sys.argv[3])
        u.SetCursorPos(x, y)
        print("moved", x, y)
    elif cmd == "scroll":
        x, y = to_screen(hwnd, sys.argv[2], sys.argv[3])
        u.SetCursorPos(x, y)
        delta = int(sys.argv[4])
        steps = max(1, abs(delta) // 120)
        sign = -120 if delta < 0 else 120
        for _ in range(steps):
            u.mouse_event(0x0800, 0, 0, sign, 0)
            time.sleep(0.04)
        print("scrolled", delta)
    else:
        print("unknown command", cmd)


main()
