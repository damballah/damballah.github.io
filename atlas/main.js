// =====================================================================
//  ATLAS DU CIEL — globe 3D des avions et satellites, de 1900 à aujourd'hui
// =====================================================================
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TrackballControls } from 'three/addons/controls/TrackballControls.js';

THREE.ColorManagement.enabled = false;

// ------------------------------------------------------------------ constantes
const RE_KM = 6371.0;            // rayon visuel de la Terre (1 unité 3D)
const RE_EQ = 6378.137;          // rayon équatorial (orbites)
const MU = 398600.4418;          // km³/s²
const J2 = 1.08262668e-3;
const DAY = 86400000, YEAR = 365.25 * DAY;
const TWO_PI = Math.PI * 2, D2R = Math.PI / 180, R2D = 180 / Math.PI;
const T_START = Date.UTC(1900, 0, 1);
const LIVE_WINDOW = 15 * 60000;  // les avions réels sont affichés si on est à moins de 15 min du présent

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const nf = new Intl.NumberFormat('fr-FR');
const nf1 = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* stockage indisponible */ } };

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function interp(table, x) {
  if (x <= table[0][0]) return table[0][1];
  for (let i = 1; i < table.length; i++) {
    if (x <= table[i][0]) {
      const [x0, y0] = table[i - 1], [x1, y1] = table[i];
      return y0 + (y1 - y0) * (x - x0) / (x1 - x0);
    }
  }
  return table[table.length - 1][1];
}
const yearFrac = (ms) => 1970 + ms / YEAR;
const parseDay = (s) => (s && s.length >= 10) ? Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) : NaN;

// ------------------------------------------------------------------ accès aux données
// Appli Windows : tout passe par le serveur local (/api/...).
// Version web (GitHub Pages, window.ATLAS_WEB) : 100 % GitHub. Les données sont publiées par
// GitHub Actions sur deux branches du dépôt, lues ici via raw.githubusercontent.com :
//   - satellites (toutes les 3 h)  : window.ATLAS_DONNEES
//   - avions (toutes les 5 min)    : window.ATLAS_AVIONS
// (le navigateur ne peut pas interroger OpenSky lui-même : OpenSky refuse les appels venant d'une page web)
const WEB = !!window.ATLAS_WEB;
const DONNEES = window.ATLAS_DONNEES || 'data/';
const AVIONS = window.ATLAS_AVIONS || 'data/';
const SETTINGS_DEF = { planesRefresh: 60, imagerie: 'eox' };
function loadSettings() { try { return { ...SETTINGS_DEF, ...JSON.parse(lsGet('atlas.settings') || '{}') }; } catch { return { ...SETTINGS_DEF }; } }
let settings = loadSettings();
const jsonResponse = (obj, status = 200) => new Response(typeof obj === 'string' ? obj : JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
async function tryFetch(url, opts = {}, timeoutMs = 20000) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), timeoutMs);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); } finally { clearTimeout(tm); }
}
let manifestP = null;
const getManifest = (fresh) => ((!manifestP || fresh) ? (manifestP = tryFetch(DONNEES + 'manifest.json?t=' + Math.floor(Date.now() / 600000), { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null)) : manifestP);
let planesSnapshotTime = 0;
async function api(path) {
  if (!WEB) return fetch(path, { cache: 'no-store' });
  const u = new URL(path, location.href), p = u.pathname.replace(/^.*\/api\//, '/api/'), q = (k) => u.searchParams.get(k) || '';
  try {
    switch (p) {
      case '/api/catalogue':
      case '/api/satellites': {
        const m = await getManifest(p === '/api/catalogue');
        const f = m && (p === '/api/catalogue' ? m.catalogue : m.satellites);
        return f ? tryFetch(DONNEES + f + '?t=' + encodeURIComponent(m.genere || ''), {}, 120000) : jsonResponse('null', 502);
      }
      case '/api/etat': { const m = await getManifest(); return jsonResponse({ erreurs: (m && m.erreurs) || {}, celestrak: null, distant: true, web: true, manifest: m }); }
      case '/api/celestrak_reessayer': return jsonResponse({ ok: false }, 403);
      case '/api/avions': {
        const refresh = clamp(+settings.planesRefresh || 60, 30, 600);
        const r = await tryFetch(AVIONS + 'avions.json?t=' + Math.floor(Date.now() / 60000), { cache: 'no-store' }, 60000);
        if (!r.ok) return jsonResponse({ auth: false, refresh, fetched: 0, message: 'Instantané des avions pas encore publié (la tâche GitHub « Données avions » doit tourner au moins une fois).', data: null });
        const j = await r.json();
        planesSnapshotTime = j.time || 0;
        const ageMin = Math.round((Date.now() / 1000 - planesSnapshotTime) / 60);
        return jsonResponse({ auth: !!j.auth, refresh, fetched: j.time, data: { time: j.time, states: j.states },
          message: ageMin > 25 ? `Les positions des avions datent de ${ageMin} min : GitHub n'a pas pu prendre de nouvel instantané depuis (tâches retardées ou quota OpenSky).` : '' });
      }
      case '/api/trajet': return jsonResponse('null');   // OpenSky refuse les appels du navigateur : traînée = instantanés successifs
      case '/api/vol': {
        const hex = q('hex'), cs = q('cs');
        if (!/^[0-9a-fA-F]{6}$/.test(hex)) return jsonResponse('null');
        const r = await tryFetch(`https://api.adsbdb.com/v0/aircraft/${hex.toUpperCase()}${/^[A-Z0-9]{2,8}$/.test(cs) ? '?callsign=' + cs : ''}`);
        return r.ok ? r : jsonResponse('null');
      }
      case '/api/gp': {   // orbite d'un objet hors liste publiée : SatNOGS puis TLE API (jamais CelesTrak depuis les visiteurs)
        const n = q('catnr'); if (!/^\d{1,9}$/.test(n)) return jsonResponse('null');
        try { const r = await tryFetch(`https://db.satnogs.org/api/tle/?norad_cat_id=${n}&format=json`); if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) return jsonResponse(j); } } catch { /* suivant */ }
        const r2 = await tryFetch('https://tle.ivanstanojevic.me/api/tle/' + n);
        return r2.ok ? r2 : jsonResponse('null');
      }
      case '/api/geocode': {
        const qq = q('q'); if (qq.length < 2) return jsonResponse('[]');
        try { const r = await tryFetch('https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&accept-language=fr&q=' + encodeURIComponent(qq)); if (r.ok) { const j = await r.json(); if (Array.isArray(j) && j.length) return jsonResponse(j); } } catch { /* suivant */ }
        const r3 = await tryFetch('https://data.geopf.fr/geocodage/search?limit=5&q=' + encodeURIComponent(qq));
        return r3.ok ? r3 : jsonResponse('null');
      }
    }
  } catch { return jsonResponse('null', 502); }
  return jsonResponse('null', 404);
}

// ------------------------------------------------------------------ astronomie
const julian = (ms) => ms / DAY + 2440587.5;
function gmst(ms) {
  const d = julian(ms) - 2451545.0;
  let g = (280.46061837 + 360.98564736629 * d) % 360;
  if (g < 0) g += 360;
  return g * D2R;
}
// direction du Soleil en repère terrestre (ECEF) puis 3D
function sunDirection(ms, out) {
  const n = julian(ms) - 2451545.0;
  const L = (280.460 + 0.9856474 * n) * D2R;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  const x = Math.cos(lam), y = Math.cos(eps) * Math.sin(lam), z = Math.sin(eps) * Math.sin(lam);
  const th = gmst(ms), c = Math.cos(th), s = Math.sin(th);
  const xe = x * c + y * s, ye = -x * s + y * c;
  return out.set(xe, z, -ye).normalize();
}
// latitude/longitude/altitude -> coordonnées 3D (x = méridien 0, y = nord)
function llaToVec(latDeg, lonDeg, rUnits, out) {
  const la = latDeg * D2R, lo = lonDeg * D2R, cl = Math.cos(la);
  return out.set(rUnits * cl * Math.cos(lo), rUnits * Math.sin(la), -rUnits * cl * Math.sin(lo));
}
function vecToLL(v) {
  const r = v.length();
  return { lat: Math.asin(v.y / r) * R2D, lon: Math.atan2(-v.z, v.x) * R2D, r };
}

// ------------------------------------------------------------------ rendu 3D
const canvas = $('#globe');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
renderer.setSize(innerWidth, innerHeight);
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, innerWidth / innerHeight, 0.01, 3000);
llaToVec(35, 5, 3.4, camera.position);

let controls, camMode = 'orbit';
function makeControls(mode) {
  const target = controls ? controls.target.clone() : new THREE.Vector3();
  if (controls) controls.dispose();
  camMode = mode;
  if (mode === 'orbit') {
    camera.up.set(0, 1, 0);
    controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.08;
    controls.screenSpacePanning = true;
    controls.zoomSpeed = 1.1;
    controls.zoomToCursor = $('#optZoomCursor').checked;
    controls.autoRotateSpeed = 0.35;
  } else {
    controls = new TrackballControls(camera, canvas);
    controls.zoomSpeed = 1.4; controls.panSpeed = 0.5;
    controls.dynamicDampingFactor = 0.12;
  }
  controls.minDistance = 1.0003; controls.maxDistance = 120;
  controls.target.copy(target);
  $('#camMode').textContent = mode === 'orbit' ? 'Mode : Orbite' : 'Mode : Libre';
}
makeControls('orbit');

