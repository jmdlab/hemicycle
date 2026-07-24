#!/usr/bin/env python3
"""Prove no text overflows its allotted box -- by rasterising it, not estimating.

    python render_card.py --in p.json --outdir D --debug-json d.json
    python check_overflow.py d.json

For every text node render_card placed, this re-renders that exact string on its
own through cairosvg at its exact family/weight/size/letter-spacing, measures the
real ink extents, resolves the anchor into an ink box, and checks that box
against the column it was allotted. It also checks the vertical zones are
ordered (the legend/footer collision), so a layout regression fails loudly.

Exit code 0 = clean, 1 = at least one overflow or zone inversion.
"""

from __future__ import annotations

import io
import json
import sys

import cairosvg
from PIL import Image

PAD = 400  # slack around the probe so ink is never clipped
TOL = 1.0  # px of tolerance on the allotted box


def ink_extents(text: str, family: str, weight: str, size: float,
                letter_spacing: float) -> tuple[float, float]:
    """Return (left_offset, width) of the painted ink relative to the anchor x."""
    if not text.strip():
        return 0.0, 0.0
    w = int(len(text) * size * 1.6) + 2 * PAD
    h = int(size * 3) + 40
    y = h * 0.7
    ls = f' letter-spacing="{letter_spacing}"' if letter_spacing else ""
    import html as _html
    svg = (f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" '
           f'viewBox="0 0 {w} {h}"><rect width="{w}" height="{h}" fill="black"/>'
           f'<text x="{PAD}" y="{y}" font-family="{_html.escape(family, True)}" '
           f'font-weight="{weight}" font-size="{size}" fill="white"{ls}>'
           f'{_html.escape(text, True)}</text></svg>')
    png = cairosvg.svg2png(bytestring=svg.encode("utf-8"), output_width=w,
                           output_height=h)
    box = Image.open(io.BytesIO(png)).convert("L").getbbox()
    if not box:
        return 0.0, 0.0
    return box[0] - PAD, float(box[2] - box[0])


def main(path: str) -> int:
    with open(path, "r", encoding="utf-8") as fh:
        dbg = json.load(fh)

    failures = []
    worst = []
    for t in dbg["texts"]:
        off, ink_w = ink_extents(t["text"], t["family"], t["weight"], t["size"],
                                 t["letter_spacing"])
        if ink_w == 0:
            continue
        anchor = t["anchor"]
        if anchor == "end":
            x0 = t["x"] - ink_w
        elif anchor == "middle":
            x0 = t["x"] - ink_w / 2
        else:
            x0 = t["x"] + off
        x1 = x0 + ink_w
        b0, b1 = t["box"]
        over_l = b0 - x0
        over_r = x1 - b1
        over = max(over_l, over_r)
        worst.append((over, t["tag"], round(ink_w, 1), round(b1 - b0, 1)))
        if over > TOL:
            failures.append(
                f"  OVERFLOW {t['tag']:22} {t['text']!r} ink={ink_w:.1f}px "
                f"box={b1 - b0:.1f}px over={over:.1f}px")
        # estimator sanity: our PIL prediction must never under-call the ink
        if t["measured"] + TOL < ink_w:
            failures.append(
                f"  UNDER-MEASURED {t['tag']:16} predicted={t['measured']:.1f} "
                f"actual_ink={ink_w:.1f}")

    z = dbg["zones"]
    order = [("legend_base", z["legend_base"]), ("chart_top", z["chart_top"]),
             ("rows_top", z["rows_top"]), ("rows_bottom", z["rows_bottom"]),
             ("chart_bottom", z["chart_bottom"]), ("axis_base", z["axis_base"]),
             ("footer_rule", z["footer_rule"]), ("footer_base", z["footer_base"])]
    for (na, va), (nb, vb) in zip(order, order[1:]):
        if va > vb + 0.01:
            failures.append(f"  ZONE INVERSION {na}={va} > {nb}={vb}")
    if dbg["rowh"] < 16:
        failures.append(f"  ROW TOO SHORT rowh={dbg['rowh']}")
    if dbg["gridlines"] > 8:
        failures.append(f"  TOO MANY GRIDLINES {dbg['gridlines']}")

    worst.sort(reverse=True)
    print(f"{len(dbg['texts'])} text nodes measured through cairo; "
          f"tightest fits (headroom px):")
    for over, tag, ink, box in worst[:5]:
        print(f"    {tag:24} ink={ink:7.1f} box={box:7.1f} headroom={-over:7.1f}")
    if failures:
        print(f"FAIL ({len(failures)}):")
        print("\n".join(failures))
        return 1
    print(f"PASS: no overflow, zones ordered, rowh={dbg['rowh']}, "
          f"gridlines={dbg['gridlines']}, grid_step={dbg['grid_step']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1]))
