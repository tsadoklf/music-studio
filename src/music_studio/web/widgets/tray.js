/* ==========================================================================
   tray.js — the tray, the mount, and the self-drive loop
   --------------------------------------------------------------------------
   Which meters are on the bench and in what order, both persisted; the
   mount/render/reset plumbing; and the self-driving loop that assembles a
   state once per frame out of the two globals studio.js publishes
   (window.StudioAnalysis and window.engine), so the bench works even though
   studio.js has no reference to it.

   Reordering uses pointer events rather than HTML5 drag-and-drop: the native
   API needs a dataTransfer payload, fires no move events on the source, and on
   a touch screen does nothing at all.

   Publishes window.StudioMeters. Must load last: METERS names every meter
   factory, so every widget file has to have run first.

   Depends on: core.js and all five meter files.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/* ==========================================================================
   5. The tray
   --------------------------------------------------------------------------
   Which meters are on the bench, and in what order. Both are the user's
   arrangement, so both persist; localStorage can throw outright in a private
   window, so a failure simply means the bench forgets.

   Reordering is done with pointer events rather than HTML5 drag-and-drop: the
   native API needs a dataTransfer payload, fires no move events on the source,
   and on a touch screen does nothing at all. A pointer drag with capture works
   everywhere and lets the list reflow under the finger as it moves.
   ========================================================================= */

const METERS = [
  { id: 'waveform', name: 'Waveform',
    note: 'the track in time · beats, findings, and a playhead',
    make: __W.Waveform },
  { id: 'loudness-time', name: 'Loudness over time',
    note: 'short-term LUFS against the delivery target',
    make: __W.LoudnessOverTime },
  { id: 'goniometer', name: 'Goniometer',
    note: 'L against R, rotated 45° · phosphor persistence',
    make: __W.Goniometer },
  { id: 'spectrum', name: 'Spectrum',
    note: 'average, live, or as a spectrogram',
    make: __W.SpectrumPanel },
  { id: 'dynamics', name: 'Dynamics history',
    note: 'crest factor and loudness range over the track',
    make: __W.DynamicsHistory },
  { id: 'equalizer', name: 'Equalizer',
    note: 'presets and bands for master.py --eq',
    make: __W.EqualizerPanel },
  { id: 'equalizer2', name: 'Equalizer II',
    note: 'a second 5-band parametric, rack-mounted · cascades after the first',
    make: __W.Equalizer2 },
  { id: 'maximizer', name: 'Mastering suite',
    note: 'compressor, imager, maximizer, soft clip — live, and patchable',
    make: __W.Maximizer },
];

const TRAY_KEY = 'music-studio.meters';

function readArrangement() {
  const saved = __W.readStore(TRAY_KEY, null);
  const known = new Set(METERS.map((m) => m.id));

  let order = [];
  if (saved && Array.isArray(saved.order)) {
    order = saved.order.filter((id) => known.has(id));
  }
  // Anything new since the arrangement was saved goes on the end, so adding a
  // meter to this file never hides it from someone with an old localStorage.
  for (const m of METERS) if (!order.includes(m.id)) order.push(m.id);

  const hidden = new Set();
  if (saved && Array.isArray(saved.hidden)) {
    for (const id of saved.hidden) if (known.has(id)) hidden.add(id);
  }
  return { order, hidden };
}

function writeArrangement(order, hidden) {
  __W.writeStore(TRAY_KEY, { order, hidden: [...hidden] });
}

/* ==========================================================================
   6. Mount and the public interface
   ========================================================================== */

const state = {
  container: null,
  instances: new Map(),     // id -> { section, body, api }
  order: [],
  hidden: new Set(),
  trayBtn: null,
  trayPanel: null,
  mounted: false,
};

/** Build one `.unit` section matching the page's existing card markup, so
    studio.js's collapse wiring picks it up exactly as it does its own. */
function buildSection(meter) {
  const section = __W.elem('section', 'unit unit--striped');
  section.setAttribute('aria-label', meter.name);
  section.dataset.meter = meter.id;
  /* studio.js keys each card's saved collapsed state on data-card-id, falling
     back to the visible <h2>. Two cards on this page are titled "Spectrum" —
     the built-in colour map and this meter — so without an explicit id the two
     would share a key and folding one would fold the other. */
  section.dataset.cardId = meter.id;

  const title = __W.elem('div', 'unit-title');
  const h2 = __W.elem('h2', null, meter.name);
  const note = __W.elem('span', 'unit-note', meter.note);
  title.appendChild(h2);
  title.appendChild(note);
  section.appendChild(title);

  const body = __W.elem('div', 'meter-body');
  section.appendChild(body);
  return { section, body };
}