// ---- Terre
const tex = (color) => { const c = document.createElement('canvas'); c.width = 2; c.height = 2; const g = c.getContext('2d'); g.fillStyle = color; g.fillRect(0, 0, 2, 2); return new THREE.CanvasTexture(c); };
const earthMat = new THREE.ShaderMaterial({
  uniforms: {
    dayMap: { value: tex('#1d4a7e') }, nightMap: { value: tex('#000000') }, waterMap: { value: tex('#000000') },
    sunDir: { value: new THREE.Vector3(1, 0, 0) }, camPos: { value: new THREE.Vector3() }, uLight: { value: 1 },
  },
  vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vP;
    void main(){ vUv = uv; vN = normal; vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
  fragmentShader: `uniform sampler2D dayMap; uniform sampler2D nightMap; uniform sampler2D waterMap;
    uniform vec3 sunDir; uniform vec3 camPos; uniform float uLight;
    varying vec2 vUv; varying vec3 vN; varying vec3 vP;
    void main(){
      vec3 n = normalize(vN);
      vec3 day = texture2D(dayMap, vUv).rgb;
      if (uLight < 0.5) { gl_FragColor = vec4(day, 1.0); return; }
      vec3 night = texture2D(nightMap, vUv).rgb;
      float d = dot(n, sunDir);
      float k = smoothstep(-0.10, 0.16, d);
      float water = texture2D(waterMap, vUv).r;
      vec3 v = normalize(camPos - vP);
      float spec = pow(max(dot(reflect(-sunDir, n), v), 0.0), 30.0) * water * 0.5 * k;
      vec3 lit = day * (0.16 + 0.95 * max(d, 0.0)) + vec3(1.0, 0.95, 0.85) * spec;
      vec3 dark = day * 0.05 + night * vec3(1.0, 0.82, 0.55) * 1.35;
      vec3 col = mix(dark, lit, k);
      col += vec3(0.9, 0.35, 0.1) * exp(-pow(d / 0.09, 2.0)) * 0.12;
      gl_FragColor = vec4(col, 1.0);
    }`,
});
const earth = new THREE.Mesh(new THREE.SphereGeometry(1, 160, 110), earthMat);
earth.renderOrder = 0;
scene.add(earth);

// ---- atmosphère
const atmoMat = new THREE.ShaderMaterial({
  uniforms: { uFade: { value: 1 } },
  vertexShader: `varying vec3 vN; varying vec3 vV;
    void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
  fragmentShader: `uniform float uFade; varying vec3 vN; varying vec3 vV;
    void main(){ float x = -dot(normalize(vN), normalize(vV)); float i = pow(clamp(x / 0.33, 0.0, 1.0), 2.2);
      gl_FragColor = vec4(vec3(0.30, 0.58, 1.0) * i * 0.85 * uFade, 1.0); }`,
  side: THREE.BackSide, blending: THREE.AdditiveBlending, transparent: true, depthWrite: false,
});
const atmo = new THREE.Mesh(new THREE.SphereGeometry(1.06, 96, 64), atmoMat);
scene.add(atmo);

// ---- étoiles (repère inertiel : elles tournent avec le temps sidéral)
const stars = (() => {
  const n = 6000, rnd = mulberry32(42), p = new Float32Array(n * 3), c = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, th = rnd() * TWO_PI, s = Math.sqrt(1 - u * u);
    p[i * 3] = 900 * s * Math.cos(th); p[i * 3 + 1] = 900 * u; p[i * 3 + 2] = 900 * s * Math.sin(th);
    const b = 0.35 + Math.pow(rnd(), 3) * 0.65, tint = rnd();
    c[i * 3] = b * (tint > 0.85 ? 1 : 0.85); c[i * 3 + 1] = b * 0.9; c[i * 3 + 2] = b * (tint < 0.2 ? 0.75 : 1);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  const m = new THREE.PointsMaterial({ size: 1.6, sizeAttenuation: false, vertexColors: true, depthWrite: false });
  const pts = new THREE.Points(g, m); pts.renderOrder = -1; return pts;
})();
scene.add(stars);

// ---- Soleil
const sunSprite = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d'), gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(255,255,240,1)'); gr.addColorStop(0.15, 'rgba(255,240,200,0.9)'); gr.addColorStop(0.4, 'rgba(255,200,120,0.25)'); gr.addColorStop(1, 'rgba(255,180,80,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), blending: THREE.AdditiveBlending, depthWrite: false }));
  s.scale.set(60, 60, 1); return s;
})();
scene.add(sunSprite);

// ---- textures (mises en cache par le serveur local)
const loader = new THREE.TextureLoader();
function loadTex(urls, onOk) {
  const [u, ...rest] = urls;
  loader.load(u, (t) => { t.anisotropy = renderer.capabilities.getMaxAnisotropy(); onOk(t); },
    undefined, () => { if (rest.length) loadTex(rest, onOk); });
}
const IMG = window.ATLAS_ASSETS || '/cdn/npm/three-globe/example/img/';
let texturesOk = false;
loadTex([IMG + 'earth-blue-marble.jpg', IMG + 'earth-day.jpg'], (t) => { earthMat.uniforms.dayMap.value = t; texturesOk = true; step('tex', true); });
loadTex([IMG + 'earth-night.jpg'], (t) => { earthMat.uniforms.nightMap.value = t; });
loadTex([IMG + 'earth-water.png'], (t) => { earthMat.uniforms.waterMap.value = t; });

// ---- nuages de points (satellites, avions réels, avions estimés)
// silhouette d'avion, nez vers la droite (+x) ; tournée dans le shader selon le cap réel
const planeIconTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.translate(32, 32);
  g.beginPath();
  g.moveTo(28, 0); g.quadraticCurveTo(26, -3.5, 20, -3.5);                 // nez
  g.lineTo(4, -3.5); g.lineTo(-6, -26); g.lineTo(-12, -26); g.lineTo(-5, -3.5);   // aile gauche
  g.lineTo(-20, -3.5); g.lineTo(-26, -12); g.lineTo(-29, -12); g.lineTo(-26, 0); // empennage
  g.lineTo(-29, 12); g.lineTo(-26, 12); g.lineTo(-20, 3.5);
  g.lineTo(-5, 3.5); g.lineTo(-12, 26); g.lineTo(-6, 26); g.lineTo(4, 3.5);       // aile droite
  g.lineTo(20, 3.5); g.quadraticCurveTo(26, 3.5, 28, 0); g.closePath();
  g.lineWidth = 5; g.strokeStyle = '#000'; g.stroke();
  g.fillStyle = '#fff'; g.fill();
  return new THREE.CanvasTexture(c);
})();
const screenRes = new THREE.Vector2(innerWidth, innerHeight);
function makePointsMaterial(oriented) {
  return new THREE.ShaderMaterial({
    uniforms: { uScale: { value: 1 }, uTime: { value: 0 }, uPx: { value: renderer.getPixelRatio() }, uMap: { value: planeIconTex }, uRes: { value: screenRes }, uOri: { value: oriented ? 1 : 0 } },
    vertexShader: `attribute float aSize; attribute vec3 aColor; attribute float aVis; attribute vec3 aDir;
      uniform float uScale; uniform float uTime; uniform float uPx; uniform vec2 uRes; uniform float uOri;
      varying vec3 vColor; varying float vHi; varying float vAng; varying float vSize;
      void main(){
        vAng = 0.0; vSize = 0.0;
        if (aVis < 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); gl_PointSize = 0.0; vColor = vec3(0.0); vHi = 0.0; return; }
        vColor = aColor; vHi = aVis > 1.5 ? 1.0 : 0.0;
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        if (uOri > 0.5) {
          vec4 q = projectionMatrix * modelViewMatrix * vec4(position + aDir * 0.002, 1.0);
          vec2 d = (q.xy / q.w - gl_Position.xy / gl_Position.w) * uRes;
          vAng = atan(d.y, d.x);
        }
        float s = aSize * uScale * uPx;
        if (vHi > 0.5) s *= 2.0 + 0.8 * sin(uTime * 5.0);
        gl_PointSize = max(s, 1.2);
        vSize = gl_PointSize;
      }`,
    fragmentShader: `uniform sampler2D uMap; uniform float uOri;
      varying vec3 vColor; varying float vHi; varying float vAng; varying float vSize;
      void main(){
        vec3 col = vHi > 0.5 ? mix(vColor, vec3(0.3, 1.0, 0.6), 0.65) : vColor;
        vec2 c = gl_PointCoord - 0.5;
        if (uOri > 0.5 && vSize >= 7.0) {
          c.y = -c.y;
          float ca = cos(vAng), sa = sin(vAng);
          vec2 r = vec2(c.x * ca + c.y * sa, -c.x * sa + c.y * ca) + 0.5;
          vec4 tx = texture2D(uMap, r);
          if (tx.a < 0.08) discard;
          gl_FragColor = vec4(col * tx.r, tx.a);
          return;
        }
        float d = length(c); if (d > 0.5) discard;
        float a = smoothstep(0.5, 0.18, d);
        gl_FragColor = vec4(col, a);
      }`,
    transparent: true, depthWrite: false,
  });
}
function makeCloud(capacity, oriented = false) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(capacity * 3), col = new Float32Array(capacity * 3), size = new Float32Array(capacity), vis = new Float32Array(capacity), dir = new Float32Array(capacity * 3);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aColor', new THREE.BufferAttribute(col, 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aSize', new THREE.BufferAttribute(size, 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aVis', new THREE.BufferAttribute(vis, 1).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3).setUsage(THREE.DynamicDrawUsage));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 100);
  g.setDrawRange(0, 0);
  const pts = new THREE.Points(g, makePointsMaterial(oriented));
  pts.frustumCulled = false; pts.renderOrder = 2;
  scene.add(pts);
  return { pts, g, pos, col, size, vis, dir, n: 0, capacity };
}
let satCloud = makeCloud(1);
const planeCloud = makeCloud(30000, true);
const synthCloud = makeCloud(16000, true);

// traînées réelles de tous les avions (positions effectivement reçues)
const TRAIL_PTS = 14;
const trailsAll = (() => {
  const cap = planeCloud.capacity * TRAIL_PTS * 2;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(cap * 3), 3).setUsage(THREE.DynamicDrawUsage));
  g.setDrawRange(0, 0);
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.75, depthWrite: false }));
  l.frustumCulled = false; l.renderOrder = 1; scene.add(l); return l;
})();

// ---- marqueur de sélection, orbite, traînée
const ringTex = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.strokeStyle = '#ffffff'; g.lineWidth = 4; g.beginPath(); g.arc(32, 32, 24, 0, TWO_PI); g.stroke();
  return new THREE.CanvasTexture(c);
})();
const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, sizeAttenuation: false, depthTest: false, transparent: true }));
marker.scale.set(0.045, 0.045, 1); marker.visible = false; marker.renderOrder = 5; scene.add(marker);
const hoverMarker = new THREE.Sprite(new THREE.SpriteMaterial({ map: ringTex, sizeAttenuation: false, depthTest: false, transparent: true, opacity: 0.45 }));
hoverMarker.scale.set(0.03, 0.03, 1); hoverMarker.visible = false; scene.add(hoverMarker);

function makeLine(n, color, opacity) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const l = new THREE.Line(g, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthWrite: false }));
  l.frustumCulled = false; l.visible = false; scene.add(l); return l;
}
const orbitLine = makeLine(361, 0x40e0ff, 0.75);
const hoverOrbitLine = makeLine(361, 0x9fb8ff, 0.35);
const trailLine = makeLine(4000, 0xffc35a, 0.95);

// ------------------------------------------------------------------ catégories
const CAT = ['station', 'starlink', 'active', 'inactive', 'rb', 'deb', 'unk'];
const LAYERS = [
  { id: 'planes', label: 'Avions en vol', color: '#ffc35a' },
  { id: 'ground', label: 'Avions au sol', color: '#8f96a3' },
  { id: 'station', label: 'Stations spatiales', color: '#ffd34d' },
  { id: 'starlink', label: 'Starlink', color: '#b58cff' },
  { id: 'active', label: 'Satellites actifs', color: '#3fe0ff' },
  { id: 'inactive', label: 'Satellites hors service', color: '#6f86a8' },
  { id: 'rb', label: 'Étages de fusée', color: '#ff8a3d' },
  { id: 'deb', label: 'Débris', color: '#ff4d6d' },
  { id: 'unk', label: 'Objets non identifiés', color: '#9a9a9a' },
];
const CAT_SIZE = [7.0, 2.0, 2.8, 2.2, 2.4, 1.6, 1.7];
const DRAW_PRIO = [9, 4, 5, 3, 2, 0, 1];   // ordre de dessin : les stations en dernier (au premier plan)
const CAT_RGB = CAT.map((id) => new THREE.Color(LAYERS.find((l) => l.id === id).color));
const layerOn = Object.fromEntries(LAYERS.map((l) => [l.id, true]));   // tout est affiché au démarrage
// cartes de compteurs (en haut à droite) -> calques
const GROUPS = { planes: ['planes', 'ground'], active: ['station', 'starlink', 'active'], inactive: ['inactive'], rb: ['rb'], debris: ['deb', 'unk'] };

const OWNERS = { SU: 'URSS', RU: 'Russie', CN: 'Chine', F: 'France', J: 'Japon', IN: 'Inde', D: 'Allemagne', I: 'Italie', 'I-ESA': 'Agence spatiale européenne', 'I-EUM': 'EUMETSAT', 'I-INT': 'Intelsat', L: 'Luxembourg', E: 'Espagne', IL: 'Israël', BR: 'Brésil', KR: 'Corée du Sud', KP: 'Corée du Nord', IR: 'Iran', AE: 'Émirats arabes unis', US: 'États-Unis', CIS: 'URSS / Russie', PRC: 'Chine', FR: 'France', ESA: 'Agence spatiale européenne', JPN: 'Japon', IND: 'Inde', UK: 'Royaume-Uni', GER: 'Allemagne', IT: 'Italie', CA: 'Canada', ISS: 'Station spatiale internationale', ITSO: 'Intelsat', SES: 'SES (Luxembourg)', EUTE: 'Eutelsat', GLOB: 'Globalstar', ORB: 'Orbcomm', IRID: 'Iridium', ISRA: 'Israël', KOR: 'Corée du Sud', NKOR: 'Corée du Nord', BRAZ: 'Brésil', ARGN: 'Argentine', AUS: 'Australie', SPN: 'Espagne', NOR: 'Norvège', LUXE: 'Luxembourg', UAE: 'Émirats arabes unis', TURK: 'Turquie', IRAN: 'Iran', SAUD: 'Arabie saoudite', INDO: 'Indonésie', MEX: 'Mexique', TBD: 'Inconnu', NATO: 'OTAN', EUME: 'EUMETSAT', AB: 'Arabsat', AC: 'AsiaSat', O3B: 'O3b / SES', UKR: 'Ukraine', KAZ: 'Kazakhstan', SWED: 'Suède', NETH: 'Pays-Bas', BEL: 'Belgique', SWTZ: 'Suisse', DEN: 'Danemark', FIN: 'Finlande', POL: 'Pologne', TWN: 'Taïwan', THAI: 'Thaïlande', VTNM: 'Viêt Nam', SING: 'Singapour', NZ: 'Nouvelle-Zélande', EGYP: 'Égypte', ALG: 'Algérie', NIG: 'Nigeria', SAFR: 'Afrique du Sud', PAKI: 'Pakistan', MALA: 'Malaisie', CHLE: 'Chili', PER: 'Pérou' };
const SITES = { AFETR: 'Cap Canaveral (USA)', AFWTR: 'Vandenberg (USA)', TYMSC: 'Baïkonour (Kazakhstan)', PKMTR: 'Plessetsk (Russie)', KYMSC: 'Kapoustine Iar (Russie)', VOSTO: 'Vostotchny (Russie)', FRGUI: 'Kourou (Guyane)', HGSTR: 'Hammaguir (Algérie)', JSC: 'Jiuquan (Chine)', TSC: 'Taiyuan (Chine)', XICLF: 'Xichang (Chine)', WSC: 'Wenchang (Chine)', YSLA: 'Mer Jaune (Chine)', SRILR: 'Sriharikota (Inde)', TNSTA: 'Tanegashima (Japon)', KSCUT: 'Uchinoura (Japon)', WRAS: 'Wallops (USA)', RLLB: 'Mahia (Nouvelle-Zélande)', SEAL: 'Plateforme Sea Launch', SNMLP: 'San Marco (Kenya)', DLS: 'Dombarovsky (Russie)', SVOBO: 'Svobodny (Russie)', KODAK: 'Kodiak (USA)', NSC: 'Naro (Corée du Sud)', SEMLS: 'Semnan (Iran)', SADOL: 'Mer de Barents (sous-marin)', WOMRA: 'Woomera (Australie)', YAVNE: 'Palmachim (Israël)', ERAS: 'Air Launch (Pegasus)', OREN: 'Iasny (Russie)', SUBL: 'Lancement sous-marin', KWAJ: 'Kwajalein', TTMTR: 'Taiyuan (Chine)', SMTS: 'Shahrud (Iran)', CAS: 'Lancement aérien' };
const OPS = { '+': 'opérationnel', '-': 'hors service', P: 'partiellement opérationnel', B: 'en réserve', S: 'de secours', X: 'mission prolongée', D: 'rentré dans l\'atmosphère', '?': 'inconnu' };
const OTYPE = { PAY: 'Satellite', 'R/B': 'Étage de fusée', DEB: 'Débris', UNK: 'Objet non identifié' };

// ------------------------------------------------------------------ événements historiques
const EVENTS = [
  ['1903-12-17', 'Premier vol motorisé : les frères Wright à Kitty Hawk'],
  ['1909-07-25', 'Louis Blériot traverse la Manche'],
  ['1914-01-01', 'Première ligne aérienne régulière (St. Petersburg – Tampa, Floride)'],
  ['1919-08-25', 'Première ligne internationale régulière : Londres – Paris'],
  ['1927-05-21', 'Lindbergh traverse l\'Atlantique en solitaire'],
  ['1939-08-27', 'Premier vol d\'un avion à réaction (Heinkel He 178)'],
  ['1952-05-02', 'Premier vol commercial en avion à réaction (de Havilland Comet)'],
  ['1957-10-04', 'Spoutnik 1 : premier satellite artificiel'],
  ['1958-02-01', 'Explorer 1 : premier satellite américain'],
  ['1961-04-12', 'Youri Gagarine, premier humain en orbite'],
  ['1962-07-10', 'Telstar 1 : première retransmission TV transatlantique'],
  ['1965-11-26', 'Astérix : la France devient la 3ᵉ puissance spatiale'],
  ['1969-07-20', 'Apollo 11 : premiers pas sur la Lune'],
  ['1970-01-22', 'Le Boeing 747 entre en service'],
  ['1976-01-21', 'Le Concorde entre en service commercial'],
  ['1978-02-22', 'Lancement du premier satellite GPS (Navstar 1)'],
  ['1986-02-20', 'Lancement du module de base de la station Mir'],
  ['1998-11-20', 'Zarya : premier module de la Station spatiale internationale'],
  ['2007-01-11', 'Tir antisatellite chinois : des milliers de débris'],
  ['2009-02-10', 'Collision Iridium 33 / Cosmos 2251'],
  ['2019-05-24', 'Premier lot de 60 satellites Starlink'],
  ['2020-03-20', 'Covid-19 : le trafic aérien mondial s\'effondre'],
  ['2021-11-15', 'Tir antisatellite russe sur Cosmos 1408'],
].map(([d, t]) => ({ t: parseDay(d), d, text: t }));

// ------------------------------------------------------------------ satellites : données
const recs = new Map();        // NORAD -> fiche
let S = null;                  // tableaux compacts pour le calcul
let satDataTime = { gp: 0, cat: 0 };
const satSource = { gp: '', cat: '' };
let chartEvents = null;
let knownNorad = null;         // pour repérer les nouveaux pendant la session
const sessionNew = new Set();
const lastVisitMax = +(lsGet('atlas.lastMaxNorad') || 0);
// 80000–99999 : numéros provisoires des analystes ; les nouveaux objets reçoivent désormais des numéros ≥ 100000
const realNorad = (n) => n < 80000 || n >= 100000;

function parseCSVLine(line) {
  const out = []; let cur = '', q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (q) { if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else if (c === '"') q = true;
    else cur += c;
  }
  out.push(cur);
  return out;
}

function ingestSatcat(text) {
  const lines = text.split(/\r?\n/);
  const h = parseCSVLine(lines[0]).map((s) => s.trim().toUpperCase());
  const ix = (k) => h.indexOf(k);
  const I = { name: ix('OBJECT_NAME'), id: ix('OBJECT_ID'), norad: ix('NORAD_CAT_ID'), type: ix('OBJECT_TYPE'), ops: ix('OPS_STATUS_CODE'), owner: ix('OWNER'), launch: ix('LAUNCH_DATE'), site: ix('LAUNCH_SITE'), decay: ix('DECAY_DATE'), period: ix('PERIOD'), inc: ix('INCLINATION'), apo: ix('APOGEE'), peri: ix('PERIGEE'), center: ix('ORBIT_CENTER'), otype: ix('ORBIT_TYPE') };
  let count = 0;
  for (let k = 1; k < lines.length; k++) {
    const L = lines[k]; if (!L) continue;
    const f = parseCSVLine(L);
    const norad = parseInt(f[I.norad], 10); if (!norad) continue;
    const center = I.center >= 0 ? f[I.center] : 'EA';
    const otype = I.otype >= 0 ? f[I.otype] : 'ORB';
    if (center && center !== 'EA') continue;          // sondes vers la Lune, Mars, le Soleil…
    if (otype === 'DOC') continue;                     // modules amarrés (déjà représentés par la station)
    let r = recs.get(norad);
    if (!r) { r = { norad, gp: null }; recs.set(norad, r); }
    r.name = f[I.name]; r.cospar = f[I.id]; r.type = f[I.type] || 'UNK'; r.ops = f[I.ops]; r.owner = f[I.owner];
    r.launch = parseDay(f[I.launch]); r.site = f[I.site];
    const dd = parseDay(f[I.decay]); r.decay = isNaN(dd) ? Infinity : dd;
    r.period = parseFloat(f[I.period]); r.inc = parseFloat(f[I.inc]); r.apo = parseFloat(f[I.apo]); r.peri = parseFloat(f[I.peri]);
    r.inCatalog = true;
    count++;
  }
  return count;
}

// catalogue GCAT (J. McDowell, planet4589.org) : source de secours, au format TSV
const MON3 = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
function vagueDate(s) {
  const m = /^(\d{4})\s+([A-Z][a-z]{2})\s*(\d{1,2})?/.exec((s || '').trim());
  return m ? Date.UTC(+m[1], MON3[m[2]] ?? 0, m[3] ? +m[3] : 1) : NaN;
}
function ingestGCAT(text) {
  const lines = text.split(/\r?\n/);
  let h = null, count = 0;
  for (const L of lines) {
    if (!L) continue;
    if (L[0] === '#') { if (!h && /JCAT/.test(L)) h = L.slice(1).split('\t').map((x) => x.trim()); continue; }
    if (!h) continue;
    const f = L.split('\t');
    const g = (k) => { const i = h.indexOf(k); return i >= 0 ? (f[i] || '').trim() : ''; };
    const norad = parseInt(g('Satcat'), 10); if (!norad) continue;
    const prim = g('Primary'); if (prim && prim !== 'Earth') continue;
    const T0 = (g('Type') || 'X')[0];
    const launch = vagueDate(g('LDate')); if (isNaN(launch)) continue;
    const dd = vagueDate(g('DDate'));
    let r = recs.get(norad);
    if (!r) { r = { norad, gp: null }; recs.set(norad, r); }
    r.name = (g('Name') || g('PLName') || ('#' + norad)).toUpperCase();
    r.cospar = g('Piece'); r.type = T0 === 'P' ? 'PAY' : T0 === 'R' ? 'R/B' : (T0 === 'D' || T0 === 'C') ? 'DEB' : 'UNK';
    r.ops = isNaN(dd) ? '?' : 'D'; r.owner = g('State'); r.site = '';
    r.launch = launch; r.decay = isNaN(dd) ? Infinity : dd;
    r.period = NaN; r.inc = parseFloat(g('Inc')); r.apo = parseFloat(g('Apogee')); r.peri = parseFloat(g('Perigee'));
    r.inCatalog = true; r.fromGCAT = true;
    count++;
  }
  return count;
}
// SatNOGS renvoie des TLE (tle0 = nom, tle1/tle2 = les deux lignes)
function normalizeGP(list) {
  if (!Array.isArray(list)) return [];
  return list.map((o) => o && o.tle1 && o.tle2 ? tleToGP(+o.norad_cat_id || +o.tle2.slice(2, 7), (o.tle0 || '').replace(/^0 /, ''), o.tle1, o.tle2) : o).filter(Boolean);
}
function ingestGP(list) {
  let count = 0;
  for (const o of list) {
    const norad = +o.NORAD_CAT_ID; if (!norad || !o.MEAN_MOTION) continue;
    let r = recs.get(norad);
    if (!r) {
      r = { norad, name: o.OBJECT_NAME, cospar: o.OBJECT_ID, type: /\bDEB\b/.test(o.OBJECT_NAME) ? 'DEB' : (/R\/B/.test(o.OBJECT_NAME) ? 'R/B' : 'PAY'), ops: '+', owner: '', site: '', decay: Infinity, gp: null };
      recs.set(norad, r);
    }
    const epoch = Date.parse(/Z$/.test(o.EPOCH) ? o.EPOCH : o.EPOCH + 'Z');
    r.gp = { mm: +o.MEAN_MOTION, e: +o.ECCENTRICITY, i: +o.INCLINATION, raan: +o.RA_OF_ASC_NODE, argp: +o.ARG_OF_PERICENTER, ma: +o.MEAN_ANOMALY, epoch, rev: +o.REV_AT_EPOCH || 0, mmdot: +o.MEAN_MOTION_DOT || 0 };
    if (!r.name) r.name = o.OBJECT_NAME;
    if (isNaN(r.launch) || r.launch === undefined) {
      // date de lancement estimée : nombre de révolutions / révolutions par jour
      r.launch = epoch - (r.gp.rev / r.gp.mm) * DAY;
      r.launchEstimated = true;
    }
    if (!r.inCatalog) r.ops = '+';
    count++;
  }
  return count;
}

const STATION_RE = /^(ISS \(ZARYA\)|CSS \(TIANHE\)|MIR|SKYLAB|SALYUT \d|TIANGONG[- ]?\d?|ALMAZ.*)$/;
function categoryOf(r) {
  if (r.type === 'PAY') {
    if (r.norad === 25544 || r.norad === 48274 || STATION_RE.test(r.name)) return 0;
    if (/^STARLINK/.test(r.name)) return 1;
    return r.gp || '+PBSX'.includes(r.ops || '-') ? 2 : 3;
  }
  if (r.type === 'R/B') return 4;
  if (r.type === 'DEB') return 5;
  return 6;
}

// éléments orbitaux d'un objet : précis (CelesTrak GP) ou approchés (catalogue)
function setElements(s, i, r) {
  s.precise[i] = 0; s.ndot2[i] = 0;
  // freinage atmosphérique : MEAN_MOTION_DOT = (dn/dt)/2 en tours/jour²
  if (r.gp) s.ndot2[i] = r.gp.mmdot * TWO_PI / (86400 * 86400);
  let a, e, inc, raan, argp, m0, mm, epoch;
  if (r.gp) {
    const g = r.gp;
    mm = g.mm * TWO_PI / 86400; a = Math.cbrt(MU / (mm * mm)); e = g.e; inc = g.i * D2R;
    raan = g.raan * D2R; argp = g.argp * D2R; m0 = g.ma * D2R; epoch = g.epoch; s.precise[i] = 1;
  } else {
    // orbite approchée depuis le catalogue (altitude et inclinaison réelles, position sur l'orbite arbitraire)
    const rnd = mulberry32(r.norad * 2654435761);
    if (r.apo > 0 && r.peri > 0) {
      const ra = RE_EQ + r.apo, rp = RE_EQ + Math.max(r.peri, 120);
      a = (ra + rp) / 2; e = (ra - rp) / (ra + rp);
    } else { a = Math.cbrt(MU * Math.pow(r.period * 60 / TWO_PI, 2)); e = 0.001; }
    mm = Math.sqrt(MU / (a * a * a));
    inc = (isNaN(r.inc) ? rnd() * 100 : r.inc) * D2R;
    raan = rnd() * TWO_PI; argp = rnd() * TWO_PI; m0 = rnd() * TWO_PI; epoch = r.launch;
  }
  if (!(a > RE_EQ + 80)) a = RE_EQ + 300;
  e = clamp(e || 0, 0, 0.97);
  const p = a * (1 - e * e), fac = 1.5 * J2 * Math.pow(RE_EQ / p, 2) * mm, ci = Math.cos(inc), si = Math.sin(inc);
  s.a[i] = a; s.e[i] = e; s.ci[i] = ci; s.si[i] = si; s.raan0[i] = raan; s.argp0[i] = argp; s.m0[i] = m0; s.mm[i] = mm; s.epoch[i] = epoch;
  s.raanDot[i] = -fac * ci; s.argpDot[i] = fac * (2 - 2.5 * si * si); s.sq[i] = Math.sqrt(1 - e * e);
}

function buildSats() {
  const list = [];
  for (const r of recs.values()) {
    if (isNaN(r.launch)) continue;
    if (r.gp || (r.period > 0) || (r.apo > 0 && r.peri > 0)) list.push(r);
  }
  list.sort((a, b) => DRAW_PRIO[categoryOf(a)] - DRAW_PRIO[categoryOf(b)]);
  const n = list.length;
  const F = (k) => new Float64Array(n);
  const s = {
    n, recs: list, index: new Map(),
    launch: F(), decay: F(), a: F(), e: F(), ci: F(), si: F(), raan0: F(), argp0: F(), m0: F(), mm: F(), epoch: F(), raanDot: F(), argpDot: F(), sq: F(),
    norad: new Float64Array(n), ndot2: new Float64Array(n),
    cat: new Uint8Array(n), cur: new Uint8Array(n).fill(255), activeNow: new Uint8Array(n), isNew: new Uint8Array(n), precise: new Uint8Array(n),
  };
  const now = Date.now();
  let maxNorad = 0;
  for (let i = 0; i < n; i++) {
    const r = list[i];
    s.index.set(r.norad, i); s.norad[i] = r.norad;
    s.launch[i] = r.launch; s.decay[i] = r.decay;
    setElements(s, i, r);
    s.cat[i] = categoryOf(r);
    s.activeNow[i] = s.cat[i] <= 2 ? 1 : 0;
    const fresh = (now - r.launch) < 7 * DAY;
    const sinceVisit = lastVisitMax > 0 && r.norad > lastVisitMax && realNorad(r.norad);
    if (fresh || sinceVisit || sessionNew.has(r.norad)) s.isNew[i] = 1;
    r.sinceVisit = sinceVisit || sessionNew.has(r.norad);
    if (realNorad(r.norad) && r.norad > maxNorad) maxNorad = r.norad;
  }
  if (maxNorad) lsSet('atlas.lastMaxNorad', String(maxNorad));

  // nuage de points à la bonne taille
  scene.remove(satCloud.pts); satCloud.g.dispose();
  satCloud = makeCloud(Math.max(n, 1));
  satCloud.n = n; satCloud.g.setDrawRange(0, n);
  for (let i = 0; i < n; i++) satCloud.size[i] = CAT_SIZE[s.cat[i]];
  satCloud.g.attributes.aSize.needsUpdate = true;
  S = s;

  // événements pour le graphique de la frise : +1 au lancement, −1 à la rentrée
  const ev = [];
  for (let i = 0; i < n; i++) {
    const grp = s.cat[i] <= 3 ? 0 : (s.cat[i] === 4 ? 1 : 2);
    ev.push([s.launch[i], 1, grp]);
    if (isFinite(s.decay[i])) ev.push([s.decay[i], -1, grp]);
  }
  ev.sort((x, y) => x[0] - y[0]);
  chartEvents = { t: Float64Array.from(ev, (x) => x[0]), d: Int8Array.from(ev, (x) => x[1]), g: Uint8Array.from(ev, (x) => x[2]) };
  lastSatCompute = 0;
  drawChart(); renderNewList(); renderSources();
}

// ---- orbite précise à la demande (si elle manque : téléchargement raté, débris, vieux satellite…)
const gpTried = new Map();   // norad -> Promise<boolean>
// conversion d'un TLE (format à deux lignes) vers les champs GP
function tleToGP(norad, name, l1, l2) {
  const yy = +l1.slice(18, 20), doy = +l1.slice(20, 32);
  const epoch = Date.UTC(yy < 57 ? 2000 + yy : 1900 + yy, 0, 1) + (doy - 1) * DAY;
  return { NORAD_CAT_ID: norad, OBJECT_NAME: name || '', OBJECT_ID: '', EPOCH: new Date(epoch).toISOString(),
    MEAN_MOTION_DOT: +l1.slice(33, 43), INCLINATION: +l2.slice(8, 16), RA_OF_ASC_NODE: +l2.slice(17, 25), ECCENTRICITY: +('0.' + l2.slice(26, 33).trim()),
    ARG_OF_PERICENTER: +l2.slice(34, 42), MEAN_ANOMALY: +l2.slice(43, 51), MEAN_MOTION: +l2.slice(52, 63), REV_AT_EPOCH: +l2.slice(63, 68) || 0 };
}
function ensurePrecise(norad) {
  const i = S?.index.get(norad);
  if (i === undefined) return Promise.resolve(false);
  if (S.precise[i]) return Promise.resolve(true);
  if (gpTried.has(norad)) return gpTried.get(norad);
  const pr = (async () => {
    try {
      const r = await api('/api/gp?catnr=' + norad); const j = await r.json();
      let list = null;
      if (Array.isArray(j) && j.length) list = normalizeGP(j);
      else if (j && j.line1 && j.line2) list = [tleToGP(norad, j.name, j.line1, j.line2)];
      if (!list) return false;
      ingestGP(list);
      const k = S.index.get(norad), rec = recs.get(norad);
      if (k === undefined || !rec.gp) return false;
      setElements(S, k, rec);
      lastSatCompute = 0; orbitStamp = -1;
      return true;
    } catch { return false; }
  })();
  gpTried.set(norad, pr);
  pr.then((ok) => { if (!ok) setTimeout(() => gpTried.delete(norad), 120000); });   // nouvel essai possible 2 min plus tard
  return pr;
}

// propagation : Kepler + dérive séculaire J2 (précision de l'ordre de quelques km à dizaines de km)
function satECI(i, t, out) {
  const dt = (t - S.epoch[i]) / 1000;
  const dq = dt > 2592000 ? 2592000 : dt < -2592000 ? -2592000 : dt;   // terme de freinage limité à ±30 jours
  let M = (S.m0[i] + S.mm[i] * dt + S.ndot2[i] * dq * dq) % TWO_PI; if (M < 0) M += TWO_PI;
  const e = S.e[i];
  let E = e < 0.8 ? M : Math.PI;
  for (let k = 0; k < 10; k++) {
    const dE = (E - e * Math.sin(E) - M) / (1 - e * Math.cos(E));
    E -= dE; if (Math.abs(dE) < 1e-9) break;
  }
  const a = S.a[i], xp = a * (Math.cos(E) - e), yp = a * S.sq[i] * Math.sin(E);
  const O = S.raan0[i] + S.raanDot[i] * dt, w = S.argp0[i] + S.argpDot[i] * dt;
  const cO = Math.cos(O), sO = Math.sin(O), cw = Math.cos(w), sw = Math.sin(w), ci = S.ci[i], si = S.si[i];
  out[0] = xp * (cO * cw - sO * sw * ci) - yp * (cO * sw + sO * cw * ci);
  out[1] = xp * (sO * cw + cO * sw * ci) + yp * (cO * cw * ci - sO * sw);
  out[2] = xp * (sw * si) + yp * (cw * si);
  return out;
}
const eciTmp = new Float64Array(3);
const ACTIVE_LIFE = 8 * YEAR;      // durée de vie estimée d'un satellite aujourd'hui hors service
const counts = { cat: new Int32Array(7), planesAir: 0, planesGround: 0, synth: 0 };
let lastSatCompute = 0;

function updateSats(t) {
  if (!S) return;
  const g = gmst(t), cg = Math.cos(g), sg = Math.sin(g);
  const { pos, col, vis } = satCloud;
  const pulse = $('#optPulse').checked;
  const c = counts.cat; c.fill(0);
  let colorChanged = false;
  for (let i = 0; i < S.n; i++) {
    if (!(S.launch[i] <= t && t < S.decay[i])) { vis[i] = 0; continue; }
    let cat = S.cat[i];
    if (cat === 3 && t < S.launch[i] + ACTIVE_LIFE) cat = 2;   // probablement encore actif à cette époque
    c[cat]++;
    if (isolate ? !(isolate.kind === 'sat' && S.norad[i] === isolate.key) : !layerOn[CAT[cat]]) { vis[i] = 0; continue; }
    if (S.cur[i] !== cat) {
      const rgb = CAT_RGB[cat]; col[i * 3] = rgb.r; col[i * 3 + 1] = rgb.g; col[i * 3 + 2] = rgb.b;
      S.cur[i] = cat; colorChanged = true;
    }
    satECI(i, t, eciTmp);
    const x = eciTmp[0], y = eciTmp[1], z = eciTmp[2];
    const xe = x * cg + y * sg, ye = -x * sg + y * cg;
    pos[i * 3] = xe / RE_KM; pos[i * 3 + 1] = z / RE_KM; pos[i * 3 + 2] = -ye / RE_KM;
    vis[i] = (pulse && S.isNew[i]) ? 2 : 1;
  }
  const at = satCloud.g.attributes;
  at.position.needsUpdate = true; at.aVis.needsUpdate = true;
  if (colorChanged) at.aColor.needsUpdate = true;
}
function satPos3(i, t, out) {
  satECI(i, t, eciTmp);
  const g = gmst(t), cg = Math.cos(g), sg = Math.sin(g);
  const x = eciTmp[0], y = eciTmp[1], z = eciTmp[2];
  return out.set((x * cg + y * sg) / RE_KM, z / RE_KM, -(-x * sg + y * cg) / RE_KM);
}

// ------------------------------------------------------------------ avions en direct (OpenSky)
const PL = { list: [], byIcao: new Map(), fetched: 0, auth: false, refresh: 90, message: '', ok: false, lastTry: 0 };
const ALT_STOPS = [[0, new THREE.Color('#ffe08a')], [4000, new THREE.Color('#ffb347')], [8000, new THREE.Color('#ff7a7a')], [12500, new THREE.Color('#ff6be6')]];
function altColor(alt, out) {
  if (alt <= 0) return out.copy(ALT_STOPS[0][1]);
  for (let i = 1; i < ALT_STOPS.length; i++) {
    if (alt <= ALT_STOPS[i][0]) { const [a0, c0] = ALT_STOPS[i - 1], [a1, c1] = ALT_STOPS[i]; return out.copy(c0).lerp(c1, (alt - a0) / (a1 - a0)); }
  }
  return out.copy(ALT_STOPS[ALT_STOPS.length - 1][1]);
}
const GROUND = new THREE.Color('#8f96a3');

let planesTimer = 0;
function fetchPlanesNow() { clearTimeout(planesTimer); fetchPlanes(); }
async function fetchPlanes() {
  clearTimeout(planesTimer);
  PL.lastTry = Date.now();
  try {
    const r = await api('/api/avions');
    const j = await r.json();
    PL.auth = j.auth; PL.refresh = j.refresh || 90; PL.message = j.message || '';
    if (j.data && j.data.states && j.fetched !== PL.fetched) { ingestPlanes(j.data.states, j.fetched); PL.ok = true; step('planes', true); }
    else if (!j.data) step('planes', false, j.message || 'pas de données');
    if (j.message && !PL.warned) { toast(esc(j.message), 'warn', 12000); PL.warned = true; }
    if (!j.message) PL.warned = false;
  } catch (e) {
    PL.message = 'Serveur local injoignable'; step('planes', false, PL.message);
  }
  renderSources();
  // appli Windows : le serveur garde un cache, on peut l'interroger deux fois plus souvent ; web : chaque appel compte
  planesTimer = setTimeout(fetchPlanes, clamp(WEB ? PL.refresh : PL.refresh / 2, 5, 900) * 1000);
}

function ingestPlanes(states, fetched) {
  PL.fetched = fetched;
  const seen = new Set();
  const list = [];
  for (const s of states) {
    const lon = s[5], lat = s[6];
    if (lat == null || lon == null) continue;
    const icao = s[0]; seen.add(icao);
    let p = PL.byIcao.get(icao);
    let old = null;
    if (!p) {
      p = { icao, trail: Array.isArray(s[15]) ? s[15].map((q) => [q[0], q[1], q[2] || 0, q[3]]) : [] };   // positions précédentes réelles
      PL.byIcao.set(icao, p);
    }
    else if (p.lat != null) old = planeLLDisp(p, Date.now());
    p.cs = (s[1] || '').trim(); p.country = s[2]; p.tpos = s[3] || s[4] || fetched; p.last = s[4];
    p.lat = lat; p.lon = lon; p.alt = s[7] ?? s[13] ?? 0; p.ground = !!s[8];
    p.v = s[9] || 0; p.trk = s[10] || 0; p.vr = s[11]; p.galt = s[13]; p.sq = s[14];
    if (old) {
      // évite les sauts : l'écart entre l'ancienne estimation et la nouvelle position se résorbe en 4 s
      const nw = planeLL(p, Date.now());
      const dla = old[0] - nw[0], dlo = ((old[1] - nw[1] + 540) % 360) - 180;
      if (Math.abs(dla) < 1 && Math.abs(dlo) < 1) { p.corr = [dla, dlo]; p.corrT = performance.now(); } else p.corrT = 0;
    }
    const tr = p.trail, last = tr[tr.length - 1];
    if (!last || last[0] !== lat || last[1] !== lon) { tr.push([lat, lon, p.alt || 0, p.tpos]); if (tr.length > 200) tr.shift(); }
    list.push(p);
  }
  for (const k of PL.byIcao.keys()) if (!seen.has(k)) PL.byIcao.delete(k);
  list.length = Math.min(list.length, planeCloud.capacity);
  PL.list = list;
  const cc = new THREE.Color();
  for (let i = 0; i < list.length; i++) {
    const p = list[i]; p.idx = i;
    if (p.ground) cc.copy(GROUND); else altColor(p.alt, cc);
    planeCloud.col[i * 3] = cc.r; planeCloud.col[i * 3 + 1] = cc.g; planeCloud.col[i * 3 + 2] = cc.b;
    planeCloud.size[i] = p.ground ? 0.7 : 1;
  }
  planeCloud.n = list.length; planeCloud.g.setDrawRange(0, list.length);
  planeCloud.g.attributes.aColor.needsUpdate = true; planeCloud.g.attributes.aSize.needsUpdate = true;
  if (sel?.kind === 'plane') fetchTrack(sel.key, true);
  lastTrails = 0;
}

// position estimée (vitesse + cap) entre deux mises à jour
function planeLL(p, t) {
  if (p.ground || !p.v) return [p.lat, p.lon];
  const dt = clamp(t / 1000 - p.tpos, -120, WEB ? 1500 : 600);
  const d = p.v * dt / 6371000, th = p.trk * D2R, la = p.lat * D2R, lo = p.lon * D2R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(d) + Math.cos(la) * Math.sin(d) * Math.cos(th));
  const lo2 = lo + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(la), Math.cos(d) - Math.sin(la) * Math.sin(la2));
  return [la2 * R2D, lo2 * R2D];
}
// position affichée = estimation + correction douce
function planeLLDisp(p, t) {
  const ll = planeLL(p, t);
  if (p.corrT) {
    const k = 1 - (performance.now() - p.corrT) / 4000;
    if (k > 0) { ll[0] += p.corr[0] * k; ll[1] += p.corr[1] * k; } else p.corrT = 0;
  }
  return ll;
}
// vecteur « cap » tangent à la Terre (nord = 0°, est = 90°)
function headingVec(latDeg, lonDeg, trkDeg, out) {
  const la = latDeg * D2R, lo = lonDeg * D2R, th = trkDeg * D2R, c = Math.cos(th), s = Math.sin(th);
  const sla = Math.sin(la), cla = Math.cos(la), slo = Math.sin(lo), clo = Math.cos(lo);
  return out.set(-sla * clo * c - slo * s, cla * c, sla * slo * c - clo * s);
}
let altExag = +$('#optExag').value;
const planeR = (altM) => 1 + Math.max(altM || 0, 0) * altExag / 6371000 + 0.0004;
const vTmp = new THREE.Vector3();

function updatePlanes(t, show) {
  const { pos, vis } = planeCloud;
  let air = 0, gnd = 0;
  for (let i = 0; i < PL.list.length; i++) {
    const p = PL.list[i];
    if (p.ground) gnd++; else air++;
    if (!show || (isolate ? !(isolate.kind === 'plane' && p.icao === isolate.key) : !(p.ground ? layerOn.ground : layerOn.planes))) { vis[i] = 0; continue; }
    const [la, lo] = planeLLDisp(p, t);
    llaToVec(la, lo, planeR(p.alt), vTmp);
    pos[i * 3] = vTmp.x; pos[i * 3 + 1] = vTmp.y; pos[i * 3 + 2] = vTmp.z;
    headingVec(la, lo, p.trk, vTmp);
    planeCloud.dir[i * 3] = vTmp.x; planeCloud.dir[i * 3 + 1] = vTmp.y; planeCloud.dir[i * 3 + 2] = vTmp.z;
    vis[i] = 1;
  }
  counts.planesAir = show ? air : 0; counts.planesGround = show ? gnd : 0;
  planeCloud.g.attributes.position.needsUpdate = true; planeCloud.g.attributes.aVis.needsUpdate = true;
  planeCloud.g.attributes.aDir.needsUpdate = true;
}

// traînées : dernières positions réellement reçues + position actuelle (reconstruites 1 fois / s)
let lastTrails = 0;
function updateTrails(now, t, show) {
  if (now - lastTrails < 1000) return; lastTrails = now;
  const on = show && $('#optTrails').checked;
  trailsAll.visible = on;
  if (!on) return;
  const P = trailsAll.geometry.attributes.position.array, C = trailsAll.geometry.attributes.color.array;
  const a = new THREE.Vector3(), b = new THREE.Vector3();
  let v = 0;
  for (let i = 0; i < PL.list.length; i++) {
    if (planeCloud.vis[i] < 0.5) continue;
    const p = PL.list[i];
    if (p.ground) continue;
    const tr = p.trail; if (tr.length < 1) continue;
    const pts = tr.slice(-TRAIL_PTS + 1);
    const n = pts.length;
    const cr = planeCloud.col[i * 3], cg = planeCloud.col[i * 3 + 1], cb = planeCloud.col[i * 3 + 2];
    const [la, lo] = planeLLDisp(p, t);
    for (let k = 0; k < n; k++) {
      llaToVec(pts[k][0], pts[k][1], planeR(pts[k][2]), a);
      if (k + 1 < n) llaToVec(pts[k + 1][0], pts[k + 1][1], planeR(pts[k + 1][2]), b); else llaToVec(la, lo, planeR(p.alt), b);
      const f0 = 0.15 + 0.6 * k / n, f1 = 0.15 + 0.6 * (k + 1) / n;
      P[v * 3] = a.x; P[v * 3 + 1] = a.y; P[v * 3 + 2] = a.z; C[v * 3] = cr * f0; C[v * 3 + 1] = cg * f0; C[v * 3 + 2] = cb * f0; v++;
      P[v * 3] = b.x; P[v * 3 + 1] = b.y; P[v * 3 + 2] = b.z; C[v * 3] = cr * f1; C[v * 3 + 1] = cg * f1; C[v * 3 + 2] = cb * f1; v++;
    }
  }
  trailsAll.geometry.setDrawRange(0, v);
  trailsAll.geometry.attributes.position.needsUpdate = true; trailsAll.geometry.attributes.color.needsUpdate = true;
}

// ------------------------------------------------------------------ avions d'autrefois (estimation)
// Ordres de grandeur du nombre d'appareils en vol simultanément dans le monde.
const AIR_EST = [[1903.95, 0], [1903.96, 1], [1906, 2], [1909, 12], [1911, 40], [1914, 120], [1915, 400], [1917, 1200], [1918.8, 1500],
  [1919.2, 250], [1925, 450], [1930, 900], [1936, 1500], [1939.6, 2200], [1941, 4500], [1944, 8000], [1945.6, 6000], [1946.2, 1800],
  [1950, 2600], [1955, 3500], [1960, 4500], [1970, 6000], [1980, 7200], [1990, 8600], [2000, 10200], [2008, 11500], [2009.5, 11000],
  [2019, 14000], [2020.15, 13500], [2020.3, 3500], [2020.7, 6500], [2021.5, 9000], [2022.5, 11500], [2024, 13500], [2027, 14500]];
const airEstimate = (yf) => yf < 1903.95 ? 0 : Math.round(interp(AIR_EST, yf));
const SPEED_KMH = [[1903, 45], [1915, 110], [1930, 200], [1945, 350], [1955, 560], [1965, 850]];
const ALT_KM = [[1903, 0.02], [1912, 0.4], [1925, 1.5], [1940, 4], [1958, 10.5]];

// [nom, lat, lon, depuis, poids]
const CITIES = [
  ['Kitty Hawk', 36.02, -75.67, 1903, 1], ['Dayton', 39.76, -84.19, 1904, 1], ['Le Mans', 47.95, 0.2, 1908, 1], ['Reims', 49.3, 4.03, 1909, 1],
  ['Paris', 48.86, 2.35, 1909, 4], ['Londres', 51.47, -0.45, 1910, 4], ['Berlin', 52.52, 13.4, 1910, 2], ['New York', 40.64, -73.78, 1910, 4],
  ['Rome', 41.8, 12.25, 1912, 2], ['Tampa', 27.98, -82.53, 1914, 1], ['Los Angeles', 33.94, -118.41, 1915, 3], ['San Francisco', 37.62, -122.38, 1915, 2],
  ['Chicago', 41.98, -87.9, 1918, 3], ['Washington', 38.85, -77.04, 1918, 2], ['Toulouse', 43.63, 1.37, 1919, 1], ['Madrid', 40.47, -3.56, 1919, 2],
  ['Amsterdam', 52.31, 4.76, 1919, 2], ['Bruxelles', 50.9, 4.48, 1919, 1], ['Lille', 50.57, 3.09, 1920, 1], ['Lyon', 45.72, 5.08, 1920, 1],
  ['Marseille', 43.44, 5.21, 1920, 1], ['Genève', 46.24, 6.11, 1920, 1], ['Zurich', 47.46, 8.55, 1920, 1], ['Munich', 48.35, 11.79, 1920, 2],
  ['Vienne', 48.11, 16.57, 1920, 1], ['Copenhague', 55.62, 12.65, 1920, 1], ['Seattle', 47.45, -122.31, 1920, 2], ['Prague', 50.1, 14.26, 1923, 1],
  ['Moscou', 55.97, 37.41, 1923, 3], ['Stockholm', 59.65, 17.92, 1924, 1], ['Varsovie', 52.17, 20.97, 1925, 1], ['Casablanca', 33.37, -7.59, 1925, 1],
  ['Alger', 36.69, 3.21, 1925, 1], ['Saint-Pétersbourg', 59.8, 30.26, 1925, 1], ['Le Caire', 30.12, 31.4, 1927, 1], ['Dakar', 14.74, -17.49, 1927, 1],
  ['Boston', 42.36, -71.0, 1927, 2], ['Miami', 25.79, -80.29, 1927, 2], ['Dallas', 32.9, -97.04, 1928, 3], ['Montréal', 45.47, -73.74, 1928, 1],
  ['Mexico', 19.44, -99.07, 1928, 2], ['La Havane', 22.99, -82.41, 1928, 1], ['Shanghai', 31.14, 121.81, 1929, 3], ['Atlanta', 33.64, -84.43, 1930, 3],
  ['Denver', 39.86, -104.67, 1930, 2], ['Toronto', 43.68, -79.63, 1930, 2], ['Oslo', 60.19, 11.1, 1930, 1], ['Helsinki', 60.32, 24.96, 1930, 1],
  ['Kiev', 50.4, 30.45, 1930, 1], ['Bogotá', 4.7, -74.15, 1930, 1], ['Rio de Janeiro', -22.81, -43.25, 1930, 1], ['Buenos Aires', -34.82, -58.54, 1930, 1],
  ['Karachi', 24.9, 67.16, 1930, 1], ['Delhi', 28.56, 77.1, 1930, 2], ['Calcutta', 22.65, 88.45, 1930, 1], ['Jakarta', -6.13, 106.66, 1930, 1],
  ['Sydney', -33.95, 151.18, 1930, 2], ['Athènes', 37.94, 23.94, 1931, 1], ['Vancouver', 49.19, -123.18, 1931, 1], ['Bangkok', 13.69, 100.75, 1931, 2],
  ['Tokyo', 35.55, 139.78, 1931, 3], ['Bombay', 19.09, 72.87, 1932, 2], ['Johannesburg', -26.14, 28.24, 1932, 1], ['Le Cap', -33.97, 18.6, 1932, 1],
  ['Melbourne', -37.67, 144.84, 1932, 1], ['Istanbul', 41.26, 28.74, 1933, 2], ['Perth', -31.94, 115.97, 1934, 1], ['Lisbonne', 38.77, -9.13, 1935, 1],
  ['Lima', -12.02, -77.11, 1935, 1], ['Santiago', -33.39, -70.79, 1935, 1], ['Caracas', 10.6, -66.99, 1935, 1], ['Nairobi', -1.32, 36.93, 1935, 1],
  ['Manille', 14.51, 121.02, 1935, 1], ['Honolulu', 21.32, -157.92, 1935, 1], ['Anchorage', 61.17, -150.0, 1935, 1], ['Dublin', 53.42, -6.27, 1936, 1],
  ['São Paulo', -23.43, -46.47, 1936, 2], ['Lagos', 6.58, 3.32, 1936, 1], ['Hong Kong', 22.31, 113.91, 1936, 2], ['Pékin', 40.08, 116.58, 1936, 3],
  ['Singapour', 1.36, 103.99, 1937, 2], ['Téhéran', 35.69, 51.31, 1938, 1], ['Osaka', 34.43, 135.23, 1939, 1], ['Auckland', -37.0, 174.79, 1940, 1],
  ['Reykjavik', 64.13, -21.94, 1940, 1], ['Addis-Abeba', 8.98, 38.8, 1946, 1], ['Séoul', 37.46, 126.44, 1948, 2], ['Riyad', 24.96, 46.7, 1950, 1],
  ['Canton', 23.39, 113.3, 1950, 2], ['Chengdu', 30.58, 103.95, 1950, 2], ['Dubaï', 25.25, 55.36, 1960, 3], ['Doha', 25.27, 51.61, 1970, 1],
  ['Shenzhen', 22.64, 113.81, 1991, 2], ['Phoenix', 33.43, -112.01, 1930, 2], ['Houston', 29.98, -95.34, 1930, 2], ['Francfort', 50.03, 8.56, 1926, 3],
];
const SYN = (() => {
  const N = synthCloud.capacity, rnd = mulberry32(19031217);
  const s = { n: N, ax: new Float32Array(N), ay: new Float32Array(N), az: new Float32Array(N), bx: new Float32Array(N), by: new Float32Array(N), bz: new Float32Array(N),
    om: new Float32Array(N), dist: new Float32Array(N), minYear: new Float32Array(N), rank: new Float32Array(N), phase: new Float32Array(N), a: new Int16Array(N), b: new Int16Array(N) };
  const cv = CITIES.map(([, la, lo]) => llaToVec(la, lo, 1, new THREE.Vector3()));
  const totalW = CITIES.reduce((x, c) => x + c[4], 0);
  const pick = () => { let r = rnd() * totalW; for (let i = 0; i < CITIES.length; i++) { r -= CITIES[i][4]; if (r <= 0) return i; } return 0; };
  const early = CITIES.map((c, i) => i).filter((i) => CITIES[i][3] < 1916);
  const distYear = (d) => d < 400 ? 1910 : d < 1200 ? 1919 : d < 3000 ? 1930 : d < 6000 ? 1946 : d < 9000 ? 1958 : 1970;
  const A = new THREE.Vector3(), B = new THREE.Vector3();
  for (let i = 0; i < N; i++) {
    let ia, ib = -1, local = false;
    if (i === 0) { ia = 0; local = true; }                       // le Flyer des frères Wright
    else if (i < 500) { ia = early[Math.floor(rnd() * early.length)]; local = true; }
    else { ia = pick(); local = rnd() < 0.1; }
    A.copy(cv[ia]);
    let minY;
    if (local) {
      const brg = rnd() * TWO_PI, dk = (i === 0 ? 0.3 : i < 500 ? 2 + rnd() * 20 : 8 + rnd() * 200) / RE_KM;
      const la = CITIES[ia][1] * D2R, lo = CITIES[ia][2] * D2R;
      const la2 = Math.asin(Math.sin(la) * Math.cos(dk) + Math.cos(la) * Math.sin(dk) * Math.cos(brg));
      const lo2 = lo + Math.atan2(Math.sin(brg) * Math.sin(dk) * Math.cos(la), Math.cos(dk) - Math.sin(la) * Math.sin(la2));
      llaToVec(la2 * R2D, lo2 * R2D, 1, B);
      minY = CITIES[ia][3];
    } else {
      const r = rnd(), lo = r < 0.45 ? 150 : r < 0.8 ? 1500 : 4500, hi = r < 0.45 ? 1500 : r < 0.8 ? 4500 : 15000;
      let best = -1;
      for (let k = 0; k < 40; k++) {
        const j = pick(); if (j === ia) continue;
        const d = Math.acos(clamp(cv[ia].dot(cv[j]), -1, 1)) * RE_KM;
        if (d >= lo && d <= hi) { best = j; break; }
        if (best < 0) best = j;
      }
      ib = best; B.copy(cv[ib]);
      const d = Math.acos(clamp(A.dot(B), -1, 1)) * RE_KM;
      minY = Math.max(CITIES[ia][3], CITIES[ib][3], distYear(d));
    }
    const om = Math.acos(clamp(A.dot(B), -1, 1));
    s.ax[i] = A.x; s.ay[i] = A.y; s.az[i] = A.z; s.bx[i] = B.x; s.by[i] = B.y; s.bz[i] = B.z;
    s.om[i] = Math.max(om, 1e-6); s.dist[i] = om * RE_KM; s.minYear[i] = minY; s.rank[i] = i === 0 ? 0 : rnd(); s.phase[i] = rnd(); s.a[i] = ia; s.b[i] = ib;
    synthCloud.size[i] = 1;
    const cc = new THREE.Color('#ffcf8a'); synthCloud.col[i * 3] = cc.r; synthCloud.col[i * 3 + 1] = cc.g; synthCloud.col[i * 3 + 2] = cc.b;
  }
  s.sortedMin = Float32Array.from(s.minYear).sort();
  synthCloud.n = N; synthCloud.g.setDrawRange(0, N);
  synthCloud.g.attributes.aSize.needsUpdate = true; synthCloud.g.attributes.aColor.needsUpdate = true;
  return s;
})();
function eligibleCount(yf) { let lo = 0, hi = SYN.sortedMin.length; while (lo < hi) { const m = (lo + hi) >> 1; if (SYN.sortedMin[m] <= yf) lo = m + 1; else hi = m; } return lo; }

function synthLeg(i, t, yf) {
  const speed = interp(SPEED_KMH, yf);
  const legH = Math.max(SYN.dist[i] / speed, 0.15);
  const f = ((t / 3600000) / (2 * legH) + SYN.phase[i]) % 1;
  return f < 0.5 ? f * 2 : 2 - f * 2;
}
function synthPos(i, t, yf, out) {
  const u = synthLeg(i, t, yf), om = SYN.om[i], so = Math.sin(om);
  const k1 = Math.sin((1 - u) * om) / so, k2 = Math.sin(u * om) / so;
  out.set(SYN.ax[i] * k1 + SYN.bx[i] * k2, SYN.ay[i] * k1 + SYN.by[i] * k2, SYN.az[i] * k1 + SYN.bz[i] * k2).normalize();
  const altM = interp(ALT_KM, yf) * 1000 * Math.min(1, u * 8, (1 - u) * 8);
  return out.multiplyScalar(planeR(altM));
}
function updateSynth(t, show) {
  const { pos, vis } = synthCloud;
  const yf = yearFrac(t);
  const est = show ? airEstimate(yf) : 0;
  const frac = est > 0 ? Math.min(1, est / Math.max(1, eligibleCount(yf))) : 0;
  let n = 0;
  for (let i = 0; i < SYN.n; i++) {
    if (!show || SYN.minYear[i] > yf || SYN.rank[i] >= frac || (isolate ? !(isolate.kind === 'synth' && isolate.key === i) : !layerOn.planes)) { vis[i] = 0; continue; }
    synthPos(i, t, yf, vTmp);
    pos[i * 3] = vTmp.x; pos[i * 3 + 1] = vTmp.y; pos[i * 3 + 2] = vTmp.z;
    const sg = synthLeg(i, t + 30000, yf) >= synthLeg(i, t, yf) ? 1 : -1;   // aller (A→B) ou retour
    synthCloud.dir[i * 3] = (SYN.bx[i] - SYN.ax[i]) * sg; synthCloud.dir[i * 3 + 1] = (SYN.by[i] - SYN.ay[i]) * sg; synthCloud.dir[i * 3 + 2] = (SYN.bz[i] - SYN.az[i]) * sg;
    vis[i] = 1; n++;
  }
  counts.synth = show ? est : 0;
  counts.synthShown = n;
  synthCloud.g.attributes.position.needsUpdate = true; synthCloud.g.attributes.aVis.needsUpdate = true;
  synthCloud.g.attributes.aDir.needsUpdate = true;
}

// ------------------------------------------------------------------ temps
const T = { t: Date.now(), live: true, playing: true, speed: 1, dir: 1, future: false };
// allowFuture : aperçu d'un passage de satellite (jusqu'à 31 jours) ; les avions n'y sont pas affichés
function setTime(ms, keepPlaying = true, allowFuture = false) {
  const now = Date.now();
  T.t = clamp(ms, T_START, allowFuture ? now + 31 * DAY : now);
  T.future = T.t > now + 1000;
  T.live = false;
  if (!keepPlaying) T.playing = false;
  if (!T.future && now - T.t < 2000 && T.dir > 0 && T.speed <= 1) T.live = true;
  lastSatCompute = 0; lastEventT = T.t; orbitStamp = -1;
  syncTimeUI();
}
function goLive() {
  T.live = true; T.playing = true; T.speed = 1; T.dir = 1; T.t = Date.now(); T.future = false;
  $('#speed').value = '1'; lastSatCompute = 0; lastEventT = T.t; orbitStamp = -1;
  syncTimeUI();
}
function syncTimeUI() {
  $('#liveBadge').classList.toggle('on', T.live);
  $('#liveBadge').textContent = T.live ? '● DIRECT' : T.future ? '◷ FUTUR · revenir' : '○ Revenir au direct';
  $('#btnPlay').textContent = T.playing ? '❚❚' : '▶';
  $('#btnBack').classList.toggle('on', T.dir < 0);
}

// ------------------------------------------------------------------ frise temporelle
const tlCanvas = $('#tlChart'), tlCtx = tlCanvas.getContext('2d'), tlTrack = $('#tlTrack');
let rangeKey = $('#range').value;
function rangeBounds() {
  const now = Date.now();
  const map = { '1900': T_START, '1957': Date.UTC(1957, 0, 1), '10y': now - 10 * YEAR, '1y': now - YEAR, '30d': now - 30 * DAY, '7d': now - 7 * DAY, '1d': now - DAY };
  return [map[rangeKey] ?? T_START, now];
}
const tToX = (t, r0, r1, w) => (t - r0) / (r1 - r0) * w;
function drawChart() {
  const w = tlTrack.clientWidth, h = tlTrack.clientHeight, dpr = Math.min(devicePixelRatio || 1, 2);
  tlCanvas.width = w * dpr; tlCanvas.height = h * dpr;
  const g = tlCtx; g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
  const [r0, r1] = rangeBounds();
  const bins = Math.max(10, Math.floor(w / 3));
  const times = Array.from({ length: bins }, (_, k) => r0 + (k + 0.5) / bins * (r1 - r0));
  // satellites en orbite (balayage des lancements / rentrées)
  const series = [];
  if (chartEvents) {
    const c = [0, 0, 0]; let j = 0; const E = chartEvents, n = E.t.length;
    for (const tb of times) { while (j < n && E.t[j] <= tb) { c[E.g[j]] += E.d[j]; j++; } series.push([c[0], c[1], c[2]]); }
  }
  const air = times.map((tb) => airEstimate(yearFrac(tb)));
  const maxS = Math.max(10, ...series.map((s) => s[0] + s[1] + s[2])) * 1.08;
  const maxA = Math.max(10, ...air) * 1.15;
  const bw = w / bins;
  const colors = ['rgba(63,224,255,0.55)', 'rgba(255,138,61,0.55)', 'rgba(255,77,109,0.5)'];
  for (let k = 0; k < series.length; k++) {
    let y = h;
    for (let gI = 0; gI < 3; gI++) {
      const v = series[k][gI] / maxS * (h - 4);
      g.fillStyle = colors[gI]; g.fillRect(k * bw, y - v, bw + 0.5, v); y -= v;
    }
  }
  g.strokeStyle = 'rgba(255,195,90,0.95)'; g.lineWidth = 1.5; g.beginPath();
  air.forEach((v, k) => { const x = (k + 0.5) * bw, y = h - v / maxA * (h - 6) - 1; k ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.stroke();
  // graduations
  g.fillStyle = 'rgba(200,215,255,0.55)'; g.font = '10px Segoe UI, sans-serif'; g.textBaseline = 'top';
  const span = r1 - r0;
  if (span > 5 * YEAR) {
    const y0 = new Date(r0).getUTCFullYear(), y1 = new Date(r1).getUTCFullYear();
    const step = span > 80 * YEAR ? 10 : span > 30 * YEAR ? 5 : span > 12 * YEAR ? 2 : 1;
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) {
      const x = tToX(Date.UTC(y, 0, 1), r0, r1, w);
      g.fillRect(x, 0, 1, 4); g.fillText(String(y), x + 2, 2);
    }
  } else {
    const fmt = new Intl.DateTimeFormat('fr-FR', span > 60 * DAY ? { month: 'short', year: '2-digit' } : span > 2 * DAY ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' });
    const step = span > 60 * DAY ? 30 * DAY : span > 10 * DAY ? 5 * DAY : span > 2 * DAY ? DAY : 3 * 3600000;
    for (let t = Math.ceil(r0 / step) * step; t <= r1; t += step) { const x = tToX(t, r0, r1, w); g.fillRect(x, 0, 1, 4); g.fillText(fmt.format(t), x + 2, 2); }
  }
  // repères historiques
  const evDiv = $('#tlEvents'); evDiv.innerHTML = '';
  for (const ev of EVENTS) {
    if (ev.t < r0 || ev.t > r1) continue;
    const d = document.createElement('div'); d.className = 'ev'; d.style.left = tToX(ev.t, r0, r1, w) + 'px';
    d.dataset.t = ev.t; d.title = `${new Date(ev.t).toLocaleDateString('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })} — ${ev.text}`;
    evDiv.appendChild(d);
  }
  chartRange = [r0, r1];
}
let chartRange = [T_START, Date.now()];
function updateCursor() {
  const w = tlTrack.clientWidth, [r0, r1] = rangeBounds();
  const x = tToX(T.t, r0, r1, w);
  const cur = $('#tlCursor');
  cur.style.display = (x >= -1 && x <= w + 1) ? 'block' : 'none';
  cur.style.left = clamp(x, 0, w - 2) + 'px';
}
let tlDrag = false;
const xToT = (clientX) => { const rc = tlTrack.getBoundingClientRect(), [r0, r1] = rangeBounds(); return r0 + clamp((clientX - rc.left) / rc.width, 0, 1) * (r1 - r0); };
tlTrack.addEventListener('pointerdown', (e) => {
  if (e.target.classList.contains('ev')) { setTime(+e.target.dataset.t + 12 * 3600000); toastEvent(+e.target.dataset.t); return; }
  tlDrag = true; tlTrack.setPointerCapture(e.pointerId); setTime(xToT(e.clientX));
});
tlTrack.addEventListener('pointermove', (e) => {
  const t = xToT(e.clientX), hv = $('#tlHover'), rc = tlTrack.getBoundingClientRect();
  hv.style.display = 'block'; hv.style.left = (e.clientX - rc.left) + 'px';
  const yf = yearFrac(t);
  hv.textContent = fmtDate(t, (rangeBounds()[1] - rangeBounds()[0]) < 60 * DAY) + (yf >= 1903.9 ? ` · ≈ ${nf.format(airEstimate(yf))} avions` : ' · aucun avion');
  if (tlDrag) setTime(t);
});
tlTrack.addEventListener('pointerup', () => { tlDrag = false; });
tlTrack.addEventListener('pointerleave', () => { $('#tlHover').style.display = 'none'; });

let lastEventT = T.t;
function checkEvents(t) {
  if (!T.live && Math.abs(T.speed) <= 31557600 * 1.01) {
    const a = Math.min(lastEventT, t), b = Math.max(lastEventT, t);
    if (b - a < 20 * YEAR) for (const ev of EVENTS) if (ev.t > a && ev.t <= b) toastEvent(ev.t);
  }
  lastEventT = t;
}
function toastEvent(t) { const ev = EVENTS.find((e) => e.t === t); if (ev) toast(`<b>${new Date(ev.t).toLocaleDateString('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'long', year: 'numeric' })}</b> — ${esc(ev.text)}`, 'gold', 7000); }

// ------------------------------------------------------------------ affichage date / stats
const useUTC = () => $('#optUTC').checked;
function fmtDate(t, withTime = true) {
  const o = { day: 'numeric', month: 'long', year: 'numeric', timeZone: (useUTC() || !withTime) ? 'UTC' : undefined };
  if (withTime) { o.hour = '2-digit'; o.minute = '2-digit'; }
  return new Intl.DateTimeFormat('fr-FR', o).format(t);
}
let lastHud = 0;
function updateHud(now) {
  if (now - lastHud < 120) return; lastHud = now;
  const tz = useUTC() ? 'UTC' : undefined;
  $('#clockDate').textContent = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: tz }).format(T.t);
  $('#clockTime').textContent = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: tz }).format(T.t) + (useUTC() ? ' UTC' : '');
  const c = counts.cat;
  const inOrbit = c.reduce((a, b) => a + b, 0);
  const liveShown = isLiveWindow();
  if (liveShown) {
    $('#stPlanes').textContent = PL.ok ? nf.format(counts.planesAir) : '—';
    const ageMin = WEB && planesSnapshotTime ? Math.max(0, Math.round((Date.now() / 1000 - planesSnapshotTime) / 60)) : 0;
    $('#stPlanesL').textContent = !PL.ok ? 'avions : en attente' : WEB ? `avions en vol · relevé il y a ${ageMin} min` : 'avions en vol (direct)';
  } else if (T.t > Date.now()) {
    $('#stPlanes').textContent = '—';
    $('#stPlanesL').textContent = 'avions : futur inconnu';
  } else {
    $('#stPlanes').textContent = (counts.synth ? '≈ ' : '') + nf.format(counts.synth);
    $('#stPlanesL').textContent = 'avions en vol (estimation)';
  }
  $('#stActive').textContent = nf.format(c[0] + c[1] + c[2]);
  $('#stInactive').textContent = nf.format(c[3]);
  $('#stRB').textContent = nf.format(c[4]);
  $('#stDebris').textContent = nf.format(c[5] + c[6]);
  $('#stats').title = `${nf.format(inOrbit)} objets en orbite au total. Clic : afficher / masquer · Ctrl + clic : n'afficher que cette catégorie`;
  // compteurs des calques
  for (const L of LAYERS) {
    const el = document.querySelector(`.layer[data-id="${L.id}"] .n`); if (!el) continue;
    let v;
    if (L.id === 'planes') v = liveShown ? counts.planesAir : counts.synth;
    else if (L.id === 'ground') v = counts.planesGround;
    else v = c[CAT.indexOf(L.id)];
    el.textContent = nf.format(v || 0);
  }
  const empty = inOrbit === 0 && (liveShown ? counts.planesAir === 0 && PL.ok : counts.synth === 0) && S;
  $('#emptySky').style.display = empty ? 'block' : 'none';
  if (document.activeElement !== $('#dateInput')) {
    const d = new Date(T.t - (useUTC() ? 0 : new Date(T.t).getTimezoneOffset() * 60000));
    $('#dateInput').value = d.toISOString().slice(0, 16);
  }
}
const isLiveWindow = () => { const d = Date.now() - T.t; return d < LIVE_WINDOW && d > -60000; };

