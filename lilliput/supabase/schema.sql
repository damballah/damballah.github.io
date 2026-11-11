-- =====================================================================
--  LILLIPUT : base de données Supabase
--  À coller en entier dans « SQL Editor » de ton projet Supabase, puis « Run ».
--  Toutes les tables sont protégées par des règles d'accès (RLS) :
--  la clé publique du site ne permet que ce qui est explicitement autorisé ici.
-- =====================================================================

-- ---------- Joueurs : un pseudo par compte (compte anonyme créé automatiquement par le jeu)
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  pseudo text not null unique check (pseudo ~ '^[A-Za-z0-9_À-ÿ-]{3,20}$'),
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
create policy "pseudos visibles par tous" on public.profiles for select using (true);
create policy "chacun crée son profil" on public.profiles for insert with check (auth.uid() = id);
create policy "chacun modifie son profil" on public.profiles for update using (auth.uid() = id);

-- ---------- Administrateurs (toi) : ajoutés à la main, voir le guide
create table if not exists public.admins (user_id uuid primary key references auth.users on delete cascade);
alter table public.admins enable row level security;
create policy "un admin se voit" on public.admins for select using (auth.uid() = user_id);

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;
grant execute on function public.is_admin() to anon, authenticated;

-- ---------- Boîte de réception : niveaux proposés, en attente de modération
create table if not exists public.inbox (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  name text not null check (char_length(name) between 1 and 40),
  author text not null check (char_length(author) between 3 and 20),
  kind text not null default 'drawing' check (kind in ('drawing', 'photo')),
  data text check (data is null or octet_length(data) < 4500000),       -- le niveau (JSON), vidé après publication
  thumb text check (thumb is null or octet_length(thumb) < 250000),     -- vignette JPEG
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'published')),
  level_id text,
  created_at timestamptz not null default now()
);
alter table public.inbox enable row level security;
create policy "déposer un niveau" on public.inbox for insert with check (auth.uid() = user_id and status = 'pending');
create policy "voir ses envois, ou tout si admin" on public.inbox for select using (auth.uid() = user_id or public.is_admin());
create policy "seul l'admin modère" on public.inbox for update using (public.is_admin());
create policy "seul l'admin supprime" on public.inbox for delete using (public.is_admin());

-- limite : 5 niveaux proposés par jour et par joueur, et un pseudo obligatoire
create or replace function public.inbox_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = new.user_id) then raise exception 'Choisis un pseudo avant de partager'; end if;
  if (select count(*) from public.inbox where user_id = new.user_id and created_at > now() - interval '1 day') >= 5 then
    raise exception 'Limite atteinte : 5 niveaux proposés par jour';
  end if;
  return new;
end $$;
drop trigger if exists inbox_guard on public.inbox;
create trigger inbox_guard before insert on public.inbox for each row execute function public.inbox_guard();

-- ---------- Niveaux publiés (remplis par la publication automatique, jamais par le site)
create table if not exists public.levels (
  id text primary key,
  name text not null,
  author text,
  author_id uuid,
  kind text,
  gems int not null default 0,
  max_points int not null,          -- total des gemmes : un score ne peut pas le dépasser
  min_time_ms int not null default 3000,  -- temps le plus court physiquement possible
  hidden boolean not null default false,
  published_at timestamptz not null default now()
);
alter table public.levels enable row level security;
create policy "niveaux visibles par tous" on public.levels for select using (true);
-- aucune règle d'écriture : seule la clé de service (publication automatique) peut écrire

