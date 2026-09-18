/* ==========================================================================
   core.js — shared helpers
   --------------------------------------------------------------------------
   Canvas fitting for the device pixel ratio, the two colour maps, the log
   frequency scale, number and time formatting, localStorage access that
   survives a private window, and the readers that pull loudness, envelopes,
   targets and codec facts out of an analysis JSON.

   Depends on nothing. Loads first; every other file uses it.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/* ==========================================================================
   1. Helpers
   ========================================================================== */

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a, b, t) => a + (b - a) * t;

/** A canvas in a collapsed card measures 0 wide, and createRadialGradient
 *  throws on a negative radius. Same guard studio.js uses; every draw call
 *  here checks it and skips the frame rather than filling the console. */
function hasArea(w, h) {
  return Number.isFinite(w) && Number.isFinite(h) && w > 1 && h > 1;
}

/** Size a canvas for the device pixel ratio; returns the 2D context. */
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

/** The width a canvas should draw at, from the box it sits in. */
function boxWidth(cv, fallback) {
  const p = cv.parentElement;
  const w = p ? p.clientWidth : 0;
  return w > 1 ? w : (fallback || 0);
}

const MONO = '"Spline Sans Mono", Menlo, monospace';
const ENGRAVE = '"Bebas Neue", "Arial Narrow", sans-serif';

/* --- inferno and magma, 16 stops each -----------------------------------
   Both are perceptually uniform; inferno matches the map studio.js already
   draws so the two spectrograms on the page agree, and magma is offered as
   the cooler alternative for material where inferno's ember top end reads as
   more level than it is. */

const INFERNO = [
  [  0,   0,   4], [ 12,   8,  38], [ 36,  12,  79], [ 66,  10, 104],
  [ 93,  18, 110], [120,  28, 109], [147,  38, 103], [174,  48,  92],
  [199,  62,  76], [220,  80,  57], [237, 105,  37], [247, 135,  17],
  [251, 167,   9], [249, 200,  41], [243, 231,  95], [252, 255, 164],
];

const MAGMA = [
  [  0,   0,   4], [ 10,   7,  35], [ 28,  16,  68], [ 52,  16, 104],
  [ 79,  18, 123], [104,  28, 129], [130,  37, 129], [157,  45, 122],
  [183,  55, 112], [208,  66,  98], [229,  82,  86], [243, 106,  80],
  [250, 136,  91], [253, 168, 116], [254, 200, 150], [252, 253, 191],
];

function sampleMap(stops, t) {
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const x = t * (stops.length - 1);
  const i = Math.min(stops.length - 2, Math.floor(x));
  const f = x - i;
  const a = stops[i], b = stops[i + 1];
  return [a[0] + (b[0] - a[0]) * f,
          a[1] + (b[1] - a[1]) * f,
          a[2] + (b[2] - a[2]) * f];
}

const inferno = (t) => sampleMap(INFERNO, t);
const magma = (t) => sampleMap(MAGMA, t);

/* --- frequency axis, shared with studio.js's scopes ---------------------- */

const FMIN = 20, FMAX = 22050;
const LOG_MIN = Math.log10(FMIN), LOG_MAX = Math.log10(FMAX);

function fToT(f) {
  return (Math.log10(clamp(f, FMIN, FMAX)) - LOG_MIN) / (LOG_MAX - LOG_MIN);
}
function tToF(t) {
  return Math.pow(10, lerp(LOG_MIN, LOG_MAX, clamp(t, 0, 1)));
}
function fmtHz(f) {
  if (f >= 10000) return Math.round(f / 1000) + 'k';
  if (f >= 1000) return (Math.round(f / 100) / 10) + 'k';
  return String(Math.round(f));
}

