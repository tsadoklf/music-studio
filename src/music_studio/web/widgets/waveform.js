/* ==========================================================================
   waveform.js — the track in time
   --------------------------------------------------------------------------
   A DAW track laid on the same faceplate as the meters: one lane per channel,
   the classic mirrored min/max about a centre line, the RMS body drawn inside
   the peak envelope so density reads apart from transients.

   Three things make it useful rather than decorative:

     · It draws from the analysis envelope the moment an analysis exists, so
       the panel says something before any audio has been decoded. When the
       engine does hold a decoded buffer it switches to a min/max pyramid
       built from the real samples, so a zoomed view is sample-accurate
       rather than an interpolated 10 Hz envelope. The unit note says which
       source is on screen, quietly.
     · The timed findings sit on the waveform at their own time, in their own
       severity colour — a clip at 0:08 is a mark on the wave, not a row in a
       table somewhere else.
     · The beat grid goes behind everything, bars over beats. A detector that
       is unsure says so by drawing dimmer and captioning itself, because a
       confidently wrong grid is worse than no grid.

   Depends on: core.js. Registered in the tray by tray.js.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';

/* ------------------------------------------------------------------ 4.6 --
   Waveform — the whole track on one axis, zoomable.
   ========================================================================= */

/* --- the sample pyramid --------------------------------------------------
   A 6:44 stereo file is about 35 million samples per channel. Walking those
   once per frame is out of the question, and walking them once per zoom
   change is not much better, so each buffer is reduced exactly once into a
   pyramid of min/max/mean-square triples — level 0 at 256 samples per column,
   each level above it half the resolution of the one below, built from its
   child rather than from the samples again. The whole structure costs one pass
   over the audio and about 1/85th of its size.

   Zoomed in past 256 samples a column, the pyramid is coarser than the picture
   being asked for and the decoded samples are read directly instead — which is
   affordable precisely because a view that narrow holds few samples.

   The cache is a WeakMap keyed on the AudioBuffer itself: load another file
   and the old pyramid becomes garbage with the buffer it described, with no
   bookkeeping here and no way for the two to disagree about which file is on
   screen. */

const BASE_HOP = 256;          // samples per column at the finest level
const PYRAMIDS = new WeakMap();

function buildPyramid(buffer) {
  const cached = PYRAMIDS.get(buffer);
  if (cached) return cached;

  const chs = Math.min(buffer.numberOfChannels, 2);
  const frames = buffer.length;
  const channels = [];
  const raws = [];

  for (let c = 0; c < chs; c++) {
    const data = buffer.getChannelData(c);
    const levels = [];

    /* Level 0, straight off the samples. Three numbers per column, interleaved
       in one Float32Array rather than kept in three: min, max, and the MEAN
       SQUARE of the samples in the column.

       The mean square rather than the RMS itself, because mean squares average
       correctly and root-mean-squares do not: every level above is built by
       reducing the level below, and averaging two RMS figures is not the RMS
       of the pair. The square root is taken once, at the point of drawing. */
    const cols0 = Math.max(1, Math.ceil(frames / BASE_HOP));
    const lv0 = new Float32Array(cols0 * 3);
    for (let i = 0; i < cols0; i++) {
      const s = i * BASE_HOP;
      const e = Math.min(frames, s + BASE_HOP);
      let mn = 0, mx = 0, sq = 0;
      if (e > s) {
        mn = data[s]; mx = data[s];
        for (let j = s; j < e; j++) {
          const v = data[j];
          if (v < mn) mn = v; else if (v > mx) mx = v;
          sq += v * v;
        }
        sq /= (e - s);
      }
      lv0[i * 3] = mn;
      lv0[i * 3 + 1] = mx;
      lv0[i * 3 + 2] = sq;
    }
    levels.push({ hop: BASE_HOP, cols: cols0, data: lv0 });

    /* Every level above is a pairwise reduce of the one below, so the total
       work after the first pass is another single pass over half the data. */
    let prev = levels[0];
    while (prev.cols > 2) {
      const cols = Math.ceil(prev.cols / 2);
      const arr = new Float32Array(cols * 3);
      for (let i = 0; i < cols; i++) {
        const a = i * 2, b = Math.min(prev.cols - 1, a + 1);
        arr[i * 3] = Math.min(prev.data[a * 3], prev.data[b * 3]);
        arr[i * 3 + 1] = Math.max(prev.data[a * 3 + 1], prev.data[b * 3 + 1]);
        arr[i * 3 + 2] = (prev.data[a * 3 + 2] + prev.data[b * 3 + 2]) * 0.5;
      }
      const lv = { hop: prev.hop * 2, cols, data: arr };
      levels.push(lv);
      prev = lv;
    }
    channels.push(levels);
    raws.push(data);
  }

  const pyr = {
    channels,
    /* The decoded Float32Arrays themselves, for the zoomed-in case where the
       pyramid's 256-sample floor is coarser than the picture being drawn.
       These are the buffer's own arrays, not copies, so keeping them costs
       nothing and they die with the buffer. */
    raws,
    sampleRate: buffer.sampleRate,
    duration: buffer.duration,
    frames,
  };
  PYRAMIDS.set(buffer, pyr);
  return pyr;
}

/** The coarsest level that still gives at least one column per pixel, so a
    zoomed-in view reads fine data and a zoomed-out one does not walk 35M
    samples to draw 600 columns. */
function pickLevel(levels, samplesPerPx) {
  let best = 0;
  for (let i = 0; i < levels.length; i++) {
    if (levels[i].hop <= samplesPerPx) best = i; else break;
  }
  return levels[best];
}

