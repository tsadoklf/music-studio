/* studio-draw.js — the instrument faces: VU dial, dBFS bars, correlation, spectrum, spectrogram
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
  const v = __S.clamp(vu, VU_MIN, VU_MAX);
  // normalised with a mild expansion toward the top of the scale
  const t = (v - VU_MIN) / (VU_MAX - VU_MIN);
  // Mild expansion only: the real face gives -20..-7 slightly less arc than
  // the -3..+3 region, but nothing like a power curve.
  const shaped = t * 0.86 + t * t * 0.14;
  return __S.lerp(ARC_START, ARC_END, shaped);
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
  ctx.lineTo(__S.lerp(cx, tip.x, 0.55), __S.lerp(cy, tip.y, 0.55));
  ctx.stroke();
  ctx.beginPath();
  ctx.lineWidth = h * 0.012;
  ctx.moveTo(__S.lerp(cx, tip.x, 0.55), __S.lerp(cy, tip.y, 0.55));
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
  const t = (__S.clamp(db, BAR_MIN_DB, 6) - BAR_MIN_DB) / (6 - BAR_MIN_DB);
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
    ctx.fillText(__S.fmtLu(c.hold, 1), w - 2, y + bh / 2);
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
  const t = (__S.clamp(value, -1, 1) + 1) / 2;
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
  return (Math.log10(__S.clamp(f, FMIN, FMAX)) - Math.log10(FMIN)) /
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
    ctx.fillText(fmtHz(f), __S.clamp(x, 12, w - 12), plotH + 3);
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
    return plotH - (__S.clamp(db, -90, 0) + 90) / 90 * plotH;
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
      const f = Math.pow(10, __S.lerp(Math.log10(FMIN), Math.log10(FMAX), t));
      const bin = Math.round(f / nyquist * bins.length);
      const v = bins[__S.clamp(bin, 0, bins.length - 1)] / 255;
      const [r, g, b] = __S.inferno(Math.pow(v, 1.15));
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
      return __S.clamp(Math.round(hz / nyq * binsPer), 0, binsPer - 1);
    };
    for (let x = 0; x < W; x++) {
      const fr = Math.min(frames - 1, Math.floor(x / W * frames));
      for (let y = 0; y < H; y++) {
        const t = 1 - y / (H - 1);
        const f = Math.pow(10, __S.lerp(Math.log10(FMIN), Math.log10(nyq), t));
        const bin = binForHz(f);
        const v = (at(fr, bin) - lo) / (hi - lo);
        const [r, g, b] = __S.inferno(Math.pow(__S.clamp(v, 0, 1), 1.45));
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
      ctx.fillText(fmtHz(f), w - 4, __S.clamp(y - 6, 7, h - 7));
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


/* Published for the files that load after this one. */
Object.assign(__S, { BAR_MIN_DB, Spectrogram, VU_MAX, VU_MIN, drawBars, drawCorrelation, drawSpectrum, drawVu });
})(window.__studio || (window.__studio = {}));
