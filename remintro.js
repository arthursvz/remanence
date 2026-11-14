'use strict';

/*
 * Rémanence — animation d'ouverture (5 s), sur le modèle de celle de Parhelion : fond nuit, bleu glacier,
 * ambre en accent, traits fins lumineux, anneau gradué façon HUD. Le logo R2 « Phosphore » sur un écran de scope :
 *   0,0–0,7  fond, anneau segmenté qui se trace, graticule
 *   0,4–1,4  premier passage du spot : le pouls se trace, la trace pâlit derrière lui (rémanence)
 *   1,4–2,4  second passage ; à la fin, la trace se fige aux opacités du logo
 *   2,3–2,8  le soleil ambre s'allume au bout de la trace (éclat)
 *   3,0–4,0  RÉMANENCE, lettre par lettre
 *   3,9–4,4  BY DAWN et le logo Dawn
 *   4,4–5,0  fondu de sortie
 * Clic, Échap, Entrée ou Espace : passer. Mouvement réduit : 1,2 s. Désactivable dans Ozone › Général. Préfixe rmi.
 * Aussi publié avec la page du téléphone (ouverture de l'appli installée) : remIntroPlay(document.body, { touch: true }).
 */

const RMI = { el: null, raf: 0, t0: 0, onKey: null, onResize: null };
const RMI_ICE = '120,214,255';
const RMI_PHOS = '140,255,190';
const RMI_AMBER = '255,176,0';
const RMI_WHITE = '232,246,255';
const RMI_SANS = '"Segoe UI Variable Display", "Segoe UI", system-ui, sans-serif';
const RMI_MONO = '"Cascadia Mono", Consolas, monospace';
// tracé du logo (grille 120) : plat, petite onde, pic, plat ; le soleil est en 102,68. x croît le long du tracé.
const RMI_PATH = [[8, 68], [34, 68], [42, 56], [50, 86], [62, 28], [72, 68], [90, 68]];

function remIntroStop() {
  if (!RMI.el) return;
  cancelAnimationFrame(RMI.raf);
  window.removeEventListener('keydown', RMI.onKey, true);
  window.removeEventListener('resize', RMI.onResize);
  const el = RMI.el;
  RMI.el = null;
  el.classList.add('out');
  setTimeout(() => el.remove(), 260);
}

