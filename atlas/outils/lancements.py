#!/usr/bin/env python3
"""Atlas du Ciel : prochains lancements de fusées et leurs retransmissions (The Space Devs, Launch Library 2).

L'API gratuite accepte 15 appels par heure et par adresse. GitHub fait ici 2 appels par heure
(à venir + récents) et publie un petit fichier lancements.json : les visiteurs du site lisent ce
fichier au lieu d'interroger l'API chacun de leur côté, comme le recommande The Space Devs.

Usage : python3 lancements.py --out DOSSIER   (écrit DOSSIER/lancements.json ; garde l'ancien en cas d'échec)
"""
import argparse, json, os, sys, time, urllib.request

API = 'https://ll.thespacedevs.com/2.3.0/launches/'
UA = 'AtlasDuCiel/1.0 (github.com; visualisation non commerciale)'


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.load(r)


def num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def name_of(x, *keys):
    """Lit un champ qui peut être un texte ou un objet (l'API a changé de forme entre ses versions)."""
    if isinstance(x, str):
        return x
    if isinstance(x, dict):
        for k in keys + ('name',):
            v = x.get(k)
            if isinstance(v, str) and v:
                return v
    return None


def compact(l):
    pad = l.get('pad') or {}
    loc = pad.get('location') or {}
    rocket = (l.get('rocket') or {}).get('configuration') or {}
    mission = l.get('mission') or {}
    status = l.get('status') or {}
    country = pad.get('country') or loc.get('country') or {}
    vids = []
    for v in l.get('vid_urls') or []:
        if not isinstance(v, dict) or not v.get('url'):
            continue
        vids.append({
            'url': v['url'],
            'titre': v.get('title') or '',
            'source': name_of(v.get('publisher')) or v.get('source') or '',
            'langue': name_of(v.get('language')) or '',
            'live': bool(v.get('live')),
            'priorite': v.get('priority') if isinstance(v.get('priority'), int) else 99,
        })
    vids.sort(key=lambda v: v['priorite'])
    return {
        'id': l.get('id'),
        'nom': l.get('name') or '',
        'net': l.get('net'),
        'fenetre': [l.get('window_start'), l.get('window_end')],
        'precision': name_of(l.get('net_precision')),
        'statut': status.get('abbrev') or '',
        'statut_nom': status.get('name') or '',
        'operateur': name_of(l.get('launch_service_provider')) or '',
        'fusee': rocket.get('full_name') or rocket.get('name') or '',
        'mission': mission.get('name') or '',
        'description': (mission.get('description') or '')[:600],
        'orbite': name_of(mission.get('orbit')) or '',
        'pas_de_tir': pad.get('name') or '',
        'lieu': loc.get('name') or '',
        'pays': (country.get('alpha_2_code') if isinstance(country, dict) else None) or loc.get('country_code') or '',
        'lat': num(pad.get('latitude')),
        'lon': num(pad.get('longitude')),
        'direct': bool(l.get('webcast_live')),
        'image': name_of(l.get('image'), 'thumbnail_url', 'image_url') or '',
        'videos': vids[:6],
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    out = {'genere': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'source': 'The Space Devs – Launch Library 2'}
    ok = False
    for key, url in (('a_venir', API + 'upcoming/?mode=detailed&limit=20&hide_recent_previous=true'),
                     ('recents', API + 'previous/?mode=detailed&limit=6')):
        try:
            out[key] = [compact(l) for l in get(url).get('results', [])]
            ok = True
            print(f'[lancements] {key} : {len(out[key])}')
        except Exception as e:   # noqa: BLE001 - on garde la liste précédente
            print(f'[lancements] {key} : {e}', file=sys.stderr)
            out[key] = None
    path = os.path.join(a.out, 'lancements.json')
    if os.path.exists(path):
        try:
            old = json.load(open(path, encoding='utf-8'))
            for key in ('a_venir', 'recents'):
                if out[key] is None:
                    out[key] = old.get(key) or []
        except Exception:   # noqa: BLE001
            pass
    for key in ('a_venir', 'recents'):
        out[key] = out[key] or []
    if not ok and not os.path.exists(path):
        print('[lancements] aucune donnée', file=sys.stderr)
        return 0   # sans gravité : la météo est publiée quand même
    json.dump(out, open(path, 'w', encoding='utf-8'), ensure_ascii=False, separators=(',', ':'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
