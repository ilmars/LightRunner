// The stage view's picture (the operator page's, and the Timeline page's): each fixture drawn where the stage plan puts
// it, in the colour the stage (or a Prepare draft) gives it now. Only the drawing; what is sent to the lights doesn't change.

import { barAxis, barEnds, beamCone, outlineCells } from './stage.js';

/**
 * How a light's colour is drawn on screen. Whites (light colours with little
 * colour in them: warm white #ffb46b, cool white #dcebff, the safe light) are
 * drawn as soft whites instead of their raw values, which look orange or blue
 * on a screen. Saturated colours are left as they are. Only the drawing
 * changes; what is sent to the lights doesn't.
 */
const CREAM = [241, 236, 228];
export function shownRgb(r, g, b) {
  const max = Math.max(r, g, b);
  if (max <= 0) return [r, g, b];
  const chroma = (max - Math.min(r, g, b)) / max;
  if (chroma >= 0.65) return [r, g, b];
  // Mix the colour (at full brightness) 60 % towards cream, then put its brightness back.
  const k = max / 255;
  return [r, g, b].map((v, i) => Math.round(((v / k) * 0.4 + CREAM[i] * 0.6) * k));
}
export function shown(hex) {
  if (!hex || !/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = shownRgb((n >> 16) & 255, (n >> 8) & 255, n & 255);
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

/**
 * Draws the stage onto `ctx` (already scaled to CSS pixels), `w` by `h`: the layout's fixtures in the colours of
 * `visual` (r, g, b per segment, in fixture order; missing values are dark). Smoke machines are a small cloud,
 * brighter while `smokeLevel(groupId)` (0..1) is up.
 */
export function drawStagePicture(ctx, w, h, layout, visual, smokeLevel = () => 0) {
  const shownVisual = visual;
  const pad = 14, r = Math.max(5, Math.min(9, h / 16));
  const iw = w - 2 * pad, ih = h - 2 * pad;
  const toPx = (p) => [pad + p.x * iw, pad + p.y * ih];
  // Where each fixture's segments start in the visual, counted in segments.
  const starts = [];
  let at = 0;
  for (const f of layout.fixtures) {
    starts.push(at);
    at += Math.max(1, f.segments ?? 1);
  }
  const cellsOf = (k) => {
    const f = layout.fixtures[k], first = starts[k];
    return Array.from({ length: Math.max(1, f.segments ?? 1) }, (_, s) =>
      shownRgb(shownVisual[(first + s) * 3] ?? 0, shownVisual[(first + s) * 3 + 1] ?? 0, shownVisual[(first + s) * 3 + 2] ?? 0));
  };
  const brightest = (cells) => cells.reduce((best, c) => (Math.max(...c) > Math.max(...best) ? c : best), cells[0]);
  const shapeOf = (f) => f.shape ?? (f.w || f.h ? 'bar' : 'dot');
  // Beams' cones and smoke go first, so they never cover a light.
  layout.fixtures.forEach((f, k) => {
    if (shapeOf(f) === 'beam') drawCone(f, cellsOf(k)[0]);
    if (shapeOf(f) === 'smoke') drawSmoke(f);
  });
  layout.fixtures.forEach((f, k) => {
    const shape = shapeOf(f);
    if (shape === 'bar') drawBar(f, cellsOf(k));
    else if (shape === 'outline') drawOutline(f, cellsOf(k));
    else if (shape !== 'smoke') drawDot(f, cellsOf(k)[0]);
  });

  /** A faint cone in the light's colour, strongest at the lamp and gone at the tip; nothing when it is off. */
  function drawCone(f, [R, G, B]) {
    const lit = Math.max(R, G, B) / 255;
    if (lit <= 0.02) return;
    const cone = beamCone(f);
    const [lx, ly] = toPx(cone.lamp), [tx, ty] = toPx(cone.tip);
    const fade = ctx.createLinearGradient(lx, ly, tx, ty);
    fade.addColorStop(0, `rgba(${R},${G},${B},${0.22 * lit})`);
    fade.addColorStop(1, `rgba(${R},${G},${B},0)`);
    ctx.beginPath();
    ctx.moveTo(lx, ly);
    ctx.lineTo(...toPx(cone.left));
    ctx.lineTo(...toPx(cone.right));
    ctx.closePath();
    ctx.fillStyle = fade;
    ctx.fill();
  }

  /** A small grey cloud, a little brighter while its smoke group's level is up. */
  function drawSmoke(f) {
    const groups = (layout.groups ?? []).filter((g) => g.kind === 'smoke' && layout.members?.[g.id]?.includes(f.id));
    const level = Math.max(0, ...groups.map((g) => smokeLevel(g.id)));
    const [x, y] = toPx(f);
    ctx.fillStyle = `rgba(148,170,210,${0.16 + 0.24 * level})`;
    for (const [dx, dy, s] of [[-0.55, 0.15, 0.7], [0, -0.2, 0.9], [0.6, 0.1, 0.75]]) {
      ctx.beginPath();
      ctx.arc(x + dx * r * 1.6, y + dy * r * 1.6, s * r * 1.1, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** A bar or strip at its real size and angle, one cell per segment from its start to its end. */
  function drawBar(f, cells) {
    const [a, b] = barEnds(f).map(toPx);
    const len = Math.max(8, Math.hypot(b[0] - a[0], b[1] - a[1]));
    const thick = Math.max(8, barAxis(f).thickness * ih);
    const glow = brightest(cells);
    const lit = Math.max(...glow) / 255;
    ctx.save();
    ctx.translate((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
    ctx.rotate(Math.atan2(b[1] - a[1], b[0] - a[0]));
    const box = () => {
      ctx.beginPath();
      ctx.roundRect(-len / 2, -thick / 2, len, thick, 4);
    };
    ctx.save();
    if (lit > 0.02) {
      ctx.shadowColor = `rgba(${glow[0]},${glow[1]},${glow[2]},${0.8 * lit})`;
      ctx.shadowBlur = 10;
    }
    box();
    ctx.fillStyle = `rgb(${glow[0]},${glow[1]},${glow[2]})`;
    ctx.fill();
    ctx.restore();
    ctx.save();
    box();
    ctx.clip();
    const cell = len / cells.length;
    cells.forEach(([R, G, B], s) => {
      // Segment 0 is at the bar's start (left or top); at its end when the fixture hangs reversed.
      const slot = f.reversed ? cells.length - 1 - s : s;
      ctx.fillStyle = `rgb(${R},${G},${B})`;
      ctx.fillRect(-len / 2 + slot * cell, -thick / 2, cell + 0.5, thick);
    });
    ctx.restore();
    box();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#3a3f48';
    ctx.stroke();
    ctx.restore();
  }

  /** A strip round something: its cells clockwise from the top left (anticlockwise when reversed). */
  function drawOutline(f, cells) {
    const box = { left: pad + (f.x - (f.w ?? 0) / 2) * iw, top: pad + (f.y - (f.h ?? 0) / 2) * ih, width: (f.w ?? 0) * iw, height: (f.h ?? 0) * ih };
    const path = (points) => {
      ctx.beginPath();
      points.forEach(([x, y], k) => (k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    };
    ctx.save();
    ctx.lineJoin = 'round';
    // The strip itself, dark where it is off.
    ctx.beginPath();
    ctx.roundRect(box.left, box.top, box.width, box.height, 4);
    ctx.lineWidth = 6;
    ctx.strokeStyle = '#3a3f48';
    ctx.stroke();
    const glow = brightest(cells);
    const lit = Math.max(...glow) / 255;
    if (lit > 0.02) {
      ctx.shadowColor = `rgba(${glow[0]},${glow[1]},${glow[2]},${0.8 * lit})`;
      ctx.shadowBlur = 10;
    }
    ctx.lineWidth = 4;
    outlineCells(box, cells.length, f.reversed).forEach((points, s) => {
      const [R, G, B] = cells[s];
      path(points);
      ctx.strokeStyle = `rgb(${R},${G},${B})`;
      ctx.stroke();
    });
    ctx.restore();
  }

  /** A lamp: a dot with a soft glow in its colour. */
  function drawDot(f, [R, G, B]) {
    const [x, y] = toPx(f);
    const lit = Math.max(R, G, B) / 255;
    if (lit > 0.02) {
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
      glow.addColorStop(0, `rgba(${R},${G},${B},${0.55 * lit})`);
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(x - r * 3.2, y - r * 3.2, r * 6.4, r * 6.4);
    }
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${R},${G},${B})`;
    ctx.fill();
    ctx.lineWidth = 1;
    ctx.strokeStyle = '#3a3f48';
    ctx.stroke();
  }
}
