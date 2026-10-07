const C = 'opsvault-v9', TILES = 'opsvault-tiles', OCR = 'opsvault-ocr-t7', LIBS = 'opsvault-lib-t1', TILE_MAX = 3000, TTL = 7 * 864e5;
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'manifest.json', 'icon-192.png', 'icon-512.png', 'lib/leaflet.js', 'lib/leaflet.css', 'lib/jspdf.umd.min.js'];
self.addEventListener('install', e => { e.waitUntil(caches.open(C).then(c => c.addAll(FILES))); self.skipWaiting(); });
// o cache de blocos do mapa (TILES), o do OCR e o dos leitores de PDF/Word (LIBS — arquivos baixados só no 1º uso) sobrevivem às trocas de versão do app
self.addEventListener('activate', e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== C && k !== TILES && k !== OCR && k !== LIBS).map(k => caches.delete(k))))); self.clients.claim(); });
const isTile = u => u.origin !== location.origin && /\/\d+\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)$/i.test(u.pathname);
let puts = 0;
async function trim(c) { // limita os blocos “vistos”; os baixados (x-ov-src: dl) nunca são cortados aqui
  const ks = await c.keys(); if (ks.length <= TILE_MAX) return; let over = ks.length - Math.floor(TILE_MAX * .9);
  for (const k of ks) { if (over <= 0) break; const r = await c.match(k); if (r && r.headers.get('x-ov-src') !== 'dl') { await c.delete(k); over--; } }
}
/* Blocos do mapa: cache primeiro. Baixados = sempre do cache; vistos = do cache por 7 dias (mínimo da política OSM),
   depois renova na rede; sem rede, usa o que tiver. */
async function tile(req) {
  const c = await caches.open(TILES); const hit = await c.match(req.url);
  if (hit && (hit.headers.get('x-ov-src') === 'dl' || Date.now() - +(hit.headers.get('x-ov-ts') || 0) < TTL)) return hit;
  let r;
  try { r = await fetch(req.url, {mode: 'cors', credentials: 'omit'}); }
  catch (e) { if (hit) return hit; try { return await fetch(req); } catch (e2) { return Response.error(); } } // servidor sem CORS: segue sem guardar
  if (!r.ok) return hit || r;
  const bl = await r.blob();
  const out = new Response(bl, {headers: {'content-type': r.headers.get('content-type') || 'image/png', 'x-ov-src': 'view', 'x-ov-ts': String(Date.now()), 'x-ov-len': String(bl.size)}});
  try { await c.put(req.url, out.clone()); if (++puts % 50 === 0) trim(c); } catch (e) {}
  return out;
}
/* OCR (tesseract.js + núcleo wasm + por.traineddata) e, desde a v0.7, pdf.js e fflate (cache LIBS):
   não vão no pré-cache; guardam no 1º uso e servem do cache depois */
async function ocrFile(req, name = OCR) {
  const c = await caches.open(name); const hit = await c.match(req.url, {ignoreSearch: true});
  if (hit) return hit;
  const r = await fetch(req); if (r.ok) { try { await c.put(req.url, r.clone()); } catch (e) {} }
  return r;
}
self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const u = new URL(e.request.url);
  if (isTile(u)) return e.respondWith(tile(e.request));
  if (u.origin !== location.origin) return;
  if (/\/lib\/(tesseract\.min\.js|tess-worker\.min\.js|tess-core\/|tessdata\/)/.test(u.pathname)) return e.respondWith(ocrFile(e.request));
  if (/\/lib\/(pdfjs\/|fflate\.min\.js)/.test(u.pathname)) return e.respondWith(ocrFile(e.request, LIBS));
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(r => r || fetch(e.request)));
});
