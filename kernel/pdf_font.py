"""A TrueType font for the PDF writer, so Greek, Cyrillic, Vietnamese and symbols survive.

The built-in PDF fonts hold Latin-1 only. When a document needs more, the writer embeds one TrueType font from
the owner's PC (Windows ships Arial and Segoe UI; Linux usually has DejaVu) as a composite font with 2-byte
glyph ids. This module reads just enough of the font file with ``struct``: the character map, the advance
widths and the glyph count. No font library is needed.

Not covered, on purpose: scripts that need shaping (Devanagari and the other Indic scripts, Arabic, Thai,
Burmese). Drawing those character by character puts vowel signs and joined letters in the wrong places, which
is worse than saying so. ``needs_shaping`` finds them so the writer can keep its honest ``?`` and warning.
"""

from __future__ import annotations

import os
import struct
import zlib
from dataclasses import dataclass
from pathlib import Path

_SHAPED = ((0x0600, 0x06FF), (0x0750, 0x077F), (0x0900, 0x0DFF), (0x0E00, 0x0E7F), (0x1000, 0x109F))


def needs_shaping(ch: str) -> bool:
    code = ord(ch)
    return any(low <= code <= high for low, high in _SHAPED)


def candidates() -> list[Path]:
    names = ("arial.ttf", "segoeui.ttf", "calibri.ttf", "DejaVuSans.ttf", "LiberationSans-Regular.ttf")
    roots = [
        Path(os.environ.get("FRIDAY_PDF_FONT", "")) if os.environ.get("FRIDAY_PDF_FONT") else None,
        Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts",
        Path("/usr/share/fonts/truetype/dejavu"),
        Path("/usr/share/fonts/truetype/liberation"),
        Path("/usr/share/fonts/TTF"),
    ]
    found: list[Path] = []
    for root in roots:
        if root is None:
            continue
        if root.is_file():
            found.append(root)
        else:
            found += [root / name for name in names if (root / name).is_file()]
    return found


@dataclass
class Font:
    data: bytes
    units: int
    glyphs: int
    cmap: dict[int, int]
    advances: list[int]
    ascent: int
    descent: int
    name: str

    def gid(self, ch: str) -> int:
        return self.cmap.get(ord(ch), 0)

    def width(self, gid: int) -> int:
        if not self.advances:
            return 0
        return self.advances[gid if gid < len(self.advances) else len(self.advances) - 1]


def _tables(data: bytes) -> dict[str, tuple[int, int]]:
    if data[:4] not in (b"\x00\x01\x00\x00", b"true"):
        raise ValueError("not a TrueType font (OpenType/CFF and collections are not read)")
    count = struct.unpack(">H", data[4:6])[0]
    out: dict[str, tuple[int, int]] = {}
    for i in range(count):
        tag, _, offset, length = struct.unpack(">4sIII", data[12 + 16 * i : 28 + 16 * i])
        out[tag.decode("latin-1")] = (offset, length)
    return out


def _cmap(data: bytes, offset: int) -> dict[int, int]:
    count = struct.unpack(">H", data[offset + 2 : offset + 4])[0]
    best: tuple[int, int] | None = None
    for i in range(count):
        platform, encoding, sub = struct.unpack(">HHI", data[offset + 4 + 8 * i : offset + 12 + 8 * i])
        rank = {(3, 10): 3, (0, 4): 3, (3, 1): 2, (0, 3): 2}.get((platform, encoding), 0)
        if rank and (best is None or rank > best[0]):
            best = (rank, offset + sub)
    if best is None:
        raise ValueError("the font has no Unicode character map")
    start = best[1]
    fmt = struct.unpack(">H", data[start : start + 2])[0]
    mapping: dict[int, int] = {}
    if fmt == 4:
        segs = struct.unpack(">H", data[start + 6 : start + 8])[0] // 2
        ends = struct.unpack(f">{segs}H", data[start + 14 : start + 14 + 2 * segs])
        base = start + 16 + 2 * segs
        starts = struct.unpack(f">{segs}H", data[base : base + 2 * segs])
        deltas = struct.unpack(f">{segs}h", data[base + 2 * segs : base + 4 * segs])
        range_at = base + 4 * segs
        ranges = struct.unpack(f">{segs}H", data[range_at : range_at + 2 * segs])
        for i in range(segs):
            for code in range(starts[i], ends[i] + 1):
                if code == 0xFFFF:
                    continue
                if ranges[i] == 0:
                    gid = (code + deltas[i]) & 0xFFFF
                else:
                    at = range_at + 2 * i + ranges[i] + 2 * (code - starts[i])
                    gid = struct.unpack(">H", data[at : at + 2])[0]
                    if gid:
                        gid = (gid + deltas[i]) & 0xFFFF
                if gid:
                    mapping[code] = gid
    elif fmt == 12:
        groups = struct.unpack(">I", data[start + 12 : start + 16])[0]
        for i in range(groups):
            low, high, gid = struct.unpack(">III", data[start + 16 + 12 * i : start + 28 + 12 * i])
            for code in range(low, high + 1):
                mapping[code] = gid + code - low
    else:
        raise ValueError(f"character map format {fmt} is not read")
    return mapping


