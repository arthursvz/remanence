'use strict';

/*
 * Rémanence mobile : révision du référentiel PSE sur téléphone (page installable, hors ligne).
 *   licence   lien <site>#lic=… émis par Ozone ; signature vérifiée avec la clé publique de la licence Dawn (config.js)
 *   paquet    pack.bin chiffré (PDF, fiches, cartes), gardé chiffré dans IndexedDB ; mis à jour d'après pack.json
 *   progression  propre à chaque personne et à cet appareil : journal des réponses { c, at, g, r } → état FSRS rejoué.
 *             Propriétaire : rejoué par-dessus le planning de Dawn contenu dans le paquet.
 *   « Exporter ma progression » / « Importer ma progression » : fichier .remprog chiffré (sauvegarde, retour vers Dawn).
 * Logique de révision : shared/remanence.js (DawnRemanence), la même que sur le bureau.
 */

const R = window.DawnRemanence;
const X = window.RemCrypto;
const CFG = window.REM_CONFIG || {};
const DAY = 86400000;
const CRITICAL_RETENTION = 0.95;
const BACKUP_NAG_DAYS = 7;
const KIND = { qa: 'Question', cloze: 'Texte à trous', order: 'Ordre des étapes', list: 'Liste à citer', dialog: 'Dialogue', mask: 'Masque', zone: 'Zone de page' };

const S = { lic: null, keys: null, pack: null, data: null, prog: null, srs: new Map(), pdf: null, session: null, screen: 'boot', tab: 'review', busy: '', error: '' };

// ───────────────────────── outils ─────────────────────────

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false && kid !== '') el.append(kid instanceof Node ? kid : String(kid));
  return el;
}
const $ = (s) => document.querySelector(s);
const pad = (n) => String(n).padStart(2, '0');
const dayOf = (t = Date.now()) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const endOfDay = () => { const d = new Date(); d.setHours(23, 59, 59, 999); return d.getTime(); };
const fmtDate = (t) => new Date(t).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
const pct = (x) => (x == null ? '—' : `${Math.round(x * 100)} %`);
const plural = (n, w) => `${n} ${w}${n > 1 ? 's' : ''}`;
const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function toast(msg, err = false) {
  const t = h('div', { class: `toast${err ? ' error' : ''}` }, msg);
  $('#toasts').append(t);
  setTimeout(() => t.remove(), err ? 6000 : 3500);
}

// ───────────────────────── stockage (IndexedDB) ─────────────────────────

let dbp = null;
function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const rq = indexedDB.open('remanence', 1);
      rq.onupgradeneeded = () => rq.result.createObjectStore('kv');
      rq.onsuccess = () => resolve(rq.result);
      rq.onerror = () => reject(rq.error);
    });
  }
  return dbp;
}
async function idb(mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const tx = d.transaction('kv', mode);
    const rq = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(rq && rq.result);
    tx.onerror = () => reject(tx.error || new Error('Stockage indisponible.'));
    tx.onabort = () => reject(tx.error || new Error('Stockage plein ou refusé.'));
  });
}
const get = (k) => idb('readonly', (s) => s.get(k));
const put = (k, v) => idb('readwrite', (s) => s.put(v, k));
const del = (k) => idb('readwrite', (s) => s.delete(k));

const progKey = () => `progress:${S.lic.h}`;
const blankProg = () => ({ log: [], seen: {}, days: {}, cfg: {}, lastBackup: 0, lastSeen: 0 });

/** Enregistre la progression ; une écriture refusée est signalée, jamais ignorée. */
async function saveProg() {
  try {
    await put(progKey(), S.prog);
  } catch (err) {
    toast(`Progression NON enregistrée (${err.message}) : exporte-la maintenant.`, true);
    throw err;
  }
}

function cfg() {
  const c = (S.prog && S.prog.cfg) || {};
  return {
    exam: c.exam || '', newPerDay: Number(c.newPerDay) || 15, maxPerDay: Number(c.maxPerDay) || 200,
    retention: Number(c.retention) || 0.9, cursus: c.cursus === 'PSE1' ? 'PSE1' : 'PSE2', typed: !!c.typed,
  };
}
async function setCfg(patch) {
  S.prog.cfg = { ...S.prog.cfg, ...patch };
  await saveProg();
  render();
}

// ───────────────────────── licence, paquet ─────────────────────────

async function boot() {
  try {
    if (!window.isSecureContext || !crypto.subtle) throw new Error('Cette page doit être ouverte en https.');
    const fromLink = /#lic=/.test(location.hash) ? location.hash.slice(1).replace(/^lic=/, '') : null;
    if (fromLink) history.replaceState(null, '', location.pathname + location.search); // la licence ne reste pas dans l'adresse
    if (fromLink) await installLicence(fromLink, { quiet: true });
    else await loadLicence();
    if (!S.lic) return show('licence');
    if (!(await checkLicence())) return;
    await loadPack();
    if (S.data) show('home');
    checkUpdate(false);
  } catch (err) {
    S.error = err.message;
    show(S.lic ? 'home' : 'licence');
  }
}

async function loadLicence() {
  const rec = await get('licence');
  if (!rec) return;
  S.lic = rec.lic;
  S.keys = { k: rec.k, ok: rec.ok || null };
}

/** Vérifie, puis range la licence : les clés deviennent des CryptoKey non extractables. */
async function installLicence(token, { quiet = false } = {}) {
  const lic = await X.parseLicence(token, CFG.pub);
  if (Date.now() > lic.exp) throw new Error(`Cette licence a expiré le ${fmtDate(lic.exp)}.`);
  const keys = { k: await X.aesKey(lic.k), ok: lic.ok ? await X.aesKey(lic.ok) : null };
  const { k, ok, token: _t, ...pub } = lic;
  const prev = S.lic;
  if (prev && prev.h !== pub.h && !confirm(`Cette licence est au nom de « ${pub.h} » (l’actuelle : « ${prev.h} »). Chaque nom garde sa propre progression sur cet appareil. Continuer ?`)) return false;
  await put('licence', { lic: pub, k: keys.k, ok: keys.ok });
  S.lic = pub;
  S.keys = keys;
  S.prog = null;
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  if (!quiet) toast(`Licence de ${pub.h} installée, valable jusqu’au ${fmtDate(pub.exp)}.`);
  return true;
}

