'use strict';

/*
 * Rémanence mobile › Fil : révision détente, à la place d'un réseau social. Un écran par format, on glisse vers le haut
 * pour passer au suivant, sans fin ; les formats sont tirés au hasard : vrai / faux, curseur, pourquoi, qui suis-je,
 * zoom, story de fiche, ordre, tempo.
 * Rien ici ne touche au planning (FSRS) ni au journal de progression : seule la série (record) est gardée, sur l'appareil.
 * Contenu tiré du paquet (pages du PDF, cartes « ordre ») et, si la licence les donne, des atteintes des cas concrets.
 * Dépend d'app.js (h, $, S, render, toast, fiche, inCursus, cfg, words, bitmap, pageNode, dpr, norm). Préfixe fd.
 */

// ───────────────────────── logique pure (testée sous Node) ─────────────────────────

const FDX = (() => {
  const NUM = '\\d+(?:[,.]\\d+)?';
  const UNIT = '(?:L\\s?/\\s?min|l\\s?/\\s?min|g\\s?/\\s?l|mg\\s?/\\s?dl|mmol\\s?/\\s?l|mmHg|°\\s?C|cm|mm|km|kg|mL|ml|litres?|minutes?|min|secondes?|sec|heures?|jours?|mois|ans?|fois|compressions|insufflations|claques|%|g|h|m|s)';
  // valeur + unité ; pas « 16 x 14 cm », pas « g/l » pris pour « g »
  const VALUE = new RegExp(`(?<![\\w,.\\/])(?<!x\\s)(${NUM})(?:\\s*(à|-|–|et)\\s*(${NUM}))?\\s*(${UNIT})(?![\\wÀ-ÿ'’/])`, 'g');
  const BULLET = /^[•·▪●○◦§oq\-–]\s+/; // « q » : puce Wingdings du PDF
  const HEADER = /\b\d{2}\s?(?:AC|PR|FT)\s?\d{2}\b|PSE\s?[①②]/;
  const toNum = (s) => Number(String(s).replace(',', '.'));

  /** Valeurs chiffrées d'une phrase (avec unité : pas de numéros de page ni de codes). */
  function values(text) {
    const out = [];
    for (const m of String(text).matchAll(VALUE)) {
      const a = toNum(m[1]);
      const b = m[3] != null ? toNum(m[3]) : null;
      if (!Number.isFinite(a) || (b != null && !(b > a))) continue;
      out.push({ index: m.index, len: m[0].length, a, b, sep: m[2] || null, unit: m[4], comma: /,/.test(m[1] + (m[3] || '')), dec: /[,.]/.test(m[1] + (m[3] || '')), raw: m[0] });
    }
    return out;
  }

  const fmt = (n, v) => { const s = String(v.dec ? Math.round(n * 10) / 10 : Math.round(n)); return v.comma ? s.replace('.', ',') : s; };
  const valueText = (v, a = v.a, b = v.b) => (b != null ? `${fmt(a, v)} ${v.sep} ${fmt(b, v)} ${v.unit}` : `${fmt(a, v)} ${v.unit}`);

  /** Une valeur fausse mais plausible (jamais égale à la vraie). */
  function alter(v, rnd = Math.random) {
    const facs = [0.5, 2, 1.5, 0.6, 3, 0.75];
    const temp = /°/.test(v.unit); // températures : quelques degrés d'écart, pas un facteur
    for (let k = 0; k < 12; k++) {
      const f = facs[Math.floor(rnd() * facs.length)];
      const d = (rnd() < 0.5 ? -1 : 1) * (1 + Math.floor(rnd() * 3));
      const move = (x) => (temp ? x + d : v.dec ? Math.round(x * f * 10) / 10 : Math.round(x * f));
      let a = move(v.a);
      let b = v.b == null ? null : move(v.b);
      if (v.unit === '%' && (b != null ? b : a) > 100) continue;
      if (a <= 0) continue;
      if (b != null && !(b > a)) b = a + Math.max(1, v.b - v.a);
      if (a === v.a && (b == null || b === v.b)) continue;
      return { a, b, text: valueText(v, a, b) };
    }
    const a = v.a + (v.a >= 10 ? 10 : 1);
    return { a, b: v.b == null ? null : v.b + (v.a >= 10 ? 10 : 1), text: valueText(v, a, v.b == null ? null : v.b + (v.a >= 10 ? 10 : 1)) };
  }

  /** Réglette du curseur : bornes, pas, tolérance, zone juste. */
  function slider(v) {
    const top = v.b != null ? v.b : v.a;
    if (/°/.test(v.unit)) { // températures : réglette resserrée, au demi-degré
      const min = Math.floor(v.a - 8);
      const max = Math.ceil(top + 8);
      const lo = v.b != null ? v.a - 0.25 : v.a - 0.5;
      const up = v.b != null ? v.b + 0.25 : v.a + 0.5;
      return { min, max, step: 0.5, ok: (x) => x >= lo - 1e-9 && x <= up + 1e-9, zone: [v.b != null ? v.a : lo, v.b != null ? v.b : up] };
    }
    const raw = v.unit === '%' ? 100 : top * 2.2 + (top < 4 ? 2 : 0);
    const mag = 10 ** Math.floor(Math.log10(Math.max(1, raw)));
    const max = v.unit === '%' ? 100 : Math.ceil(raw / (mag / 2)) * (mag / 2);
    const step = v.unit === '%' ? 1 : max <= 6 ? (v.dec ? 0.1 : 0.5) : max <= 15 ? (v.dec ? 0.5 : 1) : max <= 80 ? 1 : max <= 400 ? 5 : 10;
    const tol = v.b != null ? step / 2 : Math.max(step / 2, v.a * 0.05);
    const lo = v.a - tol;
    const up = (v.b != null ? v.b : v.a) + tol;
    return { min: 0, max, step, ok: (x) => x >= lo - 1e-9 && x <= up + 1e-9, zone: v.b != null ? [v.a, v.b] : [Math.max(0, lo), Math.min(max, up)] };
  }

  /** Lignes d'une page à partir de ses mots (fractions de page), en-tête et pied écartés. */
  function lines(ws) {
    const sorted = ws.slice().sort((p, q) => p.y - q.y || p.x - q.x);
    const out = [];
    for (const w of sorted) {
      const last = out[out.length - 1];
      if (last && Math.abs(w.y - last.y) < Math.max(0.004, w.h * 0.45)) { last.ws.push(w); last.h = Math.max(last.h, w.h); } else out.push({ y: w.y, h: w.h, ws: [w] });
    }
    // mots recollés sans espace quand ils se touchent (un mot coupé entre deux morceaux de texte du PDF)
    const join = (ws) => ws.reduce((t, w, k) => (k ? t + (w.x - (ws[k - 1].x + ws[k - 1].w) < w.h * 0.12 ? '' : ' ') + w.t : w.t), '');
    return out.map((l) => { l.ws.sort((p, q) => p.x - q.x); return { y: l.y, h: l.h, x: l.ws[0].x, text: join(l.ws).replace(/\s+([,.;:)])/g, '$1').replace(/(\S) - (\S)/g, '$1-$2') }; })
      .filter((l) => l.y > 0.035 && l.y < 0.955 && !HEADER.test(l.text) && /[a-zà-ÿ]/.test(l.text));
  }

  /** Lignes → segments (puces et fins de phrase coupent ; les suites de ligne sont recousues). */
  function segments(ls) {
    const out = [];
    let cur = '';
    let prev = null;
    const flush = () => { const t = cur.replace(/\s+/g, ' ').trim(); if (t) out.push(t); cur = ''; };
    for (const l of ls) {
      const t = l.text.trim();
      // nouvelle unité : puce, fin de phrase, majuscule en tête (intertitre au-dessus), ou changement de taille de police
      const head = /^[A-ZÀ-Ý]/.test(t) && !/[,(]$/.test(cur.trim());
      const size = prev && Math.abs(l.h - prev.h) > prev.h * 0.18;
      prev = l;
      if (BULLET.test(t) || /[.;:!?]$/.test(cur.trim()) || !cur || head || size) { flush(); cur = t.replace(BULLET, '').replace(/^\d\s+(?=[A-ZÀ-Ý])/, ''); continue; } // « 1 La… » : renvoi de note en tête
      cur = /-$/.test(cur) && /^[a-zà-ÿ]/.test(t) ? cur.slice(0, -1) + t : `${cur} ${t}`;
    }
    flush();
    return out;
  }

  /** Phrases d'un segment, gardées si elles se lisent seules. */
  function sentences(segs) {
    const out = [];
    for (const s of segs) {
      for (const p of s.split(/(?<=[.;!?])\s+(?=[A-ZÀ-Ý0-9«])/)) {
        const t = p.trim().replace(/[;:]$/, '.');
        const nw = t.split(/\s+/).length;
        if (t.length >= 25 && t.length <= 260 && nw >= 5 && /[a-zà-ÿ]{3}/.test(t) && !/[•▪●]/.test(t)) out.push(/[.!?]$/.test(t) ? t : `${t}.`);
      }
    }
    return out;
  }

  /** Phrases porteuses d'une valeur chiffrée : [{ text, v }]. */
  function valued(sents) {
    const out = [];
    for (const t of sents) {
      const vs = values(t);
      const vv = vs.filter((v) => v.a > 0);
      // « pouls1 » : renvoi de note collé au mot, phrase coupée de son contexte
      if (vv.length >= 1 && vs.length <= 3 && !/[a-zà-ÿ]{3}\d\b/.test(t)) out.push({ text: t, v: vv[Math.floor(Math.random() * vv.length)] });
    }
    return out;
  }

  /** Fréquence (par minute) d'une suite d'appuis : médiane des intervalles. */
  function bpm(taps) {
    if (taps.length < 4) return null;
    const d = [];
    for (let k = 1; k < taps.length; k++) d.push(taps[k] - taps[k - 1]);
    d.sort((p, q) => p - q);
    const med = d[Math.floor(d.length / 2)];
    return med > 0 ? Math.round(60000 / med) : null;
  }

  const shuffle = (a, rnd = Math.random) => { const x = a.slice(); for (let k = x.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [x[k], x[j]] = [x[j], x[k]]; } return x; };

  return { values, alter, slider, valueText, lines, segments, sentences, valued, bpm, shuffle, HEADER };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = FDX;

// ───────────────────────── fil (page) ─────────────────────────

const FD_BEST = 'rem.feed.best';
const FD = { node: null, list: null, scroll: 0, busy: null, streak: 0, best: 0, recent: [], text: new Map(), obs: null, chip: null };
try { FD.best = Number(localStorage.getItem(FD_BEST)) || 0; } catch { FD.best = 0; }

const fdPick = (a) => a[Math.floor(Math.random() * a.length)];
// fiches pas vues récemment ; toutes si le référentiel est trop petit pour ça
const fdFiches = () => { const all = S.data.fiches.filter((f) => f.page && inCursus(f)); const fresh = all.filter((f) => !FD.recent.includes(f.id)); return fresh.length ? fresh : all; };
const fdRef = (f) => (f ? h('button', { class: 'fd-ref', onclick: () => fdOpenFiche(f) }, h('span', { class: 'mono' }, f.code || ''), ' ', f.title, ' ›') : null);
const fdRemember = (f) => { FD.recent.push(f.id); if (FD.recent.length > 14) FD.recent.shift(); };

/** Réussite / échec d'un format : la série seulement (jamais le planning). */
function fdScore(ok) {
  FD.streak = ok ? FD.streak + 1 : 0;
  if (FD.streak > FD.best) { FD.best = FD.streak; try { localStorage.setItem(FD_BEST, String(FD.best)); } catch { /* stockage indisponible */ } }
  if (navigator.vibrate) { try { navigator.vibrate(ok ? 18 : [30, 60, 30]); } catch { /* sans vibreur */ } }
  fdChip();
}
function fdChip() {
  if (!FD.chip) return;
  FD.chip.replaceChildren(h('span', { class: `fd-flame${FD.streak >= 3 ? ' on' : ''}` }), `série ${FD.streak}`, h('span', { class: 'dim' }, ` · record ${FD.best}`));
}

/** Phrases d'une fiche (pages du PDF), en cache. */
async function fdText(f) {
  if (FD.text.has(f.id)) return FD.text.get(f.id);
  const segs = [];
  const end = Math.min(f.pageEnd || f.page, f.page + 5);
  for (let n = f.page; n <= end; n++) segs.push(...FDX.segments(FDX.lines(await words(n))));
  const out = { segs, sents: FDX.sentences(segs) };
  FD.text.set(f.id, out);
  if (FD.text.size > 60) FD.text.delete(FD.text.keys().next().value);
  return out;
}

/** Fiche en grand, par-dessus le fil : ses pages, à faire défiler. */
function fdOpenFiche(f, from = f.page) {
  const end = Math.min(f.pageEnd || f.page, f.page + 12);
  const pages = [];
  for (let n = f.page; n <= end; n++) pages.push(pageNode(n, []));
  const box = h('div', { class: 'fd-over', role: 'dialog', 'aria-label': f.title },
    h('div', { class: 'fd-over-head' }, h('div', { class: 'fd-over-title' }, h('span', { class: 'mono dim' }, f.code || ''), h('b', {}, f.title)), h('button', { class: 'secondary', onclick: () => box.remove() }, 'Fermer')),
    h('div', { class: 'fd-over-body' }, ...pages));
  document.body.append(box);
  const at = pages[from - f.page];
  if (at && from > f.page) requestAnimationFrame(() => at.scrollIntoView());
}

const fdSlide = (kind, label, ...kids) => h('section', { class: `fd-slide fd-${kind}` }, h('div', { class: 'fd-in' }, h('div', { class: 'fd-kind' }, label), ...kids));

// ── 1. Vrai / Faux au glissé ──
async function fdVF() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const cand = FDX.valued((await fdText(f)).sents);
  if (!cand.length) return null;
  fdRemember(f);
  const { text, v } = fdPick(cand);
  const truth = Math.random() < 0.5;
  const shown = truth ? text : text.slice(0, v.index) + FDX.alter(v).text + text.slice(v.index + v.len);
  const card = h('div', { class: 'fd-vf-card' }, h('p', { class: 'fd-big' }, shown));
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const answer = (said) => {
    if (done) return;
    done = true;
    const ok = said === truth;
    fdScore(ok);
    card.classList.add(said ? 'go-right' : 'go-left');
    btns.hidden = true;
    out.replaceChildren(
      h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, ` · c’était ${truth ? 'vrai' : 'faux'}`)),
      h('p', { class: 'fd-quote' }, text.slice(0, v.index), h('mark', {}, text.slice(v.index, v.index + v.len)), text.slice(v.index + v.len)),
      fdRef(f));
  };
  const btns = h('div', { class: 'fd-vf-btns' }, h('button', { class: 'fd-no', onclick: () => answer(false) }, '← Faux'), h('button', { class: 'fd-yes', onclick: () => answer(true) }, 'Vrai →'));
  // glissé horizontal sur la carte ; le défilement vertical reste au fil (touch-action: pan-y)
  let x0 = null;
  card.addEventListener('pointerdown', (e) => { if (!done) { x0 = e.clientX; card.setPointerCapture(e.pointerId); } });
  card.addEventListener('pointermove', (e) => { if (x0 == null) return; const dx = e.clientX - x0; card.style.transform = `translateX(${dx}px) rotate(${dx / 30}deg)`; card.dataset.lean = dx > 30 ? 'yes' : dx < -30 ? 'no' : ''; });
  const end = (e) => { if (x0 == null) return; const dx = e.clientX - x0; x0 = null; card.style.transform = ''; card.dataset.lean = ''; if (Math.abs(dx) > 90) answer(dx > 0); };
  card.addEventListener('pointerup', end);
  card.addEventListener('pointercancel', () => { x0 = null; card.style.transform = ''; card.dataset.lean = ''; });
  return fdSlide('vf', 'Vrai ou faux ?', card, btns, out);
}

