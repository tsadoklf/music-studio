/* ==========================================================================
   equalizer2.js — the second equaliser, rack-mounted
   --------------------------------------------------------------------------
   A five-band parametric EQ on a screwed rack faceplate, cascading AFTER the
   Equalizer panel the way two units bolted into the same rack cascade. It is a
   separate device and not a second view of the first one: its own bands, its
   own patch cable, its own bypass.

   Publishes window.StudioEq2 — the bands, in the shape studio.js's engine
   turns into live BiquadFilterNodes. It never reads or writes window.StudioEq,
   which belongs to equalizer.js: two panels writing one band list would fight,
   each overwriting the other's knob on the next publish.

   The response curve is computed from biquad.js's RBJ coefficients — the same
   maths BiquadFilterNode builds from — so the drawn curve and the audible
   filter agree by construction rather than by resemblance.

   Depends on: core.js, knob.js, biquad.js. Styles live in meters.css (the
   `.ru`, `.eqm` and `.eqcol` blocks); nothing is injected from here.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';

/* The shop's delivery rate. The curve is drawn at it, and the engine's own
   context runs at whatever the hardware gives — close enough that the two
   agree everywhere a person can hear, and fixed here so the drawn curve does
   not change shape when a different output device is plugged in. */
const EQ2_FS = 48000;

/* --- the five columns -----------------------------------------------------
   Read left to right as signal flow: cut what should not be there, then shape
   what is left. Every `type` is a valid BiquadFilterNode type string, because
   the engine hands what this panel publishes straight to `node.type` — a name
   invented here would throw there instead of failing visibly here.

   `fMin`/`fMax` are the range the column's face advertises, and the Freq knob
   is clamped to them: a knob that can be turned somewhere the label says it
   cannot go is a label that lies.

   The low cut starts OFF. Unlike the shaping bands, a high-pass at any
   frequency is doing something the moment it is in circuit — there is no
   neutral setting for it — so switching it in has to be a decision somebody
   made, not a default they inherited. */
const EQ2_COLS = [
  { id: 'locut', name: 'Lo cut', range: '20–300', glyph: 'locut',
    type: 'highpass', cls: 'eqcol--cut',
    fMin: 20, fMax: 300, f: 30,
    gain: false, g: 0,
    qMin: 0.4, qMax: 2.0, q: 0.7,
    enabled: false },
  { id: 'loshelf', name: 'Lo shelf', range: '30–400', glyph: 'loshelf',
    type: 'lowshelf', cls: '',
    fMin: 30, fMax: 400, f: 110,
    gain: true, g: 0,
    qMin: 0.2, qMax: 2.0, q: 0.7,
    enabled: true },
  { id: 'p1', name: 'Param 1', range: '39–20k', glyph: 'bell',
    type: 'peaking', cls: '',
    fMin: 39, fMax: 20000, f: 260,
    gain: true, g: 0,
    qMin: 0.2, qMax: 12, q: 1.0,
    enabled: true },
  { id: 'p2', name: 'Param 2', range: '39–20k', glyph: 'bell',
    type: 'peaking', cls: '',
    fMin: 39, fMax: 20000, f: 4500,
    gain: true, g: 0,
    qMin: 0.2, qMax: 12, q: 1.0,
    enabled: true },
  { id: 'hishelf', name: 'Hi shelf', range: '3k–12k', glyph: 'hishelf',
    type: 'highshelf', cls: '',
    fMin: 3000, fMax: 12000, f: 8000,
    gain: true, g: 0,
    qMin: 0.2, qMax: 2.0, q: 0.7,
    enabled: true },
];

const EQ2_GAIN = { min: -18, max: 18, def: 0 };

/** The defaults, minted fresh each time so a reset cannot hand back an object
    a previous session has already been turning knobs on. */
function defaultBands() {
  return EQ2_COLS.map((c) => ({
    id: c.id, type: c.type, f: c.f, g: c.g, q: c.q, enabled: c.enabled,
  }));
}

function colOf(id) { return EQ2_COLS.find((c) => c.id === id) || null; }

/** In circuit at all? A band switched out contributes nothing to the curve,
    the published list or the sound, whatever its numbers say — and it keeps
    those numbers, so throwing the switch back restores exactly what was there.

    Unlike equalizer.js this does NOT drop a gain band sitting at 0 dB. The
    engine's own `activeEqBands` does that (|gain| <= 0.01 is inert), and doing
    it twice would only mean the panel and the engine disagree about how many
    nodes exist — which is exactly what `updateEq2`'s length check is watching
    for. One filter, in one place. */
