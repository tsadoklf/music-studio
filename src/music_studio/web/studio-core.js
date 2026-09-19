/* studio-core.js — colour maps, maths helpers, VU ballistics, ITU-R BS.1770-4 loudness
 *
 * One of the five files the single 5,591-line studio.js became. Same code,
 * same behaviour, in a file you can open on its own.
 *
 * The file is its own IIFE over `window.__studio` (`__S` inside), and
 * publishes what other files need in the Object.assign at the foot.
 *
 * Cross-file names are read as `__S.name` AT THE POINT OF USE, never
 * destructured at the top of the file: `__S` fills up as the scripts load,
 * so `const { drawVu } = __S` here would capture undefined for anything a
 * later file defines. The IIFE is not optional either — these are classic
 * scripts sharing one global scope, and widgets/*.js declare several of the
 * same names with different bodies. See README.md.
 */
(function (__S) {
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


/* Published for the files that load after this one. */
Object.assign(__S, { LoudnessMeter, VuMovement, clamp, dbfs, fmtDb, fmtLu, fmtTime, inferno, lerp, truePeakOf });
})(window.__studio || (window.__studio = {}));
