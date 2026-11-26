#!/usr/bin/env python3
"""Données satellites d'Atlas du Ciel, publiées toutes les 3 h par GitHub Actions (tâche « Atlas - satellites »).

Télécharge UNE fois pour tous les visiteurs le catalogue spatial et les orbites, en respectant CelesTrak :
un essai par relevé, catalogue au plus une fois par jour, pause de 24 h après tout refus ;
secours : GCAT (catalogue) et SatNOGS (orbites), puis la dernière copie publiée.
Si rien n'est disponible, le script échoue et la copie déjà en ligne reste en place.
"""
import argparse, datetime, gzip, json, re, sys, time, urllib.error, urllib.request
from pathlib import Path

CT_GP = 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json'
CT_SATCAT = 'https://celestrak.org/pub/satcat.csv'
GCAT = 'https://planet4589.org/space/gcat/tsv/cat/satcat.tsv'
SATNOGS = 'https://db.satnogs.org/api/tle/?format=json'
UA = 'AtlasDuCiel/1.0 (publication GitHub Pages ; une requete toutes les 3 h)'


def log(*a):
    print('[build]', *a, flush=True)


def get(url, timeout=240):
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept-Encoding': 'gzip'})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read()
        if r.headers.get('Content-Encoding') == 'gzip':
            data = gzip.decompress(data)
        return data


def head(b):
    return b[:80].decode('utf-8', 'replace').lstrip('﻿ \r\n\t')


def build_data(out: Path, previous: str, offline_dir: Path | None):
    data = out
    data.mkdir(parents=True, exist_ok=True)
    now = time.time()
    errors = {}
    prev = {}
    prev_base = previous.rstrip('/') if previous else ''
    if prev_base and not offline_dir:
        try:
            prev = json.loads(get(prev_base + '/manifest.json', 60))
            log('manifeste précédent :', prev.get('genere'))
        except Exception as e:
            log('pas de version précédente lisible :', e)
    pause_until = float(prev.get('celestrak_pause_until') or 0)

    def fetch(url):
        if offline_dir:   # tests : fichiers locaux nommés d'après l'URL
            f = offline_dir / re.sub(r'[^A-Za-z0-9]+', '_', url)
            if not f.exists():
                raise urllib.error.HTTPError(url, 404, 'absent (test)', None, None)
            return f.read_bytes()
        return get(url)

    def celestrak(url):
        nonlocal pause_until
        if now < pause_until:
            raise RuntimeError('CelesTrak en pause après un refus, jusqu\'au ' + datetime.datetime.fromtimestamp(pause_until, datetime.timezone.utc).isoformat())
        try:
            return fetch(url)
        except urllib.error.HTTPError as e:   # refus : on arrête de l'interroger pendant 24 h (règle d'usage)
            pause_until = now + 86400
            raise RuntimeError(f'refus HTTP {e.code} : pause de 24 h')

    def reuse_previous(name, key, label):
        if not prev.get(key) or not prev_base:
            return None
        b = get(prev_base + '/' + prev[key])
        (data / prev[key]).write_bytes(b)
        log(label, ': copie précédente réutilisée', prev[key])
        return prev[key], prev.get(key + '_source', '?'), prev.get(key + '_date', prev.get('genere'))

    def age_h(key):
        try:
            return (now - datetime.datetime.fromisoformat(prev[key + '_date']).timestamp()) / 3600
        except Exception:
            return 1e9

    result = {}
    # ---------- orbites précises des satellites actifs
    got = None
    if prev.get('satellites_source') == 'CelesTrak' and age_h('satellites') < 2:
        try: got = reuse_previous('gp', 'satellites', 'orbites')
        except Exception as e: errors['satellites'] = 'copie précédente : ' + str(e)
    if not got:
        try:
            b = celestrak(CT_GP)
            if len(b) > 200 and head(b).startswith('['):
                (data / 'gp.json').write_bytes(b); got = ('gp.json', 'CelesTrak', None)
            else:
                errors['satellites'] = 'CelesTrak : ' + head(b)
        except Exception as e:
            errors['satellites'] = 'CelesTrak : ' + str(e)
    if not got:
        try:
            b = fetch(SATNOGS)
            if len(b) > 200 and head(b).startswith('['):
                (data / 'gp.json').write_bytes(b); got = ('gp.json', 'SatNOGS (secours)', None)
            else:
                errors['secours satellites'] = 'SatNOGS : ' + head(b)
        except Exception as e:
            errors['secours satellites'] = 'SatNOGS : ' + str(e)
    if not got and not offline_dir:
        try: got = reuse_previous('gp', 'satellites', 'orbites')
        except Exception as e: errors['secours satellites'] += ' ; copie précédente : ' + str(e)
    if got:
        result.update(satellites=got[0], satellites_source=got[1], satellites_date=got[2] or datetime.datetime.now(datetime.timezone.utc).isoformat())

    # ---------- catalogue historique (une fois par jour au plus)
    got = None
    if prev.get('catalogue') and age_h('catalogue') < 20:
        try: got = reuse_previous('cat', 'catalogue', 'catalogue')
        except Exception as e: errors['catalogue'] = 'copie précédente : ' + str(e)
    if not got:
        try:
            b = celestrak(CT_SATCAT)
            if len(b) > 200 and head(b).startswith('OBJECT_NAME'):
                (data / 'catalogue.csv').write_bytes(b); got = ('catalogue.csv', 'CelesTrak', None)
            else:
                errors['catalogue'] = 'CelesTrak : ' + head(b)
        except Exception as e:
            errors['catalogue'] = 'CelesTrak : ' + str(e)
    if not got:
        try:
            b = fetch(GCAT)
            if len(b) > 200 and head(b).startswith('#'):
                (data / 'catalogue.tsv').write_bytes(b); got = ('catalogue.tsv', 'GCAT (secours)', None)
            else:
                errors['secours catalogue'] = 'GCAT : ' + head(b)
        except Exception as e:
            errors['secours catalogue'] = 'GCAT : ' + str(e)
    if not got and not offline_dir:
        try: got = reuse_previous('cat', 'catalogue', 'catalogue')
        except Exception as e: errors.setdefault('secours catalogue', ''); errors['secours catalogue'] += ' ; copie précédente : ' + str(e)
    if got:
        result.update(catalogue=got[0], catalogue_source=got[1], catalogue_date=got[2] or datetime.datetime.now(datetime.timezone.utc).isoformat())

    manifest = {'genere': datetime.datetime.now(datetime.timezone.utc).isoformat(), **result,
                'erreurs': errors, 'celestrak_pause_until': pause_until}
    (data / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding='utf-8')
    for k, v in errors.items():
        log('avertissement', k, ':', v)
    if 'satellites' not in result and 'catalogue' not in result:
        log('ÉCHEC : aucune donnée satellite disponible ; la version en ligne reste inchangée.')
        sys.exit(1)
    log('données :', json.dumps(result, ensure_ascii=False))



def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--out', required=True)
    ap.add_argument('--previous', default='', help='adresse des données déjà publiées')
    ap.add_argument('--offline', default='', help='(tests) dossier simulant les téléchargements')
    a = ap.parse_args()
    build_data(Path(a.out), a.previous, Path(a.offline) if a.offline else None)
    log('données prêtes dans', a.out)


if __name__ == '__main__':
    main()
