/* ==========================================================================
   knob.js — the rotary knob control
   --------------------------------------------------------------------------
   A knurled aluminium cap on a dark faceplate with an arc showing the value,
   drawn on a canvas because borders and gradients on a div cannot get there.
   Press and drag vertically to change, shift for fine, double-click for the
   marked default; a pointer capture keeps the drag alive off the control.

   Depends on: core.js (fitCanvas, elem, clamp, lerp, MONO, ENGRAVE).

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/* ==========================================================================
   2. Controls — the rotary knob and its numeric field
   --------------------------------------------------------------------------
   A knob is drawn rather than styled because the look wanted here is a milled
   aluminium cap on a dark faceplate: a knurled rim catching light from the
   upper left, an engraved pointer line, and an arc outside the cap showing
   the value. None of that is reachable with borders and gradients on a div.

   The interaction is the one a hardware control has: press and drag
   vertically, shift for fine, double-click for the marked default. A pointer
   capture keeps the drag alive when the cursor leaves the knob, which is what
   makes a small control usable at all.
   ========================================================================= */

const KNOB_ARC_START = Math.PI * 0.75;   // 7 o'clock
const KNOB_ARC_END = Math.PI * 2.25;     // 5 o'clock

/**
 * @param {object} opts
 *   label      engraved under the cap
 *   min,max    range in the control's own units
 *   value      initial
 *   def        the double-click default, also the arc's origin
 *   step       coarse drag resolution, in units per 140 px of travel
 *   curve      'lin' | 'log' — log for frequency, so an octave is an octave
 *   unit       printed after the number
 *   digits     decimals in the readout
 *   size       cap diameter in CSS px
 *   onChange   called with the new value
 */
