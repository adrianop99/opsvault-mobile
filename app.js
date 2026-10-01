'use strict';
/* ============ OpsVault Mobile — by @aiforge.team ============ */
const APP_NAME = "OpsVault Mobile", APP_SHORT = "OpsVault", CREDIT = "by @aiforge.team";
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
const DB = {
  db: null,
  open() { return new Promise((res, rej) => { const r = indexedDB.open('cofre-op', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => { this.db = r.result; res(); }; r.onerror = () => rej(r.error); }); },
  tx(mode) { return this.db.transaction('kv', mode).objectStore('kv'); },
  get(k) { return new Promise((res, rej) => { const r = this.tx('readonly').get(k); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  set(k, v) { return new Promise((res, rej) => { const r = this.tx('readwrite').put(v, k); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
  del(k) { return new Promise((res, rej) => { const r = this.tx('readwrite').delete(k); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); },
  keys() { return new Promise((res, rej) => { const r = this.tx('readonly').getAllKeys(); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  clear() { return new Promise((res, rej) => { const r = this.tx('readwrite').clear(); r.onsuccess = () => res(); r.onerror = () => rej(r.error); }); }
};

/* ---------- Criptografia (PBKDF2 + AES-GCM 256) ---------- */
const ITER = 250000;
let KEY = null, S = null; // chave e estado só em memória enquanto aberto
async function deriveKey(pin, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2', salt, iterations:ITER, hash:'SHA-256'}, base, {name:'AES-GCM', length:256}, false, ['encrypt','decrypt']);
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

/* ---------- Trava automática ---------- */
let idleT = null, holdLock = false, holdT = null;
const idleMin = () => (S && S.cfg && S.cfg.idle) || 3;
function resetIdle() { clearTimeout(idleT); if (KEY) idleT = setTimeout(() => lock('inatividade'), idleMin() * 60000); }
function hold(ms = 90000) { holdLock = true; clearTimeout(holdT); holdT = setTimeout(() => holdLock = false, ms); }
function release() { setTimeout(() => { holdLock = false; }, 1500); }
['pointerdown','keydown','touchstart'].forEach(e => addEventListener(e, resetIdle, {passive:true}));
document.addEventListener('visibilitychange', () => { if (document.hidden && KEY && !holdLock) lock('app em segundo plano'); });
function lock(why) {
  KEY = null; S = null; imgCache.forEach(u => URL.revokeObjectURL(u)); imgCache.clear(); clearTimeout(idleT);
  closeSheet(); location.hash = '#lock'; route(); if (why) setTimeout(() => toast('🔒 Cofre travado (' + why + ')'), 200);
}

/* ---------- UI helpers ---------- */
function toast(m, ms = 2600) { const t = $('#toast'); t.textContent = m; t.classList.remove('hidden'); clearTimeout(t._t); t._t = setTimeout(() => t.classList.add('hidden'), ms); }
function sheet(html, onMount) { $('#sheet').innerHTML = '<div class="grab"></div>' + html; $('#sheet-wrap').classList.remove('hidden'); onMount && onMount($('#sheet')); }
function closeSheet() { $('#sheet-wrap').classList.add('hidden'); $('#sheet').innerHTML = ''; }
$('#sheet-bg').onclick = closeSheet;
function confirmBox(msg, okTxt = 'Confirmar', danger = false) {
  return new Promise(res => { sheet(`<h2 style="margin-top:0">${esc(msg)}</h2><div class="grid2" style="margin-top:16px"><div class="btn" id="cn">Cancelar</div><div class="btn ${danger?'dan':'pri'}" id="ok">${esc(okTxt)}</div></div>`, s => { s.querySelector('#cn').onclick = () => { closeSheet(); res(false); }; s.querySelector('#ok').onclick = () => { closeSheet(); res(true); }; }); });
}
const PRIO = {alta:['c-red','Prioridade alta'], media:['c-amb','Prioridade média'], baixa:['c-gray','Prioridade baixa']};
const STATUS = {planejada:['c-gray','Planejada'], andamento:['c-blue','Em andamento'], encerrada:['c-grn','Encerrada']};
const TIPOS = {residencia:['🏠','Residência','#5b8fff'], trabalho:['🏢','Trabalho','#8a6bff'], veiculo:['🚗','Veículo','#8a9bb8'], encontro:['🤝','Ponto de encontro','#ffa94d'], foto:['📷','Foto','#ff6b6b'], outro:['📍','Outro','#3cd290']};
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

/* ---------- Roteador ---------- */
addEventListener('hashchange', route);
async function route() {
  const h = (location.hash || '#ops').slice(1).split('/');
  if (!KEY) { $('#tabs').classList.add('hidden'); return viewLock(); }
  if (window._map) { window._map.remove(); window._map = null; }
  scrollTo(0, 0);
  const [v, a, b] = h;
  try {
    if (v === 'op') return viewOp(a);
    if (v === 'alvo' && b === 'editar') return viewAlvoForm(a);
    if (v === 'novoalvo') return viewAlvoForm(null, a);
    if (v === 'alvo') return viewAlvo(a);
    if (v === 'exportar') return viewExport(a);
    if (v === 'mapa') return viewMapa(a);
    if (v === 'busca') return viewBusca();
    if (v === 'cofre') return viewCofre();
    if (v === 'ajuda') return viewAjuda();
    return viewOps();
  } catch (e) { console.error(e); toast('Erro: ' + e.message); }
}

/* ---------- Tela de bloqueio ---------- */
const credit = () => `<div class="credit">${esc(APP_NAME)} · <b>${esc(CREDIT)}</b></div>`;
async function viewLock() {
  const meta = await DB.get('meta');
  const first = !meta;
  let pin = '', firstPin = null;
  const fails = () => +(localStorage.getItem('ov_fails') || 0);
  const until = () => +(localStorage.getItem('ov_until') || 0);
  APP.innerHTML = `<div class="lock">
    <div class="shield glass">🛡️</div>
    <div class="brand">${esc(APP_NAME)}</div>
    <h1 id="lt" style="margin-top:6px">${first ? 'Crie seu PIN' : 'Cofre travado'}</h1>
    <div class="sub" id="ls">${first ? 'Mínimo de 6 dígitos. Sem ele, ninguém abre os dados — nem você.' : 'Digite o PIN para abrir'}</div>
    <div class="dots" id="dots"></div>
    <div class="err" id="err"></div>
    <div class="keys">${[1,2,3,4,5,6,7,8,9].map(n => `<div class="key glass" data-k="${n}">${n}</div>`).join('')}
      <div class="key" data-k="del" style="font-size:20px">⌫</div><div class="key glass" data-k="0">0</div><div class="key" data-k="ok" style="font-size:18px;font-weight:700;color:#9cbcff">OK</div></div>
    ${credit()}
  </div>`;
  const dots = () => { $('#dots').innerHTML = Array.from({length: Math.max(6, pin.length)}, (_, i) => `<i class="${i < pin.length ? 'f' : ''}"></i>`).join(''); };
  const err = m => { $('#err').textContent = m; const d = $('#dots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake'); };
  dots();
  let busy = false;
  async function submit() {
    if (busy) return;
    if (pin.length < 6) return err('O PIN precisa ter pelo menos 6 dígitos');
    if (first) {
      if (!firstPin) { firstPin = pin; pin = ''; dots(); $('#lt').textContent = 'Confirme o PIN'; $('#ls').textContent = 'Digite o mesmo PIN de novo'; $('#err').textContent = ''; return; }
      if (pin !== firstPin) { firstPin = null; pin = ''; dots(); $('#lt').textContent = 'Crie seu PIN'; return err('Os PINs não conferem. Recomece.'); }
      busy = true; $('#err').textContent = 'Gerando chave…';
      const salt = crypto.getRandomValues(new Uint8Array(16));
      KEY = await deriveKey(pin, salt);
      await DB.set('meta', {salt: b64(salt), check: await seal(KEY, enc.encode('opsvault-ok')), v: 1});
      S = {ops: [], alvos: [], cfg: {idle: 3}}; await save();
      pin = ''; location.hash = '#ajuda'; resetIdle(); route(); toast('Cofre criado. Veja o guia rápido 👇'); return;
    }
    const wait = until() - Date.now();
    if (wait > 0) return err(`Muitas tentativas. Aguarde ${Math.ceil(wait / 1000)}s`);
    busy = true; $('#err').textContent = 'Verificando…';
    try {
      const k = await deriveKey(pin, unb64(meta.salt));
      await open_(k, meta.check);
      const box = await DB.get('data');
      S = box ? JSON.parse(dec.decode(await open_(k, box))) : {ops: [], alvos: [], cfg: {idle: 3}};
      S.cfg = S.cfg || {idle: 3};
      KEY = k; localStorage.removeItem('ov_fails'); localStorage.removeItem('ov_until');
      pin = ''; if (!location.hash || location.hash === '#lock') location.hash = '#ops'; resetIdle(); route();
    } catch (e) {
      const f = fails() + 1; localStorage.setItem('ov_fails', f);
      if (f >= 5) localStorage.setItem('ov_until', Date.now() + Math.min(30 * 2 ** (f - 5), 3600) * 1000);
      busy = false; pin = ''; dots(); err(f >= 5 ? `PIN incorreto. Bloqueado por ${Math.min(30 * 2 ** (f - 5), 3600)}s` : `PIN incorreto (${f}/5)`);
    }
  }
  APP.querySelectorAll('.key').forEach(k => k.onclick = () => {
    if (busy) return; const v = k.dataset.k;
    if (v === 'del') pin = pin.slice(0, -1); else if (v === 'ok') return submit(); else if (pin.length < 12) pin += v;
    $('#err').textContent = ''; dots();
  });
}

/* ---------- Operações ---------- */
function viewOps() {
  tabs('ops');
  const ops = [...S.ops].sort((a, b) => b.ts - a.ts);
  APP.innerHTML = `<div class="top"><div><div class="brand">${esc(APP_NAME)}</div><h1>Operações</h1></div><div class="btn sm" onclick="lock('manual')">🔒</div></div>
  ${ops.length ? ops.map(o => { const n = S.alvos.filter(a => a.opId === o.id).length; const st = STATUS[o.status] || STATUS.planejada; return `<div class="card glass" onclick="location.hash='#op/${o.id}'"><div class="row"><div class="t">${esc(o.nome)}</div><span class="chip ${st[0]}">${st[1]}</span></div><div class="sub" style="margin-top:6px">${n} alvo(s) · criada ${fmt(o.ts)}</div>${o.desc ? `<div class="sub" style="margin-top:4px">${esc(o.desc)}</div>` : ''}</div>`; }).join('')
  : `<div class="empty"><div>🗂️</div>Nenhuma operação ainda.<br>Toque em <b>+</b> para criar a primeira.</div>`}
  <div class="btn pri fab" id="nova">+</div>`;
  $('#nova').onclick = () => opForm();
}
function opForm(op) {
  sheet(`<h2 style="margin-top:0">${op ? 'Editar operação' : 'Nova operação'}</h2>
    <label>Nome</label><input id="f_n" value="${esc(op?.nome)}" placeholder="Ex.: Operação Aurora">
    <label>Status</label><select id="f_s">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${op?.status === k ? 'selected' : ''}>${v[1]}</option>`).join('')}</select>
    <label>Descrição</label><textarea id="f_d" placeholder="Objetivo, área, observações">${esc(op?.desc)}</textarea>
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
  APP.innerHTML = `<div class="back" onclick="location.hash='#ops'">‹ Operações</div>
  <div class="top"><div><h1>${esc(op.nome)}</h1><div style="margin-top:6px"><span class="chip ${st[0]}">${st[1]}</span></div></div><div class="btn sm" id="ed">Editar</div></div>
  ${op.desc ? `<div class="card glass" style="cursor:default"><div class="sub">${esc(op.desc)}</div></div>` : ''}
  <h2>Alvos (${alvos.length})</h2>
  ${alvos.length ? alvos.map(a => { const p = PRIO[a.prio] || PRIO.media; return `<div class="card glass" onclick="location.hash='#alvo/${a.id}'"><div class="row"><div style="display:flex;gap:12px;align-items:center"><div class="th" style="width:48px;height:48px;flex-shrink:0" data-img="${a.fotos?.[0]?.id || ''}">${a.fotos?.length ? '' : '<div style="display:flex;height:100%;align-items:center;justify-content:center">👤</div>'}</div><div><div class="t">${esc(a.nome)}</div><div class="sub">${esc(a.apelido ? '“' + a.apelido + '”' : '')} ${a.fotos?.length || 0} foto(s) · ${a.locais?.length || 0} local(is)</div></div></div><span class="chip ${p[0]}">${p[1].replace('Prioridade ', '')}</span></div></div>`; }).join('')
  : `<div class="empty"><div>👤</div>Nenhum alvo nesta operação.</div>`}
  <div class="btn" id="imp_op" style="margin-top:14px">⬆️ Importar alvos em lote</div>
  <div class="btn" id="exp_op" style="margin-top:10px">📦 Exportar operação (outro aparelho)</div>
  <div class="grid2" style="margin-top:10px"><div class="btn" onclick="location.hash='#mapa'">🗺️ Ver no mapa</div><div class="btn dan" id="del">Excluir operação</div></div>
  <div class="btn pri fab" onclick="location.hash='#novoalvo/${id}'">+</div>`;
  $('#ed').onclick = () => opForm(op);
  $('#imp_op').onclick = () => importBatch(id);
  $('#exp_op').onclick = () => exportOpUI(op);
  $('#del').onclick = async () => {
    if (!await confirmBox(`Excluir "${op.nome}" e seus ${alvos.length} alvo(s)?`, 'Excluir', true)) return;
    for (const a of alvos) for (const f of a.fotos || []) await DB.del('img:' + f.id);
    S.alvos = S.alvos.filter(a => a.opId !== id); S.ops = S.ops.filter(o => o.id !== id); await save(); location.hash = '#ops'; toast('Operação excluída');
  };
  loadThumbs();
}
async function loadThumbs() { for (const el of APP.querySelectorAll('[data-img]')) { const id = el.dataset.img; if (!id) continue; const u = await getImg(id); if (u) el.innerHTML = `<img src="${u}">` + (el.dataset.g ? `<span class="g">${el.dataset.g}</span>` : ''); } }

/* ---------- Formulário de alvo ---------- */
function viewAlvoForm(id, opId) {
  tabs('ops'); const a = id ? getAlvo(id) : null; if (id && !a) return location.hash = '#ops';
  const oid = a?.opId || opId;
  APP.innerHTML = `<div class="back" onclick="history.back()">‹ Voltar</div><h1>${a ? 'Editar alvo' : 'Novo alvo'}</h1>
  <label>Operação</label><select id="a_op">${S.ops.map(o => `<option value="${o.id}" ${o.id === oid ? 'selected' : ''}>${esc(o.nome)}</option>`).join('')}</select>
  <label>Nome completo</label><input id="a_nome" value="${esc(a?.nome)}">
  <label>Apelido / vulgo</label><input id="a_apelido" value="${esc(a?.apelido)}">
  <div class="grid2"><div><label>CPF / RG</label><input id="a_doc" value="${esc(a?.doc)}" inputmode="numeric"></div><div><label>Prioridade</label><select id="a_prio">${Object.entries(PRIO).map(([k, v]) => `<option value="${k}" ${(a?.prio || 'media') === k ? 'selected' : ''}>${v[1].replace('Prioridade ', '')}</option>`).join('')}</select></div></div>
  <label>Telefones (um por linha)</label><textarea id="a_tel" style="min-height:64px" inputmode="tel">${esc((a?.tels || []).join('\n'))}</textarea>
  <label>Veículo (modelo, cor, placa)</label><input id="a_veic" value="${esc(a?.veic)}">
  <label>Endereço conhecido</label><input id="a_end" value="${esc(a?.end)}">
  <label>Vínculos (pessoas, facções, empresas)</label><textarea id="a_vinc" style="min-height:64px">${esc(a?.vinc)}</textarea>
  <div class="gap"></div><div class="btn pri" id="a_ok">Salvar alvo</div>`;
  $('#a_ok').onclick = async () => {
    const g = k => $('#a_' + k).value.trim();
    if (!g('nome')) return toast('Informe o nome');
    if (!g('op')) return toast('Crie uma operação primeiro');
    const d = {opId: g('op'), nome: g('nome'), apelido: g('apelido'), doc: g('doc'), prio: g('prio'), tels: g('tel').split('\n').map(x => x.trim()).filter(Boolean), veic: g('veic'), end: g('end'), vinc: g('vinc')};
    if (a) { Object.assign(a, d); a.log = a.log || []; a.log.push({ts: Date.now(), t: 'Dados editados'}); }
    else S.alvos.push({id: uid(), ...d, fotos: [], locais: [], notas: [], log: [{ts: Date.now(), t: 'Alvo cadastrado'}], ts: Date.now()});
    await save(); toast('Alvo salvo'); location.hash = '#alvo/' + (a ? a.id : S.alvos[S.alvos.length - 1].id);
  };
}

/* ---------- Ficha do alvo ---------- */
function timeline(a) {
  const ev = [...(a.log || []).map(x => ({ts: x.ts, i: '📝', t: x.t}))];
  (a.fotos || []).forEach(f => ev.push({ts: f.ts, i: '📷', t: 'Foto' + (f.legenda ? ': ' + f.legenda : '') + (f.lat ? ` · ${coord(f)}` : ' · sem GPS')}));
  (a.locais || []).forEach(l => ev.push({ts: l.ts, i: (TIPOS[l.tipo] || TIPOS.outro)[0], t: `${l.titulo || (TIPOS[l.tipo] || TIPOS.outro)[1]} · ${coord(l)}` + (l.nota ? ' — ' + l.nota : '')}));
  (a.notas || []).forEach(n => ev.push({ts: n.ts, i: '🗒️', t: n.txt}));
  return ev.sort((x, y) => y.ts - x.ts);
}
async function viewAlvo(id) {
  tabs('ops'); const a = getAlvo(id); if (!a) return location.hash = '#ops';
  const op = getOp(a.opId); const p = PRIO[a.prio] || PRIO.media;
  const rows = [['Apelido', a.apelido], ['Documento', a.doc], ['Telefones', (a.tels || []).join('<br>')], ['Veículo', a.veic], ['Endereço', a.end], ['Vínculos', a.vinc], ['Operação', op?.nome]].filter(r => r[1]);
  const tl = timeline(a);
  APP.innerHTML = `<div class="back" onclick="location.hash='#op/${a.opId}'">‹ ${esc(op?.nome || 'Operação')}</div>
  <div class="hero" id="hero">${a.fotos?.length ? '' : '<div class="ph">👤</div>'}<div class="cap glass"><div class="row"><div><div class="t" style="font-weight:700;font-size:18px">${esc(a.nome)}</div><div class="sub">${a.fotos?.length || 0} foto(s) · ${a.locais?.length || 0} local(is) · ${a.notas?.length || 0} nota(s)</div></div><span class="chip ${p[0]}">${p[1].replace('Prioridade ', '')}</span></div></div></div>
  <div class="acts"><div class="act glass" id="b_foto"><em>📷</em>Fotografar</div><div class="act glass" id="b_loc"><em>📍</em>Marcar local</div><div class="act glass" id="b_nota"><em>🗒️</em>Anotar</div><div class="act glass" onclick="location.hash='#mapa/${a.id}'"><em>🗺️</em>Mapa</div></div>
  <div class="card glass list" style="cursor:default;padding:0">${rows.length ? rows.map(r => `<div class="li"><span>${r[0]}</span><b>${r[0] === 'Telefones' ? r[1].split('<br>').map(esc).join('<br>') : esc(r[1])}</b></div>`).join('') : '<div class="li"><span>Sem dados cadastrados</span></div>'}</div>
  <h2>Fotos</h2>
  ${a.fotos?.length ? `<div class="thumbs">${a.fotos.map(f => `<div class="th" data-img="${f.id}" data-g="${f.lat ? '📍' : ''}" onclick="viewer('${a.id}','${f.id}')"></div>`).join('')}</div>` : '<div class="sub" style="margin:0 4px">Nenhuma foto. Use “Fotografar”.</div>'}
  <h2>Linha do tempo</h2>
  ${tl.length ? `<div class="tl">${tl.map(e => `<div class="tli glass"><div class="sub">${fmt(e.ts)}</div><div style="margin-top:3px">${e.i} ${esc(e.t)}</div></div>`).join('')}</div>` : ''}
  <div class="gap"></div><div class="btn pri" onclick="location.hash='#exportar/${a.id}'">📤 Exportar / compartilhar</div>
  <div class="grid2" style="margin-top:10px"><div class="btn" onclick="location.hash='#alvo/${a.id}/editar'">✏️ Editar</div><div class="btn dan" id="b_del">🗑️ Excluir</div></div>`;
  if (a.fotos?.length) getImg(a.fotos[a.fotos.length - 1].id).then(u => { if (u && $('#hero')) $('#hero').insertAdjacentHTML('afterbegin', `<img src="${u}">`); });
  loadThumbs();
  $('#b_foto').onclick = () => takePhoto(a);
  $('#b_loc').onclick = () => markPlace(a);
  $('#b_nota').onclick = () => sheet(`<h2 style="margin-top:0">Nova anotação</h2><textarea id="n_t" placeholder="O que foi observado, horário, com quem…" style="min-height:130px"></textarea><div class="gap"></div><div class="btn pri" id="n_ok">Salvar anotação</div>`, s => {
    s.querySelector('#n_t').focus();
    s.querySelector('#n_ok').onclick = async () => { const t = s.querySelector('#n_t').value.trim(); if (!t) return; a.notas = a.notas || []; a.notas.push({id: uid(), ts: Date.now(), txt: t}); await save(); closeSheet(); route(); toast('Anotação salva'); };
  });
  $('#b_del').onclick = async () => {
    if (!await confirmBox(`Excluir o alvo "${a.nome}" com fotos e locais?`, 'Excluir', true)) return;
    for (const f of a.fotos || []) await DB.del('img:' + f.id);
    S.alvos = S.alvos.filter(x => x.id !== a.id); await save(); location.hash = '#op/' + a.opId; toast('Alvo excluído');
  };
}
async function viewer(aid, fid) {
  const a = getAlvo(aid); const f = a.fotos.find(x => x.id === fid); const u = await getImg(fid);
  const d = document.createElement('div'); d.className = 'viewer';
  d.innerHTML = `<img src="${u}"><div class="glass" style="margin-top:14px;padding:12px 16px;max-width:100%;font-size:13px;line-height:1.6">
    ${f.legenda ? `<b>${esc(f.legenda)}</b><br>` : ''}🕒 ${fmt(f.ts)}<br>📍 ${f.lat ? coord(f) + ` (±${f.acc} m)` : 'sem localização'}<br><span class="sub">SHA-256: ${f.hash.slice(0, 32)}…</span></div>
    <div class="grid2" style="margin-top:14px;width:100%;max-width:420px"><div class="btn dan" id="v_del">Excluir foto</div><div class="btn" id="v_x">Fechar</div></div>`;
  document.body.appendChild(d);
  d.querySelector('#v_x').onclick = () => d.remove();
  d.querySelector('#v_del').onclick = async () => { if (!await confirmBox('Excluir esta foto?', 'Excluir', true)) return; a.fotos = a.fotos.filter(x => x.id !== fid); await DB.del('img:' + fid); await save(); d.remove(); route(); };
}

/* ---------- Foto com GPS ---------- */
function resizeJpeg(file, max = 1600) {
  return new Promise((res, rej) => {
    const img = new Image(); const u = URL.createObjectURL(file);
    img.onload = () => { const r = Math.min(1, max / Math.max(img.width, img.height)); const c = document.createElement('canvas'); c.width = Math.round(img.width * r); c.height = Math.round(img.height * r); c.getContext('2d').drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(u); c.toBlob(b => b ? b.arrayBuffer().then(res) : rej(new Error('falha ao processar')), 'image/jpeg', .85); };
    img.onerror = () => rej(new Error('imagem inválida')); img.src = u;
  });
}
function takePhoto(a) {
  const inp = $('#cam'); inp.value = ''; hold(180000);
  const gp = geo(); // GPS começa junto com a câmera
  inp.onchange = async () => {
    release(); const file = inp.files[0]; if (!file) return;
    toast('Processando e criptografando…');
    try {
      const bytes = await resizeJpeg(file); const hash = await sha256(bytes); const pos = await gp;
      const fid = uid(); await putImg(fid, new Uint8Array(bytes));
      sheet(`<h2 style="margin-top:0">Foto salva no cofre</h2><div class="sub">${pos ? `📍 ${coord(pos)} (±${pos.acc} m)` : '⚠️ Sem localização (GPS negado ou indisponível)'}</div><label>Legenda (opcional)</label><input id="p_l" placeholder="Ex.: entrada da residência"><div class="gap"></div><div class="btn pri" id="p_ok">Concluir</div>`, s => {
        const done = async () => { a.fotos = a.fotos || []; a.fotos.push({id: fid, ts: Date.now(), hash, legenda: s.querySelector('#p_l')?.value.trim() || '', ...(pos || {})}); if (pos) { a.locais = a.locais || []; } await save(); closeSheet(); route(); toast('📷 Foto registrada'); };
        s.querySelector('#p_ok').onclick = done;
      });
    } catch (e) { toast('Erro: ' + e.message); }
  };
  inp.click();
}

/* ---------- Marcar local ---------- */
function markPlace(a) {
  let pos = null, m = null, map = null;
  sheet(`<h2 style="margin-top:0">Marcar local</h2>
    <label>Tipo</label><select id="l_t">${Object.entries(TIPOS).filter(([k]) => k !== 'foto').map(([k, v]) => `<option value="${k}">${v[0]} ${v[1]}</option>`).join('')}</select>
    <label>Título</label><input id="l_ti" placeholder="Ex.: casa da mãe">
    <label>Observação</label><input id="l_no" placeholder="Opcional">
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
    s.querySelector('#l_ok').onclick = async () => {
      if (!pos) return toast('Defina a posição (GPS ou mapa)');
      a.locais = a.locais || []; a.locais.push({id: uid(), ts: Date.now(), tipo: s.querySelector('#l_t').value, titulo: s.querySelector('#l_ti').value.trim(), nota: s.querySelector('#l_no').value.trim(), ...pos});
      await save(); if (map) map.remove(); closeSheet(); route(); toast('📍 Local salvo');
    };
  });
}
function lastPoint() { const pts = S.alvos.flatMap(a => [...(a.locais || []), ...(a.fotos || []).filter(f => f.lat)]).sort((x, y) => y.ts - x.ts); return pts[0] ? [pts[0].lat, pts[0].lng] : null; }
const tiles = () => L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {attribution: '© OpenStreetMap', maxZoom: 19, className: 'dark-tiles'});
const pinIcon = t => { const v = TIPOS[t] || TIPOS.outro; return L.divIcon({className: '', html: `<div class="pin" style="background:${v[2]}"><span>${v[0]}</span></div>`, iconSize: [32, 32], iconAnchor: [16, 32], popupAnchor: [0, -30]}); };

/* ---------- Mapa ---------- */
function viewMapa(aid) {
  window._sm = null; tabs('mapa'); const one = aid ? getAlvo(aid) : null;
  const alvos = one ? [one] : S.alvos;
  const pts = [];
  alvos.forEach(a => { (a.locais || []).forEach(l => pts.push({a, lat: l.lat, lng: l.lng, tipo: l.tipo, t: l.titulo || TIPOS[l.tipo]?.[1], n: l.nota, ts: l.ts}));
    (a.fotos || []).filter(f => f.lat).forEach(f => pts.push({a, lat: f.lat, lng: f.lng, tipo: 'foto', t: f.legenda || 'Foto', ts: f.ts})); });
  APP.innerHTML = `${one ? `<div class="back" onclick="location.hash='#alvo/${one.id}'">‹ ${esc(one.nome)}</div>` : ''}
  <div class="top"><div><h1>${one ? 'Mapa do alvo' : 'Mapa geral'}</h1><div class="sub">${pts.length} ponto(s) · ${Object.values(TIPOS).map(v => v[0]).join(' ')}</div></div>${one ? `<div class="btn sm" id="mk">+ Local</div>` : ''}</div>
  <div id="map_search"></div>
  <div class="mapbox" id="map"></div>
  ${pts.length ? '' : '<div class="sub" style="margin:12px 4px">Nenhum ponto ainda. Marque locais ou tire fotos com GPS na ficha do alvo.</div>'}`;
  const map = L.map('map', {zoomControl: false}); window._map = map;
  tiles().addTo(map);
  const b = [];
  pts.forEach(p => { b.push([p.lat, p.lng]); L.marker([p.lat, p.lng], {icon: pinIcon(p.tipo)}).addTo(map).bindPopup(`<b>${esc(p.t)}</b><br><span style="color:#8a9bb8">${esc(p.a.nome)} · ${fmt(p.ts)}</span>${p.n ? '<br>' + esc(p.n) : ''}<br><a href="#alvo/${p.a.id}" style="color:#9cbcff">Abrir ficha</a> · <a target="_blank" href="https://maps.google.com/?q=${p.lat},${p.lng}" style="color:#9cbcff">Rota</a>`); });
  if (b.length) map.fitBounds(b, {padding: [40, 40], maxZoom: 16}); else map.setView([-3.7319, -38.5267], 12);
  mountSearch($('#map_search'), {
    getCenter: () => ({lat: map.getCenter().lat, lng: map.getCenter().lng}),
    onPick: (lat, lng, label) => { map.setView([lat, lng], 16); if (window._sm) window._sm.setLatLng([lat, lng]); else window._sm = L.marker([lat, lng], {draggable: true}).addTo(map); window._sm.bindPopup('🔍 Resultado da busca' + (label ? '<br>' + esc(label) : '') + (one ? `<br><a href="#" onclick="markPlace(getAlvo('${one.id}'));return false" style="color:#9cbcff">Marcar como local</a>` : '')).openPopup(); }
  });
  if (one) $('#mk').onclick = () => markPlace(one);
}

/* ---------- Busca ---------- */
function viewBusca() {
  tabs('busca');
  APP.innerHTML = `<h1 style="margin-bottom:14px">Busca</h1><div class="search glass"><span>🔍</span><input id="q" placeholder="Nome, vulgo, placa, telefone, endereço, nota…" autocomplete="off"></div><div id="res"></div>`;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  const run = () => {
    const q = norm($('#q').value.trim()); const qd = q.replace(/\D/g, '');
    if (q.length < 2) return $('#res').innerHTML = `<div class="empty"><div>🔎</div>Digite ao menos 2 caracteres.<br>${S.alvos.length} alvo(s) no cofre.</div>`;
    const hits = [];
    S.alvos.forEach(a => {
      const f = [['Nome', a.nome], ['Vulgo', a.apelido], ['Documento', a.doc], ['Veículo', a.veic], ['Endereço', a.end], ['Vínculos', a.vinc], ...(a.tels || []).map(t => ['Telefone', t]), ...(a.notas || []).map(n => ['Nota', n.txt]), ...(a.locais || []).map(l => ['Local', (l.titulo || '') + ' ' + (l.nota || '')])];
      const m = f.find(([, v]) => norm(v).includes(q) || (qd.length >= 3 && String(v || '').replace(/\D/g, '').includes(qd)));
      if (m) hits.push([a, m]);
    });
    $('#res').innerHTML = hits.length ? hits.map(([a, [k, v]]) => `<div class="card glass" onclick="location.hash='#alvo/${a.id}'"><div class="t">${esc(a.nome)}</div><div class="sub">${esc(getOp(a.opId)?.nome || '')} · ${k}: ${esc(String(v).slice(0, 80))}</div></div>`).join('') : '<div class="empty"><div>∅</div>Nada encontrado.</div>';
  };
  $('#q').oninput = run; run(); $('#q').focus();
}

/* ---------- Exportar ---------- */
function viewExport(aid) {
  tabs('ops'); const a = getAlvo(aid); if (!a) return location.hash = '#ops';
  const o = {fmt: 'pdf', dados: true, fotos: true, locais: true, notas: true, tl: false, mask: true, marca: true, senha: false};
  const tg = (k, l, d) => `<div class="tgrow"><div>${l}${d ? `<div class="sub">${d}</div>` : ''}</div><div class="tg ${o[k] ? 'on' : ''}" data-k="${k}"></div></div>`;
  APP.innerHTML = `<div class="back" onclick="location.hash='#alvo/${a.id}'">‹ ${esc(a.nome)}</div><h1>Exportar</h1>
  <div class="seg glass" style="margin-top:14px"><div data-f="pdf" class="on">📄 PDF</div><div data-f="img">🖼️ Imagem</div></div>
  <h2>Conteúdo</h2><div class="card glass" style="padding:0;cursor:default">${tg('dados', 'Dados do alvo')}${tg('fotos', 'Fotos', `${a.fotos?.length || 0} disponível(is)`)}${tg('locais', 'Locais e coordenadas')}${tg('notas', 'Anotações')}${tg('tl', 'Linha do tempo completa')}</div>
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
  const dados = [['Nome', a.nome], ['Vulgo', a.apelido], ['Documento', a.doc && doc(a.doc)], ['Telefones', (a.tels || []).map(tel).join(', ')], ['Veículo', a.veic], ['Endereço', a.end], ['Vínculos', a.vinc], ['Prioridade', (PRIO[a.prio] || PRIO.media)[1].replace('Prioridade ', '')], ['Operação', getOp(a.opId)?.nome]].filter(r => r[1]);
  const locais = [...(a.locais || []).map(l => ({t: `${(TIPOS[l.tipo] || TIPOS.outro)[1]}${l.titulo ? ' — ' + l.titulo : ''}`, c: coord(l), n: l.nota, ts: l.ts, url: `https://maps.google.com/?q=${l.lat},${l.lng}`})),
    ...(a.fotos || []).filter(f => f.lat).map(f => ({t: 'Foto' + (f.legenda ? ' — ' + f.legenda : ''), c: coord(f), ts: f.ts, url: `https://maps.google.com/?q=${f.lat},${f.lng}`}))].sort((x, y) => x.ts - y.ts);
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
  if (o.fotos && a.fotos?.length) { title(`Fotos (${a.fotos.length})`);
    for (const f of a.fotos) { const du = await imgDataURL(f.id); if (!du) continue; const p = pdf.getImageProperties(du); const w = 90, h = Math.min(100, w * p.height / p.width); need(h + 16);
      pdf.addImage(du, 'JPEG', M, y, h === 100 ? 100 * p.width / p.height : w, h); pdf.setFontSize(9);
      const tx = M + 96; let ty = y + 4; [f.legenda || 'Foto', fmt(f.ts), f.lat ? `GPS: ${coord(f)} (±${f.acc} m)` : 'Sem GPS', 'SHA-256:', f.hash.slice(0, 32), f.hash.slice(32)].forEach(t => { pdf.text(pdf.splitTextToSize(t, W - M - tx)[0], tx, ty); ty += 5; });
      pdf.setFontSize(10); y += h + 6; } }
  if (o.locais && locais.length) { title('Locais'); locais.forEach(l => { need(12); pdf.setFont(undefined, 'bold'); pdf.text(l.t, M, y); pdf.setFont(undefined, 'normal'); y += 5; pdf.setTextColor(45, 95, 214); pdf.textWithLink(`${l.c}  ·  ${fmt(l.ts)}  ·  abrir no mapa`, M + 4, y, {url: l.url}); pdf.setTextColor(20, 24, 32); y += 5; if (l.n) para(l.n, 4); y += 2; }); }
  if (o.notas && a.notas?.length) { title('Anotações'); a.notas.slice().sort((x, z) => x.ts - z.ts).forEach(n => { need(10); pdf.setFontSize(8.5); pdf.setTextColor(100, 110, 125); pdf.text(fmt(n.ts), M, y); y += 4.5; pdf.setFontSize(10); pdf.setTextColor(20, 24, 32); para(n.txt); y += 2; }); }
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
  if (o.fotos && a.fotos?.length) { sec('Fotos'); const cols = 2, gw = (W - 2 * P - 20) / cols; let i = 0;
    for (const f of a.fotos.slice(0, 8)) { const du = await imgDataURL(f.id); const im = await new Promise(r => { const x = new Image(); x.onload = () => r(x); x.src = du; });
      const x = P + (i % cols) * (gw + 20), h = gw * .75; const r = Math.max(gw / im.width, h / im.height); const sw = gw / r, sh = h / r;
      g.save(); g.beginPath(); g.roundRect ? g.roundRect(x, y, gw, h, 18) : g.rect(x, y, gw, h); g.clip(); g.drawImage(im, (im.width - sw) / 2, (im.height - sh) / 2, sw, sh, x, y, gw, h); g.restore();
      F(20); g.fillStyle = '#aab6c9'; g.fillText(`${fmt(f.ts)}${f.lat ? ' · ' + coord(f) : ''}`.slice(0, 44), x, y + h + 28);
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
  } catch (e) { if (e.name !== 'AbortError') throw e; } finally { release(); }
}

/* ---------- Cofre (backup, segurança) ---------- */
async function viewCofre() {
  tabs('cofre');
  const nf = S.alvos.reduce((s, a) => s + (a.fotos?.length || 0), 0);
  APP.innerHTML = `<h1>Cofre</h1><div class="sub" style="margin:4px 4px 0">${S.ops.length} operação(ões) · ${S.alvos.length} alvo(s) · ${nf} foto(s) — tudo criptografado (AES-256) só neste aparelho</div>
  <h2>Segurança</h2><div class="card glass" style="padding:0;cursor:default">
    <div class="tgrow"><div>Travar automaticamente<div class="sub">após inatividade</div></div><select id="idle" style="width:auto;padding:8px 10px">${[1, 2, 3, 5, 10, 15].map(m => `<option value="${m}" ${idleMin() === m ? 'selected' : ''}>${m} min</option>`).join('')}</select></div>
    <div class="tgrow" id="chpin" style="cursor:pointer"><div>Trocar PIN</div><span class="sub">›</span></div>
    <div class="tgrow" onclick="lock('manual')" style="cursor:pointer"><div>Travar agora</div><span>🔒</span></div></div>
  <h2>Backup</h2><div class="card glass" style="padding:0;cursor:default">
    <div class="tgrow" id="bk" style="cursor:pointer"><div>Exportar backup criptografado<div class="sub">arquivo .cofre — só abre com o PIN atual</div></div><span>⬆️</span></div>
    <div class="tgrow" id="rs" style="cursor:pointer"><div>Restaurar backup<div class="sub">substitui os dados deste aparelho</div></div><span>⬇️</span></div></div>
  <h2>Importar</h2><div class="card glass" style="padding:0;cursor:default">
    <div class="tgrow" id="imp_lote" style="cursor:pointer"><div>Importar em lote<div class="sub">colar lista ou arquivo .txt/.csv (campos separados por |)</div></div><span>⬆️</span></div>
    <div class="tgrow" id="imp_opv" style="cursor:pointer"><div>Importar operação<div class="sub">arquivo .opsvault vindo de outro aparelho — junta com os dados atuais</div></div><span>📦</span></div></div>
  <h2>Zona de perigo</h2><div class="btn dan" id="wipe">Apagar tudo deste aparelho</div>
  <h2>Sobre</h2><div class="card glass" style="cursor:default"><div class="t">${esc(APP_NAME)}</div><div class="sub" style="margin-top:4px">Protótipo v0.3.1 · dados só no aparelho, sem servidor</div><div class="credit" style="text-align:left;margin-top:10px">Criado <b>${esc(CREDIT)}</b></div></div>`;
  $('#imp_lote').onclick = () => importBatch();
  $('#imp_opv').onclick = () => importOpUI();
  $('#idle').onchange = async e => { S.cfg.idle = +e.target.value; await save(); resetIdle(); toast('Trava automática: ' + S.cfg.idle + ' min'); };
  $('#bk').onclick = async () => {
    toast('Montando backup…'); const keys = (await DB.keys()).filter(k => k.startsWith('img:')); const imgs = {};
    for (const k of keys) imgs[k] = await DB.get(k);
    const f = new File([JSON.stringify({app: 'opsvault', v: 1, ts: Date.now(), meta: await DB.get('meta'), data: await DB.get('data'), imgs})], `OpsVault_backup_${fileStamp()}.cofre`, {type: 'application/json'});
    await shareFile(f);
  };
  $('#rs').onclick = () => { pickFile(null, async file => {
    try { const j = JSON.parse(await file.text()); if (j.app !== 'opsvault' || !j.meta || !j.data) throw new Error('arquivo inválido');
      if (!await confirmBox('Restaurar substitui TODOS os dados atuais. Depois, use o PIN do backup para abrir.', 'Restaurar', true)) return;
      await DB.clear(); await DB.set('meta', j.meta); await DB.set('data', j.data); for (const [k, v] of Object.entries(j.imgs || {})) await DB.set(k, v);
      lock('backup restaurado'); } catch (e) { toast('Erro: ' + e.message); } }); };
  $('#wipe').onclick = async () => { if (!await confirmBox('Apagar TODOS os dados? Não há como desfazer.', 'Apagar tudo', true)) return; if (!await confirmBox('Tem certeza absoluta?', 'Sim, apagar', true)) return; await DB.clear(); localStorage.clear(); lock('dados apagados'); };
  $('#chpin').onclick = () => sheet(`<h2 style="margin-top:0">Trocar PIN</h2><label>PIN atual</label><input id="p0" type="password" inputmode="numeric"><label>Novo PIN (mín. 6 dígitos)</label><input id="p1" type="password" inputmode="numeric"><label>Confirmar novo PIN</label><input id="p2" type="password" inputmode="numeric"><div class="gap"></div><div class="btn pri" id="pok">Trocar e recriptografar</div>`, s => {
    s.querySelector('#pok').onclick = async () => {
      const [p0, p1, p2] = ['#p0', '#p1', '#p2'].map(x => s.querySelector(x).value);
      if (!/^\d{6,12}$/.test(p1)) return toast('Novo PIN: 6 a 12 dígitos'); if (p1 !== p2) return toast('Confirmação não confere');
      const meta = await DB.get('meta'); try { await open_(await deriveKey(p0, unb64(meta.salt)), meta.check); } catch { return toast('PIN atual incorreto'); }
      s.querySelector('#pok').textContent = 'Recriptografando…';
      const salt = crypto.getRandomValues(new Uint8Array(16)); const nk = await deriveKey(p1, salt);
      for (const k of (await DB.keys()).filter(k => k.startsWith('img:'))) await DB.set(k, await seal(nk, await open_(KEY, await DB.get(k))));
      await DB.set('meta', {salt: b64(salt), check: await seal(nk, enc.encode('opsvault-ok')), v: 1}); KEY = nk; await save(); closeSheet(); toast('PIN trocado ✔');
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
    ['📷 Fotos com GPS', `<ol><li>Na ficha, toque em <b>Fotografar</b>. A câmera abre e o GPS é lido ao mesmo tempo.</li><li>Na primeira vez, <b>permita câmera e localização</b>.</li><li>A foto vai direto para o cofre, criptografada, com data/hora, coordenadas e um <b>código SHA-256</b> (prova de que não foi alterada).</li><li>A foto <b>não</b> é salva na galeria do celular.</li><li>Toque numa miniatura para ver detalhes ou excluir.</li></ol>`],
    ['📍 Marcar locais', `<ol><li>Na ficha, toque em <b>Marcar local</b>.</li><li>Escolha o tipo (🏠 residência, 🏢 trabalho, 🚗 veículo, 🤝 ponto de encontro, 📍 outro), um título e uma observação.</li><li><b>Estou aqui</b> usa o GPS; <b>Escolher no mapa</b> deixa você tocar no ponto. Arraste o marcador para ajustar.</li></ol>`],
    ['🗺️ Mapa', `<ul><li>A aba <b>Mapa</b> mostra todos os pontos de todos os alvos, com cores por tipo.</li><li>Na ficha, o botão <b>Mapa</b> mostra só aquele alvo.</li><li>Toque num marcador para abrir a ficha ou traçar <b>Rota</b> no Google Maps.</li><li>O fundo do mapa precisa de internet; os pontos ficam no aparelho.</li></ul>`],
    ['🔎 Busca no mapa', `<p>No topo do mapa (em <b>Marcar local</b> e na aba <b>Mapa</b>) há um campo de busca que aceita:</p><ul><li><b>Coordenadas:</b> <span class="kbd">-3.7319, -38.5267</span>, <span class="kbd">-3.7319 -38.5267</span> ou graus/minutos/segundos (ex.: <span class="kbd">3°43'54"S 38°31'36"W</span>).</li><li><b>Links do Google Maps:</b> cole a URL completa (com <span class="kbd">@lat,lng</span>, <span class="kbd">?q=lat,lng</span>, <span class="kbd">ll=</span> ou <span class="kbd">!3d..!4d..</span>). Links curtos <span class="kbd">maps.app.goo.gl</span> não podem ser resolvidos no aparelho — abra no navegador e copie o link completo ou as coordenadas.</li><li><b>Endereços:</b> digite o endereço e toque em <b>Ir</b>. A busca mostra até 5 resultados; toque num para posicionar o marcador e centralizar o mapa.</li></ul><div class="warn" style="margin-bottom:0">Só o <b>termo pesquisado</b> é enviado ao OpenStreetMap (serviço Nominatim). Os dados do alvo <b>não</b> saem do aparelho.</div>`],
    ['⬆️ Importar em lote', `<p>Cadastre vários alvos de uma vez. Na aba <b>Cofre</b> → <b>Importar em lote</b>, ou dentro de uma operação em <b>Importar alvos em lote</b> (já preenche aquela operação).</p><p>Um alvo por linha, campos separados por <b>|</b> (barra vertical):</p><div class="kbd" style="display:block;white-space:normal;word-break:break-all;padding:8px 10px;margin:6px 0">operação|nome|vulgo|documento|telefones|veículo|endereço|vínculos|prioridade|lat|lng</div><p><b>Exemplo:</b></p><div class="kbd" style="display:block;white-space:normal;word-break:break-all;padding:8px 10px;margin:6px 0">Operação Aurora|João da Silva|Jota|00000000000|(85) 90000-0000;(85) 90000-0001|Gol prata ABC1D23|Rua Exemplo, 100|Maria (irmã)|alta|-3.7319|-38.5267</div><ul><li><b>Telefones</b> separados por <span class="kbd">;</span> (ponto e vírgula).</li><li><b>Prioridade</b>: alta / média / baixa (padrão média).</li><li><b>lat/lng</b> são opcionais; quando presentes, criam um local 🏠 “Endereço importado”.</li><li>Linhas em branco e que começam com <span class="kbd">#</span> são ignoradas; um cabeçalho iniciado por <span class="kbd">operação|</span> é pulado.</li><li>Pode <b>colar</b> a lista ou carregar um arquivo <b>.txt/.csv</b>. Use <b>Baixar modelo</b> para um exemplo pronto.</li><li>Antes de salvar há uma <b>pré-visualização</b>: válidos, erros (com número da linha), duplicados (por documento ou nome na mesma operação) e as novas operações a criar.</li></ul>`],
    ['🗒️ Anotações e linha do tempo', `<ul><li><b>Anotar</b> registra observações com data e hora automáticas.</li><li>A <b>linha do tempo</b> junta tudo em ordem: cadastro, edições, fotos, locais e notas.</li></ul>`],
    ['🔍 Busca', `Na aba <b>Busca</b>, digite parte de nome, vulgo, placa, telefone, endereço ou texto de anotação. Números são comparados ignorando pontos e traços.`],
    ['📤 Exportar e mandar no WhatsApp', `<ol><li>Na ficha, toque em <b>Exportar / compartilhar</b>.</li><li>Escolha <b>PDF</b> (relatório com fotos, coordenadas e links de mapa) ou <b>Imagem</b> (um card para visualizar rápido).</li><li>Marque o conteúdo e as proteções: mascarar telefone/documento, marca d’água “RESERVADO” e senha no PDF.</li><li>Toque em <b>Gerar e compartilhar</b> e escolha o <b>WhatsApp</b> (ou outro app) na lista do celular.</li></ol><div class="warn" style="margin-bottom:0">O arquivo enviado sai do cofre. Mande a senha do PDF por outro canal. A senha do PDF é uma proteção básica, não substitui o cofre.</div>`],
    ['💾 Backup e restauração', `<ol><li>Aba <b>Cofre</b> → <b>Exportar backup criptografado</b> gera um arquivo <span class="kbd">.cofre</span>.</li><li>Ele continua criptografado e só abre com o PIN que estava em uso na hora do backup.</li><li>Para trocar de celular: instale o app no novo aparelho, crie qualquer PIN, vá em <b>Restaurar backup</b> e depois abra com o PIN antigo.</li></ol>`],
    ['📦 Passar uma operação para outro aparelho', `<p>Serve para mandar <b>uma operação</b> (com seus alvos, fotos, locais e anotações) para o celular de um colega ou para outro aparelho seu.</p><ol><li>Abra a operação e toque em <b>📦 Exportar operação (outro aparelho)</b>.</li><li>Crie uma <b>senha de transferência</b> (mínimo 6 caracteres) e confirme. Ela é só para este arquivo — não é o seu PIN.</li><li>Envie o arquivo <span class="kbd">.opsvault</span> (WhatsApp, e-mail, cabo…). <b>Mande a senha por outro canal</b> (ligação, pessoalmente, outro app).</li><li>No outro aparelho: aba <b>Cofre</b> → <b>Importar operação</b>, escolha o arquivo e digite a senha de transferência.</li><li>Confira a pré-visualização (operação, nº de alvos e fotos) e toque em <b>Importar</b>.</li></ol><ul><li>A operação é <b>somada</b> ao que já existe; nada do aparelho é apagado.</li><li>Se a mesma operação já existir, escolha <b>Substituir a existente</b> (apaga a antiga, seus alvos e fotos, e põe a recebida no lugar) ou <b>Importar como cópia</b> (fica com as duas; a nova recebe “(cópia)” no nome).</li><li>As fotos são recriptografadas com o PIN do aparelho que recebeu. Cada alvo ganha o registro “Importado de outro aparelho” na linha do tempo.</li></ul><p><b>Diferença para o backup completo:</b> o backup <span class="kbd">.cofre</span> leva <b>o cofre inteiro</b>, só abre com o <b>PIN do backup</b> e, ao restaurar, <b>substitui tudo</b> o que está no aparelho. A exportação de operação leva <b>só uma operação</b>, abre com a <b>senha de transferência</b> e <b>junta</b> com os dados existentes.</p><div class="warn" style="margin-bottom:0">O arquivo .opsvault é criptografado (AES-256) com a senha de transferência. Quem tiver o arquivo <b>e</b> a senha vê tudo da operação — por isso nunca mande os dois juntos.</div>`],
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
    if(low.startsWith('operação|')||low.startsWith('operacao|')) return;
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
  rows.forEach(r=>{ r.dup=null; if(r.errs.length) return; const rd=_digits(r.doc); const opKey=_norm(r.opName);
    r.dup=S.alvos.find(a=>{ if(rd && _digits(a.doc)===rd) return true; if(_norm(a.nome)===_norm(r.nome)){ const ao=getOp(a.opId); if(ao&&_norm(ao.nome)===opKey) return true; } return false; })||null; });
  const valid=rows.filter(r=>!r.errs.length);
  const errRows=rows.filter(r=>r.errs.length);
  const dups=valid.filter(r=>r.dup);
  const state={impDup:false};
  const render=()=>{
    const toImp=valid.filter(r=>!r.dup||state.impDup); const willImport=toImp.length;
    const newOpNames=[]; toImp.forEach(r=>{ const key=_norm(r.opName); if(!existingOpByName[key] && !newOpNames.some(n=>_norm(n)===key)) newOpNames.push(r.opName); });
    sheet(`<h2 style="margin-top:0">Pré-visualização</h2>
      <div class="card glass" style="cursor:default"><div class="row"><div>✅ Válidos</div><b>${valid.length}</b></div><div class="row" style="margin-top:6px"><div>⚠️ Com erro</div><b>${errRows.length}</b></div><div class="row" style="margin-top:6px"><div>🔁 Duplicados</div><b>${dups.length}</b></div><div class="row" style="margin-top:6px"><div>⬆️ Serão importados</div><b>${willImport}</b></div></div>
      ${newOpNames.length?`<h2>Novas operações (${newOpNames.length})</h2><div class="card glass" style="cursor:default;padding:10px 14px;font-size:13px">${newOpNames.map(n=>'🗂️ '+esc(n)).join('<br>')}</div>`:''}
      ${errRows.length?`<h2>Linhas com erro (${errRows.length})</h2><div class="card glass" style="cursor:default;padding:10px 14px;font-size:13px;max-height:170px;overflow:auto">${errRows.map(r=>`Linha ${r.ln}: ${esc(r.nome||'(sem nome)')} — <span style="color:#ffadad">${esc(r.errs.join(', '))}</span>`).join('<br>')}</div>`:''}
      ${dups.length?`<h2>Duplicados (${dups.length})</h2><div class="tgrow card glass" style="cursor:default"><div>Importar duplicados mesmo assim<div class="sub">por padrão são ignorados</div></div><div class="tg ${state.impDup?'on':''}" id="ib_dtg"></div></div><div class="card glass" style="cursor:default;padding:10px 14px;font-size:13px;max-height:150px;overflow:auto">${dups.map(r=>`Linha ${r.ln}: ${esc(r.nome)} — já existe como <b>${esc(r.dup.nome)}</b>`).join('<br>')}</div>`:''}
      <h2>Serão importados</h2><div class="card glass" style="cursor:default;padding:10px 14px;font-size:13px;max-height:180px;overflow:auto">${valid.map(r=>`${r.dup&&!state.impDup?'⏭️':'➕'} ${esc(r.nome)} <span class="sub">· ${esc(r.opName)}${r.lat!=null?' · 📍':''}</span>`).join('<br>')||'<span class="sub">nenhuma linha válida</span>'}</div>
      <div class="gap"></div><div class="grid2"><div class="btn" id="ib_cancel">Cancelar</div><div class="btn pri" id="ib_save">Importar ${willImport}</div></div>`, s=>{
      const dtg=s.querySelector('#ib_dtg'); if(dtg) dtg.onclick=()=>{ state.impDup=!state.impDup; render(); };
      s.querySelector('#ib_cancel').onclick=closeSheet;
      s.querySelector('#ib_save').onclick=()=>doImportBatch(valid, newOpNames, state);
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
  for (const a of alvos) for (const f of a.fotos || []) { const box = await DB.get('img:' + f.id); if (!box) { miss++; continue; } imgs[f.id] = b64(await open_(KEY, box)); }
  const pkg = {app: OPPKG_APP + '-pkg', v: 1, ts: Date.now(), by: CREDIT, op: JSON.parse(JSON.stringify(op)), alvos: JSON.parse(JSON.stringify(alvos)), imgs};
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
  pkg.imgs = pkg.imgs || {};
  return pkg;
}
// mode: 'new' (sem conflito) | 'replace' | 'copy'
async function mergeOpPackage(pkg, mode) {
  const op = JSON.parse(JSON.stringify(pkg.op)), alvos = JSON.parse(JSON.stringify(pkg.alvos)), now = Date.now();
  if (mode === 'replace') {
    const old = S.alvos.filter(a => a.opId === op.id);
    for (const a of old) for (const f of a.fotos || []) { await DB.del('img:' + f.id); if (imgCache.has(f.id)) { URL.revokeObjectURL(imgCache.get(f.id)); imgCache.delete(f.id); } }
    S.alvos = S.alvos.filter(a => a.opId !== op.id); S.ops = S.ops.filter(o => o.id !== op.id);
  }
  const copy = mode === 'copy';
  if (copy || getOp(op.id)) { op.id = uid(); if (copy) op.nome = op.nome + ' (cópia)'; }
  const aIds = new Set(S.alvos.map(a => a.id)); const fIds = new Set(S.alvos.flatMap(a => (a.fotos || []).map(f => f.id)));
  let nf = 0, miss = 0;
  for (const a of alvos) {
    if (copy || aIds.has(a.id)) a.id = uid(); aIds.add(a.id); a.opId = op.id;
    const fotos = [];
    for (const f of a.fotos || []) {
      const data = pkg.imgs[f.id]; if (!data) { miss++; continue; }
      if (copy || fIds.has(f.id)) f.id = uid(); fIds.add(f.id);
      await putImg(f.id, unb64(data)); fotos.push(f); nf++;
    }
    a.fotos = fotos; a.locais = a.locais || []; a.notas = a.notas || []; a.log = a.log || [];
    a.log.push({ts: now, t: 'Importado de outro aparelho'});
  }
  S.ops.push(op); S.alvos.push(...alvos); await save();
  return {op, nAlvos: alvos.length, nFotos: nf, miss};
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
      <div class="row" style="margin-top:8px"><div>👤 Alvos</div><b id="io_na">${pkg.alvos.length}</b></div><div class="row" style="margin-top:6px"><div>📷 Fotos</div><b id="io_nf">${nf}</b></div>
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

/* ---------- Início ---------- */
DB.open().then(route).catch(e => { APP.innerHTML = `<div class="empty">Erro ao abrir o armazenamento: ${esc(e.message)}</div>`; });
if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