/** Péremption et horloge : à l'expiration, les clés sont effacées (la progression est gardée). */
async function checkLicence() {
  const now = Date.now();
  S.prog = (await get(progKey())) || blankProg();
  if (S.prog.lastSeen && now < S.prog.lastSeen - 1.5 * DAY) {
    S.error = 'L’horloge du téléphone a reculé : remets-la à l’heure pour continuer.';
    show('licence');
    return false;
  }
  if (now > S.lic.exp) {
    await put('licence', { lic: S.lic, k: null, ok: null, expired: true });
    S.keys = { k: null, ok: null };
    S.error = `La licence de ${S.lic.h} a expiré le ${fmtDate(S.lic.exp)}. Demande un nouveau lien ; ta progression est gardée.`;
    show('licence');
    return false;
  }
  if (!S.keys || !S.keys.k) {
    show('licence');
    return false;
  }
  S.prog.lastSeen = Math.max(S.prog.lastSeen || 0, now);
  await saveProg().catch(() => {});
  return true;
}

async function loadPack() {
  const rec = await get('pack');
  if (!rec) return downloadPack();
  if (rec.header.channel !== S.lic.ch) return downloadPack();
  await openPack(rec.buf);
}

async function openPack(buf) {
  const { header, data, pdf } = await X.openPack(buf, S.keys.k);
  let base = {};
  if (S.lic.o && S.keys.ok && data.owner) {
    try { base = (await X.openOwner(data.owner, S.keys.ok, header.packId)).srs || {}; } catch { base = {}; }
  }
  S.pack = header;
  S.data = { ...data, base };
  if (S.pdf) S.pdf.destroy();
  S.pdf = null;
  S.pdfBytes = pdf;
  pageCache.clear();
  textCache.clear();
  rebuildSrs();
}

/** Télécharge pack.bin (progression affichée), vérifie qu'il s'ouvre avec la licence, puis le garde chiffré. */
async function downloadPack(meta) {
  S.busy = 'Téléchargement du paquet…';
  show('busy');
  try {
    const res = await fetch(`pack.bin?v=${encodeURIComponent((meta && meta.packId) || Date.now())}`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`Paquet introuvable sur le site (${res.status}).`);
    const total = Number(res.headers.get('content-length')) || (meta && meta.size) || 0;
    const reader = res.body.getReader();
    const parts = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      const bar = $('#dl-bar');
      if (bar && total) bar.style.width = `${Math.min(100, (got / total) * 100).toFixed(1)}%`;
      const txt = $('#dl-txt');
      if (txt) txt.textContent = `${(got / 1048576).toFixed(1)} Mo${total ? ` / ${(total / 1048576).toFixed(1)} Mo` : ''}`;
    }
    const buf = new Uint8Array(got);
    let o = 0;
    for (const p of parts) { buf.set(p, o); o += p.length; }
    await installPack(buf);
  } finally {
    S.busy = '';
  }
}

