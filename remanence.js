'use strict';

/**
 * Rémanence — logique pure (cœur, interface, tests) :
 *   - planification des révisions : FSRS 4.5 (poids par défaut), rétention cible réglable ;
 *   - découpage du référentiel PSE en fiches à partir du texte des pages (codes AC / PR / FT) ;
 *   - textes à trous {{…}} ;
 *   - maîtrise (probabilité de rappel) et rythme conseillé avant une échéance.
 * Aucune dépendance. Global navigateur : window.DawnRemanence.
 */

(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else global.DawnRemanence = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const W = [0.4072, 1.1829, 3.1262, 15.4722, 7.2102, 0.5316, 1.0651, 0.0234, 1.616, 0.1544, 1.0824, 1.9813, 0.0953, 0.2975, 2.2042, 0.2407, 2.9466, 0.5034, 0.6567];
  const DECAY = -0.5;
  const FACTOR = 19 / 81;
  const DAY = 86400000;
  const MAX_DAYS = 1095;
  const RELEARN_MIN = 10; // « Encore » : la carte revient dans 10 min
  const GRADES = Object.freeze({ again: 1, hard: 2, good: 3, easy: 4 });
  const GRADE_LABELS = Object.freeze({ 1: 'Encore', 2: 'Difficile', 3: 'Bien', 4: 'Facile' });

  const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
  const newState = () => ({ state: 'new', due: null, s: 0, d: 0, reps: 0, lapses: 0, last: null });

  /** Probabilité de rappel après `days` jours pour une stabilité `s`. */
  const retrievability = (days, s) => (s > 0 ? (1 + (FACTOR * Math.max(0, days)) / s) ** DECAY : 0);
  const intervalFor = (s, retention = 0.9) => clamp(Math.round((s / FACTOR) * (retention ** (1 / DECAY) - 1)), 1, MAX_DAYS);
  const d0 = (g) => clamp(W[4] - (g - 3) * W[5], 1, 10);

  /** Nouvel état après une réponse (g = 1…4) à l'instant `now` (ms). */
  function review(srs, g, now = Date.now(), retention = 0.9) {
    const c = { ...newState(), ...(srs || {}) };
    g = clamp(Math.round(Number(g)) || 1, 1, 4);
    let s;
    let d;
    if (c.state === 'new' || !(c.s > 0)) {
      s = W[g - 1];
      d = d0(g);
    } else {
      const elapsed = c.last ? Math.max(0, (now - Date.parse(c.last)) / DAY) : 0;
      const r = retrievability(elapsed, c.s);
      d = clamp(W[7] * d0(4) + (1 - W[7]) * (c.d - W[6] * (g - 3)), 1, 10);
      if (g === 1) {
        s = Math.min(c.s, W[11] * c.d ** -W[12] * ((c.s + 1) ** W[13] - 1) * Math.exp(W[14] * (1 - r)));
      } else {
        const hard = g === 2 ? W[15] : 1;
        const easy = g === 4 ? W[16] : 1;
        s = c.s * (Math.exp(W[8]) * (11 - c.d) * c.s ** -W[9] * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy + 1);
      }
    }
    s = clamp(s, 0.01, 36500);
    const lapse = g === 1 && c.state !== 'new';
    const due = g === 1 ? now + RELEARN_MIN * 60000 : now + intervalFor(s, retention) * DAY;
    return {
      state: g === 1 ? (c.state === 'new' ? 'learning' : 'relearning') : 'review',
      due: new Date(due).toISOString(),
      s: Math.round(s * 1000) / 1000,
      d: Math.round(d * 1000) / 1000,
      reps: c.reps + 1,
      lapses: c.lapses + (lapse ? 1 : 0),
      last: new Date(now).toISOString(),
    };
  }

  /** Aperçu de l'échéance de chaque réponse, pour les boutons (« 10 min », « 3 j »…). */
  function preview(srs, now = Date.now(), retention = 0.9) {
    const out = {};
    for (const g of [1, 2, 3, 4]) out[g] = waitLabel(Date.parse(review(srs, g, now, retention).due) - now);
    return out;
  }

  function waitLabel(ms) {
    const min = Math.round(ms / 60000);
    if (min < 60) return `${min} min`;
    const days = Math.round(ms / DAY);
    if (days < 1) return `${Math.round(min / 60)} h`;
    if (days < 31) return `${days} j`;
    if (days < 365) return `${Math.round(days / 30)} mois`;
    return `${(days / 365).toFixed(1).replace('.', ',')} an${days >= 730 ? 's' : ''}`;
  }

  /** Probabilité de rappel actuelle (null pour une carte jamais vue). */
  function recall(srs, now = Date.now()) {
    if (!srs || srs.state === 'new' || !(srs.s > 0) || !srs.last) return null;
    return retrievability((now - Date.parse(srs.last)) / DAY, srs.s);
  }

  const isDue = (srs, until = Date.now()) => Boolean(srs && srs.state !== 'new' && srs.due && Date.parse(srs.due) <= until);

  /** Nouvelles cartes par jour pour tout voir au moins une semaine avant l'échéance. */
  function pace(newCount, daysLeft) {
    if (!newCount) return 0;
    if (daysLeft == null) return Math.min(20, newCount);
    return Math.ceil(newCount / Math.max(1, daysLeft - 7));
  }

  // ── textes à trous ──
  const CLOZE_RE = /\{\{([^{}]+)\}\}/g;
  const hasCloze = (text) => /\{\{[^{}]+\}\}/.test(String(text || ''));
  function cloze(text) {
    const answers = [];
    const masked = String(text || '').replace(CLOZE_RE, (_, a) => {
      answers.push(a.trim());
      return `[ ${answers.length} ]`;
    });
    return { masked, answers, full: String(text || '').replace(CLOZE_RE, '$1') };
  }

  // ── découpage du référentiel ──
  const NATURES = Object.freeze({ AC: 'Apport de connaissances', PR: 'Procédure', FT: 'Fiche technique', X: 'Autre' });
  // en-tête du référentiel national : « [01AC04 / 11-2021] PSE① », « [06FT03 / 11/2021] PSE①② », « [04FT11 / 12-2022] »
  const CODE_H = /^\[\s*(\d{2})\s?(AC|PR|FT)\s?(\d{2})\s*(?:\/\s*(\d{1,2})\s*[-/.]\s*(\d{4}))?\s*\]\s*(PSE\s*[①②12\s]*)?\s*(.*)$/i;
  // « PR 03 A 01 », « PR03A01 », « Fiche FT 05 B 02 – Titre » ; ou la forme « 03PR01 »
  const CODE_A = /^\s*(?:fiche\s+)?(AC|PR|FT)\s?(\d{1,2})\s?([A-Z])\s?(\d{1,2})\b\s*[-–—:.]?\s*(.*)$/i;
  const CODE_B = /^\s*(?:fiche\s+)?(\d{2})\s?(AC|PR|FT)\s?(\d{2})\b\s*[-–—:.]?\s*(.*)$/i;
  const TOC_LINE = /(\.\s?){4,}\s*\d+\s*$|_{3,}\s*\d+\s*$|\s{3,}\d+\s*$/;
  const pad = (n) => String(n).padStart(2, '0');

  /** PSE① → PSE1, PSE② → PSE2, PSE①② → PSE1 (socle commun), sans marque → ''. */
  function cursusOf(mark) {
    const m = String(mark || '');
    if (/[①1]/.test(m)) return 'PSE1';
    if (/[②2]/.test(m)) return 'PSE2';
    return '';
  }

  function codeOf(line) {
    let m = CODE_H.exec(line);
    if (m) {
      const nature = m[2].toUpperCase();
      return { code: `${nature} ${m[1]} ${m[3]}`, nature, chapter: m[1], rest: m[7].trim(), edition: m[5] ? `${pad(m[4])}-${m[5]}` : '', cursus: cursusOf(m[6]), header: true };
    }
    m = CODE_A.exec(line);
    if (m) return { code: `${m[1].toUpperCase()} ${pad(m[2])} ${m[3].toUpperCase()} ${pad(m[4])}`, nature: m[1].toUpperCase(), chapter: pad(m[2]), rest: m[5].trim() };
    m = CODE_B.exec(line);
    if (m) return { code: `${m[2].toUpperCase()} ${m[1]} ${m[3]}`, nature: m[2].toUpperCase(), chapter: m[1], rest: m[4].trim() };
    return null;
  }

  // ── mise en page d'un PDF → Markdown ──

  /** Ligne Markdown → texte simple (détection des codes, titres, comparaison). */
  const mdPlain = (line) => String(line || '')
    .replace(/^\s*#{1,6}\s+/, '')
    .replace(/\\(.)|\*+/g, (m, c) => (c !== undefined ? c : ''))
    .trim();
  const BULLET_RE = /^[•▪■●◦○➢►✓✔‣⁃-−–—-]$/;
  const MD_ESC = /[\\`*_[\]~|]/g;
  const escMd = (s) => s.replace(MD_ESC, '\\$&');

  /** « **a** **b** » → « **a b** » (même style de part et d'autre d'un retour à la ligne recousu). */
  const joinMarks = (t) => t.replace(/\*\* \*\*/g, ' ').replace(/(^|[^*])\* \*(?!\*)/g, '$1 ');

  /** Fragments → lignes : même ligne de base ; puce détachée ; espaces rétablis d'après l'écart ; gras / italique. */
  function pdfLines(frags) {
    const lines = [];
    for (const f of [...frags].sort((a, b) => b.y - a.y || a.x - b.x)) {
      const l = lines.find((x) => Math.abs(x.y - f.y) <= 0.4 * Math.max(x.h, f.h));
      if (l) { l.runs.push(f); l.h = Math.max(l.h, f.h); } else lines.push({ y: f.y, h: f.h, runs: [f] });
    }
    lines.sort((a, b) => b.y - a.y);
    const out = [];
    for (const l of lines) {
      const runs = l.runs.sort((a, b) => a.x - b.x);
      let bullet = null;
      const first = runs[0].str.trim();
      if (runs.length > 1 && (BULLET_RE.test(first) || (first === 'o' && runs[0].symbol)) && runs[1].x - (runs[0].x + runs[0].w) > 0.15 * runs[0].h) bullet = runs.shift();
      const segs = [];
      let prev = null;
      for (const r of runs) {
        let s = r.str;
        if (prev && !/\s$/.test(prev.str) && !/^\s/.test(s) && r.x - (prev.x + prev.w) > 0.12 * Math.max(r.h, prev.h)) s = ` ${s}`;
        const style = `${r.bold ? 'b' : ''}${r.italic ? 'i' : ''}`;
        const last = segs[segs.length - 1];
        if (last && last.style === style) last.s += s; else segs.push({ style, s });
        prev = r;
      }
      const plain = segs.map((x) => x.s).join('').replace(/\s+/g, ' ').trim();
      if (!plain) continue;
      const md = segs.map(({ style, s }) => {
        const m = s.match(/^(\s*)(.*?)(\s*)$/s);
        if (!m[2]) return s;
        const mark = style === 'bi' ? '***' : style === 'b' ? '**' : style === 'i' ? '*' : '';
        return `${m[1]}${mark}${escMd(m[2])}${mark}${m[3]}`;
      }).join('').replace(/\s+/g, ' ').trim();
      out.push({ y: l.y, size: Math.max(...runs.map((r) => r.h)), x: runs[0].x, bulletX: bullet ? bullet.x : null, md, plain });
    }
    return out;
  }

  /**
   * Tableaux à bordures d'une page. rules = [[x1, y1, x2, y2], …] : traits (et filets pleins très fins) dans le repère
   * du PDF. Un tableau = des traits qui se croisent et forment une grille fermée : chaque bande horizontale va d'un bord
   * à l'autre, au moins 2 bandes et 2 colonnes, 80 % des cases avec leurs quatre bords. Les encadrés (une seule case),
   * les logigrammes (cases séparées par des vides) et les schémas au trait ne passent pas ces règles ; un tableau
   * presque vide de texte est aussi écarté par l'appelant.
   * Renvoie [{ x1, y1, x2, y2, cols: [x…], bands: [{ top, bot, cells: [{ xl, xr }] }] }].
   */
  function pdfGrids(rules) {
    const T = 2;
    const J = 7; // raccord : les bordures de case s'arrêtent souvent quelques points avant le trait voisin
    const merge = (segs) => {
      const out = [];
      for (const s of segs.sort((a, b) => a.k - b.k || a.a - b.a)) {
        const p = out[out.length - 1];
        if (p && Math.abs(p.k - s.k) <= 1.5 && s.a <= p.b + T) p.b = Math.max(p.b, s.b);
        else out.push({ ...s });
      }
      return out;
    };
    const H = [];
    const V = [];
    for (const [x1, y1, x2, y2] of rules || []) {
      if (Math.abs(y1 - y2) < 1 && Math.abs(x2 - x1) > 6) H.push({ k: (y1 + y2) / 2, a: Math.min(x1, x2), b: Math.max(x1, x2) });
      else if (Math.abs(x1 - x2) < 1 && Math.abs(y2 - y1) > 6) V.push({ k: (x1 + x2) / 2, a: Math.min(y1, y2), b: Math.max(y1, y2) });
    }
    const hs = merge(H);
    const vs = merge(V);
    // composantes : traits horizontaux et verticaux qui se croisent ou se touchent
    const all = [...hs.map((s) => ({ ...s, h: true })), ...vs.map((s) => ({ ...s, h: false }))];
    const parent = all.map((_, i) => i);
    const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
    all.forEach((p, i) => {
      if (!p.h) return;
      all.forEach((q, j) => {
        if (q.h) return;
        if (q.k >= p.a - J && q.k <= p.b + J && p.k >= q.a - J && p.k <= q.b + J) parent[find(i)] = find(j);
      });
    });
    const groups = new Map();
    all.forEach((s, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(s); });
    const uniq = (arr) => arr.sort((a, b) => a - b).reduce((o, v) => (o.length && v - o[o.length - 1] <= T ? o : [...o, v]), []);
    const grids = [];
    for (const g of groups.values()) {
      const gh = g.filter((s) => s.h);
      const gv = g.filter((s) => !s.h);
      if (gh.length < 2 || gv.length < 2) continue;
      const x1 = Math.min(...gh.map((s) => s.a));
      const x2 = Math.max(...gh.map((s) => s.b));
      const ys = uniq(gh.map((s) => s.k)).reverse();
      const covers = (y, a, b) => gh.some((s) => Math.abs(s.k - y) <= T && s.a <= a + J && s.b >= b - J);
      const bands = [];
      let cells = 0;
      let closed = 0;
      let ok = true;
      for (let i = 0; i + 1 < ys.length; i++) {
        const top = ys[i];
        const bot = ys[i + 1];
        if (top - bot < 4) continue;
        const xs = uniq(gv.filter((s) => Math.min(s.b, top) - Math.max(s.a, bot) >= 0.6 * (top - bot)).map((s) => s.k));
        if (xs.length < 2 || xs[0] > x1 + J || xs[xs.length - 1] < x2 - J) { ok = false; break; } // bande sans bord gauche ou droit : pas une grille
        const row = [];
        for (let j = 0; j + 1 < xs.length; j++) {
          cells += 1;
          if (covers(top, xs[j], xs[j + 1]) && covers(bot, xs[j], xs[j + 1])) closed += 1;
          row.push({ xl: xs[j], xr: xs[j + 1] });
        }
        bands.push({ top, bot, cells: row });
      }
      if (!ok || bands.length < 2 || closed < 0.8 * cells) continue;
      const cols = uniq(bands.flatMap((b) => b.cells.flatMap((c) => [c.xl, c.xr])));
      if (cols.length < 3) continue;
      grids.push({ x1, x2, y1: bands[bands.length - 1].bot, y2: bands[0].top, cols, bands });
    }
    return grids;
  }

  /**
   * Texte d'une page de PDF rendu en Markdown, d'après la position et la police de chaque fragment.
   * items = [{ str, x, y, w, h, bold, italic, symbol }] (y vers le haut, comme dans le PDF), height = hauteur de page.
   *   titres      taille ≥ 1,3 × le corps (les tailles les plus grandes donnent ##, puis ###, ####) ;
   *   listes      puce (glyphe isolé ou « o » d'une police de symboles) ; l'imbrication suit le retrait de la puce ;
   *   paragraphes les lignes rapprochées, alignées et de même taille sont rejointes ;
   *   tableaux    grilles à bordures (`rules`, voir pdfGrids) ; une case fusionnée garde son texte dans sa première
   *               colonne, les lignes d'une case sont séparées par <br> ;
   *   gras / italique d'après la police ; numéros de page en tête ou en pied écartés.
   */
  function pdfPageMarkdown(items, height = 842, rules = null) {
    let frags = items.filter((it) => it && typeof it.str === 'string' && it.str.trim() && it.h > 0)
      .map((it) => ({ ...it, str: it.str.replace(/\s+/g, ' ') }));
    // tableaux : leurs fragments quittent le flux, le tableau y entre à la hauteur de son bord supérieur
    const tables = [];
    for (const g of pdfGrids(rules)) {
      const inside = (f) => {
        const cx = f.x + f.w / 2;
        const cy = f.y + f.h / 3;
        return cx > g.x1 && cx < g.x2 && cy > g.y1 && cy < g.y2;
      };
      const mine = frags.filter(inside);
      const rows = g.bands.map((b) => g.cols.slice(0, -1).map((x) => {
        const cell = b.cells.find((c) => Math.abs(c.xl - x) <= 2);
        if (!cell) return '';
        const lines = pdfLines(mine.filter((f) => { const cx = f.x + f.w / 2; const cy = f.y + f.h / 3; return cx > cell.xl && cx < cell.xr && cy > b.bot && cy < b.top; }));
        // lignes recousues ; une puce ouvre une nouvelle ligne dans la case
        const parts = [];
        let last = null;
        for (const l of lines) {
          if (l.bulletX !== null || !last || last.y - l.y > 1.6 * l.size) parts.push(l.bulletX !== null ? `• ${l.md}` : l.md);
          else parts[parts.length - 1] += /[A-Za-zÀ-ÿ]-$/.test(parts[parts.length - 1]) ? l.md : ` ${l.md}`;
          last = l;
        }
        return parts.map(joinMarks).join('<br>');
      }));
      const filled = rows.flat().filter(Boolean).length;
      const cellCount = g.bands.reduce((n, b) => n + b.cells.length, 0);
      if (filled < 0.4 * cellCount) continue; // schéma au trait plutôt que tableau
      frags = frags.filter((f) => !mine.includes(f));
      const line = (cells) => `| ${cells.join(' | ')} |`;
      tables.push({ y: g.y2, table: [line(rows[0]), line(rows[0].map(() => '---')), ...rows.slice(1).map(line)].join('\n') });
    }
    const out = pdfLines(frags).filter((l) => !(/^\d{1,3}$/.test(l.plain) && l.bulletX === null && (l.y < 0.08 * height || l.y > 0.92 * height))); // numéro de page
    if (!out.length && !tables.length) return '';
    // taille du corps : la plus fréquente, pondérée par le nombre de caractères
    const weight = new Map();
    for (const l of out) { const k = Math.round(l.size); weight.set(k, (weight.get(k) || 0) + l.plain.length); }
    const body = weight.size ? [...weight.entries()].sort((a, b) => b[1] - a[1])[0][0] : 11;
    const isHead = (l) => l.bulletX === null && l.size >= body * 1.3 && l.plain.length < 160;
    const headSizes = [...new Set(out.filter(isHead).map((l) => Math.round(l.size)))].sort((a, b) => b - a);
    const bulletXs = [...new Set(out.filter((l) => l.bulletX !== null).map((l) => Math.round(l.bulletX)))].sort((a, b) => a - b);
    const levels = [];
    for (const x of bulletXs) if (!levels.length || x - levels[levels.length - 1] > 6) levels.push(x);
    const levelOf = (x) => levels.reduce((best, v, i) => (Math.abs(v - x) < Math.abs(levels[best] - x) ? i : best), 0);
    // blocs, tableaux compris, de haut en bas
    const flow = [...out, ...tables].sort((a, b) => b.y - a.y);
    const blocks = [];
    let cur = null;
    for (const l of flow) {
      const gap = cur ? cur.y - l.y : Infinity;
      if (l.table) {
        blocks.push(cur = { kind: 'table', text: l.table });
      } else if (isHead(l)) {
        if (cur && cur.kind === 'h' && Math.round(cur.size) === Math.round(l.size) && gap < 1.6 * l.size) cur.text += ` ${l.md}`;
        else blocks.push(cur = { kind: 'h', size: l.size, text: l.md, level: Math.min(4, 2 + headSizes.indexOf(Math.round(l.size))) });
      } else if (l.bulletX !== null) {
        blocks.push(cur = { kind: 'li', level: levelOf(l.bulletX), text: l.md, x: l.x, size: l.size });
      } else if (cur && (cur.kind === 'li' || cur.kind === 'p') && gap <= 1.5 * Math.max(l.size, cur.size) && Math.abs(l.size - cur.size) < 1.5
        && (cur.kind === 'li' ? Math.abs(l.x - cur.x) < 8 : l.x >= cur.x - 8 && l.x < cur.x + 40)) {
        cur.text += /[A-Za-zÀ-ÿ]-$/.test(cur.text) ? l.md : ` ${l.md}`;
      } else blocks.push(cur = { kind: 'p', text: l.md, x: l.x, size: l.size });
      cur.y = l.y;
    }
    const md = [];
    blocks.forEach((b, i) => {
      const prevB = blocks[i - 1];
      if (i && !(b.kind === 'li' && prevB.kind === 'li')) md.push('');
      if (b.kind === 'table') { md.push(b.text); return; }
      b.text = joinMarks(b.text);
      if (b.kind === 'h') md.push(`${'#'.repeat(b.level)} ${b.text.replace(/\*\*/g, '')}`);
      else if (b.kind === 'li') md.push(`${'  '.repeat(b.level)}- ${b.text}`);
      // paragraphe : un début qui ressemblerait à une syntaxe Markdown est neutralisé
      else md.push(b.text.replace(/^(#|>|[-+]\s|\d{1,9}[.)]\s)/, '\\$1'));
    });
    return md.join('\n');
  }

  const TABLE_LINE = /^\s*\|.*\|\s*$/m;
  /** Texte comparable : sans balisage Markdown (tableaux compris), sans puces, espaces resserrés. */
  const textCore = (s) => String(s || '').split(/\r?\n/)
    .filter((l) => !/^\s*\|(\s*-{3,}\s*\|)+\s*$/.test(l))
    .map((l) => mdPlain(l.replace(/^\s*[-*+]\s+/, '').replace(/<br>/g, ' ').replace(/(^|[^\\])\|/g, '$1 ').replace(/(^|\s)•\s/g, '$1')).replace(/^[•▪■●◦○➢►--]\s*/, '').replace(/^o\s+(?=\S)/, ''))
    .join(' ');

  /** Lignes d'une fiche → texte : espaces resserrés, retrait des éléments de liste imbriqués conservé. */
  const cleanText = (lines) => lines
    .map((l) => (/^\s*[-*+]\s/.test(l) ? l.replace(/\s+$/, '').replace(/(\S)[ \t]{2,}/g, '$1 ') : l.replace(/[ \t]+/g, ' ').trim()))
    .join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\s+$/g, '');

  /**
   * pages = [{ page, text }] → fiches [{ code, nature, chapter, title, page, text, edition, cursus }].
   * Référentiel national (en-têtes « [01AC01 / 07-2026] PSE① ») : une fiche commence à un en-tête placé
   * en haut de page ; le sommaire, la légende, les numéros de page et les pages de garde des chapitres
   * sont écartés. Autres documents : une fiche commence à une ligne qui débute par un code nouveau, les
   * en-têtes répétant le code courant et les lignes de sommaire sont ignorés. Un code vu plusieurs fois
   * garde l'occurrence la plus longue. Sans aucun code : une fiche par page.
   */
  function splitReferential(pages) {
    // plain : texte sans balisage (codes, titres, sommaire) ; raw : la ligne telle quelle (Markdown d'un PDF mis en page)
    const list = (pages || []).map((p) => ({ page: p.page, lines: String(p.text || '').split(/\r?\n/).map((l) => ({ raw: l.replace(/\s+$/, ''), plain: mdPlain(l) })) }));
    const isHeader = (l) => l.length < 200 && CODE_H.test(l) && !TOC_LINE.test(l);
    const strict = list.some((p) => p.lines.some((l) => isHeader(l.plain)));
    const fiches = [];
    let cur = null;
    let pendingTitle = false;
    for (const p of list) {
      let lines = p.lines;
      if (strict) {
        const filled = lines.filter((l) => l.plain);
        if (filled[0] && /^\d{1,3}$/.test(filled[0].plain)) lines = lines.slice(lines.indexOf(filled[0]) + 1); // numéro de page
        const rest = lines.filter((l) => l.plain);
        if (rest[0] && rest[0].plain === '-' && rest.length <= 4) {
          cur = null; // page de garde d'un chapitre
          continue;
        }
      }
      let seen = 0;
      for (const { raw, plain: line } of lines) {
        if (!line) {
          if (cur && !pendingTitle) cur.lines.push('');
          continue;
        }
        seen += 1;
        const c = line.length < 200 ? codeOf(line) : null;
        const starts = strict ? c && c.header && seen <= 3 && !TOC_LINE.test(line) : c && !TOC_LINE.test(line) && !(cur && c.code === cur.code);
        if (!strict && c && !starts) continue;
        if (starts) {
          cur = { code: c.code, nature: c.nature, chapter: c.chapter, title: c.rest, page: p.page, edition: c.edition || '', cursus: c.cursus || '', lines: [] };
          fiches.push(cur);
          pendingTitle = !c.rest;
          continue;
        }
        if (!cur) continue;
        if (pendingTitle) {
          cur.title = line;
          pendingTitle = false;
          cur.titleOpen = strict && cur.lines.length === 0;
          continue;
        }
        // titre sur deux lignes : « Préservation du potentiel mental » / « du secouriste »
        if (cur.titleOpen && !cur.lines.length && /^[a-zàâçéèêëîïôûù(]/.test(line) && cur.title.length + line.length < 160) {
          cur.title += ` ${line}`;
          cur.titleOpen = false;
          continue;
        }
        cur.titleOpen = false;
        cur.lines.push(raw);
      }
    }
    if (!fiches.length) {
      return (pages || [])
        .map((p) => ({ code: '', nature: 'X', chapter: '', title: `Page ${p.page}`, page: p.page, text: cleanText(String(p.text || '').split(/\r?\n/)), edition: '', cursus: '' }))
        .filter((f) => f.text);
    }
    const best = new Map();
    fiches.forEach((f, i) => {
      const text = cleanText(f.lines);
      const item = { code: f.code, nature: f.nature, chapter: f.chapter, title: (f.title || f.code).slice(0, 300), page: f.page, text, edition: f.edition, cursus: f.cursus, i };
      const prev = best.get(f.code);
      if (!prev || text.length > prev.text.length) best.set(f.code, item);
    });
    return [...best.values()].sort((a, b) => a.i - b.i).map(({ i, ...f }) => f);
  }

  // ── découpage par le sommaire (pages affichées telles quelles) ──
  // « [03AC01 / 09-2014] PSE① Accident d’exposition ______ 43 » ; chapitre : « - HYGIENE ET ASEPSIE ______ 42 »
  const TOC_FICHE = /^\[\s*(\d{2})\s?(AC|PR|FT)\s?(\d{2})\s*(?:\/\s*(\d{1,2})\s*[-/.]\s*(\d{4}))?\s*\]\s*(PSE\s*[①②12\s]*)?\s*(.*?)\s*(?:_{2,}|(?:\.\s?){4,}|…+)\s*(\d{1,4})\s*$/i;
  const TOC_CHAP = /^[-–]\s+(.+?)\s*(?:_{2,}|(?:\.\s?){4,}|…+)\s*(\d{1,4})\s*$/;
  const capFirst = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : '');

  /**
   * pages = [{ page, text }] (texte brut du PDF) → fiches [{ code, nature, chapter, chapterName, title, page, pageEnd,
   * edition, cursus, text }]. Les codes, titres et numéros viennent du sommaire ; le décalage entre pagination imprimée
   * et pages du PDF est celui qui retrouve le plus d'en-têtes « [01AC01 / … » en haut de page. Une fiche s'arrête
   * avant la fiche suivante ou la page de garde du chapitre suivant. Sans sommaire : une fiche par en-tête de page.
   */
  function tocFiches(pages) {
    const list = (pages || []).slice().sort((a, b) => a.page - b.page);
    const last = list.length ? list[list.length - 1].page : 0;
    const top = new Map(list.map((p) => [p.page, String(p.text || '').split(/\r?\n/).slice(0, 3).join(' ').replace(/\s+/g, '')]));
    const entries = [];
    const covers = [];
    let chapterName = '';
    for (const p of list) {
      for (const raw of String(p.text || '').split(/\r?\n/)) {
        const line = raw.trim();
        let m = TOC_FICHE.exec(line);
        if (m) {
          const nature = m[2].toUpperCase();
          entries.push({ key: `[${m[1]}${nature}${m[3]}`, code: `${nature} ${m[1]} ${m[3]}`, nature, chapter: m[1], chapterName, title: m[7].trim(), printed: Number(m[8]), edition: m[5] ? `${pad(m[4])}-${m[5]}` : '', cursus: cursusOf(m[6]) });
          continue;
        }
        m = TOC_CHAP.exec(line);
        if (m) {
          chapterName = capFirst(m[1].trim());
          covers.push(Number(m[2]));
        }
      }
    }
    let starts;
    if (entries.length) {
      let off = 0;
      let bestHits = -1;
      for (let o = -20; o <= 20; o++) {
        const hits = entries.filter((e) => (top.get(e.printed + o) || '').toUpperCase().includes(e.key)).length;
        if (hits > bestHits) [off, bestHits] = [o, hits];
      }
      const seen = new Set();
      starts = entries.filter((e) => !seen.has(e.code) && seen.add(e.code)).map(({ key, printed, ...e }) => ({ ...e, page: printed + off })).filter((e) => e.page >= 1 && e.page <= last);
      covers.splice(0, covers.length, ...covers.map((c) => c + off));
    } else {
      // pas de sommaire : en-tête « [01AC01 / 07-2026] PSE① » dans les trois premières lignes d'une page
      starts = [];
      for (const p of list) {
        const lines = String(p.text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        const i = lines.slice(0, 3).findIndex((l) => CODE_H.test(l) && !TOC_LINE.test(l));
        if (i < 0) continue;
        const c = codeOf(lines[i]);
        if (starts.some((s) => s.code === c.code)) continue;
        starts.push({ code: c.code, nature: c.nature, chapter: c.chapter, chapterName: '', title: c.rest || lines[i + 1] || c.code, page: p.page, edition: c.edition, cursus: c.cursus });
      }
    }
    starts.sort((a, b) => a.page - b.page);
    const bounds = [...new Set([...starts.map((s) => s.page), ...covers])].sort((a, b) => a - b);
    const byPage = new Map(list.map((p) => [p.page, String(p.text || '')]));
    return starts.map((s) => {
      const next = bounds.find((b) => b > s.page);
      const pageEnd = Math.max(s.page, next ? next - 1 : last);
      const text = [];
      for (let n = s.page; n <= pageEnd; n++) text.push(byPage.get(n) || '');
      return { ...s, title: s.title.slice(0, 300) || s.code, pageEnd, text: text.join('\n\n').trim() };
    });
  }

  // ── cas concrets ──
  const fold =(x) => String(x || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();

  /**
   * Note d'un cas concret.
   *   actions : [{ text, kind: 'do' | 'crit' | 'dont' }] dans l'ordre attendu ; picked : indices cliqués, dans l'ordre ;
   *   report : éléments attendus dans la transmission (alternatives séparées par « | ») ; message : texte saisi.
   * Pondération : gestes 55 %, ordre 15 %, transmission 30 % (sans transmission : 75 / 25). Pénalités : geste à
   * ne pas faire −10, geste vital oublié −15, temps dépassé −10.
   */
  function scoreCase({ actions = [], report = [], limit = 0 }, picked = [], message = '', ms = 0) {
    const expected = actions.map((a, i) => ({ ...a, i })).filter((a) => a.kind !== 'dont');
    const chosen = new Set(picked);
    const hits = expected.filter((a) => chosen.has(a.i));
    const missed = expected.filter((a) => !chosen.has(a.i));
    const critMissed = missed.filter((a) => a.kind === 'crit');
    const wrong = picked.filter((i) => actions[i] && actions[i].kind === 'dont');
    const seq = picked.filter((i) => actions[i] && actions[i].kind !== 'dont');
    let inv = 0;
    for (let a = 0; a < seq.length; a++) for (let b = a + 1; b < seq.length; b++) if (seq[a] > seq[b]) inv += 1;
    const pairs = (seq.length * (seq.length - 1)) / 2;
    const orderOk = pairs ? 1 - inv / pairs : seq.length ? 1 : 0;
    const msg = fold(message);
    const found = report.map((r) => ({ text: r, ok: String(r).split('|').map(fold).filter(Boolean).some((alt) => msg.includes(alt)) }));
    const repOk = found.length ? found.filter((x) => x.ok).length / found.length : null;
    const actOk = expected.length ? hits.length / expected.length : 1;
    const late = limit > 0 && ms > limit * 1000;
    const base = repOk == null ? 0.75 * actOk + 0.25 * orderOk : 0.55 * actOk + 0.15 * orderOk + 0.3 * repOk;
    const score = Math.round(Math.min(100, Math.max(0, 100 * base - 10 * wrong.length - 15 * critMissed.length - (late ? 10 : 0))));
    return { score, hits: hits.length, expected: expected.length, missed: missed.map((a) => a.text), critMissed: critMissed.map((a) => a.text), wrong: wrong.map((i) => actions[i].text), inversions: inv, orderOk, report: found, late };
  }

  /** Lignes saisies → gestes : « ! » en tête = vital, « x » ou « ✗ » en tête = à ne pas faire. */
  function parseActions(text) {
    return String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      if (/^!\s*/.test(l)) return { text: l.replace(/^!\s*/, ''), kind: 'crit' };
      if (/^(x|✗)\s+/i.test(l)) return { text: l.replace(/^(x|✗)\s+/i, ''), kind: 'dont' };
      return { text: l.replace(/^[-•]\s*/, ''), kind: 'do' };
    }).filter((a) => a.text);
  }
  const actionsText = (actions) => (actions || []).map((a) => (a.kind === 'crit' ? '! ' : a.kind === 'dont' ? 'x ' : '') + a.text).join('\n');

  /** « 60 | La victime ne répond plus » → { t: 60, text } ; trié par temps. */
  function parseEvents(text) {
    return String(text || '').split(/\r?\n/).map((l) => /^\s*(\d{1,4})\s*(?:s\b)?\s*[|:]\s*(.+)$/.exec(l)).filter(Boolean).map((m) => ({ t: Number(m[1]), text: m[2].trim() })).sort((a, b) => a.t - b.t);
  }
  const eventsText = (ev) => (ev || []).map((e) => `${e.t} | ${e.text}`).join('\n');

  // ── comparaison de deux versions d'une fiche ──
  /** Plus longue sous-suite commune (programmation dynamique) → opérations eq / del / add. */
  function lcsOps(a, b, eq = (x, y) => x === y) {
    const n = a.length;
    const m = b.length;
    const L = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i][j] = eq(a[i], b[j]) ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (eq(a[i], b[j])) { out.push({ op: 'eq', text: b[j] }); i++; j++; }
      else if (L[i + 1][j] >= L[i][j + 1]) out.push({ op: 'del', text: a[i++] });
      else out.push({ op: 'add', text: b[j++] });
    }
    while (i < n) out.push({ op: 'del', text: a[i++] });
    while (j < m) out.push({ op: 'add', text: b[j++] });
    return out;
  }
  const squash = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  /** Même contenu, quelle que soit la mise en forme (texte brut d'un ancien import contre Markdown). */
  const sameText = (a, b) => {
    const x = squash(textCore(a));
    const y = squash(textCore(b));
    if (x === y) return true;
    // un tableau reconstitué change l'ordre de lecture (case par case) : mêmes mots, même contenu
    if (!TABLE_LINE.test(String(a || '')) && !TABLE_LINE.test(String(b || ''))) return false;
    const bag = (t) => t.split(' ').sort().join(' ');
    return bag(x) === bag(y);
  };

  /** Différences mot à mot entre deux passages (au-delà de 3000 mots : remplacement en bloc). */
  function diffWords(a, b) {
    const ta = String(a || '').split(/(\s+)/).filter(Boolean);
    const tb = String(b || '').split(/(\s+)/).filter(Boolean);
    if (ta.length * tb.length > 9e6) return [{ op: 'del', text: a }, { op: 'add', text: b }];
    const ops = lcsOps(ta, tb);
    const out = [];
    for (const o of ops) {
      const last = out[out.length - 1];
      if (last && last.op === o.op) last.text += o.text;
      else out.push({ ...o });
    }
    return out;
  }

  /**
   * Différences ligne à ligne, puis mot à mot dans les lignes remplacées. Blocs :
   *   { op: 'eq', text } · { op: 'del', text } · { op: 'add', text } · { op: 'chg', words: [{ op, text }] }
   * Les lignes sont comparées sans tenir compte des espaces. stats = lignes ajoutées / supprimées / modifiées.
   */
  function diffText(before, after) {
    const a = String(before || '').split(/\r?\n/);
    const b = String(after || '').split(/\r?\n/);
    const ops = a.length * b.length > 9e6 ? [...a.map((t) => ({ op: 'del', text: t })), ...b.map((t) => ({ op: 'add', text: t }))] : lcsOps(a, b, (x, y) => squash(x) === squash(y));
    const blocks = [];
    const stats = { added: 0, removed: 0, changed: 0 };
    for (let k = 0; k < ops.length; ) {
      if (ops[k].op === 'eq') { blocks.push(ops[k++]); continue; }
      const dels = [];
      const adds = [];
      while (k < ops.length && ops[k].op !== 'eq') (ops[k].op === 'del' ? dels : adds).push(ops[k++].text);
      const pairs = Math.min(dels.length, adds.length);
      for (let p = 0; p < pairs; p++) blocks.push({ op: 'chg', words: diffWords(dels[p], adds[p]) });
      for (const t of dels.slice(pairs)) blocks.push({ op: 'del', text: t });
      for (const t of adds.slice(pairs)) blocks.push({ op: 'add', text: t });
      stats.changed += pairs;
      stats.removed += dels.length - pairs;
      stats.added += adds.length - pairs;
    }
    return { blocks, stats };
  }

  // ── retours de terrain : ce qui ressemble à une donnée identifiante ──
  const IDENT = [
    ['un numéro de téléphone', /(?:\+33\s?|\b0)[1-9](?:[ .-]?\d{2}){4}\b/],
    ['une adresse e-mail', /[\w.+-]+@[\w-]+\.[\w.]+/],
    ['un numéro de sécurité sociale', /\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2])\s?\d{2}\s?\d{3}\s?\d{3}(?:\s?\d{2})?\b/],
    ['une date précise (naissance ?)', /\b\d{1,2}[/.-]\d{1,2}[/.-](?:19|20)?\d{2}\b/],
    ['une adresse postale', /\b\d{1,4}\s?(?:bis|ter)?,?\s+(?:rue|avenue|av\.|boulevard|bd|place|chemin|allée|impasse|route|quai)\b/i],
    ['un nom de personne', /\b(?:M\.|Mme|Mlle|Monsieur|Madame|Mr)\s+[A-ZÀ-Ý][a-zà-ÿ-]+/],
    ['une plaque d’immatriculation', /\b[A-Z]{2}-\d{3}-[A-Z]{2}\b/],
  ];
  /** Indices de données identifiantes dans un texte (libellés, sans doublon). */
  const identifyingHints = (text) => IDENT.filter(([, re]) => re.test(String(text || ''))).map(([label]) => label);

  return { identifyingHints, diffText, diffWords, sameText, W, GRADES, GRADE_LABELS, NATURES, newState, review, preview, waitLabel, recall, isDue, retrievability, intervalFor, pace, cloze, hasCloze, codeOf, splitReferential, tocFiches, pdfPageMarkdown, pdfGrids, mdPlain, scoreCase, parseActions, actionsText, parseEvents, eventsText };
});
