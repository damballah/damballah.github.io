"""Atlas du Ciel : noms des fleuves, rivières, canaux, lacs, sommets et massifs -> noms.json

Source : Natural Earth (domaine public), https://www.naturalearthdata.com
Les fichiers GeoJSON viennent du dépôt officiel github.com/nvkelso/natural-earth-vector.
À lancer une seule fois (ou après une mise à jour de Natural Earth) : la géographie ne bouge pas.

Format de sortie (coordonnées arrondies au 1/1000 de degré) :
  rivieres : [nom, zoom_min, type, [lat, lon, lat, lon, ...]]   points où écrire le nom, répartis le long du cours
  lacs     : [nom, zoom_min, lat, lon]
  sommets  : [nom, zoom_min, lat, lon, altitude_m]
  massifs  : [nom, zoom_min, lat, lon]
  traits   : [zoom_min, [lat, lon, lat, lon, ...]]                tracé simplifié des cours d'eau
« zoom_min » est le niveau de zoom (façon carte web, 0 = monde entier) à partir duquel l'élément s'affiche.
"""
import argparse, json, math, os, sys, urllib.request

BASES = ['https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/']
FICHIERS = {
    'rivieres': ['ne_10m_rivers_lake_centerlines', 'ne_10m_rivers_europe', 'ne_10m_rivers_north_america'],
    'lacs': ['ne_10m_lakes', 'ne_10m_lakes_europe', 'ne_10m_lakes_north_america'],
    'sommets': ['ne_10m_geography_regions_elevation_points'],
    'massifs': ['ne_10m_geography_regions_polys'],
}


def telecharger(nom):
    for base in BASES:
        url = base + nom + '.geojson'
        for essai in range(3):
            try:
                req = urllib.request.Request(url, headers={'User-Agent': 'atlas-du-ciel (github.com/damballah)'})
                with urllib.request.urlopen(req, timeout=120) as r:
                    data = json.loads(r.read().decode('utf-8'))
                print(f'  {nom} : {len(data.get("features", []))} éléments')
                return data.get('features', [])
            except Exception as e:  # noqa: BLE001
                print(f'  {nom} : essai {essai + 1} échoué ({e})')
    print(f'::warning::{nom} indisponible, ignoré')
    return []


def props(f):
    return {str(k).lower(): v for k, v in (f.get('properties') or {}).items()}


def nom_fr(p):
    for k in ('name_fr', 'name', 'name_en', 'name_alt'):
        v = p.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return ''


def nombre(p, *cles, defaut=None):
    for k in cles:
        v = p.get(k)
        try:
            if v is not None and v != '' and float(v) == float(v):
                return float(v)
        except (TypeError, ValueError):
            pass
    return defaut


def zoom_min(p, defaut_rang=6, decalage=1.0):
    z = nombre(p, 'min_label', 'min_zoom')
    if z is not None and z > 0:
        return round(z, 1)
    rang = nombre(p, 'scalerank', defaut=defaut_rang)
    return round(rang * 0.6 + decalage, 1)


def lignes(geom):
    if not geom:
        return []
    t, c = geom.get('type'), geom.get('coordinates') or []
    if t == 'LineString':
        return [c]
    if t == 'MultiLineString':
        return c
    return []


def polygones(geom):
    if not geom:
        return []
    t, c = geom.get('type'), geom.get('coordinates') or []
    if t == 'Polygon':
        return [c]
    if t == 'MultiPolygon':
        return c
    return []