async function installPack(buf) {
  const header = X.packHeader(buf);
  if (header.channel !== S.lic.ch) throw new Error('Ce paquet utilise une nouvelle clé : demande un nouveau lien de licence.');
  await openPack(buf); // ne s'enregistre que s'il s'ouvre
  await put('pack', { header, buf: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  toast(`Paquet à jour : ${plural(S.data.cards.length, 'carte')}, ${plural(S.data.fiches.length, 'fiche')}.`);
}

async function checkUpdate(manual) {
  if (!navigator.onLine) { if (manual) toast('Hors ligne : réessaie avec du réseau.', true); return; }
  try {
    const res = await fetch('pack.json', { cache: 'no-store' });
    if (!res.ok) throw new Error(`pack.json : ${res.status}`);
    const meta = await res.json();
    if (S.pack && meta.packId === S.pack.packId) { if (manual) toast('Déjà à jour.'); return; }
    if (meta.channel !== S.lic.ch) { toast('Une nouvelle version existe, mais elle demande un nouveau lien de licence.', true); return; }
    if (S.session) return; // pas en pleine séance
    await downloadPack(meta);
    show('home');
  } catch (err) {
    if (manual) toast(err.message, true);
    if (S.screen === 'busy') show(S.data ? 'home' : 'licence');
  }
}

// ───────────────────────── planning ─────────────────────────

const newSrs = () => ({ state: 'new', due: null, s: 0, d: 0, reps: 0, lapses: 0, last: null });

/** État de chaque carte = planning de base (propriétaire) + journal local rejoué. */
function rebuildSrs() {
  S.srs = new Map();
  if (!S.data) return;
  const byCard = new Map();
  for (const e of S.prog.log) (byCard.get(e.c) || byCard.set(e.c, []).get(e.c)).push(e);
  for (const c of S.data.cards) {
    let s = S.data.base[c.id] || newSrs();
    const from = s.last ? Date.parse(s.last) : 0;
    for (const e of (byCard.get(c.id) || []).sort((a, b) => a.at - b.at)) if (e.at > from) s = R.review(s, e.g, e.at, e.r || 0.9);
    S.srs.set(c.id, s);
  }
}

const fiche = (id) => S.data.fiches.find((f) => f.id === id);
const inCursus = (x) => cfg().cursus === 'PSE2' || x.cursus === 'PSE1';
const active = () => S.data.cards.filter((c) => !c.suspended && inCursus(c));
const critical = (c) => { const f = fiche(c.ficheId); return !!(f && f.critical); };
const retention = (c) => (critical(c) ? Math.max(cfg().retention, CRITICAL_RETENTION) : cfg().retention);
const srsOf = (c) => S.srs.get(c.id) || newSrs();
const daysLeft = () => { const e = cfg().exam; return e ? Math.round((Date.parse(`${e}T12:00:00`) - Date.parse(`${dayOf()}T12:00:00`)) / DAY) : null; };

function stats() {
  const c = cfg();
  const cards = active();
  const dueAll = cards.filter((x) => R.isDue(srsOf(x), endOfDay()));
  const fresh = cards.filter((x) => srsOf(x).state === 'new');
  const recalls = cards.map((x) => R.recall(srsOf(x))).filter((x) => x != null);
  const left = daysLeft();
  const perDay = left != null ? Math.max(c.newPerDay, R.pace(fresh.length, left)) : c.newPerDay;
  const done = (S.prog.days[dayOf()] || {}).n || 0;
  return {
    cards, dueAll, fresh, perDay, left,
    due: dueAll.slice(0, Math.max(0, c.maxPerDay - done)),
    newNow: Math.max(0, Math.min(fresh.length, perDay - (S.prog.seen[dayOf()] || 0))),
    recall: recalls.length ? recalls.reduce((s, x) => s + x, 0) / recalls.length : null,
  };
}

// ───────────────────────── écrans ─────────────────────────

function show(screen) {
  S.screen = screen;
  render();
}

function render() {
  const root = $('#root');
  const cur = $('#cursus');
  cur.hidden = !(S.data && (S.screen === 'home' || S.screen === 'session'));
  for (const b of cur.querySelectorAll('button')) b.setAttribute('aria-pressed', String(S.prog && b.dataset.cursus === cfg().cursus));
  $('#bar-sub').textContent = S.lic ? S.lic.h : 'référentiel PSE';
  const tabs = !!(S.data && S.screen === 'home');
  $('#tabs').hidden = !tabs;
  document.body.classList.toggle('has-tabs', tabs);
  for (const b of document.querySelectorAll('#tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === S.tab));
  $('#tab-dot').hidden = !(tabs && needsBackup());
  const view = S.screen === 'licence' ? licenceView() : S.screen === 'busy' ? busyView() : S.screen === 'session' && S.session ? sessionView()
    : S.screen === 'home' && S.data ? (S.tab === 'account' ? accountView() : homeView()) : S.screen === 'boot' ? h('p', { class: 'muted' }, 'Ouverture…') : licenceView();
  root.replaceChildren(view);
  if (S.screen !== 'session') window.scrollTo(0, 0);
}

for (const b of document.querySelectorAll('#cursus button')) b.addEventListener('click', () => setCfg({ cursus: b.dataset.cursus }));
for (const b of document.querySelectorAll('#tabs button')) b.addEventListener('click', () => { S.tab = b.dataset.tab; render(); });

const needsBackup = () => !!(S.prog && S.prog.log.length && (!S.prog.lastBackup || Date.now() - S.prog.lastBackup > BACKUP_NAG_DAYS * DAY));

function licenceView() {
  const ta = h('textarea', { rows: '4', id: 'lic-in', placeholder: 'Colle ici ton lien de licence (https://…#lic=…) ou la licence (rml1.…)' });
  const go = h('button', { class: 'primary wide', id: 'lic-go' }, 'Installer la licence');
  go.addEventListener('click', async () => {
    go.disabled = true;
    try {
      S.error = '';
      if (!(await installLicence(ta.value))) return;
      if (!(await checkLicence())) return;
      await loadPack();
      show('home');
    } catch (err) {
      S.error = err.message;
      show('licence');
    } finally {
      go.disabled = false;
    }
  });
  return h('div', { class: 'stack' },
    S.error ? h('div', { class: 'callout err' }, S.error) : null,
    h('div', { class: 'card' }, h('div', { class: 'card-body stack' },
      h('h2', {}, S.lic ? 'Licence à renouveler' : 'Bienvenue'),
      h('p', { class: 'muted small' }, 'Rémanence s’ouvre avec un lien de licence personnel, émis depuis Dawn. Ouvre le lien reçu, ou colle-le ci-dessous.'),
      ta, go)),
    h('div', { class: 'card' }, h('div', { class: 'card-body stack' },
      h('span', { class: 'eyebrow' }, 'Éditeur des licences'),
      h('span', { class: 'fp' }, CFG.publisher || 'inconnu'),
      h('p', { class: 'muted small' }, 'Empreinte de la clé qui signe les licences. Le contenu reste chiffré sur ce téléphone ; une licence expirée ne l’ouvre plus.'))),
    S.lic && S.prog && S.prog.log.length ? progressCard() : null);
}

function busyView() {
  return h('div', { class: 'card' }, h('div', { class: 'card-body stack' },
    h('h3', {}, S.busy || 'Un instant…'),
    h('div', { class: 'progress-bar' }, h('span', { id: 'dl-bar' })),
    h('span', { class: 'mono small muted', id: 'dl-txt' }, '')));
}

function stat(label, value, sub) {
  return h('div', { class: 'stat' }, h('span', { class: 'stat-l' }, label), h('b', { class: 'stat-v' }, value), h('span', { class: 'stat-s' }, sub || ' '));
}

function forecast(cards) {
  const days = Array(30).fill(0);
  const t0 = endOfDay();
  for (const c of cards) {
    const s = srsOf(c);
    if (!s.due || s.state === 'new') continue;
    const d = Math.max(0, Math.ceil((Date.parse(s.due) - t0) / DAY));
    if (d < 30) days[d] += 1;
  }
  const max = Math.max(1, ...days);
  return h('div', { class: 'forecast', title: 'Cartes à revoir sur 30 jours' }, ...days.map((n) => h('span', { class: 'fc', style: `height:${Math.round((n / max) * 100)}%` })));
}

function homeView() {
  const st = stats();
  const c = cfg();
  const total = st.due.length + st.newNow;
  const capped = st.dueAll.length - st.due.length;
  const wrap = h('div', { class: 'stack' });
  if (S.error) { wrap.append(h('div', { class: 'callout err' }, S.error)); S.error = ''; }
  if (needsBackup()) {
    const age = S.prog.lastBackup ? Math.floor((Date.now() - S.prog.lastBackup) / DAY) : null;
    wrap.append(h('div', { class: 'callout' }, age != null ? `Dernière sauvegarde il y a ${age} jours. ` : 'Ta progression n’existe que sur ce téléphone. ',
      h('button', { class: 'link', style: 'padding:0;font-size:13px', onclick: () => { S.tab = 'account'; render(); } }, 'Exporter ma progression')));
  }
  wrap.append(h('div', { class: 'stats' },
    stat('À revoir', String(st.due.length), capped ? `${capped} reportée${capped > 1 ? 's' : ''}` : 'aujourd’hui'),
    stat('Nouvelles', String(st.newNow), `${st.fresh.length} jamais vues`),
    stat('Rappel moyen', pct(st.recall), plural(st.cards.length, 'carte')),
    stat('Échéance', st.left == null ? '—' : st.left >= 0 ? `J-${st.left}` : 'passée', st.left != null && st.fresh.length ? `${st.perDay} nouvelles / jour` : 'à régler plus bas')));
  wrap.append(h('div', { class: 'start' },
    h('button', { class: 'primary', id: 'start', disabled: !total, onclick: () => startSession() }, total ? `Commencer la séance (${total})` : 'Rien à revoir aujourd’hui'),
    h('button', { class: 'secondary', id: 'free', disabled: !st.cards.length, onclick: () => startSession({ free: true }) }, `Séance libre (${st.cards.length}) · sans effet sur le planning`)));
  wrap.append(h('div', { class: 'card' }, h('div', { class: 'card-body stack' }, h('span', { class: 'eyebrow' }, 'Prévision · 30 jours'), forecast(st.cards))));

  const exam = h('input', { type: 'date', value: c.exam });
  const per = h('input', { type: 'number', inputmode: 'numeric', min: '1', max: '200', value: String(c.newPerDay) });
  const max = h('input', { type: 'number', inputmode: 'numeric', min: '10', max: '2000', value: String(c.maxPerDay) });
  const ret = h('select', {}, ...[0.85, 0.9, 0.95].map((v) => h('option', { value: String(v), selected: v === c.retention }, `${Math.round(v * 100)} %`)));
  const typed = h('input', { type: 'checkbox', checked: c.typed });
  const save = () => setCfg({ exam: exam.value, newPerDay: Math.min(200, Math.max(1, Number(per.value) || 15)), maxPerDay: Math.min(2000, Math.max(10, Number(max.value) || 200)), retention: Number(ret.value), typed: typed.checked });
  for (const el of [exam, per, max, ret, typed]) el.addEventListener('change', save);
  wrap.append(h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Mon plan')),
    h('div', { class: 'card-body stack' },
      h('div', { class: 'plan' },
        h('label', {}, 'Échéance', exam),
        h('label', {}, 'Nouvelles / jour', per),
        h('label', {}, 'Révisions / jour max.', max),
        h('label', {}, 'Rétention visée', ret)),
      h('label', { class: 'check' }, typed, h('span', {}, 'Taper la réponse avant de la voir')),
      h('p', { class: 'muted small' }, 'Avec une échéance, les nouvelles cartes montent si besoin pour tout avoir vu une semaine avant. Les gestes vitaux visent toujours 95 %.'))));
  return wrap;
}

/** Page « Ma licence » : compte à rebours jusqu'à la fin de la licence, progression (exporter / importer), paquet. */
function accountView() {
  return h('div', { class: 'stack' }, countdownCard(), progressCard(), licenceCard());
}

function countdownParts() {
  const ms = Math.max(0, S.lic.exp - Date.now());
  return { ms, d: Math.floor(ms / DAY), h: Math.floor((ms % DAY) / 3600000), m: Math.floor((ms % 3600000) / 60000), s: Math.floor((ms % 60000) / 1000) };
}

function countdownCard() {
  const c = countdownParts();
  const cell = (id, v, label) => h('div', { class: 'cd-cell' }, h('b', { id }, pad(v)), h('span', {}, label));
  const total = Math.max(1, S.lic.exp - (S.lic.iat || S.lic.exp - DAY));
  const used = Math.min(1, Math.max(0, 1 - c.ms / total));
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Fin de la licence'), h('span', { class: 'mono small muted' }, fmtDate(S.lic.exp))),
    h('div', { class: 'card-body stack' },
      h('div', { class: `countdown${c.d < 7 ? ' warn' : ''}${!c.ms ? ' over' : ''}`, id: 'countdown' },
        cell('cd-d', c.d, c.d > 1 ? 'jours' : 'jour'), cell('cd-h', c.h, 'heures'), cell('cd-m', c.m, 'min'), cell('cd-s', c.s, 's')),
      h('div', { class: 'life' }, h('span', { id: 'cd-life', style: `width:${(used * 100).toFixed(2)}%` })),
      h('div', { class: 'life-legend' }, h('span', {}, S.lic.iat ? `émise le ${fmtDate(S.lic.iat)}` : ''), h('span', {}, `${Math.round(used * 100)} % écoulé`)),
      h('p', { class: 'muted small' }, 'À la fin, le contenu ne s’ouvre plus sur ce téléphone ; ta progression est gardée et revient avec un nouveau lien.')));
}

/** Le compte à rebours avance chaque seconde ; à zéro, la licence est fermée. */
setInterval(() => {
  if (!S.lic || S.screen !== 'home' || S.tab !== 'account' || !$('#cd-s')) return;
  const c = countdownParts();
  for (const [k, v] of [['d', c.d], ['h', c.h], ['m', c.m], ['s', c.s]]) $(`#cd-${k}`).textContent = pad(v);
  const total = Math.max(1, S.lic.exp - (S.lic.iat || S.lic.exp - DAY));
  $('#cd-life').style.width = `${(Math.min(1, Math.max(0, 1 - c.ms / total)) * 100).toFixed(2)}%`;
  if (!c.ms) checkLicence();
}, 1000);

function progressCard() {
  const last = S.prog.lastBackup ? fmtDate(S.prog.lastBackup) : 'jamais';
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Ma progression')),
    h('div', { class: 'card-body stack' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Réponses enregistrées'), h('dd', {}, String(S.prog.log.length)),
        h('dt', {}, 'Dernière sauvegarde'), h('dd', {}, last)),
      h('p', { class: 'muted small' }, 'Elle n’existe que sur ce téléphone, dans ce navigateur. Exporte-la régulièrement : le fichier sert de sauvegarde, et de retour vers Dawn.'),
      h('button', { class: 'primary wide', id: 'prog-export', disabled: !S.keys || !S.keys.k || !S.prog.log.length, onclick: exportProgress }, 'Exporter ma progression'),
      h('button', { class: 'secondary wide', id: 'prog-import', disabled: !S.keys || !S.keys.k, onclick: () => $('#file-progress').click() }, 'Importer ma progression')));
}

function licenceCard() {
  const left = Math.ceil((S.lic.exp - Date.now()) / DAY);
  return h('div', { class: 'card' },
    h('div', { class: 'card-head' }, h('h3', {}, 'Licence et paquet'), h('span', { class: 'small' }, h('span', { class: `led${left <= 7 ? ' warn' : ''}` }), left > 0 ? 'valide' : 'expire aujourd’hui')),
    h('div', { class: 'card-body stack' },
      h('dl', { class: 'kv' },
        h('dt', {}, 'Titulaire'), h('dd', {}, S.lic.h + (S.lic.o ? ' · propriétaire' : '')),
        h('dt', {}, 'Valable jusqu’au'), h('dd', {}, fmtDate(S.lic.exp)),
        h('dt', {}, 'Paquet'), h('dd', {}, S.pack ? `${fmtDate(Date.parse(S.pack.createdAt))} · ${S.data.cards.length} cartes` : '—'),
        h('dt', {}, 'Référentiel'), h('dd', {}, S.data.doc ? `${S.data.doc.name} · ${S.data.doc.pages} p.` : '—')),
      h('div', { class: 'row' },
        h('button', { class: 'secondary', onclick: () => checkUpdate(true) }, 'Vérifier les mises à jour'),
        h('button', { class: 'link', onclick: () => { S.error = ''; show('licence'); } }, 'Changer de licence'))));
}

// ───────────────────────── progression : exporter, importer ─────────────────────────

async function exportProgress() {
  try {
    const header = { channel: S.lic.ch, licence: S.lic.id, holder: S.lic.h, owner: !!S.lic.o, exportedAt: new Date().toISOString(), reviews: S.prog.log.length };
    const bin = await X.sealProgress(S.keys.k, header, { log: S.prog.log, seen: S.prog.seen, days: S.prog.days, cfg: S.prog.cfg });
    const name = `remanence-${norm(S.lic.h).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'progression'}-${dayOf()}.remprog`;
    const file = new File([bin], name, { type: 'application/octet-stream' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: 'Progression Rémanence' });
      } catch (err) {
        if (err.name === 'AbortError') return;
        throw err;
      }
    } else {
      const a = h('a', { href: URL.createObjectURL(file), download: name });
      document.body.append(a);
      a.click();
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
    }
    S.prog.lastBackup = Date.now();
    await saveProg();
    toast(`Progression exportée (${plural(S.prog.log.length, 'réponse')}).`);
    render();
  } catch (err) {
    toast(`Export impossible : ${err.message}`, true);
  }
}