// ------------------------------------------------------------------ sélection, survol, informations
let sel = null;     // { kind: 'sat'|'plane'|'synth', key }
let hover = null;
let follow = false;
const selPos = new THREE.Vector3(), hovPos = new THREE.Vector3();
let orbitStamp = -1, orbitKey = null, hoverOrbitKey = null;

function objectPos(o, t, out) {
  if (!o) return null;
  if (o.kind === 'sat') { const i = S?.index.get(o.key); if (i === undefined || !(S.launch[i] <= t && t < S.decay[i])) return null; return satPos3(i, t, out); }
  if (o.kind === 'plane') { const p = PL.byIcao.get(o.key); if (!p || !isLiveWindow()) return null; const [la, lo] = planeLLDisp(p, t); return llaToVec(la, lo, planeR(p.alt), out); }
  if (o.kind === 'synth') { const yf = yearFrac(t); if (isLiveWindow() || synthCloud.vis[o.key] < 0.5) return null; return synthPos(o.key, t, yf, out); }
  return null;
}
function occluded(px, py, pz) {
  const C = camera.position, dx = px - C.x, dy = py - C.y, dz = pz - C.z;
  const dd = dx * dx + dy * dy + dz * dz, s = -(C.x * dx + C.y * dy + C.z * dz) / dd;
  if (s <= 0 || s >= 1) return false;
  const qx = C.x + s * dx, qy = C.y + s * dy, qz = C.z + s * dz;
  return qx * qx + qy * qy + qz * qz < 0.998;
}
const vpm = new THREE.Matrix4();
function pickAt(cx, cy, maxPx = 12) {
  vpm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const e = vpm.elements, W = innerWidth, H = innerHeight;
  let best = null, bestD = maxPx * maxPx;
  const test = (cloud, kind, keyOf) => {
    const { pos, vis } = cloud, n = cloud.n;
    for (let i = 0; i < n; i++) {
      if (vis[i] < 0.5) continue;
      const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
      const w = e[3] * x + e[7] * y + e[11] * z + e[15]; if (w <= 0) continue;
      const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * W;
      const sy = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5) * H;
      const d2 = (sx - cx) ** 2 + (sy - cy) ** 2;
      if (d2 < bestD && !occluded(x, y, z)) { bestD = d2; best = { kind, key: keyOf(i) }; }
    }
  };
  if (S) test(satCloud, 'sat', (i) => S.recs[i].norad);
  test(planeCloud, 'plane', (i) => PL.list[i].icao);
  test(synthCloud, 'synth', (i) => i);
  return best;
}

