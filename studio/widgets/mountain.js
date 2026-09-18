/* ==========================================================================
   mountain.js — the live spectrum drawn behind an EQ curve
   --------------------------------------------------------------------------
   A response curve tells you what the filters do, but not what they are doing
   it TO. With the content drawn behind it on the same frequency axis, a
   resonance is something you can see and drag a band onto rather than
   something you hunt for by ear.

   This was `EqualizerPanel`'s private code until a second equaliser wanted the
   same overlay. It is lifted here whole rather than copied, because the three
   things it gets right are each a bug someone already paid for:

     · the log-axis gaps are INTERPOLATED, not held — below 100 Hz one FFT bin
       spans many columns, and holding drew the low end as a staircase that
       reads as structure in the audio that is not there;
     · the live Nyquist comes from the AUDIO CONTEXT, not from the delivery
       rate — the curve is drawn at 48 kHz but the browser usually opens its
       context at 44.1, and using one number for both put every bin about 9%
       too high on the axis;
     · a static average spectrum is SHIFTED to sit in the window, because
       analyze.py's dB reference is not dBFS and taking it literally put the
       mountain off the top or bottom of the plot depending on the file.

   `Mountain(opts)` returns { update(state, w), draw(ctx, w, plotH), reset() }.
   The owner calls update() once per frame with the tray's state and the canvas
   width, then draw() from inside its own paint, before the curve, so the curve
   and its handles land on top.

   Depends on: core.js (clamp, num, arrOf, fToT, FMIN, FMAX).

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';

/* The window the mountain is drawn in. A curve's axis is ±18 dB of RESPONSE,
   which is not a level, so the spectrum cannot share those numbers — it is
   mapped to the plot's height instead, from floor to ceiling of signal level.
   The FREQUENCY axis is shared exactly: both use __W.fToT, and that alignment
   is the entire reason the overlay is worth drawing. */
const SPEC_FLOOR = -84, SPEC_CEIL = -6;

/* Release per frame. 0.82 settles a peak in about a fifth of a second at
   60 Hz — slow enough not to flicker, fast enough that the mountain still
   follows the music rather than lagging behind it. */
const SPEC_RELEASE = 0.82;

/* How fast the shape falls away when the source stops. Letting it decay
   rather than cutting it is what makes stopping playback look like a fade. */
const SPEC_DECAY_DB = 1.6;

/**
 * @param {object} opts
 *   fs        the delivery sample rate, a fallback only — the live path asks
 *             the audio context for its own rate
 *   padTop    pixels above the plot, so the fill lines up with the caller's
 *             own geometry
 *   engine    () => the audio engine, for the context's real sample rate
 */