$('#file-progress').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    const head = X.progressHeader(buf);
    if (head.channel !== S.lic.ch) throw new Error('Cette progression vient d’une autre clé de canal que ta licence.');
    if (head.holder !== S.lic.h && !confirm(`Cette progression est celle de « ${head.holder} », pas la tienne (« ${S.lic.h} »). La fusionner quand même ?`)) return;
    const { data } = await X.openProgress(buf, S.keys.k);
    const seen = new Set(S.prog.log.map((x) => `${x.c}|${x.at}`));
    const add = (Array.isArray(data.log) ? data.log : []).filter((x) => x && typeof x.c === 'string' && Number.isFinite(x.at) && x.g >= 1 && x.g <= 4 && !seen.has(`${x.c}|${x.at}`));
    S.prog.log = [...S.prog.log, ...add].sort((a, b) => a.at - b.at);
    for (const [d, n] of Object.entries(data.seen || {})) S.prog.seen[d] = Math.max(S.prog.seen[d] || 0, Number(n) || 0);
    for (const [d, v] of Object.entries(data.days || {})) if (!S.prog.days[d] || (v && v.n > S.prog.days[d].n)) S.prog.days[d] = v;
    if (!Object.keys(S.prog.cfg || {}).length && data.cfg) S.prog.cfg = data.cfg;
    S.prog.lastSeen = Math.max(S.prog.lastSeen || 0, ...add.map((x) => x.at));
    await saveProg();
    rebuildSrs();
    toast(add.length ? `${plural(add.length, 'réponse')} ajoutée${add.length > 1 ? 's' : ''} (${head.exportedAt ? fmtDate(Date.parse(head.exportedAt)) : 'date inconnue'}).` : 'Rien de nouveau : cette progression est déjà là.');
    render();
  } catch (err) {
    toast(`Import impossible : ${err.message}`, true);
  }
});