// ── 2. Le curseur ──
async function fdSlider() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const cand = FDX.valued((await fdText(f)).sents).filter((c) => c.v.unit !== 'fois');
  if (!cand.length) return null;
  fdRemember(f);
  const { text, v } = fdPick(cand);
  const R0 = FDX.slider(v);
  const start = R0.min + Math.round(((R0.max - R0.min) * (0.15 + Math.random() * 0.7)) / R0.step) * R0.step;
  const read = h('div', { class: 'fd-read mono' });
  const show = (x) => read.replaceChildren(String(Math.round(x * 10) / 10).replace('.', v.comma ? ',' : '.'), h('span', { class: 'dim' }, ` ${v.unit}`));
  const range = h('input', { type: 'range', class: 'fd-range', min: String(R0.min), max: String(R0.max), step: String(R0.step), value: String(start) });
  range.addEventListener('input', () => show(Number(range.value)));
  show(start);
  const zone = h('div', { class: 'fd-zone', hidden: true });
  const out = h('div', { class: 'fd-out' });
  const go = h('button', { class: 'primary fd-go', onclick: () => {
    const x = Number(range.value);
    const ok = R0.ok(x);
    fdScore(ok);
    range.disabled = true;
    go.hidden = true;
    zone.hidden = false;
    const span = R0.max - R0.min;
    zone.style.left = `${((R0.zone[0] - R0.min) / span) * 100}%`;
    zone.style.width = `${Math.max(1.5, ((R0.zone[1] - R0.zone[0]) / span) * 100)}%`;
    out.replaceChildren(
      h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Pile dans la zone' : 'À côté', h('span', { class: 'dim' }, ` · ${FDX.valueText(v)}`)),
      h('p', { class: 'fd-quote' }, text.slice(0, v.index), h('mark', {}, text.slice(v.index, v.index + v.len)), text.slice(v.index + v.len)),
      fdRef(f));
  } }, 'Valider');
  return fdSlide('slider', 'Le bon chiffre',
    h('p', { class: 'fd-big' }, text.slice(0, v.index), h('span', { class: 'fd-blank' }, '?'), ` ${v.unit}`, text.slice(v.index + v.len)),
    read, h('div', { class: 'fd-track' }, range, zone), go, out);
}