function Mountain(opts) {
  const o = Object.assign({ fs: 48000, padTop: 6, engine: null }, opts);

  let env = null;            // Float32Array, dB per column — the decay IS state
  let raw = null;
  let width = 0;
  let live = false;          // was the last fill from live audio?

  /** The live analyser's Nyquist, in Hz. Asked for rather than assumed. */
  function nyquistOf() {
    try {
      const eng = o.engine ? o.engine() : null;
      const sr = eng && eng.ctx ? __W.num(eng.ctx.sampleRate) : NaN;
      if (isFinite(sr) && sr > 0) return sr / 2;
    } catch { /* fall through */ }
    return o.fs / 2;
  }

  /** Fold a bin array into per-column dB on the curve's log-frequency axis.
      Each column takes the MAXIMUM of the bins that fall in it, not the mean:
      at the bottom of a log axis one column spans a fraction of a bin and at
      the top it spans dozens, and averaging there buries exactly the narrow
      resonance the overlay exists to reveal. */
  function foldBins(cols, n, binHz, toDb, w) {
    for (let x = 0; x < w; x++) cols[x] = -Infinity;
    for (let i = 0; i < n; i++) {
      const f = binHz(i);
      if (!(f >= __W.FMIN) || f > __W.FMAX) continue;
      const x = Math.round(__W.fToT(f) * (w - 1));
      if (x < 0 || x >= w) continue;
      const db = toDb(i);
      if (isFinite(db) && db > cols[x]) cols[x] = db;
    }
    /* Columns no bin landed in are interpolated. See the header: holding drew
       a staircase that looked like real structure. */
    let prev = -1;
    for (let x = 0; x < w; x++) {
      if (!isFinite(cols[x])) continue;
      if (prev >= 0 && x - prev > 1) {
        const a = cols[prev], b = cols[x], span = x - prev;
        for (let k = 1; k < span; k++) cols[prev + k] = a + (b - a) * (k / span);
      }
      prev = x;
    }
    /* The runs at either end have one neighbour to go on, so they take it
       flat rather than inventing a slope. */
    let first = -1, lastI = -1;
    for (let x = 0; x < w; x++) { if (isFinite(cols[x])) { first = x; break; } }
    for (let x = w - 1; x >= 0; x--) { if (isFinite(cols[x])) { lastI = x; break; } }
    if (first < 0) return cols;                    // nothing landed at all
    for (let x = 0; x < first; x++) cols[x] = cols[first];
    for (let x = lastI + 1; x < w; x++) cols[x] = cols[lastI];
    return cols;
  }

  /** Refill from whatever source is available. True when there is something
      worth drawing. */
  function update(state, w) {
    if (!(w > 0)) return false;
    if (!env || width !== w) {
      env = new Float32Array(w).fill(-Infinity);
      raw = new Float32Array(w);
      width = w;
    }
    const liveState = (state && state.live) || {};
    const a = state && state.analysis;
    const playing = !!(state && state.playing);

    const sr = __W.num(a && a.metadata && a.metadata.sample_rate);
    const nyq = isFinite(sr) ? sr / 2 : (o.fs / 2);

    let got = false;
    const bins = liveState.spectrum;
    if (playing && bins && bins.length) {
      /* The analyser's byte data: 0..255 spanning minDecibels..maxDecibels,
         which the engine sets to −90..0. Mapped back to dB so the mountain is
         drawn against a level scale rather than a byte scale. */
      const n = bins.length;
      const nq = nyquistOf();
      foldBins(raw, n, (i) => (i + 0.5) * nq / n,
        (i) => (bins[i] / 255) * 90 - 90, w);
      got = true;
      live = true;
    } else {
      const spec = (a && a.spectrum) || {};
      const db = __W.arrOf(spec.db);
      const freqs = __W.arrOf(spec.freqs);
      if (db && db.length) {
        /* Shifted so its loudest bin sits where a loud live signal would.
           The SHAPE is the information; the absolute offset is not. */
        let hi = -Infinity;
        for (const v of db) if (isFinite(v) && v > hi) hi = v;
        const shift = isFinite(hi) ? (SPEC_CEIL - 4) - hi : 0;
        const freqAt = (freqs && freqs.length === db.length)
          ? (i) => freqs[i]
          : (i) => (i + 0.5) * nyq / db.length;
        foldBins(raw, db.length, freqAt, (i) => db[i] + shift, w);
        got = true;
        live = false;
      }
    }

    if (!got) {
      let any = false;
      for (let x = 0; x < w; x++) {
        const v = env[x];
        if (!isFinite(v)) continue;
        env[x] = v - SPEC_DECAY_DB;
        if (env[x] > SPEC_FLOOR) any = true; else env[x] = -Infinity;
      }
      return any;
    }

    /* Attack instantly, release slowly — a peak-hold, which stops a spectrum
       strobing without making it lag. A static average has nothing to decay. */
    if (!live) {
      env.set(raw);
    } else {
      for (let x = 0; x < w; x++) {
        const now = raw[x];
        const prev = env[x];
        env[x] = (!isFinite(prev) || now >= prev)
          ? now
          : prev * SPEC_RELEASE + now * (1 - SPEC_RELEASE);
      }
    }
    return true;
  }

  /** Draw it. Call before the curve, so the curve and handles paint on top. */
  function draw(ctx, w, plotH) {
    if (!env || width !== w) return;

    const yFor = (db) => {
      const t = (__W.clamp(db, SPEC_FLOOR, SPEC_CEIL) - SPEC_FLOOR) /
                (SPEC_CEIL - SPEC_FLOOR);
      return o.padTop + (1 - t) * plotH;
    };
    const base = o.padTop + plotH;

    let started = false;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const v = env[x];
      const y = isFinite(v) ? yFor(v) : base;
      if (!started) { ctx.moveTo(x, base); ctx.lineTo(x, y); started = true; }
      else ctx.lineTo(x, y);
    }
    if (!started) return;
    ctx.lineTo(w - 1, base);
    ctx.closePath();

    /* Subordinate by construction: a cool grey-green against the curve's
       amber, at an alpha low enough that the curve reads straight through it,
       and with a vertical fade so the mass sits at the bottom of the plot
       rather than competing with the 0 dB line. If the eye goes to the
       mountain first, this is drawn wrong. */
    const grad = ctx.createLinearGradient(0, o.padTop, 0, base);
    grad.addColorStop(0, 'rgba(126,172,138,0.26)');
    grad.addColorStop(1, 'rgba(96,132,110,0.07)');
    ctx.fillStyle = grad;
    ctx.fill();

    /* A hairline along the ridge. Without it a low, broad spectrum is a smear
       with no readable top edge. */
    ctx.beginPath();
    let move = true;
    for (let x = 0; x < w; x++) {
      const v = env[x];
      if (!isFinite(v)) { move = true; continue; }
      const y = yFor(v);
      if (move) { ctx.moveTo(x, y); move = false; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(150,196,162,0.34)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function reset() {
    if (env) env.fill(-Infinity);
    live = false;
  }

  return { update, draw, reset,
    get hasData() { return !!env; } };
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { Mountain, SPEC_FLOOR, SPEC_CEIL, SPEC_RELEASE });

})(window.__studioWidgets || (window.__studioWidgets = {}));
