"""Quick speed test for mod scanner."""
import time
from services.mod_scanner import ModScanner

s = ModScanner()
s.auto_detect_addons_path()

t = time.time()
m1 = s.scan_mods()
print(f'[TIME] First scan: {time.time()-t:.2f}s, {len(m1)} mods')

t = time.time()
m2 = s.scan_mods()
print(f'[TIME] Second scan: {time.time()-t:.2f}s (cached)')