function select(o, fly = true) {
  sel = o; orbitStamp = -1; follow = false;
  if (o) { meteoPoint = null; meteoPin.visible = false; }
  if (o?.kind === 'plane') { fetchTrack(o.key); fetchFlightInfo(o.key); }
  if (o?.kind === 'sat') ensurePrecise(o.key).then((ok) => { if (ok && sel?.kind === 'sat' && sel.key === o.key) renderInfo(); });
  if (!o) { isolateObj(null); marker.visible = false; orbitLine.visible = false; trailLine.visible = false; $('#label').style.display = 'none'; renderInfo(); return; }
  if (!$('.tab[data-tab="vis"]').classList.contains('active') || o.kind !== 'sat') showTab('info');
  renderInfo();
  if (o.kind === 'sat') { $('#visSat').value = FAMOUS.some(([n]) => n === o.key) ? String(o.key) : 'sel'; refreshVisSelect(); if ($('.tab[data-tab="vis"]').classList.contains('active')) renderVis(); }
  if (fly) {
    const p = objectPos(o, T.t, new THREE.Vector3());
    if (p) { const d = Math.max(camera.position.length(), p.length() + 0.5); flyTo(p.clone().normalize().multiplyScalar(Math.min(d, p.length() + (o.kind === 'sat' ? 2.2 : 1.2))), new THREE.Vector3()); }
  }
}
// ---- infos de vol et trajectoire réelle (via le serveur local)
const flightInfo = new Map();   // icao -> { route, aircraft } | null (inconnu)
async function fetchFlightInfo(icao) {
  if (flightInfo.has(icao)) return;
  const p = PL.byIcao.get(icao); if (!p) return;
  flightInfo.set(icao, undefined);
  try {
    const r = await api(`/api/vol?hex=${encodeURIComponent(icao)}&cs=${encodeURIComponent((p.cs || '').toUpperCase())}`);
    const j = await r.json();
    const resp = j && j.response && typeof j.response === 'object' ? j.response : null;
    flightInfo.set(icao, resp ? { route: resp.flightroute || null, aircraft: resp.aircraft || null } : null);
  } catch { flightInfo.set(icao, null); }
  if (sel?.kind === 'plane' && sel.key === icao) renderInfo();
}
async function fetchTrack(icao, refresh = false) {
  const p = PL.byIcao.get(icao); if (!p) return;
  if (p.track && !refresh) return;
  if (p.trackTry && Date.now() - p.trackTry < 60000) return;
  p.trackTry = Date.now();
  try {
    const r = await api('/api/trajet?icao=' + encodeURIComponent(icao));
    if (!r.ok) return;
    const j = await r.json();
    if (j && Array.isArray(j.path) && j.path.length) {
      p.track = j.path.filter((q) => q[1] != null && q[2] != null).map((q) => [q[1], q[2], q[3] ?? p.alt ?? 0, q[0]]);
      if (sel?.kind === 'plane' && sel.key === icao) renderInfo();
    }
  } catch { /* trajectoire indisponible : on garde les positions reçues */ }
}

// ---- mode isolé : un seul objet à l'écran
let isolate = null;
function isolateObj(o) {
  isolate = o ? { kind: o.kind, key: o.key } : null;
  lastSatCompute = 0; lastTrails = 0;
  const chip = $('#isolateChip');
  if (isolate) { chip.querySelector('span').textContent = nameOf(o); chip.style.display = 'flex'; }
  else chip.style.display = 'none';
}
function nameOf(o) {
  if (!o) return '';
  if (o.kind === 'sat') return recs.get(o.key)?.name || `#${o.key}`;
  if (o.kind === 'plane') { const p = PL.byIcao.get(o.key); return p ? (p.cs || p.icao.toUpperCase()) + (airlineOf(p.cs) ? ' · ' + airlineOf(p.cs) : '') : o.key; }
  const i = o.key; return `Vol estimé ${CITIES[SYN.a[i]][0]} ↔ ${SYN.b[i] >= 0 ? CITIES[SYN.b[i]][0] : 'vol local'}`;
}

function row(k, v, id) { return `<tr><td>${k}</td><td${id ? ` id="${id}"` : ''}>${v}</td></tr>`; }
function renderInfo() {
  const box = $('#info');
  if (!sel && meteoPoint) { renderPointWeather(box); return; }
  if (!sel) {
    box.innerHTML = `<p class="muted">Cliquez sur un avion ou un satellite pour voir ses détails.</p>
      <div class="quick"><button data-pick="25544">Suivre l'ISS</button><button data-pick="48274">Station chinoise</button><button data-pick="20580">Hubble</button><button data-pick="1965-096A">Astérix (1965)</button></div>`;
    return;
  }
  const actions = `<div class="actions"><button id="btnFollow">${follow ? 'Ne plus suivre' : 'Suivre (F)'}</button><button id="btnGoto">Centrer</button><button id="btnUnsel">Fermer</button></div>`;
  if (sel.kind === 'sat') {
    const r = recs.get(sel.key), i = S.index.get(sel.key);
    const a = S.a[i], e = S.e[i];
    const decayed = isFinite(r.decay);
    box.innerHTML = `<h3>${esc(r.name)}</h3><div class="kind">${OTYPE[r.type] || 'Objet'} · ${r.ops ? (OPS[r.ops] || r.ops) : '—'}${r.sinceVisit ? ' <span class="tag new">NOUVEAU</span>' : ''}</div>${actions}
      <table>
      ${row('N° NORAD', r.norad)}${row('Désignation COSPAR', esc(r.cospar || '—'))}
      ${row('Propriétaire', esc(OWNERS[r.owner] || r.owner || '—'))}
      ${row('Lancement', (r.launchEstimated ? '≈ ' : '') + fmtDate(r.launch, false))}
      ${row('Site', esc(SITES[r.site] || r.site || '—'))}
      ${decayed ? row('Rentrée atmosphérique', fmtDate(r.decay, false)) : ''}
      ${row('Altitude', '—', 'iAlt')}${row('Vitesse', '—', 'iVel')}${row('Survole', '—', 'iLL')}
      ${row('Période', nf1.format(TWO_PI / S.mm[i] / 60) + ' min')}
      ${row('Inclinaison', nf1.format(Math.acos(S.ci[i]) * R2D) + '°')}
      ${row('Apogée / périgée', `${nf.format(Math.round(a * (1 + e) - RE_EQ))} / ${nf.format(Math.round(a * (1 - e) - RE_EQ))} km`)}
      </table>
      <div class="note">${S.precise[i] ? 'Position calculée à partir des éléments orbitaux CelesTrak du ' + fmtDate(r.gp.epoch, false) + '.' : 'Orbite approchée d\'après le catalogue : altitude et inclinaison réelles, mais l\'emplacement exact sur l\'orbite est indicatif.'}${S.precise[i] && Math.abs(T.t - r.gp.epoch) > 30 * DAY ? ' Loin de cette date, la position devient indicative.' : ''}</div>
      <div class="actions"><a href="https://celestrak.org/satcat/table-satcat.php?CATNR=${r.norad}" target="_blank">Fiche CelesTrak</a> · <a href="https://www.n2yo.com/satellite/?s=${r.norad}" target="_blank">N2YO</a></div>`;
  } else if (sel.kind === 'plane') {
    const p = PL.byIcao.get(sel.key);
    if (!p) { box.innerHTML = '<p class="muted">Cet avion n\'émet plus.</p>' + actions; return; }
    const fi = flightInfo.get(p.icao);
    const ap = (a) => a ? `${esc(a.municipality || a.name)}${a.iata_code ? ' (' + esc(a.iata_code) + ')' : ''}` : '?';
    const route = fi?.route ? `<div class="route"><div><b>${ap(fi.route.origin)}</b><small>${esc(fi.route.origin?.name || '')}</small></div><div class="arrow">✈</div><div><b>${ap(fi.route.destination)}</b><small>${esc(fi.route.destination?.name || '')}</small></div></div>` : '';
    const ac = fi?.aircraft;
    const company = fi?.route?.airline?.name || airlineOf(p.cs) || (ac?.registered_owner) || '—';
    box.innerHTML = `<h3>${esc(p.cs || p.icao.toUpperCase())}</h3><div class="kind">Avion · ${esc(company)}${p.ground ? ' · au sol' : ''}</div>${actions}
      ${route}
      ${ac?.url_photo_thumbnail ? `<img class="acphoto" src="${esc(ac.url_photo_thumbnail)}" alt="">` : ''}
      <table>
      ${row('Compagnie', esc(company))}
      ${ac ? row('Appareil', esc([ac.manufacturer, ac.type].filter(Boolean).join(' ')) + (ac.icao_type ? ` (${esc(ac.icao_type)})` : '')) : ''}
      ${ac ? row('Immatriculation', esc(ac.registration || '—')) : ''}
      ${row('Pays d\'immatriculation', esc(p.country || '—'))}
      ${row('Code OACI (transpondeur)', p.icao.toUpperCase())}${row('Indicatif', esc(p.cs || '—'))}
      ${row('Altitude', '—', 'iAlt')}${row('Vitesse', '—', 'iVel')}${row('Cap', '—', 'iHdg')}${row('Taux de montée', '—', 'iVr')}
      ${row('Position', '—', 'iLL')}${row('Squawk', esc(p.sq || '—'))}${row('Dernier signal', '—', 'iLast')}
      </table>
      <div class="note">Position et cap réels (ADS-B, réseau OpenSky)${WEB ? `, relevés à ${new Date((p.tpos || 0) * 1000).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })} (un relevé mondial toutes les 5 min)` : ''}. Entre deux relevés, l'avion avance selon sa vitesse et son cap mesurés. La ligne dorée est sa trajectoire réelle${p.track ? ' depuis le décollage' : WEB ? ' sur la dernière demi-heure environ (relevés successifs)' : ' depuis l\'ouverture de l\'appli'}.${fi?.route ? ' Itinéraire : base adsbdb (itinéraire habituel de ce numéro de vol).' : fi === null ? ' Itinéraire inconnu pour cet indicatif.' : ''}</div>
      <div class="actions"><a href="https://www.flightaware.com/live/flight/${encodeURIComponent(p.cs || '')}" target="_blank">FlightAware</a> · <a href="https://globe.adsbexchange.com/?icao=${p.icao}" target="_blank">ADS-B Exchange</a> · <a href="https://globe.airplanes.live/?icao=${p.icao}" target="_blank">airplanes.live</a></div>`;
  } else {
    const i = sel.key, yf = yearFrac(T.t);
    box.innerHTML = `<h3>${esc(nameOf(sel))}</h3><div class="kind">Simulation historique</div>${actions}
      <table>${row('Époque', String(Math.floor(yf)))}${row('Distance', nf.format(Math.round(SYN.dist[i])) + ' km')}
      ${row('Vitesse typique', nf.format(Math.round(interp(SPEED_KMH, yf))) + ' km/h')}${row('Altitude typique', nf1.format(interp(ALT_KM, yf)) + ' km')}
      ${row('Avions en vol (monde)', '≈ ' + nf.format(airEstimate(yf)))}</table>
      <div class="note">Il n'existe pas de trace des vols du passé : ce point illustre la densité estimée du trafic aérien de l'époque, sur des routes plausibles. Ce n'est pas un vol réel.</div>`;
  }
  $('#btnFollow').onclick = () => toggleFollow();
  $('#btnGoto').onclick = () => select(sel, true);
  $('#btnUnsel').onclick = () => select(null);
  lastInfo = 0;
}
let lastInfo = 0;
function updateInfoLive(now, t) {
  if (!sel || now - lastInfo < 400) return; lastInfo = now;
  const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
  const p = objectPos(sel, t, new THREE.Vector3());
  if (!p) { set('iAlt', sel.kind === 'sat' ? 'pas en orbite à cette date' : 'hors du temps réel'); set('iVel', '—'); set('iLL', '—'); return; }
  const ll = vecToLL(p);
  const llTxt = `${nf1.format(Math.abs(ll.lat))}° ${ll.lat >= 0 ? 'N' : 'S'}, ${nf1.format(Math.abs(ll.lon))}° ${ll.lon >= 0 ? 'E' : 'O'}`;
  if (sel.kind === 'sat') {
    const i = S.index.get(sel.key); satECI(i, t, eciTmp);
    const r = Math.hypot(eciTmp[0], eciTmp[1], eciTmp[2]);
    set('iAlt', nf.format(Math.round(r - RE_EQ)) + ' km');
    set('iVel', nf.format(Math.round(Math.sqrt(MU * (2 / r - 1 / S.a[i])) * 3600)) + ' km/h');
    set('iLL', llTxt);
  } else if (sel.kind === 'plane') {
    const pl = PL.byIcao.get(sel.key); if (!pl) return;
    set('iAlt', pl.ground ? 'au sol' : `${nf.format(Math.round(pl.alt || 0))} m (${nf.format(Math.round((pl.alt || 0) * 3.28084))} ft)`);
    set('iVel', nf.format(Math.round(pl.v * 3.6)) + ' km/h');
    set('iHdg', Math.round(pl.trk) + '°');
    set('iVr', pl.vr == null ? '—' : nf1.format(pl.vr) + ' m/s');
    set('iLL', llTxt);
    set('iLast', pl.last ? `il y a ${Math.max(0, Math.round(Date.now() / 1000 - pl.last))} s` : '—');
  }
}

