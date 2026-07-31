"""
generate_icon.py
用 Python 生成 MusicPlayer 的 ICO 图标文件
需要 Pillow：pip install Pillow
"""
import struct, zlib, os, io

try:
    from PIL import Image, ImageDraw, ImageFont
    HAS_PILLOW = True
except ImportError:
    HAS_PILLOW = False

def create_icon_image(size):
    """创建渐变圆形音符图标"""
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # 背景圆 - 紫色渐变（用多层模拟）
    for i in range(size // 2, 0, -1):
        t = i / (size // 2)
        r = int(109 * t + 45 * (1 - t))
        g = int(40  * t + 20 * (1 - t))
        b = int(217 * t + 120 * (1 - t))
        cx, cy = size // 2, size // 2
        draw.ellipse([cx - i, cy - i, cx + i, cy + i], fill=(r, g, b, 255))

    # 音符符号（简化版：♪）
    pad = size // 6
    note_size = size - pad * 2
    cx, cy = size // 2, size // 2

    # 音符头（椭圆）
    nw = note_size // 3
    nh = note_size // 4
    nx = cx - nw // 4
    ny = cy + note_size // 6
    draw.ellipse([nx - nw//2, ny - nh//2, nx + nw//2, ny + nh//2],
                 fill=(255, 255, 255, 240))

    # 音符竖线
    lx = nx + nw // 2 - 2
    draw.rectangle([lx, cy - note_size // 3, lx + max(2, size // 20),
                    ny - nh // 4], fill=(255, 255, 255, 240))

    # 音符旗
    flag_y = cy - note_size // 3
    for fi in range(3):
        fy = flag_y + fi * max(2, size // 16)
        draw.arc([lx + 1, fy, lx + nw, fy + nw // 2],
                 start=0, end=180, fill=(255, 255, 255, 200),
                 width=max(1, size // 32))

    return img

def save_ico(output_path):
    sizes = [256, 128, 64, 48, 32, 16]
    images = []
    for s in sizes:
        img = create_icon_image(s)
        buf = io.BytesIO()
        img.save(buf, format='PNG')
        images.append((s, buf.getvalue()))

    # ICO 格式写入
    n = len(images)
    # Header: 6 bytes
    header = struct.pack('<HHH', 0, 1, n)
    # Directory entries: 16 bytes each
    offset = 6 + n * 16
    entries = b''
    data = b''
    for (s, png_data) in images:
        w = s if s < 256 else 0
        h = s if s < 256 else 0
        size_bytes = len(png_data)
        entries += struct.pack('<BBBBHHII', w, h, 0, 0, 1, 32, size_bytes, offset)
        offset += size_bytes
        data += png_data

    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, 'wb') as f:
        f.write(header + entries + data)
    print(f'[OK] icon generated: {output_path}')

if __name__ == '__main__':
    if not HAS_PILLOW:
        print('安装 Pillow: pip install Pillow')
        import subprocess, sys
        subprocess.check_call([sys.executable, '-m', 'pip', 'install', 'Pillow', '-q'])
        from PIL import Image, ImageDraw
    save_ico(r'D:\MusicPlayer\assets\icons\icon.ico')
