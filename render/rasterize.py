#!/usr/bin/env python3
"""
rasterize.py -- derive the raster set from a stored SVG.

The SVG is the canonical artefact (12 KB); PNG and WebP are disposable
derivatives (~880 KB together) produced only when someone actually asks for a
card. That inversion is what lets the whole corpus be pre-generated: ~100 MB of
SVG instead of ~7 GB of raster.

    python rasterize.py --svg PATH [--outdir DIR]

Writes {hash}-card.png, {hash}-share.png and {hash}-preview.webp next to the SVG
(or into --outdir) and prints the same JSON shape render_card.py returns, so the
server can treat both paths identically.
"""
from __future__ import annotations

import argparse
import io
import json
import os
import sys

import theme as T
from render_card import _PNG, _save_png_under


def rasterize(svg_path: str, outdir: str | None = None, force: bool = False) -> dict:
    import cairosvg
    from PIL import Image

    outdir = outdir or os.path.dirname(os.path.abspath(svg_path))
    base = os.path.basename(svg_path)
    if not base.endswith("-card.svg"):
        raise ValueError(f"unexpected svg name: {base}")
    h = base[: -len("-card.svg")]

    names = {"card": f"{h}-card.png", "share": f"{h}-share.png",
             "preview": f"{h}-preview.webp"}
    paths = {k: os.path.join(outdir, v) for k, v in names.items()}

    if force or not all(os.path.exists(p) for p in paths.values()):
        os.makedirs(outdir, exist_ok=True)
        # Rasterise once at master size, then downscale — re-rasterising per
        # size would re-hint text at each scale and drift the three outputs
        # apart.
        png = cairosvg.svg2png(url=svg_path,
                               output_width=T.CARD_W, output_height=T.CARD_H)
        master = Image.open(io.BytesIO(png)).convert("RGB")
        master.save(paths["card"], "PNG", **_PNG)
        share = master.resize((T.SHARE_W, T.SHARE_H), Image.LANCZOS)
        _save_png_under(share, paths["share"], T.SHARE_MAX_BYTES)
        preview = master.resize((T.PREVIEW_W, T.PREVIEW_H), Image.LANCZOS)
        preview.save(paths["preview"], "WEBP", quality=88, method=6)

    return {
        "preview": {"file": names["preview"], "width": T.PREVIEW_W,
                    "height": T.PREVIEW_H, "bytes": os.path.getsize(paths["preview"])},
        "share": {"file": names["share"], "width": T.SHARE_W, "height": T.SHARE_H,
                  "bytes": os.path.getsize(paths["share"])},
        "card": {"file": names["card"], "width": T.CARD_W, "height": T.CARD_H,
                 "bytes": os.path.getsize(paths["card"])},
        "svg": {"file": base, "bytes": os.path.getsize(svg_path)},
        "templateVersion": T.TEMPLATE_VERSION,
    }


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Derive rasters from a stored SVG")
    ap.add_argument("--svg", required=True)
    ap.add_argument("--outdir")
    ap.add_argument("--force", action="store_true")
    args = ap.parse_args(argv)
    try:
        print(json.dumps(rasterize(args.svg, args.outdir, args.force), ensure_ascii=False))
        return 0
    except Exception as exc:  # noqa: BLE001 - contract is a JSON error on stdout
        print(json.dumps({"error": f"{type(exc).__name__}: {exc}"}, ensure_ascii=False))
        return 1


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    raise SystemExit(main())
