/* ==========================================================================
   spectrum.js — spectrum and spectrogram
   --------------------------------------------------------------------------
   One panel with a selector, because an average spectrum answers "what is the
   balance of this master", a live curve answers "what is happening now", and a
   spectrogram answers "where in the track". Marks a codec brick wall where the
   analysis detected one.

   Depends on: core.js. Registered in the tray by tray.js.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/* ------------------------------------------------------------------ 4.3 --
   SpectrumPanel — one scope, four views, chosen deliberately.

   The page's existing Colour map card shows a live spectrum and a
   spectrogram at once, which reads as one instrument but is two different
   measurements: an average over the whole file answers "what is the tone of
   this master", a live curve answers "what is happening now", and a
   spectrogram answers "where in the track". Splitting them behind a selector
   means whichever is on screen is the one being asked about.
   ========================================================================= */

const SPEC_VIEWS = [
  ['avg', 'Spectrum (average)'],
  ['live', 'Spectrum (live)'],
  ['gram', 'Spectrogram'],
  ['gram-log', 'Spectrogram (log)'],
];

const SPEC_LABELS = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 16000, 20000];

function SpectrumPanel(host) {
  const bar = __W.elem('div', 'meter-bar');
  const sel = __W.elem('select', 'faceplate-select');
  sel.setAttribute('aria-label', 'Which spectrum view to show');
  for (const [v, label] of SPEC_VIEWS) {
    const opt = __W.elem('option', null, label);
    opt.value = v;
    sel.appendChild(opt);
  }
  const mapSel = __W.elem('select', 'faceplate-select faceplate-select--small');
  mapSel.setAttribute('aria-label', 'Spectrogram colour map');
  for (const [v, label] of [['inferno', 'Inferno'], ['magma', 'Magma']]) {
    const opt = __W.elem('option', null, label);
    opt.value = v;
    mapSel.appendChild(opt);
  }
  const status = __W.elem('span', 'meter-status', 'no analysis loaded');
  bar.appendChild(sel);
  bar.appendChild(mapSel);
  bar.appendChild(status);

  const cv = __W.elem('canvas');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', 'Spectrum');
  const wrap = __W.elem('div', 'scope');
  wrap.appendChild(cv);

  const legend = __W.elem('div', 'scope-legend meter-legend');

  host.appendChild(bar);
  host.appendChild(wrap);
  host.appendChild(legend);

  const H = 210;
  let view = 'avg';
  let mapName = 'inferno';

  const STORE = 'music-studio.spectrum-view';
  const saved = __W.readStore(STORE, null);
  if (saved && typeof saved.view === 'string' &&
      SPEC_VIEWS.some(([v]) => v === saved.view)) view = saved.view;
  if (saved && (saved.map === 'magma' || saved.map === 'inferno')) mapName = saved.map;
  sel.value = view;
  mapSel.value = mapName;

  const persist = () => __W.writeStore(STORE, { view, map: mapName });

  sel.addEventListener('change', () => {
    view = sel.value;
    gramSig = '';                 // the cached image belongs to the other axis
    persist();
    syncControls();
  });
  mapSel.addEventListener('change', () => {
    mapName = mapSel.value;
    gramSig = '';
    persist();
  });

  function syncControls() {
    const isGram = view === 'gram' || view === 'gram-log';
    mapSel.hidden = !isGram;
    legend.innerHTML = isGram
      ? '<span><span class="swatch" data-map="' + mapName + '"></span>quiet → loud</span>' +
        '<span>' + (view === 'gram-log' ? 'log frequency, 20 Hz – 22 kHz'
                                        : 'linear frequency to Nyquist') + '</span>' +
        '<span>time runs left to right</span>'
      : '<span>log frequency, 20 Hz – 22 kHz</span>' +
        '<span>' + (view === 'live' ? 'live FFT, 4096 points'
                                    : 'average over the whole file') + '</span>';
    const sw = legend.querySelector('.swatch');
    if (sw) {
      const stops = (mapName === 'magma' ? __W.MAGMA : __W.INFERNO)
        .map((c) => `rgb(${c[0]},${c[1]},${c[2]})`).join(',');
      sw.style.background = `linear-gradient(90deg, ${stops})`;
    }
  }
  syncControls();

  /* The spectrogram is expensive to rasterise, so it is drawn once into an
     offscreen buffer and re-blitted until the data, the axis or the map
     changes. A per-frame rebuild of a 128×240 image map costs more than
     every other meter on the page put together. */
  const gram = document.createElement('canvas');
  gram.width = 720;
  gram.height = 240;
  const gctx = gram.getContext('2d');
  let gramSig = '';

  function buildGram(a) {
    const sg = a && a.spectrogram;
    const flat = sg && __W.arrOf(sg.db);
    const shape = sg && __W.arrOf(sg.shape);
    if (!flat || !shape || shape.length < 2) return false;

    const sig = [view, mapName, flat.length, shape[0], shape[1],
                 a.metadata && a.metadata.filename].join('|');
    if (sig === gramSig) return true;

    const freqMajor = !/time-major/.test(String(sg.layout || 'freq-major'));
    const bins = freqMajor ? shape[0] : shape[1];
    const frames = freqMajor ? shape[1] : shape[0];
    if (!(bins > 0 && frames > 0)) return false;
    const at = freqMajor
      ? (t, f) => flat[f * frames + t]
      : (t, f) => flat[t * bins + f];

    const freqs = __W.arrOf(sg.freqs);
    const nyq = (freqs && freqs.length) ? freqs[freqs.length - 1]
      : (__W.num(a.metadata && a.metadata.sample_rate) / 2 || __W.FMAX);

    /* Percentile normalisation, then a 70 dB window: the absolute min and
       max let one loud bin push everything audible into a single colour. */
    const fin = [];
    for (let i = 0; i < flat.length; i++) if (isFinite(flat[i])) fin.push(flat[i]);
    if (!fin.length) return false;
    fin.sort((x, y) => x - y);
    let hi = fin[Math.floor(fin.length * 0.995)];
    let lo = fin[Math.floor(fin.length * 0.02)];
    if (hi - lo > 70) lo = hi - 70;
    if (!(hi > lo)) { lo = 0; hi = 1; }

    const binForHz = (hz) => {
      if (freqs && freqs.length === bins) {
        let a0 = 0, b0 = bins - 1;
        while (a0 < b0) {
          const mid = (a0 + b0) >> 1;
          if (freqs[mid] < hz) a0 = mid + 1; else b0 = mid;
        }
        return a0;
      }
      return __W.clamp(Math.round(hz / nyq * bins), 0, bins - 1);
    };

    const W = gram.width, GH = gram.height;
    const img = gctx.createImageData(W, GH);
    const d = img.data;
    const cmap = mapName === 'magma' ? __W.magma : __W.inferno;
    const logAxis = view === 'gram-log';

    for (let x = 0; x < W; x++) {
      const fr = Math.min(frames - 1, Math.floor(x / W * frames));
      for (let y = 0; y < GH; y++) {
        const t = 1 - y / (GH - 1);
        const bin = logAxis
          ? binForHz(Math.pow(10, __W.lerp(__W.LOG_MIN, Math.log10(Math.max(nyq, __W.FMIN + 1)), t)))
          : __W.clamp(Math.round(t * (bins - 1)), 0, bins - 1);
        const raw = at(fr, bin);
        const v = isFinite(raw) ? (raw - lo) / (hi - lo) : 0;
        const c = cmap(Math.pow(__W.clamp(v, 0, 1), 1.45));
        const o = (y * W + x) * 4;
        d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
      }
    }
    gctx.putImageData(img, 0, 0);
    gramSig = sig;
    return true;
  }

  /* --- the two curve views ------------------------------------------- */

  function drawCurve(ctx, w, h, col, nyq) {
    const padB = 18, padT = 6;
    const plotH = Math.max(1, h - padB - padT);

    ctx.font = `500 9px ${__W.MONO}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (const f of SPEC_LABELS) {
      if (f > nyq * 1.02) continue;
      const x = Math.round(__W.fToT(f) * w) + 0.5;
      ctx.fillStyle = 'rgba(78,80,73,0.30)';
      ctx.fillRect(x, padT, 1, plotH);
      ctx.fillStyle = '#5c5e56';
      ctx.fillText(__W.fmtHz(f), __W.clamp(x, 14, w - 14), h - padB + 4);
    }
    for (let d = -20; d >= -80; d -= 20) {
      const y = Math.round(padT + (-d / 90) * plotH) + 0.5;
      ctx.fillStyle = 'rgba(78,80,73,0.18)';
      ctx.fillRect(0, y, w, 1);
      ctx.fillStyle = '#4e5049';
      ctx.textAlign = 'left';
      ctx.fillText(String(d), 3, y + 2);
      ctx.textAlign = 'center';
    }

    if (!col) return;

    const yOf = (t01) => padT + (1 - __W.clamp(t01, 0, 1)) * plotH;

    ctx.beginPath();
    ctx.moveTo(0, padT + plotH);
    let started = false;
    for (let x = 0; x < col.length; x++) {
      if (!isFinite(col[x])) continue;
      const y = yOf(col[x]);
      if (!started) { ctx.lineTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    if (!started) return;
    ctx.lineTo(col.length - 1, padT + plotH);
    ctx.closePath();
    const fill = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    fill.addColorStop(0, 'rgba(255,180,84,0.34)');
    fill.addColorStop(1, 'rgba(255,180,84,0.03)');
    ctx.fillStyle = fill;
    ctx.fill();

    ctx.beginPath();
    started = false;
    for (let x = 0; x < col.length; x++) {
      if (!isFinite(col[x])) continue;
      const y = yOf(col[x]);
      if (!started) { ctx.moveTo(x, y); started = true; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = '#ffcf8a';
    ctx.lineWidth = 1.3;
    ctx.stroke();
  }

  /** Reduce a bin array to one normalised 0..1 value per pixel column,
      taking the max within the column so a narrow peak survives the log
      axis rather than falling between two pixels. */
  function columnsFromBins(w, bins, freqAt, lo, hi) {
    const col = new Float32Array(Math.max(1, Math.ceil(w)));
    col.fill(NaN);
    for (let i = 1; i < bins.length; i++) {
      const f = freqAt(i);
      if (!(f >= __W.FMIN)) continue;
      const x = Math.floor(__W.fToT(f) * (w - 1));
      if (x < 0 || x >= col.length) continue;
      const v = (bins[i] - lo) / (hi - lo);
      if (!(col[x] >= v)) col[x] = v;
    }
    let last = NaN;
    for (let x = 0; x < col.length; x++) {
      if (isNaN(col[x])) col[x] = last; else last = col[x];
    }
    return col;
  }

  function markCutoff(ctx, w, h, a) {
    const c = __W.codecOf(a);
    if (!(c.hz > 1000 && c.hz < __W.FMAX && c.lossy)) return false;
    const x = Math.round(__W.fToT(c.hz) * w) + 0.5;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#cf5340';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x, h - 18);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#cf5340';
    ctx.font = `500 9.5px ${__W.MONO}`;
    ctx.textBaseline = 'top';
    const right = x > w * 0.68;
    ctx.textAlign = right ? 'right' : 'left';
    ctx.fillText('codec cutoff ' + __W.fmtHz(c.hz) + 'Hz', x + (right ? -5 : 5), 4);
    ctx.textAlign = 'center';
    return true;
  }

  function markCutoffHorizontal(ctx, w, h, a, nyq, logAxis) {
    const c = __W.codecOf(a);
    if (!(c.hz > 1000 && c.lossy)) return false;
    const t = logAxis
      ? (Math.log10(__W.clamp(c.hz, FMIN, nyq)) - __W.LOG_MIN) / (Math.log10(nyq) - __W.LOG_MIN)
      : __W.clamp(c.hz / nyq, 0, 1);
    const y = Math.round((1 - t) * h) + 0.5;
    ctx.save();
    ctx.setLineDash([4, 3]);
    ctx.strokeStyle = '#ff6a50';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#ff6a50';
    ctx.font = `500 9.5px ${__W.MONO}`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'bottom';
    ctx.fillText('codec cutoff ' + __W.fmtHz(c.hz) + 'Hz', 5, __W.clamp(y - 3, 11, h - 3));
    return true;
  }

  function render(state) {
    const w = __W.boxWidth(cv, 0);
    if (!__W.hasArea(w, H)) return;
    const ctx = __W.fitCanvas(cv, w, H);
    ctx.clearRect(0, 0, w, H);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, w, H);

    const a = state && state.analysis;
    const live = (state && state.live) || {};
    const sr = __W.num(a && a.metadata && a.metadata.sample_rate);
    const nyq = isFinite(sr) ? sr / 2 : 24000;
    let flagged = false;

    if (view === 'gram' || view === 'gram-log') {
      if (buildGram(a)) {
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(gram, 0, 0, gram.width, gram.height, 0, 0, w, H);
        flagged = markCutoffHorizontal(ctx, w, H, a, nyq, view === 'gram-log');

        /* frequency guides over the map */
        ctx.font = `500 9px ${__W.MONO}`;
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'right';
        for (const f of [100, 1000, 10000]) {
          if (f > nyq) continue;
          const t = view === 'gram-log'
            ? (Math.log10(f) - __W.LOG_MIN) / (Math.log10(nyq) - __W.LOG_MIN)
            : f / nyq;
          const y = (1 - t) * H;
          ctx.fillStyle = 'rgba(255,255,255,0.18)';
          ctx.fillRect(0, Math.round(y) + 0.5, w, 1);
          ctx.fillStyle = 'rgba(255,255,255,0.5)';
          ctx.fillText(__W.fmtHz(f), w - 5, __W.clamp(y - 7, 8, H - 8));
        }

        const ph = __W.num(state && state.playhead);
        if (isFinite(ph) && ph >= 0 && ph <= 1) {
          ctx.fillStyle = 'rgba(255,255,255,0.75)';
          ctx.fillRect(Math.round(ph * w), 0, 1, H);
        }
      } else {
        __W.drawIdle(ctx, w, H, 'no spectrogram');
      }
    } else if (view === 'live') {
      const bins = live.spectrum;
      if (bins && bins.length) {
        // The host hands over the analyser's own byte data (0..255 over
        // -90..0 dB) or a float dB array; both normalise the same way.
        const isBytes = bins instanceof Uint8Array;
        const lo = isBytes ? 0 : -90, hi = isBytes ? 255 : 0;
        const col = columnsFromBins(w, bins, (i) => i * nyq / bins.length, lo, hi);
        drawCurve(ctx, w, H, col, nyq);
      } else {
        drawCurve(ctx, w, H, null, nyq);
        ctx.fillStyle = '#5c5e56';
        ctx.font = `400 11px ${__W.ENGRAVE}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.letterSpacing = '0.20em';
        ctx.fillText('PRESS PLAY FOR A LIVE CURVE', w / 2, H / 2);
        ctx.letterSpacing = '0em';
      }
      flagged = markCutoff(ctx, w, H, a);
    } else {
      const spec = (a && a.spectrum) || {};
      const db = __W.arrOf(spec.db);
      const freqs = __W.arrOf(spec.freqs);
      if (db && db.length) {
        let lo = Infinity, hi = -Infinity;
        for (const v of db) {
          if (!isFinite(v)) continue;
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        if (!(hi > lo)) { lo = 0; hi = 1; }
        if (hi - lo > 90) lo = hi - 90;
        const freqAt = (freqs && freqs.length === db.length)
          ? (i) => freqs[i]
          : (i) => i * nyq / db.length;
        drawCurve(ctx, w, H, columnsFromBins(w, db, freqAt, lo, hi), nyq);
      } else {
        drawCurve(ctx, w, H, null, nyq);
        ctx.fillStyle = '#5c5e56';
        ctx.font = `400 11px ${__W.ENGRAVE}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.letterSpacing = '0.20em';
        ctx.fillText('NO AVERAGE SPECTRUM', w / 2, H / 2);
        ctx.letterSpacing = '0em';
      }
      flagged = markCutoff(ctx, w, H, a);
    }

    const c = __W.codecOf(a);
    status.textContent = !a ? 'no analysis loaded'
      : flagged ? `brick wall at ${__W.fmtHz(c.hz)}Hz — lossy source`
      : c.hz ? `content to ${__W.fmtHz(c.hz)}Hz`
      : 'full bandwidth';
    status.classList.toggle('is-flag', flagged);
  }

  return {
    render,
    reset() {
      gramSig = '';
      status.textContent = 'no analysis loaded';
      status.classList.remove('is-flag');
      const w = __W.boxWidth(cv, 0);
      if (!__W.hasArea(w, H)) return;
      const ctx = __W.fitCanvas(cv, w, H);
      __W.drawIdle(ctx, w, H, 'no analysis');
    },
  };
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { SPEC_VIEWS, SPEC_LABELS, SpectrumPanel });

})(window.__studioWidgets || (window.__studioWidgets = {}));
