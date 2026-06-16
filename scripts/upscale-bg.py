#!/usr/bin/env python3
"""Upscale 4x via real-ESRGAN ncnn (remacri-4x) + downscale 2x via Pillow LANCZOS.

Pipeline igual ao handy-andy/upscale.py: gera primeiro em 4x, depois reduz a 2x. O ciclo
SR-then-shrink reforça bordas e geometria (especialmente bom pro low-poly).

Source: src/renderer/src/assets/bg/<tema>/<n>.png (1536×1024 do gen-bg.py)
Output: sobrescreve o arquivo no mesmo path em 3072×2048

Reusa o binário do handy-andy via ../handy-andy/tools/realesrgan-ncnn-vulkan-v0.2.0-macos.

Uso:
    python scripts/upscale-bg.py                 # processa todos
    python scripts/upscale-bg.py floresta        # só um tema
"""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

ESRGAN_DIR = ROOT.parent / "handy-andy" / "tools" / "realesrgan-ncnn-vulkan-v0.2.0-macos"
ESRGAN_BIN = ESRGAN_DIR / "realesrgan-ncnn-vulkan"
MODELS = ESRGAN_DIR / "models"
MODEL_NAME = "remacri-4x"

BG_DIR = ROOT / "src/renderer/src/assets/bg"
THEMES = ["abissal", "floresta", "cerrado", "lava", "geleira"]


def upscale(path: Path) -> None:
    print(f"→ {path.relative_to(ROOT)}")
    with tempfile.TemporaryDirectory() as tmp:
        big = Path(tmp) / "4x.png"
        subprocess.run(
            [
                str(ESRGAN_BIN),
                "-i", str(path),
                "-o", str(big),
                "-n", MODEL_NAME,
                "-s", "4",
                "-m", str(MODELS),
            ],
            check=True,
            capture_output=True,
        )
        with Image.open(big) as im:
            target = (im.width // 2, im.height // 2)
            im2 = im.resize(target, Image.LANCZOS)
            im2.save(path, optimize=True)
    kb = path.stat().st_size // 1024
    print(f"✓ {path.relative_to(ROOT)} ({kb} KB, {im2.width}×{im2.height})")


def main() -> None:
    if not ESRGAN_BIN.exists():
        sys.exit(f"real-ESRGAN não encontrado: {ESRGAN_BIN}\nVerifica se ../handy-andy/tools/ existe.")

    only = sys.argv[1] if len(sys.argv) > 1 else None
    if only and only not in THEMES:
        sys.exit(f"Tema desconhecido: {only}")

    for theme in THEMES:
        if only and theme != only:
            continue
        theme_dir = BG_DIR / theme
        if not theme_dir.exists():
            print(f"skip {theme}/ (não existe — roda gen-bg.py primeiro)")
            continue
        for png in sorted(theme_dir.glob("*.png")):
            upscale(png)


if __name__ == "__main__":
    main()
