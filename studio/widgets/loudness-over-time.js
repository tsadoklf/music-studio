/* ==========================================================================
   loudness-over-time.js — short-term LUFS across the track
   --------------------------------------------------------------------------
   The one plot that answers "is this evenly levelled, and is it at target".
   The target line and its ±1 LU band are drawn first so the curve is read
   against them; the curve is coloured by deviation, because a shape alone
   does not say whether a dip matters.

   Depends on: core.js. Registered in the tray by tray.js.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/* ==========================================================================
   4. The meters
   ========================================================================== */

/* ------------------------------------------------------------------ 4.1 --
   LoudnessOverTime — short-term LUFS across the whole track.

   The one plot that answers "is this evenly levelled, and is it at target".
   The target line and its ±1 LU band are drawn first so the curve is read
   against them; the curve itself is coloured by deviation, because a shape
   alone does not say whether a dip matters.
   ========================================================================= */

function LoudnessOverTime(host) {
  const cv = __W.elem('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label',
    'Short-term loudness across the track against the delivery target');
  const wrap = __W.elem('div', 'scope');
  wrap.appendChild(cv);
  const legend = __W.elem('div', 'meter-legend');
  legend.innerHTML =
    '<span><i class="key key--band"></i>±1 LU of target</span>' +
    '<span><i class="key key--ok"></i>on target</span>' +
    '<span><i class="key key--warn"></i>1–3 LU off</span>' +
    '<span><i class="key key--bad"></i>more than 3 LU off</span>';
  host.appendChild(wrap);
  host.appendChild(legend);

  const H = 168;

  function colourFor(d) {
    const ad = Math.abs(d);
    if (ad <= 1) return '#6f9f72';
    if (ad <= 3) return '#d9a441';
    return '#cf5340';
  }

  function render(state) {
    const w = __W.boxWidth(cv, 0);
    if (!__W.hasArea(w, H)) return;
    const ctx = __W.fitCanvas(cv, w, H);
    ctx.clearRect(0, 0, w, H);

    const a = state && state.analysis;
    const st = __W.shortTermOf(a);

    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, w, H);

    if (!st) {
      __W.drawIdle(ctx, w, H, 'no loudness series');
      ctx.fillStyle = '#4e5049';
      ctx.font = `400 10.5px ${__W.MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('load an analysis with loudness.short_term', w / 2, H / 2 + 4);
      return;
    }

    const tgt = __W.targetsOf(a);
    const vals = st.lufs;
    const n = vals.length;

    /* --- vertical scale ------------------------------------------------
       Centred on the target with at least ±9 LU shown, widened to hold the
       material. Auto-scaling to the data alone makes a flat track look like
       a mountain range; anchoring to the target keeps the plot comparable
       between one master and the next. */
    const fin = vals.filter((v) => isFinite(v) && v > -70);
    let lo = tgt.lufs - 9, hi = tgt.lufs + 5;
    if (fin.length) {
      lo = Math.min(lo, Math.min.apply(null, fin) - 1.5);
      hi = Math.max(hi, Math.max.apply(null, fin) + 1.5);
    }
    if (!(hi > lo)) { lo = -30; hi = -5; }

    const padL = 34, padB = 16, padT = 8;
    const plotW = Math.max(1, w - padL - 6);
    const plotH = Math.max(1, H - padB - padT);
    const yOf = (v) => padT + (1 - (__W.clamp(v, lo, hi) - lo) / (hi - lo)) * plotH;
    const xOf = (i) => padL + (n <= 1 ? 0.5 : i / (n - 1)) * plotW;

    /* --- LU grid -------------------------------------------------------- */
    ctx.font = `500 9px ${__W.MONO}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    const stepLu = (hi - lo) > 26 ? 6 : 3;
    const first = Math.ceil(lo / stepLu) * stepLu;
    for (let v = first; v <= hi; v += stepLu) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.fillStyle = 'rgba(78,80,73,0.22)';
      ctx.fillRect(padL, y, plotW, 1);
      ctx.fillStyle = '#5c5e56';
      ctx.fillText(__W.fmtLu(v, 0), padL - 6, y);
    }

    /* --- the tolerance band, then the target line ----------------------- */
    const yB = yOf(tgt.lufs + 1), yT = yOf(tgt.lufs - 1);
    ctx.fillStyle = 'rgba(111,159,114,0.14)';
    ctx.fillRect(padL, Math.min(yB, yT), plotW, Math.abs(yT - yB));

    const yTgt = Math.round(yOf(tgt.lufs)) + 0.5;
    ctx.save();
    ctx.setLineDash([5, 4]);
    ctx.strokeStyle = '#a8894e';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(padL, yTgt); ctx.lineTo(padL + plotW, yTgt);
    ctx.stroke();
    ctx.restore();

    ctx.fillStyle = '#d8b877';
    ctx.textAlign = 'left';
    ctx.font = `500 9.5px ${__W.MONO}`;
    ctx.fillText('target ' + __W.fmtLu(tgt.lufs, 1), padL + 4, yTgt - 8);

    /* --- the curve, in runs of one colour ------------------------------
       Drawing each segment separately would show a seam at every colour
       change; runs are built first so a stretch at target is one stroke. */
    let runStart = 0;
    let runColour = null;
    const flush = (end) => {
      if (runColour == null || end <= runStart) return;
      ctx.beginPath();
      ctx.strokeStyle = runColour;
      ctx.lineWidth = 1.6;
      ctx.lineJoin = 'round';
      for (let i = runStart; i <= end && i < n; i++) {
        const v = vals[i];
        if (!isFinite(v) || v <= -70) continue;
        const x = xOf(i), y = yOf(v);
        if (i === runStart) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    };

    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (!isFinite(v) || v <= -70) continue;
      const c = colourFor(v - tgt.lufs);
      if (c !== runColour) {
        flush(i);
        runStart = Math.max(0, i - 1);
        runColour = c;
      }
    }
    flush(n - 1);

    /* --- the playhead ---------------------------------------------------- */
    const ph = state && __W.num(state.playhead);
    if (isFinite(ph) && ph >= 0 && ph <= 1) {
      const x = Math.round(padL + ph * plotW) + 0.5;
      ctx.fillStyle = 'rgba(255,180,84,0.85)';
      ctx.fillRect(x, padT, 1, plotH);
      ctx.fillStyle = '#ffb454';
      ctx.beginPath();
      ctx.moveTo(x - 3.5, padT); ctx.lineTo(x + 3.5, padT); ctx.lineTo(x, padT + 5);
      ctx.closePath();
      ctx.fill();
    }

    /* --- time axis -------------------------------------------------------- */
    const dur = __W.durationOf(a);
    ctx.fillStyle = '#5c5e56';
    ctx.font = `500 9px ${__W.MONO}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';
    ctx.fillText('0:00', padL, H - padB + 3);
    if (dur > 0) {
      ctx.textAlign = 'right';
      ctx.fillText(__W.fmtTime(dur), padL + plotW, H - padB + 3);
    }
    ctx.textAlign = 'center';
    ctx.fillStyle = '#4e5049';
    ctx.fillText('SHORT-TERM LUFS · 3 s WINDOW', padL + plotW / 2, H - padB + 3);
  }

  return {
    render,
    reset() {
      const w = __W.boxWidth(cv, 0);
      if (!__W.hasArea(w, H)) return;
      const ctx = __W.fitCanvas(cv, w, H);
      __W.drawIdle(ctx, w, H, 'no loudness series');
    },
  };
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { LoudnessOverTime });

})(window.__studioWidgets || (window.__studioWidgets = {}));
