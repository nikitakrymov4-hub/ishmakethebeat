from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED
import json, base64, re

root = Path(__file__).resolve().parent.parent
cal = root / 'deliverables/calibration'
readme = '''ishmakethebeat aligned stems
Stereo, 44.1 kHz, 24-bit signed PCM. Same frame-zero start and total frame count.
Fixed 2-second tail; final 5 ms tapered.
Tap: post instrument, track filter/insert/fader; before master gain, dynamics, and protection.
Shared delay/reverb is in stem-fx.wav. Other files are dry with track inserts.
The nonlinear listening master is not promised to equal the stem sum.
User-supplied private kit assets: redistribution permission is unverified.
'''
(cal / 'STEMS.txt').write_text(readme)
with ZipFile(cal / 'aligned-stems.zip', 'w', ZIP_DEFLATED, compresslevel=1) as z:
    for path in sorted(cal.glob('stem-*.wav')):
        z.write(path, path.name)
    z.writestr('README.txt', readme)
project = json.loads((cal / 'project.ish.json').read_text())
with ZipFile(cal / 'project.ish.zip', 'w', ZIP_DEFLATED, compresslevel=1) as z:
    z.write(cal / 'project.ish.json', 'project.json')
    z.write(cal / 'score.mid', 'score.mid')
    for asset in project['assets']:
        z.writestr(f"samples/{asset['id']}.wav", base64.b64decode(asset['data'].split(',', 1)[1]))
with ZipFile(root / 'deliverables/listening-pack.zip', 'w', ZIP_DEFLATED, compresslevel=1) as z:
    z.write(root / 'deliverables/asset-manifest.json', 'asset-manifest.json')
    included={'asset-manifest.json'}
    for folder, pattern in [('comparison', '*matched.wav'), ('calibration', 'listening-master.wav'), ('generated', '*.wav')]:
        for path in sorted((root / 'deliverables' / folder).glob(pattern)):
            z.write(path, f'{folder}/{path.name}')
            included.add(f'{folder}/{path.name}')
    for path in (root / 'docs').glob('*.md'):
        z.write(path, f'docs/{path.name}')
        included.add(f'docs/{path.name}')
    html=(root/'deliverables/listen.html').read_text().replace('../docs/','docs/')
    def link(match):
        href,label=match.group(1),match.group(2)
        return match.group(0) if href in included else f'<span>{label} · see full deliverables</span>'
    html=re.sub(r'<a href="([^"]+)">(.*?)</a>',link,html)
    for src in re.findall(r'src="([^"]+)"',html):
        assert src in included, f'Missing listening media: {src}'
    z.writestr('listen.html',html)
print('Packaged aligned-stems.zip, project.ish.zip, and listening-pack.zip')