// ── 3. Pourquoi ? ──
async function fdWhy() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const { segs } = await fdText(f);
  const cand = [];
  for (const s of segs) {
    const t = /[.!?]$/.test(s) ? s : `${s}.`;
    for (const c of window.DawnRemanence.whyClauses(t)) cand.push({ t, c });
  }
  if (!cand.length) return null;
  fdRemember(f);
  const { t, c } = fdPick(cand);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const act = cap(t.slice(...c.act).replace(/[.,;:]+$/, ''));
  const why = t.slice(...c.why).replace(/[.,;:]+$/, '');
  const reverse = c.purpose && Math.random() < 0.35;
  const q = reverse ? `Que faire ${c.conn} ${why} ?` : act;
  const ans = reverse ? act : `${cap(c.conn)} ${why}.`;
  const out = h('div', { class: 'fd-out' });
  const tap = h('button', { class: 'fd-tap', onclick: () => { tap.remove(); out.replaceChildren(h('p', { class: 'fd-answer' }, ans), fdRef(f)); } }, 'Touche pour voir');
  return fdSlide('why', reverse ? 'Que faire ?' : 'Pourquoi ?', h('p', { class: 'fd-big' }, q), tap, out);
}

// ── 4. Qui suis-je ? (atteintes des cas concrets) ──
// l'énigme vient de sim.js (chiffré avec les cas concrets) : rien du moteur ni des atteintes dans ce fichier en clair
function fdWhoOk() { return !!(S.ent && S.ent.mod.sim && S.simLoaded && typeof msWhoQuiz === 'function'); }
async function fdWho() {
  const q = msWhoQuiz(); // { id, title, clues, options: [{ id, title }] }
  if (!q) return null;
  const { id, clues } = q;
  const opts = FDX.shuffle(q.options);
  let shown = 1;
  let done = false;
  let timer = 0;
  const list = h('div', { class: 'fd-clues' });
  const count = h('div', { class: 'small dim mono' });
  const paint = () => {
    list.replaceChildren(...clues.slice(0, shown).map((c, k) => h('p', { class: `fd-clue${k === shown - 1 && !done ? ' new' : ''}` }, c)));
    list.scrollTop = list.scrollHeight; // le dernier indice reste en vue
    count.textContent = `indice ${shown} / ${clues.length}`;
    more.hidden = done || shown >= clues.length;
  };
  const more = h('button', { class: 'link', onclick: () => { shown = Math.min(clues.length, shown + 1); paint(); } }, 'Indice suivant');
  const out = h('div', { class: 'fd-out' });
  const choose = (b, btn) => {
    if (done) return;
    done = true;
    clearInterval(timer);
    const ok = b === id;
    const found = shown;
    fdScore(ok);
    shown = clues.length;
    paint();
    for (const x of btns.children) { x.disabled = true; if (x.dataset.id === id) x.classList.add('right'); }
    if (!ok) btn.classList.add('wrong');
    const play = typeof MS !== 'undefined' ? h('button', { class: 'secondary', onclick: () => { MS.brick = id; S.tab = 'sim'; render(); } }, 'Jouer ce cas ›') : null;
    out.replaceChildren(h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? (found <= 2 ? 'Trouvé très vite' : 'Trouvé') : 'Raté', h('span', { class: 'dim' }, ` · ${q.title}`)), play);
  };
  const btns = h('div', { class: 'fd-opts' }, ...opts.map((o) => { const x = h('button', { 'data-id': o.id, onclick: () => choose(o.id, x) }, o.title); return x; }));
  paint();
  const slide = fdSlide('who', 'Qui suis-je ?', count, list, more, btns, out);
  slide.fdShow = () => { if (!done && !timer) timer = setInterval(() => { if (shown < clues.length) { shown += 1; paint(); } else clearInterval(timer); }, 3500); };
  slide.fdHide = () => { clearInterval(timer); timer = 0; };
  return slide;
}

