"""Builds assets/mastery/: the Agent Mastery pictures the /mastery Discord card is drawn from, so the
bot never depends on the wiki at run time. Needs Pillow (pip install pillow certifi).

  python scripts/build-mastery-art.py

For every playable agent: its four backgrounds (Standard, Agent Role, VALORANT, Agent Lore) as
bg-<kind>-<Agent>.jpg and its Mastery I pose as pose-<Agent>.webp (with alpha), plus the four level
frames as frame-1..4.png. Pictures come from the wiki's resized copies (the originals are up to
4096 px); the file name is the agent's name without spaces or punctuation (KAY/O -> KAYO).
"""
import io
import json
import os
import re
import sys
import time
import ssl
import urllib.request

from PIL import Image

try:  # some Python installs ship without root certificates
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = None

OUT = os.path.join(os.path.dirname(__file__), '..', 'assets', 'mastery')
WIKI = 'https://wiki.playvalorant.com/en-us/images/'
UA = {'User-Agent': 'val-shops mastery art builder'}

BG_KINDS = {'default': 'Standard_Background', 'role': 'Agent_Role_Background', 'val': 'VALORANT_Background', 'lore': 'Agent_Lore_Background'}


def get(url, tries=3):
    last = None
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=40, context=CTX) as r:
                return r.read()
        except Exception as e:  # noqa: BLE001
            last = e
            time.sleep(1.5 * (i + 1))
    raise last


def thumb(file, width):
    return f'{WIKI}thumb/{file}.png/{width}px-{file}.png'


def main():
    os.makedirs(OUT, exist_ok=True)
    agents = json.loads(get('https://valorant-api.com/v1/agents?isPlayableCharacter=true'))['data']
    keys = sorted({re.sub(r'[^A-Za-z0-9]', '', a['displayName']) for a in agents})
    print(len(keys), 'agents')

    for n, roman in enumerate(['I', 'II', 'III', 'IV'], start=1):
        dst = os.path.join(OUT, f'frame-{n}.png')
        if not os.path.exists(dst):
            raw = get(f'{WIKI}Level_{roman}_Frame.png')
            Image.open(io.BytesIO(raw)).convert('RGBA').save(dst, optimize=True)
            print('frame', n)

    failed = []
    for key in keys:
        for kind, file in BG_KINDS.items():
            dst = os.path.join(OUT, f'bg-{kind}-{key}.jpg')
            if os.path.exists(dst):
                continue
            try:
                im = Image.open(io.BytesIO(get(thumb(f'{file}_{key}', 640)))).convert('RGB')
                im.save(dst, 'JPEG', quality=80, optimize=True)
            except Exception as e:  # noqa: BLE001
                failed.append(f'bg-{kind}-{key}: {e}')
        dst = os.path.join(OUT, f'pose-{key}.webp')
        if not os.path.exists(dst):
            try:
                im = Image.open(io.BytesIO(get(thumb(f'Mastery_I_Pose_{key}', 700)))).convert('RGBA')
                im.save(dst, 'WEBP', quality=82, method=6)
            except Exception as e:  # noqa: BLE001
                failed.append(f'pose-{key}: {e}')
        print(key)
        time.sleep(0.2)

    # The poses' sizes, so the card can lay them out without decoding them.
    dims = {}
    for key in keys:
        f = os.path.join(OUT, f'pose-{key}.webp')
        if os.path.exists(f):
            dims[key] = list(Image.open(f).size)
    with open(os.path.join(OUT, 'poses.json'), 'w') as fh:
        json.dump(dims, fh, separators=(',', ':'), sort_keys=True)

    if failed:
        print('FAILED:', *failed, sep='\n  ')
        sys.exit(1)


if __name__ == '__main__':
    main()