/** Put the sections into the container in the arranged order, hiding the
    ones that are switched off. Called on mount and after every tray edit. */
function applyArrangement() {
  if (!state.container) return;
  for (const id of state.order) {
    const inst = state.instances.get(id);
    if (!inst) continue;
    inst.section.hidden = state.hidden.has(id);
    // appendChild on an element already in the parent moves it, which is
    // exactly the reorder we want and keeps every canvas and listener alive.
    state.container.appendChild(inst.section);
  }
}

/* --- the tray panel ------------------------------------------------------ */

function buildTray() {
  const btn = __W.elem('button', 'btn tray-btn', 'Meters');
  btn.type = 'button';
  btn.setAttribute('aria-haspopup', 'true');
  btn.setAttribute('aria-expanded', 'false');
  btn.title = 'Choose which meters are on the bench, and their order';

  const panel = __W.elem('div', 'tray-panel');
  panel.hidden = true;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Meter tray');

  const head = __W.elem('div', 'tray-head');
  head.appendChild(__W.elem('span', 'tray-title', 'Meters'));
  head.appendChild(__W.elem('span', 'tray-hint', 'drag to reorder'));
  panel.appendChild(head);

  const list = __W.elem('div', 'tray-list');
  panel.appendChild(list);

  const foot = __W.elem('div', 'tray-foot');
  const restore = __W.elem('button', 'tray-reset', 'Restore defaults');
  restore.type = 'button';
  restore.addEventListener('click', () => {
    state.order = METERS.map((m) => m.id);
    state.hidden = new Set();
    writeArrangement(state.order, state.hidden);
    applyArrangement();
    paintTray(list);
  });
  foot.appendChild(restore);
  panel.appendChild(foot);

  const wrap = __W.elem('div', 'tray');
  wrap.appendChild(btn);
  wrap.appendChild(panel);

  const open = (yes) => {
    panel.hidden = !yes;
    btn.setAttribute('aria-expanded', String(yes));
    if (yes) paintTray(list);
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    open(panel.hidden);
  });
  panel.addEventListener('click', (e) => e.stopPropagation());
  document.addEventListener('click', () => { if (!panel.hidden) open(false); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !panel.hidden) { open(false); btn.focus(); }
  });

  state.trayBtn = btn;
  state.trayPanel = panel;
  wireTrayDrag(list);
  paintTray(list);
  return wrap;
}

function paintTray(list) {
  list.textContent = '';
  for (const id of state.order) {
    const meter = METERS.find((m) => m.id === id);
    if (!meter) continue;

    const row = __W.elem('div', 'tray-row');
    row.dataset.id = id;

    const grip = __W.elem('span', 'tray-grip');
    grip.setAttribute('aria-hidden', 'true');
    row.appendChild(grip);

    const label = __W.elem('label', 'tray-label');
    const box = __W.elem('input');
    box.type = 'checkbox';
    box.checked = !state.hidden.has(id);
    box.addEventListener('change', () => {
      if (box.checked) state.hidden.delete(id); else state.hidden.add(id);
      writeArrangement(state.order, state.hidden);
      applyArrangement();
    });
    label.appendChild(box);
    const text = __W.elem('span', 'tray-text');
    text.appendChild(__W.elem('b', null, meter.name));
    text.appendChild(__W.elem('i', null, meter.note));
    label.appendChild(text);
    row.appendChild(label);

    /* Keyboard reordering, because a drag is not reachable from a keyboard
       and the order is the whole point of the panel. */
    const up = __W.elem('button', 'tray-move', '▲');
    up.type = 'button';
    up.title = 'Move up';
    up.setAttribute('aria-label', 'Move ' + meter.name + ' up');
    up.addEventListener('click', () => moveBy(id, -1, list));
    const down = __W.elem('button', 'tray-move', '▼');
    down.type = 'button';
    down.title = 'Move down';
    down.setAttribute('aria-label', 'Move ' + meter.name + ' down');
    down.addEventListener('click', () => moveBy(id, 1, list));
    const moves = __W.elem('span', 'tray-moves');
    moves.appendChild(up);
    moves.appendChild(down);
    row.appendChild(moves);

    list.appendChild(row);
  }
}

