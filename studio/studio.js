/* ============================================================================
   Music Studio — audio analysis + instrument rendering
   Vanilla JS, no build step. Opens from file://.

   Sections:
     1  colour maps + small maths
     2  VU ballistics (second-order damped response)
     3  loudness (ITU-R BS.1770-4 K-weighting, gated integration)
     4  drawing: VU dial, dBFS bars, correlation, spectrum, spectrogram
     5  audio engine (WebAudio) + precomputed-JSON adapter
     6  verdicts
     7  transport, file loading, boot
   ========================================================================= */
'use strict';

/* ==========================================================================
   1. Colour maps and maths helpers
   ========================================================================== */

/* Inferno, 16 stops sampled from the perceptually-uniform original.
   Chosen over viridis because the dark-to-ember ramp sits inside the
   faceplate's warm palette instead of fighting it. */
const INFERNO = [
  [  0,   0,   4], [ 12,   8,  38], [ 36,  12,  79], [ 66,  10, 104],
  [ 93,  18, 110], [120,  28, 109], [147,  38, 103], [174,  48,  92],
  [199,  62,  76], [220,  80,  57], [237, 105,  37], [247, 135,  17],
  [251, 167,   9], [249, 200,  41], [243, 231,  95], [252, 255, 164],
];

/** Sample the colormap. t is clamped to 0..1. Returns [r,g,b] 0-255. */
function inferno(t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = t * (INFERNO.length - 1);
  const i = Math.min(INFERNO.length - 2, Math.floor(x));
  const f = x - i;
  const a = INFERNO[i], b = INFERNO[i + 1];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;
const dbfs = (amp) => 20 * Math.log10(Math.max(amp, 1e-7));

function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Signed dB with a fixed sign, the way a meter prints it. */
function fmtDb(v, digits = 1) {
  if (!isFinite(v)) return '−∞';
  if (v <= -99) return '−∞';
  const s = v.toFixed(digits);
  return s.startsWith('-') ? '−' + s.slice(1) : '+' + s;
}

/** Unsigned dB for scale labels. */
function fmtLu(v, digits = 1) {
  if (!isFinite(v) || v <= -70) return '−∞';
  return (v < 0 ? '−' : '') + Math.abs(v).toFixed(digits);
}

/* ==========================================================================
   2. VU ballistics
   --------------------------------------------------------------------------
   A real VU movement is a mass on a spring with viscous damping, driven by
   the rectified average of the signal. The ASA C16.5 / IEC 60268-17 spec:
   a step to 0 VU reaches 99% of full deflection in 300 ms, and overshoots
   by 1 to 1.5%.

   Model:   x'' + 2ζω x' + ω² x = ω² u

   Both constants are solved from the spec rather than guessed:

     overshoot = exp(-πζ/√(1-ζ²)) = 0.015  →  ζ = 0.80075
     then ω is the value whose first 99% crossing lands at 300 ms,
     found by bisection  →  ω = 13.128 rad/s

   Verified at the 1 ms substep below: rise 301 ms, overshoot 1.41%.
   (A lighter ζ such as 0.6 rings far too much — around 8% — and a rise
   derived from a settling-time rule of thumb comes out near 113 ms, which
   is why these are solved numerically and not estimated.)

   This is integrated with a fixed-step semi-implicit Euler so the response
   does not change with display frame rate — a tween would.
   ========================================================================== */

const VU_ZETA = 0.80075;        // 1.5% overshoot
const VU_OMEGA = 13.128;        // rad/s — 300 ms to 99% deflection
const VU_SUBSTEP = 1 / 1000;    // 1 ms fixed integration step

class VuMovement {
  constructor() {
    this.x = 0;      // needle position, in VU
    this.v = 0;      // angular velocity
    this._acc = 0;   // leftover time between frames
  }

  /**
   * Advance the movement.
   * @param {number} target  drive level in VU (0 VU = reference)
   * @param {number} dt      elapsed wall time in seconds
   */
  step(target, dt) {
    if (!isFinite(target)) target = -20;
    // Never integrate a huge catch-up burst after a tab has been hidden.
    this._acc = Math.min(this._acc + dt, 0.1);
    const w2 = VU_OMEGA * VU_OMEGA;
    const c = 2 * VU_ZETA * VU_OMEGA;
    while (this._acc >= VU_SUBSTEP) {
      const a = w2 * (target - this.x) - c * this.v;
      this.v += a * VU_SUBSTEP;
      this.x += this.v * VU_SUBSTEP;
      this._acc -= VU_SUBSTEP;
    }
    return this.x;
  }
}

/* ==========================================================================
   3. Loudness — ITU-R BS.1770-4
   --------------------------------------------------------------------------
   K-weighting is a high-shelf ("head" filter) followed by a high-pass
   (RLB). Coefficients below are the standard's, given for 48 kHz and
   re-derived for other rates by matching the analogue prototype.
   ========================================================================== */

/** Biquad, direct form I, operating sample by sample. */
class Biquad {
  constructor(b0, b1, b2, a1, a2) {
    Object.assign(this, { b0, b1, b2, a1, a2 });
    this.x1 = this.x2 = this.y1 = this.y2 = 0;
  }
  process(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2
            - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x;
    this.y2 = this.y1; this.y1 = y;
    return y;
  }
  reset() { this.x1 = this.x2 = this.y1 = this.y2 = 0; }
}

/** BS.1770 stage 1: +4 dB high shelf at ~1681 Hz. */
function shelfFilter(fs) {
  const f0 = 1681.974450955533;
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const K = Math.tan(Math.PI * f0 / fs);
  const Vh = Math.pow(10, G / 20);
  const Vb = Math.pow(Vh, 0.4996667741545416);
  const den = 1 + K / Q + K * K;
  return new Biquad(
    (Vh + Vb * K / Q + K * K) / den,
    2 * (K * K - Vh) / den,
    (Vh - Vb * K / Q + K * K) / den,
    2 * (K * K - 1) / den,
    (1 - K / Q + K * K) / den
  );
}

/** BS.1770 stage 2: RLB high pass at ~38 Hz. */
function rlbFilter(fs) {
  const f0 = 38.13547087602444;
  const Q = 0.5003270373238773;
  const K = Math.tan(Math.PI * f0 / fs);
  const den = 1 + K / Q + K * K;
  return new Biquad(
    1, -2, 1,
    2 * (K * K - 1) / den,
    (1 - K / Q + K * K) / den
  );
}

/**
 * Streaming loudness meter: momentary (400 ms), short-term (3 s), and
 * gated integrated loudness per BS.1770-4 (absolute gate −70 LUFS, then a
 * relative gate 10 LU below the ungated mean).
 */
class LoudnessMeter {
  constructor(sampleRate, channels) {
    this.fs = sampleRate;
    this.ch = channels;
    this.shelf = [];
    this.rlb = [];
    for (let c = 0; c < channels; c++) {
      this.shelf.push(shelfFilter(sampleRate));
      this.rlb.push(rlbFilter(sampleRate));
    }
    // Loudness is computed on 100 ms blocks; momentary = 4 blocks,
    // short-term = 30 blocks, all overlapping by sliding the ring.
    this.blockLen = Math.round(sampleRate * 0.1);
    this.blockPos = 0;
    this.blockSum = new Float64Array(channels);
    this.powers = [];      // mean square per 100 ms block, summed over channels
    this.reset();
  }

  reset() {
    this.blockPos = 0;
    this.blockSum.fill(0);
    this.powers.length = 0;
    this.shelf.forEach((f) => f.reset());
    this.rlb.forEach((f) => f.reset());
    this.momentary = -Infinity;
    this.shortTerm = -Infinity;
    this.integrated = -Infinity;
  }

  /** @param {Float32Array[]} chans  one array per channel, equal length */
  push(chans) {
    const n = chans[0].length;
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.ch; c++) {
        const y = this.rlb[c].process(this.shelf[c].process(chans[c][i]));
        this.blockSum[c] += y * y;
      }
      if (++this.blockPos >= this.blockLen) {
        // Channel weights: L and R are 1.0 (surround channels would be 1.41).
        let z = 0;
        for (let c = 0; c < this.ch; c++) {
          z += this.blockSum[c] / this.blockLen;
          this.blockSum[c] = 0;
        }
        this.powers.push(z);
        this.blockPos = 0;
        this._recompute();
      }
    }
  }

  _meanOfLast(count) {
    const p = this.powers;
    if (p.length === 0) return -Infinity;
    const start = Math.max(0, p.length - count);
    let s = 0;
    for (let i = start; i < p.length; i++) s += p[i];
    const mean = s / (p.length - start);
    return mean > 0 ? -0.691 + 10 * Math.log10(mean) : -Infinity;
  }

  _recompute() {
    this.momentary = this._meanOfLast(4);    // 400 ms
    this.shortTerm = this._meanOfLast(30);   // 3 s

    // Gated integrated loudness.
    const p = this.powers;
    let sum = 0, n = 0;
    for (let i = 0; i < p.length; i++) {
      const l = p[i] > 0 ? -0.691 + 10 * Math.log10(p[i]) : -Infinity;
      if (l > -70) { sum += p[i]; n++; }          // absolute gate
    }
    if (n === 0) { this.integrated = -Infinity; return; }
    const ungated = -0.691 + 10 * Math.log10(sum / n);
    const relGate = ungated - 10;                 // relative gate
    let sum2 = 0, n2 = 0;
    for (let i = 0; i < p.length; i++) {
      const l = p[i] > 0 ? -0.691 + 10 * Math.log10(p[i]) : -Infinity;
      if (l > -70 && l > relGate) { sum2 += p[i]; n2++; }
    }
    this.integrated = n2 > 0 ? -0.691 + 10 * Math.log10(sum2 / n2) : -Infinity;
  }
}

/**
 * True-peak estimate by 4x oversampling. A sample-peak meter misses
 * inter-sample overs entirely, which is exactly what trips a lossy encoder
 * after upload — so this matters more than sample peak here.
 * Linear-phase 4-tap-per-phase polyphase interpolation is enough for a
 * display meter; it reads within a few tenths of a dB of a full
 * BS.1770 Annex 2 implementation.
 */
function truePeakOf(buf, prevTail) {
  let peak = 0;
  const n = buf.length;
  const tail = prevTail || [0, 0, 0];
  const at = (i) => (i < 0 ? tail[tail.length + i] : buf[i]);
  for (let i = 0; i < n; i++) {
    const x0 = at(i - 3), x1 = at(i - 2), x2 = at(i - 1), x3 = buf[i];
    const a0 = Math.abs(x3);
    if (a0 > peak) peak = a0;
    // Catmull-Rom through the four points, sampled at the 1/4 positions.
    for (let k = 1; k < 4; k++) {
      const t = k / 4;
      const v = 0.5 * (
        (2 * x1) +
        (-x0 + x2) * t +
        (2 * x0 - 5 * x1 + 4 * x2 - x3) * t * t +
        (-x0 + 3 * x1 - 3 * x2 + x3) * t * t * t
      );
      const a = Math.abs(v);
      if (a > peak) peak = a;
    }
  }
  return peak;
}

/* ==========================================================================
   4. Drawing
   ========================================================================== */

/** Size a canvas for the device pixel ratio; returns the 2D context. */
/* A canvas inside a collapsed card measures 0 wide. Gradient radii here are
 * derived from that width, and createRadialGradient throws on a negative
 * radius — so a hidden card would otherwise fill the console with exceptions
 * on every animation frame. Callers check this and skip the frame. */
function hasArea(cssW, cssH) {
  return Number.isFinite(cssW) && Number.isFinite(cssH) && cssW > 1 && cssH > 1;
}

