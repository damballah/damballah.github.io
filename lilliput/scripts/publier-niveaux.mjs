/*
  Publication automatique des niveaux validés (exécuté par GitHub Actions, toutes les heures).
  1. Récupère dans Supabase les niveaux que tu as acceptés (statut « approved »).
  2. Écrit chaque niveau et sa vignette dans le dossier niveaux/ du dépôt, et met à jour le catalogue.
  3. Enregistre le niveau dans la table « levels » (pour les classements) et vide la boîte de réception.
  La clé de service n'existe que dans les secrets GitHub : elle n'apparaît jamais sur le site.
  Aucune dépendance : Node 20 suffit.
*/
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';

const URL_ = process.env.SUPABASE_URL, KEY = process.env.SUPABASE_SERVICE_KEY;
if (!URL_ || !KEY) { console.error('Secrets SUPABASE_URL et SUPABASE_SERVICE_KEY manquants.'); process.exit(1); }
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
const api = async (path, opts = {}) => {
  const r = await fetch(`${URL_}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const t = await r.text(); return t ? JSON.parse(t) : null;
};

const GEM_PTS = { g: 1, b: 5, r: 10 };
const PLAYER_RUN = 11;   // vitesse de course du jeu (unités par seconde)

// réveille la base au passage (évite la mise en pause après une semaine sans visite)
await api('levels?select=id&limit=1');

const pending = await api('inbox?status=eq.approved&select=id,user_id,name,author,kind,data,thumb,created_at&order=created_at.asc');
if (!pending.length) console.log('Aucun nouveau niveau à publier.');

await mkdir('niveaux', { recursive: true });
let catalogue = [];
try { catalogue = JSON.parse(await readFile('niveaux/catalogue.json', 'utf8')); } catch { catalogue = []; }

for (const row of pending) {
  try {
    const level = JSON.parse(row.data);
    const id = 'c' + row.id.replace(/-/g, '').slice(0, 10);
    const gems = level.items?.gems || [];
    const maxPoints = gems.reduce((s, g) => s + (GEM_PTS[g.c] || 0), 0);
    // temps minimal physiquement possible : distance départ → sortie à pleine course, avec une marge
    const st = level.items?.start || [0, 0], ex = level.items?.exitDoor || [0, 0];
    const minTime = Math.max(3000, Math.round(Math.hypot(ex[0] - st[0], ex[1] - st[1]) / PLAYER_RUN * 1000 * .6));
    Object.assign(level, { id, community: id, name: row.name, author: row.author });
    await writeFile(`niveaux/${id}.json`, JSON.stringify(level));
    if (row.thumb?.startsWith('data:image/jpeg;base64,')) await writeFile(`niveaux/${id}.jpg`, Buffer.from(row.thumb.split(',')[1], 'base64'));
    catalogue = catalogue.filter(e => e.id !== id);
    catalogue.unshift({ id, name: row.name, author: row.author, kind: row.kind, gems: gems.length, maxPoints, date: new Date().toISOString().slice(0, 10), thumb: `${id}.jpg` });
    await api('levels', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ id, name: row.name, author: row.author, author_id: row.user_id, kind: row.kind, gems: gems.length, max_points: maxPoints, min_time_ms: minTime }) });
    await api(`inbox?id=eq.${row.id}`, { method: 'PATCH', body: JSON.stringify({ status: 'published', level_id: id, data: null, thumb: null }) });
    console.log(`Publié : ${row.name} (${id}) par ${row.author}`);
  } catch (e) { console.error(`Échec pour ${row.id} :`, e.message); }
}

// niveaux retirés depuis la page d'administration
const hidden = await api('levels?hidden=eq.true&select=id');
const hiddenIds = new Set(hidden.map(h => h.id));
for (const id of hiddenIds) { await rm(`niveaux/${id}.json`, { force: true }); await rm(`niveaux/${id}.jpg`, { force: true }); }
catalogue = catalogue.filter(e => !hiddenIds.has(e.id));
await writeFile('niveaux/catalogue.json', JSON.stringify(catalogue, null, 1));
