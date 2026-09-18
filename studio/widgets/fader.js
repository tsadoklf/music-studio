/* ==========================================================================
   fader.js — the slide fader control
   --------------------------------------------------------------------------
   A slot milled into the panel with a knurled cap riding in it. The natural
   control for gain, and readable across a bank at a glance. Also holds
   roundRect, the rounded-rectangle path helper, since Safari shipped
   ctx.roundRect late enough that a page opened from a disk cannot assume it.

   Depends on: core.js (fitCanvas, elem, clamp, lerp, MONO, ENGRAVE).

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/**
 * @param {object} opts
 *   label      engraved under the slot
 *   min,max    range in the control's own units
 *   value      initial
 *   def        the double-click default; also where the detent is marked
 *   unit       printed after the number in the readout
 *   digits     decimals in the readout
 *   width      the control's CSS width
 *   height     the slot's CSS height
 *   onChange   called with the new value
 */
function Fader(opts) {
  const o = Object.assign({
    label: '', min: -18, max: 18, value: 0, def: 0,
    unit: 'dB', digits: 1, width: 38, height: 118, onChange: null,
  }, opts);

  const root = __W.elem('div', 'eq-fader');
  const cv = __W.elem('canvas', 'eq-fader-face');
  cv.setAttribute('role', 'slider');
  cv.tabIndex = 0;
  cv.setAttribute('aria-label', o.label);
  cv.setAttribute('aria-orientation', 'vertical');
  const read = __W.elem('div', 'eq-fader-read', '');

  /* No engraved legend under the slot: the knob standing beside it is already
     labelled GAIN, and a second one cost a line of height on every strip to
     say what the strip had said once already. The name survives for a screen
     reader on the canvas's aria-label. */
  root.appendChild(cv);
  root.appendChild(read);

  let value = __W.clamp(o.value, o.min, o.max);

  /* The cap is deliberately broad against a narrow slot: that proportion is
     what makes a fader read as a fader from across a room, and it is also
     what gives the finger something to land on. */
  const CAP_H = 22;                    // the cap's own height, in CSS px
  const toNorm = (v) => (__W.clamp(v, o.min, o.max) - o.min) / (o.max - o.min);
  const fromNorm = (t) => __W.lerp(o.min, o.max, __W.clamp(t, 0, 1));

  /** Travel is the slot minus the cap: the cap's centre can reach the top of
      the slot only if half of it hangs out, which is not how a fader looks. */
  function travel(h) { return Math.max(1, h - CAP_H); }
  function yOfNorm(t, h) { return CAP_H / 2 + (1 - __W.clamp(t, 0, 1)) * travel(h); }
  function normOfY(y, h) { return __W.clamp(1 - (y - CAP_H / 2) / travel(h), 0, 1); }

  function paint() {
    const W = o.width, H = o.height;
    if (!__W.hasArea(W, H)) return;
    const ctx = __W.fitCanvas(cv, W, H);
    cv.style.width = W + 'px';
    ctx.clearRect(0, 0, W, H);

    const cx = W / 2;
    const slotW = 9;
    const t = toNorm(value);
    const capY = yOfNorm(t, H);

    /* --- the slot, cut into the panel --------------------------------- */
    const slotX = cx - slotW / 2;
    const slotTop = 3, slotH = H - 6;
    const slot = ctx.createLinearGradient(slotX, 0, slotX + slotW, 0);
    slot.addColorStop(0, '#050605');
    slot.addColorStop(0.45, '#0d0e0c');
    slot.addColorStop(1, '#232420');
    ctx.fillStyle = slot;
    roundRect(ctx, slotX, slotTop, slotW, slotH, 3);
    ctx.fill();
    /* the lip the milling leaves at the top edge of the cut */
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 1;
    roundRect(ctx, slotX + 0.5, slotTop + 0.5, slotW - 1, slotH - 1, 3);
    ctx.stroke();

    /* --- the scale, engraved either side of the slot -------------------
       A fader with nothing to read against is a stick in a hole. Ticks at
       every quarter of the travel, the centre one long and gold because it
       is the detent, the rest short and dark like milled marks. */
    const yDef = yOfNorm(toNorm(o.def), H);
    for (let i = 0; i <= 8; i++) {
      const y = Math.round(CAP_H / 2 + (i / 8) * travel(H)) + 0.5;
      const mid = i === 4;
      const len = mid ? W * 0.20 : (i % 2 === 0 ? W * 0.14 : W * 0.09);
      ctx.fillStyle = mid ? 'rgba(168,137,78,0.65)' : 'rgba(78,80,73,0.45)';
      ctx.fillRect(cx - slotW / 2 - len - 1, y, len, 1);
      ctx.fillRect(cx + slotW / 2 + 1, y, len, 1);
    }
    /* The detent mark sits where the default actually is, which is the centre
       only for a symmetric range — drawn separately rather than assumed. */
    if (Math.abs(yDef - (CAP_H / 2 + 0.5 * travel(H))) > 1) {
      ctx.fillStyle = 'rgba(168,137,78,0.65)';
      ctx.fillRect(cx - slotW / 2 - W * 0.2 - 1, Math.round(yDef), W * 0.2, 1);
      ctx.fillRect(cx + slotW / 2 + 1, Math.round(yDef), W * 0.2, 1);
    }

    /* --- the lit travel, from the default to where the cap is ---------- */
    if (Math.abs(capY - yDef) > 0.6) {
      ctx.fillStyle = 'rgba(255,180,84,0.42)';
      ctx.fillRect(cx - 1.5, Math.min(capY, yDef), 3, Math.abs(capY - yDef));
    }

    /* --- the cap -------------------------------------------------------- */
    /* About two and a half slot-widths across and a little taller than it is
       wide: the proportion of a mixing-desk cap. Wider than that and it reads
       as a hammer head sitting on a stick. */
    const capW = Math.round(slotW * 2.6), capX = cx - capW / 2, capTop = capY - CAP_H / 2;

    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.8)';
    ctx.shadowBlur = 5;
    ctx.shadowOffsetY = 2;
    const body = ctx.createLinearGradient(capX, capTop, capX + capW, capTop + CAP_H);
    body.addColorStop(0, '#6d6f66');
    body.addColorStop(0.38, '#3a3c36');
    body.addColorStop(0.62, '#262823');
    body.addColorStop(1, '#131412');
    ctx.fillStyle = body;
    roundRect(ctx, capX, capTop, capW, CAP_H, 2.5);
    ctx.fill();
    ctx.restore();

    /* knurling: fine horizontal ridges across the cap, the grip a fader cap
       actually has, low contrast so it reads as texture not as stripes */
    ctx.save();
    ctx.beginPath();
    roundRect(ctx, capX, capTop, capW, CAP_H, 2.5);
    ctx.clip();
    for (let y = capTop + 3; y < capTop + CAP_H - 3; y += 2.5) {
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(capX, Math.round(y), capW, 1);
      ctx.fillStyle = 'rgba(120,122,113,0.16)';
      ctx.fillRect(capX, Math.round(y) + 1, capW, 1);
    }
    ctx.restore();

    /* the engraved centre line — where the cap reads against the scale */
    const mid = Math.round(capY) + 0.5;
    ctx.strokeStyle = 'rgba(0,0,0,0.9)';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(capX + 1.5, mid); ctx.lineTo(capX + capW - 1.5, mid); ctx.stroke();
    ctx.strokeStyle = value === o.def ? 'rgba(216,184,119,0.75)' : '#e8d5a8';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(capX + 1.5, mid); ctx.lineTo(capX + capW - 1.5, mid); ctx.stroke();

    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.lineWidth = 1;
    roundRect(ctx, capX + 0.5, capTop + 0.5, capW - 1, CAP_H - 1, 2.5);
    ctx.stroke();

    cv.setAttribute('aria-valuenow', String(Math.round(value * 100) / 100));
    cv.setAttribute('aria-valuemin', String(o.min));
    cv.setAttribute('aria-valuemax', String(o.max));
    cv.setAttribute('aria-valuetext', __W.sgn(value, o.digits) + (o.unit ? ' ' + o.unit : ''));
  }

  function syncRead() {
    read.textContent = __W.sgn(value, o.digits);
    read.classList.toggle('is-zero', Math.abs(value - o.def) < 0.05);
  }

  function set(v, notify) {
    const next = __W.clamp(isFinite(v) ? v : o.def, o.min, o.max);
    const changed = next !== value;
    value = next;
    paint();
    syncRead();
    if (changed && notify !== false && o.onChange) o.onChange(value);
  }

  /* --- drag -----------------------------------------------------------
     The cap follows the pointer absolutely rather than by a delta: that is
     what a fader does, and it means a press anywhere on the slot jumps the
     cap there, which is also what a fader does. The grab offset is kept so
     a press on the cap itself does not make it jump under the finger. */

  let dragging = null;

  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    cv.setPointerCapture(e.pointerId);
    const r = cv.getBoundingClientRect();
    const y = e.clientY - r.top;
    const capY = yOfNorm(toNorm(value), o.height);
    const onCap = Math.abs(y - capY) <= CAP_H / 2 + 2;
    dragging = { off: onCap ? y - capY : 0 };
    cv.classList.add('is-sliding');
    if (!onCap) set(fromNorm(normOfY(y, o.height)));
    e.preventDefault();
  });

  cv.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const r = cv.getBoundingClientRect();
    let y = e.clientY - r.top - dragging.off;
    let t = normOfY(y, o.height);
    /* Shift is fine: the same travel covers a fifth of the range, taken
       around where the press began rather than re-scaling the whole slot. */
    if (e.shiftKey) {
      const base = toNorm(value);
      t = __W.clamp(base + (t - base) * 0.2, 0, 1);
    }
    let v = fromNorm(t);
    /* The detent: within a third of a dB of the default the cap sticks to it,
       so 0 dB is findable without watching the number. */
    if (Math.abs(v - o.def) < 0.34) v = o.def;
    set(v);
  });

  const endDrag = (e) => {
    if (!dragging) return;
    dragging = null;
    cv.classList.remove('is-sliding');
    try { cv.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);

  cv.addEventListener('dblclick', (e) => { e.preventDefault(); set(o.def); });

  cv.addEventListener('wheel', (e) => {
    if (document.activeElement !== cv) return;   // only when deliberately focused
    e.preventDefault();
    const step = (e.shiftKey ? 0.1 : 0.5) * (e.deltaY < 0 ? 1 : -1);
    set(value + step);
  }, { passive: false });

  cv.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.5;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') set(value + step);
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') set(value - step);
    else if (e.key === 'Home') set(o.def);
    else if (e.key === 'PageUp') set(value + step * 6);
    else if (e.key === 'PageDown') set(value - step * 6);
    else return;
    e.preventDefault();
  });

  set(value, false);

  return {
    root,
    get value() { return value; },
    set(v) { set(v, false); },
    reset() { set(o.def, false); },
    repaint: paint,
  };
}

/** A rounded rectangle path. Safari shipped ctx.roundRect late enough that
    a page opened from a disk cannot assume it. */
function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.arcTo(x + w, y, x + w, y + rr, rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.arcTo(x + w, y + h, x + w - rr, y + h, rr);
  ctx.lineTo(x + rr, y + h);
  ctx.arcTo(x, y + h, x, y + h - rr, rr);
  ctx.lineTo(x, y + rr);
  ctx.arcTo(x, y, x + rr, y, rr);
  ctx.closePath();
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { Fader, roundRect });

})(window.__studioWidgets || (window.__studioWidgets = {}));