def simplifier(pts, tol):
    """Douglas-Peucker itératif (pts : [[lon, lat], ...])."""
    if len(pts) < 3:
        return pts
    garde = [False] * len(pts)
    garde[0] = garde[-1] = True
    pile = [(0, len(pts) - 1)]
    while pile:
        a, b = pile.pop()
        ax, ay = pts[a][0], pts[a][1]
        bx, by = pts[b][0], pts[b][1]
        dx, dy = bx - ax, by - ay
        n2 = dx * dx + dy * dy
        dmax, imax = -1.0, -1
        for i in range(a + 1, b):
            px, py = pts[i][0] - ax, pts[i][1] - ay
            if n2 > 0:
                u = max(0.0, min(1.0, (px * dx + py * dy) / n2))
                ex, ey = px - u * dx, py - u * dy
            else:
                ex, ey = px, py
            d = ex * ex + ey * ey
            if d > dmax:
                dmax, imax = d, i
        if imax > 0 and dmax > tol * tol:
            garde[imax] = True
            pile.append((a, imax))
            pile.append((imax, b))
    return [p for p, g in zip(pts, garde) if g]


def dist_deg(a, b):
    """Distance approchée en degrés (longitude corrigée par la latitude)."""
    k = math.cos(math.radians((a[1] + b[1]) / 2))
    return math.hypot((b[0] - a[0]) * k, b[1] - a[1])


def centre_polygone(anneau):
    """Centre de gravité d'un anneau [[lon, lat], ...] et son aire (en degrés²)."""
    a = cx = cy = 0.0
    for i in range(len(anneau) - 1):
        x0, y0 = anneau[i][0], anneau[i][1]
        x1, y1 = anneau[i + 1][0], anneau[i + 1][1]
        c = x0 * y1 - x1 * y0
        a += c
        cx += (x0 + x1) * c
        cy += (y0 + y1) * c
    if abs(a) < 1e-12:
        xs = [p[0] for p in anneau]
        ys = [p[1] for p in anneau]
        return (sum(xs) / len(xs), sum(ys) / len(ys)), 0.0
    return (cx / (3 * a), cy / (3 * a)), abs(a) / 2


def r3(v):
    return round(v, 3)


