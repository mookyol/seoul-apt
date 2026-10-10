"""
앱 아이콘 만들기 — logo-source.png(원본 1장) → 아이폰 180 · 안드로이드 192·512(모양 잘림 대응) · 브라우저 탭 아이콘

  · 원본의 바깥 흰 배경을 지우고(가장자리에서 이어진 흰색만 — 캐릭터 안쪽 흰색은 유지)
  · 배경색 위 가운데 78% 안에 배치 (안드로이드가 원형·물방울로 잘라도 안전)

사용법: python make_icons.py [원본경로] [배경색]
"""
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter

ROOT = Path(__file__).parent
SRC = Path(sys.argv[1]) if len(sys.argv) > 1 else ROOT / "site" / "logo-source.png"
BG = sys.argv[2] if len(sys.argv) > 2 else "#dbeafe"
SAFE = 0.78


def cutout(im):
    """가장자리에서 이어진 흰 배경만 투명하게"""
    im = im.convert("RGBA")
    w, h = im.size
    mask = Image.new("L", (w + 2, h + 2), 0)
    rgb = Image.new("RGB", (w + 2, h + 2), (255, 255, 255))
    rgb.paste(im.convert("RGB"), (1, 1))
    ImageDraw.floodfill(rgb, (0, 0), (255, 0, 255), thresh=40)      # 바깥 흰색을 마젠타로 칠해 표시
    px = rgb.load()
    for y in range(h + 2):
        for x in range(w + 2):
            if px[x, y] == (255, 0, 255):
                mask.putpixel((x, y), 255)
    bgmask = mask.crop((1, 1, w + 1, h + 1)).filter(ImageFilter.GaussianBlur(0.8))   # 경계 부드럽게
    alpha = Image.eval(bgmask, lambda v: 255 - v)
    im.putalpha(alpha)
    return im.crop(im.getbbox())


def render(fg, size, bg, safe=SAFE):
    canvas = Image.new("RGBA", (size, size), bg)
    scale = safe * size / max(fg.size)
    big = fg.resize((max(1, round(fg.width * scale)), max(1, round(fg.height * scale))), Image.LANCZOS)
    if scale > 1:
        big = big.filter(ImageFilter.UnsharpMask(radius=1.2, percent=60, threshold=2))   # 확대로 흐려진 선 보정
    canvas.alpha_composite(big, ((size - big.width) // 2, (size - big.height) // 2 + round(size * 0.01)))
    return canvas.convert("RGB")


def main():
    fg = cutout(Image.open(SRC))
    out = ROOT / "site"
    for name, size in (("icon-512.png", 512), ("icon-192.png", 192), ("icon-180.png", 180), ("favicon-48.png", 48)):
        render(fg, size, BG, SAFE if size > 48 else 0.92).save(out / name, optimize=True)
        print("✅", name, size)


if __name__ == "__main__":
    main()