-- ---------- Scores : écriture uniquement via l'arbitre submit_score
create table if not exists public.scores (
  id bigserial primary key,
  level_id text not null references public.levels on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  points int not null,
  time_ms int not null,
  perfect boolean not null default false,
  items boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists scores_level_idx on public.scores (level_id, created_at);
alter table public.scores enable row level security;
create policy "scores visibles par tous" on public.scores for select using (true);

-- L'ARBITRE : vérifie chaque score avant de l'enregistrer
create or replace function public.submit_score(p_level text, p_points int, p_time_ms int, p_perfect boolean, p_items boolean)
returns void language plpgsql security definer set search_path = public as $$
declare lv public.levels; last_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Non connecté'; end if;
  if not exists (select 1 from public.profiles where id = auth.uid()) then raise exception 'Choisis un pseudo'; end if;
  select * into lv from public.levels where id = p_level and not hidden;
  if not found then raise exception 'Niveau inconnu'; end if;
  if p_points < 0 or p_points > lv.max_points then raise exception 'Score impossible pour ce niveau'; end if;
  if p_time_ms < lv.min_time_ms or p_time_ms > 7200000 then raise exception 'Temps impossible pour ce niveau'; end if;
  if p_perfect and p_points <> lv.max_points then raise exception 'Niveau parfait impossible avec ce score'; end if;
  select max(created_at) into last_at from public.scores where user_id = auth.uid();
  if last_at is not null and last_at > now() - interval '15 seconds' then raise exception 'Trop de scores envoyés, patiente un peu'; end if;
  insert into public.scores (level_id, user_id, points, time_ms, perfect, items) values (p_level, auth.uid(), p_points, p_time_ms, p_perfect, p_items);
end $$;
revoke all on function public.submit_score(text, int, int, boolean, boolean) from public, anon;
grant execute on function public.submit_score(text, int, int, boolean, boolean) to authenticated;

-- Début de période pour les classements
create or replace function public.period_start(p_period text) returns timestamptz language sql stable as $$
  select case p_period
    when 'jour' then date_trunc('day', now())
    when 'semaine' then date_trunc('week', now())
    when 'mois' then date_trunc('month', now())
    when 'annee' then date_trunc('year', now())
    else '-infinity'::timestamptz end;
$$;

-- Classement d'un niveau : meilleur score de chaque joueur sur la période
create or replace function public.classement(p_level text, p_period text default 'tout')
returns table (rang int, pseudo text, points int, time_ms int, perfect boolean, items boolean, created_at timestamptz)
language sql stable security definer set search_path = public as $$
  with best as (
    select distinct on (s.user_id) s.* from public.scores s
    where s.level_id = p_level and s.created_at >= public.period_start(p_period)
    order by s.user_id, s.points desc, s.time_ms asc
  )
  select (row_number() over (order by b.points desc, b.time_ms asc))::int, p.pseudo, b.points, b.time_ms, b.perfect, b.items, b.created_at
  from best b join public.profiles p on p.id = b.user_id
  order by 1 limit 50;
$$;
grant execute on function public.classement(text, text) to anon, authenticated;

-- Classement général : total des meilleurs scores de chaque joueur sur tous les niveaux
create or replace function public.classement_general(p_period text default 'semaine')
returns table (rang int, pseudo text, niveaux int, parfaits int, total int)
language sql stable security definer set search_path = public as $$
  with best as (
    select distinct on (s.user_id, s.level_id) s.* from public.scores s
    join public.levels l on l.id = s.level_id and not l.hidden
    where s.created_at >= public.period_start(p_period)
    order by s.user_id, s.level_id, s.points desc, s.time_ms asc
  )
  select (row_number() over (order by sum(b.points) desc, count(*) filter (where b.perfect) desc))::int, p.pseudo,
         count(*)::int, (count(*) filter (where b.perfect))::int, sum(b.points)::int
  from best b join public.profiles p on p.id = b.user_id
  group by p.pseudo order by 1 limit 50;
$$;
grant execute on function public.classement_general(text) to anon, authenticated;

-- ---------- Notes (1 à 5 étoiles), une par joueur et par niveau
create table if not exists public.votes (
  level_id text not null references public.levels on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  stars int not null check (stars between 1 and 5),
  created_at timestamptz not null default now(),
  primary key (level_id, user_id)
);
alter table public.votes enable row level security;
create policy "notes visibles par tous" on public.votes for select using (true);
create policy "chacun note" on public.votes for insert with check (auth.uid() = user_id);
create policy "chacun change sa note" on public.votes for update using (auth.uid() = user_id);

create or replace view public.level_stats with (security_invoker = on) as
  select level_id, round(avg(stars)::numeric, 1) as moyenne, count(*)::int as votes from public.votes group by level_id;

-- ---------- Commentaires (facultatifs), modérables par l'admin
create table if not exists public.comments (
  id bigserial primary key,
  level_id text not null references public.levels on delete cascade,
  user_id uuid not null default auth.uid() references public.profiles on delete cascade,
  body text not null check (char_length(body) between 1 and 300),
  created_at timestamptz not null default now()
);
alter table public.comments enable row level security;
create policy "commentaires visibles par tous" on public.comments for select using (true);
create policy "chacun commente" on public.comments for insert with check (auth.uid() = user_id);
create policy "auteur ou admin supprime" on public.comments for delete using (auth.uid() = user_id or public.is_admin());

create or replace function public.comment_guard() returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.comments where user_id = new.user_id and created_at > now() - interval '30 seconds') then
    raise exception 'Un commentaire toutes les 30 secondes au maximum';
  end if;
  return new;
end $$;
drop trigger if exists comment_guard on public.comments;
create trigger comment_guard before insert on public.comments for each row execute function public.comment_guard();