function computeOrbitLine(line, o, t) {
  const i = S.index.get(o.key); if (i === undefined) { line.visible = false; return; }
  const P = line.geometry.attributes.position.array;
  const period = TWO_PI / S.mm[i] * 1000;
  for (let k = 0; k <= 360; k++) {
    satECI(i, t + (k / 360) * period, eciTmp);
    // repère inertiel (sans rotation terrestre) : on tourne la ligne entière avec le temps sidéral
    P[k * 3] = eciTmp[0] / RE_KM; P[k * 3 + 1] = eciTmp[2] / RE_KM; P[k * 3 + 2] = -eciTmp[1] / RE_KM;
  }
  line.geometry.attributes.position.needsUpdate = true;
  line.userData.t0 = t;
  line.visible = true;
}
function updateLines(t) {
  const g = gmst(t);
  // orbite de l'objet sélectionné
  if (sel?.kind === 'sat' && S && objectPos(sel, t, selPos)) {
    if (orbitKey !== sel.key || orbitStamp < 0 || Math.abs(t - orbitStamp) > 3 * 3600000) { computeOrbitLine(orbitLine, sel, t); orbitStamp = t; orbitKey = sel.key; }
    orbitLine.rotation.y = -g;
  } else orbitLine.visible = false;
  // orbite au survol
  if ($('#optOrbitHover').checked && hover?.kind === 'sat' && S && hover.key !== sel?.key) {
    if (hoverOrbitKey !== hover.key || Math.abs(t - (hoverOrbitLine.userData.t0 || 0)) > 3 * 3600000) { computeOrbitLine(hoverOrbitLine, hover, t); hoverOrbitKey = hover.key; }
    hoverOrbitLine.rotation.y = -g;
  } else hoverOrbitLine.visible = false;
  // trajet réel de l'avion sélectionné (trajectoire OpenSky depuis le décollage + positions reçues ensuite)
  if (sel?.kind === 'plane' && isLiveWindow()) {
    const p = PL.byIcao.get(sel.key);
    if (p) {
      const P = trailLine.geometry.attributes.position.array;
      let pts = [];
      if (p.track && p.track.length) {
        const tEnd = p.track[p.track.length - 1][3];
        pts = p.track.concat(p.trail.filter((q) => q[3] > tEnd));
      } else pts = p.trail.slice();
      pts = pts.slice(-3998);
      pts.forEach(([la, lo, al], k) => { llaToVec(la, lo, planeR(al), vTmp); P[k * 3] = vTmp.x; P[k * 3 + 1] = vTmp.y; P[k * 3 + 2] = vTmp.z; });
      const [la, lo] = planeLLDisp(p, t); llaToVec(la, lo, planeR(p.alt), vTmp);
      const n = pts.length; P[n * 3] = vTmp.x; P[n * 3 + 1] = vTmp.y; P[n * 3 + 2] = vTmp.z;
      trailLine.geometry.setDrawRange(0, n + 1); trailLine.geometry.attributes.position.needsUpdate = true; trailLine.visible = n > 0;
    }
  } else trailLine.visible = false;
}

// ------------------------------------------------------------------ caméra : vols, suivi
let anim = null;
function flyTo(pos, target, dur = 1400) {
  anim = { p0: camera.position.clone(), p1: pos.clone(), t0: controls.target.clone(), t1: target.clone(), start: performance.now(), dur };
}
function stepAnim(now) {
  if (!anim) return;
  const k = clamp((now - anim.start) / anim.dur, 0, 1), s = k * k * (3 - 2 * k);
  // interpolation sphérique de la direction, linéaire de la distance
  const l0 = anim.p0.length(), l1 = anim.p1.length();
  const d0 = anim.p0.clone().normalize(), d1 = anim.p1.clone().normalize();
  const om = Math.acos(clamp(d0.dot(d1), -1, 1));
  let dir;
  if (om < 1e-4) dir = d1; else { const so = Math.sin(om); dir = d0.multiplyScalar(Math.sin((1 - s) * om) / so).add(d1.multiplyScalar(Math.sin(s * om) / so)); }
  const lift = Math.sin(Math.PI * s) * Math.min(om, 1.2) * 0.6;
  camera.position.copy(dir.normalize().multiplyScalar(l0 + (l1 - l0) * s + lift));
  controls.target.lerpVectors(anim.t0, anim.t1, s);
  if (k >= 1) anim = null;
}
function viewLL(lat, lon, dist) { flyTo(llaToVec(lat, lon, dist, new THREE.Vector3()), new THREE.Vector3()); }
const VIEWS = { europe: [48, 10, 2.1], france: [46.6, 2.5, 1.42], usa: [39, -97, 2.2], asie: [32, 108, 2.5], leo: [25, 0, 2.6], geo: [10, 10, 16], pole: [89, 0, 3.2] };
function toggleFollow() {
  if (!sel) return;
  follow = !follow;
  if (follow) {
    const p = objectPos(sel, T.t, new THREE.Vector3());
    if (p) { const off = p.clone().normalize().multiplyScalar(sel.kind === 'sat' ? 0.35 : 0.06); flyTo(p.clone().add(off), p, 1000); followPrev.copy(p); }
  } else flyTo(camera.position.clone().normalize().multiplyScalar(Math.max(camera.position.length(), 1.6)), new THREE.Vector3(), 900);
  renderInfo();
}
const followPrev = new THREE.Vector3();
function resetCam() { follow = false; if (camMode !== 'orbit') makeControls('orbit'); flyTo(camera.position.clone().normalize().multiplyScalar(3.4), new THREE.Vector3()); renderInfo(); }

// ------------------------------------------------------------------ interactions souris / clavier
let downXY = null, lastHoverPick = 0;
canvas.addEventListener('pointerdown', (e) => { downXY = [e.clientX, e.clientY]; anim = null; });
canvas.addEventListener('pointerup', (e) => {
  if (!downXY || e.button !== 0) return;
  if (Math.hypot(e.clientX - downXY[0], e.clientY - downXY[1]) < 5) {
    if (pickingLoc) {
      pickingLoc = false; canvas.style.cursor = '';
      const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1), camera);
      const hit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
      if (hit) { const ll = vecToLL(hit); setObserver({ lat: ll.lat, lon: ll.lon, name: 'Point choisi sur le globe' }); showTab('vis'); }
      downXY = null; return;
    }
    const o = pickAt(e.clientX, e.clientY);
    if (o) select(o, false);
    else if ($('#optMeteoClic').checked) clickWeather(e);   // clic sur la Terre : météo du lieu
  }
  downXY = null;
});
canvas.addEventListener('pointermove', (e) => {
  const now = performance.now(); if (now - lastHoverPick < 70 || (e.buttons & 1)) return; lastHoverPick = now;
  hover = pickAt(e.clientX, e.clientY, 9);
  const tip = $('#tooltip');
  if (hover) {
    tip.style.display = 'block'; tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY + 10 + 'px';
    tip.textContent = nameOf(hover); canvas.style.cursor = 'pointer';
  } else { tip.style.display = 'none'; canvas.style.cursor = ''; }
});
canvas.addEventListener('pointerleave', () => { $('#tooltip').style.display = 'none'; hover = null; });
canvas.addEventListener('dblclick', (e) => {
  const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1), camera);
  const hit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
  if (!hit) return;
  follow = false;
  const h = camera.position.length() - 1;
  flyTo(hit.clone().normalize().multiplyScalar(1 + Math.max(h * 0.45, 0.02)), new THREE.Vector3(), 1100);
});
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  const h = camera.position.length() - 1, ang = clamp(h * 0.08, 0.002, 0.12);
  const right = new THREE.Vector3().crossVectors(camera.up, camera.position).normalize();
  switch (e.key) {
    case 'ArrowLeft': camera.position.applyAxisAngle(camera.up, -ang); break;
    case 'ArrowRight': camera.position.applyAxisAngle(camera.up, ang); break;
    case 'ArrowUp': camera.position.applyAxisAngle(right, -ang); break;
    case 'ArrowDown': camera.position.applyAxisAngle(right, ang); break;
    case '+': case '=': camera.position.lerp(controls.target, 0.15); break;
    case '-': case '_': camera.position.sub(controls.target).multiplyScalar(1.18).add(controls.target); break;
    case ' ': T.playing = !T.playing; if (!T.playing) T.live = false; syncTimeUI(); break;
    case 'l': case 'L': goLive(); break;
    case 'r': case 'R': resetCam(); break;
    case 'f': case 'F': toggleFollow(); break;
    case 'Escape': if (isolate) isolateObj(null); else select(null); break;
    default: return;
  }
  e.preventDefault();
});

// ------------------------------------------------------------------ panneaux
function buildLayers() {
  $('#layers').innerHTML = LAYERS.map((L) => `<div class="layer${layerOn[L.id] ? '' : ' off'}" data-id="${L.id}"><span class="dot" style="background:${L.color};color:${L.color}"></span>${L.label}<span class="n">0</span></div>`).join('');
  $$('.layer').forEach((el) => el.addEventListener('click', () => {
    const id = el.dataset.id; layerOn[id] = !layerOn[id]; isolateObj(null); syncLayersUI();
  }));
}
function syncLayersUI() {
  $$('.layer').forEach((el) => el.classList.toggle('off', !layerOn[el.dataset.id]));
  $$('.stat[data-g]').forEach((el) => el.classList.toggle('off', !GROUPS[el.dataset.g].some((id) => layerOn[id])));
  lastSatCompute = 0; lastTrails = 0;
}
// clic sur une carte : afficher / masquer ; Ctrl + clic : n'afficher que celle-ci
function toggleGroup(g, solo) {
  const ids = GROUPS[g];
  if (solo) for (const L of LAYERS) layerOn[L.id] = ids.includes(L.id);
  else { const anyOn = ids.some((id) => layerOn[id]); ids.forEach((id) => { layerOn[id] = !anyOn; }); }
  isolateObj(null); syncLayersUI();
}
$$('.stat[data-g]').forEach((el) => el.addEventListener('click', (e) => toggleGroup(el.dataset.g, e.ctrlKey || e.metaKey)));
$('#statAll').onclick = () => { for (const L of LAYERS) layerOn[L.id] = true; isolateObj(null); syncLayersUI(); };
$('#isolateChip button').onclick = () => isolateObj(null);
function showTab(name) {
  if (name === 'vis') setTimeout(renderVis, 0);
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  $$('.tab-page').forEach((p) => p.classList.toggle('active', p.dataset.page === name));
  $('#rightPanel').classList.remove('collapsed');
}
$$('.tab').forEach((t) => t.addEventListener('click', () => showTab(t.dataset.tab)));
$$('.collapse').forEach((b) => b.addEventListener('click', () => { $('#' + b.dataset.target).classList.toggle('collapsed'); }));

function renderNewList() {
  if (!S) return;
  const now = Date.now();
  const list = S.recs.filter((r) => now - r.launch < 30 * DAY || r.sinceVisit).sort((a, b) => b.launch - a.launch || b.norad - a.norad);
  $('#newCount').textContent = list.length;
  if (!list.length) { $('#newList').innerHTML = '<p class="muted">Aucun lancement récent dans les données.</p>'; return; }
  // regroupement par date de lancement
  let html = '', curDay = '';
  for (const r of list.slice(0, 400)) {
    const day = fmtDate(r.launch, false);
    if (day !== curDay) { html += `<h4>${day}${r.launchEstimated ? ' (≈)' : ''}</h4>`; curDay = day; }
    html += `<div class="newItem" data-norad="${r.norad}">${esc(r.name)} ${r.sinceVisit ? '<span class="tag new">NOUVEAU</span>' : ''}<div class="d">${OTYPE[r.type] || ''} · ${esc(OWNERS[r.owner] || r.owner || '')} · n° ${r.norad}</div></div>`;
  }
  $('#newList').innerHTML = html;
}
$('#newList').addEventListener('click', (e) => { const it = e.target.closest('.newItem'); if (it) { if (!T.live) goLive(); select({ kind: 'sat', key: +it.dataset.norad }); } });

