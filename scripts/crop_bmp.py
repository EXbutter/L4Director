import struct, sys

src, dst = sys.argv[1], sys.argv[2]
x0, y0, w, h = (int(v) for v in sys.argv[3:7])

with open(src, "rb") as f:
    data = f.read()

off = struct.unpack_from("<I", data, 10)[0]
hdr = struct.unpack_from("<IiiHH", data, 14)
bw, bh = hdr[1], hdr[2]
row_size = (bw * 3 + 3) & ~3

rows = []
for y in range(h):
    sy = bh - y0 - h + y
    start = off + sy * row_size + x0 * 3
    rows.append(data[start:start + w * 3])

out_row = (w * 3 + 3) & ~3
pixels = bytearray()
for r in rows:
    pixels += r
    pixels += b"\x00" * (out_row - w * 3)

size = 54 + len(pixels)
with open(dst, "wb") as f:
    f.write(b"BM" + struct.pack("<IHHI", size, 0, 0, 54))
    f.write(struct.pack("<IiiHHIIiiII", 40, w, h, 1, 24, 0, len(pixels), 2835, 2835, 0, 0))
    f.write(bytes(pixels))
print("cropped", dst, w, h)