function moveBy(id, delta, list) {
  const i = state.order.indexOf(id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= state.order.length) return;
  state.order.splice(j, 0, state.order.splice(i, 1)[0]);
  writeArrangement(state.order, state.hidden);
  applyArrangement();
  paintTray(list);
}

/** Pointer-driven reorder. The dragged row is lifted out of the flow with a
    transform and the others shift under it; on release the order is read
    back from the DOM, which is the only place it was ever really edited. */
function wireTrayDrag(list) {
  let drag = null;

  list.addEventListener('pointerdown', (e) => {
    // Only the grip starts a drag: pressing anywhere on the row would make
    // the checkbox impossible to tick without nudging the order.
    const grip = e.target.closest('.tray-grip');
    if (!grip || e.button !== 0) return;
    const row = grip.closest('.tray-row');
    if (!row) return;

    const rows = [...list.querySelectorAll('.tray-row')];
    drag = {
      row,
      id: row.dataset.id,
      startY: e.clientY,
      height: row.getBoundingClientRect().height,
      rows,
      pointerId: e.pointerId,
    };
    row.classList.add('is-dragging');
    list.classList.add('is-reordering');
    list.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  list.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const dy = e.clientY - drag.startY;
    drag.row.style.transform = `translateY(${dy}px)`;

    /* Place the row where the pointer actually is, rather than swapping it
       one neighbour at a time: a step-wise swap has to reset the gesture's
       origin on every exchange, and the travel spent between two resets is
       lost — which stranded a row one short of the end of a fast drag.
       The insertion point is the first sibling whose middle the dragged
       row's own middle has risen above. */
    const mid = drag.row.getBoundingClientRect().top + drag.height / 2;
    const siblings = [...list.querySelectorAll('.tray-row:not(.is-dragging)')];
    let before = null;
    for (const s of siblings) {
      const r = s.getBoundingClientRect();
      if (mid < r.top + r.height / 2) { before = s; break; }
    }
    // Only touch the DOM when the row would actually move; reinserting it in
    // the place it already occupies restarts CSS transitions every frame.
    if (before !== drag.row.nextElementSibling) {
      list.insertBefore(drag.row, before);
      /* The row has just jumped to a new slot, so the transform that was
         holding it under the pointer now measures from somewhere else.
         Re-derive the offset from where the row landed instead of zeroing
         it, which is what keeps it under the finger across the swap. */
      drag.row.style.transform = '';
      const landed = drag.row.getBoundingClientRect();
      drag.startY = e.clientY - (mid - drag.height / 2 - landed.top);
      drag.row.style.transform = `translateY(${e.clientY - drag.startY}px)`;
    }
  });

  const finish = (e) => {
    if (!drag) return;
    drag.row.style.transform = '';
    drag.row.classList.remove('is-dragging');
    list.classList.remove('is-reordering');
    try { list.releasePointerCapture(drag.pointerId); } catch { /* gone */ }
    drag = null;

    state.order = [...list.querySelectorAll('.tray-row')].map((r) => r.dataset.id);
    writeArrangement(state.order, state.hidden);
    applyArrangement();
  };

  list.addEventListener('pointerup', finish);
  list.addEventListener('pointercancel', finish);
}

/** Put the tray button somewhere sensible: beside the page's own masthead
    controls if there are any, otherwise as a bar above the instruments. */
function placeTray(container) {
  const tray = buildTray();
  const mastheadControls = document.querySelector('.masthead-controls');
  if (mastheadControls) {
    mastheadControls.appendChild(tray);
    return;
  }
  const bar = __W.elem('div', 'tray-bar');
  bar.appendChild(tray);
  container.parentElement
    ? container.parentElement.insertBefore(bar, container)
    : container.appendChild(bar);
}

/* --- the public interface ------------------------------------------------ */

function mount(container) {
  const host = container ||
    document.querySelector('.instruments') ||
    document.body;
  if (state.mounted) return host;

  state.container = host;
  const arranged = readArrangement();
  state.order = arranged.order;
  state.hidden = arranged.hidden;

  for (const meter of METERS) {
    const { section, body } = buildSection(meter);
    host.appendChild(section);
    let api;
    try {
      api = meter.make(body);
    } catch (err) {
      // One broken meter must not take the bench down with it.
      console.error('meter failed to build: ' + meter.id, err);
      body.appendChild(__W.elem('p', 'meter-error',
        'This meter could not be built. The rest of the bench is unaffected.'));
      api = { render() {}, reset() {} };
    }
    state.instances.set(meter.id, { section, body, api });
  }

  applyArrangement();
  placeTray(host);
  state.mounted = true;
  return host;
}

