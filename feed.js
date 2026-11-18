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
      if (last && Math.abs(w.y - last.y) < Math.max(0.004, Math.max(w.h, last.h) * 0.45)) { last.ws.push(w); last.h = Math.max(last.h, w.h); } else out.push({ y: w.y, h: w.h, ws: [w] });
    }
    // mots recollés sans espace quand ils se touchent (un mot coupé entre deux morceaux de texte du PDF)
    const join = (ws) => ws.reduce((t, w, k) => (k ? t + (w.x - (ws[k - 1].x + ws[k - 1].w) < w.h * 0.12 ? '' : ' ') + w.t : w.t), '');
    return out.map((l) => { l.ws.sort((p, q) => p.x - q.x); return { y: l.y, h: l.h, x: l.ws[0].x, text: join(l.ws).replace(/\s+([,.;:)])/g, '$1').replace(/(\S) - (\S)/g, '$1-$2') }; })
      .filter((l) => l.y > 0.035 && l.y < 0.955 && !HEADER.test(l.text) && /[a-zà-ÿ]/.test(l.text));
  }

  /** Lignes → blocs (puces et fins de phrase coupent ; les suites de ligne sont recousues) : [{ text, bullet, h }]. */
  function blocks(ls) {
    const out = [];
    let cur = '';
    let bullet = false;
    let h = 0;
    let prev = null;
    const flush = () => { const t = cur.replace(/\s+/g, ' ').trim(); if (t) out.push({ text: t, bullet, h }); cur = ''; };
    for (const l of ls) {
      const t = l.text.trim();
      // nouvelle unité : puce, fin de phrase, majuscule en tête (intertitre au-dessus), ou changement de taille de police
      const head = /^[A-ZÀ-Ý]/.test(t) && !/[,(]$/.test(cur.trim());
      const size = prev && Math.abs(l.h - prev.h) > prev.h * 0.18;
      prev = l;
      if (BULLET.test(t) || /[.;:!?]$/.test(cur.trim()) || !cur || head || size) {
        flush();
        bullet = BULLET.test(t);
        h = l.h;
        cur = t.replace(BULLET, '').replace(/^\d\s+(?=[A-ZÀ-Ý])/, ''); // « 1 La… » : renvoi de note en tête
        continue;
      }
      cur = /-$/.test(cur) && /^[a-zà-ÿ]/.test(t) ? cur.slice(0, -1) + t : `${cur} ${t}`;
    }
    flush();
    return out;
  }
  const segments = (ls) => blocks(ls).map((b) => b.text);

  /** Phrases d'un texte, gardées si elles se lisent seules. */
  function split(s) {
    const out = [];
    for (const p of s.split(/(?<=[.;!?])\s+(?=[A-ZÀ-Ý0-9«])/)) {
      const t = p.trim().replace(/\s*[;:]$/, '.');
      const nw = t.split(/\s+/).length;
      if (t.length >= 25 && t.length <= 260 && nw >= 5 && /[a-zà-ÿ]{3}/.test(t) && !/[•▪●]/.test(t)) out.push(/[.!?]$/.test(t) ? t : `${t}.`);
    }
    return out;
  }
  const sentences = (segs) => [].concat(...segs.map(split));

  // publics nommés dans le texte : ce qui fait souvent varier une valeur
  const PUBLICS = [['nouveau-né', /nouveau-nés?/i], ['nourrisson', /nourrissons?/i], ['enfant', /\benfants?\b/i], ['adulte', /\badultes?\b/i], ['femme enceinte', /femmes? enceintes?|grossesse/i]];
  const publics = (...ts) => PUBLICS.filter(([, re]) => ts.some((t) => t && re.test(t))).map(([p]) => p);
  /** Masque le public dans un texte (« chez l'enfant » → « chez … »). */
  const hidePublic = (t) => String(t || '').replace(/\b(?:l['’]|le |la |les |un |une |des )?(?:nouveau-nés?|nourrissons?|enfants?|adultes?)\b/gi, '…');

  /**
   * Phrases avec leur contexte : intertitre au-dessus (head), phrase d'introduction « … : » d'une liste (lead), publics.
   * [{ text, head, lead, pub }]
   */
  function items(bl) {
    const hs = bl.map((b) => b.h).sort((p, q) => p - q);
    const body = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
    const out = [];
    let head = null;
    let lead = null;
    for (const b of bl) {
      const t = b.text;
      const nw = t.split(/\s+/).length;
      if (!b.bullet && !/[.;!?:,]$/.test(t) && /^[A-ZÀ-Ý]/.test(t) && nw <= 10 && (b.h > body * 1.08 || nw <= 6)) { head = t; lead = null; continue; }
      const l = b.bullet ? lead : null;
      for (const x of split(t)) out.push({ text: x, head, lead: l, pub: publics(x, l, head) });
      if (/:$/.test(t)) lead = t.length <= 220 ? t : null;
      else if (!b.bullet) lead = null;
    }
    return out;
  }

  /** Phrases porteuses d'une valeur chiffrée : [{ text, v, …contexte }]. */
  function valued(sents) {
    const out = [];
    for (const it of sents) {
      const o = typeof it === 'string' ? { text: it } : it;
      const t = o.text;
      const vs = values(t);
      const vv = vs.filter((v) => v.a > 0);
      // « pouls1 » : renvoi de note collé au mot, phrase coupée de son contexte
      if (vv.length >= 1 && vs.length <= 3 && !/[a-zà-ÿ]{3}\d\b/.test(t)) out.push({ ...o, v: vv[Math.floor(Math.random() * vv.length)] });
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

  const r1 = (x) => Math.round(x * 10) / 10;
  const num = (x) => String(x).replace('.', ',');

  /*
   * Valeurs normales du RTN (juillet 2026) : FR 04FT07 (tableau 4), SpO2 04FT08, FC et TRC 04FT09 (tableau 5),
   * température 04FT14. « tous » : même norme quel que soit l'âge.
   */
  const NORMS = [
    { k: 'fr', label: 'Fréquence respiratoire', unit: '/min', code: '04FT07', by: { adulte: [12, 20], enfant: [20, 30], nourrisson: [30, 40], 'nouveau-né': [40, 60] } },
    { k: 'fc', label: 'Fréquence cardiaque', unit: '/min', code: '04FT09', by: { adulte: [60, 100], enfant: [70, 140], nourrisson: [100, 160], 'nouveau-né': [120, 160] } },
    { k: 'spo2', label: 'SpO₂', unit: '%', code: '04FT08', by: { tous: [94, 100] }, dir: 'below' },
    { k: 'trc', label: 'Temps de recoloration cutanée', unit: 's', code: '04FT09', by: { tous: [0, 2] }, dir: 'above', normals: [1, 1.5], text: 'inférieur à 2 s' },
    { k: 'temp', label: 'Température', unit: '°C', code: '04FT14', by: { tous: [36.5, 37.5] }, dec: true },
  ];
  /** Une constante normale ou franchement anormale (jamais à la limite). */
  function normQuiz(rnd = Math.random) {
    const n = NORMS[Math.floor(rnd() * NORMS.length)];
    const pubs = Object.keys(n.by);
    const pub = pubs[Math.floor(rnd() * pubs.length)];
    const [lo, hi] = n.by[pub];
    const span = hi - lo;
    const normal = rnd() < 0.5;
    const round = (x) => (n.dec ? r1(x) : Math.round(x));
    let value;
    if (normal) value = n.normals ? n.normals[Math.floor(rnd() * n.normals.length)] : round(lo + span * (0.15 + rnd() * 0.7));
    else {
      const dir = n.dir || (rnd() < 0.5 ? 'below' : 'above');
      value = n.k === 'spo2' ? 82 + Math.floor(rnd() * 10) : n.k === 'trc' ? 3 + Math.floor(rnd() * 2) : n.k === 'temp' ? (dir === 'below' ? r1(34 + rnd() * 2) : r1(38 + rnd() * 2))
        : dir === 'below' ? round(lo - span * (0.3 + rnd() * 0.5)) : round(hi + span * (0.3 + rnd() * 0.6));
      if (value <= 0) value = round(hi + span * 0.5);
    }
    const range = n.text || `${num(lo)} à ${num(hi)} ${n.unit}`;
    return { k: n.k, label: n.label, unit: n.unit, pub, value, text: `${num(value)} ${n.unit}`, normal, range, code: n.code };
  }

  /*
   * Signes de gravité (RTN juillet 2026) : détresse circulatoire 05AC08 (TRC > 2 s ; FC > 120 ou < 40 au repos ; PAS < 90),
   * malaise 06AC01 (FR > 20), oxygène 05FT01 (SpO2 < 94 %). Valeurs « sans gravité » choisies normales, loin des seuils.
   */
  const GRAVITY = [
    { k: 'fc', label: 'FC', unit: '/min', ok: [64, 96], bad: [[130, 156], [30, 37]], rule: 'FC > 120 ou < 40 /min au repos', code: '05AC08' },
    { k: 'fr', label: 'FR', unit: '/min', ok: [13, 18], bad: [[25, 34]], rule: 'FR > 20 /min', code: '06AC01' },
    { k: 'spo2', label: 'SpO₂', unit: '%', ok: [96, 99], bad: [[84, 91]], rule: 'SpO₂ < 94 %', code: '05FT01' },
    { k: 'trc', label: 'TRC', unit: 's', ok: [1, 1], bad: [[3, 4]], rule: 'TRC > 2 s', code: '05AC08' },
    { k: 'pas', label: 'PA systolique', unit: 'mmHg', ok: [112, 138], bad: [[68, 84]], rule: 'PA systolique < 90 mmHg', code: '05AC08' },
  ];
  function urgentQuiz(rnd = Math.random) {
    const pick = GRAVITY.slice().sort(() => rnd() - 0.5).slice(0, 3 + Math.floor(rnd() * 2));
    const grave = rnd() < 0.55;
    const nBad = grave ? (rnd() < 0.3 ? 2 : 1) : 0;
    const between = ([a, b]) => a + Math.floor(rnd() * (b - a + 1));
    const rows = pick.map((g, i) => {
      const bad = i < nBad;
      const value = bad ? between(g.bad[Math.floor(rnd() * g.bad.length)]) : between(g.ok);
      return { k: g.k, label: g.label, text: `${value} ${g.unit}`, bad, rule: g.rule, code: g.code };
    }).sort(() => rnd() - 0.5);
    return { rows, grave, why: rows.filter((r) => r.bad) };
  }

  /** Grille « Abréviations » (12AC01) : lignes « SIGLE  Signification ». */
  function abbrevs(texts) {
    const out = [];
    const at = texts.findIndex((t) => /^Abréviations$/i.test(t.trim()));
    if (at < 0) return out;
    let miss = 0;
    for (const t of texts.slice(at + 1)) {
      const m = /^([A-Z0-9][A-Za-z0-9]{0,7})\s+(\S.{2,})$/.exec(t.trim());
      const ok = m && ((m[1].match(/[A-Z0-9]/g) || []).length >= 2 || m[1].length <= 2);
      if (ok) { out.push({ abbr: m[1], full: m[2].trim() }); miss = 0; } else if (out.length >= 5 && ++miss >= 2) break;
    }
    return out;
  }
  /** « temps de recoloration cutanée (TRC) » : sigle défini dans le texte, initiales vérifiées. */
  const SMALL = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'à', 'en', 'et', 'au', 'aux', 'par', 'pour', 'sur', 'un', 'une']);
  function defs(text) {
    const out = [];
    for (const m of String(text).matchAll(/([A-Za-zÀ-ÿ'’\- ]{4,140})\(([A-Z][A-Za-z]{1,6}[0-9]?)\)/g)) {
      const letters = m[2].replace(/[0-9]/g, '').toLowerCase();
      const ws = m[1].trim().split(/\s+/);
      const picked = [];
      for (let k = ws.length - 1; k >= 0 && picked.length < letters.length; k--) {
        const w = ws[k].replace(/^[ldLD]['’]/, '');
        if (SMALL.has(w.toLowerCase()) && picked.length) continue;
        picked.unshift(k);
      }
      if (picked.length !== letters.length) continue;
      const init = picked.map((k) => ws[k].replace(/^[ldLD]['’]/, '').normalize('NFD').charAt(0).toLowerCase()).join('');
      if (init !== letters) continue;
      // chiffre final : indice (CO2, SpO2) ; un autre est un renvoi de note (« PLS1 »)
      const abbr = /[0-9]$/.test(m[2]) && !/2$/.test(m[2]) ? m[2].slice(0, -1) : m[2];
      out.push({ abbr, full: ws.slice(picked[0]).join(' ').replace(/^[ldLD]['’]/, '') });
    }
    return out;
  }
  /**
   * Leurres d'un sigle, aux MÊMES initiales que la vraie signification (sinon les initiales donnent la réponse) :
   * un seul mot plein changé (deux, le leurre se repère trop vite) pour un mot du référentiel de même première lettre et
   * de même terminaison (l'accord reste juste : « latérale » ↔ « locale »). `vocab` : [mots des autres sigles, mots courants
   * du texte] ; seul le premier relâche la terminaison. `real` : vraies formes, jamais proposées comme leurre.
   */
  function sigleVocab(fulls, segs) {
    const pick = (t) => (t.match(/[a-zà-ÿ]{4,}/gi) || []).filter((w) => w === w.toLowerCase() || w.slice(1) === w.slice(1).toLowerCase()).map((w) => w.toLowerCase());
    const freq = new Map();
    for (const s of segs) for (const w of pick(s)) freq.set(w, (freq.get(w) || 0) + 1);
    // mots courants du référentiel, pas les formes conjuguées (« arrêtent », « décède ») ni les bribes
    const text = [...freq].filter(([w, n]) => n >= 4 && w.length >= 5 && !/(ent|ez|ons|èd?e|ait|aient)$/.test(w)).map(([w]) => w);
    return [[...new Set(fulls.flatMap(pick))], text];
  }
  function fakeFull(full, vocab, real = [], n = 2, rnd = Math.random) {
    const key = (w) => w.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    const seen = new Set([...real, full].map((x) => key(x).replace(/\s+/g, ' ')));
    const ws = full.split(/\s+/);
    const parts = ws.map((w) => /^((?:[ldLD]['’])?)(.*)$/.exec(w));
    const slots = parts.map((m, k) => (m[2].length >= 3 && !SMALL.has(m[2].toLowerCase()) && /^[A-Za-zÀ-ÿ-]+$/.test(m[2]) ? k : -1)).filter((k) => k >= 0);
    if (slots.length < 2) return []; // un seul mot (« Mercure ») : rien à deviner
    const pools = vocab.map((v) => [...new Set(v.map((x) => x.toLowerCase()))]);
    // remplaçants possibles d'un mot, du plus sûr au moins sûr (même terminaison d'abord : l'accord reste juste)
    const swaps = (w, end) => {
      const lw = w.toLowerCase();
      for (const [p, pool] of pools.entries()) {
        const e = p ? Math.max(end, 3) : end;
        const c = pool.filter((x) => key(x)[0] === key(lw)[0] && (!e || x.slice(-e) === lw.slice(-e)) && Math.abs(x.length - lw.length) <= 4 && key(x) !== key(lw));
        if (c.length) return shuffle(c, rnd).map((r) => (w[0] === w[0].toUpperCase() ? r[0].toUpperCase() + r.slice(1) : r));
      }
      return [];
    };
    const out = [];
    const used = new Set();
    for (const end of [2, 1, 0]) {
      for (const k of shuffle(slots, rnd)) {
        if (out.length >= n) return out;
        if (used.has(k)) continue;
        // un leurre par mot changé quand c'est possible : deux leurres sur le même mot se trahissent
        for (const r of swaps(parts[k][2], end)) {
          const got = parts.map((m) => m[1] + m[2]);
          got[k] = parts[k][1] + r;
          const txt = got.join(' ');
          if (seen.has(key(txt))) continue;
          seen.add(key(txt));
          out.push(txt);
          used.add(k);
          break;
        }
      }
    }
    // pas assez de mots différents : un deuxième leurre sur un mot déjà changé
    for (const k of shuffle(slots, rnd)) {
      for (const r of [2, 1, 0].flatMap((e) => swaps(parts[k][2], e))) {
        if (out.length >= n) return out;
        const got = parts.map((m) => m[1] + m[2]);
        got[k] = parts[k][1] + r;
        const txt = got.join(' ');
        if (!seen.has(key(txt))) { seen.add(key(txt)); out.push(txt); }
      }
    }
    return out;
  }

  /**
   * « Pour qui ? » : phrases d'un seul public (adulte, enfant ou nourrisson), nommé dans la phrase, son intertitre ou
   * son introduction, porteuses d'une valeur chiffrée (c'est elle qui varie selon le public) ; rien ne doit le trahir une fois masqué.
   */
  function publicItems(its, title = '') {
    const P = ['adulte', 'enfant', 'nourrisson'];
    return its.filter((it) => it.pub.length === 1 && P.includes(it.pub[0]) && !/[«»]/.test(it.text)
      && values(it.text).some((v) => v.a > 0)
      && publics(title).every((p) => p === it.pub[0])
      && publics(hidePublic(it.text), hidePublic(it.head), hidePublic(it.lead), hidePublic(title)).length === 0);
  }

  /*
   * Signes propres à UNE détresse (RTN juillet 2026) : respiratoire 05AC07, circulatoire 05AC08, neurologique 05AC09.
   * Écartés car communs à plusieurs : agitation, angoisse, somnolence, confusion, sueurs.
   */
  const DISTRESS = [
    { k: 'resp', label: 'Respiratoire', code: '05AC07', signs: ['Sifflement en écoutant la ventilation', 'Gargouillements en écoutant la ventilation', 'Râles en écoutant la ventilation', 'Tirage : contraction des muscles du haut du thorax et du cou', 'Balancement thoraco-abdominal', 'Battement des ailes du nez chez l’enfant', 'Coloration bleutée des doigts, du lobe des oreilles et des lèvres (cyanose)', 'Refuse de s’allonger, cherche à rester assise', '« J’étouffe », « j’ai du mal à respirer »', 'Fréquence respiratoire supérieure à 30 /min', 'SpO₂ inférieure à 94 %', 'Ne peut plus parler, se tient la poitrine'] },
    { k: 'circ', label: 'Circulatoire', code: '05AC08', signs: ['Pâleur des extrémités, de la face interne de la paupière inférieure et des lèvres', 'Marbrures cutanées à la face antérieure des genoux', 'Pouls radial imperceptible, pouls carotidien rapide', 'Temps de recoloration cutanée supérieur à 2 secondes', 'Fréquence cardiaque supérieure à 120 /min au repos', 'Pression artérielle systolique inférieure à 90 mmHg', 'Ne peut pas rester assise ou debout (vertiges)', 'Sensation de soif'] },
    { k: 'neuro', label: 'Neurologique', code: '05AC09', signs: ['Retard de réponse aux questions ou aux ordres', 'Ne se rappelle plus son nom, le lieu ni l’année', 'Ne peut plus bouger un membre (paralysie)', 'Perte de la vue d’un œil', 'Convulsions généralisées', 'Asymétrie évidente du visage', 'Pupilles de diamètres différents', 'A du mal à trouver ses mots, déforme les mots', 'Amnésie de l’accident ou du malaise', 'Ne répond pas, n’exécute pas un ordre simple, mais respire'] },
  ];
  function distressQuiz(rnd = Math.random) {
    const d = DISTRESS[Math.floor(rnd() * DISTRESS.length)];
    return { k: d.k, label: d.label, code: d.code, sign: d.signs[Math.floor(rnd() * d.signs.length)] };
  }

  /*
   * Calculs de terrain d'après le RTN : quantité d'oxygène = pression (bar) × volume en eau (L) (05AC01), bouteilles de
   * 2, 5, 11 et 15 L ; autonomie = quantité ÷ débit (15 L/min au MHC, 05FT01) ; paume de la victime, doigts compris = 1 %
   * de la surface de sa peau, quel que soit l'âge (07AC01).
   */
  function calcQuiz(rnd = Math.random) {
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const near = (x, alts) => {
      const set = new Set([x]);
      for (const a of alts) if (a > 0 && Number.isFinite(a) && set.size < 4) set.add(a);
      for (let k = 1; set.size < 4; k++) set.add(x + k * Math.max(1, Math.round(x * 0.2)));
      return [...set].sort((p, q) => p - q);
    };
    const kind = pick(['o2qty', 'o2time', 'o2time', 'palm']);
    if (kind === 'palm') {
      // le RTN réserve la règle de la paume à l'enfant et aux petites surfaces
      const n = 1 + Math.floor(rnd() * 6);
      return { kind, code: '07AC01', question: `Enfant brûlé sur une petite surface : environ ${n} paume${n > 1 ? 's' : ''} de sa main, doigts compris. Quelle surface de peau ?`, unit: '%', answer: n, choices: near(n, [n * 2, n * 5, n + 9, n * 10]), explain: 'Chez l’enfant et pour les petites surfaces : paume de la victime, doigts compris = 1 % de la surface de sa peau, quel que soit l’âge.' };
    }
    const vol = pick([2, 5, 11, 15]);
    const bar = pick([200, 150, 100, 50]);
    const qty = vol * bar;
    if (kind === 'o2qty') return { kind, code: '05AC01', question: `Bouteille de ${vol} L (volume en eau), manomètre à ${bar} bar. Combien de litres d’oxygène ?`, unit: 'L', answer: qty, choices: near(qty, [vol + bar, qty * 2, Math.round(qty / 2), qty * 10]), explain: `Quantité = pression × volume en eau : ${bar} × ${vol} = ${qty} L.` };
    const deb = pick([15, 15, 9, 6]);
    const t = Math.floor(qty / deb);
    return { kind, code: '05AC01', question: `Bouteille de ${vol} L à ${bar} bar, débit de ${deb} L/min. Autonomie, en minutes (sans réserve) ?`, unit: 'min', answer: t, choices: near(t, [Math.floor(qty / 15 === qty / deb ? qty / 9 : qty / 15), t * 2, Math.round(t / 2), Math.floor(vol * 60 / deb)]), explain: `${bar} × ${vol} = ${qty} L d’oxygène ; ${qty} ÷ ${deb} ≈ ${t} min.` };
  }

  // mots outils et termes trop communs pour faire un « mot qui manque »
  const STOP = new Set('victime victimes secouriste secouristes nécessaire nécessaires permettre permet possible toujours cependant lorsque lorsqu’elle notamment également pendant ensemble plusieurs certains certaines position réaliser réalisée réalisé importante important situation présence absence moment manière mesure niveau partie quelque quelques beaucoup jusqu’à au-dessus au-dessous dessous dessus doivent peuvent pourrait encore autres entre contre depuis dernier première premier différentes différents'.split(' ')
    // adverbes en -ment : même terminaison que les noms (saignement, pansement), d'où la liste
    .concat('rapidement complètement doucement immédiatement simplement systématiquement régulièrement directement fermement délicatement progressivement spontanément correctement éventuellement généralement habituellement légèrement lentement préalablement strictement totalement uniquement suffisamment apparemment fréquemment particulièrement préférentiellement absolument largement parfaitement seulement facilement rarement souvent'.split(' ')));
  /** Mot-clé d'une phrase : long, pas un mot outil, rare dans la fiche (freq : Map mot → occurrences). */
  function keyWord(text, freq = new Map(), rnd = Math.random) {
    const cand = [];
    for (const m of String(text).matchAll(/[A-Za-zÀ-ÿ’'-]{7,}/g)) {
      const w = m[0].replace(/^[ldLD][’']/, '');
      const lw = w.toLowerCase();
      if (STOP.has(lw) || /^[A-Z]{2,}/.test(w) || /-$/.test(w)) continue;
      // formes verbales et participes (« apporte » passe, mais « retrouvent », « organiser », « réalisée » non) ; noms en -ment gardés
      if (/(?:er|ez|ait|aient|ant|[^m]ent|ée?s?)$/.test(lw)) continue;
      const off = m[0].length - w.length;
      if (m.index + off === 0) continue; // premier mot de la phrase : sa majuscule le trahit
      cand.push({ index: m.index + off, word: w, n: freq.get(lw) || 1 });
    }
    if (!cand.length) return null;
    cand.sort((p, q) => p.n - q.n || q.word.length - p.word.length);
    const top = cand.slice(0, Math.min(3, cand.length));
    return top[Math.floor(rnd() * top.length)];
  }

  /** Coupe une phrase en deux, à un endroit naturel vers le milieu : { head, tail } ou null. */
  // pas « à », « en », « sur », « dans » : ils ouvrent souvent un complément du nom (« gants à usage unique »)
  const CUT_BEFORE = /^(pour|afin|avec|sans|jusqu|car|puis|et|si|lorsque|avant|après|de façon|tout en)\b/i;
  function cutSentence(text) {
    const ws = String(text).split(/\s+/);
    if (ws.length < 9) return null;
    const lo = Math.floor(ws.length * 0.35);
    const hi = Math.ceil(ws.length * 0.65);
    let at = -1;
    for (let k = lo; k <= hi && at < 0; k++) if (/,$/.test(ws[k - 1]) || CUT_BEFORE.test(ws[k])) at = k;
    if (at < 0 || ws.length - at < 3) return null; // pas d'endroit naturel : pas de coupe au hasard
    const head = ws.slice(0, at).join(' ');
    if ((head.match(/\(/g) || []).length !== (head.match(/\)/g) || []).length) return null; // dans une parenthèse
    return { head: ws.slice(0, at).join(' ').replace(/,$/, ''), tail: ws.slice(at).join(' ') };
  }

  /**
   * « Jamais / toujours » : la phrase absolue retournée (« Ne jamais percer » ↔ « Toujours percer », « ne doit jamais »
   * ↔ « doit toujours »). null si la phrase ne se retourne pas proprement.
   */
  function flipAbsolute(text) {
    const t = String(text);
    const rules = [
      [/^Ne jamais /, 'Toujours '], [/^Toujours /, 'Ne jamais '],
      [/\bne (doit|doivent|faut|peut|peuvent) jamais\b/, '$1 toujours'], [/\bn[’'](est|sont) jamais\b/, '$1 toujours'],
      // pas « est toujours » : souvent « encore » (« le nouveau-né est toujours relié à la mère »)
      [/\b(doit|doivent|faut) toujours\b/, 'ne $1 jamais'],
    ];
    const hits = rules.filter(([re]) => re.test(t));
    if (hits.length !== 1 || (t.match(/\b(jamais|toujours)\b/gi) || []).length !== 1) return null; // une seule bascule, sans ambiguïté
    const [re, to] = hits[0];
    return t.replace(re, to);
  }

  /*
   * Ordres fixés par le RTN : les 4 regards successifs du bilan (04AC01) ; la transmission « concise et ordonnée »
   * d'une victime sans détresse vitale (04PR06).
   */
  const SEQUENCES = [
    { title: 'Les quatre regards du bilan, dans l’ordre', code: '04AC01', steps: ['Apprécier la situation dans sa globalité, déceler les dangers', 'Progresser vers la victime : menace vitale et plainte principale', 'Évaluer les fonctions vitales l’une après l’autre', 'Compléter : interrogatoire, examen, paramètres vitaux'] },
    { title: 'Transmettre le bilan d’une victime sans détresse vitale, dans l’ordre', code: '04PR06', steps: ['Le motif réel de l’intervention', 'Le sexe et l’âge de la victime', 'La plainte principale', 'Le résultat du bilan et les gestes de secours entrepris'] },
  ];

  /*
   * « Ce que voit le témoin » : paroles de témoin, chacune traduisant UN signe du RTN (05AC07 respiratoire,
   * 05AC08 circulatoire, 05AC09 neurologique). Le signe exact est donné après la réponse.
   */
  const WITNESS = [
    ['resp', '« Ses lèvres et le bout de ses doigts sont tout bleus. »', 'Coloration bleutée des doigts, du lobe des oreilles et des lèvres (cyanose)'],
    ['resp', '« Ça siffle quand il respire. »', 'Sifflement en écoutant la ventilation'],
    ['resp', '« Ça gargouille dans sa gorge à chaque respiration. »', 'Gargouillements : encombrement des voies aériennes'],
    ['resp', '« Elle refuse qu’on l’allonge, elle veut absolument rester assise. »', 'Refuse de s’allonger, cherche à rester assise'],
    ['resp', '« On voit les muscles de son cou se creuser à chaque inspiration. »', 'Tirage : contraction des muscles du haut du thorax et du cou'],
    ['resp', '« Il n’arrive plus à parler, il se tient la poitrine. »', 'Ne peut plus parler, se tient la poitrine'],
    ['resp', '« Elle n’arrête pas de dire qu’elle étouffe. »', '« J’étouffe », « j’ai du mal à respirer »'],
    ['circ', '« Il est devenu tout blanc, même ses lèvres. »', 'Pâleur des extrémités, de la paupière inférieure et des lèvres'],
    ['circ', '« Ses genoux sont marbrés, avec des plaques violettes. »', 'Marbrures cutanées à la face antérieure des genoux'],
    ['circ', '« Il me demande sans arrêt à boire. »', 'Sensation de soif'],
    ['circ', '« Dès qu’elle se relève, la tête lui tourne et elle doit se rasseoir. »', 'Ne peut pas rester assise ou debout (vertiges)'],
    ['circ', '« Je ne sens pas son pouls au poignet. »', 'Pouls radial imperceptible'],
    ['neuro', '« Sa bouche est de travers d’un côté. »', 'Asymétrie évidente du visage'],
    ['neuro', '« Elle ne sait plus en quelle année on est. »', 'Désorientée : ne se rappelle plus le lieu ni l’année'],
    ['neuro', '« Il n’arrive plus à bouger son bras droit. »', 'Ne peut plus bouger un membre (paralysie)'],
    ['neuro', '« Elle cherche ses mots, elle dit des mots bizarres. »', 'Trouble de la parole : cherche ses mots, les déforme'],
    ['neuro', '« Il ne se souvient pas d’être tombé. »', 'Amnésie de l’accident ou du malaise'],
    ['neuro', '« Tout son corps s’est mis à trembler, il ne répondait plus. »', 'Convulsions généralisées'],
    ['neuro', '« Elle dit qu’elle ne voit plus rien d’un œil. »', 'Perte de la vue d’un œil'],
  ].map(([k, said, sign]) => ({ k, said, sign }));

  const shuffle = (a, rnd = Math.random) => { const x = a.slice(); for (let k = x.length - 1; k > 0; k--) { const j = Math.floor(rnd() * (k + 1)); [x[k], x[j]] = [x[j], x[k]]; } return x; };

  return { values, alter, slider, valueText, lines, blocks, segments, sentences, items, publics, hidePublic, valued, bpm, shuffle, normQuiz, urgentQuiz, abbrevs, defs, sigleVocab, fakeFull, publicItems, distressQuiz, calcQuiz, keyWord, cutSentence, flipAbsolute, NORMS, GRAVITY, DISTRESS, SEQUENCES, WITNESS, HEADER };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = FDX;

// ───────────────────────── fil (page) ─────────────────────────

const FD_BEST = 'rem.feed.best';
const FD = { node: null, list: null, scroll: 0, busy: null, streak: 0, best: 0, recent: [], text: new Map(), obs: null, chip: null };
try { FD.best = Number(localStorage.getItem(FD_BEST)) || 0; } catch { FD.best = 0; }

const fdPick = (a) => a[Math.floor(Math.random() * a.length)];
// réponse affichée : replaceChildren natif écrirait « null » pour une fiche de référence absente
const fdOut = (el, ...kids) => el.replaceChildren(...kids.flat().filter((x) => x != null && x !== false && x !== ''));
// fiches pas vues récemment ; toutes si le référentiel est trop petit pour ça
const fdFiches = () => { const all = S.data.fiches.filter((f) => f.page && inCursus(f)); const fresh = all.filter((f) => !FD.recent.includes(f.id)); return fresh.length ? fresh : all; };
const fdRef = (f) => (f ? h('button', { class: 'fd-ref', 'data-fiche': f.id, onclick: () => fdOpenFiche(f) }, h('span', { class: 'mono' }, f.code || ''), ' ', f.title, ' ›') : null);
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
  const bl = [];
  const texts = [];
  const end = Math.min(f.pageEnd || f.page, f.page + 5);
  for (let n = f.page; n <= end; n++) { const ls = FDX.lines(await words(n)); texts.push(...ls.map((l) => l.text)); bl.push(...FDX.blocks(ls)); }
  const segs = bl.map((b) => b.text);
  const out = { segs, texts, sents: FDX.sentences(segs), items: FDX.items(bl) };
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

const fdByCode = (code) => S.data.fiches.find((x) => String(x.code || '').replace(/\s/g, '') === code && inCursus(x));
/** Contexte d'une phrase, affiché AVANT la réponse : une valeur dépend souvent de la fiche, de la rubrique ou du public. */
function fdCtx(f, it = {}, hide = false) {
  const t = (x) => (hide ? FDX.hidePublic(x) : x);
  const pubs = hide ? [] : it.pub || [];
  // rubrique sans redite du titre de la fiche (« Hémorragie externe — Conduite à tenir, dans l'ordre » → « Conduite à tenir »)
  let head = String(it.head || '');
  if (f) head = head.replace(new RegExp(`^${f.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[—–:-]\\s*`, 'i'), '');
  head = head.replace(/,?\s*dans l[’']ordre\.?$/i, '').trim();
  if (f && norm(head) === norm(f.title)) head = '';
  return h('div', { class: 'fd-ctx' },
    f ? h('div', { class: 'fd-ctx-f', 'data-fiche': f.id }, h('span', { class: 'mono dim' }, f.code || ''), h('b', {}, t(f.title))) : null,
    head || pubs.length ? h('div', { class: 'fd-ctx-tags' }, head ? h('span', { class: 'fd-tag' }, t(head)) : null, ...pubs.map((p) => h('span', { class: 'fd-tag pub' }, p))) : null,
    it.lead ? h('p', { class: 'fd-ctx-lead' }, t(it.lead)) : null);
}

function fdSlide(kind, label, ...kids) {
  const flag = h('button', { class: 'fd-flag', 'aria-label': 'Signaler cette question', title: 'Signaler une question bancale' }, '⚑');
  const slide = h('section', { class: `fd-slide fd-${kind}` }, h('div', { class: 'fd-in' }, h('div', { class: 'fd-kind-row' }, h('div', { class: 'fd-kind' }, label), flag), ...kids));
  flag.addEventListener('click', () => fdFlag(slide, flag));
  return slide;
}

// ── signaler une question bancale : gardé avec la progression, envoyé au PC avec l'export ──
const FD_REASONS = [['cut', 'Phrase mal coupée'], ['context', 'Contexte trompeur ou manquant'], ['wrong', 'Réponse fausse'], ['other', 'Autre']];
function fdFlag(slide, btn) {
  if (btn.classList.contains('on')) { toast('Déjà signalée.'); return; }
  let reason = null;
  const note = h('textarea', { class: 'fd-note', rows: '2', maxlength: '400', placeholder: 'Précision (facultatif)' });
  const send = h('button', { class: 'primary', disabled: true }, 'Signaler');
  const pick = h('div', { class: 'fd-opts' }, ...FD_REASONS.map(([id, label]) => {
    const b = h('button', { onclick: () => { reason = id; for (const x of pick.children) x.classList.toggle('right', x === b); send.disabled = false; } }, label);
    return b;
  }));
  const close = () => box.remove();
  send.addEventListener('click', async () => {
    const holder = slide.querySelector('[data-fiche]');
    const f = holder ? fiche(holder.dataset.fiche) : null;
    const clone = slide.querySelector('.fd-in').cloneNode(true);
    for (const x of clone.querySelectorAll('.fd-kind-row, .fd-ref, .fd-vf-btns, .fd-go, .fd-tap, canvas')) x.remove();
    // un bloc par ligne (innerText d'un nœud détaché perd les retours à la ligne) ; les choix d'une liste, un par ligne
    const lines = [];
    for (const x of clone.children) {
      if (x.matches('.fd-opts, .fd-clues, .fd-pool, .fd-done, .fd-rows, .fd-nums, .fd-out, .fd-ctx, .fd-seq')) for (const y of x.children) lines.push(y.textContent.replace(/\s+/g, ' ').trim());
      else lines.push(x.textContent.replace(/\s+/g, ' ').trim());
    }
    const text = [slide.querySelector('.fd-kind').textContent, ...lines.filter(Boolean)].join('\n').slice(0, 1200);
    const flags = S.prog.flags || (S.prog.flags = []);
    flags.push({ id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`, at: Date.now(), fmt: slide.dataset.fmt || '', reason, note: note.value.trim().slice(0, 400), ficheId: f ? f.id : '', code: f ? f.code || '' : '', title: f ? f.title : '', text });
    if (flags.length > 300) flags.splice(0, flags.length - 300);
    await saveProg();
    btn.classList.add('on');
    close();
    toast('Tuile signalée. Pour l’envoyer à Dawn : Ma licence › Exporter les tuiles signalées.');
  });
  const box = h('div', { class: 'fd-sheet', role: 'dialog', 'aria-label': 'Signaler cette question' },
    h('div', { class: 'fd-sheet-in stack' },
      h('h3', {}, 'Signaler cette question'),
      h('p', { class: 'small muted' }, 'Ce qui est affiché à l’écran est joint au signalement ; il arrive dans Dawn avec l’import de ta progression.'),
      pick, note,
      h('div', { class: 'row', style: 'justify-content:flex-end' }, h('button', { class: 'secondary', onclick: close }, 'Annuler'), send)));
  box.addEventListener('click', (e) => { if (e.target === box) close(); });
  document.body.append(box);
}

// ── 1. Vrai / Faux au glissé ──
async function fdVF() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const cand = FDX.valued((await fdText(f)).items);
  if (!cand.length) return null;
  fdRemember(f);
  const it = fdPick(cand);
  const { text, v } = it;
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
    fdOut(out, 
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
  return fdSlide('vf', 'Vrai ou faux ?', fdCtx(f, it), card, btns, out);
}

// ── 2. Le curseur ──
async function fdSlider() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const cand = FDX.valued((await fdText(f)).items).filter((c) => c.v.unit !== 'fois');
  if (!cand.length) return null;
  fdRemember(f);
  const it = fdPick(cand);
  const { text, v } = it;
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
    fdOut(out, 
      h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Pile dans la zone' : 'À côté', h('span', { class: 'dim' }, ` · ${FDX.valueText(v)}`)),
      h('p', { class: 'fd-quote' }, text.slice(0, v.index), h('mark', {}, text.slice(v.index, v.index + v.len)), text.slice(v.index + v.len)),
      fdRef(f));
  } }, 'Valider');
  return fdSlide('slider', 'Le bon chiffre', fdCtx(f, it),
    h('p', { class: 'fd-big' }, text.slice(0, v.index), h('span', { class: 'fd-blank' }, '?'), ` ${v.unit}`, text.slice(v.index + v.len)),
    read, h('div', { class: 'fd-track' }, range, zone), go, out);
}

// ── 3. Pourquoi ? ──
async function fdWhy() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const cand = [];
  for (const it of (await fdText(f)).items) for (const c of window.DawnRemanence.whyClauses(it.text)) cand.push({ t: it.text, c, it });
  if (!cand.length) return null;
  fdRemember(f);
  const { t, c, it } = fdPick(cand);
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const act = cap(t.slice(...c.act).replace(/[.,;:]+$/, ''));
  const why = t.slice(...c.why).replace(/[.,;:]+$/, '');
  const reverse = c.purpose && Math.random() < 0.35;
  const q = reverse ? `Que faire ${c.conn} ${why} ?` : act;
  const ans = reverse ? act : `${cap(c.conn)} ${why}.`;
  const out = h('div', { class: 'fd-out' });
  const tap = h('button', { class: 'fd-tap', onclick: () => { tap.remove(); fdOut(out, h('p', { class: 'fd-answer' }, ans), fdRef(f)); } }, 'Touche pour voir');
  return fdSlide('why', reverse ? 'Que faire ?' : 'Pourquoi ?', fdCtx(f, it), h('p', { class: 'fd-big' }, q), tap, out);
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
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? (found <= 2 ? 'Trouvé très vite' : 'Trouvé') : 'Raté', h('span', { class: 'dim' }, ` · ${q.title}`)), play);
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
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? (s != null && s <= 4 ? `Reconnue en ${s} s` : 'Reconnue') : 'Raté'), fdRef(f));
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
          fdOut(out, h('div', { class: `fd-verdict ${errors ? 'bad' : 'ok'}` }, errors ? `Terminé · ${errors} erreur${errors > 1 ? 's' : ''}` : 'Sans faute'), fdRef(f));
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
  const f = fdByCode('05FT10') || S.data.fiches.find((x) => inCursus(x) && /réanimation cardio/i.test(x.title));
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
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bon rythme' : v && v < 100 ? 'Trop lent' : v ? 'Trop rapide' : 'Raté', h('span', { class: 'dim' }, ' · 100 à 120 compressions par minute')),
      h('button', { class: 'link', onclick: () => { taps.length = 0; over = false; pad.disabled = false; pad.textContent = 'Appuie en rythme'; read.textContent = '—'; fdOut(out, ); } }, 'Recommencer'), fdRef(f));
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

// ── 9. Avant / Après (cartes « ordre ») ──
async function fdBefore() {
  const c = fdPick(fdOrderCards());
  if (!c) return null;
  const f = fiche(c.ficheId);
  const i = Math.floor(Math.random() * (c.steps.length - 1));
  const j = i + 1 + Math.floor(Math.random() * (c.steps.length - 1 - i));
  const pair = FDX.shuffle([i, j]);
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (k, b) => {
    if (done) return;
    done = true;
    const ok = k === i;
    fdScore(ok);
    for (const x of btns.children) { x.disabled = true; if (Number(x.dataset.k) === i) x.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Dans l’ordre' : 'Raté'),
      h('ol', { class: 'fd-seq' }, ...c.steps.map((st, k) => h('li', { class: k === i || k === j ? 'hl' : '' }, st))), fdRef(f));
  };
  const btns = h('div', { class: 'fd-opts' }, ...pair.map((k) => { const b = h('button', { 'data-k': String(k), onclick: () => choose(k, b) }, c.steps[k]); return b; }));
  return fdSlide('before', 'Lequel d’abord ?', fdCtx(f, { head: String(c.title).replace(/\s*:?\s*remets?[- ]les? dans l[’']ordre\.?$/i, '') }), btns, out);
}

// ── 10. Adulte, enfant ou nourrisson ? (public caché dans la phrase) ──
const FD_PUBS = ['adulte', 'enfant', 'nourrisson'];
async function fdPublic() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const ok2 = FDX.publicItems((await fdText(f)).items, f.title);
  if (!ok2.length) return null;
  fdRemember(f);
  const it = fdPick(ok2);
  const truth = it.pub[0];
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (p, b) => {
    if (done) return;
    done = true;
    const ok = p === truth;
    fdScore(ok);
    for (const x of btns.children) { x.disabled = true; if (x.dataset.p === truth) x.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, ` · ${truth}`)), h('p', { class: 'fd-quote' }, it.text), fdRef(f));
  };
  const btns = h('div', { class: 'fd-vf-btns three' }, ...FD_PUBS.map((p) => { const b = h('button', { 'data-p': p, onclick: () => choose(p, b) }, p.charAt(0).toUpperCase() + p.slice(1)); return b; }));
  return fdSlide('public', 'Pour qui ?', fdCtx(f, it, true), h('p', { class: 'fd-big' }, FDX.hidePublic(it.text)), btns, out);
}

// ── 11. Normal ou anormal ? (valeurs normales du RTN) ──
async function fdNorm() {
  const q = FDX.normQuiz();
  const f = fdByCode(q.code);
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const answer = (said, b) => {
    if (done) return;
    done = true;
    const ok = said === q.normal;
    fdScore(ok);
    for (const x of btns.children) x.disabled = true;
    b.classList.add(ok ? 'right' : 'wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, ` · ${q.normal ? 'normal' : 'anormal'}`)),
      h('p', { class: 'fd-quote' }, `Normale${q.pub === 'tous' ? '' : ` chez ${q.pub === 'adulte' ? 'l’adulte' : q.pub === 'enfant' ? 'l’enfant' : q.pub === 'nourrisson' ? 'le nourrisson' : 'le nouveau-né'}`} : `, h('mark', {}, q.range), ` (${q.code}).`), fdRef(f));
  };
  const btns = h('div', { class: 'fd-vf-btns' }, h('button', { class: 'fd-no', onclick: (e) => answer(false, e.currentTarget) }, 'Anormal'), h('button', { class: 'fd-yes', onclick: (e) => answer(true, e.currentTarget) }, 'Normal'));
  return fdSlide('norm', 'Normal ou anormal ?',
    h('div', { class: 'fd-ctx' }, h('div', { class: 'fd-ctx-tags' }, h('span', { class: 'fd-tag pub' }, q.pub === 'tous' ? 'tout âge' : q.pub), h('span', { class: 'fd-tag' }, 'au repos'))),
    h('div', { class: 'fd-vital' }, h('span', { class: 'fd-vital-l' }, q.label), h('span', { class: 'fd-vital-v mono' }, q.text)), btns, out);
}

// ── 12. Urgent ou pas ? (signes de gravité du RTN) ──
async function fdUrgent() {
  const q = FDX.urgentQuiz();
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const answer = (said, b) => {
    if (done) return;
    done = true;
    const ok = said === q.grave;
    fdScore(ok);
    for (const x of btns.children) x.disabled = true;
    b.classList.add(ok ? 'right' : 'wrong');
    for (const r of rows.children) if (r.dataset.bad === '1') r.classList.add('bad');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, q.grave ? ' · signe de gravité' : ' · rien d’alarmant ici')),
      ...(q.grave ? q.why.map((r) => { const f = fdByCode(r.code); return h('p', { class: 'fd-quote' }, h('mark', {}, r.rule), ` (${r.code})`, f ? h('span', {}, ' ', fdRef(f)) : null); })
        : [h('p', { class: 'fd-quote' }, 'Aucune de ces valeurs n’atteint un seuil de gravité (FC > 120 ou < 40, FR > 20, SpO₂ < 94 %, TRC > 2 s, PAS < 90).')]));
  };
  const rows = h('div', { class: 'fd-rows' }, ...q.rows.map((r) => h('div', { class: 'fd-row', 'data-bad': r.bad ? '1' : '0' }, h('span', {}, r.label), h('span', { class: 'mono' }, r.text))));
  const btns = h('div', { class: 'fd-vf-btns' }, h('button', { class: 'fd-no', onclick: (e) => answer(false, e.currentTarget) }, 'Pas de gravité'), h('button', { class: 'fd-yes', onclick: (e) => answer(true, e.currentTarget) }, 'Signe de gravité'));
  return fdSlide('urgent', 'Urgent ou pas ?', h('p', { class: 'small muted' }, 'Adulte au repos. Bilan mesuré :'), rows, btns, out);
}

// ── 13. Bon réflexe ou faute ? (gestes joués sur la victime simulée, sim.js) ──
function fdReflexOk() { return !!(S.ent && S.ent.mod.sim && S.simLoaded && typeof msReflexQuiz === 'function'); }
async function fdReflex() {
  const q = msReflexQuiz(); // { situation, gesture, bad, why, title }
  if (!q) return null;
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const answer = (saidBad, b) => {
    if (done) return;
    done = true;
    const ok = saidBad === q.bad;
    fdScore(ok);
    for (const x of btns.children) x.disabled = true;
    b.classList.add(ok ? 'right' : 'wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, q.bad ? ' · faute' : ' · bon réflexe')), h('p', { class: 'fd-quote' }, q.why));
  };
  const btns = h('div', { class: 'fd-vf-btns' }, h('button', { class: 'fd-no', onclick: (e) => answer(true, e.currentTarget) }, 'Faute'), h('button', { class: 'fd-yes', onclick: (e) => answer(false, e.currentTarget) }, 'Bon réflexe'));
  return fdSlide('reflex', 'Bon réflexe ou faute ?', h('div', { class: 'fd-ctx' }, h('div', { class: 'fd-ctx-tags' }, h('span', { class: 'fd-tag' }, q.title))),
    h('p', { class: 'fd-scene' }, q.situation), h('p', { class: 'fd-big' }, q.gesture), btns, out);
}

// ── 14. Le sigle (grille « Abréviations » 12AC01, et sigles définis dans le texte) ──
async function fdSigles() {
  if (FD.sigles && FD.sigles.cursus === cfg().cursus) return FD.sigles;
  const list = new Map();
  const grid = fdByCode('12AC01') || S.data.fiches.find((x) => inCursus(x) && /informations générales/i.test(x.title));
  if (grid) for (const a of FDX.abbrevs((await fdText(grid)).texts)) list.set(a.abbr, { ...a, f: grid });
  FD.sigles = { cursus: cfg().cursus, list, seen: new Set() };
  return FD.sigles;
}
async function fdSigle() {
  const sg = await fdSigles();
  // au passage, les sigles définis dans les fiches déjà lues par le fil
  for (const [id, t] of FD.text) { if (sg.seen.has(id)) continue; sg.seen.add(id); const f = fiche(id); if (f && inCursus(f)) for (const d of FDX.defs(t.segs.join(' '))) if (!sg.list.has(d.abbr)) sg.list.set(d.abbr, { ...d, f }); }
  const all = [...sg.list.values()];
  if (all.length < 4) return null;
  // leurres aux mêmes initiales (un mot changé) : avec d'autres sigles au hasard, les initiales donnaient la réponse
  if (!sg.vocab || sg.vocabN !== FD.text.size) {
    sg.vocab = FDX.sigleVocab(all.map((x) => x.full), [...FD.text.values()].flatMap((t) => t.segs));
    sg.vocabN = FD.text.size;
  }
  const real = all.map((x) => x.full);
  const cands = FDX.shuffle(all);
  let a = null;
  let fakes = [];
  for (const x of cands.slice(0, 12)) { fakes = FDX.fakeFull(x.full, sg.vocab, real, 2); if (fakes.length === 2) { a = x; break; } }
  if (!a) return null;
  const opts = FDX.shuffle([a, ...fakes.map((full) => ({ abbr: '', full }))]);
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (x, b) => {
    if (done) return;
    done = true;
    const ok = x === a;
    fdScore(ok);
    for (const y of btns.children) { y.disabled = true; if (y.dataset.a === a.abbr) y.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, ` · ${a.abbr} : ${a.full}`)), fdRef(a.f));
  };
  const btns = h('div', { class: 'fd-opts' }, ...opts.map((x) => { const b = h('button', { 'data-a': x.abbr, onclick: () => choose(x, b) }, x.full); return b; }));
  return fdSlide('sigle', 'Le sigle', h('div', { class: 'fd-sigle mono' }, a.abbr), btns, out);
}

// ── 15. Combien ? (cartes « liste à citer ») ──
function fdListCards() { return S.data.cards.filter((c) => c.kind === 'list' && !c.suspended && inCursus(c) && Array.isArray(c.steps) && c.steps.length >= 3 && c.steps.length <= 10); }
async function fdCount() {
  const c = fdPick(fdListCards());
  if (!c) return null;
  const f = fiche(c.ficheId);
  const n = c.steps.length;
  const choices = FDX.shuffle([n - 1, n, n + 1, n + 2].filter((x) => x >= 2)).slice(0, 4).sort((p, q) => p - q);
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (k, b) => {
    if (done) return;
    done = true;
    const ok = k === n;
    fdScore(ok);
    for (const x of btns.children) { x.disabled = true; if (Number(x.dataset.k) === n) x.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Le compte est bon' : 'Raté', h('span', { class: 'dim' }, ` · ${n}`)), h('ul', { class: 'fd-seq' }, ...c.steps.map((st) => h('li', {}, st))), fdRef(f));
  };
  const btns = h('div', { class: 'fd-nums' }, ...choices.map((k) => { const b = h('button', { class: 'mono', 'data-k': String(k), onclick: () => choose(k, b) }, String(k)); return b; }));
  return fdSlide('count', 'Combien ?', fdCtx(f, {}), h('p', { class: 'fd-big' }, String(c.title).replace(/\s*:?\s*cite[- ]les\.?$/i, '')), h('p', { class: 'small dim' }, 'Combien d’éléments dans cette liste ?'), btns, out);
}

// ── 16. Indication ou contre-indication ? (deux listes d'une même fiche) ──
const FD_CONTRA = /contre-indication|ne doit pas être utilisée?s?|ne pas utiliser|est contre-indiquée?|ne doivent pas être utilisée?s?/i;
async function fdIndic() {
  const pool = FDX.shuffle(fdFiches()).slice(0, 12);
  for (const f of pool) {
    const its = (await fdText(f)).items;
    const ind = its.filter((it) => it.head && /^indications?\b/i.test(it.head) && !FD_CONTRA.test(it.text) && !FD_CONTRA.test(it.lead || ''));
    const con = its.filter((it) => it.lead && FD_CONTRA.test(it.lead));
    if (!ind.length || !con.length) continue;
    fdRemember(f);
    const truth = Math.random() < 0.5 ? 'ci' : 'i';
    const it = fdPick(truth === 'ci' ? con : ind);
    const out = h('div', { class: 'fd-out' });
    let done = false;
    const answer = (said, b) => {
      if (done) return;
      done = true;
      const ok = said === truth;
      fdScore(ok);
      for (const x of btns.children) x.disabled = true;
      b.classList.add(ok ? 'right' : 'wrong');
      fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, truth === 'ci' ? ' · contre-indication' : ' · indication')),
        truth === 'ci' ? h('p', { class: 'fd-quote' }, it.lead) : null, fdRef(f));
    };
    const btns = h('div', { class: 'fd-vf-btns' }, h('button', { class: 'fd-no', onclick: (e) => answer('ci', e.currentTarget) }, 'Contre-indication'), h('button', { class: 'fd-yes', onclick: (e) => answer('i', e.currentTarget) }, 'Indication'));
    return fdSlide('indic', 'Indication ou contre-indication ?', fdCtx(f, {}), h('p', { class: 'fd-big' }, it.text), btns, out);
  }
  return null;
}

// ── 17. D'où ça vient ? (une phrase, trois fiches de chapitres différents) ──
async function fdWhere() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const others = [];
  for (const x of FDX.shuffle(S.data.fiches.filter((y) => y.page && inCursus(y) && y.id !== f.id && y.chapter !== f.chapter))) {
    if (others.length < 2 && !others.some((o) => o.chapter === x.chapter)) others.push(x);
  }
  if (others.length < 2) return null;
  const words = new Set(FDX.publics(f.title).concat(norm(f.title).split(/[^a-z0-9]+/).filter((w) => w.length > 4)));
  // phrase assez longue pour être reconnaissable, qui ne recopie pas le titre
  const cand = (await fdText(f)).items.filter((it) => it.text.length >= 60 && it.text.length <= 220 && norm(it.text).split(/[^a-z0-9]+/).filter((w) => words.has(w)).length < 2);
  if (!cand.length) return null;
  fdRemember(f);
  const it = fdPick(cand);
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (x, b) => {
    if (done) return;
    done = true;
    const ok = x.id === f.id;
    fdScore(ok);
    for (const y of btns.children) { y.disabled = true; if (y.dataset.id === f.id) y.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté'), it.head ? h('p', { class: 'small dim' }, `Rubrique : ${it.head}`) : null, fdRef(f));
  };
  const btns = h('div', { class: 'fd-opts' }, ...FDX.shuffle([f, ...others]).map((x) => { const b = h('button', { 'data-id': x.id, onclick: () => choose(x, b) }, x.title); return b; }));
  return fdSlide('where', 'D’où ça vient ?', h('p', { class: 'fd-big' }, it.text), btns, out);
}

// ── 18. La suite de la phrase (les fausses fins viennent de la même fiche) ──
async function fdTail() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const cuts = (await fdText(f)).items.map((it) => ({ it, c: FDX.cutSentence(it.text) })).filter((x) => x.c && x.c.tail.length <= 160);
  if (cuts.length < 3) return null;
  fdRemember(f);
  const main = fdPick(cuts);
  const fakes = FDX.shuffle(cuts.filter((x) => x !== main && norm(x.c.tail) !== norm(main.c.tail))).slice(0, 2);
  if (fakes.length < 2) return null;
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (x, b) => {
    if (done) return;
    done = true;
    const ok = x === main;
    fdScore(ok);
    for (const y of btns.children) { y.disabled = true; if (y.dataset.main === '1') y.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté'), h('p', { class: 'fd-quote' }, main.it.text), fdRef(f));
  };
  const btns = h('div', { class: 'fd-opts' }, ...FDX.shuffle([main, ...fakes]).map((x) => { const b = h('button', { 'data-main': x === main ? '1' : '0', onclick: () => choose(x, b) }, `… ${x.c.tail}`); return b; }));
  return fdSlide('tail', 'La suite de la phrase', fdCtx(f, main.it), h('p', { class: 'fd-big' }, `${main.c.head} …`), btns, out);
}

/** Auto-évaluation après avoir dévoilé : « Je l'avais » / « Raté » (la série seulement). */
function fdSelf(out, ...kids) {
  let done = false;
  const pick = (ok) => { if (done) return; done = true; fdScore(ok); row.replaceChildren(h('span', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Trouvé' : 'À revoir')); };
  const row = h('div', { class: 'fd-vf-btns' }, h('button', { class: 'fd-no', onclick: () => pick(false) }, 'Raté'), h('button', { class: 'fd-yes', onclick: () => pick(true) }, 'Je l’avais'));
  fdOut(out, ...kids, row);
}

// ── 19. Le mot qui manque (première lettre donnée) ──
async function fdWord() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const t = await fdText(f);
  if (!t.freq) { t.freq = new Map(); for (const s of t.segs) for (const w of s.toLowerCase().match(/[a-zà-ÿ’'-]{7,}/g) || []) t.freq.set(w.replace(/^[ld][’']/, ''), (t.freq.get(w.replace(/^[ld][’']/, '')) || 0) + 1); }
  const cand = t.items.filter((it) => it.text.length >= 40 && it.text.length <= 220).map((it) => ({ it, k: FDX.keyWord(it.text, t.freq) })).filter((x) => x.k);
  if (!cand.length) return null;
  fdRemember(f);
  const { it, k } = fdPick(cand);
  const blank = h('span', { class: 'fd-blank fd-word' }, `${k.word[0]}${'·'.repeat(Math.max(2, k.word.length - 1))}`);
  const out = h('div', { class: 'fd-out' });
  const tap = h('button', { class: 'fd-tap', onclick: () => { tap.remove(); blank.textContent = k.word; blank.classList.add('shown'); fdSelf(out, fdRef(f)); } }, 'Voir le mot');
  return fdSlide('word', 'Le mot qui manque', fdCtx(f, it), h('p', { class: 'fd-big' }, it.text.slice(0, k.index), blank, it.text.slice(k.index + k.word.length)), h('p', { class: 'small dim' }, `${k.word.length} lettres`), tap, out);
}

// ── 20. Il en manque un (liste à citer, un élément retiré) ──
async function fdMissing() {
  const c = fdPick(fdListCards().filter((x) => x.steps.length <= 8));
  if (!c) return null;
  const f = fiche(c.ficheId);
  const gone = Math.floor(Math.random() * c.steps.length);
  const out = h('div', { class: 'fd-out' });
  const list = h('ul', { class: 'fd-seq fd-miss' }, ...c.steps.map((st, k) => (k === gone ? h('li', { class: 'gap' }, '?') : h('li', {}, st))));
  const tap = h('button', { class: 'fd-tap', onclick: () => { tap.remove(); const li = list.children[gone]; li.textContent = c.steps[gone]; li.classList.add('shown'); fdSelf(out, fdRef(f)); } }, 'Voir l’élément manquant');
  return fdSlide('missing', 'Il en manque un', fdCtx(f, {}), h('p', { class: 'fd-q' }, String(c.title).replace(/\s*:?\s*cite[- ]les\.?$/i, '')), list, tap, out);
}

// ── 21. Quelle détresse ? (signes propres à une détresse, RTN 05AC07 à 05AC09) ──
async function fdDistress() {
  const q = FDX.distressQuiz();
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (d, b) => {
    if (done) return;
    done = true;
    const ok = d.k === q.k;
    fdScore(ok);
    for (const x of btns.children) { x.disabled = true; if (x.dataset.k === q.k) x.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, ` · détresse ${q.label.toLowerCase()} (${q.code})`)), fdRef(fdByCode(q.code)));
  };
  const btns = h('div', { class: 'fd-vf-btns three' }, ...FDX.DISTRESS.map((d) => { const b = h('button', { 'data-k': d.k, onclick: () => choose(d, b) }, d.label); return b; }));
  return fdSlide('distress', 'Quelle détresse ?', h('div', { class: 'fd-vital' }, h('span', { class: 'fd-vital-l' }, 'Signe constaté'), h('span', { class: 'fd-sign' }, q.sign)), btns, out);
}

// ── 22. Le calcul (oxygène 05AC01, paume 07AC01) ──
async function fdCalc() {
  const q = FDX.calcQuiz();
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (v, b) => {
    if (done) return;
    done = true;
    const ok = v === q.answer;
    fdScore(ok);
    for (const x of btns.children) { x.disabled = true; if (Number(x.dataset.v) === q.answer) x.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Juste' : 'Raté', h('span', { class: 'dim' }, ` · ${q.answer} ${q.unit}`)), h('p', { class: 'fd-quote' }, q.explain, ` (${q.code})`), fdRef(fdByCode(q.code)));
  };
  const btns = h('div', { class: 'fd-nums' }, ...q.choices.map((v) => { const b = h('button', { class: 'mono', 'data-v': String(v), onclick: () => choose(v, b) }, `${v}`); return b; }));
  return fdSlide('calc', 'Le calcul', h('p', { class: 'fd-big' }, q.question), h('p', { class: 'small dim' }, `Réponse en ${q.unit}`), btns, out);
}

// ── 23. Jamais ou toujours ? (la phrase absolue, telle quelle ou retournée) ──
async function fdAbsolute() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const cand = (await fdText(f)).items.map((it) => ({ it, flip: FDX.flipAbsolute(it.text) })).filter((x) => x.flip && x.it.text.length <= 220);
  if (!cand.length) return null;
  fdRemember(f);
  const { it, flip } = fdPick(cand);
  const truth = Math.random() < 0.5;
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const answer = (said, b) => {
    if (done) return;
    done = true;
    const ok = said === truth;
    fdScore(ok);
    for (const x of btns.children) x.disabled = true;
    b.classList.add(ok ? 'right' : 'wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, ` · c’était ${truth ? 'vrai' : 'faux'}`)), h('p', { class: 'fd-quote' }, it.text), fdRef(f));
  };
  const btns = h('div', { class: 'fd-vf-btns' }, h('button', { class: 'fd-no', onclick: (e) => answer(false, e.currentTarget) }, 'Faux'), h('button', { class: 'fd-yes', onclick: (e) => answer(true, e.currentTarget) }, 'Vrai'));
  return fdSlide('absolute', 'Jamais ou toujours ?', fdCtx(f, it), h('div', { class: 'fd-vf-card' }, h('p', { class: 'fd-big' }, truth ? it.text : flip)), btns, out);
}

// ── 24. L'ordre du bilan (RTN 04AC01, 04PR06) ──
async function fdSequence() {
  const q = fdPick(FDX.SEQUENCES);
  const f = fdByCode(q.code);
  let next = 0;
  let errors = 0;
  const done = h('ol', { class: 'fd-done' });
  const out = h('div', { class: 'fd-out' });
  const pool = h('div', { class: 'fd-pool' }, ...FDX.shuffle(q.steps.map((s, k) => ({ s, k }))).map(({ s, k }) => {
    const b = h('button', { onclick: () => {
      if (k === next) {
        b.remove();
        done.append(h('li', {}, s));
        next += 1;
        if (next === q.steps.length) { fdScore(errors === 0); fdOut(out, h('div', { class: `fd-verdict ${errors ? 'bad' : 'ok'}` }, errors ? `Terminé · ${errors} erreur${errors > 1 ? 's' : ''}` : 'Sans faute'), h('p', { class: 'small dim' }, q.code), fdRef(f)); }
      } else { errors += 1; b.classList.remove('shake'); void b.offsetWidth; b.classList.add('shake'); }
    } }, s);
    return b;
  }));
  return fdSlide('sequence', 'L’ordre du bilan', h('p', { class: 'fd-q' }, q.title), h('p', { class: 'small dim' }, 'Touche les étapes dans l’ordre.'), done, pool, out);
}

// ── 25. Avant ou après le repère ? (cartes « ordre ») ──
const FD_LANDMARK = /garrot|DAE|défibrillateur|PLS|latérale de sécurité|alerte|alerter|compressions?|insufflations?|oxygène|couverture/i;
async function fdLandmark() {
  const c = fdPick(fdOrderCards());
  if (!c) return null;
  const f = fiche(c.ficheId);
  const marks = c.steps.map((s, k) => k).filter((k) => FD_LANDMARK.test(c.steps[k]));
  const j = marks.length ? fdPick(marks) : Math.floor(Math.random() * c.steps.length);
  const i = fdPick(c.steps.map((s, k) => k).filter((k) => k !== j));
  const truth = i < j ? 'avant' : 'après';
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const answer = (said, b) => {
    if (done) return;
    done = true;
    const ok = said === truth;
    fdScore(ok);
    for (const x of btns.children) x.disabled = true;
    b.classList.add(ok ? 'right' : 'wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, ` · ${truth}`)), h('ol', { class: 'fd-seq' }, ...c.steps.map((st, k) => h('li', { class: k === i || k === j ? 'hl' : '' }, st))), fdRef(f));
  };
  const btns = h('div', { class: 'fd-vf-btns' }, h('button', { onclick: (e) => answer('avant', e.currentTarget) }, 'Avant'), h('button', { onclick: (e) => answer('après', e.currentTarget) }, 'Après'));
  return fdSlide('landmark', 'Avant ou après ?', fdCtx(f, { head: String(c.title).replace(/\s*:?\s*remets?[- ]les? dans l[’']ordre\.?$/i, '') }),
    h('p', { class: 'fd-big' }, c.steps[i]), h('div', { class: 'fd-mark-step' }, h('span', { class: 'small dim' }, 'par rapport à'), h('b', {}, c.steps[j])), btns, out);
}

// ── 26. Le délai (valeurs de temps des fiches, quatre choix) ──
const FD_TIME = /^(min|minutes?|secondes?|sec|s|heures?|h|jours?)$/;
async function fdDelay() {
  const f = fdPick(fdFiches());
  if (!f) return null;
  const cand = FDX.valued((await fdText(f)).items).filter((c) => FD_TIME.test(c.v.unit));
  if (!cand.length) return null;
  fdRemember(f);
  const it = fdPick(cand);
  const { text, v } = it;
  const right = FDX.valueText(v);
  const opts = new Set([right]);
  for (let k = 0; k < 20 && opts.size < 4; k++) opts.add(FDX.alter(v).text);
  if (opts.size < 3) return null;
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (o, b) => {
    if (done) return;
    done = true;
    const ok = o === right;
    fdScore(ok);
    for (const x of btns.children) { x.disabled = true; if (x.dataset.o === right) x.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, ` · ${right}`)), h('p', { class: 'fd-quote' }, text.slice(0, v.index), h('mark', {}, text.slice(v.index, v.index + v.len)), text.slice(v.index + v.len)), fdRef(f));
  };
  const btns = h('div', { class: 'fd-opts' }, ...FDX.shuffle([...opts]).map((o) => { const b = h('button', { class: 'mono', 'data-o': o, onclick: () => choose(o, b) }, o); return b; }));
  return fdSlide('delay', 'Le délai', fdCtx(f, it), h('p', { class: 'fd-big' }, text.slice(0, v.index), h('span', { class: 'fd-blank' }, '?'), text.slice(v.index + v.len)), btns, out);
}

// ── 27. Ce que voit le témoin (paroles → détresse, signes 05AC07 à 05AC09) ──
async function fdWitness() {
  const q = fdPick(FDX.WITNESS);
  const d = FDX.DISTRESS.find((x) => x.k === q.k);
  const out = h('div', { class: 'fd-out' });
  let done = false;
  const choose = (k, b) => {
    if (done) return;
    done = true;
    const ok = k === q.k;
    fdScore(ok);
    for (const x of btns.children) { x.disabled = true; if (x.dataset.k === q.k) x.classList.add('right'); }
    if (!ok) b.classList.add('wrong');
    fdOut(out, h('div', { class: `fd-verdict ${ok ? 'ok' : 'bad'}` }, ok ? 'Bien vu' : 'Raté', h('span', { class: 'dim' }, ` · détresse ${d.label.toLowerCase()} (${d.code})`)), h('p', { class: 'fd-quote' }, 'Signe : ', h('mark', {}, q.sign)), fdRef(fdByCode(d.code)));
  };
  const btns = h('div', { class: 'fd-vf-btns three' }, ...FDX.DISTRESS.map((x) => { const b = h('button', { 'data-k': x.k, onclick: () => choose(x.k, b) }, x.label); return b; }));
  return fdSlide('witness', 'Ce que voit le témoin', h('p', { class: 'small muted' }, 'Le témoin vous dit :'), h('p', { class: 'fd-said' }, q.said), h('p', { class: 'small dim' }, 'Quelle détresse ce signe évoque-t-il ?'), btns, out);
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
  { id: 'before', w: 2, make: fdBefore, ok: () => fdOrderCards().length > 0 },
  { id: 'public', w: 0.8, make: fdPublic, ok: () => S.data.fiches.length > 0 },
  { id: 'norm', w: 2, make: fdNorm, ok: () => true },
  { id: 'urgent', w: 1.5, make: fdUrgent, ok: () => true },
  { id: 'reflex', w: 2, make: fdReflex, ok: fdReflexOk },
  { id: 'sigle', w: 1.5, make: fdSigle, ok: () => S.data.fiches.length > 0 },
  { id: 'count', w: 1.5, make: fdCount, ok: () => fdListCards().length > 0 },
  { id: 'indic', w: 0.4, make: fdIndic, ok: () => S.data.fiches.length > 0 },
  { id: 'where', w: 1.5, make: fdWhere, ok: () => S.data.fiches.length > 3 },
  { id: 'tail', w: 1.5, make: fdTail, ok: () => S.data.fiches.length > 0 },
  { id: 'word', w: 1.5, make: fdWord, ok: () => S.data.fiches.length > 0 },
  { id: 'missing', w: 1.2, make: fdMissing, ok: () => fdListCards().length > 0 },
  { id: 'distress', w: 1.5, make: fdDistress, ok: () => true },
  { id: 'calc', w: 1, make: fdCalc, ok: () => true },
  { id: 'absolute', w: 1.5, make: fdAbsolute, ok: () => S.data.fiches.length > 0 },
  { id: 'sequence', w: 0.5, make: fdSequence, ok: () => true },
  { id: 'landmark', w: 1.2, make: fdLandmark, ok: () => fdOrderCards().length > 0 },
  { id: 'delay', w: 1.2, make: fdDelay, ok: () => S.data.fiches.length > 0 },
  { id: 'witness', w: 1.2, make: fdWitness, ok: () => true },
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
      if (slide) { FD.last = pick.id; slide.dataset.fmt = pick.id; return slide; }
    } catch (err) {
      console.warn('fil', pick.id, err);
    }
  }
  return null;
}

/**
 * Garde toujours quelques écrans d'avance ; vide les écrans loin derrière.
 * On ne retire jamais un écran et on ne touche jamais à scrollTop pendant le geste : recaler la position
 * en plein défilement aimanté cassait l'arrêt écran par écran (le fil filait des dizaines d'écrans d'un coup).
 * Un écran vidé garde sa hauteur : la position ne bouge pas.
 */
function fdFill(ahead = 3) {
  if (FD.busy) return FD.busy;
  FD.busy = (async () => {
    const list = FD.list;
    while (list && list.isConnected) {
      const slides = list.children;
      const cur = Math.round(list.scrollTop / Math.max(1, list.clientHeight));
      if (slides.length - 1 - cur >= ahead) break;
      const s = await fdMake();
      if (!s) break;
      list.append(s);
      FD.obs.observe(s);
    }
    if (list && list.clientHeight) {
      const cur = Math.round(list.scrollTop / list.clientHeight);
      for (; FD.gone < cur - 12; FD.gone++) {
        const s = list.children[FD.gone];
        if (!s) break;
        FD.obs.unobserve(s);
        if (s.fdHide) s.fdHide();
        s.fdShow = s.fdHide = null;
        s.replaceChildren();
        s.className = 'fd-slide fd-gone';
      }
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
  FD.gone = 1;
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