function fitCanvas(cv, cssW, cssH) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(cssW * dpr));
  const h = Math.max(1, Math.round(cssH * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  cv.style.height = cssH + 'px';
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

/* ---- the VU dial ------------------------------------------------------- */

/* Scale marks as they appear on a real VU face: the upper row is VU,
   the lower row percentage of modulation. */
const VU_MARKS = [
  { vu: -20, label: '-20' },
  { vu: -15, label: null  },
  { vu: -10, label: '-10' },
  { vu:  -7, label: '-7'  },
  { vu:  -5, label: '-5'  },
  { vu:  -3, label: '-3'  },
  { vu:  -2, label: null  },
  { vu:  -1, label: null  },
  { vu:   0, label: '0'   },
  { vu:  +1, label: null  },
  { vu:  +2, label: null  },
  { vu:  +3, label: '+3'  },
];

const VU_MIN = -20, VU_MAX = 3;
/* A real movement sweeps about 90°, centred on vertical: -20 VU points up-left
   at 225°, +3 VU up-right at 315°. The pivot sits below the visible face so
   only the top of that arc shows, which is what gives a VU its shallow curve. */
const ARC_START = -Math.PI * 0.695;  // -20 VU, up and to the left
const ARC_END   = -Math.PI * 0.305;  // +3 VU, up and to the right

/** Map a VU value to a needle angle. Non-linear, as on a real dial: the
 *  top of the scale is compressed so -20..-7 gets less arc than -3..+3. */
function vuToAngle(vu) {
  const v = clamp(vu, VU_MIN, VU_MAX);
  // normalised with a mild expansion toward the top of the scale
  const t = (v - VU_MIN) / (VU_MAX - VU_MIN);
  // Mild expansion only: the real face gives -20..-7 slightly less arc than
  // the -3..+3 region, but nothing like a power curve.
  const shaped = t * 0.86 + t * t * 0.14;
  return lerp(ARC_START, ARC_END, shaped);
}

function drawVu(cv, label, needleVu, peakLit, w) {
  const h = Math.round(w * 0.52);
  if (!hasArea(w, h)) return;
  const ctx = fitCanvas(cv, w, h);
  ctx.clearRect(0, 0, w, h);

  const cx = w / 2;
  const cy = h * 1.27;            // pivot below the visible face
  const R = h * 1.10;             // radius out to the scale arc

  /* --- dial card: warm cream, hotter where the lamp sits behind it --- */
  const card = ctx.createRadialGradient(cx, h * 0.62, w * 0.04, cx, h * 0.55, w * 0.72);
  card.addColorStop(0, '#f6e8c6');
  card.addColorStop(0.42, '#e8d5a8');
  card.addColorStop(1, '#c9b183');
  ctx.fillStyle = card;
  ctx.fillRect(0, 0, w, h);

  /* vignette at the corners — the lamp does not reach them */
  const vig = ctx.createRadialGradient(cx, h * 0.6, w * 0.22, cx, h * 0.6, w * 0.62);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(60,44,18,0.30)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, w, h);

  /* --- the red zone above 0 VU, an arc band --- */
  ctx.save();
  ctx.lineWidth = h * 0.055;
  ctx.strokeStyle = '#c4291f';
  ctx.beginPath();
  ctx.arc(cx, cy, R, vuToAngle(0), vuToAngle(VU_MAX));
  ctx.stroke();
  ctx.restore();

  /* --- the black arc below 0 --- */
  ctx.save();
  ctx.lineWidth = h * 0.012;
  ctx.strokeStyle = '#1a1712';
  ctx.beginPath();
  ctx.arc(cx, cy, R, vuToAngle(VU_MIN), vuToAngle(0));
  ctx.stroke();
  ctx.restore();

  /* --- ticks and numerals --- */
  const fs = Math.max(7, Math.round(h * 0.066));
  ctx.font = `500 ${fs}px "Spline Sans Mono", Menlo, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const m of VU_MARKS) {
    const ang = vuToAngle(m.vu);
    const over = m.vu > 0;
    const long = m.label !== null;
    const r1 = R - (long ? h * 0.085 : h * 0.050);
    const r2 = R - h * 0.008;
    ctx.beginPath();
    ctx.lineWidth = long ? h * 0.016 : h * 0.010;
    ctx.strokeStyle = over ? '#c4291f' : '#1a1712';
    ctx.moveTo(cx + Math.cos(ang) * r1, cy + Math.sin(ang) * r1);
    ctx.lineTo(cx + Math.cos(ang) * r2, cy + Math.sin(ang) * r2);
    ctx.stroke();

    if (m.label) {
      const rt = R - h * 0.165;
      ctx.fillStyle = over ? '#c4291f' : '#1a1712';
      ctx.fillText(m.label.replace('-', '−'),
        cx + Math.cos(ang) * rt, cy + Math.sin(ang) * rt);
    }
  }

  /* "VU" engraved under the arc, and the channel name */
  // channel name sits low left, out of the needle's arc
  ctx.fillStyle = '#1a1712';
  ctx.font = `400 ${Math.round(h * 0.135)}px "Bebas Neue", "Arial Narrow", sans-serif`;
  ctx.save();
  ctx.textAlign = 'left';
  ctx.letterSpacing = '0.24em';
  ctx.fillText(label, h * 0.12, h * 0.92);
  const labelW = ctx.measureText(label).width;
  ctx.fillStyle = '#6b6049';
  ctx.font = `400 ${Math.round(h * 0.10)}px "Bebas Neue", "Arial Narrow", sans-serif`;
  ctx.fillText('VU', h * 0.12 + labelW + h * 0.10, h * 0.92);
  ctx.restore();

  /* small maker's mark, bottom right — the kind of detail a real face has */
  ctx.fillStyle = 'rgba(91,81,63,0.55)';
  ctx.font = `400 ${Math.max(6, Math.round(h * 0.055))}px "Spline Sans Mono", monospace`;
  ctx.textAlign = 'right';
  ctx.fillText('300 ms', w - h * 0.10, h * 0.90);
  ctx.textAlign = 'center';

  /* --- the needle, with its shadow on the dial --- */
  const ang = vuToAngle(needleVu);
  const tipR = R - h * 0.035;
  const tip = { x: cx + Math.cos(ang) * tipR, y: cy + Math.sin(ang) * tipR };
  const hubR = h * 0.075;

  // shadow: offset down-right, blurred, the needle floating just off the face
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h * 0.80);
  ctx.clip();
  ctx.globalAlpha = 0.22;
  ctx.strokeStyle = '#4a3a1c';
  ctx.lineWidth = h * 0.024;
  ctx.lineCap = 'round';
  ctx.filter = 'blur(2px)';
  ctx.beginPath();
  ctx.moveTo(cx + h * 0.018, cy + h * 0.02);
  ctx.lineTo(tip.x + h * 0.022, tip.y + h * 0.026);
  ctx.stroke();
  ctx.restore();

  // the needle itself: tapers from hub to tip.
  // A real dial card covers the lower part of the pointer's travel, so the
  // needle is clipped to the area above the channel label rather than being
  // allowed to run out of the bottom of the face.
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, w, h * 0.80);
  ctx.clip();
  ctx.strokeStyle = '#141210';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.lineWidth = h * 0.020;
  ctx.moveTo(cx + Math.cos(ang) * hubR * 0.5, cy + Math.sin(ang) * hubR * 0.5);
  ctx.lineTo(lerp(cx, tip.x, 0.55), lerp(cy, tip.y, 0.55));
  ctx.stroke();
  ctx.beginPath();
  ctx.lineWidth = h * 0.012;
  ctx.moveTo(lerp(cx, tip.x, 0.55), lerp(cy, tip.y, 0.55));
  ctx.lineTo(tip.x, tip.y);
  ctx.stroke();
  ctx.restore();

  /* The needle disappears under the lower dial card, as on a real movement;
     no pivot boss is visible because the pivot is behind the card. */

  /* --- the peak lamp bleeding onto the top right of the dial --- */
  if (peakLit) {
    const g = ctx.createRadialGradient(w * 0.86, h * 0.16, 0, w * 0.86, h * 0.16, w * 0.3);
    g.addColorStop(0, 'rgba(255,74,53,0.32)');
    g.addColorStop(1, 'rgba(255,74,53,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, w, h);
  }
}

/* ---- dBFS peak bars ---------------------------------------------------- */

const BAR_MIN_DB = -60;
const BAR_TICKS = [0, -3, -6, -12, -18, -24, -36, -48, -60];

function dbToX(db, w, pad) {
  const t = (clamp(db, BAR_MIN_DB, 6) - BAR_MIN_DB) / (6 - BAR_MIN_DB);
  return pad + t * (w - pad * 2);
}

function drawBars(cv, chans, w) {
  const rows = chans.length;
  const rowH = 26;
  const h = rows * rowH + 22;
  if (!hasArea(w, h)) return;
  const ctx = fitCanvas(cv, w, h);
  const pad = 26;
  ctx.clearRect(0, 0, w, h);

  const zeroX = dbToX(0, w, pad);

  /* scale ticks along the bottom */
  ctx.font = '500 9px "Spline Sans Mono", Menlo, monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  for (const t of BAR_TICKS) {
    const x = dbToX(t, w, pad);
    ctx.fillStyle = t === 0 ? '#c4291f' : '#4e5049';
    ctx.fillRect(x, rows * rowH - 2, 1, 4);
    ctx.fillStyle = t === 0 ? '#c4291f' : '#6e7067';
    ctx.fillText(t === 0 ? '0' : String(t).replace('-', '−'), x, rows * rowH + 4);
  }

  chans.forEach((c, i) => {
    const y = i * rowH + 2;
    const bh = 13;

    /* well */
    ctx.fillStyle = '#0a0b09';
    ctx.fillRect(pad, y, w - pad * 2, bh);

    /* the over-0 zone tinted into the well itself */
    ctx.fillStyle = 'rgba(196,41,31,0.16)';
    ctx.fillRect(zeroX, y, w - pad - zeroX, bh);

    /* the bar: a warm gradient that turns red past 0 */
    const x = dbToX(c.db, w, pad);
    if (x > pad) {
      const g = ctx.createLinearGradient(pad, 0, w - pad, 0);
      g.addColorStop(0, '#6f8f5f');
      g.addColorStop(0.62, '#c8a24a');
      g.addColorStop(1, '#c4291f');
      ctx.fillStyle = g;
      ctx.fillRect(pad, y, x - pad, bh);
    }

    /* peak-hold tick */
    if (c.hold > BAR_MIN_DB) {
      const hx = dbToX(c.hold, w, pad);
      ctx.fillStyle = c.hold >= 0 ? '#ff4a35' : '#f2e2bc';
      ctx.fillRect(hx - 1, y - 1, 2, bh + 2);
    }

    /* channel letter and the numeric read */
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = '400 11px "Bebas Neue", "Arial Narrow", sans-serif';
    ctx.fillStyle = '#8b8d83';
    ctx.fillText(c.name, 2, y + bh / 2);

    ctx.textAlign = 'right';
    ctx.font = '500 10px "Spline Sans Mono", Menlo, monospace';
    ctx.fillStyle = c.hold >= -0.1 ? '#ff4a35' : '#9a9c92';
    ctx.fillText(fmtLu(c.hold, 1), w - 2, y + bh / 2);
    ctx.textAlign = 'center';
  });
}

/* ---- correlation ------------------------------------------------------- */

function drawCorrelation(cv, value, w) {
  const h = 54;
  if (!hasArea(w, h)) return;
  const ctx = fitCanvas(cv, w, h);
  ctx.clearRect(0, 0, w, h);
  const pad = 10;
  const barY = 16, barH = 14;
  const innerW = w - pad * 2;

  ctx.fillStyle = '#0a0b09';
  ctx.fillRect(pad, barY, innerW, barH);

  /* out-of-phase half tinted: it is the half that means trouble in mono */
  ctx.fillStyle = 'rgba(196,41,31,0.15)';
  ctx.fillRect(pad, barY, innerW / 2, barH);

  /* centre line at 0 */
  ctx.fillStyle = '#4e5049';
  ctx.fillRect(pad + innerW / 2, barY - 3, 1, barH + 6);

  /* the pointer */
  const t = (clamp(value, -1, 1) + 1) / 2;
  const x = pad + t * innerW;
  ctx.fillStyle = value < -0.1 ? '#cf5340' : value < 0.3 ? '#d9a441' : '#6f9f72';
  ctx.fillRect(x - 2, barY - 3, 4, barH + 6);

  ctx.font = '500 9px "Spline Sans Mono", Menlo, monospace';
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#6e7067';
  ctx.textAlign = 'left';   ctx.fillText('−1', pad, barY + barH + 5);
  ctx.textAlign = 'center'; ctx.fillText('0', pad + innerW / 2, barY + barH + 5);
  ctx.textAlign = 'right';  ctx.fillText('+1', w - pad, barY + barH + 5);

  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.font = '500 13px "Spline Sans Mono", Menlo, monospace';
  ctx.fillStyle = '#ffb454';
  ctx.fillText((value >= 0 ? '+' : '−') + Math.abs(value).toFixed(2),
    pad + innerW / 2, barY - 6);
}

/* ---- spectrum + spectrogram -------------------------------------------- */

const FMIN = 20, FMAX = 22050;
const SPEC_LABELS = [50, 100, 500, 1000, 5000, 10000, 16000, 20000];

/** Log-frequency x position, 0..1. */
function fToT(f) {
  return (Math.log10(clamp(f, FMIN, FMAX)) - Math.log10(FMIN)) /
         (Math.log10(FMAX) - Math.log10(FMIN));
}

function fmtHz(f) {
  return f >= 1000 ? (f / 1000) + 'k' : String(f);
}

/**
 * Spectrum curve. `bins` is byte-valued FFT data; nyquist maps bin i to
 * frequency i * nyquist / bins.length.
 */
function drawSpectrum(cv, bins, nyquist, cutoffHz, w) {
  const h = 128;
  if (!hasArea(w, h)) return;
  const ctx = fitCanvas(cv, w, h);
  ctx.clearRect(0, 0, w, h);
  const padB = 15;
  const plotH = h - padB;

  /* grid + frequency labels */
  ctx.font = '500 9px "Spline Sans Mono", Menlo, monospace';
  ctx.textBaseline = 'top';
  ctx.textAlign = 'center';
  for (const f of SPEC_LABELS) {
    const x = fToT(f) * w;
    const is16k = f === 16000;
    ctx.fillStyle = is16k ? 'rgba(217,164,65,0.35)' : 'rgba(78,80,73,0.35)';
    ctx.fillRect(x, 0, 1, plotH);
    ctx.fillStyle = is16k ? '#d9a441' : '#6e7067';
    ctx.fillText(fmtHz(f), clamp(x, 12, w - 12), plotH + 3);
  }

  /* dB grid lines every 20 dB */
  for (let d = -20; d >= -80; d -= 20) {
    const y = (-d / 90) * plotH;
    ctx.fillStyle = 'rgba(78,80,73,0.22)';
    ctx.fillRect(0, y, w, 1);
  }

  if (!bins || !bins.length) return;

  /* Build the curve by taking the max within each x column, so a narrow
     peak is never lost between pixels at the top of a log axis. */
  const col = new Float32Array(Math.ceil(w));
  col.fill(-Infinity);
  for (let i = 1; i < bins.length; i++) {
    const f = i * nyquist / bins.length;
    if (f < FMIN) continue;
    const x = Math.floor(fToT(f) * (w - 1));
    const v = bins[i];
    if (v > col[x]) col[x] = v;
  }
  // fill gaps left by sparse low-frequency bins
  let last = -Infinity;
  for (let x = 0; x < col.length; x++) {
    if (col[x] === -Infinity) col[x] = last; else last = col[x];
  }

  const yOf = (byteVal) => {
    // byte 0..255 maps to minDecibels..maxDecibels (-90..0 by our setting)
    const db = -90 + (byteVal / 255) * 90;
    return plotH - (clamp(db, -90, 0) + 90) / 90 * plotH;
  };

  /* area fill under the curve, warm and low-contrast */
  ctx.beginPath();
  ctx.moveTo(0, plotH);
  for (let x = 0; x < col.length; x++) {
    if (col[x] === -Infinity) continue;
    ctx.lineTo(x, yOf(col[x]));
  }
  ctx.lineTo(col.length - 1, plotH);
  ctx.closePath();
  const fill = ctx.createLinearGradient(0, 0, 0, plotH);
  fill.addColorStop(0, 'rgba(255,180,84,0.34)');
  fill.addColorStop(1, 'rgba(255,180,84,0.03)');
  ctx.fillStyle = fill;
  ctx.fill();

  /* the curve */
  ctx.beginPath();
  let started = false;
  for (let x = 0; x < col.length; x++) {
    if (col[x] === -Infinity) continue;
    const y = yOf(col[x]);
    if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
  }
  ctx.strokeStyle = '#ffcf8a';
  ctx.lineWidth = 1.2;
  ctx.stroke();

  /* codec brick wall, if one was detected */
  if (cutoffHz && cutoffHz > 1000 && cutoffHz < FMAX) {
    const x = fToT(cutoffHz) * w;
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.strokeStyle = '#cf5340';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, plotH);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#cf5340';
    ctx.textAlign = x > w * 0.7 ? 'right' : 'left';
    ctx.fillText('cutoff ' + Math.round(cutoffHz / 100) / 10 + 'k',
      x + (x > w * 0.7 ? -4 : 4), 3);
  }
}

/** Scrolling spectrogram. Keeps its own offscreen buffer and blits. */
class Spectrogram {
  constructor(canvas) {
    this.cv = canvas;
    this.buf = document.createElement('canvas');
    this.buf.width = 600;
    this.buf.height = 160;
    this.bctx = this.buf.getContext('2d');
    this.bctx.fillStyle = '#000004';
    this.bctx.fillRect(0, 0, this.buf.width, this.buf.height);
    this.col = this.bctx.createImageData(1, this.buf.height);
    this.x = 0;
    this.wrapped = false;
  }

  clear() {
    this.bctx.fillStyle = '#000004';
    this.bctx.fillRect(0, 0, this.buf.width, this.buf.height);
    this.x = 0;
    this.wrapped = false;
  }

  /** Push one column from byte FFT data. */
  push(bins, nyquist) {
    const H = this.buf.height;
    const d = this.col.data;
    for (let y = 0; y < H; y++) {
      // y=0 is the top = high frequency; map through the log axis
      const t = 1 - y / (H - 1);
      const f = Math.pow(10, lerp(Math.log10(FMIN), Math.log10(FMAX), t));
      const bin = Math.round(f / nyquist * bins.length);
      const v = bins[clamp(bin, 0, bins.length - 1)] / 255;
      const [r, g, b] = inferno(Math.pow(v, 1.15));
      const o = y * 4;
      d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
    }
    this.bctx.putImageData(this.col, this.x, 0);
    this.x = (this.x + 1) % this.buf.width;
    if (this.x === 0) this.wrapped = true;
  }

  /** Draw a whole precomputed spectrogram (flat array + shape). */
  /**
   * Draw a whole precomputed spectrogram.
   * `layout` is 'freq-major' when the flat array is db[f * frames + t]
   * (analyze.py's order) and 'time-major' when it is db[t * bins + f].
   */
  drawStatic(flat, shape, hzPerBin, layout, freqs) {
    const freqMajor = layout !== 'time-major';
    // freq-major shape is [bins, frames]; time-major is [frames, bins]
    const binsPer = freqMajor ? shape[0] : shape[1];
    const frames  = freqMajor ? shape[1] : shape[0];
    const at = freqMajor
      ? (t, f) => flat[f * frames + t]
      : (t, f) => flat[t * binsPer + f];
    const W = this.buf.width, H = this.buf.height;
    const img = this.bctx.createImageData(W, H);
    const d = img.data;
    const nyq = (freqs && freqs.length) ? freqs[freqs.length - 1]
      : (hzPerBin ? hzPerBin * binsPer : FMAX);
    // Normalise: the analyser may emit dB or magnitudes.
    // Percentile normalisation. Using the absolute min and max lets one loud
    // bin flatten the whole map into the top of the colour ramp; the 2nd and
    // 98th percentiles keep the useful range spread across the scale.
    const finite = [];
    for (let i = 0; i < flat.length; i++) {
      if (isFinite(flat[i])) finite.push(flat[i]);
    }
    finite.sort((a, b) => a - b);
    let hi = finite.length ? finite[Math.floor(finite.length * 0.995)] : 1;
    let lo = finite.length ? finite[Math.floor(finite.length * 0.02)] : 0;
    // Show about 70 dB below the top, the range a real spectrogram displays.
    // Without this clamp a steep low-frequency tilt stretches the window over
    // a hundred-plus dB and everything audible collapses into one colour.
    if (hi - lo > 70) lo = hi - 70;
    if (!(hi > lo)) { lo = 0; hi = 1; }
    // When analyze.py supplies the real centre frequencies, map through them
    // rather than assuming linear bin spacing.
    const binForHz = (hz) => {
      if (freqs && freqs.length === binsPer) {
        let loI = 0, hiI = binsPer - 1;
        while (loI < hiI) {
          const mid = (loI + hiI) >> 1;
          if (freqs[mid] < hz) loI = mid + 1; else hiI = mid;
        }
        return loI;
      }
      return clamp(Math.round(hz / nyq * binsPer), 0, binsPer - 1);
    };
    for (let x = 0; x < W; x++) {
      const fr = Math.min(frames - 1, Math.floor(x / W * frames));
      for (let y = 0; y < H; y++) {
        const t = 1 - y / (H - 1);
        const f = Math.pow(10, lerp(Math.log10(FMIN), Math.log10(nyq), t));
        const bin = binForHz(f);
        const v = (at(fr, bin) - lo) / (hi - lo);
        const [r, g, b] = inferno(Math.pow(clamp(v, 0, 1), 1.45));
        const o = (y * W + x) * 4;
        d[o] = r; d[o + 1] = g; d[o + 2] = b; d[o + 3] = 255;
      }
    }
    this.bctx.putImageData(img, 0, 0);
    this.x = 0;
    this.wrapped = true;
    this.staticMode = true;
  }

  render(w, cutoffHz, playhead) {
    const h = 150;
    if (!hasArea(w, h)) return;
    const ctx = fitCanvas(this.cv, w, h);
    ctx.imageSmoothingEnabled = false;
    const B = this.buf;
    if (this.staticMode) {
      ctx.drawImage(B, 0, 0, B.width, B.height, 0, 0, w, h);
    } else if (this.wrapped) {
      // oldest part is to the right of the write head
      const rightW = B.width - this.x;
      const split = rightW / B.width * w;
      ctx.drawImage(B, this.x, 0, rightW, B.height, 0, 0, split, h);
      ctx.drawImage(B, 0, 0, this.x, B.height, split, 0, w - split, h);
    } else {
      const shown = this.x;
      if (shown > 0) {
        ctx.drawImage(B, 0, 0, shown, B.height,
          w - shown / B.width * w, 0, shown / B.width * w, h);
      }
    }

    /* frequency guides drawn over the map */
    ctx.font = '500 9px "Spline Sans Mono", Menlo, monospace';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'right';
    for (const f of [100, 1000, 16000]) {
      const t = fToT(f);
      const y = (1 - t) * h;
      const is16k = f === 16000;
      ctx.fillStyle = is16k ? 'rgba(217,164,65,0.75)' : 'rgba(255,255,255,0.20)';
      ctx.fillRect(0, y, w, is16k ? 1 : 1);
      ctx.fillStyle = is16k ? '#d9a441' : 'rgba(255,255,255,0.45)';
      ctx.fillText(fmtHz(f), w - 4, clamp(y - 6, 7, h - 7));
    }

    /* the detected brick wall */
    if (cutoffHz && cutoffHz > 1000) {
      const y = (1 - fToT(cutoffHz)) * h;
      ctx.save();
      ctx.setLineDash([4, 3]);
      ctx.strokeStyle = '#ff6a50';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
      ctx.restore();
    }

    /* playhead, when showing a precomputed map */
    if (this.staticMode && playhead != null && playhead >= 0) {
      ctx.fillStyle = 'rgba(255,255,255,0.8)';
      ctx.fillRect(playhead * w, 0, 1, h);
    }
  }
}

/* ==========================================================================
   5. Audio engine
   ========================================================================== */

/* Which bands actually do something.
 *
 * Gain is the wrong test on its own: a lowpass, highpass or notch is defined by
 * its corner frequency and does its work at gain 0, so filtering on `b.gain`
 * silently dropped them — the panel would show a lowpass while the audio had
 * none. Only the gain-bearing types (peaking and the shelves) are inert at 0. */
function activeEqBands(bands) {
  const SHAPES_WITHOUT_GAIN = new Set(['highpass', 'lowpass', 'notch', 'bandpass', 'allpass']);
  return (bands || []).filter(
    b => b && b.type && (SHAPES_WITHOUT_GAIN.has(b.type) || Math.abs(b.gain || 0) > 0.01));
}

/* The limiter's named times, in ms. These are maximize.py's LIMIT_ATTACK and
 * LIMIT_RELEASE: the browser limiter must respond the way the render will, so
 * the numbers are copied rather than invented. `auto` has no browser
 * equivalent — alimiter's `asc` adapts to the material — so it previews at a
 * middling 100 ms, which rackApprox() does not flag because the audible
 * difference is small and naming it would bury the two that matter. */
const RACK_LIMIT_ATTACK = { fast: 0.5, mid: 4.0, slow: 20.0 };
const RACK_LIMIT_RELEASE = { fast: 30.0, slow: 300.0, auto: 100.0 };

/* A hard ceiling as a WaveShaper curve: linear up to the limit, flat above.
 *
 * This is the backstop behind the browser limiter's compressor, which
 * overshoots its own threshold by more the harder it is driven (measured:
 * +1.195 dBFS on a -1.0 dBFS threshold at 12 dB of drive). Sampled at an odd
 * length so there is a sample exactly at zero and silence maps to silence. */
function hardCeilingCurve(ceilingDb) {
  const N = 8193;
  const curve = new Float32Array(N);
  const lin = Math.pow(10, clamp(ceilingDb, -60, 0) / 20);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = Math.sign(x) * Math.min(Math.abs(x), lin);
  }
  return curve;
}

/* A transfer curve for the WaveShaper, matching ffmpeg's `asoftclip` types.
 *
 * Below the threshold the curve is linear — the signal passes untouched — and
 * above it the named function rounds the peak instead of the hard corner that
 * clipping would put there. `amount` scales how hard the rounding bites.
 *
 * Sampled over [-1, 1]; an odd length guarantees a sample exactly at zero, so
 * silence maps to silence rather than to a DC offset. */
function softClipCurve(kind, amount, threshold) {
  const N = 8193;
  const curve = new Float32Array(N);
  const t = clamp(threshold == null ? 0.95 : threshold, 0.05, 1);
  const a = clamp(amount == null ? 1 : amount, 0.01, 3);

  const shape = (x) => {
    // x is the amount by which the signal exceeds the threshold, normalised
    // so that 1 is "one full threshold's worth over". The functions all map
    // [0, inf) into [0, 1) so the result can never exceed full scale.
    switch (kind) {
      case 'tanh': return Math.tanh(x * a);
      case 'atan': return Math.atan(x * a) / (Math.PI / 2);
      case 'cubic': { const u = Math.min(x * a, 1); return u - (u * u * u) / 3; }
      case 'exp': return 1 - Math.exp(-x * a);
      case 'alg': return (x * a) / Math.sqrt(1 + (x * a) * (x * a));
      case 'quintic': { const u = Math.min(x * a, 1); return u - (u ** 5) / 5; }
      case 'sin': return Math.sin(Math.min(x * a, 1) * (Math.PI / 2));
      case 'erf': return Math.tanh(x * a * 1.2);     // close enough by eye
      case 'hard': default: return Math.min(x * a, 1);
    }
  };

  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    const mag = Math.abs(x);
    let y;
    if (mag <= t) {
      y = mag;
    } else {
      // Round only the part above the threshold, and scale what remains into
      // the headroom left between the threshold and full scale.
      y = t + (1 - t) * shape((mag - t) / (1 - t));
    }
    curve[i] = Math.sign(x) * Math.min(y, 1);
  }
  return curve;
}

class Engine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.analyser = null;
    this.splitter = null;
    this.playing = false;
    this.startedAt = 0;
    this.offset = 0;
    this.sampleRate = 48000;

    this.meters = {
      L: { rms: -Infinity, peak: -Infinity, hold: -Infinity, holdAge: 0, tp: -Infinity },
      R: { rms: -Infinity, peak: -Infinity, hold: -Infinity, holdAge: 0, tp: -Infinity },
    };
    this.correlation = 0;
    this.loudness = null;
    this.overCount = 0;
    this.maxTruePeak = -Infinity;

    /* Auto gain compensation, in dB. Set by the EQ panel, which computes it
       from the same coefficients it draws the curve from. Always ≤ 0: this
       trim only ever takes level away. Monitor only — see buildEq(). */
    this.eqTrimDb = 0;
    this.eqTrim = null;
    this.eqBypassed = false;

    /* The rack: the mastering suite as a patchable block. See buildRack().
     * `rackEnabled` is the patch cable — false means the block is out of the
     * signal path entirely, which is what makes the wiring optional rather
     * than a bypass switch on a device that is always there. */
    this.rackEnabled = false;
    this.rackBypassed = false;
    this.rackNodes = null;
    this.rackInput = null;
    this.rackOutput = null;

    /* The second equaliser, a device of its own. Same patch-cable idea as the
     * rack: unpatched it is absent from the graph rather than bypassed in it. */
    this.eq2Enabled = false;
    this.eq2Bypassed = false;
    this.eq2Nodes = null;
    this.eq2Input = null;
    this.eq2Output = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.sampleRate = this.ctx.sampleRate;
    }
    return this.ctx;
  }

  async decode(arrayBuffer) {
    const ctx = this.ensureContext();
    this.buffer = await ctx.decodeAudioData(arrayBuffer);
    this.sampleRate = this.buffer.sampleRate;
    this.offset = 0;
    this.resetMeters();
    return this.buffer;
  }

  resetMeters() {
    for (const k of ['L', 'R']) {
      Object.assign(this.meters[k],
        { rms: -Infinity, peak: -Infinity, hold: -Infinity, holdAge: 0, tp: -Infinity });
    }
    this.overCount = 0;
    this.maxTruePeak = -Infinity;
    if (this.loudness) this.loudness.reset();
  }

  /**
   * Build the graph. A ScriptProcessorNode does the sample-accurate work
   * (loudness, true peak, correlation); an AnalyserNode feeds the visuals.
   * ScriptProcessor is deprecated but universally available from file://,
   * where an AudioWorklet needs a module URL the browser will refuse to
   * load under the file: scheme in most configurations.
   */
  buildGraph() {
    const ctx = this.ensureContext();
    const buf = this.buffer;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.72;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = 0;

    this.loudness = new LoudnessMeter(buf.sampleRate, Math.min(2, buf.numberOfChannels));

    const proc = ctx.createScriptProcessor(2048, 2, 2);
    this._tails = [[0, 0, 0], [0, 0, 0]];
    proc.onaudioprocess = (e) => this._onAudio(e);
    this.proc = proc;

    const gain = ctx.createGain();
    gain.gain.value = 1;
    this.gain = gain;
    return { analyser: this.analyser, proc, gain };
  }

  _onAudio(e) {
    const inp = e.inputBuffer;
    const nch = inp.numberOfChannels;
    const L = inp.getChannelData(0);
    const R = nch > 1 ? inp.getChannelData(1) : L;

    // Silence the processor's own output; the gain node carries the audio.
    const out = e.outputBuffer;
    for (let c = 0; c < out.numberOfChannels; c++) out.getChannelData(c).fill(0);

    if (!this.playing) return;

    const n = L.length;
    let sumL = 0, sumR = 0, pkL = 0, pkR = 0;
    let sumLR = 0, sumLL = 0, sumRR = 0;

    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      sumL += l * l; sumR += r * r;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
      sumLR += l * r; sumLL += l * l; sumRR += r * r;
    }

    const tpL = truePeakOf(L, this._tails[0]);
    const tpR = truePeakOf(R, this._tails[1]);
    this._tails[0] = [L[n - 3], L[n - 2], L[n - 1]];
    this._tails[1] = [R[n - 3], R[n - 2], R[n - 1]];

    const mL = this.meters.L, mR = this.meters.R;
    mL.rms = dbfs(Math.sqrt(sumL / n));
    mR.rms = dbfs(Math.sqrt(sumR / n));
    mL.peak = dbfs(pkL);
    mR.peak = dbfs(pkR);
    mL.tp = dbfs(tpL);
    mR.tp = dbfs(tpR);

    const tpDb = Math.max(mL.tp, mR.tp);
    if (tpDb > this.maxTruePeak) this.maxTruePeak = tpDb;
    if (pkL >= 0.999 || pkR >= 0.999) this.overCount++;

    // Pearson correlation of L against R over the block.
    const den = Math.sqrt(sumLL * sumRR);
    const corr = den > 1e-9 ? sumLR / den : (nch > 1 ? 0 : 1);
    this.correlation = lerp(this.correlation, corr, 0.25);

    this.loudness.push(nch > 1 ? [L, R] : [L]);
  }

  /* ------------------------------------------------------------------ EQ --
   * A live equaliser, so a knob is something you hear rather than only a
   * number that ends up in a command.
   *
   * BiquadFilterNode implements the same RBJ cookbook filters the response
   * curve is drawn from, so the curve and the sound agree by construction
   * rather than by two implementations happening to match. The band list is
   * whatever the Equalizer panel last published; an empty list is a
   * passthrough, which is also the state before anything is dialled.
   */
  buildEq(ctx) {
    const bands = (window.StudioEq && window.StudioEq.bands) || [];
    const active = activeEqBands(bands);

    /* The trim node: auto gain compensation, and the reason a boost here does
     * not clip.
     *
     * Nothing follows the EQ but ctx.destination — no limiter, and the gain
     * stage before it is fixed at 1.0 — so whatever the filters add lands
     * straight on the browser's output. On a −1 dBFS master, where real
     * masters sit, a +12 dB shelf reaches +4 dBFS and is hard-clipped, and
     * the user hears distortion the monitor path invented. This node carries
     * the inverse of the chain's maximum boost, so the loudest point of the
     * equalised signal sits no higher than the bypassed signal does.
     *
     * It sits BEFORE the filters rather than after: attenuating first keeps
     * the biquads' own internal state away from the region where a resonant
     * boost would overflow, and means the meters downstream read the signal
     * that is actually audible.
     *
     * The number comes from the panel (StudioEq.trimForBands, swept over the
     * same RBJ coefficients the curve is drawn from). This file only holds
     * the node and ramps it.
     *
     * MONITOR ONLY. The trim compensates for the browser having no output
     * ceiling. It is not part of the EQ and must never appear in the emitted
     * ffmpeg chain: master.py applies its own true-peak ceiling after the EQ,
     * so a trim added there would attenuate a second time and deliver a file
     * quieter than asked for. The panel's buildChain() knows nothing about
     * this node, which is the correct arrangement. */
    const trim = ctx.createGain();
    trim.gain.value = this._eqTrimLinear();
    this.eqTrim = trim;

    this.eqNodes = [];
    if (!active.length || this.eqBypassed) {
      /* Nothing to filter. The trim node still stands in for the chain so the
         caller always has an input and an output to wire — and with no bands
         the trim it carries is 0 dB (unity), so this is a passthrough. Under
         bypass the trim is forced to unity below: a bypass that also removed
         a level change would be a level-matched comparison pretending to be
         an A/B of the filters. */
      this.eqInput = this.eqOutput = trim;
      return { input: trim, output: trim };
    }

    let head = null, tail = null;
    for (const b of active) {
      const node = ctx.createBiquadFilter();
      node.type = b.type;
      node.frequency.value = b.freq;
      if (b.type !== 'highpass' && b.type !== 'lowpass') node.gain.value = b.gain;
      node.Q.value = b.q || 0.707;
      if (tail) tail.connect(node); else head = node;
      tail = node;
      this.eqNodes.push({ node, band: b });
    }
    /* trim → filters. The caller wires into the trim, so the attenuation is
       applied before anything can boost. */
    trim.connect(head);
    this.eqInput = trim;
    this.eqOutput = tail;
    return { input: trim, output: tail };
  }

  /** The trim as a linear gain, or unity when it should not apply.
   *
   * Bypass forces unity: bypass exists so the ear can compare the EQ against
   * the untouched source, and a bypass that quietly kept an attenuation would
   * be a level-matched comparison wearing an A/B's clothes. */
  _eqTrimLinear() {
    if (this.eqBypassed) return 1;
    const db = Number(this.eqTrimDb);
    if (!isFinite(db) || db >= 0) return 1;      // only ever attenuates
    return Math.pow(10, db / 20);
  }

  /**
   * Set the auto gain compensation trim, in dB. Negative attenuates; 0 or
   * positive is unity, because this control only ever takes level away.
   *
   * Ramped with setTargetAtTime, exactly as the band updates are, so a fader
   * being moved changes the trim continuously instead of stepping it — a
   * stepped gain on a signal that is already playing is an audible click, and
   * the trim moves on every single frame of a drag.
   *
   * @param {number} db
   */
  setEqTrim(db) {
    const v = Number(db);
    this.eqTrimDb = isFinite(v) ? Math.min(0, v) : 0;
    const node = this.eqTrim;
    if (!node || !this.ctx) return;
    try {
      node.gain.setTargetAtTime(this._eqTrimLinear(), this.ctx.currentTime, 0.01);
    } catch (_) { /* node detached between frames */ }
  }

  /* Apply a changed band list without interrupting playback.
   *
   * Rebuilding the graph would mean stopping and restarting the source, which
   * costs the playhead and makes an A/B impossible. When the shape of the
   * chain is unchanged we only retune the existing nodes, ramping rather than
   * stepping so a turned knob does not click. */
  updateEq(bands) {
    const ctx = this.ctx;
    if (!ctx || !this.eqNodes) return false;

    const active = activeEqBands(bands);
    if (active.length !== this.eqNodes.length) return false;   // needs a rebuild

    const t = ctx.currentTime;
    for (let i = 0; i < active.length; i++) {
      const { node } = this.eqNodes[i];
      const b = active[i];
      if (node.type !== b.type) return false;                  // needs a rebuild
      node.frequency.setTargetAtTime(b.freq, t, 0.01);
      node.Q.setTargetAtTime(b.q || 0.707, t, 0.01);
      if (node.gain) node.gain.setTargetAtTime(b.gain, t, 0.01);
      this.eqNodes[i].band = b;
    }
    return true;
  }

  /* Rebuild the EQ when its shape changed — a band switched on or off, so the
     node count no longer matches. Playback is restarted at the current
     position rather than from the top, so the change is still an A/B. */
  rebuildEq() {
    if (!this.playing) return;
    const at = this.currentTime();
    this.pause();
    this.offset = at;
    this.play();
  }

  /* -------------------------------------------------------------- EQ TWO --
   * A second equaliser, cascading after the first, the way two units bolted
   * into a rack cascade.
   *
   * It is a SEPARATE DEVICE, not a second view of the first: it has its own
   * bands (window.StudioEq2), its own patch state, and its own bypass. The
   * first EQ owns `window.StudioEq` and nothing here touches that global —
   * two panels writing one band list would fight, each overwriting the
   * other's knob on the next publish.
   *
   * No trim node here. The first EQ's auto gain compensation already stands
   * before the filters and is computed from the whole monitor path's worst
   * case; a second trim would attenuate twice and deliver a monitor quieter
   * than the source. The rack's maximizer, when patched, is what holds the
   * ceiling for everything downstream.
   */
  buildEq2(ctx) {
    const bands = (window.StudioEq2 && window.StudioEq2.bands) || [];
    const active = activeEqBands(bands);

    this.eq2Nodes = [];
    if (!active.length || this.eq2Bypassed) {
      const pass = ctx.createGain();
      this.eq2Input = this.eq2Output = pass;
      return { input: pass, output: pass };
    }

    let head = null, tail = null;
    for (const b of active) {
      const node = ctx.createBiquadFilter();
      node.type = b.type;
      node.frequency.value = b.freq;
      if (b.type !== 'highpass' && b.type !== 'lowpass') node.gain.value = b.gain;
      node.Q.value = b.q || 0.707;
      if (tail) tail.connect(node); else head = node;
      tail = node;
      this.eq2Nodes.push({ node, band: b });
    }
    this.eq2Input = head;
    this.eq2Output = tail;
    return { input: head, output: tail };
  }

  /* Retune EQ 2 in place. Same contract as updateEq: false means the shape
   * changed and the graph has to be rebuilt. */
  updateEq2(bands) {
    const ctx = this.ctx;
    if (!ctx || !this.eq2Nodes) return false;
    const active = activeEqBands(bands);
    if (active.length !== this.eq2Nodes.length) return false;
    const t = ctx.currentTime;
    for (let i = 0; i < active.length; i++) {
      const { node } = this.eq2Nodes[i];
      const b = active[i];
      if (node.type !== b.type) return false;
      node.frequency.setTargetAtTime(b.freq, t, 0.01);
      node.Q.setTargetAtTime(b.q || 0.707, t, 0.01);
      if (node.gain) node.gain.setTargetAtTime(b.gain, t, 0.01);
      this.eq2Nodes[i].band = b;
    }
    return true;
  }

  rebuildEq2() {
    if (!this.playing) return;
    const at = this.currentTime();
    this.pause();
    this.offset = at;
    this.play();
  }

  setEq2Bypass(on) {
    this.eq2Bypassed = !!on;
    if (this.playing) this.rebuildEq2();
  }

  /* ---------------------------------------------------------------- RACK --
   * The mastering suite, live: compressor, stereo imager, maximizer and soft
   * clip, in MClass's device order — the same order maximize.py emits.
   *
   * Built as an {input, output} block, exactly like buildEq(), because the
   * router below chains blocks and does not care what is inside one. That is
   * what makes the wiring optional: a device the user has unpatched is simply
   * a block the router skips, and back-panel cables later become a change to
   * the router rather than to any device.
   *
   * THREE PLACES THE BROWSER CANNOT MATCH THE CLI. These are surfaced in the
   * panel rather than clamped silently, because a knob that reads 2.4 s while
   * doing 1.0 s is the kind of lie that costs an afternoon:
   *
   *   1. Compressor release. ffmpeg allows 9 s; DynamicsCompressorNode caps
   *      at 1 s. Anything above is previewed at 1 s and marked approximate.
   *   2. The limiter. There is no limiter node. Built here from a DelayNode
   *      (look-ahead) into a hard-kneed 20:1 compressor. Measured: a source
   *      reaching 0 dBFS came out at -0.05 dBFS.
   *   3. The stereo imager. No node does mid/side, so it is built from a
   *      splitter, gain stages and a merger.
   *
   * The CLI remains the authority. This is a monitor path: it writes nothing,
   * and `music maximize` is what actually renders.
   */
  buildRack(ctx) {
    const s = (window.StudioRack && window.StudioRack.settings) || null;
    if (!s || this.rackBypassed) {
      const pass = ctx.createGain();
      this.rackNodes = null;
      this.rackInput = this.rackOutput = pass;
      return { input: pass, output: pass };
    }

    const nodes = {};
    const blocks = [];

    if (s.comp) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = clamp(s.comp_threshold, -100, 0);
      comp.ratio.value = clamp(s.comp_ratio, 1, 20);
      comp.knee.value = clamp(s.comp_knee, 0, 40);
      comp.attack.value = clamp(s.comp_attack / 1000, 0, 1);
      // The release divergence. clamp() is what makes it a preview rather
      // than a lie; the panel reads rackApprox() to say so on screen.
      comp.release.value = clamp(s.comp_release / 1000, 0, 1);
      nodes.comp = comp;
      // Makeup gain is a separate node: the browser compressor has none.
      if (s.comp_makeup) {
        const mk = ctx.createGain();
        mk.gain.value = Math.pow(10, s.comp_makeup / 20);
        comp.connect(mk);
        nodes.compMakeup = mk;
        blocks.push({ input: comp, output: mk });
      } else {
        blocks.push({ input: comp, output: comp });
      }
    }

    if (s.imager) blocks.push(this._buildImager(ctx, s, nodes));
    if (s.maximize) blocks.push(this._buildMaximizer(ctx, s, nodes));
    if (s.soft_clip) blocks.push(this._buildSoftClip(ctx, s, nodes));

    this.rackNodes = nodes;
    return this._chain(ctx, blocks, 'rack');
  }

  /* Stereo imager: split to L/R, derive mid and side, scale the side by the
   * width, and sum back. A crossover would need two of these on either side
   * of a filter pair; the CLI's xover is not previewed, which rackApprox()
   * reports. Width 0 is mono, 1 is as recorded, above 1 is wider. */
  _buildImager(ctx, s, nodes) {
    const input = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);

    /* mid = (L+R)/2, side = (L-R)/2, then L = mid + w·side, R = mid - w·side.
     *
     * Every gain here is explicit rather than folded into a shared node.
     * Measured, the folded version was wrong twice over: a `side` node that
     * was itself 0.5 halved an already-halved difference, while feeding both
     * the positive and the inverted side into the merger double-counted it.
     * Width 1 came out at L=0.525/R=0.075 from a 0.5/0.1 input — audibly
     * wider when it should have been bit-transparent. Width 1 is now asserted
     * transparent by the offline check. */
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };

    const mid = g(1);            // sums 0.5L + 0.5R from the two feeds below
    const side = g(1);           // sums 0.5L - 0.5R

    const midL = g(0.5), midR = g(0.5);
    const sideL = g(0.5), sideR = g(-0.5);

    input.connect(split);
    split.connect(midL, 0); split.connect(midR, 1);
    midL.connect(mid); midR.connect(mid);
    split.connect(sideL, 0); split.connect(sideR, 1);
    sideL.connect(side); sideR.connect(side);

    // Width acts on the side signal only, which is what "width" means.
    const width = g(clamp(s.hi_width, 0, 2));
    side.connect(width);

    // L = mid + side, R = mid - side. The inversion is its own node so the
    // side signal is counted exactly once per output channel.
    const negS = g(-1);
    width.connect(negS);

    const outL = g(1), outR = g(1);
    mid.connect(outL); width.connect(outL);
    mid.connect(outR); negS.connect(outR);
    outL.connect(merge, 0, 0);
    outR.connect(merge, 0, 1);

    nodes.width = width;
    return { input, output: merge };
  }

  /* Maximizer: input gain, look-ahead, gain riding, then a ceiling.
   *
   * There is no limiter node, so this is built from three. The DelayNode is
   * the look-ahead: the gain computer sees a transient before the signal it
   * is about to act on arrives. The compressor does the musical part, riding
   * the level down over milliseconds the way a limiter's release does.
   *
   * THE COMPRESSOR ALONE IS NOT A CEILING. Measured, driving a -1.0 dBFS
   * threshold: +0.38 dBFS at 6 dB of drive and +1.195 dBFS at 12 dB — it
   * overshoots further the harder it is pushed, because ratio 20:1 is a slope
   * and not a wall. That is the same failure `alimiter` has in the CLI, and
   * the reason invariant 1 exists.
   *
   * So a hard-clipping WaveShaper backstops it at exactly the asked-for
   * ceiling. Measured with the backstop: -0.978 dBFS at 6 dB of drive and
   * -0.991 at 12 dB — the ceiling holds however hard the input is driven,
   * which is the whole job. The compressor keeps the clipper from doing
   * audible work; the clipper keeps the compressor honest.
   *
   * Unlike the CLI this may end the chain: the browser writes no file, so an
   * intersample peak has nothing to damage past the monitor path. Invariant 1
   * governs what master.py emits and is untouched. */
  _buildMaximizer(ctx, s, nodes) {
    const input = ctx.createGain();
    input.gain.value = Math.pow(10, clamp(s.input_gain, -12, 12) / 20);

    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = s.look_ahead ? 0.004 : 0;   // MClass's 4 ms

    const ceiling = clamp(s.limit, -60, 0);
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = ceiling;
    lim.ratio.value = 20;
    lim.knee.value = 0;                                 // no soft shoulder
    lim.attack.value = (RACK_LIMIT_ATTACK[s.limit_attack] ?? 0.5) / 1000;
    lim.release.value = (RACK_LIMIT_RELEASE[s.limit_release] ?? 100) / 1000;

    const wall = ctx.createWaveShaper();
    wall.curve = hardCeilingCurve(ceiling);
    wall.oversample = '4x';

    input.connect(delay);
    delay.connect(lim);
    lim.connect(wall);
    nodes.limiter = lim;
    nodes.inputGain = input;
    nodes.wall = wall;
    return { input, output: wall };
  }

  /* Soft clip: a WaveShaper with the curve the CLI names, at 4x oversampling
   * so the curve's own harmonics do not alias back down. */
  _buildSoftClip(ctx, s, nodes) {
    const ws = ctx.createWaveShaper();
    ws.curve = softClipCurve(s.soft_clip, s.clip_amount, s.clip_threshold);
    ws.oversample = s.clip_oversample >= 4 ? '4x'
      : (s.clip_oversample >= 2 ? '2x' : 'none');
    nodes.clip = ws;
    return { input: ws, output: ws };
  }

  /* Wire a list of blocks head to tail and return the pair. An empty list is
   * a passthrough, so a rack with every device unpatched still has an input
   * and an output for the router to use. */
  _chain(ctx, blocks, which) {
    if (!blocks.length) {
      const pass = ctx.createGain();
      this[which + 'Input'] = this[which + 'Output'] = pass;
      return { input: pass, output: pass };
    }
    for (let i = 0; i < blocks.length - 1; i++) {
      blocks[i].output.connect(blocks[i + 1].input);
    }
    const input = blocks[0].input;
    const output = blocks[blocks.length - 1].output;
    this[which + 'Input'] = input;
    this[which + 'Output'] = output;
    return { input, output };
  }

  /* Which settings the browser is only approximating, for the panel to show.
   * Returns [{knob, asked, preview, why}]. Empty means the preview is exact. */
  rackApprox() {
    const s = (window.StudioRack && window.StudioRack.settings) || null;
    const out = [];
    if (!s) return out;
    if (s.comp && s.comp_release > 1000) {
      out.push({
        knob: 'comp_release', asked: s.comp_release, preview: 1000,
        why: 'WebAudio caps compressor release at 1 s; the CLI allows 9 s.',
      });
    }
    if (s.comp && s.comp_adaptive) {
      out.push({
        knob: 'comp_adaptive', asked: 'on', preview: 'off',
        why: 'No adaptive release in the browser; the render has it.',
      });
    }
    if (s.imager) {
      out.push({
        knob: 'xover', asked: s.xover, preview: null,
        why: 'The CLI splits the band here and widens each half separately; '
           + 'the preview has one width across the whole range.',
      });
      /* The preview applies hi_width to everything, so a low width that
         differs is doing nothing you can hear. Reported only when it actually
         differs: flagging lo_width on every widened master, including the
         common case where both halves match, would train the eye to skip the
         notice — and then the two entries that matter go unread with it. */
      if (Math.abs((s.lo_width ?? 1) - (s.hi_width ?? 1)) > 0.005) {
        out.push({
          knob: 'lo_width', asked: s.lo_width, preview: s.hi_width,
          why: 'The preview widens the whole band by the high width; only the '
             + 'render treats the low band separately.',
        });
      }
    }
    return out;
  }

  /* Live gain reduction, in dB, for the panel's meters. Negative is
   * reduction. Null when the device is not in the chain. */
  rackReduction() {
    const n = this.rackNodes;
    if (!n) return { comp: null, limiter: null };
    return {
      comp: n.comp ? n.comp.reduction : null,
      limiter: n.limiter ? n.limiter.reduction : null,
    };
  }

  /* Rebuild the rack when its shape changed — a device switched on or off.
   * Same restart-in-place as the EQ, so a change stays an A/B. */
  rebuildRack() {
    if (!this.playing) return;
    const at = this.currentTime();
    this.pause();
    this.offset = at;
    this.play();
  }

  /* Retune the rack without rebuilding, when only values moved. Returns
   * false when the shape changed and a rebuild is needed. */
  updateRack() {
    const ctx = this.ctx, n = this.rackNodes;
    const s = (window.StudioRack && window.StudioRack.settings) || null;
    if (!ctx || !n || !s) return false;
    const t = ctx.currentTime;
    const ramp = (param, v) => {
      try { param.setTargetAtTime(v, t, 0.01); } catch (_) { /* detached */ }
    };
    // A device appearing or disappearing is a shape change.
    if (!!s.comp !== !!n.comp) return false;
    if (!!s.maximize !== !!n.limiter) return false;
    if (!!s.soft_clip !== !!n.clip) return false;
    if (!!s.imager !== !!n.width) return false;
    if (s.comp && !!s.comp_makeup !== !!n.compMakeup) return false;

    if (n.comp) {
      ramp(n.comp.threshold, clamp(s.comp_threshold, -100, 0));
      ramp(n.comp.ratio, clamp(s.comp_ratio, 1, 20));
      ramp(n.comp.knee, clamp(s.comp_knee, 0, 40));
      ramp(n.comp.attack, clamp(s.comp_attack / 1000, 0, 1));
      ramp(n.comp.release, clamp(s.comp_release / 1000, 0, 1));
    }
    if (n.compMakeup) ramp(n.compMakeup.gain, Math.pow(10, s.comp_makeup / 20));
    if (n.width) ramp(n.width.gain, clamp(s.hi_width, 0, 2));
    if (n.inputGain) {
      ramp(n.inputGain.gain, Math.pow(10, clamp(s.input_gain, -12, 12) / 20));
    }
    if (n.limiter) {
      ramp(n.limiter.threshold, clamp(s.limit, -60, 0));
      ramp(n.limiter.attack, (RACK_LIMIT_ATTACK[s.limit_attack] ?? 0.5) / 1000);
      ramp(n.limiter.release, (RACK_LIMIT_RELEASE[s.limit_release] ?? 100) / 1000);
      /* The ceiling moves with the threshold. Retuning one without the other
         left the wall where it was, so turning the limit knob down changed
         the gain riding while the actual ceiling stayed put. */
      if (n.wall) n.wall.curve = hardCeilingCurve(clamp(s.limit, -60, 0));
    }
    if (n.clip) {
      // The curve is a buffer, not a param: swapped whole, no ramp available.
      n.clip.curve = softClipCurve(s.soft_clip, s.clip_amount, s.clip_threshold);
    }
    return true;
  }

  /* Bypass the whole rack, for comparing the suite against the source. */
  setRackBypass(on) {
    this.rackBypassed = !!on;
    if (this.playing) this.rebuildRack();
  }

  /* Bypass, for comparing the EQ against the source. */
  setEqBypass(on) {
    this.eqBypassed = !!on;
    /* The trim follows the bypass: out of bypass it comes back to whatever
       the panel last asked for, in bypass it goes to unity. Done before the
       rebuild so the new chain is built with the right value already set. */
    if (this.eqTrim && this.ctx) {
      try {
        this.eqTrim.gain.setTargetAtTime(
          this._eqTrimLinear(), this.ctx.currentTime, 0.01);
      } catch (_) { /* node detached */ }
    }
    if (this.playing) this.rebuildEq();
  }

  play() {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') ctx.resume();
    if (!this.buffer || this.playing) return;

    const { analyser, proc, gain } = this.buildGraph();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;

    /* The EQ sits between the gain stage and everything downstream, so the
     * meters read the equalised signal — what you hear is what they measure.
     * With no bands active, eqIn and eqOut are the same node and this is a
     * plain passthrough. */
    const { input: eqIn, output: eqOut } = this.buildEq(ctx);

    /* The router. Each stage is an {input, output} block, and only the
     * patched ones are wired — an unpatched rack is not a bypassed device in
     * the path, it is absent from the path. Order follows MClass and the CLI:
     * EQ, then the suite. The meters sit at the end, so they always read what
     * is actually audible however the blocks are patched. */
    let tail = eqOut;
    /* EQ 2 sits between the first equaliser and the suite — two units in a
     * rack, in the order they are bolted in. Tone before dynamics, so the
     * compressor reacts to the signal you actually shaped. */
    if (this.eq2Enabled) {
      const { input: eq2In, output: eq2Out } = this.buildEq2(ctx);
      tail.connect(eq2In);
      tail = eq2Out;
    } else {
      this.eq2Nodes = null;
    }
    if (this.rackEnabled) {
      const { input: rackIn, output: rackOut } = this.buildRack(ctx);
      tail.connect(rackIn);
      tail = rackOut;
    } else {
      this.rackNodes = null;
    }

    src.connect(gain);
    gain.connect(eqIn);
    tail.connect(analyser);
    analyser.connect(proc);
    proc.connect(ctx.destination);   // silent, keeps the processor pulling
    tail.connect(ctx.destination);   // the audible path

    /* `onended` fires on a later task, not inside stop(), so a flag that pause()
       clears on the next line is already false by the time this runs — which is
       how pausing came to rewind to zero. Asking instead whether this node is
       still the transport's current source settles it: after a deliberate stop
       it is not (pause() and _teardown() drop it), and only a source that played
       out to its own end is. */
    src.onended = () => {
      if (this.source !== src) return;   // stopped by hand, not the end of the file
      this.playing = false;
      this.offset = 0;
      if (this.onended) this.onended();
    };
    src.start(0, this.offset);
    this.source = src;
    this.startedAt = ctx.currentTime;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime();
    const src = this.source;
    /* Drop our claim on the node before stopping it, so the `onended` this
       provokes can see it is no longer the current source and leave the
       playhead where the pause put it. */
    this.source = null;
    this.playing = false;
    try { if (src) src.stop(); } catch (_) { /* already stopped */ }
    this._teardown(src);
  }

  /** @param {AudioBufferSourceNode} [src]  a source already detached by pause() */
  _teardown(src) {
    for (const n of [src || this.source, this.gain, this.eqTrim, this.analyser, this.proc]) {
      if (n) { try { n.disconnect(); } catch (_) { /* not connected */ } }
    }
    /* The rack's own nodes. Missing these left the previous chain still wired
       to ctx.destination after a rebuild, so the old settings stayed audible
       underneath the new ones. */
    for (const n of [this.rackInput, this.rackOutput, this.eq2Input, this.eq2Output]) {
      if (n) { try { n.disconnect(); } catch (_) { /* not connected */ } }
    }
    for (const e of this.eq2Nodes || []) {
      if (e && e.node) { try { e.node.disconnect(); } catch (_) { /* not connected */ } }
    }
    this.eq2Nodes = null;
    for (const n of Object.values(this.rackNodes || {})) {
      if (n) { try { n.disconnect(); } catch (_) { /* not connected */ } }
    }
    this.rackNodes = null;
    if (this.proc) this.proc.onaudioprocess = null;
    this.source = null;
  }

  seek(sec) {
    const was = this.playing;
    if (was) this.pause();
    this.offset = clamp(sec, 0, this.duration());
    this.resetMeters();
    if (was) this.play();
  }

  currentTime() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    return clamp(this.offset + (this.ctx.currentTime - this.startedAt), 0, this.duration());
  }

  duration() { return this.buffer ? this.buffer.duration : 0; }
}

/* ==========================================================================
   6. Verdicts
   ========================================================================== */

/* Delivery targets. These are defaults for the audio-only path, where nothing
 * tells us what the shop aims for. An analyze.py JSON carries a `targets` block
 * read from master.py, and loading one overwrites these — so changing
 * DEFAULT_LUFS in master.py reaches this page instead of leaving it quietly
 * showing a number nobody targets any more. */
let TARGET_LUFS = -14;
let TP_CEILING = -1.0;
let TARGET_SOURCE = 'default';

function applyTargets(t) {
  if (!t || typeof t !== 'object') return;
  if (Number.isFinite(t.integrated_lufs)) TARGET_LUFS = t.integrated_lufs;
  if (Number.isFinite(t.true_peak_dbtp)) TP_CEILING = t.true_peak_dbtp;
  TARGET_SOURCE = t.source || 'analysis';
  const el = document.getElementById('delivery-target');
  if (el) {
    el.textContent =
      `delivery target ${TARGET_LUFS} LUFS / ${TP_CEILING.toFixed(1)} dBTP`;
  }
}

function verdictLoudness(integrated) {
  if (!isFinite(integrated)) {
    return { state: 'idle', pill: 'no signal',
      body: 'Play the track, or load an analysis, to measure integrated loudness.' };
  }
  const d = integrated - TARGET_LUFS;
  const ad = Math.abs(d);
  const num = `<b>${fmtLu(integrated, 1)} LUFS</b>`;
  const off = `<b>${d >= 0 ? '+' : '−'}${ad.toFixed(1)} LU</b>`;
  if (ad <= 0.5) {
    return { state: 'ok', pill: 'on target',
      body: `${num}, ${off} from the −14 LUFS target. Ready to upload.` };
  }
  if (ad <= 1.5) {
    return { state: 'warn', pill: `${d >= 0 ? 'hot' : 'quiet'} by ${ad.toFixed(1)} LU`,
      body: `${num}. Within a level YouTube will normalise without audible harm, ` +
            `but a re-master gets it exact.` };
  }
  return { state: 'bad', pill: `${d >= 0 ? 'too hot' : 'too quiet'}`,
    body: `${num}, ${off} off target. ` +
      (d > 0
        ? 'YouTube will turn this down on playback, so the extra level buys nothing and costs dynamics.'
        : 'This will sit noticeably quieter than neighbouring tracks. Re-run mastering before upload.') };
}

function verdictClipping(overs, truePeak) {
  if (!isFinite(truePeak)) {
    return { state: 'idle', pill: 'not measured',
      body: `Sample and true peak are read while the track plays. Ceiling is <b>−1.0 dBTP</b>.` };
  }
  const tp = `<b>${fmtLu(truePeak, 1)} dBTP</b>`;
  if (truePeak > 0) {
    return { state: 'bad', pill: `${overs} over${overs === 1 ? '' : 's'}`,
      body: `True peak ${tp} — above full scale. Lossy encoding will clip this ` +
            `audibly even though the WAV sounds clean. Limit before upload.` };
  }
  if (truePeak > TP_CEILING) {
    return { state: 'warn', pill: 'above ceiling',
      body: `True peak ${tp}, over the −1.0 dBTP ceiling. There is not enough ` +
            `headroom for the encoder.` };
  }
  return { state: 'ok', pill: 'clean',
    body: `True peak ${tp}, inside the −1.0 dBTP ceiling. No clipping detected.` };
}

function verdictCutoff(hz, sourceKind) {
  if (!hz) {
    return { state: 'idle', pill: 'watching',
      body: 'Full-band content up to Nyquist so far. A hard ceiling near ' +
            '<b>16 kHz</b> would mean the source has already been through a lossy codec.' };
  }
  const k = (hz / 1000).toFixed(1);
  if (hz >= 19000) {
    return { state: 'ok', pill: 'full band',
      body: `Content extends to <b>${k} kHz</b>. This looks like an untouched ` +
            `WAV, not a re-encode.` };
  }
  // Measured encoder cutoffs (LAME/AAC round-trips, 2026-09-15): 128k lands
  // near 15-16.6 kHz, 192k near 18.7 kHz, 320k near 20 kHz. So 18 kHz is the
  // honest line between "high bitrate, barely audible" and "128k, a real loss".
  if (hz >= 18000) {
    return { state: 'warn', pill: `${k} kHz wall`,
      body: `Energy stops at <b>${k} kHz</b> — the signature of a high-bitrate ` +
            `MP3 or AAC. Fine to publish, but master from the WAV if you still have it.` };
  }
  if (hz >= 15000) {
    return { state: 'bad', pill: `${k} kHz wall`,
      body: `Energy stops at <b>${k} kHz</b> — around what a <b>128 kbps</b> encode ` +
            `leaves. The top octave is gone and no EQ restores it. Master from the ` +
            `original WAV rather than publishing this.` };
  }
  return { state: 'bad', pill: `${k} kHz wall`,
    body: `A brick wall at <b>${k} kHz</b> means a low-bitrate lossy source. ` +
          `Re-encoding it for upload stacks a second generation of artefacts.` };
}

function verdictPhase(corr) {
  if (!isFinite(corr)) {
    return { state: 'idle', pill: 'no signal', body: 'Stereo correlation reads during playback.' };
  }
  const v = `<b>${(corr >= 0 ? '+' : '−') + Math.abs(corr).toFixed(2)}</b>`;
  if (corr < 0) {
    return { state: 'bad', pill: 'out of phase',
      body: `Correlation ${v}. The channels partly cancel — this track will lose ` +
            `body on a phone speaker or any mono playback.` };
  }
  if (corr < 0.3) {
    return { state: 'warn', pill: 'very wide',
      body: `Correlation ${v}. A wide image, but check it in mono before publishing.` };
  }
  return { state: 'ok', pill: 'mono-safe',
    body: `Correlation ${v}. The stereo image survives a mono fold-down.` };
}

/* ==========================================================================
   7. Wiring
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

const el = {
  vuL: $('#vu-left'), vuR: $('#vu-right'),
  lamp: $('#peak-lamp'),
  bars: $('#bars'), corr: $('#corr'),
  spectrum: $('#spectrum'), spectro: $('#spectrogram'),
  play: $('#play'), pause: $('#pause'), stop: $('#stop'), rtz: $('#rtz'),
  scrub: $('#scrub'),
  tCur: $('#t-cur'), tDur: $('#t-dur'),
  source: $('#source-name'),
  roBpm: $('#ro-bpm'), roBpmV: $('#ro-bpm-v'), roMeter: $('#ro-meter'),
  roKey: $('#ro-key'), roKeyV: $('#ro-key-v'),
  roLufsM: $('#ro-lufs-m'), roLufsS: $('#ro-lufs-s'),
  roTp: $('#ro-tp'), roCorr: $('#ro-corr'),
  roPos: $('#ro-pos'), roBar: $('#ro-bar'),
  analyseNow: $('#analyse-now'), analyseAuto: $('#analyse-auto'),
  audioInput: $('#audio-input'), jsonInput: $('#json-input'),
  verdicts: $('#verdicts'),
  lufsM: $('#lufs-m'), lufsS: $('#lufs-s'), lufsI: $('#lufs-i'),
  lufsDelta: $('#lufs-delta'), lra: $('#lra-v'),
  cutoffNote: $('#cutoff-note'),
  rate: $('#meta-rate'), chans: $('#meta-chans'),
  mode: $('#channel-mode'),
  timeline: $('#timeline'),
  splitter: $('#splitter'),
  shell: $('.shell'),
  reset: $('#reset-all'),
  analyzeRun: $('#analyze-run'),
};

const engine = new Engine();

/* The Equalizer panel lives in meters.js and needs to reach the audio graph to
   make a knob audible. One named global is the whole contract between them. */
window.engine = engine;
const vuL = new VuMovement();
const vuR = new VuMovement();
const spectro = new Spectrogram(el.spectro);

let analysis = null;        // precomputed JSON, when loaded
let peakLatch = 0;          // timestamp of the last over
let lastFrame = performance.now();
let cutoffHz = 0;
let sourceKind = 'none';
let staticSpectrumNyquist = 0;  // nyquist for a spectrum that came from JSON

/* ---- VU reference ------------------------------------------------------
   0 VU is pinned to −18 dBFS RMS, the usual digital alignment for a −14 LUFS
   master: it puts a correctly-levelled track's needles dancing around 0
   rather than pinned or asleep at the bottom of the scale. */
const VU_REF_DBFS = -18;

function rmsToVu(rmsDb) {
  if (!isFinite(rmsDb)) return VU_MIN;
  return clamp(rmsDb - VU_REF_DBFS, VU_MIN - 2, VU_MAX + 1.2);
}

/* ---- peak hold --------------------------------------------------------- */

function updateHold(m, now, dt) {
  const v = m.tp;
  if (v > m.hold) { m.hold = v; m.holdAge = now; }
  else if (now - m.holdAge > 1500) {
    // 20 dB per second fall after the 1.5 s hold, the broadcast convention
    m.hold = Math.max(BAR_MIN_DB, m.hold - 20 * dt);
  }
}

/* ---- codec cutoff detection from the live spectrum --------------------- */

/* ---- codec cutoff detection from the live spectrum ---------------------
   A lossy encoder leaves a *cliff*: full-level content right up to the cutoff,
   then a near-vertical drop to nothing that persists over time. Sparse music
   (a solo instrument, a quiet passage) also has no high-frequency energy, but
   it falls away gradually and the edge wanders. So the test is not "where does
   energy stop" — it is "is there a persistent, steep, sustained edge".        */

const cutoffHistory = [];
let cutoffStable = 0;

function detectCutoff(bins, nyquist) {
  const n = bins.length;

  /* Reference level: the median of the strong mid band. Judging the edge
     against the frame's own level, rather than an absolute byte value, keeps a
     quiet passage from reading as a brick wall. */
  const mid = [];
  for (let i = Math.floor(n * 0.02); i < Math.floor(n * 0.25); i++) mid.push(bins[i]);
  if (!mid.length) return;
  mid.sort((a, b) => a - b);
  const ref = mid[mid.length >> 1];
  if (ref < 40) { cutoffStable = Math.max(0, cutoffStable - 3); return; }

  /* What a lossy encoder leaves behind is not a gentle roll-off but a floor:
     measured against a 96 kbps MP3, bins above the cutoff read 0 while the
     band below sits near the mid-band level. Full-bandwidth material stays
     within about 20 of the reference all the way to Nyquist. So the edge is
     the last bin still clearly above an absolute floor. */
  const FLOOR = 12;
  let edge = -1;
  for (let i = n - 1; i > n * 0.05; i--) {
    if (bins[i] > FLOOR) { edge = i; break; }
  }
  if (edge < 0) { cutoffStable = Math.max(0, cutoffStable - 3); return; }

  /* Content reaching the top of the usable band is full bandwidth. The very
     top bins are unreliable, so measure against 0.90 of Nyquist. */
  if (edge > n * 0.90) { cutoffStable = Math.max(0, cutoffStable - 3); return; }

  /* A codec cliff has real level right up to the edge; a dull mix fades. */
  const bLo = Math.max(1, Math.floor(edge * 0.82));
  let below = 0, bn = 0;
  for (let i = bLo; i <= edge; i++) { below += bins[i]; bn++; }
  below = bn ? below / bn : 0;
  if (below < ref - 45) { cutoffStable = Math.max(0, cutoffStable - 3); return; }

  cutoffStable = Math.min(120, cutoffStable + 1);
  cutoffHistory.push(edge * nyquist / n);
  if (cutoffHistory.length > 120) cutoffHistory.shift();

  /* Report only a stable, tightly-agreeing edge held for about a second. */
  if (cutoffStable < 40 || cutoffHistory.length < 30) return;
  const sorted = cutoffHistory.slice().sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  if ((q3 - q1) > med * 0.10) return;          // a wandering edge is not a codec
  cutoffHz = med < nyquist * 0.90 ? med : 0;
}

/* ---- the frame loop ---------------------------------------------------- */

let freqBytes = null;

function frame() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  const bridgeW = el.vuL.parentElement.clientWidth - 14;
  const mL = engine.meters.L, mR = engine.meters.R;

  /* --- drive the movements --- */
  let driveL, driveR;
  if (engine.playing) {
    driveL = rmsToVu(mL.rms);
    driveR = rmsToVu(mR.rms);
  } else if (analysis && analysis._staticVu) {
    driveL = analysis._staticVu[0];
    driveR = analysis._staticVu[1];
  } else {
    driveL = driveR = VU_MIN;
  }

  const nL = vuL.step(driveL, dt);
  const nR = vuR.step(driveR, dt);

  /* --- peak lamp: latches on an over, decays after 1.2 s --- */
  const over = (isFinite(mL.tp) && mL.tp > TP_CEILING) ||
               (isFinite(mR.tp) && mR.tp > TP_CEILING);
  if (over && engine.playing) peakLatch = now;
  const lampLit = now - peakLatch < 1200;
  el.lamp.classList.toggle('lit', lampLit);

  drawVu(el.vuL, 'Left', nL, lampLit, bridgeW);
  drawVu(el.vuR, 'Right', nR, lampLit, bridgeW);

  /* --- digital bars --- */
  updateHold(mL, now, dt);
  updateHold(mR, now, dt);
  const barsW = el.bars.parentElement.clientWidth;
  drawBars(el.bars, [
    { name: 'L', db: isFinite(mL.tp) ? mL.tp : BAR_MIN_DB, hold: mL.hold },
    { name: 'R', db: isFinite(mR.tp) ? mR.tp : BAR_MIN_DB, hold: mR.hold },
  ], barsW);

  drawCorrelation(el.corr, engine.correlation, el.corr.parentElement.clientWidth);

  /* --- spectrum + spectrogram --- */
  const specW = el.spectrum.parentElement.clientWidth;
  if (engine.analyser && engine.playing) {
    if (!freqBytes || freqBytes.length !== engine.analyser.frequencyBinCount) {
      freqBytes = new Uint8Array(engine.analyser.frequencyBinCount);
    }
    engine.analyser.getByteFrequencyData(freqBytes);
    staticSpectrumNyquist = 0;
    const nyq = engine.sampleRate / 2;
    detectCutoff(freqBytes, nyq);
    drawSpectrum(el.spectrum, freqBytes, nyq, cutoffHz, specW);
    if (!spectro.staticMode) spectro.push(freqBytes, nyq);
  } else {
    const nyq = staticSpectrumNyquist || engine.sampleRate / 2;
    drawSpectrum(el.spectrum, freqBytes, nyq, cutoffHz, specW);
  }
  const ph = spectro.staticMode && engine.duration()
    ? engine.currentTime() / engine.duration() : -1;
  spectro.render(specW, cutoffHz, ph);

  /* --- readouts --- */
  updateReadouts();

  /* --- transport --- */
  if (engine.buffer) {
    const t = engine.currentTime();
    el.tCur.textContent = fmtTime(t);
    if (document.activeElement !== el.scrub) {
      el.scrub.value = String((t / engine.duration()) * 1000);
    }
  }

  requestAnimationFrame(frame);
}

/* ---- readouts and verdicts --------------------------------------------- */

let verdictTick = 0;

function updateReadouts() {
  const lm = engine.loudness;
  const a = analysis;

  const mom = lm && isFinite(lm.momentary) ? lm.momentary : (a ? a.momentary_lufs : NaN);
  const sht = lm && isFinite(lm.shortTerm) ? lm.shortTerm : (a ? a.shortterm_lufs : NaN);
  let itg = lm && isFinite(lm.integrated) ? lm.integrated : NaN;
  if (!isFinite(itg) && a && isFinite(a.integrated_lufs)) itg = a.integrated_lufs;

  el.lufsM.textContent = isFinite(mom) ? fmtLu(mom, 1) : '−∞';
  el.lufsS.textContent = isFinite(sht) ? fmtLu(sht, 1) : '−∞';
  el.lufsI.textContent = isFinite(itg) ? fmtLu(itg, 1) : '−∞';

  /* --- the transport's own readout strip -------------------------------
     Live figures while playing, the analysed ones when parked, an em-dash
     when neither exists. Nothing here falls back to a plausible constant. */
  if (el.roLufsM) el.roLufsM.textContent = isFinite(mom) ? fmtLu(mom, 1) : NO_VALUE;
  if (el.roLufsS) el.roLufsS.textContent = isFinite(sht) ? fmtLu(sht, 1) : NO_VALUE;

  const tpNow = isFinite(engine.maxTruePeak) ? engine.maxTruePeak
    : (a && isFinite(a.true_peak_dbtp) ? a.true_peak_dbtp : NaN);
  if (el.roTp) el.roTp.textContent = isFinite(tpNow) ? fmtDb(tpNow, 1) : NO_VALUE;

  const corrNow = engine.playing ? engine.correlation
    : (a && isFinite(a.correlation) ? a.correlation
      : (engine.buffer ? engine.correlation : NaN));
  if (el.roCorr) {
    el.roCorr.textContent = isFinite(corrNow)
      ? (corrNow >= 0 ? '+' : '−') + Math.abs(corrNow).toFixed(2) : NO_VALUE;
  }

  /* Position: the clock and the musical grid say the same thing two ways. */
  const dur = engine.duration() || (a && isFinite(a.duration) ? a.duration : 0);
  const pos = engine.buffer ? engine.currentTime() : 0;
  if (el.roPos) {
    el.roPos.textContent = dur > 0
      ? `${fmtTime(pos)} / ${fmtTime(dur)}` : NO_VALUE;
  }
  if (el.roBar) {
    /* currentTempo is parsed once when the analysis lands, not per frame: a
       beat_times array can hold thousands of entries. */
    el.roBar.textContent = barBeatAt(pos, currentTempo) || NO_VALUE;
  }

  if (isFinite(itg)) {
    const d = itg - TARGET_LUFS;
    const ad = Math.abs(d);
    el.lufsDelta.textContent =
      `${d >= 0 ? '+' : '−'}${ad.toFixed(1)} LU vs −14 target`;
    el.lufsDelta.className = 'delta ' + (ad <= 0.5 ? 'ok' : ad <= 1.5 ? 'warn' : 'bad');
  } else {
    el.lufsDelta.textContent = 'target −14.0 LUFS';
    el.lufsDelta.className = 'delta';
  }

  if (a && isFinite(a.lra)) el.lra.textContent = a.lra.toFixed(1);
  else if (!a) el.lra.textContent = '—';

  /* Verdicts are text: recompute a few times a second, not every frame. */
  if (++verdictTick % 20 !== 0) return;

  const tp = isFinite(engine.maxTruePeak) ? engine.maxTruePeak
    : (a && isFinite(a.true_peak_dbtp) ? a.true_peak_dbtp : NaN);
  const overs = engine.overCount || (a && a.clip_runs) || 0;
  let cut = cutoffHz || (a && a.cutoff_hz) || 0;
  // Ignore a "cutoff" that sits at Nyquist: that is full bandwidth.
  const nyqRef = (a && a.sample_rate ? a.sample_rate : engine.sampleRate) / 2;
  if (cut && cut >= nyqRef * 0.94) cut = 0;
  const corr = engine.playing ? engine.correlation
    : (a && isFinite(a.correlation) ? a.correlation : NaN);

  renderVerdicts([
    ['Loudness', verdictLoudness(itg)],
    ['Clipping', verdictClipping(overs, tp)],
    ['Codec cutoff', verdictCutoff(cut, sourceKind)],
    ['Stereo phase', verdictPhase(corr)],
  ]);

  /* A "cutoff" at Nyquist is not a brick wall, it is simply full bandwidth. */
  const nyqNow = (a && a.sample_rate ? a.sample_rate : engine.sampleRate) / 2;
  const isWall = !!cut && cut < nyqNow * 0.94 && cut < 19000;
  /* With nothing loaded there is no bandwidth to report: claiming "full
     bandwidth to 24.0 kHz" off an empty page states a measurement that was
     never made, and would survive a Reset as if it had been. */
  const measured = !!a || !!engine.buffer;
  el.cutoffNote.textContent = !measured
    ? 'no signal'
    : isWall
      ? `brick wall at ${(cut / 1000).toFixed(1)} kHz — lossy source`
      : `full bandwidth to ${(Math.min(cut || nyqNow, nyqNow) / 1000).toFixed(1)} kHz`;
  el.cutoffNote.classList.toggle('cutoff-flag', isWall);
}

function renderVerdicts(items) {
  const html = items.map(([name, v]) => `
    <div class="verdict" data-state="${v.state}">
      <div class="verdict-head">
        <span class="k">${name}</span>
        <span class="pill">${v.pill}</span>
      </div>
      <p class="verdict-body">${v.body}</p>
    </div>`).join('');
  if (el.verdicts.dataset.sig !== html) {
    el.verdicts.dataset.sig = html;
    el.verdicts.innerHTML = html;
  }
}

/* ---- loading ----------------------------------------------------------- */

async function loadAudioFile(file) {
  el.source.innerHTML = `reading <b>${escapeHtml(file.name)}</b>…`;
  try {
    const buf = await file.arrayBuffer();
    await engine.decode(buf);
    sourceKind = /\.wav$/i.test(file.name) ? 'wav' : 'lossy';
    /* Loading audio supersedes any previously loaded analysis: leaving it in
       place would let the old file's cutoff, peaks and correlation leak into
       the new file's verdicts. A JSON dropped afterwards re-applies. */
    analysis = null;
    cutoffHistory.length = 0;
    cutoffHz = 0;
    cutoffStable = 0;
    staticSpectrumNyquist = 0;
    freqBytes = null;
    spectro.staticMode = false;
    spectro.clear();
    el.source.innerHTML = `<b>${escapeHtml(file.name)}</b>`;
    el.tDur.textContent = fmtTime(engine.duration());
    el.rate.textContent = (engine.buffer.sampleRate / 1000).toFixed(1) + ' kHz';
    el.chans.textContent = engine.buffer.numberOfChannels > 1 ? 'stereo' : 'mono';
    el.mode.textContent = engine.buffer.numberOfChannels > 1 ? 'Stereo' : 'Mono';
    setTransportEnabled(true);
    engine.play();
    setPlayState(true);
    /* Loading audio supersedes the previous analysis, so the tempo and key
       cells must not keep showing the old track's reading. */
    window.StudioAnalysis = null;
    renderMusicalReadouts();
    maybeAutoAnalyse(file.name);
  } catch (err) {
    el.source.innerHTML =
      `<b>${escapeHtml(file.name)}</b> \u00b7 could not be decoded`;
    console.error(err);
  }
}

async function loadAnalysisFile(file) {
  try {
    const text = await file.text();
    const a = JSON.parse(text);
    applyAnalysis(a, file.name);
  } catch (err) {
    el.source.innerHTML = `<b>${escapeHtml(file.name)}</b> is not valid analysis JSON.`;
    console.error(err);
  }
}

/**
 * Adapt the precomputed analysis. Every field is optional: whatever is
 * present is shown, whatever is missing falls back to the live meters.
 */
/**
 * Normalise either shape of analysis into one flat record:
 *   - `audio-analysis/v1` from analyze.py, whose fields are grouped into
 *     metadata / measures / loudness / envelopes / spectrogram / spectrum /
 *     codec / clipping / stereo blocks
 *   - a flat object with the same values at the top level
 * Everything is optional; whatever is missing falls back to the live meters.
 */
function normaliseAnalysis(a) {
  const meta = a.metadata || {};
  const loud = a.loudness || {};
  const meas = a.measures || {};
  const codec = a.codec || {};
  const clip = a.clipping || {};
  const st = a.stereo || {};
  const spec = a.spectrum || {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);

  const n = {
    duration: pick(meta.duration, a.duration),
    sample_rate: pick(meta.sample_rate, a.sample_rate),
    channels: pick(meta.channels, a.channels),
    filename: pick(meta.filename, a.filename),

    // analyze.py puts the ffmpeg loudness figures in `measures`; the
    // `loudness` block holds the momentary/short-term series and their maxima.
    integrated_lufs: pick(meas.integrated_lufs, loud.integrated_lufs,
                          a.integrated_lufs),
    true_peak_dbtp: pick(meas.true_peak_dbtp, loud.true_peak_dbtp,
                         a.true_peak_dbtp),
    lra: pick(meas.lra, loud.lra, a.lra),
    momentary_lufs: pick(loud.max_momentary, a.momentary_lufs),
    shortterm_lufs: pick(loud.max_short_term, a.shortterm_lufs),

    sample_peak_db: pick(meas.peak, a.peak_db),
    rms_db: pick(meas.rms, a.rms_db),

    cutoff_hz: pick(codec.cutoff_hz, a.cutoff_hz),
    lossy_suspected: pick(codec.lossy_suspected, a.lossy_suspected),
    codec_verdict: codec.verdict,

    clipped_samples: pick(clip.clipped_samples, a.clipped_samples),
    clip_runs: pick(clip.runs, a.clip_runs,
      Array.isArray(a.clipping_events) ? a.clipping_events.length : undefined),

    correlation: pick(st.correlation, a.stereo_correlation, a.correlation),
    balance_db: st.balance_db,
  };

  /* Short-term LUFS series: analyze.py gives {times, lufs}. */
  const stSeries = loud.short_term || a.short_term;
  if (stSeries && Array.isArray(stSeries.lufs)) {
    n.shortterm_series = stSeries.lufs;
    if (!isFinite(n.shortterm_lufs)) {
      const fin = stSeries.lufs.filter((v) => isFinite(v));
      if (fin.length) n.shortterm_lufs = Math.max(...fin);
    }
  }

  const momSeries = loud.momentary || a.momentary;
  if (momSeries && Array.isArray(momSeries.lufs)) {
    n.momentary_series = momSeries.lufs;
  }

  /* Per-channel envelopes: analyze.py nests them under envelopes.channels[]. */
  const env = a.envelopes;
  if (env && Array.isArray(env.channels) && env.channels.length) {
    n.rms_db_channels = env.channels.map((c) => c.rms_db || null).filter(Boolean);
    n.peak_db_channels = env.channels.map((c) => c.peak_db || null).filter(Boolean);
    n.channel_peaks_dbfs = env.channels.map((c) => {
      const arr = c.peak_db || [];
      let m = -Infinity;
      for (const v of arr) if (isFinite(v) && v > m) m = v;
      return m;
    });
  } else if (a.rms_envelope || a.peak_envelope) {
    const e = a.rms_envelope || a.peak_envelope;
    n.rms_db_channels = Array.isArray(e[0]) ? e : [e];
  }
  if (!n.channel_peaks_dbfs && Array.isArray(a.channel_peaks_dbfs)) {
    n.channel_peaks_dbfs = a.channel_peaks_dbfs;
  }

  /* Average spectrum: analyze.py gives spectrum.db with spectrum.freqs. */
  n.average_spectrum = pick(spec.db, a.average_spectrum);
  n.spectrum_freqs = pick(spec.freqs, a.spectrum_freqs);
  n.bands = pick(spec.bands, a.bands);

  /* Spectrogram: analyze.py stores db + shape + layout + freqs. */
  const sg = a.spectrogram;
  if (sg && Array.isArray(sg.db) && Array.isArray(sg.shape)) {
    n.spectrogram = sg.db;
    n.spectrogram_shape = sg.shape;
    n.spectrogram_layout = sg.layout && /freq-major/.test(sg.layout)
      ? 'freq-major' : 'time-major';
    n.spectrogram_freqs = sg.freqs;
  } else if (Array.isArray(a.spectrogram) && Array.isArray(a.spectrogram_shape)) {
    n.spectrogram = a.spectrogram;
    n.spectrogram_shape = a.spectrogram_shape;
    n.spectrogram_layout = a.spectrogram_layout || 'time-major';
    n.spectrogram_freqs = a.spectrogram_freqs;
  }

  return n;
}

function applyAnalysis(raw, name) {
  const a = normaliseAnalysis(raw);
  analysis = a;

  /* Publish the analysis whole, before anything is derived from it, so a
     reader that wants a block this file ignores gets what the worker wrote. */
  window.StudioAnalysis = raw && typeof raw === 'object' ? raw : null;
  renderMusicalReadouts();

  // Targets travel with the analysis, so master.py stays the single source.
  applyTargets(raw && raw.targets);

  if (isFinite(a.sample_rate)) {
    el.rate.textContent = (a.sample_rate / 1000).toFixed(1) + ' kHz';
    if (!engine.buffer) engine.sampleRate = a.sample_rate;
  }
  if (a.channels) {
    el.chans.textContent = a.channels > 1 ? 'stereo' : 'mono';
    el.mode.textContent = a.channels > 1 ? 'Stereo' : 'Mono';
  }
  if (isFinite(a.duration) && !engine.buffer) el.tDur.textContent = fmtTime(a.duration);
  if (isFinite(a.cutoff_hz) && a.cutoff_hz > 0) cutoffHz = a.cutoff_hz;

  /* Park the needles at the track's representative level so the dials read as
     a measurement of the analysed file rather than sitting dead at rest. */
  const chans = a.rms_db_channels;
  if (chans && chans.length) {
    const meanDb = (arr) => {
      let sum = 0, n = 0;
      for (const v of arr) if (isFinite(v) && v > -60) { sum += v; n++; }
      return n ? sum / n : -60;
    };
    const l = rmsToVu(meanDb(chans[0]));
    const r = rmsToVu(meanDb(chans[1] || chans[0]));
    a._staticVu = [l, r];
  } else if (isFinite(a.integrated_lufs)) {
    const v = rmsToVu(a.integrated_lufs);
    a._staticVu = [v, v];
  }

  /* Peak-hold ticks from the analysed peaks. */
  if (Array.isArray(a.channel_peaks_dbfs) && a.channel_peaks_dbfs.length) {
    const pk = a.channel_peaks_dbfs;
    engine.meters.L.hold = pk[0];
    engine.meters.R.hold = pk[1] !== undefined ? pk[1] : pk[0];
    engine.meters.L.tp = engine.meters.L.hold;
    engine.meters.R.tp = engine.meters.R.hold;
  } else if (isFinite(a.sample_peak_db)) {
    engine.meters.L.hold = engine.meters.R.hold = a.sample_peak_db;
    engine.meters.L.tp = engine.meters.R.tp = a.sample_peak_db;
  }
  if (isFinite(a.true_peak_dbtp)) engine.maxTruePeak = a.true_peak_dbtp;
  if (isFinite(a.correlation)) engine.correlation = a.correlation;
  if (isFinite(a.clip_runs)) engine.overCount = a.clip_runs;

  /* The colour map, drawn whole. */
  if (a.spectrogram && a.spectrogram_shape) {
    const bins = a.spectrogram_layout === 'freq-major'
      ? a.spectrogram_shape[0] : a.spectrogram_shape[1];
    const hzPerBin = a.sample_rate ? (a.sample_rate / 2) / bins : null;
    spectro.drawStatic(a.spectrogram, a.spectrogram_shape, hzPerBin,
      a.spectrogram_layout, a.spectrogram_freqs);
  }

  /* The average spectrum replaces the live curve when nothing is playing. */
  if (Array.isArray(a.average_spectrum) && a.average_spectrum.length) {
    const arr = a.average_spectrum;
    let lo = Infinity, hi = -Infinity;
    for (const v of arr) {
      if (!isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!(hi > lo)) { lo = 0; hi = 1; }
    if (hi - lo > 90) lo = hi - 90;
    freqBytes = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = isFinite(arr[i]) ? arr[i] : lo;
      freqBytes[i] = clamp(Math.round((v - lo) / (hi - lo) * 255), 0, 255);
    }
    /* The spectrum drawing maps bin -> Hz linearly, so when analyze.py hands
       us its own frequency table, tell the drawing the top of that table. */
    if (Array.isArray(a.spectrum_freqs) && a.spectrum_freqs.length === arr.length) {
      staticSpectrumNyquist = a.spectrum_freqs[a.spectrum_freqs.length - 1];
    } else if (a.sample_rate) {
      staticSpectrumNyquist = a.sample_rate / 2;
    }
  }

  const label = a.filename || name;
  el.source.innerHTML = engine.buffer
    ? `<b>${escapeHtml(el.source.textContent.split('\u00b7')[0].trim())}</b>` +
      ' <span style="color:#6f9f72">+ analysis</span>'
    : `<b>${escapeHtml(label)}</b> \u00b7 analysis only, no audio`;

  verdictTick = 19;   // force a verdict refresh on the next frame
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ======================================================== tempo and key ====
 * A worker adds two optional blocks to the analysis JSON:
 *
 *   "tempo": {bpm, confidence, meter, beat_times[]}
 *   "key":   {name, confidence, alternatives[]}
 *
 * Both may be absent, either field inside them may be null, and a confidence
 * figure is a real number that is often low. Everything below reads them
 * defensively: an absent block is an em-dash, and a reading the estimator was
 * not sure of is shown dimmed and marked rather than stated as fact. There is
 * no branch anywhere that invents a number when one is missing.
 * ========================================================================= */

/** Below this, the estimator is guessing and the panel must say so. */
const CONFIDENCE_FLOOR = 0.5;

/** The dash a readout shows when there is nothing to show. Never a zero. */
const NO_VALUE = '—';

/**
 * Pull the tempo block out of either analysis shape.
 * @returns {{bpm:number|null, confidence:number, meter:string|null,
 *            beats:number[], sure:boolean}|null}
 */
function readTempo(raw) {
  const t = raw && typeof raw === 'object' ? raw.tempo : null;
  if (!t || typeof t !== 'object') return null;
  const bpm = Number(t.bpm);
  const conf = Number(t.confidence);
  const beats = Array.isArray(t.beat_times)
    ? t.beat_times.filter((v) => Number.isFinite(Number(v))).map(Number)
    : [];
  /* A block with no usable bpm and no beats carries nothing; treat it as
     absent rather than rendering an empty shell of a reading. */
  if (!Number.isFinite(bpm) && !beats.length) return null;
  return {
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    confidence: Number.isFinite(conf) ? conf : 0,
    meter: typeof t.meter === 'string' && t.meter ? t.meter : null,
    beats,
    sure: Number.isFinite(conf) ? conf >= CONFIDENCE_FLOOR : false,
  };
}

/**
 * Pull the key block out of either analysis shape.
 * @returns {{name:string, confidence:number, alternatives:string[],
 *            sure:boolean}|null}
 */
function readKey(raw) {
  const k = raw && typeof raw === 'object' ? raw.key : null;
  if (!k || typeof k !== 'object') return null;
  const name = typeof k.name === 'string' ? k.name.trim() : '';
  if (!name) return null;
  const conf = Number(k.confidence);
  return {
    name,
    confidence: Number.isFinite(conf) ? conf : 0,
    alternatives: Array.isArray(k.alternatives)
      ? k.alternatives.filter((v) => typeof v === 'string' && v) : [],
    sure: Number.isFinite(conf) ? conf >= CONFIDENCE_FLOOR : false,
  };
}

/**
 * Beats per bar, from the metre string. Only the numerator matters for
 * counting bars, and anything unparseable means we cannot count them at all —
 * which is reported as such, not defaulted to four.
 * @returns {number|null}
 */
function beatsPerBar(meter) {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(String(meter || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 32 ? n : null;
}

/**
 * Bar and beat at a position in seconds.
 *
 * Prefers the measured beat grid when the worker supplied one — a real track
 * drifts, and counting from a single average BPM walks away from the music
 * over a few minutes. Falls back to a constant tempo when only a bpm is known.
 * Returns null when the metre or the tempo is missing, so the caller can print
 * a dash instead of a bar number that means nothing.
 *
 * @param {number} seconds
 * @returns {string|null}  e.g. "9:3"
 */
function barBeatAt(seconds, tempo) {
  if (!tempo || !Number.isFinite(seconds) || seconds < 0) return null;
  const per = beatsPerBar(tempo.meter);
  if (!per) return null;

  let beatIndex = null;

  if (tempo.beats.length >= 2) {
    const beats = tempo.beats;
    const last = beats[beats.length - 1];
    if (seconds < beats[0]) {
      /* Before the first beat we are in the pick-up: bar 1 beat 1, not a
         negative bar. */
      beatIndex = 0;
    } else if (seconds > last) {
      /* Past the end of the supplied grid. A worker may send only the beats it
         was confident about, and the transport still has to count — so carry on
         at the average spacing of the grid rather than sticking on its last
         line, which would freeze the bar counter part-way through the track. */
      const spacing = (last - beats[0]) / (beats.length - 1);
      beatIndex = spacing > 0
        ? beats.length - 1 + Math.floor((seconds - last) / spacing)
        : beats.length - 1;
    } else {
      /* How many grid lines have gone by. */
      let lo = 0, hi = beats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (beats[mid] <= seconds) lo = mid; else hi = mid - 1;
      }
      beatIndex = lo;
    }
  } else if (tempo.bpm) {
    beatIndex = Math.floor(seconds * tempo.bpm / 60);
  }

  if (beatIndex === null) return null;
  const bar = Math.floor(beatIndex / per) + 1;
  const beat = (beatIndex % per) + 1;
  return `${bar}:${beat}`;
}

/* The last analysis object, whole and unmodified, for anything else on the
   page that wants to read a block this file does not itself use. It is the
   raw JSON rather than the normalised record on purpose: a reader after
   `tempo` or `key` wants what the worker wrote, not our flattening of it. */
window.StudioAnalysis = null;

/** The parsed tempo of the loaded analysis, or null. Parsed once, read often. */
let currentTempo = null;

/** Paint one readout cell, marking a low-confidence reading as doubted. */
function setReadout(cell, valueEl, text, sure) {
  if (!valueEl) return;
  valueEl.textContent = text;
  if (cell) cell.classList.toggle('is-unsure', text !== NO_VALUE && sure === false);
}

/** The tempo and key cells. Called when an analysis arrives, not per frame. */
function renderMusicalReadouts() {
  currentTempo = readTempo(window.StudioAnalysis);
  const tempo = currentTempo;
  const key = readKey(window.StudioAnalysis);

  if (tempo && tempo.bpm !== null) {
    setReadout(el.roBpm, el.roBpmV, tempo.bpm.toFixed(1), tempo.sure);
    if (el.roMeter) el.roMeter.textContent = tempo.meter || '';
    if (el.roBpm) {
      el.roBpm.title = `${tempo.bpm.toFixed(1)} BPM` +
        (tempo.meter ? `, ${tempo.meter}` : '') +
        ` · confidence ${tempo.confidence.toFixed(2)}` +
        (tempo.sure ? '' : ' — low, treat as a guess');
    }
  } else {
    setReadout(el.roBpm, el.roBpmV, NO_VALUE, true);
    if (el.roMeter) el.roMeter.textContent = '';
    if (el.roBpm) el.roBpm.title = 'No tempo in this analysis';
  }

  if (key) {
    setReadout(el.roKey, el.roKeyV, key.name, key.sure);
    if (el.roKey) {
      el.roKey.title = `${key.name} · confidence ${key.confidence.toFixed(2)}` +
        (key.alternatives.length ? ` · or ${key.alternatives.join(', ')}` : '') +
        (key.sure ? '' : ' — low, treat as a guess');
    }
  } else {
    setReadout(el.roKey, el.roKeyV, NO_VALUE, true);
    if (el.roKey) el.roKey.title = 'No key in this analysis';
  }
}

/* ---- transport controls ------------------------------------------------ */

/* One key does both jobs, so it has to SAY which job it is offering. A button
   that plays and pauses but always shows a play triangle is the classic
   ambiguity — the glyph must show the action the next click performs. */
function setPlayState(playing) {
  el.play.classList.toggle('is-latched', !!playing);
  el.play.setAttribute('aria-pressed', playing ? 'true' : 'false');
  const glyph = el.play.querySelector('.key-glyph');
  if (glyph) glyph.textContent = playing ? '\u23F8' : '\u25B6';
  const label = playing ? 'Pause' : 'Play';
  el.play.title = label;
  el.play.setAttribute('aria-label', label);
}

/** Enable or disable the whole key gang together. */
function setTransportEnabled(on) {
  for (const k of [el.play, el.rtz]) {
    if (k) k.disabled = !on;
  }
  el.scrub.disabled = !on;
}

el.play.addEventListener('click', () => {
  if (!engine.buffer) return;
  /* The only play/pause control there is; the space bar routes here too. */
  if (engine.playing) { engine.pause(); setPlayState(false); }
  else { engine.play(); setPlayState(true); }
});



/* Back to start keeps whatever the transport was doing: rewind under play
   keeps playing from the top, rewind while stopped stays parked at zero —
   which together with the play/pause toggle is everything the old Stop key
   did, in one fewer control. */
if (el.rtz) el.rtz.addEventListener('click', () => {
  if (!engine.buffer) return;
  engine.seek(0);
  syncTransportDisplay(0);
});

/** Put a known position on the scrub and the timecode without waiting a frame. */
function syncTransportDisplay(t) {
  const dur = engine.duration();
  el.tCur.textContent = fmtTime(t);
  el.scrub.value = dur > 0 ? String((t / dur) * 1000) : '0';
}

engine.onended = () => setPlayState(false);

el.scrub.addEventListener('input', () => {
  if (!engine.buffer) return;
  const t = (Number(el.scrub.value) / 1000) * engine.duration();
  el.tCur.textContent = fmtTime(t);
});

el.scrub.addEventListener('change', () => {
  if (!engine.buffer) return;
  engine.seek((Number(el.scrub.value) / 1000) * engine.duration());
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); el.play.click(); }
  else if (e.code === 'ArrowLeft' && engine.buffer) {
    engine.seek(engine.currentTime() - 5);
  } else if (e.code === 'ArrowRight' && engine.buffer) {
    engine.seek(engine.currentTime() + 5);
  }
});

/* ---- file inputs and drag-and-drop ------------------------------------- */

const AUDIO_RE = /\.(wav|mp3|m4a|aac|flac|ogg|opus|aiff?)$/i;

function routeFile(file) {
  if (/\.json$/i.test(file.name)) loadAnalysisFile(file);
  else if (AUDIO_RE.test(file.name) || file.type.startsWith('audio/')) loadAudioFile(file);
  else el.source.innerHTML =
    `<b>${escapeHtml(file.name)}</b> is not audio or analysis JSON.`;
}

$('#pick-audio').addEventListener('click', () => el.audioInput.click());
$('#pick-json').addEventListener('click', () => el.jsonInput.click());

el.audioInput.addEventListener('change', (e) => {
  if (e.target.files[0]) routeFile(e.target.files[0]);
});
el.jsonInput.addEventListener('change', (e) => {
  if (e.target.files[0]) routeFile(e.target.files[0]);
});

/* Only a drag carrying FILES is a load. The bench also lets panels be dragged
 * around, and although that is a pointer-event drag rather than a native one —
 * so it fires none of these — a text selection dragged across the page does
 * fire them, and used to raise the full-screen "RELEASE TO LOAD" overlay for a
 * drag that could never load anything. `dataTransfer.types` is the reliable
 * test during a drag, because `.files` is deliberately empty until the drop. */
function dragHasFiles(e) {
  const t = e.dataTransfer && e.dataTransfer.types;
  if (!t) return false;
  return Array.prototype.indexOf.call(t, 'Files') >= 0;
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  if (++dragDepth === 1) document.body.classList.add('dropping');
});
window.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); }
});
window.addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const files = Array.from(e.dataTransfer.files || []);
  // Load the JSON last so its readouts win over a freshly decoded file.
  files.filter((f) => !/\.json$/i.test(f.name)).forEach(routeFile);
  files.filter((f) => /\.json$/i.test(f.name)).forEach(routeFile);
});

/* ---- boot --------------------------------------------------------------
   The page opens showing a worked example: a short synthesised passage at
   the shop's own target so every instrument reads a real value on load,
   plainly marked as a demo tone rather than passed off as the user's file. */

function demoAnalysis() {
  const FRAMES = 240, BINS = 128;
  const sr = 48000, nyq = sr / 2, cut = 16000;
  /* freq-major, matching analyze.py: db[f * frames + t] */
  const db = new Float32Array(BINS * FRAMES);
  const freqs = [];
  for (let b = 0; b < BINS; b++) freqs.push((b + 0.5) * nyq / BINS);

  for (let t = 0; t < FRAMES; t++) {
    const phase = t / FRAMES;
    const drive = 0.55 + 0.45 * Math.sin(phase * Math.PI * 2 - Math.PI / 2);
    for (let b = 0; b < BINS; b++) {
      const f = freqs[b];
      let v = -14 - 11 * Math.log10(Math.max(f, 30) / 90);      // spectral tilt
      v += 7 * Math.exp(-Math.pow((Math.log10(f) - Math.log10(220)) / 0.16, 2));
      v += 5 * Math.exp(-Math.pow((Math.log10(f) - Math.log10(2600)) / 0.2, 2));
      v += (Math.sin(t * 0.7 + b * 0.35) + Math.sin(t * 0.21 + b * 1.7)) * 2.1;
      v += 14 * Math.log10(drive);
      if (f > cut) v -= 42 + (f - cut) / 900;                   // the brick wall
      db[b * FRAMES + t] = v;
    }
  }

  const avg = [];
  for (let b = 0; b < BINS; b++) {
    let s2 = 0;
    for (let t = 0; t < FRAMES; t++) s2 += db[b * FRAMES + t];
    avg.push(s2 / FRAMES);
  }

  const rmsL = [], rmsR = [], pkL = [], pkR = [];
  for (let t = 0; t < FRAMES; t++) {
    const phase = t / FRAMES;
    const d = 0.55 + 0.45 * Math.sin(phase * Math.PI * 2 - Math.PI / 2);
    const base = 20 * Math.log10(d);
    rmsL.push(-19.5 + base + Math.sin(t * 0.9) * 0.8);
    rmsR.push(-19.3 + base + Math.cos(t * 0.8) * 0.8);
    pkL.push(-6.4 + base + Math.sin(t * 1.7) * 1.4);
    pkR.push(-6.2 + base + Math.cos(t * 1.5) * 1.4);
  }

  return {
    schema: 'audio-analysis/v1',
    metadata: {
      filename: 'example-analysis.json',
      duration: 206.4, sample_rate: sr, channels: 2,
      bit_depth: 24, subtype: 'PCM_24',
    },
    measures: { rms: -19.4, peak: -0.9, crest_factor: 18.5, sample_peak: 0.9016 },
    loudness: {
      integrated_lufs: -13.2, true_peak_dbtp: -0.6, lra: 8.4,
      max_momentary: -12.1, max_short_term: -12.8,
      gate_threshold_lufs: -23.2, source: 'ffmpeg loudnorm',
    },
    envelopes: {
      points_per_second: 10,
      channels: [
        { rms_db: rmsL, peak_db: pkL },
        { rms_db: rmsR, peak_db: pkR },
      ],
    },
    spectrogram: {
      shape: [BINS, FRAMES],
      layout: 'freq-major: db[f * frames + t]',
      freqs, db: Array.from(db),
    },
    spectrum: { freqs, db: avg },
    codec: {
      cutoff_hz: cut, confidence: 0.82, drop_db: 42,
      nyquist_hz: nyq, lossy_suspected: true,
      verdict: 'lossy source suspected',
    },
    clipping: {
      clipped_samples: 0, clipped_fraction: 0, runs: 0,
      longest_run: 0, clipping_suspected: false, worst: [],
    },
    stereo: {
      stereo: true, correlation: 0.61, mid_rms_db: -19.1,
      side_rms_db: -27.4, side_to_mid_db: -8.3, balance_db: 0.2,
    },
  };
}

/* =============================================================== splitter ==
 * The seam between the question rail and the instrument column. Dragging it
 * moves one custom property on .shell, which is the whole layout contract —
 * no element is measured or resized by hand, so the grid reflows itself and
 * every canvas picks the new width up on its next frame.
 *
 * The chosen width is remembered. localStorage throws outright in a private
 * window, so every access is guarded.
 * ========================================================================= */

const RAIL_KEY = 'music-studio.rail-width';
const RAIL_MIN = 300;
const RAIL_MAX = 680;
const RAIL_DEFAULT = 420;

function readRailWidth() {
  try {
    const v = Number(localStorage.getItem(RAIL_KEY));
    return Number.isFinite(v) && v > 0 ? clamp(v, RAIL_MIN, RAIL_MAX) : RAIL_DEFAULT;
  } catch { return RAIL_DEFAULT; }
}

function writeRailWidth(px) {
  try { localStorage.setItem(RAIL_KEY, String(Math.round(px))); }
  catch { /* nothing to do: the bench still works, it just forgets */ }
}

function setRailWidth(px, persist) {
  const w = clamp(Math.round(px), RAIL_MIN, RAIL_MAX);
  if (el.shell) el.shell.style.setProperty('--rail-w', w + 'px');
  if (el.splitter) el.splitter.setAttribute('aria-valuenow', String(w));
  if (persist) writeRailWidth(w);
  return w;
}

/* The masthead is a FIXED bar pinned to the top of the window, so it is out of
 * flow and reserves no space. Two things therefore have to be handed to CSS:
 *
 *   --masthead-h  the bar's height plus the gap that belongs under it. .shell
 *                 takes this as padding-top, which is what stops the first
 *                 panel and the rail from sliding under the bar.
 *   --rail-top    where the content's top edge sits in the VIEWPORT once the
 *                 page is scrolled — which, for a fixed bar, is simply the
 *                 same number. It is the sticky offset for the question rail
 *                 and the splitter, and the term their height is taken from.
 *
 * Both are measured rather than written as CSS constants because the bar's
 * type is clamp()ed and it wraps at narrow widths.
 *
 * NOTE the ordering trap this replaces: the old version derived the offset
 * from `shell.getBoundingClientRect().top`, which now INCLUDES the padding
 * this same function sets, so each measurement fed the next and the rail
 * walked down the page on every resize. The bar's own height is the only
 * independent term, so it is the only one read. */
function trackMastheadHeight() {
  const head = document.querySelector('.masthead');
  if (!head || !el.shell) return;
  const measure = () => {
    /* Where the shell's left edge actually is. The bar is fixed and so spans
       the whole window, while the shell is centred inside a max-width, so the
       bar has to be told where the bench's first column starts or its own
       columns line up with nothing. Measured rather than derived from 100vw,
       which counts a scrollbar the shell's box does not.

       Set on the ROOT, not the shell: the bar reads it as its own padding, and
       although the bar is a child of .shell today, a value that positions the
       bar must not depend on that staying true. */
    const left = Math.max(0, Math.round(el.shell.getBoundingClientRect().left));
    document.documentElement.style.setProperty('--shell-left', left + 'px');

    /* the grid gap below the bar counts too: the content starts after it */
    const gap = parseFloat(getComputedStyle(el.shell).rowGap) || 0;
    const h = Math.round(head.getBoundingClientRect().height + gap);
    el.shell.style.setProperty('--masthead-h', h + 'px');
    /* A fixed bar occupies the top `h` pixels of the viewport at every scroll
       position, so the first row of content clears it at exactly `h`. No page
       gutter is added: body's top padding sits UNDER the bar and is already
       spent. */
    el.shell.style.setProperty('--rail-top', h + 'px');
  };
  measure();
  window.addEventListener('resize', measure);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(measure).observe(head);
  } else {
    window.addEventListener('resize', measure);
  }
}

function wireSplitter() {
  const bar = el.splitter;
  if (!bar || !el.shell) return;

  setRailWidth(readRailWidth(), false);
  bar.setAttribute('aria-valuemin', String(RAIL_MIN));
  bar.setAttribute('aria-valuemax', String(RAIL_MAX));

  /* Pointer events cover mouse, pen and touch in one path, and capture keeps
     the drag alive when the cursor outruns the 9px seam. */
  let dragging = false;

  const widthFromPointer = (clientX) => {
    const left = el.shell.getBoundingClientRect().left;
    return clientX - left;
  };

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    bar.classList.add('is-dragging');
    document.body.classList.add('is-splitting');
    try { bar.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    e.preventDefault();
  });

  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setRailWidth(widthFromPointer(e.clientX), false);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('is-dragging');
    document.body.classList.remove('is-splitting');
    try { bar.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
    /* Persist once, on release, rather than on every move. */
    writeRailWidth(Number(bar.getAttribute('aria-valuenow')) || RAIL_DEFAULT);
  };

  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);

  /* Double-click returns the seam to where it shipped. */
  bar.addEventListener('dblclick', () => setRailWidth(RAIL_DEFAULT, true));

  /* Keyboard: the arrows nudge, shift coarsens, Home/End go to the stops. */
  bar.addEventListener('keydown', (e) => {
    const cur = Number(bar.getAttribute('aria-valuenow')) || RAIL_DEFAULT;
    const step = e.shiftKey ? 40 : 10;
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + step;
    else if (e.key === 'Home') next = RAIL_MIN;
    else if (e.key === 'End') next = RAIL_MAX;
    else if (e.key === 'Enter' || e.key === ' ') next = RAIL_DEFAULT;
    if (next === null) return;
    e.preventDefault();
    setRailWidth(next, true);
  });
}

/* ======================================================== timed findings ==
 * The analysis log: one row per finding, in time order, each folding open to
 * the longer comment. `renderTimeline(items)` is the only way rows get here;
 * items are {time_s, severity, title, detail}.
 * ========================================================================= */

const SEVERITY_MARK = { ok: '✓', warn: '!', bad: '✗' };

/**
 * Move the transport to a position in the track.
 * Does nothing — quietly, not noisily — when no audio is loaded: a finding can
 * outlive the file it was measured from, and a dead click is better than a
 * thrown exception on a page whose whole job is to keep running.
 * @param {number} seconds
 */
function seekTo(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  if (!engine.buffer) return false;
  const dur = engine.duration();
  if (!(dur > 0)) return false;
  const t = clamp(seconds, 0, dur);
  engine.seek(t);
  el.tCur.textContent = fmtTime(t);
  el.scrub.value = String((t / dur) * 1000);
  return true;
}
window.seekTo = seekTo;

/** The findings currently on screen, so a reset can tell whether to redraw. */
let timelineItems = [];

/**
 * Draw the timed findings.
 * @param {Array<{time_s:number, severity:string, title:string, detail:string}>} items
 */
function renderTimeline(items) {
  const box = el.timeline;
  if (!box) return;

  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => (Number(a && a.time_s) || 0) - (Number(b && b.time_s) || 0));
  timelineItems = list;

  if (!list.length) {
    box.innerHTML =
      '<p class="timeline-empty">No analysis yet — click <b>Analyze</b>.</p>';
    return;
  }

  const seekable = !!engine.buffer && engine.duration() > 0;

  box.innerHTML = list.map((it, i) => {
    const sev = ['ok', 'warn', 'bad'].includes(it.severity) ? it.severity : 'warn';
    const t = Number(it.time_s);
    const stamp = Number.isFinite(t) ? fmtTime(t) : '—:—';
    const detail = it.detail ? String(it.detail) : '';
    const canSeek = seekable && Number.isFinite(t);
    /* The timecode is its own button, a sibling of the fold control rather than
       a child of it: a focusable control nested inside a button is neither
       valid nor reachable by keyboard in the way it looks like it should be. */
    return `
    <div class="finding" data-severity="${sev}" data-index="${i}">
      <div class="finding-row">
        <button type="button" class="finding-time"
                data-seek="${Number.isFinite(t) ? t : ''}"
                data-seekable="${canSeek ? 'yes' : 'no'}"
                title="${canSeek ? 'Move the transport to ' + stamp
                                 : 'Load the audio to jump here'}"
                aria-label="${canSeek ? 'Play from ' + stamp : stamp + ', no audio loaded'}"
                >${stamp}</button>
        <button type="button" class="finding-open" aria-expanded="false"
                aria-controls="finding-detail-${i}">
          <span class="finding-mark" aria-hidden="true">${SEVERITY_MARK[sev]}</span>
          <span class="finding-title">${escapeHtml(it.title || 'Finding')}</span>
          <span class="finding-caret" aria-hidden="true"></span>
        </button>
      </div>
      <p class="finding-detail" id="finding-detail-${i}" hidden>${escapeHtml(detail)}</p>
    </div>`;
  }).join('');
}

/* One delegated listener for the whole list, so re-rendering never leaks
   handlers and a row added later is wired by construction. */
function wireTimeline() {
  const box = el.timeline;
  if (!box) return;

  const jump = (stamp) => {
    const raw = stamp.getAttribute('data-seek');
    if (raw === '' || raw === null) return;
    /* seekTo reports whether it could act; say so rather than pretending. */
    if (!seekTo(Number(raw))) {
      stamp.setAttribute('data-seekable', 'no');
      stamp.title = 'Load the audio to jump here';
    }
  };

  box.addEventListener('click', (e) => {
    const stamp = e.target.closest('.finding-time');
    if (stamp) { jump(stamp); return; }

    const row = e.target.closest('.finding-open');
    if (!row) return;
    const card = row.closest('.finding');
    const detail = card && card.querySelector('.finding-detail');
    if (!detail) return;
    const open = card.classList.toggle('is-open');
    detail.hidden = !open;
    row.setAttribute('aria-expanded', String(open));
  });
}

/* ==================================================================== reset ==
 * Return the bench to rest. Not "stop": every needle goes back to the far left
 * of its arc, every readout to its idle dash, the lamp out, the log empty and
 * the file unloaded — the state the page boots into before anything is
 * measured, rather than the last frame frozen on screen.
 * ========================================================================= */

/* Put every panel back where it ships: one per row, in markup order, nothing
 * collapsed, the rail at its default width. The stored layout is cleared too,
 * so a reload does not quietly restore what was just reset.
 *
 * Saved WORKSPACES are deliberately left alone. They are named work, not
 * accumulated state, and losing them to a button meant for clearing a
 * measurement would be a nasty surprise. */
function resetLayout() {
  try { localStorage.removeItem(LAYOUT_KEY); } catch { /* private window */ }
  try { localStorage.removeItem(COLLAPSE_KEY); } catch { /* ditto */ }
  try { localStorage.removeItem(RAIL_KEY); } catch { /* ditto */ }

  /* One card per row, in the order the markup declares — the arrangement a
     first visit gets. */
  layoutRows = layoutCards().map((section, i) => [layoutId(section, i)]);
  applyLayout(true);

  /* Expand everything: a panel folded away is as much "not default" as one
     moved. */
  document.querySelectorAll('.instruments .unit.is-collapsed').forEach((s) => {
    const btn = s.querySelector('.collapse-btn');
    if (btn) btn.click();
  });

  if (typeof setRailWidth === 'function') setRailWidth(RAIL_DEFAULT);
}

function resetAll() {
  /* --- silence and unload the engine --------------------------------- */
  if (engine.playing) engine.pause();
  engine._teardown();
  engine.buffer = null;
  engine.offset = 0;
  engine.analyser = null;
  engine.loudness = null;
  engine.resetMeters();
  engine.correlation = 0;
  setPlayState(false);

  /* --- the needles: drive them back to rest AND zero the movement -----
     resetMeters() alone only removes the drive; the movement would then swing
     down over its 300 ms. Zeroing x and v as well puts the needle at the peg
     immediately, which is what "rest position" means on a real meter. */
  analysis = null;
  for (const m of [vuL, vuR]) { m.x = VU_MIN; m.v = 0; m._acc = 0; }
  peakLatch = 0;
  el.lamp.classList.remove('lit');

  /* --- spectrum and colour map --------------------------------------- */
  freqBytes = null;
  cutoffHz = 0;
  cutoffStable = 0;
  cutoffHistory.length = 0;
  staticSpectrumNyquist = 0;
  sourceKind = 'none';
  spectro.staticMode = false;
  spectro.clear();

  /* --- readouts back to their idle strings ---------------------------- */
  el.lufsM.textContent = '−∞';
  el.lufsS.textContent = '−∞';
  el.lufsI.textContent = '−∞';
  el.lufsDelta.textContent = `target ${fmtLu(TARGET_LUFS, 1)} LUFS`;
  el.lufsDelta.className = 'delta';
  el.lra.textContent = '—';
  el.cutoffNote.textContent = 'no signal';
  el.cutoffNote.classList.remove('cutoff-flag');

  /* --- transport ------------------------------------------------------ */
  el.tCur.textContent = '0:00';
  el.tDur.textContent = '0:00';
  el.scrub.value = '0';
  setTransportEnabled(false);
  /* The musical readouts belong to the file that was unloaded. */
  window.StudioAnalysis = null;
  renderMusicalReadouts();
  el.source.innerHTML = 'no file loaded';

  /* --- findings and verdicts ------------------------------------------ */
  renderTimeline([]);
  /* Clearing the signature forces the next verdict pass to repaint rather than
     deciding the identical idle HTML means there is nothing to do. */
  el.verdicts.dataset.sig = '';
  verdictTick = 19;

  /* --- the bench itself, back to how it ships ------------------------- *
     Reset means the whole instrument, not only what it was measuring. A
     rearranged bench with every readout blanked is a half-reset: the state
     you can SEE is gone while the state you arranged silently persists, and
     the next load inherits a layout you may have been experimenting with. */
  resetLayout();

  /* Draw one frame at rest immediately. The loop would get there on its own,
     but only after the needles had visibly fallen from wherever they froze. */
  drawRestFrame();
}

/** Paint the instruments once, at rest, without waiting for the loop. */
function drawRestFrame() {
  const bridgeW = el.vuL.parentElement.clientWidth - 14;
  drawVu(el.vuL, 'Left', VU_MIN, false, bridgeW);
  drawVu(el.vuR, 'Right', VU_MIN, false, bridgeW);
  drawBars(el.bars, [
    { name: 'L', db: BAR_MIN_DB, hold: -Infinity },
    { name: 'R', db: BAR_MIN_DB, hold: -Infinity },
  ], el.bars.parentElement.clientWidth);
  drawCorrelation(el.corr, 0, el.corr.parentElement.clientWidth);
  const specW = el.spectrum.parentElement.clientWidth;
  drawSpectrum(el.spectrum, null, engine.sampleRate / 2, 0, specW);
  spectro.render(specW, 0, -1);
}

function wireReset() {
  if (el.reset) el.reset.addEventListener('click', resetAll);
}

/* The Analyze button in the Analysis title row. When a server is listening it
 * runs the same one-click pipeline as the transport's button; opened from
 * file:// there is nothing to run, so it says so in the list rather than
 * failing silently. */
function wireAnalyzeRun() {
  const btn = el.analyzeRun;
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (server.live && server.commands.studio) { analyseNow(); return; }
    renderTimeline([{
      time_s: 0,
      severity: 'warn',
      title: 'No analyser reachable from this page',
      detail: 'A page opened straight off the disk cannot run anything. ' +
              'Serve the studio with serve.py, or run analyze.py in the ' +
              'terminal and drop its JSON onto this page.',
    }]);
  });
}

/* =============================================================== collapse ==
 * Every instrument card folds away. The control is added in script rather than
 * markup so a new card gets one for free, but every card now carries its own
 * engraved title in the markup: a folded drawer that does not say what is
 * inside it is a drawer you have to open to identify, which defeats folding.
 *
 * Collapsed state is per card and remembered, so a bench arranged for one job
 * is still arranged that way next time. localStorage can throw outright in a
 * private window, so every access is guarded.
 * ========================================================================= */

const COLLAPSE_KEY = 'music-studio.collapsed';

function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
  } catch { return new Set(); }
}

function writeCollapsed(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); }
  catch { /* nothing to do: the bench still works, it just forgets */ }
}

/* The key a panel's collapsed state is stored under.
 *
 * Deliberately NOT the visible title: two panels can legitimately carry the
 * same name (there is a built-in "Spectrum" card and a tray meter also called
 * Spectrum), and keying on text would make folding one fold the other. A
 * renamed panel would also silently lose its saved state. `data-card-id` is
 * stable across both; the title is only a fallback for older markup. */
function cardName(section, i) {
  const id = section.dataset.cardId;
  if (id) return id;
  const h = section.querySelector('.unit-title h2');
  return h ? h.textContent.trim() : (section.getAttribute('aria-label') || `card-${i}`);
}

function wireCollapse() {
  const saved = readCollapsed();
  const cards = document.querySelectorAll('.instruments .unit');

  cards.forEach((section, i) => {
    /* A panel can opt out. The Transport does: it is the control surface for
       everything below it, and a control surface you can fold away is one you
       have to go looking for at the moment you need it most. The body wrapper
       is skipped too — with no control to hide it there is nothing to wrap. */
    if (section.hasAttribute('data-no-collapse')) return;

    const id = cardName(section, i);

    /* Wrap everything under the title (or everything, when there is no title)
       so one element can be hidden without disturbing the header row. */
    const title = section.querySelector('.unit-title');
    const body = document.createElement('div');
    body.className = 'unit-body';
    const move = [...section.children].filter(c => c !== title);
    move.forEach(c => body.appendChild(c));
    section.appendChild(body);

    let head = title;
    if (!head) {
      /* A card with no title in the markup is a mistake rather than a style:
         give it a visible engraved name from its own aria-label so the folded
         drawer is still identifiable, instead of a blank bar. */
      head = document.createElement('div');
      head.className = 'unit-title';
      head.innerHTML = `<h2>${escapeHtml(id)}</h2>`;
      section.insertBefore(head, body);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'collapse-btn';
    btn.setAttribute('aria-controls', `card-body-${i}`);
    body.id = `card-body-${i}`;

    const apply = (collapsed) => {
      section.classList.toggle('is-collapsed', collapsed);
      body.hidden = collapsed;
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = (collapsed ? 'Expand ' : 'Collapse ') + id;
      btn.setAttribute('aria-label', btn.title);
    };

    apply(saved.has(id));

    btn.addEventListener('click', () => {
      const next = !section.classList.contains('is-collapsed');
      apply(next);
      const now = readCollapsed();
      if (next) now.add(id); else now.delete(id);
      writeCollapsed(now);
      /* No canvas fix-up needed on expand: every draw call re-fits its own
         canvas from the current box, and the render loop never stops. */
    });

    head.appendChild(btn);
  });
}

/* ===================================================================== ask ==
 * The conversational layer. A file:// page cannot hold an API key and cannot
 * reach a model, so this composes the exact `music advise` command and shows
 * an answer when the CLI has already produced one (music scope --open embeds
 * it as window.PRELOADED_ADVICE). The measurements stay the shared ground:
 * whatever the model says, it said it about the numbers on this page.
 * ========================================================================= */

function askTrackHint() {
  const p = (analysis && analysis.path) || window.PRELOADED_NAME || '';
  const m = String(p).match(/tracks\/([^/]+)/);
  return m ? m[1] : '<track>';
}

function composeAskCommand(question) {
  const track = askTrackHint();
  const q = (question || '').trim();
  return q
    ? `music advise ${track} --ask ${JSON.stringify(q)}`
    : `music advise ${track}`;
}

/* Served by serve.py, or opened straight off the disk? Everything that runs a
 * command is gated on this. Opened from file:// the panel still composes
 * commands to paste, exactly as before. */
const server = { live: false, readOnly: true, root: null, commands: {} };

async function detectServer() {
  if (!location.protocol.startsWith('http')) return;
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (!r.ok) return;
    const h = await r.json();
    server.live = true;
    server.readOnly = !!h.read_only;
    server.root = h.root;
    server.commands = h.commands || {};
  } catch { /* no server: the compose-only path stays correct */ }
  const note = document.getElementById('ask-note');
  if (note && server.live) {
    note.textContent = server.readOnly
      ? 'connected · read-only'
      : 'connected · writes ask first';
  }
}

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

/* Parse a `music ...` line out of the model's answer into something the API
 * can take. Only the commands the server actually exposes are offered; a line
 * mentioning anything else stays text you can read but not run. */
function parseMusicCommand(line) {
  const parts = line.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  if (parts[0] !== 'music' && parts[0] !== 'music.py') return null;
  const name = parts[1];
  if (!server.commands[name]) return null;

  const options = {};
  const allowed = server.commands[name].options || {};
  for (let i = 2; i < parts.length; i++) {
    const tok = parts[i].replace(/^"|"$/g, '');

    /* Anything that is not a flag is a positional. The API takes named options
       only, so a positional means this line does not describe a call we can
       make — and it is usually a placeholder like <track> that points at no
       real file. Offering to run it would be offering to master nothing. */
    if (!tok.startsWith('--')) return null;

    if (!(tok in allowed)) return null;              // an unknown flag: do not offer
    if (allowed[tok] === 'flag') { options[tok] = true; continue; }
    const val = (parts[i + 1] || '').replace(/^"|"$/g, '');
    if (!val || val.startsWith('--')) return null;
    if (/[<>]/.test(val)) return null;               // a placeholder, not a path
    options[tok] = val;
    i++;
  }
  /* A command with no options at all would run on defaults we never showed. */
  return Object.keys(options).length ? { command: name, options } : null;
}

/* ---- the transcript ----------------------------------------------------
 * A conversation, not a command composer. Every turn is appended; nothing is
 * ever rebuilt from scratch, so the history stands and the scroll position
 * means something. The turns are also kept as data for the session, so a
 * later question reads in the context of the ones before it.
 * ------------------------------------------------------------------------ */

/** The session's turns: {role:'user'|'assistant'|'system', text:string}. */
const chatLog = [];

/** True once the "not connected" notice has been said, so it is said once. */
let saidOffline = false;

function askOut() { return document.getElementById('ask-out'); }

/** Scroll the transcript to the newest turn. */
function scrollChat() {
  const out = askOut();
  if (out) out.scrollTop = out.scrollHeight;
}

/**
 * Append one turn.
 * @param {'user'|'assistant'|'system'} role
 * @param {string} html        already-safe markup for the bubble
 * @param {string} [variant]   an extra modifier class, e.g. 'error'
 * @returns {HTMLElement} the turn element, so a placeholder can be replaced
 */
function appendTurn(role, html, variant) {
  const out = askOut();
  if (!out) return null;
  const turn = document.createElement('div');
  turn.className = `turn turn--${role}` + (variant ? ` turn--${variant}` : '');
  const who = role === 'user' ? 'You' : role === 'assistant' ? 'Studio' : '';
  turn.innerHTML =
    (who ? `<span class="turn-who">${who}</span>` : '') +
    `<div class="turn-body">${html}</div>`;
  out.appendChild(turn);
  scrollChat();
  return turn;
}

/** A turn from the operator. Plain text, escaped. */
function chatUser(text) {
  chatLog.push({ role: 'user', text });
  appendTurn('user', `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`);
}

/** A turn from the model. Markdown-formatted, and any runnable command wired. */
function chatAssistant(text, variant, undoBands) {
  chatLog.push({ role: 'assistant', text });
  const turn = appendTurn('assistant', formatAdvice(text), variant);
  if (turn) wireRunnableCommands(turn);

  /* An EQ move applied without asking needs a way back, and it has to be right
     here in the turn that made it — not somewhere in the panel. */
  if (turn && undoBands) {
    const bar = document.createElement('div');
    bar.className = 'ask-actions';
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'ask-run';
    undo.textContent = 'Undo';
    undo.addEventListener('click', () => {
      window.StudioEq = window.StudioEq || {};
      window.StudioEq.bands = undoBands;
      window.dispatchEvent(new CustomEvent('studio-eq-restore',
        { detail: { bands: undoBands } }));
      undo.disabled = true;
      undo.textContent = 'Undone';
    }, { once: true });
    bar.appendChild(undo);
    turn.appendChild(bar);
  }

  scrollChat();
  return turn;
}

/** The page speaking about itself: not connected, no file, and so on. */
function chatSystem(text, extraHtml) {
  chatLog.push({ role: 'system', text });
  appendTurn('system', `<p>${escapeHtml(text)}</p>` + (extraHtml || ''));
}

/** Three lamps, until the reply lands. Returns the element to replace. */
function chatThinking() {
  return appendTurn('assistant',
    '<span class="think-dot"></span><span class="think-dot"></span>' +
    '<span class="think-dot"></span>', 'thinking');
}

/**
 * Offer the CLI as a fallback — a command to copy and run elsewhere. This is
 * never the answer to a question; it is what to do when the page cannot ask
 * one on your behalf.
 */
function fallbackCommandHtml(question) {
  const cmd = composeAskCommand(question);
  return `<pre class="ask-cmd"><code>${escapeHtml(cmd)}</code></pre>` +
    '<div class="ask-actions">' +
    `<button type="button" class="ask-copy" data-copy="${escapeHtml(cmd)}">Copy command</button>` +
    '</div>';
}

/* One delegated handler for every Copy button the transcript ever grows. */
function wireCopyButtons() {
  const out = askOut();
  if (!out) return;
  out.addEventListener('click', (e) => {
    const btn = e.target.closest('.ask-copy[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    const done = (msg) => {
      btn.textContent = msg;
      setTimeout(() => { btn.textContent = 'Copy command'; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done('Copied'),
                                               () => done('Copy failed'));
    } else {
      done('Copy failed');
    }
  });
}

/* Any `music ...` line inside an answer gets a Run button, provided the server
 * exposes that command and every flag in it. Writes go through confirm first. */
function wireRunnableCommands(scope) {
  if (!server.live || !scope) return;
  scope.querySelectorAll('.ask-cmd').forEach(pre => {
    const parsed = parseMusicCommand(pre.textContent || '');
    if (!parsed) return;
    const writes = !!(server.commands[parsed.command] || {}).writes;
    if (writes && server.readOnly) return;

    const bar = document.createElement('div');
    bar.className = 'ask-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ask-run' + (writes ? ' ask-run--writes' : '');
    btn.textContent = writes ? 'Run (writes audio)' : 'Run';
    btn.addEventListener('click', () => runCommand(parsed, btn));
    bar.appendChild(btn);
    pre.after(bar);
  });
}

/* The machine's own log of what actually ran: a running turn at the foot of
   the conversation, so a command's output sits in time order with the words
   around it rather than in a separate box that has to be found. A fresh turn
   is started whenever something else has spoken since the last line. */
function transcript() {
  const out = askOut();
  if (!out) return null;
  let t = out.lastElementChild && out.lastElementChild.querySelector
    ? out.lastElementChild.querySelector('.ask-log') : null;
  if (!t) {
    const turn = appendTurn('assistant', '<div class="ask-log"></div>', 'log');
    t = turn ? turn.querySelector('.ask-log') : null;
  }
  return t;
}

function logLine(text, kind = '') {
  const t = transcript();
  if (!t) return null;
  const p = document.createElement('pre');
  p.className = 'ask-log-line' + (kind ? ' is-' + kind : '');
  p.textContent = text;
  t.appendChild(p);
  scrollChat();
  return p;
}

async function runCommand(parsed, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  try {
    const plan = await api('/api/prepare', parsed);

    if (plan.confirm) {
      /* A command that writes is shown exactly as it will run, and waits. */
      const ok = window.confirm(
        'This will write audio.\n\n' + plan.display +
        '\n\nRun it?'
      );
      if (!ok) { btn.disabled = false; btn.textContent = label; return; }
      parsed.confirm = plan.confirm;
    }

    btn.textContent = 'Running…';
    logLine('$ ' + plan.display, 'cmd');
    const res = await api('/api/run', parsed);
    if (res.stderr.trim()) logLine(res.stderr.trim());
    if (res.stdout.trim()) logLine(res.stdout.trim());
    logLine(res.returncode === 0
      ? `done in ${res.seconds}s`
      : `exit ${res.returncode} after ${res.seconds}s`,
      res.returncode === 0 ? 'ok' : 'bad');
  } catch (err) {
    logLine(String(err.message || err), 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/**
 * Send one question and put the reply in the transcript.
 *
 * The question always goes to the model, with or without an analysis: a
 * general question about mastering does not need a file, and advise.py is
 * content with a missing --analysis. If the server refuses anyway, the refusal
 * is shown as what it is — an answer that did not come — inside the
 * conversation, never as a command box pretending to be a reply.
 *
 * @param {string} question
 */
/* ---- tone requests go to the equaliser, not the advisor ---------------- *
 *
 * "more highs" and "cut the hum" are instructions to the EQ, not questions
 * about the measurements. Routing everything to `advise` meant the chat
 * answered a request to DO something with an explanation of how to do it
 * yourself — which is what it was built to avoid.
 *
 * The test is deliberately conservative: a sentence must both name a tonal
 * move and read as an instruction. Anything ambiguous stays with the advisor,
 * because a wrong answer there costs a paragraph, while a wrong EQ move costs
 * a surprise change to what you are hearing. */
/* Stems, not exact words: 'boxy' and 'boxiness' are the same request, and
 listing every inflection by hand is how one of them gets missed. */
const TONE_WORDS = /\b(bass|low|lows|sub|bottom|bod(y|ies)|warm\w*|boom\w*|mud\w*|box\w*|honk\w*|mid|mids|midrange|presen\w*|high|highs|top|treble|bright\w*|brillian\w*|air|airy|sheen|harsh\w*|sibilan\w*|ess|hiss\w*|hum|buzz\w*|rumbl\w*|thin\w*|dull\w*|dark\w*|muffl\w*|sharp\w*|crisp\w*|shrill\w*|nasal|tinny|woolly|cloud\w*)\b/i;
const TONE_VERBS = /\b(add|more|less|boost|lift|raise|increase|cut|reduce|lower|drop|dip|remove|clean|clear|tame|soften|roll ?off|notch|attenuate|brighten|darken|warm up|open up|eq)\b/i;
const QUESTIONY = /^(what|why|how|is|are|does|do|should|can|could|would|when|which|who)\b|\?\s*$/i;

function isToneRequest(text) {
const s = String(text || '').trim();
if (!s || QUESTIONY.test(s)) return false;
if (!TONE_WORDS.test(s)) return false;

/* A verb is the clearest signal, but it is not required. "a bit mid-hi" is
   plainly an instruction to the equaliser and has no verb at all; demanding
   one sent it to the advisor, which can only describe commands — so the user
   asked for a change and got a lecture.
   
   A short phrase built around a tone word IS the request. Anything longer is
   probably a sentence about the track rather than an instruction to it, so
   it still needs a verb to qualify. */
if (TONE_VERBS.test(s)) return true;
const words = s.split(/\s+/).filter(Boolean);
return words.length <= 5;
}

/* Set when a turn applies EQ, cleared by any other kind of reply. Declared
 * before isEqFollowUp reads it: `let` has a temporal dead zone, so a call that
 * runs before the declaration throws rather than seeing undefined. */
let lastTurnMovedEq = false;

/* "more", "again", "a bit less" — a short follow-up with no tone word of its
 * own, which only means anything because of the turn before it. Treated as a
 * tone request ONLY when the last thing the studio did was move the EQ, so a
 * bare "more" after an explanation still goes to the advisor. */
const FOLLOW_UP = /^(more|less|again|a bit more|a bit less|bit more|bit less|harder|softer|stronger|weaker|too much|not enough|keep going|further)\b[\s.!]*$/i;

function isEqFollowUp(text) {
if (!lastTurnMovedEq) return false;
return FOLLOW_UP.test(String(text || '').trim());
}



/* Apply what eqchat.py returned, and say what changed in plain terms. The
 * bands are already validated server-side; this only has to place them. */
function applyChatEq(payload, question) {
const bands = (payload && payload.bands) || [];
if (!bands.length) {
  chatAssistant(payload && payload.summary
    ? payload.summary
    : 'No EQ change for that — try naming a frequency range.');
  return;
}

/* Remember the previous setting so the move can be taken back. Undo is what
   makes applying-without-asking reasonable: the EQ is an audition, and a
   wrong move should cost one click. */
const before = JSON.parse(JSON.stringify((window.StudioEq && window.StudioEq.bands) || []));
const next = payload.replace ? bands.slice() : mergeEqBands(before, bands);

window.StudioEq = window.StudioEq || {};
window.StudioEq.bands = next;
window.dispatchEvent(new CustomEvent('studio-eq-restore', { detail: { bands: next } }));

const lines = bands.map(b => {
  const hz = b.freq >= 1000 ? (b.freq / 1000).toFixed(1) + ' kHz' : Math.round(b.freq) + ' Hz';
  const g = b.type === 'peaking' || b.type === 'lowshelf' || b.type === 'highshelf'
    ? `  ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB` : '';
  return `• ${b.type} ${hz}${g}  Q ${b.q}`;
}).join('\n');

chatAssistant((payload.summary ? payload.summary + '\n\n' : '') + lines, 'eq', before);
}

/* Merge a returned band into what is already set.
 *
 * Matching on id alone does not work: the model returns bands with no id, so
 * "more" produced a SECOND 8 kHz shelf stacked on the first rather than
 * raising it. Two shelves is a different sound from one shelf turned up, and
 * nothing on screen said it had happened.
 *
 * So match on what makes two bands the same filter — the same type at
 * substantially the same frequency. A third of an octave is the tolerance:
 * wide enough to catch 8000 against 8200, tight enough that a deliberate pair
 * at 3 kHz and 5 kHz stays two bands. */
function sameBand(a, b) {
  if (a.type !== b.type) return false;
  const lo = Math.min(a.freq, b.freq), hi = Math.max(a.freq, b.freq);
  return lo > 0 && hi / lo < 1.26;
}

function mergeEqBands(current, incoming) {
  const out = current.slice();
  for (const b of incoming) {
    let i = b.id ? out.findIndex(x => x.id === b.id) : -1;
    if (i < 0) i = out.findIndex(x => sameBand(x, b));
    if (i >= 0) out[i] = Object.assign({}, out[i], b, { id: out[i].id });
    else out.push(Object.assign({ id: 'chat-' + Math.random().toString(36).slice(2, 7) }, b));
  }
  return out;
}


async function askServer(question) {
  const thinking = chatThinking();
  const drop = () => { if (thinking && thinking.parentNode) thinking.remove(); };

  /* A path if we have one, and no invention if we do not. */
  const path = (analysis && analysis.analysisPath) || window.PRELOADED_PATH || null;
  const options = { '--ask': question };
  if (path) options['--analysis'] = path;

  const tone = isToneRequest(question) || isEqFollowUp(question);
  if (tone) {
    /* Send what is already set, so the equaliser EDITS rather than starting
       from flat. Without this, "more" cannot mean "more of what you just did"
       — the model has no idea anything was done. */
    const now = (window.StudioEq && window.StudioEq.bands) || [];
    if (now.length) options['--bands-json'] = JSON.stringify(now);
  }

  try {
    const res = await api('/api/run',
      { command: tone ? 'eq' : 'advise', options });
    if (tone) {
      drop();
      let payload = null;
      try { payload = JSON.parse((res.stdout || '').trim().split('\n').pop()); }
      catch { /* fall through to the error path below */ }
      if (res.returncode === 0 && payload && !payload.error) {
        lastTurnMovedEq = (payload.bands || []).length > 0;
        applyChatEq(payload, question);
      } else {
        chatAssistant((payload && payload.error) ||
          (res.stderr || 'The equaliser returned nothing.').trim(), 'error');
      }
      return;
    }
    drop();
    const text = (res.stdout || '').trim();
    if (res.returncode === 0 && text) {
      lastTurnMovedEq = false;   // an explanation, not a move
      chatAssistant(text);
    } else {
      /* The command ran and had nothing to say, or said it on stderr. Either
         way it is the model's turn that failed, so it is reported in the
         model's place in the conversation. */
      const why = (res.stderr || res.stdout || '').trim();
      chatAssistant(
        why || 'The advisor returned nothing. Check the server log.', 'error');
      if (!path) {
        chatSystem('No analysis is loaded, so that question was answered ' +
          'without the measurements. Load one for an answer about this track.');
      }
    }
  } catch (err) {
    drop();
    chatAssistant(String((err && err.message) || err), 'error');
  } finally {
    drop();
    scrollChat();
  }
}

/**
 * Handle one message from the composer: the user's bubble goes up at once,
 * then either the server answers or the page explains why it cannot.
 */
function sendMessage(text) {
  const q = String(text || '').trim();
  if (!q) return;
  chatUser(q);

  if (server.live && server.commands.advise) {
    askServer(q);
    return;
  }

  /* Offline. Say so once, then hand over the command as a fallback — the
     conversation stays the shape it is, and the CLI is the way out of it
     rather than the substance of the reply. */
  if (!saidOffline) {
    saidOffline = true;
    chatSystem('Not connected — start `music serve` to chat here.');
  }
  appendTurn('assistant',
    '<p>I cannot reach a model from this page. Run this in the terminal ' +
    'to ask it:</p>' + fallbackCommandHtml(q), 'error');
  chatLog.push({ role: 'assistant', text: composeAskCommand(q) });
  scrollChat();
}

/* Minimal markdown: the model replies with **bold** and ``` blocks. */
function formatAdvice(text) {
  const parts = String(text).split(/```(?:\w+)?\n?/);
  return parts.map((chunk, i) => {
    if (i % 2 === 1) return `<pre class="ask-cmd"><code>${escapeHtml(chunk.trim())}</code></pre>`;
    return escapeHtml(chunk)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .split(/\n{2,}/).filter(Boolean).map(p => `<p>${p.replace(/\n/g, ' ')}</p>`).join('');
  }).join('');
}

/* ============================================================== one click ==
 * Analyse, report, advise — in a single action.
 *
 * A browser never learns where a dropped file lives on disk, so the button
 * cannot work from the file input alone. When served, it asks for a path
 * relative to the server's root; the server resolves it, refuses anything
 * outside, and runs the whole pipeline in one call.
 * ========================================================================= */

function currentTrackPath() {
  /* Prefer a path we were told about; fall back to the loaded file's name,
     which is usually right when the root is the track's own folder. */
  if (window.PRELOADED_PATH) {
    return String(window.PRELOADED_PATH).replace(/analysis\.json$/, '') || null;
  }
  return (analysis && analysis.filename) || null;
}

/* ---- the auto latch ----------------------------------------------------
   Whether loading a file should analyse it without being asked. Remembered
   between sessions; localStorage throws outright in a private window, so both
   ends are guarded and the bench simply forgets rather than failing. */

const AUTO_KEY = 'music-studio.analyse-auto';

function readAutoAnalyse() {
  try { return localStorage.getItem(AUTO_KEY) === '1'; }
  catch { return false; }
}

function writeAutoAnalyse(on) {
  try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); }
  catch { /* nothing to do: the setting just does not survive the session */ }
}

/**
 * Run the offline analysis.
 * @param {string} [pathHint]  a path to use instead of asking for one
 * @param {boolean} [silent]   true when the run was triggered by a load rather
 *                             than a click: never put up a prompt in that case,
 *                             because an automatic action must not block on a
 *                             dialogue nobody asked for.
 */
async function analyseNow(pathHint, silent) {
  const btn = el.analyseNow;
  if (!btn) return;
  if (btn.dataset.running === '1') return;       // one run at a time

  if (!server.live || !server.commands.studio) {
    chatSystem('Not connected — start `music serve` to analyse from this page.');
    return;
  }

  let rel = pathHint || '';
  if (!rel) {
    if (silent) return;
    rel = window.prompt(
      'Path to the audio file, relative to the server root:',
      currentTrackPath() || '') || '';
  }
  if (!rel) return;

  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  btn.dataset.running = '1';
  btn.disabled = true;
  btn.classList.add('is-running');
  btn.textContent = 'Analysing…';
  btn.setAttribute('aria-busy', 'true');
  logLine('$ studio --in ' + rel, 'cmd');

  try {
    const res = await api('/api/run', {
      command: 'studio',
      options: { '--in': rel },
    });
    let payload = null;
    try { payload = JSON.parse((res.stdout || '').trim().split('\n').pop()); }
    catch { /* fall through to the raw output below */ }

    if (!payload || !payload.ok) {
      logLine((payload && payload.error) || res.stderr || 'analysis failed', 'bad');
      return;
    }

    logLine(payload.headline, payload.verdicts.some(v => v.severity === 'bad') ? 'bad' : 'ok');
    for (const v of payload.verdicts) {
      logLine(`${v.severity === 'bad' ? '✗' : v.severity === 'warn' ? '!' : '✓'} ${v.title}`,
              v.severity === 'ok' ? 'ok' : v.severity === 'bad' ? 'bad' : '');
    }
    /* The same findings, on the Analysis panel's timed list. A verdict without
       a time is still worth showing, so it lands at 0:00 rather than being
       dropped for want of a timestamp. */
    renderTimeline(payload.verdicts.map((v) => ({
      time_s: Number.isFinite(v.time_s) ? v.time_s
        : (Number.isFinite(v.time) ? v.time : 0),
      severity: v.severity,
      title: v.title,
      detail: v.detail || v.body || v.message || '',
    })));
    for (const [k, p] of Object.entries(payload.files)) logLine(`${k}: ${p}`);

    /* The advice that came with the run is a turn in the conversation, appended
       after the log it belongs to. Nothing is rebuilt, so nothing is lost. */
    if (payload.advice) {
      window.PRELOADED_ADVICE = payload.advice;
      chatAssistant(String(payload.advice));
    }
    /* Put the analysis we just produced onto the meters, so the page and the
       transcript never disagree about the same file. The server serves only
       its own directory, so the JSON is fetched through the command channel
       rather than by URL. */
    try {
      const rendered = await fetch('/api/analysis?path=' +
        encodeURIComponent(payload.files.analysis));
      if (rendered.ok) {
        applyAnalysis(await rendered.json(), rel.split('/').pop());
        logLine('meters updated', 'ok');
      }
    } catch { /* the reports are written either way */ }
  } catch (err) {
    logLine(String(err.message || err), 'bad');
  } finally {
    btn.dataset.running = '';
    btn.disabled = false;
    btn.classList.remove('is-running');
    btn.textContent = label;
    btn.removeAttribute('aria-busy');
  }
}

function wireAnalyseButton() {
  const btn = el.analyseNow;
  if (btn) {
    btn.dataset.label = btn.textContent;
    btn.addEventListener('click', () => analyseNow());
  }

  const auto = el.analyseAuto;
  if (auto) {
    auto.checked = readAutoAnalyse();
    auto.addEventListener('change', () => writeAutoAnalyse(auto.checked));
  }
}

/** Called after a file loads. Runs the analysis only if the latch is down. */
function maybeAutoAnalyse(name) {
  if (!el.analyseAuto || !el.analyseAuto.checked) return;
  if (!server.live || !server.commands.studio) return;
  /* A browser never learns where a dropped file lives, so the name is the best
     guess available and is only right when the server root is the track's own
     folder. When it is wrong the server refuses the path and says so — which
     is the correct outcome, and better than a dialogue on every load. */
  analyseNow(name, true);
}

function wireAsk() {
  const input = document.getElementById('ask-input');
  const go = document.getElementById('ask-go');
  const chips = document.getElementById('ask-chips');
  const presets = document.getElementById('ask-presets');
  if (!input || !go) return;

  wireCopyButtons();

  const send = () => {
    const q = input.value;
    if (!q.trim()) return;
    input.value = '';
    sendMessage(q);
  };

  go.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  /* A preset is a question, so it is sent as one — it does not fill the box
     and wait, and it certainly does not compose a command. */
  if (chips) {
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (!b) return;
      const q = b.dataset.q || b.textContent.trim();
      if (presets) presets.open = false;
      sendMessage(q);
    });
  }

  /* The opening line: what this conversation is grounded in. */
  chatSystem('Ask about the measurements on this bench. The model reads the ' +
    'numbers, not the audio.');

  /* An answer the CLI already produced (music scope --open embeds it) opens
     the conversation rather than sitting in a box of its own. */
  if (window.PRELOADED_ADVICE) chatAssistant(String(window.PRELOADED_ADVICE));
}

/* ================================================================= layout ==
 * The bench as a set of rows. A row holds one, two or three panels; the panels
 * in a row share its width evenly. Dragging a panel by its title bar moves it;
 * dropping on the left or right edge of another panel joins that panel's row,
 * dropping above or below opens a new full-width row.
 *
 * THE DOM STAYS FLAT. Every panel is a direct child of `.instruments` and a
 * row is expressed only as a span on each panel — never as a wrapper element.
 * This is forced by meters.js, whose `applyArrangement()` does
 * `state.container.appendChild(section)` for each meter on every tray edit: a
 * panel nested in a row wrapper would be pulled straight back out to be a
 * direct child the first time somebody switched a meter on or off, silently
 * dismantling the layout. Flat, that same appendChild is only a reorder, and
 * the observer below re-derives the spans from the new document order.
 *
 * So the model is: an ORDER (the document order of the panels) plus a set of
 * ROW BREAKS. `rows` is the canonical form — an array of arrays of card ids —
 * and the DOM is written from it, never read as the source of truth except
 * when reconciling panels that appeared from elsewhere.
 * ========================================================================= */

const MAX_PER_ROW = 3;
const SPAN_FOR = { 1: 12, 2: 6, 3: 4 };

/* Panels that do not exist when this file boots but are expected to arrive:
 * meters.js mounts these five into `.instruments` on its own DOMContentLoaded
 * handler, which runs after ours. A saved layout naming them must survive the
 * window in which they are absent — see the note in reconcileRows(). Kept as a
 * plain list rather than read from window.StudioMeters, because at boot that
 * global does not exist yet either; METER_IDS below is the same set and is
 * asserted against the live registry once meters.js has mounted. */
const LAYOUT_EXPECTED = new Set([
  'loudness-time', 'goniometer', 'spectrum', 'dynamics', 'equalizer',
]);

/* The working layout, autosaved on every change. This is what survives a plain
 * reload; a named workspace is a separate, deliberate save. */
const LAYOUT_KEY = 'music-studio.layout';

/** Every panel on the bench, in document order. */
function layoutCards() {
  const host = document.querySelector('.instruments');
  if (!host) return [];
  return [...host.children].filter(
    (n) => n.classList && n.classList.contains('unit'));
}

/** The stable id a panel is tracked by — the same key collapse already uses,
 *  so a workspace and a folded state always agree about which card is which. */
function layoutId(section, i) {
  return cardName(section, i);
}

/** id -> element, for the panels currently on the bench. */
function cardMap() {
  const m = new Map();
  layoutCards().forEach((s, i) => m.set(layoutId(s, i), s));
  return m;
}

/* The canonical layout: an array of rows, each an array of card ids. Starts
 * empty and is filled by the first reconcile, which runs once the panels
 * (including the ones meters.js mounts) are in the document. */
let layoutRows = [];

function readLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    return normaliseRows(raw && raw.rows);
  } catch { return []; }
}

function writeLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ rows: layoutRows }));
  } catch { /* a private window forgets the arrangement; it still works */ }
}

/** Coerce anything claiming to be a row list into a sane one: arrays of
 *  strings, no empties, no row longer than three, no id twice. */
function normaliseRows(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const clean = [];
    for (const id of row) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      clean.push(id);
      if (clean.length === MAX_PER_ROW) break;
    }
    if (clean.length) out.push(clean);
  }
  return out;
}

/** Drop ids that are no longer on the bench and give every panel that is on it
 *  but missing from the layout a full-width row of its own, at the end. This is
 *  what makes the layout survive meters.js adding, hiding or reordering cards,
 *  and what makes a workspace saved before a new meter existed still load. */
function reconcileRows(rows, cards) {
  const present = new Set(cards.keys());
  const out = [];
  const placed = new Set();
  for (const row of rows) {
    /* An id is kept when its panel is on the bench OR when it is a panel that
       is expected to arrive later.
       ---------------------------------------------------------------------
       This second clause is load-bearing. studio.js boots before meters.js
       mounts, so at the first reconcile only the five built-in panels exist
       and the five meter panels do not. Dropping an absent id here meant a
       saved row like ["goniometer", "spectrum"] was pruned to nothing at boot,
       the meters were then re-added as separate full-width rows by the loop
       below, and writeLayout() persisted that — so any row grouping meter
       panels quietly destroyed itself on every reload. Holding a placeholder
       for a panel that has not mounted yet keeps the row intact until it
       does. An id that is neither present nor expected really is gone (a
       renamed or removed panel) and is still dropped. */
    const keep = row.filter((id) =>
      !placed.has(id) && (present.has(id) || LAYOUT_EXPECTED.has(id)));
    keep.forEach((id) => placed.add(id));
    if (keep.length) out.push(keep);
  }
  for (const id of cards.keys()) {
    if (!placed.has(id)) out.push([id]);
  }
  return out;
}

/* A write to the DOM from layoutRows sets off the MutationObserver that
 * watches for meters.js reordering. This flag tells the observer the change
 * was ours and needs no reconcile, which would otherwise be an endless loop. */
let layoutWriting = false;

/** Write `layoutRows` to the document: panels in row order, each carrying the
 *  span its row implies. */
function applyLayout(persist) {
  const host = document.querySelector('.instruments');
  if (!host) return;
  const cards = cardMap();
  layoutRows = reconcileRows(layoutRows, cards);

  layoutWriting = true;
  try {
    for (const row of layoutRows) {
      /* The span comes from how many panels in this row are actually on the
         bench, not how many the row names. A row can legitimately name a panel
         that has not mounted yet (a meter, before meters.js runs) or one that
         is switched off in the tray; counting those would hand the survivors a
         half or third width and leave a visible gap where the absent panel
         would have been. Counting only what is present means a two-panel row
         with one panel absent renders that panel full width, and it returns to
         a half as soon as its partner appears. */
      const live = row.filter((id) => {
        const s = cards.get(id);
        return s && !s.hidden;
      });
      const span = SPAN_FOR[live.length] || 12;
      for (const id of row) {
        const section = cards.get(id);
        if (!section) continue;
        section.dataset.span = String(span);
        /* appendChild on a child already here is a move, which keeps every
           canvas, context and listener alive — the same trick meters.js uses
           to reorder without rebuilding. */
        host.appendChild(section);
      }
    }
  } finally {
    /* Released after a microtask, so the observer's own callback — which is
       delivered asynchronously — still sees the flag set for our writes. */
    Promise.resolve().then(() => { layoutWriting = false; });
  }

  if (persist !== false) writeLayout();

}

/** Where a card sits now: [rowIndex, colIndex], or null. */
function findCard(id) {
  for (let r = 0; r < layoutRows.length; r++) {
    const c = layoutRows[r].indexOf(id);
    if (c >= 0) return [r, c];
  }
  return null;
}

/** Take a card out of the layout, dropping the row if it empties. */
function removeCard(id) {
  const at = findCard(id);
  if (!at) return;
  const [r, c] = at;
  layoutRows[r].splice(c, 1);
  if (!layoutRows[r].length) layoutRows.splice(r, 1);
}

/* ---- moving a card -------------------------------------------------------
 * Two shapes of move, matching the two shapes of drop:
 *   beside(target, side)  — join the target's row to its left or right
 *   above(target, side)   — open a new full-width row before or after it
 * Both are expressed against a TARGET CARD rather than an index, because the
 * index changes the moment the dragged card is lifted out. */

/** Join `id` into the row holding `targetId`, on the given side. */
function moveBeside(id, targetId, side) {
  if (id === targetId) return false;
  const before = findCard(targetId);
  if (!before) return false;
  /* A full row still accepts a card that is already in it — that is a reorder,
     not a fourth arrival. `from` can be null for a card the layout has not
     seen yet, which counts as coming from outside the row. */
  const from = findCard(id);
  if (layoutRows[before[0]].length >= MAX_PER_ROW &&
      (!from || from[0] !== before[0])) return false;

  removeCard(id);
  const at = findCard(targetId);     // re-read: the lift may have shifted it
  if (!at) return false;
  const [r, c] = at;
  layoutRows[r].splice(side === 'left' ? c : c + 1, 0, id);
  return true;
}

/** Put `id` in a new full-width row above or below the row holding
 *  `targetId`. */
function moveToNewRow(id, targetId, side) {
  const before = findCard(targetId);
  if (!before) return false;
  /* A card already alone in its row, asked to make a new row adjacent to
     itself, has nothing to do — and acting would be an off-by-one shuffle. */
  if (findCard(id) && findCard(id)[0] === before[0] &&
      layoutRows[before[0]].length === 1) return false;

  removeCard(id);
  const at = findCard(targetId);
  if (!at) return false;
  layoutRows.splice(side === 'above' ? at[0] : at[0] + 1, 0, [id]);
  return true;
}

/* ---- the drop-zone overlay ----------------------------------------------
 * The old interaction was a thin gold seam that appeared when the pointer
 * strayed into an invisible quarter-width band at the edge of a panel. It
 * worked, but only once you already knew it was there: there was nothing on
 * screen saying where a release would land, so aiming was guesswork and the
 * most common outcome of a drag was a panel somewhere you did not ask for.
 *
 * It is replaced by an explicit, visible map of the bench, raised the instant
 * a drag begins:
 *
 *   - the page dims, so the structure reads over the content;
 *   - every existing ROW is outlined, so the thing being edited is visible;
 *   - every legal landing is a real, sizeable TARGET carrying its own words —
 *     a full-width bar between each pair of rows saying "New row", and a
 *     left/right half on each panel saying "Join this row".
 *
 * A zone lights on hover and states what it will do. A row that already holds
 * three panels still shows its side zones, marked "Row is full" in the
 * faceplate's warning red and refusing the drop — a refusal you can see beats
 * a drop that silently does nothing.
 *
 * The zones are plain absolutely-positioned divs in one overlay element that
 * is a sibling of the panels rather than a child of any of them, so nothing
 * here is inside `.instruments` and meters.js's appendChild storm cannot tear
 * it out. Geometry is measured once per drag (and on scroll/resize), not per
 * pointer move: the layout cannot change mid-drag, since a drop is what
 * changes it.
 * ========================================================================= */

/** Does the viewport currently allow more than one column? Read from the same
 *  media query the stylesheet uses, so the two can never disagree: below this
 *  the grid overrides every span back to full width, so a side drop or a
 *  "place left" would describe a row that cannot be seen. */
function multiColumnAllowed() {
  return window.matchMedia('(min-width: 1101px)').matches;
}

let zoneLayer = null;     // the overlay element
let zoneList = [];        // [{ el, kind, id, side, full, label }]
let zoneActive = null;    // the zone under the pointer

function zoneOverlay() {
  if (zoneLayer && zoneLayer.isConnected) return zoneLayer;
  zoneLayer = document.createElement('div');
  zoneLayer.className = 'drop-zones';
  zoneLayer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(zoneLayer);
  return zoneLayer;
}

/** A single target. `rect` is in viewport coordinates; the overlay is fixed,
 *  so no scroll offset is added. */
function makeZone(rect, kind, id, side, full, label) {
  const z = document.createElement('div');
  z.className = 'drop-zone drop-zone--' + kind + (full ? ' is-full' : '');
  z.style.left = rect.left + 'px';
  z.style.top = rect.top + 'px';
  z.style.width = Math.max(0, rect.width) + 'px';
  z.style.height = Math.max(0, rect.height) + 'px';
  const tag = document.createElement('span');
  tag.className = 'drop-zone-label';
  tag.textContent = full ? 'Row is full' : label;
  z.appendChild(tag);
  return { el: z, kind, id, side, full, label };
}

/** Outline an existing row, so the structure being edited is visible. */
function makeRowOutline(rect) {
  const o = document.createElement('div');
  o.className = 'drop-row-outline';
  o.style.left = rect.left + 'px';
  o.style.top = rect.top + 'px';
  o.style.width = Math.max(0, rect.width) + 'px';
  o.style.height = Math.max(0, rect.height) + 'px';
  return o;
}

/** The viewport rect covering a whole row: the union of its visible panels. */
function rowRect(row, cards) {
  let r = null;
  for (const id of row) {
    const s = cards.get(id);
    if (!s || s.hidden) continue;
    const b = s.getBoundingClientRect();
    if (!r) r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    else {
      r.left = Math.min(r.left, b.left);
      r.top = Math.min(r.top, b.top);
      r.right = Math.max(r.right, b.right);
      r.bottom = Math.max(r.bottom, b.bottom);
    }
  }
  if (!r) return null;
  r.width = r.right - r.left;
  r.height = r.bottom - r.top;
  return r;
}

/** Build the whole map for a drag of `draggedId`. */
function buildZones(draggedId) {
  const layer = zoneOverlay();
  layer.innerHTML = '';
  zoneList = [];
  zoneActive = null;

  const cards = cardMap();
  const multi = multiColumnAllowed();
  const BAR = 34;          // height of a "new row" bar
  const from = findCard(draggedId);

  /* The rows that are actually on screen, with their geometry. A row whose
     every panel is hidden (all its meters switched off) has no rect and is
     skipped entirely. */
  const rows = [];
  for (let r = 0; r < layoutRows.length; r++) {
    const rect = rowRect(layoutRows[r], cards);
    if (rect) rows.push({ index: r, rect, ids: layoutRows[r] });
  }
  if (!rows.length) return;

  for (const row of rows) layer.appendChild(makeRowOutline(row.rect));

  /* --- "new row" bars, above the first row and below every row ----------
     Each is anchored to a TARGET PANEL and a side, because that is what
     moveToNewRow() takes: an index would be invalidated the moment the
     dragged panel is lifted out of the layout. */
  const addRowBar = (row, side) => {
    /* A panel alone in its row, asked to open a new row against itself, has
       nothing to do — the same no-op moveToNewRow() refuses. Do not offer it
       as a target at all rather than let it be clicked and do nothing. */
    if (from && from[0] === row.index && row.ids.length === 1) return;
    const anchor = row.ids.find((id) => {
      const s = cards.get(id);
      return s && !s.hidden;
    });
    if (!anchor) return;
    const y = side === 'above' ? row.rect.top - BAR - 3 : row.rect.bottom + 3;
    zoneList.push(makeZone(
      { left: row.rect.left, top: y, width: row.rect.width, height: BAR },
      'row', anchor, side, false, 'New row here'));
  };

  addRowBar(rows[0], 'above');
  for (const row of rows) addRowBar(row, 'below');

  /* --- side zones on each panel ----------------------------------------
     Half a panel each, so the target is as large as it can be without
     overlapping its neighbour. Below the multi-column breakpoint the bench is
     one column by decree and a side drop would build a row nobody can see, so
     only the row bars above are offered. */
  if (multi) {
    for (const row of rows) {
      const rowLen = row.ids.filter((id) => {
        const s = cards.get(id);
        return s && !s.hidden;
      }).length;
      const sameRow = from && from[0] === row.index;
      /* A full row can still be REORDERED from within — moving a panel already
         in it changes the order, not the count — so the refusal only applies
         to a panel arriving from another row. */
      const full = rowLen >= MAX_PER_ROW && !sameRow;

      for (const id of row.ids) {
        if (id === draggedId) continue;
        const s = cards.get(id);
        if (!s || s.hidden) continue;
        const b = s.getBoundingClientRect();
        const half = b.width / 2;
        zoneList.push(makeZone(
          { left: b.left, top: b.top, width: half, height: b.height },
          'side', id, 'left', full, 'Join row, left'));
        zoneList.push(makeZone(
          { left: b.left + half, top: b.top, width: half, height: b.height },
          'side', id, 'right', full, 'Join row, right'));
      }
    }
  }

  /* Side zones are painted first so a "new row" bar, which is the smaller and
     more precise target, always sits on top where the two touch. */
  for (const z of zoneList) {
    if (z.kind === 'side') layer.appendChild(z.el);
  }
  for (const z of zoneList) {
    if (z.kind === 'row') layer.appendChild(z.el);
  }

  document.body.classList.add('is-zoning');
}

function clearZones() {
  if (zoneLayer) zoneLayer.innerHTML = '';
  zoneList = [];
  zoneActive = null;
  document.body.classList.remove('is-zoning');
}

/** Which zone is under (x, y)? The LAST match wins, which matches the paint
 *  order above: the row bars are on top, so a point inside both a side zone
 *  and a row bar resolves to the bar the user can see. */
function zoneAt(x, y) {
  let hit = null;
  for (const z of zoneList) {
    const r = z.el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      if (!hit || z.kind === 'row') hit = z;
    }
  }
  return hit;
}

/** Light the zone under the pointer and dim the rest. */
function highlightZone(z) {
  if (zoneActive === z) return;
  if (zoneActive) zoneActive.el.classList.remove('is-on');
  zoneActive = z;
  if (z) z.el.classList.add('is-on');
}

/** Carry out a decided drop. Returns true when the layout actually changed. */
function commitIntent(draggedId, zone) {
  if (!zone || zone.full) return false;
  const ok = zone.kind === 'side'
    ? moveBeside(draggedId, zone.id, zone.side)
    : moveToNewRow(draggedId, zone.id, zone.side);
  if (ok) applyLayout();
  return ok;
}

/* ---- the pointer drag ----------------------------------------------------
 * Pointer events, not HTML5 drag-and-drop, and deliberately so. The page
 * already owns window-level dragenter/dragover/drop for FILE loading, which
 * puts the whole body into its "RELEASE TO LOAD" state; a native element drag
 * fires those same events and would flash that overlay every time a panel was
 * moved. Pointer events are a separate channel entirely, so the two cannot
 * collide — and they work under a finger, which native DnD does not.
 *
 * The file drop path is additionally hardened below to ignore any drag that
 * is not carrying files, so the two remain independent from both ends.
 * ========================================================================= */

const DRAG_SLOP = 5;   // px before a press becomes a drag rather than a click

function wirePanelDrag() {
  const host = document.querySelector('.instruments');
  if (!host) return;

  let active = null;

  const onMove = (e) => {
    if (!active) return;
    if (!active.started) {
      if (Math.hypot(e.clientX - active.x0, e.clientY - active.y0) < DRAG_SLOP) {
        return;
      }
      active.started = true;
      active.section.classList.add('is-dragging');
      document.body.classList.add('is-panel-dragging');
      /* The map goes up the instant the press becomes a drag, not on the first
         hover near an edge: the whole point is that the targets are on screen
         BEFORE the aiming starts. Built once — the layout cannot change
         mid-drag, because a drop is the only thing that changes it. */
      buildZones(active.id);
    }
    active.zone = zoneAt(e.clientX, e.clientY);
    highlightZone(active.zone);
  };

  const finish = (commit) => {
    if (!active) return;
    const a = active;
    active = null;
    clearZones();
    a.section.classList.remove('is-dragging');
    document.body.classList.remove('is-panel-dragging');
    try { a.section.releasePointerCapture(a.pointerId); } catch { /* gone */ }
    if (commit && a.started) commitIntent(a.id, a.zone);
  };

  host.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const title = e.target.closest('.unit-title');
    if (!title) return;
    const section = title.parentElement;
    if (!section || !section.classList.contains('unit')) return;
    if (section.hasAttribute('data-no-drag')) return;
    /* The title row carries real controls — the collapse key, Analysis's own
       Analyze button. A press on one of those is a click, not a grab. */
    if (e.target.closest('button, a, input, select, textarea')) return;

    const cards = cardMap();
    let id = null;
    for (const [k, v] of cards) if (v === section) { id = k; break; }
    if (!id) return;

    active = {
      id, section, pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY, started: false, zone: null,
    };
    try { section.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });

  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', () => finish(true));
  host.addEventListener('pointercancel', () => finish(false));

  /* Escape abandons a drag in flight, leaving the bench as it was. */
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) { e.preventDefault(); finish(false); }
  });

  /* A drag that ends outside the instruments column still has to be cleaned
     up, or the body keeps its grabbing cursor. */
  window.addEventListener('pointerup', () => { if (active) finish(true); });
}

/* ---- keyboard moves ------------------------------------------------------
 * The title bar is a real control, so it is focusable and announces itself.
 * Modifier + arrow moves the panel: left/right within and between rows,
 * up/down between rows. Nothing here needs a pointer.
 * ========================================================================= */

let liveRegion = null;

function announce(msg) {
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'layout-live';
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');
    document.body.appendChild(liveRegion);
  }
  /* Re-setting identical text does not re-announce; the space forces it. */
  liveRegion.textContent = msg + (liveRegion.textContent === msg ? ' ' : '');
}

/** Say where a panel has landed, in the terms the user thinks in. */
function describePlace(id) {
  const at = findCard(id);
  if (!at) return '';
  const [r, c] = at;
  const row = layoutRows[r];
  const where = `row ${r + 1} of ${layoutRows.length}`;
  return row.length > 1
    ? `${where}, position ${c + 1} of ${row.length}`
    : `${where}, full width`;
}

/** Move a panel one step in a direction. Returns true if anything moved. */
function stepCard(id, dir) {
  const at = findCard(id);
  if (!at) return false;
  const [r, c] = at;
  const row = layoutRows[r];

  if (dir === 'left' || dir === 'right') {
    const to = dir === 'left' ? c - 1 : c + 1;
    if (to >= 0 && to < row.length) {
      /* Within the row: swap with the neighbour. */
      row.splice(c, 1);
      row.splice(to, 0, id);
      return true;
    }
    /* Off the end of the row: join the neighbouring row, if it has space. */
    const nr = dir === 'left' ? r - 1 : r + 1;
    if (nr < 0 || nr >= layoutRows.length) return false;
    if (!multiColumnAllowed()) return false;
    if (layoutRows[nr].length >= MAX_PER_ROW) return false;
    removeCard(id);
    /* The lift may have removed row r entirely and shifted nr down by one. */
    const target = nr > r && row.length === 1 ? nr - 1 : nr;
    if (target < 0 || target >= layoutRows.length) return false;
    layoutRows[target][dir === 'left' ? 'push' : 'unshift'](id);
    return true;
  }

  /* Up and down: leave the row and open a new one of your own. Within a
     multi-column row this is how a panel gets back to full width. */
  const nr = dir === 'up' ? r - 1 : r + 1;
  if (row.length === 1) {
    /* Already alone: swap whole rows with the neighbour. */
    if (nr < 0 || nr >= layoutRows.length) return false;
    const tmp = layoutRows[r];
    layoutRows[r] = layoutRows[nr];
    layoutRows[nr] = tmp;
    return true;
  }
  removeCard(id);
  layoutRows.splice(dir === 'up' ? r : r + 1, 0, [id]);
  return true;
}

function wireLayoutKeys() {
  const host = document.querySelector('.instruments');
  if (!host) return;

  host.addEventListener('keydown', (e) => {
    const title = e.target.closest('.unit-title');
    if (!title || title !== e.target) return;
    const section = title.parentElement;
    if (!section || section.hasAttribute('data-no-drag')) return;

    const DIRS = {
      ArrowLeft: 'left', ArrowRight: 'right',
      ArrowUp: 'up', ArrowDown: 'down',
    };
    const dir = DIRS[e.key];
    if (!dir) return;
    /* A modifier is required: bare arrows on a focused element must stay
       available for scrolling and for the browser's own caret browsing. */
    if (!(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)) return;
    e.preventDefault();

    let id = null;
    for (const [k, v] of cardMap()) if (v === section) { id = k; break; }
    if (!id) return;

    if (stepCard(id, dir)) {
      applyLayout();
      /* The move re-appends the element, which drops focus on the title bar;
         put it straight back so a second press continues the move. */
      title.focus();
      announce(`${panelTitle(section)} moved to ${describePlace(id)}`);
    } else {
      announce(`${panelTitle(section)} cannot move further ${dir}`);
    }
  });
}

/** The engraved name of a panel, for spoken feedback. */
function panelTitle(section) {
  const h = section.querySelector('.unit-title h2');
  return h ? h.textContent.trim() : 'Panel';
}

/** Make every title bar a described, focusable drag handle. Re-run whenever
 *  panels appear, since meters.js mounts five of its own after boot. */
function markHandles() {
  layoutCards().forEach((section, i) => {
    const title = section.querySelector('.unit-title');
    if (!title || title.dataset.handle === '1') return;
    if (section.hasAttribute('data-no-drag')) return;
    title.dataset.handle = '1';
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    const name = panelTitle(section);
    title.setAttribute('aria-label',
      `${name} panel — drag to rearrange, or hold Alt and press the arrow ` +
      `keys to move it`);
    title.setAttribute('aria-roledescription', 'draggable panel');
  });
}

/* ---- the placement menu -------------------------------------------------
 * The macOS window-tiling analogy, and the precise path: a small control in
 * every panel's title bar that opens a list of places the panel can go, each
 * of which performs the move on a single click with no dragging at all.
 *
 * This is not a convenience wrapper around the drag — it is the accessible
 * route. Everything the drag can express is here as a named command, so a
 * pointer that cannot hold a drag, a keyboard, or a person who simply does not
 * want to aim never has to touch the zone map. The options are generated from
 * the panel's CURRENT place, so what is offered is always something that would
 * actually change the bench: an option that would be a no-op is disabled with
 * the reason on it rather than silently doing nothing.
 *
 * At one-column widths (the same media query the stylesheet uses) only up and
 * down are offered — the side and width options describe rows that cannot be
 * seen there.
 * ========================================================================= */

let placementMenu = null;     // the open menu element, or null
let placementOwner = null;    // the button that opened it

function closePlacement() {
  if (placementMenu) {
    placementMenu.remove();
    placementMenu = null;
  }
  if (placementOwner) {
    placementOwner.setAttribute('aria-expanded', 'false');
    placementOwner = null;
  }
}

/* ---- the moves the menu offers ------------------------------------------
 * Each is expressed against the layout model, never against the DOM, and each
 * returns true only when it actually changed something — that is what decides
 * whether the option is offered as live or disabled. */

/** Put `id` alone in a full-width row of its own, keeping its vertical place.
 *  This is "make full width" for a panel sharing a row. */
function placeFullWidth(id) {
  const at = findCard(id);
  if (!at) return false;
  const [r] = at;
  if (layoutRows[r].length === 1) return false;   // already full width
  removeCard(id);
  /* Directly below what is left of the row it was in, so the panel stays
     where the eye last saw it rather than jumping to the end of the bench. */
  layoutRows.splice(r + 1, 0, [id]);
  return true;
}

/** Move `id` to position `col` within its own row (0 = left). Used for the
 *  "place left / centre / right" options. */
function placeAtColumn(id, col) {
  const at = findCard(id);
  if (!at) return false;
  const [r, c] = at;
  const row = layoutRows[r];
  if (col < 0 || col >= row.length || col === c) return false;
  row.splice(c, 1);
  row.splice(col, 0, id);
  return true;
}

/** Join the row above or below, if that row has room. This is how a panel
 *  BECOMES part of a 2- or 3-across row from the menu, with no drag. */
function placeJoinRow(id, dir, side) {
  const at = findCard(id);
  if (!at) return false;
  const [r] = at;
  const nr = dir === 'up' ? r - 1 : r + 1;
  if (nr < 0 || nr >= layoutRows.length) return false;
  if (layoutRows[nr].length >= MAX_PER_ROW) return false;
  const alone = layoutRows[r].length === 1;
  removeCard(id);
  /* Lifting the panel may have deleted its old row and shifted the target up
     by one. */
  const target = (alone && nr > r) ? nr - 1 : nr;
  if (target < 0 || target >= layoutRows.length) return false;
  if (side === 'left') layoutRows[target].unshift(id);
  else layoutRows[target].push(id);
  return true;
}

/** Give `id` a new full-width row of its own at the very end of the bench. */
function placeOwnRowAtEnd(id) {
  const at = findCard(id);
  if (!at) return false;
  const [r] = at;
  if (r === layoutRows.length - 1 && layoutRows[r].length === 1) return false;
  removeCard(id);
  layoutRows.push([id]);
  return true;
}

/** Run a move, write it to the page, and say what happened. */
function runPlacement(id, fn, label) {
  const section = cardMap().get(id);
  if (!fn()) {
    announce(`${section ? panelTitle(section) : 'Panel'} — ${label} changes nothing`);
    return;
  }
  applyLayout();
  const now = cardMap().get(id);
  if (now) announce(`${panelTitle(now)} moved to ${describePlace(id)}`);
}

/** The option list for a panel, in the order it is shown. Each entry is
 *  { label, run, off } — `off` being a reason it is unavailable, which is
 *  shown rather than hidden so the menu's shape does not jump about. */
function placementOptions(id) {
  const at = findCard(id);
  if (!at) return [];
  const [r, c] = at;
  const row = layoutRows[r];
  const multi = multiColumnAllowed();
  const opts = [];

  /* --- vertical: always available, at every width --------------------- */
  opts.push({
    label: 'Move up',
    off: r === 0 && row.length === 1 ? 'already at the top' : '',
    run: () => stepCard(id, 'up'),
  });
  opts.push({
    label: 'Move down',
    off: r === layoutRows.length - 1 && row.length === 1
      ? 'already at the bottom' : '',
    run: () => stepCard(id, 'down'),
  });

  /* Below the breakpoint the bench is one column whatever the layout says, so
     a width or a side would describe something invisible. Up and down are the
     whole vocabulary there, which is exactly what the brief asks for. */
  if (!multi) return opts;

  opts.push({ sep: true });

  /* --- width ---------------------------------------------------------- */
  opts.push({
    label: 'Make full width',
    off: row.length === 1 ? 'already full width' : '',
    run: () => placeFullWidth(id),
  });

  /* --- position within the row it is already in ------------------------ */
  if (row.length > 1) {
    const names = row.length === 2
      ? ['Place left', 'Place right']
      : ['Place left', 'Place centre', 'Place right'];
    names.forEach((label, i) => {
      opts.push({
        label,
        off: c === i ? 'already there' : '',
        run: () => placeAtColumn(id, i),
      });
    });
  }

  /* --- joining a neighbouring row, which is how a row of 2 or 3 is built
         without ever dragging ----------------------------------------- */
  opts.push({ sep: true });

  const canJoin = (dir) => {
    const nr = dir === 'up' ? r - 1 : r + 1;
    if (nr < 0 || nr >= layoutRows.length) return 'no row there';
    if (layoutRows[nr].length >= MAX_PER_ROW) return 'that row is full';
    return '';
  };

  opts.push({
    label: 'Join row above, left',
    off: canJoin('up'),
    run: () => placeJoinRow(id, 'up', 'left'),
  });
  opts.push({
    label: 'Join row above, right',
    off: canJoin('up'),
    run: () => placeJoinRow(id, 'up', 'right'),
  });
  opts.push({
    label: 'Join row below, left',
    off: canJoin('down'),
    run: () => placeJoinRow(id, 'down', 'left'),
  });
  opts.push({
    label: 'Join row below, right',
    off: canJoin('down'),
    run: () => placeJoinRow(id, 'down', 'right'),
  });

  opts.push({ sep: true });
  opts.push({
    label: 'Move to its own new row',
    off: r === layoutRows.length - 1 && row.length === 1
      ? 'already alone at the end' : '',
    run: () => placeOwnRowAtEnd(id),
  });

  return opts;
}

/** Open the picker under its button. */
function openPlacement(btn, id) {
  closePlacement();

  const opts = placementOptions(id);
  if (!opts.length) return;

  const menu = document.createElement('div');
  menu.className = 'place-menu';
  menu.setAttribute('role', 'menu');
  const section = cardMap().get(id);
  menu.setAttribute('aria-label',
    `Place ${section ? panelTitle(section) : 'panel'}`);

  for (const o of opts) {
    if (o.sep) {
      const hr = document.createElement('div');
      hr.className = 'place-sep';
      menu.appendChild(hr);
      continue;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'place-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = o.label;
    if (o.off) {
      item.disabled = true;
      item.title = o.off;
      const why = document.createElement('span');
      why.className = 'place-why';
      why.textContent = o.off;
      item.appendChild(why);
    } else {
      item.addEventListener('click', () => {
        closePlacement();
        runPlacement(id, o.run, o.label);
      });
    }
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  placementMenu = menu;
  placementOwner = btn;
  btn.setAttribute('aria-expanded', 'true');

  /* Positioned in viewport coordinates under the button, then pulled back
     inside the window if it would hang off an edge — a menu that opens off
     screen is a menu that does not open. */
  const b = btn.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  let left = b.right - m.width;
  let top = b.bottom + 6;
  const pad = 8;
  left = Math.max(pad, Math.min(left, window.innerWidth - m.width - pad));
  if (top + m.height > window.innerHeight - pad) {
    /* No room below: flip above the button, and if there is no room there
       either, sit at the top of the window and let the menu scroll. */
    top = Math.max(pad, b.top - m.height - 6);
  }
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  menu.style.maxHeight = Math.round(window.innerHeight - top - pad) + 'px';

  const first = menu.querySelector('.place-item:not([disabled])');
  if (first) first.focus();
}

/** The control itself, added to every panel's title bar. */
function wirePlacementMenus() {
  markPlacementButtons();

  /* One document-level handler rather than one per menu: the menu is rebuilt
     on every open, and a listener per instance would leak. */
  document.addEventListener('pointerdown', (e) => {
    if (!placementMenu) return;
    if (e.target.closest('.place-menu')) return;
    if (e.target.closest('.place-btn')) return;   // its own toggle handles it
    closePlacement();
  });

  document.addEventListener('keydown', (e) => {
    if (!placementMenu) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      const owner = placementOwner;
      closePlacement();
      if (owner) owner.focus();
      return;
    }
    /* Arrow keys walk the list, which is what a menu is expected to do. */
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...placementMenu.querySelectorAll('.place-item:not([disabled])')];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown'
      ? (at + 1) % items.length
      : (at <= 0 ? items.length - 1 : at - 1);
    items[next].focus();
  });
}

/** Give every panel that does not have one a placement control. Re-run
 *  whenever panels appear, since meters.js mounts five after boot. */
function markPlacementButtons() {
  layoutCards().forEach((section, i) => {
    const title = section.querySelector('.unit-title');
    if (!title) return;
    if (title.querySelector('.place-btn')) return;
    if (section.hasAttribute('data-no-drag')) return;


    const id = layoutId(section, i);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'place-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = `Place ${panelTitle(section)} on the bench`;
    btn.setAttribute('aria-label', btn.title);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (placementOwner === btn) { closePlacement(); return; }
      /* The id is re-derived at open time, not captured: meters.js can
         re-append a panel, and the element this button lives in outlives any
         one reading of the card map. */
      let live = id;
      for (const [k, v] of cardMap()) if (v === section) { live = k; break; }
      openPlacement(btn, live);
    });

    /* The title bar is the drag handle, and a press on a real control in it
       is a click rather than a grab — wirePanelDrag() already refuses any
       pointerdown that lands on a button, so nothing more is needed here than
       keeping this a <button>. */
    title.appendChild(btn);
  });
}

/* ---- watching for panels that arrive from elsewhere ---------------------
 * meters.js mounts its five panels after this script boots, and re-appends
 * them on every tray edit. Both land here: new ids are reconciled into the
 * layout, and a reorder that was not ours is absorbed rather than fought.
 * ========================================================================= */

function watchInstruments() {
  const host = document.querySelector('.instruments');
  if (!host || typeof MutationObserver !== 'function') return;

  let queued = false;
  const observer = new MutationObserver(() => {
    if (layoutWriting || queued) return;
    queued = true;
    /* Coalesce: mount() appends ten times in a row, and applyArrangement()
       once per meter. One pass after the burst is enough. */
    Promise.resolve().then(() => {
      queued = false;
      markHandles();
      /* The five meter panels mount after boot and are re-appended on every
         tray edit, so their placement controls are added here rather than
         only at wire time. The function is idempotent — it skips a title bar
         that already has one — so running it on every burst is free. */
      markPlacementButtons();
      /* A meter that was switched off is `hidden`; it keeps its place in the
         layout so switching it back on returns it where it was. */
      applyLayout();
    });
  });
  observer.observe(host, { childList: true });
}

/* ================================================================ workspaces
 * A workspace is the whole bench: panel order and row grouping, which meters
 * are on, what is folded, the rail width, and the EQ bands.
 *
 * Built-ins ship with the page and cannot be deleted — but selecting one and
 * saving under a new name is an ordinary save, so they are starting points
 * rather than a closed set.
 * ========================================================================= */

const WORKSPACE_KEY = 'music-studio.workspaces';

/* The five meter ids that meters.js owns. Named here so a built-in can say
 * which meters it wants without reaching into that file's internals. */
const METER_IDS = ['loudness-time', 'goniometer', 'spectrum', 'dynamics',
                   'equalizer'];

/* Built-in benches. Each names the rows it wants; any panel not mentioned is
 * appended full-width at the end by reconcileRows, so these stay valid when a
 * new panel is added to the page. */
const BUILTIN_WORKSPACES = [
  {
    id: 'mastering',
    name: 'Mastering',
    builtin: true,
    rows: [
      ['transport'],
      ['vu-bridge', 'levels'],
      ['analysis'],
      ['loudness-time', 'dynamics'],
    ],
    hiddenMeters: ['goniometer', 'spectrum', 'equalizer'],
    collapsed: [],
  },
  {
    id: 'mixing',
    name: 'Mixing',
    builtin: true,
    rows: [
      ['transport'],
      ['spectrum', 'goniometer', 'equalizer'],
      ['vu-bridge', 'levels'],
    ],
    hiddenMeters: ['loudness-time', 'dynamics'],
    collapsed: ['analysis', 'spectrum-builtin'],
  },
  {
    id: 'quick-check',
    name: 'Quick check',
    builtin: true,
    rows: [
      ['transport'],
      ['analysis'],
    ],
    hiddenMeters: METER_IDS.slice(),
    collapsed: ['vu-bridge', 'levels', 'spectrum-builtin'],
  },
];

function readWorkspaces() {
  try {
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || 'null');
    if (!Array.isArray(raw)) return [];
    return raw.filter((w) => w && typeof w.name === 'string' && w.id);
  } catch { return []; }
}

function writeWorkspaces(list) {
  try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(list)); }
  catch { /* private window: the bench works, it just cannot remember */ }
}

/** Built-ins first, then the user's own, which shadow a built-in of the same
 *  id — that is how "overwrite a built-in into a new name" stays possible
 *  without ever destroying the original. */
function allWorkspaces() {
  const saved = readWorkspaces();
  const savedIds = new Set(saved.map((w) => w.id));
  return [
    ...BUILTIN_WORKSPACES.filter((w) => !savedIds.has(w.id)),
    ...saved,
  ];
}

/** Capture the bench exactly as it stands. */
function captureWorkspace(name) {
  const cards = cardMap();
  layoutRows = reconcileRows(layoutRows, cards);

  const collapsed = [];
  for (const [id, section] of cards) {
    if (section.classList.contains('is-collapsed')) collapsed.push(id);
  }

  let hiddenMeters = [];
  try {
    const tray = window.StudioMeters && window.StudioMeters.tray();
    if (tray) hiddenMeters = tray.hidden();
  } catch { /* meters.js absent or not mounted yet */ }

  let bands = [];
  try {
    if (window.StudioEq && Array.isArray(window.StudioEq.bands)) {
      /* A deep copy: the live array is meters.js's own and keeps changing. */
      bands = JSON.parse(JSON.stringify(window.StudioEq.bands));
    }
  } catch { /* an EQ that will not serialise is simply not captured */ }

  let rail = RAIL_DEFAULT;
  if (el.splitter) rail = Number(el.splitter.getAttribute('aria-valuenow')) || rail;

  return {
    id: 'ws-' + Date.now().toString(36),
    name,
    rows: layoutRows.map((r) => r.slice()),
    collapsed,
    hiddenMeters,
    bands,
    rail,
  };
}

/** Put the bench into a saved state. */
function restoreWorkspace(ws) {
  if (!ws) return;

  /* --- the meter tray first: showing a meter that was off adds a panel, and
     the layout has to be written after every panel exists. ---------------- */
  try {
    const tray = window.StudioMeters && window.StudioMeters.tray();
    if (tray && Array.isArray(ws.hiddenMeters)) {
      const want = new Set(ws.hiddenMeters);
      for (const id of METER_IDS) {
        if (want.has(id)) tray.hide(id); else tray.show(id);
      }
    }
  } catch { /* no tray: the built-in panels still rearrange */ }

  /* --- rail width ------------------------------------------------------- */
  if (Number.isFinite(ws.rail)) setRailWidth(ws.rail, true);

  /* --- collapsed states -------------------------------------------------
     Driven through each card's own control rather than by setting the class,
     so the button's aria-expanded, the body's hidden flag and the saved
     collapse key all stay in step with the class. */
  const want = new Set(Array.isArray(ws.collapsed) ? ws.collapsed : []);
  for (const [id, section] of cardMap()) {
    const btn = section.querySelector('.collapse-btn');
    if (!btn) continue;
    const isCollapsed = section.classList.contains('is-collapsed');
    if (want.has(id) !== isCollapsed) btn.click();
  }

  /* --- the layout itself ------------------------------------------------- */
  layoutRows = normaliseRows(ws.rows);
  applyLayout();

  /* --- the EQ -----------------------------------------------------------
     window.StudioEq carries `bands` and `preset` but no apply(): meters.js
     publishes the array and never offers a way in. So the bands are set and
     a 'studio-eq-restore' event is dispatched for meters.js to listen for.
     The apply() branch is kept for the day that file grows one. */
  if (Array.isArray(ws.bands) && ws.bands.length) {
    try {
      window.StudioEq = window.StudioEq || {};
      window.StudioEq.bands = JSON.parse(JSON.stringify(ws.bands));
      if (typeof window.StudioEq.apply === 'function') {
        window.StudioEq.apply(window.StudioEq.bands);
      } else {
        window.dispatchEvent(new CustomEvent('studio-eq-restore',
          { detail: { bands: window.StudioEq.bands } }));
      }
    } catch { /* an EQ that refuses to restore must not stop the layout */ }
  }
}

/* ---- the masthead control ------------------------------------------------ */

const WS_CURRENT_KEY = 'music-studio.workspace-current';

function readCurrentWorkspace() {
  try { return localStorage.getItem(WS_CURRENT_KEY) || ''; }
  catch { return ''; }
}

function writeCurrentWorkspace(id) {
  try { localStorage.setItem(WS_CURRENT_KEY, id || ''); }
  catch { /* nothing to do */ }
}

function fillWorkspaceSelect(select, selectedId) {
  const list = allWorkspaces();
  select.innerHTML = '';

  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— working layout —';
  select.appendChild(none);

  const builtins = list.filter((w) => w.builtin);
  const mine = list.filter((w) => !w.builtin);

  const group = (label, items) => {
    if (!items.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const w of items) {
      const o = document.createElement('option');
      o.value = w.id;
      o.textContent = w.name;
      g.appendChild(o);
    }
    select.appendChild(g);
  };
  group('Built in', builtins);
  group('Saved', mine);

  select.value = list.some((w) => w.id === selectedId) ? selectedId : '';
  return list;
}

function wireWorkspaces() {
  const select = $('#workspace-select');
  const saveBtn = $('#workspace-save');
  const delBtn = $('#workspace-delete');
  if (!select || !saveBtn || !delBtn) return;

  const refresh = (id) => {
    const list = fillWorkspaceSelect(select, id);
    const chosen = list.find((w) => w.id === select.value);
    /* A built-in cannot be deleted; nor can "the working layout". */
    delBtn.disabled = !chosen || !!chosen.builtin;
    delBtn.title = !chosen
      ? 'Choose a saved workspace to delete it'
      : chosen.builtin
        ? `${chosen.name} is built in and cannot be deleted`
        : `Delete “${chosen.name}”`;
  };

  refresh(readCurrentWorkspace());

  select.addEventListener('change', () => {
    const id = select.value;
    writeCurrentWorkspace(id);
    if (!id) { refresh(id); return; }
    const ws = allWorkspaces().find((w) => w.id === id);
    if (ws) restoreWorkspace(ws);
    refresh(id);
    announce(ws ? `${ws.name} workspace loaded` : 'Workspace not found');
  });

  saveBtn.addEventListener('click', () => {
    const current = allWorkspaces().find((w) => w.id === select.value);
    const suggested = current && !current.builtin ? current.name : '';
    const name = (window.prompt('Name this workspace', suggested) || '').trim();
    if (!name) return;

    const list = readWorkspaces();
    const ws = captureWorkspace(name);
    /* Saving under an existing saved name replaces it, which is what a person
       who typed the same name again meant. A built-in's name is free to reuse:
       the copy shadows it by id only if the ids match, and they never do. */
    const at = list.findIndex((w) => !w.builtin && w.name === name);
    if (at >= 0) { ws.id = list[at].id; list[at] = ws; }
    else list.push(ws);

    writeWorkspaces(list);
    writeCurrentWorkspace(ws.id);
    refresh(ws.id);
    announce(`Workspace ${name} saved`);
  });

  delBtn.addEventListener('click', () => {
    const id = select.value;
    if (!id) return;
    const list = readWorkspaces();
    const at = list.findIndex((w) => w.id === id);
    if (at < 0) return;
    const name = list[at].name;
    if (!window.confirm(`Delete the workspace “${name}”?`)) return;
    list.splice(at, 1);
    writeWorkspaces(list);
    writeCurrentWorkspace('');
    refresh('');
    announce(`Workspace ${name} deleted`);
  });
}

/** Start the layout engine: adopt the saved working layout, mark the handles,
 *  and watch for the panels meters.js is about to mount. */
function wireLayout() {
  layoutRows = readLayout();
  markHandles();
  applyLayout(false);
  wirePanelDrag();
  wireLayoutKeys();
  wirePlacementMenus();
  watchInstruments();
  wireWorkspaces();

  /* The zone map is measured geometry, so a resize or a scroll while a drag is
     somehow still live would leave every target pointing at where a panel used
     to be. Drop the map rather than show a lie; the next pointer move rebuilds
     nothing, so the drag simply ends with no drop, which is the safe outcome.
     The placement menu is dismissed for the same reason. */
  window.addEventListener('resize', () => { clearZones(); closePlacement(); });
  window.addEventListener('scroll', closePlacement, { passive: true });
}

function boot() {
  setTransportEnabled(false);
  trackMastheadHeight();
  wireSplitter();
  wireCollapse();
  wireTimeline();
  wireReset();
  wireAnalyzeRun();
  wireAnalyseButton();
  wireLayout();
  renderTimeline([]);
  renderMusicalReadouts();
  wireAsk();
  detectServer().then(() => {
    /* Say so once we know: the rail's note carries the connection state, and
       an offline page should not claim to be able to chat. */
    if (!server.live) {
      saidOffline = true;
      chatSystem('Not connected — start `music serve` to chat. ' +
        'Questions typed here will come back as a command to run instead.');
    }
  });

  // `music scope --open` writes the analysis into window.PRELOADED_ANALYSIS and
  // opens this page, so the run you just did is on screen without hand-loading
  // a file. A file:// page cannot fetch a sibling JSON — CORS forbids it — so
  // the data is embedded rather than linked.
  const pre = window.PRELOADED_ANALYSIS;
  if (pre && typeof pre === 'object') {
    applyAnalysis(pre, window.PRELOADED_NAME || 'analysis.json');
    el.source.innerHTML =
      `<b>${escapeHtml(window.PRELOADED_NAME || 'analysis.json')}</b>` +
      ' · analysis only';
    requestAnimationFrame(frame);
    return;
  }

  applyAnalysis(demoAnalysis(), 'example-analysis.json');
  el.source.innerHTML =
    '<b>Example measurement</b> · a demonstration reading, not your file';
  el.tDur.textContent = fmtTime(206.4);
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
