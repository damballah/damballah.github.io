/*
  Configuration du site Lilliput.
  Copie ici les deux valeurs de ton projet Supabase (Réglages du projet → API) :
  - l'URL du projet ;
  - la clé « anon » (publique par conception : la sécurité repose sur les règles de la base).
  Ne mets JAMAIS ici la clé « service_role » : elle reste dans les secrets GitHub.
*/
window.LILLIPUT_CONFIG = {
  supabaseUrl: 'https://nozknmznfexvswlcsttx.supabase.co',        // ex. 'https://abcdefghijkl.supabase.co'
  supabaseAnonKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im5vemtubXpuZmV4dnN3bGNzdHR4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQ0MTkyMjAsImV4cCI6MjEwOTk5NTIyMH0.3mT2O856ALPT6ocSVoBGwC7hTkeZs-JfcmWQK37hxdI',    // ex. 'eyJhbGciOi...'
};