let srcErrors = {}, ctPause = null, ctWarned = false, isRemoteViewer = false, webManifest = null;
async function fetchSrcErrors() {
  try { const j = await (await api('/api/etat')).json(); srcErrors = (j && j.erreurs) || {}; ctPause = (j && j.celestrak) || null; isRemoteViewer = !!(j && j.distant); webManifest = (j && j.manifest) || null; }
  catch { srcErrors = {}; ctPause = null; }
  renderSources();
  if (ctPause && !ctWarned) {
    ctWarned = true;
    toast(`<b>CelesTrak refuse l'accès depuis votre connexion</b> (${esc(ctPause.reason)}). L'appli respecte sa règle : plus de requête avant ${new Date(ctPause.until * 1000).toLocaleString('fr-FR', { weekday: 'short', hour: '2-digit', minute: '2-digit' })}. En attendant, les satellites viennent des sources de secours. Détails : onglet Sources.`, 'warn', 25000, () => showTab('sources'));
  }
}
function renderSources() {
  const ago = (ms) => { if (!ms) return 'jamais'; const s = Math.round((Date.now() - ms) / 1000); return s < 90 ? `il y a ${s} s` : s < 5400 ? `il y a ${Math.round(s / 60)} min` : `il y a ${Math.round(s / 3600)} h`; };
  $('#sourcesInfo').innerHTML = `
    <div class="src"><b>Avions en direct</b> — OpenSky Network<br>
      ${PL.ok ? `<span class="ok">● ${nf.format(PL.list.length)} appareils</span>, données ${ago(PL.fetched * 1000)}` : '<span class="ko">● en attente</span>'}<br>
      Accès : ${PL.auth ? 'compte OpenSky (quota élevé)' : 'anonyme (quota réduit)'} · rafraîchi toutes les ${PL.refresh} s
      ${PL.message ? `<div class="note">${esc(PL.message)}</div>` : ''}</div>
    ${WEB ? `<div class="src"><b>Version web — données publiées par GitHub</b><br>
      Satellites : ${webManifest ? 'relevés le ' + new Date(webManifest.genere).toLocaleString('fr-FR') : '—'} (toutes les 3 h)${webManifest ? ` · catalogue ${esc(webManifest.catalogue_source || '?')} · orbites ${esc(webManifest.satellites_source || '?')}` : ''}<br>
      Avions : ${planesSnapshotTime ? 'relevé le ' + new Date(planesSnapshotTime * 1000).toLocaleString('fr-FR') : '—'} (toutes les 5 min environ ; GitHub retarde parfois ses tâches)</div>` : ''}
    ${ctPause ? `<div class="src"><div class="note"><b>CelesTrak en pause</b> : refus reçu le ${new Date(ctPause.since * 1000).toLocaleString('fr-FR')} (${esc(ctPause.reason)}). Pour respecter sa règle d'usage, l'appli ne l'interroge plus avant le ${new Date(ctPause.until * 1000).toLocaleString('fr-FR')}. Les sources de secours prennent le relais.${isRemoteViewer ? '' : '<br><button id="ctRetry" style="margin-top:6px">Réessayer CelesTrak maintenant (une fois)</button>'}</div></div>` : ''}
    <div class="src"><b>Satellites actifs</b> — ${esc(satSource.gp || 'CelesTrak')}<br>
      ${satDataTime.gp ? `<span class="ok">● chargés</span> ${ago(satDataTime.gp)}` : '<span class="ko">● indisponibles</span> (récupérés un par un à la demande)'} · positions précises
      ${srcErrors['gp_actifs.json'] ? `<div class="small muted">${esc(srcErrors['gp_actifs.json'])}</div>` : ''}${srcErrors['secours gp_actifs.json'] ? `<div class="small muted">Secours : ${esc(srcErrors['secours gp_actifs.json'])}</div>` : ''}</div>
    <div class="src"><b>Historique spatial</b> — ${esc(satSource.cat || 'CelesTrak')}${satSource.cat.startsWith('GCAT') ? ' — données GCAT (J. McDowell, planet4589.org/space/gcat)' : ''}<br>
      ${satDataTime.cat ? `<span class="ok">● ${nf.format(S ? S.n : 0)} objets depuis 1957</span> ${ago(satDataTime.cat)}` : '<span class="ko">● indisponible</span>'}
      ${srcErrors['satcat.csv'] ? `<div class="small muted">${esc(srcErrors['satcat.csv'])}</div>` : ''}${srcErrors['secours satcat.csv'] ? `<div class="small muted">Secours : ${esc(srcErrors['secours satcat.csv'])}</div>` : ''}<br>
      Débris, étages et satellites éteints : altitude et inclinaison réelles, emplacement sur l'orbite indicatif. Un satellite aujourd'hui hors service est considéré comme actif pendant ses 8 premières années.</div>
    <div class="src"><b>Avions avant aujourd'hui</b> — estimation<br>Aucune base ne conserve tous les vols depuis 1903. Avant le direct, l'appli affiche une simulation dont le nombre d'appareils suit des ordres de grandeur historiques (courbe dorée de la frise), sur des routes entre villes desservies à l'époque.</div>
    <div class="src"><b>Imagerie détaillée (zoom)</b><br>${Object.values(IMAGERIES).map((i) => i.credit).join('<br>')}</div>
    <div class="src"><b>Météo</b><br>Nuages : EUMETSAT (anneau géostationnaire, Meteosat) et NASA GIBS (GOES, Himawari) · Pluie : NASA GPM IMERG · Vents : NOAA GFS. Relevés toutes les heures par GitHub, 72 h d'historique. Météo au clic : Open-Meteo (CC BY 4.0), archives depuis 1940.<br><small class="muted">We acknowledge the use of imagery provided by services from NASA's Global Imagery Browse Services (GIBS), part of NASA's Earth Science Data and Information System (ESDIS).</small></div>
    <div class="src"><b>Avions : que compte-t-on ?</b><br>Le nombre affiché correspond aux avions <i>en vol</i> captés à cet instant par les récepteurs bénévoles du réseau OpenSky (les avions au sol sont comptés à part, dans le panneau Calques). Ce sont de vrais signaux, mais pas la totalité du trafic mondial : au-dessus des océans et de certaines régions, il n'y a pas de récepteur.</div>
    <div class="src"><b>Mises à jour</b><br>Avions : en continu. Satellites : contrôle toutes les 30 min (CelesTrak publie plusieurs fois par jour). Les nouveaux lancements apparaissent tout seuls et clignotent en vert.</div>`;
  const btn = document.getElementById('ctRetry');
  if (btn) btn.onclick = async () => { btn.disabled = true; btn.textContent = 'Essai en cours…'; await api('/api/celestrak_reessayer'); ctWarned = false; await loadSatData(false); };
}

// ------------------------------------------------------------------ recherche globale (en haut)
// compagnies aériennes : code OACI de l'indicatif -> nom
const AIRLINES = { AFR: 'Air France', HOP: 'Air France Hop', TVF: 'Transavia France', TRA: 'Transavia', EZY: 'easyJet', EJU: 'easyJet Europe', EZS: 'easyJet Switzerland',
  RYR: 'Ryanair', RUK: 'Ryanair UK', LDM: 'Lauda Europe', BAW: 'British Airways', SHT: 'British Airways Shuttle', VIR: 'Virgin Atlantic', DLH: 'Lufthansa', EWG: 'Eurowings',
  CFG: 'Condor', KLM: 'KLM', KLC: 'KLM Cityhopper', SWR: 'Swiss', AUA: 'Austrian Airlines', BEL: 'Brussels Airlines', IBE: 'Iberia', IBS: 'Iberia Express', VLG: 'Vueling',
  AEA: 'Air Europa', TAP: 'TAP Air Portugal', ITY: 'ITA Airways', SAS: 'SAS', NOZ: 'Norwegian', NSZ: 'Norwegian', FIN: 'Finnair', LOT: 'LOT Polish', CSA: 'Czech Airlines',
  WZZ: 'Wizz Air', WUK: 'Wizz Air UK', THY: 'Turkish Airlines', PGT: 'Pegasus', AEE: 'Aegean', ELY: 'El Al', CRL: 'Corsair', FBU: 'French Bee', ASL: 'Air Serbia',
  UAE: 'Emirates', QTR: 'Qatar Airways', ETD: 'Etihad', SVA: 'Saudia', MSR: 'EgyptAir', RAM: 'Royal Air Maroc', DAH: 'Air Algérie', TAR: 'Tunisair', ETH: 'Ethiopian Airlines',
  KQA: 'Kenya Airways', SAA: 'South African Airways', AAL: 'American Airlines', DAL: 'Delta Air Lines', UAL: 'United Airlines', SWA: 'Southwest', JBU: 'JetBlue',
  ASA: 'Alaska Airlines', NKS: 'Spirit', FFT: 'Frontier', SKW: 'SkyWest', RPA: 'Republic Airways', ENY: 'Envoy', ACA: 'Air Canada', WJA: 'WestJet', TSC: 'Air Transat',
  AMX: 'Aeroméxico', AVA: 'Avianca', LAN: 'LATAM', TAM: 'LATAM Brasil', GLO: 'Gol', AZU: 'Azul', ARG: 'Aerolíneas Argentinas', CPA: 'Cathay Pacific', CCA: 'Air China',
  CES: 'China Eastern', CSN: 'China Southern', CHH: 'Hainan Airlines', CXA: 'Xiamen Airlines', JAL: 'Japan Airlines', ANA: 'All Nippon Airways', KAL: 'Korean Air',
  AAR: 'Asiana', SIA: 'Singapore Airlines', THA: 'Thai Airways', MAS: 'Malaysia Airlines', GIA: 'Garuda Indonesia', PAL: 'Philippine Airlines', VNA: 'Vietnam Airlines',
  AIC: 'Air India', IGO: 'IndiGo', QFA: 'Qantas', VOZ: 'Virgin Australia', ANZ: 'Air New Zealand', FDX: 'FedEx', UPS: 'UPS Airlines', GEC: 'Lufthansa Cargo',
  CLX: 'Cargolux', BOX: 'AeroLogic', DHK: 'DHL Air', BCS: 'DHL (EAT Leipzig)', ABW: 'AirBridgeCargo', AFL: 'Aeroflot', SDM: 'Rossiya', VOE: 'Volotea', BTI: 'airBaltic',
  ICE: 'Icelandair', EIN: 'Aer Lingus', SXS: 'SunExpress', TUI: 'TUI', TOM: 'TUI Airways', JAF: 'TUI fly Belgium', AIZ: 'Arkia', RJA: 'Royal Jordanian', MEA: 'Middle East Airlines',
  OMA: 'Oman Air', GFA: 'Gulf Air', KAC: 'Kuwait Airways', PIA: 'PIA', ALK: 'SriLankan', NAX: 'Norwegian', CTM: 'Armée de l\'air (France)', FAF: 'Armée de l\'air (France)',
  RCH: 'US Air Force (Reach)', NJE: 'NetJets Europe', EJA: 'NetJets' };
const airlineOf = (cs) => { if (!cs || cs.length < 4) return ''; const c = cs.slice(0, 3).toUpperCase(); return /^[A-Z]{3}$/.test(c) ? (AIRLINES[c] || '') : ''; };
const norm = (x) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase();
// noms français -> noms du catalogue (en anglais)
const ALIASES = [[/^SPOUTNIK/, 'SPUTNIK'], [/^STATION SPATIALE( INTERNATIONALE)?$|^SSI$/, 'ISS (ZARYA)'], [/^STATION CHINOISE$|^TIANGONG$/, 'CSS (TIANHE)'],
  [/^HUBBLE/, 'HST'], [/^ASTERIX/, 'ASTERIX'], [/^MIR$/, 'MIR'], [/^JAMES WEBB|^JWST/, 'JWST'], [/^GALILEO/, 'GALILEO'], [/^VOSTOK/, 'VOSTOK'], [/^TELESTAR|^TELSTAR/, 'TELSTAR']];
let searchTimer = 0;
const gs = $('#gsearch'), gsBox = $('#gsearchResults');
gs.addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runSearch, 150); });
gs.addEventListener('focus', () => { if (gs.value.trim().length >= 2) runSearch(); });
gs.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const f = gsBox.querySelector('div[data-k]'); if (f) f.click(); } if (e.key === 'Escape') { gsBox.style.display = 'none'; gs.blur(); } });
document.addEventListener('click', (e) => { if (!e.target.closest('.gsearch')) gsBox.style.display = 'none'; });
function runSearch() {
  let q = norm(gs.value.trim());
  for (const [re, to] of ALIASES) if (re.test(q)) { q = to; break; }
  if (q.length < 2) { gsBox.style.display = 'none'; return; }
  const planes = [], sats = [];
  // avions : indicatif, code transpondeur, ou nom de compagnie (« air france », « ryanair »…)
  const codes = q.length >= 3 ? Object.entries(AIRLINES).filter(([, n]) => norm(n).includes(q)).map(([c]) => c) : [];
  for (const p of PL.list) {
    const cs = (p.cs || '').toUpperCase();
    if (cs.includes(q.replace(/\s/g, '')) || p.icao.toUpperCase() === q || (cs && codes.includes(cs.slice(0, 3)))) {
      planes.push({ kind: 'plane', key: p.icao, label: p.cs || p.icao.toUpperCase(), k: [airlineOf(p.cs) || p.country, p.ground ? 'au sol' : nf.format(Math.round(p.alt || 0)) + ' m'].join(' · ') });
      if (planes.length >= 25) break;
    }
  }
  if (S) {
    const num = /^\d+$/.test(q) ? +q : -1, t = T.t, hits = [];
    for (let i = 0; i < S.n; i++) {
      const r = S.recs[i];
      if (r.norad === num || (r.name && r.name.toUpperCase().includes(q)) || (r.cospar && r.cospar.toUpperCase() === q)) {
        const inOrbit = S.launch[i] <= t && t < S.decay[i];
        hits.push({ r, score: (r.norad === num ? 0 : r.name.toUpperCase().startsWith(q) ? 1 : 2) + (inOrbit ? 0 : 3) });
      }
    }
    hits.sort((a, b) => a.score - b.score || a.r.norad - b.r.norad);
    for (const h of hits.slice(0, 30)) {
      const r = h.r, gone = !(r.launch <= T.t && T.t < r.decay);
      sats.push({ kind: 'sat', key: r.norad, label: r.name, k: `${OTYPE[r.type] || ''} · ${new Date(r.launch).getUTCFullYear()}${gone ? (isFinite(r.decay) && r.decay <= T.t ? ' · rentré' : ' · pas encore lancé') : ''}` });
    }
  }
  const res = [...planes, ...sats];
  let html = '';
  if (planes.length) html += `<h5>✈ Avions en vol (${planes.length >= 25 ? '25+' : planes.length})</h5>` + planes.map((o, k) => `<div data-k="${k}">${esc(o.label)}<span class="k">${esc(o.k)}</span></div>`).join('');
  if (sats.length) html += `<h5>🛰 Satellites et objets spatiaux</h5>` + sats.map((o, k) => `<div data-k="${planes.length + k}">${esc(o.label)}<span class="k">${esc(o.k)}</span></div>`).join('');
  gsBox.innerHTML = html || '<p class="muted">Aucun résultat</p>';
  gsBox.style.display = 'block';
  gsBox.querySelectorAll('div[data-k]').forEach((d) => d.addEventListener('click', () => {
    const o = res[+d.dataset.k]; gsBox.style.display = 'none'; gs.blur();
    if (o.kind === 'sat') { const r = recs.get(o.key); if (!(r.launch <= T.t && T.t < r.decay)) setTime(isFinite(r.decay) && r.decay <= T.t ? r.launch + 2 * DAY : (T.live ? T.t : r.launch + 2 * DAY)); }
    if (o.kind === 'plane' && !isLiveWindow()) goLive();
    lastSatCompute = 0;
    select({ kind: o.kind, key: o.key });
    isolateObj(o);   // seul l'objet choisi reste à l'écran
  }));
}
function pickQuick(v) {
  if (!S) return;
  let norad = /^\d+$/.test(v) ? +v : null;
  if (!norad) { const r = S.recs.find((x) => x.cospar === v); if (r) norad = r.norad; }
  const r = recs.get(norad); if (!r) { toast('Objet introuvable dans les données.', 'warn'); return; }
  if (!(r.launch <= T.t && T.t < r.decay)) setTime(r.launch + 2 * DAY);
  select({ kind: 'sat', key: norad });
  if (r.norad === 25544 || r.norad === 48274) setTimeout(() => { if (!follow) toggleFollow(); }, 1450);
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-pick]'); if (b) pickQuick(b.dataset.pick); });

// commandes
buildLayers();
$('#liveBadge').onclick = goLive;
$('#btnPlay').onclick = () => { T.playing = !T.playing; if (!T.playing) T.live = false; syncTimeUI(); };
$('#btnBack').onclick = () => { T.dir = -T.dir; if (T.dir < 0) { T.live = false; T.playing = true; } syncTimeUI(); };
$('#speed').onchange = (e) => { T.speed = +e.target.value; T.playing = true; if (T.speed > 1) T.live = false; syncTimeUI(); };
$('#range').onchange = (e) => { rangeKey = e.target.value; drawChart(); };
$('#dateInput').onchange = (e) => {
  const v = e.target.value; if (!v) return;
  const [d, hm = '00:00'] = v.split('T'); const [y, mo, da] = d.split('-').map(Number); const [hh, mi] = hm.split(':').map(Number);
  const t = useUTC() ? Date.UTC(y, mo - 1, da, hh, mi) : new Date(y, mo - 1, da, hh, mi).getTime();
  setTime(t);
};
$$('[data-jump]').forEach((b) => b.addEventListener('click', () => {
  const s = b.dataset.jump; const [d, hm = '12:00'] = s.split('T'); const [y, mo, da] = d.split('-').map(Number); const [hh, mi] = hm.split(':').map(Number);
  setTime(Date.UTC(y, mo - 1, da, hh, mi));
  const ev = EVENTS.find((x) => Math.abs(x.t - Date.UTC(y, mo - 1, da)) < 2 * DAY); if (ev) toastEvent(ev.t);
  if (y === 1957) setTimeout(() => pickQuick('2'), 300);   // n° 2 = Spoutnik 1 (le n° 1 est son étage)
}));
$('#camMode').onclick = () => makeControls(camMode === 'orbit' ? 'free' : 'orbit');
$('#camReset').onclick = resetCam;
$$('[data-view]').forEach((b) => b.addEventListener('click', () => { follow = false; if (camMode !== 'orbit') makeControls('orbit'); const v = VIEWS[b.dataset.view]; viewLL(v[0], v[1], v[2]); }));
$('#optLight').onchange = (e) => { earthMat.uniforms.uLight.value = e.target.checked ? 1 : 0; };
$('#optAtmo').onchange = (e) => { atmo.visible = e.target.checked; };
$('#optStars').onchange = (e) => { stars.visible = e.target.checked; sunSprite.visible = e.target.checked; };
$('#optZoomCursor').onchange = (e) => { if (camMode === 'orbit') controls.zoomToCursor = e.target.checked; };
$('#optUTC').onchange = () => { lastHud = 0; if (sel) renderInfo(); renderNewList(); };
$('#optExag').oninput = (e) => { altExag = +e.target.value; $('#exagVal').textContent = altExag; };
let pointScale = 1; $('#optSize').oninput = (e) => { pointScale = +e.target.value; };
$('#optTrails').onchange = () => { lastTrails = 0; };
for (const id of ['optLight', 'optAtmo', 'optStars', 'optPulse', 'optOrbitHover', 'optSpin', 'optZoomCursor', 'optUTC', 'optTrails', 'optFamous', 'optNuages', 'optPluie', 'optVents', 'optMeteoClic']) {
  const v = lsGet('atlas.' + id); if (v !== null) { $('#' + id).checked = v === '1'; $('#' + id).dispatchEvent(new Event('change')); }
  $('#' + id).addEventListener('change', (e) => lsSet('atlas.' + id, e.target.checked ? '1' : '0'));
}

// notifications
function toast(html, cls = '', ms = 6000, onClick) {
  const d = document.createElement('div'); d.className = 'toast ' + cls; d.innerHTML = html;
  d.onclick = () => { if (onClick) onClick(); d.remove(); };
  $('#toasts').appendChild(d);
  while ($('#toasts').children.length > 4) $('#toasts').firstChild.remove();
  setTimeout(() => d.remove(), ms);
}

// ------------------------------------------------------------------ chargement des données
const STEPS = { engine: 'Moteur 3D', tex: 'Textures de la Terre', cat: 'Catalogue spatial (1957 → aujourd\'hui)', gp: 'Satellites actifs (orbites précises)', planes: 'Avions en direct' };
const stepState = {};
function step(id, ok, msg) { stepState[id] = { ok, msg }; renderSteps(); }
function renderSteps() {
  $('#loadSteps').innerHTML = Object.entries(STEPS).map(([k, label]) => {
    const s = stepState[k]; const cls = s ? (s.ok ? 'ok' : 'ko') : '';
    return `<li class="${cls}">${s ? (s.ok ? '✔' : '⚠') : '…'} ${label}${s && s.msg ? ' — ' + esc(s.msg) : ''}</li>`;
  }).join('');
}
step('engine', true);

async function loadSatData(first) {
  const prev = knownNorad;
  let gotCat = false, gotGp = false;
  const [catRes, gpRes] = await Promise.allSettled([
    api('/api/catalogue').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); }),
    api('/api/satellites').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
  ]);
  if (catRes.status === 'fulfilled') {
    const txt = catRes.value, gcat = txt.trimStart()[0] === '#';
    const n = gcat ? ingestGCAT(txt) : ingestSatcat(txt);
    gotCat = n > 0; if (gotCat) { satDataTime.cat = Date.now(); satSource.cat = gcat ? 'GCAT (secours)' : 'CelesTrak'; }
    step('cat', gotCat, gotCat ? `${nf.format(n)} objets · ${satSource.cat}` : 'vide');
  } else step('cat', false, 'aucune source joignable');
  if (gpRes.status === 'fulfilled' && Array.isArray(gpRes.value)) {
    const satnogs = gpRes.value.length && gpRes.value[0].tle1;
    const n = ingestGP(normalizeGP(gpRes.value));
    gotGp = n > 0; if (gotGp) { satDataTime.gp = Date.now(); satSource.gp = satnogs ? 'SatNOGS (secours)' : 'CelesTrak'; }
    step('gp', gotGp, `${nf.format(n)} satellites · ${satSource.gp}`);
  } else step('gp', false, 'aucune source joignable');
  fetchSrcErrors();
  if (!gotCat && !gotGp) return false;
  // nouveaux objets apparus pendant la session
  if (prev) {
    const fresh = [];
    for (const r of recs.values()) if (!prev.has(r.norad) && !isNaN(r.launch)) { sessionNew.add(r.norad); fresh.push(r); }
    fresh.sort((a, b) => b.launch - a.launch);
    fresh.slice(0, 4).forEach((r) => toast(`🛰 <b>Nouvel objet en orbite :</b> ${esc(r.name)} — lancé le ${fmtDate(r.launch, false)}`, 'green', 12000, () => select({ kind: 'sat', key: r.norad })));
    if (fresh.length > 4) toast(`… et ${fresh.length - 4} autres nouveaux objets (onglet « Nouveaux »)`, 'green', 12000, () => showTab('new'));
  }
  knownNorad = new Set(recs.keys());
  buildSats();
  gpTried.clear();
  if (!gotGp) { fetchSrcErrors(); for (const [n] of [[25544], [48274], [20580]]) ensurePrecise(n); }
  if (sel?.kind === 'sat') renderInfo();
  return true;
}

// ------------------------------------------------------------------ étiquettes permanentes (ISS…)
const FAMOUS = [[25544, 'ISS'], [48274, 'Tiangong'], [20580, 'Hubble']];
const famousDivs = FAMOUS.map(([n, lab]) => {
  const d = document.createElement('div'); d.className = 'famous'; d.textContent = lab;
  d.onclick = () => select({ kind: 'sat', key: n });
  document.body.appendChild(d); return d;
});
const famV = new THREE.Vector3();
function updateFamous(t) {
  const on = $('#optFamous').checked;
  FAMOUS.forEach(([n], k) => {
    const d = famousDivs[k]; let show = false;
    const i = S ? S.index.get(n) : undefined;
    if (on && i !== undefined && satCloud.vis[i] > 0.5 && !(sel?.kind === 'sat' && sel.key === n)) {
      satPos3(i, t, famV);
      if (!occluded(famV.x, famV.y, famV.z)) {
        famV.project(camera);
        if (famV.z < 1) { show = true; d.style.left = (famV.x * 0.5 + 0.5) * innerWidth + 'px'; d.style.top = (0.5 - famV.y * 0.5) * innerHeight + 'px'; }
      }
    }
    d.style.display = show ? 'block' : 'none';
  });
}

// ------------------------------------------------------------------ visibilité d'un satellite depuis un lieu
const WGS_A = 6378.137, WGS_E2 = (1 / 298.257223563) * (2 - 1 / 298.257223563);
let obsLoc = null;
try { obsLoc = JSON.parse(lsGet('atlas.obs') || 'null'); } catch { obsLoc = null; }
let pickingLoc = false;
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
function observer(lat, lon, hKm = 0.05) {
  const la = lat * D2R, lo = lon * D2R, sl = Math.sin(la), cl = Math.cos(la), so = Math.sin(lo), co = Math.cos(lo);
  const N = WGS_A / Math.sqrt(1 - WGS_E2 * sl * sl);
  return { p: [(N + hKm) * cl * co, (N + hKm) * cl * so, (N * (1 - WGS_E2) + hKm) * sl], up: [cl * co, cl * so, sl], east: [-so, co, 0], north: [-sl * co, -sl * so, cl] };
}
function satECEF(i, t, out) {
  satECI(i, t, eciTmp);
  const g = gmst(t), c = Math.cos(g), sn = Math.sin(g);
  out[0] = eciTmp[0] * c + eciTmp[1] * sn; out[1] = -eciTmp[0] * sn + eciTmp[1] * c; out[2] = eciTmp[2];
  return out;
}
function sunECEF(t) { const v = sunDirection(t, new THREE.Vector3()); return [v.x, -v.z, v.y]; }
function lookAngles(obs, sp) {
  const d = [sp[0] - obs.p[0], sp[1] - obs.p[1], sp[2] - obs.p[2]], r = Math.hypot(d[0], d[1], d[2]);
  return { el: Math.asin(dot3(d, obs.up) / r) * R2D, az: (Math.atan2(dot3(d, obs.east), dot3(d, obs.north)) * R2D + 360) % 360, range: r };
}
function sunlit(sp, sun) {
  const k = dot3(sp, sun); if (k >= 0) return true;
  return Math.hypot(sp[0] - k * sun[0], sp[1] - k * sun[1], sp[2] - k * sun[2]) > RE_EQ;   // hors du cône d'ombre de la Terre
}
const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
const dirName = (az) => COMPASS[Math.round(az / 22.5) % 16];
const DIR_FULL = { N: 'nord', NNE: 'nord-nord-est', NE: 'nord-est', ENE: 'est-nord-est', E: 'est', ESE: 'est-sud-est', SE: 'sud-est', SSE: 'sud-sud-est', S: 'sud', SSO: 'sud-sud-ouest', SO: 'sud-ouest', OSO: 'ouest-sud-ouest', O: 'ouest', ONO: 'ouest-nord-ouest', NO: 'nord-ouest', NNO: 'nord-nord-ouest' };

function computePasses(i, obs, t0, days = 10, minEl = 10) {
  const sp = new Float64Array(3);
  const elAt = (t) => lookAngles(obs, satECEF(i, t, sp)).el;
  const period = TWO_PI / S.mm[i];
  if (period > 6 * 3600) {   // orbite haute (géostationnaire…) : position quasi fixe dans le ciel
    const L = lookAngles(obs, satECEF(i, t0, sp));
    return { high: true, el: L.el, az: L.az };
  }
  const passes = [], step = 30000, tEnd = t0 + days * DAY;
  const refine = (a, b) => { let ea = elAt(a); for (let k = 0; k < 14; k++) { const m = (a + b) / 2, em = elAt(m); if ((em > 0) === (ea > 0)) { a = m; ea = em; } else b = m; } return (a + b) / 2; };
  const finish = (P) => {
    const sun = sunECEF((P.start + P.end) / 2);
    const sunEl = Math.asin(dot3(sun, obs.up)) * R2D;
    let maxEl = -90, tMax = P.start, visStart = null, visEnd = null, a10 = null, b10 = null;
    for (let tt = P.start; tt <= P.end; tt += 5000) {
      satECEF(i, tt, sp); const L = lookAngles(obs, sp);
      if (L.el > maxEl) { maxEl = L.el; tMax = tt; }
      if (L.el >= minEl) { if (a10 === null) a10 = tt; b10 = tt; }
      if (L.el >= minEl && sunEl < -6 && sunlit(sp, sun)) { if (visStart === null) visStart = tt; visEnd = tt; }
    }
    if (maxEl < minEl) return;
    const az = (tt) => lookAngles(obs, satECEF(i, tt, sp)).az;
    // s'arrête-t-il d'être visible parce qu'il entre dans l'ombre (et non parce qu'il descend) ?
    const shadowEnd = visEnd !== null && visEnd < b10 && !sunlit(satECEF(i, visEnd + 5000, sp), sun);
    const shadowStart = visStart !== null && visStart > a10 && !sunlit(satECEF(i, visStart - 5000, sp), sun);
    passes.push({ start: a10, end: b10, tMax, maxEl, azStart: az(a10), azMax: az(tMax), azEnd: az(b10), sunEl, visible: visStart !== null, visStart, visEnd, shadowEnd, shadowStart, cut: !!P.cut });
  };
  let prev = elAt(t0), cur = prev > 0 ? { start: t0, cut: true } : null;
  for (let t = t0 + step; t <= tEnd && passes.length < 80; t += step) {
    const el = elAt(t);
    if (!cur && el > 0 && prev <= 0) cur = { start: refine(t - step, t) };
    else if (cur && el <= 0 && prev > 0) { cur.end = refine(t - step, t); finish(cur); cur = null; }
    prev = el;
  }
  return { passes };
}

const pinMarker = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.fillStyle = '#ffd34d'; g.beginPath(); g.arc(32, 32, 10, 0, TWO_PI); g.fill();
  g.strokeStyle = '#ffd34d'; g.lineWidth = 3; g.beginPath(); g.arc(32, 32, 22, 0, TWO_PI); g.stroke();
  g.fillStyle = '#000'; g.beginPath(); g.arc(32, 32, 4, 0, TWO_PI); g.fill();
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), sizeAttenuation: false, transparent: true, depthWrite: false }));
  sp.scale.set(0.028, 0.028, 1); sp.visible = false; sp.renderOrder = 4; scene.add(sp); return sp;
})();
function setObserver(loc) {
  obsLoc = loc; lsSet('atlas.obs', JSON.stringify(loc));
  if (loc) { llaToVec(loc.lat, loc.lon, 1.002, pinMarker.position); pinMarker.visible = true; }
  renderVis();
}
function visTarget() {
  const v = $('#visSat').value;
  if (v === 'sel') return sel?.kind === 'sat' ? sel.key : null;
  return +v;
}
function refreshVisSelect() {
  const opt = $('#visSat').querySelector('option[value="sel"]');
  if (sel?.kind === 'sat') { opt.textContent = 'Objet sélectionné : ' + (recs.get(sel.key)?.name || sel.key); opt.disabled = false; }
  else { opt.textContent = 'Objet sélectionné (aucun)'; opt.disabled = true; if ($('#visSat').value === 'sel') $('#visSat').value = '25544'; }
}
let lastPasses = [];
function renderVis() {
  refreshVisSelect();
  const out = $('#passList');
  $('#locCurrent').innerHTML = obsLoc ? `📍 <b>${esc(obsLoc.name)}</b><br><span class="muted">${nf1.format(obsLoc.lat)}°, ${nf1.format(obsLoc.lon)}°</span>` : '<span class="muted">Aucun lieu choisi.</span>';
  if (!obsLoc) { out.innerHTML = '<p class="muted">Choisissez d\'abord un lieu d\'observation.</p>'; return; }
  if (!S) { out.innerHTML = '<p class="muted">Chargement des satellites…</p>'; return; }
  const norad = visTarget(); const i = norad != null ? S.index.get(norad) : undefined;
  if (i === undefined) { out.innerHTML = '<p class="muted">Satellite introuvable dans les données.</p>'; return; }
  const r = S.recs[i], now = Date.now();
  if (!(S.launch[i] <= now && now < S.decay[i])) { out.innerHTML = '<p class="muted">Cet objet n\'est plus en orbite.</p>'; return; }
  if (!S.precise[i]) {
    out.innerHTML = `<p class="muted">Récupération de l'orbite précise de ${esc(r.name)}…</p>`;
    ensurePrecise(norad).then((ok) => {
      if (ok) { renderVis(); if (sel?.kind === 'sat' && sel.key === norad) renderInfo(); return; }
      const err = srcErrors['gp_actifs.json'] || srcErrors.gp;
      out.innerHTML = `<div class="note">Impossible d'obtenir l'orbite précise de ${esc(r.name)} pour l'instant (CelesTrak et la source de secours n'ont pas répondu)${err ? ' : <i>' + esc(err) + '</i>' : ''}. Vérifiez la connexion Internet ; nouvel essai possible dans 2 minutes.</div>`;
    });
    return;
  }
  const res = computePasses(i, observer(obsLoc.lat, obsLoc.lon), now, 10, 10);
  if (res.high) {
    out.innerHTML = res.el > 0
      ? `<div class="note">${esc(r.name)} est sur une orbite haute : il reste presque immobile dans votre ciel, à <b>${Math.round(res.el)}°</b> de hauteur, direction <b>${dirName(res.az)}</b> (azimut ${Math.round(res.az)}°). Trop faible pour être vu à l'œil nu.</div>`
      : `<div class="note">${esc(r.name)} est sur une orbite haute et reste sous l'horizon depuis ce lieu.</div>`;
    return;
  }
  const onlyVis = $('#visOnly').checked;
  lastPasses = res.passes.filter((p) => !onlyVis || p.visible);
  const tz = useUTC() ? 'UTC' : undefined;
  const fD = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: tz });
  const fT = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: tz });
  let html = `<p class="small muted">${esc(r.name)} · 10 prochains jours · horaires au-dessus de 10° de hauteur. ${onlyVis ? `${lastPasses.length} passage(s) visible(s) à l'œil nu sur ${res.passes.length}.` : `${res.passes.length} passage(s).`}</p>`;
  if (!lastPasses.length) html += `<p class="muted">${onlyVis ? 'Aucun passage visible à l\'œil nu : le satellite passe de jour, ou la nuit dans l\'ombre de la Terre. Décochez le filtre pour voir tous les passages.' : 'Aucun passage au-dessus de 10°.'}</p>`;
  let curDay = '';
  lastPasses.forEach((p, k) => {
    const d = fD.format(p.start);
    if (d !== curDay) { html += `<h4>${d}</h4>`; curDay = d; }
    const dur = Math.max(1, Math.round((p.end - p.start) / 60000));
    const partial = p.visible && (p.visStart - p.start > 60000 || p.end - p.visEnd > 60000);
    const why = p.shadowEnd ? ' — il disparaît ensuite dans l\'ombre de la Terre' : p.shadowStart ? ' — il sort de l\'ombre de la Terre' : '';
    html += `<div class="pass${p.visible ? ' vis' : ''}" data-k="${k}">
      <div class="pt">${fT.format(p.start)} → ${fT.format(p.end)} <span class="muted">(${dur} min)</span>${p.visible ? '<span class="tag new">VISIBLE</span>' : `<span class="tag dim">${p.sunEl > -6 ? 'de jour' : 'dans l\'ombre'}</span>`}</div>
      <div class="pd">Apparaît au <b>${dirName(p.azStart)}</b>, culmine à <b>${Math.round(p.maxEl)}°</b> au ${dirName(p.azMax)} vers ${fT.format(p.tMax)}, disparaît au <b>${dirName(p.azEnd)}</b></div>
      ${partial ? `<div class="pd">👁 Visible de ${fT.format(p.visStart)} à ${fT.format(p.visEnd)}${why}</div>` : ''}
    </div>`;
  });
  html += `<div class="note">Hauteur : 0° = horizon, 90° = au-dessus de votre tête. « Visible » = le satellite est éclairé par le Soleil alors que le ciel est noir chez vous. Prévision calculée sur les orbites CelesTrak du jour : précise à environ une minute, refaites le calcul le jour même.</div>`;
  out.innerHTML = html;
}
$('#passList').addEventListener('click', (e) => {
  const el = e.target.closest('.pass'); if (!el) return;
  const p = lastPasses[+el.dataset.k]; const norad = visTarget();
  setTime(p.tMax - 90000, true, true);
  T.speed = 1; $('#speed').value = '1'; T.playing = true; syncTimeUI();
  toast(`Aperçu du passage : il apparaît côté <b>${DIR_FULL[dirName(p.azStart)]}</b> (azimut ${Math.round(p.azStart)}°) et culmine à ${Math.round(p.maxEl)}°. Touche L pour revenir au direct.`, 'green', 8000);
  select({ kind: 'sat', key: norad }, false);
  showTab('vis');
  // vue au-dessus du lieu d'observation
  follow = false; if (camMode !== 'orbit') makeControls('orbit');
  viewLL(obsLoc.lat, obsLoc.lon, 1.35);
});
$('#visSat').onchange = renderVis;
$('#visOnly').onchange = renderVis;
async function geocode() {
  const q = $('#locInput').value.trim(); if (q.length < 2) return;
  const box = $('#locResults');
  box.innerHTML = '<p class="muted">Recherche de l\'adresse…</p>';
  $('#passList').innerHTML = '<p class="muted">Recherche de l\'adresse…</p>';
  // 1) réseau : interroger le service d'adresses
  let list = null, why = '';
  try {
    const r = await api('/api/geocode?q=' + encodeURIComponent(q));
    const txt = await r.text();
    if (!r.ok) why = WEB ? 'les services d\'adresses (OpenStreetMap, IGN) n\'ont pas répondu' : `le serveur local a répondu « ${txt.slice(0, 60)} » (code ${r.status})`;
    else {
      const j = JSON.parse(txt);
      if (Array.isArray(j)) list = j.map((x) => ({ name: x.display_name, lat: +x.lat, lon: +x.lon }));                     // OpenStreetMap
      else if (j && Array.isArray(j.features)) list = j.features.map((f) => ({ name: [f.properties.label, f.properties.context].filter(Boolean).join(', '), lat: f.geometry.coordinates[1], lon: f.geometry.coordinates[0] }));   // IGN
      else why = 'aucun service d\'adresses n\'a répondu';
    }
  } catch (e) { why = 'serveur local injoignable (' + e.message + ')'; }
  if (!list) { box.innerHTML = `<p class="muted">Recherche d'adresse impossible : ${esc(why)}. Vous pouvez cliquer sur « Ma position » ou « Choisir sur le globe ».</p>`; renderVis(); return; }
  if (!list.length) { box.innerHTML = '<p class="muted">Adresse introuvable. Essayez avec la ville ou le code postal.</p>'; renderVis(); return; }
  // 2) le meilleur résultat est pris tout de suite : la liste des passages s'affiche immédiatement
  const use = (x) => { setObserver({ lat: x.lat, lon: x.lon, name: x.name.split(',').slice(0, 3).join(',') }); viewLL(x.lat, x.lon, 1.6); };
  const others = list.slice(1, 5);
  box.innerHTML = others.length ? '<p class="small muted" style="margin:4px 0 2px">Pas le bon endroit ? Autres lieux trouvés :</p>' + others.map((x, k) => `<div data-k="${k + 1}">${esc(x.name)}</div>`).join('') : '';
  box.querySelectorAll('div[data-k]').forEach((d) => d.onclick = () => { box.innerHTML = ''; use(list[+d.dataset.k]); });
  use(list[0]);
}
$('#locSearch').onclick = geocode;
$('#locInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') geocode(); });
$('#locGeo').onclick = () => {
  if (!navigator.geolocation) { toast('Géolocalisation indisponible.', 'warn'); return; }
  navigator.geolocation.getCurrentPosition(
    (pos) => { setObserver({ lat: pos.coords.latitude, lon: pos.coords.longitude, name: 'Ma position' }); viewLL(pos.coords.latitude, pos.coords.longitude, 1.6); },
    () => toast('Position refusée ou indisponible (vérifiez « Localisation » dans les paramètres de Windows). Tapez plutôt une adresse.', 'warn', 9000),
    { timeout: 15000 });
};
$('#locPick').onclick = () => { pickingLoc = true; canvas.style.cursor = 'crosshair'; toast('Cliquez sur le globe à l\'endroit voulu.', '', 5000); };
if (obsLoc) setObserver(obsLoc);

