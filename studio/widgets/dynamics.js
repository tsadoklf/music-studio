/* ==========================================================================
   dynamics.js — crest factor and loudness range over the track
   --------------------------------------------------------------------------
   Where the master is squashed and where it breathes. Crest factor and LRA
   together separate "this section is loud" from "this section has been
   squashed" — two things a single loudness plot cannot tell apart.

   Depends on: core.js. Registered in the tray by tray.js.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/* ------------------------------------------------------------------ 4.4 --
   DynamicsHistory — crest factor and loudness range, over the track.

   Crest factor is peak minus RMS, computed from the envelopes frame by
   frame: it says how much transient is left at each moment. Loudness range
   is computed over a sliding window of the short-term series: it says how
   much the level moves around over the last half minute. Together they
   separate "this section is loud" from "this section has been squashed" —
   two things a single loudness plot cannot tell apart.
   ========================================================================= */

function DynamicsHistory(host) {
  const cv = __W.elem('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'Crest factor and loudness range over the track');
  const wrap = __W.elem('div', 'scope');
  wrap.appendChild(cv);

  const legend = __W.elem('div', 'meter-legend');
  legend.innerHTML =
    '<span><i class="key key--crest"></i>Crest factor (dB)</span>' +
    '<span><i class="key key--lra"></i>Loudness range (LU, 30 s window)</span>' +
    '<span class="meter-legend-note">low crest means squashed</span>';

  const reads = __W.elem('div', 'dyn-reads');
  const mk = (k) => {
    const cell = __W.elem('div', 'dyn-read');
    cell.innerHTML = `<span class="k">${k}</span><span class="v">—</span>`;
    return cell;
  };
  const rCrest = mk('Crest'), rLra = mk('LRA'), rMin = mk('Least dynamic');
  reads.appendChild(rCrest); reads.appendChild(rLra); reads.appendChild(rMin);

  host.appendChild(reads);
  host.appendChild(wrap);
  host.appendChild(legend);

  const H = 168;

  /** Per-frame crest factor from the envelopes: max over channels of
      peak − rms, which is the honest reading for a stereo file where one
      channel carries the transient. */
  function crestSeries(a) {
    const env = __W.envelopesOf(a);
    if (!env) return null;
    let n = Infinity;
    for (const c of env) {
      if (c.peak) n = Math.min(n, c.peak.length);
      if (c.rms) n = Math.min(n, c.rms.length);
    }
    if (!isFinite(n) || n < 2) return null;
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      let best = NaN;
      for (const c of env) {
        if (!c.peak || !c.rms) continue;
        const p = c.peak[i], r = c.rms[i];
        if (!isFinite(p) || !isFinite(r) || r < -80) continue;
        const d = p - r;
        if (!(best >= d)) best = d;
      }
      out[i] = best;
    }
    return out;
  }

  /** Rolling loudness range: the 95th minus the 10th percentile of the
      short-term values inside the window, which is the shape of the LRA
      definition without the gating a whole-file figure applies. */
  function lraSeries(a) {
    const st = __W.shortTermOf(a);
    if (!st) return null;
    const v = st.lufs;
    const n = v.length;
    if (n < 4) return null;
    // Short-term frames are usually 10 per second; 30 s is 300 frames. Work
    // the spacing out from the times array when it is there.
    let per = 10;
    if (st.times && st.times.length > 1) {
      const dt = st.times[1] - st.times[0];
      if (dt > 0) per = 1 / dt;
    }
    const win = Math.max(8, Math.min(Math.round(per * 30), Math.floor(n / 2)));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const lo = Math.max(0, i - win + 1);
      const slice = [];
      for (let j = lo; j <= i; j++) if (isFinite(v[j]) && v[j] > -70) slice.push(v[j]);
      if (slice.length < 4) { out[i] = NaN; continue; }
      slice.sort((x, y) => x - y);
      const q = (p) => slice[__W.clamp(Math.floor(slice.length * p), 0, slice.length - 1)];
      out[i] = q(0.95) - q(0.10);
    }
    return out;
  }

  function trace(ctx, series, n, xOf, yOf, colour, width) {
    ctx.beginPath();
    ctx.strokeStyle = colour;
    ctx.lineWidth = width;
    ctx.lineJoin = 'round';
    let started = false;
    for (let i = 0; i < n; i++) {
      const v = series[i];
      if (!isFinite(v)) { started = false; continue; }
      const x = xOf(i / (n - 1 || 1)), y = yOf(v);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  function render(state) {
    const w = __W.boxWidth(cv, 0);
    if (!__W.hasArea(w, H)) return;
    const ctx = __W.fitCanvas(cv, w, H);
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, w, H);

    const a = state && state.analysis;
    const crest = crestSeries(a);
    const lra = lraSeries(a);

    if (!crest && !lra) {
      __W.drawIdle(ctx, w, H, 'no envelopes');
      ctx.fillStyle = '#4e5049';
      ctx.font = `400 10.5px ${__W.MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('needs envelopes or loudness.short_term', w / 2, H / 2 + 4);
      rCrest.querySelector('.v').textContent = '—';
      rLra.querySelector('.v').textContent = '—';
      rMin.querySelector('.v').textContent = '—';
      return;
    }

    const padL = 32, padR = 34, padB = 16, padT = 8;
    const plotW = Math.max(1, w - padL - padR);
    const plotH = Math.max(1, H - padB - padT);
    const xOf = (t) => padL + __W.clamp(t, 0, 1) * plotW;

    /* Two scales sharing one plot. Both are dB-like and both matter in
       roughly the same band, so they are given the same 0..24 range and one
       axis: two independent auto-scales would invite reading a crossing as
       meaning something, which it would not. */
    const SCALE_MAX = 24;
    const yOf = (v) => padT + (1 - __W.clamp(v, 0, SCALE_MAX) / SCALE_MAX) * plotH;

    ctx.font = `500 9px ${__W.MONO}`;
    ctx.textBaseline = 'middle';
    for (let v = 0; v <= SCALE_MAX; v += 6) {
      const y = Math.round(yOf(v)) + 0.5;
      ctx.fillStyle = 'rgba(78,80,73,0.20)';
      ctx.fillRect(padL, y, plotW, 1);
      ctx.fillStyle = '#5c5e56';
      ctx.textAlign = 'right';
      ctx.fillText(String(v), padL - 6, y);
    }

    /* The band under 8 dB of crest: below this a master is squashed, and
       saying so on the face beats making the reader remember it. */
    ctx.fillStyle = 'rgba(207,83,64,0.10)';
    const y8 = yOf(8);
    ctx.fillRect(padL, y8, plotW, padT + plotH - y8);
    ctx.fillStyle = 'rgba(207,83,64,0.55)';
    ctx.font = `500 9px ${__W.MONO}`;
    ctx.textAlign = 'left';
    ctx.fillText('squashed', padL + 5, y8 + 9);

    if (crest) trace(ctx, crest, crest.length, xOf, yOf, '#ffb454', 1.5);
    if (lra) trace(ctx, lra, lra.length, xOf, yOf, '#7fb0c9', 1.4);

    const ph = __W.num(state && state.playhead);
    if (isFinite(ph) && ph >= 0 && ph <= 1) {
      const x = Math.round(xOf(ph)) + 0.5;
      ctx.fillStyle = 'rgba(255,255,255,0.4)';
      ctx.fillRect(x, padT, 1, plotH);
    }

    ctx.fillStyle = '#4e5049';
    ctx.font = `500 9px ${__W.MONO}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'right';
    ctx.fillText('dB / LU', w - 4, padT);
    ctx.textAlign = 'center';
    ctx.fillText('TIME →', padL + plotW / 2, H - padB + 3);

    /* --- readouts ------------------------------------------------------- */
    const meas = (a && a.measures) || {};
    const cf = __W.num(meas.crest_factor);
    rCrest.querySelector('.v').textContent = isFinite(cf) ? cf.toFixed(1) + ' dB' : '—';
    const lraWhole = __W.num(meas.lra) || __W.num(a && a.loudness && a.loudness.lra);
    rLra.querySelector('.v').textContent =
      isFinite(lraWhole) ? lraWhole.toFixed(1) + ' LU' : '—';

    if (crest) {
      let worst = Infinity, at = 0;
      for (let i = 0; i < crest.length; i++) {
        if (isFinite(crest[i]) && crest[i] < worst) { worst = crest[i]; at = i; }
      }
      const dur = __W.durationOf(a);
      rMin.querySelector('.v').textContent = isFinite(worst)
        ? `${worst.toFixed(1)} dB at ${__W.fmtTime(dur * at / (crest.length - 1 || 1))}`
        : '—';
    } else {
      rMin.querySelector('.v').textContent = '—';
    }
  }

  return {
    render,
    reset() {
      rCrest.querySelector('.v').textContent = '—';
      rLra.querySelector('.v').textContent = '—';
      rMin.querySelector('.v').textContent = '—';
      const w = __W.boxWidth(cv, 0);
      if (!__W.hasArea(w, H)) return;
      const ctx = __W.fitCanvas(cv, w, H);
      __W.drawIdle(ctx, w, H, 'no envelopes');
    },
  };
}

/* ------------------------------------------------------------------ 4.5 --
   EqualizerPanel — the bench's tone control.

   Two ways in. The preset row is what `music master --eq <name>` already
   does, shown with the filter chain each name expands to, straight out of
   master.py. The band bank is the same job done by hand, and its output is
   a chain that can be pasted into `--eq "<chain>"` — the CLI accepts a raw
   ffmpeg chain for anything that is not a known preset name.

   The curve is computed from the same coefficients ffmpeg builds, so what
   is on screen is what the file will get. A drawn approximation would be
   worse than no curve at all: it would be believed.

   The band controls fold away, because most of the time the question is
   "which preset" and the full bank is fourteen knobs of noise.
   ========================================================================= */

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { DynamicsHistory });

})(window.__studioWidgets || (window.__studioWidgets = {}));
