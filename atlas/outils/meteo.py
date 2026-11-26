#!/usr/bin/env python3
"""Météo d'Atlas du Ciel, relevée toutes les heures par GitHub Actions (tâche « Atlas - météo »).

Pour chaque heure, trois images globales (projection équirectangulaire, -180..180 / 90..-90) :
  - nuages : assemblage infrarouge 10,8 µm de tous les satellites géostationnaires
             base EUMETSAT « Geostationary Ring » (toutes les 3 h, globe entier), rafraîchie là où il existe
             une image plus récente : NASA GIBS (GOES-Est, GOES-Ouest, Himawari, toutes les 10 min)
             et EUMETSAT Meteosat (0° et océan Indien) ;
  - pluie  : NASA GPM IMERG (précipitations toutes les 30 min, disponibles ~5 h après l'observation) ;
  - vents  : modèle NOAA GFS 1°, vent à 10 m (u, v), à l'heure demandée.
Les 72 dernières heures sont gardées (frise). Chaque élément est facultatif : si une source manque,
l'image correspondante est simplement absente de cette heure.

Usage : python3 meteo.py --dir DOSSIER   (DOSSIER = contenu actuel de la branche atlas-meteo)
"""
import argparse, datetime as dt, io, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
import numpy as np
from PIL import Image

UA = 'AtlasDuCiel/1.0 (GitHub Actions, une requete par heure)'
W, H = 2048, 1024                    # taille des images de nuages
RW, RH = 1440, 720                   # taille des images de pluie
GARDE_H = 72                         # historique gardé
GIBS = 'https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi'
EUM = 'https://view.eumetsat.int/geoserver/wms'
NOMADS = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_gfs_1p00.pl'
# satellites géostationnaires : (nom affiché, serveur, couche, longitude du satellite, pas de temps en minutes)
GEO = [
    ('GOES-Est', GIBS, 'GOES-East_ABI_Band13_Clean_Infrared', -75.2, 10),
    ('GOES-Ouest', GIBS, 'GOES-West_ABI_Band13_Clean_Infrared', -137.2, 10),
    ('Himawari', GIBS, 'Himawari_AHI_Band13_Clean_Infrared', 140.7, 10),
    ('Meteosat 0°', EUM, 'msg_fes:ir108', 0.0, 15),
    ('Meteosat océan Indien', EUM, 'msg_iodc:ir108', 45.5, 15),
]
OFFLINE = None   # (tests) dossier de fichiers simulant les réponses


def log(*a):
    print('[météo]', *a, flush=True)


def iso(t):
    return t.strftime('%Y-%m-%dT%H:%M:%SZ')