/** Signed value with the typographic minus the rest of the page uses. */
function sgn(v, digits = 1) {
  if (!isFinite(v)) return '−∞';
  const s = Math.abs(v).toFixed(digits);
  return (v < 0 ? '−' : '+') + s;
}
function fmtLu(v, digits = 1) {
  if (!isFinite(v) || v <= -70) return '−∞';
  return (v < 0 ? '−' : '') + Math.abs(v).toFixed(digits);
}
function fmtTime(sec) {
  if (!isFinite(sec) || sec < 0) sec = 0;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* --- DOM ----------------------------------------------------------------- */

function elem(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

/* --- storage ------------------------------------------------------------
   localStorage throws outright in a private window, so every access is
   guarded and a failure simply means the bench forgets its arrangement. */

function readStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const v = JSON.parse(raw);
    return (v && typeof v === 'object') ? v : fallback;
  } catch { return fallback; }
}

function writeStore(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); }
  catch { /* nothing to do */ }
}

/* --- reading the analysis ------------------------------------------------
   Every accessor is total: a missing block, a wrong type or a null yields
   the empty answer rather than an exception, because the page must render
   before anything has been loaded. */

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : NaN; }

function arrOf(v) { return Array.isArray(v) ? v : null; }

function shortTermOf(a) {
  const st = a && a.loudness && a.loudness.short_term;
  if (!st) return null;
  const lufs = arrOf(st.lufs);
  if (!lufs || !lufs.length) return null;
  return { lufs, times: arrOf(st.times) };
}

function momentaryOf(a) {
  const m = a && a.loudness && a.loudness.momentary;
  if (!m) return null;
  const lufs = arrOf(m.lufs);
  if (!lufs || !lufs.length) return null;
  return { lufs, times: arrOf(m.times) };
}

function envelopesOf(a) {
  const ch = a && a.envelopes && arrOf(a.envelopes.channels);
  if (!ch || !ch.length) return null;
  // analyze.py writes peak_db / rms_db; the brief names them peak / rms.
  // Accept either, so a hand-made fixture works as well as the real file.
  const out = ch.map((c) => ({
    peak: arrOf(c.peak_db) || arrOf(c.peak) || null,
    rms: arrOf(c.rms_db) || arrOf(c.rms) || null,
  })).filter((c) => c.peak || c.rms);
  return out.length ? out : null;
}

function targetsOf(a) {
  const t = (a && a.targets) || {};
  const lufs = num(t.integrated_lufs);
  const tp = num(t.true_peak_dbtp);
  return {
    lufs: isFinite(lufs) ? lufs : -14,
    tp: isFinite(tp) ? tp : -1,
    stated: isFinite(lufs),
  };
}

function codecOf(a) {
  const c = (a && a.codec) || {};
  const hz = num(c.cutoff_hz);
  return {
    hz: isFinite(hz) ? hz : 0,
    lossy: !!c.lossy_suspected,
  };
}

function durationOf(a) {
  const d = num(a && a.metadata && a.metadata.duration);
  if (isFinite(d)) return d;
  const st = shortTermOf(a);
  if (st && st.times && st.times.length) return st.times[st.times.length - 1];
  return 0;
}

/* Everything that draws an empty instrument says the same thing in the same
   place, so an unloaded bench reads as one machine at rest rather than five
   different kinds of blank. */
function drawIdle(ctx, w, h, line) {
  ctx.save();
  ctx.fillStyle = '#07080a';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(78,80,73,0.28)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, Math.round(h / 2) + 0.5);
  ctx.lineTo(w, Math.round(h / 2) + 0.5);
  ctx.stroke();
  ctx.fillStyle = '#5c5e56';
  ctx.font = `400 11px ${ENGRAVE}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.letterSpacing = '0.20em';
  ctx.fillText(String(line).toUpperCase(), w / 2, h / 2 - 12);
  ctx.restore();
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { clamp, lerp, hasArea, fitCanvas, boxWidth, MONO, ENGRAVE, INFERNO, MAGMA, sampleMap, inferno, magma, FMIN, FMAX, LOG_MIN, LOG_MAX, fToT, tToF, fmtHz, sgn, fmtLu, fmtTime, elem, readStore, writeStore, num, arrOf, shortTermOf, momentaryOf, envelopesOf, targetsOf, codecOf, durationOf, drawIdle });

})(window.__studioWidgets || (window.__studioWidgets = {}));