// ── 5. Le zoom ──
async function fdZoom() {
  const all = fdFiches();
  const f = fdPick(all);
  if (!f) return null;
  const others = FDX.shuffle(S.data.fiches.filter((x) => x.page && inCursus(x) && x.id !== f.id && x.chapter !== f.chapter)).slice(0, 2);
  if (others.length < 2) return null;
  fdRemember(f);
  const n = f.page + Math.floor(Math.random() * Math.min(2, (f.pageEnd || f.page) - f.page + 1));
  const ws = await words(n);
  // le titre et le code de la fiche sont recouverts, sur le canevas même
  const titleWords = new Set(norm(f.title).split(/[^a-z0-9]+/).filter((w) => w.length > 3));
  let cover = 0.11;
  for (const l of FDX.lines(ws.map((w) => w)).concat(ws.filter((w) => FDX.HEADER.test(w.t)).map((w) => ({ y: w.y, h: w.h, text: w.t })))) {
    if (l.y > 0.32) continue;
    const toks = norm(l.text).split(/[^a-z0-9]+/).filter((w) => w.length > 3);
    if (FDX.HEADER.test(l.text) || (toks.length && toks.filter((w) => titleWords.has(w)).length / toks.length >= 0.5)) cover = Math.max(cover, l.y + l.h + 0.012);
  }
  for (const w of ws) if (w.y < 0.08) cover = Math.max(cover, w.y + w.h + 0.008); // bandeau d'en-tête
  const body = ws.filter((w) => w.y > cover + 0.05 && w.y < 0.88);
  const focus = body.length ? fdPick(body) : { x: 0.5, y: 0.5 };
  const canvas = h('canvas');
  const frame = h('div', { class: 'fd-zoom-frame loading' }, canvas);
  const draw = async () => {
    const b = await bitmap(n, (frame.clientWidth || 340) * dpr() * 2.4);
    canvas.width = b.width;
    canvas.height = b.height;
    const g = canvas.getContext('2d');
    g.drawImage(b, 0, 0);
    g.fillStyle = '#1a2029';
    g.fillRect(0, 0, b.width, Math.round(cover * b.height));
    frame.classList.remove('loading');
  };
  canvas.style.transformOrigin = `${(focus.x * 100).toFixed(1)}% ${(focus.y * 100).toFixed(1)}%`;
  const opts = FDX.shuffle([f, ...others]);
  let done = false;
  let t0 = 0;
  const out = h('div', { class: 'fd-out' });
  const choose = (x, btn) => {
    if (done) return;
    done = true;
    const ok = x.id === f.id;
    fdScore(ok);
    canvas.classList.add('free');
    for (const y of btns.children) { y.disabled = true; if (y.dataset.id === f.id) y.classList.add('right'); }
    if (!ok) btn.classList.add('wrong');
    const s = t0 ? Math.round((Date.now() - t0) / 1000) : null;
    out.replaceChildren(h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? (s != null && s <= 4 ? `Reconnue en ${s} s` : 'Reconnue') : 'Raté'), fdRef(f));
  };
  const btns = h('div', { class: 'fd-opts' }, ...opts.map((x) => { const b = h('button', { 'data-id': x.id, onclick: () => choose(x, b) }, x.title); return b; }));
  const slide = fdSlide('zoom', 'De quelle fiche ?', frame, btns, out);
  slide.fdShow = () => {
    if (slide.fdDrawn) return;
    slide.fdDrawn = true;
    draw().then(() => { t0 = Date.now(); requestAnimationFrame(() => canvas.classList.add('out')); }).catch((err) => frame.append(h('p', { class: 'small muted' }, err.message)));
  };
  return slide;
}