/** Drive every visible meter. Called once per animation frame by the host,
    so a throw here would stop the page's whole render loop: each meter is
    isolated, and a meter that fails is reported once and then left alone. */
const failed = new Set();

function render(s) {
  const st = s || {};
  for (const [id, inst] of state.instances) {
    if (state.hidden.has(id) || inst.section.hidden) continue;
    if (inst.section.classList.contains('is-collapsed')) continue;
    if (failed.has(id)) continue;
    try {
      inst.api.render(st);
    } catch (err) {
      failed.add(id);
      console.error('meter render failed: ' + id, err);
    }
  }
}

/* Meters that show the FILE, as opposed to a setting the user chose.
 *
 * Loading a new track must clear the previous track's picture — a stale
 * spectrogram is worse than an empty one. But it must NOT throw away the
 * equaliser: the bands are the user's own work, they are what the audio engine
 * is currently running, and a tone dialled in for a mix is exactly the thing
 * you want to carry to the next take. Resetting it on every file change also
 * defeated the EQ's own persistence, so a dialled-in curve did not survive a
 * reload either. */
const FILE_VIEW_METERS = new Set([
  'loudness-time', 'goniometer', 'spectrum', 'dynamics',
]);

function reset(opts) {
  const keepSettings = !!(opts && opts.fileChangeOnly);
  failed.clear();
  for (const [id, inst] of state.instances) {
    if (keepSettings && !FILE_VIEW_METERS.has(id)) continue;
    try { inst.api.reset(); }
    catch (err) { console.error('meter reset failed: ' + id, err); }
  }
}

function tray() {
  return {
    button: state.trayBtn,
    panel: state.trayPanel,
    order: () => [...state.order],
    hidden: () => [...state.hidden],
    show(id) {
      if (!state.hidden.has(id)) return;
      state.hidden.delete(id);
      writeArrangement(state.order, state.hidden);
      applyArrangement();
    },
    hide(id) {
      if (state.hidden.has(id)) return;
      state.hidden.add(id);
      writeArrangement(state.order, state.hidden);
      applyArrangement();
    },
  };
}

window.StudioMeters = { mount, render, reset, tray, meters: METERS };

/* ==========================================================================
   7. Self-drive: building the state from what the page already publishes

   The host page mounts nothing and calls nothing: studio.js has no reference
   to window.StudioMeters at all, so a bench driven only by the host would sit
   at its idle faces for ever. The meters therefore assemble their own state
   once per frame out of the two globals studio.js does publish — the raw
   analysis on window.StudioAnalysis and the transport on window.engine.

   This is a fallback, not a takeover. The moment anything calls
   window.StudioMeters.render() the self-drive loop stands down permanently,
   so wiring studio.js later needs no change here.

   Everything below treats both globals as absent until proven otherwise: the
   page opens from file:// with no analysis and no audio, and that is a normal
   state rather than an error.
   ========================================================================== */

/* --- the analysis --------------------------------------------------------
   meters.js reads the raw `audio-analysis/v1` shape (loudness.short_term,
   envelopes.channels[], spectrogram.db/shape/layout, spectrum.db). That is
   exactly what studio.js publishes on window.StudioAnalysis — its own
   normaliseAnalysis() output is a flattened, differently-named object kept
   private to that file, so reading the raw global is both correct and the
   only thing that works. */
function currentAnalysis() {
  try {
    const a = window.StudioAnalysis;
    if (a && typeof a === 'object') return a;
    const pre = window.PRELOADED_ANALYSIS;
    if (pre && typeof pre === 'object') return pre;
  } catch (_) { /* a global that throws on read is still just "absent" */ }
  return null;
}

/** Identity of an analysis, for spotting a *different* file rather than a
    different object. applyAnalysis() can republish an equal analysis, and
    re-running the static views every time that happened would throw away the
    signature caches the spectrogram and the goniometer rely on. */
function analysisSig(a) {
  if (!a) return '';
  const m = a.metadata || {};
  const st = a.loudness && a.loudness.short_term;
  return [
    m.filename || '', m.duration || '', m.sample_rate || '', m.channels || '',
    (st && Array.isArray(st.lufs)) ? st.lufs.length : 0,
  ].join('|');
}

