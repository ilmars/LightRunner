// Stage plan shapes, for drawing them on the Patch plan and the operator's stage view. No DOM, so it can be tested.
// Positions are fractions of the plan (x across, y down). Angles and lengths along an angle are measured in the
// Patch plan's proportions (PLAN_ASPECT wide to 1 high), so a turned bar ends at the same points in every view.

export const PLAN_ASPECT = 2.4;
/** A beam's cone opens this many degrees each side of where it points. */
export const BEAM_HALF_SPREAD = 20;
/** A new beam reaches about a third of the plan's height. */
export const BEAM_REACH = 0.14;

const rad = (deg) => (deg * Math.PI) / 180;

/**
 * A bar's middle line: length (a fraction of the plan's width), thickness (a fraction of its height) and angle
 * (degrees clockwise, 0 = across). A bar from before angles that is taller than wide is an upright bar:
 * its w is its thickness and its h its length.
 */
export function barAxis(f) {
  const w = f.w ?? 0, h = f.h ?? 0;
  if (f.angle == null && h > w * PLAN_ASPECT) return { length: h / PLAN_ASPECT, thickness: w * PLAN_ASPECT, angle: 90 };
  return { length: w, thickness: h, angle: f.angle ?? 0 };
}

/** A step of `length` along `angle`, as fractions of the plan. */
export function along(length, angle) {
  return { x: length * Math.cos(rad(angle)), y: length * Math.sin(rad(angle)) * PLAN_ASPECT };
}

/** A bar's two ends as fractions of the plan; segment 0 is at the first (the left or top end at 0° or 90°). */
export function barEnds(f) {
  const { length, angle } = barAxis(f);
  const d = along(length / 2, angle);
  return [{ x: f.x - d.x, y: f.y - d.y }, { x: f.x + d.x, y: f.y + d.y }];
}

/** A beam's cone: the lamp, the far corners of the cone and the tip in the middle, as fractions of the plan. */
export function beamCone(f) {
  const angle = f.angle ?? -90, reach = f.reach ?? BEAM_REACH;
  const tip = along(reach, angle);
  const side = (sign) => along(reach / Math.cos(rad(BEAM_HALF_SPREAD)), angle + sign * BEAM_HALF_SPREAD);
  const at = (d) => ({ x: f.x + d.x, y: f.y + d.y });
  return { lamp: { x: f.x, y: f.y }, left: at(side(-1)), right: at(side(1)), tip: at(tip) };
}

/** Half the width of a beam's cone where it reaches, as a fraction of the plan's width (the spread and its reach). */
export function beamHalfWidth(f) {
  return (f.reach ?? BEAM_REACH) * Math.tan(rad(BEAM_HALF_SPREAD));
}

/**
 * The cells of an outline, clockwise round its edge from the top-left corner (anticlockwise when reversed),
 * each as a list of points in pixels. `box` is the outline's left, top, width and height in pixels.
 */
export function outlineCells(box, count, reversed = false) {
  const { left, top, width, height } = box;
  let corners = [[left, top], [left + width, top], [left + width, top + height], [left, top + height]];
  if (reversed) corners = [corners[0], ...corners.slice(1).reverse()];
  const sides = corners.map((c, k) => [c, corners[(k + 1) % 4]]);
  const lengths = sides.map(([a, b]) => Math.hypot(b[0] - a[0], b[1] - a[1]));
  const total = lengths.reduce((s, l) => s + l, 0);
  // The point at distance d along the edge.
  const pointAt = (d) => {
    for (let k = 0; k < 4; k++) {
      if (d <= lengths[k] || k === 3) {
        const t = lengths[k] ? Math.min(1, d / lengths[k]) : 0;
        const [a, b] = sides[k];
        return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      }
      d -= lengths[k];
    }
  };
  // Corners along the way, so a cell bends round them.
  const cornerAt = [];
  let run = 0;
  for (let k = 0; k < 3; k++) cornerAt.push((run += lengths[k]));
  const n = Math.max(1, count);
  return Array.from({ length: n }, (_, s) => {
    const from = (total * s) / n, to = (total * (s + 1)) / n;
    return [pointAt(from), ...cornerAt.filter((c) => c > from && c < to).map(pointAt), pointAt(to)];
  });
}
