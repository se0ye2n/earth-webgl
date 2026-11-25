"""공개 ETOPO1 API를 위경도 격자로 조회한다. Python 표준 라이브러리만 사용.
실행: python download_elevation.py --step 2
중간 결과를 저장하므로 실패한 뒤 다시 실행해도 이어서 받을 수 있다.
"""
import argparse
import json
import math
from pathlib import Path
import time
from datetime import datetime, timezone
from urllib.parse import urlencode
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parent
parser = argparse.ArgumentParser()
parser.add_argument('--step', type=int, default=2, choices=[1, 2, 3, 5, 10])
args = parser.parse_args()
step = args.step
width, height = 360 // step, 180 // step + 1
locations = [(max(-89.9999, min(89.9999, -90 + row * step)), -180 + col * step)
             for row in range(height) for col in range(width)]
cache = ROOT / 'data' / f'cache-{step}'
cache.mkdir(parents=True, exist_ok=True)
values = []
for start in range(0, len(locations), 100):
    batch = locations[start:start + 100]
    path = cache / f'{start:05d}.json'
    if path.exists():
        response = json.loads(path.read_text(encoding='utf-8'))
    else:
        query = urlencode({'locations': '|'.join(f'{lat},{lon}' for lat, lon in batch)})
        for attempt in range(4):
            try:
                with urlopen('https://api.opentopodata.org/v1/etopo1?' + query, timeout=40) as stream:
                    response = json.load(stream)
                if response.get('status') != 'OK':
                    raise ValueError(str(response))
                result = response['results']
                if len(result) != len(batch) or any(not isinstance(r.get('elevation'), (int, float)) for r in result):
                    raise ValueError('Missing elevation data')
                path.write_text(json.dumps(response), encoding='utf-8')
                time.sleep(1.15)  # API: 1 request/sec, 100 locations/request
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(3 * (attempt + 1))
    values.extend(round(r['elevation']) for r in response['results'])
    print(f'{min(start+100, len(locations))}/{len(locations)}', flush=True)

# 극점은 하나의 위치이므로 경도에 관계없이 같은 높이로 맞춘다.
for offset in [0, (height - 1) * width]:
    pole = round(sum(values[offset:offset+width]) / width)
    values[offset:offset+width] = [pole] * width
data = {'dataset': 'ETOPO1', 'provider': 'Open Topo Data',
        'source': 'https://www.opentopodata.org/datasets/etopo1/',
        'api': 'https://api.opentopodata.org/v1/etopo1',
        'retrievedUTC': datetime.now(timezone.utc).isoformat(),
        'stepDegrees': step, 'width': width, 'height': height,
        'latitudeStart': -90, 'longitudeStart': -180,
        'units': 'metres', 'elevations': values}
assert len(values) == width * height and all(math.isfinite(v) for v in values)
# JS 형식으로도 저장하여 index.html을 더블클릭해서 실행할 수 있게 한다.
payload = json.dumps(data, separators=(',', ':'))
(ROOT / 'data' / 'elevation.json').write_text(payload, encoding='utf-8')
(ROOT / 'data' / 'elevation.js').write_text('window.EARTH_DATA = ' + payload + ';\n', encoding='utf-8')
print('Saved real elevation grid:', width, height, min(values), max(values))