// ── 6. Story de fiche ──
async function fdStory() {
  const f = fdPick(fdFiches().filter((x) => (x.pageEnd || x.page) - x.page <= 3));
  if (!f) return null;
  fdRemember(f);
  const pages = [];
  for (let n = f.page; n <= (f.pageEnd || f.page); n++) pages.push(n);
  let at = 0;
  const bars = h('div', { class: 'fd-bars' }, ...pages.map(() => h('span')));
  const stage = h('div', { class: 'fd-stage' });
  const paint = () => {
    [...bars.children].forEach((b, k) => b.classList.toggle('on', k <= at));
    const canvas = h('canvas');
    stage.replaceChildren(canvas);
    requestAnimationFrame(async () => {
      try {
        const b = await bitmap(pages[at], (stage.clientWidth || 340) * dpr());
        canvas.width = b.width;
        canvas.height = b.height;
        canvas.getContext('2d').drawImage(b, 0, 0);
      } catch (err) { stage.append(h('p', { class: 'small muted' }, err.message)); }
    });
  };
  stage.addEventListener('click', (e) => {
    const r = stage.getBoundingClientRect();
    const next = e.clientX - r.left > r.width * 0.35;
    const k = Math.min(pages.length - 1, Math.max(0, at + (next ? 1 : -1)));
    if (k !== at) { at = k; paint(); }
  });
  const slide = fdSlide('story', 'Story de fiche', bars,
    h('div', { class: 'fd-story-head' }, h('span', { class: 'mono dim' }, f.code || ''), h('b', {}, f.title)),
    stage,
    h('div', { class: 'row fd-story-foot' }, h('span', { class: 'small dim' }, pages.length > 1 ? 'Touche à droite pour la page suivante' : 'Une page'), h('button', { class: 'link', onclick: () => fdOpenFiche(f, pages[at]) }, 'Agrandir')));
  slide.fdShow = () => { if (!slide.fdDrawn) { slide.fdDrawn = true; paint(); } };
  return slide;
}