// ───────────────────────── pages du PDF ─────────────────────────

const pageCache = new Map();
const textCache = new Map();
const PAGE_CACHE_MAX = 16;

async function pdfDoc() {
  if (S.pdf) return S.pdf;
  if (!window.DawnPdf) {
    await new Promise((resolve, reject) => {
      const s = h('script', { src: 'pdfview.js' });
      s.onload = resolve;
      s.onerror = () => reject(new Error('Lecteur PDF introuvable.'));
      document.head.append(s);
    });
  }
  S.pdf = await window.DawnPdf.getDocument({ data: S.pdfBytes.slice(), isEvalSupported: false, disableFontFace: true, verbosity: 0 }).promise;
  return S.pdf;
}

/** Image de la page n à `px` pixels de large (cache réduit : mémoire du téléphone). */
async function bitmap(n, px) {
  px = Math.min(2400, Math.max(200, Math.round(px / 100) * 100));
  const k = `${n}|${px}`;
  if (pageCache.has(k)) { const b = pageCache.get(k); pageCache.delete(k); pageCache.set(k, b); return b; }
  const page = await (await pdfDoc()).getPage(n);
  const vp1 = page.getViewport({ scale: 1 });
  const vp = page.getViewport({ scale: px / vp1.width });
  const c = document.createElement('canvas');
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  await page.render({ canvasContext: c.getContext('2d'), viewport: vp, background: '#ffffff' }).promise;
  const b = await createImageBitmap(c);
  c.width = 0;
  pageCache.set(k, b);
  while (pageCache.size > PAGE_CACHE_MAX) { const old = pageCache.keys().next().value; pageCache.get(old).close(); pageCache.delete(old); }
  return b;
}