function eq2BandActive(b) {
  return !!(b && b.type && b.enabled !== false);
}

/* ==========================================================================
   Equalizer2 — the panel.
   ========================================================================= */

function Equalizer2(host) {
  const STORE = 'music-studio.eq2';

  /* --- state ------------------------------------------------------------ */

  let bands = defaultBands();
  let patched = false;        // engine.eq2Enabled — the cable, not the bypass
  let bypassed = false;       // in the path, doing nothing — for the A/B

  const knobs = new Map();    // band id -> { f, g, q }
  const lamps = new Map();    // band id -> button
  const cols = new Map();     // band id -> the .eqcol element
  const glyphs = [];          // [canvas, kind] — repainted on a device-ratio change

  function bandById(id) { return bands.find((b) => b.id === id) || null; }

  function engineOf() {
    try { return window.engine || (window.Studio && window.Studio.engine) || null; }
    catch { return null; }
  }

  /* --- the faceplate -----------------------------------------------------
     The tray already wraps every panel in a `section.unit.unit--striped`, so
     the rack unit is a child of the host rather than the host itself. */

  const ru = __W.elem('div', 'ru ru--eq ru--screwed');
  for (const cls of ['rail-groove rail-groove--l', 'rail-groove rail-groove--r',
                     'screw screw--tl', 'screw screw--tr',
                     'screw screw--bl', 'screw screw--br']) {
    ru.appendChild(__W.elem('span', cls));
  }

  /* The left ear: the unit's own power lamp and its engraved name, reading up
     the rack the way a name plate on a real one does. */
  const ear = __W.elem('div', 'ru-ear');
  const powerBtn = __W.elem('button', 'eq-band-power');
  powerBtn.type = 'button';
  powerBtn.appendChild(__W.elem('span', 'eq-band-lamp'));
  powerBtn.setAttribute('aria-pressed', 'false');
  powerBtn.setAttribute('aria-label', 'Equalizer 2 power');
  ear.appendChild(powerBtn);
  ear.appendChild(__W.elem('span', 'ru-name', 'Equalizer'));
  ru.appendChild(ear);

  const body = __W.elem('div', 'ru-body ru-body--eq');
  ru.appendChild(body);

  /* --- the head: title, note, and the switches -------------------------- */

  const eqm = __W.elem('div', 'eqm');
  const head = __W.elem('div', 'eqm-head');
  head.appendChild(__W.elem('span', 'eqm-title', 'Equalizer'));
  const note = __W.elem('span', 'unit-note', '5-band parametric');
  note.style.whiteSpace = 'nowrap';
  head.appendChild(note);

  const keys = __W.elem('div', 'seg-keys');

  /** The head's two keys. `On` is the whole unit; `Bypass` is the A/B. They
      are the same control drawn twice rather than a pair of radio buttons,
      because on the desk this imitates they are two separate switches and
      pressing one does not release the other. */
  function key(text, label) {
    const b = __W.elem('button', 'eq-band-power');
    b.type = 'button';
    b.appendChild(__W.elem('span', 'eq-band-lamp'));
    b.appendChild(__W.elem('span', 'eq-band-power-text', text));
    b.setAttribute('aria-pressed', 'false');
    b.setAttribute('aria-label', label);
    return b;
  }
  /* The patch cable, and it sits in this row with the other two keys.
     It began on a line of its own below the head, which cost the scope the
     height of a whole row and read as a separate idea from the switches it
     belongs beside. It is the same kind of switch — a key with a lamp — so it
     is drawn as one, and the row reads left to right in the order the
     questions are actually asked: is it patched, is it on, is it bypassed. */
  const patchBtn = key('Patch', 'Patch equalizer 2 into the signal path');
  patchBtn.classList.add('eqm-key-patch');
  patchBtn.title = 'In the path, after EQ 1. Out of the path it is not built at all.';
  const patchText = patchBtn.querySelector('.eq-band-power-text');

  const onKey = key('On', 'Equalizer 2 on');
  const bypassKey = key('Bypass', 'Bypass equalizer 2');
  bypassKey.title = 'Hear the signal with this EQ patched in but doing nothing';
  keys.appendChild(patchBtn);
  keys.appendChild(onKey);
  keys.appendChild(bypassKey);
  head.appendChild(keys);
  eqm.appendChild(head);

  /* --- the scope -------------------------------------------------------- */

  const curveCv = __W.elem('canvas');
  curveCv.setAttribute('role', 'img');
  curveCv.setAttribute('aria-label',
    'Combined filter response of the five bands of equalizer 2');
  const curveWrap = __W.elem('div', 'scope eq-curve eqm-scope eqm-scope--tall');
  curveWrap.appendChild(curveCv);
  eqm.appendChild(curveWrap);
  body.appendChild(eqm);

  const CH = 214;                     // the mockup's tall scope
  const PAD_B = 15, PAD_T = 6;

  /* The live spectrum behind the curve. See widgets/mountain.js. */
  const mountain = __W.Mountain({ fs: EQ2_FS, padTop: PAD_T, engine: engineOf });
  const DB = 18;                      // the gain range the plot spans, each way
  let geo = { w: 0, plotH: Math.max(1, CH - PAD_B - PAD_T) };
  const yOf = (db) =>
    PAD_T + (1 - (__W.clamp(db, -DB, DB) + DB) / (2 * DB)) * geo.plotH;

  /* --- the band columns ------------------------------------------------- */

  const eqcols = __W.elem('div', 'eqcols');
  body.appendChild(eqcols);

  /** The engraved filter-shape glyph, ported from the mockup. Drawn rather
      than set as a character because no font has a shelf in it, and an ASCII
      approximation of a bell is worse than nothing on a face this careful. */
  function drawGlyph(cv, kind) {
    const w = 22, h = 14;
    const ctx = __W.fitCanvas(cv, w, h);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = '#9a9c92';
    ctx.lineWidth = 1.5;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    if (kind === 'locut') { ctx.moveTo(2, 12); ctx.lineTo(8, 4); ctx.lineTo(20, 4); }
    else if (kind === 'loshelf') { ctx.moveTo(2, 4); ctx.lineTo(8, 4); ctx.lineTo(13, 9); ctx.lineTo(20, 9); }
    else if (kind === 'hishelf') { ctx.moveTo(2, 9); ctx.lineTo(9, 9); ctx.lineTo(14, 4); ctx.lineTo(20, 4); }
    else { ctx.moveTo(2, 10); ctx.quadraticCurveTo(8, 10, 11, 4); ctx.quadraticCurveTo(14, 10, 20, 10); }
    ctx.stroke();
  }

  for (const c of EQ2_COLS) {
    const col = __W.elem('div', 'eqcol eqcol--v eqcol--eq' + (c.cls ? ' ' + c.cls : ''));
    cols.set(c.id, col);

    const name = __W.elem('span', 'eqcol-name eqcol-name--down', c.name + ' ');
    name.appendChild(__W.elem('span', 'eqcol-name-num', c.range));
    col.appendChild(name);

    const vbody = __W.elem('div', 'eqcol-vbody');
    const vtop = __W.elem('div', 'eqcol-vtop');
    const lamp = __W.elem('button', 'eq-band-power');
    lamp.type = 'button';
    lamp.appendChild(__W.elem('span', 'eq-band-lamp'));
    lamp.setAttribute('aria-label', c.name + ' in circuit');
    lamp.addEventListener('click', () => {
      const b = bandById(c.id);
      if (!b) return;
      b.enabled = !b.enabled;
      syncBandUi(c.id);
      /* A band coming in or out changes the number of nodes, which is the
         shape `updateEq2` refuses to retune. onEdit() lets it say so and
         rebuilds; nothing here has to know which. */
      onEdit();
    });
    lamps.set(c.id, lamp);
    vtop.appendChild(lamp);
    vbody.appendChild(vtop);

    const krow = __W.elem('div', 'eqcol-knobs eqcol-knobs--floor');
    const set = {};

    /* Freq, on every column including the low cut. The mockup gives the cut
       no knobs at all, but a high-pass fixed at 30 Hz is a switch labelled
       "remove some lows" — the frequency is the only interesting thing about
       the filter, and the column has the room. */
    set.f = __W.Knob({
      label: 'Freq', min: c.fMin, max: c.fMax, value: c.f, def: c.f,
      curve: 'log', unit: 'Hz', digits: 0, size: 38,
      onChange: (v) => { const b = bandById(c.id); if (b) { b.f = v; onEdit(); } },
    });
    krow.appendChild(set.f.root);

    /* Gain only where the filter has one. A high-pass does not boost by
       anything, so a Gain knob on it would be a control with nothing behind
       it — and the engine would ignore whatever it was set to, which is the
       worst outcome: a knob that turns and does nothing. */
    if (c.gain) {
      set.g = __W.Knob({
        label: 'Gain', min: EQ2_GAIN.min, max: EQ2_GAIN.max,
        value: c.g, def: EQ2_GAIN.def,
        curve: 'lin', unit: 'dB', digits: 1, size: 38,
        onChange: (v) => { const b = bandById(c.id); if (b) { b.g = v; onEdit(); } },
      });
      krow.appendChild(set.g.root);
    }

    /* Q on every column, the low cut included: the steepness of a cut is the
       difference between tidying the bottom end and hollowing it out, and
       biquad.js has `highPassQCoeffs` precisely so a settable Q draws its own
       resonance rather than a fixed Butterworth's. */
    set.q = __W.Knob({
      label: 'Q', min: c.qMin, max: c.qMax, value: c.q, def: c.q,
      curve: 'log', unit: '', digits: 2, size: 38,
      onChange: (v) => { const b = bandById(c.id); if (b) { b.q = v; onEdit(); } },
    });
    krow.appendChild(set.q.root);

    knobs.set(c.id, set);
    vbody.appendChild(krow);

    const gl = __W.elem('canvas', 'eqcol-glyph');
    vbody.appendChild(gl);
    glyphs.push([gl, c.glyph]);

    col.appendChild(vbody);
    eqcols.appendChild(col);
  }

  host.appendChild(ru);

  /* --- the response curve ------------------------------------------------
     Computed per pixel column from the same RBJ coefficients the engine's
     BiquadFilterNodes are built from. A drawn approximation would be worse
     than no curve at all, because it would be believed. */

  function coeffsFor(b) {
    switch (b.type) {
      case 'peaking': return __W.peakingCoeffs(b.f, b.g, b.q, EQ2_FS);
      case 'lowshelf': return __W.lowShelfCoeffs(b.f, b.g, b.q, EQ2_FS);
      case 'highshelf': return __W.highShelfCoeffs(b.f, b.g, b.q, EQ2_FS);
      case 'highpass': return __W.highPassQCoeffs(b.f, EQ2_FS, b.q);
      case 'lowpass': return __W.lowPassCoeffs(b.f, EQ2_FS, b.q);
      case 'notch': return __W.notchCoeffs(b.f, EQ2_FS, b.q);
      default: return null;
    }
  }

  function activeBands() { return bands.filter(eq2BandActive); }

  /** Combined magnitude at one frequency, in dB: filters in series add in
      dB, which is why a cascade is drawn as a sum. */
  function responseAt(f) {
    let db = 0;
    for (const b of activeBands()) {
      const c = coeffsFor(b);
      if (c) db += __W.biquadDb(c, f, EQ2_FS);
    }
    return db;
  }

  /** Where a band's handle sits. A gain band rides the combined curve at its
      own frequency; the cut has no gain to ride, so its handle rides the
      curve too — which for a high-pass is the corner itself, the one place on
      the plot where the band is visibly doing something. */
  function handleXY(b, w) {
    return { x: __W.fToT(b.f) * w, y: yOf(responseAt(b.f)) };
  }

  const GRID_HZ = [50, 100, 500, 1000, 5000, 10000, 20000];

  function drawCurve() {
    const w = __W.boxWidth(curveCv, 0);
    if (!__W.hasArea(w, CH)) return;
    const ctx = __W.fitCanvas(curveCv, w, CH);
    geo = { w, plotH: Math.max(1, CH - PAD_B - PAD_T) };
    const plotH = geo.plotH;

    ctx.clearRect(0, 0, w, CH);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, w, CH);

    /* The live spectrum, behind everything. Drawn before the grid so the grid
       lines read through it and the curve lands on top: the mountain is the
       context, the curve is the control. Same module the first equaliser
       uses, so the two overlays agree rather than being two implementations
       of the same idea drifting apart. */
    mountain.draw(ctx, w, plotH);

    /* grid */
    ctx.font = `500 9px ${__W.MONO}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (const f of GRID_HZ) {
      const x = Math.round(__W.fToT(f) * w) + 0.5;
      ctx.fillStyle = 'rgba(78,80,73,0.32)';
      ctx.fillRect(x, PAD_T, 1, plotH);
      ctx.fillStyle = '#6e7067';
      ctx.fillText(__W.fmtHz(f), __W.clamp(x, 14, w - 14), CH - PAD_B + 3);
    }
    ctx.textBaseline = 'middle';
    for (const db of [-12, -6, 6, 12]) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.fillStyle = 'rgba(78,80,73,0.20)';
      ctx.fillRect(0, y, w, 1);
      ctx.fillStyle = '#5c5e56';
      ctx.textAlign = 'left';
      ctx.fillText(__W.sgn(db, 0) + ' dB', 4, y);
      ctx.textAlign = 'center';
    }

    /* the 0 dB line — the thing the curve is read against */
    const y0 = Math.round(yOf(0)) + 0.5;
    ctx.fillStyle = 'rgba(168,137,78,0.45)';
    ctx.fillRect(0, y0, w, 1);

    /* --- the curve, computed per pixel column -------------------------- */
    const pts = new Float64Array(w);
    for (let x = 0; x < w; x++) pts[x] = responseAt(__W.tToF(x / Math.max(1, w - 1)));

    ctx.beginPath();
    ctx.moveTo(0, yOf(pts[0]));
    for (let x = 1; x < w; x++) ctx.lineTo(x, yOf(pts[x]));
    ctx.lineTo(w - 1, y0);
    ctx.lineTo(0, y0);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,180,84,0.16)';
    ctx.fill();

    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const y = yOf(pts[x]);
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = bypassed || !patched ? '#7e8077' : '#ffcf8a';
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    /* The numbered handles, keyed to the columns below by position: band 1 is
       the leftmost column. A switched-out band has no handle, which is the
       same statement its dark lamp makes. */
    bands.forEach((b, i) => {
      if (!eq2BandActive(b)) return;
      const { x, y } = handleXY(b, w);
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.fillStyle = '#1c1e1a';
      ctx.fill();
      ctx.strokeStyle = '#ffb454';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#d8b877';
      ctx.font = `500 9px ${__W.MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(String(i + 1),
        __W.clamp(x, 12, w - 12), __W.clamp(y - 8, 10, CH - PAD_B - 2));
      ctx.textBaseline = 'middle';
    });

    /* How far the chain moves the level: the number worth knowing before a
       second EQ is stacked on a first one that has already boosted. */
    let peak = 0;
    for (let x = 0; x < w; x++) if (Math.abs(pts[x]) > Math.abs(peak)) peak = pts[x];
    ctx.fillStyle = Math.abs(peak) > 3 ? '#d9a441' : '#7e8077';
    ctx.font = `500 10px ${__W.MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('max ' + __W.sgn(peak, 1) + ' dB', w - 5, PAD_T + 2);

    /* Out of the path, the glass says so. Set against the bottom of the plot
       rather than the top: the top corner already carries the peak readout,
       and two pieces of text fighting over one corner is how a panel stops
       being readable at the exact moment it has something to say. */
    if (!patched) {
      ctx.fillStyle = 'rgba(126,128,119,0.92)';
      ctx.font = `400 11px ${__W.ENGRAVE}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.letterSpacing = '0.18em';
      ctx.fillText('NOT PATCHED', w / 2, PAD_T + plotH - 6);
      ctx.letterSpacing = '0em';
      ctx.textBaseline = 'middle';
    }
  }

  /* --- publishing to the audio engine -----------------------------------
     The panel is the authority on what this EQ is set to; the engine reads it
     from here and builds BiquadFilterNodes from the same numbers the curve is
     drawn from. Publishing on every change is what makes a turned knob
     audible, which is the whole point of a knob.

     The published shape is the engine's, not the panel's: `freq` and `gain`,
     not the panel's internal `f` and `g`. The conversion happens here, once,
     at the boundary — the same place equalizer.js does it. */
  function publish() {
    const list = activeBands().map((b) => ({
      id: b.id,
      type: b.type,
      freq: b.f,
      /* A band whose type has no gain publishes 0, which is the truth: a
         high-pass does not boost by anything. A filler value put here to
         satisfy one reader would be a false reading for every other one. */
      gain: hasGain(b) ? b.g : 0,
      q: b.q,
    }));

    /* window.StudioEq2, and never window.StudioEq — that one belongs to
       equalizer.js, and two panels writing one band list would fight. */
    window.StudioEq2 = window.StudioEq2 || {};
    window.StudioEq2.bands = list;

    try {
      const eng = engineOf();
      if (eng && typeof eng.updateEq2 === 'function') {
        /* false means the chain's SHAPE changed — a band came in or out, or
           a type moved — and there is nothing to retune. A rebuild restarts
           playback in place, so it is only worth doing while there is
           playback to restart. */
        if (!eng.updateEq2(list) && eng.playing && typeof eng.rebuildEq2 === 'function') {
          eng.rebuildEq2();
        }
      }
    } catch { /* no engine: the panel still works and still draws */ }
  }

  function hasGain(b) {
    const c = colOf(b.id);
    return c ? !!c.gain : (b.type === 'peaking' || b.type === 'lowshelf' || b.type === 'highshelf');
  }

  /** One edit, one cascade: publish so it is audible, redraw so it is visible,
      persist so it survives the reload. Every control calls this and nothing
      else, so no path can do two of the three. */
  function onEdit() {
    publish();
    drawCurve();
    persist();
  }

  /* --- the switches ------------------------------------------------------ */

  function syncBandUi(id) {
    const b = bandById(id);
    const lamp = lamps.get(id);
    const col = cols.get(id);
    if (!b || !lamp || !col) return;
    const on = b.enabled !== false;
    lamp.classList.toggle('is-on', on);
    lamp.setAttribute('aria-pressed', String(on));
    col.classList.toggle('is-off', !on);
  }

  function syncHeadUi() {
    /* `On` is the unit's own switch and is the patch state seen from the
       faceplate: an unpatched unit is an unlit one. */
    onKey.classList.toggle('is-on', patched);
    onKey.setAttribute('aria-pressed', String(patched));
    powerBtn.classList.toggle('is-on', patched);
    powerBtn.setAttribute('aria-pressed', String(patched));

    bypassKey.classList.toggle('is-on', bypassed);
    bypassKey.setAttribute('aria-pressed', String(bypassed));
    /* Bypass with nothing patched is a switch that cannot do anything — the
       worst kind on a panel meant to be trusted. */
    bypassKey.disabled = !patched;

    patchBtn.classList.toggle('is-on', patched);
    patchBtn.setAttribute('aria-pressed', String(patched));
    /* The key's own text stays "Patch": a switch in a row of switches is
       labelled by what it does, not by its current state, and the lamp beside
       it already carries the state. The whole sentence moved to the title,
       where it can be read without costing a line of the faceplate. */
    patchText.textContent = 'Patch';
    patchBtn.title = patched
      ? (bypassed
          ? 'In the signal path after EQ 1, but bypassed — the cable is in and '
            + 'the filters are muted. Click to unpatch.'
          : 'In the signal path, after EQ 1. Click to unpatch — the bands keep '
            + 'their settings and stop being heard.')
      : 'Out of the signal path: not built at all. Click to patch it in after EQ 1.';
    ru.classList.toggle('is-unpatched', !patched);
  }

  function setPatched(on) {
    patched = !!on;
    syncHeadUi();
    try {
      const eng = engineOf();
      if (eng) {
        /* Patching is a shape change by definition — the block is either in
           the graph or it is not — so there is nothing for updateEq2() to
           retune and the rebuild is unconditional. */
        eng.eq2Enabled = patched;
        if (eng.playing && typeof eng.rebuildEq2 === 'function') eng.rebuildEq2();
      }
    } catch { /* no engine: the switch still reads correctly */ }
  }

  patchBtn.addEventListener('click', () => {
    setPatched(!patched);
    drawCurve();
    persist();
  });

  onKey.addEventListener('click', () => {
    setPatched(!patched);
    drawCurve();
    persist();
  });

  powerBtn.addEventListener('click', () => {
    setPatched(!patched);
    drawCurve();
    persist();
  });

  bypassKey.addEventListener('click', () => {
    if (!patched) return;
    bypassed = !bypassed;
    syncHeadUi();
    try {
      const eng = engineOf();
      if (eng && typeof eng.setEq2Bypass === 'function') eng.setEq2Bypass(bypassed);
    } catch { /* no engine: the button still reads correctly */ }
    drawCurve();
    persist();
  });

  /* --- persistence ------------------------------------------------------ */

  function persist() {
    __W.writeStore(STORE, {
      version: 1,
      /* The cable is part of the arrangement. A reload that silently
         unpatched the unit would be a reload that changed the sound, and one
         that silently patched it in would be worse. */
      patched,
      bypassed,
      bands: bands.map((b) => ({
        id: b.id, type: b.type, f: b.f, g: b.g, q: b.q,
        enabled: b.enabled !== false,
      })),
    });
  }

  /** Clamp a band's numbers into the ranges its own column allows. Called
      after a restore and anywhere a band is written from outside the knobs,
      so a store hand-edited or written by an older version cannot put a knob
      past its own end stop. */
  function normalise(b) {
    const c = colOf(b.id);
    if (!c) return b;
    b.type = c.type;
    b.f = __W.clamp(isFinite(__W.num(b.f)) ? b.f : c.f, c.fMin, c.fMax);
    b.q = __W.clamp(isFinite(__W.num(b.q)) ? b.q : c.q, c.qMin, c.qMax);
    b.g = c.gain
      ? __W.clamp(isFinite(__W.num(b.g)) ? b.g : 0, EQ2_GAIN.min, EQ2_GAIN.max)
      : 0;
    b.enabled = b.enabled !== false;
    return b;
  }

  /** Push `bands` back onto the controls. The knobs are the display as well
      as the input, so anything that writes the band list from outside them
      has to come through here or the face stops describing the sound. */
  function syncControls() {
    for (const b of bands) {
      const set = knobs.get(b.id);
      if (set) {
        if (set.f) set.f.set(b.f);
        if (set.g) set.g.set(b.g);
        if (set.q) set.q.set(b.q);
      }
      syncBandUi(b.id);
    }
    syncHeadUi();
  }

  (function restore() {
    const s = __W.readStore(STORE, null);
    if (s && Array.isArray(s.bands)) {
      /* Merged by id onto the defaults rather than taken wholesale: the column
         list is the panel's, not the store's, so a band added or removed here
         in a later version does not have to be migrated in the store. */
      const byId = new Map();
      for (const b of s.bands) if (b && typeof b === 'object' && b.id) byId.set(b.id, b);
      bands = defaultBands().map((d) => {
        const v = byId.get(d.id);
        if (!v) return d;
        return normalise({
          id: d.id, type: d.type,
          f: __W.num(v.f), g: __W.num(v.g), q: __W.num(v.q),
          enabled: v.enabled !== false,
        });
      });
    }
    bypassed = !!(s && s.bypassed);
    /* setPatched rather than an assignment: restoring the cable has to reach
       the engine too, or the face and the graph disagree from the first
       frame. */
    setPatched(!!(s && s.patched));
    if (bypassed) {
      try {
        const eng = engineOf();
        if (eng && typeof eng.setEq2Bypass === 'function') eng.setEq2Bypass(true);
      } catch { /* no engine */ }
    }
    syncControls();
    /* Restoring is a publish too: the bands that came back from localStorage
       are what this EQ is set to, and an engine that had not been told would
       be playing the defaults. */
    publish();
    for (const [cv, kind] of glyphs) drawGlyph(cv, kind);
    drawCurve();
  })();

  return {
    /* Called once per frame by the tray's loop, with the same state every
       other meter gets. The curve has no animation of its own, but the canvas
       has to be repainted when the panel is resized or the device pixel ratio
       changes, and riding the frame that was already happening is cheaper
       than watching for either. */
    /* Called once per frame by the tray's loop. The mountain is refilled from
       the state the tray already assembled — the same analyser tap the first
       equaliser reads, so the page runs one FFT rather than two — and then the
       canvas is repainted with it behind the curve. */
    render(state) {
      const w = __W.boxWidth(curveCv, 0);
      if (w > 0) mountain.update(state, w);
      drawCurve();
    },
    reset() {
      bands = defaultBands();
      bypassed = false;
      setPatched(false);
      try {
        const eng = engineOf();
        if (eng && typeof eng.setEq2Bypass === 'function') eng.setEq2Bypass(false);
      } catch { /* no engine */ }
      syncControls();
      for (const [cv, kind] of glyphs) drawGlyph(cv, kind);
      onEdit();
    },
    /* The band list as the engine sees it, for a test that needs to check the
       published shape without reaching through a global. */
    publishedBands() {
      return (window.StudioEq2 && window.StudioEq2.bands) || [];
    },
  };
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { EQ2_COLS, EQ2_GAIN, EQ2_FS, eq2BandActive, Equalizer2 });

})(window.__studioWidgets || (window.__studioWidgets = {}));
