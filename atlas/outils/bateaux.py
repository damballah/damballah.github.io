#!/usr/bin/env python3
"""Atlas du Ciel : instantané mondial des navires (AIS) depuis aisstream.io.

aisstream.io diffuse en continu, par WebSocket, les messages AIS captés par des antennes au sol.
Toutes les 5 minutes, GitHub écoute ce flux pendant ~50 s et publie un petit fichier bateaux.json.
Les navires entendus lors des relevés précédents (moins de 45 min) sont conservés : un bateau à quai
ou au mouillage n'émet que toutes les 3 à 6 minutes.

La clé aisstream ne quitte jamais GitHub (secret AISSTREAM_API_KEY) : le site ne lit que bateaux.json.
Aucune dépendance à installer : client WebSocket minimal en Python standard.

Usage : AISSTREAM_API_KEY=... python3 bateaux.py --out DOSSIER [--precedent URL_DU_DOSSIER_PUBLIE] [--duree 50]
"""
import argparse, base64, json, os, socket, ssl, struct, sys, time, urllib.parse, urllib.request

URL = 'wss://stream.aisstream.io/v0/stream'
GARDE = 45 * 60            # on garde un navire 45 min après sa dernière position
GARDE_STATIQUE = 48 * 3600 # nom, type, destination… gardés 48 h (envoyés seulement toutes les 6 min par les navires)
POSITIONS = ('PositionReport', 'StandardClassBPositionReport', 'ExtendedClassBPositionReport')
STATIQUES = ('ShipStaticData', 'StaticDataReport')