def traiter_rivieres(features):
    groupes, traits = {}, []
    for f in features:
        p = props(f)
        cla = str(p.get('featurecla') or '').lower()
        z = zoom_min(p, 8, 1.5)
        for ligne in lignes(f.get('geometry')):
            pts = [q[:2] for q in ligne if len(q) >= 2]
            if len(pts) < 2:
                continue
            tol = 0.004 if z >= 6 else 0.008
            s = simplifier(pts, tol)
            traits.append([z, [v for q in s for v in (r3(q[1]), r3(q[0]))]])
            nom = nom_fr(p)
            if not nom or 'lake centerline' in cla:
                continue   # les lacs sont nommés à part
            typ = 'canal' if 'canal' in cla else ('intermittent' if 'intermittent' in cla else 'riviere')
            g = groupes.setdefault(nom, {'z': z, 'type': typ, 'lignes': []})
            g['z'] = min(g['z'], z)
            g['lignes'].append(pts)
    rivieres = []
    for nom, g in groupes.items():
        total = sum(dist_deg(l[i], l[i + 1]) for l in g['lignes'] for i in range(len(l) - 1))
        if total <= 0:
            continue
        pas = max(0.6, min(4.0, total / 6))   # 6 noms au plus par cours d'eau à grande échelle
        points, cumul, prochain = [], 0.0, pas / 2
        for l in g['lignes']:
            for i in range(len(l) - 1):
                d = dist_deg(l[i], l[i + 1])
                while d > 0 and cumul + d >= prochain:
                    u = (prochain - cumul) / d
                    points += [r3(l[i][1] + (l[i + 1][1] - l[i][1]) * u), r3(l[i][0] + (l[i + 1][0] - l[i][0]) * u)]
                    prochain += pas
                cumul += d
        if not points:
            m = g['lignes'][0][len(g['lignes'][0]) // 2]
            points = [r3(m[1]), r3(m[0])]
        rivieres.append([nom, g['z'], g['type'], points[:60]])
    rivieres.sort(key=lambda r: r[1])
    traits.sort(key=lambda t: t[0])
    return rivieres, traits


def traiter_lacs(features):
    vus, lacs = set(), []
    for f in features:
        p = props(f)
        nom = nom_fr(p)
        if not nom:
            continue
        meilleur = None
        for poly in polygones(f.get('geometry')):
            if not poly or len(poly[0]) < 4:
                continue
            c, aire = centre_polygone(poly[0])
            if meilleur is None or aire > meilleur[1]:
                meilleur = (c, aire)
        if not meilleur:
            continue
        (lon, lat), aire = meilleur
        cle = (nom, round(lat), round(lon))
        if cle in vus:
            continue
        vus.add(cle)
        z = zoom_min(p, 8, 1.5)
        lacs.append([nom, z, r3(lat), r3(lon)])
    lacs.sort(key=lambda l: l[1])
    return lacs


def traiter_sommets(features):
    sommets = []
    for f in features:
        p = props(f)
        cla = str(p.get('featurecla') or '').lower()
        if cla not in ('mountain', 'peak', 'volcano'):
            continue
        nom = nom_fr(p)
        g = f.get('geometry') or {}
        if not nom or g.get('type') != 'Point':
            continue
        lon, lat = g['coordinates'][:2]
        alt = nombre(p, 'elevation', 'elev', defaut=0) or 0
        sommets.append([nom, zoom_min(p, 6, 2.5), r3(lat), r3(lon), int(round(alt))])
    sommets.sort(key=lambda s: (s[1], -s[4]))
    return sommets


def traiter_massifs(features):
    massifs = []
    for f in features:
        p = props(f)
        cla = str(p.get('featurecla') or '').lower()
        if cla not in ('range/mtn', 'range', 'mountain range'):
            continue
        nom = nom_fr(p)
        if not nom:
            continue
        lx, ly = nombre(p, 'label_x'), nombre(p, 'label_y')
        if lx is None or ly is None:
            meilleur = None
            for poly in polygones(f.get('geometry')):
                if poly and len(poly[0]) >= 4:
                    c, aire = centre_polygone(poly[0])
                    if meilleur is None or aire > meilleur[1]:
                        meilleur = (c, aire)
            if not meilleur:
                continue
            lx, ly = meilleur[0]
        massifs.append([nom, zoom_min(p, 4, 1.0), r3(ly), r3(lx)])
    massifs.sort(key=lambda m: m[1])
    return massifs


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', default='noms')
    ap.add_argument('--local', help='dossier contenant déjà les .geojson (tests)')
    a = ap.parse_args()

    def charger(nom):
        if a.local:
            chemin = os.path.join(a.local, nom + '.geojson')
            if not os.path.exists(chemin):
                return []
            with open(chemin, encoding='utf-8') as fh:
                return json.load(fh).get('features', [])
        return telecharger(nom)

    print('Téléchargement de Natural Earth…')
    src = {k: [f for n in v for f in charger(n)] for k, v in FICHIERS.items()}
    if not any(src.values()):
        print('::error::aucune donnée Natural Earth récupérée')
        sys.exit(1)
    rivieres, traits = traiter_rivieres(src['rivieres'])
    sortie = {
        'v': 1,
        'source': 'Natural Earth (domaine public), naturalearthdata.com',
        'rivieres': rivieres,
        'lacs': traiter_lacs(src['lacs']),
        'sommets': traiter_sommets(src['sommets']),
        'massifs': traiter_massifs(src['massifs']),
        'traits': traits,
    }
    os.makedirs(a.out, exist_ok=True)
    chemin = os.path.join(a.out, 'noms.json')
    with open(chemin, 'w', encoding='utf-8') as fh:
        json.dump(sortie, fh, ensure_ascii=False, separators=(',', ':'))
    taille = os.path.getsize(chemin) / 1e6
    print(f"noms.json : {len(sortie['rivieres'])} cours d'eau, {len(sortie['lacs'])} lacs, {len(sortie['sommets'])} sommets, "
          f"{len(sortie['massifs'])} massifs, {len(traits)} tracés — {taille:.1f} Mo")


if __name__ == '__main__':
    main()