// ── 7. Remettre dans l'ordre ──
function fdOrderCards() { return S.data.cards.filter((c) => c.kind === 'order' && !c.suspended && inCursus(c) && Array.isArray(c.steps) && c.steps.length >= 3 && c.steps.length <= 7 && c.steps.every((s) => typeof s === 'string' && s.length <= 180)); }
async function fdOrder() {
  const c = fdPick(fdOrderCards());
  if (!c) return null;
  const f = fiche(c.ficheId);
  let next = 0;
  let errors = 0;
  const done = h('ol', { class: 'fd-done' });
  const out = h('div', { class: 'fd-out' });
  const pool = h('div', { class: 'fd-pool' }, ...FDX.shuffle(c.steps.map((s, k) => ({ s, k }))).map(({ s, k }) => {
    const b = h('button', { onclick: () => {
      if (k === next) {
        b.remove();
        done.append(h('li', {}, s));
        next += 1;
        if (next === c.steps.length) {
          fdScore(errors === 0);
          out.replaceChildren(h('div', { class: `fd-verdict ${errors ? 'bad' : 'ok'}` }, errors ? `Terminé · ${errors} erreur${errors > 1 ? 's' : ''}` : 'Sans faute'), fdRef(f));
        }
      } else {
        errors += 1;
        b.classList.remove('shake');
        void b.offsetWidth;
        b.classList.add('shake');
      }
    } }, s);
    return b;
  }));
  return fdSlide('order', 'Dans l’ordre', h('p', { class: 'fd-q' }, String(c.title).replace(/\s*:?\s*remets?[- ]les? dans l[’']ordre\.?$/i, '')), h('p', { class: 'small dim' }, 'Touche les étapes dans l’ordre.'), done, pool, out);
}

// ── 8. Le tempo (compressions thoraciques : 100 à 120 par minute, RTN 05FT10) ──
async function fdTempo() {
  const f = S.data.fiches.find((x) => /^05\s?FT\s?10$/.test(String(x.code || '').replace(/\s/g, ''))) || S.data.fiches.find((x) => /réanimation cardio/i.test(x.title));
  const taps = [];
  let timer = 0;
  let over = false;
  const read = h('div', { class: 'fd-read mono' }, '—');
  const pad = h('button', { class: 'fd-pad', 'aria-label': 'Appuyer en rythme' }, 'Appuie en rythme');
  const out = h('div', { class: 'fd-out' });
  const finish = () => {
    over = true;
    const v = FDX.bpm(taps);
    const ok = v != null && v >= 100 && v <= 120;
    fdScore(ok);
    pad.disabled = true;
    pad.textContent = v ? `${v} / min` : 'Trop peu d’appuis';
    out.replaceChildren(h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bon rythme' : v && v < 100 ? 'Trop lent' : v ? 'Trop rapide' : 'Raté', h('span', { class: 'dim' }, ' · 100 à 120 compressions par minute')),
      h('button', { class: 'link', onclick: () => { taps.length = 0; over = false; pad.disabled = false; pad.textContent = 'Appuie en rythme'; read.textContent = '—'; out.replaceChildren(); } }, 'Recommencer'), fdRef(f));
  };
  pad.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (over) return;
    taps.push(performance.now());
    pad.classList.remove('beat');
    void pad.offsetWidth;
    pad.classList.add('beat');
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* sans vibreur */ } }
    if (taps.length === 1) { timer = setTimeout(finish, 8000); pad.textContent = '8 secondes…'; }
    const v = FDX.bpm(taps);
    if (v) read.replaceChildren(String(v), h('span', { class: 'dim' }, ' / min'));
  });
  const slide = fdSlide('tempo', 'Le tempo', h('p', { class: 'fd-big' }, 'Compressions thoraciques : tiens le rythme pendant 8 secondes.'), read, pad, out);
  slide.fdHide = () => { if (taps.length && !over) { clearTimeout(timer); finish(); } };
  return slide;
}

