#!/usr/bin/env python3
"""Gera backgrounds low-poly geométricos por tema via gpt-image-1.

5 imagens por tema × 5 temas = 25 PNGs em 1536×1024.
Saída em src/renderer/src/assets/bg/<tema>/<n>.png. Idempotente: pula arquivos já existentes.

Uso:
    python scripts/gen-bg.py                # gera todos os temas (5 cada)
    python scripts/gen-bg.py floresta       # gera só um tema (5)
    python scripts/gen-bg.py --count 1      # 1 imagem por tema (smoke test)
    python scripts/gen-bg.py --force        # regenera mesmo se existir
"""
from __future__ import annotations

import base64
import sys
from pathlib import Path

from dotenv import dotenv_values
from openai import OpenAI

ROOT = Path(__file__).resolve().parent.parent
ENV = dotenv_values(ROOT / ".env")
API_KEY = ENV.get("OPENAPI_KEY") or ENV.get("OPENAI_API_KEY")
if not API_KEY:
    sys.exit("Falta OPENAPI_KEY ou OPENAI_API_KEY no .env")

client = OpenAI(api_key=API_KEY)

# Estilo comum a todos os prompts. Apendado no final pra reforçar consistência visual.
STYLE_SUFFIX = (
    " Low-poly geometric illustration style, faceted polygons, flat colors. "
    "Wide cinematic landscape, 3:2 aspect ratio. Limited palette, minimal composition "
    "with generous negative space. No people, no text, no UI elements, no borders, no watermark."
)