// ------------------------------------------------------------------ ⚙ Paramètres
function openSettings() {
  const m = $('#settingsModal');
  $('#setRefresh').value = settings.planesRefresh;
  $('#setImagerie').value = settings.imagerie || 'off';
  $('#setImagerieInfo').innerHTML = TL.src ? `${TL.ok} images chargées${TL.err ? `, <b>${TL.err} refusées</b> (service indisponible ? essayez l'autre source)` : ''}${TL.zMax ? ` · niveau de détail actuel : ${TL.zMax}` : ''}<br><small>${TL.src.credit}</small>` : 'Imagerie détaillée désactivée : seule l\'image de base de la Terre est utilisée.';
  m.querySelectorAll('.web-only').forEach((el) => { el.disabled = !WEB; });
  const ago = (t) => t ? `${new Date(t).toLocaleString('fr-FR')} (il y a ${Math.max(0, Math.round((Date.now() - t) / 60000))} min)` : '—';
  $('#setData').innerHTML = WEB
    ? `Satellites : ${ago(webManifest && Date.parse(webManifest.genere))}<br>Avions : ${ago(planesSnapshotTime * 1000)} · compte OpenSky : ${PL.auth ? 'oui' : 'non (anonyme)'}`
    : 'Appli Windows : données téléchargées par le serveur local (réglages dans config.json).';
  m.style.display = 'flex';
}
$('#btnSettings').onclick = openSettings;
$('#setCancel').onclick = () => { $('#settingsModal').style.display = 'none'; };
$('#settingsModal').addEventListener('click', (e) => { if (e.target.id === 'settingsModal') e.target.style.display = 'none'; });
$('#setReset').onclick = () => { settings = { ...SETTINGS_DEF }; lsSet('atlas.settings', JSON.stringify(settings)); openSettings(); };
$('#setSave').onclick = () => {
  settings = { ...settings, planesRefresh: clamp(+$('#setRefresh').value || 60, 30, 600), imagerie: $('#setImagerie').value };
  lsSet('atlas.settings', JSON.stringify(settings));
  PL.warned = false;
  $('#settingsModal').style.display = 'none';
  toast('Paramètres enregistrés.', 'green', 3000);
  if (WEB) fetchPlanesNow();
};

// ------------------------------------------------------------------ IMAGERIE DÉTAILLÉE
// L'image de base de la Terre (≈ 5 km par pixel) devient floue dès qu'on s'approche. En dessous d'environ
// 7 000 km d'altitude, le globe se couvre de « tuiles » d'images satellites de plus en plus fines,
// comme Google Earth : seules les tuiles visibles, au niveau de détail utile à l'écran, sont téléchargées.
const IMAGERIES = {
  eox: { nom: 'Sentinel-2 sans nuages (EOX, 10 m)', max: 14,
    url: (z, x, y) => `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless-2024_3857/default/g/${z}/${y}/${x}.jpg`,
    credit: 'Sentinel-2 cloudless 2024 – <a href="https://s2maps.eu" target="_blank" rel="noopener">s2maps.eu</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2024), CC BY-NC-SA 4.0' },
  esri: { nom: 'Esri World Imagery (jusqu\'à 1 m)', max: 18,
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
    credit: 'Imagerie © Esri, Maxar, Earthstar Geographics et la communauté des utilisateurs SIG' },
};
const TL = { tiles: new Map(), tex: new Map(), queue: [], loading: 0, lastUpd: 0, src: null, ok: 0, err: 0, shown: 0, zMax: 0 };
const TILE_R = 1.0001, TILE_Z0 = 3;
const tileVert = `uniform vec2 uvOff; uniform float uvScale; varying vec2 vUv; varying vec3 vN;
  void main(){ vUv = uvOff + uv * uvScale; vN = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
const tileFrag = `uniform sampler2D map; uniform vec3 sunDir; uniform float uLight; uniform float uFade; varying vec2 vUv; varying vec3 vN;
  void main(){
    vec3 c = texture2D(map, vUv).rgb;
    float d = dot(vN, sunDir);
    float day = uLight > 0.5 ? smoothstep(-0.08, 0.12, d) : 1.0;   // la nuit, on laisse voir les lumières des villes du globe
    if (uLight > 0.5) c *= 0.7 + 0.3 * clamp(d * 2.0 + 0.2, 0.0, 1.0);
    gl_FragColor = vec4(c, uFade * day);
  }`;
const tileFade = { value: 0 };
const mercLat = (fy) => Math.atan(Math.sinh(Math.PI * (1 - 2 * fy))) * R2D;   // fy : 0 en haut, 1 en bas
function tileBounds(z, x, y) {
  const n = 2 ** z;
  return { lon0: x / n * 360 - 180, lon1: (x + 1) / n * 360 - 180, lat0: mercLat(y / n), lat1: mercLat((y + 1) / n) };
}
function tileMesh(key, z, x, y) {
  let t = TL.tiles.get(key);
  if (t) { t.used = performance.now(); return t; }
  const b = tileBounds(z, x, y), n = 2 ** z;
  const seg = clamp(Math.ceil((b.lon1 - b.lon0) / 0.7), 2, 32);   // assez de facettes pour épouser la sphère
  const pos = new Float32Array((seg + 1) * (seg + 1) * 3), uv = new Float32Array((seg + 1) * (seg + 1) * 2), idx = [];
  const v = new THREE.Vector3();
  for (let j = 0; j <= seg; j++) {
    const lat = mercLat((y + j / seg) / n);
    for (let i = 0; i <= seg; i++) {
      const k = j * (seg + 1) + i;
      llaToVec(lat, b.lon0 + (b.lon1 - b.lon0) * i / seg, TILE_R, v);
      pos[k * 3] = v.x; pos[k * 3 + 1] = v.y; pos[k * 3 + 2] = v.z;
      uv[k * 2] = i / seg; uv[k * 2 + 1] = 1 - j / seg;
      if (i < seg && j < seg) idx.push(k, k + seg + 1, k + 1, k + 1, k + seg + 1, k + seg + 2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('uv', new THREE.BufferAttribute(uv, 2)); g.setIndex(idx);
  const m = new THREE.ShaderMaterial({ uniforms: { map: { value: null }, uvOff: { value: new THREE.Vector2() }, uvScale: { value: 1 },
    sunDir: earthMat.uniforms.sunDir, uLight: earthMat.uniforms.uLight, uFade: tileFade }, vertexShader: tileVert, fragmentShader: tileFrag, transparent: true, depthWrite: true });
  const mesh = new THREE.Mesh(g, m); mesh.renderOrder = 0.5; mesh.visible = false; mesh.frustumCulled = false; scene.add(mesh);
  t = { mesh, used: performance.now() };
  TL.tiles.set(key, t);
  if (TL.tiles.size > 400) {   // on libère les tuiles inutilisées depuis le plus longtemps
    const old = [...TL.tiles.entries()].filter(([, o]) => !o.mesh.visible).sort((a, b2) => a[1].used - b2[1].used).slice(0, 100);
    for (const [k, o] of old) { scene.remove(o.mesh); o.mesh.geometry.dispose(); o.mesh.material.dispose(); TL.tiles.delete(k); }
  }
  return t;
}
const tileLoader = new THREE.TextureLoader(); tileLoader.setCrossOrigin('anonymous');
function tileTex(key, z, x, y, want) {
  let e = TL.tex.get(key);
  if (e) { e.used = performance.now(); return e.ready ? e.tex : null; }
  if (!want) return null;
  e = { ready: false, used: performance.now(), z, x, y, key };
  TL.tex.set(key, e); TL.queue.push(e);
  return null;
}
function pumpTiles() {
  // les tuiles grossières d'abord (elles servent de fond pendant le chargement des fines)
  TL.queue.sort((a, b) => a.z - b.z || b.used - a.used);
  while (TL.loading < 8 && TL.queue.length) {
    const e = TL.queue.shift();
    if (performance.now() - e.used > 3000) { TL.tex.delete(e.key); continue; }   // plus à l'écran
    TL.loading++;
    const src = TL.src;
    e.tex = tileLoader.load(src.url(e.z, e.x, e.y), (t) => {
      TL.loading--; TL.ok++;
      t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
      e.ready = true; TL.lastUpd = 0;
    }, undefined, () => { TL.loading--; TL.err++; e.failed = true; setTimeout(() => { if (TL.tex.get(e.key) === e) TL.tex.delete(e.key); }, 60000); });
  }
  if (TL.tex.size > 260) {
    const old = [...TL.tex.values()].filter((o) => o.ready).sort((a, b) => a.used - b.used).slice(0, 60);
    for (const o of old) { o.tex.dispose(); TL.tex.delete(o.key); }
  }
}
const tlV = new THREE.Vector3(), tlC = new THREE.Vector3();
function updateTiles(now) {
  const src = IMAGERIES[settings.imagerie] || null;
  if (src !== TL.src) {   // changement de source : on repart de zéro
    for (const o of TL.tex.values()) o.tex?.dispose?.();
    TL.tex.clear(); TL.queue.length = 0; TL.src = src; TL.ok = TL.err = 0;
    for (const o of TL.tiles.values()) o.mesh.visible = false;
  }
  const camR = camera.position.length(), h = camR - 1;
  tileFade.value = src ? clamp((1.25 - h) / 0.4, 0, 1) : 0;
  if (!src || h > 1.25) { if (TL.shown) { for (const o of TL.tiles.values()) o.mesh.visible = false; TL.shown = 0; } return; }
  if (now - TL.lastUpd < 150) return;
  TL.lastUpd = now;
  const pxPerRad = innerHeight / (2 * Math.tan(camera.fov * D2R / 2));
  const frustum = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
  // Chaque tuile : visible si elle déborde sur la calotte que la caméra voit (au-dessus de l'horizon)
  // et dans le champ de la caméra. On raffine d'abord les tuiles qui paraissent les plus grandes à l'écran.
  const nadir = tlC.copy(camera.position).normalize(), horizon = Math.acos(Math.min(1, 1 / camR)) + 0.01;
  const info = (z, x, y) => {
    const b = tileBounds(z, x, y), latc = (b.lat0 + b.lat1) / 2, lonc = (b.lon0 + b.lon1) / 2;
    const c = llaToVec(latc, lonc, 1, new THREE.Vector3());
    let ang = 0, rad = 0;
    for (const [la, lo] of [[b.lat0, b.lon0], [b.lat0, b.lon1], [b.lat1, b.lon0], [b.lat1, b.lon1], [b.lat0, lonc], [b.lat1, lonc], [latc, b.lon0], [latc, b.lon1]]) {
      llaToVec(la, lo, 1, tlV); ang = Math.max(ang, Math.acos(clamp(tlV.dot(c), -1, 1))); rad = Math.max(rad, tlV.distanceTo(c));
    }
    if (Math.acos(clamp(c.dot(nadir), -1, 1)) - ang > horizon) return null;
    if (!frustum.intersectsSphere(new THREE.Sphere(c, rad * 1.05))) return null;
    const dist = Math.max(c.distanceTo(camera.position) - rad, 1e-4);
    return { z, x, y, px: (rad * 1.414) / dist * pxPerRad };   // côté approximatif de la tuile à l'écran, en pixels
  };
  let leaves = [];
  const n0 = 2 ** TILE_Z0;
  for (let y = 0; y < n0; y++) for (let x = 0; x < n0; x++) { const t = info(TILE_Z0, x, y); if (t) leaves.push(t); }
  for (let guard = 0; guard < 400; guard++) {
    let bi = -1, bp = 360;   // on découpe tant qu'une tuile dépasse ~1,4 × 256 pixels
    for (let i = 0; i < leaves.length; i++) if (leaves[i].px > bp && leaves[i].z < src.max) { bp = leaves[i].px; bi = i; }
    if (bi < 0 || leaves.length > 140) break;
    const t = leaves[bi]; leaves.splice(bi, 1);
    for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) { const c = info(t.z + 1, 2 * t.x + dx, 2 * t.y + dy); if (c) leaves.push(c); }
  }
  const want = leaves.map((t) => [t.z, t.x, t.y]);
  const show = new Set(); let zMax = 0;
  for (const [z, x, y] of want) {
    const key = `${z}/${x}/${y}`;
    let tex = tileTex(key, z, x, y, true), az = z, ax = x, ay = y;
    while (!tex && az > TILE_Z0) { az--; ax >>= 1; ay >>= 1; tex = tileTex(`${az}/${ax}/${ay}`, az, ax, ay, false); }
    if (!tex) { tileTex(`${TILE_Z0}/${x >> (z - TILE_Z0)}/${y >> (z - TILE_Z0)}`, TILE_Z0, x >> (z - TILE_Z0), y >> (z - TILE_Z0), true); continue; }
    const t = tileMesh(key, z, x, y), U = t.mesh.material.uniforms, dz = z - az, sc = 1 / 2 ** dz;
    U.map.value = tex; U.uvScale.value = sc;
    U.uvOff.value.set((x - (ax << dz)) * sc, 1 - (y - (ay << dz) + 1) * sc);
    t.mesh.visible = true; show.add(key); zMax = Math.max(zMax, az);
  }
  for (const [k, o] of TL.tiles) if (!show.has(k)) o.mesh.visible = false;
  TL.shown = show.size; TL.zMax = zMax;
  pumpTiles();
}

if (/[?&]debug\b/.test(location.search)) window.ATLAS_DEBUG = { camera, TL, get MET() { return MET; }, settings: () => settings };

// ------------------------------------------------------------------ MÉTÉO
// Couches (version web) : relevées toutes les heures par GitHub Actions, 72 h d'historique (window.ATLAS_METEO).
//   nuages : infrarouge des satellites géostationnaires (EUMETSAT + NASA GIBS)
//   pluie  : NASA GPM IMERG (observations, ~5 h de décalage)
//   vents  : modèle NOAA GFS, vent à 10 m, animé en particules
// Météo d'un point au clic : Open-Meteo (prévisions, 92 derniers jours, archives depuis 1940).
const METEO = window.ATLAS_METEO || '';
const MET = { man: null, lists: { nuages: [], pluie: [], vents: [] }, tex: new Map(), wind: new Map(), lastLoad: 0, status: '' };
const metLoader = new THREE.TextureLoader();
function metTex(file) {
  if (!file) return null;
  let e = MET.tex.get(file);
  if (!e) {
    e = { tex: null, ready: false, used: 0 };
    e.tex = metLoader.load(METEO + file, (t) => { t.wrapS = THREE.RepeatWrapping; e.ready = true; }, undefined, () => { e.failed = true; });
    MET.tex.set(file, e);
    if (MET.tex.size > 14) {   // on ne garde en mémoire graphique que les images récemment utilisées
      const old = [...MET.tex.entries()].sort((a, b) => a[1].used - b[1].used).slice(0, MET.tex.size - 14);
      for (const [f, o] of old) { o.tex.dispose(); MET.tex.delete(f); }
    }
  }
  e.used = performance.now();
  return e.ready ? e.tex : null;
}
async function loadMeteo() {
  if (!METEO) return;
  MET.lastLoad = Date.now();
  try {
    const r = await tryFetch(METEO + 'meteo.json?t=' + Math.floor(Date.now() / 300000), { cache: 'no-store' });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const m = await r.json();
    MET.man = m;
    for (const k of ['nuages', 'pluie', 'vents']) {
      MET.lists[k] = (m.frames || []).filter((f) => f[k]).map((f) => ({ t: Date.parse(f.t), f })).sort((a, b) => a.t - b.t);
    }
  } catch (e) { MET.status = 'Météo pas encore publiée (tâche GitHub « Atlas - météo »).'; }
}
// deux images encadrant l'instant t (fondu entre les heures) ; null hors de l'historique
function metPair(kind, t) {
  const L = MET.lists[kind]; if (!L || !L.length) return null;
  const last = L[L.length - 1];
  if (T.live || t >= last.t) return t - last.t < 3 * 3600000 || T.live ? { a: last, b: null, k: 0 } : null;
  if (t < L[0].t - 1800000) return null;
  if (t <= L[0].t) return { a: L[0], b: null, k: 0 };
  for (let i = 0; i < L.length - 1; i++) {
    if (t >= L[i].t && t < L[i + 1].t) {
      const gap = L[i + 1].t - L[i].t;
      if (gap > 4 * 3600000) return { a: t - L[i].t < gap / 2 ? L[i] : L[i + 1], b: null, k: 0 };   // trou dans les relevés
      return { a: L[i], b: L[i + 1], k: (t - L[i].t) / gap };
    }
  }
  return null;
}
const metVert = `varying vec2 vUv; varying vec3 vN; void main(){ vUv = uv; vN = normal; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;
function metMaterial(rgba) {
  return new THREE.ShaderMaterial({
    uniforms: { texA: { value: null }, texB: { value: null }, k: { value: 0 }, hasB: { value: 0 }, sunDir: earthMat.uniforms.sunDir, uOpacity: { value: 0.9 }, uLight: earthMat.uniforms.uLight },
    vertexShader: metVert,
    fragmentShader: rgba
      ? `uniform sampler2D texA; uniform sampler2D texB; uniform float k; uniform float hasB; uniform float uOpacity; varying vec2 vUv;
         void main(){ vec4 a = texture2D(texA, vUv); vec4 c = hasB > 0.5 ? mix(a, texture2D(texB, vUv), k) : a;
           gl_FragColor = vec4(c.rgb * 1.15, c.a * uOpacity); }`
      : `uniform sampler2D texA; uniform sampler2D texB; uniform float k; uniform float hasB; uniform vec3 sunDir; uniform float uOpacity; uniform float uLight;
         varying vec2 vUv; varying vec3 vN;
         void main(){
           float a = texture2D(texA, vUv).r; float c = hasB > 0.5 ? mix(a, texture2D(texB, vUv).r, k) : a;
           float d = dot(normalize(vN), sunDir);
           float day = uLight > 0.5 ? smoothstep(-0.12, 0.3, d) : 1.0;
           vec3 col = mix(vec3(0.42, 0.5, 0.66) * 0.55, vec3(1.0), day);   // nuits : nuages visibles (infrarouge) mais sombres
           gl_FragColor = vec4(col, c * uOpacity * mix(0.75, 1.0, day));
         }`,
    transparent: true, depthWrite: false,
  });
}
const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(1.007, 128, 80), metMaterial(false));
const rainMesh = new THREE.Mesh(new THREE.SphereGeometry(1.009, 128, 80), metMaterial(true));
cloudMesh.renderOrder = 1; rainMesh.renderOrder = 1;
cloudMesh.visible = rainMesh.visible = false;
scene.add(cloudMesh, rainMesh);

// ---- vents : grille GFS 360 x 181 décodée depuis l'image (rouge = u, vert = v, 0,5 m/s par niveau)
function metWind(file) {
  if (!file) return null;
  let e = MET.wind.get(file);
  if (!e) {
    e = { ready: false };
    MET.wind.set(file, e);
    const img = new Image(); img.crossOrigin = 'anonymous';
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = 360; c.height = 181;
      const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, 360, 181).data;
      e.u = new Float32Array(360 * 181); e.v = new Float32Array(360 * 181);
      for (let i = 0; i < 360 * 181; i++) { e.u[i] = (d[i * 4] - 128) / 2; e.v[i] = (d[i * 4 + 1] - 128) / 2; }
      e.ready = true;
    };
    img.onerror = () => { e.failed = true; };
    img.src = METEO + file;
    if (MET.wind.size > 8) MET.wind.delete(MET.wind.keys().next().value);
  }
  return e.ready ? e : null;
}
const windFailed = (file) => !!MET.wind.get(file)?.failed;
function windAt(e, lat, lon, out) {
  const y = clamp(90 - lat, 0, 179.999), x = ((lon + 180) % 360 + 360) % 360;
  const y0 = Math.floor(y), x0 = Math.floor(x), x1 = (x0 + 1) % 360, fy = y - y0, fx = x - x0;
  const i00 = y0 * 360 + x0, i01 = y0 * 360 + x1, i10 = (y0 + 1) * 360 + x0, i11 = (y0 + 1) * 360 + x1;
  out[0] = (e.u[i00] * (1 - fx) + e.u[i01] * fx) * (1 - fy) + (e.u[i10] * (1 - fx) + e.u[i11] * fx) * fy;
  out[1] = (e.v[i00] * (1 - fx) + e.v[i01] * fx) * (1 - fy) + (e.v[i10] * (1 - fx) + e.v[i11] * fx) * fy;
  return out;
}
// Chaque particule laisse une traînée (WH points d'historique) : sans cela, au zoom normal,
// un trait de vent ne mesure que 2 ou 3 pixels et l'animation est quasi invisible.
const WN = 3000, WH = 10, WSTEP = 0.1;    // particules, points de traînée, secondes entre deux points
const WSEG = WN * WH;                    // segments dessinés
const windLines = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(WSEG * 6), 3).setUsage(THREE.DynamicDrawUsage));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(WSEG * 8), 4).setUsage(THREE.DynamicDrawUsage));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false }));
  l.frustumCulled = false; l.renderOrder = 3; l.visible = false; scene.add(l); return l;
})();
const WP = { lat: new Float32Array(WN), lon: new Float32Array(WN), age: new Float32Array(WN), max: new Float32Array(WN),
  hla: new Float32Array(WN * WH), hlo: new Float32Array(WN * WH), acc: 0 };