/* --- the live stereo tap -------------------------------------------------
   The goniometer needs time-domain L and R. The engine's ScriptProcessor
   reduces each block to scalars (rms, peak, true peak, correlation) and keeps
   no samples, and its single AnalyserNode sees the signal already downmixed,
   so neither can supply a Lissajous figure.

   Rather than ask studio.js to retain a block — that file is owned elsewhere —
   the tap is built here: a ChannelSplitter off the engine's own EQ output
   feeding one AnalyserNode per channel. It is a pure read of a node that
   already exists, adds nothing to the audible path, and is rebuilt whenever
   the engine replaces its graph (every play(), and every EQ rebuild). */
const tap = {
  ctx: null,
  from: null,          // the node we are tapped off, to notice a rebuild
  up: null,            // mono -> stereo upmix, ahead of the split
  splitter: null,
  anL: null,
  anR: null,
  bufL: null,
  bufR: null,
};

function teardownTap() {
  for (const n of [tap.up, tap.splitter, tap.anL, tap.anR]) {
    if (n) { try { n.disconnect(); } catch (_) { /* never connected */ } }
  }
  tap.up = tap.splitter = tap.anL = tap.anR = null;
  tap.from = null;
}

/** Make sure the stereo tap hangs off the engine's current output node.
    Returns true when a usable tap is in place. */
function ensureTap(engine) {
  if (!engine || !engine.ctx) { if (tap.from) teardownTap(); return false; }

  /* eqOutput is the last node before the destination and carries the same
     signal the meters and the speakers get. It is replaced on every play()
     and on every EQ rebuild, which is what `from` watches for. */
  const src = engine.eqOutput || engine.analyser || null;
  if (!src) { if (tap.from) teardownTap(); return false; }
  if (tap.from === src && tap.anL && tap.anR) return true;

  teardownTap();
  const ctx = engine.ctx;
  try {
    const anL = ctx.createAnalyser();
    const anR = ctx.createAnalyser();
    for (const an of [anL, anR]) {
      an.fftSize = 2048;
      an.smoothingTimeConstant = 0;   // a scope wants the block, not an average
    }

    /* A splitter fed a mono source puts that one channel on output 0 and
       silence on output 1, so a mono file would plot a flat line rather than
       the 45° mono trace it should.

       The upmix therefore happens *before* the split, in a plain gain node
       asked for two channels with the "speakers" interpretation, which
       duplicates a mono input into both. It cannot be asked of the splitter
       itself: ChannelSplitterNode pins channelInterpretation to 'discrete'
       and throws InvalidStateError on any attempt to change it — which it
       did, silently costing the goniometer its live trace until the node
       order was turned around. */
    const up = ctx.createGain();
    up.channelCount = 2;
    up.channelCountMode = 'explicit';
    up.channelInterpretation = 'speakers';

    const splitter = ctx.createChannelSplitter(2);

    src.connect(up);
    up.connect(splitter);
    splitter.connect(anL, 0);
    splitter.connect(anR, 1);

    tap.ctx = ctx;
    tap.from = src;
    tap.up = up;
    tap.splitter = splitter;
    tap.anL = anL;
    tap.anR = anR;
    tap.bufL = new Float32Array(anL.fftSize);
    tap.bufR = new Float32Array(anR.fftSize);
    return true;
  } catch (err) {
    /* A browser that refuses the extra nodes still gets every other meter —
       but say so, rather than leaving the goniometer on its idle face with
       no clue why. */
    console.warn('goniometer stereo tap unavailable', err);
    teardownTap();
    return false;
  }
}

/* --- the live block ------------------------------------------------------ */

/** Read the engine's per-block measurements and the analyser data into the
    `live` object the meters expect. Every field is optional: a meter that
    cannot find one draws its idle face rather than throwing. */
let specBytes = null;