const FD_FORMATS = [
  { id: 'vf', w: 3, make: fdVF, ok: () => S.data.fiches.length > 0 },
  { id: 'slider', w: 2.5, make: fdSlider, ok: () => S.data.fiches.length > 0 },
  { id: 'why', w: 2, make: fdWhy, ok: () => S.data.fiches.length > 0 },
  { id: 'who', w: 2, make: fdWho, ok: fdWhoOk },
  { id: 'zoom', w: 1.5, make: fdZoom, ok: () => S.data.fiches.length > 3 },
  { id: 'order', w: 1.5, make: fdOrder, ok: () => fdOrderCards().length > 0 },
  { id: 'story', w: 1, make: fdStory, ok: () => S.data.fiches.length > 0 },
  { id: 'tempo', w: 0.5, make: fdTempo, ok: () => true },
];

/** Un écran de plus : format tiré au hasard (pondéré), en évitant deux fois le même d'affilée. */
async function fdMake() {
  for (let k = 0; k < 10; k++) {
    const fm = FD_FORMATS.filter((x) => x.ok() && x.id !== FD.last);
    let r = Math.random() * fm.reduce((s, x) => s + x.w, 0);
    const pick = fm.find((x) => (r -= x.w) < 0) || fm[0];
    if (!pick) return null;
    try {
      const slide = await pick.make();
      if (slide) { FD.last = pick.id; return slide; }
    } catch (err) {
      console.warn('fil', pick.id, err);
    }
  }
  return null;
}

