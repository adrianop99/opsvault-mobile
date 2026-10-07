'use strict';
/* ============ OpsVault Mobile — by @aiforge.team ============ */
const APP_NAME = "OpsVault Mobile", APP_SHORT = "OpsVault", CREDIT = "by @aiforge.team", APP_VER = "v0.8", APP_CACHE = "opsvault-v9"; // APP_CACHE = nome do cache em sw.js
const $ = s => document.querySelector(s);
const APP = $('#app');
const enc = new TextEncoder(), dec = new TextDecoder();
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt = ts => new Date(ts).toLocaleString('pt-BR', {day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
const b64 = buf => { let s = ''; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
const sha256 = async data => hex(await crypto.subtle.digest('SHA-256', typeof data === 'string' ? enc.encode(data) : data));

/* ---------- IndexedDB ---------- */
/* Dois espaços isolados: 'cofre-op' (real) e 'cofre-op-d' (cofre falso do PIN de pânico).
   Os dois bancos são sempre criados, para que a existência de um não denuncie nada. */
const NS_MAIN = 'cofre-op', NS_DECOY = 'cofre-op-d';
function idbOpen(name) { return new Promise((res, rej) => { const r = indexedDB.open(name, 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
const DB = {
  db: null, main: null, alt: null, decoy: false,
  async open() { this.main = await idbOpen(NS_MAIN); this.alt = await idbOpen(NS_DECOY); this.db = this.main; },
  use(decoy) { this.decoy = !!decoy; this.db = decoy ? this.alt : this.main; },
  tx(mode, db) { return (db || this.db).transaction('kv', mode).objectStore('kv'); },
  _r(q) { return new Promise((res, rej) => { q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); }); },
  get(k, db) { return this._r(this.tx('readonly', db).get(k)); },
  set(k, v, db) { return this._r(this.tx('readwrite', db).put(v, k)).then(() => {}); },
  del(k, db) { return this._r(this.tx('readwrite', db).delete(k)).then(() => {}); },
  keys(db) { return this._r(this.tx('readonly', db).getAllKeys()); },
  clear(db) { return this._r(this.tx('readwrite', db).clear()).then(() => {}); }
};

/* ---------- Criptografia (PBKDF2 + AES-GCM 256) ---------- */
const ITER = 250000;
let KEY = null, S = null; // chave e estado só em memória enquanto aberto
async function deriveKey(pin, salt, extractable = false) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:ITER, hash:'SHA-256'}, base, {name:'AES-GCM', length:256}, extractable, ['encrypt','decrypt']);
}
async function seal(key, bytes) { const iv = crypto.getRandomValues(new Uint8Array(12)); const ct = await crypto.subtle.encrypt({name:'AES-GCM', iv}, key, bytes); return {iv:b64(iv), ct:b64(ct)}; }
async function open_(key, box) { return new Uint8Array(await crypto.subtle.decrypt({name:'AES-GCM', iv:unb64(box.iv)}, key, unb64(box.ct))); }
async function save() { await DB.set('data', await seal(KEY, enc.encode(JSON.stringify(S)))); }
const imgCache = new Map();
async function putImg(id, bytes) { await DB.set('img:' + id, await seal(KEY, bytes)); }
async function getImg(id) {
  if (imgCache.has(id)) return imgCache.get(id);
  const box = await DB.get('img:' + id); if (!box) return null;
  const url = URL.createObjectURL(new Blob([await open_(KEY, box)], {type:'image/jpeg'}));
  imgCache.set(id, url); return url;
}
async function imgDataURL(id) { const box = await DB.get('img:' + id); if (!box) return null; return 'data:image/jpeg;base64,' + b64(await open_(KEY, box)); }
async function imgBytes(id) { const box = await DB.get('img:' + id); return box ? open_(KEY, box) : null; }
function dropImg(id) { if (!id) return Promise.resolve(); if (imgCache.has(id)) { URL.revokeObjectURL(imgCache.get(id)); imgCache.delete(id); } return DB.del('img:' + id); }
/* Todos os blobs criptografados (imagens e áudios) de um alvo */
function alvoBlobKeys(a) {
  const k = [];
  (a.fotos || []).forEach(f => { k.push('img:' + f.id); if (f.carimbo) k.push('img:' + f.carimbo.id); });
  if (a.docFoto) k.push('img:' + a.docFoto.id);
  (a.audios || []).forEach(x => k.push('aud:' + x.id));
  return k;
}
async function dropAlvo(a) {
  for (const k of alvoBlobKeys(a)) { const id = k.slice(4); if (imgCache.has(id)) { URL.revokeObjectURL(imgCache.get(id)); imgCache.delete(id); } await DB.del(k); }
  S.links = (S.links || []).filter(l => l.a !== a.id && l.b !== a.id);
  S.alvos = S.alvos.filter(x => x.id !== a.id);
}
async function dropOp(opId) {
  if (typeof TRK !== 'undefined' && TRK && TRK.opId === opId) trackStop(true);
  for (const a of S.alvos.filter(a => a.opId === opId)) await dropAlvo(a);
  const op = getOp(opId); for (const x of (op && op.audios) || []) await DB.del('aud:' + x.id);
  S.areas = (S.areas || []).map(ar => ar.opId === opId ? {...ar, opId: ''} : ar);
  (S.inbox || []).forEach(it => { if (it.opId === opId) it.opId = ''; });
  S.ops = S.ops.filter(o => o.id !== opId);
}
/* Migração: dados v0.4 (ou anteriores) ganham os campos novos sem perder nada */
const freshState = () => ({ops: [], alvos: [], links: [], areas: [], offline: [], inbox: [], cfg: {idle: 3, bkDays: 7}, v: 6});
function migrate(st) {
  st = st || freshState();
  st.ops = st.ops || []; st.alvos = st.alvos || []; st.links = st.links || []; st.areas = st.areas || []; st.offline = st.offline || []; st.inbox = st.inbox || [];
  st.cfg = Object.assign({idle: 3, bkDays: 7, carimbo: false, discreto: false}, st.cfg || {});
  st.ops.forEach(o => { o.audios = o.audios || []; o.vig = o.vig || []; o.diario = o.diario || []; o.trajetos = o.trajetos || []; });
  st.alvos.forEach(a => { a.fotos = a.fotos || []; a.locais = a.locais || []; a.notas = a.notas || []; a.log = a.log || []; a.tels = a.tels || []; a.audios = a.audios || []; a.redes = a.redes || []; a.mandados = a.mandados || []; a.tags = a.tags || []; a.pend = a.pend || []; if (a.situacao == null) a.situacao = ''; });
  st.v = 6; return st;
}

/* ---------- Trava automática ---------- */
let idleT = null, holdLock = false, holdT = null;
const idleMin = () => (S && S.cfg && S.cfg.idle) || 3;
function resetIdle() { clearTimeout(idleT); if (KEY) idleT = setTimeout(() => lock('inatividade'), idleMin() * 60000); }
function hold(ms = 90000) { holdLock = true; clearTimeout(holdT); holdT = setTimeout(() => holdLock = false, ms); }
function release() { setTimeout(() => { holdLock = false; }, 1500); }
['pointerdown','keydown','touchstart'].forEach(e => addEventListener(e, resetIdle, {passive:true}));
document.addEventListener('visibilitychange', () => { if (document.hidden && KEY && !holdLock) lock('app em segundo plano'); });
function lock(why) {
  try { stopRecorder(); } catch (e) {}
  if (OFF_RUN) OFF_RUN.stop = true; MF = null; window._mapRender = null;
  try { stopDict(); ocrStop(); } catch (e) {}
  try { exPanelClose(); if (DOCQ) { DOCQ.files.forEach(x => URL.revokeObjectURL(x.url)); DOCQ = null; } } catch (e) {} // v0.7: conferências abertas e fila de documentos somem ao travar
  try { trackStop(true); } catch (e) {} try { measureEnd && measureEnd(); } catch (e) {}
  try { stopPlayer(); } catch (e) {} audioCache.forEach(u => URL.revokeObjectURL(u)); audioCache.clear();
  KEY = null; S = null; imgCache.forEach(u => URL.revokeObjectURL(u)); imgCache.clear(); clearTimeout(idleT); DB.use(false);
  document.querySelectorAll('.viewer').forEach(v => v.remove()); applyDisc();
  closeSheet(); location.hash = '#lock'; route(); updQ(); if (why) setTimeout(() => toast('🔒 Cofre travado (' + why + ')'), 200);
}

/* ---------- UI helpers ---------- */
function toast(m, ms = 2600) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms); }
let SHEET_HASH = null; // rota em que a folha foi aberta: trocar de rota (hash) fecha a folha
function sheet(html, onMount) { SHEET_HASH = location.hash; $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#sheet-wrap').classList.remove('hidden'); onMount && onMount($('#sheet')); micify($('#sheet')); }
function closeSheet() { SHEET_HASH = null; stopDict(); $('#sheet-wrap').classList.add('hidden'); $('#sheet').innerHTML = ''; }
$('#sheet-bg').onclick = closeSheet;
function confirmBox(msg, okTxt = 'Confirmar', danger = false) {
  return new Promise(res => { sheet(`<h2 style="margin-top:0">${esc(msg)}</h2><div class="grid2" style="margin-top:16px"><div class="btn" id="cn">Cancelar</div><div class="btn ${danger?'dan':'pri'}" id="ok">${esc(okTxt)}</div></div>`, s => { s.querySelector('#cn').onclick = () => { closeSheet(); res(false); }; s.querySelector('#ok').onclick = () => { closeSheet(); res(true); }; }); });
}
const PRIO = {alta:['c-red','Prioridade alta'], media:['c-amb','Prioridade média'], baixa:['c-gray','Prioridade baixa']};
const STATUS = {planejada:['c-gray','Planejada'], andamento:['c-blue','Em andamento'], encerrada:['c-grn','Encerrada']};
const TIPOS = {residencia:['🏠','Residência','#5b8fff'], trabalho:['🏢','Trabalho','#8a6bff'], veiculo:['🚗','Veículo','#8a9bb8'], encontro:['🤝','Ponto de encontro','#ffa94d'], foto:['📷','Foto','#ff6b6b'], outro:['📍','Outro','#3cd290'], vig:['👁️','Vigilância','#ffd43b']};
const maskTel = t => String(t||'').replace(/\d(?=(?:\D*\d){4})/g, (d, i, s) => i < 5 ? d : '•');
const maskDoc = t => String(t||'').replace(/\d/g, (d, i) => i < 3 ? d : '•');
function tabs(active) {
  const T = [['ops','🗂️','Operações'],['mapa','🗺️','Mapa'],['busca','🔍','Busca'],['cofre','🔐','Cofre'],['ajuda','❔','Ajuda']];
  const n = $('#tabs'); n.classList.remove('hidden');
  n.innerHTML = T.map(([k,i,l]) => `<a href="#${k}" class="${active===k?'on':''}"><i>${i}</i>${l}</a>`).join('');
}
const getOp = id => S.ops.find(o => o.id === id);
const getAlvo = id => S.alvos.find(a => a.id === id);
function geo() {
  return new Promise(res => {
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(p => res({lat:p.coords.latitude, lng:p.coords.longitude, acc:Math.round(p.coords.accuracy)}), () => res(null), {enableHighAccuracy:true, timeout:12000, maximumAge:0});
  });
}
const coord = l => l ? `${l.lat.toFixed(5)}, ${l.lng.toFixed(5)}` : '—';
const accTxt = l => l && l.acc != null ? ` (±${l.acc} m)` : '';
const isAlbum = f => f && f.origem === 'album';
/* Capa do alvo: a.capa se a foto ainda existir; senão a última (hero) ou a primeira (miniatura) */
function capaId(a, fallback = 'last') {
  const fs = a.fotos || []; if (!fs.length) return '';
  if (a.capa && fs.some(f => f.id === a.capa)) return a.capa;
  return (fallback === 'first' ? fs[0] : fs[fs.length - 1]).id;
}
const fotosCapaPrimeiro = a => { const fs = a.fotos || []; const c = a.capa && fs.find(f => f.id === a.capa); return c ? [c, ...fs.filter(f => f !== c)] : fs.slice(); };

/* ---------- Roteador ---------- */
addEventListener('hashchange', () => { if (SHEET_HASH !== null && SHEET_HASH !== location.hash && !$('#sheet-wrap').classList.contains('hidden')) closeSheet(); route(); });
async function route() {
  const h = (location.hash || '#ops').slice(1).split('/');
  if (h[0] === 'acao') { if (ACOES[h[1]]) PEND_ACAO = h[1]; history.replaceState(null, '', location.pathname + '#ops'); h.splice(0, h.length, 'ops'); if (KEY) setTimeout(runAcao, 250); }
  if (!KEY) { $('#tabs').classList.add('hidden'); updQ(); return viewLock(); }
  updQ();
  measureEnd(); if (window._map) { window._map.remove(); window._map = null; }
  stopPlayer(); stopRecorder(); stopDict(); applyDisc();
  scrollTo(0, 0);
  const [v, a, b] = h;
  try {
    if (v === 'op') return viewOp(a);
    if (v === 'alvo' && b === 'editar') return viewAlvoForm(a);
    if (v === 'novoalvo') return viewAlvoForm(null, a);
    if (v === 'alvo') return viewAlvo(a);
    if (v === 'exportar') return viewExport(a);
    if (v === 'relatorio') return viewRelatorio(a);
    if (v === 'vinculos') return viewGrafo(a);
    if (v === 'mapa') return viewMapa(a);
    if (v === 'busca') return viewBusca(a, b);
    if (v === 'rascunhos') return viewRascunhos(a);
    if (v === 'pendencias') return viewPendencias(a);
    if (v === 'diario') return viewDiario(a);
    if (v === 'cruzamentos') return viewCruzamentos(a);
    if (v === 'vig') return viewVig(a, b);
    if (v === 'cofre') return viewCofre();
    if (v === 'ajuda') return viewAjuda();
    return viewOps();
  } catch (e) { console.error(e); toast('Erro: ' + e.message); }
}

/* ---------- Tela de bloqueio ---------- */
const credit = () => `<div class="credit">${esc(APP_NAME)} · <b>${esc(CREDIT)}</b></div>`;
/* ---------- Modo discreto ---------- */
const discOn = () => S ? !!S.cfg.discreto : localStorage.getItem('ov_disc') === '1';
const brandName = () => discOn() ? 'Notas' : APP_NAME;
function applyDisc() {
  const on = discOn(); document.body.classList.toggle('disc', on);
  document.title = on ? 'Notas' : 'OpsVault Mobile — by @aiforge.team';
  if (S) { if (on) localStorage.setItem('ov_disc', '1'); else localStorage.removeItem('ov_disc'); }
}
async function toggleDisc(v) { S.cfg.discreto = v == null ? !S.cfg.discreto : !!v; await save(); applyDisc(); route(); toast(S.cfg.discreto ? '🕶️ Modo discreto ligado' : 'Modo discreto desligado'); }
/* No modo discreto, o 1º toque numa foto borrada só revela; o 2º abre */
document.addEventListener('click', e => {
  if (!document.body.classList.contains('disc')) return;
  const t = e.target.closest && e.target.closest('.th, .hero, .vimg, .docth');
  if (t && t.querySelector('img') && !t.classList.contains('rev')) { t.classList.add('rev'); e.stopPropagation(); e.preventDefault(); }
}, true);

/* ---------- Abertura do cofre (real, falso ou apagamento de pânico) ---------- */
const P_DECOY = 'opsvault-p:decoy', P_WIPE = 'opsvault-p:wipe';
async function wipeEverything() {
  await DB.clear(DB.main); await DB.clear(DB.alt); localStorage.clear();
  try { await caches.delete(TILE_CACHE); } catch (e) {}
}
/* mode: 'real' | 'decoy' | 'wipe' — key já validada */
async function openVault(mode, key, meta) {
  if (mode === 'wipe') {
    await wipeEverything();
    // cofre novo e vazio, aberto com o mesmo PIN (parece um cofre normal recém-criado)
    await DB.set('meta', {salt: meta.p.salt, check: await seal(key, enc.encode('opsvault-ok')), v: 1}, DB.main);
    DB.use(false); KEY = key; S = freshState(); await save();
  } else {
    DB.use(mode === 'decoy'); KEY = key;
    const box = await DB.get('data');
    S = migrate(box ? JSON.parse(dec.decode(await open_(key, box))) : freshState());
    if (!box) await save();
  }
  localStorage.removeItem('ov_fails'); localStorage.removeItem('ov_until');
  applyDisc(); if (!location.hash || location.hash === '#lock') location.hash = '#ops'; resetIdle(); route();
  if (PEND_ACAO) setTimeout(runAcao, 350); // atalho da tela inicial: executa a ação depois de destravar
}
/* Sempre deriva as duas chaves (real e pânico) em paralelo: o tempo de resposta é o mesmo
   para PIN real, PIN de pânico ou PIN errado — a tela não denuncia qual foi digitado. */
async function checkPin(pin, meta) {
  const pSalt = meta.p ? unb64(meta.p.salt) : unb64(meta.salt).map(x => x ^ 0x5a);
  const [k, kp] = await Promise.all([deriveKey(pin, unb64(meta.salt)), deriveKey(pin, pSalt)]);
  try { await open_(k, meta.check); return {mode: 'real', key: k}; } catch (e) {}
  if (meta.p) { try { const t = dec.decode(await open_(kp, meta.p.check)); return {mode: t === P_WIPE ? 'wipe' : 'decoy', key: kp}; } catch (e) {} }
  return null;
}
async function viewLock() {
  DB.use(false);
  const meta = await DB.get('meta', DB.main);
  const fakeFirst = !!meta && localStorage.getItem('ov_fr') === '1' && !!meta.p, first = !meta || fakeFirst;
  let pin = '', firstPin = null;
  const fails = () => +(localStorage.getItem('ov_fails') || 0);
  const until = () => +(localStorage.getItem('ov_until') || 0);
  const bios = first ? [] : (await Promise.all([DB.get('bio', DB.main), DB.get('bio', DB.alt)])).map((b, i) => b && {...b, ns: i}).filter(Boolean);
  const showBio = bios.length && await bioSupported();
  applyDisc();
  APP.innerHTML = `<div class="lock">
    <div class="shield glass">${discOn() ? '🗒️' : '🛡️'}</div>
    <div class="brand">${esc(brandName())}</div>
    <h1 id="lt" style="margin-top:6px">${first ? 'Crie seu PIN' : (discOn() ? 'Bloqueado' : 'Cofre travado')}</h1>
    <div class="sub" id="ls">${first ? 'Mínimo de 6 dígitos. Sem ele, ninguém abre os dados — nem você.' : 'Digite o PIN para abrir'}</div>
    <div class="dots" id="dots"></div>
    <div class="err" id="err"></div>
    <div class="keys">${[1,2,3,4,5,6,7,8,9].map(n => `<div class="key glass" data-k="${n}">${n}</div>`).join('')}
      <div class="key" data-k="del" style="font-size:20px">⌫</div><div class="key glass" data-k="0">0</div><div class="key" data-k="ok" style="font-size:18px;font-weight:700;color:#9cbcff">OK</div></div>
    ${showBio ? `<div class="btn sm" id="bio" style="margin-top:18px">🙂 Face ID / biometria</div>` : ''}
    ${discOn() ? '' : credit()}
  </div>`;
  const dots = () => { $('#dots').innerHTML = Array.from({length: Math.max(6, pin.length)}, (_, i) => `<i class="${i < pin.length ? 'f' : ''}"></i>`).join(''); };
  const err = m => { $('#err').textContent = m; const d = $('#dots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); };
  dots();
  let busy = false;
  const failed = () => {
    const f = fails() + 1; localStorage.setItem('ov_fails', f);
    if (f >= 5) localStorage.setItem('ov_until', Date.now() + Math.min(30 * 2 ** (f - 5), 3600) * 1000);
    busy = false; pin = ''; dots(); err(f >= 5 ? `PIN incorreto. Bloqueado por ${Math.min(30 * 2 ** (f - 5), 3600)}s` : `PIN incorreto (${f}/5)`);
  };
  async function submit() {
    if (busy) return;
    if (pin.length < 6) return err('O PIN precisa ter pelo menos 6 dígitos');
    if (first) {
      if (!firstPin) { firstPin = pin; pin = ''; dots(); $('#lt').textContent = 'Confirme o PIN'; $('#ls').textContent = 'Digite o mesmo PIN de novo'; $('#err').textContent = ''; return; }
      if (pin !== firstPin) { firstPin = null; pin = ''; dots(); $('#lt').textContent = 'Crie seu PIN'; return err('Os PINs não conferem. Recomece.'); }
      busy = true; $('#err').textContent = 'Gerando chave…';
      if (fakeFirst) { // depois de “Apagar tudo” no cofre falso: o novo PIN passa a abrir o falso; o PIN real continua abrindo o real
        const r = await checkPin(pin, meta).catch(() => null); localStorage.removeItem('ov_fr');
        if (r && r.mode === 'real') { pin = ''; return openVault('real', r.key, meta); }
        const ps = crypto.getRandomValues(new Uint8Array(16)); const kp = await deriveKey(pin, ps);
        meta.p = {salt: b64(ps), check: await seal(kp, enc.encode(P_DECOY))}; await DB.clear(DB.alt); await DB.set('meta', meta, DB.main);
        DB.use(true); KEY = kp; S = freshState(); S.cfg.since = Date.now(); await save();
        pin = ''; location.hash = '#ajuda'; resetIdle(); route(); toast('Cofre criado. Veja o guia rápido 👇'); return;
      }
      const salt = crypto.getRandomValues(new Uint8Array(16));
      KEY = await deriveKey(pin, salt); DB.use(false);
      await DB.set('meta', {salt: b64(salt), check: await seal(KEY, enc.encode('opsvault-ok')), v: 1}, DB.main);
      S = freshState(); S.cfg.since = Date.now(); await save();
      pin = ''; location.hash = '#ajuda'; resetIdle(); route(); toast('Cofre criado. Veja o guia rápido 👇'); return;
    }
    const wait = until() - Date.now();
    if (wait > 0) return err(`Muitas tentativas. Aguarde ${Math.ceil(wait / 1000)}s`);
    busy = true; $('#err').textContent = 'Verificando…';
    let r = null; try { r = await checkPin(pin, meta); } catch (e) { r = null; }
    if (!r) return failed();
    pin = '';
    try { await openVault(r.mode, r.key, meta); } catch (e) { console.error(e); busy = false; err('Erro ao abrir: ' + e.message); }
  }
  APP.querySelectorAll('.key').forEach(k => k.onclick = () => {
    if (busy) return; const v = k.dataset.k;
    if (v === 'del') pin = pin.slice(0, -1); else if (v === 'ok') return submit(); else if (pin.length < 12) pin += v;
    $('#err').textContent = ''; dots();
  });
  if (showBio) $('#bio').onclick = async () => {
    if (busy) return; const wait = until() - Date.now();
    if (wait > 0) return err(`Muitas tentativas. Aguarde ${Math.ceil(wait / 1000)}s`);
    busy = true; $('#err').textContent = 'Aguardando biometria…'; hold(60000);
    try { const r = await bioUnlock(bios, meta); release(); await openVault(r.mode, r.key, meta); }
    catch (e) { release(); busy = false; console.warn('bio', e); err(e.name === 'NotAllowedError' ? 'Biometria cancelada. Use o PIN.' : 'Biometria indisponível. Use o PIN.'); }
  };
}

/* ---------- Operações ---------- */
function opForm(op) {
  sheet(`<h2 style="margin-top:0">${op ? 'Editar operação' : 'Nova operação'}</h2>
    <label>Nome</label><input id="f_n" value="${esc(op?.nome)}" placeholder="Ex.: Operação Aurora">
    <label>Status</label><select id="f_s">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${op?.status === k ? 'selected' : ''}>${v[1]}</option>`).join('')}</select>
    <label>Descrição</label><textarea id="f_d" data-mic placeholder="Objetivo, área, observações">${esc(op?.desc)}</textarea>
    <div class="gap"></div><div class="btn pri" id="f_ok">Salvar</div>`, s => {
    s.querySelector('#f_ok').onclick = async () => {
      const nome = s.querySelector('#f_n').value.trim(); if (!nome) return toast('Dê um nome à operação');
      if (op) Object.assign(op, {nome, status: s.querySelector('#f_s').value, desc: s.querySelector('#f_d').value.trim()});
      else S.ops.push({id: uid(), nome, status: s.querySelector('#f_s').value, desc: s.querySelector('#f_d').value.trim(), ts: Date.now()});
      await save(); closeSheet(); route(); toast('Operação salva');
    };
  });
}
async function viewOp(id) {
  tabs('ops'); const op = getOp(id); if (!op) return location.hash = '#ops';
  const alvos = S.alvos.filter(a => a.opId === id);
  const st = STATUS[op.status] || STATUS.planejada;
  const otags = [...new Map(alvos.flatMap(a => a.tags || []).map(t => [t.toLowerCase(), t])).values()].sort((x, y) => x.localeCompare(y, 'pt-BR'));
  const nInb = (S.inbox || []).filter(it => it.opId === id).length, nPend = alvos.reduce((s, a) => s + (a.pend || []).filter(p => !p.done).length, 0);
  APP.innerHTML = `<div class="back" onclick="location.hash='#ops'">‹ Operações</div>
  <div class="top"><div><h1>${esc(op.nome)}</h1><div style="margin-top:6px"><span class="chip ${st[0]}">${st[1]}</span>${isArq(op) ? ' <span class="chip c-gray">🗄️ Arquivada</span>' : ''}</div></div><div class="btn sm" id="ed">Editar</div></div>
  ${isArq(op) ? `<div class="warn" id="arq_ban">🗄️ Operação arquivada em ${fmt(op.arquivada)}. Ela não aparece na lista principal. <div class="btn sm" id="unarq" style="margin-top:8px;display:inline-flex">Desarquivar</div></div>` : ''}
  ${op.desc ? `<div class="card glass" style="cursor:default"><div class="sub">${esc(op.desc)}</div></div>` : ''}
  ${nInb ? `<div class="card glass" onclick="location.hash='#rascunhos/${id}'"><div class="row"><div class="t">📥 Rascunhos desta operação</div><span class="chip c-blue">${nInb}</span></div></div>` : ''}
  <h2>Alvos (${alvos.length})${nPend ? ` <span class="sub" style="font-weight:400">· ✅ ${nPend} pendência(s) aberta(s)</span>` : ''}</h2>
  ${otags.length ? `<div class="chips" id="op_tags" style="margin:-2px 0 10px">${['', ...otags].map(t => `<span class="chip ${t ? 'c-gray' : 'c-blue'} otag" data-t="${esc(t)}" style="cursor:pointer">${t ? '#' + esc(t) : 'Todos'}</span>`).join('')}</div>` : ''}
  ${alvos.length ? alvos.map(a => { const p = PRIO[a.prio] || PRIO.media; return `<div class="card glass acard" data-tags="${esc((a.tags || []).map(t => t.toLowerCase()).join('|'))}" onclick="location.hash='#alvo/${a.id}'"><div class="row"><div style="display:flex;gap:12px;align-items:center"><div class="th" style="width:48px;height:48px;flex-shrink:0" data-img="${capaId(a, 'first')}">${a.fotos?.length ? '' : '<div style="display:flex;height:100%;align-items:center;justify-content:center">👤</div>'}</div><div><div class="t">${esc(a.nome)}</div><div class="sub">${esc(a.apelido ? '“' + a.apelido + '”' : '')} ${a.fotos?.length || 0} foto(s) · ${a.locais?.length || 0} local(is)</div>${(a.tags || []).length ? `<div class="chips" style="margin-top:5px">${tagChips(a.tags)}</div>` : ''}</div></div><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end"><span class="chip ${p[0]}">${p[1].replace('Prioridade ', '')}</span>${a.situacao ? `<span class="chip ${(SITU[a.situacao] || SITU.outro)[0]}">${esc((SITU[a.situacao] || SITU.outro)[1])}</span>` : ''}</div></div></div>`; }).join('')
  : `<div class="empty"><div>👤</div>Nenhum alvo nesta operação.</div>`}
  ${vigCard(op)}
  <h2>Áudios da operação (${(op.audios || []).length})</h2><div id="op_aud"></div><div class="btn" id="aud_op" style="margin-top:10px">🎙️ Gravar áudio da operação</div>
  <div class="grid2" style="margin-top:14px"><div class="btn pri" id="rel_op">📄 Relatório PDF</div><div class="btn" onclick="location.hash='#vinculos/${id}'">🕸️ Vínculos</div></div>
  <div class="grid2" style="margin-top:10px"><div class="btn" id="pl_op">📊 Exportar planilha</div><div class="btn" id="imp_op">⬆️ Importar em lote</div></div>
  <div class="btn" id="exp_op" style="margin-top:10px">📦 Exportar operação (outro aparelho)</div>
  <div class="grid2" style="margin-top:10px"><div class="btn" id="dup_op">📑 Duplicar como modelo</div><div class="btn" id="arq_op">${isArq(op) ? '📂 Desarquivar' : '🗄️ Arquivar'}</div></div>
  <div class="grid2" style="margin-top:10px"><div class="btn" onclick="location.hash='#mapa'">🗺️ Ver no mapa</div><div class="btn dan" id="del">Excluir operação</div></div>
  ${opTimelineBox(id)}
  <div class="btn pri fab" onclick="location.hash='#novoalvo/${id}'">+</div>`;
  $('#ed').onclick = () => opForm(op); $('#rel_op').onclick = () => relatorioSheet(id);
  $('#dup_op').onclick = () => dupSheet(op); $('#arq_op').onclick = () => toggleArq(op); if ($('#unarq')) $('#unarq').onclick = () => toggleArq(op);
  APP.querySelectorAll('.otag').forEach(c => c.onclick = () => { const t = c.dataset.t.toLowerCase(); APP.querySelectorAll('.otag').forEach(x => { x.classList.toggle('c-blue', x === c); x.classList.toggle('c-gray', x !== c); }); APP.querySelectorAll('.acard').forEach(el => el.style.display = !t || el.dataset.tags.split('|').includes(t) ? '' : 'none'); });
  $('#imp_op').onclick = () => importBatch(id);
  $('#exp_op').onclick = () => exportOpUI(op);
  $('#pl_op').onclick = () => planilhaUI(id); $('#aud_op').onclick = () => recordAudio(op, 'op'); audioList($('#op_aud'), op);
  $('#del').onclick = async () => {
    if (!await confirmBox(`Excluir "${op.nome}" e seus ${alvos.length} alvo(s)?`, 'Excluir', true)) return;
    await dropOp(id); await save(); location.hash = '#ops'; toast('Operação excluída');
  };
  loadThumbs();
}
async function loadThumbs() { for (const el of APP.querySelectorAll('[data-img]')) { const id = el.dataset.img; if (!id) continue; const u = await getImg(id); if (u) el.innerHTML = `<img src="${u}">` + (el.dataset.g ? `<span class="g">${el.dataset.g}</span>` : ''); } }

/* ---------- Formulário de alvo ---------- */
function viewAlvoForm(id, opId) {
  tabs('ops'); const a = id ? getAlvo(id) : null; if (id && !a) return location.hash = '#ops';
  const oid = a?.opId || opId;
  APP.innerHTML = `<div class="back" onclick="history.back()">‹ Voltar</div><h1>${a ? 'Editar alvo' : 'Novo alvo'}</h1>
  <div class="ocrbar"><div class="btn sm" id="a_ocr">🪪 Ler documento</div><div class="btn sm" id="a_cnh">🪪 Ler CNH (modelo)</div><span class="sub">foto do RG/CNH · leitura no aparelho</span></div><div id="a_docpend"></div>
  <label>Operação</label><select id="a_op">${S.ops.map(o => `<option value="${o.id}" ${o.id === oid ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select>
  <label>Nome completo</label><input id="a_nome" value="${esc(a?.nome)}">
  <label>Apelido / vulgo</label><input id="a_apelido" value="${esc(a?.apelido)}">
  <div class="grid2"><div><label>CPF / RG</label><input id="a_doc" value="${esc(a?.doc)}" inputmode="numeric"></div><div><label>Prioridade</label><select id="a_prio">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${(a?.prio || 'media') === k ? 'selected' : ''}>${v[1].replace('Prioridade ', '')}</option>`).join('')}</select></div></div>
  <div class="grid2"><div><label>Data de nascimento</label><input id="a_nasc" type="date" value="${esc(a?.nasc)}"></div><div></div></div>
  <label>Filiação</label><textarea id="a_filiacao" data-mic style="min-height:56px" placeholder="Pai e mãe (um por linha)">${esc(a?.filiacao)}</textarea>
  <label>Telefones (um por linha)</label><textarea id="a_tel" style="min-height:64px" inputmode="tel">${esc((a?.tels || []).join('\n'))}</textarea>
  <div class="lblrow"><label>Veículo (modelo, cor, placa)</label><div class="btn sm" id="a_placa">🚗 Ler placa</div></div><input id="a_veic" value="${esc(a?.veic)}">
  <label>Endereço conhecido</label><input id="a_end" value="${esc(a?.end)}">
  <label>Vínculos (pessoas, facções, empresas)</label><textarea id="a_vinc" data-mic style="min-height:64px">${esc(a?.vinc)}</textarea>
  <div class="sub" style="margin:6px 4px 0">Para ligar a outro alvo cadastrado (irmão, sócio…), use <b>Vincular</b> na ficha.</div>
  <div class="grid2"><div><label>Situação</label><select id="a_sit"><option value="">—</option>${Object.entries(SITU).map(([k, v]) => `<option value="${k}" ${a?.situacao === k ? 'selected' : ''}>${v[1]}</option>`).join('')}</select></div><div id="a_sito_w" class="${a?.situacao === 'outro' ? '' : 'hidden'}"><label>Qual?</label><input id="a_sito" value="${esc(a?.situacaoOutro)}"></div></div>
  <label>Etiquetas</label><div id="a_tags"></div>
  <label>Redes sociais (uma por linha)</label><textarea id="a_redes" style="min-height:64px" placeholder="Instagram: @perfil&#10;Facebook: link">${esc((a?.redes || []).join('\n'))}</textarea>
  <label>Mandados</label><div id="a_mands"></div><div class="btn sm" id="a_madd" style="margin-top:8px">+ Mandado</div>
  <div class="gap"></div><div class="btn pri" id="a_ok">Salvar alvo</div>`;
  const mands = (a?.mandados || []).map(m => ({...m}));
  const getTags = tagInput($('#a_tags'), (a?.tags || []).slice());
  const drawM = () => { $('#a_mands').innerHTML = mands.map((m, i) => `<div class="card glass mrow" style="cursor:default;padding:10px"><input data-i="${i}" data-f="num" placeholder="Número do mandado" value="${esc(m.num)}"><div class="grid2" style="margin-top:8px"><select data-i="${i}" data-f="status">${Object.entries(MAND_ST).map(([k, v]) => `<option value="${k}" ${m.status === k ? 'selected' : ''}>${v}</option>`).join('')}</select><input type="date" data-i="${i}" data-f="data" value="${esc(m.data)}"></div><div class="sub" data-rm="${i}" style="margin-top:8px;cursor:pointer;color:#ffadad">Remover</div></div>`).join('') || '<div class="sub" style="margin:0 4px">Nenhum mandado.</div>';
    $('#a_mands').querySelectorAll('[data-f]').forEach(el => el.oninput = el.onchange = () => mands[+el.dataset.i][el.dataset.f] = el.value.trim());
    $('#a_mands').querySelectorAll('[data-rm]').forEach(el => el.onclick = () => { mands.splice(+el.dataset.rm, 1); drawM(); }); };
  let docPend = null; // imagem do documento escolhida na leitura: só vai para o cofre ao salvar o alvo
  const drawDocPend = () => { $('#a_docpend').innerHTML = docPend ? `<div class="sub ocrpend">🪪 A imagem do documento será salva${a && a.docFoto ? ' (substitui a atual)' : ''} ao tocar em <b>Salvar alvo</b>. <span id="a_docx" style="color:#ffadad;cursor:pointer">Não salvar</span></div>` : ''; const x = $('#a_docx'); if (x) x.onclick = () => { docPend = null; drawDocPend(); }; };
  $('#a_ocr').onclick = () => docOcrStart(r => { if (r.img) { docPend = r.img; drawDocPend(); } });
  $('#a_cnh').onclick = () => cnhStart(r => { if (r.img) { docPend = r.img; drawDocPend(); } });
  $('#a_placa').onclick = () => plateOcrStart(pl => { const el = $('#a_veic'); el.value = putPlate(el.value, pl); el.dispatchEvent(new Event('input')); toast('🚗 Placa ' + pl + ' no campo Veículo — confira e salve'); });
  micify(APP);
  drawM(); $('#a_madd').onclick = () => { mands.push({num: '', status: 'aberto', data: ''}); drawM(); };
  $('#a_sit').onchange = e => $('#a_sito_w').classList.toggle('hidden', e.target.value !== 'outro');
  $('#a_ok').onclick = async () => {
    const g = k => $('#a_' + k).value.trim();
    if (!g('nome')) return toast('Informe o nome');
    if (!g('op')) return toast('Crie uma operação primeiro');
    const d = {opId: g('op'), nome: g('nome'), apelido: g('apelido'), doc: g('doc'), nasc: g('nasc'), filiacao: g('filiacao'), prio: g('prio'), tels: g('tel').split('\n').map(x => x.trim()).filter(Boolean), veic: g('veic'), end: g('end'), vinc: g('vinc'), situacao: g('sit'), situacaoOutro: g('sit') === 'outro' ? g('sito') : '', redes: g('redes').split('\n').map(x => x.trim()).filter(Boolean), mandados: mands.filter(m => m.num || m.data), tags: getTags()};
    if (a) { Object.assign(a, d); a.log = a.log || []; a.log.push({ts: Date.now(), t: 'Dados editados'}); }
    else S.alvos.push({id: uid(), ...d, fotos: [], locais: [], notas: [], audios: [], pend: [], log: [{ts: Date.now(), t: 'Alvo cadastrado'}], ts: Date.now()});
    const al = a || S.alvos[S.alvos.length - 1];
    if (docPend) { try { const id = uid(); await putImg(id, new Uint8Array(docPend)); if (al.docFoto) await dropImg(al.docFoto.id); al.docFoto = {id, ts: Date.now(), hash: await sha256(docPend)}; al.log.push({ts: Date.now(), t: 'Foto do documento registrada (leitura de documento)'}); } catch (e) { toast('Erro ao salvar a imagem do documento: ' + e.message); } docPend = null; }
    await save(); toast('Alvo salvo'); location.hash = '#alvo/' + (a ? a.id : S.alvos[S.alvos.length - 1].id);
  };
}

/* ---------- Ficha do alvo ---------- */
function timeline(a) {
  const ev = [...(a.log || []).map(x => ({ts: x.ts, i: '📝', t: x.t}))];
  (a.fotos || []).forEach(f => ev.push({ts: f.ts, i: isAlbum(f) ? '🖼️' : '📷', t: 'Foto' + (isAlbum(f) ? ' (álbum)' : '') + (f.legenda ? ': ' + f.legenda : '') + (f.lat ? ` · ${coord(f)}` : ' · sem GPS')}));
  (a.locais || []).forEach(l => ev.push({ts: l.ts, i: (TIPOS[l.tipo] || TIPOS.outro)[0], t: `${l.titulo || (TIPOS[l.tipo] || TIPOS.outro)[1]} · ${coord(l)}` + (l.nota ? ' — ' + l.nota : '')}));
  (a.notas || []).forEach(n => ev.push({ts: n.ts, i: '🗒️', t: n.txt}));
  (a.audios || []).forEach(x => ev.push({ts: x.ts, i: '🎙️', t: `Áudio${x.titulo ? ': ' + x.titulo : ''} (${durTxt(x.dur)})`}));
  const vop = getOp(a.opId); ((vop && vop.diario) || []).filter(e => vigAlvos(vop, e).includes(a.id)).forEach(e => ev.push({ts: e.ts, i: (VIG_K[e.k] || VIG_K.obs)[0], t: 'Vigilância — ' + vigTxt(vop, e) + (e.lat != null ? ` · ${coord(e)}` : '')}));
  return ev.sort((x, y) => y.ts - x.ts);
}
async function viewAlvo(id) {
  tabs('ops'); const a = getAlvo(id); if (!a) return location.hash = '#ops';
  const op = getOp(a.opId); const p = PRIO[a.prio] || PRIO.media;
  const rows = [['Apelido', a.apelido], ['Situação', situTxt(a)], ['Documento', a.doc], ['Nascimento', a.nasc && dateBR(a.nasc)], ['Filiação', a.filiacao], ['Telefones', (a.tels || []).join('<br>')], ['Veículo', a.veic], ['Endereço', a.end], ['Vínculos', a.vinc], ['Redes sociais', (a.redes || []).join('<br>')], ['Mandados', (a.mandados || []).map(mandTxt).join('<br>')], ['Operação', op?.nome]].filter(r => r[1]);
  const lks = linksOf(a.id);
  const tl = timeline(a);
  APP.innerHTML = `<div class="back" onclick="location.hash='#op/${a.opId}'">‹ ${esc(op?.nome || 'Operação')}</div>
  <div class="hero" id="hero">${a.fotos?.length ? '' : '<div class="ph">👤</div>'}<div class="cap glass"><div class="row"><div><div class="t" style="font-weight:700;font-size:18px">${esc(a.nome)}</div><div class="sub">${a.fotos?.length || 0} foto(s) · ${a.locais?.length || 0} local(is) · ${a.notas?.length || 0} nota(s)</div></div><div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end"><span class="chip ${p[0]}">${p[1].replace('Prioridade ', '')}</span>${a.situacao ? `<span class="chip ${(SITU[a.situacao] || SITU.outro)[0]}">${esc(situTxt(a))}</span>` : ''}</div></div></div></div>
  ${(a.tags || []).length ? `<div class="chips" id="al_tags" style="margin:-4px 2px 12px">${tagChips(a.tags, 'atag')}</div>` : ''}
  ${xAlerts(a)}
  <div class="acts"><div class="act glass" id="b_foto"><em>📷</em>Foto</div><div class="act glass" id="b_loc"><em>📍</em>Marcar local</div><div class="act glass" id="b_nota"><em>🗒️</em>Anotar</div><div class="act glass" id="b_aud"><em>🎙️</em>Áudio</div><div class="act glass" id="b_doc"><em>🪪</em>Documento</div><div class="act glass" id="b_lnk"><em>🔗</em>Vincular</div><div class="act glass" onclick="location.hash='#mapa/${a.id}'"><em>🗺️</em>Mapa</div><div class="act glass" id="b_vig"><em>👁️</em>Vigiar</div>${rotaDests(a).length ? '<div class="act glass" id="b_rota"><em>🧭</em>Rota</div>' : ''}</div>
  <div class="card glass list" style="cursor:default;padding:0">${rows.length ? rows.map(r => `<div class="li"><span>${r[0]}</span><b>${['Telefones', 'Redes sociais', 'Mandados'].includes(r[0]) ? r[1].split('<br>').map(esc).join('<br>') : esc(r[1])}</b></div>`).join('') : '<div class="li"><span>Sem dados cadastrados</span></div>'}</div>
  <h2>Pendências (${(a.pend || []).filter(p => !p.done).length} aberta(s)${(a.pend || []).some(p => pendState(p) === 'atrasada') ? ' · ⏰ atrasada' : ''})</h2>
  ${(a.pend || []).length ? `<div class="card glass list" id="al_pend" style="cursor:default;padding:0">${a.pend.slice().sort(pendSort).map(p => pendRow(p, a)).join('')}</div>` : ''}<div class="btn sm" id="b_pend" style="margin-top:8px;display:inline-flex">＋ Pendência</div>
  <h2>Vínculos com alvos (${lks.length})</h2>
  ${lks.length ? `<div class="card glass list" style="cursor:default;padding:0">${lks.map(l => `<div class="li"><span style="cursor:pointer;color:var(--txt)" onclick="location.hash='#alvo/${l.other.id}'">${l.out ? '→' : '←'} <b style="font-weight:600">${esc(l.other.nome)}</b>${getOp(l.other.opId) && l.other.opId !== a.opId ? ` <span class="sub">(${esc(getOp(l.other.opId).nome)})</span>` : ''}</span><b class="lk" data-l="${l.id}" style="cursor:pointer">${esc(l.rel)} ✏️</b></div>`).join('')}</div>` : '<div class="sub" style="margin:0 4px">Nenhum. Use “Vincular”.</div>'}
  <h2>Foto do documento</h2>
  ${a.docFoto ? `<div style="display:flex;gap:12px;align-items:center"><div class="th docth" style="width:110px;aspect-ratio:1.5" data-img="${a.docFoto.id}" id="doc_v"></div><div class="btn sm" id="doc_b">Trocar / remover</div></div>` : '<div class="btn sm" id="doc_b" style="display:inline-flex">🪪 Adicionar foto do documento</div>'}
  <h2>Áudios (${(a.audios || []).length})</h2><div id="al_aud"></div>
  <h2>Fotos</h2>
  ${a.fotos?.length ? `<div class="thumbs">${a.fotos.map(f => `<div class="th" data-img="${f.id}" data-g="${(a.capa === f.id ? '⭐' : '') + (f.carimbo ? '🕓' : '') + (f.lat ? '📍' : '')}" onclick="viewer('${a.id}','${f.id}')"></div>`).join('')}</div>` : '<div class="sub" style="margin:0 4px">Nenhuma foto. Use “Foto”.</div>'}
  <h2>Linha do tempo</h2>
  ${tl.length ? `<div class="tl">${tl.map(e => `<div class="tli glass"><div class="sub">${fmt(e.ts)}</div><div style="margin-top:3px">${e.i} ${esc(e.t)}</div></div>`).join('')}</div>` : ''}
  <div class="gap"></div><div class="btn pri" onclick="location.hash='#exportar/${a.id}'">📤 Exportar / compartilhar</div>
  <div class="grid2" style="margin-top:10px"><div class="btn" onclick="location.hash='#alvo/${a.id}/editar'">✏️ Editar</div><div class="btn dan" id="b_del">🗑️ Excluir</div></div>`;
  if (a.fotos?.length) getImg(capaId(a, 'last')).then(u => { if (u && $('#hero')) $('#hero').insertAdjacentHTML('afterbegin', `<img src="${u}">`); });
  loadThumbs();
  $('#b_foto').onclick = () => photoMenu(a);
  $('#b_pend').onclick = () => pendForm(a); bindPend(APP);
  APP.querySelectorAll('.atag').forEach(c => c.onclick = () => location.hash = '#busca/tag/' + encodeURIComponent(c.dataset.tag));
  APP.querySelectorAll('.xchip').forEach(c => c.onclick = () => location.hash = c.dataset.h);
  $('#b_loc').onclick = () => markPlace(a);
  $('#b_aud').onclick = () => recordAudio(a, 'alvo'); audioList($('#al_aud'), a);
  $('#b_doc').onclick = () => docFotoMenu(a); $('#b_lnk').onclick = () => linkSheet(a); if ($('#b_rota')) $('#b_rota').onclick = () => rotaSheet(rotaDests(a), a.nome);
  $('#b_vig').onclick = () => { const vo = getOp(a.opId); const at = vo && (vo.vig || []).filter(s => !s.fim && s.alvoId === a.id).sort((x, y) => y.ini - x.ini)[0]; if (at) location.hash = `#vig/${vo.id}/${at.id}`; else vigNovaSheet(a.opId, a.id); };
  APP.querySelectorAll('.lk').forEach(el => el.onclick = () => linkSheet(a, S.links.find(l => l.id === el.dataset.l)));
  $('#doc_b').onclick = () => docFotoMenu(a); if ($('#doc_v')) $('#doc_v').onclick = () => docViewer(a);
  $('#b_nota').onclick = () => sheet(`<h2 style="margin-top:0">Nova anotação</h2><textarea id="n_t" data-mic placeholder="O que foi observado, horário, com quem…" style="min-height:130px"></textarea><div class="gap"></div><div class="btn pri" id="n_ok">Salvar anotação</div>`, s => {
    s.querySelector('#n_t').focus();
    s.querySelector('#n_ok').onclick = async () => { const t = s.querySelector('#n_t').value.trim(); if (!t) return; a.notas = a.notas || []; a.notas.push({id: uid(), ts: Date.now(), txt: t}); await save(); closeSheet(); route(); toast('Anotação salva'); };
  });
  $('#b_del').onclick = async () => {
    if (!await confirmBox(`Excluir o alvo "${a.nome}" com fotos, áudios, locais e vínculos?`, 'Excluir', true)) return;
    await dropAlvo(a); await save(); location.hash = '#op/' + a.opId; toast('Alvo excluído');
  };
}
async function viewer(aid, fid) {
  const a = getAlvo(aid); const f = a.fotos.find(x => x.id === fid); const uO = await getImg(fid), uC = f.carimbo ? await getImg(f.carimbo.id) : null; const u = uC || uO;
  const alb = isAlbum(f); const ehCapa = a.capa === fid;
  const quando = alb
    ? `🕒 Data original da foto: ${f.dataExif === false ? '<span class="sub">sem data na foto</span>' : fmt(f.ts)}<br>⬇️ Importada em: ${fmt(f.importado || f.ts)}`
    : `🕒 ${fmt(f.ts)}`;
  const onde = f.lat != null ? `📍 ${coord(f)}${accTxt(f)}${alb ? ' <span class="sub">(GPS da foto)</span>' : ''}` : `📍 ${alb ? 'sem localização na foto' : 'sem localização'}`;
  const d = document.createElement('div'); d.className = 'viewer';
  d.innerHTML = `<div class="vimg"><img id="v_img" src="${u}"></div>${uC ? '<div class="seg glass" id="v_seg" style="margin-top:12px;width:100%;max-width:420px"><div data-v="c" class="on">🕓 Carimbada</div><div data-v="o">Original</div></div>' : ''}<div class="glass" style="margin-top:14px;padding:12px 16px;max-width:100%;font-size:13px;line-height:1.6">
    ${f.legenda ? `<b>${esc(f.legenda)}</b><br>` : ''}<span id="v_org">${alb ? '🖼️ Origem: Álbum' : '📷 Origem: Câmera'}</span><br>${quando}<br>${onde}<br><span class="sub">SHA-256 ${f.carimbo ? 'original' : ''}${f.hashTipo === 'original' ? ' (arquivo original)' : ''}: ${f.hash.slice(0, 32)}…</span>${f.carimbo ? `<br><span class="sub">SHA-256 carimbada: ${f.carimbo.hash.slice(0, 32)}…</span>` : ''}</div>
    <div class="btn ${ehCapa ? '' : 'pri'}" id="v_capa" style="margin-top:14px;width:100%;max-width:420px">${ehCapa ? '⭐ Capa atual' : '⭐ Usar como capa'}</div>
    <div class="grid2" style="margin-top:10px;width:100%;max-width:420px"><div class="btn dan" id="v_del">Excluir foto</div><div class="btn" id="v_x">Fechar</div></div>`;
  document.body.appendChild(d);
  d.querySelectorAll('#v_seg div').forEach(x => x.onclick = () => { d.querySelectorAll('#v_seg div').forEach(y => y.classList.toggle('on', y === x)); d.querySelector('#v_img').src = x.dataset.v === 'c' ? uC : uO; d.querySelector('.vimg').classList.remove('rev'); });
  d.querySelector('#v_x').onclick = () => d.remove();
  d.querySelector('#v_capa').onclick = async () => {
    if (a.capa === fid) return toast('Esta já é a capa');
    a.capa = fid; a.log = a.log || []; a.log.push({ts: Date.now(), t: 'Capa alterada'}); await save(); d.remove(); route(); toast('⭐ Capa definida');
  };
  d.querySelector('#v_del').onclick = async () => { d.style.display = 'none'; /* o visualizador fica acima da folha de confirmação */ if (!await confirmBox('Excluir esta foto?', 'Excluir', true)) { d.style.display = ''; return; } a.fotos = a.fotos.filter(x => x.id !== fid); if (a.capa === fid) delete a.capa; await dropImg(fid); if (f.carimbo) await dropImg(f.carimbo.id); await save(); d.remove(); route(); };
}

/* ---------- Foto com GPS ---------- */
function resizeJpeg(file, max = 1600) {
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => { const r = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); c.toBlob(b => b ? b.arrayBuffer().then(res) : rej(new Error('falha ao processar')), 'image/jpeg', .85); };
    img.onerror = () => rej(new Error('imagem inválida')); img.src = u;
  });
}
/* Menu “Foto”: câmera ou álbum */
function photoMenu(a) {
  sheet(`<h2 style="margin-top:0">Adicionar foto</h2>
    <div class="tgrow card glass" style="cursor:default;margin:6px 0 14px"><div>🕓 Carimbo na foto<div class="sub">data/hora, coordenadas, operação e alvo numa cópia</div></div><div class="tg ${S.cfg.carimbo ? 'on' : ''}" id="pm_stamp"></div></div>
    <div class="btn pri" id="pm_cam">📷 Tirar foto</div>
    <div class="btn" id="pm_alb" style="margin-top:10px">🖼️ Escolher do álbum</div>
    <div class="sub" style="margin:10px 4px 0;line-height:1.4">Do álbum, a data e o local vêm da própria foto (se ela tiver). O GPS atual não é usado.</div>`, s => {
    // o clique no input acontece dentro do mesmo toque (exigência do iPhone)
    let stamp = !!S.cfg.carimbo; const tg = s.querySelector('#pm_stamp'); tg.onclick = () => { stamp = !stamp; tg.classList.toggle('on', stamp); };
    s.querySelector('#pm_cam').onclick = () => { closeSheet(); takePhoto(a, stamp); };
    s.querySelector('#pm_alb').onclick = () => { closeSheet(); pickAlbum(a, stamp); };
  });
}
function takePhoto(a, stamp) {
  const inp = $('#cam'); inp.value = ''; hold(180000);
  const gp = geo(); // GPS começa junto com a câmera
  inp.oncancel = () => release();
  inp.onchange = async () => {
    release(); const file = inp.files[0]; if (!file) return;
    toast('Processando e criptografando…');
    try {
      const bytes = await resizeJpeg(file); const hash = await sha256(bytes); const pos = await gp; const ts = Date.now();
      const fid = uid(); await putImg(fid, new Uint8Array(bytes));
      const carimbo = stamp ? await makeStamp(a, bytes, ts, pos) : null;
      sheet(`<h2 style="margin-top:0">Foto salva no cofre</h2><div class="sub">${pos ? `📍 ${coord(pos)} (±${pos.acc} m)` : '⚠️ Sem localização (GPS negado ou indisponível)'}${carimbo ? '<br>🕓 Cópia carimbada criada' : ''}</div><label>Legenda (opcional)</label><input id="p_l" placeholder="Ex.: entrada da residência"><div class="gap"></div><div class="btn pri" id="p_ok">Concluir</div>`, s => {
        const done = async () => { a.fotos = a.fotos || []; a.fotos.push({id: fid, ts, hash, legenda: s.querySelector('#p_l')?.value.trim() || '', origem: 'camera', ...(pos || {}), ...(carimbo ? {carimbo} : {})}); await save(); closeSheet(); route(); toast('📷 Foto registrada'); };
        s.querySelector('#p_ok').onclick = done;
      });
    } catch (e) { toast('Erro: ' + e.message); }
  };
  inp.click();
}

/* ---------- Leitor EXIF mínimo (JPEG) — by @aiforge.team ---------- */
// Lê GPS, DateTimeOriginal e Orientation dos bytes originais. Não-JPEG ou EXIF ausente/corrompido → {}.
function parseExif(buf) {
  try {
    const v = new DataView(buf instanceof ArrayBuffer ? buf : buf.buffer, buf.byteOffset || 0, buf.byteLength);
    if (v.byteLength < 4 || v.getUint16(0) !== 0xFFD8) return {};
    let p = 2;
    while (p + 4 <= v.byteLength) {
      if (v.getUint8(p) !== 0xFF) return {};
      const mk = v.getUint8(p + 1);
      if (mk === 0xFF) { p++; continue; }               // preenchimento
      if (mk === 0xDA || mk === 0xD9) return {};          // início da imagem: sem EXIF
      if (mk === 0x01 || (mk >= 0xD0 && mk <= 0xD7)) { p += 2; continue; }
      const len = v.getUint16(p + 2);
      if (len < 2 || p + 2 + len > v.byteLength) return {};
      if (mk === 0xE1 && len >= 16 && v.getUint32(p + 4) === 0x45786966 && v.getUint16(p + 8) === 0) return readTiff(v, p + 10, p + 2 + len);
      p += 2 + len;
    }
  } catch (e) { /* EXIF inválido: ignora */ }
  return {};
}
function readTiff(v, t, end) {
  const bo = v.getUint16(t); if (bo !== 0x4949 && bo !== 0x4D4D) return {};
  const le = bo === 0x4949;
  const u16 = o => v.getUint16(o, le), u32 = o => v.getUint32(o, le);
  if (u16(t + 2) !== 42) return {};
  const SZ = {1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 7: 1, 9: 4, 10: 8};
  const ifd = off => {
    const out = {}; const base = t + off;
    if (off < 8 || base + 2 > end) return out;
    const n = u16(base); if (n > 512 || base + 2 + n * 12 > end) return out;
    for (let i = 0; i < n; i++) {
      const e = base + 2 + i * 12, tag = u16(e), type = u16(e + 2), cnt = u32(e + 4), sz = SZ[type];
      if (!sz || cnt > 65535) continue;
      const vo = sz * cnt <= 4 ? e + 8 : t + u32(e + 8);
      if (vo + sz * cnt > end) continue;
      let val;
      if (type === 2) { let str = ''; for (let k = 0; k < cnt; k++) { const c = v.getUint8(vo + k); if (!c) break; str += String.fromCharCode(c); } val = str; }
      else if (type === 3) val = cnt === 1 ? u16(vo) : Array.from({length: cnt}, (_, k) => u16(vo + 2 * k));
      else if (type === 4) val = cnt === 1 ? u32(vo) : Array.from({length: cnt}, (_, k) => u32(vo + 4 * k));
      else if (type === 5 || type === 10) { val = []; for (let k = 0; k < cnt; k++) { const nu = type === 5 ? u32(vo + 8 * k) : v.getInt32(vo + 8 * k, le), de = type === 5 ? u32(vo + 8 * k + 4) : v.getInt32(vo + 8 * k + 4, le); val.push(de ? nu / de : NaN); } }
      else continue;
      out[tag] = val;
    }
    return out;
  };
  const i0 = ifd(u32(t + 4)); const r = {};
  if (i0[0x0112]) r.orientation = i0[0x0112];
  const ex = i0[0x8769] ? ifd(i0[0x8769]) : {};
  const dto = ex[0x9003] || ex[0x9004] || i0[0x0132];
  const m = typeof dto === 'string' && dto.match(/^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (m && +m[1] > 1900) {
    const off = typeof ex[0x9011] === 'string' && /^[+-]\d{2}:\d{2}$/.test(ex[0x9011]) ? ex[0x9011] : null;
    const ts = off ? Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${off}`) : new Date(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
    if (isFinite(ts)) r.ts = ts;
  }
  if (i0[0x8825]) {
    const g = ifd(i0[0x8825]);
    const dms = a => Array.isArray(a) && a.length >= 3 ? a[0] + a[1] / 60 + a[2] / 3600 : NaN;
    let lat = dms(g[2]), lng = dms(g[4]);
    if (/S/i.test(g[1] || '')) lat = -lat; if (/W/i.test(g[3] || '')) lng = -lng;
    if (validLatLng(lat, lng) && !(lat === 0 && lng === 0)) { r.lat = +lat.toFixed(7); r.lng = +lng.toFixed(7); }
  }
  return r;
}

/* ---------- Fotos do álbum (várias de uma vez) ---------- */
function pickAlbum(a, stamp) {
  const inp = $('#alb'); inp.value = ''; hold(300000);
  inp.oncancel = () => release();
  inp.onchange = () => { release(); const files = [...(inp.files || [])]; inp.value = ''; if (files.length) importAlbum(a, files, stamp); };
  inp.click();
}
async function importAlbum(a, files, stamp) {
  const added = []; let falhas = 0; const n = files.length;
  for (let i = 0; i < n; i++) {
    if (!KEY) return; // cofre travou no meio
    resetIdle(); toast(`🖼️ Processando ${i + 1}/${n}…`, 60000);
    try {
      const file = files[i]; const orig = await file.arrayBuffer();
      const ex = parseExif(orig);                     // EXIF antes de redimensionar (o canvas remove os metadados)
      const hash = await sha256(orig);                // hash dos bytes ORIGINAIS do arquivo
      const bytes = await resizeJpeg(file);           // o navegador já aplica a rotação do EXIF ao desenhar
      const fid = uid(); await putImg(fid, new Uint8Array(bytes)); const now = Date.now();
      const f = {id: fid, ts: ex.ts || now, importado: now, dataExif: !!ex.ts, hash, hashTipo: 'original', legenda: '', origem: 'album', arquivo: file.name || ''};
      if (ex.lat != null) Object.assign(f, {lat: ex.lat, lng: ex.lng, acc: null});
      if (ex.orientation) f.orient = ex.orientation;
      if (stamp) f.carimbo = await makeStamp(a, bytes, f.ts, f.lat != null ? f : null, ex.ts ? '' : ' (importação — foto sem data)'); // álbum: data e GPS do EXIF
      a.fotos = a.fotos || []; a.fotos.push(f); added.push(f);
    } catch (e) { console.warn('álbum: falha', e); falhas++; }
  }
  if (added.length) await save();
  $('#toast').classList.add('hidden');
  const comGps = added.filter(f => f.lat != null).length, nStamp = added.filter(f => f.carimbo).length;
  if (!added.length) { route(); return toast('⚠️ Nenhuma foto pôde ser processada'); }
  sheet(`<h2 style="margin-top:0">Fotos do álbum</h2>
    <div class="card glass" style="cursor:default" id="al_sum"><div class="t">${added.length} foto(s) adicionada(s), ${comGps} com localização</div>
      ${nStamp ? `<div class="sub" style="margin-top:4px">🕓 ${nStamp} cópia(s) carimbada(s) com data/local da própria foto</div>` : ''}
      ${falhas ? `<div class="sub" style="margin-top:4px">⚠️ ${falhas} arquivo(s) não puderam ser lidos</div>` : ''}
      ${comGps < added.length ? `<div class="sub" style="margin-top:4px">Sem local na foto? No iPhone, ative <b>Opções → Localização</b> ao escolher.</div>` : ''}</div>
    <label>Legenda comum (opcional, aplicada a todas)</label><input id="al_l" placeholder="Ex.: fotos da campana">
    <div class="gap"></div><div class="btn pri" id="al_ok">Concluir</div>`, s => {
    s.querySelector('#al_ok').onclick = async () => {
      const lg = s.querySelector('#al_l').value.trim();
      if (lg) { added.forEach(f => f.legenda = lg); await save(); }
      closeSheet(); route(); toast(`🖼️ ${added.length} foto(s) registrada(s)`);
    };
  });
  route();
}

/* ---------- Marcar local ---------- */
function markPlace(a, opts) {
  let pos = null, m = null, map = null; const inbox = !!(opts && opts.onSave);
  sheet(`<h2 style="margin-top:0">${inbox ? '📍 Local rápido' : 'Marcar local'}</h2>${inbox ? `<div class="sub">Vai para <b>Rascunhos</b> · ${esc(opts.label || 'Caixa geral')}</div>` : ''}
    <label>Tipo</label><select id="l_t">${Object.entries(TIPOS).filter(([k]) => k !== 'foto' && k !== 'vig').map(([k, v]) => `<option value="${k}">${v[0]} ${v[1]}</option>`).join('')}</select>
    <label>Título</label><input id="l_ti" placeholder="Ex.: casa da mãe">
    <label>Observação</label><input id="l_no" data-mic placeholder="Opcional">
    <div class="grid2" style="margin-top:14px"><div class="btn" id="l_gps">📡 Estou aqui</div><div class="btn" id="l_map">🗺️ Escolher no mapa</div></div>
    <div id="l_search" style="margin-top:14px"></div>
    <div id="l_info" class="sub" style="margin:10px 4px"></div><div id="l_box" class="mapbox sm hidden"></div>
    <div class="gap"></div><div class="btn pri" id="l_ok">Salvar local</div>`, s => {
    const info = t => s.querySelector('#l_info').textContent = t;
    const showMap = (c, z) => {
      s.querySelector('#l_box').classList.remove('hidden');
      if (!map) { map = L.map(s.querySelector('#l_box'), {zoomControl: false}).setView(c, z); tiles().addTo(map);
        map.on('click', e => place(e.latlng.lat, e.latlng.lng)); }
      else map.setView(c, z); setTimeout(() => map.invalidateSize(), 150);
    };
    const place = (lat, lng, acc) => { pos = {lat, lng, acc: acc || null}; info(`📍 ${coord(pos)}${acc ? ` (±${acc} m)` : ''} — arraste o marcador para ajustar`);
      if (m) m.setLatLng([lat, lng]); else { m = L.marker([lat, lng], {draggable: true, icon: pinIcon(s.querySelector('#l_t').value)}).addTo(map); m.on('dragend', () => { const ll = m.getLatLng(); place(ll.lat, ll.lng); }); } };
    s.querySelector('#l_gps').onclick = async () => { info('Obtendo GPS…'); hold(20000); const g = await geo(); release(); if (!g) return info('⚠️ Não foi possível obter a localização. Use “Escolher no mapa”.'); showMap([g.lat, g.lng], 17); place(g.lat, g.lng, g.acc); };
    s.querySelector('#l_map').onclick = () => { const last = lastPoint(); showMap(last || [-3.7319, -38.5267], last ? 15 : 12); info('Toque no mapa para posicionar o marcador'); };
    mountSearch(s.querySelector('#l_search'), {
      getCenter: () => map ? {lat: map.getCenter().lat, lng: map.getCenter().lng} : (lastPoint() ? {lat: lastPoint()[0], lng: lastPoint()[1]} : {lat: -3.7319, lng: -38.5267}),
      onPick: (lat, lng, label) => { showMap([lat, lng], 17); place(lat, lng); if (label) { const ti = s.querySelector('#l_ti'); if (!ti.value.trim()) ti.value = label; } }
    });
    s.querySelector('#l_t').onchange = e => m && m.setIcon(pinIcon(e.target.value));
    if (opts && opts.autoGps) setTimeout(() => s.querySelector('#l_gps') && s.querySelector('#l_gps').click(), 50);
    s.querySelector('#l_ok').onclick = async () => {
      if (!pos) return toast('Defina a posição (GPS ou mapa)');
      const loc = {id: uid(), ts: Date.now(), tipo: s.querySelector('#l_t').value, titulo: s.querySelector('#l_ti').value.trim(), nota: s.querySelector('#l_no').value.trim(), ...pos};
      if (inbox) { if (map) map.remove(); closeSheet(); await opts.onSave(loc); route(); return toast('📥 Local em Rascunhos'); }
      a.locais = a.locais || []; a.locais.push(loc);
      await save(); if (map) map.remove(); closeSheet(); route(); toast('📍 Local salvo');
    };
  });
}
function lastPoint() { const pts = S.alvos.flatMap(a => [...(a.locais || []), ...(a.fotos || []).filter(f => f.lat)]).sort((x, y) => y.ts - x.ts); return pts[0] ? [pts[0].lat, pts[0].lng] : null; }
const tiles = () => L.tileLayer(tileUrl(), {attribution: '© OpenStreetMap', maxZoom: 19, className: 'dark-tiles', crossOrigin: true}); // crossOrigin: o sw.js consegue guardar o bloco (sem resposta opaca)
const pinIcon = t => { const v = TIPOS[t] || TIPOS.outro; return L.divIcon({className: '', html: `<div class="pin" style="background:${v[2]}"><span>${v[0]}</span></div>`, iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -30]}); };

/* ---------- Mapa (v0.5: filtros, calor, áreas, offline) — by @aiforge.team ---------- */
let MF = null; // filtros do mapa: valem durante a sessão aberta (zerados ao travar)
const mfNew = () => ({op: '', alvo: '', tipos: [], de: '', ate: '', heat: false, traj: true});
const mfCount = f => (f.op ? 1 : 0) + (f.alvo ? 1 : 0) + (f.tipos.length ? 1 : 0) + (f.de || f.ate ? 1 : 0) + (f.traj === false ? 1 : 0);
function mapPoints(one) {
  const f = MF; const alvos = one ? [one] : S.alvos.filter(a => (!f.op || a.opId === f.op) && (!f.alvo || a.id === f.alvo));
  const t0 = f.de ? new Date(f.de + 'T00:00').getTime() : -Infinity, t1 = f.ate ? new Date(f.ate + 'T23:59:59.999').getTime() : Infinity;
  const pts = [];
  alvos.forEach(a => { (a.locais || []).forEach(l => pts.push({a, lat: l.lat, lng: l.lng, tipo: l.tipo, t: l.titulo || TIPOS[l.tipo]?.[1], n: l.nota, ts: l.ts}));
    (a.fotos || []).filter(x => x.lat != null).forEach(x => pts.push({a, lat: x.lat, lng: x.lng, tipo: 'foto', t: x.legenda || 'Foto', ts: x.ts})); });
  S.ops.filter(o => one ? o.id === one.opId : !f.op || o.id === f.op).forEach(o => (o.diario || []).forEach(e => { // diário de vigilância
    if (e.lat == null) return; const ids = vigAlvos(o, e); if (one ? !ids.includes(one.id) : f.alvo && !ids.includes(f.alvo)) return;
    pts.push({a: getAlvo(ids[0]) || null, lat: e.lat, lng: e.lng, tipo: 'vig', t: (VIG_K[e.k] || VIG_K.obs)[1], n: vigTxt(o, e), ts: e.ts, who: o.nome, href: `#vig/${o.id}/${e.sess}`}); }));
  return pts.filter(p => (!f.tipos.length || f.tipos.includes(TIPOS[p.tipo] ? p.tipo : 'outro')) && p.ts >= t0 && p.ts <= t1);
}
const mapAreas = one => S.areas.filter(ar => one ? (!ar.opId || ar.opId === one.opId) : (!MF.op || !ar.opId || ar.opId === MF.op));

/* Mapa de calor: camada canvas própria (sem bibliotecas). Cada ponto soma intensidade; a paleta colore. */
const HeatLayer = L.Layer.extend({
  initialize(pts) { this._pts = pts; },
  onAdd(map) { this._map = map; this._c = L.DomUtil.create('canvas', 'ov-heat leaflet-zoom-hide'); this._c.style.pointerEvents = 'none'; map.getPanes().overlayPane.appendChild(this._c); map.on('moveend zoomend resize viewreset', this._draw, this); this._draw(); },
  onRemove(map) { L.DomUtil.remove(this._c); map.off('moveend zoomend resize viewreset', this._draw, this); },
  _pal() { if (HeatLayer._p) return HeatLayer._p; const c = document.createElement('canvas'); c.width = 256; c.height = 1; const g = c.getContext('2d'), gr = g.createLinearGradient(0, 0, 256, 0);
    [[0, '#2050ff'], [.35, '#00d0ff'], [.55, '#40ff70'], [.75, '#ffe030'], [1, '#ff3030']].forEach(([o, k]) => gr.addColorStop(o, k)); g.fillStyle = gr; g.fillRect(0, 0, 256, 1); return HeatLayer._p = g.getImageData(0, 0, 256, 1).data; },
  _draw() {
    const m = this._map, s = m.getSize(), c = this._c; L.DomUtil.setPosition(c, m.containerPointToLayerPoint([0, 0])); c.width = s.x; c.height = s.y;
    const g = c.getContext('2d', {willReadFrequently: true}); const r = Math.max(14, Math.min(48, 26 * Math.pow(1.22, m.getZoom() - 14)));
    this._pts.forEach(p => { const q = m.latLngToContainerPoint([p.lat, p.lng]); if (q.x < -r || q.y < -r || q.x > s.x + r || q.y > s.y + r) return;
      const gr = g.createRadialGradient(q.x, q.y, 0, q.x, q.y, r); gr.addColorStop(0, 'rgba(0,0,0,.45)'); gr.addColorStop(1, 'rgba(0,0,0,0)'); g.fillStyle = gr; g.fillRect(q.x - r, q.y - r, 2 * r, 2 * r); });
    if (!this._pts.length || !s.x || !s.y) return;
    const im = g.getImageData(0, 0, s.x, s.y), d = im.data, P = this._pal();
    for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; if (!a) continue; const o = Math.min(255, Math.round(a * 1.25)) * 4; /* ~3 pontos sobrepostos já chegam ao vermelho */ d[i] = P[o]; d[i + 1] = P[o + 1]; d[i + 2] = P[o + 2]; d[i + 3] = Math.min(215, 60 + a); }
    g.putImageData(im, 0, 0);
  }
});

function viewMapa(aid) {
  window._sm = null; tabs('mapa'); const one = aid ? getAlvo(aid) : null; if (!MF) MF = mfNew();
  APP.innerHTML = `${one ? `<div class="back" onclick="location.hash='#alvo/${one.id}'">‹ ${esc(one.nome)}</div>` : ''}
  <div class="top"><div><h1>${one ? 'Mapa do alvo' : 'Mapa geral'}</h1><div class="sub" id="mp_sub"></div></div>${one ? `<div class="btn sm" id="mk">+ Local</div>` : ''}</div>
  <div id="map_search"></div>
  <div class="mtools"><div class="btn sm" id="mf_b">⚙️ Filtros</div><div class="btn sm ${MF.heat ? 'pri' : ''}" id="mh_b">🔥 Calor</div><div class="btn sm" id="ma_b">⬡ Áreas</div><div class="btn sm" id="mo_b">⬇️ Offline</div><div class="btn sm" id="mm_b">📏 Medir</div></div>
  <div id="mf_chips" class="chips" style="margin:0 2px 10px"></div>
  <div id="draw_bar" class="drawbar glass hidden"></div>
  <div class="mapbox" id="map" style="height:calc(100vh - 300px)"></div>
  <div class="sub" id="mp_empty" style="margin:12px 4px"></div>`;
  const map = L.map('map', {zoomControl: false}); window._map = map;
  tiles().addTo(map);
  const gPins = L.layerGroup().addTo(map), gAreas = L.layerGroup().addTo(map), gTraj = L.layerGroup().addTo(map); let heat = null;
  const render = fit => {
    const pts = mapPoints(one); gPins.clearLayers(); gAreas.clearLayers(); if (heat) { map.removeLayer(heat); heat = null; }
    if (MF.heat) { heat = new HeatLayer(pts); map.addLayer(heat); }
    else pts.forEach(p => L.marker([p.lat, p.lng], {icon: pinIcon(p.tipo)}).addTo(gPins).bindPopup(`<b>${esc(p.t)}</b><br><span style="color:#8a9bb8">${esc(p.who || p.a.nome)} · ${fmt(p.ts)}</span>${p.n ? '<br>' + esc(p.n) : ''}<br>${p.href ? `<a href="${p.href}" style="color:#9cbcff">Abrir diário</a>` : `<a href="#alvo/${p.a.id}" style="color:#9cbcff">Abrir ficha</a>`} · <a href="#" class="prota" onclick="rotaSheet([{label: 'Ponto no mapa', lat: ${p.lat}, lng: ${p.lng}}]);return false" style="color:#9cbcff">Rota</a>`));
    const trs = mapTracks(one); gTraj.clearLayers(); trs.forEach(x => trackLayer(x.o, x.t).addTo(gTraj));
    const ars = mapAreas(one); ars.forEach(ar => areaShape(ar).addTo(gAreas).bindPopup(areaPopup(ar)));
    const nf = one ? (MF.tipos.length ? 1 : 0) + (MF.de || MF.ate ? 1 : 0) + (MF.traj === false ? 1 : 0) : mfCount(MF);
    $('#mp_sub').textContent = `${pts.length} ponto(s)${ars.length ? ` · ${ars.length} área(s)` : ''}${trs.length ? ` · ${trs.length} trajeto(s)` : ''}${nf ? ` · ${nf} filtro(s)` : ''}${MF.heat ? ' · calor' : ''}`;
    $('#mf_b').textContent = nf ? `⚙️ Filtros (${nf})` : '⚙️ Filtros'; $('#mf_b').classList.toggle('pri', !!nf); $('#mh_b').classList.toggle('pri', MF.heat);
    const ch = []; if (!one && MF.op) ch.push(getOp(MF.op)?.nome); if (!one && MF.alvo) ch.push('👤 ' + (getAlvo(MF.alvo)?.nome || '?')); if (MF.tipos.length) ch.push(MF.tipos.map(t => TIPOS[t][0]).join(' ')); if (MF.de || MF.ate) ch.push(`📅 ${MF.de ? MF.de.split('-').reverse().join('/') : '…'} – ${MF.ate ? MF.ate.split('-').reverse().join('/') : '…'}`); if (MF.traj === false) ch.push('sem trajetos');
    $('#mf_chips').innerHTML = ch.filter(Boolean).map(t => `<span class="chip c-blue">${esc(t)}</span>`).join('') + (ch.length ? '<span class="chip c-gray" id="mf_clr" style="cursor:pointer">✕ limpar</span>' : '');
    if ($('#mf_clr')) $('#mf_clr').onclick = () => { const h = MF.heat; MF = mfNew(); MF.heat = h; render(true); };
    $('#mp_empty').textContent = pts.length || trs.length ? '' : (S.alvos.some(a => (a.locais || []).length || (a.fotos || []).some(x => x.lat != null)) ? 'Nenhum ponto com os filtros atuais.' : 'Nenhum ponto ainda. Marque locais ou tire fotos com GPS na ficha do alvo.');
    if (fit) { const b = [...pts.map(p => [p.lat, p.lng]), ...ars.flatMap(areaLatLngs), ...trs.flatMap(x => x.t.pts.map(q => [q[0], q[1]]))]; if (b.length) map.fitBounds(b, {padding: [40, 40], maxZoom: 16}); else if (!map._loaded) map.setView([-3.7319, -38.5267], 12); }
  };
  window._mapRender = render;
  render(true); if (window._offFit) { map.fitBounds(window._offFit); window._offFit = null; }
  $('#mf_b').onclick = () => mapFilterSheet(one, () => render(true));
  $('#mh_b').onclick = () => { MF.heat = !MF.heat; render(false); };
  $('#ma_b').onclick = () => areaListSheet(map, one);
  $('#mo_b').onclick = () => offlineSheet(map); $('#mm_b').onclick = () => measureTool(map);
  mountSearch($('#map_search'), {
    getCenter: () => ({lat: map.getCenter().lat, lng: map.getCenter().lng}),
    onPick: (lat, lng, label) => { map.setView([lat, lng], 16); if (window._sm) window._sm.setLatLng([lat, lng]); else window._sm = L.marker([lat, lng], {draggable: true, icon: pinIcon('outro')}).addTo(map); window._sm.bindPopup('🔍 Resultado da busca' + (label ? '<br>' + esc(label) : '') + (one ? `<br><a href="#" onclick="markPlace(getAlvo('${one.id}'));return false" style="color:#9cbcff">Marcar como local</a>` : '')).openPopup(); }
  });
  if (one) $('#mk').onclick = () => markPlace(one);
}
function mapFilterSheet(one, done) {
  const f = {...MF, tipos: [...MF.tipos]};
  const alvoOpts = () => S.alvos.filter(a => !f.op || a.opId === f.op).map(a => `<option value="${a.id}" ${f.alvo === a.id ? 'selected' : ''}>${esc(a.nome)}${f.op ? '' : ' · ' + esc(getOp(a.opId)?.nome || '')}</option>`).join('');
  sheet(`<h2 style="margin-top:0">⚙️ Filtros do mapa</h2><div class="sub">Valem até o cofre travar.</div>
    ${one ? '' : `<label>Operação</label><select id="mf_op"><option value="">Todas</option>${S.ops.map(o => `<option value="${o.id}" ${f.op === o.id ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select>
    <label>Alvo</label><select id="mf_al"><option value="">Todos</option>${alvoOpts()}</select>`}
    <label>Tipo de local</label><div class="chips" id="mf_tp">${Object.entries(TIPOS).map(([k, v]) => `<span class="chip ${f.tipos.includes(k) ? 'c-blue' : 'c-gray'}" data-t="${k}" style="cursor:pointer">${v[0]} ${v[1]}</span>`).join('')}</div>
    <div class="sub" style="margin:6px 4px 0">Nenhum marcado = todos.</div>
    <div class="grid2"><div><label>De</label><input type="date" id="mf_de" value="${f.de}"></div><div><label>Até</label><input type="date" id="mf_ate" value="${f.ate}"></div></div>
    <div class="tgrow card glass" style="cursor:default;margin-top:12px"><div>🛰️ Mostrar trajetos gravados<div class="sub">seguem operação, alvo (da sessão) e período</div></div><div class="tg ${f.traj !== false ? 'on' : ''}" id="mf_tr"></div></div>
    <div class="gap"></div><div class="grid2"><div class="btn" id="mf_x">Limpar</div><div class="btn pri" id="mf_ok">Aplicar</div></div>`, s => {
    const op = s.querySelector('#mf_op'); if (op) op.onchange = () => { f.op = op.value; if (f.alvo && getAlvo(f.alvo)?.opId !== f.op && f.op) f.alvo = ''; s.querySelector('#mf_al').innerHTML = '<option value="">Todos</option>' + alvoOpts(); };
    s.querySelectorAll('#mf_tp .chip').forEach(c => c.onclick = () => { const k = c.dataset.t; f.tipos = f.tipos.includes(k) ? f.tipos.filter(x => x !== k) : [...f.tipos, k]; c.className = 'chip ' + (f.tipos.includes(k) ? 'c-blue' : 'c-gray'); });
    s.querySelector('#mf_tr').onclick = e => { f.traj = f.traj === false; e.target.classList.toggle('on', f.traj); };
    s.querySelector('#mf_x').onclick = () => { const h = MF.heat; MF = mfNew(); MF.heat = h; closeSheet(); done(); };
    s.querySelector('#mf_ok').onclick = () => {
      if (!one) { f.op = s.querySelector('#mf_op').value; f.alvo = s.querySelector('#mf_al').value; }
      f.de = s.querySelector('#mf_de').value; f.ate = s.querySelector('#mf_ate').value;
      if (f.de && f.ate && f.de > f.ate) return toast('A data inicial é depois da final');
      MF = f; closeSheet(); done();
    };
  });
}

/* ---------- Áreas no mapa (círculo ou polígono) ---------- */
const dotIcon = L.divIcon({className: '', html: '<div class="cdot"></div>', iconSize: [24, 24], iconAnchor: [12, 12]}); // sem imagens padrão do Leaflet (lib/images não existe)
const AREA_CORES = ['#5b8fff', '#ff6b6b', '#ffa94d', '#3cd290', '#c77dff', '#ffd43b'];
const areaLatLngs = ar => ar.tipo === 'circulo' ? (() => { const d = ar.raio / 111320, k = Math.cos(ar.c[0] * Math.PI / 180) || 1; return [[ar.c[0] - d, ar.c[1] - d / k], [ar.c[0] + d, ar.c[1] + d / k]]; })() : ar.pts;
const areaShape = ar => { const o = {color: ar.cor, weight: 2, fillColor: ar.cor, fillOpacity: .15}; return ar.tipo === 'circulo' ? L.circle(ar.c, {...o, radius: ar.raio}) : L.polygon(ar.pts, o); };
function polyArea(pts) { // m², projeção local equiretangular (suficiente para áreas de bairro/cidade)
  if (pts.length < 3) return 0; const R = 6371008.8, la0 = pts.reduce((s, p) => s + p[0], 0) / pts.length * Math.PI / 180;
  const xy = pts.map(p => [p[1] * Math.PI / 180 * R * Math.cos(la0), p[0] * Math.PI / 180 * R]); let s = 0;
  for (let i = 0; i < xy.length; i++) { const [x1, y1] = xy[i], [x2, y2] = xy[(i + 1) % xy.length]; s += x1 * y2 - x2 * y1; } return Math.abs(s / 2);
}
const m2Txt = m => m >= 1e6 ? (m / 1e6).toLocaleString('pt-BR', {maximumFractionDigits: 2}) + ' km²' : Math.round(m).toLocaleString('pt-BR') + ' m²';
const areaInfo = ar => ar.tipo === 'circulo' ? `Círculo · raio ${ar.raio.toLocaleString('pt-BR')} m · ${m2Txt(Math.PI * ar.raio * ar.raio)}` : `Polígono · ${ar.pts.length} pontos · ${m2Txt(polyArea(ar.pts))}`;
const areaPopup = ar => `<b style="color:${ar.cor}">⬡ ${esc(ar.nome)}</b><br><span style="color:#8a9bb8">${areaInfo(ar)}${ar.opId && getOp(ar.opId) ? '<br>' + esc(getOp(ar.opId).nome) : ''}</span>${ar.nota ? '<br>' + esc(ar.nota) : ''}<br><a href="#" onclick="areaEdit('${ar.id}');return false" style="color:#9cbcff">Editar</a> · <a href="#" onclick="areaDel('${ar.id}');return false" style="color:#ff9a9a">Excluir</a>`;
function areaListSheet(map, one) {
  const ars = mapAreas(one);
  sheet(`<h2 style="margin-top:0">⬡ Áreas</h2><div class="sub">Marque perímetros de interesse: um raio em volta de um ponto ou um polígono livre.</div>
    <div class="grid2" style="margin-top:14px"><div class="btn pri" id="ar_c">⭕ Novo raio</div><div class="btn pri" id="ar_p">⬡ Novo polígono</div></div>
    <h2>Neste mapa (${ars.length})</h2>${ars.length ? `<div class="card glass list" style="cursor:default;padding:0">${ars.map(ar => `<div class="li" data-a="${ar.id}" style="cursor:pointer"><span><b style="color:${ar.cor}">⬤</b> <b style="font-weight:600;color:var(--txt)">${esc(ar.nome)}</b><br><span class="sub">${areaInfo(ar)}${ar.opId && getOp(ar.opId) ? ' · ' + esc(getOp(ar.opId).nome) : ''}</span></span><b>›</b></div>`).join('')}</div>` : '<div class="sub" style="margin:0 4px">Nenhuma área.</div>'}`, s => {
    s.querySelector('#ar_c').onclick = () => { closeSheet(); areaDraw(map, {tipo: 'circulo', opId: one ? one.opId : (MF.op || '')}); };
    s.querySelector('#ar_p').onclick = () => { closeSheet(); areaDraw(map, {tipo: 'poligono', opId: one ? one.opId : (MF.op || '')}); };
    s.querySelectorAll('[data-a]').forEach(el => el.onclick = () => { const ar = S.areas.find(x => x.id === el.dataset.a); closeSheet(); map.fitBounds(areaLatLngs(ar), {padding: [30, 30], maxZoom: 17}); areaEdit(ar.id); });
  });
}
/* Desenho no mapa principal. base: área existente (editar forma) ou {tipo, opId} */
function areaDraw(map, base) {
  const circ = base.tipo === 'circulo'; const bar = $('#draw_bar'); const tmp = L.layerGroup().addTo(map);
  let c = base.c ? L.latLng(base.c) : null, raio = base.raio || 300, pts = (base.pts || []).map(p => L.latLng(p)); let cm = null;
  const cor = base.cor || AREA_CORES[S.areas.length % AREA_CORES.length];
  const draw = () => {
    tmp.clearLayers();
    if (circ) { if (c) { L.circle(c, {radius: raio, color: cor, fillColor: cor, fillOpacity: .18, weight: 2}).addTo(tmp); cm = L.marker(c, {draggable: true, icon: dotIcon}).addTo(tmp); cm.on('dragend', () => { c = cm.getLatLng(); draw(); }); } }
    else { if (pts.length > 1) (pts.length > 2 ? L.polygon(pts, {color: cor, fillColor: cor, fillOpacity: .18, weight: 2, dashArray: '5 4'}) : L.polyline(pts, {color: cor, weight: 2, dashArray: '5 4'})).addTo(tmp);
      pts.forEach((p, i) => L.circleMarker(p, {radius: i === pts.length - 1 ? 7 : 5, color: '#fff', weight: 2, fillColor: cor, fillOpacity: 1}).addTo(tmp)); }
    bar.querySelector('#db_info').textContent = circ ? (c ? `Raio ${raio.toLocaleString('pt-BR')} m · ${m2Txt(Math.PI * raio * raio)} — arraste o marcador para mover` : 'Toque no mapa para pôr o centro') : (pts.length ? `${pts.length} ponto(s)${pts.length > 2 ? ' · ' + m2Txt(polyArea(pts.map(p => [p.lat, p.lng]))) : ' — mínimo 3'}` : 'Toque no mapa para adicionar os vértices');
    const ok = bar.querySelector('#db_ok'); ok.classList.toggle('dis', circ ? !c : pts.length < 3);
    const un = bar.querySelector('#db_un'); if (un) un.classList.toggle('dis', !pts.length);
  };
  bar.innerHTML = `<div class="t" style="font-size:14px">${circ ? '⭕ Raio' : '⬡ Polígono'}${base.id ? ' · ' + esc(base.nome) : ''}</div><div class="sub" id="db_info" style="margin:4px 0 8px"></div>
    ${circ ? `<div style="display:flex;gap:10px;align-items:center"><input type="range" id="db_r" min="25" max="5000" step="25" value="${raio}" style="flex:1;padding:0"><input id="db_rn" type="number" inputmode="numeric" min="10" max="50000" value="${raio}" style="width:92px;padding:8px 10px"><span class="sub">m</span></div>` : ''}
    <div style="display:flex;gap:8px;margin-top:10px">${circ ? '' : '<div class="btn sm" id="db_un">↶ Desfazer</div>'}<div class="btn sm" id="db_x">Cancelar</div><div class="btn sm pri" id="db_ok" style="flex:1">Concluir</div></div>`;
  bar.classList.remove('hidden'); $('.mtools').classList.add('hidden'); $('#mf_chips').classList.add('hidden');
  const onClick = e => { if (circ) c = e.latlng; else pts.push(e.latlng); draw(); };
  map.on('click', onClick); map.closePopup(); map.getContainer().classList.add('drawing');
  const end = () => { map.off('click', onClick); map.removeLayer(tmp); bar.classList.add('hidden'); bar.innerHTML = ''; map.getContainer().classList.remove('drawing'); $('.mtools')?.classList.remove('hidden'); $('#mf_chips')?.classList.remove('hidden'); };
  if (circ) { const r = bar.querySelector('#db_r'), rn = bar.querySelector('#db_rn');
    r.oninput = () => { raio = +r.value; rn.value = raio; draw(); };
    rn.onchange = () => { const v = Math.round(+rn.value); if (!(v >= 10 && v <= 50000)) { rn.value = raio; return toast('Raio entre 10 e 50.000 m'); } raio = v; r.value = Math.min(5000, v); draw(); }; }
  else bar.querySelector('#db_un').onclick = () => { pts.pop(); draw(); };
  bar.querySelector('#db_x').onclick = () => { end(); window._mapRender && window._mapRender(false); };
  bar.querySelector('#db_ok').onclick = () => {
    if (circ ? !c : pts.length < 3) return toast(circ ? 'Toque no mapa para pôr o centro' : 'Marque pelo menos 3 pontos');
    const geo_ = circ ? {tipo: 'circulo', c: [+c.lat.toFixed(6), +c.lng.toFixed(6)], raio} : {tipo: 'poligono', pts: pts.map(p => [+p.lat.toFixed(6), +p.lng.toFixed(6)])};
    end();
    if (base.id) { const ar = S.areas.find(x => x.id === base.id); Object.assign(ar, geo_, {upd: Date.now()}); if (circ) delete ar.pts; else { delete ar.c; delete ar.raio; } save().then(() => { window._mapRender && window._mapRender(false); toast('⬡ Forma atualizada'); }); }
    else areaForm({...geo_, cor, opId: base.opId || ''});
  };
  draw(); if (circ && c) map.setView(c, Math.max(map.getZoom(), 14));
}
function areaForm(ar) {
  const isNew = !ar.id;
  sheet(`<h2 style="margin-top:0">${isNew ? 'Nova área' : 'Editar área'}</h2><div class="sub">${areaInfo(ar)}</div>
    <label>Nome</label><input id="af_n" value="${esc(ar.nome)}" placeholder="Ex.: perímetro da boca">
    <label>Cor</label><div class="chips" id="af_c">${AREA_CORES.map(k => `<span class="swatch ${k === ar.cor ? 'on' : ''}" data-c="${k}" style="background:${k}"></span>`).join('')}</div>
    <label>Operação (opcional)</label><select id="af_o"><option value="">— nenhuma (aparece em todas) —</option>${S.ops.map(o => `<option value="${o.id}" ${ar.opId === o.id ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select>
    <label>Observação</label><input id="af_t" value="${esc(ar.nota)}" placeholder="Opcional">
    <div class="gap"></div><div class="btn pri" id="af_ok">Salvar área</div>
    ${isNew ? '' : '<div class="grid2" style="margin-top:10px"><div class="btn" id="af_g">✏️ Ajustar forma</div><div class="btn dan" id="af_d">Excluir</div></div>'}`, s => {
    let cor = ar.cor || AREA_CORES[0];
    s.querySelectorAll('.swatch').forEach(w => w.onclick = () => { cor = w.dataset.c; s.querySelectorAll('.swatch').forEach(x => x.classList.toggle('on', x === w)); });
    s.querySelector('#af_ok').onclick = async () => {
      const nome = s.querySelector('#af_n').value.trim(); if (!nome) return toast('Dê um nome à área');
      const d = {nome, cor, opId: s.querySelector('#af_o').value, nota: s.querySelector('#af_t').value.trim()};
      if (isNew) S.areas.push({id: uid(), ts: Date.now(), ...ar, ...d}); else Object.assign(S.areas.find(x => x.id === ar.id), d, {upd: Date.now()});
      await save(); closeSheet(); window._mapRender && window._mapRender(false); toast('⬡ Área salva');
    };
    if (!isNew) { s.querySelector('#af_d').onclick = () => areaDel(ar.id); s.querySelector('#af_g').onclick = () => { closeSheet(); if (window._map) areaDraw(window._map, ar); }; }
  });
}
function areaEdit(id) { const ar = S.areas.find(x => x.id === id); if (!ar) return; window._map && window._map.closePopup(); areaForm(ar); }
async function areaDel(id) {
  const ar = S.areas.find(x => x.id === id); if (!ar) return; window._map && window._map.closePopup();
  if (!await confirmBox(`Excluir a área "${ar.nome}"?`, 'Excluir', true)) return;
  S.areas = S.areas.filter(x => x.id !== id); await save(); window._mapRender && window._mapRender(false); toast('Área excluída');
}

/* ---------- Mapa offline (Cache Storage + sw.js) ----------
   Dois níveis:
   1) Sempre: os blocos que você VÊ ficam guardados (sw.js, até ~3000, renovados após 7 dias) — permitido pelo OSM.
   2) “Baixar área”: pré-download da tela atual (zoom atual..+3, teto 1500 blocos, até 4 em paralelo — usamos 3).
      A política do tile.openstreetmap.org PROÍBE pré-download/offline, então esse botão só funciona com outro
      servidor de mapas que permita (configurável em Cofre → Mapas offline). */
const TILE_CACHE = 'opsvault-tiles', TILE_OSM = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', TILE_CAP = 1500, TILE_PAR = 3;
const tileUrl = () => (S && S.cfg.tileUrl) || TILE_OSM;
const isOsm = u => /(^|\.)openstreetmap\.org$/i.test((() => { try { return new URL(u.replace(/\{[a-z]\}/gi, '0')).hostname; } catch (e) { return ''; } })());
const offlineAllowed = () => !isOsm(tileUrl());
const lon2x = (lng, z) => Math.floor((lng + 180) / 360 * 2 ** z);
const lat2y = (lat, z) => { const r = Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI / 180; return Math.floor((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * 2 ** z); };
function tileRange(b, z) { const n = 2 ** z, cl = v => Math.max(0, Math.min(n - 1, v)); return {z, x0: cl(lon2x(b.w, z)), x1: cl(lon2x(b.e, z)), y0: cl(lat2y(b.n, z)), y1: cl(lat2y(b.s, z))}; }
const rangeCount = r => (r.x1 - r.x0 + 1) * (r.y1 - r.y0 + 1);
/* zoom atual..+3; corta os níveis mais altos até caber no teto */
function offlinePlan(b, zc) {
  const z0 = Math.max(0, Math.round(zc)), all = []; for (let z = z0; z <= Math.min(19, z0 + 3); z++) all.push(tileRange(b, z));
  const want = all.reduce((s, r) => s + rangeCount(r), 0); let rs = all.slice();
  while (rs.length > 1 && rs.reduce((s, r) => s + rangeCount(r), 0) > TILE_CAP) rs.pop();
  const n = rs.reduce((s, r) => s + rangeCount(r), 0);
  return {z0, z1: rs[rs.length - 1].z, zWant: all[all.length - 1].z, n, want, ranges: rs, tooBig: n > TILE_CAP};
}
function* tileUrls(rec) { const t = rec.url; for (const r of rec.ranges) for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) yield t.replace('{z}', r.z).replace('{x}', x).replace('{y}', y).replace('{s}', 'abc'[Math.abs(x + y) % 3]).replace('{r}', ''); }
const kbTxt = b => b >= 1048576 ? (b / 1048576).toLocaleString('pt-BR', {maximumFractionDigits: 1}) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';
let OFF_RUN = null;
function offlineSheet(map) {
  const bb = map.getBounds(), b = {s: bb.getSouth(), w: bb.getWest(), n: bb.getNorth(), e: bb.getEast()};
  const pl = offlinePlan(b, map.getZoom()), allowed = offlineAllowed();
  const tot = S.offline.reduce((s, o) => s + (o.bytes || 0), 0);
  sheet(`<h2 style="margin-top:0">⬇️ Mapa offline</h2>
    <div class="card glass" style="cursor:default"><div class="t" style="font-size:14px">🗺️ Já funciona sem internet</div><div class="sub" style="margin-top:4px;line-height:1.45">Os blocos do mapa que você <b>visualiza</b> ficam guardados no aparelho e reaparecem sem sinal. Antes de sair, passeie pela região no zoom que vai precisar.</div></div>
    <h2>Baixar a área visível</h2>
    ${allowed ? `<div class="card glass" style="cursor:default"><div class="row"><div>Blocos</div><b id="of_n">${pl.n.toLocaleString('pt-BR')}</b></div><div class="row" style="margin-top:6px"><div>Zoom</div><b id="of_z">${pl.z0}–${pl.z1}</b></div><div class="row" style="margin-top:6px"><div>Tamanho estimado</div><b>~${kbTxt(pl.n * 18e3)}</b></div></div>
      ${pl.tooBig ? `<div class="warn" id="of_big">Área grande demais: mesmo só no zoom ${pl.z0} passa de ${TILE_CAP} blocos. Aproxime o mapa.</div>` : pl.z1 < pl.zWant ? `<div class="warn" id="of_cut">Seriam ${pl.want.toLocaleString('pt-BR')} blocos até o zoom ${pl.zWant}. Para respeitar o limite de ${TILE_CAP}, vai só até o zoom ${pl.z1}.</div>` : ''}
      <label>Nome</label><input id="of_nm" value="Área ${new Date().toLocaleDateString('pt-BR')}">
      <div class="prog hidden" id="of_pg"><i></i></div><div class="sub" id="of_st" style="margin:6px 4px"></div>
      <div class="btn pri ${pl.tooBig ? 'dis' : ''}" id="of_go">⬇️ Baixar para offline</div>`
    : `<div class="warn" id="of_osm">O servidor padrão (OpenStreetMap) <b>não permite</b> baixar áreas para offline — a política dele bloqueia aparelhos que fazem isso. Para usar este botão, configure em <b>Cofre → Mapas offline</b> um servidor de mapas que permita (próprio ou contratado). A guarda automática acima continua valendo.</div>`}
    <div class="btn" id="of_mg" style="margin-top:10px">Gerenciar mapas offline (${S.offline.length} área(s)${tot ? ' · ' + kbTxt(tot) : ''})</div>`, s => {
    s.querySelector('#of_mg').onclick = () => offlineManage();
    const go = s.querySelector('#of_go'); if (!go) return;
    go.onclick = async () => {
      if (pl.tooBig || OFF_RUN) return; const nome = s.querySelector('#of_nm').value.trim() || 'Área';
      const rec = {id: uid(), nome, ts: Date.now(), b, z0: pl.z0, z1: pl.z1, ranges: pl.ranges, url: tileUrl(), n: pl.n, ok: 0, fail: 0, bytes: 0};
      go.textContent = 'Cancelar download'; go.classList.replace('pri', 'dan'); go.onclick = () => { if (OFF_RUN) OFF_RUN.stop = true; };
      s.querySelector('#of_pg').classList.remove('hidden');
      const r = await offlineDownload(rec, (d, t) => { const pg = $('#of_pg i'); if (pg) pg.style.width = (100 * d / t).toFixed(1) + '%'; const st = $('#of_st'); if (st) st.textContent = `${d.toLocaleString('pt-BR')} / ${t.toLocaleString('pt-BR')} blocos · ${kbTxt(rec.bytes)}`; });
      if (r.stopped && !rec.ok) { closeSheet(); return toast('Download cancelado'); }
      S.offline.push(rec); await save(); closeSheet();
      toast(`${r.stopped ? 'Interrompido' : '✔ Área salva'}: ${rec.ok} bloco(s), ${kbTxt(rec.bytes)}${rec.fail ? ` · ${rec.fail} falha(s)` : ''}`, 4000);
    };
  });
}
async function offlineDownload(rec, prog) {
  const run = OFF_RUN = {stop: false}; const cache = await caches.open(TILE_CACHE); const it = tileUrls(rec); let done = 0;
  hold(30 * 60000);
  const worker = async () => {
    for (let n = it.next(); !n.done; n = it.next()) {
      if (run.stop || !KEY) { run.stop = true; return; }
      const u = n.value; let ok = false;
      try {
        const have = await cache.match(u);
        if (have) { rec.bytes += +(have.headers.get('x-ov-len') || 0); ok = true; if (have.headers.get('x-ov-src') !== 'dl') await cache.put(u, new Response(await have.blob(), {headers: {'content-type': have.headers.get('content-type') || 'image/png', 'x-ov-src': 'dl', 'x-ov-ts': String(Date.now()), 'x-ov-len': have.headers.get('x-ov-len') || '0'}})); }
        else for (let t = 0; t < 2 && !ok; t++) { const r = await fetch(u, {mode: 'cors', credentials: 'omit'}); if (!r.ok) { if (r.status === 404) break; continue; }
          const bl = await r.blob(); await cache.put(u, new Response(bl, {headers: {'content-type': r.headers.get('content-type') || 'image/png', 'x-ov-src': 'dl', 'x-ov-ts': String(Date.now()), 'x-ov-len': String(bl.size)}})); rec.bytes += bl.size; ok = true; }
      } catch (e) { /* sem rede: conta como falha */ }
      ok ? rec.ok++ : rec.fail++; done++; prog(done, rec.n); resetIdle();
    }
  };
  try { await Promise.all(Array.from({length: TILE_PAR}, worker)); } finally { OFF_RUN = null; release(); }
  return {stopped: run.stop};
}
function offlineManage() {
  const tot = S.offline.reduce((s, o) => s + (o.bytes || 0), 0);
  sheet(`<h2 style="margin-top:0">🗺️ Mapas offline</h2>
    <div class="sub" style="line-height:1.45">Servidor: <b>${esc(isOsm(tileUrl()) ? 'OpenStreetMap (padrão)' : tileUrl())}</b><br>${S.offline.length} área(s) baixada(s) · ~${kbTxt(tot)}<br><span id="om_view">Guardados ao visualizar: calculando…</span></div>
    ${S.offline.length ? `<div class="card glass list" style="cursor:default;padding:0;margin-top:12px">${S.offline.map(o => `<div class="li"><span style="color:var(--txt)"><b style="font-weight:600">${esc(o.nome)}</b><br><span class="sub">${o.ok.toLocaleString('pt-BR')} blocos · zoom ${o.z0}–${o.z1} · ~${kbTxt(o.bytes || 0)} · ${fmt(o.ts)}</span></span><span style="display:flex;gap:6px"><b class="om_v" data-o="${o.id}" style="cursor:pointer">🗺️</b><b class="om_d" data-o="${o.id}" style="cursor:pointer;color:#ff9a9a">🗑️</b></span></div>`).join('')}</div>` : '<div class="sub" style="margin:12px 4px">Nenhuma área baixada.</div>'}
    <div class="btn" id="om_srv" style="margin-top:12px">Servidor de mapas…</div>
    <div class="btn dan" id="om_all" style="margin-top:10px">Apagar todos os mapas guardados</div>`, async s => {
    s.querySelectorAll('.om_v').forEach(el => el.onclick = () => { const o = S.offline.find(x => x.id === el.dataset.o); closeSheet(); window._offFit = [[o.b.s, o.b.w], [o.b.n, o.b.e]]; if (location.hash === '#mapa') { window._map.fitBounds(window._offFit); window._offFit = null; } else location.hash = '#mapa'; });
    s.querySelectorAll('.om_d').forEach(el => el.onclick = async () => { const o = S.offline.find(x => x.id === el.dataset.o); if (!await confirmBox(`Apagar o mapa offline "${o.nome}"?`, 'Apagar', true)) return offlineManage(); await offlineDrop(o); offlineManage(); toast('Mapa offline apagado'); });
    s.querySelector('#om_srv').onclick = () => tileServerSheet();
    s.querySelector('#om_all').onclick = async () => { if (!await confirmBox('Apagar todos os mapas guardados neste aparelho (baixados e vistos)?', 'Apagar', true)) return offlineManage(); await caches.delete(TILE_CACHE); S.offline = []; await save(); route(); toast('Mapas guardados apagados'); };
    try { const c = await caches.open(TILE_CACHE), ks = await c.keys(); let n = 0, by = 0; for (const k of ks) { const r = await c.match(k); if (r && r.headers.get('x-ov-src') !== 'dl') { n++; by += +(r.headers.get('x-ov-len') || 0); } } const el = s.querySelector('#om_view'); if (el) el.textContent = `Guardados ao visualizar: ${n.toLocaleString('pt-BR')} bloco(s) · ~${kbTxt(by)}`; } catch (e) {}
  });
}
async function offlineDrop(o) { // apaga só os blocos que nenhuma outra área baixada usa
  const keep = new Set(); S.offline.filter(x => x.id !== o.id).forEach(x => { for (const u of tileUrls(x)) keep.add(u); });
  const c = await caches.open(TILE_CACHE); for (const u of tileUrls(o)) if (!keep.has(u)) await c.delete(u);
  S.offline = S.offline.filter(x => x.id !== o.id); await save();
}
function tileServerSheet() {
  sheet(`<h2 style="margin-top:0">Servidor de mapas</h2><div class="sub" style="line-height:1.45">Modelo de URL com <span class="kbd">{z}</span>, <span class="kbd">{x}</span> e <span class="kbd">{y}</span>. Use um servidor próprio ou um provedor que <b>permita</b> uso offline. Deixe em branco para o OpenStreetMap padrão. O servidor precisa liberar CORS (Access-Control-Allow-Origin).</div>
    <label>URL dos blocos</label><input id="ts_u" value="${esc(S.cfg.tileUrl || '')}" placeholder="${TILE_OSM}" autocapitalize="off" autocorrect="off">
    <div class="gap"></div><div class="btn pri" id="ts_ok">Salvar</div>`, s => {
    s.querySelector('#ts_ok').onclick = async () => {
      const u = s.querySelector('#ts_u').value.trim();
      if (u && (!/\{z\}/.test(u) || !/\{x\}/.test(u) || !/\{y\}/.test(u) || !/^(https:\/\/|http:\/\/(localhost|127\.0\.0\.1)[:/])/.test(u))) return toast('URL inválida: precisa de https:// e {z} {x} {y}');
      if (u && isOsm(u)) { delete S.cfg.tileUrl; } else if (u) S.cfg.tileUrl = u; else delete S.cfg.tileUrl;
      await save(); closeSheet(); toast(S.cfg.tileUrl ? 'Servidor de mapas alterado' : 'Usando OpenStreetMap (padrão)');
    };
  });
}

/* ---------- Busca ---------- */
/* ---------- Exportar ---------- */
function viewExport(aid) {
  tabs('ops'); const a = getAlvo(aid); if (!a) return location.hash = '#ops';
  const o = {fmt: 'pdf', dados: true, fotos: true, docf: false, aud: true, locais: true, notas: true, tl: false, mask: true, marca: true, senha: false};
  const tg = (k, l, d) => `<div class="tgrow"><div>${l}${d ? `<div class="sub">${d}</div>` : ''}</div><div class="tg ${o[k] ? 'on' : ''}" data-k="${k}"></div></div>`;
  APP.innerHTML = `<div class="back" onclick="location.hash='#alvo/${a.id}'">‹ ${esc(a.nome)}</div><h1>Exportar</h1>
  <div class="seg glass" style="margin-top:14px"><div data-f="pdf" class="on">📄 PDF</div><div data-f="img">🖼️ Imagem</div></div>
  <h2>Conteúdo</h2><div class="card glass" style="padding:0;cursor:default">${tg('dados', 'Dados do alvo')}${tg('fotos', 'Fotos', `${a.fotos?.length || 0} disponível(is)`)}${a.docFoto ? tg('docf', 'Foto do documento', 'desligado por padrão — contém dados pessoais') : ''}${tg('locais', 'Locais e coordenadas')}${tg('notas', 'Anotações')}${a.audios?.length ? tg('aud', 'Lista de áudios (só PDF)', `${a.audios.length} — data, duração e SHA-256; o som não vai no arquivo`) : ''}${tg('tl', 'Linha do tempo completa')}</div>
  <h2>Proteção</h2><div class="card glass" style="padding:0;cursor:default">${tg('mask', 'Mascarar telefone e documento')}${tg('marca', 'Marca d’água “RESERVADO”')}<div id="pw_row">${tg('senha', 'Senha no PDF', 'Proteção básica (RC4) — envie a senha por outro canal')}</div></div>
  <input id="pw" class="hidden" placeholder="Senha do PDF" style="margin-top:4px">
  <div class="warn">⚠️ O arquivo exportado sai do cofre e não fica mais criptografado pelo app. Compartilhe só com quem precisa.</div>
  <div class="btn pri" id="go">📤 Gerar e compartilhar</div>
  <div class="credit">Rodapé do arquivo: ${esc(APP_NAME)} · <b>${esc(CREDIT)}</b></div>`;
  APP.querySelectorAll('.tg').forEach(t => t.onclick = () => { o[t.dataset.k] = !o[t.dataset.k]; t.classList.toggle('on'); $('#pw').classList.toggle('hidden', !(o.senha && o.fmt === 'pdf')); });
  APP.querySelectorAll('.seg div').forEach(d => d.onclick = () => { APP.querySelectorAll('.seg div').forEach(x => x.classList.remove('on')); d.classList.add('on'); o.fmt = d.dataset.f; $('#pw_row').classList.toggle('hidden', o.fmt !== 'pdf'); $('#pw').classList.toggle('hidden', !(o.senha && o.fmt === 'pdf')); });
  $('#go').onclick = async () => {
    if (o.fmt === 'pdf' && o.senha && !$('#pw').value) return toast('Defina a senha do PDF');
    $('#go').textContent = 'Gerando…';
    try { const file = o.fmt === 'pdf' ? await buildPDF(a, o, $('#pw').value) : await buildImage(a, o); await shareFile(file); }
    catch (e) { console.error(e); toast('Erro: ' + e.message); }
    $('#go').textContent = '📤 Gerar e compartilhar';
  };
}
function exportData(a, o) {
  const tel = t => o.mask ? maskTel(t) : t, doc = t => o.mask ? maskDoc(t) : t;
  const dados = [['Nome', a.nome], ['Vulgo', a.apelido], ['Documento', a.doc && doc(a.doc)], ['Nascimento', a.nasc && dateBR(a.nasc)], ['Filiação', a.filiacao], ['Telefones', (a.tels || []).map(tel).join(', ')], ['Veículo', a.veic], ['Endereço', a.end], ['Vínculos', a.vinc], ['Vínc. alvos', linksOf(a.id).map(l => `${l.other.nome} (${l.rel})`).join('; ')], ['Situação', situTxt(a)], ['Etiquetas', (a.tags || []).map(t => '#' + t).join(' ')], ['Redes sociais', (a.redes || []).join('; ')], ['Mandados', (a.mandados || []).map(mandTxt).join('; ')], ['Prioridade', (PRIO[a.prio] || PRIO.media)[1].replace('Prioridade ', '')], ['Operação', getOp(a.opId)?.nome]].filter(r => r[1]);
  const locais = [...(a.locais || []).map(l => ({t: `${(TIPOS[l.tipo] || TIPOS.outro)[1]}${l.titulo ? ' — ' + l.titulo : ''}`, c: coord(l), n: l.nota, ts: l.ts, url: `https://maps.google.com/?q=${l.lat},${l.lng}`})),
    ...(a.fotos || []).filter(f => f.lat).map(f => ({t: 'Foto' + (isAlbum(f) ? ' (álbum)' : '') + (f.legenda ? ' — ' + f.legenda : ''), c: coord(f), ts: f.ts, url: `https://maps.google.com/?q=${f.lat},${f.lng}`}))].sort((x, y) => x.ts - y.ts);
  return {dados, locais};
}
const fileStamp = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}_${z(d.getHours())}${z(d.getMinutes())}`; };
const slug = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 30);
async function buildPDF(a, o, pw) {
  const {jsPDF} = window.jspdf;
  const opt = {unit: 'mm', format: 'a4'}; if (o.senha && pw) opt.encryption = {userPassword: pw, ownerPassword: pw + '#ov' + uid(), userPermissions: ['print']};
  const pdf = new jsPDF(opt); const W = 210, M = 14; let y = 0;
  const {dados, locais} = exportData(a, o);
  const header = () => { pdf.setFillColor(8, 14, 26); pdf.rect(0, 0, W, 24, 'F'); pdf.setTextColor(156, 188, 255); pdf.setFontSize(9); pdf.text(APP_NAME.toUpperCase() + '  ·  ' + CREDIT, M, 9); pdf.setTextColor(255, 255, 255); pdf.setFontSize(15); pdf.text(`Relatório de alvo — ${a.nome}`.slice(0, 70), M, 18); y = 32; pdf.setTextColor(20, 24, 32); };
  const marca = () => { if (!o.marca) return; pdf.saveGraphicsState(); pdf.setGState(new pdf.GState({opacity: .08})); pdf.setFontSize(70); pdf.setTextColor(200, 0, 0); pdf.text('RESERVADO', 40, 200, {angle: 35}); pdf.restoreGraphicsState(); pdf.setTextColor(20, 24, 32); };
  const need = h => { if (y + h > 280) { pdf.addPage(); header(); } };
  const title = t => { need(14); pdf.setFontSize(12); pdf.setTextColor(45, 95, 214); pdf.text(t, M, y); y += 2; pdf.setDrawColor(45, 95, 214); pdf.line(M, y, W - M, y); y += 6; pdf.setTextColor(20, 24, 32); pdf.setFontSize(10); };
  const para = (t, ind = 0) => { const L_ = pdf.splitTextToSize(String(t), W - 2 * M - ind); L_.forEach(l => { need(5); pdf.text(l, M + ind, y); y += 5; }); };
  header();
  pdf.setFontSize(9); pdf.setTextColor(100, 110, 125); pdf.text(`Gerado em ${fmt(Date.now())}${o.mask ? ' · dados sensíveis mascarados' : ''}`, M, y); y += 8; pdf.setTextColor(20, 24, 32);
  if (o.dados) { title('Dados do alvo'); dados.forEach(([k, v]) => { need(6); pdf.setFont(undefined, 'bold'); pdf.text(k + ':', M, y); pdf.setFont(undefined, 'normal'); const L_ = pdf.splitTextToSize(String(v), W - 2 * M - 32); L_.forEach((l, i) => { if (i) need(5); pdf.text(l, M + 32, y); y += 5; }); y += 1; }); y += 3; }
  if (o.docf && a.docFoto) { const du = await imgDataURL(a.docFoto.id); if (du) { title('Foto do documento'); const p = pdf.getImageProperties(du); let w = 110, h = w * p.height / p.width; if (h > 80) { h = 80; w = h * p.width / p.height; } need(h + 12); pdf.addImage(du, 'JPEG', M, y, w, h); y += h + 5; pdf.setFontSize(8.5); pdf.setTextColor(100, 110, 125); pdf.text(`Registrada em ${fmt(a.docFoto.ts)} · SHA-256: ${a.docFoto.hash.slice(0, 32)}…`, M, y); pdf.setFontSize(10); pdf.setTextColor(20, 24, 32); y += 8; } }
  if (o.fotos && a.fotos?.length) { title(`Fotos (${a.fotos.length})`);
    for (const f of fotosCapaPrimeiro(a)) { const du = await imgDataURL(dispId(f)); if (!du) continue; const p = pdf.getImageProperties(du); const w = 90, h = Math.min(100, w * p.height / p.width);
      const alb = isAlbum(f);
      const lines = [(a.capa === f.id ? '[Capa] ' : '') + (f.legenda || 'Foto') + (alb ? ' (álbum)' : ''), alb ? `Data da foto: ${f.dataExif === false ? 'sem data na foto' : fmt(f.ts)}` : fmt(f.ts), ...(alb ? [`Importada em ${fmt(f.importado || f.ts)}`] : []),
        f.lat != null ? `GPS: ${coord(f)}${accTxt(f)}${alb ? ' (da foto)' : ''}` : (alb ? 'Sem localização na foto' : 'Sem GPS'), (f.carimbo ? 'SHA-256 original' : 'SHA-256') + (alb && f.hashTipo === 'original' ? ' (arquivo original):' : ':'), f.hash.slice(0, 32), f.hash.slice(32), ...(f.carimbo ? ['SHA-256 carimbada (imagem acima):', f.carimbo.hash.slice(0, 32), f.carimbo.hash.slice(32)] : [])];
      const bh = Math.max(h, lines.length * 5); need(bh + 8);
      pdf.addImage(du, 'JPEG', M, y, h === 100 ? 100 * p.width / p.height : w, h); pdf.setFontSize(9);
      const tx = M + 96; let ty = y + 4; lines.forEach(t => { pdf.text(pdf.splitTextToSize(t, W - M - tx)[0], tx, ty); ty += 5; });
      pdf.setFontSize(10); y += bh + 6; } }
  if (o.locais && locais.length) { title('Locais'); locais.forEach(l => { need(12); pdf.setFont(undefined, 'bold'); pdf.text(l.t, M, y); pdf.setFont(undefined, 'normal'); y += 5; pdf.setTextColor(45, 95, 214); pdf.textWithLink(`${l.c}  ·  ${fmt(l.ts)}  ·  abrir no mapa`, M + 4, y, {url: l.url}); pdf.setTextColor(20, 24, 32); y += 5; if (l.n) para(l.n, 4); y += 2; }); }
  if (o.notas && a.notas?.length) { title('Anotações'); a.notas.slice().sort((x, z) => x.ts - z.ts).forEach(n => { need(10); pdf.setFontSize(8.5); pdf.setTextColor(100, 110, 125); pdf.text(fmt(n.ts), M, y); y += 4.5; pdf.setFontSize(10); pdf.setTextColor(20, 24, 32); para(n.txt); y += 2; }); }
  if (o.aud && a.audios?.length) { title(`Áudios (${a.audios.length})`); pdf.setFontSize(9); a.audios.slice().sort((x, z) => x.ts - z.ts).forEach(x => { need(10); pdf.text(`${fmt(x.ts)} · duração ${durTxt(x.dur)}${x.titulo ? ' · ' + x.titulo : ''}`, M, y); y += 4.5; pdf.setTextColor(100, 110, 125); pdf.text(`SHA-256: ${x.hash || '—'}`, M + 4, y); pdf.setTextColor(20, 24, 32); y += 6; }); pdf.setFontSize(10); }
  if (o.tl) { title('Linha do tempo'); timeline(a).reverse().forEach(e => para(`${fmt(e.ts)} — ${e.t}`)); }
  const hash = await sha256(JSON.stringify({a: a.id, dados, locais, n: a.notas, t: Date.now()}));
  const n = pdf.getNumberOfPages();
  for (let i = 1; i <= n; i++) { pdf.setPage(i); marca(); pdf.setFontSize(7.5); pdf.setTextColor(120, 130, 145); pdf.text(`${APP_NAME} · ${CREDIT}  |  Controle: ${hash.slice(0, 16)}  |  Pág. ${i}/${n}`, M, 291); }
  return new File([pdf.output('blob')], `OpsVault_${slug(a.nome)}_${fileStamp()}.pdf`, {type: 'application/pdf'});
}
async function buildImage(a, o) {
  const W = 1080, P = 56; const c = document.createElement('canvas'); c.width = W; c.height = 4000; const g = c.getContext('2d');
  const {dados, locais} = exportData(a, o);
  const bg = g.createLinearGradient(0, 0, 0, 4000); bg.addColorStop(0, '#0b1422'); bg.addColorStop(1, '#04060a'); g.fillStyle = bg; g.fillRect(0, 0, W, 4000);
  let y = 70; const F = (s, w = 400) => g.font = `${w} ${s}px -apple-system, Roboto, sans-serif`;
  const wrap = (t, x, maxW, lh) => { const words = String(t).split(' '); let line = ''; for (const w of words) { if (g.measureText(line + w).width > maxW && line) { g.fillText(line, x, y); y += lh; line = ''; } line += w + ' '; } g.fillText(line, x, y); y += lh; };
  F(24, 600); g.fillStyle = '#7fa4e6'; g.fillText(APP_NAME.toUpperCase() + '  ·  ' + CREDIT, P, y); y += 60;
  F(52, 700); g.fillStyle = '#fff'; wrap(a.nome, P, W - 2 * P, 60);
  F(26); g.fillStyle = '#8a9bb8'; g.fillText(`${getOp(a.opId)?.nome || ''} · ${fmt(Date.now())}`, P, y); y += 40;
  const sec = t => { y += 24; F(30, 700); g.fillStyle = '#9cbcff'; g.fillText(t, P, y); y += 14; g.fillStyle = 'rgba(91,143,255,.4)'; g.fillRect(P, y, W - 2 * P, 2); y += 40; };
  if (o.dados) { sec('Dados'); dados.forEach(([k, v]) => { F(26, 600); g.fillStyle = '#8a9bb8'; g.fillText(k, P, y); F(28); g.fillStyle = '#e6ecf5'; wrap(v, P + 220, W - 2 * P - 220, 38); y += 4; }); }
  if (o.docf && a.docFoto) { const du = await imgDataURL(a.docFoto.id); if (du) { sec('Documento'); const im = await new Promise(r => { const x = new Image(); x.onload = () => r(x); x.src = du; }); let w = W - 2 * P, h = w * im.height / im.width; if (h > 600) { h = 600; w = h * im.width / im.height; } g.drawImage(im, P, y, w, h); y += h + 36; } }
  if (o.fotos && a.fotos?.length) { sec('Fotos'); const cols = 2, gw = (W - 2 * P - 20) / cols; let i = 0;
    for (const f of fotosCapaPrimeiro(a).slice(0, 8)) { const du = await imgDataURL(dispId(f)); const im = await new Promise(r => { const x = new Image(); x.onload = () => r(x); x.src = du; });
      const x = P + (i % cols) * (gw + 20), h = gw * .75; const r = Math.max(gw / im.width, h / im.height); const sw = gw / r, sh = h / r;
      g.save(); g.beginPath(); g.roundRect ? g.roundRect(x, y, gw, h, 18) : g.rect(x, y, gw, h); g.clip(); g.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, x, y, gw, h); g.restore();
      F(20); g.fillStyle = '#aab6c9'; g.fillText(`${a.capa === f.id ? '⭐ ' : ''}${fmt(f.ts)}${isAlbum(f) ? ' (álbum)' : ''}${f.lat ? ' · ' + coord(f) : ''}`.slice(0, 50), x, y + h + 28);
      if (i % cols === cols - 1 || i === Math.min(a.fotos.length, 8) - 1) y += h + 56; i++; } }
  if (o.locais && locais.length) { sec('Locais'); locais.forEach(l => { F(28, 600); g.fillStyle = '#e6ecf5'; wrap(l.t, P, W - 2 * P, 36); F(24); g.fillStyle = '#7fa4e6'; g.fillText(`📍 ${l.c}  ·  ${fmt(l.ts)}`, P, y); y += 36; if (l.n) { g.fillStyle = '#aab6c9'; wrap(l.n, P, W - 2 * P, 32); } y += 8; }); }
  if (o.notas && a.notas?.length) { sec('Anotações'); a.notas.slice().sort((x, z) => x.ts - z.ts).forEach(n => { F(22); g.fillStyle = '#8a9bb8'; g.fillText(fmt(n.ts), P, y); y += 32; F(26); g.fillStyle = '#e6ecf5'; wrap(n.txt, P, W - 2 * P, 34); y += 10; }); }
  y += 30; F(22); g.fillStyle = '#6f84a8'; g.fillText(`${APP_NAME} · ${CREDIT}`, P, y); y += 40;
  const H = Math.min(y, 4000); const out = document.createElement('canvas'); out.width = W; out.height = H; const og = out.getContext('2d'); og.drawImage(c, 0, 0);
  if (o.marca) { og.save(); og.translate(W / 2, H / 2); og.rotate(-Math.PI / 6); og.font = '700 150px sans-serif'; og.fillStyle = 'rgba(255,60,60,.09)'; og.textAlign = 'center'; og.fillText('RESERVADO', 0, 0); og.restore(); }
  const blob = await new Promise(r => out.toBlob(r, 'image/jpeg', .9));
  return new File([blob], `OpsVault_${slug(a.nome)}_${fileStamp()}.jpg`, {type: 'image/jpeg'});
}
async function shareFile(file) {
  hold(120000);
  try {
    if (navigator.canShare && navigator.canShare({files: [file]})) { await navigator.share({files: [file], title: file.name}); toast('Enviado ✔'); }
    else { const u = URL.createObjectURL(file); const l = document.createElement('a'); l.href = u; l.download = file.name; document.body.appendChild(l); l.click(); l.remove(); setTimeout(() => URL.revokeObjectURL(u), 5000); toast('Arquivo baixado: ' + file.name); }
    return true;
  } catch (e) { if (e.name !== 'AbortError') throw e; return false; } finally { release(); }
}

/* ---------- Cofre (backup, segurança) ---------- */
async function viewCofre() {
  tabs('cofre');
  const bioOk = await bioSupported(), bio = bioOk ? await DB.get('bio') : null;
  const nf = S.alvos.reduce((s, a) => s + (a.fotos?.length || 0), 0);
  APP.innerHTML = `<h1>Cofre</h1><div class="sub" style="margin:4px 4px 0">${S.ops.length} operação(ões) · ${S.alvos.length} alvo(s) · ${nf} foto(s) — tudo criptografado (AES-256) só neste aparelho</div>
  <h2>Segurança</h2><div class="card glass" style="padding:0;cursor:default">
    <div class="tgrow"><div>Travar automaticamente<div class="sub">após inatividade</div></div><select id="idle" style="width:auto;padding:8px 10px">${[1, 2, 3, 5, 10, 15].map(m => `<option value="${m}" ${idleMin() === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></div>
    <div class="tgrow" id="chpin" style="cursor:pointer"><div>Trocar PIN</div><span class="sub">›</span></div>
    <div class="tgrow" onclick="lock('manual')" style="cursor:pointer"><div>Travar agora</div><span>🔒</span></div></div>
  <h2>Backup</h2><div class="card glass" style="padding:0;cursor:default">
    <div class="tgrow" id="bk" style="cursor:pointer"><div>Exportar backup criptografado<div class="sub">arquivo .cofre — só abre com o PIN atual<br>${S.cfg.lastBackup ? 'Último backup: ' + fmt(S.cfg.lastBackup) : 'Nenhum backup registrado'}</div></div><span>⬆️</span></div>
    <div class="tgrow"><div>Lembrete de backup<div class="sub">aviso na tela inicial quando atrasar</div></div><select id="bkd" style="width:auto;padding:8px 10px">${[[0, 'Desligado'], [1, 'Todo dia'], [3, 'A cada 3 dias'], [7, 'A cada 7 dias'], [14, 'A cada 14 dias'], [30, 'A cada 30 dias']].map(([v, l]) => `<option value="${v}" ${(+S.cfg.bkDays || 0) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
    <div class="tgrow" id="rs" style="cursor:pointer"><div>Restaurar backup<div class="sub">substitui os dados deste aparelho</div></div><span>⬇️</span></div></div>
  <h2>Importar e exportar</h2><div class="card glass" style="padding:0;cursor:default">
    <div class="tgrow" id="pl_all" style="cursor:pointer"><div>Exportar planilha<div class="sub">todas as operações — texto com | (reimportável) ou CSV</div></div><span>📊</span></div>
    <div class="tgrow" id="imp_lote" style="cursor:pointer"><div>Importar em lote<div class="sub">colar lista ou arquivo .txt/.csv (campos separados por |)</div></div><span>⬆️</span></div>
    <div class="tgrow" id="imp_ex" style="cursor:pointer"><div>Extrair alvos de texto/documento<div class="sub">BO, relatório, WhatsApp, PDF ou Word — com conferência</div></div><span>🧾</span></div>
    <div class="tgrow" id="imp_docs" style="cursor:pointer"><div>Ler documentos em lote<div class="sub">várias fotos de RG/CNH, OCR no aparelho</div></div><span>🪪</span></div>
    <div class="tgrow" id="imp_fotos" style="cursor:pointer"><div>Fotos em lote pelo nome do arquivo<div class="sub">CPF, RG ou nome do alvo no nome da foto</div></div><span>🖼️</span></div>
    <div class="tgrow" id="imp_opv" style="cursor:pointer"><div>Importar operação<div class="sub">arquivo .opsvault vindo de outro aparelho — junta com os dados atuais</div></div><span>📦</span></div></div>
  <h2>Mapas offline</h2><div class="card glass" style="padding:0;cursor:default">
    <div class="tgrow" id="off_m" style="cursor:pointer"><div>Mapas guardados no aparelho<div class="sub">${S.offline.length} área(s) baixada(s) · servidor ${isOsm(tileUrl()) ? 'OpenStreetMap' : 'personalizado'}</div></div><span>🗺️</span></div></div>
  <h2>Privacidade e acesso</h2><div class="card glass" style="padding:0;cursor:default">
    <div class="tgrow"><div>Modo discreto<div class="sub">fotos borradas até tocar, título neutro, tela mais escura</div></div><div class="tg ${S.cfg.discreto ? 'on' : ''}" id="sw_disc"></div></div>
    <div class="tgrow"><div>Carimbo nas fotos (padrão)<div class="sub">data/hora, coordenadas, operação e alvo numa cópia carimbada</div></div><div class="tg ${S.cfg.carimbo ? 'on' : ''}" id="sw_stamp"></div></div>
    ${bioOk ? `<div class="tgrow" id="bio_row" style="cursor:pointer"><div>Face ID / biometria<div class="sub">${bio ? 'Ativada · ' + (bio.mode === 'prf' ? 'PRF' : 'conveniência') : 'Desativada'}</div></div><span class="sub">›</span></div>` : ''}
    <div class="tgrow" id="panic_row" style="cursor:pointer"><div>PIN de pânico<div class="sub">${S.cfg.panicMode ? 'Ativo' : 'Desativado'}</div></div><span class="sub">›</span></div></div>
  <h2>Zona de perigo</h2><div class="btn dan" id="wipe">Apagar tudo deste aparelho</div>
  <h2>Sobre</h2><div class="card glass" style="cursor:default"><div class="t">${esc(APP_NAME)}</div><div class="sub" style="margin-top:4px">Protótipo ${APP_VER} · dados só no aparelho, sem servidor<br>Cache offline: ${APP_CACHE}</div><div class="credit" style="text-align:left;margin-top:10px">Criado <b>${esc(CREDIT)}</b></div></div>`;
  $('#off_m').onclick = () => offlineManage();
  $('#sw_disc').onclick = () => toggleDisc();
  $('#sw_stamp').onclick = async e => { S.cfg.carimbo = !S.cfg.carimbo; await save(); e.target.classList.toggle('on', S.cfg.carimbo); toast(S.cfg.carimbo ? '🕓 Carimbo ligado por padrão' : 'Carimbo desligado por padrão'); };
  if ($('#bio_row')) $('#bio_row').onclick = () => bioSheet(bio);
  $('#panic_row').onclick = () => panicSheet();
  $('#imp_lote').onclick = () => importBatch(); $('#pl_all').onclick = () => planilhaUI();
  $('#bkd').onchange = async e => { S.cfg.bkDays = +e.target.value; delete S.cfg.bkSnooze; await save(); toast(S.cfg.bkDays ? `Lembrete de backup a cada ${S.cfg.bkDays} dia(s)` : 'Lembrete de backup desligado'); };
  $('#imp_opv').onclick = () => importOpUI();
  $('#imp_ex').onclick = () => extractUI(); $('#imp_docs').onclick = () => docBatchUI(); $('#imp_fotos').onclick = () => photoBatchUI();
  $('#idle').onchange = async e => { S.cfg.idle = +e.target.value; await save(); resetIdle(); toast('Trava automática: ' + S.cfg.idle + ' min'); };
  $('#bk').onclick = async () => { try { if (await doBackup()) route(); } catch (e) { console.error(e); toast('Erro: ' + e.message); } };
  $('#rs').onclick = () => { pickFile(null, async file => {
    try { const j = JSON.parse(await file.text()); if (j.app !== 'opsvault' || !j.meta || !j.data) throw new Error('arquivo inválido');
      if (!await confirmBox('Restaurar substitui TODOS os dados atuais. Depois, use o PIN do backup para abrir.', 'Restaurar', true)) return;
      if (DB.decoy) { // cofre falso: o backup vira o conteúdo do cofre falso (abre com o PIN do backup); o real fica intocado
        const meta = await DB.get('meta', DB.main); meta.p = {salt: j.meta.salt, check: j.meta.check};
        await DB.clear(DB.alt); await DB.set('meta', meta, DB.main); await DB.set('data', j.data, DB.alt);
        for (const [k, v] of Object.entries(j.imgs || {})) if (/^(img|aud):/.test(k)) await DB.set(k, v, DB.alt);
        return lock('backup restaurado');
      }
      const m = {salt: j.meta.salt, check: j.meta.check, v: 1}; if (j.meta.p) m.p = j.meta.p;
      await DB.clear(DB.main); await DB.clear(DB.alt); await DB.set('meta', m, DB.main); await DB.set('data', j.data, DB.main);
      for (const [k, v] of Object.entries(j.imgs || {})) if (/^(img|aud):/.test(k)) await DB.set(k, v, DB.main);
      lock('backup restaurado'); } catch (e) { toast('Erro: ' + e.message); } }); };
  $('#wipe').onclick = async () => { if (!await confirmBox('Apagar TODOS os dados? Não há como desfazer.', 'Apagar tudo', true)) return; if (!await confirmBox('Tem certeza absoluta?', 'Sim, apagar', true)) return;
    if (DB.decoy) { await DB.clear(DB.alt); localStorage.clear(); try { await caches.delete(TILE_CACHE); } catch (e) {} localStorage.setItem('ov_fr', '1'); } // só o falso some; a próxima tela pede “Crie seu PIN”
    else await wipeEverything();
    lock('dados apagados'); };
  $('#chpin').onclick = () => sheet(`<h2 style="margin-top:0">Trocar PIN</h2><label>PIN atual</label><input id="p0" type="password" inputmode="numeric"><label>Novo PIN (mín. 6 dígitos)</label><input id="p1" type="password" inputmode="numeric"><label>Confirmar novo PIN</label><input id="p2" type="password" inputmode="numeric"><div class="gap"></div><div class="btn pri" id="pok">Trocar e recriptografar</div>`, s => {
    s.querySelector('#pok').onclick = async () => {
      const [p0, p1, p2] = ['#p0', '#p1', '#p2'].map(x => s.querySelector(x).value);
      if (!/^\d{6,12}$/.test(p1)) return toast('Novo PIN: 6 a 12 dígitos'); if (p1 !== p2) return toast('Confirmação não confere');
      const meta = await DB.get('meta', DB.main); const ns = DB.decoy ? meta.p : meta, other = DB.decoy ? meta : meta.p;
      s.querySelector('#pok').textContent = 'Verificando…';
      try { await open_(await deriveKey(p0, unb64(ns.salt)), ns.check); } catch { s.querySelector('#pok').textContent = 'Trocar e recriptografar'; return toast('PIN atual incorreto'); }
      // o novo PIN não pode coincidir com o outro cofre (real ↔ pânico); mensagem genérica para não denunciar nada
      if (other) { let clash = false; try { await open_(await deriveKey(p1, unb64(other.salt)), other.check); clash = true; } catch (e) {} if (clash) { s.querySelector('#pok').textContent = 'Trocar e recriptografar'; return toast('PIN não aceito — escolha outro'); } }
      s.querySelector('#pok').textContent = 'Recriptografando…';
      const salt = crypto.getRandomValues(new Uint8Array(16)); const nk = await deriveKey(p1, salt);
      for (const k of (await DB.keys()).filter(k => k.startsWith('img:') || k.startsWith('aud:'))) await DB.set(k, await seal(nk, await open_(KEY, await DB.get(k))));
      if (DB.decoy) meta.p = {salt: b64(salt), check: await seal(nk, enc.encode(P_DECOY))};
      else { meta.salt = b64(salt); meta.check = await seal(nk, enc.encode('opsvault-ok')); meta.v = 1; }
      await DB.set('meta', meta, DB.main); await DB.del('bio'); KEY = nk; await save(); closeSheet(); toast('PIN trocado ✔');
    };
  });
}

/* ---------- Ajuda ---------- */
function viewAjuda() {
  tabs('ajuda');
  const H = [
    ['🚀 Primeiro acesso e PIN', `<ol><li>Na primeira abertura, crie um PIN de <b>6 a 12 dígitos</b> e confirme.</li><li>O PIN gera a chave que criptografa tudo (AES-256). Ele <b>não fica salvo</b> em lugar nenhum.</li><li><b>Esqueceu o PIN = dados perdidos.</b> Não existe recuperação. Faça backups.</li><li>Após 5 erros, o app bloqueia por um tempo crescente.</li></ol>`],
    ['📲 Instalar na tela inicial', `<ul><li><b>Android (Chrome):</b> menu ⋮ → <b>Adicionar à tela inicial</b> / <b>Instalar app</b>.</li><li><b>iPhone (Safari):</b> botão Compartilhar ⬆️ → <b>Adicionar à Tela de Início</b>.</li></ul>Depois disso, ele abre em tela cheia como um app comum e funciona sem internet (exceto o fundo do mapa).`],
    ['🗂️ Operações', `<ol><li>Na aba <b>Operações</b>, toque em <b>+</b>.</li><li>Dê um nome, escolha o status (Planejada, Em andamento, Encerrada) e descreva o objetivo.</li><li>Toque na operação para ver e adicionar alvos. Use <b>Editar</b> para mudar o status.</li></ol>`],
    ['👤 Alvos', `<ol><li>Dentro da operação, toque em <b>+</b>.</li><li>Preencha o que souber: nome, vulgo, documento, telefones (um por linha), veículo, endereço, vínculos e prioridade.</li><li>A ficha do alvo reúne dados, fotos, locais, anotações e linha do tempo.</li></ol>`],
    ['🪪 Situação, redes, mandados e documento', `<ul><li>No <b>Editar</b> do alvo: <b>situação</b> (preso, foragido, monitorado, solto ou outro — com descrição), <b>redes sociais</b> (uma por linha) e <b>mandados</b> (número, status e data; toque em <b>+ Mandado</b> para cada um).</li><li>A situação aparece como etiqueta colorida na lista da operação e na ficha.</li><li><b>🪪 Documento</b> (na ficha): fotografe ou escolha a imagem do RG/CNH. Ela fica <b>separada</b> das fotos do alvo — não entra na galeria nem vira capa — e também é criptografada.</li><li>Tudo isso entra na <b>Busca</b>, no PDF/imagem (a foto do documento só se você ligar a opção), na exportação de operação e no backup.</li></ul>`],
    ['🔗 Vínculos entre alvos', `<ol><li>Na ficha, toque em <b>Vincular</b>, escolha o outro alvo (de qualquer operação) e escreva a relação — ou toque numa sugestão (irmão, sócio, comparsa, cônjuge…).</li><li>O vínculo aparece <b>nos dois alvos</b>. Toque na relação ✏️ para editar ou remover.</li><li>Na operação, <b>🕸️ Vínculos</b> mostra o gráfico: cada bolinha é um alvo (cor = situação); tracejado = alvo de outra operação. Toque numa bolinha para abrir a ficha.</li></ol><p>O campo de texto livre “Vínculos” continua existindo para pessoas que não são alvos.</p>`],
    ['📊 Exportar planilha', `<ul><li>Na operação, <b>📊 Exportar planilha</b> (só ela) ou na aba <b>Cofre</b> → <b>Exportar planilha</b> (todas).</li><li><b>Texto com |</b>: exatamente o formato da importação em lote (<span class="kbd">operação|nome|vulgo|documento|telefones|veículo|endereço|vínculos|prioridade|lat|lng</span>). Pode ser importado de volta noutro aparelho.</li><li><b>CSV</b>: abre direto no Excel/Planilhas (separador ponto e vírgula) e traz também situação, redes, mandados, vínculos entre alvos, etiquetas, nascimento e filiação.</li></ul><div class="warn" style="margin-bottom:0">A planilha sai <b>sem criptografia</b> e sem máscara. Use só para migrar ou conferir dados.</div>`],
    ['📷 Fotos (câmera ou álbum)', `<p>Na ficha, toque em <b>Foto</b> e escolha:</p><ul><li><b>📷 Tirar foto</b> — a câmera abre e o GPS do aparelho é lido ao mesmo tempo. Na primeira vez, <b>permita câmera e localização</b>. A foto vai direto para o cofre e <b>não</b> é salva na galeria.</li><li><b>🖼️ Escolher do álbum</b> — selecione <b>uma ou várias</b> fotos já existentes. A <b>data original</b> e a <b>localização</b> são lidas da própria foto (EXIF); o GPS atual do aparelho <b>não</b> é usado. No fim, aparece um resumo (“N foto(s) adicionada(s), X com localização”) e você pode pôr uma legenda comum a todas.</li></ul><ul><li>Toda foto é guardada criptografada com um <b>código SHA-256</b>. Nas fotos do álbum, o código é do <b>arquivo original</b> (antes de reduzir), o que reforça a prova de integridade.</li><li>Toque numa miniatura para ver origem (Câmera/Álbum), data original × data de importação, local, ou para excluir.</li><li><b>⭐ Capa:</b> no visualizador, toque em <b>Usar como capa</b> para escolher a foto que aparece no topo da ficha e na lista da operação. Ela também vai <b>primeiro</b> no PDF/imagem exportados. Sem capa escolhida, vale a foto mais recente.</li></ul><div class="warn" style="margin-bottom:0">📍 <b>iPhone:</b> ao escolher fotos, o seletor tem o botão <b>Opções</b> no topo. Se <b>Localização</b> estiver desligada ali, o iPhone <b>remove o local</b> da foto antes de entregar ao app — ela entra “sem localização na foto”. Ligue antes de selecionar.</div>`],
    ['📍 Marcar locais', `<ol><li>Na ficha, toque em <b>Marcar local</b>.</li><li>Escolha o tipo (🏠 residência, 🏢 trabalho, 🚗 veículo, 🤝 ponto de encontro, 📍 outro), um título e uma observação.</li><li><b>Estou aqui</b> usa o GPS; <b>Escolher no mapa</b> deixa você tocar no ponto. Arraste o marcador para ajustar.</li></ol>`],
    ['🗺️ Mapa', `<ul><li>A aba <b>Mapa</b> mostra todos os pontos de todos os alvos, com cores por tipo.</li><li>Na ficha, o botão <b>Mapa</b> mostra só aquele alvo.</li><li>Toque num marcador para abrir a ficha (ou o diário, nos pontos 👁️ de vigilância) ou traçar <b>Rota</b> no Waze, Google Maps ou Apple Maps.</li><li>Trajetos gravados aparecem como linha azul (verde = início, vermelho = fim).</li><li>O fundo do mapa precisa de internet; os pontos ficam no aparelho.</li></ul>`],
    ['🔎 Busca no mapa', `<p>No topo do mapa (em <b>Marcar local</b> e na aba <b>Mapa</b>) há um campo de busca que aceita:</p><ul><li><b>Coordenadas:</b> <span class="kbd">-3.7319, -38.5267</span>, <span class="kbd">-3.7319 -38.5267</span> ou graus/minutos/segundos (ex.: <span class="kbd">3°43'54"S 38°31'36"W</span>).</li><li><b>Links do Google Maps:</b> cole a URL completa (com <span class="kbd">@lat,lng</span>, <span class="kbd">?q=lat,lng</span>, <span class="kbd">ll=</span> ou <span class="kbd">!3d..!4d..</span>). Links curtos <span class="kbd">maps.app.goo.gl</span> não podem ser resolvidos no aparelho — abra no navegador e copie o link completo ou as coordenadas.</li><li><b>Endereços:</b> digite o endereço e toque em <b>Ir</b>. A busca mostra até 5 resultados; toque num para posicionar o marcador e centralizar o mapa.</li></ul><div class="warn" style="margin-bottom:0">Só o <b>termo pesquisado</b> é enviado ao OpenStreetMap (serviço Nominatim). Os dados do alvo <b>não</b> saem do aparelho.</div>`],
    ['⬆️ Importar em lote', `<p>Cadastre vários alvos de uma vez. Na aba <b>Cofre</b> → <b>Importar em lote</b>, ou dentro de uma operação em <b>Importar alvos em lote</b> (já preenche aquela operação).</p><p>Um alvo por linha, campos separados por <b>|</b> (barra vertical):</p><div class="kbd" style="display:block;white-space:normal;word-break:break-all;padding:8px 10px;margin:6px 0">operação|nome|vulgo|documento|telefones|veículo|endereço|vínculos|prioridade|lat|lng</div><p><b>Exemplo:</b></p><div class="kbd" style="display:block;white-space:normal;word-break:break-all;padding:8px 10px;margin:6px 0">Operação Aurora|João da Silva|Jota|00000000000|(85) 90000-0000;(85) 90000-0001|Gol prata ABC1D23|Rua Exemplo, 100|Maria (irmã)|alta|-3.7319|-38.5267</div><ul><li><b>Telefones</b> separados por <span class="kbd">;</span> (ponto e vírgula).</li><li><b>Prioridade</b>: alta / média / baixa (padrão média).</li><li><b>lat/lng</b> são opcionais; quando presentes, criam um local 🏠 “Endereço importado”.</li><li>Linhas em branco e que começam com <span class="kbd">#</span> são ignoradas; um cabeçalho iniciado por <span class="kbd">operação|</span> é pulado.</li><li>Pode <b>colar</b> a lista ou carregar um arquivo <b>.txt/.csv</b>. Use <b>Baixar modelo</b> para um exemplo pronto.</li><li>Antes de salvar há uma <b>pré-visualização</b>: válidos, erros (com número da linha), os que <b>já existem</b> (mesma operação e mesmo documento ou nome — ignorados, a menos que você ative “Importar mesmo assim”) e as novas operações a criar. Reimportar a própria planilha exportada não duplica nada.</li></ul>`],
    ['🧭 Filtros, calor e áreas no mapa', `<ul><li><b>⚙️ Filtros</b>: por operação, alvo, tipo de local (inclui 👁️ Vigilância), período (datas) e a chave <b>Mostrar trajetos gravados</b>. Valem até o cofre travar; <b>✕ limpar</b> tira todos.</li><li><b>🔥 Calor</b>: troca os marcadores por uma mancha de concentração — quanto mais pontos no mesmo lugar, mais quente (azul → vermelho).</li><li><b>⬡ Áreas</b>: <b>Novo raio</b> (toque o centro, ajuste os metros na barra ou digitando, arraste para mover) ou <b>Novo polígono</b> (toque os vértices, <b>↶ Desfazer</b> tira o último, <b>Concluir</b> com 3 ou mais). Dê nome, cor e, se quiser, uma operação. Toque na área para editar, ajustar a forma ou excluir.</li><li>As áreas ficam criptografadas, entram no backup e, quando ligadas a uma operação, vão junto na exportação da operação.</li></ul>`],
    ['🗺️ Mapa offline', `<ul><li><b>Automático:</b> os blocos do mapa que você <b>visualiza</b> ficam guardados no aparelho (até ~3.000, renovados após 7 dias) e aparecem sem internet. Antes de ir a campo, passeie pela região no zoom que vai usar.</li><li><b>⬇️ Baixar área:</b> baixa a tela atual do zoom atual até +3 (máx. ${TILE_CAP} blocos; se passar, o zoom máximo é reduzido), com barra de progresso e poucos downloads simultâneos.</li><li>Gerencie em <b>Cofre → Mapas offline</b>: lista com tamanho estimado, ver no mapa, apagar uma área ou tudo.</li></ul><div class="warn" style="margin-bottom:0">⚠️ <b>Política do OpenStreetMap:</b> os servidores do OSM são mantidos por doações e <b>proíbem pré-download / “baixar para offline”</b> — quem faz isso pode ser bloqueado sem aviso. Por isso, com o servidor padrão, o botão <b>Baixar área</b> fica desativado e vale só a guarda do que você vê (uso normal e ocasional). Para baixar áreas, configure em <b>Cofre → Mapas offline → Servidor de mapas</b> um servidor próprio ou um provedor que permita uso offline. Os blocos guardados <b>não</b> são criptografados (são só imagens do mapa, mas revelam qual região foi vista).</div>`],
    ['👁️ Diário de vigilância', `<ol><li>Na operação, card <b>👁️ Vigilância</b> → <b>▶ Nova sessão</b> (ou, na ficha do alvo, <b>👁️ Vigiar</b>). Escolha o alvo vigiado (opcional — dá para escrever uma pessoa não cadastrada) e um título/local.</li><li>Na tela da sessão, botões grandes: <b>🟢 Chegou</b> e <b>🔴 Saiu</b> registram com <b>um toque</b>; <b>🤝 Encontrou com…</b> (escolha um alvo da operação ou escreva quem), <b>🚗 Veículo</b> (placa — com <b>📷 Ler placa</b> no aparelho — e modelo/cor) e <b>🗒️ Observação</b> (com 🎤 ditado).</li><li>Cada registro guarda a <b>hora do toque</b> e o <b>GPS</b>, se disponível (com trajeto em gravação, usa a posição dele na hora). Toque num registro para corrigir hora, texto, tipo, remover o GPS ou excluir.</li><li><b>⏹ Encerrar sessão</b> fecha (pode reabrir). <b>📒 Diário</b> lista todas as sessões e trajetos da operação.</li></ol><ul><li>Os registros aparecem na <b>linha do tempo da operação</b> e do alvo, no <b>mapa</b> (pino 👁️, respeitando os filtros), no <b>relatório PDF</b> (seção “Diário de vigilância”), na exportação <span class="kbd">.opsvault</span> e no backup — sempre criptografados no aparelho.</li></ul>`],
    ['🧭 Rota (Waze, Google Maps, Apple Maps)', `<ul><li>Na ficha de um alvo com locais marcados, toque em <b>🧭 Rota</b> e escolha o destino e o app: <b>Waze</b>, <b>Google Maps</b> ou, no iPhone, <b>Apple Maps</b>. Também há <b>Rota</b> no balão de cada ponto do mapa e nos registros do diário com GPS.</li><li>Se o app não estiver instalado, abre a versão web.</li></ul><div class="warn" style="margin-bottom:0">🔐 Só as <b>coordenadas do destino</b> são enviadas ao app escolhido e podem ficar no histórico da conta dele (Google/Apple/Waze). Nome do alvo e demais dados não saem do cofre. Ao trocar para o app de navegação, o cofre trava.</div>`],
    ['📏 Medir distância', `<ol><li>Na aba <b>Mapa</b>, toque em <b>📏 Medir</b>.</li><li>Toque no mapa para marcar os pontos: cada trecho mostra a distância e a barra mostra o <b>total</b> (m ou km).</li><li><b>↶ Desfazer</b> tira o último ponto, <b>Limpar</b> recomeça e <b>Fechar</b> sai da régua. Nada é salvo.</li></ol><p>A distância é em linha reta sobre a superfície da Terra (não segue ruas).</p>`],
    ['🛰️ Trajeto gravado', `<ol><li>Na operação (card Vigilância), no Diário ou dentro de uma sessão, toque em <b>🛰️ Gravar trajeto</b>. Pode ligar o trajeto a uma sessão de vigilância.</li><li>Enquanto grava, uma pílula 🛰️ no topo mostra distância e tempo; toque nela para <b>parar e salvar</b>.</li><li>Leituras com precisão pior que 50 m são descartadas; passos muito curtos (ruído parado) são ignorados.</li><li>O trajeto fica <b>criptografado</b> na operação: pontos com horário, distância e duração. Aparece no mapa (filtro <b>Mostrar trajetos gravados</b>), no Diário (🗺️ abre no mapa, 🗑️ exclui), no resumo e no diário do relatório PDF, no <span class="kbd">.opsvault</span> e no backup.</li></ol><div class="warn" style="margin-bottom:0">📵 <b>iPhone:</b> o iOS <b>para o GPS quando a tela bloqueia</b> ou o app vai para segundo plano — e o cofre trava ao sair da tela, encerrando a gravação (o que foi gravado fica salvo). Mantenha o app aberto e a tela ligada. Onde o navegador permite (Wake Lock), o app pede para a tela não apagar; senão, ajuste o <b>Bloqueio Automático</b> do aparelho. Gasta mais bateria.</div>`],
    ['🗒️ Anotações e linha do tempo', `<ul><li><b>Anotar</b> registra observações com data e hora automáticas.</li><li>A <b>linha do tempo</b> junta tudo em ordem: cadastro, edições, fotos, locais, notas e registros de vigilância.</li><li>Na operação, <b>🕓 Linha do tempo da operação</b> (no fim da tela) reúne os eventos de todos os alvos, do diário de vigilância e dos trajetos.</li></ul>`],
    ['🔍 Busca', `Na aba <b>Busca</b>, digite parte de nome, vulgo, placa, telefone, endereço, rede social, número de mandado, situação, relação de vínculo ou texto de anotação. Números são comparados ignorando pontos e traços. Toque em <b>🔀 Cruzamentos</b> para ver telefones e placas repetidos entre alvos.`],
    ['🔀 Cruzamentos de telefones e placas', `<p>O app compara sozinho os <b>telefones</b> e as <b>placas</b> de todos os alvos (campo Veículo) e dos registros 🚗 do <b>diário de vigilância</b>, e avisa quando o mesmo número ou placa aparece em <b>alvos diferentes</b> — na mesma operação ou em outra.</p><ul><li><b>Telefones:</b> só os dígitos contam. O app tira <b>+55</b>, o <b>0</b> e o <b>código de operadora</b> (ex.: <span class="kbd">0 21 85 …</span>) e compara os <b>8 últimos dígitos</b> + o <b>DDD</b> quando os dois têm DDD. Com ou sem o <b>9</b> da frente é o mesmo número. Números 0800/4004 são ignorados.</li><li><b>Placas:</b> maiúsculas, sem traço. A placa antiga <span class="kbd">ABC-1234</span> e a Mercosul equivalente <span class="kbd">ABC1C34</span> contam como a mesma.</li><li><b>Na ficha do alvo</b>, um aviso âmbar mostra, por exemplo, “Telefone também aparece em: Fulano (Op X)”. Toque para abrir a outra ficha (ou a sessão do diário).</li><li><b>Tela Cruzamentos</b> (botão <b>🔀</b> no topo de Operações ou na <b>Busca</b>): todos os casos agrupados por telefone/placa, com filtro e a chave <b>Incluir operações arquivadas</b>.</li><li>O <b>relatório PDF</b> da operação traz a seção <b>Cruzamentos</b> com os casos que envolvem aquela operação.</li><li>No <b>cofre falso</b>, só os dados dele são comparados. No <b>modo discreto</b>, números e placas aparecem mascarados na tela.</li></ul><div class="warn" style="margin-bottom:0">Coincidência não prova vínculo (linha reaproveitada, carro vendido, erro de digitação). Confirme antes de usar.</div>`],
    ['📤 Exportar e mandar no WhatsApp', `<ol><li>Na ficha, toque em <b>Exportar / compartilhar</b>.</li><li>Escolha <b>PDF</b> (relatório com fotos, coordenadas e links de mapa) ou <b>Imagem</b> (um card para visualizar rápido).</li><li>Marque o conteúdo e as proteções: mascarar telefone/documento, marca d’água “RESERVADO” e senha no PDF.</li><li>Toque em <b>Gerar e compartilhar</b> e escolha o <b>WhatsApp</b> (ou outro app) na lista do celular.</li></ol><div class="warn" style="margin-bottom:0">O arquivo enviado sai do cofre. Mande a senha do PDF por outro canal. A senha do PDF é uma proteção básica, não substitui o cofre.</div>`],
    ['⚡ Registro rápido e Rascunhos', `<p>Para registrar em campo sem procurar o alvo: com o cofre aberto, o botão flutuante no canto inferior esquerdo fica sempre à mão.</p><ul><li><b>📷</b> — <b>um toque</b> abre a câmera; a foto é salva com o GPS do momento, criptografada, em <b>Rascunhos</b>.</li><li><b>⚡</b> — menu com <b>Foto</b>, <b>Nota</b>, <b>Áudio</b> e <b>Local</b> (já pega o GPS), e a escolha do <b>destino</b>: uma operação ou a <b>Caixa geral</b>. O número vermelho mostra quantos rascunhos esperam atribuição.</li><li>Dentro de uma operação ou da ficha de um alvo, os rascunhos vão para aquela operação. Fora delas, vão para o destino escolhido no menu ⚡.</li><li>Em <b>📥 Rascunhos</b> (card na tela inicial ou na operação), toque em <b>Atribuir a alvo</b>, ou marque vários ☐ e use <b>Atribuir selecionados</b>. A foto, o áudio, o local ou a nota passam para o alvo, com a data e o GPS originais. Com o carimbo ligado, a foto ganha a cópia carimbada nessa hora.</li><li>Se uma operação for excluída, seus rascunhos vão para a Caixa geral. Rascunhos entram no backup e na exportação da operação.</li></ul>`],
    ['📲 Atalhos na tela inicial', `<ul><li><b>Android (Chrome):</b> com o app instalado, <b>toque e segure o ícone</b>: aparecem <b>Nova foto</b>, <b>Marcar local</b>, <b>Gravar áudio</b> e <b>Registro rápido</b>. Depois do PIN, o app vai direto para a ação.</li><li><b>iPhone:</b> o iOS não mostra atalhos no ícone. Use o app <b>Atalhos</b>: <b>+</b> → <b>Adicionar Ação</b> → <b>Abrir URLs</b> e cole um dos endereços abaixo; depois, no atalho, <b>Compartilhar → Adicionar à Tela de Início</b> (ou use pelo widget/Siri).</li></ul><div class="kbd" style="display:block;white-space:normal;word-break:break-all;padding:8px 10px;margin:6px 0;line-height:1.7">${esc(location.origin + location.pathname)}#acao/foto<br>${esc(location.origin + location.pathname)}#acao/local<br>${esc(location.origin + location.pathname)}#acao/audio<br>${esc(location.origin + location.pathname)}#acao/rapido</div><ul><li>O atalho abre o app; depois do PIN, a ação é executada. Para a câmera, toque em <b>📷 Abrir câmera agora</b> (o iPhone exige um toque para abrir a câmera).</li><li>No iPhone, o atalho abre o <b>Safari</b>; os dados do app instalado na Tela de Início ficam separados dos do Safari. Use o atalho no mesmo lugar onde você usa o cofre.</li></ul>`],
    ['🏷️ Etiquetas', `<ul><li>No <b>Editar</b> do alvo, campo <b>Etiquetas</b>: digite e toque <b>Enter</b> (ou vírgula). As etiquetas já usadas aparecem como sugestão (+). Toque no ✕ para remover.</li><li>Na operação, toque numa etiqueta acima da lista para <b>filtrar os alvos</b>. Na ficha, tocar numa etiqueta abre a <b>Busca</b> já filtrada.</li><li>Na <b>Busca</b>, toque nas etiquetas para filtrar (o texto digitado também procura nas etiquetas).</li><li>Entram no PDF/imagem do alvo, no relatório da operação, no CSV (coluna “etiquetas”), no backup e na exportação da operação. A planilha com <b>|</b> não muda, para continuar compatível com a importação.</li></ul>`],
    ['✅ Pendências', `<ul><li>Na ficha do alvo, <b>＋ Pendência</b>: o que precisa ser feito e um <b>prazo</b> opcional. Toque em ☐ para concluir (☑) e no texto para editar ou excluir.</li><li>Prazo vencido = <b>atrasada</b> (vermelho); vence hoje = âmbar.</li><li>O botão <b>✅</b> no topo da tela inicial abre <b>Pendências</b> de todas as operações, por prazo, com filtros Abertas / Atrasadas / Concluídas / Todas. O número vermelho no botão e o aviso na tela inicial mostram as atrasadas.</li><li>As pendências entram no relatório PDF da operação (com situação e prazo) e na linha do tempo do alvo.</li></ul>`],
    ['📑 Duplicar e 🗄️ Arquivar operação', `<ul><li><b>Duplicar como modelo</b> (na operação): cria uma operação nova “(cópia)”, com status Planejada. Você escolhe se copia os <b>alvos</b> (dados, etiquetas e mandados — <b>sem</b> fotos, áudios, documento e anotações), os locais, as pendências (reabertas), os vínculos entre eles e as áreas do mapa.</li><li><b>Arquivar</b>: tira a operação da lista principal, sem apagar nada. Ela fica em <b>🗄️ Arquivadas</b> no fim da tela inicial; abra e toque em <b>Desarquivar</b> para voltar.</li><li>Na Busca e em Pendências, operações arquivadas ficam de fora, a menos que você ligue <b>Incluir operações arquivadas</b>.</li></ul>`],
    ['📄 Relatório PDF da operação', `<ol><li>Abra a operação e toque em <b>📄 Relatório PDF</b>.</li><li>Escolha: <b>mascarar documentos</b>, <b>incluir fotos</b> e, se incluir, <b>cópia carimbada</b> (quando houver) ou <b>original</b>.</li><li>Toque em <b>Gerar e compartilhar</b> e escolha o app (WhatsApp, e-mail…) ou salve o arquivo.</li></ol><p>O relatório traz: <b>capa</b> (nome, data de geração, RESERVADO), <b>resumo executivo</b> (alvos por situação, locais, áreas, fotos, áudios, vínculos e período coberto pelos dados), <b>quadro de envolvidos</b> (nome com nascimento e filiação, vulgo, documento, situação, prioridade, mandados), <b>vínculos</b> com o gráfico, <b>cruzamentos</b> de telefone/placa com outros alvos, <b>linha do tempo</b> (cadastros, fotos, locais, áudios, anotações, mandados com data, vigilância e trajetos), <b>diário de vigilância</b> (sessões, registros com hora e GPS, trajetos com distância e duração), <b>locais e áreas</b> com coordenadas, <b>fotos</b> (capa primeiro, com data, GPS e SHA-256 original/carimbada) e a <b>lista de áudios</b> (data, duração, SHA-256 — sem o som).</p><ul><li>Só entra o que está cadastrado; campo vazio aparece como “—”. Nada é preenchido automaticamente.</li><li>Todas as páginas têm marca d’água <b>RESERVADO</b>, rodapé com crédito, código de controle e número de página.</li><li>No <b>modo discreto</b>, o arquivo recebe um nome neutro (<span class="kbd">Notas_…pdf</span>).</li></ul><div class="warn" style="margin-bottom:0">O PDF sai do cofre <b>sem criptografia</b>. Compartilhe só com quem precisa.</div>`],
    ['💾 Backup e restauração', `<ol><li>Aba <b>Cofre</b> → <b>Exportar backup criptografado</b> gera um arquivo <span class="kbd">.cofre</span>.</li><li>Ele continua criptografado e só abre com o PIN que estava em uso na hora do backup.</li><li>Para trocar de celular: instale o app no novo aparelho, crie qualquer PIN, vá em <b>Restaurar backup</b> e depois abra com o PIN antigo.</li><li><b>Lembrete:</b> em <b>Cofre → Lembrete de backup</b> escolha a cada quantos dias (padrão 7). Quando passar do prazo, aparece um aviso na tela inicial com <b>Fazer backup agora</b>.</li></ol>`],
    ['📦 Passar uma operação para outro aparelho', `<p>Serve para mandar <b>uma operação</b> (com seus alvos, fotos, locais e anotações) para o celular de um colega ou para outro aparelho seu.</p><ol><li>Abra a operação e toque em <b>📦 Exportar operação (outro aparelho)</b>.</li><li>Crie uma <b>senha de transferência</b> (mínimo 6 caracteres) e confirme. Ela é só para este arquivo — não é o seu PIN.</li><li>Envie o arquivo <span class="kbd">.opsvault</span> (WhatsApp, e-mail, cabo…). <b>Mande a senha por outro canal</b> (ligação, pessoalmente, outro app).</li><li>No outro aparelho: aba <b>Cofre</b> → <b>Importar operação</b>, escolha o arquivo e digite a senha de transferência.</li><li>Confira a pré-visualização (operação, nº de alvos e fotos) e toque em <b>Importar</b>.</li></ol><ul><li>A operação é <b>somada</b> ao que já existe; nada do aparelho é apagado.</li><li>Se a mesma operação já existir, escolha <b>Substituir a existente</b> (apaga a antiga, seus alvos e fotos, e põe a recebida no lugar) ou <b>Importar como cópia</b> (fica com as duas; a nova recebe “(cópia)” no nome).</li><li>As fotos são recriptografadas com o PIN do aparelho que recebeu. Cada alvo ganha o registro “Importado de outro aparelho” na linha do tempo.</li></ul><p><b>Diferença para o backup completo:</b> o backup <span class="kbd">.cofre</span> leva <b>o cofre inteiro</b>, só abre com o <b>PIN do backup</b> e, ao restaurar, <b>substitui tudo</b> o que está no aparelho. A exportação de operação leva <b>só uma operação</b>, abre com a <b>senha de transferência</b> e <b>junta</b> com os dados existentes.</p><div class="warn" style="margin-bottom:0">O arquivo .opsvault é criptografado (AES-256) com a senha de transferência. Quem tiver o arquivo <b>e</b> a senha vê tudo da operação — por isso nunca mande os dois juntos.</div>`],
    ['🕓 Carimbo na foto', `<ul><li>Ligue em <b>Cofre → Privacidade e acesso → Carimbo nas fotos</b> (padrão desligado) ou na hora, na chave <b>🕓 Carimbo na foto</b> do menu <b>Foto</b>.</li><li>O app guarda a <b>foto original intacta</b> e cria uma <b>cópia carimbada</b> com uma faixa embaixo: data/hora, coordenadas (ou “sem GPS”), operação e alvo.</li><li>Fotos do álbum usam a <b>data e o GPS da própria foto (EXIF)</b>; sem data no arquivo, o carimbo avisa.</li><li>No visualizador, alterne <b>Carimbada / Original</b>. Os dois códigos aparecem rotulados: <b>SHA-256 original</b> e <b>SHA-256 carimbada</b>. O PDF/imagem usa a cópia carimbada e lista os dois códigos.</li></ul>`],
    ['🎙️ Anotação em áudio', `<ol><li>Na ficha do alvo, toque em <b>🎙️ Áudio</b> (ou, na operação, <b>Gravar áudio da operação</b>). Permita o microfone na primeira vez.</li><li>Escolha se o áudio fica no <b>alvo</b> ou na <b>operação</b>, dê um título opcional e toque em <b>Gravar</b>. O cronômetro mostra o tempo; <b>Parar e salvar</b> encerra. Limite de <b>10 minutos</b> (para sozinho).</li><li>Na lista: ▶/⏸ para tocar/pausar, 🗑️ para apagar (pede confirmação).</li></ol><ul><li>O áudio é criptografado como as fotos e entra no backup e na exportação de operação. No PDF vai só a <b>lista</b> (data, duração e SHA-256), não o som.</li><li>Gravação e reprodução param ao travar o cofre ou trocar de tela.</li><li>iPhone grava em <span class="kbd">audio/mp4</span>; Android/Chrome em <span class="kbd">webm/opus</span>. Um áudio gravado num tipo pode não tocar no outro aparelho.</li></ul>`],
    ['🕶️ Modo discreto', `<ul><li>Ligue no botão <b>🕶️</b> no topo de Operações ou em <b>Cofre → Privacidade e acesso</b>. Fica salvo.</li><li>Fotos e miniaturas ficam <b>borradas</b>: o 1º toque revela, o 2º abre. O título da aba vira <b>“Notas”</b>, a tela fica mais escura e a tela de bloqueio fica neutra.</li></ul>`],
    ['🚨 PIN de pânico', `<ul><li>Configure em <b>Cofre → PIN de pânico</b>: 6 a 12 dígitos, diferente do PIN real.</li><li><b>Padrão:</b> digitado na tela de bloqueio, abre um <b>cofre falso</b> vazio que funciona normalmente (pode cadastrar, fazer backup, trocar PIN, apagar). Nada do que se faz nele toca no cofre real nem o revela.</li><li><b>Modo “Apagar tudo ao usar”:</b> apaga na hora todos os dados reais e abre um cofre novo e vazio. Irreversível — só um backup .cofre recupera.</li><li>A tela de bloqueio é a mesma e o tempo de resposta é parecido para PIN real, de pânico ou errado; os erros contam no mesmo bloqueio.</li><li>No cofre falso, “Apagar tudo” volta à tela “Crie seu PIN”; o PIN real continua abrindo o cofre real.</li></ul>`],
    ['🙂 Face ID / biometria', `<ul><li>Aparece em <b>Cofre → Privacidade e acesso</b> só se o aparelho tiver Face ID/digital disponível para sites (iPhone instalado na Tela de Início, Android com bloqueio de tela).</li><li>Para ativar, confirme o PIN; o aparelho cria uma credencial protegida por biometria. Na tela de bloqueio surge <b>Face ID / biometria</b>.</li><li>Quando o aparelho suporta a extensão <b>PRF</b>, a chave do cofre fica embrulhada por um segredo que só sai após a biometria.</li><li>Sem PRF, funciona como <b>“porta” de conveniência</b>: a chave fica guardada pelo aparelho. Quem copiar o armazenamento do aparelho poderia abrir sem o PIN.</li><li><b>O PIN é sempre a chave-mestra.</b> Trocar o PIN desativa a biometria. A biometria ativada no cofre falso abre só o falso; a do real abre só o real.</li></ul>`],
    ['🎤 Ditado por voz', `<ul><li>Nos campos de texto de anotação e observação (Anotar, Nota rápida, observação do local, descrição da operação, pendência, vínculos e filiação) aparece um <b>🎤</b> no canto. Toque, fale e o texto é <b>acrescentado ao final</b> do que já está escrito. Toque de novo para parar.</li><li>Confira o texto antes de salvar — nomes e números costumam sair errados.</li><li>O botão só aparece se o navegador tiver reconhecimento de fala. Na primeira vez, permita o microfone.</li></ul><div class="warn" style="margin-bottom:0">🔐 <b>Privacidade:</b> o reconhecimento de fala é feito pelo sistema/navegador e <b>pode ser processado em servidores externos</b> — no iPhone, pela <b>Apple</b>; no Android/Chrome, pelo <b>Google</b>. O áudio não passa pelo cofre, mas sai do aparelho. Para conteúdo sensível, digite. Alternativa: o <b>🎤 do próprio teclado</b> do iPhone (que, conforme o modelo e o idioma, também pode usar os servidores da Apple).</div>`],
    ['🔎 Ler documento e placa (OCR)', `<p>A leitura é feita <b>no próprio aparelho</b> (tesseract, português). A imagem <b>não é enviada</b> para nenhum servidor. Na 1ª leitura, o leitor (~6 MB) é carregado do endereço do app e fica guardado para uso sem internet.</p><ol><li><b>🪪 Ler documento</b> (no topo de <b>Novo alvo</b> / <b>Editar</b>): fotografe ou escolha a imagem do <b>RG ou CNH</b>. O app procura <b>nome, CPF</b> (com conferência dos dígitos verificadores), <b>RG</b>, <b>data de nascimento</b> e <b>filiação</b>.</li><li>Abre a tela <b>Conferir leitura</b>: corrija o que precisar e marque só os campos que quer usar. <b>Preencher campos</b> copia para o formulário — <b>nada é salvo</b> até você tocar em <b>Salvar alvo</b>.</li><li>Com <b>Guardar esta imagem como foto do documento</b> ligado, a imagem vira a 🪪 foto do documento do alvo (criptografada, fora da galeria) ao salvar.</li><li><b>🚗 Ler placa</b> (ao lado de Veículo): escolha a foto, <b>arraste um retângulo</b> bem justo em volta da placa e toque em <b>Ler placa</b>. Aceita o modelo antigo (<span class="kbd">ABC-1234</span>) e o Mercosul (<span class="kbd">ABC1D23</span>), corrigindo trocas comuns pela posição (O/0, I/1, B/8, S/5, Z/2). Confirme e a placa vai para o campo Veículo.</li></ol><div class="warn" style="margin-bottom:0">A <b>precisão varia</b>: documento plano, boa luz, sem reflexo do plástico, foto de frente e só o documento no quadro ajudam muito. CNH digital (tela) e RG antigo manuscrito costumam falhar. Sempre confira com o documento.</div>`],
    ['🧾 Extrair alvos de texto, PDF e Word (v0.7)', `<p>Transforma um <b>BO, relatório ou mensagem</b> em alvos, sem digitar tudo. Abra em <b>Cofre → Extrair alvos de texto/documento</b> ou em <b>Importar em lote</b> (na operação ou no Cofre).</p><ol><li><b>Cole o texto</b> ou toque em <b>📎 Escolher PDF, Word (.docx) ou .txt</b>. O PDF com texto é lido direto; o <b>PDF digitalizado</b> (imagem) pode ser lido com o OCR do aparelho (até 15 páginas). Word antigo <span class="kbd">.doc</span> não é aceito: salve como <span class="kbd">.docx</span> ou PDF.</li><li>O app procura <b>nomes</b> (sequências em MAIÚSCULAS, “nome:”, “qualificado como”…), <b>vulgo</b> (“vulgo”, “v.”, “alcunha”, “conhecido como”), <b>filiação</b> (“filho de”, “filiação”), <b>CPF</b> (confere os dígitos), <b>RG</b>, <b>telefones</b>, <b>placas</b> (antiga e Mercosul) com o veículo, <b>nascimento</b> (perto de “nasc.”, “nascido”, “DN”) e <b>endereços</b> (Rua, Av., Travessa… com número ou bairro).</li><li>Os dados são agrupados em <b>pessoas</b> pela proximidade (no mesmo parágrafo, perto do nome). Na tela <b>Conferir extração</b>: corrija os campos, marque/desmarque cada pessoa, toque em <b>⇄</b> para mover um telefone, placa ou endereço para outra pessoa, use <b>⋯ → Juntar</b> para unir dois cartões ou <b>Remover</b>, e <b>＋ Adicionar pessoa</b>. O que ficou sem nome por perto aparece em <b>Dados soltos</b>.</li><li>Escolha a <b>operação</b> (ou crie uma) e toque em <b>Conferir duplicados</b>: quem já existe na operação (mesmo CPF/RG ou mesmo nome) pode ser <b>completado</b> (só campos vazios + telefones/placas novos), criado de novo ou ignorado.</li><li>Opcional: <b>guardar o texto de origem</b> como anotação criptografada em cada alvo, com o nome do arquivo e o SHA-256.</li></ol><div class="warn" style="margin-bottom:0">A extração é <b>automática e aproximada</b>: pode juntar dados da pessoa errada, cortar nomes ou não ver dados escritos de forma incomum. Nada é criado sem a sua conferência. Tudo é feito no aparelho — o texto e os arquivos não são enviados a lugar nenhum.</div>`],
    ['🤖 Formato ordenado com IA — leitura exata (v0.8)', `<p>Para texto bagunçado, <b>foto de documento</b> ou PDF difícil: uma IA organiza os dados num formato fixo e o app lê <b>cada campo exatamente</b>, sem adivinhar.</p><ol><li>Em <b>Extrair de texto/documento</b>, toque em <b>📋 Copiar instrução para IA</b> (ou <b>👁️ Ver instrução</b> para ler antes).</li><li>Abra a IA, cole a instrução e <b>anexe ou cole o material</b> (texto, foto do RG/CNH, print, PDF).</li><li>Copie a resposta da IA, cole no campo <b>Texto</b> e confira o selo <b>✅ Formato ordenado reconhecido — leitura exata</b>. Toque em <b>Extrair e conferir</b>: os mesmos cartões de conferência e a mesma checagem de duplicados.</li></ol><p><b>Formato</b> — uma pessoa por linha, campos separados por <span class="kbd">|</span>, em qualquer ordem e só os que existirem:</p><div class="kbd" style="display:block;white-space:normal;word-break:break-word;padding:8px 10px;margin:6px 0">NOME: … | VULGO: … | CPF: … | RG: … | NASC: dd/mm/aaaa | MÃE: … | PAI: … | NATURALIDADE: … | PROFISSÃO: … | ENDEREÇO: … | TELEFONES: …; … | VEÍCULO: … | PLACA: … | REDES: … | PAPEL: … | OBS: …</div><ul><li>Também vale <b>um campo por linha</b> (<span class="kbd">NOME: …</span> em uma linha, <span class="kbd">CPF: …</span> na outra), com <b>linha em branco</b> ou <span class="kbd">---</span> entre as pessoas, e uma lista <b>JSON</b> com as mesmas chaves.</li><li>Chaves sem diferença entre maiúsculas e acentos (<span class="kbd">Mae</span> = <span class="kbd">MÃE</span>); aceita sinônimos (Alcunha, Data de nascimento, Celular, Endereço residencial…).</li><li><b>MÃE/PAI</b> → filiação; <b>VEÍCULO + PLACA</b> → veículo (“Fiat Uno prata ABC1D23”); <b>TELEFONES</b>, <b>ENDEREÇO</b>, <b>PLACA</b> e <b>REDES</b> aceitam vários separados por <span class="kbd">;</span>; <b>OBS</b>, naturalidade e profissão viram uma <b>anotação</b> no alvo; <b>PAPEL</b> vira etiqueta.</li><li>O <b>CPF</b> tem os dígitos conferidos: se não conferir, ele <b>fica</b> no cartão com aviso ⚠️ para você checar. Valores marcados como <span class="kbd">(incerto)</span> aparecem com aviso.</li></ul><div class="warn" style="margin-bottom:0">🔐 <b>Privacidade:</b> o app não envia nada — mas, ao colar dados numa IA externa (ChatGPT, Gemini, Copilot…), eles saem do aparelho e podem ficar guardados pelo provedor. Siga a política da sua instituição e prefira uma <b>IA institucional</b>. A IA também erra: confira com o material original antes de salvar.</div>`],
    ['🏷️ Texto com rótulos “Campo: valor” (v0.8)', `<p>Relatórios e ofícios costumam trazer a qualificação com rótulos. O app lê esses rótulos <b>em qualquer ordem</b>, um por linha ou na mesma linha (<span class="kbd">Nome: Fulano, CPF: …, Mãe: …</span>), em maiúsculas ou minúsculas:</p><ul><li><b>Nome</b>, Nome completo, Qualificado — e Autor, Vítima, Testemunha, Investigado, Conduzido (viram etiqueta).</li><li><b>Vulgo</b>, Alcunha, Apelido, Conhecido como · <b>CPF</b>, C.P.F. · <b>RG</b>, Identidade, Doc. identidade, Cédula de identidade — com o <b>órgão emissor</b> (ex.: <span class="kbd">SSP/CE</span>) junto ou no rótulo Órgão emissor.</li><li><b>Data de nascimento</b>, Nasc., DN, Nascido em (aceita “12 de março de 1990”) · <b>Filiação</b>, <b>Mãe</b>, <b>Pai</b>, Genitora, Genitor.</li><li><b>Endereço</b>, Residência, Residente, Domicílio · <b>Telefone</b>, Celular, Fone, Contato, WhatsApp · <b>Veículo</b>, <b>Placa</b>.</li><li><b>Naturalidade</b> e <b>Profissão</b> → anotação no alvo; Redes sociais, Instagram, E-mail → redes sociais.</li></ul><ul><li>Cada novo rótulo <b>Nome</b> começa outra pessoa. Os dados com rótulo têm <b>prioridade</b> sobre os que o app só adivinha e ficam com a pessoa rotulada mais próxima.</li><li>Valores como “não consta” ou “não informado” são ignorados.</li></ul>`],
    ['🪪 Ler CNH por modelo, com moldura (v0.8)', `<ol><li>No formulário do alvo toque em <b>🪪 Ler CNH (modelo)</b> → <b>Abrir câmera</b> (câmera traseira) ou <b>Escolher do álbum</b>. Em <b>Ler documentos em lote</b>, ligue <b>Ler como CNH (modelo)</b> (use fotos já recortadas no cartão, de frente).</li><li>Encaixe a CNH na <b>moldura verde</b> e toque em <b>Capturar</b>. Vale o cartão (modelo 2017/2019) ou a frente de dados da CNH 2022 aberta: enquadre só a parte com os dados.</li><li>Na tela seguinte, <b>arraste os 4 cantos</b> até a borda do cartão — o app <b>endireita</b> a foto (corrige inclinação e perspectiva) e lê <b>cada campo na posição dele</b>: nome, doc. identidade/órgão/UF, CPF, nascimento, filiação, nº de registro, validade e categoria, com filtros de caracteres por campo.</li><li>Na conferência, cada campo mostra a <b>% de confiança</b> do leitor; o CPF é conferido pelos dígitos verificadores. Se os campos principais vierem fracos, o app lê também a <b>página inteira</b> e completa. Nº registro, validade e categoria ficam para copiar (não têm campo próprio no alvo).</li><li><b>Dicas:</b> boa luz, <b>sem reflexo</b> (incline um pouco se o plástico brilhar), cartão plano e <b>enchendo a moldura</b>. Acentos não são inventados: o que o leitor não viu, você corrige.</li><li>As posições dos campos são uma <b>estimativa do layout</b> oficial e podem variar entre emissões — confira sempre. A imagem endireitada pode ser guardada como <b>foto do documento</b> (criptografada).</li></ol>`],
    ['📲 CNH digital em PDF (v0.8)', `<ol><li>Exporte a CNH digital pelo app <b>Carteira Digital de Trânsito (CDT)</b> ou pelo <b>gov.br</b> (compartilhar/baixar PDF) e salve em Arquivos.</li><li>No Cofre: <b>Importar em lote → Extrair de documento</b> e escolha o PDF. Se o PDF tiver texto selecionável com os rótulos da CNH, aparece <b>🪪 CNH digital reconhecida</b>: os campos são lidos pela <b>posição de cada rótulo</b> (valor ao lado ou logo abaixo) — leitura exata, sem OCR.</li><li>Confira o cartão (nome, CPF, RG/órgão, nascimento, filiação; registro, validade e categoria vão para Observações), revise duplicados e salve — como em qualquer importação, <b>nada é criado sem a conferência</b>.</li><li>PDF <b>sem texto</b> (foto/escaneado): o app oferece <b>“É uma CNH — ler por modelo”</b>, que renderiza a 1ª página e abre o ajuste de cantos da leitura por moldura.</li><li>Os modelos de PDF podem mudar; se o selo não aparecer, o texto é tratado como documento comum (extrator de “Campo: valor”).</li></ol>`],
    ['🖼️ Fotos em lote pelo nome do arquivo (v0.7)', `<ol><li><b>Cofre → Fotos em lote pelo nome do arquivo</b> (ou em Importar em lote) e escolha <b>várias fotos</b> de uma vez.</li><li>O nome de cada arquivo (sem extensão, sem acento, espaço, maiúscula ou separador) é comparado com os alvos: <b>CPF</b> ou <b>RG/documento</b> (só os dígitos — <span class="kbd">529.982.247-25.jpg</span>, <span class="kbd">52998224725_2.jpg</span>), <b>nome</b> (<span class="kbd">joao_carlos_da_silva.jpg</span>, <span class="kbd">Joao Silva (2).jpg</span>) ou <b>vulgo</b>. Sufixos como <span class="kbd">_2</span>, <span class="kbd">-1</span> e <span class="kbd">(3)</span> são ignorados.</li><li>Na tabela, confira o alvo de cada foto (troque na lista ou marque <b>não importar</b>). As sem correspondência ficam separadas. Em <b>Procurar alvos em</b>, limite a uma operação ou use todas.</li><li>As fotos entram como <b>fotos do álbum</b>: data e GPS do EXIF, SHA-256 do arquivo original, criptografadas; opcionalmente a 1ª vira <b>capa</b> (se o alvo não tiver capa escolhida) e ganha <b>carimbo</b>.</li></ol>`],
    ['🪪 Leitura de documentos em lote (v0.7)', `<ol><li><b>Cofre → Ler documentos em lote</b> (ou em Importar em lote). <b>📷 Fotografar</b> um por um ou <b>🖼️ Escolher várias</b> imagens de RG/CNH; toque numa miniatura para tirar da fila.</li><li><b>Ler N documento(s)</b>: as imagens são lidas <b>uma por vez</b>, no aparelho, com barra de progresso e <b>Cancelar</b>, que pausa a fila: <b>continue</b> de onde parou ou <b>confira</b> o que já foi lido.</li><li>Cada documento vira um cartão com nome, CPF (com verificação dos dígitos), RG, nascimento e filiação, a miniatura da imagem e o texto lido. Corrija, marque/desmarque, junte cartões do mesmo documento (frente e verso) e escolha a operação.</li><li>Na etapa de <b>duplicados</b>, complete um alvo existente ou crie novos. Com <b>Guardar como foto do documento</b>, a imagem vira a 🪪 foto do documento do alvo (criptografada, com SHA-256; num alvo que já tem foto do documento, ela <b>não</b> é trocada).</li></ol><div class="warn" style="margin-bottom:0">O OCR <b>erra</b> com reflexo, foto torta ou CNH digital na tela. Confira cada número com o documento antes de salvar.</div>`],
    ['🛡️ Segurança', `<ul><li>O app trava sozinho após inatividade (ajuste na aba Cofre) e sempre que sai da tela.</li><li>Nada é enviado para servidor: sem nuvem, sem conta.</li><li>Use um PIN diferente do desbloqueio do celular.</li><li>Antes de usar em serviço, confirme a política da sua instituição e a LGPD para dados de investigação.</li></ul>`]
  ];
  APP.innerHTML = `<div class="brand">${esc(APP_NAME)}</div><h1>Ajuda</h1><div class="sub" style="margin:4px 4px 14px">Guia rápido. Toque num tópico para abrir.</div>
  <div class="help">${H.map(([t, b], i) => `<details class="glass" ${i === 0 ? 'open' : ''}><summary>${t}</summary><div class="body">${b}</div></details>`).join('')}</div>
  ${credit()}`;
}


/* ============ Busca de local no mapa — by @aiforge.team ============ */
function validLatLng(lat,lng){ return isFinite(lat)&&isFinite(lng)&&lat>=-90&&lat<=90&&lng>=-180&&lng<=180; }
function parseDMS(str){
  const re=/(\d{1,3}(?:\.\d+)?)\s*[°º:\s]\s*(?:(\d{1,2}(?:\.\d+)?)\s*['’′:\s]\s*)?(?:(\d{1,2}(?:\.\d+)?)\s*["”″]?\s*)?([NSLOWnslow])/g;
  const out=[]; let m;
  while((m=re.exec(str))){ let d=(+m[1])+(m[2]?+m[2]/60:0)+(m[3]?+m[3]/3600:0); const h=m[4].toUpperCase(); if(h==='S'||h==='W'||h==='O') d=-d; out.push({h,d}); }
  const lat=out.find(o=>'NS'.includes(o.h)), lng=out.find(o=>'EWLO'.includes(o.h));
  if(lat&&lng&&validLatLng(lat.d,lng.d)) return {lat:lat.d,lng:lng.d};
  return null;
}
function parseGmaps(str){
  let m;
  if((m=str.match(/!3d(-?\d+(?:\.\d+)?)!4d(-?\d+(?:\.\d+)?)/))){ const la=+m[1],lo=+m[2]; if(validLatLng(la,lo))return{lat:la,lng:lo}; }
  if((m=str.match(/@(-?\d+\.\d+),\s*(-?\d+\.\d+)/))){ const la=+m[1],lo=+m[2]; if(validLatLng(la,lo))return{lat:la,lng:lo}; }
  if((m=str.match(/[?&#](?:q|query|ll|sll|center|destination|daddr|saddr)=(-?\d+\.\d+)(?:,|%2C|\s)+(-?\d+\.\d+)/i))){ const la=+m[1],lo=+m[2]; if(validLatLng(la,lo))return{lat:la,lng:lo}; }
  return null;
}
function parseLocationInput(str){
  str=String(str||'').trim(); if(!str) return null;
  if(/^https?:\/\//i.test(str)||/google|goo\.gl|maps/i.test(str)){
    if(/(maps\.app\.goo\.gl|goo\.gl\/)/i.test(str)){ const g=parseGmaps(str); if(g) return {type:'coord',...g}; return {type:'shortlink'}; }
    const g=parseGmaps(str); if(g) return {type:'coord',...g};
  }
  let m=str.match(/^\(?\s*(-?\d{1,3}(?:\.\d+)?)\s*[, ]\s*(-?\d{1,3}(?:\.\d+)?)\s*\)?$/);
  if(m){ const la=+m[1],lo=+m[2]; if(validLatLng(la,lo)) return {type:'coord',lat:la,lng:lo}; }
  const dms=parseDMS(str); if(dms) return {type:'coord',...dms};
  const g=parseGmaps(str); if(g) return {type:'coord',...g};
  return null;
}
async function geocode(q, center){
  let vb='';
  if(center&&isFinite(center.lat)&&isFinite(center.lng)){ const d=0.2; vb=`&viewbox=${center.lng-d},${center.lat+d},${center.lng+d},${center.lat-d}&bounded=0`; }
  const url=`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=5&countrycodes=br&accept-language=pt-BR`+vb;
  const r=await fetch(url,{headers:{Accept:'application/json'}}); if(!r.ok) throw new Error('HTTP '+r.status); return r.json();
}
function mountSearch(root, cfg){
  root.innerHTML=`<div class="search glass" style="margin-bottom:8px"><span>🔍</span><input id="ms_q" placeholder="Endereço, coordenadas ou link do Maps" autocomplete="off" style="flex:1;min-width:0"><span class="btn sm" id="ms_go" style="margin:5px">Ir</span></div><div id="ms_note" class="sub hidden" style="margin:0 4px 10px;line-height:1.4"></div><div id="ms_res"></div>`;
  const q=root.querySelector('#ms_q'), res=root.querySelector('#ms_res');
  const showNote=()=>{ if(localStorage.getItem('ov_geonote'))return; const n=root.querySelector('#ms_note'); n.classList.remove('hidden'); n.textContent='ℹ️ o termo pesquisado é enviado ao OpenStreetMap; os dados do alvo não saem do aparelho'; localStorage.setItem('ov_geonote','1'); };
  let busy=false;
  async function submit(){
    const v=q.value.trim(); if(!v) return;
    const pr=parseLocationInput(v);
    if(pr&&pr.type==='shortlink'){ res.innerHTML='<div class="sub" style="padding:8px 4px;line-height:1.4">🔗 Links curtos (maps.app.goo.gl) não podem ser resolvidos aqui. Abra o link no navegador e cole as coordenadas ou o link completo.</div>'; return; }
    if(pr&&pr.type==='coord'){ res.innerHTML=''; cfg.onPick(pr.lat,pr.lng,null); toast('📍 Coordenada localizada'); return; }
    showNote();
    if(!navigator.onLine){ res.innerHTML='<div class="sub" style="padding:8px 4px">📴 Sem conexão. A busca de endereços precisa de internet.</div>'; return; }
    if(busy) return; busy=true; res.innerHTML='<div class="sub" style="padding:8px 4px">Buscando…</div>';
    try{
      const seen=new Set(); const list=(await geocode(v, cfg.getCenter&&cfg.getCenter())).filter(r=>{ const k=String(r.display_name).replace(/, \d{5}-\d{3}/,''); if(seen.has(k)) return false; seen.add(k); return true; });
      if(!list.length){ res.innerHTML=`<div class="sub" style="padding:8px 4px">Nada encontrado para "${esc(v)}".</div>`; }
      else res.innerHTML=list.map((r,i)=>`<div class="card glass msres" data-i="${i}" style="padding:10px 14px"><div class="t" style="font-size:14px">${esc(r.name||String(r.display_name).split(',')[0])}</div><div class="sub">${esc(r.display_name)}</div></div>`).join('');
      res.querySelectorAll('.msres').forEach(el=>el.onclick=()=>{ const r=list[+el.dataset.i]; const label=String(r.display_name||'').split(',').slice(0,2).join(',').trim(); cfg.onPick(+r.lat,+r.lon,label); });
    }catch(e){ res.innerHTML=`<div class="sub" style="padding:8px 4px">⚠️ Erro na busca: ${esc(e.message)}. Tente de novo.</div>`; }
    busy=false;
  }
  root.querySelector('#ms_go').onclick=submit;
  q.addEventListener('keydown',e=>{ if(e.key==='Enter'){ e.preventDefault(); submit(); } });
}

/* ============ Importação em lote — by @aiforge.team ============ */
const BATCH_HEADER='operação|nome|vulgo|documento|telefones|veículo|endereço|vínculos|prioridade|lat|lng';
const _norm = s=>String(s||'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').trim();
const _digits = s=>String(s||'').replace(/\D/g,'');
function normPrio(p){ p=_norm(p); if(p==='alta')return'alta'; if(p==='baixa')return'baixa'; return 'media'; }
function parseBatch(text){
  const rows=[];
  String(text||'').split(/\r?\n/).forEach((raw,idx)=>{
    const ln=idx+1; const line=raw.trim();
    if(!line||line.startsWith('#')) return;
    const low=line.toLowerCase();
    if((low.startsWith('operação|')||low.startsWith('operacao|')) && _norm(line.split('|')[1])==='nome') return;
    const f=line.split('|').map(x=>x.trim());
    const row={ln, operacao:f[0]||'', nome:f[1]||'', vulgo:f[2]||'', doc:f[3]||'', tels:(f[4]||'').split(';').map(x=>x.trim()).filter(Boolean), veic:f[5]||'', end:f[6]||'', vinc:f[7]||'', prio:normPrio(f[8]), lat:null, lng:null, errs:[]};
    if(!row.nome) row.errs.push('nome vazio');
    const rawLat=f[9], rawLng=f[10];
    if((rawLat&&rawLat.length)||(rawLng&&rawLng.length)){
      const la=parseFloat(String(rawLat).replace(',','.')), lo=parseFloat(String(rawLng).replace(',','.'));
      if(!validLatLng(la,lo)) row.errs.push('lat/lng inválidos'); else { row.lat=la; row.lng=lo; }
    }
    rows.push(row);
  });
  return rows;
}
function importBatch(defaultOpId){
  const defOp = defaultOpId ? getOp(defaultOpId) : null;
  sheet(`<h2 style="margin-top:0">Importar em lote</h2>
    ${exModesHtml()}
    <h2 style="margin-top:14px">Lista com | (planilha)</h2>
    <div class="sub" style="margin:0 0 8px;line-height:1.4">Um alvo por linha, campos separados por <b>|</b> (barra vertical):</div>
    <div class="card glass" style="cursor:default;padding:10px 12px;font-size:11px;word-break:break-all;color:#9cbcff">${esc(BATCH_HEADER)}</div>
    ${defOp?`<div class="sub" style="margin:8px 4px">Operação padrão (quando o campo <b>operação</b> ficar vazio): <b>${esc(defOp.nome)}</b></div>`:''}
    <label>Colar lista</label><textarea id="ib_t" style="min-height:140px" placeholder="Cole aqui ou use o arquivo…"></textarea>
    <div class="grid2" style="margin-top:12px"><div class="btn" id="ib_file">📄 Arquivo .txt/.csv</div><div class="btn" id="ib_modelo">⬇️ Baixar modelo</div></div>
    <div class="gap"></div><div class="btn pri" id="ib_prev">Pré-visualizar</div>
    <div class="credit">${esc(APP_NAME)} · <b>${esc(CREDIT)}</b></div>`, s=>{
    exModesBind(s, defaultOpId); s.querySelector('#ib_modelo').onclick=()=>modeloBatch();
    s.querySelector('#ib_file').onclick=()=>{
      pickFile('.txt,.csv,text/plain,text/csv', async f=>{ try{ s.querySelector('#ib_t').value=await f.text(); toast('Arquivo carregado'); }catch(e){ toast('Erro ao ler: '+e.message); } });
    };
    s.querySelector('#ib_prev').onclick=()=>{ const txt=s.querySelector('#ib_t').value; if(!txt.trim()) return toast('Cole a lista ou escolha um arquivo'); previewBatch(txt, defaultOpId); };
  });
}
function modeloBatch(){
  const txt=[BATCH_HEADER,
    'Operação Exemplo|João da Silva (fictício)|Jota|00000000000|(85) 90000-0000;(85) 90000-0001|Fiat Uno branco XYZ0A00|Rua Fictícia, 123 - Centro|Maria (fictícia, irmã)|alta|-3.7319|-38.5267',
    'Operação Exemplo|Maria Souza (fictícia)|Mari|11111111111|(85) 91111-1111|sem veículo|Av. Inventada, 456 - Bairro|João (fictício, irmão)|média|-3.7330|-38.5240'
  ].join('\n')+'\n';
  shareFile(new File([txt],`OpsVault_modelo_importacao_${fileStamp()}.txt`,{type:'text/plain'}));
}
function previewBatch(text, defaultOpId){
  const defOp = defaultOpId ? getOp(defaultOpId) : null;
  const rows = parseBatch(text);
  if(!rows.length) return toast('Nenhuma linha para importar');
  const existingOpByName={}; S.ops.forEach(o=>existingOpByName[_norm(o.nome)]=o);
  rows.forEach(r=>{ r.opName = r.operacao || (defOp?defOp.nome:''); if(!r.opName && !r.errs.includes('operação vazia')) r.errs.push('operação vazia'); });
  rows.forEach(r=>{ r.dup=null; r.dupWhy=''; if(r.errs.length) return; const rd=_digits(r.doc); const opKey=_norm(r.opName);
    for(const a of S.alvos){ const ao=getOp(a.opId); if(!ao||_norm(ao.nome)!==opKey) continue;
      if(rd && _digits(a.doc)===rd){ r.dup=a; r.dupWhy='mesmo documento'; break; }
      if(_norm(a.nome)===_norm(r.nome)){ r.dup=a; r.dupWhy='mesmo nome'; break; } } });
  const valid=rows.filter(r=>!r.errs.length);
  const errRows=rows.filter(r=>r.errs.length);
  const dups=valid.filter(r=>r.dup);
  const state={impDup:false};
  const render=()=>{
    const toImp=valid.filter(r=>!r.dup||state.impDup); const willImport=toImp.length;
    const newOpNames=[]; toImp.forEach(r=>{ const key=_norm(r.opName); if(!existingOpByName[key] && !newOpNames.some(n=>_norm(n)===key)) newOpNames.push(r.opName); });
    sheet(`<h2 style="margin-top:0">Pré-visualização</h2>
      <div class="card glass" style="cursor:default"><div class="row"><div>✅ Válidos</div><b>${valid.length}</b></div><div class="row" style="margin-top:6px"><div>⚠️ Com erro</div><b>${errRows.length}</b></div><div class="row" style="margin-top:6px"><div>🔁 Já existem no cofre</div><b>${dups.length}</b></div><div class="row" style="margin-top:6px"><div>⬆️ Serão importados</div><b>${willImport}</b></div></div>
      ${newOpNames.length?`<h2>Novas operações (${newOpNames.length})</h2><div class="card glass" style="cursor:default;padding:10px 14px;font-size:13px">${newOpNames.map(n=>'🗂️ '+esc(n)).join('<br>')}</div>`:''}
      ${errRows.length?`<h2>Linhas com erro (${errRows.length})</h2><div class="card glass" style="cursor:default;padding:10px 14px;font-size:13px;max-height:170px;overflow:auto">${errRows.map(r=>`Linha ${r.ln}: ${esc(r.nome||'(sem nome)')} — <span style="color:#ffadad">${esc(r.errs.join(', '))}</span>`).join('<br>')}</div>`:''}
      ${dups.length?`<h2>Já existem (${dups.length})</h2><div class="sub" id="ib_dmsg" style="margin:0 4px 8px;line-height:1.45">${dups.length===valid.length?'<b>Todas as linhas já estão cadastradas</b> — ':''}Estas linhas correspondem a alvos que <b>já existem na mesma operação</b> (mesmo documento ou mesmo nome) e <b>${state.impDup?'serão importadas de novo, criando alvos repetidos':'serão ignoradas'}</b>. Nada do que já existe é alterado.</div><div class="card glass" style="cursor:default;padding:10px 14px;font-size:13px;max-height:150px;overflow:auto">${dups.map(r=>`Linha ${r.ln}: ${esc(r.nome)} — já existe em <b>${esc(r.opName)}</b> (${r.dupWhy})${state.impDup?'':' · ignorada'}`).join('<br>')}</div><div class="tgrow card glass" style="cursor:default"><div>Importar mesmo assim<div class="sub">cria alvos repetidos</div></div><div class="tg ${state.impDup?'on':''}" id="ib_dtg"></div></div>`:''}
      <h2>Serão importados</h2><div class="card glass" style="cursor:default;padding:10px 14px;font-size:13px;max-height:180px;overflow:auto">${valid.map(r=>`${r.dup&&!state.impDup?'⏭️':'➕'} ${esc(r.nome)}${r.dup&&!state.impDup?' <span class="sub">(já existe)</span>':''} <span class="sub">· ${esc(r.opName)}${r.lat!=null?' · 📍':''}</span>`).join('<br>')||'<span class="sub">nenhuma linha válida</span>'}</div>
      <div class="gap"></div><div class="grid2"><div class="btn" id="ib_cancel">Cancelar</div><div class="btn pri ${willImport?'':'dis'}" id="ib_save">${willImport?`Importar ${willImport}`:'Nada novo para importar'}</div></div>`, s=>{
      const dtg=s.querySelector('#ib_dtg'); if(dtg) dtg.onclick=()=>{ state.impDup=!state.impDup; render(); };
      s.querySelector('#ib_cancel').onclick=closeSheet;
      s.querySelector('#ib_save').onclick=()=>{ if(!willImport) return toast(dups.length?'Todas as linhas já existem no cofre':'Nenhuma linha válida'); doImportBatch(valid, newOpNames, state); };
    });
  };
  render();
}
async function doImportBatch(valid, newOpNames, state){
  const opMap={}; S.ops.forEach(o=>opMap[_norm(o.nome)]=o.id);
  newOpNames.forEach(n=>{ if(!opMap[_norm(n)]){ const id=uid(); S.ops.push({id,nome:n,status:'planejada',desc:'',ts:Date.now()}); opMap[_norm(n)]=id; } });
  let count=0;
  valid.forEach(r=>{
    if(r.dup&&!state.impDup) return;
    const opId=opMap[_norm(r.opName)]; if(!opId) return;
    const now=Date.now(); const locais=[];
    if(r.lat!=null) locais.push({id:uid(), ts:now, tipo:'residencia', titulo:'Endereço importado', nota:'', lat:r.lat, lng:r.lng, acc:null});
    S.alvos.push({id:uid(), opId, nome:r.nome, apelido:r.vulgo, doc:r.doc, prio:r.prio, tels:r.tels, veic:r.veic, end:r.end, vinc:r.vinc, fotos:[], locais, notas:[], log:[{ts:now, t:'Importado em lote'}], ts:now});
    count++;
  });
  await save(); closeSheet(); route();
  toast(`✔ ${count} alvo(s) importado(s)${newOpNames.length?` · ${newOpNames.length} nova(s) operação(ões)`:''}`);
}


/* Seletor de arquivo compatível com iPhone: input fixo no DOM, sem accept para tipos desconhecidos */
/* v0.7: multiple = true → cb recebe a lista de arquivos (seleção de várias fotos no iPhone) */
function pickFile(accept, cb, multiple) {
  let inp = document.getElementById('pick');
  if (!inp) { inp = document.createElement('input'); inp.type = 'file'; inp.id = 'pick'; inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0'; document.body.appendChild(inp); }
  if (accept) inp.setAttribute('accept', accept); else inp.removeAttribute('accept');
  inp.multiple = !!multiple;
  inp.value = ''; hold(multiple ? 300000 : 180000);
  inp.oncancel = () => release();
  inp.onchange = () => { release(); const fs = [...(inp.files || [])]; inp.value = ''; if (!fs.length) return; if (multiple) cb(fs); else cb(fs[0]); };
  inp.click();
}

/* ============ Exportar / importar operação (outro aparelho) — by @aiforge.team ============ */
const OPPKG_APP = 'opsvault-op';
async function buildOpPackage(opId, pw) {
  const op = getOp(opId); if (!op) throw new Error('operação não encontrada');
  const alvos = S.alvos.filter(a => a.opId === opId);
  const imgs = {}; let miss = 0;
  for (const a of alvos) for (const f of [...(a.fotos || []), ...(a.fotos || []).filter(x => x.carimbo).map(x => x.carimbo), ...(a.docFoto ? [a.docFoto] : [])]) { const box = await DB.get('img:' + f.id); if (!box) { miss++; continue; } imgs[f.id] = b64(await open_(KEY, box)); }
  const inbox = (S.inbox || []).filter(it => it.opId === opId);
  for (const it of inbox) if (it.kind === 'foto') { const box = await DB.get('img:' + it.f.id); if (box) imgs[it.f.id] = b64(await open_(KEY, box)); }
  const auds = {}; for (const x of [...alvos.flatMap(a => a.audios || []), ...(op.audios || []), ...inbox.filter(it => it.kind === 'audio').map(it => it.x)]) { const box = await DB.get('aud:' + x.id); if (box) auds[x.id] = b64(await open_(KEY, box)); }
  const ids = new Set(alvos.map(a => a.id)); const links = (S.links || []).filter(l => ids.has(l.a) && ids.has(l.b)); // v0.5: só vínculos entre alvos da própria operação
  const pkg = {app: OPPKG_APP + '-pkg', v: 2, ts: Date.now(), by: CREDIT, op: JSON.parse(JSON.stringify(op)), alvos: JSON.parse(JSON.stringify(alvos)), links: JSON.parse(JSON.stringify(links)), areas: JSON.parse(JSON.stringify((S.areas || []).filter(ar => ar.opId === opId))), inbox: JSON.parse(JSON.stringify(inbox)), imgs, auds};
  const salt = crypto.getRandomValues(new Uint8Array(16)); const k = await deriveKey(pw, salt);
  const out = {app: OPPKG_APP, v: 1, salt: b64(salt), box: await seal(k, enc.encode(JSON.stringify(pkg)))};
  const file = new File([JSON.stringify(out)], `OpsVault_op_${slug(op.nome)}_${fileStamp()}.opsvault`, {type: 'application/octet-stream'});
  return {file, nAlvos: alvos.length, nFotos: Object.keys(imgs).length, miss};
}
function exportOpUI(op) {
  const alvos = S.alvos.filter(a => a.opId === op.id); const nf = alvos.reduce((s, a) => s + (a.fotos?.length || 0), 0);
  sheet(`<h2 style="margin-top:0">📦 Exportar operação</h2>
    <div class="sub" style="line-height:1.4"><b>${esc(op.nome)}</b> · ${alvos.length} alvo(s) · ${nf} foto(s)</div>
    <label>Senha de transferência (mín. 6 caracteres)</label><input id="xo_p1" type="password" autocomplete="new-password">
    <label>Confirmar senha</label><input id="xo_p2" type="password" autocomplete="new-password">
    <div class="warn">⚠️ Envie a <b>senha por outro canal</b> (ligação, pessoalmente, outro app) — nunca junto com o arquivo. Quem tiver os dois abre a operação inteira.</div>
    <div class="btn pri" id="xo_ok">Gerar arquivo .opsvault</div>
    <div class="credit">${esc(APP_NAME)} · <b>${esc(CREDIT)}</b></div>`, s => {
    const b = s.querySelector('#xo_ok'); let busy = false;
    b.onclick = async () => {
      if (busy) return; const p1 = s.querySelector('#xo_p1').value, p2 = s.querySelector('#xo_p2').value;
      if (p1.length < 6) return toast('A senha precisa ter pelo menos 6 caracteres'); if (p1 !== p2) return toast('As senhas não conferem');
      busy = true; b.textContent = 'Criptografando…';
      try { const r = await buildOpPackage(op.id, p1); closeSheet(); await shareFile(r.file); setTimeout(() => toast(`📦 ${r.nAlvos} alvo(s), ${r.nFotos} foto(s) exportados. Envie a senha por outro canal!`, 4200), 2700); }
      catch (e) { console.error(e); toast('Erro: ' + e.message); busy = false; b.textContent = 'Gerar arquivo .opsvault'; }
    };
  });
}
async function openOpPackage(text, pw) {
  let j; try { j = JSON.parse(text); } catch { throw new Error('Arquivo inválido (não é uma operação do OpsVault)'); }
  if (!j || j.app !== OPPKG_APP || !j.salt || !j.box) throw new Error('Arquivo inválido (não é uma operação do OpsVault)');
  let pkg;
  try { const k = await deriveKey(pw, unb64(j.salt)); pkg = JSON.parse(dec.decode(await open_(k, j.box))); }
  catch { const e = new Error('Senha incorreta ou arquivo corrompido'); e.badPw = true; throw e; }
  if (!pkg || !pkg.op || !pkg.op.id || !Array.isArray(pkg.alvos)) { const e = new Error('Senha incorreta ou arquivo corrompido'); e.badPw = true; throw e; }
  pkg.imgs = pkg.imgs || {}; pkg.links = Array.isArray(pkg.links) ? pkg.links : []; pkg.areas = Array.isArray(pkg.areas) ? pkg.areas : []; pkg.auds = pkg.auds || {}; // pacotes v0.4 não têm vínculos/áreas
  return pkg;
}
// mode: 'new' (sem conflito) | 'replace' | 'copy'
async function mergeOpPackage(pkg, mode) {
  const op = JSON.parse(JSON.stringify(pkg.op)), alvos = JSON.parse(JSON.stringify(pkg.alvos)), now = Date.now();
  if (mode === 'replace') {
    for (const a of S.alvos.filter(a => a.opId === op.id)) await dropAlvo(a); // fotos, documento, áudios e vínculos
    S.ops = S.ops.filter(o => o.id !== op.id); S.areas = S.areas.filter(ar => ar.opId !== op.id);
  }
  const copy = mode === 'copy';
  if (mode === 'replace' && TRK && TRK.opId === op.id) trackStop(true); // trajeto em gravação na operação substituída
  if (copy || getOp(op.id)) { op.id = uid(); if (copy) op.nome = op.nome + ' (cópia)'; }
  const aIds = new Set(S.alvos.map(a => a.id)); const fIds = new Set(S.alvos.flatMap(a => [...(a.fotos || []).map(f => f.id), ...(a.docFoto ? [a.docFoto.id] : [])]));
  let nf = 0, miss = 0; const idMap = {};
  for (const a of alvos) {
    const oldId = a.id; if (copy || aIds.has(a.id)) a.id = uid(); aIds.add(a.id); a.opId = op.id; idMap[oldId] = a.id;
    if (a.docFoto) { const data = pkg.imgs[a.docFoto.id]; if (!data) { miss++; delete a.docFoto; } else { if (copy || fIds.has(a.docFoto.id)) a.docFoto.id = uid(); fIds.add(a.docFoto.id); await putImg(a.docFoto.id, unb64(data)); } }
    const fotos = [];
    for (const f of a.fotos || []) {
      const data = pkg.imgs[f.id]; if (!data) { miss++; continue; }
      if (copy || fIds.has(f.id)) { const nid = uid(); if (a.capa === f.id) a.capa = nid; f.id = nid; } fIds.add(f.id);
      await putImg(f.id, unb64(data)); fotos.push(f); nf++;
      if (f.carimbo) { const cd = pkg.imgs[f.carimbo.id]; if (!cd) delete f.carimbo; else { if (copy || fIds.has(f.carimbo.id)) f.carimbo.id = uid(); fIds.add(f.carimbo.id); await putImg(f.carimbo.id, unb64(cd)); } }
    }
    a.fotos = fotos; a.audios = await importAuds(a.audios, pkg, copy); a.locais = a.locais || []; a.notas = a.notas || []; a.log = a.log || [];
    a.log.push({ts: now, t: 'Importado de outro aparelho'});
  }
  op.audios = await importAuds(op.audios, pkg, copy);
  const remap = id => id ? (idMap[id] || (getAlvo(id) ? id : '')) : ''; // diário: refs a alvos do pacote ganham os novos ids
  (op.vig || []).forEach(v => { v.alvoId = remap(v.alvoId); }); (op.diario || []).forEach(e => { e.alvoId = remap(e.alvoId); e.com = remap(e.com); });
  if (mode === 'replace') for (const it of (S.inbox || []).filter(it => it.opId === op.id)) await inboxDrop(it);
  let ni = 0; S.inbox = S.inbox || [];
  for (const it of Array.isArray(pkg.inbox) ? pkg.inbox : []) { // rascunhos da operação (v0.6); pacotes antigos não têm
    const x = JSON.parse(JSON.stringify(it)); x.id = uid(); x.opId = op.id;
    if (x.kind === 'foto') { const d = x.f && pkg.imgs[x.f.id]; if (!d) continue; x.f.id = uid(); await putImg(x.f.id, unb64(d)); }
    else if (x.kind === 'audio') { const [a2] = await importAuds([x.x], pkg, true); if (!a2) continue; x.x = a2; }
    else if (!INB[x.kind]) continue;
    S.inbox.push(x); ni++;
  }
  S.ops.push(op); S.alvos.push(...alvos);
  let nl = 0; for (const l of pkg.links || []) { const x = idMap[l.a], y = idMap[l.b]; if (!x || !y || x === y) continue; if (S.links.some(k => (k.a === x && k.b === y) || (k.a === y && k.b === x))) continue; S.links.push({id: uid(), a: x, b: y, rel: String(l.rel || ''), ts: l.ts || now}); nl++; }
  const arIds = new Set(S.areas.map(x => x.id)); let na = 0;
  for (const ar of pkg.areas || []) { if (!ar || !(ar.tipo === 'circulo' ? Array.isArray(ar.c) && +ar.raio > 0 : Array.isArray(ar.pts) && ar.pts.length > 2)) continue; const x = JSON.parse(JSON.stringify(ar)); if (copy || arIds.has(x.id)) x.id = uid(); arIds.add(x.id); x.opId = op.id; S.areas.push(x); na++; }
  migrate(S); await save();
  return {op, nAlvos: alvos.length, nFotos: nf, nLinks: nl, nAreas: na, miss};
}
/* áudios do pacote: só os que vieram com o som; ids novos se for cópia ou colidirem */
async function importAuds(list, pkg, copy) {
  const out = []; for (const x of list || []) { const data = pkg.auds && pkg.auds[x.id]; if (!data) continue; if (copy || await DB.get('aud:' + x.id)) x.id = uid(); await putAud(x.id, unb64(data)); out.push(x); }
  return out;
}
function importOpUI() {
  pickFile(null, async file => {
    let text; try { text = await file.text(); } catch (e) { return toast('Erro ao ler: ' + e.message); }
    let j; try { j = JSON.parse(text); } catch { return toast('Arquivo inválido (não é uma operação do OpsVault)'); }
    if (j && j.app === 'opsvault') return toast('Este é um backup completo (.cofre). Use “Restaurar backup”.', 4200);
    if (!j || j.app !== OPPKG_APP) return toast('Arquivo inválido (não é uma operação do OpsVault)');
    importOpPassword(text, file.name);
  });
}
function importOpPassword(text, name) {
  sheet(`<h2 style="margin-top:0">📦 Importar operação</h2><div class="sub" style="word-break:break-all">${esc(name || '')}</div>
    <label>Senha de transferência</label><input id="io_pw" type="password" autocomplete="off">
    <div class="err" id="io_err" style="color:#ff8a8a;font-size:13px;margin:8px 4px;min-height:16px"></div>
    <div class="btn pri" id="io_ok">Abrir arquivo</div>`, s => {
    const b = s.querySelector('#io_ok'), pw = s.querySelector('#io_pw'); let busy = false; pw.focus();
    const go = async () => {
      if (busy || !pw.value) return; busy = true; b.textContent = 'Descriptografando…'; s.querySelector('#io_err').textContent = '';
      try { const pkg = await openOpPackage(text, pw.value); importOpPreview(pkg); }
      catch (e) { busy = false; b.textContent = 'Abrir arquivo'; s.querySelector('#io_err').textContent = e.message; toast(e.message); pw.value = ''; pw.focus(); }
    };
    b.onclick = go; pw.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  });
}
function importOpPreview(pkg) {
  const nf = pkg.alvos.reduce((s, a) => s + (a.fotos?.length || 0), 0); const exists = getOp(pkg.op.id);
  const st = STATUS[pkg.op.status] || STATUS.planejada; $('#toast').classList.add('hidden');
  sheet(`<h2 style="margin-top:0">Pré-visualização</h2>
    <div class="card glass" style="cursor:default"><div class="row"><div class="t">${esc(pkg.op.nome)}</div><span class="chip ${st[0]}">${st[1]}</span></div>
      <div class="row" style="margin-top:8px"><div>👤 Alvos</div><b id="io_na">${pkg.alvos.length}</b></div><div class="row" style="margin-top:6px"><div>📷 Fotos</div><b id="io_nf">${nf}</b></div>${pkg.links.length ? `<div class="row" style="margin-top:6px"><div>🔗 Vínculos entre alvos</div><b id="io_nl">${pkg.links.length}</b></div>` : ''}${pkg.areas.length ? `<div class="row" style="margin-top:6px"><div>⬡ Áreas no mapa</div><b id="io_nar">${pkg.areas.length}</b></div>` : ''}${(pkg.op.diario || []).length || (pkg.op.vig || []).length ? `<div class="row" style="margin-top:6px"><div>👁️ Vigilância</div><b id="io_nv">${(pkg.op.vig || []).length} sessão(ões) · ${(pkg.op.diario || []).length} reg.</b></div>` : ''}${(pkg.op.trajetos || []).length ? `<div class="row" style="margin-top:6px"><div>🛰️ Trajetos</div><b id="io_nt">${pkg.op.trajetos.length}</b></div>` : ''}
      ${pkg.ts ? `<div class="sub" style="margin-top:6px">Exportada em ${fmt(pkg.ts)}</div>` : ''}</div>
    <div class="card glass" style="cursor:default;padding:10px 14px;font-size:13px;max-height:150px;overflow:auto">${pkg.alvos.map(a => `👤 ${esc(a.nome)} <span class="sub">· ${a.fotos?.length || 0} foto(s)</span>`).join('<br>') || '<span class="sub">sem alvos</span>'}</div>
    ${exists ? `<div class="warn">⚠️ Esta operação já existe neste aparelho (<b>${esc(exists.nome)}</b>, ${S.alvos.filter(a => a.opId === exists.id).length} alvo(s)). O que fazer?</div>
      <div class="btn dan" id="io_rep">Substituir a existente</div><div class="btn pri" id="io_cp" style="margin-top:10px">Importar como cópia</div>`
    : `<div class="sub" style="margin:10px 4px">Será <b>somada</b> aos dados deste aparelho — nada é apagado.</div><div class="btn pri" id="io_new">Importar</div>`}
    <div class="btn" id="io_cn" style="margin-top:10px">Cancelar</div>`, s => {
    let busy = false;
    const run = async mode => {
      if (busy) return;
      if (mode === 'replace' && !await confirmBox(`Apagar "${exists.nome}" (alvos e fotos) deste aparelho e pôr a recebida no lugar?`, 'Substituir', true)) return importOpPreview(pkg);
      busy = true; toast('Importando e recriptografando…');
      try { const r = await mergeOpPackage(pkg, mode); closeSheet(); location.hash = '#op/' + r.op.id; route();
        toast(`✔ ${mode === 'replace' ? 'Operação substituída' : mode === 'copy' ? 'Cópia importada' : 'Operação importada'}: ${r.nAlvos} alvo(s), ${r.nFotos} foto(s)${r.miss ? ` · ${r.miss} foto(s) ausente(s) no arquivo` : ''}`, 3500); }
      catch (e) { console.error(e); busy = false; toast('Erro: ' + e.message); }
    };
    s.querySelector('#io_cn').onclick = closeSheet;
    if (exists) { s.querySelector('#io_rep').onclick = () => run('replace'); s.querySelector('#io_cp').onclick = () => run('copy'); }
    else s.querySelector('#io_new').onclick = () => run('new');
  });
}

/* ============ v0.5 — Biometria (WebAuthn) — by @aiforge.team ============ */
/* Estratégia:
   1) PRF (extensão WebAuthn): o autenticador devolve 32 bytes secretos só após Face ID/digital.
      Desses bytes deriva-se (HKDF) a chave que embrulha a chave do cofre. Sem a biometria, nada abre.
   2) Sem PRF: a WebAuthn vira uma "porta" e a chave do cofre fica embrulhada por uma chave do aparelho
      guardada no IndexedDB. É conveniência: quem extrair o armazenamento do aparelho não precisa do PIN.
      Por isso só é ativado com confirmação explícita. O PIN continua sendo a chave-mestra. */
const b64url = buf => b64(buf).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function bioSupported() {
  try { return !!(window.isSecureContext && window.PublicKeyCredential && navigator.credentials && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
  catch (e) { return false; }
}
async function prfKey(out) {
  const base = await crypto.subtle.importKey('raw', out, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt: enc.encode('opsvault-bio-v1'), info: enc.encode('wrap')}, base, {name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
}
/* Chave do namespace atual (real ou falso) a partir do PIN, extraível só aqui para ser embrulhada */
async function nsCheck(meta) { return DB.decoy ? {salt: meta.p.salt, check: meta.p.check} : {salt: meta.salt, check: meta.check}; }
async function verifyPinRaw(pin) {
  const meta = await DB.get('meta', DB.main); const ns = await nsCheck(meta);
  const k = await deriveKey(pin, unb64(ns.salt), true);
  await open_(k, ns.check);
  return new Uint8Array(await crypto.subtle.exportKey('raw', k));
}
async function bioEnable(pin) {
  let raw; try { raw = await verifyPinRaw(pin); } catch (e) { throw new Error('PIN incorreto'); }
  const prfSalt = crypto.getRandomValues(new Uint8Array(32));
  hold(90000);
  try {
    const cred = await navigator.credentials.create({publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)), rp: {name: APP_SHORT},
      user: {id: crypto.getRandomValues(new Uint8Array(16)), name: APP_SHORT, displayName: APP_NAME},
      pubKeyCredParams: [{type: 'public-key', alg: -7}, {type: 'public-key', alg: -257}],
      authenticatorSelection: {authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred'},
      timeout: 60000, attestation: 'none', extensions: {prf: {eval: {first: prfSalt}}}}});
    const ext = (cred.getClientExtensionResults && cred.getClientExtensionResults()) || {};
    let out = ext.prf && ext.prf.results && ext.prf.results.first;
    if (!out && ext.prf && ext.prf.enabled) {
      const as = await navigator.credentials.get({publicKey: {challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: [{type: 'public-key', id: cred.rawId}], userVerification: 'required', timeout: 60000, extensions: {prf: {eval: {first: prfSalt}}}}});
      const e2 = as.getClientExtensionResults(); out = e2.prf && e2.prf.results && e2.prf.results.first;
    }
    const rec = {credId: b64(cred.rawId), ts: Date.now()};
    if (out) { rec.mode = 'prf'; rec.prfSalt = b64(prfSalt); rec.box = await seal(await prfKey(out), raw); }
    else {
      release();
      if (!await confirmBox('Este aparelho não oferece a extensão PRF. A biometria funcionará só como “porta” (conveniência): a chave fica protegida pelo aparelho, não pela biometria. Ativar mesmo assim?', 'Ativar (conveniência)')) return null;
      const dev = await crypto.subtle.generateKey({name: 'AES-GCM', length: 256}, false, ['encrypt', 'decrypt']);
      rec.mode = 'dev'; rec.devKey = dev; rec.box = await seal(dev, raw);
    }
    await DB.set('bio', rec); return rec.mode;
  } finally { release(); raw.fill(0); }
}
async function bioUnlock(bios, meta) {
  const prf = bios.filter(b => b.mode === 'prf');
  const pk = {challenge: crypto.getRandomValues(new Uint8Array(32)), allowCredentials: bios.map(b => ({type: 'public-key', id: unb64(b.credId)})), userVerification: 'required', timeout: 60000};
  if (prf.length) pk.extensions = {prf: {evalByCredential: Object.fromEntries(prf.map(b => [b64url(unb64(b.credId)), {first: unb64(b.prfSalt)}]))}};
  const as = await navigator.credentials.get({publicKey: pk});
  const rec = bios.find(b => b.credId === b64(as.rawId)); if (!rec) throw new Error('credencial desconhecida');
  let wrap;
  if (rec.mode === 'prf') { const e = as.getClientExtensionResults(); const out = e.prf && e.prf.results && e.prf.results.first; if (!out) throw new Error('PRF ausente'); wrap = await prfKey(out); }
  else wrap = rec.devKey;
  const raw = await open_(wrap, rec.box);
  const key = await crypto.subtle.importKey('raw', raw, {name: 'AES-GCM'}, false, ['encrypt', 'decrypt']); raw.fill(0);
  if (rec.ns === 0) { await open_(key, meta.check); return {mode: 'real', key}; }
  if (!meta.p) throw new Error('cofre indisponível');
  await open_(key, meta.p.check); return {mode: 'decoy', key};
}
function bioSheet(cur) {
  if (cur) return sheet(`<h2 style="margin-top:0">Face ID / biometria</h2><div class="sub" style="line-height:1.5">Ativada em ${fmt(cur.ts)} · modo <b>${cur.mode === 'prf' ? 'PRF (chave derivada da biometria)' : 'conveniência (chave do aparelho)'}</b>.</div>
    <div class="gap"></div><div class="btn dan" id="bo_off">Desativar biometria</div>`, s => {
    s.querySelector('#bo_off').onclick = async () => { await DB.del('bio'); closeSheet(); route(); toast('Biometria desativada'); };
  });
  sheet(`<h2 style="margin-top:0">Ativar Face ID / biometria</h2>
    <div class="sub" style="line-height:1.5">Confirme o PIN. Depois o aparelho pede o Face ID / digital para criar a credencial. O PIN continua valendo sempre.</div>
    <label>PIN atual</label><input id="bo_p" type="password" inputmode="numeric" autocomplete="off">
    <div class="gap"></div><div class="btn pri" id="bo_ok">Ativar</div>`, s => {
    const b = s.querySelector('#bo_ok');
    b.onclick = async () => {
      const p = s.querySelector('#bo_p').value; if (!/^\d{6,12}$/.test(p)) return toast('Digite o PIN');
      b.textContent = 'Aguardando biometria…';
      try { const m = await bioEnable(p); closeSheet(); route(); if (m) toast(m === 'prf' ? '🙂 Biometria ativada (PRF)' : '🙂 Biometria ativada (conveniência)', 3500); }
      catch (e) { console.warn(e); b.textContent = 'Ativar'; toast(e.name === 'NotAllowedError' ? 'Biometria cancelada' : 'Erro: ' + e.message); }
    };
  });
}

/* ============ v0.5 — PIN de pânico ============ */
function panicSheet() {
  const mode = S.cfg.panicMode || '';
  sheet(`<h2 style="margin-top:0">🚨 PIN de pânico</h2>
    <div class="sub" style="line-height:1.5">Um segundo PIN que, digitado na tela de bloqueio, parece abrir o cofre normalmente. A tela é idêntica e o tempo de resposta é o mesmo.</div>
    ${mode ? `<div class="card glass" style="cursor:default;margin-top:12px"><div class="t" style="font-size:14px">Ativo: ${mode === 'wipe' ? '🔥 apaga todos os dados reais' : '🗂️ abre um cofre falso vazio'}</div></div>` : ''}
    <label>Ao digitar o PIN de pânico</label><select id="pp_m"><option value="decoy" ${mode !== 'wipe' ? 'selected' : ''}>Abrir cofre falso vazio (padrão)</option><option value="wipe" ${mode === 'wipe' ? 'selected' : ''}>Apagar TODOS os dados reais na hora</option></select>
    <label>PIN de pânico (6 a 12 dígitos, diferente do PIN real)</label><input id="pp1" type="password" inputmode="numeric" autocomplete="off">
    <label>Confirmar</label><input id="pp2" type="password" inputmode="numeric" autocomplete="off">
    <div class="warn">O modo “apagar” é irreversível: os dados reais, backups internos e mapas offline somem e abre-se um cofre novo e vazio com esse PIN.</div>
    <div class="btn pri" id="pp_ok">${mode ? 'Redefinir PIN de pânico' : 'Ativar PIN de pânico'}</div>
    ${mode ? '<div class="btn dan" id="pp_off" style="margin-top:10px">Desativar PIN de pânico</div>' : ''}`, s => {
    const b = s.querySelector('#pp_ok');
    b.onclick = async () => {
      const p1 = s.querySelector('#pp1').value, p2 = s.querySelector('#pp2').value, m = s.querySelector('#pp_m').value;
      if (!/^\d{6,12}$/.test(p1)) return toast('PIN de pânico: 6 a 12 dígitos'); if (p1 !== p2) return toast('Confirmação não confere');
      const label = b.textContent; b.textContent = 'Gerando chave…';
      const meta = await DB.get('meta', DB.main), ns = DB.decoy ? meta.p : meta;
      let same = false; try { await open_(await deriveKey(p1, unb64(ns.salt)), ns.check); same = true; } catch (e) {}
      if (same) { b.textContent = label; return toast('O PIN de pânico não pode ser igual ao PIN real'); }
      if (m === 'wipe' && !await confirmBox('⚠️ ATENÇÃO: quem digitar o PIN de pânico vai APAGAR NA HORA todos os dados reais — operações, alvos, fotos, áudios e mapas offline. Não há como desfazer nem recuperar sem um backup .cofre. Ativar o modo apagar?', 'Sim, modo apagar', true)) return panicSheet();
      const salt = crypto.getRandomValues(new Uint8Array(16)); const kp = await deriveKey(p1, salt);
      if (DB.decoy) { await new Promise(r => setTimeout(r, 120)); S.cfg.panicMode = m; await save(); closeSheet(); route(); toast('🚨 PIN de pânico ativo'); return; } // cofre falso: só aparência
      meta.p = {salt: b64(salt), check: await seal(kp, enc.encode(m === 'wipe' ? P_WIPE : P_DECOY))};
      await DB.clear(DB.alt); // cofre falso recomeça vazio a cada novo PIN de pânico
      await DB.set('meta', meta, DB.main); S.cfg.panicMode = m; await save(); closeSheet(); route(); toast('🚨 PIN de pânico ativo');
    };
    const off = s.querySelector('#pp_off'); if (off) off.onclick = async () => {
      if (!await confirmBox('Desativar o PIN de pânico? O cofre falso será apagado.', 'Desativar', true)) return;
      if (DB.decoy) { delete S.cfg.panicMode; await save(); route(); toast('PIN de pânico desativado'); return; }
      const meta = await DB.get('meta', DB.main); delete meta.p; await DB.set('meta', meta, DB.main); await DB.clear(DB.alt); delete S.cfg.panicMode; await save(); route(); toast('PIN de pânico desativado');
    };
  });
}

/* ============ v0.5 — Backup e lembrete ============ */
async function doBackup() {
  toast('Montando backup…');
  const keys = (await DB.keys()).filter(k => k.startsWith('img:') || k.startsWith('aud:')); const imgs = {};
  for (const k of keys) imgs[k] = await DB.get(k);
  const m = await DB.get('meta', DB.main);
  const meta = DB.decoy ? {salt: m.p.salt, check: m.p.check, v: 1} : {salt: m.salt, check: m.check, v: 1, ...(m.p ? {p: m.p} : {})};
  const f = new File([JSON.stringify({app: 'opsvault', v: 2, ver: APP_VER, ts: Date.now(), meta, data: await DB.get('data'), imgs})], `OpsVault_backup_${fileStamp()}.cofre`, {type: 'application/json'});
  if (await shareFile(f)) { S.cfg.lastBackup = Date.now(); delete S.cfg.bkSnooze; await save(); return true; }
  return false;
}
function backupOverdue() {
  const d = +S.cfg.bkDays; if (!d) return false;
  if (!S.ops.length && !S.alvos.length) return false;
  if (S.cfg.bkSnooze && S.cfg.bkSnooze > Date.now()) return false;
  const ref = S.cfg.lastBackup || S.cfg.since; // cofre criado na v0.5 conta a partir da criação; dados antigos sem backup já avisam
  return !ref || Date.now() - ref > d * 864e5;
}

/* ============ v0.5 — Exportar planilha (pipe e CSV) ============ */
const pipeCell = v => String(v ?? '').replace(/\s*[|\r\n]+\s*/g, ' ').trim();
const PRIO_TXT = {alta: 'alta', media: 'média', baixa: 'baixa'};
const SITU = {preso: ['c-red', 'Preso'], foragido: ['c-amb', 'Foragido'], monitorado: ['c-blue', 'Monitorado'], solto: ['c-grn', 'Solto'], outro: ['c-gray', 'Outro']};
const situTxt = a => a.situacao ? (a.situacao === 'outro' && a.situacaoOutro ? 'Outro: ' + a.situacaoOutro : (SITU[a.situacao] || SITU.outro)[1]) : '';
const MAND_ST = {aberto: 'Em aberto', cumprido: 'Cumprido', revogado: 'Revogado', suspenso: 'Suspenso', outro: 'Outro'};
const mandTxt = m => [m.num, MAND_ST[m.status] || m.status, m.data ? new Date(m.data + 'T12:00').toLocaleDateString('pt-BR') : ''].filter(Boolean).join(' — ');
/* local principal para lat/lng: o “Endereço importado”, senão a 1ª residência */
const mainLoc = a => (a.locais || []).find(l => l.titulo === 'Endereço importado') || (a.locais || []).find(l => l.tipo === 'residencia') || null;
function pipeRows(alvos) {
  return [BATCH_HEADER, ...alvos.map(a => { const l = mainLoc(a);
    return [getOp(a.opId)?.nome, a.nome, a.apelido, a.doc, (a.tels || []).map(t => pipeCell(t).replace(/;/g, ',')).join(';'), a.veic, a.end, a.vinc, PRIO_TXT[a.prio] || 'média', l ? String(l.lat) : '', l ? String(l.lng) : ''].map((v, i) => i === 4 ? v : pipeCell(v)).join('|'); })].join('\n') + '\n';
}
const csvCell = (v, num) => { let s = String(v ?? ''); if (!num && /^[=+@\t\r-]/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s)) s = "'" + s; return /[";\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
function csvRows(alvos) {
  const H = ['operação', 'nome', 'vulgo', 'documento', 'telefones', 'veículo', 'endereço', 'vínculos', 'prioridade', 'lat', 'lng', 'situação', 'redes sociais', 'mandados', 'vínculos com alvos', 'fotos', 'locais', 'áudios', 'cadastrado em', 'etiquetas', 'nascimento', 'filiação'];
  const rows = alvos.map(a => { const l = mainLoc(a);
    return [getOp(a.opId)?.nome, a.nome, a.apelido, a.doc, (a.tels || []).join(' / '), a.veic, a.end, a.vinc, PRIO_TXT[a.prio] || 'média', l ? l.lat : '', l ? l.lng : '', situTxt(a), (a.redes || []).join(' / '), (a.mandados || []).map(mandTxt).join(' / '),
      linksOf(a.id).map(x => `${x.other ? x.other.nome : '?'} (${x.rel})`).join(' / '), (a.fotos || []).length, (a.locais || []).length, (a.audios || []).length, a.ts ? fmt(a.ts) : '', (a.tags || []).join(' / '), a.nasc ? dateBR(a.nasc) : '', String(a.filiacao || '').split('\n').map(x => x.trim()).filter(Boolean).join(' / ')].map((v, i) => csvCell(v, i === 9 || i === 10)).join(';'); });
  return '\uFEFF' + [H.join(';'), ...rows].join('\r\n') + '\r\n';
}
function planilhaUI(opId) {
  const op = opId ? getOp(opId) : null; const alvos = op ? S.alvos.filter(a => a.opId === op.id) : S.alvos;
  let f = 'pipe';
  sheet(`<h2 style="margin-top:0">📊 Exportar planilha</h2><div class="sub">${op ? esc(op.nome) : 'Todas as operações'} · ${alvos.length} alvo(s)</div>
    <div class="seg glass" style="margin-top:14px"><div data-f="pipe" class="on">Texto com | (.txt)</div><div data-f="csv">CSV (Excel)</div></div>
    <div class="sub" id="pl_d" style="margin:10px 4px;line-height:1.45"></div>
    <div class="warn">⚠️ A planilha sai <b>sem criptografia</b> e sem máscara. Use só para migrar ou conferir dados.</div>
    <div class="btn pri" id="pl_go">Gerar e compartilhar</div>`, s => {
    const d = () => s.querySelector('#pl_d').innerHTML = f === 'pipe' ? 'Mesmo formato da <b>importação em lote</b> (11 campos separados por |, telefones por ;). Pode ser importado de volta sem perdas nesses campos.' : 'UTF-8 com BOM, separador <b>;</b> (Excel pt-BR). Inclui também situação, redes sociais, mandados e vínculos entre alvos.';
    d(); s.querySelectorAll('.seg div').forEach(x => x.onclick = () => { s.querySelectorAll('.seg div').forEach(y => y.classList.remove('on')); x.classList.add('on'); f = x.dataset.f; d(); });
    s.querySelector('#pl_go').onclick = async () => {
      const base = `OpsVault_planilha_${op ? slug(op.nome) : 'todas'}_${fileStamp()}`;
      const file = f === 'pipe' ? new File([pipeRows(alvos)], base + '.txt', {type: 'text/plain'}) : new File([csvRows(alvos)], base + '.csv', {type: 'text/csv'});
      closeSheet(); await shareFile(file);
    };
  });
}

/* ============ v0.5 — Vínculos entre alvos ============ */
const REL_SUG = ['irmão', 'irmã', 'pai', 'mãe', 'filho(a)', 'cônjuge', 'companheiro(a)', 'primo(a)', 'sócio', 'comparsa', 'amigo', 'vizinho', 'funcionário', 'chefe', 'advogado', 'fornecedor', 'cliente'];
/* Cada vínculo é guardado uma vez (S.links) e exibido nos dois alvos */
function linksOf(id) {
  return (S.links || []).filter(l => l.a === id || l.b === id).map(l => ({...l, out: l.a === id, other: getAlvo(l.a === id ? l.b : l.a)})).filter(x => x.other);
}
function linkSheet(a, edit) {
  const others = S.alvos.filter(x => x.id !== a.id);
  if (!others.length) return toast('Cadastre outro alvo para criar um vínculo');
  const byOp = S.ops.map(o => [o, others.filter(x => x.opId === o.id)]).filter(([, l]) => l.length);
  const sel = edit ? (edit.a === a.id ? edit.b : edit.a) : '';
  sheet(`<h2 style="margin-top:0">${edit ? 'Editar vínculo' : '🔗 Vincular a outro alvo'}</h2><div class="sub">${esc(a.nome)} ↔ …</div>
    <label>Alvo</label><select id="lk_t">${byOp.map(([o, l]) => `<optgroup label="${esc(o.nome)}">${l.map(x => `<option value="${x.id}" ${x.id === sel ? 'selected' : ''}>${esc(x.nome)}${x.apelido ? ' “' + esc(x.apelido) + '”' : ''}</option>`).join('')}</optgroup>`).join('')}</select>
    <label>Relação (texto livre)</label><input id="lk_r" list="lk_dl" value="${esc(edit?.rel)}" placeholder="Ex.: irmão, sócio, comparsa"><datalist id="lk_dl">${REL_SUG.map(r => `<option value="${r}">`).join('')}</datalist>
    <div class="chips" style="margin-top:8px">${REL_SUG.slice(0, 10).map(r => `<span class="chip c-gray rs" data-r="${r}">${r}</span>`).join('')}</div>
    <div class="gap"></div><div class="btn pri" id="lk_ok">Salvar vínculo</div>
    ${edit ? '<div class="btn dan" id="lk_del" style="margin-top:10px">Remover vínculo</div>' : ''}`, s => {
    s.querySelectorAll('.rs').forEach(c => c.onclick = () => s.querySelector('#lk_r').value = c.dataset.r);
    s.querySelector('#lk_ok').onclick = async () => {
      const to = s.querySelector('#lk_t').value, rel = s.querySelector('#lk_r').value.trim();
      if (!to) return toast('Escolha o alvo'); if (!rel) return toast('Informe a relação');
      const dup = S.links.find(l => l.id !== edit?.id && ((l.a === a.id && l.b === to) || (l.b === a.id && l.a === to)));
      if (dup) { dup.rel = rel; if (edit) S.links = S.links.filter(l => l.id !== edit.id); }
      else if (edit) { const L_ = S.links.find(l => l.id === edit.id); Object.assign(L_, {a: a.id, b: to, rel}); }
      else S.links.push({id: uid(), a: a.id, b: to, rel, ts: Date.now()});
      a.log.push({ts: Date.now(), t: `Vínculo: ${rel} — ${getAlvo(to).nome}`});
      await save(); closeSheet(); route(); toast('🔗 Vínculo salvo');
    };
    const d = s.querySelector('#lk_del'); if (d) d.onclick = async () => { S.links = S.links.filter(l => l.id !== edit.id); await save(); closeSheet(); route(); toast('Vínculo removido'); };
  });
}
/* Gráfico de vínculos da operação: layout de forças simples em SVG, sem bibliotecas */
function grafoLayout(nodes, edges, W, H) {
  const n = nodes.length; const P = nodes.map((_, i) => ({x: W / 2 + Math.cos(2 * Math.PI * i / n) * W * .35, y: H / 2 + Math.sin(2 * Math.PI * i / n) * H * .35}));
  if (n < 2) { if (n) P[0] = {x: W / 2, y: H / 2}; return P; }
  const idx = new Map(nodes.map((x, i) => [x.id, i])); const k = Math.sqrt(W * H / n) * .75;
  for (let it = 0; it < 260; it++) {
    const D = P.map(() => ({x: 0, y: 0})); const t = (1 - it / 260) * 18 + 1;
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d = Math.max(1, Math.hypot(dx, dy)), f = k * k / d / d; D[i].x += dx * f; D[i].y += dy * f; D[j].x -= dx * f; D[j].y -= dy * f; }
    edges.forEach(e => { const i = idx.get(e.a), j = idx.get(e.b); const dx = P[i].x - P[j].x, dy = P[i].y - P[j].y, d = Math.max(1, Math.hypot(dx, dy)), f = d / k; D[i].x -= dx * f / d * 1; D[i].y -= dy * f / d; D[j].x += dx * f / d; D[j].y += dy * f / d; });
    P.forEach((p, i) => { D[i].x += (W / 2 - p.x) * .01; D[i].y += (H / 2 - p.y) * .01; const m = Math.hypot(D[i].x, D[i].y) || 1; p.x += D[i].x / m * Math.min(m, t); p.y += D[i].y / m * Math.min(m, t); });
  }
  const xs = P.map(p => p.x), ys = P.map(p => p.y), pad = 46; const mx = Math.min(...xs), Mx = Math.max(...xs), my = Math.min(...ys), My = Math.max(...ys);
  return P.map(p => ({x: pad + (Mx - mx ? (p.x - mx) / (Mx - mx) : .5) * (W - 2 * pad), y: pad + (My - my ? (p.y - my) / (My - my) : .5) * (H - 2 * pad)}));
}
/* rótulo curto: primeiro + último nome (“Fulano de Tal” → “Fulano Tal”) */
const gName = n => { const w = String(n || '').trim().split(/\s+/); return (w.length > 2 ? w[0] + ' ' + w[w.length - 1] : w.join(' ')).slice(0, 22); };
function viewGrafo(opId) {
  tabs('ops'); const op = getOp(opId); if (!op) return location.hash = '#ops';
  const inOp = S.alvos.filter(a => a.opId === opId); const ids = new Set(inOp.map(a => a.id));
  const edges = S.links.filter(l => (ids.has(l.a) || ids.has(l.b)) && getAlvo(l.a) && getAlvo(l.b));
  const ext = []; edges.forEach(l => [l.a, l.b].forEach(x => { if (!ids.has(x) && !ext.some(e => e.id === x)) ext.push(getAlvo(x)); }));
  const nodes = [...inOp, ...ext]; const W = 354, H = Math.max(380, Math.min(620, 120 + nodes.length * 34));
  const P = grafoLayout(nodes, edges, W, H); const at = new Map(nodes.map((x, i) => [x.id, P[i]]));
  const col = a => ({preso: '#ff6b6b', foragido: '#ffa94d', monitorado: '#5b8fff', solto: '#3cd290'}[a.situacao] || (a.prio === 'alta' ? '#ff9a9a' : '#8a9bb8'));
  const svg = `<svg id="grafo" viewBox="0 0 ${W} ${H}" width="100%" style="display:block">
    ${edges.map(l => { const p = at.get(l.a), q = at.get(l.b); return `<line x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}" stroke="rgba(156,188,255,.45)" stroke-width="1.6"/><text x="${(p.x + q.x) / 2}" y="${(p.y + q.y) / 2 - 3}" class="gl">${esc(l.rel)}</text>`; }).join('')}
    ${nodes.map(a => { const p = at.get(a.id), e = !ids.has(a.id); return `<g class="gn" data-id="${a.id}" style="cursor:pointer"><circle cx="${p.x}" cy="${p.y}" r="${e ? 11 : 15}" fill="${col(a)}" fill-opacity="${e ? .35 : .85}" stroke="#fff" stroke-opacity=".6" ${e ? 'stroke-dasharray="3 2"' : ''}/><text x="${p.x}" y="${p.y + 28}" class="gt">${esc(gName(a.nome))}</text></g>`; }).join('')}
  </svg>`;
  APP.innerHTML = `<div class="back" onclick="location.hash='#op/${op.id}'">‹ ${esc(op.nome)}</div><h1>Vínculos</h1>
  <div class="sub" style="margin:4px 4px 12px">${inOp.length} alvo(s) · ${edges.length} vínculo(s)${ext.length ? ` · ${ext.length} de outras operações (tracejado)` : ''}. Toque num alvo para abrir.</div>
  <div class="card glass" style="cursor:default;padding:6px">${nodes.length ? svg : '<div class="empty">Sem alvos.</div>'}</div>
  <div class="sub" style="margin:8px 4px">🔴 preso · 🟠 foragido · 🔵 monitorado · 🟢 solto · ⚪ sem situação</div>
  <h2>Lista</h2>${edges.length ? edges.map(l => `<div class="card glass" style="cursor:default;padding:10px 14px"><b>${esc(getAlvo(l.a).nome)}</b> <span class="sub">— ${esc(l.rel)} —</span> <b>${esc(getAlvo(l.b).nome)}</b></div>`).join('') : '<div class="sub" style="margin:0 4px">Nenhum vínculo. Na ficha do alvo, use “Vincular”.</div>'}`;
  APP.querySelectorAll('.gn').forEach(g => g.onclick = () => location.hash = '#alvo/' + g.dataset.id);
}

/* ============ v0.5 — Foto do documento (separada da galeria) ============ */
function docFotoMenu(a) {
  sheet(`<h2 style="margin-top:0">🪪 Foto do documento</h2><div class="sub">Fica separada das fotos do alvo (não entra na galeria nem vira capa).</div>
    <div class="btn pri" id="df_cam" style="margin-top:14px">📷 Fotografar documento</div><div class="btn" id="df_alb" style="margin-top:10px">🖼️ Escolher imagem</div>
    ${a.docFoto ? '<div class="btn dan" id="df_del" style="margin-top:10px">Remover foto do documento</div>' : ''}`, s => {
    const got = async file => {
      toast('Criptografando…');
      try { const bytes = await resizeJpeg(file, 2000); const id = uid(); await putImg(id, new Uint8Array(bytes));
        if (a.docFoto) await dropImg(a.docFoto.id);
        a.docFoto = {id, ts: Date.now(), hash: await sha256(bytes)}; a.log.push({ts: Date.now(), t: 'Foto do documento registrada'}); await save(); route(); toast('🪪 Documento salvo'); }
      catch (e) { toast('Erro: ' + e.message); }
    };
    s.querySelector('#df_cam').onclick = () => { closeSheet(); const inp = $('#cam'); inp.value = ''; hold(180000); inp.oncancel = () => release(); inp.onchange = () => { release(); const f = inp.files[0]; if (f) got(f); }; inp.click(); };
    s.querySelector('#df_alb').onclick = () => { closeSheet(); pickFile('image/*', got); };
    const d = s.querySelector('#df_del'); if (d) d.onclick = async () => { closeSheet(); if (!await confirmBox('Remover a foto do documento?', 'Remover', true)) return; await dropImg(a.docFoto.id); delete a.docFoto; await save(); route(); };
  });
}
async function docViewer(a) {
  const u = await getImg(a.docFoto.id); const d = document.createElement('div'); d.className = 'viewer';
  d.innerHTML = `<div class="vimg"><img src="${u}"></div><div class="glass" style="margin-top:14px;padding:12px 16px;font-size:13px;line-height:1.6">🪪 Foto do documento · ${fmt(a.docFoto.ts)}<br><span class="sub">SHA-256: ${a.docFoto.hash.slice(0, 32)}…</span></div><div class="btn" id="dv_x" style="margin-top:14px;width:100%;max-width:420px">Fechar</div>`;
  document.body.appendChild(d); d.querySelector('#dv_x').onclick = () => d.remove();
}

/* ============ Stage C — Carimbo, Áudio, Discreto ============ by @aiforge.team */
const durTxt = s => { s = Math.round(+s || 0); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

/* ---------- Carimbo na foto (burn-in) ---------- */
/* Desenha a imagem num canvas e queima uma barra inferior com data/hora, coordenadas (ou "sem GPS"),
   operação e alvo. Devolve uma CÓPIA em JPEG; o original é preservado à parte. */
function stampLines(a, ts, pos, note) {
  const op = getOp(a.opId);
  return [fmt(ts) + (note || ''), pos && pos.lat != null ? `📍 ${(+pos.lat).toFixed(5)}, ${(+pos.lng).toFixed(5)}${pos.acc != null ? ` (±${pos.acc} m)` : ''}` : '📍 sem GPS', `${op ? op.nome + ' · ' : ''}${a.nome}`];
}
function stampPhoto(bytes, lines) {
  return new Promise((res, rej) => {
    const img = new Image(), u = URL.createObjectURL(new Blob([bytes], {type: 'image/jpeg'}));
    img.onload = () => {
      const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
      const W = c.width, fs = Math.max(15, Math.round(W / 36)), pad = Math.round(fs * .7), lh = Math.round(fs * 1.34), bh = pad * 2 + lh * lines.length;
      const grad = g.createLinearGradient(0, c.height - bh, 0, c.height); grad.addColorStop(0, 'rgba(0,0,0,.58)'); grad.addColorStop(1, 'rgba(0,0,0,.82)');
      g.fillStyle = grad; g.fillRect(0, c.height - bh, W, bh);
      g.fillStyle = '#5b8fff'; g.fillRect(0, c.height - bh, Math.round(fs * .5), bh);
      g.textBaseline = 'top'; let y = c.height - bh + pad;
      lines.forEach((ln, i) => { g.font = `${i === 0 ? '700 ' : '400 '}${fs}px -apple-system, Roboto, Arial, sans-serif`; g.lineWidth = Math.max(2, fs / 7); g.strokeStyle = 'rgba(0,0,0,.6)'; g.fillStyle = i === 0 ? '#fff' : 'rgba(235,242,255,.95)'; g.strokeText(ln, pad * 2, y); g.fillText(ln, pad * 2, y); y += lh; });
      URL.revokeObjectURL(u); c.toBlob(b => b ? b.arrayBuffer().then(res) : rej(new Error('carimbo falhou')), 'image/jpeg', .9);
    };
    img.onerror = () => rej(new Error('imagem inválida para carimbo')); img.src = u;
  });
}
/* Grava a cópia carimbada e devolve {id, hash} para f.carimbo; recebe os bytes JÁ redimensionados. */
async function makeStamp(a, bytes, ts, pos, note) {
  const st = await stampPhoto(bytes, stampLines(a, ts, pos, note)); const id = uid();
  await putImg(id, new Uint8Array(st)); return {id, hash: await sha256(st), ts: Date.now()};
}
/* id da imagem a exibir/exportar: carimbada quando existir */
const dispId = f => (f && f.carimbo && f.carimbo.id) || (f && f.id);

/* ---------- Anotação em áudio (MediaRecorder) ---------- */
const audioCache = new Map();
function audMime() {
  // iPhone/iPad (inclusive iPadOS que se diz Mac): mp4/AAC; demais: webm/opus
  const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const C = ios ? ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'] : ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'];
  for (const m of C) { try { if (window.MediaRecorder && MediaRecorder.isTypeSupported(m)) return m; } catch (e) {} }
  return '';
}
async function putAud(id, bytes) { await DB.set('aud:' + id, await seal(KEY, bytes)); }
async function getAud(id, mime) {
  if (audioCache.has(id)) return audioCache.get(id);
  const box = await DB.get('aud:' + id); if (!box) return null;
  const url = URL.createObjectURL(new Blob([await open_(KEY, box)], {type: mime || 'audio/mp4'}));
  audioCache.set(id, url); return url;
}
function dropAud(id) { if (!id) return Promise.resolve(); if (audioCache.has(id)) { URL.revokeObjectURL(audioCache.get(id)); audioCache.delete(id); } return DB.del('aud:' + id); }
const AUD_MAX = 600; // 10 min
let REC = null, PLAYER = null;
function stopRecorder() { if (!REC) return; try { clearInterval(REC.timer); } catch (e) {} try { if (REC.mr && REC.mr.state !== 'inactive') { REC.discard = true; REC.mr.stop(); } } catch (e) {} try { REC.stream && REC.stream.getTracks().forEach(t => t.stop()); } catch (e) {} REC = null; }
function stopPlayer() { if (!PLAYER) return; try { PLAYER.el.pause(); } catch (e) {} PLAYER = null; document.querySelectorAll('.aud-pp').forEach(b => b.textContent = '▶'); }
function recordAudio(holder, kind, opts) {
  const inbox = !!(opts && opts.onSave); const isAlvo = !inbox && (kind === 'alvo' || (holder.opId !== undefined));
  const mime = audMime();
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || !window.MediaRecorder || !mime)
    return toast('Gravação de áudio não suportada neste navegador');
  sheet(`<h2 style="margin-top:0">🎙️ Gravar áudio</h2>
    <div class="sub">${inbox ? `Vai para <b>Rascunhos</b> · ${esc(opts.label || 'Caixa geral')}` : `${isAlvo ? 'Anexado ao alvo' : 'Anexado à operação'}: <b>${esc(holder.nome)}</b>`}. Máximo ${durTxt(AUD_MAX)}.</div>
    ${isAlvo && getOp(holder.opId) ? `<label>Anexar em</label><select id="ra_dest"><option value="alvo">Alvo: ${esc(holder.nome)}</option><option value="op">Operação: ${esc(getOp(holder.opId).nome)}</option></select>` : ''}
    <div class="rec-ui"><div class="rec-dot" id="ra_dot"></div><div class="rec-time" id="ra_t">0:00</div></div>
    <label>Título (opcional)</label><input id="ra_ti" placeholder="Ex.: relato da campana">
    <div class="gap"></div><div class="grid2"><div class="btn" id="ra_cn">Cancelar</div><div class="btn pri" id="ra_go">● Gravar</div></div>`, s => {
    let state = 'idle';
    const btn = s.querySelector('#ra_go'), tEl = s.querySelector('#ra_t');
    s.querySelector('#ra_cn').onclick = () => { stopRecorder(); closeSheet(); };
    btn.onclick = async () => {
      if (state === 'idle') {
        let stream; try { stream = await navigator.mediaDevices.getUserMedia({audio: true}); }
        catch (e) { return toast('Microfone negado ou indisponível'); }
        hold(AUD_MAX * 1000 + 30000); const chunks = []; let mr;
        try { mr = new MediaRecorder(stream, {mimeType: mime}); } catch (e) { try { mr = new MediaRecorder(stream); } catch (e2) { stream.getTracks().forEach(t => t.stop()); return toast('Não foi possível gravar'); } }
        REC = {mr, stream, chunks, t0: Date.now(), timer: null, discard: false};
        mr.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
        mr.onstop = async () => {
          const rec = REC; clearInterval(rec && rec.timer); try { stream.getTracks().forEach(t => t.stop()); } catch (e) {}
          const discard = !rec || rec.discard; const dur = rec ? Math.round((Date.now() - rec.t0) / 1000) : 0; REC = null;
          if (discard || !chunks.length || !KEY) { release(); return; }
          const blob = new Blob(chunks, {type: mime}); const bytes = new Uint8Array(await blob.arrayBuffer());
          const id = uid(); await putAud(id, bytes);
          if (inbox) { await opts.onSave({id, ts: Date.now(), dur, mime, size: bytes.length, hash: await sha256(bytes), titulo: s.querySelector('#ra_ti').value.trim()}); release(); closeSheet(); route(); toast('📥 Áudio em Rascunhos'); return; }
          const dest = (s.querySelector('#ra_dest') && s.querySelector('#ra_dest').value) || (isAlvo ? 'alvo' : 'op');
          const h = dest === 'op' ? getOp(holder.opId) : holder;
          h.audios = h.audios || []; h.audios.push({id, ts: Date.now(), dur, mime, size: bytes.length, hash: await sha256(bytes), titulo: s.querySelector('#ra_ti').value.trim()});
          if (h.log) h.log.push({ts: Date.now(), t: `Áudio gravado (${durTxt(dur)})`});
          await save(); release(); closeSheet(); route(); toast('🎙️ Áudio salvo');
        };
        mr.start(); state = 'rec'; s.querySelector('#ra_dot').classList.add('on'); btn.textContent = '■ Parar'; btn.classList.add('dan'); btn.classList.remove('pri');
        REC.timer = setInterval(() => { const d = Math.round((Date.now() - REC.t0) / 1000); tEl.textContent = durTxt(d); if (d >= AUD_MAX) btn.click(); }, 250);
      } else if (state === 'rec') { state = 'done'; btn.disabled = true; btn.textContent = 'Salvando…'; try { REC.mr.stop(); } catch (e) {} }
    };
  });
}
async function audioList(el, holder) {
  if (!el) return; const list = holder.audios || [];
  if (!list.length) { el.innerHTML = '<div class="sub" style="margin:0 4px">Nenhum áudio.</div>'; return; }
  el.innerHTML = `<div class="card glass list" style="cursor:default;padding:0">${list.slice().sort((a, b) => b.ts - a.ts).map(x => `<div class="li aud-row"><span style="display:flex;align-items:center;gap:12px"><b class="aud-pp" data-id="${x.id}" data-mime="${esc(x.mime || '')}" style="cursor:pointer;font-size:20px;width:26px;text-align:center">▶</b><span>${x.titulo ? `<b style="font-weight:600">${esc(x.titulo)}</b><br>` : ''}<span class="sub">${fmt(x.ts)} · ${durTxt(x.dur)}${x.size ? ' · ' + Math.max(1, Math.round(x.size / 1024)) + ' KB' : ''}</span></span></span><b class="aud-del" data-id="${x.id}" style="cursor:pointer;color:#ff9a9a">🗑️</b></div>`).join('')}</div>`;
  // descriptografa antes do toque: no iPhone o play() precisa acontecer dentro do próprio toque
  list.forEach(x => getAud(x.id, x.mime).catch(() => {}));
  el.querySelectorAll('.aud-pp').forEach(b => b.onclick = async () => {
    const id = b.dataset.id;
    if (PLAYER && PLAYER.id === id) { if (PLAYER.el.paused) { PLAYER.el.play(); b.textContent = '⏸'; } else { PLAYER.el.pause(); b.textContent = '▶'; } return; }
    stopPlayer(); const url = audioCache.get(id) || await getAud(id, b.dataset.mime); if (!url) return toast('Áudio indisponível');
    const au = new Audio(url); PLAYER = {id, el: au}; b.textContent = '⏸';
    au.onended = () => { b.textContent = '▶'; if (PLAYER && PLAYER.id === id) PLAYER = null; };
    au.play().catch(() => { toast('Falha ao tocar'); b.textContent = '▶'; });
  });
  el.querySelectorAll('.aud-del').forEach(b => b.onclick = async () => {
    const id = b.dataset.id; if (!await confirmBox('Excluir este áudio?', 'Excluir', true)) return;
    if (PLAYER && PLAYER.id === id) stopPlayer();
    holder.audios = holder.audios.filter(x => x.id !== id); await dropAud(id); await save(); route(); toast('Áudio excluído');
  });
}

/* ============ v0.5 — Relatório PDF da operação inteira — by @aiforge.team ============ */
/* Só usa dados existentes no cofre aberto (no cofre falso, só os dados dele). Nada é inventado:
   campos vazios aparecem como “—” e seções sem dados dizem “nenhum registro”. */
const pdfSafe = s => String(s ?? '').replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/↔/g, '-').trim();
const SITU_ORD = ['preso', 'foragido', 'monitorado', 'solto', 'outro', ''];
function opReportData(opId) {
  const op = getOp(opId); const alvos = S.alvos.filter(a => a.opId === opId); const ids = new Set(alvos.map(a => a.id));
  const links = (S.links || []).filter(l => (ids.has(l.a) || ids.has(l.b)) && getAlvo(l.a) && getAlvo(l.b));
  const areas = (S.areas || []).filter(ar => ar.opId === opId);
  const ev = [];
  alvos.forEach(a => {
    if (a.ts) ev.push({ts: a.ts, k: 'Cadastro', t: `Alvo cadastrado: ${a.nome}`});
    (a.fotos || []).forEach(f => ev.push({ts: f.ts, k: 'Foto', t: `${a.nome} — ${f.legenda || (isAlbum(f) ? 'foto do álbum' : 'foto da câmera')}${f.lat != null ? ' · ' + coord(f) : ' · sem GPS'}${isAlbum(f) && f.dataExif === false ? ' (sem data na foto; data de importação)' : ''}`}));
    (a.locais || []).forEach(l => ev.push({ts: l.ts, k: 'Local', t: `${a.nome} — ${(TIPOS[l.tipo] || TIPOS.outro)[1]}${l.titulo ? ': ' + l.titulo : ''} · ${coord(l)}`}));
    (a.audios || []).forEach(x => ev.push({ts: x.ts, k: 'Áudio', t: `${a.nome} — ${x.titulo || 'áudio'} (${durTxt(x.dur)})`}));
    (a.notas || []).forEach(n => ev.push({ts: n.ts, k: 'Anotação', t: `${a.nome} — ${n.txt}`}));
    (a.mandados || []).forEach(m => { if (m.data) { const t = new Date(m.data + 'T12:00').getTime(); if (isFinite(t)) ev.push({ts: t, k: 'Mandado', t: `${a.nome} — ${mandTxt(m)}`, dia: true}); } });
  });
  (op.audios || []).forEach(x => ev.push({ts: x.ts, k: 'Áudio', t: `Operação — ${x.titulo || 'áudio'} (${durTxt(x.dur)})`}));
  areas.forEach(ar => { if (ar.ts) ev.push({ts: ar.ts, k: 'Área', t: `Área criada: ${ar.nome || 'sem nome'}`}); });
  (op.diario || []).forEach(e => ev.push({ts: e.ts, k: 'Vigilância', t: vigTxt(op, e) + (e.lat != null ? ' · ' + coord(e) : '')}));
  (op.trajetos || []).filter(t => t.pts.length > 1).forEach(t => ev.push({ts: t.ini, k: 'Trajeto', t: `Trajeto gravado · ${distTxt(trackDist(t))} · ${durHM(trackDur(t))} · ${t.pts.length} pontos`}));
  ev.sort((x, y) => x.ts - y.ts);
  const sit = {}; alvos.forEach(a => { const k = a.situacao || ''; sit[k] = (sit[k] || 0) + 1; });
  const cnt = {alvos: alvos.length, locais: alvos.reduce((s, a) => s + (a.locais || []).length, 0), areas: areas.length, fotos: alvos.reduce((s, a) => s + (a.fotos || []).length, 0),
    fotosCarimbo: alvos.reduce((s, a) => s + (a.fotos || []).filter(f => f.carimbo).length, 0), audios: alvos.reduce((s, a) => s + (a.audios || []).length, 0) + (op.audios || []).length,
    vinculos: links.length, mandados: alvos.reduce((s, a) => s + (a.mandados || []).length, 0),
    vigSess: (op.vig || []).length, vigReg: (op.diario || []).length, traj: (op.trajetos || []).filter(t => t.pts.length > 1).length, trajDist: (op.trajetos || []).reduce((s, t) => s + trackDist(t), 0), trajDur: (op.trajetos || []).reduce((s, t) => s + trackDur(t), 0),
    pendAbertas: alvos.reduce((s, a) => s + (a.pend || []).filter(p => !p.done).length, 0), pendAtrasadas: alvos.reduce((s, a) => s + (a.pend || []).filter(p => pendState(p) === 'atrasada').length, 0), pendTotal: alvos.reduce((s, a) => s + (a.pend || []).length, 0)};
  const ts = ev.filter(e => isFinite(e.ts)).map(e => e.ts);
  const cruz = xForOp(opId); cnt.cruz = cruz.length;
  return {op, alvos, links, areas, ev, sit, cnt, cruz, periodo: ts.length ? [Math.min(...ts), Math.max(...ts)] : null};
}
/* Gráfico de vínculos desenhado num canvas claro (para impressão) → PNG */
function grafoPng(alvos, links) {
  const ids = new Set(alvos.map(a => a.id)); const ext = [];
  links.forEach(l => [l.a, l.b].forEach(x => { if (!ids.has(x) && !ext.some(e => e.id === x)) ext.push(getAlvo(x)); }));
  const nodes = [...alvos.filter(a => links.some(l => l.a === a.id || l.b === a.id)), ...ext]; if (nodes.length < 2) return null;
  const W = 900, H = Math.max(420, Math.min(760, 200 + nodes.length * 40)); const P = grafoLayout(nodes, links, W, H); const at = new Map(nodes.map((x, i) => [x.id, P[i]]));
  const c = document.createElement('canvas'); c.width = W * 2; c.height = H * 2; const g = c.getContext('2d'); g.scale(2, 2);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, W, H);
  const col = a => ({preso: '#d94848', foragido: '#e08a2c', monitorado: '#3f6fd8', solto: '#2aa56f'}[a.situacao] || '#8a96a8');
  g.lineWidth = 1.6; g.strokeStyle = '#9fb0cc'; g.font = '13px Helvetica, Arial, sans-serif'; g.textAlign = 'center';
  links.forEach(l => { const p = at.get(l.a), q = at.get(l.b); g.beginPath(); g.moveTo(p.x, p.y); g.lineTo(q.x, q.y); g.stroke(); });
  links.forEach(l => { const p = at.get(l.a), q = at.get(l.b), t = String(l.rel || ''), mx = (p.x + q.x) / 2, my = (p.y + q.y) / 2 - 4; const w = g.measureText(t).width + 8; g.fillStyle = 'rgba(255,255,255,.9)'; g.fillRect(mx - w / 2, my - 12, w, 16); g.fillStyle = '#4a5a75'; g.fillText(t, mx, my); });
  nodes.forEach(a => { const p = at.get(a.id), e = !ids.has(a.id); g.beginPath(); g.arc(p.x, p.y, e ? 11 : 15, 0, Math.PI * 2); g.fillStyle = col(a); g.globalAlpha = e ? .45 : 1; g.fill(); g.globalAlpha = 1; g.setLineDash(e ? [3, 2] : []); g.strokeStyle = '#1b2433'; g.lineWidth = 1.2; g.stroke(); g.setLineDash([]); g.fillStyle = '#141820'; g.font = '600 13px Helvetica, Arial, sans-serif'; g.fillText(gName(a.nome) + (e ? ' *' : ''), p.x, p.y + 31); });
  return {url: c.toDataURL('image/png'), w: W, h: H, ext: ext.length};
}
async function buildOpReport(opId, o) {
  const R = opReportData(opId); const {op, alvos, links, areas, ev, sit, cnt} = R;
  const {jsPDF} = window.jspdf; const pdf = new jsPDF({unit: 'mm', format: 'a4'}); const W = 210, M = 14, BOT = 282; let y = 0;
  const T = s => pdfSafe(s); const doc = d => d ? (o.mask ? maskDoc(d) : d) : '—';
  const gray = () => pdf.setTextColor(100, 110, 125), ink = () => pdf.setTextColor(20, 24, 32);
  const header = () => { pdf.setFillColor(8, 14, 26); pdf.rect(0, 0, W, 16, 'F'); pdf.setFontSize(8.5); pdf.setTextColor(156, 188, 255); pdf.text(T(APP_NAME.toUpperCase() + '  ·  RELATÓRIO DA OPERAÇÃO'), M, 7); pdf.setTextColor(255, 255, 255); pdf.setFontSize(11); pdf.text(T(op.nome).slice(0, 80), M, 12.5); pdf.setTextColor(255, 120, 120); pdf.setFontSize(8.5); pdf.text('RESERVADO', W - M, 7, {align: 'right'}); ink(); y = 24; };
  const page = () => { pdf.addPage(); header(); };
  const need = h => { if (y + h > BOT) page(); };
  const title = t => { need(16); y += 2; pdf.setFont(undefined, 'bold'); pdf.setFontSize(12.5); pdf.setTextColor(45, 95, 214); pdf.text(T(t), M, y); y += 2; pdf.setDrawColor(45, 95, 214); pdf.setLineWidth(.4); pdf.line(M, y, W - M, y); y += 6; pdf.setFont(undefined, 'normal'); ink(); pdf.setFontSize(10); };
  const sub = t => { need(18); pdf.setFont(undefined, 'bold'); pdf.setFontSize(10.5); pdf.text(T(t), M, y); pdf.setFont(undefined, 'normal'); pdf.setFontSize(10); y += 5.5; };
  const para = (t, ind = 0, fs = 10, lh = 4.8) => { pdf.setFontSize(fs); pdf.splitTextToSize(T(t), W - 2 * M - ind).forEach(l => { need(lh); pdf.text(l, M + ind, y); y += lh; }); pdf.setFontSize(10); };
  const none = t => { gray(); para(t || 'Nenhum registro.'); ink(); y += 2; };
  const dia = ts => new Date(ts).toLocaleDateString('pt-BR');
  // ---- capa ----
  pdf.setFillColor(8, 14, 26); pdf.rect(0, 0, W, 297, 'F');
  pdf.setTextColor(156, 188, 255); pdf.setFontSize(11); pdf.text(T(APP_NAME.toUpperCase() + '  ·  ' + CREDIT), M + 4, 30);
  pdf.setTextColor(255, 255, 255); pdf.setFontSize(13); pdf.text('Relatório da operação', M + 4, 92);
  pdf.setFont(undefined, 'bold'); pdf.setFontSize(28); const nl = pdf.splitTextToSize(T(op.nome), W - 2 * M - 8); nl.slice(0, 3).forEach((l, i) => pdf.text(l, M + 4, 106 + i * 12)); pdf.setFont(undefined, 'normal');
  let cy = 106 + Math.min(3, nl.length) * 12 + 4;
  pdf.setFontSize(11); pdf.setTextColor(190, 200, 220);
  pdf.text(T(`Status: ${(STATUS[op.status] || STATUS.planejada)[1]}  ·  criada em ${fmt(op.ts)}`), M + 4, cy); cy += 7;
  pdf.text(T(`Gerado em ${fmt(Date.now())}`), M + 4, cy); cy += 7;
  if (op.desc) { pdf.setFontSize(10); pdf.splitTextToSize(T(op.desc), W - 2 * M - 8).slice(0, 6).forEach(l => { pdf.text(l, M + 4, cy); cy += 5.5; }); }
  pdf.setDrawColor(255, 90, 90); pdf.setLineWidth(1.2); pdf.rect(W / 2 - 42, 205, 84, 22); pdf.setTextColor(255, 90, 90); pdf.setFont(undefined, 'bold'); pdf.setFontSize(24); pdf.text('RESERVADO', W / 2, 220, {align: 'center'}); pdf.setFont(undefined, 'normal');
  pdf.setFontSize(9); pdf.setTextColor(150, 160, 180); pdf.text(T(`Documento de uso restrito${o.mask ? ' · documentos mascarados' : ''} · fotos: ${o.fotos ? (o.carimbo ? 'cópias carimbadas quando houver' : 'originais') : 'não incluídas'}`), W / 2, 240, {align: 'center'});
  // ---- resumo executivo ----
  page(); title('Resumo executivo');
  const rows = [['Alvos', cnt.alvos], ['Locais marcados', cnt.locais], ['Áreas no mapa', cnt.areas], ['Fotos', cnt.fotos + (cnt.fotosCarimbo ? ` (${cnt.fotosCarimbo} com cópia carimbada)` : '')], ['Áudios', cnt.audios], ['Vínculos', cnt.vinculos], ['Mandados registrados', cnt.mandados], ['Pendências', `${cnt.pendAbertas} aberta(s)${cnt.pendAtrasadas ? `, ${cnt.pendAtrasadas} atrasada(s)` : ''} de ${cnt.pendTotal}`], ['Vigilância', `${cnt.vigSess} sessão(ões) · ${cnt.vigReg} registro(s)`], ['Trajetos gravados', cnt.traj ? `${cnt.traj} · ${distTxt(cnt.trajDist)} · ${durHM(cnt.trajDur)}` : '0'],
    ['Período coberto pelos dados', R.periodo ? `${fmt(R.periodo[0])} a ${fmt(R.periodo[1])}` : 'sem registros datados']];
  rows.forEach(([k, v]) => { need(6); pdf.text(T(k), M, y); pdf.setFont(undefined, 'bold'); pdf.text(T(String(v)), M + 62, y); pdf.setFont(undefined, 'normal'); y += 6; });
  y += 2; sub('Alvos por situação');
  if (!cnt.alvos) none('Nenhum alvo nesta operação.');
  else SITU_ORD.filter(k => sit[k]).forEach(k => { need(6); pdf.text(T(k ? (SITU[k] || SITU.outro)[1] : 'Sem situação informada'), M + 4, y); pdf.text(String(sit[k]), M + 62, y); y += 5.5; });
  if (op.desc) { y += 3; sub('Descrição'); para(op.desc); }
  if (cnt.cruz) { y += 3; sub('Cruzamentos'); para(`${cnt.cruz} telefone(s)/placa(s) desta operação também aparece(m) em outros alvos ou no diário de vigilância — ver a seção Cruzamentos.`); }
  // ---- quadro de envolvidos ----
  title(`Quadro de envolvidos (${alvos.length})`);
  if (!alvos.length) none();
  else {
    const cols = [['Nome', 42], ['Vulgo', 24], ['Documento', 28], ['Situação', 24], ['Prioridade', 18], ['Mandados', 46]];
    const head = () => { need(9); pdf.setFillColor(228, 235, 248); pdf.rect(M, y - 4.5, W - 2 * M, 7, 'F'); pdf.setFont(undefined, 'bold'); pdf.setFontSize(8.5); let x = M + 1.5; cols.forEach(([h, w]) => { pdf.text(h, x, y); x += w; }); pdf.setFont(undefined, 'normal'); y += 5; };
    head();
    alvos.slice().sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')).forEach((a, i) => {
      const cells = [a.nome + (a.nasc ? '\nNasc. ' + dateBR(a.nasc) : '') + (a.filiacao ? '\nFiliação: ' + String(a.filiacao).split('\n').map(x => x.trim()).filter(Boolean).join('; ') : '') + ((a.tags || []).length ? '\n' + a.tags.map(t => '#' + t).join(' ') : ''), a.apelido || '—', doc(a.doc), situTxt(a) || '—', (PRIO[a.prio] || PRIO.media)[1].replace('Prioridade ', ''), (a.mandados || []).length ? a.mandados.map(mandTxt).join('; ') : '—'];
      pdf.setFontSize(8.5); const wrapped = cells.map((c, j) => pdf.splitTextToSize(T(c), cols[j][1] - 3)); const h = Math.max(...wrapped.map(w => w.length)) * 3.9 + 2.6;
      if (y + h > BOT) { page(); head(); }
      if (i % 2) { pdf.setFillColor(246, 248, 252); pdf.rect(M, y - 3.6, W - 2 * M, h, 'F'); }
      let x = M + 1.5; wrapped.forEach((w, j) => { w.forEach((l, k) => pdf.text(l, x, y + k * 3.9)); x += cols[j][1]; }); y += h;
    });
    pdf.setFontSize(10); y += 3; if (o.mask) { gray(); para('Documentos mascarados (só os 3 primeiros dígitos visíveis).', 0, 8.5); ink(); }
  }
  // ---- vínculos ----
  title(`Vínculos (${links.length})`);
  if (!links.length) none('Nenhum vínculo entre alvos registrado.');
  else {
    links.forEach(l => { const A = getAlvo(l.a), B = getAlvo(l.b); para(`• ${A.nome}${A.opId !== op.id ? ' *' : ''} — ${l.rel} — ${B.nome}${B.opId !== op.id ? ' *' : ''}`, 0, 9.5, 4.6); });
    const g = grafoPng(alvos, links);
    if (g) { const w = W - 2 * M, h = w * g.h / g.w; need(h + 10); y += 2; pdf.setDrawColor(210, 218, 232); pdf.setLineWidth(.3); pdf.rect(M, y, w, h); pdf.addImage(g.url, 'PNG', M, y, w, h); y += h + 4; }
    if (links.some(l => getAlvo(l.a).opId !== op.id || getAlvo(l.b).opId !== op.id)) { gray(); para('* alvo de outra operação', 0, 8.5); ink(); }
    gray(); para('Cores: vermelho preso · laranja foragido · azul monitorado · verde solto · cinza sem situação.', 0, 8.5); ink();
  }
  // ---- cruzamentos ----
  title(`Cruzamentos (${R.cruz.length})`);
  if (!R.cruz.length) none('Nenhum telefone ou placa desta operação aparece em outro alvo ou diário.');
  else {
    R.cruz.forEach(g => { sub(g.k === 'tel' ? `Telefone ${g.val}` : `Placa ${g.label}`);
      g.its.forEach(x => { const xo = getOp(x.opId); para(`• ${xName(x)} (${xo ? xo.nome : '?'})${x.opId !== op.id ? ' *' : ''}${xo && isArq(xo) ? ' [arquivada]' : ''} — ${x.src}: ${[...x.raws].join(' / ')}${x.n_ > 1 ? ` (${x.n_} registros)` : ''}`, 2, 9.5, 4.6); }); y += 1.5; });
    gray(); para('Telefones comparados pelos 8 últimos dígitos e pelo DDD (com ou sem o 9º dígito, +55, 0 e código de operadora); placa antiga e Mercosul equivalentes contam como a mesma. * outra operação. Coincidência não prova vínculo — confirme.', 0, 8.5); ink(); y += 2;
  }
  // ---- linha do tempo ----
  title(`Linha do tempo (${ev.length})`);
  if (!ev.length) none();
  else ev.forEach(e => { pdf.setFontSize(9); const tx = pdf.splitTextToSize(T(e.t), W - 2 * M - 52); need(tx.length * 4.3 + 1); gray(); pdf.text(e.dia ? dia(e.ts) : fmt(e.ts), M, y); pdf.setFont(undefined, 'bold'); pdf.text(T(e.k), M + 30, y); pdf.setFont(undefined, 'normal'); ink(); tx.forEach((l, k) => pdf.text(l, M + 52, y + k * 4.3)); y += tx.length * 4.3 + 1; });
  pdf.setFontSize(10);
  // ---- diário de vigilância ----
  title(`Diário de vigilância (${cnt.vigReg})`);
  if (!(op.vig || []).length && !cnt.traj) none('Nenhuma sessão de vigilância registrada.');
  (op.vig || []).slice().sort((x, z) => x.ini - z.ini).forEach(sx => {
    const al = getAlvo(sx.alvoId), es = (op.diario || []).filter(e => e.sess === sx.id).sort((x, z) => x.ts - z.ts);
    sub(`${sx.titulo || 'Sessão de vigilância'}${al ? ' — ' + al.nome : sx.alvoNome ? ' — ' + sx.alvoNome : ''}`);
    gray(); para(`Início ${fmt(sx.ini)}${sx.fim ? ' · fim ' + fmt(sx.fim) : ' · em andamento'} · ${es.length} registro(s)`, 0, 8.5, 4.2); ink();
    if (!es.length) none('Sem registros.');
    es.forEach(e => { pdf.setFontSize(9); const tx = pdf.splitTextToSize(T(vigTxt(op, e)), W - 2 * M - 52); need(tx.length * 4.3 + 5); gray(); pdf.text(fmt(e.ts), M, y); pdf.setFont(undefined, 'bold'); pdf.text(T((VIG_K[e.k] || VIG_K.obs)[1]), M + 30, y); pdf.setFont(undefined, 'normal'); ink(); tx.forEach((l, k) => pdf.text(l, M + 52, y + k * 4.3)); y += tx.length * 4.3;
      if (e.lat != null) { pdf.setFontSize(8); pdf.setTextColor(45, 95, 214); pdf.textWithLink(`${coord(e)}${accTxt(e)} · abrir no mapa`, M + 52, y, {url: `https://maps.google.com/?q=${e.lat},${e.lng}`}); ink(); y += 3.8; } else { pdf.setFontSize(8); gray(); pdf.text('sem GPS', M + 52, y); ink(); y += 3.8; } y += 1; });
    const tr = (op.trajetos || []).filter(t => t.sess === sx.id && t.pts.length > 1); if (tr.length) { gray(); para(`Trajetos desta sessão: ${tr.map(t => `${fmt(t.ini)} · ${distTxt(trackDist(t))} · ${durHM(trackDur(t))}`).join('; ')}`, 0, 8.5, 4.2); ink(); }
    y += 2;
  });
  if (cnt.traj) { sub(`Trajetos gravados (${cnt.traj})`); (op.trajetos || []).filter(t => t.pts.length > 1).sort((x, z) => x.ini - z.ini).forEach(t => { const a0 = t.pts[0], a1 = t.pts[t.pts.length - 1]; para(`• ${fmt(t.ini)} a ${fmt(t.fim || a1[2])} · ${distTxt(trackDist(t))} · ${durHM(trackDur(t))} · ${t.pts.length} pontos · de ${a0[0].toFixed(5)}, ${a0[1].toFixed(5)} até ${a1[0].toFixed(5)}, ${a1[1].toFixed(5)}`, 0, 9, 4.4); }); y += 2; }
  pdf.setFontSize(10);
  // ---- pendências ----
  title(`Pendências (${cnt.pendTotal})`);
  if (!cnt.pendTotal) none();
  else alvos.filter(a => (a.pend || []).length).forEach(a => { sub(a.nome); a.pend.slice().sort(pendSort).forEach(p => { const st = pendState(p); pdf.setFontSize(9.5); const tx = pdf.splitTextToSize(T(p.txt), W - 2 * M - 70); need(tx.length * 4.4 + 1.5); pdf.text(p.done ? '[x]' : '[  ]', M + 2, y); tx.forEach((l, k) => pdf.text(l, M + 12, y + k * 4.4)); if (st === 'atrasada') pdf.setTextColor(200, 40, 40); else gray(); pdf.text(T(p.done ? `concluída${p.doneTs ? ' em ' + dia(p.doneTs) : ''}` : p.due ? `prazo ${dateBR(p.due)}${st === 'atrasada' ? ' (atrasada)' : st === 'hoje' ? ' (hoje)' : ''}` : 'sem prazo'), W - M, y, {align: 'right'}); ink(); y += tx.length * 4.4 + 1.5; }); y += 1.5; });
  pdf.setFontSize(10);
  // ---- locais e áreas ----
  title('Locais e áreas');
  sub(`Locais dos alvos (${cnt.locais})`);
  if (!cnt.locais) none();
  else alvos.forEach(a => (a.locais || []).slice().sort((x, z) => x.ts - z.ts).forEach(l => { need(10); pdf.setFontSize(9.5); pdf.setFont(undefined, 'bold'); pdf.text(T(`${a.nome} — ${(TIPOS[l.tipo] || TIPOS.outro)[1]}${l.titulo ? ': ' + l.titulo : ''}`).slice(0, 95), M + 2, y); pdf.setFont(undefined, 'normal'); y += 4.5; pdf.setTextColor(45, 95, 214); pdf.textWithLink(`${coord(l)}${accTxt(l)}  ·  ${fmt(l.ts)}  ·  abrir no mapa`, M + 6, y, {url: `https://maps.google.com/?q=${l.lat},${l.lng}`}); ink(); y += 4.5; if (l.nota) para(l.nota, 6, 9, 4.3); y += 1; }));
  sub(`Áreas (${areas.length})`);
  if (!areas.length) none('Nenhuma área ligada a esta operação.');
  else areas.forEach(ar => { need(12); pdf.setFontSize(9.5); pdf.setFont(undefined, 'bold'); pdf.text(T(ar.nome || 'Área sem nome'), M + 2, y); pdf.setFont(undefined, 'normal'); y += 4.5;
    if (ar.tipo === 'circulo') para(`Círculo · centro ${ar.c[0].toFixed(5)}, ${ar.c[1].toFixed(5)} · raio ${Math.round(ar.raio).toLocaleString('pt-BR')} m · ${m2Txt(Math.PI * ar.raio * ar.raio)}`, 6, 9, 4.3);
    else { para(`Polígono · ${ar.pts.length} vértices · ${m2Txt(polyArea(ar.pts))}`, 6, 9, 4.3); para('Vértices: ' + ar.pts.map(p => `${(+p[0]).toFixed(5)}, ${(+p[1]).toFixed(5)}`).join(' | '), 6, 8, 3.8); }
    if (ar.nota) para(ar.nota, 6, 9, 4.3); y += 1.5; });
  // ---- fotos ----
  if (o.fotos) {
    title(`Fotos (${cnt.fotos})`);
    if (!cnt.fotos) none();
    for (const a of alvos) {
      if (!(a.fotos || []).length) continue; sub(`${a.nome} — ${a.fotos.length} foto(s)`);
      for (const f of fotosCapaPrimeiro(a)) {
        const useSt = o.carimbo && f.carimbo; const du = await imgDataURL(useSt ? f.carimbo.id : f.id); if (!du) continue; resetIdle();
        const p = pdf.getImageProperties(du); let w = 84, h = w * p.height / p.width; if (h > 92) { h = 92; w = h * p.width / p.height; }
        const alb = isAlbum(f);
        const lines = [(a.capa === f.id || (!a.capa && f === fotosCapaPrimeiro(a)[0]) ? '[Capa] ' : '') + (f.legenda || 'Foto') + (alb ? ' (álbum)' : ' (câmera)'),
          alb ? `Data da foto: ${f.dataExif === false ? 'sem data na foto' : fmt(f.ts)}` : `Data: ${fmt(f.ts)}`, ...(alb ? [`Importada em ${fmt(f.importado || f.ts)}`] : []),
          f.lat != null ? `GPS: ${coord(f)}${accTxt(f)}${alb ? ' (da foto)' : ''}` : (alb ? 'Sem localização na foto' : 'Sem GPS'),
          `Imagem exibida: ${useSt ? 'cópia carimbada' : 'original'}`,
          `SHA-256 original${alb && f.hashTipo === 'original' ? ' (arquivo)' : ''}:`, f.hash.slice(0, 32), f.hash.slice(32),
          ...(f.carimbo ? ['SHA-256 carimbada:', f.carimbo.hash.slice(0, 32), f.carimbo.hash.slice(32)] : [])];
        const bh = Math.max(h, lines.length * 4.4); need(bh + 6);
        pdf.addImage(du, 'JPEG', M, y, w, h); pdf.setFontSize(8.5); const tx = M + 90; let ty = y + 3.5;
        lines.forEach((t, i) => { if (i === 0) pdf.setFont(undefined, 'bold'); pdf.text(pdf.splitTextToSize(T(t), W - M - tx)[0], tx, ty); pdf.setFont(undefined, 'normal'); ty += 4.4; });
        pdf.setFontSize(10); y += bh + 5;
      }
    }
  }
  // ---- áudios ----
  const auds = [...alvos.flatMap(a => (a.audios || []).map(x => ({...x, de: a.nome}))), ...(op.audios || []).map(x => ({...x, de: 'Operação'}))].sort((x, z) => x.ts - z.ts);
  title(`Áudios (${auds.length})`);
  if (!auds.length) none();
  else { auds.forEach(x => { need(10); pdf.setFontSize(9.5); pdf.text(T(`${fmt(x.ts)} · ${durTxt(x.dur)} · ${x.de}${x.titulo ? ' — ' + x.titulo : ''}`).slice(0, 110), M, y); y += 4.4; gray(); pdf.setFontSize(8); pdf.text(`SHA-256: ${x.hash || '—'}`, M + 4, y); ink(); y += 5.5; }); gray(); para('Somente a lista. Os arquivos de áudio ficam no cofre e não vão no PDF.', 0, 8.5); ink(); }
  // ---- rodapé, marca d'água ----
  const ctl = await sha256(JSON.stringify({op: op.id, n: alvos.length, ev: ev.length, t: Date.now()}));
  const n = pdf.getNumberOfPages();
  for (let i = 1; i <= n; i++) {
    pdf.setPage(i);
    pdf.saveGraphicsState(); pdf.setGState(new pdf.GState({opacity: i === 1 ? .05 : .07})); pdf.setFont(undefined, 'bold'); pdf.setFontSize(72); pdf.setTextColor(200, 0, 0); pdf.text('RESERVADO', 34, 205, {angle: 35}); pdf.setFont(undefined, 'normal'); pdf.restoreGraphicsState();
    pdf.setFontSize(7.5); pdf.setTextColor(i === 1 ? 150 : 120, i === 1 ? 160 : 130, i === 1 ? 180 : 145);
    pdf.text(T(`${APP_NAME} · ${CREDIT}  |  ${APP_VER}  |  Controle: ${ctl.slice(0, 16)}`), M, 291); pdf.text(`Página ${i} de ${n}`, W - M, 291, {align: 'right'});
  }
  const name = discOn() ? `Notas_${fileStamp()}.pdf` : `OpsVault_Relatorio_${slug(op.nome)}_${fileStamp()}.pdf`;
  return new File([pdf.output('blob')], name, {type: 'application/pdf'});
}
function relatorioSheet(opId) {
  const op = getOp(opId); if (!op) return; const R = opReportData(opId);
  const o = {mask: true, fotos: true, carimbo: true};
  const tg = (k, l, d) => `<div class="tgrow"><div>${l}${d ? `<div class="sub">${d}</div>` : ''}</div><div class="tg ${o[k] ? 'on' : ''}" data-k="${k}"></div></div>`;
  sheet(`<h2 style="margin-top:0">📄 Relatório da operação</h2>
    <div class="sub" style="line-height:1.5">${esc(op.nome)} · ${R.cnt.alvos} alvo(s), ${R.cnt.locais} local(is), ${R.cnt.areas} área(s), ${R.cnt.fotos} foto(s), ${R.cnt.audios} áudio(s), ${R.cnt.vinculos} vínculo(s), ${R.cnt.cruz} cruzamento(s), ${R.cnt.vigReg} registro(s) de vigilância, ${R.cnt.traj} trajeto(s).</div>
    <div class="card glass" style="padding:0;cursor:default;margin-top:12px">
      ${tg('mask', 'Mascarar documentos', 'mostra só os 3 primeiros dígitos')}
      ${tg('fotos', 'Incluir fotos', `${R.cnt.fotos} foto(s) — capa primeiro, com metadados e SHA-256`)}
      <div id="rp_st_w" class="${o.fotos ? '' : 'hidden'}">${tg('carimbo', 'Usar cópia carimbada quando houver', `${R.cnt.fotosCarimbo} com carimbo · desligado = sempre a original`)}</div>
    </div>
    <div class="sub" style="margin:10px 4px 0;line-height:1.4">Capa, resumo, quadro de envolvidos (com nascimento e filiação), vínculos (com gráfico), cruzamentos de telefone/placa, linha do tempo, diário de vigilância e trajetos, locais e áreas, fotos e lista de áudios. Marca d’água RESERVADO e páginas numeradas.</div>
    <div class="warn">⚠️ O PDF sai do cofre sem criptografia. Compartilhe só com quem precisa.</div>
    <div class="btn pri" id="rp_go">📤 Gerar e compartilhar</div>`, s => {
    s.querySelectorAll('.tg').forEach(t => t.onclick = () => { o[t.dataset.k] = !o[t.dataset.k]; t.classList.toggle('on', o[t.dataset.k]); s.querySelector('#rp_st_w').classList.toggle('hidden', !o.fotos); });
    const b = s.querySelector('#rp_go');
    b.onclick = async () => {
      if (b.dataset.busy) return; b.dataset.busy = '1'; b.textContent = 'Gerando relatório…';
      try { const f = await buildOpReport(opId, o); window._lastReport = f; closeSheet(); await shareFile(f); }
      catch (e) { console.error(e); toast('Erro: ' + e.message); b.textContent = '📤 Gerar e compartilhar'; delete b.dataset.busy; }
    };
  });
}
function viewRelatorio(opId) { if (!getOp(opId)) return location.hash = '#ops'; viewOp(opId); relatorioSheet(opId); }

/* ============ v0.6 — Registro rápido, Rascunhos, atalhos, etiquetas, pendências, modelos e arquivo — by @aiforge.team ============ */
const todayISO = () => { const d = new Date(), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`; };
const dateBR = iso => iso ? new Date(iso + 'T12:00').toLocaleDateString('pt-BR') : '';
const isArq = op => !!(op && op.arquivada);
const activeOps = () => S.ops.filter(o => !isArq(o));

/* ---------- Rascunhos (caixa de entrada) ---------- */
/* item: {id, ts, opId ('' = caixa geral), kind: 'foto'|'nota'|'audio'|'local', f | txt | x | l} */
const INB = {foto: ['📷', 'Foto'], nota: ['🗒️', 'Nota'], audio: ['🎙️', 'Áudio'], local: ['📍', 'Local']};
const inboxOpName = id => id ? (getOp(id) ? getOp(id).nome : 'operação removida') : 'Caixa geral';
function ctxOp() {
  const h = (location.hash || '').slice(1).split('/');
  if (h[0] === 'op' && getOp(h[1]) && !isArq(getOp(h[1]))) return h[1];
  if (h[0] === 'alvo' && getAlvo(h[1]) && !isArq(getOp(getAlvo(h[1]).opId))) return getAlvo(h[1]).opId;
  if (h[0] === 'rascunhos' && getOp(h[1]) && !isArq(getOp(h[1]))) return h[1];
  return S.cfg.qOp && getOp(S.cfg.qOp) && !isArq(getOp(S.cfg.qOp)) ? S.cfg.qOp : '';
}
async function inboxAdd(it) { if (!KEY) return; S.inbox = S.inbox || []; const x = {id: uid(), ts: Date.now(), ...it}; S.inbox.push(x); await save(); updQ(); if (/^#rascunhos/.test(location.hash)) route(); return x; }
async function inboxDrop(it) {
  if (it.kind === 'foto' && it.f) await dropImg(it.f.id);
  if (it.kind === 'audio' && it.x) await dropAud(it.x.id);
  S.inbox = (S.inbox || []).filter(x => x.id !== it.id);
}
/* botão flutuante: 📷 = foto com um toque; ⚡ = menu (nota, áudio, local, rascunhos) */
function updQ() {
  let q = $('#qbar');
  if (!q) {
    document.body.insertAdjacentHTML('beforeend', `<div id="qbar" class="glass hidden"><div id="q_cam" title="Foto rápida (vai para Rascunhos)">📷</div><div id="q_more" title="Registro rápido">⚡<b id="q_n" class="badge hidden"></b></div></div>`);
    q = $('#qbar');
    // o clique no input da câmera precisa acontecer dentro do próprio toque (iPhone)
    $('#q_cam').onclick = () => { if (KEY) quickPhoto(ctxOp()); };
    $('#q_more').onclick = () => { if (KEY) qMenu(ctxOp()); };
  }
  const on = !!KEY && location.hash !== '#lock'; q.classList.toggle('hidden', !on); document.body.classList.toggle('qon', on);
  const n = on ? (S.inbox || []).length : 0; const b = $('#q_n'); b.textContent = n > 99 ? '99+' : n; b.classList.toggle('hidden', !n);
}
function quickPhoto(opId) {
  const inp = $('#cam'); inp.value = ''; hold(180000);
  const gp = geo(); // GPS começa junto com a câmera
  inp.oncancel = () => release();
  inp.onchange = async () => {
    release(); const file = inp.files[0]; if (!file || !KEY) return; const ts = Date.now();
    toast('📥 Salvando no rascunho…', 15000);
    try {
      const bytes = await resizeJpeg(file); const hash = await sha256(bytes); const fid = uid(); await putImg(fid, new Uint8Array(bytes));
      const pos = await gp; if (!KEY) return;
      await inboxAdd({opId, kind: 'foto', ts, f: {id: fid, ts, hash, legenda: '', origem: 'camera', ...(pos || {})}});
      toast(`📥 Foto em Rascunhos · ${inboxOpName(opId)} · ${pos ? '📍 com GPS' : 'sem GPS'}`, 3400);
    } catch (e) { toast('Erro: ' + e.message); }
  };
  inp.click();
}
function quickNote(opId) {
  sheet(`<h2 style="margin-top:0">🗒️ Nota rápida</h2><div class="sub">Vai para <b>Rascunhos</b> · ${esc(inboxOpName(opId))}</div><textarea id="qn_t" data-mic placeholder="O que foi observado…" style="min-height:130px"></textarea><div class="gap"></div><div class="btn pri" id="qn_ok">Salvar nos rascunhos</div>`, s => {
    s.querySelector('#qn_t').focus();
    s.querySelector('#qn_ok').onclick = async () => { const t = s.querySelector('#qn_t').value.trim(); if (!t) return toast('Escreva a nota'); closeSheet(); await inboxAdd({opId, kind: 'nota', txt: t}); toast('📥 Nota em Rascunhos'); };
  });
}
const quickAudio = opId => recordAudio(null, 'inbox', {label: inboxOpName(opId), onSave: async x => { await inboxAdd({opId, kind: 'audio', ts: x.ts, x}); }});
const quickLocal = opId => markPlace(null, {label: inboxOpName(opId), autoGps: true, onSave: async l => { await inboxAdd({opId, kind: 'local', ts: l.ts, l}); }});
function qMenu(opId, focus) {
  const n = (S.inbox || []).length;
  sheet(`<h2 style="margin-top:0">⚡ Registro rápido</h2>
    <label>Destino dos rascunhos</label><select id="q_dest"><option value="">📥 Caixa geral (sem operação)</option>${activeOps().map(o => `<option value="${o.id}" ${o.id === opId ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select>
    ${focus === 'foto' ? '<div class="btn pri" id="q_bigcam" style="margin-top:14px">📷 Abrir câmera agora</div>' : ''}
    <div class="acts" style="margin-top:14px"><div class="act glass" id="q_f"><em>📷</em>Foto</div><div class="act glass" id="q_no"><em>🗒️</em>Nota</div><div class="act glass" id="q_au"><em>🎙️</em>Áudio</div><div class="act glass" id="q_lo"><em>📍</em>Local</div></div>
    <div class="sub" style="margin:0 4px 12px;line-height:1.4">Tudo vai para <b>Rascunhos</b>, criptografado. Depois, em Rascunhos, atribua cada item a um alvo.</div>
    <div class="btn" id="q_inb">📥 Abrir Rascunhos (${n})</div>`, s => {
    const dest = () => s.querySelector('#q_dest').value;
    s.querySelector('#q_dest').onchange = async () => { S.cfg.qOp = dest(); await save(); };
    const cam = () => { const d = dest(); closeSheet(); quickPhoto(d); };
    s.querySelector('#q_f').onclick = cam; if (s.querySelector('#q_bigcam')) s.querySelector('#q_bigcam').onclick = cam;
    s.querySelector('#q_no').onclick = () => quickNote(dest());
    s.querySelector('#q_au').onclick = () => quickAudio(dest());
    s.querySelector('#q_lo').onclick = () => quickLocal(dest());
    s.querySelector('#q_inb').onclick = () => { closeSheet(); location.hash = '#rascunhos'; };
  });
}
function inboxDesc(it) {
  if (it.kind === 'foto') return it.f.lat != null ? `📍 ${coord(it.f)}${accTxt(it.f)}` : 'sem GPS';
  if (it.kind === 'nota') return it.txt;
  if (it.kind === 'audio') return `${it.x.titulo ? it.x.titulo + ' · ' : ''}${durTxt(it.x.dur)}`;
  if (it.kind === 'local') return `${(TIPOS[it.l.tipo] || TIPOS.outro)[1]}${it.l.titulo ? ': ' + it.l.titulo : ''} · ${coord(it.l)}`;
  return '';
}
let INB_SEL = new Set();
function viewRascunhos(filt) {
  tabs('ops'); const all = (S.inbox || []).slice().sort((a, b) => b.ts - a.ts);
  const f = filt || 'todos'; const list = all.filter(it => f === 'todos' || (f === 'geral' ? !it.opId : it.opId === f));
  INB_SEL = new Set([...INB_SEL].filter(id => list.some(it => it.id === id)));
  const groups = [['todos', 'Todos', all.length], ['geral', 'Caixa geral', all.filter(it => !it.opId).length], ...[...new Set(all.map(it => it.opId).filter(Boolean))].map(id => [id, inboxOpName(id), all.filter(it => it.opId === id).length])];
  APP.innerHTML = `<div class="back" onclick="location.hash='#ops'">‹ Operações</div><div class="top"><div><h1>📥 Rascunhos</h1><div class="sub">${all.length} item(ns) aguardando atribuição a um alvo</div></div><div class="btn sm" id="r_new">⚡ Novo</div></div>
  <div class="chips" style="margin:4px 0 12px">${groups.map(([k, l, n]) => `<span class="chip ${k === f ? 'c-blue' : 'c-gray'} rf" data-f="${k}" style="cursor:pointer">${esc(l)} (${n})</span>`).join('')}</div>
  ${list.length ? list.map(it => `<div class="card glass inb ${INB_SEL.has(it.id) ? 'sel' : ''}" data-id="${it.id}" style="cursor:default"><div style="display:flex;gap:12px;align-items:center">
      <div class="isel" data-id="${it.id}" title="Selecionar">${INB_SEL.has(it.id) ? '☑' : '☐'}</div>
      ${it.kind === 'foto' ? `<div class="th" style="width:56px;height:56px;flex-shrink:0" data-img="${it.f.id}"></div>` : `<div class="ibig">${INB[it.kind][0]}</div>`}
      <div style="flex:1;min-width:0"><div class="t" style="font-size:14px">${INB[it.kind][0]} ${INB[it.kind][1]} <span class="sub">· ${fmt(it.ts)}</span></div><div class="sub" style="margin-top:3px;overflow:hidden;text-overflow:ellipsis;${it.kind === 'nota' ? 'white-space:normal' : 'white-space:nowrap'}">${esc(inboxDesc(it))}</div><div style="margin-top:6px"><span class="chip ${it.opId ? 'c-blue' : 'c-gray'}">${esc(inboxOpName(it.opId))}</span></div></div>
      ${it.kind === 'audio' ? `<b class="ipl" data-id="${it.id}" style="cursor:pointer;font-size:20px">▶</b>` : ''}</div>
      <div class="grid2" style="margin-top:10px"><div class="btn sm pri ias" data-id="${it.id}">👤 Atribuir a alvo</div><div class="btn sm idl" data-id="${it.id}">🗑️ Excluir</div></div></div>`).join('')
  : `<div class="empty"><div>📥</div>Nenhum rascunho${f !== 'todos' ? ' neste filtro' : ''}.<br>Use o botão <b>📷</b> ou <b>⚡</b> no canto da tela para registrar em campo.</div>`}
  <div class="btn pri hidden" id="r_bulk" style="position:sticky;bottom:calc(var(--safe-b) + 96px);margin-top:12px">Atribuir selecionados</div>`;
  const get = id => S.inbox.find(x => x.id === id);
  const bulk = () => { const b = $('#r_bulk'); b.classList.toggle('hidden', !INB_SEL.size); b.textContent = `👤 Atribuir ${INB_SEL.size} selecionado(s)`; };
  APP.querySelectorAll('.rf').forEach(c => c.onclick = () => location.hash = '#rascunhos' + (c.dataset.f === 'todos' ? '' : '/' + c.dataset.f));
  APP.querySelectorAll('.isel').forEach(c => c.onclick = () => { const id = c.dataset.id; INB_SEL.has(id) ? INB_SEL.delete(id) : INB_SEL.add(id); c.textContent = INB_SEL.has(id) ? '☑' : '☐'; c.closest('.inb').classList.toggle('sel', INB_SEL.has(id)); bulk(); });
  APP.querySelectorAll('.ias').forEach(b => b.onclick = () => assignSheet([get(b.dataset.id)]));
  $('#r_bulk').onclick = () => assignSheet([...INB_SEL].map(get).filter(Boolean));
  APP.querySelectorAll('.idl').forEach(b => b.onclick = async () => { const it = get(b.dataset.id); if (!await confirmBox(`Excluir este rascunho (${INB[it.kind][1].toLowerCase()})?`, 'Excluir', true)) return; await inboxDrop(it); await save(); route(); toast('Rascunho excluído'); });
  APP.querySelectorAll('.ipl').forEach(b => b.onclick = async () => {
    const it = get(b.dataset.id);
    if (PLAYER && PLAYER.id === it.x.id) { if (PLAYER.el.paused) { PLAYER.el.play(); b.textContent = '⏸'; } else { PLAYER.el.pause(); b.textContent = '▶'; } return; }
    stopPlayer(); APP.querySelectorAll('.ipl').forEach(x => x.textContent = '▶'); const url = audioCache.get(it.x.id) || await getAud(it.x.id, it.x.mime); if (!url) return toast('Áudio indisponível');
    const au = new Audio(url); PLAYER = {id: it.x.id, el: au}; b.textContent = '⏸'; au.onended = () => { b.textContent = '▶'; PLAYER = null; }; au.play().catch(() => { b.textContent = '▶'; });
  });
  list.filter(it => it.kind === 'audio').forEach(it => getAud(it.x.id, it.x.mime).catch(() => {}));
  $('#r_new').onclick = () => qMenu(f !== 'todos' && f !== 'geral' ? f : ctxOp());
  bulk(); loadThumbs();
}
function assignSheet(items) {
  if (!items.length) return;
  if (!S.alvos.length) return toast('Cadastre um alvo primeiro');
  const pref = items[0].opId; const byOp = [...S.ops].sort((a, b) => (b.id === pref) - (a.id === pref)).map(o => [o, S.alvos.filter(a => a.opId === o.id)]).filter(([, l]) => l.length);
  sheet(`<h2 style="margin-top:0">👤 Atribuir a alvo</h2><div class="sub">${items.length} rascunho(s): ${[...new Set(items.map(it => INB[it.kind][1].toLowerCase()))].join(', ')}</div>
    <label>Alvo</label><select id="as_a">${byOp.map(([o, l]) => `<optgroup label="${esc(o.nome)}${isArq(o) ? ' (arquivada)' : ''}">${l.map(a => `<option value="${a.id}">${esc(a.nome)}${a.apelido ? ' “' + esc(a.apelido) + '”' : ''}</option>`).join('')}</optgroup>`).join('')}</select>
    ${items.some(it => it.kind === 'foto') && S.cfg.carimbo ? '<div class="sub" style="margin:8px 4px 0">🕓 Carimbo ligado: as fotos ganham cópia carimbada com a data e o GPS da captura.</div>' : ''}
    <div class="gap"></div><div class="btn pri" id="as_ok">Atribuir</div>`, s => {
    s.querySelector('#as_ok').onclick = async () => {
      const a = getAlvo(s.querySelector('#as_a').value); if (!a) return; s.querySelector('#as_ok').textContent = 'Atribuindo…';
      for (const it of items) await assignItem(it, a);
      await save(); INB_SEL.clear(); closeSheet(); route(); updQ(); toast(`✔ ${items.length} rascunho(s) atribuído(s) a ${a.nome}`);
    };
  });
}
async function assignItem(it, a) {
  a.log = a.log || [];
  if (it.kind === 'foto') { const f = it.f; if (S.cfg.carimbo && !f.carimbo) { const bytes = await imgBytes(f.id); if (bytes) f.carimbo = await makeStamp(a, bytes, f.ts, f.lat != null ? f : null); } a.fotos = a.fotos || []; a.fotos.push(f); }
  else if (it.kind === 'audio') { a.audios = a.audios || []; a.audios.push(it.x); }
  else if (it.kind === 'local') { a.locais = a.locais || []; a.locais.push(it.l); }
  else if (it.kind === 'nota') { a.notas = a.notas || []; a.notas.push({id: uid(), ts: it.ts, txt: it.txt}); }
  a.log.push({ts: Date.now(), t: `Rascunho atribuído (${INB[it.kind][1].toLowerCase()} de ${fmt(it.ts)})`});
  S.inbox = S.inbox.filter(x => x.id !== it.id);
}

/* ---------- Atalhos (manifest shortcuts e URLs #acao/...) ---------- */
const ACOES = {foto: 'Nova foto', local: 'Marcar local', audio: 'Gravar áudio', rapido: 'Registro rápido'};
let PEND_ACAO = null;
(function () {
  const q = new URLSearchParams(location.search).get('acao'); const m = (location.hash || '').match(/^#acao\/(\w+)/);
  const a = (m && m[1]) || q;
  if (a && ACOES[a]) { PEND_ACAO = a; history.replaceState(null, '', location.pathname + '#ops'); }
  else if (q || m) history.replaceState(null, '', location.pathname + '#ops');
})();
function runAcao() {
  const a = PEND_ACAO; PEND_ACAO = null; if (!a || !KEY) return;
  const op = ctxOp();
  if (a === 'foto') return qMenu(op, 'foto');
  if (a === 'local') return quickLocal(op);
  if (a === 'audio') return quickAudio(op);
  return qMenu(op);
}

/* ---------- Etiquetas ---------- */
const normTag = s => String(s || '').replace(/^#+/, '').replace(/\s+/g, ' ').trim().slice(0, 30);
function allTags() { const m = new Map(); S.alvos.forEach(a => (a.tags || []).forEach(t => { const k = t.toLowerCase(); const e = m.get(k) || {t, n: 0}; e.n++; m.set(k, e); })); return [...m.values()].sort((x, y) => y.n - x.n || x.t.localeCompare(y.t, 'pt-BR')); }
const hasTag = (a, t) => (a.tags || []).some(x => x.toLowerCase() === String(t).toLowerCase());
const tagChips = (tags, cls = '') => (tags || []).map(t => `<span class="chip c-tag ${cls}" data-tag="${esc(t)}">#${esc(t)}</span>`).join('');
/* campo de etiquetas com sugestões (usado no formulário do alvo) */
function tagInput(el, tags) {
  const draw = () => {
    const sug = allTags().filter(x => !tags.some(t => t.toLowerCase() === x.t.toLowerCase())).slice(0, 12);
    el.innerHTML = `<div class="tagin glass">${tags.map((t, i) => `<span class="chip c-tag">#${esc(t)} <b data-rm="${i}" style="cursor:pointer;opacity:.8">✕</b></span>`).join('')}<input id="a_tagi" list="a_tagdl" placeholder="${tags.length ? 'mais…' : 'Ex.: facção X, receptação'}" autocomplete="off"></div>
      <datalist id="a_tagdl">${allTags().map(x => `<option value="${esc(x.t)}">`).join('')}</datalist>
      ${sug.length ? `<div class="chips" style="margin-top:8px">${sug.map(x => `<span class="chip c-gray tsug" data-t="${esc(x.t)}" style="cursor:pointer">+ ${esc(x.t)}</span>`).join('')}</div>` : ''}`;
    const inp = el.querySelector('#a_tagi');
    const add = v => { String(v).split(/[,;]/).map(normTag).filter(Boolean).forEach(t => { if (!tags.some(x => x.toLowerCase() === t.toLowerCase())) tags.push(t); }); };
    inp.onkeydown = e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); if (inp.value.trim()) { add(inp.value); draw(); el.querySelector('#a_tagi').focus(); } } };
    inp.onchange = () => { if (inp.value.trim()) { add(inp.value); draw(); } };
    el.querySelectorAll('[data-rm]').forEach(b => b.onclick = () => { tags.splice(+b.dataset.rm, 1); draw(); });
    el.querySelectorAll('.tsug').forEach(c => c.onclick = () => { add(c.dataset.t); draw(); });
  };
  draw();
  return () => { const v = el.querySelector('#a_tagi'); if (v && v.value.trim()) String(v.value).split(/[,;]/).map(normTag).filter(Boolean).forEach(t => { if (!tags.some(x => x.toLowerCase() === t.toLowerCase())) tags.push(t); }); return tags; };
}

/* ---------- Pendências ---------- */
const pendState = p => p.done ? 'feita' : !p.due ? 'aberta' : p.due < todayISO() ? 'atrasada' : p.due === todayISO() ? 'hoje' : 'aberta';
const pendChip = p => { const s = pendState(p); if (s === 'feita') return `<span class="chip c-grn">feita${p.doneTs ? ' ' + new Date(p.doneTs).toLocaleDateString('pt-BR') : ''}</span>`; if (!p.due) return ''; return `<span class="chip ${s === 'atrasada' ? 'c-red' : s === 'hoje' ? 'c-amb' : 'c-gray'}">${s === 'atrasada' ? 'atrasada · ' : s === 'hoje' ? 'hoje · ' : ''}${dateBR(p.due)}</span>`; };
const pendSort = (x, y) => (x.done - y.done) || ((x.due || '9999') < (y.due || '9999') ? -1 : (x.due || '9999') > (y.due || '9999') ? 1 : x.ts - y.ts);
function allPend(incArq) { const out = []; S.alvos.forEach(a => { const op = getOp(a.opId); if (!incArq && isArq(op)) return; (a.pend || []).forEach(p => out.push({p, a, op})); }); return out; }
const overdueCount = () => allPend(false).filter(({p}) => pendState(p) === 'atrasada').length;
function pendForm(a, p) {
  sheet(`<h2 style="margin-top:0">${p ? 'Editar pendência' : '✅ Nova pendência'}</h2><div class="sub">${esc(a.nome)}</div>
    <label>O que precisa ser feito</label><input id="pd_t" data-mic value="${esc(p?.txt)}" placeholder="Ex.: confirmar endereço do trabalho">
    <label>Prazo (opcional)</label><input id="pd_d" type="date" value="${esc(p?.due)}">
    <div class="gap"></div><div class="btn pri" id="pd_ok">Salvar</div>${p ? '<div class="btn dan" id="pd_del" style="margin-top:10px">Excluir pendência</div>' : ''}`, s => {
    s.querySelector('#pd_t').focus();
    s.querySelector('#pd_ok').onclick = async () => {
      const txt = s.querySelector('#pd_t').value.trim(), due = s.querySelector('#pd_d').value; if (!txt) return toast('Descreva a pendência');
      a.pend = a.pend || [];
      if (p) Object.assign(p, {txt, due}); else { a.pend.push({id: uid(), txt, due, done: false, ts: Date.now()}); a.log = a.log || []; a.log.push({ts: Date.now(), t: `Pendência criada: ${txt}`}); }
      await save(); closeSheet(); route(); toast('✅ Pendência salva');
    };
    const d = s.querySelector('#pd_del'); if (d) d.onclick = async () => { closeSheet(); if (!await confirmBox('Excluir esta pendência?', 'Excluir', true)) return; a.pend = a.pend.filter(x => x.id !== p.id); await save(); route(); toast('Pendência excluída'); };
  });
}
async function pendToggle(a, p) { p.done = !p.done; if (p.done) p.doneTs = Date.now(); else delete p.doneTs; a.log = a.log || []; a.log.push({ts: Date.now(), t: `Pendência ${p.done ? 'concluída' : 'reaberta'}: ${p.txt}`}); await save(); }
const pendRow = (p, a, showAlvo) => `<div class="li prow ${p.done ? 'done' : ''}"><span style="display:flex;gap:12px;align-items:flex-start;min-width:0"><b class="pchk" data-a="${a.id}" data-p="${p.id}">${p.done ? '☑' : '☐'}</b><span style="min-width:0"><span class="ptxt" data-a="${a.id}" data-p="${p.id}" style="cursor:pointer">${esc(p.txt)}</span>${showAlvo ? `<br><span class="sub" style="cursor:pointer" onclick="location.hash='#alvo/${a.id}'">👤 ${esc(a.nome)} · ${esc(getOp(a.opId)?.nome || '')}</span>` : ''}</span></span><span style="flex-shrink:0">${pendChip(p)}</span></div>`;
function bindPend(root) {
  root.querySelectorAll('.pchk').forEach(b => b.onclick = async () => { const a = getAlvo(b.dataset.a), p = a && (a.pend || []).find(x => x.id === b.dataset.p); if (!p) return; await pendToggle(a, p); route(); });
  root.querySelectorAll('.ptxt').forEach(b => b.onclick = () => { const a = getAlvo(b.dataset.a), p = a && (a.pend || []).find(x => x.id === b.dataset.p); if (p) pendForm(a, p); });
}
function viewPendencias(f) {
  tabs('ops'); f = f || 'abertas'; const inc = !!S.cfg.pendArq;
  const all = allPend(inc); const cnt = k => all.filter(({p}) => k === 'todas' || (k === 'feitas' ? p.done : k === 'atrasadas' ? pendState(p) === 'atrasada' : !p.done)).length;
  const list = all.filter(({p}) => f === 'todas' || (f === 'feitas' ? p.done : f === 'atrasadas' ? pendState(p) === 'atrasada' : !p.done)).sort((x, y) => pendSort(x.p, y.p));
  APP.innerHTML = `<div class="back" onclick="location.hash='#ops'">‹ Operações</div><h1>✅ Pendências</h1><div class="sub" style="margin:4px 4px 12px">Todas as operações · ordenadas por prazo</div>
  <div class="chips" style="margin-bottom:12px">${[['abertas', 'Abertas'], ['atrasadas', 'Atrasadas'], ['feitas', 'Concluídas'], ['todas', 'Todas']].map(([k, l]) => `<span class="chip ${k === f ? (k === 'atrasadas' ? 'c-red' : 'c-blue') : 'c-gray'} pf" data-f="${k}" style="cursor:pointer">${l} (${cnt(k)})</span>`).join('')}</div>
  <div class="tgrow card glass" style="cursor:default;margin-bottom:12px"><div>Incluir operações arquivadas</div><div class="tg ${inc ? 'on' : ''}" id="pd_arq"></div></div>
  ${list.length ? `<div class="card glass list" style="cursor:default;padding:0">${list.map(({p, a}) => pendRow(p, a, true)).join('')}</div>` : `<div class="empty"><div>✅</div>Nenhuma pendência ${f === 'todas' ? '' : 'neste filtro'}.<br>Crie na ficha do alvo.</div>`}`;
  APP.querySelectorAll('.pf').forEach(c => c.onclick = () => location.hash = '#pendencias/' + c.dataset.f);
  $('#pd_arq').onclick = async () => { S.cfg.pendArq = !S.cfg.pendArq; await save(); route(); };
  bindPend(APP);
}

/* ---------- Duplicar operação como modelo / Arquivar ---------- */
function dupSheet(op) {
  const n = S.alvos.filter(a => a.opId === op.id).length;
  const o = {alvos: true, locais: false, pend: true, links: true, areas: true};
  const tg = (k, l, d) => `<div class="tgrow"><div>${l}${d ? `<div class="sub">${d}</div>` : ''}</div><div class="tg ${o[k] ? 'on' : ''}" data-k="${k}"></div></div>`;
  sheet(`<h2 style="margin-top:0">📑 Duplicar como modelo</h2><div class="sub">Cria uma operação nova com a mesma estrutura. A original não muda.</div>
    <label>Nome da nova operação</label><input id="dp_n" value="${esc(op.nome + ' (cópia)')}">
    <div class="card glass" style="padding:0;cursor:default;margin-top:12px">
      ${tg('alvos', `Copiar alvos (${n})`, 'dados, etiquetas e mandados — sem fotos, áudios, documento e anotações')}
      <div id="dp_sub">${tg('locais', 'Incluir locais dos alvos')}${tg('pend', 'Incluir pendências (reabertas)')}${tg('links', 'Incluir vínculos entre os alvos copiados')}</div>
      ${tg('areas', 'Copiar áreas do mapa da operação')}
    </div>
    <div class="gap"></div><div class="btn pri" id="dp_ok">Duplicar</div>`, s => {
    s.querySelectorAll('.tg').forEach(t => t.onclick = () => { o[t.dataset.k] = !o[t.dataset.k]; t.classList.toggle('on', o[t.dataset.k]); s.querySelector('#dp_sub').classList.toggle('hidden', !o.alvos); });
    s.querySelector('#dp_ok').onclick = async () => {
      const nome = s.querySelector('#dp_n').value.trim(); if (!nome) return toast('Dê um nome');
      const nop = await duplicateOp(op.id, nome, o); closeSheet(); location.hash = '#op/' + nop.id; toast('📑 Operação duplicada');
    };
  });
}
async function duplicateOp(opId, nome, o) {
  const op = getOp(opId), now = Date.now();
  const nop = {id: uid(), nome, status: 'planejada', desc: op.desc || '', ts: now, audios: [], modelo: opId};
  S.ops.push(nop); const map = {};
  if (o.alvos) for (const a of S.alvos.filter(a => a.opId === opId)) {
    const c = JSON.parse(JSON.stringify({nome: a.nome, apelido: a.apelido, doc: a.doc, nasc: a.nasc || '', filiacao: a.filiacao || '', prio: a.prio, tels: a.tels || [], veic: a.veic, end: a.end, vinc: a.vinc, situacao: a.situacao || '', situacaoOutro: a.situacaoOutro || '', redes: a.redes || [], mandados: a.mandados || [], tags: a.tags || []}));
    const na = {id: uid(), opId: nop.id, ...c, fotos: [], audios: [], notas: [], locais: o.locais ? (a.locais || []).map(l => ({...l, id: uid()})) : [], pend: o.pend ? (a.pend || []).map(p => ({id: uid(), txt: p.txt, due: p.due || '', done: false, ts: now})) : [], log: [{ts: now, t: `Alvo copiado do modelo “${op.nome}”`}], ts: now};
    map[a.id] = na.id; S.alvos.push(na);
  }
  if (o.alvos && o.links) (S.links || []).forEach(l => { if (map[l.a] && map[l.b]) S.links.push({id: uid(), a: map[l.a], b: map[l.b], rel: l.rel, ts: now}); });
  if (o.areas) (S.areas || []).filter(ar => ar.opId === opId).forEach(ar => S.areas.push({...JSON.parse(JSON.stringify(ar)), id: uid(), opId: nop.id, ts: now}));
  migrate(S); await save(); return nop;
}
async function toggleArq(op) {
  if (isArq(op)) { delete op.arquivada; await save(); route(); return toast('Operação desarquivada'); }
  if (!await confirmBox(`Arquivar "${op.nome}"? Ela sai da lista principal (fica em “Arquivadas”). Nada é apagado.`, 'Arquivar')) return;
  op.arquivada = Date.now(); if (S.cfg.qOp === op.id) delete S.cfg.qOp; await save(); location.hash = '#ops'; toast('🗄️ Operação arquivada');
}

/* ---------- Tela inicial (v0.6) ---------- */
function opCard(o) { const n = S.alvos.filter(a => a.opId === o.id).length; const st = STATUS[o.status] || STATUS.planejada; const ni = (S.inbox || []).filter(it => it.opId === o.id).length; const po = S.alvos.filter(a => a.opId === o.id).reduce((s, a) => s + (a.pend || []).filter(p => pendState(p) === 'atrasada').length, 0);
  return `<div class="card glass ${isArq(o) ? 'arq' : ''}" onclick="location.hash='#op/${o.id}'"><div class="row"><div class="t">${esc(o.nome)}</div><span class="chip ${isArq(o) ? 'c-gray' : st[0]}">${isArq(o) ? '🗄️ Arquivada' : st[1]}</span></div><div class="sub" style="margin-top:6px">${n} alvo(s) · criada ${fmt(o.ts)}${ni ? ` · 📥 ${ni} rascunho(s)` : ''}${po ? ` · <span style="color:#ff9a9a">⏰ ${po} atrasada(s)</span>` : ''}</div>${o.desc ? `<div class="sub" style="margin-top:4px">${esc(o.desc)}</div>` : ''}</div>`; }
function viewOps() {
  tabs('ops');
  const ops = activeOps().sort((a, b) => b.ts - a.ts), arq = S.ops.filter(isArq).sort((a, b) => b.arquivada - a.arquivada);
  const od = backupOverdue(), late = overdueCount(), nX = xCount(), nInb = (S.inbox || []).length, nGeral = (S.inbox || []).filter(it => !it.opId).length;
  APP.innerHTML = `<div class="top"><div><div class="brand">${esc(brandName())}</div><h1>Operações</h1></div><div style="display:flex;gap:8px"><div class="btn sm bdg" id="cruz_t" title="Cruzamentos">🔀${nX ? `<b class="badge xb">${nX}</b>` : ''}</div><div class="btn sm bdg" id="pend_t" title="Pendências">✅${late ? `<b class="badge">${late}</b>` : ''}</div><div class="btn sm" id="disc_t" title="Modo discreto">🕶️</div><div class="btn sm" onclick="lock('manual')">🔒</div></div></div>
  ${od ? `<div class="warn" id="bk_ban"><b>💾 Backup atrasado.</b> ${S.cfg.lastBackup ? `Último backup em ${fmt(S.cfg.lastBackup)}.` : 'Nenhum backup registrado neste aparelho.'} Lembrete a cada ${S.cfg.bkDays} dia(s).<div class="grid2" style="margin-top:10px"><div class="btn sm pri" id="bk_now">Fazer backup agora</div><div class="btn sm" id="bk_later">Lembrar amanhã</div></div></div>` : ''}
  ${late ? `<div class="card glass" id="late_card" onclick="location.hash='#pendencias/atrasadas'" style="border-color:rgba(255,107,107,.45)"><div class="row"><div class="t">⏰ ${late} pendência(s) atrasada(s)</div><span class="sub">›</span></div></div>` : ''}
  ${nInb ? `<div class="card glass" id="inb_card" onclick="location.hash='#rascunhos'"><div class="row"><div class="t">📥 Rascunhos</div><span class="chip c-blue">${nInb}</span></div><div class="sub" style="margin-top:4px">${nGeral ? `${nGeral} na caixa geral · ` : ''}toque para atribuir a alvos</div></div>` : ''}
  ${ops.length ? ops.map(opCard).join('') : `<div class="empty"><div>🗂️</div>${arq.length ? 'Nenhuma operação ativa.' : 'Nenhuma operação ainda.'}<br>Toque em <b>+</b> para criar${arq.length ? ' uma nova' : ' a primeira'}.</div>`}
  ${arq.length ? `<details class="arqbox" id="arq_box"><summary>🗄️ Arquivadas (${arq.length})</summary>${arq.map(opCard).join('')}</details>` : ''}
  <div class="btn pri fab" id="nova">+</div>`;
  $('#nova').onclick = () => opForm(); $('#disc_t').onclick = () => toggleDisc(); $('#pend_t').onclick = () => location.hash = '#pendencias'; $('#cruz_t').onclick = () => location.hash = '#cruzamentos';
  if (od) { $('#bk_now').onclick = async () => { if (await doBackup()) route(); }; $('#bk_later').onclick = async () => { S.cfg.bkSnooze = Date.now() + 864e5; await save(); route(); }; }
}

/* ---------- Busca (v0.6: etiquetas e arquivadas) ---------- */
function viewBusca(mode, val) {
  tabs('busca');
  let tag = mode === 'tag' && val ? decodeURIComponent(val) : '';
  const tags = allTags(), nX = xCount();
  APP.innerHTML = `<h1 style="margin-bottom:14px">Busca</h1><div class="search glass"><span>🔍</span><input id="q" placeholder="Nome, vulgo, placa, telefone, etiqueta…" autocomplete="off"></div>
  ${tags.length ? `<div class="chips" id="b_tags" style="margin:10px 0 4px">${tags.slice(0, 24).map(x => `<span class="chip ${x.t.toLowerCase() === tag.toLowerCase() ? 'c-tag on' : 'c-gray'} btag" data-t="${esc(x.t)}" style="cursor:pointer">#${esc(x.t)} <span style="opacity:.6">${x.n}</span></span>`).join('')}</div>` : ''}
  <div class="tgrow" style="padding:8px 4px;border:0"><div class="sub">Incluir operações arquivadas</div><div class="tg ${S.cfg.buscaArq ? 'on' : ''}" id="b_arq"></div></div>
  <div class="card glass" id="b_cruz" onclick="location.hash='#cruzamentos'" style="padding:12px 14px"><div class="row"><div class="t">🔀 Cruzamentos de telefones e placas</div><span class="chip ${nX ? 'c-amb' : 'c-gray'}">${nX}</span></div></div>
  <div id="res"></div>`;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const run = () => {
    const q = norm($('#q').value.trim()); const qd = q.replace(/\D/g, '');
    const pool = S.alvos.filter(a => (S.cfg.buscaArq || !isArq(getOp(a.opId))) && (!tag || hasTag(a, tag)));
    const nArq = S.cfg.buscaArq ? 0 : S.alvos.filter(a => isArq(getOp(a.opId)) && (!tag || hasTag(a, tag))).length;
    if (q.length < 2 && !tag) return $('#res').innerHTML = `<div class="empty"><div>🔎</div>Digite ao menos 2 caracteres${tags.length ? ' ou toque numa etiqueta' : ''}.<br>${S.alvos.length} alvo(s) no cofre.</div>`;
    const hits = [];
    pool.forEach(a => {
      if (q.length < 2) return hits.push([a, ['Etiqueta', '#' + (a.tags || []).find(t => t.toLowerCase() === tag.toLowerCase())]]);
      const f = [['Nome', a.nome], ['Vulgo', a.apelido], ['Documento', a.doc], ['Nascimento', a.nasc ? dateBR(a.nasc) : ''], ['Filiação', a.filiacao], ['Veículo', a.veic], ['Endereço', a.end], ['Vínculos', a.vinc], ...(a.tels || []).map(t => ['Telefone', t]), ...(a.tags || []).map(t => ['Etiqueta', '#' + t]), ...(a.notas || []).map(n => ['Nota', n.txt]), ...(a.locais || []).map(l => ['Local', (l.titulo || '') + ' ' + (l.nota || '')]), ['Situação', situTxt(a)], ...(a.redes || []).map(r => ['Rede social', r]), ...(a.mandados || []).map(m => ['Mandado', mandTxt(m)]), ...linksOf(a.id).map(l => ['Vínculo', l.rel + ' — ' + l.other.nome]), ...(a.audios || []).map(x => ['Áudio', x.titulo]), ...(a.pend || []).map(p => ['Pendência', p.txt])];
      const m = f.find(([, v]) => norm(v).includes(q) || (qd.length >= 3 && String(v || '').replace(/\D/g, '').includes(qd)));
      if (m) hits.push([a, m]);
    });
    $('#res').innerHTML = (hits.length ? hits.map(([a, [k, v]]) => `<div class="card glass" onclick="location.hash='#alvo/${a.id}'"><div class="t">${esc(a.nome)}${isArq(getOp(a.opId)) ? ' <span class="chip c-gray">🗄️ arquivada</span>' : ''}</div><div class="sub">${esc(getOp(a.opId)?.nome || '')} · ${k}: ${esc(String(v).slice(0, 80))}</div>${(a.tags || []).length ? `<div class="chips" style="margin-top:6px">${tagChips(a.tags)}</div>` : ''}</div>`).join('') : '<div class="empty"><div>∅</div>Nada encontrado.</div>')
      + (nArq && (q.length >= 2 || tag) ? `<div class="sub" style="margin:8px 4px">${nArq} alvo(s) de operações arquivadas não entram — ligue “Incluir operações arquivadas”.</div>` : '');
  };
  APP.querySelectorAll('.btag').forEach(c => c.onclick = () => { tag = tag.toLowerCase() === c.dataset.t.toLowerCase() ? '' : c.dataset.t; APP.querySelectorAll('.btag').forEach(x => { const on = x.dataset.t.toLowerCase() === tag.toLowerCase() && !!tag; x.classList.toggle('c-tag', on); x.classList.toggle('on', on); x.classList.toggle('c-gray', !on); }); run(); });
  $('#b_arq').onclick = async e => { S.cfg.buscaArq = !S.cfg.buscaArq; e.target.classList.toggle('on', S.cfg.buscaArq); await save(); run(); };
  $('#q').oninput = run; run(); if (!tag) $('#q').focus();
}

/* ============ v0.6 Etapa B — Ditado por voz e leitura (OCR) de documento e placa — by @aiforge.team ============ */
/* ---- Ditado: reconhecimento de fala do navegador (o texto é só acrescentado ao campo; nada é gravado) ---- */
const SRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let DICT = null;
function stopDict() { if (!DICT) return; const d = DICT; DICT = null; try { d.r.abort(); } catch (e) {} d.btn.classList.remove('on'); d.hint.remove(); }
function micify(root) {
  if (!SRec || !root) return; // sem suporte: nenhum botão aparece
  root.querySelectorAll('[data-mic]').forEach(el => {
    if (el._mic) return; el._mic = true;
    const w = document.createElement('div'); w.className = 'micw' + (el.tagName === 'INPUT' ? ' inp' : '');
    el.parentNode.insertBefore(w, el); w.appendChild(el);
    const b = document.createElement('div'); b.className = 'micb'; b.setAttribute('role', 'button'); b.setAttribute('aria-label', 'Ditado por voz'); b.textContent = '🎤'; w.appendChild(b);
    b.onclick = e => { e.preventDefault(); e.stopPropagation(); if (DICT && DICT.el === el) return stopDict(); stopDict(); startDict(el, b, w); };
  });
}
function startDict(el, btn, w) {
  let r; try { r = new SRec(); } catch (e) { return toast('Ditado indisponível neste navegador'); }
  r.lang = 'pt-BR'; r.continuous = true; r.interimResults = true; r.maxAlternatives = 1;
  const hint = document.createElement('div'); hint.className = 'michint'; hint.textContent = '🎙️ Ouvindo… toque em 🎤 para parar'; w.after(hint);
  const d = DICT = {r, el, btn, hint}, done = new Set(); btn.classList.add('on');
  r.onresult = ev => {
    let interim = '';
    for (let i = ev.resultIndex; i < ev.results.length; i++) {
      const res = ev.results[i];
      if (res.isFinal) { if (!done.has(i)) { done.add(i); const t = (res[0].transcript || '').trim(); if (t) appendDict(el, t); } }
      else interim += res[0].transcript;
    }
    if (DICT === d) hint.textContent = interim.trim() ? '🎙️ ' + interim.trim() : '🎙️ Ouvindo… toque em 🎤 para parar';
  };
  r.onerror = ev => { const m = {'not-allowed': 'Microfone não permitido', 'service-not-allowed': 'Ditado não permitido neste aparelho', network: 'O ditado precisa de internet neste aparelho', 'no-speech': 'Nenhuma fala detectada', 'audio-capture': 'Microfone indisponível'}[ev.error]; if (m) toast('🎤 ' + m); };
  r.onend = () => { if (DICT === d) stopDict(); };
  try { r.start(); } catch (e) { stopDict(); toast('Não foi possível iniciar o ditado'); }
}
function appendDict(el, t) { const v = el.value; el.value = v + (!v || /\s$/.test(v) ? '' : ' ') + t; el.dispatchEvent(new Event('input', {bubbles: true})); }

/* ---- OCR no aparelho: tesseract.js carregado sob demanda de lib/ (sem CDN, sem rede externa) ---- */
let TESS = null, OCR_PROG = null;
const libUrl = p => new URL('lib/' + p, location.href).href;
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => { s.remove(); rej(new Error('não foi possível carregar o leitor')); }; document.head.appendChild(s); }); }
async function ocrWorker() {
  if (!window.Tesseract) await loadScript(libUrl('tesseract.min.js'));
  if (!TESS) TESS = Tesseract.createWorker('por', 1, {workerPath: libUrl('tess-worker.min.js'), corePath: libUrl('tess-core/'), langPath: libUrl('tessdata'), gzip: false, cacheMethod: 'none', workerBlobURL: false,
    logger: m => OCR_PROG && OCR_PROG(m), errorHandler: e => console.warn('OCR', e)}).catch(e => { TESS = null; throw e; });
  return TESS;
}
function ocrStop() { if (TESS) { const t = TESS; TESS = null; t.then(w => w.terminate()).catch(() => {}); } OCR_PROG = null; } // ao travar: libera memória e o texto lido
async function runOcr(cv, params, onProg) {
  OCR_PROG = onProg || null;
  try { const w = await ocrWorker(), tp = TESS; const live = () => { if (!tp || TESS !== tp) throw new Error('leitura cancelada'); }; // leitor encerrado (Cancelar/travar) no meio: não manda mais nada a ele
    live(); await w.setParameters(Object.assign({tessedit_char_whitelist: '', tessedit_pageseg_mode: '3', preserve_interword_spaces: '1', user_defined_dpi: '300', debug_file: '/dev/null'}, params || {})); live(); const {data} = await w.recognize(cv); return data; }
  finally { OCR_PROG = null; }
}
const ocrStepTxt = m => ({'loading tesseract core': 'Carregando o leitor…', 'initializing tesseract': 'Preparando…', 'loading language traineddata': 'Carregando o português…', 'initializing api': 'Preparando…', 'recognizing text': 'Lendo o texto…'})[m.status] || 'Preparando…';
function loadImg(file) { return new Promise((res, rej) => { const u = URL.createObjectURL(file); const img = new Image(); img.onload = () => res({img, u}); img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('imagem inválida')); }; img.src = u; }); }
/* recorte → canvas em tons de cinza com contraste esticado (ajuda o OCR com foto escura/lavada) */
function ocrCanvas(img, r, maxSide, minH, invert) {
  r = r || {x: 0, y: 0, w: img.naturalWidth || img.width, h: img.naturalHeight || img.height}; // imagem ou canvas
  let k = Math.min(1, maxSide / Math.max(r.w, r.h)); if (minH && r.h * k < minH) k = Math.min(minH / r.h, maxSide / r.w, 6);
  const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(r.w * k)); c.height = Math.max(1, Math.round(r.h * k));
  const x = c.getContext('2d', {willReadFrequently: true}); x.imageSmoothingQuality = 'high'; x.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
  const id = x.getImageData(0, 0, c.width, c.height), d = id.data, hist = new Uint32Array(256), g = new Uint8Array(d.length / 4);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { const v = (d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000 | 0; g[j] = v; hist[v]++; }
  let lo = 0, hi = 255, acc = 0; const cut = g.length * .01; while (lo < 254 && (acc += hist[lo]) < cut) lo++; acc = 0; while (hi > lo + 1 && (acc += hist[hi]) < cut) hi--;
  const sc = 255 / Math.max(1, hi - lo);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) { let v = Math.max(0, Math.min(255, (g[j] - lo) * sc)); if (invert) v = 255 - v; d[i] = d[i + 1] = d[i + 2] = v; }
  x.putImageData(id, 0, 0); return c;
}
function ocrBusySheet(title) {
  sheet(`<h2 style="margin-top:0">${title}</h2><div class="sub" id="oc_st">Preparando…</div><div class="prog"><i id="oc_bar"></i></div><div class="sub" style="margin-top:8px;line-height:1.4">🔒 Leitura feita no próprio aparelho — a imagem não é enviada a lugar nenhum. Na 1ª vez, o leitor (~6 MB) é carregado do endereço do app e fica guardado.</div>`);
  return m => { const st = $('#oc_st'), bar = $('#oc_bar'); if (!st) return; st.textContent = ocrStepTxt(m); if (bar) bar.style.width = Math.round((m.status === 'recognizing text' ? .3 + .7 * (m.progress || 0) : .3 * (m.progress || 0)) * 100) + '%'; };
}
/* escolher foto: câmera (mesmo toque — iPhone) ou arquivo */
function ocrPick(title, cb) {
  sheet(`<h2 style="margin-top:0">${title}</h2><div class="btn pri" id="op_cam">📷 Tirar foto</div><div class="btn" id="op_alb" style="margin-top:10px">🖼️ Escolher imagem</div>`, s => {
    s.querySelector('#op_cam').onclick = () => { closeSheet(); const inp = $('#cam'); inp.value = ''; hold(180000); inp.oncancel = () => release(); inp.onchange = () => { release(); const f = inp.files[0]; if (f) cb(f); }; inp.click(); };
    s.querySelector('#op_alb').onclick = () => { closeSheet(); pickFile('image/*', cb); };
  });
}

/* ---- Extração de dados de RG/CNH a partir do texto lido ---- */
function cpfValid(d) {
  d = String(d || '').replace(/\D/g, ''); if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += +d[i] * (n + 1 - i); const r = s * 10 % 11; return r === 10 ? 0 : r; };
  return dv(9) === +d[9] && dv(10) === +d[10];
}
const cpfFmt = d => String(d).replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
const OCR_DIG = {O: '0', o: '0', D: '0', Q: '0', U: '0', I: '1', l: '1', '|': '1', i: '1', L: '1', Z: '2', z: '2', S: '5', s: '5', B: '8', G: '6', T: '7', g: '9'};
const ocrDigits = s => String(s).replace(/[OoDQUIl|iLZzSsBGTg]/g, c => OCR_DIG[c]);
function findCPFs(text) {
  const C = '[0-9OoDQUIl|iLZzSsBGTg]', re = new RegExp(`(^|[^0-9])(${C}{3})[ ]?[.,·]?[ ]?(${C}{3})[ ]?[.,·]?[ ]?(${C}{3})[ ]?[-–—.,/]?[ ]?(${C}{2})(?![0-9])`, 'gm'), out = new Map();
  let m; while ((m = re.exec(text))) {
    const raw = m[2] + m[3] + m[4] + m[5]; if ((raw.match(/\d/g) || []).length < 9) continue;
    const d = ocrDigits(raw); if (!out.has(d)) out.set(d, cpfValid(d)); re.lastIndex = m.index + m[1].length + 1;
  }
  return [...out].map(([d, ok]) => ({d, ok})).sort((x, y) => y.ok - x.ok);
}
const OCR_LBL = /\b(NOME|FILIACAO|FILIA|NASC|NASCIMENTO|DATA|CPF|REGISTRO|GERAL|IDENTIDADE|DOC|ORG|EMISSOR|EXPEDI\w*|EXPEDICAO|VALIDADE|CATEGORIA|CAT|HAB|PERMISSAO|HABILITACAO|NATURALIDADE|NATURAL|ASSINATURA|OBSERVACOES|OBS|LOCAL|REPUBLICA|FEDERATIVA|BRASIL|CARTEIRA|NACIONAL|DEPARTAMENTO|TRANSITO|SECRETARIA|ESTADO|MINISTERIO|DETRAN|INSTITUTO|POLEGAR|TITULAR|RENACH|SSP|UF|VIA|VALIDA|TERRITORIO|LEI|SEGURANCA|PUBLICA|DIRETOR|ACC|SOCIAL|PAI|MAE|SEXO|NACIONALIDADE)\b/;
const ocrN = s => _norm(s).toUpperCase();
function nameLine(s) {
  if (!s) return ''; const t = s.replace(/[^A-Za-zÀ-ÿ' ]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (t.length < 6 || OCR_LBL.test(ocrN(t))) return '';
  const letters = (s.match(/[A-Za-zÀ-ÿ]/g) || []).length; if (letters / s.replace(/\s/g, '').length < .85) return '';
  const w = t.split(' ').filter(x => x.length > 1 || /^[eE]$/.test(x)); if (w.length < 2 || w.filter(x => x.length >= 2).length < 2) return '';
  return w.join(' ');
}
const PART = new Set(['da', 'de', 'do', 'das', 'dos', 'e', 'di', 'du']);
const titleName = s => s.toLowerCase().split(' ').map((w, i) => i && PART.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
function findDates(text) {
  const out = [], re = /([0-3OoIl][0-9OoIl])\s?[\/.\-]\s?([01OoIl][0-9OoIlS])\s?[\/.\-]\s?((?:19|20)[0-9OoIl]{2})/g; let m;
  while ((m = re.exec(text))) { const [d, mo, y] = [m[1], m[2], m[3]].map(ocrDigits).map(Number); if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) out.push({iso: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, i: m.index}); }
  return out;
}
function extractDoc(text) {
  const lines = String(text || '').split(/\n/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean), N = lines.map(ocrN);
  const r = {nome: '', cpfs: findCPFs(text), rg: '', nasc: '', filiacao: []};
  const after = (i, re) => { const m = N[i].match(re); return m ? lines[i].slice(m.index + m[0].length) : ''; }; // N = lines sem acento (mesmos índices)
  // nome: linha com o rótulo NOME (não “nome social”/pai/mãe) → mesmo texto depois do rótulo ou próximas linhas
  for (let i = 0; i < N.length && !r.nome; i++) if (/\bNOME\b/.test(N[i]) && !/SOCIAL|\bPAI\b|\bMAE\b/.test(N[i])) for (const c of [after(i, /\bNOME\b( E SOBRENOME)?/), lines[i + 1], lines[i + 2]]) { const n = nameLine(c); if (n) { r.nome = n; break; } }
  // filiação: até 2 linhas com cara de nome depois do rótulo
  const fi = N.findIndex(x => /FILIA/.test(x));
  if (fi >= 0) { for (const c of [after(fi, /FILIA\w*/), ...lines.slice(fi + 1, fi + 6)]) { if (r.filiacao.length >= 2) break; const n = nameLine(c); if (n && n !== r.nome) r.filiacao.push(n); else if (c && OCR_LBL.test(ocrN(c)) && !/FILIA/.test(ocrN(c)) && r.filiacao.length) break; } }
  if (!r.nome) { for (let i = 0; i < lines.length; i++) { if (fi >= 0 && i > fi && i <= fi + 3) continue; const n = nameLine(lines[i]); if (n && n.split(' ').length >= 2 && !r.filiacao.includes(n)) { r.nome = n; break; } } }
  // nascimento: data perto do rótulo NASC; senão a data mais antiga plausível
  const ni = N.findIndex(x => /NASC/.test(x)), cur = new Date().getFullYear();
  if (ni >= 0) for (const c of [after(ni, /NASC\w*/), lines[ni + 1], lines[ni + 2]]) { const ds = c ? findDates(c) : []; if (ds.length) { r.nasc = ds[0].iso; break; } }
  if (!r.nasc) { const ds = findDates(text).filter(x => +x.iso.slice(0, 4) >= 1900 && +x.iso.slice(0, 4) <= cur - 1).sort((x, y) => x.iso < y.iso ? -1 : 1); if (ds.length) r.nasc = ds[0].iso; }
  // RG: número perto de REGISTRO GERAL / IDENTIDADE / RG (sem ser CPF nem data)
  const cpfSet = new Set(r.cpfs.map(x => x.d));
  for (let i = 0; i < N.length && !r.rg; i++) if (/REGISTRO GERAL|IDENTIDADE|\bR\.?G\.?\b/.test(N[i])) {
    for (const c of [after(i, /REGISTRO GERAL|IDENTIDADE|\bR\.?G\.?\b/), lines[i + 1], lines[i + 2]]) {
      if (!c) continue; const cc = c.replace(/([0-3]\d)[\/.\-]([01]\d)[\/.\-]((?:19|20)\d{2})/g, ' ');
      const m = cc.match(/\b\d{1,3}(?:\.\d{3}){1,3}(?:-[\dXx])?\b|\b\d{5,13}(?:-?[\dXx])?\b/g) || []; const hit = m.find(x => !cpfSet.has(x.replace(/\D/g, '')) && x.replace(/\D/g, '').length >= 5);
      if (hit) { r.rg = hit; break; }
    }
  }
  if (r.nome) r.nome = titleName(r.nome); r.filiacao = r.filiacao.map(titleName);
  return r;
}

/* ---- Fluxo “Ler documento”: foto → OCR → conferência → preenche o formulário (nunca salva sozinho) ---- */
function docOcrStart(onDone) { ocrPick('🪪 Ler documento (RG/CNH)', f => docOcrRun(f, onDone)); }
async function docOcrRun(file, onDone) {
  const prog = ocrBusySheet('🪪 Lendo documento…'); let li = null;
  try {
    li = await loadImg(file); const cv = ocrCanvas(li.img, null, 2000);
    let data = await runOcr(cv, {tessedit_pageseg_mode: '3'}, prog);
    let ex = extractDoc(data.text);
    if (!ex.nome && !ex.cpfs.length) { const d2 = await runOcr(cv, {tessedit_pageseg_mode: '11'}, prog); const e2 = extractDoc(d2.text); if (e2.nome || e2.cpfs.length) { data = d2; ex = e2; } }
    const img = await resizeJpeg(file, 2000);
    if (!$('#oc_st')) return; // fechou/travou durante a leitura
    docReview(ex, data.text, img, onDone);
  } catch (e) { console.warn(e); if (KEY) { closeSheet(); toast('Leitura falhou: ' + e.message); } }
  finally { if (li) URL.revokeObjectURL(li.u); }
}
function docReview(ex, raw, img, onDone, conf) {
  const best = ex.cpfs[0];
  const cf = k => conf && conf[k] != null ? ` <span class="confchip ${conf[k] >= 80 ? 'hi' : conf[k] >= 60 ? 'md' : 'lo'}" title="confiança do OCR">${conf[k]}%</span>` : conf ? ' <span class="confchip lo">não lido</span>' : '';
  const row = (k, lbl, inner, on) => `<div class="ocrrow"><label class="ocrl"><input type="checkbox" class="ocrck" data-k="${k}" ${on ? 'checked' : ''}> ${lbl}${cf(k === 'fil' ? 'fil' : k)}</label>${inner}</div>`;
  sheet(`<h2 style="margin-top:0">🪪 Conferir leitura${ex.cnh ? ' — CNH (modelo)' : ''}</h2>
    ${ex.cnh ? `<div class="exok" style="margin-top:4px">🪪 <b>Leitura por moldura (zona a zona)</b><div class="sub">${ex.fallback ? 'alguns campos vieram da leitura da página inteira' : 'cada campo lido na posição do modelo'} · % = confiança do OCR</div></div>${cnhObs(ex) ? `<div class="sub" style="margin:6px 4px 0">📋 ${esc(cnhObs(ex))}${conf ? ` <span class="sub">(${['registro', 'validade', 'cat'].filter(k => conf[k] != null).map(k => conf[k] + '%').join(' · ')})</span>` : ''} <span class="chip c-gray" id="or_cnhcp" style="cursor:pointer">📋 copiar</span><div class="sub" style="margin-top:2px">sem campo próprio no alvo — copie para Vínculos/observações se quiser</div></div>` : ''}` : ''}
    <div class="warn" style="margin-top:6px">A leitura automática <b>pode errar</b> (luz, foco, reflexo, modelo do documento). Confira cada campo com o documento. Só os campos marcados vão para o formulário, e nada é salvo até você tocar em <b>Salvar alvo</b>.</div>
    ${row('nome', 'Nome', `<input id="or_nome" value="${esc(ex.nome)}">`, !!ex.nome)}
    ${row('cpf', 'CPF', `<input id="or_cpf" inputmode="numeric" value="${esc(best ? cpfFmt(best.d) : '')}"><div class="sub" id="or_cpfst" style="margin:6px 4px 0"></div>${ex.cpfs.length > 1 ? `<div class="chips" style="margin-top:6px">${ex.cpfs.slice(0, 4).map(c => `<span class="chip ${c.ok ? 'c-grn' : 'c-gray'} orcpf" data-d="${c.d}">${cpfFmt(c.d)}</span>`).join('')}</div>` : ''}`, !!(best && best.ok))}
    ${row('rg', 'RG', `<input id="or_rg" value="${esc(ex.rg)}">`, !!ex.rg)}
    ${row('nasc', 'Data de nascimento', `<input id="or_nasc" type="date" value="${esc(ex.nasc)}">`, !!ex.nasc)}
    ${row('fil', 'Filiação', `<textarea id="or_fil" style="min-height:56px">${esc(ex.filiacao.join('\n'))}</textarea>`, ex.filiacao.length > 0)}
    <div class="tgrow card glass" style="cursor:default;margin:12px 0 4px"><div>🪪 Guardar esta imagem como foto do documento<div class="sub">criptografada, separada da galeria; salva junto com o alvo</div></div><div class="tg on" id="or_img"></div></div>
    <details class="ocrraw"><summary class="sub">Ver texto lido</summary><pre>${esc(raw || '(nada)')}</pre></details>
    <div class="gap"></div><div class="btn pri" id="or_ok">Preencher campos</div><div class="btn" id="or_cn" style="margin-top:10px">Cancelar</div>`, s => {
    const q = x => s.querySelector(x); let keepImg = true;
    const cpfSt = () => { const d = q('#or_cpf').value.replace(/\D/g, ''); q('#or_cpfst').innerHTML = !d ? 'Nenhum CPF encontrado — digite se quiser.' : cpfValid(d) ? '<span style="color:#7be3b0">✓ Dígitos verificadores conferem</span>' : '<span style="color:#ffadad">⚠️ Dígitos verificadores não conferem — confira</span>'; };
    q('#or_cpf').oninput = () => { cpfSt(); q('.ocrck[data-k="cpf"]').checked = !!q('#or_cpf').value.trim(); }; cpfSt();
    s.querySelectorAll('.orcpf').forEach(c => c.onclick = () => { q('#or_cpf').value = cpfFmt(c.dataset.d); q('#or_cpf').oninput(); });
    [['nome', '#or_nome'], ['rg', '#or_rg'], ['nasc', '#or_nasc'], ['fil', '#or_fil']].forEach(([k, sel]) => q(sel).addEventListener('input', () => { q(`.ocrck[data-k="${k}"]`).checked = !!q(sel).value.trim(); }));
    q('#or_img').onclick = () => { keepImg = !keepImg; q('#or_img').classList.toggle('on', keepImg); };
    if (q('#or_cnhcp')) q('#or_cnhcp').onclick = () => copyText(cnhObs(ex)).then(ok => toast(ok ? '📋 Dados da CNH copiados' : 'Não consegui copiar'));
    q('#or_cn').onclick = closeSheet;
    q('#or_ok').onclick = () => {
      const on = k => q(`.ocrck[data-k="${k}"]`).checked, v = sel => q(sel).value.trim(), set = (id, val) => { const el = $(id); if (el) { el.value = val; el.dispatchEvent(new Event('input')); } };
      const cpfD = v('#or_cpf').replace(/\D/g, ''), cpf = on('cpf') && cpfD ? (cpfD.length === 11 ? cpfFmt(cpfD) : v('#or_cpf')) : '', rg = on('rg') ? v('#or_rg') : '';
      let n = 0;
      if (on('nome') && v('#or_nome')) { set('#a_nome', v('#or_nome')); n++; }
      if (cpf || rg) { set('#a_doc', cpf && rg ? `${cpf} / RG ${rg}` : cpf || rg); n++; }
      if (on('nasc') && v('#or_nasc')) { set('#a_nasc', v('#or_nasc')); n++; }
      if (on('fil') && v('#or_fil')) { set('#a_filiacao', v('#or_fil')); n++; }
      closeSheet(); onDone && onDone({img: keepImg ? img : null}); toast(n ? `✍️ ${n} campo(s) preenchido(s) — confira e toque em Salvar alvo` : 'Nenhum campo marcado');
    };
  });
}

/* ---- Fluxo “Ler placa”: foto → arrastar retângulo → OCR → candidatos com correção por posição ---- */
const PL_L2D = {O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', J: '1', T: '7', Z: '2', S: '5', B: '8', G: '6', A: '4'};
const PL_D2L = {0: 'O', 1: 'I', 2: 'Z', 4: 'A', 5: 'S', 6: 'G', 7: 'T', 8: 'B'};
const PLATE_RE = /\b[A-Z]{3}-?\d[A-Z0-9]\d{2}\b/i;
function plateCands(raw) {
  const out = new Map();
  for (const lineRaw of String(raw || '').toUpperCase().split(/\n/)) {
    const s = lineRaw.replace(/[^A-Z0-9]/g, '');
    for (let i = 0; i + 7 <= s.length; i++) {
      const w = s.slice(i, i + 7);
      for (const fmt of ['LLLDDDD', 'LLLDLDD']) {
        let fixes = 0, r = '';
        for (let k = 0; k < 7; k++) { const c = w[k];
          if (fmt[k] === 'L') { if (/[A-Z]/.test(c)) r += c; else if (PL_D2L[c]) { r += PL_D2L[c]; fixes++; } else break; }
          else if (/\d/.test(c)) r += c; else if (PL_L2D[c]) { r += PL_L2D[c]; fixes++; } else break; }
        if (r.length === 7 && fixes <= 3) { const sc = fixes * 2 + (s.length > 7 ? 1 : 0); if (!out.has(r) || out.get(r) > sc) out.set(r, sc); }
      }
    }
  }
  return [...out].map(([p, sc]) => ({p, sc, merc: /^[A-Z]{3}\d[A-Z]\d{2}$/.test(p)})).sort((x, y) => x.sc - y.sc);
}
const plateFmt = p => /^[A-Z]{3}\d{4}$/.test(p) ? p.slice(0, 3) + '-' + p.slice(3) : p;
const plateMerc = p => /^[A-Z]{3}\d{4}$/.test(p) ? p.slice(0, 4) + 'ABCDEFGHIJ'[+p[4]] + p.slice(5) : '';
function putPlate(v, pl) { v = String(v || '').trim(); return PLATE_RE.test(v) ? v.replace(PLATE_RE, pl) : (v ? v + ' ' : '') + pl; }
function plateOcrStart(onPick) { ocrPick('🚗 Ler placa', f => plateCrop(f, onPick)); }
async function plateCrop(file, onPick) {
  let li; try { li = await loadImg(file); } catch (e) { return toast('Erro: ' + e.message); }
  const {img, u} = li; const d = document.createElement('div'); d.className = 'viewer cropv';
  d.innerHTML = `<div class="sub" style="margin-bottom:10px;text-align:center;color:#c9d6ee">Arraste um retângulo em volta da placa</div><div class="cropbox" id="cr_box"><img id="cr_img" src="${u}" draggable="false"><div class="crsel hidden" id="cr_sel"></div></div><div class="sub" id="cr_st" style="margin-top:10px;min-height:18px;text-align:center"></div><div class="grid2" style="margin-top:12px;width:100%;max-width:420px"><div class="btn" id="cr_x">Cancelar</div><div class="btn pri" id="cr_ok">Ler placa</div></div><div class="sub" style="margin-top:8px;text-align:center">Leitura no aparelho · a precisão varia com luz, ângulo e distância</div>`;
  document.body.appendChild(d);
  const box = d.querySelector('#cr_box'), sel = d.querySelector('#cr_sel'), im = d.querySelector('#cr_img'); let r = null, st = null, busy = false;
  const pt = e => { const b = im.getBoundingClientRect(); return {x: Math.max(0, Math.min(b.width, e.clientX - b.left)), y: Math.max(0, Math.min(b.height, e.clientY - b.top)), b}; };
  const draw = () => { if (!r) return sel.classList.add('hidden'); sel.classList.remove('hidden'); Object.assign(sel.style, {left: im.offsetLeft + r.x + 'px', top: im.offsetTop + r.y + 'px', width: r.w + 'px', height: r.h + 'px'}); };
  box.onpointerdown = e => { if (busy) return; e.preventDefault(); try { box.setPointerCapture(e.pointerId); } catch (x) {} st = pt(e); r = {x: st.x, y: st.y, w: 0, h: 0}; draw(); };
  box.onpointermove = e => { if (!st) return; const p = pt(e); r = {x: Math.min(st.x, p.x), y: Math.min(st.y, p.y), w: Math.abs(p.x - st.x), h: Math.abs(p.y - st.y)}; draw(); };
  box.onpointerup = box.onpointercancel = () => { st = null; if (r && (r.w < 12 || r.h < 8)) { r = null; draw(); } };
  const close = () => { d.remove(); URL.revokeObjectURL(u); };
  d.querySelector('#cr_x').onclick = close;
  d.querySelector('#cr_ok').onclick = async () => {
    if (busy) return; busy = true; const stEl = d.querySelector('#cr_st');
    const b = im.getBoundingClientRect(), kx = img.naturalWidth / b.width, ky = img.naturalHeight / b.height;
    const rc = r ? {x: Math.round(r.x * kx), y: Math.round(r.y * ky), w: Math.max(1, Math.round(r.w * kx)), h: Math.max(1, Math.round(r.h * ky))} : null;
    const prog = m => { stEl.textContent = ocrStepTxt(m) + (m.status === 'recognizing text' ? ` ${Math.round((m.progress || 0) * 100)}%` : ''); };
    let cands = [], raw = '';
    try {
      const wl = {tessedit_char_whitelist: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-'};
      const passes = rc ? [[false, '7'], [false, '13'], [true, '7']] : [[false, '11'], [false, '3']];
      for (const [inv, psm] of passes) {
        const cv = ocrCanvas(img, rc, 1600, rc ? 140 : 0, inv); const data = await runOcr(cv, {...wl, tessedit_pageseg_mode: psm}, prog); raw += data.text + '\n';
        cands = plateCands(raw); if (cands.length && cands[0].sc <= 1) break; if (!d.isConnected) return;
      }
    } catch (e) { console.warn(e); busy = false; if (d.isConnected) stEl.textContent = 'Leitura falhou: ' + e.message; return; }
    busy = false; if (!d.isConnected) return; close(); plateReview(cands, raw, onPick);
  };
}
function plateReview(cands, raw, onPick) {
  const best = cands[0];
  sheet(`<h2 style="margin-top:0">🚗 Conferir placa</h2>
    <div class="warn" style="margin-top:6px">${best ? 'Confira com a foto: a leitura automática pode trocar letras e números parecidos (O/0, I/1, B/8, S/5, Z/2).' : 'Não encontrei uma placa no formato brasileiro. Tente recortar mais justo na placa, com boa luz — ou digite abaixo.'}</div>
    <label>Placa (ABC1234 ou Mercosul ABC1D23)</label><input id="pr_p" value="${esc(best ? best.p : '')}" autocapitalize="characters" style="font-size:22px;letter-spacing:3px;font-weight:700;text-transform:uppercase">
    <div class="sub" id="pr_st" style="margin:6px 4px 0"></div>
    ${cands.length > 1 ? `<div class="sub" style="margin:10px 4px 4px">Outras leituras possíveis:</div><div class="chips">${cands.slice(1, 6).map(c => `<span class="chip c-gray prc" data-p="${c.p}">${plateFmt(c.p)}</span>`).join('')}</div>` : ''}
    <details class="ocrraw"><summary class="sub">Ver texto lido</summary><pre>${esc(raw.trim() || '(nada)')}</pre></details>
    <div class="gap"></div><div class="btn pri" id="pr_ok">Usar no campo Veículo</div><div class="btn" id="pr_cn" style="margin-top:10px">Cancelar</div>`, s => {
    const q = x => s.querySelector(x); const norm = () => q('#pr_p').value.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const upd = () => { const p = norm(); q('#pr_st').innerHTML = /^[A-Z]{3}\d{4}$/.test(p) ? `Modelo antigo · ${plateFmt(p)} · equivalente Mercosul: <b>${plateMerc(p)}</b>` : /^[A-Z]{3}\d[A-Z]\d{2}$/.test(p) ? 'Padrão Mercosul ✓' : p ? '<span style="color:#ffadad">⚠️ Formato não reconhecido</span>' : ''; };
    q('#pr_p').oninput = upd; upd();
    s.querySelectorAll('.prc').forEach(c => c.onclick = () => { q('#pr_p').value = c.dataset.p; upd(); });
    q('#pr_cn').onclick = closeSheet;
    q('#pr_ok').onclick = () => { const p = norm(); if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(p)) return toast('Placa inválida — use ABC1234 ou ABC1D23'); closeSheet(); onPick(plateFmt(p)); };
  });
}

/* ============ v0.6 Etapa B2 — Diário de vigilância, rota, régua e trajeto gravado — by @aiforge.team ============ */
/* Modelo (dentro da operação, criptografado junto com o resto do estado):
   op.vig      = [{id, ini, fim, alvoId, alvoNome, titulo}]                       sessões de vigilância
   op.diario   = [{id, sess, ts, k, txt?, com?, comNome?, placa?, veic?, lat?, lng?, acc?}]   k: chegou|saiu|encontro|veiculo|obs
   op.trajetos = [{id, sess, ini, fim, pts: [[lat, lng, ts, acc], …]}]             trajetos gravados (sess opcional) */
const isIOS = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const hav = (a, b) => { const R = 6371008.8, r = Math.PI / 180, dLa = (b[0] - a[0]) * r, dLo = (b[1] - a[1]) * r; const h = Math.sin(dLa / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dLo / 2) ** 2; return 2 * R * Math.asin(Math.min(1, Math.sqrt(h))); };
const distTxt = m => m >= 1000 ? (m / 1000).toLocaleString('pt-BR', {minimumFractionDigits: m >= 10000 ? 1 : 2, maximumFractionDigits: m >= 10000 ? 1 : 2}) + ' km' : Math.round(m || 0) + ' m';
const durHM = ms => { const s = Math.max(0, Math.round((ms || 0) / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60; return h ? `${h} h ${String(m).padStart(2, '0')} min` : m ? `${m} min ${String(x).padStart(2, '0')} s` : `${x} s`; };
const hms = ts => new Date(ts).toLocaleTimeString('pt-BR', {hour: '2-digit', minute: '2-digit', second: '2-digit'});
const trackDist = t => { let d = 0; const p = (t && t.pts) || []; for (let i = 1; i < p.length; i++) d += hav(p[i - 1], p[i]); return d; };
const trackDur = t => { const p = (t && t.pts) || []; return p.length ? Math.max(0, (t.fim || p[p.length - 1][2]) - (t.ini || p[0][2])) : 0; };
const toLocalInput = ts => { const d = new Date(ts), z = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}:${z(d.getSeconds())}`; };

/* ---------- Diário de vigilância ---------- */
const VIG_K = {chegou: ['🟢', 'Chegou'], saiu: ['🔴', 'Saiu'], encontro: ['🤝', 'Encontro'], veiculo: ['🚗', 'Veículo'], obs: ['🗒️', 'Observação']};
const vigS = (op, id) => ((op && op.vig) || []).find(s => s.id === id);
const vigNome = (id, snap) => (id && getAlvo(id) ? getAlvo(id).nome : '') || snap || '';
const vigTitulo = (op, s) => s.titulo || ('Vigilância' + (vigNome(s.alvoId, s.alvoNome) ? ' — ' + vigNome(s.alvoId, s.alvoNome) : ''));
/* alvos envolvidos num registro: o da sessão (ou o do próprio registro) e, no encontro, a outra pessoa se for alvo */
function vigAlvos(op, e) { const s = vigS(op, e.sess); return [...new Set([e.alvoId || (s && s.alvoId) || '', e.k === 'encontro' ? e.com || '' : ''].filter(Boolean))]; }
function vigTxt(op, e) {
  const s = vigS(op, e.sess); const who = vigNome(e.alvoId, e.alvoNome) || (s ? vigNome(s.alvoId, s.alvoNome) : ''); const n = e.txt ? (e.k === 'obs' ? '' : ' — ' + e.txt) : '';
  if (e.k === 'chegou') return (who ? who + ' chegou' : 'Chegada') + n;
  if (e.k === 'saiu') return (who ? who + ' saiu' : 'Saída') + n;
  if (e.k === 'encontro') return `${who || 'Alvo'} encontrou com ${vigNome(e.com, e.comNome) || '?'}` + n;
  if (e.k === 'veiculo') return `Veículo${e.placa ? ' ' + e.placa : ''}${e.veic ? ' (' + e.veic + ')' : ''}` + n;
  return e.txt || 'Observação';
}
/* grava o estado com a chave e o banco do momento (seguro mesmo se o cofre travar logo depois) */
function saveNow() { if (!KEY || !S) return Promise.resolve(); const db = DB.db, k = KEY, data = enc.encode(JSON.stringify(S)); return seal(k, data).then(box => DB.set('data', box, db)); }

function vigCard(op) {
  const ss = op.vig || [], act = ss.filter(s => !s.fim).sort((x, y) => y.ini - x.ini), nTr = (op.trajetos || []).filter(t => t.pts.length > 1).length, rec = TRK && TRK.opId === op.id;
  const nReg = s => (op.diario || []).filter(e => e.sess === s.id).length;
  return `<h2>👁️ Vigilância</h2><div class="card glass" id="vig_card" style="cursor:default">
    ${act.map(s => `<div class="row vigact" data-s="${s.id}" onclick="location.hash='#vig/${op.id}/${s.id}'"><div><div class="t">🟡 ${esc(vigTitulo(op, s))}</div><div class="sub">em andamento desde ${fmt(s.ini)} · ${nReg(s)} registro(s)</div></div><b>›</b></div>`).join('')}
    <div class="sub">${ss.length} sessão(ões) · ${(op.diario || []).length} registro(s) · ${nTr} trajeto(s)${rec ? ' · <span style="color:#ff9a9a">🔴 gravando trajeto</span>' : ''}</div>
    <div class="grid2" style="margin-top:10px"><div class="btn pri" id="vig_new" onclick="vigNovaSheet('${op.id}')">▶ Nova sessão</div><div class="btn" id="vig_dia" onclick="location.hash='#diario/${op.id}'">📒 Diário</div></div>
    <div class="btn" id="vig_trk" style="margin-top:10px" onclick="trackToggle('${op.id}')">${rec ? '⏹ Parar trajeto' : '🛰️ Gravar trajeto'}</div></div>`;
}
/* linha do tempo da operação na tela (mesmos eventos do relatório PDF) */
function opTimelineBox(id) {
  const ev = opReportData(id).ev.slice().reverse(), MAX = 300;
  return `<details class="glass optl" id="op_tl"><summary>🕓 Linha do tempo da operação (${ev.length})</summary>${ev.length ? `<div class="tl" style="margin-top:10px">${ev.slice(0, MAX).map(e => `<div class="tli glass"><div class="sub">${e.dia ? new Date(e.ts).toLocaleDateString('pt-BR') : fmt(e.ts)} · ${esc(e.k)}</div><div style="margin-top:3px">${esc(e.t)}</div></div>`).join('')}</div>${ev.length > MAX ? `<div class="sub" style="margin:4px">Mostrando os ${MAX} mais recentes — o relatório PDF traz todos.</div>` : ''}` : '<div class="sub" style="margin:10px 4px 0">Nada registrado ainda.</div>'}</details>`;
}
function vigNovaSheet(opId, alvoId) {
  const op = getOp(opId); if (!op) return; const als = S.alvos.filter(a => a.opId === opId);
  sheet(`<h2 style="margin-top:0">👁️ Nova sessão de vigilância</h2><div class="sub">${esc(op.nome)} · a hora de início é agora</div>
    <label>Alvo vigiado (opcional)</label><select id="vn_a"><option value="">— nenhum / não cadastrado —</option>${als.map(a => `<option value="${a.id}" ${a.id === alvoId ? 'selected' : ''}>${esc(a.nome)}${a.apelido ? ' “' + esc(a.apelido) + '”' : ''}</option>`).join('')}</select>
    <div id="vn_lw" class="${alvoId ? 'hidden' : ''}"><label>Pessoa não cadastrada (opcional)</label><input id="vn_l" placeholder="Ex.: homem de boné vermelho"></div>
    <label>Título / local (opcional)</label><input id="vn_t" placeholder="Ex.: campana na Rua Exemplo">
    <div class="tgrow card glass" style="cursor:default;margin-top:12px"><div>🛰️ Gravar trajeto junto<div class="sub">usa o GPS continuamente · veja o aviso ao iniciar</div></div><div class="tg" id="vn_tr"></div></div>
    <div class="gap"></div><div class="btn pri" id="vn_ok">▶ Iniciar sessão</div>`, s => {
    const q = x => s.querySelector(x); let tr = false;
    q('#vn_a').onchange = () => q('#vn_lw').classList.toggle('hidden', !!q('#vn_a').value);
    q('#vn_tr').onclick = e => { tr = !tr; e.target.classList.toggle('on', tr); };
    q('#vn_ok').onclick = async () => {
      const aid = q('#vn_a').value, sx = {id: uid(), ini: Date.now(), fim: null, alvoId: aid, alvoNome: aid ? getAlvo(aid).nome : q('#vn_l').value.trim(), titulo: q('#vn_t').value.trim()};
      op.vig = op.vig || []; op.vig.push(sx); await save(); closeSheet(); location.hash = `#vig/${op.id}/${sx.id}`; toast('👁️ Sessão iniciada');
      if (tr) setTimeout(() => trackStartSheet(op.id, sx.id), 500);
    };
  });
}
function viewDiario(opId) {
  tabs('ops'); const op = getOp(opId); if (!op) return location.hash = '#ops';
  const ss = (op.vig || []).slice().sort((x, y) => y.ini - x.ini), trs = (op.trajetos || []).filter(t => t.pts.length > 1 || (TRK && TRK.t === t)).sort((x, y) => y.ini - x.ini);
  const nReg = s => (op.diario || []).filter(e => e.sess === s.id).length;
  APP.innerHTML = `<div class="back" onclick="location.hash='#op/${op.id}'">‹ ${esc(op.nome)}</div>
  <div class="top"><div><h1>Diário de vigilância</h1><div class="sub">${ss.length} sessão(ões) · ${(op.diario || []).length} registro(s)</div></div><div class="btn sm pri" id="dv_new">▶ Nova</div></div>
  ${ss.length ? ss.map(s => `<div class="card glass vsess" data-s="${s.id}" onclick="location.hash='#vig/${op.id}/${s.id}'"><div class="row"><div><div class="t">${esc(vigTitulo(op, s))}</div><div class="sub">${fmt(s.ini)}${s.fim ? ' – ' + fmt(s.fim) : ''} · ${nReg(s)} registro(s)</div></div>${s.fim ? '<span class="chip c-gray">Encerrada</span>' : '<span class="chip c-amb">Em andamento</span>'}</div></div>`).join('') : '<div class="empty"><div>👁️</div>Nenhuma sessão. Toque em <b>Nova</b> para começar a registrar.</div>'}
  <h2>🛰️ Trajetos gravados (${trs.length})</h2>
  ${trs.length ? `<div class="card glass list" style="cursor:default;padding:0" id="dv_trs">${trs.map(t => { const s = vigS(op, t.sess), live = TRK && TRK.t === t; return `<div class="li"><span><b style="font-weight:600;color:var(--txt)">${fmt(t.ini)}</b>${live ? ' <span style="color:#ff9a9a">🔴 gravando</span>' : ''}<br><span class="sub">${distTxt(trackDist(t))} · ${durHM(live ? Date.now() - t.ini : trackDur(t))} · ${t.pts.length} ponto(s)${s ? ' · ' + esc(vigTitulo(op, s)) : ''}</span></span><b style="white-space:nowrap"><span class="trm" data-t="${t.id}" style="cursor:pointer">🗺️</span>&nbsp;&nbsp;${live ? '' : `<span class="trd" data-t="${t.id}" style="cursor:pointer">🗑️</span>`}</b></div>`; }).join('')}</div>` : '<div class="sub" style="margin:0 4px">Nenhum trajeto. Use <b>🛰️ Gravar trajeto</b> na operação ou na sessão.</div>'}
  <div class="btn" style="margin-top:12px" id="dv_trk">${TRK && TRK.opId === op.id ? '⏹ Parar trajeto' : '🛰️ Gravar trajeto'}</div>`;
  $('#dv_new').onclick = () => vigNovaSheet(op.id); $('#dv_trk').onclick = () => trackToggle(op.id);
  APP.querySelectorAll('.trm').forEach(el => el.onclick = () => trackShow(op, el.dataset.t));
  APP.querySelectorAll('.trd').forEach(el => el.onclick = async () => { const t = op.trajetos.find(x => x.id === el.dataset.t); if (!t || !await confirmBox(`Excluir o trajeto de ${fmt(t.ini)} (${distTxt(trackDist(t))})?`, 'Excluir', true)) return; op.trajetos = op.trajetos.filter(x => x !== t); await save(); route(); toast('Trajeto excluído'); });
}
function trackShow(op, tid) { const t = (op.trajetos || []).find(x => x.id === tid); if (!t || !t.pts.length) return; MF = mfNew(); MF.op = op.id; window._offFit = t.pts.map(p => [p[0], p[1]]); location.hash = '#mapa'; }
let VIG_PEND = new Set(), VIG_LAST = {};
function viewVig(opId, sid) {
  tabs('ops'); const op = getOp(opId); const s = vigS(op, sid); if (!s) return location.hash = op ? '#diario/' + opId : '#ops';
  APP.innerHTML = `<div class="back" onclick="location.hash='#diario/${op.id}'">‹ Diário · ${esc(op.nome)}</div>
  <div class="top"><div><h1 id="vs_h">${esc(vigTitulo(op, s))}</h1><div class="sub" id="vs_st">${s.fim ? `Encerrada · ${fmt(s.ini)} – ${fmt(s.fim)}` : `🟡 Em andamento desde ${fmt(s.ini)}`}</div></div><div class="btn sm" id="vs_ed">Editar</div></div>
  <div class="vigbtns">${['chegou', 'saiu', 'encontro', 'veiculo', 'obs'].map(k => `<div class="vbtn glass ${k === 'obs' ? 'wide' : ''}" id="vb_${k}" data-k="${k}"><em>${VIG_K[k][0]}</em>${k === 'encontro' ? 'Encontrou com…' : VIG_K[k][1]}</div>`).join('')}</div>
  <div class="sub" style="margin:8px 4px 0">Cada toque registra a hora e, se possível, o GPS. Toque num registro para corrigir ou excluir.</div>
  <div class="card glass" style="cursor:default;margin-top:12px" id="vs_trk"></div>
  <h2 id="vs_n"></h2><div id="vs_list"></div>
  <div class="grid2" style="margin-top:14px"><div class="btn" id="vs_map">🗺️ Ver no mapa</div><div class="btn" id="vs_end">${s.fim ? '↺ Reabrir sessão' : '⏹ Encerrar sessão'}</div></div>
  <div class="btn dan" id="vs_del" style="margin-top:10px">Excluir sessão</div>`;
  const paint = () => {
    if (!$('#vs_list')) return; const es = (op.diario || []).filter(e => e.sess === s.id).sort((x, y) => y.ts - x.ts);
    $('#vs_n').textContent = `Registros (${es.length})`;
    $('#vs_list').innerHTML = es.length ? `<div class="card glass list" style="cursor:default;padding:0">${es.map(e => `<div class="li vrow" data-e="${e.id}" style="cursor:pointer;align-items:flex-start"><span style="color:var(--txt)"><b style="font-weight:700">${VIG_K[e.k] ? VIG_K[e.k][0] : '🗒️'} ${hms(e.ts)}</b> <span class="sub">${new Date(e.ts).toLocaleDateString('pt-BR')}</span><br>${esc(vigTxt(op, e))}<br><span class="sub">${e.lat != null ? '📍 ' + coord(e) + accTxt(e) : VIG_PEND.has(e.id) ? '📡 obtendo GPS…' : 'sem GPS'}</span></span><b>✏️</b></div>`).join('')}</div>` : '<div class="sub" style="margin:0 4px">Nenhum registro ainda.</div>';
    $('#vs_list').querySelectorAll('.vrow').forEach(el => el.onclick = () => vigEditSheet(op, s, op.diario.find(e => e.id === el.dataset.e)));
    const recHere = TRK && TRK.opId === op.id && TRK.sess === s.id, trs = (op.trajetos || []).filter(t => t.sess === s.id && t.pts.length > 1 && !(TRK && TRK.t === t));
    $('#vs_trk').innerHTML = (recHere ? `<div class="t">🔴 Gravando trajeto desta sessão</div><div class="sub" data-trklive style="margin-top:4px"></div><div class="btn dan" id="vs_tk" style="margin-top:10px">⏹ Parar trajeto</div>`
      : TRK ? `<div class="sub">🔴 Há outro trajeto em gravação (${esc(getOp(TRK.opId)?.nome || '')}).</div><div class="btn" id="vs_tk" style="margin-top:10px">⏹ Parar aquele trajeto</div>`
      : `<div class="btn" id="vs_tk">🛰️ Gravar trajeto desta sessão</div><div class="sub" style="margin-top:6px">📵 iPhone: o GPS para quando a tela bloqueia ou o app sai da frente.</div>`)
      + (trs.length ? `<div class="sub" style="margin-top:8px">Trajetos: ${trs.map(t => `<span class="trm" data-t="${t.id}" style="cursor:pointer;color:#9cbcff">${hms(t.ini)} · ${distTxt(trackDist(t))} · ${durHM(trackDur(t))}</span>`).join(' · ')}</div>` : '');
    $('#vs_tk').onclick = () => trackToggle(op.id, s.id); $('#vs_trk').querySelectorAll('.trm').forEach(el => el.onclick = () => trackShow(op, el.dataset.t)); trackPaint();
  };
  window._vigPaint = {op: op.id, s: s.id, paint}; paint();
  APP.querySelectorAll('.vbtn').forEach(b => b.onclick = () => {
    const k = b.dataset.k, now = Date.now(); if (now - (VIG_LAST[k] || 0) < 700) return; VIG_LAST[k] = now; // toque duplo acidental
    if (k === 'chegou' || k === 'saiu') { b.classList.add('flash'); setTimeout(() => b.classList.remove('flash'), 450); return vigLog(op, s, k, {}); }
    const gp = vigGps(); // hora e GPS valem do toque, não de quando o formulário for salvo
    if (k === 'encontro') vigEncontroSheet(op, s, {ts: now, gp});
    else if (k === 'veiculo') vigVeicSheet(op, s, {ts: now, gp});
    else vigObsSheet(op, s, {ts: now, gp});
  });
  $('#vs_ed').onclick = () => vigSessSheet(op, s);
  $('#vs_map').onclick = () => { const pts = [...(op.diario || []).filter(e => e.sess === s.id && e.lat != null).map(e => [e.lat, e.lng]), ...(op.trajetos || []).filter(t => t.sess === s.id).flatMap(t => t.pts.map(p => [p[0], p[1]]))]; MF = mfNew(); MF.op = op.id; if (pts.length) window._offFit = pts; location.hash = '#mapa'; };
  $('#vs_end').onclick = async () => { if (s.fim) { s.fim = null; await save(); route(); return toast('Sessão reaberta'); } if (!await confirmBox('Encerrar esta sessão de vigilância?', 'Encerrar')) return; s.fim = Date.now(); if (TRK && TRK.opId === op.id && TRK.sess === s.id) trackStop(); await save(); route(); toast('⏹ Sessão encerrada'); };
  $('#vs_del').onclick = async () => {
    const n = (op.diario || []).filter(e => e.sess === s.id).length;
    if (!await confirmBox(`Excluir a sessão e seus ${n} registro(s)? Os trajetos gravados continuam na operação.`, 'Excluir', true)) return;
    if (TRK && TRK.opId === op.id && TRK.sess === s.id) TRK.sess = TRK.t.sess = '';
    op.diario = (op.diario || []).filter(e => e.sess !== s.id); op.vig = op.vig.filter(x => x !== s); (op.trajetos || []).forEach(t => { if (t.sess === s.id) t.sess = ''; });
    await save(); location.hash = '#diario/' + op.id; toast('Sessão excluída');
  };
}
const vigRepaint = (op, s) => { const v = window._vigPaint; if (v && v.op === op.id && v.s === s.id && location.hash === `#vig/${op.id}/${s.id}`) v.paint(); };
/* posição para o registro: a do trajeto em gravação, se recente; senão uma leitura nova do GPS */
function vigGps() {
  const f = trackFix(); if (f) return Promise.resolve(f);
  hold(20000); return geo().then(g => { release(); return g; });
}
async function vigLog(op, s, k, extra, ts, gp) {
  const e = {id: uid(), sess: s.id, ts: ts || Date.now(), k, ...extra}; Object.keys(e).forEach(x => { if (e[x] === '' || e[x] == null) delete e[x]; });
  const f = trackFix(); if (f && !gp) Object.assign(e, f);
  op.diario = op.diario || []; op.diario.push(e); if (e.lat == null) VIG_PEND.add(e.id);
  await save(); vigRepaint(op, s); toast(`✔ ${VIG_K[k][0]} ${VIG_K[k][1]} · ${hms(e.ts)}`);
  if (e.lat != null) return e;
  const g = await (gp || vigGps()); VIG_PEND.delete(e.id);
  if (!S || getOp(op.id) !== op || !op.diario.includes(e)) return e; // cofre travou ou registro apagado
  if (g) { Object.assign(e, {lat: g.lat, lng: g.lng, acc: g.acc}); await save(); }
  vigRepaint(op, s); return e;
}
function vigEncontroSheet(op, s, ctx) {
  const als = S.alvos.filter(a => a.opId === op.id && a.id !== s.alvoId); let sel = '';
  sheet(`<h2 style="margin-top:0">🤝 Encontrou com…</h2><div class="sub">${hms(ctx.ts)} · ${esc(vigNome(s.alvoId, s.alvoNome) || 'alvo da sessão')}</div>
    ${als.length ? `<label>Alvo da operação</label><div class="chips" id="ve_al">${als.map(a => `<span class="chip c-gray" data-a="${a.id}" style="cursor:pointer;font-size:13px;padding:7px 12px">${esc(a.nome)}</span>`).join('')}</div>` : ''}
    <label>${als.length ? 'Ou pessoa não cadastrada' : 'Pessoa'}</label><input id="ve_l" placeholder="Ex.: homem de moto preta">
    <label>Observação (opcional)</label><textarea id="ve_t" data-mic style="min-height:70px"></textarea>
    <div class="gap"></div><div class="btn pri" id="ve_ok">Registrar encontro</div>`, sh => {
    sh.querySelectorAll('#ve_al .chip').forEach(c => c.onclick = () => { sel = sel === c.dataset.a ? '' : c.dataset.a; sh.querySelectorAll('#ve_al .chip').forEach(x => x.className = 'chip ' + (x.dataset.a === sel ? 'c-blue' : 'c-gray')); if (sel) sh.querySelector('#ve_l').value = ''; });
    sh.querySelector('#ve_l').oninput = () => { if (sh.querySelector('#ve_l').value.trim() && sel) { sel = ''; sh.querySelectorAll('#ve_al .chip').forEach(x => x.className = 'chip c-gray'); } };
    sh.querySelector('#ve_ok').onclick = () => {
      const livre = sh.querySelector('#ve_l').value.trim(); if (!sel && !livre) return toast('Escolha um alvo ou escreva quem é');
      const d = {com: sel, comNome: sel ? getAlvo(sel).nome : livre, txt: sh.querySelector('#ve_t').value.trim()}; closeSheet(); vigLog(op, s, 'encontro', d, ctx.ts, ctx.gp);
    };
  });
}
function vigVeicSheet(op, s, ctx) {
  sheet(`<h2 style="margin-top:0">🚗 Veículo</h2><div class="sub">${hms(ctx.ts)}</div>
    <div class="lblrow"><label>Placa</label><div class="btn sm" id="vv_ocr">📷 Ler placa</div></div><input id="vv_p" value="${esc(ctx.placa)}" autocapitalize="characters" placeholder="ABC1D23" style="font-size:20px;letter-spacing:2px;font-weight:700;text-transform:uppercase">
    <label>Modelo / cor (opcional)</label><input id="vv_v" value="${esc(ctx.veic)}" placeholder="Ex.: Gol prata">
    <label>Observação (opcional)</label><textarea id="vv_t" data-mic style="min-height:60px">${esc(ctx.txt)}</textarea>
    <div class="gap"></div><div class="btn pri" id="vv_ok">Registrar veículo</div>`, sh => {
    const q = x => sh.querySelector(x); const cur = () => ({...ctx, placa: q('#vv_p').value, veic: q('#vv_v').value, txt: q('#vv_t').value});
    q('#vv_ocr').onclick = () => { const c = cur(); closeSheet(); plateOcrStart(pl => vigVeicSheet(op, s, {...c, placa: pl})); };
    q('#vv_ok').onclick = () => {
      const raw = q('#vv_p').value.toUpperCase().replace(/[^A-Z0-9]/g, ''), veic = q('#vv_v').value.trim();
      if (!raw && !veic) return toast('Informe a placa ou o modelo');
      if (raw && !/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(raw)) setTimeout(() => toast('⚠️ Placa fora do padrão ABC1234 / ABC1D23 — confira no registro'), 2700);
      const d = {placa: raw ? plateFmt(raw) : '', veic, txt: q('#vv_t').value.trim()}; closeSheet(); vigLog(op, s, 'veiculo', d, ctx.ts, ctx.gp);
    };
  });
}
function vigObsSheet(op, s, ctx) {
  sheet(`<h2 style="margin-top:0">🗒️ Observação</h2><div class="sub">${hms(ctx.ts)}</div><textarea id="vo_t" data-mic placeholder="O que foi visto, com quem, direção…" style="min-height:130px"></textarea><div class="gap"></div><div class="btn pri" id="vo_ok">Registrar observação</div>`, sh => {
    sh.querySelector('#vo_t').focus();
    sh.querySelector('#vo_ok').onclick = () => { const t = sh.querySelector('#vo_t').value.trim(); if (!t) return toast('Escreva a observação'); closeSheet(); vigLog(op, s, 'obs', {txt: t}, ctx.ts, ctx.gp); };
  });
}
function vigEditSheet(op, s, e) {
  if (!e) return; const als = S.alvos.filter(a => a.opId === op.id && a.id !== s.alvoId); let noGps = false;
  sheet(`<h2 style="margin-top:0">${VIG_K[e.k] ? VIG_K[e.k][0] + ' ' + VIG_K[e.k][1] : 'Registro'}</h2>
    <label>Data e hora</label><input id="vx_ts" type="datetime-local" step="1" value="${toLocalInput(e.ts)}">
    <label>Tipo</label><select id="vx_k">${Object.entries(VIG_K).map(([k, v]) => `<option value="${k}" ${e.k === k ? 'selected' : ''}>${v[0]} ${v[1]}</option>`).join('')}</select>
    <div id="vx_enc" class="${e.k === 'encontro' ? '' : 'hidden'}"><label>Encontrou com (alvo)</label><select id="vx_c"><option value="">— pessoa não cadastrada —</option>${als.map(a => `<option value="${a.id}" ${e.com === a.id ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}</select><label>Nome (se não cadastrada)</label><input id="vx_cn" value="${esc(e.com && getAlvo(e.com) ? '' : e.comNome)}"></div>
    <div id="vx_vei" class="${e.k === 'veiculo' ? '' : 'hidden'}"><div class="grid2"><div><label>Placa</label><input id="vx_p" value="${esc(e.placa)}" autocapitalize="characters" style="text-transform:uppercase"></div><div><label>Modelo / cor</label><input id="vx_v" value="${esc(e.veic)}"></div></div></div>
    <label>${e.k === 'obs' ? 'Observação' : 'Observação (opcional)'}</label><textarea id="vx_t" data-mic style="min-height:80px">${esc(e.txt)}</textarea>
    <div class="sub" id="vx_g" style="margin:10px 4px">${e.lat != null ? `📍 ${coord(e)}${accTxt(e)} · <span id="vx_ng" style="color:#ffadad;cursor:pointer">remover GPS</span>` : 'Sem GPS neste registro.'}</div>
    ${e.lat != null ? '<div class="btn sm" id="vx_rota" style="display:inline-flex;margin-bottom:8px">🧭 Rota até aqui</div>' : ''}
    <div class="gap"></div><div class="btn pri" id="vx_ok">Salvar</div><div class="btn dan" id="vx_del" style="margin-top:10px">Excluir registro</div>`, sh => {
    const q = x => sh.querySelector(x);
    q('#vx_k').onchange = () => { q('#vx_enc').classList.toggle('hidden', q('#vx_k').value !== 'encontro'); q('#vx_vei').classList.toggle('hidden', q('#vx_k').value !== 'veiculo'); };
    if (q('#vx_ng')) q('#vx_ng').onclick = () => { noGps = true; q('#vx_g').textContent = 'O GPS será removido ao salvar.'; };
    if (q('#vx_rota')) q('#vx_rota').onclick = () => rotaSheet([{label: vigTxt(op, e), lat: e.lat, lng: e.lng}], vigTitulo(op, s));
    q('#vx_ok').onclick = async () => {
      const ts = new Date(q('#vx_ts').value).getTime(); if (!isFinite(ts)) return toast('Data/hora inválida');
      const k = q('#vx_k').value, txt = q('#vx_t').value.trim(); if (k === 'obs' && !txt) return toast('Escreva a observação');
      const d = {ts, k, txt}; ['com', 'comNome', 'placa', 'veic'].forEach(x => delete e[x]);
      if (k === 'encontro') { const c = q('#vx_c').value, cn = q('#vx_cn').value.trim(); if (!c && !cn) return toast('Diga com quem foi o encontro'); Object.assign(d, c ? {com: c, comNome: getAlvo(c).nome} : {comNome: cn}); }
      if (k === 'veiculo') { const raw = q('#vx_p').value.toUpperCase().replace(/[^A-Z0-9]/g, ''); Object.assign(d, {placa: raw ? plateFmt(raw) : '', veic: q('#vx_v').value.trim()}); }
      Object.assign(e, d); Object.keys(e).forEach(x => { if (e[x] === '') delete e[x]; });
      if (noGps) { delete e.lat; delete e.lng; delete e.acc; }
      e.edit = Date.now(); await save(); closeSheet(); vigRepaint(op, s); toast('Registro atualizado');
    };
    q('#vx_del').onclick = async () => { if (!await confirmBox('Excluir este registro do diário?', 'Excluir', true)) return; op.diario = op.diario.filter(x => x !== e); await save(); vigRepaint(op, s); toast('Registro excluído'); };
  });
}
function vigSessSheet(op, s) {
  const als = S.alvos.filter(a => a.opId === op.id);
  sheet(`<h2 style="margin-top:0">Editar sessão</h2>
    <label>Alvo vigiado</label><select id="vq_a"><option value="">— nenhum / não cadastrado —</option>${als.map(a => `<option value="${a.id}" ${s.alvoId === a.id ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}</select>
    <div id="vq_lw" class="${s.alvoId ? 'hidden' : ''}"><label>Pessoa não cadastrada</label><input id="vq_l" value="${esc(s.alvoId ? '' : s.alvoNome)}"></div>
    <label>Título / local</label><input id="vq_t" value="${esc(s.titulo)}">
    <div class="grid2"><div><label>Início</label><input id="vq_i" type="datetime-local" value="${toLocalInput(s.ini).slice(0, 16)}"></div><div><label>Fim</label><input id="vq_f" type="datetime-local" value="${s.fim ? toLocalInput(s.fim).slice(0, 16) : ''}"></div></div>
    <div class="gap"></div><div class="btn pri" id="vq_ok">Salvar</div>`, sh => {
    const q = x => sh.querySelector(x);
    q('#vq_a').onchange = () => q('#vq_lw').classList.toggle('hidden', !!q('#vq_a').value);
    q('#vq_ok').onclick = async () => {
      const ini = new Date(q('#vq_i').value).getTime(), fim = q('#vq_f').value ? new Date(q('#vq_f').value).getTime() : null;
      if (!isFinite(ini)) return toast('Início inválido'); if (fim != null && fim < ini) return toast('O fim é antes do início');
      const aid = q('#vq_a').value; Object.assign(s, {alvoId: aid, alvoNome: aid ? getAlvo(aid).nome : q('#vq_l').value.trim(), titulo: q('#vq_t').value.trim(), ini, fim});
      await save(); closeSheet(); route(); toast('Sessão atualizada');
    };
  });
}

/* ---------- Rota em apps de navegação ---------- */
function rotaDests(a) {
  return (a.locais || []).filter(l => validLatLng(+l.lat, +l.lng)).sort((x, y) => y.ts - x.ts).slice(0, 8)
    .map(l => ({label: `${(TIPOS[l.tipo] || TIPOS.outro)[0]} ${l.titulo || (TIPOS[l.tipo] || TIPOS.outro)[1]}`, lat: +l.lat, lng: +l.lng}));
}
const rotaLinks = d => { const ll = `${(+d.lat).toFixed(6)},${(+d.lng).toFixed(6)}`; return [['🚙 Waze', `https://waze.com/ul?ll=${ll}&navigate=yes`, 'waze'], ['🗺️ Google Maps', `https://www.google.com/maps/dir/?api=1&destination=${ll}`, 'gmaps'], ...(isIOS() ? [['🍎 Apple Maps', `https://maps.apple.com/?daddr=${ll}`, 'apple']] : [])]; };
function rotaSheet(dests, nome) {
  dests = (dests || []).filter(d => d && validLatLng(+d.lat, +d.lng)); if (!dests.length) return toast('Sem coordenadas para traçar a rota');
  window._map && window._map.closePopup();
  sheet(`<h2 style="margin-top:0">🧭 Rota</h2>${nome ? `<div class="sub">${esc(nome)}</div>` : ''}
    ${dests.map(d => `<div class="card glass rota" style="cursor:default"><div class="t" style="font-size:14px">${esc(d.label || 'Destino')}</div><div class="sub">${(+d.lat).toFixed(5)}, ${(+d.lng).toFixed(5)}</div><div class="rbtns">${rotaLinks(d).map(([n, u, k]) => `<a class="btn sm" data-app="${k}" href="${u}" target="_blank" rel="noopener noreferrer">${n}</a>`).join('')}</div></div>`).join('')}
    <div class="warn" style="margin-bottom:0">🔐 Só as <b>coordenadas do destino</b> vão para o app escolhido (Waze, Google ou Apple) e podem ficar no histórico da conta dele. Nome do alvo e demais dados não saem do cofre. Ao abrir o app de navegação, o cofre trava.</div>`);
}

/* ---------- Medir distância (régua no mapa) ---------- */
let MEAS = null;
function measureTool(map) {
  if (MEAS) return measureEnd();
  const bar = $('#draw_bar'); if (!bar) return; const g = L.layerGroup().addTo(map), pts = []; const box = map.getContainer();
  bar.innerHTML = `<div class="t" style="font-size:14px">📏 Medir distância</div><div class="sub" id="ms_info" style="margin:4px 0 2px;height:18px;overflow:hidden"></div><div class="sub" id="ms_seg" style="height:36px;overflow:auto;margin-bottom:8px;line-height:1.45"></div>
    <div style="display:flex;gap:8px"><div class="btn sm" id="ms_un">↶ Desfazer</div><div class="btn sm" id="ms_clr">Limpar</div><div class="btn sm pri" id="ms_x" style="flex:1">Fechar</div></div>`;
  const draw = () => {
    g.clearLayers(); let tot = 0; const seg = [];
    if (pts.length > 1) L.polyline(pts, {color: '#ffd43b', weight: 3, dashArray: '7 6', interactive: false}).addTo(g);
    for (let i = 1; i < pts.length; i++) { const d = hav([pts[i - 1].lat, pts[i - 1].lng], [pts[i].lat, pts[i].lng]); tot += d; seg.push(d);
      L.marker([(pts[i - 1].lat + pts[i].lat) / 2, (pts[i - 1].lng + pts[i].lng) / 2], {icon: L.divIcon({className: 'mtipw', html: `<span class="mtip">${distTxt(d)}</span>`, iconSize: [0, 0]}), interactive: false}).addTo(g); }
    pts.forEach((p, i) => L.circleMarker(p, {radius: i === pts.length - 1 ? 7 : 5, color: '#fff', weight: 2, fillColor: '#ffd43b', fillOpacity: 1, interactive: false}).addTo(g));
    bar.querySelector('#ms_info').innerHTML = pts.length < 2 ? (pts.length ? '1 ponto — toque o próximo' : 'Toque no mapa para marcar os pontos') : `${pts.length} pontos · total <b id="ms_tot" style="color:#ffe27a">${distTxt(tot)}</b>`;
    bar.querySelector('#ms_seg').innerHTML = seg.map((d, i) => `${i + 1}→${i + 2}: ${distTxt(d)}`).join(' · ');
    bar.querySelector('#ms_un').classList.toggle('dis', !pts.length); bar.querySelector('#ms_clr').classList.toggle('dis', !pts.length);
    if (MEAS) { MEAS.total = tot; MEAS.n = pts.length; MEAS.pts = pts.map(p => [p.lat, p.lng]); }
  };
  const onClick = e => { pts.push(e.latlng); draw(); };
  map.on('click', onClick); map.closePopup(); box.classList.add('drawing', 'measuring'); const dz = map.doubleClickZoom.enabled(); map.doubleClickZoom.disable(); // toques rápidos marcam pontos, não dão zoom
  bar.classList.remove('hidden'); $('.mtools')?.classList.add('hidden'); $('#mf_chips')?.classList.add('hidden');
  MEAS = {map, total: 0, n: 0, end: () => { map.off('click', onClick); if (dz) try { map.doubleClickZoom.enable(); } catch (e) {} try { map.removeLayer(g); } catch (e) {} box.classList.remove('drawing', 'measuring'); bar.classList.add('hidden'); bar.innerHTML = ''; $('.mtools')?.classList.remove('hidden'); $('#mf_chips')?.classList.remove('hidden'); }};
  bar.querySelector('#ms_un').onclick = () => { pts.pop(); draw(); };
  bar.querySelector('#ms_clr').onclick = () => { pts.length = 0; draw(); };
  bar.querySelector('#ms_x').onclick = measureEnd;
  draw();
}
function measureEnd() { if (!MEAS) return; const m = MEAS; MEAS = null; try { m.end(); } catch (e) {} }

/* ---------- Trajeto gravado (watchPosition) ---------- */
let TRK = null; const TRK_ACC = 50, TRK_MIN = 5; // descarta leituras piores que 50 m; ignora passos menores que ~5 m (ruído parado)
function trackFix() { return TRK && TRK.fix && Date.now() - TRK.fix.ts < 20000 && TRK.fix.acc <= 100 ? {lat: TRK.fix.lat, lng: TRK.fix.lng, acc: TRK.fix.acc} : null; }
function trackToggle(opId, sess) { if (TRK) return trackStopSheet(); trackStartSheet(opId, sess || ''); }
function trackStartSheet(opId, sess) {
  const op = getOp(opId); if (!op) return; if (!navigator.geolocation) return toast('GPS indisponível neste aparelho');
  if (TRK) return trackStopSheet();
  const act = (op.vig || []).filter(s => !s.fim);
  sheet(`<h2 style="margin-top:0">🛰️ Gravar trajeto</h2><div class="sub">${esc(op.nome)}</div>
    <div class="warn">📵 <b>iPhone:</b> o iOS <b>para o GPS quando a tela bloqueia</b> ou o app vai para segundo plano. Além disso, o cofre <b>trava ao sair da tela</b> — a gravação termina e o que foi gravado até ali fica salvo. Mantenha o app aberto e a tela ligada${'wakeLock' in navigator ? ' (o app pede ao aparelho para não apagar a tela)' : ' — ajuste em Ajustes → Tela e Brilho → Bloqueio Automático'}. A bateria gasta mais.</div>
    <label>Sessão de vigilância (opcional)</label><select id="tk_s"><option value="">— nenhuma —</option>${act.map(s => `<option value="${s.id}" ${s.id === sess ? 'selected' : ''}>${esc(vigTitulo(op, s))}</option>`).join('')}${sess && !act.some(s => s.id === sess) && vigS(op, sess) ? `<option value="${sess}" selected>${esc(vigTitulo(op, vigS(op, sess)))}</option>` : ''}</select>
    <div class="sub" style="line-height:1.45;margin:10px 4px">Pontos com precisão pior que ${TRK_ACC} m são descartados. O trajeto (pontos com horário) fica <b>criptografado</b> no cofre, na operação.</div>
    <div class="btn pri" id="tk_go">▶ Começar a gravar</div>`, s => { s.querySelector('#tk_go').onclick = () => { const sx = s.querySelector('#tk_s').value; closeSheet(); trackStart(opId, sx); }; });
}
async function trackStart(opId, sess) {
  const op = getOp(opId); if (!op || TRK) return;
  const t = {id: uid(), sess: sess || '', ini: Date.now(), fim: null, pts: []}; op.trajetos = op.trajetos || []; op.trajetos.push(t);
  const T = TRK = {opId, sess: sess || '', t, watch: null, wake: null, drop: 0, fix: null, err: '', lastSave: Date.now(), tick: null};
  T.watch = navigator.geolocation.watchPosition(trackPos, trackErr, {enableHighAccuracy: true, maximumAge: 0, timeout: 30000});
  T.tick = setInterval(trackPaint, 1000);
  try { if ('wakeLock' in navigator) { const w = await navigator.wakeLock.request('screen'); if (TRK === T) T.wake = w; else w.release().catch(() => {}); } } catch (e) { T.wakeErr = true; }
  await save(); route(); toast('🛰️ Gravando trajeto — mantenha a tela ligada');
}
function trackPos(p) {
  const T = TRK; if (!T || !S) return; const c = p.coords, acc = Math.round(c.accuracy), ts = Date.now();
  T.fix = {lat: c.latitude, lng: c.longitude, acc, ts}; T.err = '';
  if (!(acc <= TRK_ACC)) { T.drop++; return trackPaint(); }
  const pt = [+c.latitude.toFixed(6), +c.longitude.toFixed(6), ts, acc], pts = T.t.pts, l = pts[pts.length - 1];
  if (l && hav(l, pt) < Math.max(TRK_MIN, (acc + (l[3] || 0)) / 4)) return trackPaint();
  pts.push(pt);
  if (pts.length % 10 === 0 || ts - T.lastSave > 20000) { T.lastSave = ts; saveNow(); }
  trackPaint(); if (pts.length % 5 === 0 && /^#mapa/.test(location.hash) && !MEAS) window._mapRender && window._mapRender(false); // redesenha o trajeto ao vivo sem fechar popups a cada leitura
}
function trackErr(e) {
  const T = TRK; if (!T) return;
  if (e.code === 1) { trackStop(true); route(); return toast('📵 Localização não permitida — trajeto interrompido', 4000); }
  T.err = e.code === 3 ? 'sem sinal de GPS no momento' : 'GPS indisponível no momento'; trackPaint();
}
function trackStop(silent) {
  const T = TRK; if (!T) return null; TRK = null;
  try { navigator.geolocation.clearWatch(T.watch); } catch (e) {} clearInterval(T.tick);
  try { T.wake && T.wake.release().catch(() => {}); } catch (e) {}
  const op = S && getOp(T.opId); let kept = false;
  if (op) { T.t.fim = Date.now(); if (T.t.pts.length < 2) op.trajetos = (op.trajetos || []).filter(x => x !== T.t); else kept = true; saveNow(); }
  trackPaint();
  if (!silent) toast(kept ? `🛰️ Trajeto salvo · ${distTxt(trackDist(T.t))} · ${durHM(trackDur(T.t))}` : 'Trajeto descartado (menos de 2 pontos com boa precisão)', 3500);
  return kept ? T.t : null;
}
function trackStopSheet() {
  const T = TRK; if (!T) return; const op = getOp(T.opId);
  sheet(`<h2 style="margin-top:0">🛰️ Trajeto em gravação</h2><div class="sub">${esc(op ? op.nome : '')}${T.sess && op && vigS(op, T.sess) ? ' · ' + esc(vigTitulo(op, vigS(op, T.sess))) : ''}</div>
    <div class="card glass" style="cursor:default;margin-top:12px"><div data-trklive></div></div>
    <div class="grid2" style="margin-top:12px"><div class="btn" id="ts_c">Continuar</div><div class="btn dan" id="ts_s">⏹ Parar e salvar</div></div>`, s => {
    trackPaint(); s.querySelector('#ts_c').onclick = closeSheet;
    s.querySelector('#ts_s').onclick = () => { closeSheet(); trackStop(); route(); };
  });
}
function trackLive() {
  const T = TRK; if (!T) return ''; const f = T.fix;
  return `${distTxt(trackDist(T.t))} · ${durHM(Date.now() - T.t.ini)} · ${T.t.pts.length} ponto(s)` + (f ? ` · ±${f.acc} m` : ' · aguardando GPS…') + (T.drop ? ` · ${T.drop} descartado(s)` : '') + (T.err ? ` · ⚠️ ${T.err}` : '') + (T.wake ? '' : (T.wakeErr || !('wakeLock' in navigator) ? ' · tela pode apagar' : ''));
}
function trackPaint() {
  let pill = document.getElementById('trkpill');
  if (!TRK || !KEY) { if (pill) pill.remove(); return; }
  if (!pill) { pill = document.createElement('div'); pill.id = 'trkpill'; pill.className = 'trkpill glass'; pill.onclick = trackStopSheet; document.body.appendChild(pill); }
  const live = trackLive(); pill.innerHTML = `<i></i>🛰️ ${esc(distTxt(trackDist(TRK.t)))} · ${esc(durHM(Date.now() - TRK.t.ini))}`;
  document.querySelectorAll('[data-trklive]').forEach(el => el.textContent = live);
}
/* trajetos para o mapa: seguem operação, alvo (da sessão), período e a chave “Mostrar trajetos” */
function mapTracks(one) {
  if (!MF || MF.traj === false) return [];
  const t0 = MF.de ? new Date(MF.de + 'T00:00').getTime() : -Infinity, t1 = MF.ate ? new Date(MF.ate + 'T23:59:59.999').getTime() : Infinity, out = [];
  S.ops.filter(o => one ? o.id === one.opId : !MF.op || o.id === MF.op).forEach(o => (o.trajetos || []).forEach(t => {
    if ((t.pts || []).length < 2) return; const s = t.sess && vigS(o, t.sess), al = s ? s.alvoId : '';
    if (one ? al !== one.id : MF.alvo && al !== MF.alvo) return;
    const a = t.ini || t.pts[0][2], b = t.fim || t.pts[t.pts.length - 1][2]; if (b < t0 || a > t1) return;
    out.push({o, t});
  }));
  return out;
}
function trackLayer(o, t) {
  const g = L.layerGroup(), ll = t.pts.map(p => [p[0], p[1]]), s = t.sess && vigS(o, t.sess), live = TRK && TRK.t === t;
  const pop = `<b>🛰️ Trajeto gravado${live ? ' (gravando)' : ''}</b><br><span style="color:#8a9bb8">${esc(o.nome)}${s ? ' · ' + esc(vigTitulo(o, s)) : ''}</span><br>${fmt(t.ini)} · ${distTxt(trackDist(t))} · ${durHM(live ? Date.now() - t.ini : trackDur(t))} · ${t.pts.length} pontos<br><a href="#diario/${o.id}" style="color:#9cbcff">Abrir diário</a>`;
  L.polyline(ll, {color: '#000', weight: 7, opacity: .35, interactive: false}).addTo(g);
  L.polyline(ll, {color: '#4dd4ff', weight: 4, opacity: .95, className: 'trkline'}).addTo(g).bindPopup(pop);
  L.circleMarker(ll[0], {radius: 6, color: '#fff', weight: 2, fillColor: '#3cd290', fillOpacity: 1}).addTo(g).bindPopup(pop);
  L.circleMarker(ll[ll.length - 1], {radius: 6, color: '#fff', weight: 2, fillColor: live ? '#ffd43b' : '#ff6b6b', fillOpacity: 1}).addTo(g).bindPopup(pop);
  return g;
}

/* ============ v0.6 Etapa B3 — Cruzamento de telefones e placas — by @aiforge.team ============ */
/* Só lê o estado aberto (no cofre falso, só os dados dele); nada é gravado além da preferência “incluir arquivadas”.
   Fontes: telefones do alvo, campo Veículo do alvo e registros 🚗 do diário de vigilância. */
const DDD_OK = d => /^[1-9][1-9]$/.test(d);
function telNorm(raw) {
  const s = String(raw || ''); let d = s.replace(/\D/g, '');
  if (d.length < 8) return null;
  if (/^0?[3589]00\d{6,7}$/.test(d) || /^[34]00\d{5}$/.test(d)) return null;                                          // 0800/0300/4004… não são linhas de pessoas
  if ((/^\s*\+\s*55/.test(s) || /^55/.test(d)) && (d.length === 12 || d.length === 13)) d = d.slice(2);        // +55 / 55 + DDD + número
  else if (/^00\d{2}55/.test(d) && d.length >= 16) d = d.slice(6);                                               // 00 + operadora + 55 (ligação internacional)
  else if (/^0/.test(d)) { d = d.replace(/^0+/, ''); if (d.length === 12 || d.length === 13) d = d.slice(2); }     // 0 + operadora (2 dígitos) + DDD + número, ou 0 + DDD + número
  let ddd = '', num = d;
  if (d.length === 10 || d.length === 11) { ddd = d.slice(0, 2); num = d.slice(2); if (!DDD_OK(ddd)) { ddd = ''; num = d; } }
  else if (d.length > 11) num = d.slice(-9);
  if (num.length < 8) return null;
  return {ddd, num, l8: num.slice(-8)};
}
const telFmt = n => (n.ddd ? `(${n.ddd}) ` : '') + (n.num.length >= 9 ? n.num.slice(-9, -4) + '-' + n.num.slice(-4) : n.num.slice(0, 4) + '-' + n.num.slice(4));
/* placa: maiúsculas e só letras/números; a antiga ABC1234 vira a Mercosul ABC1C34 (5º caractere 0–9 → A–J) */
function plateNorm(raw) {
  const s = String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]{3}\d{4}$/.test(s)) return s.slice(0, 4) + 'ABCDEFGHIJ'[+s[4]] + s.slice(5);
  return /^[A-Z]{3}\d[A-Z]\d{2}$/.test(s) ? s : null;
}
function platesIn(txt) {
  const out = new Set(), re = /(^|[^A-Z0-9])([A-Z]{3})[\s.-]?(\d[A-Z0-9]\d{2})(?![A-Z0-9])/g; const s = String(txt || '').toUpperCase(); let m;
  while ((m = re.exec(s))) { const p = plateNorm(m[2] + m[3]); if (p) out.add(p); re.lastIndex = m.index + m[0].length; }
  return [...out];
}
const plateOld = p => { const i = 'ABCDEFGHIJ'.indexOf(p[4]); return i < 0 ? '' : p.slice(0, 3) + '-' + p[3] + i + p.slice(5); };
const plateLbl = p => p + (plateOld(p) ? ` · antiga ${plateOld(p)}` : '');
function xItems(incArq) {
  const out = [], okOp = op => op && (incArq || !isArq(op));
  for (const a of S.alvos) {
    const op = getOp(a.opId); if (!okOp(op)) continue;
    (a.tels || []).forEach(t => { const n = telNorm(t); if (n) out.push({k: 'tel', n, raw: String(t).trim(), ent: a.id, alvoId: a.id, opId: op.id, src: 'Telefone'}); });
    platesIn(a.veic).forEach(p => out.push({k: 'placa', key: p, raw: String(a.veic).trim(), ent: a.id, alvoId: a.id, opId: op.id, src: 'Veículo'}));
  }
  for (const op of S.ops) {
    if (!okOp(op)) continue;
    (op.diario || []).filter(e => e.k === 'veiculo').forEach(e => {
      const s = vigS(op, e.sess), al = e.alvoId || (s && s.alvoId) || '', alvoId = al && getAlvo(al) ? al : '';
      new Set([...platesIn(e.placa), ...platesIn(e.veic)]).forEach(p => out.push({k: 'placa', key: p, raw: [e.placa, e.veic].filter(Boolean).join(' · '), ent: alvoId || 'vig:' + op.id, alvoId, opId: op.id, src: 'Diário de vigilância', sess: e.sess || '', ts: e.ts, quem: alvoId ? '' : (s ? vigNome(s.alvoId, s.alvoNome) : '')}));
    });
  }
  return out;
}
/* grupos: placa igual (antiga = Mercosul) ou telefone com os mesmos 8 últimos dígitos e o mesmo DDD (sem DDD casa com qualquer DDD);
   só vale como cruzamento se envolver pelo menos dois alvos diferentes (ou alvo × diário de outra origem) */
function xGroups(incArq) {
  const it = xItems(incArq), G = [];
  const by = (xs, f) => { const m = new Map(); xs.forEach(x => { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }); return m; };
  by(it.filter(x => x.k === 'placa'), x => x.key).forEach((xs, key) => G.push({k: 'placa', key: 'p:' + key, val: key, label: plateLbl(key), xs}));
  by(it.filter(x => x.k === 'tel'), x => x.n.l8).forEach((xs, l8) => {
    const ddds = [...new Set(xs.map(x => x.n.ddd).filter(Boolean))], noD = xs.filter(x => !x.n.ddd);
    (ddds.length ? ddds : ['']).forEach(d => { const ys = ddds.length > 1 ? [...xs.filter(x => x.n.ddd === d), ...noD] : xs; const best = ys.slice().sort((a, b) => (b.n.ddd ? 1 : 0) - (a.n.ddd ? 1 : 0) || b.n.num.length - a.n.num.length)[0];
      G.push({k: 'tel', key: 't:' + d + ':' + l8, val: telFmt(best.n), label: telFmt(best.n), xs: ys}); });
  });
  return G.map(g => { // junta as ocorrências de uma mesma origem (ex.: 3 registros do mesmo diário)
    const m = new Map(); g.xs.forEach(x => { const k = x.ent + '|' + x.src + '|' + x.opId; if (!m.has(k)) m.set(k, {...x, n_: 0, raws: new Set()}); const y = m.get(k); y.n_++; y.raws.add(x.raw); if (x.sess && !y.sess) y.sess = x.sess; });
    return {...g, its: [...m.values()], ents: new Set(g.xs.map(x => x.ent))};
  }).filter(g => g.ents.size >= 2).sort((a, b) => b.ents.size - a.ents.size || a.k.localeCompare(b.k) || a.val.localeCompare(b.val));
}
const xName = x => x.alvoId ? (getAlvo(x.alvoId) || {}).nome || '?' : 'Diário de vigilância' + (x.quem ? ` (${x.quem})` : '');
const xHref = x => x.alvoId ? '#alvo/' + x.alvoId : x.sess ? `#vig/${x.opId}/${x.sess}` : '#diario/' + x.opId;
const xVal = g => discOn() ? (g.k === 'tel' ? maskTel(g.val) : g.val.slice(0, 3) + '••••') : g.val;
const xRaw = (g, r) => discOn() ? (g.k === 'tel' ? maskTel(r) : String(r).replace(/[A-Z0-9]{3}[\s.-]?\d[A-Z0-9]\d{2}/gi, m => m.slice(0, 3) + '••••')) : r;
const xCount = () => S ? xGroups(!!S.cfg.cruzArq).length : 0;
/* alertas na ficha do alvo (inclui operações arquivadas, marcadas) */
function xAlerts(a) {
  const out = [];
  xGroups(true).forEach(g => { if (!g.ents.has(a.id)) return; g.its.filter(x => x.ent !== a.id).forEach(x => out.push({g, x})); });
  if (!out.length) return '';
  return `<div class="xalerts" id="al_cruz">${out.map(({g, x}) => { const op = getOp(x.opId); return `<div class="xchip" data-h="${xHref(x)}"><div>${g.k === 'tel' ? '📞 Telefone' : '🚗 Placa'} também aparece em: <b>${esc(xName(x))}</b> (${esc(op ? op.nome : '?')})${op && isArq(op) ? ' 🗄️' : ''}</div><div class="sub">${esc(xVal(g))} · ${esc(x.src)}${x.n_ > 1 ? ` · ${x.n_} registro(s)` : ''} ›</div></div>`; }).join('')}</div>`;
}
function viewCruzamentos(filt) {
  tabs('busca'); filt = ['tel', 'placa'].includes(filt) ? filt : '';
  const inc = !!S.cfg.cruzArq, all = xGroups(inc), gs = all.filter(g => !filt || g.k === filt), nHid = inc ? 0 : xGroups(true).length - all.length;
  const nT = all.filter(g => g.k === 'tel').length, nP = all.length - nT;
  APP.innerHTML = `<div class="back" onclick="location.hash='#busca'">‹ Busca</div><h1>🔀 Cruzamentos</h1>
  <div class="sub" style="margin:4px 4px 10px;line-height:1.45">Telefones e placas que aparecem em <b>alvos diferentes</b> (na mesma ou em outra operação) e nos registros 🚗 do diário de vigilância.</div>
  <div class="chips" id="x_f" style="margin:0 0 6px">${[['', `Todos ${all.length}`], ['tel', `📞 Telefones ${nT}`], ['placa', `🚗 Placas ${nP}`]].map(([k, l]) => `<span class="chip ${filt === k ? 'c-tag on' : 'c-gray'} xf" data-k="${k}" style="cursor:pointer">${l}</span>`).join('')}</div>
  <div class="tgrow" style="padding:8px 4px;border:0"><div class="sub">Incluir operações arquivadas</div><div class="tg ${inc ? 'on' : ''}" id="x_arq"></div></div>
  <div id="x_list">${gs.length ? gs.map(g => `<div class="card glass xg" data-g="${esc(g.key)}" style="cursor:default"><div class="row"><div class="t">${g.k === 'tel' ? '📞' : '🚗'} ${esc(xVal(g))}${g.k === 'placa' && !discOn() && plateOld(g.val) ? ` <span class="sub" style="white-space:nowrap;font-weight:500">antiga ${esc(plateOld(g.val))}</span>` : ''}</div><span class="chip c-amb">${g.ents.size} origens</span></div>
    <div class="list" style="margin-top:6px">${g.its.map(x => { const op = getOp(x.opId); return `<div class="li xi" data-h="${xHref(x)}" style="cursor:pointer"><span style="color:var(--txt)"><b style="font-weight:600">${esc(xName(x))}</b> <span class="sub">${esc(op ? op.nome : '?')}${op && isArq(op) ? ' · 🗄️ arquivada' : ''}</span><br><span class="sub">${esc(x.src)}: ${esc(xRaw(g, [...x.raws].join(' / ')).slice(0, 90))}${x.n_ > 1 ? ` · ${x.n_} registro(s)` : ''}</span></span><b>›</b></div>`; }).join('')}</div></div>`).join('')
    : `<div class="empty"><div>🔀</div>Nenhum cruzamento${filt ? ' deste tipo' : ''}.<br><span class="sub">Telefones comparados pelos 8 últimos dígitos + DDD (com ou sem o 9 e o +55); placas antigas e Mercosul equivalentes contam como a mesma.</span></div>`}</div>
  ${nHid ? `<div class="sub" style="margin:8px 4px">${nHid} cruzamento(s) envolvendo operações arquivadas não aparecem — ligue “Incluir operações arquivadas”.</div>` : ''}`;
  APP.querySelectorAll('.xf').forEach(c => c.onclick = () => location.hash = '#cruzamentos' + (c.dataset.k ? '/' + c.dataset.k : ''));
  APP.querySelectorAll('.xi').forEach(c => c.onclick = () => location.hash = c.dataset.h);
  $('#x_arq').onclick = async () => { S.cfg.cruzArq = !S.cfg.cruzArq; await save(); viewCruzamentos(filt); };
}
/* relatório: cruzamentos que envolvem a operação (inclui arquivadas, para o documento ficar completo) */
const xForOp = opId => xGroups(true).filter(g => g.its.some(x => x.opId === opId));

/* ============ v0.7 — Extrair alvos de texto/PDF/Word, fotos em lote pelo nome e leitura de documentos em lote — by @aiforge.team ============ */
/* Tudo roda no aparelho: pdf.js e fflate vêm de lib/ sob demanda (cache no 1º uso); nada é enviado a servidor.
   Nenhum alvo é criado sem a tela de conferência. */
const EX_L = 'A-Za-zÀ-ÖØ-öø-ÿ', EX_U = 'A-ZÀ-ÖØ-Þ';
const EX_STOP = new Set(('BOLETIM OCORRENCIA OCORRENCIAS POLICIA CIVIL MILITAR FEDERAL RODOVIARIA ESTADO ESTADUAL SECRETARIA SEGURANCA PUBLICA DEFESA SOCIAL DELEGACIA DISTRITO DISTRITAL REGIONAL ' +
  'METROPOLITANA RELATORIO RELATO INVESTIGACAO INQUERITO HISTORICO QUALIFICACAO ENVOLVIDOS ENVOLVIDO ENVOLVIDA AUTOR AUTORA AUTORES VITIMA VITIMAS TESTEMUNHA TESTEMUNHAS CONDUZIDO CONDUZIDA CONDUZIDOS ' +
  'SUSPEITO SUSPEITA SUSPEITOS INVESTIGADO INVESTIGADA NATUREZA FATO FATOS LOCAL DATA HORA HORARIO CPF RG SSP SDS SSPDS CNH UF BAIRRO CENTRO RUA AVENIDA AV TRAVESSA ALAMEDA ESTRADA RODOVIA PRACA VILA CONJUNTO ' +
  'QUADRA LOTE CEP NUMERO APTO APARTAMENTO BLOCO CASA CIDADE MUNICIPIO COMARCA BRASIL REPUBLICA FEDERATIVA NOME VULGO ALCUNHA APELIDO FILIACAO PAI MAE NASCIMENTO NASCIDO NASCIDA NATURAL NATURALIDADE ' +
  'NACIONALIDADE BRASILEIRO BRASILEIRA SOLTEIRO SOLTEIRA CASADO CASADA PROFISSAO ENDERECO TELEFONE TELEFONES CELULAR CONTATO VEICULO VEICULOS PLACA MARCA MODELO COR OBS OBSERVACAO OBSERVACOES ANEXO PAGINA FOLHA ' +
  'DOCUMENTO DOCUMENTOS ASSUNTO REFERENCIA PROCESSO MANDADO PRISAO BUSCA APREENSAO OPERACAO ORDEM SERVICO EQUIPE VIATURA GUARNICAO DROGA DROGAS ARMA ARMAS FOGO MUNICAO TRAFICO ENTORPECENTES ROUBO FURTO ' +
  'HOMICIDIO LESAO CORPORAL AMEACA ART LEI CODIGO PENAL MINISTERIO JUSTICA PODER JUDICIARIO TRIBUNAL VARA CRIMINAL JUIZ JUIZA PROMOTOR PROMOTORA DELEGADO DELEGADA ESCRIVAO ESCRIVA AGENTE INSPETOR INVESTIGADOR ' +
  'SOLDADO CABO SARGENTO TENENTE CAPITAO MAJOR CORONEL PM PC PF PRF GCM DETRAN NUCLEO SETOR SECAO DIVISAO DEPARTAMENTO COORDENADORIA DIRETORIA SUPERINTENDENCIA WHATSAPP MENSAGEM MENSAGENS AUDIO FOTO FOTOS ' +
  'VIDEO IMAGEM URGENTE ATENCAO INFORMACAO INFORMACOES DADOS SIM NAO OK PIX BANCO CONTA TIPO SEXO MASCULINO FEMININO IDADE ANOS RESERVADO CONFIDENCIAL SIGILOSO PROTOCOLO REGISTRO GERAL IDENTIDADE CARTEIRA ' +
  'NACIONAL HABILITACAO EXPEDICAO EMISSOR ORGAO VALIDADE CATEGORIA JANEIRO FEVEREIRO MARCO ABRIL MAIO JUNHO JULHO AGOSTO SETEMBRO OUTUBRO NOVEMBRO DEZEMBRO SEGUNDA TERCA QUARTA QUINTA SEXTA SABADO DOMINGO ' +
  'FEIRA FIAT VW VOLKSWAGEN CHEVROLET GM FORD HONDA YAMAHA TOYOTA HYUNDAI RENAULT NISSAN JEEP PEUGEOT CITROEN MITSUBISHI KIA BMW AUDI MERCEDES GOL UNO PALIO ONIX CELTA CORSA HB20 STRADA SAVEIRO FOX POLO KA ' +
  'FIESTA CIVIC COROLLA HILUX S10 BIZ FAN TITAN CG FAZER PRATA PRETO PRETA BRANCO BRANCA VERMELHO VERMELHA AZUL CINZA VERDE AMARELO AMARELA MOTO CARRO MOTOCICLETA AUTOMOVEL CAMINHONETE ' +
  'FOI FORAM ERA ESTAVA ESTAVAM SER SENDO SAO TEM TINHA HAVIA QUE QUAL QUANDO ONDE COMO POIS PORQUE MAS OU SE JA AINDA MUITO POUCO MAIS MENOS ATE APOS ANTES DEPOIS DURANTE ENTRE SOBRE SOB PARA PELA PELO ' +
  'PELOS PELAS COM SEM NA NO NAS NOS EM UM UMA UNS UMAS OS AS AO AOS ESTE ESTA ESSE ESSA ISSO ISTO AQUI ALI LA SEU SUA SEUS SUAS ELE ELA ELES ELAS LHE ABORDADO ABORDADA ABORDADOS PRESO PRESA PRESOS DETIDO ' +
  'DETIDA LOCALIZADO LOCALIZADA IDENTIFICADO IDENTIFICADA RESIDENTE RESIDENTES DOMICILIADO DOMICILIADA PORTADOR PORTADORA INSCRITO INSCRITA FILHO FILHA CONHECIDO CONHECIDA PROPRIETARIO CONDUTOR PASSAGEIRO ' +
  'MOTORISTA ACOMPANHADO ACOMPANHADA JUNTAMENTE TAMBEM MESMO MESMA REFERIDO REFERIDA CITADO CITADA ACIMA ABAIXO SEGUINTE SEGUINTES SEGUNDO CONFORME BOM BOA DIA TARDE NOITE SR SRA DR DRA HOJE ONTEM ' +
  'GRUPO FACCAO COMANDO VERMELHO CAPITAL PRIMEIRO GUARDIOES TERCEIRO PASSAGENS POLICIAIS ANTECEDENTES CRIMINAIS QUALIFICADO QUALIFICADA DEMAIS OUTROS OUTRAS TODOS NADA CONSTA INFORMOU INFORMA RELATOU DISSE').split(' '));
const EX_ROLE = [['autor', /\bautor(?:a|es)?\b/i], ['vítima', /\bv[ií]tima/i], ['testemunha', /\btestemunha/i], ['conduzido', /\bconduzid[oa]/i], ['suspeito', /\bsuspeit[oa]/i], ['investigado', /\binvestigad[oa]/i]];
const exKey = s => _norm(s).replace(/\s+/g, ' ');
const exUp = s => _norm(s).toUpperCase();
function exClean(t) {
  return String(t || '').replace(/\r\n?/g, '\n').replace(/[\u00a0\u2007\u202f]/g, ' ').replace(/[\u200b-\u200d\ufeff]/g, '')
    .replace(/^\[\d{1,2}[:h]\d{2}(?::\d{2})?,? \d{1,2}\/\d{1,2}\/\d{2,4}\] [^:\n]{1,40}: ?/gm, '')          // WhatsApp (iPhone) [10:32, 01/10/2026] Fulano:
    .replace(/^\[?\d{1,2}\/\d{1,2}\/\d{2,4},? \d{1,2}:\d{2}(?::\d{2})?\]? (?:- )?[^:\n]{1,40}: ?/gm, '')     // WhatsApp (Android) 01/10/2026 10:32 - Fulano:
    .replace(/<(?:M[íi]dia oculta|Media omitted)>/gi, '').replace(/[ \t]+\n/g, '\n');
}
const exPhoneFmt = d => d.length === 11 ? `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}` : d.length === 10 ? `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}` : d.length === 9 ? d.slice(0, 5) + '-' + d.slice(5) : d.slice(0, 4) + '-' + d.slice(4);
function exPhoneDigits(run) { // dígitos de um telefone brasileiro (sem +55/0+operadora) ou ''
  let d = _digits(run); if (/^\s*\+?\s*55/.test(run) && (d.length === 12 || d.length === 13)) d = d.slice(2);
  else if (/^0/.test(d)) { d = d.replace(/^0+/, ''); if (d.length === 12 || d.length === 13) d = d.slice(2); }
  if (d.length === 11) return DDD_OK(d.slice(0, 2)) && d[2] === '9' ? d : '';
  if (d.length === 10) return DDD_OK(d.slice(0, 2)) && /[2-9]/.test(d[2]) ? d : '';
  if (d.length === 9) return d[0] === '9' ? d : '';
  return d.length === 8 && /[2-9]/.test(d[0]) ? d : '';
}
const EX_VEIC_RE = /\b(?:ve[ií]culo|carro|moto(?:cicleta)?|autom[óo]vel|caminhonete|caminh[ãa]o|camioneta|fiat|vw|volkswagen|chevrolet|gm|ford|honda|yamaha|toyota|hyundai|renault|nissan|jeep|peugeot|citro[eë]n|mitsubishi|kia|bmw|audi|mercedes|gol|uno|palio|onix|celta|corsa|hb ?20|strada|saveiro|fox|polo|ka|fiesta|civic|corolla|hilux|s ?10|biz|fan|titan|cg ?\d*|fazer|prisma|cobalt|spin|sandero|logan|kwid|argo|mobi|toro|compass|renegade|creta|tracker|voyage|siena|fusca)\b/i;
const EX_PLATE_BAD = new Set('ANO DIA MES TEL CEL CPF CEP APT NUM ART LEI RUA BOX LOT KMS HRS MIN SEG POR COM SEM DAS DOS QUE NAS NOS UMA AOS ATE MAS SUA SEU ELE ELA REF PAG FLS VOL OBS TOT QTD VAL PRF SSP SDS NRO FIG TAB CAP INC'.split(' '));
/* blocos (parágrafos) — a proximidade só vale dentro do mesmo bloco */
function exBlocks(t) { const b = [0]; const re = /\n[ \t]*\n+|\n(?=[ \t]*(?:\d{1,2}\s*[).º°-]\s|[-•*]\s|(?:AUTOR|V[ÍI]TIMA|TESTEMUNHA|CONDUZIDO|ENVOLVIDO|SUSPEITO|INVESTIGADO)[A-ZÀ-Ú]*\s*\d*\s*[:\-–]))/gi; let m; while ((m = re.exec(t))) b.push(m.index + 1); return b; }
const exBlockOf = (bs, i) => { let lo = 0, hi = bs.length - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bs[mid] <= i) lo = mid; else hi = mid - 1; } return lo; };
/* recorta uma sequência de palavras em trechos com cara de nome (≥ 2 palavras, sem palavras de formulário/verbos comuns) */
function exNameRuns(words) {
  const out = []; let cur = [];
  const flush = () => { while (cur.length && PART.has(cur[cur.length - 1].w.toLowerCase())) cur.pop(); while (cur.length && PART.has(cur[0].w.toLowerCase())) cur.shift(); if (cur.filter(x => !PART.has(x.w.toLowerCase()) && x.w.length >= 2).length >= 2) out.push(cur.slice()); cur = []; };
  for (const x of words) { const u = exUp(x.w); if (EX_STOP.has(u) || /\d/.test(x.w) || (x.w.length === 1 && !/^[eE]$/.test(x.w))) flush(); else cur.push(x); }
  flush(); return out;
}
function extractEntities(text) {
  const T = exClean(text), bs = exBlocks(T); let M = T; // M = cópia mascarada (o que já foi reconhecido vira espaço)
  const ents = [], anchors = [];
  const mask = (i, j) => { M = M.slice(0, i) + ' '.repeat(j - i) + M.slice(j); };
  const near = (i, re, back = 30) => re.test(T.slice(Math.max(0, i - back), i));
  { const LB = exLabeled(T); ents.push(...LB.ents); anchors.push(...LB.anchors); LB.spans.forEach(([a, b]) => mask(a, b)); } // v0.8: “Campo: valor” primeiro (prioridade)
  const scan = (re, fn) => { re.lastIndex = 0; const hits = []; let m; while ((m = re.exec(M))) { hits.push(m); if (!m[0].length) re.lastIndex++; } hits.forEach(fn); };
  const cut = (s, max) => { // fim do trecho: quebra de linha, ; ou próximo rótulo
    const re = /\n|;|[,.]?\s*\b(?:telefone|tel\.?|fone|cel(?:ular)?|whats(?:app)?|zap|cpf|rg|nascid[oa]|nasc\.|natural|filh[oa]\s+de|filia[çc][ãa]o|vulgo|alcunha|conhecid[oa]|portador|inscrit[oa]|ve[ií]culo|placa|e-?mail|residente|domiciliad[oa]|brasileir[oa]|solteir[oa]|casad[oa]|profiss[ãa]o|estado civil)\b|[,.]?\s*\b(?:m[ãa]e|pai|genitora?|nome|endere[çc]o|naturalidade|identidade|apelido|contato|ocupa[çc][ãa]o|redes?\s+sociais)\s*:|\.\s+(?=[A-ZÀ-Ú])/i;
    const m = s.slice(0, max).match(re); return m ? m.index : Math.min(s.length, max);
  };
  // CPF (com ou sem pontuação; sem pontuação só vale se os dígitos conferirem ou houver o rótulo CPF perto)
  scan(/(^|[^\d.\/-])(\d{3})([.\s]?)(\d{3})\3(\d{3})\s?[-.\s]?\s?(\d{2})(?![\d])/g, m => {
    const i = m.index + m[1].length, j = m.index + m[0].length, d = m[2] + m[4] + m[5] + m[6], lab = near(i, /\bc\.?p\.?f\.?\s*(?:n[º°o.]*\s*)?[:\-]?\s*$/i, 22), ok = cpfValid(d), punct = /[.\-]/.test(T.slice(i, j));
    if (ok || lab || (punct && m[3] === '.')) { ents.push({k: 'cpf', v: cpfFmt(d), ok, i}); mask(i, j); }
  });
  // RG (precisa do rótulo)
  scan(/\b(?:R\.?\s?G\.?|registro\s+geral|c[ée]dula\s+de\s+identidade|carteira\s+de\s+identidade|identidade)(?:\s+civil)?\s*(?:n[º°o.]*\s*)?[:\-]?\s*((?:\d{4,13}|\d{1,2}\.\d{3}\.\d{3})(?!\d)(?:\s?-\s?[\dXx])?)((?:\s*[-–\/]?\s*(?:SSP|SDS|SSPDS|SESP|SESDEC|SJS|SJ|PC|IFP|DETRAN|DGPC|SSPDC|SEJUSP|PCCE|DIC|II|IIRGD)(?:\s*[-\/]?\s*[A-Z]{2}\b)?)?)/gi, m => {
    const num = m[1].replace(/\s/g, ''), org = (m[2].replace(/^[\s\-–\/]+/, '').replace(/\s*[-\/]\s*/g, '/').trim().match(/^[A-Z]+(?:\/[A-Z]{2}(?![a-z]))?/) || [''])[0];
    ents.push({k: 'rg', v: num + (org ? ' ' + org : ''), i: m.index}); mask(m.index, m.index + m[0].length);
  });
  // datas: nascimento só com palavra de contexto; todas são mascaradas (não viram telefone/RG)
  scan(/\b(?:nascid[oa]s?|nascimento|data\s+de\s+nascimento|nasc|D\.?\s?N)\b\.?[^\d\n]{0,26}([0-3]?\d)[\/.\-]([01]?\d)[\/.\-]((?:19|20)?\d{2})\b/gi, m => {
    let [d, mo, y] = [+m[1], +m[2], m[3]]; if (y.length === 2) y = (+y > new Date().getFullYear() % 100 ? '19' : '20') + y;
    if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12 && +y >= 1900 && +y <= new Date().getFullYear()) ents.push({k: 'nasc', v: `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`, i: m.index});
    mask(m.index, m.index + m[0].length);
  });
  scan(/\b[0-3]?\d[\/.\-][01]?\d[\/.\-](?:19|20)?\d{2}\b/g, m => mask(m.index, m.index + m[0].length));
  scan(/\bCEP\s*:?\s*\d{2}\.?\d{3}-?\d{3}\b|\b\d{5}-\d{3}\b/gi, m => mask(m.index, m.index + m[0].length));
  scan(/\b\d{1,2}[:h]\d{2}(?:min|h)?\b/gi, m => mask(m.index, m.index + m[0].length)); // horários
  // placas (antiga e Mercosul) + descrição do veículo logo antes
  scan(/(^|[^A-Za-z0-9])([A-Za-z]{3})([-\s]?)(\d[A-Za-z0-9]\d{2})(?![A-Za-z0-9])/g, m => {
    const L = m[2], R = m[4], i = m.index + m[1].length, j = m.index + m[0].length, up = L === L.toUpperCase(), pl = (L + R).toUpperCase();
    if (!/^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(pl) || EX_PLATE_BAD.has(L.toUpperCase())) return;
    const ctx = T.slice(Math.max(0, i - 60), i), hasCtx = /placa|ve[ií]culo/i.test(ctx) || EX_VEIC_RE.test(ctx);
    if (m[3] === ' ' && !hasCtx) return; if (!up && !hasCtx && m[3] !== '-') return;
    let desc = ''; const seg = T.slice(Math.max(0, i - 60), i).split(/[.;\n]/).pop(); const vm = seg.match(EX_VEIC_RE);
    if (vm) desc = seg.slice(vm.index).replace(/\b(?:de\s+)?placas?\b\s*(?:n[º°o.]*)?/gi, ' ').replace(/^(?:ve[ií]culo|carro|autom[óo]vel)\s*(?:marca\s*|modelo\s*)?[:\-]?\s*/i, '').replace(/[\s,:\-–]+$/, '').replace(/\s+/g, ' ').trim();
    if (vm) mask(Math.max(0, i - 60) + (T.slice(Math.max(0, i - 60), i).length - seg.length) + vm.index, i);
    ents.push({k: 'veic', v: (desc ? desc + ' ' : '') + plateFmt(pl), i}); mask(i, j);
  });
  // telefones BR (+55, 0+operadora, DDD com/sem parênteses, 9º dígito; 8/9 dígitos sem DDD só com rótulo)
  scan(/\+?\d[\d\s().\-]{6,22}\d/g, m => {
    let run = m[0], off = 0;
    while (run) {
      const d = exPhoneDigits(run);
      if (d && (d.length >= 10 || near(m.index + off, /\b(?:tel(?:efone)?s?|fone|cel(?:ular)?|contato|whats(?:app)?|zap|wpp)\b[^\n]{0,18}$/i, 30))) {
        if (!near(m.index + off, /CEP\s*:?\s*$/i, 8)) { ents.push({k: 'tel', v: exPhoneFmt(d), i: m.index + off}); mask(m.index + off, m.index + m[0].length); }
        return;
      }
      const sp = run.search(/[\s(]/); if (sp < 0) return; const nx = run.slice(sp).search(/[\d+(]/); if (nx < 0) return; off += sp + nx; run = run.slice(sp + nx);
    }
  });
  // endereços: Rua/Av./Travessa… até o fim do trecho; precisa de número, s/n ou bairro
  scan(new RegExp(`(^|[^${EX_L}])(Rua|R\\.|Avenida|Av\\.?|Travessa|Trav\\.|Tv\\.|Alameda|Al\\.|Estrada|Rodovia|Rod\\.|Pra[çc]a|P[çc]a\\.?|Beco|Largo|Viela|Passagem|Conjunto|Cj\\.|Residencial|Loteamento|S[íi]tio|Fazenda|Vila)\\s+`, 'gi'), m => {
    const i = m.index + m[1].length; if (M[i] === ' ') return; // já reconhecido
    const s = T.slice(i, i + 220); const pre = s.slice(0, m[2].length + 1); let k = cut(s.slice(pre.length), 200) + pre.length;
    { const pz = s.slice(0, k).search(/,\s+(?:a|o|as|os|onde|que|quando|quem|foi|foram|tendo|sendo|ocasi[ãa]o|momento|local\s+(?:em|onde)|e\s+(?:a|o|foi))\s/); if (pz > pre.length) k = pz; } // v0.8: endereço não engole a frase seguinte
    let addr = s.slice(0, k).replace(/[\s,.;:\-–]+$/, '').replace(/\s+/g, ' ').trim();
    if (!/\d|s\/n|bairro/i.test(addr) || addr.length < 8) return;
    ents.push({k: 'end', v: addr, i}); mask(i, i + k);
  });
  // filiação: “filho de A e B”, “Filiação: A / B”
  scan(/\b(?:filh[oa]\s+de|filia[çc][ãa]o)\s*:?\s*/gi, m => {
    const i = m.index + m[0].length, s = T.slice(i, i + 160); let k = cut(s, 150); const s2 = s.slice(0, k), c2 = s2.search(/,\s*(?!\s*(?:e|d[aeo]s?)\s)/); if (c2 > 0) k = c2;
    const ps = s.slice(0, k).split(/\s+e\s+|\s*\/\s*|\s*;\s*|\n/).map(x => x.replace(/[^A-Za-zÀ-ÿ' ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(x => x.split(' ').length >= 2);
    if (ps.length) ents.push({k: 'fil', v: ps.map(p => p === p.toUpperCase() ? titleName(p) : p).join('\n'), i: m.index});
    mask(m.index, i + k);
  });
  // vulgo / alcunha / conhecido como
  scan(/(?:\b(?:vulgo|alcunha|apelid(?:o|ad[oa])(?:\s+de)?|conhecid[oa]s?\s+(?:como|por)(?:\s+alcunha)?)|[,(]\s*v\.)\s*:?\s*/gi, m => {
    const i = m.index + m[0].length, s = T.slice(i, i + 50); const q = s.match(/^["“'‘«]([^"”'’»\n]{1,30})["”'’»]/);
    let v = q ? q[1] : (s.match(new RegExp(`^[${EX_L}][${EX_L}'\\-]*(?:\\s+(?:d[aeo]s?\\s+)?[${EX_U}][${EX_L}'\\-]*){0,2}`)) || [''])[0];
    v = v.trim(); if (!v) return; ents.push({k: 'vulgo', v: v === v.toUpperCase() && v.length > 3 ? titleName(v) : v, i: m.index}); mask(m.index, i + (q ? q[0].length : v.length));
  });
  // nomes: rótulos (nome:, qualificado como…)
  const W = `[${EX_U}][${EX_L}'\\-]+`, NAME = `${W}(?:\\s+(?:(?:d[aeo]s?|e|D[AEO]S?|E)\\s+)?${W}){1,7}`;
  scan(new RegExp(`\\b(nome(?:\\s+completo)?|qualificad[oa]\\s+como|identificad[oa]\\s+como|de\\s+nome|chamad[oa]|o\\s+nacional|a\\s+nacional|autor[a]?|v[ií]tima|testemunha|conduzid[oa]|suspeit[oa]|investigad[oa]|envolvid[oa])(?:\\s*\\d{1,2})?\\s*[:\\-–]?\\s*(?:(?:o|a|sr\\.?|sra\\.?)\\s+)?(${NAME})`, 'gi'), m => {
    const i = m.index + m[0].length - m[2].length; const words = []; const wr = /\S+/g; let w; while ((w = wr.exec(m[2]))) words.push({w: w[0], i: i + w.index});
    const runs = exNameRuns(words).filter(r => r.every(x => PART.has(x.w.toLowerCase()) || /^[A-ZÀ-ÖØ-Þ]/.test(x.w))); if (!runs.length) return; const r = runs[0], a = r[0].i, b = r[r.length - 1].i + r[r.length - 1].w.length;
    if (M.slice(a, b).trim() !== T.slice(a, b).trim()) return;
    const role = (EX_ROLE.find(([, re]) => re.test(m[1])) || [])[0] || '';
    anchors.push({i: a, nome: T.slice(a, b), lab: true, role}); mask(a, b);
  });
  // nomes: sequências em MAIÚSCULAS e Nomes Próprios (≥ 3 palavras, ou 2 com palavra de contexto antes)
  scan(new RegExp(`(^|[^${EX_L}])([${EX_U}][${EX_U}'\\-]*(?:[ \\t]+[${EX_U}][${EX_U}'\\-]*){1,12})(?=$|[^${EX_L}])`, 'g'), m => {
    const i = m.index + m[1].length, words = []; const wr = /\S+/g; let w; while ((w = wr.exec(m[2]))) words.push({w: w[0], i: i + w.index});
    exNameRuns(words).forEach(r => { const a = r[0].i, b = r[r.length - 1].i + r[r.length - 1].w.length; anchors.push({i: a, nome: T.slice(a, b), lab: false}); mask(a, b); });
  });
  scan(new RegExp(`(^|[^${EX_L}])([${EX_U}][a-zà-öø-ÿ'\\-]+(?:[ \\t]+(?:(?:d[aeo]s?|e)[ \\t]+)?[${EX_U}][a-zà-öø-ÿ'\\-]+){1,7})(?=$|[^${EX_L}])`, 'g'), m => {
    const i = m.index + m[1].length, words = []; const wr = /\S+/g; let w; while ((w = wr.exec(m[2]))) words.push({w: w[0], i: i + w.index});
    exNameRuns(words).forEach(r => {
      const a = r[0].i, b = r[r.length - 1].i + r[r.length - 1].w.length, caps = r.filter(x => !PART.has(x.w.toLowerCase())).length;
      const cue = near(a, /(?:^|[\s,(])(?:o|a|é|sr\.?|sra\.?|nome|elemento|indiv[ií]duo|suspeit[oa]|autor[a]?|v[ií]tima|comparsa|irm[ãa]o?|esposa|marido|companheir[oa]|namorad[oa]|chamad[oa]|primo|prima|tio|tia|parceiro|parceira|cara|mano|mana)\s+$/i, 24);
      if (caps >= 3 || cue) { anchors.push({i: a, nome: T.slice(a, b), lab: false}); mask(a, b); }
    });
  });
  // papel (autor, vítima…) nas 40 letras antes do nome
  anchors.forEach(an => { if (!an.role) { const back = T.slice(Math.max(0, an.i - 40), an.i).replace(/\b(sra?|dra?)\./gi, '$1 ').split(/[.;\n]/).pop(); an.role = (EX_ROLE.find(([, re]) => re.test(back)) || [])[0] || ''; } an.b = exBlockOf(bs, an.i); });
  anchors.sort((x, y) => x.i - y.i); ents.sort((x, y) => x.i - y.i);
  return {T, anchors, ents, bs};
}
/* agrupa os dados em pessoas candidatas: cada dado vai para o nome mais próximo ANTES dele no mesmo bloco
   (se não houver, o primeiro nome logo depois, até 160 letras); o resto fica em “dados soltos” */
function exCandidates(text) {
  const {T, anchors, ents, bs} = extractEntities(text);
  const cards = [], byKey = new Map(), loose = [];
  const cardFor = an => { const k = exKey(an.nome); if (byKey.has(k)) { const c = byKey.get(k); if (!c.papel && an.role) c.papel = an.role; return c; }
    if (!an.fl && k.includes(' ')) { const hit = [...byKey].find(([kk, c]) => c.fl && (kk + ' ').startsWith(k + ' ')); if (hit) { byKey.set(k, hit[1]); return hit[1]; } } // v0.8: “Paulo Roberto” = “Paulo Roberto Nascimento” rotulado antes
    const nome = an.nome === an.nome.toUpperCase() ? titleName(an.nome.replace(/\s+/g, ' ')) : an.nome.replace(/\s+/g, ' ');
    const c = exCard({nome, papel: an.role || '', lab: !!an.lab}); if (an.fl) c.fl = true; byKey.set(k, c); cards.push(c); return c; };
  anchors.forEach(an => an.c = cardFor(an));
  // v0.8: dados rotulados (“CPF: …”) vão primeiro (prioridade sobre os adivinhados) e só para nomes rotulados do mesmo bloco, quando houver
  const labAn = anchors.filter(x => x.fl);
  for (const e of [...ents.filter(x => x.lab), ...ents.filter(x => !x.lab)]) {
    const b = exBlockOf(bs, e.i); let an = null; const pool = e.lab && labAn.some(x => x.b === b) ? labAn : anchors;
    for (const x of pool) { if (x.b !== b) continue; if (x.i <= e.i) an = x; else { if (!an && x.i - e.i <= (e.lab ? 400 : 160) && (e.lab || (e.k !== 'fil' && e.k !== 'vulgo'))) an = x; break; } }
    if (!an) { loose.push(exItem(e.k, e.v, e.ok)); continue; }
    exPut(an.c, exItem(e.k, e.v, e.ok), loose);
  }
  cards.forEach(c => { c.inc = !!(c.cpf || c.rg || c.nasc || c.fil || c.apelido || c.tels.length || c.veics.length || c.ends.length || c.obs || c.redes || c.lab); });
  return {cards, loose, text: T};
}
let EX_SEQ = 0;
const exItem = (k, v, ok) => ({id: 'i' + (++EX_SEQ), k, v, ok: ok !== false});
function exCard(o) { return Object.assign({id: 'c' + (++EX_SEQ), inc: true, nome: '', apelido: '', cpf: '', rg: '', nasc: '', fil: '', tels: [], veics: [], ends: [], papel: '', lab: false, redes: '', obs: ''}, o || {}); }
const EX_LIST = {tel: 'tels', veic: 'veics', end: 'ends'}, EX_SCAL = {cpf: 'cpf', rg: 'rg', nasc: 'nasc', vulgo: 'apelido', fil: 'fil', nome: 'nome'};
const EX_ICON = {tel: '📞', veic: '🚗', end: '🏠', cpf: '🪪 CPF', rg: '🪪 RG', nasc: '🎂', vulgo: '“”', fil: '👪', nome: '👤', rgorg: '🪪 Órgão', nat: '📍 Natural de', prof: '💼', rede: '🌐', obs: '🗒️'};
/* põe um dado num cartão; campo único já ocupado → o valor antigo vai para os dados soltos */
function exPut(c, it, loose) {
  if (it.k === 'rgorg') { if (c.rg && !/[A-Za-z]/.test(c.rg)) c.rg += ' ' + it.v; else if (!c.rg) c._rgorg = it.v; return; }
  if (it.k === 'nat' || it.k === 'prof' || it.k === 'obs') { const l = (it.k === 'nat' ? 'Naturalidade: ' : it.k === 'prof' ? 'Profissão: ' : '') + it.v; if (!c.obs.split('\n').some(x => exKey(x) === exKey(l))) c.obs = c.obs ? c.obs + '\n' + l : l; return; }
  if (it.k === 'rede') { if (!c.redes.split('\n').some(x => exKey(x) === exKey(it.v))) c.redes = c.redes ? c.redes + '\n' + it.v : it.v; return; }
  if (EX_LIST[it.k]) { const L = c[EX_LIST[it.k]]; const key = it.k === 'tel' ? (x => { const n = telNorm(x); return n ? n.ddd + n.l8 : _digits(x); }) : it.k === 'veic' ? (x => platesIn(x)[0] || exKey(x)) : exKey;
    if (!L.some(x => key(x) === key(it.v))) L.push(it.v); return; }
  const f = EX_SCAL[it.k]; if (!f) return;
  if (f === 'fil') { const cur = c.fil ? c.fil.split('\n') : []; it.v.split('\n').forEach(p => { if (p && !cur.some(x => exKey(x) === exKey(p))) cur.push(p); }); c.fil = cur.join('\n'); return; }
  if (f === 'cpf' && it.ok === false) c.cpfWarn = true;
  if (!c[f]) { c[f] = it.v; if (f === 'rg' && c._rgorg && !/[A-Za-z]/.test(c.rg)) { c.rg += ' ' + c._rgorg; delete c._rgorg; } return; }
  if (exKey(c[f]) === exKey(it.v) || _digits(c[f]) && _digits(c[f]) === _digits(it.v)) return;
  if (f === 'cpf' && !cpfValid(c[f]) && cpfValid(it.v)) { loose.push(exItem('cpf', c[f], false)); c[f] = it.v; return; }
  loose.push(it);
}

/* ---- leitores de arquivo (no aparelho): PDF (pdf.js), Word .docx (fflate), texto ---- */
async function exPdfLib() {
  if (!window.pdfjsLib) await loadScript(libUrl('pdfjs/pdf.min.js'));
  pdfjsLib.GlobalWorkerOptions.workerSrc = libUrl('pdfjs/pdf.worker.min.js'); return pdfjsLib;
}
async function exPdfOpen(buf) {
  const L = await exPdfLib();
  // isEvalSupported:false — fontes não executam código (proteção recomendada para PDFs de terceiros)
  return L.getDocument({data: new Uint8Array(buf), isEvalSupported: false, disableFontFace: true, useSystemFonts: false, disableAutoFetch: true, disableStream: true, enableXfa: false, verbosity: 0}).promise;
}
async function exPdfText(pdf) {
  const pages = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const pg = await pdf.getPage(n), tc = await pg.getTextContent(); let s = '', lastY = null, lastEnd = null;
    for (const it of tc.items) {
      if (!('str' in it)) continue; const x = it.transform[4], y = it.transform[5], h = Math.abs(it.transform[3]) || it.height || 10;
      if (lastY !== null && Math.abs(y - lastY) > h * .6) { if (!/\n$/.test(s)) s += '\n'; if (Math.abs(y - lastY) > h * 2.2 && !/\n\n$/.test(s)) s += '\n'; } // linha em branco → novo bloco (proximidade)
      else if (lastEnd !== null && x - lastEnd > h * .25 && s && !/\s$/.test(s) && !/^\s/.test(it.str)) s += ' ';
      s += it.str; if (it.hasEOL) s += '\n'; lastY = y; lastEnd = x + (it.width || 0);
    }
    pages.push(s.replace(/[ \t]+\n/g, '\n').trim()); pg.cleanup();
  }
  return pages;
}
async function exPdfPageCanvas(pdf, n, maxSide = 2200) {
  const pg = await pdf.getPage(n), v1 = pg.getViewport({scale: 1}), sc = Math.min(3, maxSide / Math.max(v1.width, v1.height)), vp = pg.getViewport({scale: sc});
  const c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height); const x = c.getContext('2d'); x.fillStyle = '#fff'; x.fillRect(0, 0, c.width, c.height);
  await pg.render({canvasContext: x, viewport: vp}).promise; pg.cleanup(); return c;
}
async function exDocx(buf) {
  if (!window.fflate) await loadScript(libUrl('fflate.min.js'));
  let files; try { files = fflate.unzipSync(new Uint8Array(buf), {filter: f => f.name === 'word/document.xml'}); } catch (e) { throw new Error('arquivo .docx inválido ou corrompido'); }
  const raw = files['word/document.xml']; if (!raw) throw new Error('não encontrei o texto do documento (word/document.xml)');
  const doc = new DOMParser().parseFromString(fflate.strFromU8(raw), 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('documento Word ilegível');
  const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', out = [];
  const para = p => { let s = ''; const walk = n => { for (const c of n.childNodes) { if (c.nodeType !== 1) continue; const l = c.localName; if (l === 't') s += c.textContent; else if (l === 'tab') s += '\t'; else if (l === 'br' || l === 'cr') s += '\n'; else if (l !== 'delText' && l !== 'instrText' && l !== 'rPr' && l !== 'pPr') walk(c); } }; walk(p); return s; };
  const block = n => { for (const c of n.childNodes) { if (c.nodeType !== 1) continue;
    if (c.localName === 'p') out.push(para(c));
    else if (c.localName === 'tbl') { for (const tr of c.getElementsByTagNameNS(W, 'tr')) out.push([...tr.getElementsByTagNameNS(W, 'tc')].map(tc => [...tc.getElementsByTagNameNS(W, 'p')].map(para).join(' ').trim()).filter(Boolean).join(' | ')); out.push(''); }
    else if (c.localName !== 'sectPr') block(c); } };
  block(doc.getElementsByTagNameNS(W, 'body')[0] || doc.documentElement);
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}
function exDecodeText(buf) { try { return new TextDecoder('utf-8', {fatal: true}).decode(buf); } catch (e) { return new TextDecoder('windows-1252').decode(buf); } }
/* resultado da CNH por modelo → cartão de conferência (lote / PDF digitalizado) */
function cnhCardOf(r, img, blob, name) { const ex = r.ex, best = ex.cpfs[0];
  return exCard({nome: ex.nome, cpf: best ? cpfFmt(best.d) : '', cpfWarn: !!(best && !best.ok), rg: ex.rg, nasc: ex.nasc, fil: ex.filiacao.join('\n'), obs: cnhObs(ex).replace(/ · /g, '\n'), inc: !!(ex.nome || (best && best.ok)), raw: r.raw, keepImg: true, conf: r.conf,
    img: {bytes: img, url: exUrl(blob), name: name || 'cnh.jpg', hashOrig: ''}}); }
async function cnhToReview(r, img, blob, src, opId) { const c = cnhCardOf(r, img, blob, (src && src.name || 'cnh').replace(/\.pdf$/i, '') + '_p1.jpg'); c.img.hashOrig = src && src.hash || await sha256(img); closeSheet(); EX_SEQ_PANEL++; exReview({mode: 'doc', cards: [c], loose: [], src: {}, opId: exDefOp(opId), newOp: '', keepNote: false, cnhModel: true}); }
const exKind = (name, u8) => u8[0] === 0x25 && u8[1] === 0x50 && u8[2] === 0x44 && u8[3] === 0x46 ? 'pdf' : u8[0] === 0x50 && u8[1] === 0x4b ? 'docx' : u8[0] === 0xd0 && u8[1] === 0xcf && u8[2] === 0x11 && u8[3] === 0xe0 ? 'doc' : /\.(rtf)$/i.test(name) ? 'rtf' : 'txt';

/* ---- painel de tela cheia (fecha sozinho ao travar o cofre: classe viewer) ---- */
let EX_URLS = [];
function exPanel(html, onMount) {
  let d = $('#expanel'); const keep = d ? d.scrollTop : 0, same = d && d.dataset.k === String(EX_SEQ_PANEL);
  if (!d) { d = document.createElement('div'); d.id = 'expanel'; d.className = 'viewer expanel'; document.body.appendChild(d); }
  d.dataset.k = String(EX_SEQ_PANEL); d.innerHTML = html; onMount && onMount(d); micify(d); if (same) d.scrollTop = keep; return d;
}
let EX_SEQ_PANEL = 0;
function exPanelClose() { const d = $('#expanel'); if (d) d.remove(); EX_URLS.forEach(u => URL.revokeObjectURL(u)); EX_URLS = []; EX_RUN = null; }
const exUrl = blob => { const u = URL.createObjectURL(blob); EX_URLS.push(u); return u; };
const exOpOptions = sel => S.ops.filter(o => !isArq(o) || o.id === sel).map(o => `<option value="${o.id}" ${o.id === sel ? 'selected' : ''}>${esc(o.nome)}</option>`).join('');
const exDefOp = opId => (opId && getOp(opId) ? opId : (ctxOp && ctxOp()) || (activeOps()[0] || S.ops[0] || {}).id || '');

/* ---- 1) Extrair de texto/documento: entrada ---- */
function extractUI(opId, pre) {
  // pre = {src, text}: reabre a tela com o arquivo já carregado (após o aviso de OCR / .doc, que usam a mesma folha)
  const src = pre && pre.src || {name: '', kind: 'texto', hash: '', pages: 0};
  sheet(`<h2 style="margin-top:0">🧾 Extrair de texto/documento</h2>
    <div class="sub" style="margin:0 4px 8px;line-height:1.45">Cole o texto de um <b>BO, relatório, ofício ou mensagem</b> (WhatsApp) ou escolha um <b>PDF</b> ou <b>Word (.docx)</b>. O app procura nomes, CPF, RG, telefones, placas, nascimento, filiação, vulgo e endereços — <b>tudo no aparelho</b>. Rótulos como <span class="kbd">Nome:</span> <span class="kbd">CPF:</span> <span class="kbd">Mãe:</span> <span class="kbd">Endereço:</span> são lidos em qualquer ordem.</div>
    <div class="card glass exai" style="cursor:default">
      <div class="t">🤖 Texto difícil? Organize com uma IA</div>
      <div class="sub" style="line-height:1.45;margin-top:4px">Copie a instrução, cole numa IA <b>junto com o texto, a foto ou o PDF</b> e cole aqui a resposta. No <b>formato ordenado</b> o app lê cada campo <b>exatamente</b>, sem adivinhar.</div>
      <div class="grid2" style="margin-top:10px"><div class="btn pri" id="ex_aicp">📋 Copiar instrução para IA</div><div class="btn" id="ex_aiv">👁️ Ver instrução</div></div>
      <div id="ex_aip" class="hidden"><pre class="exprompt">${esc(AF_PROMPT)}</pre></div>
      <div class="warn" style="margin:10px 0 0">🔐 Enviar dados a um <b>serviço externo de IA</b> (ChatGPT, Gemini, Copilot…) tira as informações do aparelho e pode deixá-las guardadas pelo provedor. Siga a <b>política da sua instituição</b> e prefira uma <b>IA institucional</b>. O app em si não envia nada.</div>
    </div>
    <label>Texto</label><textarea id="ex_t" style="min-height:170px" placeholder="Cole aqui o texto ou a resposta da IA…"></textarea>
    <div id="ex_fmt"></div>
    <div class="sub" id="ex_src" style="margin:6px 4px 0"></div>
    <div class="btn" id="ex_file" style="margin-top:12px">📎 Escolher PDF, Word (.docx) ou .txt</div>
    <div class="warn" style="margin-bottom:0">A extração é <b>automática</b> e pode errar ou deixar passar dados. Na próxima tela você confere tudo; <b>nenhum alvo é criado sem a sua revisão</b>.</div>
    <div class="gap"></div><div class="btn pri" id="ex_go">Extrair e conferir</div>
    <div class="credit">${esc(APP_NAME)} · <b>${esc(CREDIT)}</b></div>`, s => {
    const ta = s.querySelector('#ex_t'), st = s.querySelector('#ex_src');
    if (pre && pre.text != null) { ta.value = pre.text; exSrcInfo(st, src, pre.text); }
    const fmt = () => { const el = s.querySelector('#ex_fmt'); if (el) el.innerHTML = afBadge(ta.value.length < 300000 ? afDetect(ta.value) : null); }; fmt();
    ta.oninput = () => { fmt(); if (src.kind !== 'texto' && src.loaded !== ta.value) { src.edited = true; st.textContent = `📄 ${src.name} · texto editado depois de carregado`; } };
    s.querySelector('#ex_aicp').onclick = async () => toast(await copyText(AF_PROMPT) ? '📋 Instrução copiada — cole na IA junto com o texto, a foto ou o PDF' : 'Não consegui copiar: toque em Ver instrução e copie à mão', 3500);
    s.querySelector('#ex_aiv').onclick = e => { const b = s.querySelector('#ex_aip'), open = b.classList.toggle('hidden') === false; e.currentTarget.textContent = open ? '🙈 Ocultar instrução' : '👁️ Ver instrução'; };
    s.querySelector('#ex_file').onclick = () => pickFile('application/pdf,.pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,.docx,text/plain,.txt,application/msword,.doc', f => exLoadFile(f, opId, src.kind === 'texto' ? ta.value : ''));
    s.querySelector('#ex_go').onclick = async () => {
      const t = ta.value; if (!t.trim()) return toast('Cole um texto ou escolha um arquivo');
      if (src.kind === 'texto') { src.name = ''; src.hash = await sha256(t); }
      const r = afParse(t) || exCandidates(t); EX_SEQ_PANEL++;
      if (r.exact && r.exact.kind === 'none') return toast('A resposta diz NENHUMA PESSOA — nada a importar');
      closeSheet(); exReview({mode: 'text', cards: r.cards, loose: r.loose, src: Object.assign({}, src, {text: t}), opId: exDefOp(opId), newOp: '', keepNote: true, exact: r.exact || null});
    };
  });
}
function exSrcInfo(st, src, text) {
  if (!st) return;
  st.innerHTML = `📄 <b>${esc(src.name)}</b> · ${({pdf: 'PDF', 'pdf-ocr': 'PDF digitalizado (OCR)', 'cnh-e': 'CNH digital (PDF)', docx: 'Word', txt: 'texto'})[src.kind] || ''}${src.pages ? ` · ${src.pages} página(s)` : ''} · ${text.length} caracteres${src.edited ? ' · editado' : ''}<br><span style="font-size:11px">SHA-256 ${esc(src.hash.slice(0, 24))}…</span>`;
}
/* lê o arquivo escolhido e reabre a tela de entrada com o texto (a folha pode ter sido usada por avisos/OCR no meio) */
async function exLoadFile(f, opId, typed) {
  const stEl = () => $('#ex_src'), say = t => { const st = stEl(); if (st) st.textContent = t; };
  const back = msg => { extractUI(opId, typed ? {text: typed} : null); if (msg) setTimeout(() => say(msg), 0); };
  say('⏳ Lendo ' + (f.name || 'arquivo') + '…');
  try {
    const buf = await f.arrayBuffer(), u8 = new Uint8Array(buf), kind = exKind(f.name || '', u8);
    if (kind === 'doc') return sheet(`<h2 style="margin-top:0">📝 Word antigo (.doc)</h2><div class="warn">O formato <b>.doc</b> (Word 97–2003) não pode ser lido no aparelho. Abra o arquivo no Word, Pages ou Google Docs e <b>salve/exporte como .docx</b> (ou PDF), depois escolha de novo.</div><div class="btn pri" id="dc_ok">Entendi</div>`, s2 => s2.querySelector('#dc_ok').onclick = () => back(''));
    if (kind === 'rtf') throw new Error('arquivo .rtf não suportado — salve como .docx ou PDF');
    const src = {name: f.name || 'arquivo', hash: await sha256(buf), kind, pages: 0, edited: false};
    let text = '';
    if (kind === 'pdf') {
      say('⏳ Abrindo o PDF (leitor carregado do app na 1ª vez)…');
      const pdf = await exPdfOpen(buf); src.pages = pdf.numPages;
      try {
        // v0.8: CNH digital (CNH-e) — leitura exata pela posição dos rótulos na camada de texto
        try { const cn = cnheExtract(await cnhePdfItems(pdf)); if (cn) { src.kind = 'cnh-e'; src.text = (await exPdfText(pdf)).join('\n\n'); src.loaded = src.text; if (!KEY) return; closeSheet(); EX_SEQ_PANEL++; return exReview({mode: 'text', cards: cn.cards, loose: cn.loose, src: Object.assign({}, src), opId: exDefOp(opId), newOp: '', keepNote: true, exact: cn.exact}); } } catch (e) { console.warn('CNH-e', e); }
        text = (await exPdfText(pdf)).join('\n\n');
        if (text.replace(/\s/g, '').length < 20 * pdf.numPages) { // sem camada de texto: digitalizado
          const ask = await exAskOcr(pdf.numPages); if (ask === 'cnh') { const pc = await exPdfPageCanvas(pdf, 1, 2000); return cnhCornerUI(pc, warped => cnhProcess(warped, null, (r, img, blob) => cnhToReview(r, img, blob, src, opId)), () => back('')); }
          if (!ask) return back('📄 PDF sem texto selecionável — nada extraído');
          text = await exPdfOcr(pdf, Math.min(pdf.numPages, 15)); src.kind = 'pdf-ocr';
          if (text == null) return back(KEY ? 'Leitura cancelada' : '');
        }
      } finally { pdf.destroy(); }
    } else if (kind === 'docx') text = await exDocx(buf);
    else text = exDecodeText(buf);
    if (!KEY) return;
    src.loaded = text; extractUI(opId, {src, text});
    if (!text.trim()) toast('Nenhum texto encontrado no arquivo');
  } catch (e) { console.warn(e); if (!KEY) return; if (!$('#ex_t')) back(''); setTimeout(() => say('⚠️ ' + e.message), 0); toast('Erro ao ler: ' + e.message); }
}
function exAskOcr(n) {
  return new Promise(res => sheet(`<h2 style="margin-top:0">📄 PDF digitalizado</h2><div class="sub" style="line-height:1.45">Este PDF <b>não tem texto selecionável</b> (parece uma imagem escaneada). Posso ler as páginas com o <b>OCR no aparelho</b> (o mesmo da leitura de documento) — ${n > 15 ? 'as <b>15 primeiras</b> de ' + n + ' páginas' : n + ' página(s)'}. Leva alguns segundos por página e o resultado costuma ter erros: confira.</div><div class="grid2" style="margin-top:16px"><div class="btn" id="ao_n">Agora não</div><div class="btn pri" id="ao_y">Ler com OCR</div></div><div class="btn" id="ao_cnh" style="margin-top:10px">🪪 É uma CNH — ler por modelo (1ª página)</div>`, s => {
    s.querySelector('#ao_n').onclick = () => { closeSheet(); res(false); }; s.querySelector('#ao_y').onclick = () => res(true); s.querySelector('#ao_cnh').onclick = () => res('cnh'); }));
}
async function exPdfOcr(pdf, n) {
  let stop = false, cancelRes; const out = [], cancelP = new Promise(r => cancelRes = r);
  const prog = ocrBusySheet('📄 Lendo páginas com OCR…'); const st = () => $('#oc_st');
  $('#sheet').insertAdjacentHTML('beforeend', '<div class="btn" id="oc_cancel" style="margin-top:12px">Cancelar</div>'); $('#oc_cancel').onclick = () => { stop = true; cancelRes('cancel'); ocrStop(); };
  for (let i = 1; i <= n && !stop; i++) {
    if (!KEY) return null; resetIdle();
    const pre = `Página ${i} de ${n} · `;
    try { const c = await exPdfPageCanvas(pdf, i); const cv = ocrCanvas(c, {x: 0, y: 0, w: c.width, h: c.height}, 2200);
      const d = await Promise.race([runOcr(cv, {tessedit_pageseg_mode: '3'}, m => { prog(m); if (st()) st().textContent = pre + ocrStepTxt(m); }), cancelP]); if (d === 'cancel') break; out.push(d.text.trim()); }
    catch (e) { if (stop) break; console.warn(e); out.push(''); }
  }
  if (!KEY) return null; closeSheet(); if (stop && !out.some(Boolean)) { toast('Leitura cancelada'); return null; } if (stop) toast(`Leitura interrompida — ${out.length} de ${n} página(s) lida(s)`);
  return out.join('\n\n');
}

/* ---- conferência (comum ao texto e aos documentos em lote) ---- */
let EX_RUN = null;
function exReview(R) {
  EX_RUN = R; const cards = R.cards, q = (d, x) => d.querySelector(x);
  const label = c => `Pessoa ${cards.indexOf(c) + 1}`;
  const itemLbl = (k, v) => `${EX_ICON[k] || ''} ${esc(k === 'nasc' ? dateBR(v) : k === 'fil' ? v.replace(/\n/g, ' / ') : v)}`;
  const moveSel = (where, k, idx, iid) => `<select class="exmv" data-w="${where}" data-k="${k}" data-x="${idx}" data-iid="${iid || ''}" aria-label="Mover"><option value="">Mover…</option>${cards.filter(c => c.id !== where).map(c => `<option value="${c.id}">→ ${esc(label(c))}${c.nome ? ': ' + esc(c.nome.slice(0, 24)) : ''}</option>`).join('')}${where === 'loose' ? '<option value="new">→ Nova pessoa</option>' : '<option value="loose">→ Dados soltos</option>'}<option value="del">✕ Remover</option></select>`;
  const chips = c => [['tel', 'tels'], ['veic', 'veics'], ['end', 'ends']].flatMap(([k, f]) => c[f].map((v, i) => `<span class="chip c-gray exchip">${itemLbl(k, v)} <b class="exmvb">⇄</b>${moveSel(c.id, k, i)}</span>`)).join('');
  const cardHtml = c => `<div class="card glass excard ${c.inc ? '' : 'off'}" data-c="${c.id}" style="cursor:default">
    <div class="row"><label class="ocrl" style="margin:0"><input type="checkbox" class="ocrck exinc" ${c.inc ? 'checked' : ''}> <b style="color:var(--txt)">${label(c)}</b>${c.papel ? ` <span class="chip c-blue">${esc(c.papel)}</span>` : ''}</label>
      <select class="exmenu" aria-label="Ações"><option value="">⋯</option>${cards.filter(x => x !== c).map(x => `<option value="m:${x.id}">Juntar com ${esc(label(x))}${x.nome ? ': ' + esc(x.nome.slice(0, 22)) : ''}</option>`).join('')}<option value="rm">Remover cartão</option></select></div>
    ${c.img ? `<div class="exdoc"><div class="th docth" style="width:96px;aspect-ratio:1.5;flex-shrink:0"><img src="${c.img.url}"></div><div><div class="sub">🪪 ${esc(c.img.name || 'imagem')}</div><label class="ocrl" style="margin:6px 0 0"><input type="checkbox" class="ocrck exkimg" ${c.keepImg ? 'checked' : ''}> Guardar como foto do documento</label></div></div>` : ''}
    ${exCardWarn(c)}${c.conf ? `<div class="sub" style="margin:8px 2px 0">🎯 Confiança do OCR: ${[['nome', 'nome'], ['cpf', 'CPF'], ['rg', 'RG'], ['nasc', 'nasc.'], ['fil', 'filiação']].map(([k, l]) => `${l} <span class="confchip ${c.conf[k] >= 80 ? 'hi' : c.conf[k] >= 60 ? 'md' : 'lo'}">${c.conf[k] != null ? c.conf[k] + '%' : '—'}</span>`).join(' ')}</div>` : ''}
    <div class="exf"><label>Nome</label><input data-f="nome" value="${esc(c.nome)}" placeholder="obrigatório para criar"></div>
    <div class="grid2"><div class="exf"><label>Vulgo</label><input data-f="apelido" value="${esc(c.apelido)}"></div><div class="exf"><label>Nascimento</label><input data-f="nasc" type="date" value="${esc(c.nasc)}"></div></div>
    <div class="grid2"><div class="exf"><label>CPF</label><input data-f="cpf" inputmode="numeric" value="${esc(c.cpf)}"><div class="sub excpf">${exCpfSt(c.cpf)}</div></div><div class="exf"><label>RG</label><input data-f="rg" value="${esc(c.rg)}"></div></div>
    <div class="exf"><label>Filiação</label><textarea data-f="fil" style="min-height:48px">${esc(c.fil)}</textarea></div>
    ${c.redes || c.exact ? `<div class="exf"><label>Redes sociais <span class="sub" style="font-weight:400">(uma por linha)</span></label><textarea data-f="redes" style="min-height:44px">${esc(c.redes)}</textarea></div>` : ''}
    ${c.obs || c.exact ? `<div class="exf"><label>Observações <span class="sub" style="font-weight:400">(viram anotação no alvo)</span></label><textarea data-f="obs" style="min-height:44px">${esc(c.obs)}</textarea></div>` : ''}
    ${chips(c) ? `<div class="chips" style="margin-top:10px">${chips(c)}</div>` : ''}
    ${c.raw != null ? `<details class="ocrraw"><summary class="sub">Ver texto lido</summary><pre>${esc(c.raw || '(nada)')}</pre></details>` : ''}</div>`;
  const nInc = cards.filter(c => c.inc).length, src = R.src || {};
  exPanel(`<div class="exhead"><div class="back" id="ex_x" style="margin:0">‹ Cancelar</div><div class="sub">${R.mode === 'doc' ? '🪪 Documentos em lote' : '🧾 Extração'}</div></div>
    <h1 style="margin-top:6px">Conferir ${R.mode === 'doc' ? 'leituras' : 'extração'}</h1>
    ${R.exact ? afBadge({kind: R.exact.kind, persons: cards, ignored: R.exact.ignored}) : ''}
    <div class="warn">${R.mode === 'doc' ? `Leitura <b>automática (OCR${R.cnhModel || cards.some(c => c.conf) ? ', por moldura de CNH' : ''})</b>: pode trocar letras e números. Confira cada cartão com a imagem.` : R.exact && R.exact.kind === 'cnh' ? 'Dados lidos <b>direto do texto do PDF</b> da CNH digital, pela posição dos rótulos. Confira mesmo assim (modelos de PDF variam).' : R.exact ? 'Os campos foram lidos <b>exatamente</b> como estão no texto — mas quem escreveu (a IA ou você) pode ter errado. Confira com o material original, principalmente CPF, datas e telefones.' : 'Extração <b>automática</b>: pode juntar dados da pessoa errada, errar nomes ou deixar passar dados.'} Só os cartões marcados viram alvos, e <b>nada é salvo</b> até o último passo.</div>
    <div class="sub" style="margin:0 4px 6px">${src.name ? `📄 <b>${esc(src.name)}</b>${src.pages ? ` · ${src.pages} pág.` : ''} · ` : R.mode === 'doc' ? `${cards.length} imagem(ns) · ` : R.exact ? (R.exact.kind === 'cnh' ? '🪪 CNH digital · ' : '🤖 Formato ordenado · ') : '📋 Texto colado · '}${cards.length} pessoa(s) encontrada(s) · ${R.loose.length} dado(s) solto(s)</div>
    <label>Operação de destino</label><select id="ex_op">${exOpOptions(R.opId)}<option value="__new" ${R.opId === '__new' ? 'selected' : ''}>➕ Nova operação…</option></select>
    <div id="ex_nopw" class="${R.opId === '__new' ? '' : 'hidden'}"><label>Nome da nova operação</label><input id="ex_nop" value="${esc(R.newOp)}" placeholder="Ex.: Operação Aurora"></div>
    <h2>Pessoas (${cards.length}) <span class="sub" style="font-weight:400">· ${nInc} marcada(s)</span></h2>
    ${cards.length ? cards.map(cardHtml).join('') : '<div class="empty" style="padding:20px"><div>🔎</div>Nenhuma pessoa reconhecida. Use <b>+ Adicionar pessoa</b> e mova os dados soltos.</div>'}
    <div class="btn" id="ex_add">＋ Adicionar pessoa</div>
    <h2>Dados soltos (${R.loose.length})</h2>
    <div class="sub" style="margin:0 4px 8px">Encontrados sem um nome por perto. Toque em <b>⇄</b> para mandar a uma pessoa.</div>
    ${R.loose.length ? `<div class="chips" id="ex_loose">${R.loose.map((it, i) => `<span class="chip ${it.ok === false ? 'c-amb' : 'c-gray'} exchip">${itemLbl(it.k, it.v)}${it.k === 'cpf' && it.ok === false ? ' ⚠️' : ''} <b class="exmvb">⇄</b>${moveSel('loose', it.k, i, it.id)}</span>`).join('')}</div>` : '<div class="sub" style="margin:0 4px">Nenhum.</div>'}
    <div class="tgrow card glass" style="cursor:default;margin-top:16px"><div>${R.mode === 'doc' ? '🗒️ Guardar o texto lido como anotação' : '🗒️ Guardar o texto de origem como anotação'}<div class="sub">criptografada, em cada alvo criado/completado${src.name ? ', com nome do arquivo e SHA-256' : ''}</div></div><div class="tg ${R.keepNote ? 'on' : ''}" id="ex_note"></div></div>
    <div class="gap"></div><div class="btn pri" id="ex_next">Conferir duplicados →</div>
    ${credit()}`, d => {
    q(d, '#ex_x').onclick = async () => { d.style.display = 'none'; if (await confirmBox('Descartar esta conferência? Nada foi salvo.', 'Descartar', true)) exPanelClose(); else d.style.display = ''; };
    q(d, '#ex_op').onchange = e => { R.opId = e.target.value; q(d, '#ex_nopw').classList.toggle('hidden', R.opId !== '__new'); };
    q(d, '#ex_nop').oninput = e => R.newOp = e.target.value;
    q(d, '#ex_note').onclick = e => { R.keepNote = !R.keepNote; e.target.classList.toggle('on', R.keepNote); };
    d.querySelectorAll('.excard').forEach(el => {
      const c = cards.find(x => x.id === el.dataset.c);
      el.querySelectorAll('[data-f]').forEach(inp => inp.oninput = () => { c[inp.dataset.f] = inp.value; if (inp.dataset.f === 'cpf') { el.querySelector('.excpf').innerHTML = exCpfSt(inp.value); c.cpfWarn = !!_digits(inp.value) && !cpfValid(inp.value); const w = el.querySelector('.exwarn'); if (w) w.outerHTML = exCardWarn(c) || '<div class="exwarn hidden"></div>'; } });
      q(el, '.exinc').onchange = e => { c.inc = e.target.checked; el.classList.toggle('off', !c.inc); };
      const ki = q(el, '.exkimg'); if (ki) ki.onchange = e => c.keepImg = e.target.checked;
      q(el, '.exmenu').onchange = e => { const v = e.target.value; e.target.value = '';
        if (v === 'rm') { exDropCard(R, c); exReview(R); }
        else if (v.startsWith('m:')) { const o = cards.find(x => x.id === v.slice(2)); if (o) { const msg = `🔗 ${label(c)} juntada em ${label(o)}`; exMergeCards(R, o, c); exReview(R); toast(msg); } } };
    });
    d.querySelectorAll('.exmv').forEach(sel => sel.onchange = () => {
      const to = sel.value; if (!to) return; const w = sel.dataset.w, k = sel.dataset.k, x = +sel.dataset.x; let it;
      if (w === 'loose') { it = R.loose.splice(x, 1)[0]; }
      else { const c = cards.find(y => y.id === w), f = EX_LIST[k]; it = exItem(k, c[f].splice(x, 1)[0]); }
      if (to === 'loose') R.loose.push(it);
      else if (to === 'new') { const c = exCard({inc: true}); cards.push(c); exPut(c, it, R.loose); }
      else if (to !== 'del') { const c = cards.find(y => y.id === to); if (c) { exPut(c, it, R.loose); c.inc = true; } }
      exReview(R);
    });
    q(d, '#ex_add').onclick = () => { cards.push(exCard({inc: true})); exReview(R); setTimeout(() => { const el = d.querySelector('.excard:last-of-type input[data-f="nome"]'); if (el) { el.scrollIntoView({block: 'center'}); el.focus(); } }, 50); };
    q(d, '#ex_next').onclick = () => {
      const inc = cards.filter(c => c.inc); if (!inc.length) return toast('Marque pelo menos uma pessoa');
      const semNome = inc.find(c => !c.nome.trim()); if (semNome) { toast(`${label(semNome)}: informe o nome ou desmarque`); d.querySelector(`.excard[data-c="${semNome.id}"] input[data-f="nome"]`).scrollIntoView({block: 'center'}); return; }
      if (R.opId === '__new' && !R.newOp.trim()) return toast('Dê um nome à nova operação');
      if (!R.opId) return toast('Escolha a operação');
      EX_SEQ_PANEL++; exDupStep(R);
    };
  });
}
const exCardWarn = c => { const w = [];
  if (_digits(c.cpf) && !cpfValid(c.cpf)) w.push(`⚠️ CPF ${_digits(c.cpf).length === 11 ? 'com dígitos verificadores que <b>não conferem</b>' : 'incompleto'} — mantido para você conferir`);
  if (c.incerto) w.push('⚠️ Há leitura <b>incerta</b> — veja Observações');
  return w.length ? `<div class="exwarn">${w.join('<br>')}</div>` : `<div class="exwarn hidden"></div>`; };
const exCpfSt = v => { const d = _digits(v); return !d ? '' : d.length !== 11 ? '<span style="color:#ffadad">⚠️ precisa de 11 dígitos</span>' : cpfValid(d) ? '<span style="color:#7be3b0">✓ dígitos conferem</span>' : '<span style="color:#ffadad">⚠️ dígitos não conferem</span>'; };
function exMergeCards(R, into, from) {
  ['nome', 'apelido', 'cpf', 'rg', 'nasc'].forEach(f => { if (from[f] && !into[f]) into[f] = from[f]; else if (from[f] && exKey(from[f]) !== exKey(into[f]) && f !== 'nome') R.loose.push(exItem(f === 'apelido' ? 'vulgo' : f, from[f])); });
  if (from.fil) exPut(into, exItem('fil', from.fil), R.loose);
  (from.redes || '').split('\n').filter(Boolean).forEach(v => exPut(into, exItem('rede', v), R.loose)); (from.obs || '').split('\n').filter(Boolean).forEach(v => exPut(into, exItem('obs', v), R.loose)); if (from.incerto) into.incerto = true;
  from.tels.forEach(v => exPut(into, exItem('tel', v), R.loose)); from.veics.forEach(v => exPut(into, exItem('veic', v), R.loose)); from.ends.forEach(v => exPut(into, exItem('end', v), R.loose));
  if (!into.img && from.img) { into.img = from.img; into.keepImg = from.keepImg; } if (from.raw) into.raw = (into.raw ? into.raw + '\n\n---\n\n' : '') + from.raw;
  if (!into.papel) into.papel = from.papel; into.inc = true; R.cards.splice(R.cards.indexOf(from), 1);
}
function exDropCard(R, c) { // dados de contato não somem: vão para os dados soltos
  c.tels.forEach(v => R.loose.push(exItem('tel', v))); c.veics.forEach(v => R.loose.push(exItem('veic', v))); c.ends.forEach(v => R.loose.push(exItem('end', v)));
  if (c.cpf) R.loose.push(exItem('cpf', c.cpf, cpfValid(c.cpf))); if (c.rg) R.loose.push(exItem('rg', c.rg));
  R.cards.splice(R.cards.indexOf(c), 1);
}
/* duplicados: mesma operação + mesmo CPF/RG (documento) ou mesmo nome — igual à importação em lote */
const exDocTokens = doc => (String(doc || '').match(/\d[\d.\-\/]*[\dXx]?/g) || []).map(x => _digits(x)).filter(x => x.length >= 5);
function exFindDup(opId, c, skip) {
  if (!opId || opId === '__new') return null; const cpf = _digits(c.cpf), rg = _digits(c.rg);
  for (const a of S.alvos) { if (a.opId !== opId || (skip && skip.has(a.id))) continue; const tk = exDocTokens(a.doc);
    if (cpf.length === 11 && (tk.includes(cpf) || _digits(a.doc) === cpf)) return {a, why: 'mesmo CPF'};
    if (rg.length >= 5 && tk.includes(rg)) return {a, why: 'mesmo RG'}; }
  for (const a of S.alvos) if (a.opId === opId && !(skip && skip.has(a.id)) && c.nome.trim() && exKey(a.nome) === exKey(c.nome)) return {a, why: 'mesmo nome'};
  return null;
}
const exDocStr = c => { const d = _digits(c.cpf), cpf = d.length === 11 ? cpfFmt(d) : c.cpf.trim(), rg = c.rg.trim(); return cpf && rg ? `${cpf} / RG ${rg}` : cpf || (rg ? 'RG ' + rg : ''); };
function exDupStep(R) {
  const inc = R.cards.filter(c => c.inc);
  inc.forEach(c => { const f = exFindDup(R.opId, c); if (!f) { c.dup = null; c.act = 'new'; return; } if (!c.dup || c.dup.a !== f.a) c.act = 'merge'; c.dup = f; });
  // repetidos dentro da própria leitura
  const seen = new Map(), inner = []; inc.forEach(c => { const k = _digits(c.cpf).length === 11 ? 'cpf' + _digits(c.cpf) : 'n' + exKey(c.nome); if (seen.has(k)) inner.push([seen.get(k), c]); else seen.set(k, c); });
  const lbl = c => `Pessoa ${R.cards.indexOf(c) + 1}`;
  const row = c => `<div class="card glass exdup" data-c="${c.id}" style="cursor:default"><div class="row"><div><div class="t">${c.dup ? '🔁' : '➕'} ${esc(c.nome)}</div><div class="sub">${esc(lbl(c))}${exDocStr(c) ? ' · ' + esc(exDocStr(c)) : ''}${c.tels.length ? ' · ' + c.tels.length + ' tel.' : ''}${c.img && c.keepImg ? ' · 🪪 imagem' : ''}</div></div></div>
    ${c.dup ? `<div class="sub" style="margin:8px 0 6px;color:#ffcf8a">Já existe nesta operação: <b>${esc(c.dup.a.nome)}</b> (${c.dup.why})</div><select class="exact"><option value="merge" ${c.act === 'merge' ? 'selected' : ''}>Completar o existente (só campos vazios)</option><option value="new" ${c.act === 'new' ? 'selected' : ''}>Criar outro alvo mesmo assim</option><option value="skip" ${c.act === 'skip' ? 'selected' : ''}>Não importar</option></select>` : '<div class="sub" style="margin-top:6px">Novo alvo</div>'}</div>`;
  const opName = R.opId === '__new' ? R.newOp.trim() + ' (nova)' : (getOp(R.opId) || {}).nome;
  const counts = () => ({n: inc.filter(c => c.act === 'new').length, m: inc.filter(c => c.act === 'merge').length});
  const k = counts();
  exPanel(`<div class="exhead"><div class="back" id="ed_b" style="margin:0">‹ Voltar à conferência</div></div>
    <h1 style="margin-top:6px">Duplicados</h1><div class="sub" style="margin:4px 4px 10px">Destino: <b>${esc(opName)}</b> · comparação por CPF/RG e nome dentro da operação</div>
    ${inner.length ? `<div class="warn">⚠️ ${inner.map(([a, b]) => `${esc(lbl(a))} e ${esc(lbl(b))}`).join('; ')} parecem a mesma pessoa. Volte e use <b>⋯ → Juntar</b>, ou siga assim.</div>` : ''}
    ${inc.map(row).join('')}
    <div class="sub" style="margin:8px 4px;line-height:1.45">“Completar” preenche só os campos <b>vazios</b> do alvo existente e acrescenta telefones/placas novos; nada do que já existe é apagado ou trocado.</div>
    <div class="gap"></div><div class="btn pri ${k.n + k.m ? '' : 'dis'}" id="ed_ok">Salvar: ${k.n} novo(s) · ${k.m} completado(s)</div>${credit()}`, d => {
    d.querySelector('#ed_b').onclick = () => { EX_SEQ_PANEL++; exReview(R); };
    d.querySelectorAll('.exdup').forEach(el => { const s = el.querySelector('.exact'); if (s) s.onchange = () => { R.cards.find(c => c.id === el.dataset.c).act = s.value; exDupStep(R); }; });
    d.querySelector('#ed_ok').onclick = () => { const kk = counts(); if (!kk.n && !kk.m) return toast('Nada para salvar'); exSave(R); };
  });
}
async function exSave(R) {
  const btn = $('#ed_ok'); if (!btn || btn.dataset.busy) return; btn.dataset.busy = '1'; btn.textContent = 'Salvando e criptografando…';
  try {
    let opId = R.opId, newOp = false;
    if (opId === '__new') { const ex = S.ops.find(o => exKey(o.nome) === exKey(R.newOp)); if (ex) opId = ex.id; else { opId = uid(); S.ops.push({id: opId, nome: R.newOp.trim(), status: 'planejada', desc: '', ts: Date.now(), audios: [], vig: [], diario: [], trajetos: []}); newOp = true; } }
    const src = R.src || {}, now = Date.now(), isCnhe = !!(R.exact && R.exact.kind === 'cnh'), isCnhM = !!(R.mode === 'doc' && (R.cnhModel || R.cards.some(c => c.conf)));
    const how = R.mode === 'doc' ? (isCnhM ? 'leitura de CNH por modelo (OCR)' : 'leitura de documento em lote') : isCnhe ? 'CNH digital em PDF — leitura exata' : R.exact ? 'formato ordenado (IA) — leitura exata' : 'extração de texto/documento';
    const redesOf = c => String(c.redes || '').split('\n').map(x => x.trim()).filter(Boolean);
    const obsNote = c => String(c.obs || '').trim() ? `🗒️ Observações ${isCnhe ? 'da CNH digital' : isCnhM ? 'da CNH (leitura por modelo)' : R.exact ? 'do formato ordenado (IA)' : 'da extração'}, conferidas:\n${String(c.obs).trim()}` : '';
    const noteTxt = c => { if (!R.keepNote) return '';
      const body = R.mode === 'doc' ? (c.raw || '') : (src.text || ''); if (!body.trim()) return '';
      const head = R.mode === 'doc' ? `🪪 Texto lido do documento (OCR automático)${c.img ? ' — imagem: ' + (c.img.name || '') + ' · SHA-256 do arquivo: ' + c.img.hashOrig : ''}` : `📄 Texto de origem (${isCnhe ? 'CNH digital em PDF — leitura exata' : R.exact ? 'formato ordenado — leitura exata' : 'extração automática'}, revisada)${src.name ? ` — arquivo: ${src.name} · SHA-256 do arquivo: ${src.hash}${src.edited ? ' (texto editado depois de carregado)' : ''}` : ` — texto colado · SHA-256: ${src.hash}`}`;
      const max = 8000; return head + '\n\n' + (body.length > max ? body.slice(0, max) + `\n\n[… texto truncado: ${body.length} caracteres no total — o SHA-256 acima é do original]` : body); };
    const putDoc = async (a, c) => { if (!c.img || !c.keepImg) return false; if (a.docFoto) return false; const id = uid(); await putImg(id, new Uint8Array(c.img.bytes)); a.docFoto = {id, ts: Date.now(), hash: await sha256(c.img.bytes), hashOrig: c.img.hashOrig, arquivo: c.img.name || ''}; return true; };
    let nNew = 0, nMerge = 0;
    for (const c of R.cards.filter(c => c.inc)) {
      if (!KEY) return;
      const doc = exDocStr(c), fil = c.fil.trim(), veic = c.veics.join('; '), end = c.ends.join(' / ');
      const tels = []; c.tels.forEach(t => { if (!tels.some(x => telKey(x) === telKey(t))) tels.push(t); });
      if (c.act === 'merge' && c.dup && S.alvos.includes(c.dup.a)) {
        const a = c.dup.a, done = [];
        [['apelido', c.apelido.trim(), 'vulgo'], ['doc', doc, 'documento'], ['nasc', c.nasc, 'nascimento'], ['filiacao', fil, 'filiação'], ['veic', veic, 'veículo'], ['end', end, 'endereço']].forEach(([f, v, l]) => { if (v && !String(a[f] || '').trim()) { a[f] = v; done.push(l); } });
        if (String(a.veic || '').trim() && c.veics.length) { const have = new Set(platesIn(a.veic)), nv = c.veics.filter(v => { const pl = platesIn(v)[0]; return pl && !have.has(pl); }); if (nv.length) { a.veic = a.veic.trim() + '; ' + nv.join('; '); done.push(nv.length + ' veículo(s)/placa(s)'); } }
        a.tels = a.tels || []; const nt = tels.filter(t => !a.tels.some(x => telKey(x) === telKey(t))); if (nt.length) { a.tels.push(...nt); done.push(nt.length + ' telefone(s)'); }
        if (c.papel && !(a.tags || []).some(t => exKey(t) === exKey(c.papel))) { a.tags = a.tags || []; a.tags.push(c.papel); }
        if (await putDoc(a, c)) done.push('foto do documento');
        a.redes = a.redes || []; const nr = redesOf(c).filter(r => !a.redes.some(x => exKey(x) === exKey(r))); if (nr.length) { a.redes.push(...nr); done.push(nr.length + ' rede(s) social(is)'); }
        const ob = obsNote(c); if (ob) { a.notas = a.notas || []; a.notas.push({id: uid(), ts: now, txt: ob}); done.push('observações (anotação)'); }
        const nt2 = noteTxt(c); if (nt2) { a.notas = a.notas || []; a.notas.push({id: uid(), ts: now, txt: nt2}); }
        a.log = a.log || []; a.log.push({ts: now, t: `Completado por ${how}${done.length ? ': ' + done.join(', ') : ' (nenhum campo vazio a preencher)'}`}); nMerge++;
      } else if (c.act === 'new' || !c.dup) {
        const a = {id: uid(), opId, nome: c.nome.trim(), apelido: c.apelido.trim(), doc, nasc: c.nasc, filiacao: fil, prio: 'media', tels, veic, end, vinc: '', situacao: '', situacaoOutro: '', redes: redesOf(c), mandados: [], tags: c.papel ? [c.papel] : [], fotos: [], locais: [], notas: [], audios: [], pend: [], log: [{ts: now, t: `Cadastrado por ${how} (conferido)`}], ts: now};
        S.alvos.push(a); if (await putDoc(a, c)) a.log.push({ts: now, t: 'Foto do documento registrada (leitura em lote)'});
        const ob = obsNote(c); if (ob) a.notas.push({id: uid(), ts: now, txt: ob});
        const nt2 = noteTxt(c); if (nt2) a.notas.push({id: uid(), ts: now, txt: nt2}); nNew++;
      }
    }
    await save(); exPanelClose(); location.hash = '#op/' + opId; route();
    toast(`✔ ${nNew} alvo(s) criado(s)${nMerge ? ` · ${nMerge} completado(s)` : ''}${newOp ? ' · nova operação' : ''}`, 3500);
  } catch (e) { console.error(e); toast('Erro ao salvar: ' + e.message); if (btn) { delete btn.dataset.busy; btn.textContent = 'Tentar de novo'; } }
}
const telKey = t => { const n = telNorm(t); return n ? n.l8 : _digits(t); };

/* ---- 2) Fotos em lote pelo nome do arquivo ---- */
const exSlug = s => _norm(s).replace(/[^a-z0-9]+/g, '');
function exFileKeys(name) {
  const b0 = String(name || '').replace(/\.[A-Za-z0-9]{2,5}$/, '').trim(), b1 = b0.replace(/(?:[\s_\-.]*\(\d{1,3}\)|[\s_\-.]+\d{1,2})$/, '');
  return [...new Set([b0, b1])].filter(Boolean).map(b => ({digits: _digits(b), letters: exSlug(b).replace(/\d+/g, '')}));
}
function exAlvoKeys(a) {
  const d = new Set(exDocTokens(a.doc)); const ad = _digits(a.doc); if (ad.length >= 5) d.add(ad);
  const parts = _norm(a.nome).split(/[^a-z0-9]+/).filter(Boolean), np = parts.filter(w => !PART.has(w)), names = new Set([parts.join(''), np.join('')]);
  if (np.length >= 2) names.add(np[0] + np[np.length - 1]);
  return {d, names, vul: a.apelido && exSlug(a.apelido).length >= 3 ? exSlug(a.apelido) : ''};
}
function exMatchFile(name, alvos) {
  const keys = exFileKeys(name), K = alvos.map(a => [a, exAlvoKeys(a)]);
  for (const k of keys) if (k.digits.length >= 5) { const hit = K.filter(([, x]) => x.d.has(k.digits)).map(([a]) => a); if (hit.length) return {alvos: [...new Set(hit)], why: k.digits.length === 11 && cpfValid(k.digits) ? 'CPF' : 'documento'}; }
  for (const k of keys) if (k.letters.length >= 4) {
    const hn = K.filter(([, x]) => x.names.has(k.letters)).map(([a]) => a); if (hn.length) return {alvos: hn, why: 'nome'};
    const hv = K.filter(([, x]) => x.vul && x.vul === k.letters).map(([a]) => a); if (hv.length) return {alvos: hv, why: 'vulgo'};
  }
  return null;
}
function photoBatchUI(opId) {
  pickFile('image/*', files => {
    files = files.filter(f => /^image\//.test(f.type) || /\.(jpe?g|png|heic|heif|webp|gif)$/i.test(f.name));
    if (!files.length) return toast('Nenhuma imagem escolhida');
    EX_SEQ_PANEL++; const P = {files: files.map(f => ({f, url: exUrl(f), sel: '', why: '', amb: 0})), scope: opId && getOp(opId) ? opId : '', capa: true, stamp: !!S.cfg.carimbo};
    exPhotoMatch(P); exPhotoReview(P);
  }, true);
}
function exPhotoMatch(P) {
  const alvos = S.alvos.filter(a => P.scope ? a.opId === P.scope : !isArq(getOp(a.opId)));
  P.files.forEach(r => { const m = exMatchFile(r.f.name, alvos); r.why = m ? m.why : ''; r.amb = m && m.alvos.length > 1 ? m.alvos.length : 0; r.cands = m ? m.alvos.map(a => a.id) : []; r.sel = m && m.alvos.length === 1 ? m.alvos[0].id : ''; });
}
function exPhotoReview(P) {
  const alvos = S.alvos.filter(a => P.scope ? a.opId === P.scope : !isArq(getOp(a.opId))).slice().sort((x, y) => x.nome.localeCompare(y.nome, 'pt-BR'));
  const opt = r => `<option value="">— não importar —</option>${r.cands.length > 1 ? `<optgroup label="Possíveis (${r.why})">${r.cands.map(id => getAlvo(id)).filter(Boolean).map(a => `<option value="${a.id}" ${r.sel === a.id ? 'selected' : ''}>${esc(a.nome)} · ${esc((getOp(a.opId) || {}).nome || '')}</option>`).join('')}</optgroup>` : ''}<optgroup label="Alvos">${alvos.map(a => `<option value="${a.id}" ${r.sel === a.id && r.cands.length <= 1 ? 'selected' : ''}>${esc(a.nome)}${P.scope ? '' : ' · ' + esc((getOp(a.opId) || {}).nome || '')}</option>`).join('')}</optgroup>`;
  const row = (r, i) => `<div class="exprow glass" data-i="${i}"><div class="th" style="width:56px;height:56px;flex-shrink:0"><img src="${r.url}" loading="lazy"></div><div style="flex:1;min-width:0"><div class="exfn">${esc(r.f.name)}</div><div class="sub">${r.amb ? `⚠️ ${r.amb} alvos possíveis (${esc(r.why)}) — escolha` : r.why ? `✓ pelo ${esc(r.why)}` : 'sem correspondência'}</div><select class="exps">${opt(r)}</select></div></div>`;
  const matched = P.files.map((r, i) => [r, i]).filter(([r]) => r.why), un = P.files.map((r, i) => [r, i]).filter(([r]) => !r.why), nImp = P.files.filter(r => r.sel).length;
  exPanel(`<div class="exhead"><div class="back" id="pb_x" style="margin:0">‹ Cancelar</div><div class="sub">🖼️ Fotos pelo nome</div></div>
    <h1 style="margin-top:6px">Fotos em lote</h1><div class="sub" style="margin:4px 4px 10px;line-height:1.45">${P.files.length} foto(s). O nome do arquivo (sem extensão, sem acento/espaço/separador) foi comparado com <b>CPF, RG/documento, nome e vulgo</b> dos alvos. Ex.: <span class="kbd">52998224725_2.jpg</span>, <span class="kbd">joao-carlos-da-silva.jpg</span>.</div>
    <label>Procurar alvos em</label><select id="pb_sc"><option value="">Todas as operações (ativas)</option>${exOpOptions(P.scope)}</select>
    <h2>Com correspondência (${matched.length})</h2>${matched.length ? matched.map(([r, i]) => row(r, i)).join('') : '<div class="sub" style="margin:0 4px">Nenhuma.</div>'}
    <h2>Sem correspondência (${un.length})</h2>${un.length ? `<div class="sub" style="margin:0 4px 8px">Escolha o alvo manualmente ou deixe “não importar”.</div>` + un.map(([r, i]) => row(r, i)).join('') : '<div class="sub" style="margin:0 4px">Nenhuma.</div>'}
    <div class="card glass" style="cursor:default;padding:0;margin-top:14px"><div class="tgrow"><div>⭐ 1ª foto vira capa<div class="sub">só para alvos sem capa escolhida</div></div><div class="tg ${P.capa ? 'on' : ''}" id="pb_capa"></div></div>
      <div class="tgrow"><div>🕓 Carimbo<div class="sub">cópia com data/GPS da própria foto</div></div><div class="tg ${P.stamp ? 'on' : ''}" id="pb_st"></div></div></div>
    <div class="sub" style="margin:8px 4px;line-height:1.4">Entram como fotos do <b>álbum</b>: data e GPS do EXIF, SHA-256 do arquivo original, criptografadas.</div>
    <div class="gap"></div><div class="btn pri ${nImp ? '' : 'dis'}" id="pb_ok">${nImp ? `Importar ${nImp} foto(s)` : 'Nenhuma foto atribuída'}</div>${credit()}`, d => {
    d.querySelector('#pb_x').onclick = exPanelClose;
    d.querySelector('#pb_sc').onchange = e => { P.scope = e.target.value; exPhotoMatch(P); exPhotoReview(P); };
    d.querySelector('#pb_capa').onclick = e => { P.capa = !P.capa; e.target.classList.toggle('on', P.capa); };
    d.querySelector('#pb_st').onclick = e => { P.stamp = !P.stamp; e.target.classList.toggle('on', P.stamp); };
    d.querySelectorAll('.exprow').forEach(el => { el.querySelector('.exps').onchange = e => { P.files[+el.dataset.i].sel = e.target.value; const n = P.files.filter(r => r.sel).length, b = d.querySelector('#pb_ok'); b.textContent = n ? `Importar ${n} foto(s)` : 'Nenhuma foto atribuída'; b.classList.toggle('dis', !n); }; });
    d.querySelector('#pb_ok').onclick = () => { if (!P.files.some(r => r.sel)) return toast('Escolha o alvo de pelo menos uma foto'); exPhotoSave(P); };
  });
}
async function exPhotoSave(P) {
  const rows = P.files.filter(r => r.sel && getAlvo(r.sel)); let ok = 0, fail = 0; const capaSet = new Set(), touched = new Map(); let stop = false;
  sheet(`<h2 style="margin-top:0">🖼️ Importando fotos…</h2><div class="sub" id="pbs_st">Preparando…</div><div class="prog"><i id="pbs_bar"></i></div><div class="btn" id="pbs_c" style="margin-top:12px">Parar</div>`, s => s.querySelector('#pbs_c').onclick = () => { stop = true; });
  for (let i = 0; i < rows.length && !stop; i++) {
    if (!KEY) return; resetIdle(); const r = rows[i], a = getAlvo(r.sel);
    const st = $('#pbs_st'), bar = $('#pbs_bar'); if (st) st.textContent = `${i + 1} de ${rows.length} · ${r.f.name}`; if (bar) bar.style.width = Math.round(i / rows.length * 100) + '%';
    try {
      const orig = await r.f.arrayBuffer(), ex = parseExif(orig), hash = await sha256(orig), bytes = await resizeJpeg(r.f), fid = uid(), now = Date.now();
      await putImg(fid, new Uint8Array(bytes));
      const f = {id: fid, ts: ex.ts || now, importado: now, dataExif: !!ex.ts, hash, hashTipo: 'original', legenda: '', origem: 'album', arquivo: r.f.name || '', lote: 'nome'};
      if (ex.lat != null) Object.assign(f, {lat: ex.lat, lng: ex.lng, acc: null}); if (ex.orientation) f.orient = ex.orientation;
      if (P.stamp) f.carimbo = await makeStamp(a, bytes, f.ts, f.lat != null ? f : null, ex.ts ? '' : ' (importação — foto sem data)');
      if (P.capa && !capaSet.has(a.id) && !(a.capa && (a.fotos || []).some(x => x.id === a.capa))) { a.capa = fid; capaSet.add(a.id); }
      a.fotos = a.fotos || []; a.fotos.push(f); touched.set(a.id, (touched.get(a.id) || 0) + 1); ok++;
    } catch (e) { console.warn('foto em lote', e); fail++; }
  }
  touched.forEach((n, id) => { const a = getAlvo(id); a.log = a.log || []; a.log.push({ts: Date.now(), t: `${n} foto(s) importada(s) em lote pelo nome do arquivo${capaSet.has(id) ? ' · capa definida' : ''}`}); });
  if (ok) await save(); closeSheet(); exPanelClose(); route();
  toast(`🖼️ ${ok} foto(s) em ${touched.size} alvo(s)${fail ? ` · ⚠️ ${fail} falha(s)` : ''}${stop ? ' · interrompido' : ''}`, 3500);
}

/* ---- 3) Leitura de documentos em lote (OCR sequencial, um único leitor) ---- */
let DOCQ = null;
function docBatchUI(opId) {
  if (!DOCQ || (opId && DOCQ.opId !== opId)) { if (DOCQ) DOCQ.files.forEach(x => URL.revokeObjectURL(x.url)); DOCQ = {opId: opId || '', files: []}; }
  const Q = DOCQ, n = Q.files.length;
  sheet(`<h2 style="margin-top:0">🪪 Ler documentos em lote</h2>
    <div class="sub" style="margin:0 4px 10px;line-height:1.45">Fotografe ou escolha várias imagens de <b>RG/CNH</b>. Cada uma é lida no aparelho (OCR, uma por vez) e vira um cartão para conferir — nome, CPF (com verificação), RG, nascimento e filiação. A imagem pode virar a 🪪 foto do documento do alvo.</div>
    ${n ? `<div class="thumbs" id="dq_th">${Q.files.map((x, i) => `<div class="th" data-i="${i}"><img src="${x.url}"><span class="g">✕</span></div>`).join('')}</div>` : '<div class="empty" style="padding:16px"><div>🪪</div>Nenhuma imagem na fila.</div>'}
    <div class="grid2" style="margin-top:12px"><div class="btn" id="dq_cam">📷 Fotografar</div><div class="btn" id="dq_alb">🖼️ Escolher várias</div></div>
    <div class="sub" style="margin:8px 4px 0">Boa luz, documento plano e sem reflexo. Toque numa miniatura para tirar da fila.</div>
    <div class="tgrow card glass" style="cursor:default;margin:12px 0 0"><div>🪪 Ler como CNH (modelo)<div class="sub">lê cada campo na posição da CNH — use fotos <b>recortadas no cartão</b>, de frente</div></div><div class="tg ${Q.cnh ? 'on' : ''}" id="dq_cnh"></div></div>
    <div class="gap"></div><div class="btn pri ${n ? '' : 'dis'}" id="dq_go">${n ? `Ler ${n} documento(s)` : 'Adicione imagens'}</div>`, s => {
    s.querySelectorAll('#dq_th .th').forEach(t => t.onclick = () => { const x = Q.files.splice(+t.dataset.i, 1)[0]; URL.revokeObjectURL(x.url); docBatchUI(Q.opId); });
    const add = fs => { fs.forEach(f => Q.files.push({f, url: URL.createObjectURL(f)})); docBatchUI(Q.opId); };
    s.querySelector('#dq_cam').onclick = () => { const inp = $('#cam'); inp.value = ''; hold(180000); inp.oncancel = () => release(); inp.onchange = () => { release(); const f = inp.files[0]; if (f) add([f]); }; inp.click(); };
    s.querySelector('#dq_alb').onclick = () => pickFile('image/*', fs => add(fs), true);
    s.querySelector('#dq_cnh').onclick = e => { Q.cnh = !Q.cnh; e.target.classList.toggle('on', Q.cnh); };
    s.querySelector('#dq_go').onclick = () => { if (!Q.files.length) return toast('Adicione imagens dos documentos'); const fs = Q.files.map(x => x.f); Q.files.forEach(x => URL.revokeObjectURL(x.url)); DOCQ = null; docBatchRun(fs, Q.opId, [], 0, !!Q.cnh); };
  });
}
async function docBatchRun(files, opId, cards = [], start = 0, cnhMode = false) {
  // Cancelar pausa a fila: dá para continuar de onde parou (mesmo leitor recriado) ou conferir o que já foi lido
  const n = files.length; let cancel = false, cancelRes, next = start; const cancelP = new Promise(r => cancelRes = r);
  sheet(`<h2 style="margin-top:0">🪪 Lendo documentos…</h2><div class="t" id="db_n" style="margin:0 4px">Documento ${start + 1} de ${n}</div><div class="sub" id="db_st" style="margin:4px 4px 0">Preparando…</div><div class="prog"><i id="db_bar" style="width:${Math.round(start / n * 100)}%"></i></div>
    <div class="sub" id="db_done" style="margin:6px 4px 0">${cards.length} lido(s) até agora</div>
    <div class="sub" style="margin-top:8px;line-height:1.4">🔒 Leitura no próprio aparelho, uma imagem por vez — nada é enviado. Na 1ª vez, o leitor (~6 MB) é carregado do endereço do app.</div><div class="btn" id="db_c" style="margin-top:12px">Cancelar</div>`, s => s.querySelector('#db_c').onclick = () => { cancel = true; cancelRes('cancel'); ocrStop(); });
  for (let i = start; i < n && !cancel; i++) {
    if (!KEY) return; resetIdle(); const file = files[i]; let li = null; next = i;
    const nEl = $('#db_n'), sEl = $('#db_st'); if (nEl) nEl.textContent = `Documento ${i + 1} de ${n}`; if (sEl) sEl.textContent = 'Preparando…';
    const prog = m => { if (cancel) return; const st = $('#db_st'), bar = $('#db_bar'); if (st) st.textContent = ocrStepTxt(m) + (m.status === 'recognizing text' ? ` ${Math.round((m.progress || 0) * 100)}%` : ''); if (bar) bar.style.width = Math.round(((i + (m.status === 'recognizing text' ? .3 + .7 * (m.progress || 0) : .3 * (m.progress || 0))) / n) * 100) + '%'; };
    try {
      li = await loadImg(file); if (cancel) break;
      if (cnhMode) { // v0.8: CNH por modelo (zonas) — a foto deve estar recortada no cartão
        const r = await Promise.race([cnhReadCanvas(canvasOf(li.img, 1800), m => prog(m)), cancelP]); if (r === 'cancel' || cancel || !r) break;
        const bytes = await resizeJpeg(file, 2000), c = cnhCardOf(r, bytes, new Blob([bytes], {type: 'image/jpeg'}), file.name || `cnh_${i + 1}.jpg`); c.img.hashOrig = await sha256(await file.arrayBuffer()); cards.push(c); next = i + 1;
        const dn0 = $('#db_done'); if (dn0) dn0.textContent = `${cards.length} lido(s) até agora`; continue;
      }
      const cv = ocrCanvas(li.img, null, 2000);
      let data = await Promise.race([runOcr(cv, {tessedit_pageseg_mode: '3'}, prog), cancelP]); if (data === 'cancel') break;
      let ex = extractDoc(data.text);
      if (!ex.nome && !ex.cpfs.length) { const d2 = await Promise.race([runOcr(cv, {tessedit_pageseg_mode: '11'}, prog), cancelP]); if (d2 === 'cancel') break; const e2 = extractDoc(d2.text); if (e2.nome || e2.cpfs.length) { data = d2; ex = e2; } }
      if (cancel) break;
      const orig = await file.arrayBuffer(), bytes = await resizeJpeg(file, 2000), best = ex.cpfs[0];
      cards.push(exCard({nome: ex.nome, cpf: best ? cpfFmt(best.d) : '', rg: ex.rg, nasc: ex.nasc, fil: ex.filiacao.join('\n'), inc: !!(ex.nome || (best && best.ok)), raw: data.text, keepImg: true,
        img: {bytes, url: exUrl(new Blob([bytes], {type: 'image/jpeg'})), name: file.name || `documento_${i + 1}.jpg`, hashOrig: await sha256(orig)}}));
      next = i + 1;
    } catch (e) { if (cancel) break; console.warn('doc lote', e); try { const bytes = await resizeJpeg(file, 2000); cards.push(exCard({inc: false, raw: '(falha na leitura: ' + e.message + ')', keepImg: true, img: {bytes, url: exUrl(new Blob([bytes], {type: 'image/jpeg'})), name: file.name || '', hashOrig: await sha256(await file.arrayBuffer())}})); } catch (e2) {} next = i + 1; }
    finally { if (li) URL.revokeObjectURL(li.u); }
    const dn = $('#db_done'); if (dn) dn.textContent = `${cards.length} lido(s) até agora`;
  }
  if (!KEY) return;
  if (cancel && next < n) { // pausado: continuar ou conferir
    const rest = n - next;
    return sheet(`<h2 style="margin-top:0">⏸️ Leitura pausada</h2><div class="sub" style="line-height:1.45">${cards.length} de ${n} documento(s) lido(s). Faltam <b>${rest}</b>.</div>
      <div class="btn pri" id="dp_go" style="margin-top:16px">▶️ Continuar a leitura (${rest} restante${rest > 1 ? 's' : ''})</div>
      <div class="btn ${cards.length ? '' : 'dis'}" id="dp_rev" style="margin-top:10px">Conferir os ${cards.length} lido(s)${rest ? ' e descartar o resto' : ''}</div>
      <div class="btn dan" id="dp_x" style="margin-top:10px">Descartar tudo</div>`, s => {
      s.querySelector('#dp_go').onclick = () => docBatchRun(files, opId, cards, next, cnhMode);
      s.querySelector('#dp_rev').onclick = () => { if (!cards.length) return toast('Nenhum documento lido ainda'); closeSheet(); EX_SEQ_PANEL++; exReview({mode: 'doc', cards, loose: [], src: {}, opId: exDefOp(opId), newOp: '', keepNote: false}); };
      s.querySelector('#dp_x').onclick = () => { closeSheet(); EX_URLS.forEach(u => URL.revokeObjectURL(u)); EX_URLS = []; toast('Leitura descartada'); };
    });
  }
  closeSheet();
  if (!cards.length) return toast('Nenhum documento pôde ser lido');
  EX_SEQ_PANEL++; exReview({mode: 'doc', cards, loose: [], src: {}, opId: exDefOp(opId), newOp: '', keepNote: false});
}
/* ============ v0.8 (parte A) — Formato ordenado com IA (leitura exata) e rótulos “Campo: valor” — by @aiforge.team ============ */
/* Formato ordenado: uma pessoa por linha (campos “CHAVE: valor” separados por |), ou um bloco de linhas “CHAVE: valor” por pessoa
   (separadas por linha em branco ou ---), ou uma lista JSON com as mesmas chaves. Leitura exata: nada é adivinhado. */
const AF_MAP = {nome: 'nome', 'nome completo': 'nome', qualificado: 'nome', qualificada: 'nome',
  vulgo: 'vulgo', vulgos: 'vulgo', alcunha: 'vulgo', apelido: 'vulgo', apelidos: 'vulgo',
  cpf: 'cpf', 'cpf/mf': 'cpf',
  rg: 'rg', identidade: 'rg', 'rg/orgao': 'rg', 'rg/orgao emissor': 'rg', 'documento de identidade': 'rg', 'doc identidade': 'rg', 'carteira de identidade': 'rg', 'registro geral': 'rg',
  'orgao emissor': 'rgorg', 'orgao expedidor': 'rgorg', emissor: 'rgorg', 'rg orgao': 'rgorg', 'rg uf': 'rgorg',
  nasc: 'nasc', nascimento: 'nasc', 'data de nascimento': 'nasc', 'data nascimento': 'nasc', 'data de nasc': 'nasc', 'data nasc': 'nasc', dn: 'nasc', 'nascido em': 'nasc', 'nascida em': 'nasc',
  mae: 'mae', 'nome da mae': 'mae', genitora: 'mae', pai: 'pai', 'nome do pai': 'pai', genitor: 'pai', filiacao: 'fil',
  endereco: 'end', enderecos: 'end', 'endereco residencial': 'end', residencia: 'end', domicilio: 'end',
  telefones: 'tel', telefone: 'tel', tel: 'tel', tels: 'tel', fone: 'tel', fones: 'tel', celular: 'tel', celulares: 'tel', whatsapp: 'tel', contato: 'tel', contatos: 'tel',
  veiculo: 'veic', veiculos: 'veic', placa: 'placa', placas: 'placa',
  redes: 'redes', 'redes sociais': 'redes', 'rede social': 'redes', instagram: 'rede:Instagram', facebook: 'rede:Facebook', tiktok: 'rede:TikTok', 'e-mail': 'rede:E-mail', email: 'rede:E-mail',
  obs: 'obs', observacao: 'obs', observacoes: 'obs',
  naturalidade: 'nat', 'natural de': 'nat', profissao: 'prof', ocupacao: 'prof', papel: 'papel'};
const afKeyNorm = k => _norm(k).replace(/\*+/g, '').replace(/\.(?=\S)/g, '').replace(/\.$/, '').replace(/\s*\/\s*/g, '/').replace(/[\s_]+/g, ' ').trim();
const AF_NA = /^(?:-+|—+|\?+|n\/?[ad]|nao (?:consta|informad[oa]|declarad[oa]|identificad[oa]|possui|ha|tem)|ignorad[oa]|desconhecid[oa]|sem informac(?:ao|oes)|nenhum[a]?|null|undefined|vazio)\.?$/;
const afNA = v => AF_NA.test(_norm(v).replace(/\s+/g, ' '));
/* “CHAVE: valor” (aceita marcador de lista, **negrito** do markdown e aspas) → {f, k, v} ou null */
function afSeg(s) {
  const m = String(s).match(/^\s*(?:[-*•]\s+|\d{1,2}[.)]\s+)?\**\s*([A-Za-zÀ-ÿ][A-Za-zÀ-ÿ .\/_-]{0,32}?)\s*\**\s*:\s*\**\s*(.*?)\s*\**\s*$/);
  if (!m) return null; const f = AF_MAP[afKeyNorm(m[1])]; if (!f) return null;
  return {f, k: m[1].replace(/\*/g, '').trim(), v: m[2].replace(/^["“']|["”']$/g, '').trim()};
}
const AF_INLINE = /[,;]\s*(?:nome|cpf|rg|vulgo|alcunha|telefone|celular|endere[çc]o|m[ãa]e|pai|nascimento|placa|ve[íi]culo)\s*:/i;
const afIsSep = l => /^\s*(?:-{3,}|_{3,}|\*{3,}|={3,}|#{1,6}\s.*|`{3}.*|\**\s*(?:pessoa|indiv[íi]duo|envolvid[oa]|alvo|registro)\s*(?:n[º°o.]*\s*)?\d{0,3}\s*\**\s*:?\s*\**|\d{1,3}\s*[.)º°]?)\s*$/i.test(l); // separadores e cabeçalhos “Pessoa 1:”
/* classifica a linha: {segs} se for linha do formato (1ª parte com chave conhecida e a maioria das partes com chave) */
function afLine(line) {
  const parts = line.split('|').map(x => x.trim()).filter(Boolean); if (!parts.length) return null;
  const segs = parts.map(afSeg); if (!segs[0] || segs.filter(Boolean).length * 2 < parts.length) return null;
  if (parts.length === 1 && AF_INLINE.test(segs[0].v)) return null; // “Nome: X, CPF: Y” = texto semiestruturado → extração por rótulos
  const out = []; parts.forEach((p, i) => { if (segs[i]) out.push(segs[i]); else out[out.length - 1].v += '; ' + p; });
  return out;
}
function afStripFences(t) { return String(t || '').replace(/^\s*```[a-z]*\s*\n?/i, '').replace(/\n?\s*```\s*$/, '').trim(); }
/* detecção rápida (também usada para o selo ao colar) → null ou {kind, persons:[[{f,k,v}]], ignored} */
function afDetect(text) {
  const T = exClean(text).trim(); if (!T) return null;
  if (/^nenhuma pessoa\.?$/i.test(T)) return {kind: 'none', persons: [], ignored: 0};
  const J = afStripFences(T);
  if (/^[\[{]/.test(J)) { try { const r = afJson(JSON.parse(J)); if (r) return r; } catch (e) { /* não é JSON válido: segue como texto */ } }
  const lines = T.split('\n'); let keyL = 0, other = 0, nomes = 0, multi = 0, inline = 0;
  const parsed = lines.map(l => { if (!l.trim() || afIsSep(l)) return 'sep'; const s = afLine(l); if (s) { keyL++; if (s.length > 1) multi++; nomes += s.filter(x => x.f === 'nome').length; } else { other++; if (AF_INLINE.test(l)) inline++; } return s; });
  // linhas com | : a maioria das linhas no formato; blocos “CAMPO: valor”: quase tudo no formato (até 2 linhas soltas, ex.: “Aqui estão os dados:”)
  // texto com rótulos no meio de frases (“Nome: X, CPF: Y”) fica com a extração por rótulos, que entende prosa
  if (!nomes || inline) return null;
  if (multi ? keyL < (keyL + other) * .6 : keyL < 2 || other > Math.max(2, Math.floor(keyL * .1))) return null;
  const persons = []; let cur = null, last = null, ignored = 0;
  const flush = () => { if (cur && cur.length) persons.push(cur); cur = null; last = null; };
  parsed.forEach((s, i) => {
    if (s === 'sep') return flush();
    if (s) {
      if (s.length > 1) { flush(); persons.push(s); return; }
      const x = s[0]; if (!cur) cur = []; if (x.f === 'nome' && cur.some(y => y.f === 'nome')) { flush(); cur = []; }
      cur.push(x); last = x; return;
    }
    const l = lines[i].trim();
    if (cur && last) { if (/^[^:]{2,30}:\s*\S/.test(l)) cur.push({f: 'obs', k: '', v: l}); else last.v += (last.f === 'obs' || last.f === 'end' ? ' ' : '; ') + l; }
    else ignored++;
  });
  flush();
  return {kind: multi ? 'linhas' : 'blocos', persons, ignored};
}
function afJson(j) {
  let arr = Array.isArray(j) ? j : j && typeof j === 'object' ? (Object.values(j).find(Array.isArray) || [j]) : null;
  if (!arr || !arr.length || !arr.every(o => o && typeof o === 'object' && !Array.isArray(o))) return null;
  const val = v => Array.isArray(v) ? v.map(val).filter(Boolean).join('; ') : v && typeof v === 'object' ? Object.entries(v).map(([a, b]) => a + ': ' + val(b)).join('; ') : v == null ? '' : String(v);
  const persons = arr.map(o => Object.entries(o).map(([k, v]) => { const f = AF_MAP[afKeyNorm(k)]; return f ? {f, k, v: val(v).trim()} : {f: 'obs', k: '', v: k + ': ' + val(v)}; }));
  if (!persons.some(p => p.some(x => x.f === 'nome'))) return null;
  return {kind: 'JSON', persons, ignored: 0};
}
const AF_MES = {jan: 1, fev: 2, mar: 3, abr: 4, mai: 5, jun: 6, jul: 7, ago: 8, set: 9, out: 10, nov: 11, dez: 12};
function exDateISO(s) { // dd/mm/aaaa, dd.mm.aa, aaaa-mm-dd, “12 de março de 1990” → aaaa-mm-dd ou ''
  const t = _norm(s); let d, mo, y, m;
  if ((m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/))) [y, mo, d] = [m[1], +m[2], +m[3]];
  else if ((m = t.match(/(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{2}|\d{4})(?!\d)/))) [d, mo, y] = [+m[1], +m[2], m[3]];
  else if ((m = t.match(/(\d{1,2})\s*(?:º|o)?\s+de\s+([a-zç]{3})[a-zç]*\s+de\s+(\d{4})/))) [d, mo, y] = [+m[1], AF_MES[m[2]], m[3]];
  else return '';
  if (String(y).length === 2) y = (+y > new Date().getFullYear() % 100 ? '19' : '20') + y;
  const ok = mo >= 1 && mo <= 12 && d >= 1 && d <= new Date(+y, mo, 0).getDate() && +y >= 1900 && +y <= new Date().getFullYear();
  return ok ? `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}` : '';
}
const exNameFix = s => { const v = String(s || '').replace(/[^A-Za-zÀ-ÿ' \-]+/g, ' ').replace(/\s+/g, ' ').trim(); return v && (v === v.toUpperCase() || v === v.toLowerCase()) ? titleName(v) : v; };
const exPlateClean = p => { const s = String(p).toUpperCase().replace(/[^A-Z0-9]/g, ''); return /^[A-Z]{3}\d[A-Z0-9]\d{2}$/.test(s) ? plateFmt(s) : String(p).trim(); };
const exTelClean = t => { const d = exPhoneDigits(t); return d ? exPhoneFmt(d) : String(t).trim(); };
const AF_UNC = /\(\s*(?:incert[oa]|duvidos[oa]|ileg[íi]vel|\?)\s*\)|\?{1,3}$/i;
/* uma pessoa do formato → cartão de conferência (mesmo cartão da extração v0.7) */
function afCard(pairs, loose) {
  const c = exCard({lab: true, exact: true}), obs = [], veics = [], plates = [], fil = {mae: [], pai: [], fil: []}; let rgorg = '';
  for (const p of pairs) {
    let v = String(p.v || '').replace(/\s+/g, ' ').trim(); if (!v || afNA(v)) continue;
    if (p.f !== 'obs' && AF_UNC.test(v)) { c.incerto = true; obs.push(`⚠️ ${p.k || p.f} com leitura incerta: ${v}`); v = v.replace(AF_UNC, '').trim(); if (!v || /[?]/.test(v)) continue; }
    const list = s => s.split(/\s*;\s*|\n/).map(x => x.trim()).filter(x => x && !afNA(x));
    switch (p.f.split(':')[0]) {
      case 'nome': exPut(c, exItem('nome', exNameFix(v)), loose); break;
      case 'vulgo': exPut(c, exItem('vulgo', v.replace(/^["“']|["”']$/g, '')), loose); break;
      case 'cpf': { const d = _digits(v), ok = d.length === 11 && cpfValid(d); exPut(c, exItem('cpf', d.length === 11 ? cpfFmt(d) : v, ok), loose); if (!ok) c.cpfWarn = true; break; }
      case 'rg': exPut(c, exItem('rg', v.replace(/\s*-\s*(?=[A-Z]{2,8}\b)/, ' ').replace(/\b([A-Z]{2,8})\s*[-\s]\s*([A-Z]{2})$/, '$1/$2')), loose); break;
      case 'rgorg': rgorg = v.toUpperCase().replace(/\s*[-\s]\s*/g, '/'); break;
      case 'nasc': { const iso = exDateISO(v); if (iso) exPut(c, exItem('nasc', iso), loose); else obs.push('Nascimento (não reconhecido): ' + v); break; }
      case 'mae': case 'pai': fil[p.f].push(exNameFix(v)); break;
      case 'fil': fil.fil.push(...v.split(/\s*[\/;]\s*/).map(exNameFix).filter(Boolean)); break;
      case 'end': list(v).forEach(x => exPut(c, exItem('end', x), loose)); break;
      case 'tel': v.split(/\s*[;,\/]\s*|\s+e\s+|\s+ou\s+/).map(x => x.trim()).filter(x => _digits(x).length >= 8).forEach(x => exPut(c, exItem('tel', exTelClean(x)), loose)); break;
      case 'veic': veics.push(...list(v)); break;
      case 'placa': plates.push(...v.split(/\s*[;,\/]\s*|\s+e\s+/).map(x => x.trim()).filter(Boolean)); break;
      case 'redes': c.redes = [c.redes, ...list(v)].filter(Boolean).join('\n'); break;
      case 'rede': c.redes = [c.redes, p.f.split(':')[1] + ': ' + v].filter(Boolean).join('\n'); break;
      case 'nat': obs.push('Naturalidade: ' + v); break;
      case 'prof': obs.push('Profissão: ' + v); break;
      case 'papel': c.papel = _norm(v) === 'vitima' ? 'vítima' : v.toLowerCase(); break;
      default: obs.push(v);
    }
  }
  if (rgorg) { if (c.rg && !/[A-Za-z]/.test(c.rg)) c.rg += ' ' + rgorg; else if (!c.rg) obs.push('Órgão emissor do RG: ' + rgorg); }
  const fl = [...fil.mae, ...fil.pai, ...fil.fil].filter(Boolean); if (fl.length) exPut(c, exItem('fil', fl.join('\n')), loose);
  // placa(s) + veículo(s): um veículo e uma placa viram “Fiat Uno prata ABC1D23”; o resto fica em itens separados
  const pl = plates.map(exPlateClean), vs = veics.slice();
  if (vs.length === 1 && pl.length >= 1 && !platesIn(vs[0]).length) { exPut(c, exItem('veic', vs[0] + ' ' + pl[0]), loose); pl.slice(1).forEach(x => exPut(c, exItem('veic', x), loose)); }
  else { vs.forEach(x => exPut(c, exItem('veic', x), loose)); pl.forEach(x => { if (!c.veics.some(y => platesIn(y)[0] && platesIn(y)[0] === platesIn(x)[0])) exPut(c, exItem('veic', x), loose); }); }
  c.obs = [c.obs, ...obs].filter(Boolean).join('\n'); if (/incert/i.test(c.obs)) c.incerto = true;
  c.inc = true; return c;
}
function afParse(text) {
  const d = afDetect(text); if (!d) return null; const loose = [];
  return {cards: d.persons.map(p => afCard(p, loose)), loose, text: exClean(text), exact: {kind: d.kind, n: d.persons.length, ignored: d.ignored}};
}

/* instrução para colar numa IA (o app não envia nada: o usuário copia e decide onde usar) */
const AF_PROMPT = `Você vai extrair dados de pessoas para um cadastro. Leia com atenção o material que estou enviando (texto colado, foto de documento como RG ou CNH, print ou PDF) e liste TODAS as pessoas mencionadas.

REGRAS
1. Responda SOMENTE com as linhas no formato abaixo. Não escreva introdução, comentário, explicação, tabela, markdown nem bloco de código.
2. Uma pessoa por linha. Os campos são separados por " | " e cada campo é escrito como CHAVE: valor.
3. Use somente estas chaves, nesta ordem: NOME | VULGO | CPF | RG | NASC | MÃE | PAI | NATURALIDADE | PROFISSÃO | ENDEREÇO | TELEFONES | VEÍCULO | PLACA | REDES | PAPEL | OBS
4. NUNCA invente, complete ou deduza dados. Se uma informação não aparece no material, omita a chave inteira (não escreva "não informado", "N/D" nem deixe a chave vazia).
5. Padronize assim:
   - NOME: nome completo, sem abreviar e sem títulos (Sr., Dr.).
   - CPF: 000.000.000-00. Copie os números exatamente como estão, mesmo que pareçam inválidos.
   - RG: número seguido do órgão emissor e UF, se houver (ex.: 2004010123456 SSP/CE).
   - NASC: dd/mm/aaaa.
   - MÃE e PAI: nomes completos da filiação.
   - TELEFONES: (DD) 90000-0000; vários separados por "; ".
   - VEÍCULO: marca, modelo e cor (ex.: Fiat Uno prata).
   - PLACA: ABC1D23 (Mercosul) ou ABC-1234 (antiga); várias separadas por "; ".
   - ENDEREÇO: logradouro, número, complemento, bairro, cidade/UF; vários separados por "; ".
   - REDES: perfis ou links (ex.: Instagram @perfil); vários separados por "; ".
   - PAPEL: autor, vítima, testemunha, conduzido, suspeito ou investigado, só quando o material disser.
6. Se uma leitura estiver duvidosa (foto ruim, letra ilegível, número cortado), NÃO coloque no campo próprio: escreva em OBS seguida de "(incerto)". Exemplo: OBS: CPF 123.456.789-0? (incerto)
7. Outras informações úteis sobre a pessoa (tatuagens, sinais, local de trabalho, facção, antecedentes citados) vão em OBS, de forma curta.
8. Não use o caractere "|" dentro dos valores.
9. Se o material for foto de documento, leia todos os campos visíveis do documento.
10. Se não houver nenhuma pessoa no material, responda apenas: NENHUMA PESSOA

EXEMPLO DE RESPOSTA
NOME: João Carlos da Silva | VULGO: Jota | CPF: 529.982.247-25 | RG: 2004010123456 SSP/CE | NASC: 15/03/1990 | MÃE: Maria Aparecida da Silva | PAI: José Carlos da Silva | ENDEREÇO: Rua das Flores, 123, Centro, Fortaleza/CE | TELEFONES: (85) 98877-6655; (85) 3222-1100 | VEÍCULO: Fiat Uno prata | PLACA: ABC1D23 | REDES: Instagram @jota_ce | PAPEL: investigado | OBS: tatuagem de carpa no braço direito
NOME: Ana Paula Ferreira | NASC: 02/11/1995 | TELEFONES: (85) 99911-2233 | OBS: CPF 123.456.789-0? (incerto)

MATERIAL:
`;
async function copyText(t) {
  try { if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(t); return true; } } catch (e) { /* cai no método antigo */ }
  const ta = document.createElement('textarea'); ta.value = t; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
  document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, t.length); let ok = false; try { ok = document.execCommand('copy'); } catch (e) {} ta.remove(); return ok;
}
const afBadge = d => d && d.kind === 'cnh' ? `<div class="exok">🪪 <b>CNH digital reconhecida</b><div class="sub">campos lidos pela posição dos rótulos no PDF (camada de texto) — leitura exata</div></div>` : d ? (d.kind === 'none' ? `<div class="exok none">🤖 A resposta diz <b>NENHUMA PESSOA</b> — não há o que importar.</div>` : `<div class="exok">✅ <b>Formato ordenado reconhecido — leitura exata</b><div class="sub">${d.persons.length} pessoa(s) · ${({linhas: 'uma por linha', blocos: 'blocos CAMPO: valor', JSON: 'JSON'})[d.kind] || d.kind}${d.ignored ? ` · ${d.ignored} linha(s) fora do formato ignorada(s)` : ''}</div></div>`) : '';

/* ---- rótulos “Campo: valor” (relatórios/ofícios), em qualquer ordem, inline ou um por linha ---- */
const EXL_UF = 'AC AL AP AM BA CE DF ES GO MA MT MS MG PA PB PR PE PI RJ RN RS RO RR SC SP SE TO'.split(' ');
const EXL_DEFS = [ // ordem importa: rótulos mais longos/específicos antes
  ['mae', 'nome\\s+da\\s+m[ãa]e|m[ãa]e|genitora'], ['pai', 'nome\\s+do\\s+pai|pai|genitor'], ['fil', 'filia[çc][ãa]o'],
  ['rgorg', '[óo]rg[ãa]o\\s+(?:emissor|expedidor)|emissor|expedidor'],
  ['nasc', 'data\\s+de\\s+nascimento|data\\s+(?:de\\s+)?nasc\\.?|nascimento|nascid[oa]\\s+em|nasc\\.?|d\\.?\\s?n\\.?'],
  ['nome', 'nome\\s+completo|nome|qualificad[oa]|qualifica[çc][ãa]o'],
  ['role', 'autor[a]?|v[ií]tima|testemunha|conduzid[oa]|suspeit[oa]|investigad[oa]|envolvid[oa]|abordad[oa]|preso|presa'],
  ['vulgo', 'vulgo|alcunha|apelido|conhecid[oa]\\s+(?:como|por)'],
  ['cpf', 'c\\.?\\s?p\\.?\\s?f\\.?(?:\\s*\\/\\s*mf)?'],
  ['rg', 'doc(?:umento)?\\.?\\s+(?:de\\s+)?identidade|c[ée]dula\\s+de\\s+identidade|carteira\\s+de\\s+identidade|registro\\s+geral|identidade|r\\.?\\s?g\\.?'],
  ['end', 'endere[çc]o(?:\\s+residencial)?|resid[êe]ncia|residente(?:\\s+e\\s+domiciliad[oa])?|domic[íi]lio|domiciliad[oa]'],
  ['tel', 'telefones?|tel\\.?|fones?|celular(?:es)?|cel\\.?|contatos?|whats(?:app)?|zap'],
  ['placa', 'placas?'], ['veic', 've[íi]culos?|carro|moto(?:cicleta)?'],
  ['nat', 'naturalidade|natural\\s+de'], ['prof', 'profiss[ãa]o|ocupa[çc][ãa]o'],
  ['rede', 'redes?\\s+sociais|redes|instagram|facebook|e-?mail']];
const EXL_RE = new RegExp(`(^|[\\n,;|(•]|\\s[-–]\\s|\\.\\s)[ \\t]*(?:\\d{1,2}[.)º°]?[ \\t]*[-–]?[ \\t]*)?(?:${EXL_DEFS.map(([, s]) => `(${s})`).join('|')})(?:[ \\t]*\\d{1,2})?[ \\t]*(?:n[º°o.]+[ \\t]*)?:[ \\t]*`, 'gim');
const EXL_NEXT = new RegExp(`(?:[,;.]|\\s[-–])?\\s*\\b(?:${EXL_DEFS.map(([, s]) => s).join('|')})(?:[ \\t]*\\d{1,2})?[ \\t]*(?:n[º°o.]+[ \\t]*)?:`, 'i');
const EX_ABBR = new Set('av r rua trav tv al rod pca pc est n no nº apto ap bl qd q lt cj conj res sr sra dr dra prof profa sto sta s km cond ed jd jdm vl pq fl fls dist mun br'.split(' '));
/* fim do valor rotulado: quebra de linha, ; ou |, próximo “Rótulo:”, fim de frase (sem cortar “Av. Bezerra”); nomes param também na vírgula */
function exlCut(s, f) {
  let k = s.length; const hit = i => { if (i >= 0 && i < k) k = i; };
  hit(s.search(/\n|;|\|/)); const nx = s.match(EXL_NEXT); if (nx) hit(nx.index);
  const re = /(\S+)\.\s+(?=[A-ZÀ-Ú])/g; let m; while ((m = re.exec(s)) && m.index < k) { if (!EX_ABBR.has(_norm(m[1]).replace(/[^a-z0-9º]/g, '')) && !/^[A-Z]$/.test(m[1])) { hit(m.index + m[1].length); break; } }
  if (f === 'nome' || f === 'role' || f === 'mae' || f === 'pai' || f === 'vulgo' || f === 'nat' || f === 'prof') hit(s.search(/[,(]|\s[-–]\s|\b(?:brasileir[oa]|solteir[oa]|casad[oa]|divorciad[oa]|vi[úu]v[oa]|portador[a]?|inscrit[oa]|nascid[oa]|natural|residente|filh[oa]\s+de|vulgo|cpf|rg)\b/i));
  if (f === 'nasc') { const m2 = s.match(/^[^\n]*?\b(?:\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{2,4}|\d{1,2}\s*(?:º\s*)?de\s+[a-zç]+\s+de\s+\d{4}|\d{4}-\d{2}-\d{2})/i); hit(m2 ? m2[0].length : 0); }
  return Math.max(0, Math.min(k, 260));
}
/* passa pelo texto achando “Rótulo: valor”; devolve entidades {k, v, i, lab:true}, âncoras de nome rotuladas e os trechos a mascarar */
function exLabeled(T) {
  const ents = [], anchors = [], spans = []; EXL_RE.lastIndex = 0; let m;
  while ((m = EXL_RE.exec(T))) {
    const gi = m.slice(2).findIndex(x => x !== undefined); if (gi < 0) continue; const f = EXL_DEFS[gi][0], lab = m[gi + 2];
    const vs = m.index + m[0].length, raw = T.slice(vs, vs + 300), k = exlCut(raw, f); let v = raw.slice(0, k).replace(/[\s,.;:\-–]+$/, '').replace(/\s+/g, ' ').trim();
    const i0 = m.index + m[1].length; let used = k; EXL_RE.lastIndex = vs + k;
    if (!v || afNA(v)) { spans.push([i0, vs + k]); continue; }
    const put = (kk, vv, extra) => ents.push(Object.assign({k: kk, v: vv, i: i0, lab: true}, extra || {}));
    const upto = n => { used = Math.min(k, raw.slice(0, k).length - raw.slice(0, k).trimStart().length + n); EXL_RE.lastIndex = vs + used; }; // só o trecho realmente usado é mascarado
    if (f === 'nome' || f === 'role') { const nm = exNameFix(v); if (nm.replace(/[^A-Za-zÀ-ÿ]/g, '').length < 3 || EX_STOP.has(exUp(nm.split(' ')[0])) && nm.split(' ').length < 2) continue;
      const role = f === 'role' ? ((EX_ROLE.find(([, re]) => re.test(lab)) || [])[0] || (/pres[oa]|abordad/i.test(lab) ? 'conduzido' : '')) : ''; anchors.push({i: i0, nome: nm, lab: true, fl: true, role}); }
    else if (f === 'vulgo') put('vulgo', v.replace(/^["“'‘«]|["”'’»]$/g, ''));
    else if (f === 'cpf') { const nm = v.match(/^\d[\d.\s\-\/]*\d/); if (!nm) continue; const d = _digits(nm[0]); if (d.length < 9 || d.length > 11) continue; put('cpf', d.length === 11 ? cpfFmt(d) : nm[0], {ok: d.length === 11 && cpfValid(d)}); upto(nm[0].length); }
    else if (f === 'rg') { const n = v.match(/^((?:\d[\d.\s]*\d|\d)(?:\s?-\s?[\dXx])?)/); if (!n) continue; const rest = v.slice(n[0].length);
      const o = rest.match(/^[\s,\-–\/(]*([A-Z]{2,8})(?:\s*[-\/\s]\s*([A-Z]{2}))?\b\)?/); let org = o && (o[1] !== 'UF' || o[2]) ? (o[2] && EXL_UF.includes(o[2]) ? o[1] + '/' + o[2] : o[1]) : '';
      if (org && EXL_UF.includes(org) && !o[2]) org = ''; put('rg', n[1].replace(/\s/g, '') + (org ? ' ' + org : '')); upto(n[0].length + (org ? o[0].length : 0)); }
    else if (f === 'rgorg') { const o = v.match(/^([A-Z]{2,8})(?:\s*[-\/\s]\s*([A-Z]{2}))?/i); if (!o) continue; put('rgorg', o[1].toUpperCase() + (o[2] ? '/' + o[2].toUpperCase() : '')); upto(o[0].length); }
    else if (f === 'nasc') { const iso = exDateISO(v); if (iso) put('nasc', iso); }
    else if (f === 'mae' || f === 'pai') { const nm = exNameFix(v); if (nm.split(' ').length >= 2) put('fil', nm, {fo: f}); }
    else if (f === 'fil') { const st = v.search(/,?\s*\b(?:brasileir[oa]|solteir[oa]|casad[oa]|divorciad[oa]|portador[a]?|inscrit[oa]|nascid[oa]|natural|residente|domiciliad[oa]|cpf|rg|vulgo)\b/i), vv = st > 0 ? v.slice(0, st) : v; if (st > 0) upto(st);
      const ps = vv.split(/\s+e\s+|\s*[\/;,]\s*/).map(exNameFix).filter(x => x.split(' ').length >= 2); if (ps.length) put('fil', ps.join('\n')); }
    else if (f === 'end') put('end', v.replace(/^(?:n[ao]|em|à|a)\s+/i, ''));
    else if (f === 'tel') { const re = /\+?\(?\d[\d\s().\-]{6,22}\d/g; let t, any = false, end = 0; while ((t = re.exec(v))) { const d = exPhoneDigits(t[0]); if (d) { put('tel', exPhoneFmt(d)); any = true; end = t.index + t[0].length; } } if (!any) continue; upto(end); }
    else if (f === 'placa' || f === 'veic') { const ps = platesIn(v), desc = v.replace(/\b[A-Za-z]{3}[\s.-]?\d[A-Za-z0-9]\d{2}\b/g, ' ').replace(/\b(?:de\s+)?placas?\b\s*(?:n[º°o.]*)?\s*:?/gi, ' ').replace(/[\s,;:\-–]+$/, '').replace(/\s+/g, ' ').trim();
      if (ps.length) ps.forEach((p, n) => { const raw2 = (v.match(new RegExp(p.slice(0, 3) + '[\\s.-]?' + p[3] + '[A-Z0-9]' + p.slice(5), 'i')) || [p])[0].toUpperCase().replace(/[^A-Z0-9]/g, ''); put('veic', (n === 0 && f === 'veic' && desc ? desc + ' ' : '') + plateFmt(raw2)); });
      else if (f === 'veic' && desc.length >= 3) put('veic', desc); else continue; }
    else if (f === 'nat') put('nat', v); else if (f === 'prof') put('prof', v);
    else if (f === 'rede') put('rede', (/^(?:redes?)/i.test(lab) ? '' : lab.charAt(0).toUpperCase() + lab.slice(1).toLowerCase() + ': ') + v);
    spans.push([i0, vs + used]);
  }
  return {ents, anchors, spans};
}

/* ============ v0.8 (parte B) — Leitura de CNH por modelo (moldura) e CNH digital em PDF — by @aiforge.team ============ */
/* ATENÇÃO: o CONTRAN (Res. 718/2017 e 886/2021) publica os campos e a ordem do anverso, mas NÃO as coordenadas.
   As zonas abaixo são uma ESTIMATIVA ajustável (percentuais). Se a leitura por zona ficar fraca, cai para OCR da
   página inteira + extrator “Campo: valor”. Tudo roda no aparelho; nada é enviado. */
const CNH_WL_NAME = 'ABCDEFGHIJKLMNOPQRSTUVWXYZÁÀÂÃÇÉÊÍÓÔÕÚÜ ', CNH_WL_NUM = '0123456789./- ', CNH_WL_RG = '0123456789./-X ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const CNH_TEMPLATES = [{
  id: 'fisica', label: 'CNH cartão (anverso)', ratio: 1.585, pad: {x: .012, y: .015},
  // zonas do VALOR (o rótulo impresso fica acima/fora da zona). x,y,w,h em fração do cartão recortado
  zones: {
    nome:   {x: .300, y: .140, w: .685, h: .095, wl: CNH_WL_NAME, psm: '7', type: 'name'},
    doc:    {x: .300, y: .275, w: .290, h: .080, wl: CNH_WL_RG,   psm: '7', type: 'rg'},
    cpf:    {x: .590, y: .275, w: .200, h: .080, wl: CNH_WL_NUM,  psm: '7', type: 'cpf'},
    nasc:   {x: .790, y: .275, w: .200, h: .080, wl: CNH_WL_NUM,  psm: '7', type: 'date'},
    fil:    {x: .300, y: .405, w: .685, h: .255, wl: CNH_WL_NAME, psm: '6', type: 'fil'},
    registro:{x: .015, y: .760, w: .300, h: .090, wl: CNH_WL_NUM, psm: '7', type: 'num'},
    validade:{x: .320, y: .760, w: .235, h: .090, wl: CNH_WL_NUM, psm: '7', type: 'date'},
    cat:    {x: .800, y: .760, w: .190, h: .090, wl: 'ABCDE ',    psm: '7', type: 'cat'}
  }
}];
function canvasOf(img, maxSide = 1800) { // imagem → canvas simples (cores), para recortar zonas
  const k = Math.min(1, maxSide / Math.max(img.naturalWidth || img.width, img.naturalHeight || img.height));
  const c = document.createElement('canvas'); c.width = Math.round((img.naturalWidth || img.width) * k); c.height = Math.round((img.naturalHeight || img.height) * k);
  const x = c.getContext('2d'); x.imageSmoothingQuality = 'high'; x.drawImage(img, 0, 0, c.width, c.height); return c;
}
const cnhStripLabels = s => String(s || '').replace(/\b(?:NOME|SOBRENOME|DOC|DOCUMENTO|IDENTIDADE|ORG|[ÓO]RG[ÃA]O|EMISSOR|EXPEDIDOR|UF|CPF|DATA|NASCIMENTO|NASC|FILIA[ÇC][ÃA]O|PAI|M[ÃA]E|REGISTRO|N[º°O]|VALIDADE|CATEGORIA|CAT|HAB|HABILITA[ÇC][ÃA]O|LOCAL|PERMISS[ÃA]O|RENACH|ASSINATURA|PORTADOR)\b/gi, ' ').replace(/\s+/g, ' ').trim();
const cnhClean = s => cnhStripLabels(s).replace(/[|_]/g, ' ').replace(/\s+/g, ' ').trim();
async function cnhZoneRead(cv, z, onProg) {
  const P = CNH_TEMPLATES[0].pad || {x: 0, y: 0}, w = cv.width, h = cv.height; // folga: tolera cantos ajustados com pequeno erro
  const x0 = Math.max(0, (z.x - P.x) * w), y0 = Math.max(0, (z.y - P.y) * h), r = {x: x0, y: y0, w: Math.min(w - x0, (z.w + 2 * P.x) * w), h: Math.min(h - y0, (z.h + 2 * P.y) * h)};
  const zc = ocrCanvas(cv, r, 1600, 150); // upscale: zonas pequenas rendem mais com altura mínima
  const data = await runOcr(zc, {tessedit_char_whitelist: z.wl, tessedit_pageseg_mode: z.psm}, onProg);
  return {text: (data.text || '').trim(), conf: Math.max(0, Math.round(data.confidence || 0))};
}
/* lê um cartão de CNH já recortado/endireitado: zona a zona, com reserva de página inteira */
async function cnhReadCanvas(cv, onProg) {
  const tpl = CNH_TEMPLATES[0], ex = {nome: '', cpfs: [], rg: '', nasc: '', filiacao: [], registro: '', validade: '', cat: '', cnh: true}, conf = {}, rawParts = [];
  let i = 0; const zkeys = Object.keys(tpl.zones);
  for (const key of zkeys) {
    if (!KEY) return null; const z = tpl.zones[key];
    const {text, conf: c} = await cnhZoneRead(cv, z, m => onProg && onProg(m, i / zkeys.length)); i++;
    rawParts.push(`[${key}] ${text}`);
    if (z.type === 'name') { const n = nameLine(cnhClean(text)); if (n) { ex.nome = titleName(n); conf.nome = c; } }
    else if (z.type === 'cpf') { const f = findCPFs(text); if (f.length) { ex.cpfs = f; conf.cpf = c; } }
    else if (z.type === 'date') { const d = findDates(text); if (d.length) { ex[key === 'nasc' ? 'nasc' : 'validade'] = d[0].iso; conf[key] = c; } }
    else if (z.type === 'rg') { const d = cnhClean(text), num = (d.match(/\d[\d.\-\/]{3,}[\dX]?/i) || [''])[0].replace(/\s/g, ''); const om = d.toUpperCase().match(/\b(SSPDS|SSP|SDS|DETRAN|PCCE|PC|IFP|SESP|SEJUSP|DGPC|SJS|SESDEC|SSPDC)\s*[-\/]?\s*(AC|AL|AP|AM|BA|CE|DF|ES|GO|MA|MT|MS|MG|PA|PB|PR|PE|PI|RJ|RN|RS|RO|RR|SC|SP|SE|TO)?\b/), org = om ? om[1] + (om[2] ? '/' + om[2] : '') : ''; if (num) { ex.rg = num + (org ? ' ' + org.toUpperCase() : ''); conf.rg = c; } }
    else if (z.type === 'fil') { const ps = text.split(/\n+|\s{3,}/).map(cnhClean).map(x => x.replace(/[^A-Za-zÀ-ÿ' ]+/g, ' ').replace(/\s+/g, ' ').trim()).filter(x => x.split(' ').filter(w => w.length >= 2).length >= 2).map(titleName); if (ps.length) { ex.filiacao = ps.slice(0, 2); conf.fil = c; } }
    else if (z.type === 'num') { const n = (cnhClean(text).match(/\d[\d.\-\/]{6,}\d/) || [''])[0].replace(/\D/g, ''); if (n) { ex.registro = n; conf.registro = c; } }
    else if (z.type === 'cat') { const g = (text.toUpperCase().match(/\b[A-E]{1,5}\b/) || [''])[0]; if (g) { ex.cat = g; conf.cat = c; } }
  }
  // reserva: se os campos-chave vieram fracos, OCR da página inteira + extrator por rótulos
  const low = k => conf[k] == null || conf[k] < (k === 'nome' ? 80 : 70) || (k === 'nome' && (ex.nome.split(' ')[0] || '').length < 3);
  if (low('nome') || low('cpf') || !ex.cpfs.length || !ex.cpfs[0].ok || !ex.nasc || ex.nome.split(' ').length < 2) {
    if (!KEY) return null; const full = await runOcr(ocrCanvas(cv, null, 2000), {tessedit_pageseg_mode: '3'}, m => onProg && onProg(m, .9));
    const fx = extractDoc(full.text); rawParts.push('[página inteira]\n' + full.text);
    if ((!ex.nome || low('nome')) && fx.nome && fx.nome.split(' ').length >= 2) { ex.nome = fx.nome; conf.nome = 60; }
    if ((!ex.cpfs.length || !ex.cpfs[0].ok) && fx.cpfs.length) { ex.cpfs = fx.cpfs; conf.cpf = conf.cpf || 60; }
    if (!ex.rg && fx.rg) { ex.rg = fx.rg; conf.rg = conf.rg || 60; }
    if (!ex.nasc && fx.nasc) { ex.nasc = fx.nasc; conf.nasc = conf.nasc || 60; }
    if ((!ex.filiacao.length || low('fil')) && fx.filiacao.length) { ex.filiacao = fx.filiacao; conf.fil = 60; }
    ex.fallback = true;
  }
  return {ex, conf, raw: rawParts.join('\n'), template: tpl.id};
}
const cnhObs = ex => [ex.registro ? 'Nº Registro: ' + ex.registro : '', ex.validade ? 'Validade: ' + dateBR(ex.validade) : '', ex.cat ? 'Categoria: ' + ex.cat : ''].filter(Boolean).join(' · ');

/* ---- warp: 4 cantos (TL,TR,BR,BL em px da origem) → retângulo outW×outH (dois triângulos afins) ---- */
function cnhAffine(s, d) { // matriz que leva o triângulo s no d
  const [[sx0, sy0], [sx1, sy1], [sx2, sy2]] = s, [[dx0, dy0], [dx1, dy1], [dx2, dy2]] = d;
  const den = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0) || 1e-6;
  const a = ((dx1 - dx0) * (sy2 - sy0) - (dx2 - dx0) * (sy1 - sy0)) / den;
  const b = ((dx2 - dx0) * (sx1 - sx0) - (dx1 - dx0) * (sx2 - sx0)) / den;
  const c = ((dy1 - dy0) * (sy2 - sy0) - (dy2 - dy0) * (sy1 - sy0)) / den;
  const dd = ((dy2 - dy0) * (sx1 - sx0) - (dy1 - dy0) * (sx2 - sx0)) / den;
  return {a, b, c, d: dd, e: dx0 - a * sx0 - b * sy0, f: dy0 - c * sx0 - dd * sy0};
}
function cnhWarp(src, corners, outW, outH) { // corners: [TL,TR,BR,BL]
  const out = document.createElement('canvas'); out.width = outW; out.height = outH; const ctx = out.getContext('2d'); ctx.imageSmoothingQuality = 'high';
  const dst = [[0, 0], [outW, 0], [outW, outH], [0, outH]], tris = [[0, 1, 3], [1, 2, 3]];
  for (const [i, j, k] of tris) {
    const s = [corners[i], corners[j], corners[k]], d = [dst[i], dst[j], dst[k]], m = cnhAffine(s, d);
    ctx.save(); ctx.beginPath(); ctx.moveTo(d[0][0], d[0][1]); ctx.lineTo(d[1][0], d[1][1]); ctx.lineTo(d[2][0], d[2][1]); ctx.closePath(); ctx.clip();
    ctx.setTransform(m.a, m.c, m.b, m.d, m.e, m.f); ctx.drawImage(src, 0, 0); ctx.restore(); ctx.setTransform(1, 0, 0, 1, 0, 0);
  }
  return out;
}

/* ---- tela de ajuste de cantos (comum à foto do álbum e à captura da câmera) ---- */
function cnhCornerUI(srcCanvas, onReady, onCancel, inset = .06) {
  const ratio = CNH_TEMPLATES[0].ratio, maxW = Math.min(360, srcCanvas.width), scale = maxW / srcCanvas.width, dispW = Math.round(srcCanvas.width * scale), dispH = Math.round(srcCanvas.height * scale);
  const C = [[dispW * inset, dispH * inset], [dispW * (1 - inset), dispH * inset], [dispW * (1 - inset), dispH * (1 - inset)], [dispW * inset, dispH * (1 - inset)]];
  sheet(`<h2 style="margin-top:0">🪪 Ajustar cantos da CNH</h2><div class="sub" style="margin:0 0 8px;line-height:1.4">Arraste os quatro cantos para encaixar na <b>borda do cartão</b> (ou da área de dados). Depois toque em <b>Endireitar e ler</b>.</div>
    <div class="cnhwrap" id="cnhw" style="width:${dispW}px;height:${dispH}px"><canvas id="cnhc" width="${dispW}" height="${dispH}"></canvas><svg id="cnhsvg" width="${dispW}" height="${dispH}" style="position:absolute;inset:0"><polygon id="cnhpoly" fill="rgba(90,140,255,.12)" stroke="#5a8cff" stroke-width="2"/></svg>${C.map((_, i) => `<div class="cnhh" data-i="${i}"></div>`).join('')}</div>
    <div class="gap"></div><div class="btn pri" id="cnh_go">Endireitar e ler</div><div class="btn" id="cnh_cn" style="margin-top:10px">Cancelar</div>`, s => {
    const cv = s.querySelector('#cnhc'); cv.getContext('2d').drawImage(srcCanvas, 0, 0, dispW, dispH);
    const poly = s.querySelector('#cnhpoly'), hs = [...s.querySelectorAll('.cnhh')];
    const paint = () => { poly.setAttribute('points', C.map(p => p.join(',')).join(' ')); hs.forEach((h, i) => { h.style.left = C[i][0] + 'px'; h.style.top = C[i][1] + 'px'; }); };
    paint();
    const wrap = s.querySelector('#cnhw'); let drag = -1;
    const pt = e => { const r = wrap.getBoundingClientRect(), t = e.touches ? e.touches[0] : e; return [Math.max(0, Math.min(dispW, t.clientX - r.left)), Math.max(0, Math.min(dispH, t.clientY - r.top))]; };
    hs.forEach(h => { const start = e => { drag = +h.dataset.i; e.preventDefault(); }; h.addEventListener('mousedown', start); h.addEventListener('touchstart', start, {passive: false}); });
    const move = e => { if (drag < 0) return; C[drag] = pt(e); paint(); e.preventDefault(); }; const up = () => drag = -1;
    wrap.addEventListener('mousemove', move); wrap.addEventListener('touchmove', move, {passive: false}); window.addEventListener('mouseup', up); window.addEventListener('touchend', up);
    s.querySelector('#cnh_cn').onclick = () => { closeSheet(); onCancel && onCancel(); };
    s.querySelector('#cnh_go').onclick = () => {
      const inv = 1 / scale, corners = C.map(([x, y]) => [x * inv, y * inv]);
      const wTop = Math.hypot(corners[1][0] - corners[0][0], corners[1][1] - corners[0][1]), wBot = Math.hypot(corners[2][0] - corners[3][0], corners[2][1] - corners[3][1]);
      const hL = Math.hypot(corners[3][0] - corners[0][0], corners[3][1] - corners[0][1]), hR = Math.hypot(corners[2][0] - corners[1][0], corners[2][1] - corners[1][1]);
      const outW = Math.round(Math.max(wTop, wBot, 900)), outH = Math.round(outW / ratio);
      onReady(cnhWarp(srcCanvas, corners, outW, outH));
    };
  });
}
/* roda a leitura por zona sobre o canvas endireitado e abre a conferência (igual à de documento) */
async function cnhProcess(warped, onDone, batchCb) {
  const prog = ocrBusySheet('🪪 Lendo a CNH (modelo)…'); const st = () => $('#oc_st'), bar = () => $('#oc_bar');
  try {
    const r = await cnhReadCanvas(warped, (m, frac) => { prog(m); if (st()) st().textContent = 'Lendo os campos da CNH…'; if (bar() && frac != null) bar().style.width = Math.round(frac * 100) + '%'; });
    if (!r || !KEY) return;
    const blob = await new Promise(res => warped.toBlob(res, 'image/jpeg', .9)); const buf = await blob.arrayBuffer(); const img = new Uint8Array(buf);
    if (batchCb) return batchCb(r, img, blob);
    if (!$('#oc_st')) return; docReview(r.ex, r.raw, img, onDone, r.conf);
  } catch (e) { console.warn('CNH', e); if (KEY) { closeSheet(); toast('Leitura da CNH falhou: ' + e.message); } }
}
function cnhFromImageFile(file, onDone) { loadImg(file).then(li => { const cv = canvasOf(li.img, 1800); URL.revokeObjectURL(li.u); cnhCornerUI(cv, warped => cnhProcess(warped, onDone), null); }).catch(e => toast('Imagem inválida')); }
/* câmera ao vivo com moldura; se a câmera não abrir, cai para o álbum */
function cnhCamera(onDone) {
  let stream = null;
  const stop = () => { if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; release(); } };
  sheet(`<h2 style="margin-top:0">🪪 Ler CNH (modelo)</h2><div class="sub" style="margin:0 0 8px;line-height:1.4">Encaixe a CNH na moldura, com <b>boa luz</b> e <b>sem reflexo</b>. Toque em <b>Capturar</b>.</div>
    <div class="cnhcam"><video id="cnhv" playsinline autoplay muted></video><div class="cnhframe" style="aspect-ratio:${CNH_TEMPLATES[0].ratio}"></div></div>
    <div class="gap"></div><div class="btn pri" id="cnh_cap">📸 Capturar</div><div class="btn" id="cnh_alb" style="margin-top:10px">🖼️ Escolher do álbum</div><div class="btn" id="cnh_cn" style="margin-top:10px">Cancelar</div>`, async s => {
    const v = s.querySelector('#cnhv');
    s.querySelector('#cnh_cn').onclick = () => { stop(); closeSheet(); };
    s.querySelector('#cnh_alb').onclick = () => { stop(); closeSheet(); ocrPickAlbum(f => cnhFromImageFile(f, onDone)); };
    s.querySelector('#cnh_cap').onclick = () => {
      if (!v.videoWidth) return toast('Aguarde a câmera abrir ou use o álbum');
      const c = document.createElement('canvas'); c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
      // recorta exatamente o que aparece dentro da moldura: retângulo da moldura na tela → pixels do vídeo (considera o object-fit: cover)
      const vr = v.getBoundingClientRect(), frR = s.querySelector('.cnhframe').getBoundingClientRect(), k = Math.max(vr.width / c.width, vr.height / c.height);
      const ox = (vr.width - c.width * k) / 2, oy = (vr.height - c.height * k) / 2;
      let fx = (frR.left - vr.left - ox) / k, fy = (frR.top - vr.top - oy) / k, fw = frR.width / k, fh = frR.height / k;
      fx = Math.max(0, fx); fy = Math.max(0, fy); fw = Math.min(c.width - fx, fw); fh = Math.min(c.height - fy, fh);
      const crop = document.createElement('canvas'); crop.width = Math.round(fw); crop.height = Math.round(fh); crop.getContext('2d').drawImage(c, fx, fy, fw, fh, 0, 0, crop.width, crop.height);
      stop(); cnhCornerUI(crop, warped => cnhProcess(warped, onDone), () => cnhCamera(onDone), .01);
    };
    try { stream = await navigator.mediaDevices.getUserMedia({video: {facingMode: {ideal: 'environment'}, width: {ideal: 1920}}, audio: false}); v.srcObject = stream; hold(300000); v.onloadedmetadata = () => { const box = s.querySelector('.cnhcam'); if (box && v.videoWidth) { box.style.aspectRatio = `${v.videoWidth} / ${v.videoHeight}`; box.style.width = `min(100%, calc(56vh * ${(v.videoWidth / v.videoHeight).toFixed(4)}))`; } v.play().catch(() => {}); }; }
    catch (e) { console.warn('cam', e); const al = $('#cnh_cap'); if (al) { const note = document.createElement('div'); note.className = 'warn'; note.innerHTML = '⚠️ Não consegui abrir a câmera aqui (permissão ou navegador). Use <b>Escolher do álbum</b>.'; al.parentNode.insertBefore(note, al); } }
  });
}
function ocrPickAlbum(cb) { pickFile('image/*', cb); }
function cnhStart(onDone) {
  sheet(`<h2 style="margin-top:0">🪪 Ler CNH (modelo)</h2><div class="sub" style="line-height:1.45;margin-bottom:6px">Leitura por <b>moldura</b>: encaixe a CNH, o app endireita e lê cada campo na posição dele — costuma acertar mais que ler o documento inteiro como texto. Tudo no aparelho.</div>
    <div class="btn pri" id="cs_cam">📷 Abrir câmera</div><div class="btn" id="cs_alb" style="margin-top:10px">🖼️ Escolher do álbum</div>
    <div class="warn" style="margin-bottom:0">As posições dos campos são uma <b>estimativa</b> do modelo da CNH e podem precisar de ajuste; se a leitura sair fraca, o app tenta ler a página inteira. Sempre confira antes de salvar.</div>`, s => {
    s.querySelector('#cs_cam').onclick = () => { closeSheet(); cnhCamera(onDone); };
    s.querySelector('#cs_alb').onclick = () => { closeSheet(); ocrPickAlbum(f => cnhFromImageFile(f, onDone)); };
  });
}

/* ============ CNH digital em PDF (CNH-e / Carteira Digital de Trânsito) ============ */
/* Sem amostra real: o parser é por POSIÇÃO de rótulo (rótulo → valor ao lado/abaixo), tolerante a ordem e quebras.
   A fixture de teste é sintética (reportlab) imitando rótulos/valores. Caveat relatado ao usuário. */
async function cnhePdfItems(pdf) {
  const pg = await pdf.getPage(1), tc = await pg.getTextContent(); const items = [];
  for (const it of tc.items) { if (!('str' in it) || !it.str.trim()) continue; const t = it.transform; items.push({s: it.str.trim(), x: t[4], y: t[5], h: Math.abs(t[3]) || it.height || 8, w: it.width || 0}); }
  pg.cleanup(); return items;
}
const CNHE_SIG = /(?:CARTEIRA\s+NACIONAL\s+DE\s+HABILITA[ÇC][ÃA]O|CARTEIRA\s+DIGITAL\s+DE\s+TR[ÂA]NSITO)/i;
function cnheDetect(items) { const all = _norm(items.map(i => i.s).join(' ')); if (!CNHE_SIG.test(items.map(i => i.s).join(' '))) return false;
  let n = 0; for (const re of [/\bnome\b/, /\bcpf\b/, /\bfilia[cç][aã]o\b/, /\bnº?\s*registro\b|\bregistro\b/, /\bvalidade\b/, /\bnascimento\b/, /\bidentidade\b/, /\bcategoria\b|\bcat\b/]) if (re.test(all)) n++; return n >= 4; }
/* agrupa itens em linhas (por y), ordena por x */
function cnheLines(items) {
  const srt = items.slice().sort((a, b) => b.y - a.y || a.x - b.x), lines = [];
  for (const it of srt) { const L = lines.find(l => Math.abs(l.y - it.y) <= Math.max(3, it.h * .6)); if (L) { L.items.push(it); L.y = (L.y * L.items.length + it.y) / (L.items.length + 1); } else lines.push({y: it.y, items: [it]}); }
  lines.forEach(l => { l.items.sort((a, b) => a.x - b.x); l.text = l.items.map(i => i.s).join(' ').replace(/\s+/g, ' ').trim(); l.x = l.items[0].x; });
  return lines;
}
const CNHE_LABELS = [
  ['nome', /^(?:nome(?:\s+e\s+sobrenome|\s+social|\s+civil|\s+completo)?)\s*:?\.?$/],
  ['rg', /^(?:(?:n[º°o.]*\s*)?doc(?:umento)?\.?\s*(?:de\s+)?identidade.*|identidade|rg)\s*:?\.?$/],
  ['cpf', /^(?:n[º°o.]*\s*)?cpf\s*:?\.?$/],
  ['nasc', /^(?:data\b.{0,25}\bnascimento|nascimento|data\s+nasc\.?)\s*:?\.?$/],
  ['fil', /^filia[cç][aã]o\s*:?\.?$/],
  ['registro', /^(?:n[º°o.]*\s*)?registro\s*:?\.?$/],
  ['validade', /^validade\s*:?\.?$/],
  ['cat', /^(?:cat\.?|categoria)(?:\s*hab\.?)?\s*:?\.?$/],
  ['local', /^(?:local\s*(?:e\s*uf)?|naturalidade)\s*:?\.?$/]
];
const cnheLabelOf = s => { const n = _norm(s).replace(/:.*$/, '').trim().replace(/^\d{1,2}[a-z]?(?:\s*(?:e|,|\/)\s*\d{1,2}[a-z]?)*\s*[.)\-]?\s+(?=[a-z])/, ''); for (const [f, re] of CNHE_LABELS) if (re.test(n)) return f; return null; };
/* valor de um rótulo (por coluna): itens à direita na mesma linha até o próximo rótulo; senão os itens da(s) linha(s) abaixo
   cujo x cai na coluna do rótulo [x-30, x do próximo rótulo da linha) */
function cnheValue(lines, li, it, wantNames, f) {
  const L0 = lines[li], idx = L0.items.indexOf(it), after = L0.items.slice(idx + 1);
  const inl = it.s.includes(':') ? it.s.replace(/^[^:]*:/, '').trim() : ''; if (inl) return [inl];
  // à direita na mesma linha só vale como VALOR se o rótulo termina em “:”, se a letra é maior (valor em destaque) ou se tem cara do campo;
  // outro texto do tamanho do rótulo (ex.: “1ª HABILITAÇÃO”, “DATA EMISSÃO”) é outro cabeçalho e fecha a coluna
  const looks = s => /^(?:cpf|registro|validade|nasc)$/.test(f) ? /\d{2}/.test(s) : f === 'cat' ? /^[A-E]{1,5}$/.test(s.trim()) : false;
  const isVal = x => !cnheLabelOf(x.s) && (/:\s*$/.test(it.s) || x.h > it.h * 1.12 || looks(x.s));
  const right = []; let stopX = Infinity; for (const x of after) { if (isVal(x)) right.push(x.s); else { stopX = x.x; break; } }
  if (right.length) return [right.join(' ').replace(/^:\s*/, '').trim()];
  const x1 = stopX - 4;
  const out = [];
  for (let k = li + 1; k < lines.length && out.length < (wantNames ? 2 : 1); k++) {
    const L = lines[k], col = L.items.filter(x => x.x >= it.x - 30 && x.x < x1);
    if (!col.length) { if (out.length) break; if (L0.y - L.y > it.h * 4) break; continue; }
    if (col.some(x => cnheLabelOf(x.s))) break;
    out.push(col.map(x => x.s).join(' ').trim());
  }
  return out;
}
function cnheExtract(items) {
  if (!cnheDetect(items)) return null;
  const lines = cnheLines(items), c = exCard({lab: true, exact: true, cnh: true}), got = {}; const loose = [];
  lines.forEach((L, li) => { for (const it of L.items) { const f = cnheLabelOf(it.s); if (!f || got[f]) continue; got[f] = true;
    const vals = cnheValue(lines, li, it, f === 'fil', f); if (!vals.length) continue;
    if (f === 'nome') { const nm = exNameFix(vals[0]); if (nm) exPut(c, exItem('nome', nm), loose); }
    else if (f === 'cpf') { const d = _digits(vals[0]); if (d.length === 11) exPut(c, exItem('cpf', cpfFmt(d), cpfValid(d)), loose); }
    else if (f === 'nasc') { const m = vals[0].match(/\d{1,2}\s*[\/.\-]\s*\d{1,2}\s*[\/.\-]\s*\d{4}/), iso = exDateISO(m ? m[0] : vals[0]); if (iso) exPut(c, exItem('nasc', iso), loose);
      const loc = m ? vals[0].slice(m.index + m[0].length).replace(/^[\s,;\-]+/, '').trim() : ''; if (loc && /[A-Za-zÀ-ÿ]{3}/.test(loc) && !got.local) { got.local = true; c.obs = [c.obs, 'Naturalidade: ' + loc].filter(Boolean).join('\n'); } }
    else if (f === 'rg') { const d = vals[0].replace(/\s+/g, ' ').trim(); if (d) exPut(c, exItem('rg', d.replace(/\s*-\s*(?=[A-Z]{2,8}\b)/, ' ')), loose); }
    else if (f === 'fil') { const ps = vals.map(exNameFix).filter(x => x.split(' ').length >= 2); if (ps.length) exPut(c, exItem('fil', ps.join('\n')), loose); }
    else if (f === 'registro') { const d = _digits(vals[0]); if (d.length >= 6) c.obs = [c.obs, 'Nº Registro: ' + d].filter(Boolean).join('\n'); }
    else if (f === 'validade') { const m = vals[0].match(/(\d{1,2})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{4})/), iso = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : ''; if (iso) c.obs = [c.obs, 'Validade: ' + dateBR(iso)].filter(Boolean).join('\n'); }
    else if (f === 'cat') { const g = (vals[0].toUpperCase().match(/\b[A-E]{1,5}\b/) || [''])[0]; if (g) c.obs = [c.obs, 'Categoria: ' + g].filter(Boolean).join('\n'); }
    else if (f === 'local') { if (vals[0]) c.obs = [c.obs, 'Naturalidade: ' + vals[0].replace(/\s+/g, ' ').trim()].filter(Boolean).join('\n'); }
  } });
  if (!c.nome && !c.cpf) return null;
  c.inc = true; return {cards: [c], loose, exact: {kind: 'cnh', n: 1, ignored: 0}};
}

/* menu com os modos de importação (usado na Importação em lote) */
const exModesHtml = () => `<div class="card glass" style="cursor:default;padding:0;margin:0 0 6px"><div class="tgrow" id="mo_ex" style="cursor:pointer"><div>🧾 Extrair de texto/documento<div class="sub">BO, relatório, WhatsApp, PDF ou Word → pessoas para conferir</div></div><span class="sub">›</span></div><div class="tgrow" id="mo_doc" style="cursor:pointer"><div>🪪 Ler documentos em lote<div class="sub">várias fotos de RG/CNH (OCR no aparelho)</div></div><span class="sub">›</span></div><div class="tgrow" id="mo_ph" style="cursor:pointer"><div>🖼️ Fotos em lote pelo nome<div class="sub">arquivos com CPF ou nome do alvo</div></div><span class="sub">›</span></div></div>`;
function exModesBind(root, opId) { const b = (id, fn) => { const el = root.querySelector(id); if (el) el.onclick = fn; };
  b('#mo_ex', () => extractUI(opId)); b('#mo_doc', () => { closeSheet(); docBatchUI(opId); }); b('#mo_ph', () => { closeSheet(); photoBatchUI(opId); }); }

/* ---------- Início ---------- */
DB.open().then(route).catch(e => { APP.innerHTML = `<div class="empty">Erro ao abrir o armazenamento: ${esc(e.message)}</div>`; });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