# 5 cenas distintas dentro de cada bioma — não variações de luz/composição, mas SUBJECTS
# diferentes (ângulo, foco, elemento principal) pra cada workspace ver algo notavelmente
# diferente do vizinho. Mantém paleta + estilo coesos via STYLE_SUFFIX.
SCENES: dict[str, list[str]] = {
    "abissal": [
        # 0 — sub iluminado, claro PORÉM teal/azul saturado (rev3: clarear sem lavar a cor)
        "Sunlit underwater sea scene with a low-poly whale gliding through clear water, "
        "diagonal sunbeams from above. Rich saturated turquoise and teal water graduating "
        "to deeper blue at the edges. Brighter than a dark abyss but clearly an oceanic "
        "teal-and-blue palette, vivid aqua and teal dominant. Not pale, not washed out, "
        "no sandy cream, no white sky.",
        # 1 — coral reef colorido
        "Underwater coral reef colony, faceted brain corals and fan corals in bluish-"
        "purple and muted teal. A small school of glowing fish drifting through. "
        "Mid-distance vantage. Cool palette with bioluminescent accents.",
        # 2 — kelp forest vertical
        "Underwater kelp forest with tall vertical faceted kelp fronds rising from "
        "the depths. Sunlight beams cutting diagonally through. Dim teal and emerald "
        "palette, vertical composition.",
        # 3 — superfície vista de baixo
        "Ocean seen from below the surface, looking up at faceted geometric waves and "
        "a sun disk above. Sun rays piercing the water column. Bright cyan center "
        "fading to deep navy edges.",
        # 4 — águas-vivas bioluminescentes (cool palette only)
        "A drift of faceted bioluminescent jellyfish floating at different depths in "
        "dark navy water. Glowing pale cyan and white tentacles trailing below faceted "
        "bell shapes. Strictly cool palette: deep blue, navy, cyan, white accents. "
        "No warm tones, no orange, no red.",
    ],
    "floresta": [
        # 0 — aprovado v1: pinheiros + luz dourada
        "Dense pine forest with faceted triangular evergreen trees in emerald and sage. "
        "Warm golden light filtering between the trunks from the center. Limited green "
        "palette.",
        # 1 — selva tropical, folhagem
        "Tropical jungle seen from below, large faceted broad leaves filling the frame "
        "in the foreground. Bright greens and yellow highlights where canopy gaps let "
        "light through. Lush dense composition.",
        # 2 — riacho na mata
        "Forest stream cutting through mossy faceted rocks, water in stylized geometric "
        "ripples. Mid-distance vantage with trees on both banks. Mix of forest greens, "
        "gray rocks, soft blue water.",
        # 3 — montanha enevoada
        "Misty mountain forest with layered ridge silhouettes receding into fog. Cool "
        "blue-grays mixed with deep greens. Tranquil atmospheric perspective, low "
        "saturation.",
        # 4 — sequoias / floresta de troncos altos (verde dominante)
        "Massive redwood/sequoia trunks rising vertically from a mossy faceted forest "
        "floor. Deep emerald and forest green palette throughout, soft shafts of pale "
        "warm light filtering between trunks. Strictly green-dominant.",
    ],
    "cerrado": [
        # 0 — aprovado v1: acácias na savana dourada
        "Brazilian cerrado savanna at golden hour with scattered low faceted acacia "
        "trees on rolling polygonal grassland. Distant flat-topped plateau silhouettes. "
        "Ochre, amber, and dry gold palette.",
        # 1 — chapada de arenito vermelho
        "Cerrado chapada at sunset, red sandstone cliffs and table mountains facing "
        "the viewer. Dry low vegetation in foreground. Warm crimson-ochre palette with "
        "deep shadow.",
        # 2 — ipê florido na colina
        "Single iconic ipê tree with faceted pink and yellow blossoms on a low hill, "
        "sparse savanna around. Cool morning palette of soft pinks and pale gold, "
        "calm mood.",
        # 3 — savana ao crepúsculo, fogo distante
        "Cerrado at twilight, purple and pink sky over silhouetted faceted grass. Low "
        "orange glow of distant fire on the horizon. Mood: dusk transition, cool above, "
        "warm below.",
        # 4 — afloramento rochoso com cactos
        "Rocky outcrop with faceted cacti and dry low vegetation in a cerrado landscape. "
        "Sienna and amber palette. Vultures as small geometric silhouettes circling "
        "overhead in clear sky.",
    ],
    "lava": [
        # 0 — aprovado v1: vulcão + rio de lava
        "Erupting volcano in the background with a glowing orange lava river winding "
        "toward the viewer through dark polygonal terrain. Smoke plume rising. Dramatic "
        "red-orange and obsidian black palette.",
        # 1 — vulcão em erupção, claro PORÉM com lava forte (rev3: clarear sem perder o tema)
        "Active volcano erupting in warm daylight, bright glowing orange-red lava flowing "
        "down its slopes toward the viewer. Warm hazy amber sky brighter than night, lit "
        "volcanic terrain in warm rust and ember tones. Vivid molten lava is the clear "
        "focal point. Lighter and warmer than a dark night scene but unmistakably "
        "volcanic — strong orange and red palette, glowing lava prominent. Not pale, not "
        "a sandy desert.",
        # 2 — planície com rios de lava, clara mas quente (rev3: clarear sem perder o tema)
        "Volcanic plain criss-crossed by bright glowing orange lava rivers and molten "
        "cracks, warm golden-hour light. Faceted warm rust and dark-terracotta rock "
        "between channels of vivid incandescent lava. Warm amber sky glow above. Lighter "
        "and warmer than a dark night scene, lava clearly the focal element. Rich orange, "
        "red and ember palette. Not pale, not a sandy desert.",
        # 3 — tubo de lava (caverna)
        "Lava tube cave interior with a glowing magma channel running through. Faceted "
        "stalactites hanging from the roof. Enclosed scene, intense orange light "
        "against black rock.",
        # 4 — colunas de basalto com lava, clara mas avermelhada (rev3: clarear sem perder o tema)
        "Field of faceted hexagonal basalt columns seen at an angle, bright incandescent "
        "orange lava glowing in the cracks between them, warm reddish daylight. Rock in "
        "warm terracotta, brick-red and rust tones, vivid molten lava seams running "
        "across the frame as the focal element. Lighter and warmer than a dark night "
        "scene but clearly volcanic, reddish-orange palette throughout. Not pale, not a "
        "sandy desert, no blue sky.",
    ],
    "geleira": [
        # 0 — aprovado v1: icebergs em água espelho
        "Faceted icebergs floating in calm pale water with mountain silhouettes in the "
        "distance. Soft pink and pale blue sky reflecting on the surface. Icy palette.",
        # 1 — falha de geleira desabando no mar
        "Glacier cliff calving into the sea, a large ice slab mid-fall with geometric "
        "spray particles. Faceted blue ice wall behind. Dramatic motion in still "
        "composition.",
        # 2 — campo de gelo, claro PORÉM azul gelo saturado (rev3: clarear sem lavar a cor)
        "Open sunlit glacier field of faceted ice in clear icy blue and cyan under a "
        "bright powder-blue sky, daylight. Vivid glacial blue and cyan tones across the "
        "ice, cool blue shadows between the faceted blocks, crisp and luminous. Brighter "
        "than a dark scene but clearly an icy-blue palette, saturated glacier blue "
        "dominant. Not washed-out white, not pale pastel, no cave, no tunnel.",
        # 3 — cordilheira nevada sob aurora
        "Snowy mountain ridge under an aurora borealis, green and purple geometric "
        "sky ribbons above white faceted peaks. Cool night palette with vibrant "
        "aurora as focal.",
        # 4 — lago congelado com rachaduras
        "Frozen lake surface with crack patterns radiating across, low-angle oblique "
        "view. Twilight gradient sky, distant snowy hills. Pale violet and steel-blue "
        "palette.",
    ],
}