/** Garde toujours quelques écrans d'avance ; retire les plus anciens au-delà de 30. */
function fdFill(ahead = 3) {
  if (FD.busy) return FD.busy;
  FD.busy = (async () => {
    const list = FD.list;
    while (list && list.isConnected) {
      const slides = [...list.children];
      const cur = Math.round(list.scrollTop / Math.max(1, list.clientHeight));
      if (slides.length - 1 - cur >= ahead) break;
      const s = await fdMake();
      if (!s) break;
      list.append(s);
      FD.obs.observe(s);
    }
    if (list && list.children.length > 30) {
      const drop = list.children.length - 30;
      const hgt = list.clientHeight;
      for (let k = 0; k < drop; k++) { FD.obs.unobserve(list.firstElementChild); list.firstElementChild.remove(); }
      list.scrollTop -= drop * hgt;
    }
  })().finally(() => { FD.busy = null; });
  return FD.busy;
}

/** Onglet « Fil ». Le nœud est gardé d'un rendu à l'autre (position et écrans conservés). */
function feedView() {
  if (!S.data || !S.data.fiches.length) return h('div', { class: 'card' }, h('div', { class: 'card-body' }, h('p', { class: 'muted' }, 'Le fil a besoin du paquet du référentiel : vérifie les mises à jour dans Ma licence.')));
  if (FD.node && FD.cursus === cfg().cursus) {
    requestAnimationFrame(() => { fdLayout(); FD.list.scrollTop = FD.scroll; });
    return FD.node;
  }
  FD.cursus = cfg().cursus;
  FD.recent = [];
  FD.chip = h('div', { class: 'fd-chip mono' });
  fdChip();
  FD.list = h('div', { class: 'fd-list' },
    h('section', { class: 'fd-slide fd-hello' }, h('div', { class: 'fd-in' },
      fdMark(),
      h('h2', {}, 'Le Fil'),
      h('p', { class: 'muted' }, 'Des petits formats, un par écran, sans fin. Glisse vers le haut.'),
      h('p', { class: 'small dim' }, 'Rien ici ne compte dans ton planning ni dans ta rétention : c’est pour le plaisir, et pour la mémoire quand même.'),
      h('div', { class: 'fd-swipe' }, '↑'))));
  // le défilement remplit aussi (l'observateur ne suffit pas si l'écran ne se peint pas, ex. fenêtre cachée)
  FD.list.addEventListener('scroll', () => { FD.scroll = FD.list.scrollTop; fdFill(); }, { passive: true });
  if (FD.obs) FD.obs.disconnect();
  FD.obs = new IntersectionObserver((ents) => {
    for (const e of ents) {
      if (e.isIntersecting && e.intersectionRatio >= 0.6) { if (e.target.fdShow) e.target.fdShow(); fdFill(); } else if (!e.isIntersecting && e.target.fdHide) e.target.fdHide();
    }
  }, { root: FD.list, threshold: [0, 0.6] });
  FD.obs.observe(FD.list.firstElementChild);
  FD.node = h('div', { class: 'fd' }, FD.list, FD.chip);
  setTimeout(() => { fdLayout(); fdFill(); }, 0);
  return FD.node;
}
function fdMark() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'fd-mark');
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS(NS, 'use');
  use.setAttribute('href', '#rem-mark');
  svg.append(use);
  return svg;
}
/** Le fil occupe l'écran entre l'en-tête et la barre d'onglets. */
function fdLayout() {
  if (!FD.node) return;
  const bar = $('.bar');
  const tabs = $('#tabs');
  FD.node.style.top = `${bar ? bar.getBoundingClientRect().bottom : 0}px`;
  FD.node.style.bottom = `${tabs && !tabs.hidden ? tabs.getBoundingClientRect().height : 0}px`;
}
if (typeof window !== 'undefined') window.addEventListener('resize', () => fdLayout());
