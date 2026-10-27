"""Build pixel-exact lossless WebP companions for flood display overlays.

Packed query rasters and other PNG data stay in their original format. Existing
PNG overlays remain as a browser fallback. Identical PNGs share one encoding.
"""
from concurrent.futures import ThreadPoolExecutor, as_completed
from hashlib import sha256
from pathlib import Path
import shutil
import os
import tempfile

from PIL import Image, features

ROOT = Path(__file__).resolve().parents[1]


def digest(path):
    h = sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def encode(source, destinations):
    output = destinations[0]
    descriptor, name = tempfile.mkstemp(dir=output.parent, suffix='.webp.incomplete')
    os.close(descriptor)
    temporary = Path(name)
    try:
        with Image.open(source) as original:
            rgba = original.convert('RGBA')
            pixels = sha256(rgba.tobytes()).digest()
            size = rgba.size
            rgba.save(temporary, 'WEBP', lossless=True, exact=True, quality=100, method=4)
        if pixel_signature(temporary) != (size, pixels):
            raise RuntimeError(f'WebP pixel verification failed: {source}')
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    for destination in destinations[1:]:
        shutil.copyfile(output, destination)
    return len(destinations)


def pixel_signature(path):
    with Image.open(path) as original:
        rgba = original.convert('RGBA')
        return rgba.size, sha256(rgba.tobytes()).digest()


def main():
    if not features.check('webp'):
        raise RuntimeError('Pillow was built without WebP support')
    paths = sorted(path for path in (ROOT / 'assets').rglob('*.png')
                   if 'DepthPNGs' in path.parts or 'StagePNGs' in path.parts)
    groups = {}
    signatures = {}
    for path in paths:
        target = path.with_suffix('.webp')
        source_hash = digest(path)
        if source_hash not in signatures:
            signatures[source_hash] = pixel_signature(path)
        matches = False
        if target.exists():
            try:
                target_hash = digest(target)
                if target_hash not in signatures:
                    signatures[target_hash] = pixel_signature(target)
                matches = signatures[source_hash] == signatures[target_hash]
            except (OSError, ValueError):
                pass  # A damaged companion is rebuilt from its authoritative PNG.
        if not matches:
            groups.setdefault(source_hash, []).append(path)
    print(f'{len(paths)} display PNGs; {sum(map(len, groups.values()))} WebP companions missing or stale; {len(groups)} unique encodings', flush=True)
    count = 0
    with ThreadPoolExecutor(max_workers=2) as pool:
        futures = [pool.submit(encode, group[0], [path.with_suffix('.webp') for path in group])
                   for group in groups.values()]
        for future in as_completed(futures):
            count += future.result()
            if count % 100 < 2:
                print(f'Created {count} WebP companions', flush=True)
    print(f'Created {count} pixel-verified WebP companions', flush=True)


if __name__ == '__main__':
    main()