const rpct = (v) => `${(v * 100).toFixed(3)}%`;
const dpr = () => Math.min(3, window.devicePixelRatio || 1);

function pageNode(n, masks, onReady) {
  const canvas = h('canvas');
  const layer = h('div', { class: 'layer' }, ...masks.map((r) => h('div', { class: `rect ${r.st}`, style: `left:${rpct(r.x)};top:${rpct(r.y)};width:${rpct(r.w)};height:${rpct(r.h)}` }, r.st === 'target' ? '?' : '')));
  const box = h('div', { class: 'page loading' }, canvas, layer, h('span', { class: 'num' }, `p. ${n}`));
  requestAnimationFrame(async () => {
    try {
      const w = (box.clientWidth || 360) * dpr();
      const b = await bitmap(n, w);
      canvas.width = b.width;
      canvas.height = b.height;
      canvas.getContext('2d').drawImage(b, 0, 0);
      box.classList.remove('loading');
      if (onReady) onReady(box);
    } catch (err) {
      box.classList.remove('loading');
      box.append(h('p', { class: 'small', style: 'color:#b33;padding:8px' }, err.message));
    }
  });
  return box;
}

function cropNode(n, r) {
  const canvas = h('canvas');
  const box = h('div', { class: 'crop loading' }, canvas);
  requestAnimationFrame(async () => {
    try {
      const w = ((box.clientWidth || 340) * dpr()) / Math.max(0.05, r.w);
      const b = await bitmap(n, w);
      const sx = Math.round(r.x * b.width);
      const sy = Math.round(r.y * b.height);
      const sw = Math.max(1, Math.round(r.w * b.width));
      const sh = Math.max(1, Math.round(r.h * b.height));
      canvas.width = sw;
      canvas.height = sh;
      canvas.getContext('2d').drawImage(b, sx, sy, sw, sh, 0, 0, sw, sh);
      box.classList.remove('loading');
    } catch (err) {
      box.classList.remove('loading');
      box.append(h('p', { class: 'small muted' }, err.message));
    }
  });
  return box;
}

/** Mots de la page n (fractions de page), pour comparer une réponse tapée à ce que cachent les masques. */
async function words(n) {
  if (textCache.has(n)) return textCache.get(n);
  const page = await (await pdfDoc()).getPage(n);
  const vp = page.getViewport({ scale: 1 });
  const out = [];
  for (const it of (await page.getTextContent()).items) {
    if (!it.str || !it.str.trim()) continue;
    const hh = (it.height || Math.abs(it.transform[3]) || 10) / vp.height;
    const x = it.transform[4] / vp.width;
    const y = 1 - it.transform[5] / vp.height - hh * 0.85;
    const w = it.width / vp.width;
    for (const m of it.str.matchAll(/\S+/g)) out.push({ t: m[0], x: x + w * (m.index / it.str.length), y, w: w * (m[0].length / it.str.length), h: hh * 1.1 });
  }
  textCache.set(n, out);
  return out;
}
async function textIn(n, rects) {
  const ws = await words(n);
  const inside = (wd, r) => { const cx = wd.x + wd.w / 2; const cy = wd.y + wd.h / 2; return cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h; };
  return rects.map((r) => ws.filter((wd) => inside(wd, r)).map((wd) => wd.t).join(' '));
}

// ───────────────────────── séance ─────────────────────────

function startSession(opts = {}) {
  const vital = (a, b) => Number(critical(b)) - Number(critical(a));
  const byRef = (a, b) => { const fa = fiche(a.ficheId); const fb = fiche(b.ficheId); return (fa ? fa.order : 1e9) - (fb ? fb.order : 1e9) || String(a.createdAt).localeCompare(String(b.createdAt)); };
  let queue;
  if (opts.free) queue = active().sort(() => Math.random() - 0.5);
  else {
    const st = stats();
    const due = st.due.slice().sort((a, b) => vital(a, b) || Date.parse(srsOf(a).due) - Date.parse(srsOf(b).due));
    queue = [...due, ...st.fresh.slice().sort((a, b) => vital(a, b) || byRef(a, b)).slice(0, st.newNow)];
  }
  S.session = { queue: queue.map((c) => c.id), done: 0, again: 0, shown: false, free: !!opts.free, t0: Date.now(), zoom: false };
  show('session');
}

const curCard = () => {
  const s = S.session;
  while (s.queue.length && !S.data.cards.some((c) => c.id === s.queue[0])) s.queue.shift();
  return s.queue.length ? S.data.cards.find((c) => c.id === s.queue[0]) : null;
};

function clozeNodes(text, reveal) {
  let n = 0;
  return String(text || '').split(/(\{\{[^{}]+\}\})/).map((p) => {
    const m = /^\{\{([^{}]+)\}\}$/.exec(p);
    if (!m) return p;
    n += 1;
    return reveal ? h('mark', { class: 'hole on' }, m[1]) : h('span', { class: 'hole' }, `[ ${n} ]`);
  });
}

/** Réplique « victime » / « secouriste » : [question, réponse], sinon null. */
const pair = (t) => { const m = /^(.*?[»"”])\s*\/\s*([«"“].*)$/.exec(t); return m ? [m[1], m[2]] : null; };

/** Réponse tapée : 3 juste, 2 presque (≥ 80 % des caractères), 1 faux. Accents, ponctuation, petits mots ignorés. */
function compare(given, expected) {
  const n = (x) => norm(x).replace(/\b(a|et|de|du|la|le|les|des)\b/g, ' ').replace(/[^a-z0-9%]+/g, '');
  const a = n(given);
  const b = n(expected);
  if (!a || !b) return 1;
  if (a === b) return 3;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return 1 - d[a.length][b.length] / Math.max(a.length, b.length) >= 0.8 ? 2 : 1;
}