OUT_DIR = ROOT / "src/renderer/src/assets/bg"


def gen_one(theme: str, idx: int, force: bool) -> None:
    out = OUT_DIR / theme / f"{idx}.png"
    if out.exists() and not force:
        print(f"skip {out.relative_to(ROOT)} (existe)")
        return
    prompt = SCENES[theme][idx] + STYLE_SUFFIX
    print(f"→ {theme}/{idx}.png ...")
    resp = client.images.generate(
        model="gpt-image-1",
        prompt=prompt,
        size="1536x1024",
        quality="high",
        n=1,
    )
    b64 = resp.data[0].b64_json
    if not b64:
        sys.exit("Resposta sem b64_json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(base64.b64decode(b64))
    kb = out.stat().st_size // 1024
    print(f"✓ {out.relative_to(ROOT)} ({kb} KB)")


def main() -> None:
    args = sys.argv[1:]
    force = "--force" in args
    args = [a for a in args if a != "--force"]
    count = 5
    if "--count" in args:
        i = args.index("--count")
        count = int(args[i + 1])
        args = args[:i] + args[i + 2:]
    # Targeting por slot: tokens "tema:idx" regeneram SÓ aqueles (sempre force — o intent de
    # mirar um slot existente é refazê-lo). Ex: gen-bg.py lava:1 lava:2 geleira:2
    targets = [a for a in args if ":" in a]
    if targets:
        for tok in targets:
            th, _, ixs = tok.partition(":")
            if th not in SCENES:
                sys.exit(f"Tema desconhecido: {th}. Opções: {', '.join(SCENES)}")
            ix = int(ixs)
            if ix < 0 or ix >= len(SCENES[th]):
                sys.exit(f"idx fora do range pra {th}: {tok}")
            gen_one(th, ix, True)
        return

    only = args[0] if args else None
    if only and only not in SCENES:
        sys.exit(f"Tema desconhecido: {only}. Opções: {', '.join(SCENES)}")
    for theme in SCENES:
        if only and theme != only:
            continue
        for i in range(min(count, len(SCENES[theme]))):
            gen_one(theme, i, force)


if __name__ == "__main__":
    main()
