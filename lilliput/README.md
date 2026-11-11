# Lilliput

Dessine un niveau sur une feuille, prends-le en photo, et parcours-le en 3D à la taille d'une fourmi.

Le site fonctionne avec deux services gratuits :

- **GitHub Pages** héberge le site, le jeu et la galerie des niveaux partagés (dossier `niveaux/`).
- **Supabase** (open source) garde les pseudos, les scores, les votes, les commentaires et la boîte de réception des niveaux proposés.

Une tâche automatique de GitHub publie toutes les heures les niveaux que tu as acceptés, et réveille la base au passage (Supabase met en pause les projets gratuits après une semaine sans visite).

## Contenu du dépôt

| Chemin | Rôle |
|---|---|
| `index.html` | Page d'accueil du site |
| `jeu/` | Le jeu |
| `admin/` | Ta page de modération |
| `niveaux/` | Galerie publique, remplie automatiquement |
| `config.js` | Les deux valeurs publiques de Supabase, à remplir |
| `supabase/schema.sql` | La base de données et ses règles de sécurité |
| `scripts/publier-niveaux.mjs` et `.github/workflows/` | La publication automatique |

---

## Installation (environ 20 minutes, une seule fois)

### 1. Mettre le site sur GitHub

1. Sur github.com, connecté à ton compte, crée un nouveau dépôt **public** nommé `lilliput`.
2. Dépose dedans tout le contenu de ce dossier, en gardant les sous-dossiers, y compris le dossier caché `.github`. Le plus simple : bouton « Add file », puis « Upload files », puis glisser-déposer.
3. Dans le dépôt : **Settings**, puis **Pages**. Source : « Deploy from a branch », branche `main`, dossier `/ (root)`. Enregistre.
4. Après une ou deux minutes, le site est en ligne sur `https://damballah.github.io/lilliput/`.

À ce stade, le jeu marche déjà, mais sans les fonctions en ligne.

### 2. Créer la base de données

1. Sur supabase.com, crée un compte gratuit puis un nouveau projet (choisis une région en Europe et note le mot de passe de la base).
2. Ouvre **SQL Editor**, colle tout le contenu de `supabase/schema.sql`, puis clique sur **Run**. Ce script ne doit être lancé qu'une fois.
3. Dans **Authentication**, puis les réglages des fournisseurs de connexion (« Sign In / Providers »), active **Anonymous sign-ins**. C'est ce qui permet aux joueurs d'avoir un pseudo sans créer de compte.
4. Dans les réglages du projet, rubrique **API** (ou « Data API »), copie :
   - l'**URL du projet** ;
   - la clé **anon** (publique).
5. Colle ces deux valeurs dans `config.js`, puis remplace ce fichier sur GitHub.

> La clé **anon** peut être publique : la base n'autorise que ce que les règles du fichier `schema.sql` permettent. La clé **service_role**, elle, ne doit **jamais** apparaître sur le site (étape 4).

### 3. Créer ton compte de modérateur

1. Dans Supabase : **Authentication**, puis **Users**, puis **Add user**. Saisis ton e-mail et un mot de passe solide, et coche la confirmation automatique si elle est proposée.
2. Copie l'identifiant (UUID) de cet utilisateur.
3. Dans **SQL Editor**, lance :
   ```sql
   insert into public.admins (user_id) values ('COLLE-ICI-TON-UUID');
   ```
4. Ta page de modération est sur `https://damballah.github.io/lilliput/admin/`.

### 4. Activer la publication automatique

1. Dans Supabase, rubrique **API**, copie la clé **service_role** (secrète).
2. Sur GitHub, dans le dépôt : **Settings**, puis **Secrets and variables**, puis **Actions**, puis **New repository secret**. Crée deux secrets :
   - `SUPABASE_URL` : l'URL du projet ;
   - `SUPABASE_SERVICE_KEY` : la clé service_role.
3. Onglet **Actions** du dépôt : si GitHub le demande, autorise les workflows. Lance « Publier les niveaux » une première fois à la main (« Run workflow ») pour vérifier que tout est vert.

C'est terminé.

---

## Au quotidien

- **Modérer :** ouvre `/admin/`. Teste chaque niveau proposé dans le jeu avec « Tester », puis accepte ou refuse. Un niveau accepté apparaît dans la galerie dans l'heure, ou tout de suite si tu lances la tâche « Publier les niveaux » à la main.
- **Retirer un niveau publié :** onglet « Publiés », bouton « Retirer ». Il disparaît de la galerie et des classements à la publication suivante.
- **Commentaires :** onglet « Commentaires », bouton « Supprimer ».

## Sécurité et limites à connaître

- Chaque table est protégée : un joueur ne peut modifier que son propre profil, ses notes et ses commentaires. Seul l'administrateur modère.
- Les scores passent par un **arbitre côté serveur** (`submit_score`) qui refuse ce qui est impossible : plus de points que le niveau n'en contient, un temps plus court que le trajet le plus rapide possible, un « parfait » incohérent, ou des envois trop rapprochés. Un tricheur très déterminé pourrait encore envoyer un score *plausible* : c'est la limite de tout jeu qui tourne dans le navigateur.
- Limites anti-abus : 5 niveaux proposés par jour et par joueur, un commentaire toutes les 30 secondes.
- Le pseudo est lié au navigateur (compte anonyme). Changer d'appareil ou effacer ses données de navigation fait repartir de zéro.
- Offre gratuite Supabase : 500 Mo de base de données (des centaines de milliers de scores). GitHub Pages : 1 Go de site et 100 Go de trafic par mois (environ 2 000 niveaux).