function remIntroPlay(target = '#view-app .content', opts = {}) {
  const host = typeof target === 'string' ? document.querySelector(target) : target;
  if (RMI.el || !host) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const total = reduced ? 1.2 : 5;
  const canvas = h('canvas', {});
  const el = h('div', { class: 'rem-intro', title: 'Clic pour passer' }, canvas, h('span', { class: 'rem-intro-skip mono' }, opts.touch ? 'toucher pour passer' : 'clic · Échap pour passer'));
  document.body.append(el);
  RMI.el = el;
  const ctx = canvas.getContext('2d');
  let box;
  const size = () => {
    const r = host === document.body ? { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight } : host.getBoundingClientRect();
    Object.assign(el.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, r.width * dpr);
    canvas.height = Math.max(1, r.height * dpr);
    canvas.style.width = `${r.width}px`;
    canvas.style.height = `${r.height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    box = r;
  };
  size();
  RMI.onResize = size;
  window.addEventListener('resize', RMI.onResize);
  el.addEventListener('click', remIntroStop);
  RMI.onKey = (e) => {
    if (['Escape', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      e.stopPropagation();
      remIntroStop();
    }
  };
  window.addEventListener('keydown', RMI.onKey, true);
  RMI.t0 = performance.now();

  const ease = (x) => (x <= 0 ? 0 : x >= 1 ? 1 : 1 - (1 - x) ** 3);
  const seg = (t, a, b) => ease((t - a) / (b - a));
  const lin = (t, a, b) => Math.min(1, Math.max(0, (t - a) / (b - a)));

  // un seul Path2D pour la trace ; abscisse curviligne s(x) pour placer le spot (x monotone le long du tracé)
  const trace = new Path2D(`M${RMI_PATH.map((p) => p.join(' ')).join('L')}`);
  const cum = [0];
  for (let i = 1; i < RMI_PATH.length; i++) cum.push(cum[i - 1] + Math.hypot(RMI_PATH[i][0] - RMI_PATH[i - 1][0], RMI_PATH[i][1] - RMI_PATH[i - 1][1]));
  const L = cum[cum.length - 1];
  const sOfX = (x) => {
    for (let i = 1; i < RMI_PATH.length; i++) {
      if (x <= RMI_PATH[i][0]) return (cum[i - 1] + ((x - RMI_PATH[i - 1][0]) / (RMI_PATH[i][0] - RMI_PATH[i - 1][0])) * (cum[i] - cum[i - 1])) / L;
    }
    return 1;
  };
  const pointAt = (u) => {
    const d = u * L;
    for (let i = 1; i < RMI_PATH.length; i++) {
      if (d <= cum[i]) {
        const f = (d - cum[i - 1]) / (cum[i] - cum[i - 1]);
        return [RMI_PATH[i - 1][0] + (RMI_PATH[i][0] - RMI_PATH[i - 1][0]) * f, RMI_PATH[i - 1][1] + (RMI_PATH[i][1] - RMI_PATH[i - 1][1]) * f];
      }
    }
    return RMI_PATH[RMI_PATH.length - 1];
  };
  const PASSES = [[0.4, 1.4], [1.4, 2.4]];
  const finalAlpha = (x) => (x < 34 ? 0.25 : x < 50 ? 0.55 : 1);
  const STOPS = [];
  for (let x = 8; x <= 90; x += 1.5) STOPS.push(x);
  STOPS.push(33.9, 34.1, 49.9, 50.1, 90);
  STOPS.sort((p, q) => p - q);

  function frame(now) {
    if (!RMI.el) return;
    let t = (now - RMI.t0) / 1000;
    if (reduced) t = 4.2 + (t / total) * 0.8; // image finale puis fondu
    if (t >= 5) {
      remIntroStop();
      return;
    }
    const W = box.width;
    const H = box.height;
    ctx.clearRect(0, 0, W, H);
    const fadeOut = 1 - seg(t, 4.4, 5);
    ctx.fillStyle = `rgba(3,7,13,${Math.min(1, t / 0.25) * fadeOut})`;
    ctx.fillRect(0, 0, W, H);

    const S = Math.min(W, H) * 0.0028;
    const cx = W / 2;
    const cy = H * 0.44;
    const ox = cx - 61 * S;
    const oy = cy - 60 * S;
    const a = fadeOut;

    // grille de points discrète
    ctx.fillStyle = `rgba(${RMI_ICE},${0.06 * a})`;
    for (let x = (W % 40) / 2; x < W; x += 40) for (let y = (H % 40) / 2; y < H; y += 40) ctx.fillRect(x, y, 1, 1);

    // anneau segmenté et graduations
    const R = 92 * S;
    const ring = seg(t, 0, 0.7);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(t * 0.25);
    ctx.lineWidth = 1;
    ctx.strokeStyle = `rgba(${RMI_ICE},${0.55 * a})`;
    for (let i = 0; i < 6; i += 1) {
      const s0 = (i / 6) * Math.PI * 2 + 0.12;
      ctx.beginPath();
      ctx.arc(0, 0, R, s0, s0 + (Math.PI * 2 / 6 - 0.24) * ring);
      ctx.stroke();
    }
    ctx.rotate(-t * 0.55);
    for (let i = 0; i < 72; i += 1) {
      if (i / 72 > ring) break;
      const ang = (i / 72) * Math.PI * 2;
      const len = i % 6 === 0 ? 8 : 3;
      ctx.strokeStyle = `rgba(${RMI_ICE},${(i % 6 === 0 ? 0.5 : 0.22) * a})`;
      ctx.beginPath();
      ctx.moveTo(Math.cos(ang) * (R + 8), Math.sin(ang) * (R + 8));
      ctx.lineTo(Math.cos(ang) * (R + 8 + len), Math.sin(ang) * (R + 8 + len));
      ctx.stroke();
    }
    ctx.restore();

    // graticule de scope, fin, dans l'anneau
    const g = seg(t, 0.1, 0.8) * a;
    if (g > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(cx, cy, R - 6, 0, Math.PI * 2);
      ctx.clip();
      ctx.lineWidth = 1;
      const cell = 20 * S;
      for (let k = -5; k <= 5; k += 1) {
        ctx.strokeStyle = `rgba(${RMI_ICE},${(k === 0 ? 0.14 : 0.06) * g})`;
        ctx.beginPath();
        ctx.moveTo(cx + k * cell, cy - R);
        ctx.lineTo(cx + k * cell, cy + R);
        ctx.moveTo(cx - R, oy + 68 * S + k * cell);
        ctx.lineTo(cx + R, oy + 68 * S + k * cell);
        ctx.stroke();
      }
      ctx.restore();
    }

    // trace : un seul trait fin ; la luminosité le long du tracé passe par un dégradé horizontal
    const freeze = seg(t, 2.25, 2.7);
    const glowAt = (x) => {
      const s = sOfX(x);
      let gl = 0;
      for (const [p0, p1] of PASSES) {
        const tp = p0 + s * (p1 - p0);
        if (t >= tp) gl = Math.max(gl, Math.exp(-(t - tp) / 0.45));
      }
      return gl;
    };
    ctx.save();
    ctx.translate(ox, oy);
    ctx.scale(S, S);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const grad = ctx.createLinearGradient(8, 0, 90, 0);
    let any = false;
    for (const x of STOPS) {
      const al = (glowAt(x) * (1 - freeze) + finalAlpha(x) * freeze) * a;
      if (al > 0.01) any = true;
      grad.addColorStop((x - 8) / 82, freeze >= 1 ? `rgba(${RMI_WHITE},${al})` : `rgba(${RMI_PHOS},${al})`);
    }
    if (any) {
      ctx.strokeStyle = grad;
      ctx.lineWidth = 4;
      ctx.shadowColor = `rgba(${freeze >= 1 ? RMI_ICE : RMI_PHOS},${0.9 * a})`;
      ctx.shadowBlur = 16;
      ctx.stroke(trace);
    }
    // spot
    for (const [p0, p1] of PASSES) {
      if (t >= p0 && t < p1) {
        const [x, y] = pointAt(lin(t, p0, p1));
        ctx.shadowColor = `rgba(${RMI_PHOS},${a})`;
        ctx.shadowBlur = 22;
        ctx.fillStyle = `rgba(${RMI_WHITE},${a})`;
        ctx.beginPath();
        ctx.arc(x, y, 4.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    // soleil ambre
    const sun = seg(t, 2.3, 2.8);
    if (sun > 0) {
      ctx.shadowColor = `rgba(${RMI_AMBER},${a})`;
      ctx.shadowBlur = 26;
      ctx.fillStyle = `rgba(${RMI_AMBER},${a})`;
      ctx.beginPath();
      ctx.arc(102, 68, 11 * sun, 0, Math.PI * 2);
      ctx.fill();
      const fl = (t - 2.3) / 0.9;
      if (fl > 0 && fl < 1) {
        ctx.shadowBlur = 0;
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = `rgba(${RMI_AMBER},${(1 - fl) * 0.8 * a})`;
        ctx.beginPath();
        ctx.arc(102, 68, 11 + fl * 50, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.restore();

    // lectures discrètes reliées par des lignes de rappel
    const rd = seg(t, 1.4, 2.2) * a;
    if (rd > 0) {
      ctx.font = `10px ${RMI_MONO}`;
      ctx.fillStyle = `rgba(${RMI_ICE},${0.6 * rd})`;
      ctx.strokeStyle = `rgba(${RMI_ICE},${0.35 * rd})`;
      ctx.lineWidth = 1;
      const narrow = W < 560; // téléphone : les lectures passent au-dessus et au-dessous de l'anneau
      if (narrow) {
        ctx.textAlign = 'center';
        ctx.fillText('RÉVISION DU RÉFÉRENTIEL', cx, cy - R - 26);
        ctx.fillText('PSE1 · PSE2 · CARTES · CAS CONCRETS', cx, cy + R + 32);
      }
      const lx = cx + R * 0.72;
      const ly = cy - R * 0.72;
      if (!narrow) {
      ctx.beginPath();
      ctx.moveTo(lx, ly);
      ctx.lineTo(lx + 26, ly - 18);
      ctx.lineTo(lx + 120, ly - 18);
      ctx.stroke();
      ctx.textAlign = 'left';
      ctx.fillText('RÉVISION DU RÉFÉRENTIEL', lx + 30, ly - 23);
      const bx = cx - R * 0.72;
      const by = cy + R * 0.72;
      ctx.beginPath();
      ctx.moveTo(bx, by);
      ctx.lineTo(bx - 26, by + 18);
      ctx.lineTo(bx - 130, by + 18);
      ctx.stroke();
      ctx.textAlign = 'right';
      ctx.fillText('PSE1 · PSE2 · CARTES · CAS CONCRETS', bx - 30, by + 31);
      }
    }

    // RÉMANENCE, lettre par lettre
    const word = 'RÉMANENCE';
    const ty = cy + R + (W < 560 ? 76 : 58);
    const fs = Math.max(22, Math.min(52, W * 0.04));
    ctx.font = `200 ${fs}px ${RMI_SANS}`;
    ctx.textAlign = 'left';
    const spacing = fs * 0.42;
    const widths = [...word].map((ch) => ctx.measureText(ch).width);
    const totalW = widths.reduce((s, w) => s + w, 0) + spacing * (word.length - 1);
    let x = cx - totalW / 2;
    for (let i = 0; i < word.length; i += 1) {
      const li = seg(t, 3.0 + i * 0.1, 3.0 + i * 0.1 + 0.25);
      if (li > 0) {
        const flick = li < 1 ? (Math.sin(now / 23 + i) > 0 ? 1 : 0.55) : 1;
        ctx.shadowColor = `rgba(${RMI_ICE},${0.8 * a})`;
        ctx.shadowBlur = 14;
        ctx.fillStyle = `rgba(${RMI_WHITE},${li * flick * a})`;
        ctx.fillText(word[i], x, ty);
      }
      x += widths[i] + spacing;
    }
    // BY DAWN + logo Dawn
    const by2 = seg(t, 3.9, 4.4) * a;
    if (by2 > 0) {
      ctx.shadowBlur = 0;
      ctx.font = `11px ${RMI_MONO}`;
      ctx.textAlign = 'center';
      const label = 'B Y   D A W N';
      const lw = ctx.measureText(label).width;
      const my = ty + fs * 0.85;
      ctx.fillStyle = `rgba(${RMI_ICE},${0.75 * by2})`;
      ctx.fillText(label, cx + 12, my);
      // mini logo Dawn (n°07 « Orbite »)
      ctx.save();
      ctx.translate(cx - lw / 2 - 22, my - 12);
      ctx.scale(0.13, 0.13);
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.strokeStyle = `rgba(${RMI_WHITE},${0.3 * by2})`;
      ctx.beginPath();
      ctx.arc(60, 60, 40, 0, Math.PI);
      ctx.stroke();
      ctx.strokeStyle = `rgba(${RMI_WHITE},${by2})`;
      ctx.beginPath();
      ctx.arc(60, 60, 40, Math.PI, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(8, 60);
      ctx.lineTo(112, 60);
      ctx.stroke();
      ctx.fillStyle = `rgba(${RMI_AMBER},${by2})`;
      ctx.beginPath();
      ctx.arc(80, 25.4, 12, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      // filet sous le titre
      ctx.strokeStyle = `rgba(${RMI_ICE},${0.3 * by2})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - totalW / 2, ty + 14);
      ctx.lineTo(cx + totalW / 2, ty + 14);
      ctx.stroke();
    }
    RMI.raf = requestAnimationFrame(frame);
  }
  RMI.raf = requestAnimationFrame(frame);
}
