import sys
from pathlib import Path

from PIL import Image

GIF_WIDTH = 960
FRAME_MS = 1100
LAST_FRAME_MS = 2600
PALETTE_COLORS = 255


def pad_to(frame: Image.Image, width: int, height: int, background: tuple[int, int, int]) -> Image.Image:
    canvas = Image.new('RGB', (width, height), background)
    canvas.paste(frame, (0, 0))
    return canvas


def build_gif(frames_dir: Path, output: Path) -> None:
    frames = [Image.open(path).convert('RGB') for path in sorted(frames_dir.glob('frame-*.png'))]

    if not frames:
        raise SystemExit(f'no frames in {frames_dir}')

    width = max(frame.width for frame in frames)
    height = max(frame.height for frame in frames)
    background = frames[0].getpixel((5, 5))
    size = (GIF_WIDTH, round(height * GIF_WIDTH / width))
    scaled = [pad_to(frame, width, height, background).resize(size, Image.LANCZOS) for frame in frames]

    mosaic = Image.new('RGB', (size[0], size[1] * len(scaled)))
    for index, frame in enumerate(scaled):
        mosaic.paste(frame, (0, index * size[1]))

    palette = mosaic.quantize(colors=PALETTE_COLORS, method=Image.Quantize.MAXCOVERAGE, dither=Image.Dither.NONE)
    quantized = [frame.quantize(palette=palette, dither=Image.Dither.NONE) for frame in scaled]
    durations = [FRAME_MS] * (len(quantized) - 1) + [LAST_FRAME_MS]
    quantized[0].save(output, save_all=True, append_images=quantized[1:], duration=durations, loop=0, optimize=True)


if __name__ == '__main__':
    if len(sys.argv) != 3:
        raise SystemExit('Usage: python3 scripts/demo/build-gif.py <frames-dir> <output.gif>')

    build_gif(Path(sys.argv[1]), Path(sys.argv[2]))