def load(path: Path) -> Font:
    data = path.read_bytes()
    tables = _tables(data)
    for needed in ("head", "hhea", "hmtx", "maxp", "cmap", "glyf"):
        if needed not in tables:
            raise ValueError(f"the font has no {needed} table")
    head, hhea, maxp = tables["head"][0], tables["hhea"][0], tables["maxp"][0]
    units = struct.unpack(">H", data[head + 18 : head + 20])[0] or 1000
    ascent, descent = struct.unpack(">hh", data[hhea + 4 : hhea + 8])
    metrics = struct.unpack(">H", data[hhea + 34 : hhea + 36])[0]
    glyphs = struct.unpack(">H", data[maxp + 4 : maxp + 6])[0]
    hmtx = tables["hmtx"][0]
    advances = [struct.unpack(">H", data[hmtx + 4 * i : hmtx + 4 * i + 2])[0] for i in range(metrics)]
    return Font(data, units, glyphs, _cmap(data, tables["cmap"][0]), advances, ascent, descent, path.stem)


def first_usable() -> Font | None:
    for path in candidates():
        try:
            return load(path)
        except (ValueError, OSError, struct.error):
            continue
    return None


def pdf_objects(font: Font, used: dict[int, str], add) -> int:
    """Append the font objects through ``add(body_bytes) -> object number`` and return the Type0 font number."""
    compressed = zlib.compress(font.data, 6)
    file_no = add(
        b"<< /Length "
        + str(len(compressed)).encode()
        + b" /Length1 "
        + str(len(font.data)).encode()
        + b" /Filter /FlateDecode >>\nstream\n"
        + compressed
        + b"\nendstream"
    )
    scale = 1000 / font.units
    descriptor = add(
        f"<< /Type /FontDescriptor /FontName /{font.name} /Flags 4 /FontBBox [-200 -300 1200 1000] "
        f"/ItalicAngle 0 /Ascent {round(font.ascent * scale)} /Descent {round(font.descent * scale)} "
        f"/CapHeight {round(font.ascent * scale)} /StemV 80 /FontFile2 {file_no} 0 R >>".encode()
    )
    widths = " ".join(f"{gid} [{round(font.width(gid) * scale)}]" for gid in sorted(used))
    cid = add(
        f"<< /Type /Font /Subtype /CIDFontType2 /BaseFont /{font.name} /CIDSystemInfo << /Registry (Adobe) "
        f"/Ordering (Identity) /Supplement 0 >> /FontDescriptor {descriptor} 0 R /CIDToGIDMap /Identity "
        f"/DW 600 /W [{widths}] >>".encode()
    )
    entries = "\n".join(
        f"<{gid:04X}> <{''.join(f'{u:04X}' for u in _utf16(char))}>" for gid, char in sorted(used.items())
    )
    cmap_text = (
        "/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /Adobe-Identity-UCS def "
        "/CMapType 2 def 1 begincodespacerange <0000> <FFFF> endcodespacerange "
        f"{len(used)} beginbfchar\n{entries}\nendbfchar endcmap CMapName currentdict /CMap defineresource pop end end"
    ).encode()
    to_unicode = add(b"<< /Length " + str(len(cmap_text)).encode() + b" >>\nstream\n" + cmap_text + b"\nendstream")
    return add(
        f"<< /Type /Font /Subtype /Type0 /BaseFont /{font.name} /Encoding /Identity-H "
        f"/DescendantFonts [{cid} 0 R] /ToUnicode {to_unicode} 0 R >>".encode()
    )


def _utf16(char: str) -> list[int]:
    raw = char.encode("utf-16-be")
    return [int.from_bytes(raw[i : i + 2], "big") for i in range(0, len(raw), 2)]
