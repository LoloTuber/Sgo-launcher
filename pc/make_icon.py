# -*- coding: utf-8 -*-
"""Генерация иконок приложения (web/icon.ico и web/icon.png).

Значок тот же, что и логотип в интерфейсе: скруглённый зелёный квадрат
с белыми буквами «СГ». ICO нужен системному трею Windows, PNG — веб-странице
и заголовку окна.

Запуск:  python make_icon.py
"""

from __future__ import annotations

import os

from PIL import Image, ImageDraw, ImageFont

BASE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(BASE, "web")

GREEN = (20, 108, 67, 255)
GREEN_DARK = (15, 84, 52, 255)
WHITE = (255, 255, 255, 255)

FONT_CANDIDATES = [
    r"C:\Windows\Fonts\segoeuib.ttf",
    r"C:\Windows\Fonts\arialbd.ttf",
    r"C:\Windows\Fonts\arial.ttf",
]


def _font(size: int) -> ImageFont.FreeTypeFont:
    for path in FONT_CANDIDATES:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except OSError:
                continue
    return ImageFont.load_default()


def _render(size: int) -> Image.Image:
    """Рисует квадратный значок заданного размера."""
    scale = size / 256.0
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    radius = int(56 * scale)
    draw.rounded_rectangle(
        [0, 0, size - 1, size - 1],
        radius=radius,
        fill=GREEN,
    )
    # Нижняя полоска — «переплёт» книги, как в логотипе.
    strip = max(1, int(10 * scale))
    draw.rounded_rectangle(
        [int(10 * scale), size - int(26 * scale), size - int(10 * scale), size - int(10 * scale)],
        radius=max(1, int(6 * scale)),
        fill=GREEN_DARK,
    )

    font = _font(max(10, int(118 * scale)))
    text = "СГ"
    box = draw.textbbox((0, 0), text, font=font)
    width = box[2] - box[0]
    height = box[3] - box[1]
    x = (size - width) / 2 - box[0]
    y = (size - height) / 2 - box[1] - int(6 * scale)
    draw.text((x, y), text, font=font, fill=WHITE)
    return img


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    sizes = [16, 24, 32, 48, 64, 128, 256]
    images = [_render(size) for size in sizes]

    ico_path = os.path.join(OUT_DIR, "icon.ico")
    images[-1].save(ico_path, format="ICO", sizes=[(s, s) for s in sizes])
    print("saved:", ico_path)

    png_path = os.path.join(OUT_DIR, "icon.png")
    images[-1].save(png_path, format="PNG")
    print("saved:", png_path)


if __name__ == "__main__":
    main()