function liveFrom(engine) {
  const live = {};
  if (!engine) return live;

  /* Peak and RMS. engine.meters.{L,R} are already in dBFS — the same units
     the panels label — and hold -Infinity before the first block. */
  const mL = engine.meters && engine.meters.L;
  const mR = engine.meters && engine.meters.R;
  if (mL) { live.peakL = mL.peak; live.rmsL = mL.rms; live.tpL = mL.tp; }
  if (mR) { live.peakR = mR.peak; live.rmsR = mR.rms; live.tpR = mR.tp; }
  if (typeof engine.correlation === 'number') live.correlation = engine.correlation;

  const an = engine.analyser;
  if (an) {
    /* The spectrum panel accepts the analyser's own byte data (0..255 over
       minDecibels..maxDecibels) and normalises it itself. One array is reused
       across frames; allocating 1024 floats 60 times a second is the kind of
       garbage a scope does not need to make. */
    try {
      const n = an.frequencyBinCount;
      if (!specBytes || specBytes.length !== n) specBytes = new Uint8Array(n);
      an.getByteFrequencyData(specBytes);
      live.spectrum = specBytes;
    } catch (_) { /* analyser detached mid-frame */ }
  }

  if (ensureTap(engine)) {
    try {
      tap.anL.getFloatTimeDomainData(tap.bufL);
      tap.anR.getFloatTimeDomainData(tap.bufR);
      live.samplesL = tap.bufL;
      live.samplesR = tap.bufR;
    } catch (_) { /* same */ }
  }

  return live;
}

/* --- the timeline --------------------------------------------------------
   studio.js owns the Analysis panel and exposes renderTimeline(items) as a
   plain top-level function, which on a classic script is window.renderTimeline.
   Nothing in that file ever loads timeline.json, so the panel stays on its
   "No analysis yet" line even with a full analysis on the meters. Feeding it
   is all that happens here: the rendering, the seek links and the markup stay
   where they are.

   Three sources, cheapest first:
     1. a `timeline` array already on the analysis object;
     2. timeline.json beside the analysis, when the page was served by
        serve.py and knows the analysis path;
     3. the studio command, which returns the same findings inline.
   Only the first is available from file://, and that is fine: there is no
   server there to ask. */

function timelineItems(raw) {
  const arr = Array.isArray(raw) ? raw
    : (raw && Array.isArray(raw.timeline)) ? raw.timeline : null;
  if (!arr || !arr.length) return null;
  const out = [];
  for (const e of arr) {
    if (!e || typeof e !== 'object') continue;
    const t = __W.num(e.time_s);
    out.push({
      time_s: isFinite(t) ? t : (isFinite(__W.num(e.time)) ? __W.num(e.time) : 0),
      time: e.time,
      severity: e.severity || 'info',
      title: String(e.title || e.headline || '').trim() || 'finding',
      detail: e.detail || e.body || e.message || '',
      comment: e.comment,
    });
  }
  return out.length ? out : null;
}

function feedTimeline(items) {
  if (!items || !items.length) return false;
  const fn = window.renderTimeline;
  if (typeof fn !== 'function') return false;
  try { fn(items); return true; }
  catch (err) { console.error('renderTimeline failed', err); return false; }
}

/** Where the analysis.json lives on the server, if the page knows. */
function analysisPathHint() {
  try {
    const p = window.PRELOADED_PATH;
    if (typeof p === 'string' && p) return p;
  } catch (_) { /* absent */ }
  return null;
}

let timelineSig = '';

/** Is this serve.py, with the /api/run command channel? Asked once and
    remembered, so the answer costs one request per page rather than one per
    analysis. Anything other than a healthy answer counts as "no", which is
    the right reading for a plain static host and for file://. */
let runApiProbe = null;

function serverHasRunApi() {
  if (runApiProbe) return runApiProbe;
  if (location.protocol === 'file:') {
    runApiProbe = Promise.resolve(false);
    return runApiProbe;
  }
  runApiProbe = fetch('/api/health', { cache: 'no-store' })
    .then((r) => r.ok)
    .catch(() => false);
  return runApiProbe;
}

