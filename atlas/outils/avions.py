#!/usr/bin/env python3
"""Instantané mondial des avions (OpenSky), pris par GitHub Actions toutes les 5 minutes.

Écrit <out>/avions.json, lu par le site (le navigateur ne peut pas interroger OpenSky lui-même :
OpenSky n'autorise pas les appels venant d'une page web).
- Compte OpenSky facultatif via les secrets OPENSKY_CLIENT_ID / OPENSKY_CLIENT_SECRET
  (4 000 crédits/jour : un instantané mondial en coûte 4, soit 288 instantanés/jour = 1 152 crédits).
- Chaque avion garde ses dernières positions réellement reçues (traînée de ~30 min).
- En cas d'échec, rien n'est écrit : l'instantané précédent reste en ligne (avec son heure).
"""
import argparse, gzip, json, os, sys, time, urllib.error, urllib.parse, urllib.request

UA = 'AtlasDuCiel/1.0 (GitHub Actions, un instantane toutes les 5 min)'
TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token'
STATES = 'https://opensky-network.org/api/states/all'
TRAIL_MAX = 6            # positions précédentes gardées par avion
TRAIL_MAX_AGE = 45 * 60  # secondes


def get(url, headers=None, data=None, timeout=60):
    h = {'User-Agent': UA, 'Accept-Encoding': 'gzip', **(headers or {})}
    req = urllib.request.Request(url, headers=h, data=data)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        b = r.read()
        return gzip.decompress(b) if r.headers.get('Content-Encoding') == 'gzip' else b


def token():
    cid, sec = os.environ.get('OPENSKY_CLIENT_ID', ''), os.environ.get('OPENSKY_CLIENT_SECRET', '')
    if not cid or not sec:
        return None
    body = urllib.parse.urlencode({'grant_type': 'client_credentials', 'client_id': cid, 'client_secret': sec}).encode()
    j = json.loads(get(TOKEN_URL, {'Content-Type': 'application/x-www-form-urlencoded'}, body, 30))
    return j['access_token']


def r(x, n):
    return None if x is None else round(x, n)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--previous', default='', help='URL ou fichier de l’instantané précédent (pour les traînées)')
    ap.add_argument('--source', default='', help='(tests) fichier JSON simulant la réponse OpenSky')
    a = ap.parse_args()

    prev = {}
    if a.previous:
        try:
            raw = open(a.previous, 'rb').read() if os.path.exists(a.previous) else get(a.previous, timeout=30)
            for s in json.loads(raw).get('states', []):
                prev[s[0]] = s
        except Exception as e:
            print('pas d’instantané précédent :', e)

    auth = False
    try:
        if a.source:
            data = json.load(open(a.source))
        else:
            h = {}
            try:
                t = token()
                if t:
                    h['Authorization'] = 'Bearer ' + t; auth = True
            except Exception as e:
                print('compte OpenSky refusé, essai en anonyme :', e)
            data = json.loads(get(STATES, h))
    except urllib.error.HTTPError as e:
        print(f'OpenSky a répondu {e.code} : instantané précédent conservé.'); return 0
    except Exception as e:
        print('OpenSky injoignable :', e, ': instantané précédent conservé.'); return 0

    now = data.get('time') or int(time.time())
    out = []
    for s in data.get('states') or []:
        if s[5] is None or s[6] is None:
            continue
        row = [s[0], (s[1] or '').strip(), s[2], s[3], s[4], r(s[5], 4), r(s[6], 4), r(s[7], 0), 1 if s[8] else 0,
               r(s[9], 1), r(s[10], 0), r(s[11], 1), None, r(s[13], 0), s[14]]
        p = prev.get(s[0])
        trail = []
        if p:
            trail = [q for q in (p[15] if len(p) > 15 and p[15] else []) if now - (q[3] or 0) < TRAIL_MAX_AGE]
            pt = p[3] or p[4] or 0
            if (p[6], p[5]) != (row[6], row[5]) and now - pt < TRAIL_MAX_AGE:
                trail.append([p[6], p[5], p[7] or 0, pt])
            trail = trail[-TRAIL_MAX:]
        row.append(trail)
        out.append(row)

    os.makedirs(a.out, exist_ok=True)
    doc = {'time': now, 'genere': int(time.time()), 'auth': auth, 'source': 'OpenSky Network', 'states': out}
    with open(os.path.join(a.out, 'avions.json'), 'w') as f:
        json.dump(doc, f, separators=(',', ':'))
    print(f'{len(out)} avions, compte OpenSky : {"oui" if auth else "non (anonyme)"}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