/* --- reading the envelope ------------------------------------------------
   analyze.py writes both the linear peak/rms and their dB twins. A waveform
   wants the linear pair — a dB envelope drawn as amplitude is a wall — so
   the linear arrays are preferred and the dB ones are converted only when a
   fixture carries nothing else. core.js's envelopesOf() prefers dB for the
   meters that want dB, which is why this reads the block itself. */

function linearEnvelopes(a) {
  const env = a && a.envelopes;
  const chs = env && __W.arrOf(env.channels);
  if (!chs || !chs.length) return null;

  const fromDb = (arr) => {
    const out = new Float32Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = arr[i];
      out[i] = (typeof v === 'number' && isFinite(v)) ? Math.pow(10, v / 20) : 0;
    }
    return out;
  };
  const asLinear = (lin, db) => {
    if (Array.isArray(lin) && lin.length) return lin;
    if (Array.isArray(db) && db.length) return fromDb(db);
    return null;
  };

  const out = [];
  for (const c of chs) {
    const peak = asLinear(c.peak, c.peak_db);
    const rms = asLinear(c.rms, c.rms_db);
    if (peak || rms) out.push({ peak: peak || rms, rms: rms || peak });
  }
  if (!out.length) return null;

  const n = out[0].peak.length;
  let sps = __W.num(env.seconds_per_point);
  if (!isFinite(sps) || sps <= 0) {
    const pps = __W.num(env.points_per_second);
    sps = (isFinite(pps) && pps > 0) ? 1 / pps : 0;
  }
  return { channels: out, points: n, secondsPerPoint: sps };
}

/* --- the tempo grid ------------------------------------------------------ */

function tempoOf(a) {
  const t = a && a.tempo;
  const beats = t && __W.arrOf(t.beat_times);
  if (!beats || beats.length < 2) return null;
  const conf = __W.num(t.confidence);
  /* "4/4" -> 4. A missing or unparseable meter means beats only: inventing a
     bar length would put downbeats in the wrong place, which is exactly the
     confidently-wrong grid this panel is meant to avoid. */
  let perBar = 0;
  const m = t.meter;
  if (typeof m === 'string') {
    const hit = /^\s*(\d+)\s*\/\s*\d+\s*$/.exec(m);
    if (hit) perBar = parseInt(hit[1], 10);
  } else if (typeof m === 'number' && isFinite(m)) {
    perBar = Math.round(m);
  }
  if (!(perBar >= 2 && perBar <= 16)) perBar = 0;

  return {
    beats,
    bpm: __W.num(t.bpm),
    perBar,
    confidence: isFinite(conf) ? conf : NaN,
    unsure: isFinite(conf) && conf < 0.5,
  };
}

function findingsOf(a) {
  const tl = a && __W.arrOf(a.timeline);
  if (!tl || !tl.length) return [];
  const out = [];
  for (const it of tl) {
    if (!it || typeof it !== 'object') continue;
    const t = __W.num(it.time_s);
    if (!isFinite(t) || t < 0) continue;
    const sev = String(it.severity || 'ok').toLowerCase();
    out.push({
      t,
      severity: (sev === 'bad' || sev === 'warn') ? sev : 'ok',
      title: String(it.title || ''),
      detail: String(it.detail || ''),
      label: String(it.time || __W.fmtTime(t)),
    });
  }
  out.sort((x, y) => x.t - y.t);
  return out;
}

const SEV_COLOUR = { ok: '#6f9f72', warn: '#d9a441', bad: '#cf5340' };

/* --- the time ruler ------------------------------------------------------
   The step is chosen from a fixed ladder rather than computed, because the
   readable divisions of a clock are not powers of ten: a 2-second tick and a
   30-second tick are both natural, a 2.5-second tick never is. */

const TICK_STEPS = [
  0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600,
];

function pickStep(span, width) {
  const want = span / Math.max(2, width / 72);   // a label every ~72 px
  for (const s of TICK_STEPS) if (s >= want) return s;
  return TICK_STEPS[TICK_STEPS.length - 1];
}

/** Clock text at the precision the step deserves: tenths only when the ticks
    are close enough together that whole seconds would repeat. */