def get(url, timeout=90):
    if OFFLINE:
        f = os.path.join(OFFLINE, ''.join(c if c.isalnum() else '_' for c in url)[:180])
        if not os.path.exists(f):
            raise IOError('absent (test)')
        return open(f, 'rb').read()
    req = urllib.request.Request(url, headers={'User-Agent': UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def wms(base, layer, t, w, h, bbox='-180,-90,180,90', transparent=True):
    q = (f'{base}?SERVICE=WMS&REQUEST=GetMap&VERSION=1.1.1&LAYERS={layer}&STYLES=&SRS=EPSG:4326'
         f'&BBOX={bbox}&WIDTH={w}&HEIGHT={h}&FORMAT=image/png&TRANSPARENT={"TRUE" if transparent else "FALSE"}&TIME={iso(t)}')
    b = get(q)
    if not b.startswith(b'\x89PNG'):
        raise IOError('pas une image : ' + b[:120].decode('utf-8', 'replace'))
    return Image.open(io.BytesIO(b)).convert('RGBA')


def useful(img, min_frac=0.02):
    """Une image WMS vide (hors période) est entièrement transparente ou uniforme."""
    a = np.asarray(img)
    data = a[..., 3] > 0
    if data.mean() < min_frac:
        return False
    v = a[..., :3].max(axis=2)[data]
    return v.std() > 3


def latest(base, layer, start, step_min, tries, w, h, bbox='-180,-90,180,90'):
    """Image la plus récente disponible à partir de « start » en reculant par pas de step_min."""
    t = start.replace(minute=(start.minute // step_min) * step_min, second=0, microsecond=0)
    last = None
    for _ in range(tries):
        try:
            img = wms(base, layer, t, w, h, bbox)
            if useful(img):
                return img, t
        except Exception as e:
            last = e
        t -= dt.timedelta(minutes=step_min)
    raise IOError(f'{layer} : aucune image récente ({last})')


def cloudiness(img):
    """Infrarouge -> opacité des nuages (0..1), auto-calibrée : sol chaud sombre, sommets froids clairs."""
    a = np.asarray(img).astype(np.float32)
    v = a[..., :3].max(axis=2) / 255.0          # max des canaux : gère les palettes colorées des nuages très froids
    mask = a[..., 3] > 0
    if mask.sum() < 100:
        return np.zeros(v.shape, np.float32), mask
    lo, hi = np.percentile(v[mask], [35, 99.5])
    c = np.clip((v - lo) / max(hi - lo, 1e-3), 0, 1) ** 1.15
    return c * mask, mask


def build_clouds(t):
    lat = np.linspace(90, -90, H, dtype=np.float32)[:, None]
    lon = np.linspace(-180, 180, W, endpoint=False, dtype=np.float32)[None, :] + 180.0 / W
    acc = np.zeros((H, W), np.float32)
    wsum = np.zeros((H, W), np.float32)
    sources = []
    # base : assemblage EUMETSAT toutes les 3 h (couvre tout le globe)
    try:
        img, tb = latest(EUM, 'mumi:worldcloudmap_ir108', t, 180, 4, W, H)
        c, m = cloudiness(img)
        acc += c * 0.05 * m; wsum += 0.05 * m
        sources.append(f'EUMETSAT assemblage {tb:%H:%M}')
    except Exception as e:
        log('base EUMETSAT indisponible :', e)
    # images récentes de chaque satellite, pondérées par l'angle de vue
    newest = None
    for name, base, layer, sublon, step in GEO:
        try:
            img, ts = latest(base, layer, t - dt.timedelta(minutes=20), step, 9, W, H)
        except Exception as e:
            log(name, 'indisponible :', e)
            continue
        c, m = cloudiness(img)
        dl = np.radians(((lon - sublon + 540) % 360) - 180)
        cosang = np.cos(dl) * np.cos(np.radians(lat))           # cosinus de l'angle au centre du disque vu
        w = np.clip((cosang - 0.25) / 0.75, 0, 1) ** 2 * m
        acc += c * w; wsum += w
        sources.append(f'{name} {ts:%H:%M}')
        newest = ts if newest is None or ts > newest else newest
    if not sources:
        raise IOError('aucune source de nuages')
    out = np.where(wsum > 0, acc / np.maximum(wsum, 1e-6), 0)
    return Image.fromarray((out * 255).astype(np.uint8), 'L'), sources, newest


def build_rain(t):
    for layer in ('IMERG_Precipitation_Rate_30min', 'IMERG_Precipitation_Rate'):
        try:
            img, tr = latest(GIBS, layer, t - dt.timedelta(hours=4), 30, 24, RW, RH)
            q = img.quantize(colors=64, method=Image.Quantize.FASTOCTREE)   # PNG à palette : 5x plus léger
            return q, tr
        except Exception as e:
            log(layer, ':', e)
    raise IOError('pluie indisponible')


def decode_grib(path):
    """u, v à 10 m via les outils eccodes (grib_get_data), installés par la tâche GitHub."""
    fields = {}
    for short in ('10u', '10v'):
        out = subprocess.run(['grib_get_data', '-w', f'shortName={short}', path], capture_output=True, text=True, check=True).stdout
        rows = [l.split() for l in out.splitlines()[1:] if l.strip()]
        arr = np.array([[float(r[0]), float(r[1]), float(r[2])] for r in rows], np.float32)
        fields[short] = arr
    return fields


def build_wind(t):
    """Vent GFS 1° à l'heure t : dernière prévision disponible (échéance 0 à 9 h)."""
    run = t.replace(hour=(t.hour // 6) * 6, minute=0, second=0, microsecond=0)
    for _ in range(4):
        fh = int((t - run).total_seconds() // 3600)
        fh = int(round(fh / 3)) * 3   # la grille GFS 1° n'est publiée que toutes les 3 h d'échéance (f000, f003, f006…)
        if fh >= 0:
            url = (f'{NOMADS}?dir=%2Fgfs.{run:%Y%m%d}%2F{run:%H}%2Fatmos&file=gfs.t{run:%H}z.pgrb2.1p00.f{fh:03d}'
                   f'&var_UGRD=on&var_VGRD=on&lev_10_m_above_ground=on')
            try:
                b = get(url, 60)
                if b[:4] == b'GRIB':
                    with tempfile.NamedTemporaryFile(suffix='.grib2', delete=False) as f:
                        f.write(b); path = f.name
                    try:
                        fl = decode_grib(path)
                    finally:
                        os.unlink(path)
                    return to_wind_png(fl), run, fh
            except Exception as e:
                log(f'GFS {run:%Y-%m-%d %H}h +{fh}h :', e)
        run -= dt.timedelta(hours=6)
    raise IOError('vents indisponibles')


def to_wind_png(fl):
    """Grille 360 x 181 (lon -180..179, lat 90..-90) ; rouge = u, vert = v, 0,5 m/s par niveau, 128 = 0."""
    img = np.zeros((181, 360, 3), np.uint8)
    for short, ch in (('10u', 0), ('10v', 1)):
        a = fl[short]
        la = np.rint(90 - a[:, 0]).astype(int)
        lo = (np.rint(a[:, 1]).astype(int) + 180) % 360
        ok = (la >= 0) & (la <= 180)
        img[la[ok], lo[ok], ch] = np.clip(np.rint(a[ok, 2] * 2 + 128), 0, 255).astype(np.uint8)
    return Image.fromarray(img, 'RGB')


def main():
    global OFFLINE
    ap = argparse.ArgumentParser()
    ap.add_argument('--dir', required=True, help='contenu actuel de la branche atlas-meteo (modifié sur place)')
    ap.add_argument('--heure', default='', help='(tests) heure UTC traitée, ex. 2026-11-26T13:00')
    ap.add_argument('--offline', default='', help='(tests) réponses simulées')
    a = ap.parse_args()
    OFFLINE = a.offline or None
    os.makedirs(a.dir, exist_ok=True)
    now = dt.datetime.now(dt.timezone.utc)
    t = dt.datetime.fromisoformat(a.heure).replace(tzinfo=dt.timezone.utc) if a.heure else now.replace(minute=0, second=0, microsecond=0)
    man_path = os.path.join(a.dir, 'meteo.json')
    man = json.load(open(man_path)) if os.path.exists(man_path) else {'frames': []}
    key = f'{t:%Y%m%dT%H}'
    frame = next((f for f in man['frames'] if f['t'] == iso(t)), None) or {'t': iso(t)}
    errors = {}

    try:
        img, src, newest = build_clouds(t)
        f = f'nuages_{key}.jpg'
        img.save(os.path.join(a.dir, f), quality=82, optimize=True)
        frame.update(nuages=f, nuages_sources=src, nuages_t=iso(newest) if newest else None)
        log('nuages :', ', '.join(src))
    except Exception as e:
        errors['nuages'] = str(e); log('nuages :', e)
    try:
        img, tr = build_rain(t)
        f = f'pluie_{key}.png'
        img.save(os.path.join(a.dir, f), optimize=True)
        frame.update(pluie=f, pluie_t=iso(tr))
        log('pluie : observation de', iso(tr))
    except Exception as e:
        errors['pluie'] = str(e); log('pluie :', e)
    try:
        img, run, fh = build_wind(t)
        f = f'vents_{key}.png'
        img.save(os.path.join(a.dir, f), optimize=True)
        frame.update(vents=f, vents_run=iso(run), vents_echeance=fh)
        log(f'vents : GFS {run:%d/%m %H}h +{fh}h')
    except Exception as e:
        errors['vents'] = str(e); log('vents :', e)

    if not any(k in frame for k in ('nuages', 'pluie', 'vents')):
        log('ÉCHEC : aucune donnée météo pour', iso(t), '; rien n’est publié.')
        sys.exit(1)
    man['frames'] = [f for f in man['frames'] if f['t'] != frame['t']] + [frame]
    # on ne garde que les 72 dernières heures, et on supprime les fichiers devenus inutiles
    limit = now - dt.timedelta(hours=GARDE_H)
    man['frames'] = sorted((f for f in man['frames'] if dt.datetime.fromisoformat(f['t'].replace('Z', '+00:00')) >= limit), key=lambda f: f['t'])
    keep = {f[k] for f in man['frames'] for k in ('nuages', 'pluie', 'vents') if k in f} | {'meteo.json'}
    for name in os.listdir(a.dir):
        if name not in keep and os.path.isfile(os.path.join(a.dir, name)):
            os.remove(os.path.join(a.dir, name))
    man.update(genere=iso(now), erreurs=errors, historique_h=GARDE_H)
    json.dump(man, open(man_path, 'w'), ensure_ascii=False, indent=1)
    log(f'{len(man["frames"])} heures en historique')


if __name__ == '__main__':
    main()