async function expected(c) {
  if (c.kind === 'qa') return c.back || '';
  if (c.kind === 'cloze') return R.cloze(c.back).answers.join(' · ');
  if (c.kind === 'mask') { const f = fiche(c.ficheId); return f ? (await textIn(f.page + (c.pg || 0), c.targets.map((i) => c.rects[i]))).join(' · ') : ''; }
  return null;
}

function sessionView() {
  const s = S.session;
  const card = curCard();
  const wrap = h('div', { class: 'stack' });
  wrap.append(h('div', { class: 'sbar' },
    h('span', {}, `${s.done} faite${s.done > 1 ? 's' : ''} · ${s.queue.length} restante${s.queue.length > 1 ? 's' : ''}${s.free ? ' · libre' : ''}`),
    h('button', { class: 'link', onclick: () => { S.session = null; show('home'); } }, 'Terminer')));
  if (!card) {
    wrap.append(h('div', { class: 'card' }, h('div', { class: 'card-body stack' },
      h('h3', {}, 'Séance terminée'),
      h('p', { class: 'muted' }, `${plural(s.done, 'réponse')}, dont ${s.again} à revoir${s.free ? '' : ' dans quelques minutes'}.`),
      h('button', { class: 'primary wide', onclick: () => { S.session = null; show('home'); } }, 'Retour'))));
    return wrap;
  }
  const f = fiche(card.ficheId);
  const srs = srsOf(card);
  const box = h('div', { class: 'card rcard' });
  box.append(h('div', { class: 'rcard-head' },
    f ? h('span', { class: 'code' }, f.code || 'Fiche') : null,
    h('span', { class: 't' }, f ? f.title : KIND[card.kind]),
    srs.lapses >= 4 ? h('span', { class: 'flag' }, 'difficile') : null,
    h('span', { class: `tag ${srs.state}` }, srs.state === 'new' ? 'nouvelle' : `${srs.reps} rév.`)));
  const body = h('div', { class: 'rcard-body' });
  const pageNo = f && f.page ? f.page + (card.pg || 0) : null;
  if (card.kind === 'mask') {
    body.append(h('div', { class: 'q' }, card.title || 'Que cachent les masques ?'));
    if (!pageNo) body.append(h('p', { class: 'muted' }, 'Fiche sans page.'));
    else {
      const masks = card.rects.map((r, i) => ({ ...r, st: card.targets.includes(i) ? (s.shown ? 'shown' : 'target') : 'mask' }));
      const sheet = h('div', { class: `sheet${s.zoom ? ' zoom' : ''}` }, pageNode(pageNo, masks, (el) => {
        const t = el.querySelector('.rect.target, .rect.shown');
        if (t) {
          const sh = el.parentElement;
          sh.scrollTop = Math.max(0, t.offsetTop - sh.clientHeight / 2);
          sh.scrollLeft = Math.max(0, t.offsetLeft - sh.clientWidth / 2);
        }
      }));
      body.append(sheet, h('div', { class: 'sheet-tools' }, h('button', { class: 'link', onclick: () => { s.zoom = !s.zoom; render(); } }, s.zoom ? 'Réduire la page' : 'Agrandir la page')));
    }
  } else if (card.kind === 'zone') {
    body.append(h('div', { class: 'q' }, card.title));
    if (s.shown) body.append(pageNo ? h('div', { class: 'crops' }, ...card.rects.map((r) => cropNode(pageNo + (r.p || 0), r))) : h('p', { class: 'muted' }, 'Fiche sans page.'), card.back ? h('div', { class: 'a' }, card.back) : null);
  } else if (card.kind === 'cloze') {
    body.append(h('div', { class: 'q' }, ...clozeNodes(card.back || card.title, s.shown)));
  } else if (card.kind === 'dialog') {
    if (!s.dlg) s.dlg = { i: 0, open: false, miss: [] };
    const d = s.dlg;
    body.append(h('div', { class: 'q' }, card.title), h('p', { class: 'muted small' }, `Réplique ${Math.min(d.i + 1, card.steps.length)} sur ${card.steps.length} : retrouve-la, puis dévoile-la.`));
    const lines = h('div', { class: 'dialog' });
    card.steps.forEach((t, i) => {
      if (i > d.i) return;
      const open = i < d.i || d.open || s.shown;
      const p = pair(t);
      if (open) lines.append(h('div', { class: `dl${d.miss.includes(i) ? ' miss' : ''}${i === d.i && !s.shown ? ' cur' : ''}` }, t));
      else lines.append(h('div', { class: 'dl cur' }, ...(p ? [p[0], h('span', { class: 'dl-hole' }, ' / « … »')] : [h('span', { class: 'dl-hole' }, '« … »')])));
    });
    body.append(lines);
  } else if (card.kind === 'list') {
    body.append(h('div', { class: 'q' }, card.title), h('p', { class: 'muted small' }, `${card.steps.length} éléments à citer, dans n’importe quel ordre.`));
    if (s.shown) {
      if (!s.found) s.found = new Set();
      body.append(h('div', { class: 'listcheck' }, h('span', { class: 'muted small' }, 'Touche ceux que tu avais cités :'),
        ...card.steps.map((t, i) => h('button', { class: `li${s.found.has(i) ? ' on' : ''}`, onclick: () => { if (s.found.has(i)) s.found.delete(i); else s.found.add(i); render(); } }, t))));
    }
  } else if (card.kind === 'order') {
    body.append(h('div', { class: 'q' }, card.title), s.shown ? null : h('p', { class: 'muted small' }, 'Touche les étapes dans l’ordre.'));
    if (!s.order) s.order = { pool: card.steps.map((t, i) => ({ t, i })).sort(() => Math.random() - 0.5), picked: [], errors: 0 };
    const o = s.order;
    body.append(h('ol', { class: 'steps' }, ...o.picked.map((i) => h('li', { class: 'ok' }, card.steps[i]))));
    if (s.shown) body.append(h('p', { class: 'muted small' }, o.errors ? `${plural(o.errors, 'erreur')} d’ordre.` : 'Sans erreur.'));
    else {
      body.append(h('div', { class: 'pool' }, ...o.pool.filter((x) => !o.picked.includes(x.i)).map((x) => h('button', {
        class: 'secondary',
        onclick: (e) => {
          if (x.i === o.picked.length) {
            o.picked.push(x.i);
            if (o.picked.length === card.steps.length) s.shown = true;
            render();
          } else {
            o.errors += 1;
            const b = e.currentTarget;
            b.classList.add('bad');
            setTimeout(() => b.classList.remove('bad'), 400);
          }
        },
      }, x.t))));
    }
  } else {
    body.append(h('div', { class: 'q' }, card.title));
    if (s.shown) body.append(h('div', { class: 'a' }, card.back || '—'));
  }
  const typable = cfg().typed && ['qa', 'cloze', 'mask'].includes(card.kind);
  if (typable && !s.shown) {
    const inp = h('input', { class: 'typed', placeholder: 'Ta réponse', autocomplete: 'off', autocapitalize: 'off', enterkeyhint: 'done', value: s.typed || '' });
    inp.addEventListener('input', () => { s.typed = inp.value; });
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); reveal(); } });
    body.append(inp);
  } else if (typable && s.shown && s.check) {
    body.append(h('div', { class: `check-res g${s.check.grade}` }, h('span', { class: 'muted small' }, 'Ta réponse : '), s.typed || '—', h('br'), h('span', { class: 'muted small' }, 'Attendu : '), s.check.expected || '—'));
  }
  box.append(body);
  if (!s.shown) {
    if (card.kind === 'dialog') {
      const open = s.dlg && s.dlg.open;
      box.append(h('div', { class: 'actions' },
        h('button', { class: 'primary', id: 'reveal', onclick: reveal }, open ? 'Trouvée, suivante' : 'Dévoiler la réplique'),
        open ? h('button', { class: 'secondary', onclick: dialogMiss }, 'Ratée') : null));
    } else if (card.kind !== 'order') box.append(h('div', { class: 'actions' }, h('button', { class: 'primary', id: 'reveal', onclick: reveal }, 'Afficher la réponse')));
  } else {
    const prev = R.preview(srs, Date.now(), retention(card));
    const ratio = card.kind === 'list' ? (s.found ? s.found.size : 0) / card.steps.length : null;
    const suggest = card.kind === 'order' ? (s.order.errors === 0 ? 3 : s.order.errors === 1 ? 2 : 1)
      : card.kind === 'list' ? (ratio >= 0.9 ? 3 : ratio >= 0.6 ? 2 : 1)
        : card.kind === 'dialog' ? (!s.dlg.miss.length ? 3 : s.dlg.miss.length <= card.steps.length / 4 ? 2 : 1)
          : s.check ? s.check.grade : null;
    box.append(h('div', { class: 'grades' }, ...[1, 2, 3, 4].map((g) => h('button', { class: `grade g${g}${suggest === g ? ' suggest' : ''}`, 'data-grade': String(g), onclick: () => grade(g) },
      h('b', {}, R.GRADE_LABELS[g]), h('span', {}, s.free ? ' ' : prev[g])))));
  }
  wrap.append(box);
  return wrap;
}