function tickLabel(t, step) {
  if (step >= 1) return __W.fmtTime(t);
  const m = Math.floor(t / 60);
  const s = t - m * 60;
  return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

function Waveform(host) {
  /* --- chrome ----------------------------------------------------------- */
  const bar = __W.elem('div', 'meter-bar');

  const fitBtn = __W.elem('button', 'btn wave-btn', 'Fit');
  fitBtn.type = 'button';
  fitBtn.title = 'Show the whole track';

  const zoomOut = __W.elem('button', 'btn wave-btn wave-btn--icon', '−');
  zoomOut.type = 'button';
  zoomOut.title = 'Zoom out';
  zoomOut.setAttribute('aria-label', 'Zoom out');

  const zoomIn = __W.elem('button', 'btn wave-btn wave-btn--icon', '+');
  zoomIn.type = 'button';
  zoomIn.title = 'Zoom in';
  zoomIn.setAttribute('aria-label', 'Zoom in');

  const gridBtn = __W.elem('button', 'btn wave-btn', 'Grid');
  gridBtn.type = 'button';
  gridBtn.title = 'Show or hide the beat and bar grid';

  const status = __W.elem('span', 'meter-status', 'no analysis loaded');

  bar.appendChild(fitBtn);
  bar.appendChild(zoomOut);
  bar.appendChild(zoomIn);
  bar.appendChild(gridBtn);
  bar.appendChild(status);

  const cv = __W.elem('canvas');
  cv.setAttribute('role', 'img');
  cv.tabIndex = 0;
  cv.setAttribute('aria-label',
    'The track as a waveform, with a beat grid and the timed findings');
  const wrap = __W.elem('div', 'scope wave-scope');
  wrap.appendChild(cv);

  /* The tooltip is a DOM node rather than canvas text: it has to stay legible
     over a dark wave at any width, and the page already styles tips this way
     elsewhere. */
  const tip = __W.elem('div', 'wave-tip');
  tip.hidden = true;
  wrap.appendChild(tip);

  /* The overview strip: the whole track, always, with a window showing what
     the main lane is looking at. Drag it to pan — the scrollbar of a DAW. */
  const stripCv = __W.elem('canvas');
  stripCv.setAttribute('role', 'img');
  stripCv.setAttribute('aria-label', 'Overview of the whole track; drag to pan');
  const stripWrap = __W.elem('div', 'scope wave-strip');
  stripWrap.appendChild(stripCv);

  const legend = __W.elem('div', 'meter-legend');

  host.appendChild(bar);
  host.appendChild(wrap);
  host.appendChild(stripWrap);
  host.appendChild(legend);

  const H = 248;                 // the main lane stack
  const STRIP_H = 34;
  const RULER_H = 18;
  const LAMP_H = 9;              // the row the finding heads sit in
  const FOOT_H = 14;             // the engraved strap along the bottom
  const LANE_GAP = 5;            // the gutter between two channel lanes

  /* --- view state -------------------------------------------------------
     `zoom` is how many times the whole track fits in the window (1 = fit),
     `centre` is the middle of the window as a fraction of the track. Keeping
     them normalised rather than in seconds means the view survives a switch
     to a file of a different length without landing off the end. */
  const STORE = 'music-studio.waveform-view';
  let zoom = 1;
  let centre = 0.5;
  let showGrid = true;

  (function restore() {
    const saved = __W.readStore(STORE, null);
    if (!saved) return;
    const z = __W.num(saved.zoom);
    const c = __W.num(saved.centre);
    if (isFinite(z) && z >= 1 && z <= 4096) zoom = z;
    if (isFinite(c) && c >= 0 && c <= 1) centre = c;
    if (typeof saved.grid === 'boolean') showGrid = saved.grid;
  })();

  const persist = () => __W.writeStore(STORE, { zoom, centre, grid: showGrid });

  /* Where the last frame put things, so the pointer handlers can turn an x
     into a time without recomputing the layout or guessing at it. */
  const view = {
    w: 0, plotX: 0, plotW: 1,
    dur: 0, t0: 0, t1: 0,
    lanesY: 0, lanesH: 0,
    marks: [],           // {x, y, r, finding} for hit-testing
    source: 'none',
  };

  function clampView() {
    zoom = __W.clamp(zoom, 1, 4096);
    const half = 0.5 / zoom;
    centre = __W.clamp(centre, half, 1 - half);
    if (zoom <= 1) centre = 0.5;
  }

  function setZoom(next, anchorFrac) {
    const before = __W.clamp(next, 1, 4096);
    const half0 = 0.5 / zoom;
    /* The point under the cursor must not move: convert it to a track
       fraction at the old zoom, then re-centre so it lands there again. */
    const at = (typeof anchorFrac === 'number')
      ? __W.clamp(centre - half0 + anchorFrac * (2 * half0), 0, 1)
      : centre;
    zoom = before;
    const half1 = 0.5 / zoom;
    if (typeof anchorFrac === 'number') centre = at - (anchorFrac - 0.5) * (2 * half1);
    clampView();
    persist();
  }

  fitBtn.addEventListener('click', () => {
    zoom = 1; centre = 0.5; clampView(); persist();
  });
  zoomIn.addEventListener('click', () => setZoom(zoom * 1.8, 0.5));
  zoomOut.addEventListener('click', () => setZoom(zoom / 1.8, 0.5));
  gridBtn.addEventListener('click', () => {
    showGrid = !showGrid;
    gridBtn.setAttribute('aria-pressed', String(showGrid));
    persist();
  });
  gridBtn.setAttribute('aria-pressed', String(showGrid));

  /* --- the pointer ------------------------------------------------------
     A press on a finding marker seeks to the finding. A press anywhere else
     seeks to that point and keeps seeking while the pointer moves, which is
     scrubbing. A press with shift (or the middle button) pans instead, the
     modifier drag the brief asks for and the one every editor uses. */

  const timeAtX = (x) => view.t0 + ((x - view.plotX) / view.plotW) * (view.t1 - view.t0);
  const xAtTime = (t) => view.plotX + ((t - view.t0) / Math.max(1e-6, view.t1 - view.t0)) * view.plotW;

  function seek(seconds) {
    /* studio.js owns the transport. It returns false when no audio is loaded,
       which is a normal state on this page, not a failure. */
    try {
      if (typeof window.seekTo === 'function') return window.seekTo(seconds) !== false;
    } catch (_) { /* a transport that throws is a transport that is not there */ }
    return false;
  }

  function markAt(x, y) {
    let best = null, bestD = Infinity;
    for (const m of view.marks) {
      const dx = x - m.x, dy = y - m.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d <= m.r + 4 && d < bestD) { best = m; bestD = d; }
    }
    return best;
  }

  let drag = null;

  cv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    try { cv.setPointerCapture(e.pointerId); } catch (_) { /* not captured */ }
    e.preventDefault();

    const hit = markAt(x, y);
    if (hit && e.button === 0 && !e.shiftKey) {
      seek(hit.finding.t);
      drag = { kind: 'none' };
      return;
    }
    if (e.shiftKey || e.button === 1 || e.altKey) {
      drag = { kind: 'pan', x, centre };
      cv.classList.add('is-panning');
      return;
    }
    drag = { kind: 'scrub' };
    seek(timeAtX(x));
  });

  cv.addEventListener('pointermove', (e) => {
    const r = cv.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;

    if (drag && drag.kind === 'scrub') { seek(timeAtX(x)); return; }
    if (drag && drag.kind === 'pan') {
      const frac = (x - drag.x) / Math.max(1, view.plotW);
      centre = drag.centre - frac / zoom;
      clampView();
      return;
    }
    if (drag) return;

    /* Hover: the finding's title, where the pointer is. */
    const hit = markAt(x, y);
    if (hit) {
      tip.textContent = hit.finding.label + ' · ' + hit.finding.title;
      tip.hidden = false;
      const tw = tip.offsetWidth || 180;
      tip.style.left = Math.round(__W.clamp(x - tw / 2, 4, Math.max(4, view.w - tw - 4))) + 'px';
      tip.style.top = Math.round(Math.max(2, y - 30)) + 'px';
      cv.style.cursor = 'pointer';
    } else {
      tip.hidden = true;
      cv.style.cursor = '';
    }
  });

  const endDrag = (e) => {
    if (drag && drag.kind === 'pan') { cv.classList.remove('is-panning'); persist(); }
    drag = null;
    try { cv.releasePointerCapture(e.pointerId); } catch (_) { /* already gone */ }
  };
  cv.addEventListener('pointerup', endDrag);
  cv.addEventListener('pointercancel', endDrag);
  cv.addEventListener('pointerleave', () => { if (!drag) { tip.hidden = true; } });

  cv.addEventListener('wheel', (e) => {
    /* The wheel over a waveform is zoom in every editor there is, so it needs
       no modifier — but it does need the page not to scroll under it, which
       is why this listener is not passive. A trackpad pinch arrives here as
       a wheel with ctrlKey set and is handled by the same path. */
    e.preventDefault();
    const r = cv.getBoundingClientRect();
    const anchor = __W.clamp((e.clientX - r.left - view.plotX) / Math.max(1, view.plotW), 0, 1);
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    const k = Math.exp(-e.deltaY * unit * 0.0022);
    setZoom(zoom * k, anchor);
  }, { passive: false });

  cv.addEventListener('keydown', (e) => {
    if (e.key === '+' || e.key === '=') setZoom(zoom * 1.8, 0.5);
    else if (e.key === '-' || e.key === '_') setZoom(zoom / 1.8, 0.5);
    else if (e.key === '0') { zoom = 1; centre = 0.5; clampView(); persist(); }
    else if (e.key === 'ArrowLeft') { centre -= 0.25 / zoom; clampView(); persist(); }
    else if (e.key === 'ArrowRight') { centre += 0.25 / zoom; clampView(); persist(); }
    else return;
    e.preventDefault();
  });

  /* The overview strip pans: press anywhere to put the window there, drag to
     carry it. */
  let stripDrag = false;
  const stripTo = (e) => {
    const r = stripCv.getBoundingClientRect();
    centre = __W.clamp((e.clientX - r.left) / Math.max(1, r.width), 0, 1);
    clampView();
  };
  stripCv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    stripDrag = true;
    try { stripCv.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }
    stripTo(e);
    e.preventDefault();
  });
  stripCv.addEventListener('pointermove', (e) => { if (stripDrag) stripTo(e); });
  const stripEnd = (e) => {
    if (!stripDrag) return;
    stripDrag = false;
    persist();
    try { stripCv.releasePointerCapture(e.pointerId); } catch (_) { /* gone */ }
  };
  stripCv.addEventListener('pointerup', stripEnd);
  stripCv.addEventListener('pointercancel', stripEnd);

  /* --- reading a column out of whichever source we have ------------------
     Both readers answer the same question — over this slice of time, what
     were the extremes and how dense was it — so the drawing code below does
     not care which one it is talking to. */

  /** Below this many samples per column the pyramid's own 256-sample floor is
      coarser than the picture being asked for, and the samples are read
      directly. That only happens once the view is under a second wide, where
      the number of samples on screen is small by definition. */
  const DIRECT_LIMIT = BASE_HOP;

  function columnFromSamples(data, sA, sB) {
    let mn = 0, mx = 0, sq = 0, n = 0;
    const e = Math.min(data.length, sB);
    for (let j = Math.max(0, sA); j < e; j++) {
      const v = data[j];
      if (n === 0) { mn = v; mx = v; }
      else if (v < mn) mn = v; else if (v > mx) mx = v;
      sq += v * v;
      n++;
    }
    return { mn, mx, rms: n ? Math.sqrt(sq / n) : 0 };
  }

  function columnFromPyramid(levels, sr, tA, tB, raw) {
    const sA = Math.max(0, Math.floor(tA * sr));
    const sB = Math.max(sA + 1, Math.ceil(tB * sr));

    /* Zoomed past the pyramid's resolution: read the real samples. */
    if (raw && (sB - sA) <= DIRECT_LIMIT) return columnFromSamples(raw, sA, sB);

    const lv = pickLevel(levels, Math.max(1, (sB - sA)));
    const i0 = Math.max(0, Math.floor(sA / lv.hop));
    const i1 = Math.min(lv.cols - 1, Math.max(i0, Math.ceil(sB / lv.hop) - 1));
    let mn = 0, mx = 0, sq = 0, n = 0;
    for (let i = i0; i <= i1; i++) {
      const a = lv.data[i * 3], b = lv.data[i * 3 + 1];
      if (a < mn) mn = a;
      if (b > mx) mx = b;
      sq += lv.data[i * 3 + 2];      // mean squares average; RMS values do not
      n++;
    }
    return { mn, mx, rms: n ? Math.sqrt(sq / n) : 0 };
  }

  function columnFromEnvelope(ch, sps, tA, tB) {
    const i0 = Math.max(0, Math.floor(tA / sps));
    const i1 = Math.max(i0, Math.min(ch.peak.length - 1, Math.ceil(tB / sps) - 1));
    let pk = 0, rms = 0, n = 0;
    for (let i = i0; i <= i1 && i < ch.peak.length; i++) {
      const p = ch.peak[i];
      if (isFinite(p) && p > pk) pk = p;
      const r = ch.rms[i];
      if (isFinite(r)) { rms += r; n++; }
    }
    if (n) rms /= n;
    /* An envelope has no sign: it is a magnitude per 10 ms. Mirroring it is
       honest about that — the lane is an outline, not a trace of the signal,
       which is exactly why the sample pyramid is preferred when it exists. */
    return { mn: -pk, mx: pk, rms };
  }

  /* --- drawing ---------------------------------------------------------- */

  function faceplate(ctx, w, h) {
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, w, h);
  }

  function drawRuler(ctx, x0, w, y, dur, t0, t1) {
    ctx.save();
    ctx.fillStyle = 'rgba(16,17,14,0.75)';
    ctx.fillRect(x0, y, w, RULER_H);
    /* The gold pinstripe under the ruler is the same rule the rack uses to
       separate a label from what it labels. */
    ctx.fillStyle = 'rgba(168,137,78,0.35)';
    ctx.fillRect(x0, y + RULER_H - 1, w, 1);

    const span = Math.max(1e-3, t1 - t0);
    const step = pickStep(span, w);
    const sub = step / (step >= 1 ? 5 : 5);
    const pxOf = (t) => x0 + ((t - t0) / span) * w;

    ctx.font = `500 9px ${__W.MONO}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'left';

    // sub-ticks first, so the labelled ones draw over them
    ctx.fillStyle = 'rgba(78,80,73,0.45)';
    for (let t = Math.ceil(t0 / sub) * sub; t <= t1 + 1e-9; t += sub) {
      if (t < 0 || t > dur) continue;
      ctx.fillRect(Math.round(pxOf(t)) + 0.5, y + RULER_H - 5, 1, 4);
    }

    for (let t = Math.ceil(t0 / step) * step; t <= t1 + 1e-9; t += step) {
      if (t < -1e-9 || t > dur + 1e-9) continue;
      const px = Math.round(pxOf(t)) + 0.5;
      ctx.fillStyle = 'rgba(168,137,78,0.55)';
      ctx.fillRect(px, y + 3, 1, RULER_H - 4);
      ctx.fillStyle = '#8b8d83';
      const label = tickLabel(t, step);
      /* Keep the last label inside the plot rather than letting it hang off
         the right edge, which at 400 px is the difference between a ruler
         and a clipped smear. */
      const tw = ctx.measureText(label).width;
      const lx = Math.min(px + 3, x0 + w - tw - 1);
      ctx.fillText(label, lx, y + 4);
    }
    ctx.restore();
  }

  function drawGrid(ctx, x0, w, y, h, tempo, t0, t1) {
    if (!tempo || !showGrid) return;
    const span = Math.max(1e-6, t1 - t0);
    const pxOf = (t) => x0 + ((t - t0) / span) * w;
    const beats = tempo.beats;

    /* Below about three pixels a beat, a grid stops being a grid and becomes
       a wash, so it drops out and leaves the bars. */
    const beatPx = (beats.length > 1)
      ? (w / span) * ((beats[beats.length - 1] - beats[0]) / (beats.length - 1))
      : 0;
    const dim = tempo.unsure ? 0.45 : 1;

    ctx.save();
    if (beatPx >= 3) {
      ctx.fillStyle = `rgba(90,96,88,${(0.30 * dim).toFixed(3)})`;
      for (let i = 0; i < beats.length; i++) {
        const t = beats[i];
        if (t < t0 - 1 || t > t1 + 1) continue;
        if (tempo.perBar && i % tempo.perBar === 0) continue;   // drawn as a bar
        ctx.fillRect(Math.round(pxOf(t)) + 0.5, y, 1, h);
      }
    }
    if (tempo.perBar) {
      ctx.fillStyle = `rgba(168,137,78,${(0.34 * dim).toFixed(3)})`;
      for (let i = 0; i < beats.length; i += tempo.perBar) {
        const t = beats[i];
        if (t < t0 - 1 || t > t1 + 1) continue;
        ctx.fillRect(Math.round(pxOf(t)) + 0.5, y, 1, h);
      }
    }
    ctx.restore();
  }

  /** One channel lane: the mirrored peak fill, the RMS body inside it, the
      centre line over both. */
  function drawLane(ctx, x0, w, y, h, col, label) {
    const mid = y + h / 2;
    const half = h / 2 - 1;

    /* The lane well: a shallow inset so each channel reads as its own slot in
       the metal rather than as a band of paint. */
    const well = ctx.createLinearGradient(0, y, 0, y + h);
    well.addColorStop(0, 'rgba(255,255,255,0.028)');
    well.addColorStop(0.5, 'rgba(0,0,0,0)');
    well.addColorStop(1, 'rgba(0,0,0,0.20)');
    ctx.fillStyle = well;
    ctx.fillRect(x0, y, w, h);

    /* The columns are read once and kept: both the peak fill and the RMS body
       need them, and at 1,600 px a second read of the pyramid per lane is the
       most expensive thing this panel would do. */
    const cols = new Array(w);
    for (let i = 0; i < w; i++) cols[i] = col(i);

    /* Both bodies are drawn as one closed outline — down the top edge, back
       along the bottom — rather than as a picket of one-pixel rectangles.
       Rectangles leave a hairline of background between columns wherever two
       neighbours differ, which at high zoom turns a solid wave into a comb;
       a single path has no seams and is one fill rather than `w` of them. */
    const outline = (topOf, botOf) => {
      ctx.beginPath();
      for (let i = 0; i < w; i++) ctx.lineTo(x0 + i, topOf(cols[i], i));
      for (let i = w - 1; i >= 0; i--) ctx.lineTo(x0 + i, botOf(cols[i], i));
      ctx.closePath();
      ctx.fill();
    };

    /* Peak fill. Backlit amber, brighter at the centre line the way a lamp
       behind a dial is brightest where it sits. */
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, '#8e7434');
    g.addColorStop(0.5, '#e7c176');
    g.addColorStop(1, '#8e7434');
    ctx.fillStyle = g;
    outline(
      (c) => mid - Math.max(__W.clamp(c.mx, 0, 1) * half, 0.5),
      (c) => mid - Math.min(__W.clamp(c.mn, -1, 0) * half, -0.5));

    /* RMS body, inside the peak. A deeper, denser tone: where the two are far
       apart the material is transient, where they meet it is dense — which is
       the whole reason a DAW draws both. */
    ctx.fillStyle = 'rgba(186,86,42,0.80)';
    outline(
      (c) => mid - Math.max(__W.clamp(c.rms, 0, 1) * half, 0.5),
      (c) => mid + Math.max(__W.clamp(c.rms, 0, 1) * half, 0.5));

    /* Centre line, and the engraved channel cap at the left. */
    ctx.fillStyle = 'rgba(232,213,168,0.16)';
    ctx.fillRect(x0, Math.round(mid) + 0.5, w, 1);

    /* The channel cap sits at the right. At the left it lands under the
       ruler's 0:00, and two pieces of engraving in the same square inch read
       as a mistake rather than as a label. */
    ctx.save();
    ctx.font = `400 11px ${__W.ENGRAVE}`;
    ctx.letterSpacing = '0.18em';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    /* Inset far enough that the scope's own rounded corner does not clip the
       plate, and the label centred in it rather than hung off its right edge. */
    const capW = 19, capX = x0 + w - capW - 6;
    ctx.fillStyle = 'rgba(10,11,9,0.72)';
    ctx.fillRect(capX, y + 4, capW, 15);
    ctx.fillStyle = 'rgba(168,137,78,0.22)';
    ctx.fillRect(capX, y + 4, capW, 1);
    ctx.fillStyle = '#9a9c92';
    ctx.textAlign = 'center';
    ctx.fillText(label, capX + capW / 2 + 1, y + 5);
    ctx.restore();
  }

  function drawFindings(ctx, x0, w, yTop, yBot, items, t0, t1) {
    view.marks = [];
    if (!items.length) return;
    const span = Math.max(1e-6, t1 - t0);
    const pxOf = (t) => x0 + ((t - t0) / span) * w;

    for (const f of items) {
      if (f.t < t0 - 0.01 || f.t > t1 + 0.01) continue;
      const x = Math.round(pxOf(f.t)) + 0.5;
      const c = SEV_COLOUR[f.severity];

      /* A short tether from the lamp into the top of the wave, and the faintest
         wash below it. A full-strength rule the height of both lanes reads as
         a cut in the audio rather than as a note about it — the finding is an
         annotation, and the waveform is the subject. */
      ctx.save();
      ctx.globalAlpha = 0.5;
      ctx.fillStyle = c;
      ctx.fillRect(x, yTop, 1, 7);
      ctx.globalAlpha = 0.13;
      ctx.fillRect(x, yTop + 7, 1, (yBot - yTop) - 7);
      ctx.restore();

      /* The head is a lamp on the ruler line: a filled disc with a dark rim,
         which is how every indicator on this faceplate is drawn. */
      const cy = yTop - 5;
      ctx.beginPath();
      ctx.arc(x, cy, 4, 0, Math.PI * 2);
      ctx.fillStyle = c;
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = 'rgba(8,9,7,0.85)';
      ctx.stroke();

      view.marks.push({ x, y: cy, r: 4, finding: f });
    }
  }

  function drawPlayhead(ctx, x0, w, yTop, yBot, t, playing) {
    const x = Math.round(x0 + ((t - view.t0) / Math.max(1e-6, view.t1 - view.t0)) * w) + 0.5;
    if (x < x0 - 1 || x > x0 + w + 1) return;
    ctx.save();
    /* Lit amber and solid while running; cool and dashed when stopped. The
       panel should say whether it is moving without the playhead having to
       move to say it, and a dash is legible at a glance where a colour change
       alone is not — especially against the warm wave it sits on. */
    if (playing) {
      ctx.fillStyle = 'rgba(255,180,84,0.92)';
      ctx.fillRect(x, yTop, 1, yBot - yTop);
    } else {
      ctx.strokeStyle = 'rgba(190,193,182,0.78)';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(x, yTop); ctx.lineTo(x, yBot);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    /* The head, in the lamp rail: a filled wedge when running, an outline when
       parked, so the transport state reads from the marker alone. */
    ctx.beginPath();
    ctx.moveTo(x - 4.5, yTop - 1); ctx.lineTo(x + 4.5, yTop - 1); ctx.lineTo(x, yTop + 6);
    ctx.closePath();
    if (playing) {
      ctx.fillStyle = '#ffb454';
      ctx.fill();
    } else {
      ctx.fillStyle = 'rgba(12,13,11,0.9)';
      ctx.fill();
      ctx.strokeStyle = '#bec1b6';
      ctx.lineWidth = 1;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawStrip(ctx, w, h, envel, pyr, dur, items) {
    faceplate(ctx, w, h);
    if (!(dur > 0)) return;

    const mid = h / 2;
    const half = h / 2 - 2;

    /* The overview is always the whole track, and always cheap: one column
       per pixel over 4,000 envelope points or a coarse pyramid level. */
    ctx.fillStyle = 'rgba(140,116,58,0.85)';
    ctx.beginPath();
    for (let i = 0; i < w; i++) {
      const tA = (i / w) * dur, tB = ((i + 1) / w) * dur;
      let mx = 0;
      if (pyr) {
        const c = columnFromPyramid(pyr.channels[0], pyr.sampleRate, tA, tB);   // overview: never below the pyramid
        mx = Math.max(Math.abs(c.mn), Math.abs(c.mx));
      } else if (envel) {
        const c = columnFromEnvelope(envel.channels[0], envel.secondsPerPoint, tA, tB);
        mx = c.mx;
      }
      const a = __W.clamp(mx, 0, 1) * half;
      ctx.rect(i, mid - a, 1, Math.max(1, a * 2));
    }
    ctx.fill();

    for (const f of items) {
      const x = Math.round((f.t / dur) * w) + 0.5;
      ctx.fillStyle = SEV_COLOUR[f.severity];
      ctx.globalAlpha = 0.7;
      ctx.fillRect(x, 0, 1, h);
      ctx.globalAlpha = 1;
    }

    /* The window: everything outside it dimmed, a gold frame around it. */
    const half01 = 0.5 / zoom;
    const a = __W.clamp(centre - half01, 0, 1) * w;
    const b = __W.clamp(centre + half01, 0, 1) * w;
    ctx.fillStyle = 'rgba(7,8,10,0.62)';
    ctx.fillRect(0, 0, a, h);
    ctx.fillRect(b, 0, w - b, h);
    ctx.strokeStyle = zoom > 1 ? 'rgba(216,184,119,0.75)' : 'rgba(168,137,78,0.35)';
    ctx.lineWidth = 1;
    ctx.strokeRect(Math.round(a) + 0.5, 0.5, Math.max(1, Math.round(b - a) - 1), h - 1);
  }

  /* --- the frame -------------------------------------------------------- */

  let lastLegend = '';
  function setLegend(html) {
    if (html === lastLegend) return;
    lastLegend = html;
    legend.innerHTML = html;
  }

  function render(state) {
    const w = __W.boxWidth(cv, 0);
    if (!__W.hasArea(w, H)) return;
    const ctx = __W.fitCanvas(cv, w, H);
    view.w = w;

    const a = state && state.analysis;
    const envel = linearEnvelopes(a);

    /* The decoded buffer, if the engine has one. tray.js reads window.engine
       the same way; a global that is absent or throws is simply "no audio". */
    let buffer = null;
    try {
      const eng = window.engine;
      if (eng && eng.buffer && typeof eng.buffer.getChannelData === 'function') {
        buffer = eng.buffer;
      }
    } catch (_) { /* absent */ }

    let dur = buffer ? buffer.duration : __W.durationOf(a);
    if (!isFinite(dur) || dur <= 0) dur = 0;

    if ((!envel && !buffer) || !(dur > 0)) {
      faceplate(ctx, w, H);
      __W.drawIdle(ctx, w, H, 'no waveform');
      ctx.fillStyle = '#4e5049';
      ctx.font = `400 10.5px ${__W.MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('load an analysis, or open an audio file', w / 2, H / 2 + 4);
      status.textContent = 'no analysis loaded';
      status.classList.remove('is-flag');
      view.marks = [];
      view.source = 'none';
      const sw = __W.boxWidth(stripCv, 0);
      if (__W.hasArea(sw, STRIP_H)) {
        faceplate(__W.fitCanvas(stripCv, sw, STRIP_H), sw, STRIP_H);
      }
      setLegend('<span class="meter-legend-note">' +
        'click to seek · wheel to zoom · shift-drag to pan</span>');
      return;
    }

    /* The pyramid is built once per buffer, on the first frame after it
       arrives, and cached on the buffer itself. Everything after that is a
       read. */
    let pyr = null;
    if (buffer) {
      try { pyr = buildPyramid(buffer); }
      catch (_) { pyr = null; }   // out of memory on a huge file: fall back
    }
    const source = pyr ? 'samples' : 'envelope';
    view.source = source;

    clampView();
    const half = 0.5 / zoom;
    const t0 = __W.clamp(centre - half, 0, 1) * dur;
    const t1 = __W.clamp(centre + half, 0, 1) * dur;
    view.dur = dur; view.t0 = t0; view.t1 = t1;

    faceplate(ctx, w, H);

    const padL = 0, padR = 0;
    const plotX = padL, plotW = Math.max(1, Math.round(w - padL - padR));
    view.plotX = plotX; view.plotW = plotW;

    const chCount = pyr ? pyr.channels.length
                        : Math.min(2, envel ? envel.channels.length : 1);
    const lanesTop = RULER_H + LAMP_H;
    const lanesH = H - lanesTop - FOOT_H;
    const laneH = Math.floor(lanesH / chCount);
    view.lanesY = lanesTop; view.lanesH = lanesH;

    const tempo = tempoOf(a);
    const items = findingsOf(a);

    drawGrid(ctx, plotX, plotW, lanesTop, laneH * chCount, tempo, t0, t1);

    /* One column reader per channel, closing over whichever source won. The
       lane drawer asks for column i and does not know or care which. */
    for (let c = 0; c < chCount; c++) {
      const y = lanesTop + c * laneH;
      const label = chCount > 1 ? (c === 0 ? 'L' : 'R') : 'M';
      const col = (i) => {
        const tA = t0 + (i / plotW) * (t1 - t0);
        const tB = t0 + ((i + 1) / plotW) * (t1 - t0);
        if (pyr) {
          const ci = Math.min(c, pyr.channels.length - 1);
          return columnFromPyramid(pyr.channels[ci], pyr.sampleRate, tA, tB,
                                   pyr.raws[ci]);
        }
        const ch = envel.channels[Math.min(c, envel.channels.length - 1)];
        return columnFromEnvelope(ch, envel.secondsPerPoint, tA, tB);
      };
      drawLane(ctx, plotX, plotW, y, laneH - LANE_GAP, col, label);
    }

    const lanesBottom = lanesTop + laneH * chCount;

    /* The gutter between lanes, drawn after both so neither wave spills into
       it. Two channels butted together read as one tall waveform; a rule with
       a catch-light on its lower edge reads as two slots in the same plate. */
    for (let c = 1; c < chCount; c++) {
      const yG = lanesTop + c * laneH - LANE_GAP;
      ctx.fillStyle = 'rgba(4,5,4,0.95)';
      ctx.fillRect(plotX, yG, plotW, LANE_GAP);
      ctx.fillStyle = 'rgba(168,137,78,0.13)';
      ctx.fillRect(plotX, yG + LANE_GAP - 1, plotW, 1);
    }

    drawRuler(ctx, plotX, plotW, 0, dur, t0, t1);
    drawFindings(ctx, plotX, plotW, lanesTop, lanesBottom, items, t0, t1);

    /* The playhead. state.playhead is a 0..1 fraction of the track, which is
       what every other meter here is given. */
    const ph = state && __W.num(state.playhead);
    if (isFinite(ph) && ph >= 0 && ph <= 1) {
      drawPlayhead(ctx, plotX, plotW, lanesTop, lanesBottom, ph * dur, !!(state && state.playing));
    }

    /* The footer strap: what is on screen, in the engraved hand. It gets its
       own band under the lanes rather than sitting over the bottom channel —
       lettering across a waveform is unreadable and makes the lane look cut
       off at the knees. */
    ctx.save();
    ctx.fillStyle = '#07080a';
    ctx.fillRect(plotX, lanesBottom, plotW, H - lanesBottom);
    ctx.fillStyle = 'rgba(168,137,78,0.22)';
    ctx.fillRect(plotX, lanesBottom, plotW, 1);
    ctx.font = `400 10px ${__W.ENGRAVE}`;
    ctx.letterSpacing = '0.18em';
    ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#4e5049';
    ctx.textAlign = 'left';
    ctx.fillText(__W.fmtTime(t0).toUpperCase(), plotX + 3, H - 2);
    ctx.textAlign = 'right';
    ctx.fillText(__W.fmtTime(t1).toUpperCase(), plotX + plotW - 3, H - 2);
    ctx.textAlign = 'center';
    let strap = source === 'samples' ? 'SAMPLES' : 'ENVELOPE';
    if (tempo && showGrid) {
      strap += ' · ' + (isFinite(tempo.bpm) ? tempo.bpm.toFixed(1) : '?') + ' BPM';
      if (tempo.unsure) strap += ' · GRID UNCERTAIN';
    }
    ctx.fillText(strap, plotX + plotW / 2, H - 2);
    ctx.restore();

    /* --- the overview strip ------------------------------------------- */
    const sw = __W.boxWidth(stripCv, 0);
    if (__W.hasArea(sw, STRIP_H)) {
      drawStrip(__W.fitCanvas(stripCv, sw, STRIP_H), sw, STRIP_H, envel, pyr, dur, items);
    }

    /* --- status and legend -------------------------------------------- */
    const span = t1 - t0;
    status.textContent = zoom > 1.001
      ? `${__W.fmtTime(t0)}–${__W.fmtTime(t1)} · ${span < 10 ? span.toFixed(1) : Math.round(span)} s · ×${zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}`
      : `whole track · ${__W.fmtTime(dur)}`;
    status.classList.toggle('is-flag', items.some((f) => f.severity === 'bad'));

    let html =
      '<span><i class="key key--wave-peak"></i>peak</span>' +
      '<span><i class="key key--wave-rms"></i>RMS</span>';
    if (tempo && showGrid) {
      html += tempo.perBar
        ? '<span><i class="key key--wave-bar"></i>bars over beats</span>'
        : '<span><i class="key key--wave-bar"></i>beats' +
          (isFinite(tempo.bpm) ? ' at ' + tempo.bpm.toFixed(1) + ' BPM' : '') + '</span>';
      if (tempo.unsure) {
        html += '<span class="meter-legend-note">grid drawn dim: the detector is ' +
          (isFinite(tempo.confidence) ? Math.round(tempo.confidence * 100) + '%' : 'not') +
          ' sure, so treat it as a guess</span>';
      }
    }
    if (items.length) {
      html += '<span><i class="key key--bad"></i>findings · click one to seek</span>';
    }
    html += '<span class="meter-legend-note">' +
      (source === 'samples'
        ? 'drawn from the decoded samples'
        : 'drawn from the analysis envelope' +
          (envel ? ' · ' + Math.round(1 / (envel.secondsPerPoint || 0.01)) + ' points/s' : '')) +
      ' · wheel to zoom, shift-drag to pan</span>';
    setLegend(html);
  }

  return {
    render,
    reset() {
      /* A new file: back to the whole track. The zoom of the last one means
         nothing on this one, and landing at ×40 somewhere in the middle of a
         track you have just opened is disorienting rather than helpful. */
      zoom = 1;
      centre = 0.5;
      view.marks = [];
      tip.hidden = true;
      persist();
      const w = __W.boxWidth(cv, 0);
      if (__W.hasArea(w, H)) {
        const ctx = __W.fitCanvas(cv, w, H);
        faceplate(ctx, w, H);
        __W.drawIdle(ctx, w, H, 'no waveform');
      }
      const sw = __W.boxWidth(stripCv, 0);
      if (__W.hasArea(sw, STRIP_H)) {
        faceplate(__W.fitCanvas(stripCv, sw, STRIP_H), sw, STRIP_H);
      }
      status.textContent = 'no analysis loaded';
      status.classList.remove('is-flag');
    },
  };
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { Waveform });

})(window.__studioWidgets || (window.__studioWidgets = {}));