function Knob(opts) {
  const o = Object.assign({
    label: '', min: 0, max: 1, value: 0, def: 0, curve: 'lin',
    unit: '', digits: 1, size: 46, onChange: null,
  }, opts);

  const root = __W.elem('div', 'knob');
  const cv = __W.elem('canvas', 'knob-face');
  cv.setAttribute('role', 'slider');
  cv.tabIndex = 0;
  cv.setAttribute('aria-label', o.label);
  const cap = __W.elem('div', 'knob-cap');
  cap.appendChild(cv);
  const name = __W.elem('div', 'knob-label', o.label);
  const field = __W.elem('input', 'knob-field');
  field.type = 'text';
  field.inputMode = 'decimal';
  field.setAttribute('aria-label', o.label + ' value');

  root.appendChild(cap);
  root.appendChild(name);
  root.appendChild(field);

  let value = __W.clamp(o.value, o.min, o.max);
  let editing = false;

  /* Normalised position 0..1. Frequency knobs are logarithmic: a knob where
     the bottom third of the travel covers 20 Hz to 200 Hz and the rest covers
     everything above is unusable for the band it matters most for. */
  const toNorm = (v) => o.curve === 'log'
    ? (Math.log(__W.clamp(v, o.min, o.max)) - Math.log(o.min)) /
      (Math.log(o.max) - Math.log(o.min))
    : (__W.clamp(v, o.min, o.max) - o.min) / (o.max - o.min);

  const fromNorm = (t) => o.curve === 'log'
    ? Math.exp(__W.lerp(Math.log(o.min), Math.log(o.max), __W.clamp(t, 0, 1)))
    : __W.lerp(o.min, o.max, __W.clamp(t, 0, 1));

  /** The value as it reads on the panel. A frequency past a kilohertz prints
      as "10.0k", and the unit that follows it becomes "Hz" all the same —
      "10k Hz" is right, "10k kHz" would not be. */
  function fmt(v) {
    if (o.curve === 'log' && v >= 1000) return (Math.round(v / 100) / 10).toFixed(1) + 'k';
    return v.toFixed(o.digits);
  }

  function paint() {
    const S = o.size;
    if (!__W.hasArea(S, S)) return;
    const ctx = __W.fitCanvas(cv, S, S);
    cv.style.width = S + 'px';
    ctx.clearRect(0, 0, S, S);

    const cx = S / 2, cy = S / 2;
    const rArc = S * 0.46;
    const rCap = S * 0.335;
    const t = toNorm(value);
    const ang = __W.lerp(KNOB_ARC_START, KNOB_ARC_END, t);
    const angDef = __W.lerp(KNOB_ARC_START, KNOB_ARC_END, toNorm(o.def));

    /* --- the value arc, outside the cap ------------------------------- */
    ctx.lineCap = 'butt';
    ctx.lineWidth = Math.max(2, S * 0.055);
    ctx.strokeStyle = 'rgba(78,80,73,0.55)';
    ctx.beginPath();
    ctx.arc(cx, cy, rArc, KNOB_ARC_START, KNOB_ARC_END);
    ctx.stroke();

    /* Drawn from the default outward, so a band at rest shows no arc at all
       and any lit arc is a change somebody made. */
    if (Math.abs(ang - angDef) > 0.008) {
      ctx.strokeStyle = '#d8b877';
      ctx.beginPath();
      ctx.arc(cx, cy, rArc, Math.min(ang, angDef), Math.max(ang, angDef));
      ctx.stroke();
    }

    /* --- the knurled rim ---------------------------------------------- */
    const rim = ctx.createLinearGradient(cx - rCap, cy - rCap, cx + rCap, cy + rCap);
    rim.addColorStop(0, '#6d6f66');
    rim.addColorStop(0.42, '#32342f');
    rim.addColorStop(1, '#141513');
    ctx.fillStyle = rim;
    ctx.beginPath();
    ctx.arc(cx, cy, rCap * 1.18, 0, Math.PI * 2);
    ctx.fill();

    /* knurling: fine radial teeth around the rim, low contrast */
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,0.5)';
    ctx.lineWidth = 1;
    const teeth = 32;
    for (let i = 0; i < teeth; i++) {
      const a = (i / teeth) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * rCap * 1.02, cy + Math.sin(a) * rCap * 1.02);
      ctx.lineTo(cx + Math.cos(a) * rCap * 1.18, cy + Math.sin(a) * rCap * 1.18);
      ctx.stroke();
    }
    ctx.restore();

    /* --- the cap face -------------------------------------------------- */
    const face = ctx.createRadialGradient(
      cx - rCap * 0.4, cy - rCap * 0.45, rCap * 0.05, cx, cy, rCap * 1.25);
    face.addColorStop(0, '#4a4c45');
    face.addColorStop(0.55, '#2a2c27');
    face.addColorStop(1, '#171815');
    ctx.fillStyle = face;
    ctx.beginPath();
    ctx.arc(cx, cy, rCap, 0, Math.PI * 2);
    ctx.fill();

    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(cx, cy, rCap, 0, Math.PI * 2);
    ctx.stroke();

    /* --- the pointer, cut into the cap --------------------------------- */
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineWidth = Math.max(1.6, S * 0.045);
    ctx.strokeStyle = '#0c0d0b';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * rCap * 0.18, cy + Math.sin(ang) * rCap * 0.18);
    ctx.lineTo(cx + Math.cos(ang) * rCap * 0.86, cy + Math.sin(ang) * rCap * 0.86);
    ctx.stroke();
    ctx.lineWidth = Math.max(1, S * 0.026);
    ctx.strokeStyle = '#e8d5a8';
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * rCap * 0.2, cy + Math.sin(ang) * rCap * 0.2);
    ctx.lineTo(cx + Math.cos(ang) * rCap * 0.84, cy + Math.sin(ang) * rCap * 0.84);
    ctx.stroke();
    ctx.restore();

    cv.setAttribute('aria-valuenow', String(Math.round(value * 100) / 100));
    cv.setAttribute('aria-valuemin', String(o.min));
    cv.setAttribute('aria-valuemax', String(o.max));
    cv.setAttribute('aria-valuetext', fmt(value) + (o.unit ? ' ' + o.unit : ''));
  }

  function syncField() {
    if (editing) return;
    field.value = fmt(value) + (o.unit ? ' ' + o.unit : '');
  }

  function set(v, notify) {
    const next = __W.clamp(isFinite(v) ? v : o.def, o.min, o.max);
    const changed = next !== value;
    value = next;
    paint();
    syncField();
    if (changed && notify !== false && o.onChange) o.onChange(value);
  }

  /* --- drag ----------------------------------------------------------- */

  let dragFrom = null;

  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    cv.setPointerCapture(e.pointerId);
    dragFrom = { y: e.clientY, t: toNorm(value) };
    cv.classList.add('is-turning');
    e.preventDefault();
  });

  cv.addEventListener('pointermove', (e) => {
    if (!dragFrom) return;
    // 160 px of travel spans the whole range; shift divides that by five, and
    // the whole gesture is recomputed from the press so a fine pass never
    // accumulates the drift a per-move delta would.
    const span = e.shiftKey ? 800 : 160;
    const t = dragFrom.t + (dragFrom.y - e.clientY) / span;
    set(fromNorm(t));
  });

  const endDrag = (e) => {
    if (!dragFrom) return;
    dragFrom = null;
    cv.classList.remove('is-turning');
    try { cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);

  cv.addEventListener('dblclick', (e) => { e.preventDefault(); set(o.def); });

  cv.addEventListener('wheel', (e) => {
    if (document.activeElement !== cv) return;   // only when deliberately focused
    e.preventDefault();
    const step = (e.shiftKey ? 0.002 : 0.02) * (e.deltaY < 0 ? 1 : -1);
    set(fromNorm(toNorm(value) + step));
  }, { passive: false });

  cv.addEventListener('keydown', (e) => {
    const fine = e.shiftKey ? 0.002 : 0.02;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') { set(fromNorm(toNorm(value) + fine)); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') { set(fromNorm(toNorm(value) - fine)); }
    else if (e.key === 'Home') { set(o.def); }
    else return;
    e.preventDefault();
  });

  /* --- the typed field ------------------------------------------------- */

  field.addEventListener('focus', () => {
    editing = true;
    field.value = o.curve === 'log' ? String(Math.round(value)) : value.toFixed(o.digits);
    field.select();
  });

  /* Commits once per edit, whatever fires it. Enter calls this and then
     blurs, which fires it again — and by the second call syncField has
     already rewritten the box as "3.0k Hz", where the unit hides the k from
     the suffix test and 3000 Hz silently re-reads as 3. Guarding on
     `editing` makes the second call a no-op, and the parser ignores a
     trailing unit so a hand-typed "3k Hz" works too. */
  const commit = () => {
    if (!editing) return;
    editing = false;
    const raw = field.value.trim().replace(/,/g, '.').toLowerCase()
      .replace(/\s*(hz|db|lu)\s*$/, '');
    const v = parseFloat(raw);
    if (!isFinite(v)) { syncField(); return; }
    set(/k$/.test(raw) ? v * 1000 : v);
  };

  field.addEventListener('blur', commit);
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { commit(); field.blur(); }
    else if (e.key === 'Escape') { editing = false; syncField(); field.blur(); }
    e.stopPropagation();          // the page's space-to-play must not fire here
  });
  field.addEventListener('dblclick', (e) => e.stopPropagation());

  set(value, false);

  return {
    root,
    get value() { return value; },
    set(v) { set(v, false); },
    reset() { set(o.def, false); },
    repaint: paint,
  };
}

/* --------------------------------------------------------------------------
   Fader — the vertical gain control.

   A knob tells you one band's gain; a row of faders tells you the shape of
   the whole EQ at a glance, which is the reason a graphic EQ has ever looked
   the way it does. So gain gets both: the knob for the hand that wants to
   nudge, the fader for the eye that wants to read across.

   Drawn on canvas for the same reason the knob is: a slot milled into the
   faceplate with a shadow falling into it, a knurled cap with an engraved
   centre line, and a detent notch at the marked default are not shapes that
   borders and gradients make. The slot is drawn as a recess, the cap as a
   lit object sitting in it.
   -------------------------------------------------------------------------- */

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { KNOB_ARC_START, KNOB_ARC_END, Knob });

})(window.__studioWidgets || (window.__studioWidgets = {}));