function dialogNext() {
  const s = S.session;
  s.dlg.i += 1;
  s.dlg.open = false;
  if (s.dlg.i >= curCard().steps.length) s.shown = true;
}
function dialogMiss() {
  const s = S.session;
  if (!s.dlg || !s.dlg.open) return;
  s.dlg.miss.push(s.dlg.i);
  dialogNext();
  render();
}

async function reveal() {
  const s = S.session;
  if (!s || s.shown) return;
  const card = curCard();
  s.check = null;
  if (card.kind === 'dialog') {
    const d = s.dlg || (s.dlg = { i: 0, open: false, miss: [] });
    if (!d.open) d.open = true;
    else dialogNext();
    return render();
  }
  if (cfg().typed && ['qa', 'cloze', 'mask'].includes(card.kind)) {
    try { const e = await expected(card); s.check = { expected: e, grade: compare(s.typed, e) }; } catch { /* page illisible : pas de comparaison */ }
  }
  s.shown = true;
  render();
}

async function grade(g) {
  const s = S.session;
  const card = s && curCard();
  if (!card || !s.shown || s.busy) return;
  s.busy = true;
  try {
    if (!s.free) {
      const now = Date.now();
      const before = srsOf(card);
      const r = retention(card);
      S.prog.log.push({ c: card.id, at: now, g, r });
      S.srs.set(card.id, R.review(before, g, now, r));
      const day = dayOf(now);
      if (before.state === 'new') S.prog.seen[day] = (S.prog.seen[day] || 0) + 1;
      const d = S.prog.days[day] || { n: 0, ms: 0 };
      S.prog.days[day] = { n: d.n + 1, ms: d.ms + Math.min(120000, now - s.t0) };
      S.prog.lastSeen = Math.max(S.prog.lastSeen || 0, now);
      await saveProg();
    }
    s.queue.shift();
    s.done += 1;
    if (g === 1) { s.again += 1; s.queue.splice(Math.min(s.queue.length, 4), 0, card.id); }
    Object.assign(s, { shown: false, order: null, found: null, dlg: null, typed: '', check: null, t0: Date.now() });
  } catch { /* déjà signalé par saveProg */ } finally {
    s.busy = false;
    render();
    window.scrollTo(0, 0);
  }
}

// ───────────────────────── démarrage ─────────────────────────

if ('serviceWorker' in navigator && window.isSecureContext) navigator.serviceWorker.register('sw.js').catch(() => {});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && S.lic && S.screen === 'home') checkLicence().then((ok) => ok && render()); });
window.addEventListener('hashchange', () => { if (/#lic=/.test(location.hash)) boot(); });
boot();
