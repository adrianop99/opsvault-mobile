'use strict';
/* ============ OpsVault Mobile — by @aiforge.team ============ */
const APP_NAME = "OpsVault Mobile", APP_SHORT = "OpsVault", CREDIT = "by @aiforge.team", APP_VER = "v0.6", APP_CACHE = "opsvault-v7"; // APP_CACHE = nome do cache em sw.js
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
  try { trackStop(true); } catch (e) {} try { measureEnd && measureEnd(); } catch (e) {}
  try { stopPlayer(); } catch (e) {} audioCache.forEach(u => URL.revokeObjectURL(u)); audioCache.clear();
  KEY = null; S = null; imgCache.forEach(u => URL.revokeObjectURL(u)); imgCache.clear(); clearTimeout(idleT); DB.use(false);
  document.querySelectorAll('.viewer').forEach(v => v.remove()); applyDisc();
  closeSheet(); location.hash = '#lock'; route(); updQ(); if (why) setTimeout(() => toast('🔒 Cofre travado (' + why + ')'), 200);
}

/* ---------- UI helpers ---------- */
function toast(m, ms = 2600) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms); }
function sheet(html, onMount) { $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#sheet-wrap').classList.remove('hidden'); onMount && onMount($('#sheet')); micify($('#sheet')); }
function closeSheet() { stopDict(); $('#sheet-wrap').classList.add('hidden'); $('#sheet').innerHTML = ''; }
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
addEventListener('hashchange', route);
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
  <div class="ocrbar"><div class="btn sm" id="a_ocr">🪪 Ler documento</div><span class="sub">foto do RG/CNH · leitura no aparelho</span></div><div id="a_docpend"></div>
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
    <div class="sub" style="margin:0 0 8px;line-height:1.4">Um alvo por linha, campos separados por <b>|</b> (barra vertical):</div>
    <div class="card glass" style="cursor:default;padding:10px 12px;font-size:11px;word-break:break-all;color:#9cbcff">${esc(BATCH_HEADER)}</div>
    ${defOp?`<div class="sub" style="margin:8px 4px">Operação padrão (quando o campo <b>operação</b> ficar vazio): <b>${esc(defOp.nome)}</b></div>`:''}
    <label>Colar lista</label><textarea id="ib_t" style="min-height:140px" placeholder="Cole aqui ou use o arquivo…"></textarea>
    <div class="grid2" style="margin-top:12px"><div class="btn" id="ib_file">📄 Arquivo .txt/.csv</div><div class="btn" id="ib_modelo">⬇️ Baixar modelo</div></div>
    <div class="gap"></div><div class="btn pri" id="ib_prev">Pré-visualizar</div>
    <div class="credit">${esc(APP_NAME)} · <b>${esc(CREDIT)}</b></div>`, s=>{
    s.querySelector('#ib_modelo').onclick=()=>modeloBatch();
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
function pickFile(accept, cb) {
  let inp = document.getElementById('pick');
  if (!inp) { inp = document.createElement('input'); inp.type = 'file'; inp.id = 'pick'; inp.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0'; document.body.appendChild(inp); }
  if (accept) inp.setAttribute('accept', accept); else inp.removeAttribute('accept');
  inp.value = ''; hold(180000);
  inp.onchange = () => { release(); const f = inp.files && inp.files[0]; if (f) cb(f); };
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
  try { const w = await ocrWorker(); await w.setParameters(Object.assign({tessedit_char_whitelist: '', tessedit_pageseg_mode: '3', preserve_interword_spaces: '1', user_defined_dpi: '300'}, params || {})); const {data} = await w.recognize(cv); return data; }
  finally { OCR_PROG = null; }
}
const ocrStepTxt = m => ({'loading tesseract core': 'Carregando o leitor…', 'initializing tesseract': 'Preparando…', 'loading language traineddata': 'Carregando o português…', 'initializing api': 'Preparando…', 'recognizing text': 'Lendo o texto…'})[m.status] || 'Preparando…';
function loadImg(file) { return new Promise((res, rej) => { const u = URL.createObjectURL(file); const img = new Image(); img.onload = () => res({img, u}); img.onerror = () => { URL.revokeObjectURL(u); rej(new Error('imagem inválida')); }; img.src = u; }); }
/* recorte → canvas em tons de cinza com contraste esticado (ajuda o OCR com foto escura/lavada) */
function ocrCanvas(img, r, maxSide, minH, invert) {
  r = r || {x: 0, y: 0, w: img.naturalWidth, h: img.naturalHeight};
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
function docReview(ex, raw, img, onDone) {
  const best = ex.cpfs[0];
  const row = (k, lbl, inner, on) => `<div class="ocrrow"><label class="ocrl"><input type="checkbox" class="ocrck" data-k="${k}" ${on ? 'checked' : ''}> ${lbl}</label>${inner}</div>`;
  sheet(`<h2 style="margin-top:0">🪪 Conferir leitura</h2>
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

/* ---------- Início ---------- */
DB.open().then(route).catch(e => { APP.innerHTML = `<div class="empty">Erro ao abrir o armazenamento: ${esc(e.message)}</div>`; });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
