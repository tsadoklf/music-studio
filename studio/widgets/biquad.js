/* ==========================================================================
   biquad.js — RBJ cookbook filter maths
   --------------------------------------------------------------------------
   Coefficients for the peaking, shelf, pass and notch filters, and the
   magnitude response |H(e^jw)| evaluated at a frequency. These are the same
   coefficients ffmpeg's filters and WebAudio's BiquadFilterNode build, so the
   curve the EQ draws and the filter that is heard agree by construction.

   Depends on nothing but Math. Used by equalizer.js.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/* ==========================================================================
   3. Biquad magnitude response — RBJ Audio EQ Cookbook
   --------------------------------------------------------------------------
   The EQ curve is computed, never drawn as a decorative bump. For each band
   we build the same coefficients ffmpeg's own filters build, then evaluate

       |H(e^jw)| = |b0 + b1 z + b2 z²| / |1 + a1 z + a2 z²|,  z = e^-jw

   at every pixel column. The result is what the filter chain in the output
   field will actually do, which is the only reason showing a curve is worth
   anything.
   ========================================================================= */

/** Peaking EQ. gain in dB, Q dimensionless. */
function peakingCoeffs(f0, gainDb, Q, fs) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const alpha = Math.sin(w0) / (2 * Math.max(Q, 0.01));
  const cw = Math.cos(w0);
  const a0 = 1 + alpha / A;
  return {
    b0: (1 + alpha * A) / a0,
    b1: (-2 * cw) / a0,
    b2: (1 - alpha * A) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha / A) / a0,
  };
}

/** Low shelf. ffmpeg's `bass` filter with width_type=q is this. */
function lowShelfCoeffs(f0, gainDb, Q, fs) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(Q, 0.01));
  const tsa = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) + (A - 1) * cw + tsa;
  return {
    b0: (A * ((A + 1) - (A - 1) * cw + tsa)) / a0,
    b1: (2 * A * ((A - 1) - (A + 1) * cw)) / a0,
    b2: (A * ((A + 1) - (A - 1) * cw - tsa)) / a0,
    a1: (-2 * ((A - 1) + (A + 1) * cw)) / a0,
    a2: ((A + 1) + (A - 1) * cw - tsa) / a0,
  };
}

/** High shelf — ffmpeg's `treble`. */
function highShelfCoeffs(f0, gainDb, Q, fs) {
  const A = Math.pow(10, gainDb / 40);
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(Q, 0.01));
  const tsa = 2 * Math.sqrt(A) * alpha;
  const a0 = (A + 1) - (A - 1) * cw + tsa;
  return {
    b0: (A * ((A + 1) + (A - 1) * cw + tsa)) / a0,
    b1: (-2 * A * ((A - 1) + (A + 1) * cw)) / a0,
    b2: (A * ((A + 1) + (A - 1) * cw - tsa)) / a0,
    a1: (2 * ((A - 1) - (A + 1) * cw)) / a0,
    a2: ((A + 1) - (A - 1) * cw - tsa) / a0,
  };
}

/** Second-order Butterworth high-pass — what `highpass=poles=2` builds. */
function highPassCoeffs(f0, fs) {
  const Q = Math.SQRT1_2;
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Q);
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0,
    b1: (-(1 + cw)) / a0,
    b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Second-order Butterworth low-pass — what `lowpass=poles=2` builds, and
    what WebAudio's 'lowpass' type is at Q = 1/√2. The Q is taken rather than
    fixed, because a band the user can set the Q of has to draw its resonance
    or the curve stops matching what is heard. */
function lowPassCoeffs(f0, fs, Q) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(Q || Math.SQRT1_2, 0.01));
  const a0 = 1 + alpha;
  return {
    b0: ((1 - cw) / 2) / a0,
    b1: (1 - cw) / a0,
    b2: ((1 - cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** High-pass with a settable Q, for a band whose Q knob is live. The fixed-Q
    `highPassCoeffs` above stays as it is: it models `highpass=poles=2`, whose
    Q is not ours to choose. */
function highPassQCoeffs(f0, fs, Q) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(Q || Math.SQRT1_2, 0.01));
  const a0 = 1 + alpha;
  return {
    b0: ((1 + cw) / 2) / a0,
    b1: (-(1 + cw)) / a0,
    b2: ((1 + cw) / 2) / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Band-stop. A notch removes a narrow slice outright; Q sets how narrow. */
function notchCoeffs(f0, fs, Q) {
  const w0 = 2 * Math.PI * f0 / fs;
  const cw = Math.cos(w0), sw = Math.sin(w0);
  const alpha = sw / (2 * Math.max(Q || 1, 0.01));
  const a0 = 1 + alpha;
  return {
    b0: 1 / a0,
    b1: (-2 * cw) / a0,
    b2: 1 / a0,
    a1: (-2 * cw) / a0,
    a2: (1 - alpha) / a0,
  };
}

/** Magnitude of one biquad at frequency f, in dB. */
function biquadDb(c, f, fs) {
  const w = 2 * Math.PI * f / fs;
  const cw = Math.cos(w), sw = Math.sin(w);
  const c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  const nr = c.b0 + c.b1 * cw + c.b2 * c2;
  const ni = -(c.b1 * sw + c.b2 * s2);
  const dr = 1 + c.a1 * cw + c.a2 * c2;
  const di = -(c.a1 * sw + c.a2 * s2);
  const n2 = nr * nr + ni * ni;
  const d2 = dr * dr + di * di;
  if (d2 <= 1e-20) return 0;
  return 10 * Math.log10(Math.max(n2 / d2, 1e-12));
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { peakingCoeffs, lowShelfCoeffs, highShelfCoeffs, highPassCoeffs, lowPassCoeffs, highPassQCoeffs, notchCoeffs, biquadDb });

})(window.__studioWidgets || (window.__studioWidgets = {}));