/** Try, once per analysis, to put dated findings on the Analysis panel. */
function refreshTimeline(a, sig) {
  if (!a || sig === timelineSig) return;
  timelineSig = sig;

  // 1. Already on the analysis.
  if (feedTimeline(timelineItems(a.timeline))) return;

  // 2 and 3 need a server. file:// has none, and fetch() there fails anyway.
  if (location.protocol === 'file:') return;

  const path = analysisPathHint();
  /* The folder the analysis lives in, which is also where analyze.py wrote
     timeline.json and where the audio itself sits. '' when the page was not
     told a path, which is the file:// and drag-a-file cases. */
  const dir = path ? String(path).replace(/[^/]*$/, '') : '';

  serverHasRunApi().then((hasRunApi) => {

  const viaJson = () => {
    /* timeline.json beside the analysis, for a plain static host that serves
       the track folder. serve.py deliberately does not: its static handler
       only serves the studio directory, so asking it would log a 404 in the
       console for a file that was never reachable by that route. Detecting
       that server by its /api/ endpoints is cheaper and quieter than probing
       and failing, so the ask only happens where it can succeed. */
    if (!dir || hasRunApi) return Promise.reject();
    return fetch(dir + 'timeline.json', { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : Promise.reject()));
  };

  const viaRun = () => {
    /* The studio command returns the same dated findings inline on stdout.
       It needs the *audio* path relative to the server root: metadata.filename
       is a bare name, so it is joined to the analysis's own folder. Without
       that join the command resolves against the root and reports no audio,
       which is exactly how the Analysis panel came to stay empty. */
    if (!hasRunApi) return Promise.reject();
    const a2 = currentAnalysis();
    const name = (a2 && a2.metadata && a2.metadata.filename) || null;
    if (!name) return Promise.reject();
    const rel = /[/]/.test(name) ? name : dir + name;
    return fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'studio', options: { '--in': rel } }),
    })
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((res) => {
        const line = String((res && res.stdout) || '').trim().split('\n').pop();
        const p = JSON.parse(line);
        if (!p || !p.ok) return Promise.reject();
        return p.timeline;
      });
  };

  viaJson()
    .then((data) => (feedTimeline(timelineItems(data)) ? null : Promise.reject()))
    .catch(() => viaRun().then((t) => {
      if (!feedTimeline(timelineItems(t))) return Promise.reject();
    }))
    .catch(() => { /* no server, no timeline: the meters are unaffected */ });

  });
}

/* --- the loop ------------------------------------------------------------ */

/** Assemble one frame's state from the live page. */
function composeState() {
  let engine = null;
  try { engine = window.engine || null; } catch (_) { /* absent */ }

  const a = currentAnalysis();
  const playing = !!(engine && engine.playing);

  /* The meters want the playhead as a 0..1 fraction of the track, and read
     anything outside that as "do not draw one". Duration comes from the
     decoded buffer when there is one and from the analysis otherwise, so the
     spectrogram cursor is right even before any audio is loaded. */
  let playhead = -1;
  if (engine && typeof engine.currentTime === 'function') {
    const t = __W.num(engine.currentTime());
    let dur = __W.num(typeof engine.duration === 'function' ? engine.duration() : NaN);
    if (!isFinite(dur) || dur <= 0) dur = __W.durationOf(a);
    if (isFinite(t) && isFinite(dur) && dur > 0) playhead = __W.clamp(t / dur, 0, 1);
  }

  return { analysis: a, live: liveFrom(engine), playhead, playing };
}

/* The host page may mount these itself, in which case it does so after its
   own boot and nothing here should race it. When it does not — the page as
   it stands today — mount once the document is ready and drive the meters
   from a frame loop built on the globals studio.js publishes. */
function autoMount() {
  if (state.mounted) return;
  const host = document.querySelector('.instruments');
  if (!host) return;
  mount(host);

  /* A self-drive loop only runs while nobody else is calling render(). The
     host setting window.StudioMeters.render aside and calling it from its
     own frame loop is the better arrangement; this is the fallback, and it
     stands down for good the first time the host drives a frame. */
  let hostDriven = false;
  const wrapped = window.StudioMeters.render;
  window.StudioMeters.render = function (s) {
    hostDriven = true;
    return wrapped(s);
  };

  let lastSig = null;

  const tick = () => {
    if (!hostDriven) {
      try {
        const s = composeState();

        /* A change of file re-runs the static views once. reset() clears the
           signature caches inside the spectrogram and the goniometer, which
           otherwise keep showing the previous track's picture. */
        const sig = analysisSig(s.analysis);
        if (sig !== lastSig) {
          lastSig = sig;
          if (sig) {
            /* Only the views of the file — the EQ is a setting, not a view. */
            reset({ fileChangeOnly: true });
            refreshTimeline(s.analysis, sig);
          }
        }

        render(s);
      } catch (err) {
        // One bad frame must not stop the loop; render() already isolates
        // each meter, so reaching here means composeState() itself failed.
        console.error('meters self-drive frame failed', err);
      }
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', autoMount);
} else {
  autoMount();
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { METERS, TRAY_KEY });

})(window.__studioWidgets || (window.__studioWidgets = {}));