# ------------------------------------------------------------------ WebSocket minimal (RFC 6455)
class WS:
    def __init__(self, url, timeout=20):
        u = urllib.parse.urlparse(url)
        port = u.port or (443 if u.scheme == 'wss' else 80)
        raw = socket.create_connection((u.hostname, port), timeout=timeout)
        self.s = ssl.create_default_context().wrap_socket(raw, server_hostname=u.hostname) if u.scheme == 'wss' else raw
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path or '/') + ('?' + u.query if u.query else '')
        host = u.hostname + ('' if u.port in (None, 443, 80) else f':{u.port}')
        self.s.sendall((f'GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                        f'Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\nUser-Agent: AtlasDuCiel/1.0\r\n\r\n').encode())
        self.buf = b''
        head = self._until(b'\r\n\r\n')
        if b' 101 ' not in head.split(b'\r\n')[0]:
            raise RuntimeError('refus du serveur : ' + head.split(b'\r\n')[0].decode(errors='replace'))

    def _recv(self, n):
        while len(self.buf) < n:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError('connexion fermée')
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _until(self, sep):
        while sep not in self.buf:
            chunk = self.s.recv(65536)
            if not chunk:
                raise ConnectionError('connexion fermée pendant la poignée de main')
            self.buf += chunk
        i = self.buf.index(sep) + len(sep)
        out, self.buf = self.buf[:i], self.buf[i:]
        return out

    def send(self, text, opcode=1):
        data = text.encode() if isinstance(text, str) else text
        mask = os.urandom(4)
        n = len(data)
        hdr = bytes([0x80 | opcode])
        hdr += bytes([0x80 | n]) if n < 126 else (bytes([0x80 | 126]) + struct.pack('>H', n) if n < 65536 else bytes([0x80 | 127]) + struct.pack('>Q', n))
        self.s.sendall(hdr + mask + bytes(b ^ mask[i % 4] for i, b in enumerate(data)))

    def recv(self):
        """renvoie le texte du prochain message (None si le serveur ferme)"""
        msg, first = b'', None
        while True:
            b1, b2 = self._recv(2)
            fin, op, n = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if n == 126: n = struct.unpack('>H', self._recv(2))[0]
            elif n == 127: n = struct.unpack('>Q', self._recv(8))[0]
            mask = self._recv(4) if b2 & 0x80 else None
            data = self._recv(n)
            if mask: data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
            if op == 8: return None                       # fermeture
            if op == 9: self.send(data, 10); continue     # ping -> pong
            if op == 10: continue
            if first is None: first = op
            msg += data
            if fin: return msg.decode('utf-8', errors='replace') if first == 1 else msg.decode('utf-8', errors='replace')

    def close(self):
        try: self.send(b'', 8); self.s.close()
        except OSError: pass


# ------------------------------------------------------------------ lecture des messages AIS
def propre(s):
    s = (s or '').replace('@', ' ').strip()
    return ' '.join(s.split())[:40]


def ingerer(m, nav, stat, now):
    """met à jour nav (positions) et stat (données fixes) à partir d'un message aisstream"""
    mt = m.get('MessageType'); md = m.get('MetaData') or {}
    mmsi = md.get('MMSI') or md.get('MMSI_String')
    try: mmsi = int(mmsi)
    except (TypeError, ValueError): return
    if not (100000000 <= mmsi <= 999999999): return
    body = (m.get('Message') or {}).get(mt) or {}
    nom = propre(md.get('ShipName'))
    if mt in POSITIONS:
        lat, lon = body.get('Latitude', md.get('latitude')), body.get('Longitude', md.get('longitude'))
        if lat is None or lon is None or not (-90 <= lat <= 90 and -180 <= lon <= 180) or (abs(lat) < 1e-4 and abs(lon) < 1e-4):
            return
        if body.get('Valid') is False: return
        sog = body.get('Sog'); cog = body.get('Cog'); hdg = body.get('TrueHeading')
        e = nav.setdefault(mmsi, {})
        e.update(lat=round(lat, 4), lon=round(lon, 4), t=int(now),
                 sog=round(sog, 1) if isinstance(sog, (int, float)) and sog < 102.2 else None,
                 cog=round(cog) if isinstance(cog, (int, float)) and cog < 360 else None,
                 hdg=hdg if isinstance(hdg, int) and hdg < 360 else None,
                 classe='B' if 'ClassB' in mt else 'A')
        if 'NavigationalStatus' in body: e['nav'] = body['NavigationalStatus']
        if nom: stat.setdefault(mmsi, {})['nom'] = nom; stat[mmsi]['t'] = int(now)
    elif mt == 'ShipStaticData':
        d = stat.setdefault(mmsi, {})
        if propre(body.get('Name')): d['nom'] = propre(body.get('Name'))
        if body.get('Type'): d['type'] = body['Type']
        if propre(body.get('Destination')): d['dest'] = propre(body.get('Destination'))
        if propre(body.get('CallSign')): d['ind'] = propre(body.get('CallSign'))
        if body.get('ImoNumber'): d['imo'] = body['ImoNumber']
        dim = body.get('Dimension') or {}
        if dim.get('A') is not None and dim.get('B') is not None and 0 < dim['A'] + dim['B'] < 500: d['long'] = dim['A'] + dim['B']
        d['t'] = int(now)
    elif mt == 'StaticDataReport':
        d = stat.setdefault(mmsi, {})
        ra, rb = body.get('ReportA') or {}, body.get('ReportB') or {}
        if ra.get('Valid', True) and propre(ra.get('Name')): d['nom'] = propre(ra.get('Name'))
        if rb.get('Valid', True):
            if rb.get('ShipType'): d['type'] = rb['ShipType']
            if propre(rb.get('CallSign')): d['ind'] = propre(rb.get('CallSign'))
            dim = rb.get('Dimension') or {}
            if dim.get('A') is not None and dim.get('B') is not None and 0 < dim['A'] + dim['B'] < 500: d['long'] = dim['A'] + dim['B']
        d['t'] = int(now)


def abonnement(cle):
    return json.dumps({'APIKey': cle, 'BoundingBoxes': [[[-90, -180], [90, 180]]], 'FilterMessageTypes': list(POSITIONS + STATIQUES)})


def ecouter_lib(cle, duree, nav, stat, url):
    """version avec la bibliothèque « websockets » (installée par la tâche GitHub)"""
    import asyncio
    import websockets

    async def run():
        t0 = time.time()
        async with websockets.connect(url, open_timeout=40, ping_interval=20, ping_timeout=40, max_size=2 ** 24, close_timeout=5) as ws:
            print(f'[bateaux] connecté en {time.time() - t0:.1f} s')
            await ws.send(abonnement(cle))
            fin, n, premier = time.time() + duree, 0, None
            while time.time() < fin:
                try:
                    txt = await asyncio.wait_for(ws.recv(), timeout=min(30, max(1, fin - time.time())))
                except asyncio.TimeoutError:
                    if n == 0: raise RuntimeError('connecté, mais aucun message reçu en 30 s')
                    break
                if isinstance(txt, bytes): txt = txt.decode('utf-8', errors='replace')
                try: m = json.loads(txt)
                except ValueError: continue
                if isinstance(m, dict) and m.get('error'):
                    raise RuntimeError('aisstream : ' + str(m['error']))
                if premier is None:
                    premier = time.time() - t0; print(f'[bateaux] premier message après {premier:.1f} s')
                ingerer(m, nav, stat, time.time()); n += 1
            return n
    return asyncio.run(run())


def ecouter(cle, duree, nav, stat, url=URL):
    try:
        import websockets  # noqa: F401
        return ecouter_lib(cle, duree, nav, stat, url)
    except ImportError:
        pass
    ws = WS(url, timeout=40)
    # aisstream exige l'abonnement dans les 3 secondes
    ws.send(abonnement(cle))
    ws.s.settimeout(15)
    fin, n = time.time() + duree, 0
    try:
        while time.time() < fin:
            txt = ws.recv()
            if txt is None: break
            try: m = json.loads(txt)
            except ValueError: continue
            if isinstance(m, dict) and m.get('error'):
                raise RuntimeError('aisstream : ' + str(m['error']))
            ingerer(m, nav, stat, time.time()); n += 1
    except (socket.timeout, ConnectionError) as e:
        if n == 0: raise RuntimeError(f'aucun message reçu ({e})')
    finally:
        ws.close()
    return n


def lire(url):
    try:
        req = urllib.request.Request(url + '?t=' + str(int(time.time())), headers={'User-Agent': 'AtlasDuCiel/1.0'})
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.load(r)
    except Exception as e:   # noqa: BLE001 - premier relevé, ou branche pas encore créée
        print(f'[bateaux] pas de relevé précédent ({e})')
        return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--precedent', default='')
    ap.add_argument('--duree', type=float, default=50)
    ap.add_argument('--url', default=URL)
    a = ap.parse_args()
    cle = os.environ.get('AISSTREAM_API_KEY', '').strip()
    if not cle:
        print('[bateaux] secret AISSTREAM_API_KEY absent : rien à faire (voir le README).')
        return 0
    now = time.time()
    nav, stat = {}, {}
    if a.precedent:   # relevés précédents
        p = lire(a.precedent.rstrip('/') + '/bateaux.json') or {}
        for r in p.get('navires', []):
            mmsi, lat, lon, sog, cog, hdg, t = r[0], r[2], r[3], r[4], r[5], r[6], r[8]
            if now - t < GARDE:
                nav[mmsi] = dict(lat=lat, lon=lon, sog=sog, cog=cog, hdg=hdg, t=t, nav=r[9], classe=r[13] if len(r) > 13 else 'A')
        s = lire(a.precedent.rstrip('/') + '/statique.json') or {}
        for k, d in s.items():
            if now - d.get('t', 0) < GARDE_STATIQUE: stat[int(k)] = d
    avant = len(nav)
    n, err = 0, None
    for essai in range(1, 4):   # le service est en bêta : jusqu'à 3 essais
        try:
            n = ecouter(cle, a.duree, nav, stat, a.url)
            print(f'[bateaux] {n} messages reçus en {a.duree:.0f} s')
            break
        except Exception as e:   # noqa: BLE001
            err = f'{type(e).__name__} : {e}'
            print(f'[bateaux] essai {essai} : flux indisponible ({err})', file=sys.stderr)
            if 'aisstream :' in str(e): break       # clé refusée : inutile d'insister
            time.sleep(5)
    if not n:
        # pas d'erreur rouge toutes les 5 min : un simple avertissement, le relevé précédent reste en ligne
        print(f'::warning title=Navires::aisstream.io injoignable ({err}). Le relevé précédent reste en ligne.')
        if not avant: return 0
        print('[bateaux] on republie les positions précédentes encore valables')
    # fichier lu par le site : [mmsi, nom, lat, lon, vitesse(nœuds), route, cap, type, t, statut, destination, longueur, imo, classe]
    rows = []
    for mmsi, e in nav.items():
        d = stat.get(mmsi, {})
        rows.append([mmsi, d.get('nom', ''), e['lat'], e['lon'], e.get('sog'), e.get('cog'), e.get('hdg'), d.get('type', 0),
                     e['t'], e.get('nav'), d.get('dest', ''), d.get('long'), d.get('imo'), e.get('classe', 'A')])
    rows.sort(key=lambda r: -r[8])
    os.makedirs(a.out, exist_ok=True)
    json.dump({'time': int(now), 'genere': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(now)),
               'source': 'aisstream.io (AIS terrestre)', 'n': len(rows), 'navires': rows},
              open(os.path.join(a.out, 'bateaux.json'), 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    json.dump({str(k): v for k, v in stat.items()}, open(os.path.join(a.out, 'statique.json'), 'w', encoding='utf-8'),
              ensure_ascii=False, separators=(',', ':'))
    print(f'[bateaux] {len(rows)} navires publiés ({avant} gardés des relevés précédents), {len(stat)} fiches')
    return 0


if __name__ == '__main__':
    sys.exit(main())