const wrnd = mulberry32(7);
function respawn(i) {
  WP.lat[i] = Math.asin(wrnd() * 2 - 1) * R2D * 0.98; WP.lon[i] = wrnd() * 360 - 180; WP.age[i] = 0; WP.max[i] = 3 + wrnd() * 5;
  for (let h = 0; h < WH; h++) { WP.hla[i * WH + h] = WP.lat[i]; WP.hlo[i * WH + h] = WP.lon[i]; }
}
for (let i = 0; i < WN; i++) { respawn(i); WP.age[i] = wrnd() * WP.max[i]; }
const WIND_COL = [[0, new THREE.Color('#5a8cff')], [5, new THREE.Color('#38d6e6')], [10, new THREE.Color('#5bf07a')], [17, new THREE.Color('#f7ea4b')], [25, new THREE.Color('#ff8a3d')], [35, new THREE.Color('#ff3d6e')]];
const wc = new THREE.Color(), wTmp = [0, 0], wTmp2 = [0, 0], wA = new THREE.Vector3(), wB = new THREE.Vector3();
function windColor(sp) {
  for (let i = 1; i < WIND_COL.length; i++) if (sp <= WIND_COL[i][0]) { const [s0, c0] = WIND_COL[i - 1], [s1, c1] = WIND_COL[i]; return wc.copy(c0).lerp(c1, (sp - s0) / (s1 - s0)); }
  return wc.copy(WIND_COL[WIND_COL.length - 1][1]);
}
function updateWind(dtSec, ea, eb, k) {
  const P = windLines.geometry.attributes.position.array, C = windLines.geometry.attributes.color.array;
  // vitesse d'affichage en degrés par seconde pour 1 m/s, adaptée au zoom (de près, on ralentit)
  const f = 0.4 * clamp((camera.position.length() - 1) / 2, 0.01, 1.5), rr = 1.002;
  WP.acc += dtSec; const push = WP.acc >= WSTEP; if (push) WP.acc = 0;
  for (let i = 0; i < WN; i++) {
    let la = WP.lat[i], lo = WP.lon[i];
    windAt(ea, la, lo, wTmp);
    if (eb) { windAt(eb, la, lo, wTmp2); wTmp[0] += (wTmp2[0] - wTmp[0]) * k; wTmp[1] += (wTmp2[1] - wTmp[1]) * k; }
    const u = wTmp[0], v = wTmp[1], sp = Math.hypot(u, v);
    WP.age[i] += dtSec;
    const cl = Math.max(Math.cos(la * D2R), 0.15);
    la += v * f * dtSec; lo += u * f * dtSec / cl;
    const o = i * WH;
    if (WP.age[i] > WP.max[i] || Math.abs(la) > 86 || sp < 0.3) respawn(i);
    else {
      WP.lat[i] = la; WP.lon[i] = ((lo + 540) % 360) - 180;
      if (push) { WP.hla.copyWithin(o + 1, o, o + WH - 1); WP.hlo.copyWithin(o + 1, o, o + WH - 1); }
      WP.hla[o] = WP.lat[i]; WP.hlo[o] = WP.lon[i];
    }
    const fade = Math.min(1, WP.age[i] / 0.5, (WP.max[i] - WP.age[i]) / 0.8);
    windColor(sp);
    llaToVec(WP.hla[o], WP.hlo[o], rr, wA);
    for (let h = 0; h < WH; h++) {
      const j = (o + h) * 6, c = (o + h) * 8;
      if (h < WH - 1 && Math.abs(WP.hlo[o + h + 1] - WP.hlo[o + h]) < 90) llaToVec(WP.hla[o + h + 1], WP.hlo[o + h + 1], rr, wB); else wB.copy(wA);
      P[j] = wA.x; P[j + 1] = wA.y; P[j + 2] = wA.z; P[j + 3] = wB.x; P[j + 4] = wB.y; P[j + 5] = wB.z;
      const a0 = fade * (1 - h / WH), a1 = fade * (1 - (h + 1) / WH);
      C[c] = C[c + 4] = wc.r; C[c + 1] = C[c + 5] = wc.g; C[c + 2] = C[c + 6] = wc.b; C[c + 3] = a0; C[c + 7] = a1;
      wA.copy(wB);
    }
  }
  windLines.geometry.attributes.position.needsUpdate = true; windLines.geometry.attributes.color.needsUpdate = true;
}

const hhmm = (ms) => new Date(ms).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: useUTC() ? 'UTC' : undefined });
let lastMetUi = 0;
function updateMeteo(now, t, dtReal) {
  if (METEO && now - MET.lastLoad > 10 * 60000) { MET.lastLoad = now; loadMeteo(); }   // nouveau relevé toutes les heures
  const on = { nuages: $('#optNuages').checked, pluie: $('#optPluie').checked, vents: $('#optVents').checked };
  const info = [];
  // nuages et pluie
  for (const [kind, mesh] of [['nuages', cloudMesh], ['pluie', rainMesh]]) {
    const pr = on[kind] ? metPair(kind, t) : null;
    const ta = pr ? metTex(pr.a.f[kind]) : null, tb = pr && pr.b ? metTex(pr.b.f[kind]) : null;
    mesh.visible = !!ta;
    if (ta) {
      const U = mesh.material.uniforms;
      U.texA.value = ta; U.texB.value = tb || ta; U.hasB.value = tb ? 1 : 0; U.k.value = pr.k;
      const near = clamp((camera.position.length() - 1 - 0.02) / 0.2, 0, 1);   // tout près du sol, on laisse voir l'imagerie détaillée
      U.uOpacity.value = (kind === 'nuages' ? +$('#optNuagesOp').value : 0.9) * (0.15 + 0.85 * near);
    }
    if (pr && kind === 'nuages') info.push(`☁️ Nuages : relevé de ${hhmm(Date.parse(pr.a.f.nuages_t || pr.a.f.t))} (${(pr.a.f.nuages_sources || []).length} sources satellites)`);
    if (pr && kind === 'pluie') info.push(`🌧️ Pluie : observation de ${hhmm(Date.parse(pr.a.f.pluie_t || pr.a.f.t))} (NASA, environ 5 h de décalage)`);
    // préchargement de l'heure suivante pendant la lecture
    if (pr && pr.b && T.playing) { const L = MET.lists[kind], j = L.indexOf(pr.b); if (j >= 0 && L[j + 1]) metTex(L[j + 1].f[kind]); }
  }
  // vents
  const pw = on.vents ? metPair('vents', t) : null;
  const ea = pw ? metWind(pw.a.f.vents) : null, eb = pw && pw.b ? metWind(pw.b.f.vents) : null;
  windLines.visible = !!ea;
  if (ea) updateWind(Math.min(dtReal / 1000, 0.1), ea, eb, pw.k);
  if (pw) info.push(ea ? `💨 Vents : modèle GFS (${hhmm(Date.parse(pw.a.f.t))})`
    : windFailed(pw.a.f.vents) ? '💨 Vents : image du relevé introuvable (relancez la tâche « Atlas - météo »).' : '💨 Vents : chargement…');
  else if (on.vents && MET.man && !MET.lists.vents.length) info.push('💨 Vents : pas encore de relevé de vents (la tâche « Atlas - météo » n\'a pas pu joindre la NOAA).');
  // légende
  if (now - lastMetUi > 1000) {
    lastMetUi = now;
    let txt;
    if (!METEO) txt = 'Couches météo : version web uniquement. La météo au clic fonctionne.';
    else if (!MET.man) txt = MET.status || 'Chargement de la météo…';
    else if (!on.nuages && !on.pluie && !on.vents) txt = 'Couches météo masquées.';
    else if (!info.length) txt = `Pas de couches météo à cette date : l'historique couvre les ${MET.man.historique_h || 72} dernières heures. (La météo au clic remonte jusqu'en 1940.)`;
    else txt = info.join('<br>');
    $('#meteoInfo').innerHTML = txt;
  }
}

// ---- météo d'un point au clic (Open-Meteo)
const WMO = { 0: ['Ciel dégagé', '☀️', '🌙'], 1: ['Plutôt dégagé', '🌤️', '🌙'], 2: ['Partiellement nuageux', '⛅', '☁️'], 3: ['Couvert', '☁️', '☁️'], 45: ['Brouillard', '🌫️'], 48: ['Brouillard givrant', '🌫️'],
  51: ['Bruine légère', '🌦️'], 53: ['Bruine', '🌦️'], 55: ['Bruine dense', '🌧️'], 56: ['Bruine verglaçante', '🌧️'], 57: ['Bruine verglaçante dense', '🌧️'],
  61: ['Pluie faible', '🌦️'], 63: ['Pluie', '🌧️'], 65: ['Forte pluie', '🌧️'], 66: ['Pluie verglaçante', '🌧️'], 67: ['Forte pluie verglaçante', '🌧️'],
  71: ['Neige faible', '🌨️'], 73: ['Neige', '❄️'], 75: ['Forte neige', '❄️'], 77: ['Grains de neige', '🌨️'], 80: ['Averses', '🌦️'], 81: ['Averses', '🌧️'], 82: ['Violentes averses', '⛈️'],
  85: ['Averses de neige', '🌨️'], 86: ['Fortes averses de neige', '❄️'], 95: ['Orage', '⛈️'], 96: ['Orage avec grêle', '⛈️'], 99: ['Orage avec forte grêle', '⛈️'] };
const wmo = (c, day = 1) => { const w = WMO[c] || ['—', '🌡️']; return { txt: w[0], ico: (!day && w[2]) ? w[2] : w[1] }; };
const meteoPin = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d');
  g.fillStyle = '#40e0ff'; g.beginPath(); g.arc(32, 32, 9, 0, TWO_PI); g.fill();
  g.strokeStyle = '#40e0ff'; g.lineWidth = 3; g.beginPath(); g.arc(32, 32, 20, 0, TWO_PI); g.stroke();
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), sizeAttenuation: false, transparent: true, depthWrite: false }));
  sp.scale.set(0.026, 0.026, 1); sp.visible = false; sp.renderOrder = 4; scene.add(sp); return sp;
})();
let meteoPoint = null;   // { lat, lon, name, data, mode, err, forT }
function clickWeather(e) {
  const ray = new THREE.Raycaster(); ray.setFromCamera(new THREE.Vector2(e.clientX / innerWidth * 2 - 1, -e.clientY / innerHeight * 2 + 1), camera);
  const hit = ray.ray.intersectSphere(new THREE.Sphere(new THREE.Vector3(), 1), new THREE.Vector3());
  if (!hit) return;
  const ll = vecToLL(hit);
  if (sel) select(null);
  meteoPoint = { lat: ll.lat, lon: ll.lon, name: '', data: null };
  llaToVec(ll.lat, ll.lon, 1.002, meteoPin.position); meteoPin.visible = true;
  showTab('info'); renderInfo();
  fetchPointWeather(meteoPoint);
  tryFetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=fr&lat=${ll.lat.toFixed(4)}&lon=${ll.lon.toFixed(4)}`, {}, 10000)
    .then((r) => (r.ok ? r.json() : null)).then((j) => {
      if (meteoPoint && j) { const a = j.address || {}; meteoPoint.name = [a.city || a.town || a.village || a.municipality || a.county || a.state || j.name, a.country].filter(Boolean).join(', '); if (!sel) renderInfo(); }
    }).catch(() => { /* nom du lieu facultatif (océan…) */ });
}
async function fetchPointWeather(mp) {
  const t = T.t, now = Date.now(), ageDays = (now - t) / DAY;
  const vars = 'temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,cloud_cover,pressure_msl,wind_speed_10m,wind_direction_10m,wind_gusts_10m,is_day';
  let url;
  if (ageDays > 85) {   // archives (réanalyse ERA5) : depuis 1940
    if (t < Date.UTC(1940, 0, 1)) { mp.err = 'Pas de données météo avant 1940.'; mp.forT = t; if (!sel) renderInfo(); return; }
    const d = new Date(t).toISOString().slice(0, 10);
    url = `https://archive-api.open-meteo.com/v1/archive?latitude=${mp.lat.toFixed(3)}&longitude=${mp.lon.toFixed(3)}&start_date=${d}&end_date=${d}&hourly=${vars.replace(',is_day', '')}&timezone=GMT&wind_speed_unit=kmh`;
    mp.mode = 'archive';
  } else {
    const past = Math.min(92, Math.max(1, Math.ceil(ageDays) + 1));
    url = `https://api.open-meteo.com/v1/forecast?latitude=${mp.lat.toFixed(3)}&longitude=${mp.lon.toFixed(3)}&current=${vars}&hourly=${vars}&past_days=${past}&forecast_days=3&timezone=GMT&wind_speed_unit=kmh`;
    mp.mode = 'prevision';
  }
  mp.err = ''; mp.forT = t;
  try {
    const r = await tryFetch(url, {}, 20000);
    const j = await r.json();
    if (!r.ok || j.error) throw new Error(j.reason || 'HTTP ' + r.status);
    mp.data = j;
  } catch (e) { mp.err = 'Service météo injoignable (' + e.message + ').'; }
  if (meteoPoint === mp && !sel) renderInfo();
}
function hourlyAt(j, t) {
  const H = j.hourly; if (!H || !H.time) return null;
  const ts = H.time.map((s) => Date.parse(s + 'Z'));
  let best = -1, bd = Infinity;
  for (let i = 0; i < ts.length; i++) { const d = Math.abs(ts[i] - t); if (d < bd) { bd = d; best = i; } }
  if (best < 0 || bd > 2 * 3600000) return null;
  const o = { time: ts[best] }; for (const k of Object.keys(H)) if (k !== 'time') o[k] = H[k][best];
  return o;
}
const DIRS16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSO', 'SO', 'OSO', 'O', 'ONO', 'NO', 'NNO'];
function renderPointWeather(box) {
  const mp = meteoPoint, latTxt = `${nf1.format(Math.abs(mp.lat))}° ${mp.lat >= 0 ? 'N' : 'S'}, ${nf1.format(Math.abs(mp.lon))}° ${mp.lon >= 0 ? 'E' : 'O'}`;
  let html = `<h3>🌍 ${esc(mp.name || 'Météo du point')}</h3><div class="kind">${latTxt}</div>`;
  if (mp.err) html += `<div class="note">${esc(mp.err)}</div>`;
  else if (!mp.data) html += '<p class="muted">Chargement de la météo…</p>';
  else {
    const live = T.live || Math.abs(T.t - Date.now()) < 3600000;
    const c = live && mp.data.current ? { ...mp.data.current, time: Date.parse(mp.data.current.time + 'Z') } : hourlyAt(mp.data, T.t);
    if (!c) html += '<p class="muted">Pas de valeur météo pour cette date ici.</p>';
    else {
      const w = wmo(c.weather_code, c.is_day ?? 1);
      const when = new Date(c.time).toLocaleString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: useUTC() ? 'UTC' : undefined });
      html += `<div class="wx-now"><span class="wx-ico">${w.ico}</span><div><div class="wx-t">${nf1.format(c.temperature_2m)} °C</div><div>${w.txt}${c.apparent_temperature != null ? ` · ressenti ${Math.round(c.apparent_temperature)} °C` : ''}</div><div class="muted small">${live ? 'maintenant' : esc(when)}</div></div></div>
        <table>${row('Vent', `${Math.round(c.wind_speed_10m)} km/h ${DIRS16[Math.round((c.wind_direction_10m || 0) / 22.5) % 16]}${c.wind_gusts_10m != null ? ` (rafales ${Math.round(c.wind_gusts_10m)})` : ''}`)}
        ${row('Nuages', Math.round(c.cloud_cover) + ' %')}${row('Précipitations', nf1.format(c.precipitation || 0) + ' mm')}
        ${row('Humidité', Math.round(c.relative_humidity_2m) + ' %')}${c.pressure_msl != null ? row('Pression', Math.round(c.pressure_msl) + ' hPa') : ''}</table>`;
      // prochaines heures (ou heures autour de la date choisie)
      const H = mp.data.hourly, ts = H.time.map((s) => Date.parse(s + 'Z')), base = live ? Date.now() : T.t;
      const idx = ts.map((x, i) => [x, i]).filter(([x]) => x >= base - 1800000).slice(0, 24).filter((_, n) => n % 3 === 0);
      if (idx.length > 1) {
        html += `<h4>${live ? 'Prochaines heures' : 'Heures suivantes'}</h4><div class="wx-strip">` + idx.map(([x, i]) => {
          const ww = wmo(H.weather_code[i], H.is_day ? H.is_day[i] : 1);
          return `<div><small>${hhmm(x)}</small><span>${ww.ico}</span><b>${Math.round(H.temperature_2m[i])}°</b></div>`;
        }).join('') + '</div>';
      }
    }
    html += `<div class="note">Source : Open-Meteo (CC BY 4.0)${mp.mode === 'archive' ? ', archives ERA5' : ''}. Cliquez ailleurs sur la Terre pour un autre lieu ; la météo suit la date de la frise.</div>`;
  }
  html += `<div class="actions"><button id="btnWxClose">Fermer</button></div>`;
  box.innerHTML = html;
  $('#btnWxClose').onclick = () => { meteoPoint = null; meteoPin.visible = false; renderInfo(); };
}
// la date change beaucoup (frise) : on recharge la météo du point
let lastWxRender = 0;
function updatePointWeather(now) {
  if (!meteoPoint || sel || now - lastWxRender < 2000) return;
  lastWxRender = now;
  const mp = meteoPoint;
  if (mp.forT != null && Math.abs(T.t - mp.forT) > (mp.mode === 'archive' ? 12 : 60) * 3600000 && !mp.loading) {
    mp.loading = true; mp.data = null; renderInfo();
    fetchPointWeather(mp).finally(() => { mp.loading = false; });
    return;
  }
  renderInfo();
}

// ------------------------------------------------------------------ boucle principale
const clock = { last: performance.now() };
function onResize() {
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight); screenRes.set(innerWidth, innerHeight); controls.handleResize?.(); drawChart();
}
window.addEventListener('resize', onResize);
const sunV = new THREE.Vector3();
let lastChartRedraw = 0;

function frame(now) {
  requestAnimationFrame(frame);
  const dtReal = Math.min(now - clock.last, 250); clock.last = now;
  // temps simulé
  if (T.live) T.t = Date.now();
  else if (T.playing) {
    T.t += dtReal * T.speed * T.dir;
    const wall = Date.now();
    if (T.future) { if (T.t <= wall) T.future = false; else if (T.t > wall + 31 * DAY) { T.t = wall + 31 * DAY; T.playing = false; syncTimeUI(); } }
    else if (T.t >= wall) { if (T.dir > 0) goLive(); else T.t = wall; }
    if (T.t <= T_START) { T.t = T_START; T.playing = false; syncTimeUI(); }
  }
  const t = T.t;
  checkEvents(t);

  // éclairage, étoiles
  sunDirection(t, sunV);
  earthMat.uniforms.sunDir.value.copy(sunV);
  earthMat.uniforms.camPos.value.copy(camera.position);
  sunSprite.position.copy(sunV).multiplyScalar(800);
  stars.rotation.y = -gmst(t);

  // objets (≈ 30 calculs par seconde pour ménager les vieux PC)
  if (now - lastSatCompute > 33) {
    lastSatCompute = now;
    updateSats(t);
    const live = isLiveWindow();
    updatePlanes(t, live);
    updateSynth(t, t < Date.now() - LIVE_WINDOW);
  }

  // suivi d'un objet
  if (follow && sel && objectPos(sel, t, selPos)) {
    const d = selPos.clone().sub(followPrev);
    if (!anim) { camera.position.add(d); controls.target.add(d); }
    followPrev.copy(selPos);
    if (anim) anim.t1.copy(selPos);
  }
  stepAnim(now);

  // réglages caméra selon l'altitude
  const camR = camera.position.length(), h = Math.max(camR - 1, 0.0002);
  const camToTarget = camera.position.distanceTo(controls.target);
  if (camMode === 'orbit') {
    controls.rotateSpeed = follow ? 0.6 : clamp(h * 0.55, 0.02, 0.9);
    controls.panSpeed = clamp(h * 0.5, 0.02, 1);
    controls.autoRotate = $('#optSpin').checked && !follow && !sel;
  } else { controls.rotateSpeed = clamp(h * 1.6, 0.06, 3.2); }
  controls.minDistance = follow ? 0.003 : (controls.target.lengthSq() > 1e-6 ? 0.003 : 1.0003);
  camera.near = clamp(Math.min(h, camToTarget) * 0.25, 0.00005, 0.5);
  camera.far = 3000; camera.updateProjectionMatrix();
  atmoMat.uniforms.uFade.value = clamp((h - 0.01) / 0.08, 0.15, 1);
  const zoomK = clamp(Math.pow(3.2 / camR, 0.45), 0.55, 2.4) * pointScale;
  satCloud.pts.material.uniforms.uScale.value = zoomK; satCloud.pts.material.uniforms.uTime.value = now / 1000;
  // avions : petits points vus de loin, silhouettes orientées en s'approchant
  const planePx = pointScale * clamp(9 * Math.pow(1.4 / camR, 1.3), 2.2, 24);
  planeCloud.pts.material.uniforms.uScale.value = planePx;
  synthCloud.pts.material.uniforms.uScale.value = planePx;
  controls.update();

  // marqueurs et étiquette
  updateLines(t);
  const lbl = $('#label');
  if (sel && objectPos(sel, t, selPos)) {
    marker.position.copy(selPos); marker.visible = !occluded(selPos.x, selPos.y, selPos.z);
    const sp = selPos.clone().project(camera);
    if (marker.visible && sp.z < 1) { lbl.style.display = 'block'; lbl.style.left = (sp.x * 0.5 + 0.5) * innerWidth + 'px'; lbl.style.top = (0.5 - sp.y * 0.5) * innerHeight + 'px'; lbl.textContent = nameOf(sel); }
    else lbl.style.display = 'none';
  } else { marker.visible = false; lbl.style.display = 'none'; }
  if (hover && (!sel || hover.key !== sel.key || hover.kind !== sel.kind) && objectPos(hover, t, hovPos)) { hoverMarker.position.copy(hovPos); hoverMarker.visible = true; }
  else hoverMarker.visible = false;

  updateTrails(now, t, isLiveWindow());
  updateTiles(now);
  updateMeteo(now, t, dtReal);
  updatePointWeather(now);
  updateFamous(t);
  updateInfoLive(now, t);
  updateHud(now);
  updateCursor();
  if (now - lastChartRedraw > 30000 && rangeKey !== '1900' && rangeKey !== '1957') { lastChartRedraw = now; drawChart(); }

  renderer.render(scene, camera);
}

async function init() {
  syncTimeUI();
  drawChart();
  requestAnimationFrame(frame);
  fetchPlanes();
  loadMeteo();
  const ok = await loadSatData(true);
  setTimeout(() => $('#loading').classList.add('hide'), ok ? 400 : 4000);
  if (!ok) toast('Aucune source de données spatiales n\'a répondu (CelesTrak ni secours). Vérifiez la connexion Internet ; détails dans l\'onglet Sources. Nouvel essai automatique dans 30 minutes.', 'warn', 20000);
  setInterval(() => loadSatData(false), 30 * 60000);   // le serveur décide lui-même s'il doit retélécharger
  setTimeout(() => { if (!texturesOk) step('tex', false, 'Terre simplifiée (CDN injoignable)'); }, 15000);
  // anniversaire du jour ?
  const today = new Date(); const ev = EVENTS.find((e) => { const d = new Date(e.t); return d.getUTCMonth() === today.getMonth() && d.getUTCDate() === today.getDate(); });
  if (ev) setTimeout(() => toast(`📅 <b>Il y a ${today.getFullYear() - new Date(ev.t).getUTCFullYear()} ans, jour pour jour</b> — ${esc(ev.text)}`, 'gold', 12000, () => setTime(ev.t + 12 * 3600000)), 2500);
}
init();
