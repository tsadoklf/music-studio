/* ==========================================================================
   equalizer.js — the equaliser panel
   --------------------------------------------------------------------------
   Presets, a band bank of knobs and faders, a draggable response curve and the
   ffmpeg chain it corresponds to. The five built-in preset chains are copied
   from master.py's EQ_PRESETS and must stay byte-identical to them.

   Publishes window.StudioEq — the bands, in the shape the audio engine in
   studio.js turns into live BiquadFilterNodes. That global is intentional and
   is the only one besides window.StudioMeters.

   Depends on: core.js, knob.js, fader.js (Fader, roundRect), biquad.js.

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';
/* The chains are copied from master.py's EQ_PRESETS. `flat` is genuinely
   empty there — it means loudness and true peak only — so it is shown as
   such rather than invented. */
const EQ_PRESETS = [
  { id: 'flat', label: 'Flat', chain: '',
    why: 'No tone change. Loudness and true peak only — trust the mix.' },
  { id: 'warm', label: 'Warm',
    chain: "firequalizer=gain_entry='entry(0,1.5);entry(200,1.0);entry(800,0);" +
           "entry(4000,-0.6);entry(16000,-0.9)'",
    why: 'Gentle tilt toward the lows, pivoting near 800 Hz. For thin or ' +
         'brittle digital sources.',
    approx: true,
    /* The preset is a FIR curve, not a biquad chain, so the bands below are
       the nearest shelving equivalent — enough to show the tilt honestly
       and marked as an approximation in the readout. */
    bands: { low: { f: 200, g: 1.2, q: 0.7 }, p1: { f: 800, g: 0, q: 1 },
             p2: { f: 4000, g: -0.6, q: 1 }, p3: { f: 1000, g: 0, q: 1 },
             high: { f: 10000, g: -0.9, q: 0.7 } } },
  { id: 'air', label: 'Air',
    chain: 'treble=g=1.0:f=10000:width_type=q:w=0.7',
    why: '+1 dB shelf above 10 kHz. Only helps when real top end is present — ' +
         'it cannot restore what a codec removed.',
    bands: { high: { f: 10000, g: 1.0, q: 0.7 } } },
  { id: 'clean-lows', label: 'Clean lows',
    chain: 'highpass=f=28:poles=2',
    why: 'High-pass at 28 Hz. Removes rumble and DC that eat headroom without ' +
         'being audible.',
    highpass: 28 },
  { id: 'narrow-bass', label: 'Narrow bass',
    chain: 'stereotools=mlev=1:sbal=0,lowpass=f=120',
    why: 'Bass below 120 Hz to mono. For wide synth bass that wastes headroom ' +
         'and collapses badly on small speakers.',
    /* Two things at once, and the bank can only do one of them. The mono fold
       changes the image, not the magnitude response, so there is nothing to
       draw for it and nothing a biquad can do about it; the low-pass at 120 Hz
       is a real filter and is approximated exactly. The panel says so rather
       than letting the preview pass for the whole preset — and the CLI still
       gets the exact chain, by name. */
    noCurve: true, approx: true,
    approxBands: [{ id: 'lp', type: 'lowpass', f: 120, g: 0, q: Math.SQRT1_2 }] },
];

/* --- band types -----------------------------------------------------------
   Every type name here is a valid BiquadFilterNode type string, because the
   engine takes what this panel publishes and hands it straight to
   `node.type`. Anything invented here would throw there instead. Each type
   carries its own ranges, whether gain and Q mean anything for it, and the
   short tag the strip and the curve label it with. */

const EQ_TYPES = {
  peaking: {
    label: 'Peak', tag: 'peak', gain: true, q: true,
    f: { min: 20, max: 20000 }, q: { min: 0.2, max: 12, def: 1.0 } },
  lowshelf: {
    label: 'Low shelf', tag: 'shelf ↓', gain: true, q: true,
    f: { min: 20, max: 1000 }, q: { min: 0.2, max: 2, def: 0.7 } },
  highshelf: {
    label: 'High shelf', tag: 'shelf ↑', gain: true, q: true,
    f: { min: 1000, max: 20000 }, q: { min: 0.2, max: 2, def: 0.7 } },
  lowpass: {
    /* Down to 20 Hz rather than a comfortable 200: narrow-bass's low-pass
       sits at 120, and a range that cannot hold a preset the panel itself
       ships would silently move it. */
    label: 'Low pass', tag: 'lo-pass', gain: false, q: true,
    f: { min: 20, max: 20000 }, q: { min: 0.2, max: 8, def: 0.707 } },
  highpass: {
    label: 'High pass', tag: 'hi-pass', gain: false, q: true,
    f: { min: 20, max: 2000 }, q: { min: 0.2, max: 8, def: 0.707 } },
  notch: {
    label: 'Notch', tag: 'notch', gain: false, q: true,
    f: { min: 20, max: 20000 }, q: { min: 0.5, max: 24, def: 6 } },
};

const EQ_TYPE_ORDER = ['peaking', 'lowshelf', 'highshelf', 'lowpass', 'highpass', 'notch'];

const EQ_GAIN = { min: -18, max: 18, def: 0 };
const EQ_MAX_BANDS = 10;

/** The five the panel opens with — the bank as it stood before bands became
    dynamic, so an existing arrangement and every preset's band map still line
    up by id. */
/* Every band starts in circuit, including the ones sitting at neutral gain.
   A band at 0 dB already contributes nothing — `eqBandActive` drops it from
   the chain and the graph either way — so starting them switched out would
   buy no silence, and would mean a bank of dark lamps on a panel where
   nothing is wrong. On the desk this imitates, a strip is in the path unless
   somebody took it out; the lamp says "this band will be heard the moment you
   move it", which is true, and the switch is there for taking one out
   afterwards to hear what it was doing. */
const EQ_DEFAULT_BANDS = [
  { id: 'low', type: 'lowshelf', f: 110, g: 0, q: 0.7, enabled: true },
  { id: 'p1', type: 'peaking', f: 260, g: 0, q: 1.0, enabled: true },
  { id: 'p2', type: 'peaking', f: 1200, g: 0, q: 1.0, enabled: true },
  { id: 'p3', type: 'peaking', f: 4500, g: 0, q: 1.0, enabled: true },
  { id: 'high', type: 'highshelf', f: 8000, g: 0, q: 0.7, enabled: true },
];

const EQ_FS = 48000;         // the delivery rate; the curve is drawn at it

/* --- auto gain compensation ----------------------------------------------
   A boost in the monitor path is a boost with nothing after it. The engine's
   gain stage is fixed at 1.0 and there is no limiter between the filters and
   the destination, so a +12 dB shelf on a −1 dBFS master — where real masters
   sit — drives the browser's output past full scale and hard-clips it. The
   user then hears distortion caused by the monitor path and can easily blame
   the track, or worse, judge a tone decision through clipping.

   The fix is the one a console gives you: a trim before the filters, set to
   the inverse of whatever the filters add. The maximum boost is computed from
   the same RBJ coefficients the curve is drawn from and the filters are built
   from, so the number is exact rather than estimated — swept over a log-spaced
   grid across the audible band, since a resonance can sit anywhere.

   Only attenuation is ever applied. A cut-only EQ already has headroom to
   spare and lifting it back up would be a gain change nobody asked for, so
   the trim is clamped at 0 dB from above.

   MONITOR ONLY. This trim exists because the browser's output has no ceiling.
   It must never reach the emitted ffmpeg chain: master.py applies its own
   true-peak ceiling after the EQ, so a trim added there would attenuate a
   second time and deliver a quiet file. buildChain() knows nothing about it
   and must stay that way. */

/** The log-spaced sweep the maximum boost is measured on. 20 Hz to 20 kHz at
    a fixed resolution: fine enough that a Q of 12 — the narrowest the bank
    allows — cannot hide its peak between two probes, and cheap enough to run
    on every knob turn. At 480 points the spacing is about 1/144 octave, and a
    Q=12 peaking band is roughly 1/12 octave wide at its −3 dB points. */
const TRIM_SWEEP = (() => {
  const N = 480, lo = Math.log10(20), hi = Math.log10(20000);
  const out = new Float64Array(N);
  for (let i = 0; i < N; i++) out[i] = Math.pow(10, lo + (hi - lo) * i / (N - 1));
  return out;
})();

/** Coefficients for a band in the ENGINE's published shape ({type, freq, gain,
    q}), which is what the trim is computed from — the same numbers that reach
    BiquadFilterNode, so the trim and the filters cannot drift apart. */
function trimCoeffsFor(b) {
  const f = b.freq, g = b.gain || 0, q = b.q || 0.707;
  switch (b.type) {
    case 'peaking': return __W.peakingCoeffs(f, g, q, EQ_FS);
    case 'lowshelf': return __W.lowShelfCoeffs(f, g, q, EQ_FS);
    case 'highshelf': return __W.highShelfCoeffs(f, g, q, EQ_FS);
    case 'lowpass': return __W.lowPassCoeffs(f, EQ_FS, q);
    case 'highpass': return __W.highPassQCoeffs(f, EQ_FS, q);
    case 'notch': return __W.notchCoeffs(f, EQ_FS, q);
    default: return null;
  }
}

/**
 * The trim, in dB, that keeps a band list from pushing the monitor path above
 * where the bypassed signal sits. Negative or zero, never positive.
 *
 * @param {Array<{type:string,freq:number,gain:number,q:number}>} bands
 *        the published band list — the engine's shape, not the panel's.
 * @returns {number} dB to apply BEFORE the filter chain.
 */
function trimForBands(bands) {
  const list = (bands || []).filter((b) => b && b.type);
  if (!list.length) return 0;

  const coeffs = [];
  for (const b of list) {
    const c = trimCoeffsFor(b);
    if (c) coeffs.push(c);
  }
  if (!coeffs.length) return 0;

  let max = -Infinity;
  for (let i = 0; i < TRIM_SWEEP.length; i++) {
    const f = TRIM_SWEEP[i];
    let db = 0;
    for (let j = 0; j < coeffs.length; j++) db += __W.biquadDb(coeffs[j], f, EQ_FS);
    if (db > max) max = db;
  }
  if (!isFinite(max) || max <= 0) return 0;   // cut-only: nothing to compensate
  return -max;
}

/** A band is neutral when it changes nothing: no gain for the types that have
    gain, and for the pass and notch types simply being present is the change,
    so they are never neutral. Only bands that depart from neutral reach the
    chain and the audio graph.

    The engine applies its own version of this test (`activeEqBands` in
    studio.js, which treats |gain| <= 0.01 as inert and recognises the
    gain-less shapes by type). This one is the stricter of the two and runs
    first, so the set of bands in the ffmpeg chain and the set of nodes in the
    live graph cannot diverge: anything this rejects never reaches the engine,
    and anything it passes clears the engine's looser bar as well. Raising the
    engine's threshold above 0.05 would break that nesting. */
function eqBandActive(b) {
  const t = EQ_TYPES[b.type];
  if (!t) return false;
  /* Switched out of circuit by its own toggle. Checked before anything else:
     an off band contributes nothing to the chain, the published list or the
     curve, whatever its numbers say — and it keeps those numbers, so throwing
     the switch back restores exactly what was there. `enabled` is read as
     "not explicitly false" so a band from an older store, an older preset or
     a `studio-eq-restore` event that predates the toggle is on, which is what
     it was doing before the toggle existed. */
  if (b.enabled === false) return false;
  return t.gain ? Math.abs(b.g) >= 0.05 : true;
}

function EqualizerPanel(host) {
  const STORE = 'music-studio.eq';
  const USER_STORE = 'music-studio.eq-presets';

  /* --- state ---------------------------------------------------------- */

  /** The live band list. Order is display order and chain order; `id` is only
      ever used to key a strip to its band, never as an index. */
  let bands = EQ_DEFAULT_BANDS.map((b) => Object.assign({}, b));
  let preset = 'flat';
  let highpass = 0;           // Hz, from the clean-lows preset; 0 is off
  let expanded = false;
  let leftBehind = '';
  let userPresets = [];       // [{ id, name, bands:[...], highpass }]
  let seq = 0;                // for minting band ids that cannot collide

  /* Auto gain compensation. On by default: the monitor path has no limiter,
     so an uncompensated boost clips, and a panel whose default state distorts
     the thing you are judging is not a panel you can judge with. */
  let autoGain = true;
  let appliedTrim = 0;        // dB, ≤ 0, what is actually on the trim node
  let clipSeen = false;       // measured, never predicted
  let clipBase = 0;           // engine.overCount when the lamp was last cleared

  function newBandId() {
    let id;
    do { id = 'b' + (++seq); } while (bands.some((b) => b.id === id));
    return id;
  }

  /* --- markup ---------------------------------------------------------- */

  const presetRow = __W.elem('div', 'eq-presets');
  const presetBtns = new Map();      // id -> button, built-ins and saved alike

  const saveBtn = __W.elem('button', 'eq-preset eq-preset--save', '+ save');
  saveBtn.type = 'button';
  saveBtn.title = 'Name the current bands and keep them in this browser';

  const presetWhy = __W.elem('p', 'eq-why', '');
  const presetChain = __W.elem('pre', 'eq-preset-chain');
  presetChain.appendChild(__W.elem('code'));

  const curveCv = __W.elem('canvas');
  curveCv.setAttribute('role', 'img');
  curveCv.setAttribute('aria-label', 'Combined filter response of the current EQ');
  const curveWrap = __W.elem('div', 'scope eq-curve');
  curveWrap.appendChild(curveCv);
  /* The readout that follows the cursor while a handle is dragged. A DOM chip
     rather than canvas text: it must sit above the curve without being
     repainted at 60 Hz, and it reads to a screen reader. */
  const curveTip = __W.elem('div', 'eq-tip');
  curveTip.hidden = true;
  curveWrap.appendChild(curveTip);
  const curveHint = __W.elem('p', 'eq-hint',
    'Drag a handle to move the band — across for frequency, up and down for ' +
    'gain. Shift-drag or scroll over a handle sets Q. Double-click empty ' +
    'space to add a peak there; double-click a handle to zero it.');

  const bandsToggle = __W.elem('button', 'eq-toggle', 'Show band controls');

  /* Bypass. An EQ you cannot switch out is an EQ you cannot judge: the ear
     adapts within seconds, so the only honest test is an immediate A/B against
     the untouched signal. */
  const bypassBtn = __W.elem('button', 'eq-bypass', 'Bypass');
  bypassBtn.setAttribute('aria-pressed', 'false');
  bypassBtn.title = 'Hear the source without the EQ';
  bypassBtn.addEventListener('click', () => {
    const on = bypassBtn.getAttribute('aria-pressed') !== 'true';
    bypassBtn.setAttribute('aria-pressed', String(on));
    bypassBtn.classList.toggle('is-on', on);
    try {
      const eng = engineOf();
      if (eng && typeof eng.setEqBypass === 'function') eng.setEqBypass(on);
    } catch { /* no engine: the button still reads correctly */ }
  });
  bandsToggle.type = 'button';
  bandsToggle.setAttribute('aria-expanded', 'false');

  /* --- auto gain compensation ------------------------------------------
     The defeat switch, the trim readout, and the clip lamp that only means
     anything while compensation is defeated.

     Default ON, because the default has to be the one that does not lie: an
     EQ panel whose boosts clip the monitor is a panel that makes you judge
     tone through distortion. The switch exists for the times the raw filter
     output is deliberately what you want to hear — checking how much a boost
     really adds, or matching the level a downstream tool will see. */
  const compBtn = __W.elem('button', 'eq-comp');
  compBtn.type = 'button';
  compBtn.appendChild(__W.elem('span', 'eq-comp-lamp'));
  compBtn.appendChild(__W.elem('span', 'eq-comp-text', 'auto gain'));

  /* The applied trim, live. Shown beside the switch rather than on the curve:
     it is a property of the monitor path, not of the response being drawn. */
  const trimRead = __W.elem('span', 'eq-trim');

  /* The clip lamp. Lit only from measured output — engine.overCount, which the
     ScriptProcessor increments from real sample peaks — never from the
     predicted response, which would be a guess dressed up as a measurement. */
  const clipLamp = __W.elem('span', 'eq-clip', 'CLIP');
  clipLamp.hidden = true;
  clipLamp.title = 'The monitor path went over full scale with auto gain ' +
                   'defeated. Click to clear.';
  clipLamp.setAttribute('role', 'status');

  function syncCompUi() {
    compBtn.classList.toggle('is-on', autoGain);
    compBtn.setAttribute('aria-pressed', String(autoGain));
    compBtn.title = autoGain
      ? 'Auto gain is on: the EQ is trimmed so a boost cannot clip the ' +
        'monitor. Click to defeat it and hear the raw filter output.'
      : 'Auto gain is DEFEATED: a boost can clip the monitor path. Click to ' +
        'put the compensation back.';
    /* "−0.0 dB" is a reading that says something happened when nothing did.
       A cut-only EQ, or no EQ at all, gets no chip. */
    const t = appliedTrim;
    if (autoGain && t <= -0.05) {
      trimRead.textContent = 'auto-trim ' + __W.sgn(t, 1) + ' dB';
      trimRead.hidden = false;
      trimRead.classList.remove('is-idle');
    } else if (autoGain) {
      trimRead.textContent = 'auto-trim none';
      trimRead.hidden = false;
      trimRead.classList.add('is-idle');
    } else {
      trimRead.textContent = 'auto gain off';
      trimRead.hidden = false;
      trimRead.classList.add('is-idle');
    }
    /* A lit clip lamp under compensation would be stale: whatever caused it
       cannot happen again while the trim is in. */
    if (autoGain) clearClip();
  }

  compBtn.addEventListener('click', () => {
    autoGain = !autoGain;
    clearClip();
    syncCompUi();
    persist();
    applyTrim();
  });

  clipLamp.addEventListener('click', clearClip);

  const addBtn = __W.elem('button', 'eq-toggle eq-add', '+ band');
  addBtn.type = 'button';
  addBtn.title = 'Add a peaking band at 1 kHz';
  addBtn.addEventListener('click', () => {
    const b = addBand(1000);
    if (b) { rebuildBank(); onEdit(); }
  });

  const bank = __W.elem('div', 'eq-bank');
  bank.hidden = true;

  const out = __W.elem('div', 'eq-out');
  const outField = __W.elem('input', 'eq-chain');
  outField.type = 'text';
  outField.readOnly = true;
  outField.spellcheck = false;
  outField.setAttribute('aria-label', 'The ffmpeg filter chain these settings produce');
  const copyBtn = __W.elem('button', 'eq-copy', 'Copy');
  copyBtn.type = 'button';
  const resetBtn = __W.elem('button', 'eq-copy eq-copy--ghost', 'Reset bands');
  resetBtn.type = 'button';
  const outLabel = __W.elem('div', 'eq-out-label', 'music master --eq "…"');
  const outRow = __W.elem('div', 'eq-out-row');
  outRow.appendChild(outField);
  outRow.appendChild(copyBtn);
  outRow.appendChild(resetBtn);
  out.appendChild(outLabel);
  out.appendChild(outRow);

  host.appendChild(presetRow);
  host.appendChild(presetWhy);
  host.appendChild(presetChain);
  host.appendChild(curveWrap);
  host.appendChild(curveHint);
  /* The switches share a row. Appended straight to the panel they were each a
     block in a flex column, so all three stretched the full width of the card
     and read as banners rather than buttons. */
  const controlRow = __W.elem('div', 'eq-controls');
  controlRow.appendChild(bandsToggle);
  controlRow.appendChild(addBtn);
  controlRow.appendChild(bypassBtn);
  controlRow.appendChild(compBtn);
  controlRow.appendChild(trimRead);
  controlRow.appendChild(clipLamp);
  host.appendChild(controlRow);
  host.appendChild(bank);
  host.appendChild(out);

  /* --- the engine ------------------------------------------------------ */

  function engineOf() {
    try { return window.engine || (window.Studio && window.Studio.engine) || null; }
    catch { return null; }
  }

  /* --- the trim ---------------------------------------------------------
     Compute what the current bands add, and hand the engine the inverse. The
     engine owns the node; this owns the number, because the number comes from
     the same coefficients the curve is drawn from.

     The published list is what gets measured, not the panel's own `bands`:
     the published list is what the engine actually builds nodes from, so a
     band the panel is holding but not publishing — switched out, or sitting
     at neutral gain — cannot make the trim describe a chain that is not
     there. */
  function applyTrim() {
    const list = (window.StudioEq && window.StudioEq.bands) || [];
    const want = autoGain ? trimForBands(list) : 0;
    appliedTrim = want;
    try {
      const eng = engineOf();
      if (eng && typeof eng.setEqTrim === 'function') eng.setEqTrim(want);
    } catch { /* no engine: the readout is still correct */ }
    syncCompUi();
  }

  function clearClip() {
    clipSeen = false;
    clipLamp.hidden = true;
    clipLamp.classList.remove('is-lit');
    try {
      const eng = engineOf();
      clipBase = (eng && isFinite(__W.num(eng.overCount))) ? eng.overCount : 0;
    } catch { clipBase = 0; }
  }

  /** Has the monitor path actually gone over full scale since the lamp was
      last cleared? Read from engine.overCount, which the ScriptProcessorNode
      increments from measured per-block sample peaks on the post-EQ signal —
      an honest measurement of the audio, not an inference from the predicted
      response. Called once per frame from render().

      Only meaningful with compensation defeated: with the trim in, the whole
      point is that this cannot happen, and a lamp that could light anyway
      would be reporting on something else. */
  function pollClip() {
    if (autoGain) return;
    let n = NaN;
    try {
      const eng = engineOf();
      n = eng ? __W.num(eng.overCount) : NaN;
    } catch { return; }
    if (!isFinite(n)) return;
    if (n < clipBase) clipBase = n;          // meters were reset under us
    if (n > clipBase && !clipSeen) {
      clipSeen = true;
      clipLamp.hidden = false;
      clipLamp.classList.add('is-lit');
    }
  }

  /* --- the band bank ---------------------------------------------------
     Rebuilt from `bands` whenever the list changes shape. Turning a knob or
     moving a fader does not rebuild: the strip's controls are updated in
     place, so a drag is never interrupted by its own control being replaced.
  */

  const strips = new Map();     // band id -> { root, knobs, fader, tag, sel }

  function bandById(id) { return bands.find((b) => b.id === id) || null; }

  /** The name a band wears on its strip and on the curve. Derived rather than
      stored: a band that changes type must not keep a label that lies. */
  function bandName(b, i) {
    const t = EQ_TYPES[b.type];
    return (t ? t.label : 'Band') + ' ' + (i + 1);
  }
  function bandShort(b, i) {
    const t = EQ_TYPES[b.type];
    if (!t) return String(i + 1);
    return (b.type === 'peaking' ? 'P' : b.type === 'lowshelf' ? 'LS'
      : b.type === 'highshelf' ? 'HS' : b.type === 'lowpass' ? 'LP'
      : b.type === 'highpass' ? 'HP' : 'N') + (i + 1);
  }

  function fRange(b) { return EQ_TYPES[b.type] ? EQ_TYPES[b.type].f : { min: 20, max: 20000 }; }
  function qRange(b) { return EQ_TYPES[b.type] ? EQ_TYPES[b.type].q : { min: 0.2, max: 12, def: 1 }; }
  function hasGain(b) { return !!(EQ_TYPES[b.type] && EQ_TYPES[b.type].gain); }

  /** Clamp a band's numbers into the ranges its own type allows. Called after
      a type change, after a restore, and after anything that writes a band
      from outside the controls. */
  function normaliseBand(b) {
    if (!EQ_TYPES[b.type]) b.type = 'peaking';
    /* Anything but an explicit false is on. A band arriving from an older
       store, a preset saved before the toggle, or another file's event has no
       opinion about being switched out, and the answer that preserves what it
       used to do is "in circuit". */
    b.enabled = b.enabled !== false;
    const fr = fRange(b), qr = qRange(b);
    b.f = __W.clamp(isFinite(__W.num(b.f)) ? b.f : 1000, fr.min, fr.max);
    b.q = __W.clamp(isFinite(__W.num(b.q)) ? b.q : qr.def, qr.min, qr.max);
    b.g = hasGain(b)
      ? __W.clamp(isFinite(__W.num(b.g)) ? b.g : 0, EQ_GAIN.min, EQ_GAIN.max)
      : 0;
    return b;
  }

  function addBand(freq, type) {
    if (bands.length >= EQ_MAX_BANDS) return null;
    const t = type && EQ_TYPES[type] ? type : 'peaking';
    const b = normaliseBand({
      id: newBandId(), type: t,
      f: isFinite(__W.num(freq)) ? freq : 1000,
      g: 0, q: EQ_TYPES[t].q.def,
      /* A band somebody just asked for is a band they want in circuit. */
      enabled: true,
    });
    /* Kept in frequency order, which is the order a graphic EQ is read in and
       the order the chain then runs in. Nothing depends on it — biquads in
       series commute — but a bank whose faders jump around as bands are added
       is unreadable. */
    bands.push(b);
    bands.sort((x, y) => x.f - y.f);
    return b;
  }

  function removeBand(id) {
    const i = bands.findIndex((b) => b.id === id);
    if (i < 0 || bands.length <= 1) return false;
    bands.splice(i, 1);
    return true;
  }

  /** One band's strip: the head with its ON lamp, type selector and remove
      button, then the controls stacked down the strip the way a channel strip
      on a console is read — each control with its label and typed readout
      beside it rather than beneath it. */
  function buildStrip(b, i) {
    const strip = __W.elem('div', 'eq-band');
    strip.dataset.band = b.id;
    strip.classList.toggle('is-off', b.enabled === false);

    const head = __W.elem('div', 'eq-band-head');

    /* The ON lamp: the switch that puts this band in or out of circuit. A
       lit tungsten pip beside an engraved legend, because that is what the
       control is on the hardware this panel is pretending to be — the band
       is either in the signal path or it is not, and you can see which from
       across the room. It leads the head rather than trailing it: the first
       question about a strip is whether it is doing anything. */
    const power = __W.elem('button', 'eq-band-power');
    power.type = 'button';
    power.appendChild(__W.elem('span', 'eq-band-lamp'));
    power.appendChild(__W.elem('span', 'eq-band-power-text', 'On'));
    const syncPower = () => {
      const on = b.enabled !== false;
      power.classList.toggle('is-on', on);
      power.setAttribute('aria-pressed', String(on));
      power.title = on
        ? 'This band is in circuit — click to switch it out, keeping its settings'
        : 'This band is switched out — click to put it back, exactly as it was';
      power.setAttribute('aria-label',
        bandName(b, i) + (on ? ' is in circuit' : ' is switched out'));
      strip.classList.toggle('is-off', !on);
    };
    power.addEventListener('click', () => {
      b.enabled = b.enabled === false;
      syncPower();
      /* onEdit() is the whole cascade: chain, publish, curve, persist. The
         band's numbers are untouched, so switching back on restores it
         exactly — nothing here writes to f, g or q. */
      onEdit();
    });
    syncPower();
    head.appendChild(power);

    const nameEl = __W.elem('span', 'eq-band-name', bandName(b, i));
    head.appendChild(nameEl);

    const sel = __W.elem('select', 'eq-band-type');
    sel.setAttribute('aria-label', bandName(b, i) + ' type');
    for (const t of EQ_TYPE_ORDER) {
      const op = __W.elem('option', null, EQ_TYPES[t].label);
      op.value = t;
      sel.appendChild(op);
    }
    sel.value = b.type;
    sel.addEventListener('change', () => {
      b.type = EQ_TYPES[sel.value] ? sel.value : 'peaking';
      b.q = EQ_TYPES[b.type].q.def;
      normaliseBand(b);
      rebuildBank();
      onEdit();
    });
    head.appendChild(sel);

    const kill = __W.elem('button', 'eq-band-kill', '×');
    kill.type = 'button';
    kill.title = 'Remove this band';
    kill.setAttribute('aria-label', 'Remove ' + bandName(b, i));
    kill.disabled = bands.length <= 1;
    kill.addEventListener('click', () => {
      if (removeBand(b.id)) { rebuildBank(); onEdit(); }
    });
    head.appendChild(kill);
    strip.appendChild(head);

    const body = __W.elem('div', 'eq-band-body');

    /* The strip is three columns, the way a channel strip is: the gain fader
       running the full height on the left, the three knobs stacked in the
       middle, and each knob's engraved legend and typed readout on its right.
       The knob and fader factories build their own label and field as a
       column underneath the control; these lift those out into the value
       column instead. The nodes are moved, never rebuilt — the field keeps
       every listener the factory put on it, so typing (including the `3k`
       shorthand) works exactly as before. */

    /* --- the fader, its own column ------------------------------------ */
    const fader = hasGain(b)
      ? __W.Fader({
          label: 'Gain', unit: 'dB',
          min: EQ_GAIN.min, max: EQ_GAIN.max, def: 0, value: b.g,
          /* Tall enough to run beside the knob column, which is what makes
             it read as the strip's fader rather than one more control in a
             list. The column is two rows now that GAIN has gone, and the
             fader carries its own legend and field underneath, so the slot
             itself is shorter than the 146 px it needed against three rows —
             the strip loses a row's height rather than keeping it as padding.
             104 px still gives the cap a long, readable throw. */
          height: 104,
          width: 32,
          onChange: (v) => {
            b.g = v;
            const k = strips.get(b.id);
            if (k && k.gField && k.gField.syncFromBand) k.gField.syncFromBand();
            onEdit();
          },
        })
      : null;

    const faderCol = __W.elem('div', 'eq-band-fader');
    let gField = null;
    if (fader) {
      /* The fader's numeric field, and its engraved legend.
         With the GAIN knob gone the fader is the only gain control on the
         strip, so the number has to live here — and it has to be typed, not
         merely read: "−3.5" is a thing you set, and hunting for it with a cap
         is worse than saying it. The factory's chip is read-only, so it is
         replaced rather than removed, with an input carrying the same parsing
         the knob fields have (a trailing unit and a comma decimal both
         accepted) and the same Enter/Escape behaviour.

         fader.set() deliberately does not notify, so committing here calls
         onEdit() itself — one edit, one cascade, no double publish. */
      const read = fader.root.querySelector('.eq-fader-read');
      if (read) read.remove();

      const legend = __W.elem('div', 'eq-fader-name', 'Gain');
      gField = __W.elem('input', 'knob-field eq-fader-field');
      gField.type = 'text';
      gField.inputMode = 'decimal';
      gField.setAttribute('aria-label', bandName(b, i) + ' gain in dB');

      let editing = false;
      const syncField = () => {
        if (editing) return;
        gField.value = b.g.toFixed(1) + ' dB';
        gField.classList.toggle('is-zero', Math.abs(b.g) < 0.05);
      };
      gField.addEventListener('focus', () => {
        editing = true;
        gField.value = b.g.toFixed(1);
        gField.select();
      });
      const commit = () => {
        if (!editing) return;
        editing = false;
        const raw = gField.value.trim().replace(/,/g, '.').toLowerCase()
          .replace(/\s*db\s*$/, '');
        const v = parseFloat(raw);
        if (!isFinite(v)) { syncField(); return; }
        b.g = __W.clamp(v, EQ_GAIN.min, EQ_GAIN.max);
        if (fader) fader.set(b.g);
        syncField();
        onEdit();
      };
      gField.addEventListener('blur', commit);
      gField.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commit(); gField.blur(); }
        else if (e.key === 'Escape') { editing = false; syncField(); gField.blur(); }
        e.stopPropagation();      // the page's space-to-play must not fire here
      });
      syncField();

      fader.root.appendChild(legend);
      fader.root.appendChild(gField);
      faderCol.appendChild(fader.root);
      /* The fader's own moves have to reach the field too. */
      gField.syncFromBand = syncField;
    } else {
      /* A pass or notch band has no gain, so a fader would be a control that
         does nothing. The column keeps its width so every strip in the bank
         is the same shape, and says why it is empty. */
      const blank = __W.elem('div', 'eq-fader--none');
      blank.appendChild(__W.elem('div', 'eq-fader-none-note', 'no gain'));
      faderCol.appendChild(blank);
    }
    body.appendChild(faderCol);

    /* --- the three knobs, stacked, each with its value beside it -------- */
    const knobCol = __W.elem('div', 'eq-band-knobs');

    /** One knob row: the knob, then its legend and typed readout. */
    function knobRow(ctl, legend) {
      const row = __W.elem('div', 'eq-row');
      const face = __W.elem('div', 'eq-row-ctl');
      const side = __W.elem('div', 'eq-row-side');
      const lab = ctl.root.querySelector('.knob-label');
      const fld = ctl.root.querySelector('.knob-field');
      if (lab) lab.remove();
      side.appendChild(__W.elem('div', 'eq-row-name', legend));
      face.appendChild(ctl.root);
      if (fld) side.appendChild(fld);
      row.appendChild(face);
      row.appendChild(side);
      return row;
    }

    const fr = fRange(b), qr = qRange(b);

    const kf = __W.Knob({
      label: 'Freq', unit: 'Hz', curve: 'log', digits: 0, size: 38,
      min: fr.min, max: fr.max, def: b.f, value: b.f,
      onChange: (v) => { b.f = v; onEdit(); },
    });
    knobCol.appendChild(knobRow(kf, 'Freq'));

    /* There is no GAIN knob. The fader beside these knobs is the gain
       control, and it was the same value shown twice — two controls for one
       number, each pushing the other. Keeping the fader is the right half to
       keep: it is the taller, more precise control, it is what a channel
       strip's gain lives on, and the shape of the whole bank can be read off
       a row of fader caps in a way a row of knob pointers does not allow.
       Its own numeric field carries the typed readout that used to live on
       the knob, so nothing was lost but the duplicate. */

    const kq = __W.Knob({
      label: 'Q', digits: 2, size: 38,
      min: qr.min, max: qr.max, def: qr.def, value: b.q,
      onChange: (v) => { b.q = v; onEdit(); },
    });
    knobCol.appendChild(knobRow(kq, 'Q'));

    body.appendChild(knobCol);

    strip.appendChild(body);

    strips.set(b.id, {
      root: strip, knobs: { f: kf, q: kq }, fader, gField, sel, name: nameEl,
      power: syncPower,
    });
    return strip;
  }

  /** Throw the bank away and build it again. Called only when the list
      changes shape — a band added, removed, or retyped — never on a value
      change, which would kill a drag in progress. */
  function rebuildBank() {
    strips.clear();
    bank.textContent = '';
    bands.forEach((b, i) => bank.appendChild(buildStrip(b, i)));
    addBtn.disabled = bands.length >= EQ_MAX_BANDS;
    addBtn.title = bands.length >= EQ_MAX_BANDS
      ? `The bank holds ${EQ_MAX_BANDS} bands`
      : 'Add a peaking band at 1 kHz';
    if (expanded) repaintBank();
  }

  /** Push every band's numbers back into its controls, without rebuilding.
      This is what a curve drag, a preset, or a restore calls. */
  function syncControls() {
    for (const b of bands) {
      const s = strips.get(b.id);
      if (!s) continue;
      s.knobs.f.set(b.f);
      s.knobs.q.set(b.q);
      if (s.fader) s.fader.set(b.g);
      if (s.gField && s.gField.syncFromBand) s.gField.syncFromBand();
    }
  }

  function repaintBank() {
    for (const s of strips.values()) {
      for (const w of ['f', 'q']) if (s.knobs[w]) s.knobs[w].repaint();
      if (s.fader) s.fader.repaint();
    }
  }

  rebuildBank();

  bandsToggle.addEventListener('click', () => {
    expanded = !expanded;
    bank.hidden = !expanded;
    bandsToggle.textContent = expanded ? 'Hide band controls' : 'Show band controls';
    bandsToggle.setAttribute('aria-expanded', String(expanded));
    persist();
    // The controls were laid out in a hidden box, so their canvases measured
    // zero and drew nothing. Repaint now that they have a size.
    if (expanded) repaintBank();
  });

  /* Returning the bands to their defaults returns the panel to `flat`, the
     named preset those defaults are. Marking it 'custom' instead — which an
     earlier version did by routing through onEdit() — left the panel saying
     "hand-set bands" while every band sat at its default and the chain was
     empty, which is `--eq flat` by another name. */
  resetBtn.addEventListener('click', () => { applyPreset('flat'); });

  copyBtn.addEventListener('click', () => {
    const text = outField.value;
    const done = (ok) => {
      copyBtn.textContent = ok ? 'Copied' : 'Select it';
      setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done(true), () => fallback());
    } else fallback();

    function fallback() {
      // file:// without a clipboard permission still has the old path.
      try {
        outField.readOnly = false;
        outField.select();
        const ok = document.execCommand && document.execCommand('copy');
        outField.readOnly = true;
        done(!!ok);
      } catch { outField.readOnly = true; done(false); }
    }
  });

  /* --- presets ----------------------------------------------------------
     Two kinds sit in the same row. A built-in is one of master.py's names and
     emits master.py's own chain string verbatim; a saved preset is a band
     list this browser is keeping, and emits whatever chain those bands build.
  */

  function userById(id) { return userPresets.find((p) => p.id === id) || null; }

  function loadUserPresets() {
    const raw = __W.readStore(USER_STORE, null);
    const list = raw && Array.isArray(raw.presets) ? raw.presets : [];
    userPresets = [];
    for (const p of list) {
      if (!p || typeof p !== 'object') continue;
      const name = typeof p.name === 'string' ? p.name.trim() : '';
      const bl = Array.isArray(p.bands) ? p.bands : null;
      if (!name || !bl || !bl.length) continue;
      const cleaned = [];
      for (const b of bl.slice(0, EQ_MAX_BANDS)) {
        if (!b || typeof b !== 'object') continue;
        cleaned.push(normaliseBand({
          id: typeof b.id === 'string' ? b.id : 'b' + (cleaned.length + 1),
          type: typeof b.type === 'string' ? b.type : 'peaking',
          f: __W.num(b.f), g: __W.num(b.g), q: __W.num(b.q),
          /* A preset saved before the toggle existed carries no flag, and
             every band in it was in circuit. */
          enabled: b.enabled !== false,
        }));
      }
      if (!cleaned.length) continue;
      userPresets.push({
        id: typeof p.id === 'string' && p.id ? p.id : 'user-' + cleaned.length + '-' + name,
        name,
        bands: cleaned,
        highpass: isFinite(__W.num(p.highpass)) ? __W.num(p.highpass) : 0,
      });
    }
  }

  function saveUserPresets() {
    __W.writeStore(USER_STORE, { version: 1, presets: userPresets });
  }

  /** A stable, collision-free id for a saved preset. Built-in ids are taken,
      and so is anything already saved. */
  function mintUserId(name) {
    const base = 'user-' + (name.toLowerCase().replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'preset');
    let id = base, n = 1;
    const taken = (x) => EQ_PRESETS.some((p) => p.id === x) || userPresets.some((p) => p.id === x);
    while (taken(id)) id = base + '-' + (++n);
    return id;
  }

  function buildPresetRow() {
    presetRow.textContent = '';
    presetBtns.clear();

    for (const p of EQ_PRESETS) {
      const b = __W.elem('button', 'eq-preset', p.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.title = p.why + (p.approx ? ' — the live preview approximates this one.' : '');
      /* Toggle, not latch: clicking the preset that is already on returns to
         flat, so the same button both applies and removes. Without it the only
         way back was to hunt for the FLAT key. */
      b.addEventListener('click', () => applyPreset(preset === p.id ? 'flat' : p.id));
      presetRow.appendChild(b);
      presetBtns.set(p.id, b);
    }

    for (const p of userPresets) {
      const wrap = __W.elem('span', 'eq-preset-saved');
      const b = __W.elem('button', 'eq-preset eq-preset--user', p.name);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.title = `Saved here — ${p.bands.length} band${p.bands.length === 1 ? '' : 's'}`;
      /* Toggle, not latch: clicking the preset that is already on returns to
         flat, so the same button both applies and removes. Without it the only
         way back was to hunt for the FLAT key. */
      b.addEventListener('click', () => applyPreset(preset === p.id ? 'flat' : p.id));
      const del = __W.elem('button', 'eq-preset-del', '×');
      del.type = 'button';
      del.title = 'Delete the saved preset "' + p.name + '"';
      del.setAttribute('aria-label', 'Delete saved preset ' + p.name);
      del.addEventListener('click', (e) => {
        e.stopPropagation();
        userPresets = userPresets.filter((x) => x.id !== p.id);
        saveUserPresets();
        if (preset === p.id) preset = 'custom';
        buildPresetRow();
        syncPresetUi();
        syncOutput();
      });
      wrap.appendChild(b);
      wrap.appendChild(del);
      presetRow.appendChild(wrap);
      presetBtns.set(p.id, b);
    }

    presetRow.appendChild(saveBtn);
  }

  saveBtn.addEventListener('click', () => {
    let name = '';
    try { name = window.prompt('Name for this EQ setting', suggestName()); }
    catch { name = ''; }
    if (name == null) return;
    name = String(name).trim().slice(0, 40);
    if (!name) return;
    const existing = userPresets.find((p) => p.name.toLowerCase() === name.toLowerCase());
    const snap = {
      id: existing ? existing.id : mintUserId(name),
      name,
      /* Which bands were switched out is part of the setting, not an
         accident of the moment it was saved: recalling the preset must put
         the same bands in circuit and leave the same ones out. */
      bands: bands.map((b) => ({
        id: b.id, type: b.type, f: b.f, g: b.g, q: b.q,
        enabled: b.enabled !== false,
      })),
      highpass,
    };
    if (existing) userPresets = userPresets.map((p) => (p.id === existing.id ? snap : p));
    else userPresets.push(snap);
    saveUserPresets();
    preset = snap.id;
    buildPresetRow();
    syncPresetUi();
    syncOutput();
    persist();
  });

  function suggestName() {
    const lifted = bands.filter((b) => hasGain(b) && b.g > 0.05).length;
    const cut = bands.filter((b) => hasGain(b) && b.g < -0.05).length;
    if (lifted && !cut) return 'Lift';
    if (cut && !lifted) return 'Trim';
    return 'My EQ';
  }

  /** Apply a built-in or a saved preset. Both land in the same place: a band
      list, the controls rebuilt from it, and a publish so it is audible. */
  function applyPreset(id) {
    const u = userById(id);
    if (u) {
      preset = id;
      leftBehind = '';
      bands = u.bands.map((b) => normaliseBand(Object.assign({}, b)));
      highpass = u.highpass || 0;
      afterBandsReplaced();
      return;
    }

    const p = EQ_PRESETS.find((x) => x.id === id);
    if (!p) return;
    preset = id;
    leftBehind = '';        // a named preset leaves nothing behind

    /* A preset resets the bank, then writes its own equivalent in: leaving an
       old hand-made band standing under a named preset would make the curve
       and the chain disagree. The default five come back too, so `flat` is
       genuinely the panel's rest position however many bands were added. */
    bands = EQ_DEFAULT_BANDS.map((b) => Object.assign({}, b));
    highpass = p.highpass || 0;
    if (p.bands) {
      for (const [bid, v] of Object.entries(p.bands)) {
        const b = bands.find((x) => x.id === bid);
        if (!b) continue;
        b.f = v.f; b.g = v.g; b.q = v.q;
        normaliseBand(b);
      }
    }
    /* A preset the bank cannot express as gain on the default five carries its
       own bands instead — narrow-bass's low-pass, which is a whole band rather
       than a setting of one. They replace the default set so the preview is
       the filter and nothing else. */
    if (p.approxBands) {
      bands = p.approxBands.map((b) => normaliseBand(Object.assign({}, b)));
    }
    afterBandsReplaced();
  }

  function afterBandsReplaced() {
    rebuildBank();
    syncPresetUi();
    syncOutput();
    persist();
    publish();
  }

  /** A hand edit means the settings are no longer that named preset. */
  function onEdit() {
    const was = EQ_PRESETS.find((x) => x.id === preset);
    if (was) {
      leftBehind = was.noCurve
        ? `The ${was.label} preset's stereo fold is not part of this chain — ` +
          'the bank has no stereo tool. Run that preset by name if you need it.'
        : was.bands
          ? `Shown as the shelving equivalent of ${was.label}, not its original ` +
            'FIR curve.'
          : '';
    }
    preset = 'custom';
    syncPresetUi();
    syncOutput();
    persist();
    publish();          // so a turned knob is audible, not just written down
    drawCurve();        // so a fader move redraws the curve immediately
  }

  function syncPresetUi() {
    for (const [id, b] of presetBtns) {
      const on = id === preset;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const p = EQ_PRESETS.find((x) => x.id === preset);
    const u = userById(preset);

    if (p) {
      presetWhy.textContent = p.why + (p.approx
        ? ' · The live preview approximates this preset with the band bank — ' +
          'the file gets the exact chain below.'
        : '');
      presetChain.querySelector('code').textContent =
        p.chain ? `music master <track> --eq ${p.id}` +
                  `\n  → ${p.chain}`
                : `music master <track> --eq flat` +
                  `\n  → (no tone filter; loudness and true peak only)`;
      presetChain.hidden = false;
      return;
    }

    if (u) {
      presetWhy.textContent =
        `Saved preset "${u.name}" — ${u.bands.length} band` +
        `${u.bands.length === 1 ? '' : 's'}, kept in this browser only. ` +
        'The chain below is what it passes to --eq.';
      presetChain.querySelector('code').textContent = '';
      presetChain.hidden = true;
      return;
    }

    let why = 'Hand-set bands. Pass the chain below to --eq; master.py takes ' +
      'any ffmpeg filter chain that is not a preset name.';
    /* Some of what a preset did cannot survive a hand edit: the bank has no
       stereo tool, so narrow-bass's mono fold is dropped rather than carried
       into the chain, and warm's FIR curve becomes the shelving pair the
       response curve draws. Saying so is the difference between a panel that
       changed the master and one that quietly stopped doing half of it. */
    if (leftBehind) why += ' ' + leftBehind;
    presetWhy.textContent = why;
    /* Emptied as well as hidden. A hidden element keeps its text, and this box
       holds a runnable command: anything reading the DOM rather than the
       screen — a test, a scraper, a person in devtools — would find a stale
       `--eq flat` standing next to hand-set bands and reasonably conclude the
       panel was emitting it. The live chain is in .eq-chain. */
    presetChain.querySelector('code').textContent = '';
    presetChain.hidden = true;
  }

  /* --- publishing to the audio engine -----------------------------------
     The panel is the authority on what the EQ is set to; the engine reads it
     from here and builds BiquadFilterNodes from the same numbers the response
     curve is drawn from. Publishing on every change means a turned knob is
     audible immediately, which is the whole point of a knob.

     `type` already carries WebAudio's own type names, so nothing is translated
     between the curve, the sound, and the ffmpeg chain — and the two presets
     that cannot be a biquad chain (`warm`'s FIR curve, `narrow-bass`'s stereo
     fold) are published as the band bank's nearest approximation, which is
     what the panel says on its face. */
  function publish() {
    const list = bands.filter(eqBandActive).map((b) => ({
      id: b.id,
      type: b.type,
      freq: b.f,
      /* A band whose type has no gain publishes 0, which is the truth: a
         low-pass does not boost by anything. This list is a public contract
         read by more than the engine, so a filler value put here to satisfy
         one consumer would be a false reading for every other one, and a
         reader that did honour gain on a pass filter would apply the error
         silently. The engine recognises the gain-less shapes by type. */
      gain: hasGain(b) ? b.g : 0,
      q: b.q,
    }));
    /* The clean-lows preset's high-pass is a filter the bank does not hold as
       a band, so it is published as one — otherwise selecting that preset is
       silent while the chain says otherwise. */
    if (highpass > 0) {
      list.unshift({ id: 'hp', type: 'highpass', freq: highpass, gain: 0, q: Math.SQRT1_2 });
    }
    window.StudioEq = window.StudioEq || {};
    window.StudioEq.bands = list;
    window.StudioEq.preset = preset;
    /* The trim maths, published beside the bands it is computed from. The
       engine reads the trim off this panel like it reads the bands, and a
       test can ask for the same number the panel applied rather than
       reimplementing the sweep and slowly drifting from it. */
    window.StudioEq.trimForBands = trimForBands;
    /* Retune a playing chain in place where possible. A rebuild would stop and
       restart the source, losing the playhead and making an A/B impossible. */
    try {
      const eng = engineOf();
      if (eng && typeof eng.updateEq === 'function') {
        if (!eng.updateEq(list) && eng.playing && typeof eng.rebuildEq === 'function') {
          eng.rebuildEq();
        }
      }
    } catch { /* the panel still works with no engine present */ }
    /* After the bands, never before: the trim is the inverse of what the
       chain now does, so it has to be computed from the list the engine has
       just been given. */
    applyTrim();
  }

  /* --- the chain -------------------------------------------------------- */

  /** Trim a number for a filter argument: ffmpeg does not want 1.0000000002
      and a person reading the line does not either. Only the fractional part
      is trimmed — stripping trailing zeros from a whole number turns 10000 Hz
      into 1 Hz, which is a filter chain that does something else entirely. */
  function nfmt(v, digits) {
    const s = Number(v).toFixed(digits);
    if (s.indexOf('.') < 0) return s;
    return s.replace(/0+$/, '').replace(/\.$/, '');
  }

  function activeBands() { return bands.filter(eqBandActive); }

  function buildChain() {
    /* While a built-in preset is selected the chain is master.py's own string,
       verbatim and unconditionally. The `bands` and `highpass` entries on a
       preset exist only so the curve and the knobs can show what it does;
       rebuilding the chain from them would emit something subtly different
       from what `--eq <name>` actually runs — the Air preset came back as
       `treble=f=10000:width_type=q:w=0.7:g=1` against the CLI's
       `treble=g=1.0:f=10000:width_type=q:w=0.7`. The moment a band is touched,
       `preset` becomes 'custom' and no built-in is found here, so the
       hand-built chain below takes over. A saved preset is a band list, not a
       CLI name, so it builds its chain the same way. */
    const p = EQ_PRESETS.find((x) => x.id === preset);
    if (p) return p.chain;

    const parts = [];
    if (highpass > 0) parts.push(`highpass=f=${nfmt(highpass, 0)}:poles=2`);
    for (const b of activeBands()) {
      if (b.type === 'peaking') {
        parts.push(`equalizer=f=${nfmt(b.f, 0)}:t=q:w=${nfmt(b.q, 2)}` +
                   `:g=${nfmt(b.g, 2)}`);
      } else if (b.type === 'lowshelf') {
        parts.push(`bass=f=${nfmt(b.f, 0)}:width_type=q:w=${nfmt(b.q, 2)}` +
                   `:g=${nfmt(b.g, 2)}`);
      } else if (b.type === 'highshelf') {
        parts.push(`treble=f=${nfmt(b.f, 0)}:width_type=q:w=${nfmt(b.q, 2)}` +
                   `:g=${nfmt(b.g, 2)}`);
      } else if (b.type === 'highpass') {
        parts.push(`highpass=f=${nfmt(b.f, 0)}`);
      } else if (b.type === 'lowpass') {
        parts.push(`lowpass=f=${nfmt(b.f, 0)}`);
      } else if (b.type === 'notch') {
        /* ffmpeg has no `notch`; a band-reject of the same shape is an
           equalizer with a deep cut, which is what the curve draws too. */
        parts.push(`equalizer=f=${nfmt(b.f, 0)}:t=q:w=${nfmt(b.q, 2)}:g=-30`);
      }
    }
    return parts.join(',');
  }

  function syncOutput() {
    const chain = buildChain();
    outField.value = chain;
    outField.placeholder = 'flat — no tone filter';
    const p = EQ_PRESETS.find((x) => x.id === preset);
    outLabel.textContent = chain
      ? (p && p.id !== 'custom' && chain === p.chain
          ? `music master <track> --eq ${p.id}`
          : `music master <track> --eq "${chain.length > 46
              ? chain.slice(0, 44) + '…' : chain}"`)
      : 'music master <track> --eq flat';
    copyBtn.disabled = !chain;
  }

  /* --- the response curve ----------------------------------------------- */

  const CH = 180;
  const PAD_B = 17, PAD_T = 6;
  const DB = 18;                        // ±18 dB shown, matching the faders

  /* The last geometry drawn, so a pointer event can turn a client coordinate
     into a frequency and a gain without measuring again. */
  let geo = { w: 0, plotH: Math.max(1, CH - PAD_B - PAD_T) };

  const yOf = (db) => PAD_T + (1 - (__W.clamp(db, -DB, DB) + DB) / (2 * DB)) * geo.plotH;
  const dbOf = (y) => __W.clamp((1 - (y - PAD_T) / geo.plotH) * 2 * DB - DB, -DB, DB);

  /* --- the spectrum behind the curve -------------------------------------
     What EQ Eight shows, and for the same reason: a response curve on its own
     tells you what the filters do, but not what they are doing it TO. With
     the live content drawn behind it on the same axes, a resonance is
     something you can see and drag a band onto, rather than something you
     hunt for by ear.

     Drawn in the curve's own canvas, behind the curve and the handles, and
     deliberately subordinate — a dim translucent fill with no outline of its
     own. The curve is the control; the mountain is the context. If the eye
     goes to the mountain first, this is drawn wrong.

     The data has two sources and the panel is useful in both states:
       · playing — the engine's AnalyserNode, byte data over minDecibels..
         maxDecibels, arriving on state.live.spectrum. This is the tap
         tray.js already fills once per frame; taking it from there rather
         than opening a second AnalyserNode means one FFT for the page.
       · stopped — the analysis's average spectrum (analysis.spectrum.db,
         with freqs when analyze.py supplied them), so a loaded-but-stopped
         file still shows what it contains.

     SMOOTHING. The analyser's own smoothingTimeConstant handles the FFT
     jitter; this adds a slow-release envelope on top so the shape settles
     rather than strobing. Attack is immediate — a transient should show the
     moment it happens — and release is per-frame exponential, which is what
     a peak-hold meter does and what makes a spectrum readable at 60 Hz.

     COST. No new frame loop and no new tap: this runs inside drawCurve(),
     which already runs once per frame, and reads an array the page had
     already filled. The per-column reduction is O(bins) once per frame. */

  /** The smoothed mountain, one dB value per canvas column. Rebuilt when the
      canvas width changes; carried across frames otherwise, because the decay
      IS the state. */
  let specEnv = null;           // Float32Array, dBFS-ish, per column
  let specW = 0;
  let specLive = false;         // was the last fill from live audio?

  /* Release per frame. 0.82 settles a peak in about a fifth of a second at
     60 Hz — slow enough not to flicker, fast enough that the mountain still
     follows the music rather than lagging behind it. */
  const SPEC_RELEASE = 0.82;

  /* The window the mountain is drawn in. The curve's axis is ±18 dB of
     RESPONSE, which is not a level, so the spectrum cannot share those
     numbers — it is mapped to the plot's height instead, from SPEC_FLOOR to
     SPEC_CEIL of signal level. The frequency axis IS shared, exactly:
     both use __W.fToT, which is the alignment that makes the overlay worth
     drawing at all. */
  const SPEC_FLOOR = -84, SPEC_CEIL = -6;

  /** Fold a bin array into per-column dB, on the curve's own log-frequency
      axis. `binHz(i)` gives a bin's centre frequency; `toDb(v)` its level.

      Each column takes the MAXIMUM of the bins that fall in it, not the mean.
      At the bottom of a log axis one column spans a fraction of a bin and at
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
    /* Columns no bin landed in are INTERPOLATED, not held.

       At the bottom of a log axis one linear FFT bin spans many columns —
       below 100 Hz a 44.1 kHz/4096 analyser gives a bin every 10.8 Hz while
       the axis gives a column every 0.3 Hz — so holding the last value drew
       the low end as a flight of stairs, which reads as structure in the
       audio that is not there. A straight line between the two bins that
       bracket the gap is still an approximation, but it is an honest one:
       it claims no detail finer than the analyser actually resolved. */
    let prev = -1;
    for (let x = 0; x < w; x++) {
      if (!isFinite(cols[x])) continue;
      if (prev >= 0 && x - prev > 1) {
        const a = cols[prev], b = cols[x], span = x - prev;
        for (let k = 1; k < span; k++) cols[prev + k] = a + (b - a) * (k / span);
      }
      prev = x;
    }
    /* The runs at either end have only one neighbour to go on, so they take
       it flat rather than inventing a slope. */
    let first = -1, lastI = -1;
    for (let x = 0; x < w; x++) { if (isFinite(cols[x])) { first = x; break; } }
    for (let x = w - 1; x >= 0; x--) { if (isFinite(cols[x])) { lastI = x; break; } }
    if (first < 0) return cols;                    // nothing landed at all
    for (let x = 0; x < first; x++) cols[x] = cols[first];
    for (let x = lastI + 1; x < w; x++) cols[x] = cols[lastI];
    return cols;
  }

  /** Update `specEnv` from whatever source is available this frame. Returns
      true when there is something worth drawing. */
  let specRaw = null;

  /** The live analyser's Nyquist, in Hz. The AudioContext picks its own rate
      from the output device, so this is asked for rather than assumed; EQ_FS
      is only a fallback for the frames before a context exists. */
  function engineNyquist() {
    try {
      const eng = engineOf();
      const sr = eng && eng.ctx ? __W.num(eng.ctx.sampleRate) : NaN;
      if (isFinite(sr) && sr > 0) return sr / 2;
    } catch { /* fall through */ }
    return EQ_FS / 2;
  }

  function updateSpectrum(state, w) {
    if (!specEnv || specW !== w) {
      specEnv = new Float32Array(w).fill(-Infinity);
      specRaw = new Float32Array(w);
      specW = w;
    }
    const live = (state && state.live) || {};
    const a = state && state.analysis;
    const playing = !!(state && state.playing);

    const sr = __W.num(a && a.metadata && a.metadata.sample_rate);
    const nyq = isFinite(sr) ? sr / 2 : (EQ_FS / 2);

    let got = false;
    const bins = live.spectrum;
    if (playing && bins && bins.length) {
      /* The analyser's byte data: 0..255 spanning minDecibels..maxDecibels,
         which the engine sets to −90..0. Mapped back to dB so the mountain is
         drawn against a level scale rather than a byte scale.

         The Nyquist here is the AUDIO CONTEXT's, not EQ_FS. The curve is
         drawn at the 48 kHz delivery rate, but the analyser's bins are
         spaced by whatever rate the browser opened its context at — 44.1 kHz
         on most Macs. Using EQ_FS for both put every bin about 9% too high on
         the axis, which is a third of a semitone of misalignment at the very
         place the overlay exists to line up. */
      const n = bins.length;
      const nq = engineNyquist();
      foldBins(specRaw, n, (i) => (i + 0.5) * nq / n,
        (i) => (bins[i] / 255) * 90 - 90, w);
      got = true;
      specLive = true;
    } else {
      const spec = (a && a.spectrum) || {};
      const db = __W.arrOf(spec.db);
      const freqs = __W.arrOf(spec.freqs);
      if (db && db.length) {
        /* analyze.py's average spectrum. Its dB reference is not dBFS — it is
           whatever the analysis normalised to — so it is shifted to sit in the
           same window the live data does, by putting its loudest bin where a
           loud live signal would be. The SHAPE is the information here; the
           absolute offset is not, and pretending otherwise would put the
           mountain off the top or bottom of the plot depending on the file. */
        let hi = -Infinity;
        for (const v of db) if (isFinite(v) && v > hi) hi = v;
        const shift = isFinite(hi) ? (SPEC_CEIL - 4) - hi : 0;
        const freqAt = (freqs && freqs.length === db.length)
          ? (i) => freqs[i]
          : (i) => (i + 0.5) * nyq / db.length;
        foldBins(specRaw, db.length, freqAt, (i) => db[i] + shift, w);
        got = true;
        specLive = false;
      }
    }

    if (!got) {
      /* Nothing to show. Let whatever is on screen fall away rather than
         cutting it, so stopping playback fades the mountain out. */
      let any = false;
      for (let x = 0; x < w; x++) {
        const v = specEnv[x];
        if (!isFinite(v)) continue;
        specEnv[x] = v - 1.6;                  // dB per frame
        if (specEnv[x] > SPEC_FLOOR) any = true; else specEnv[x] = -Infinity;
      }
      return any;
    }

    /* Attack instantly, release slowly: a peak-hold, which is what stops a
       spectrum strobing without making it lag. A static average spectrum has
       nothing to decay, so it is taken whole. */
    if (!specLive) {
      specEnv.set(specRaw);
    } else {
      for (let x = 0; x < w; x++) {
        const now = specRaw[x];
        const prev = specEnv[x];
        specEnv[x] = (!isFinite(prev) || now >= prev)
          ? now
          : prev * SPEC_RELEASE + now * (1 - SPEC_RELEASE);
      }
    }
    return true;
  }

  /** Draw the mountain. Called from drawCurve() before the curve, so the
      curve and every handle paint on top of it. */
  function drawSpectrum(ctx, w, plotH) {
    if (!specEnv || specW !== w) return;

    const yFor = (db) => {
      const t = (__W.clamp(db, SPEC_FLOOR, SPEC_CEIL) - SPEC_FLOOR) /
                (SPEC_CEIL - SPEC_FLOOR);
      return PAD_T + (1 - t) * plotH;
    };
    const base = PAD_T + plotH;

    let started = false;
    ctx.beginPath();
    for (let x = 0; x < w; x++) {
      const v = specEnv[x];
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
       rather than competing with the 0 dB line. */
    const grad = ctx.createLinearGradient(0, PAD_T, 0, base);
    grad.addColorStop(0, 'rgba(126,172,138,0.26)');
    grad.addColorStop(1, 'rgba(96,132,110,0.07)');
    ctx.fillStyle = grad;
    ctx.fill();

    /* A hairline along the ridge. Without it a low, broad spectrum is a smear
       with no readable top edge; at this alpha it still sits well under the
       curve. */
    ctx.beginPath();
    let move = true;
    for (let x = 0; x < w; x++) {
      const v = specEnv[x];
      if (!isFinite(v)) { move = true; continue; }
      const y = yFor(v);
      if (move) { ctx.moveTo(x, y); move = false; } else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(150,196,162,0.34)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  function coeffsFor(b) {
    switch (b.type) {
      case 'peaking': return __W.peakingCoeffs(b.f, b.g, b.q, EQ_FS);
      case 'lowshelf': return __W.lowShelfCoeffs(b.f, b.g, b.q, EQ_FS);
      case 'highshelf': return __W.highShelfCoeffs(b.f, b.g, b.q, EQ_FS);
      case 'lowpass': return __W.lowPassCoeffs(b.f, EQ_FS, b.q);
      case 'highpass': return __W.highPassQCoeffs(b.f, EQ_FS, b.q);
      case 'notch': return __W.notchCoeffs(b.f, EQ_FS, b.q);
      default: return null;
    }
  }

  /** Combined magnitude at one frequency, in dB. */
  function responseAt(f) {
    let db = 0;
    if (highpass > 0) db += __W.biquadDb(__W.highPassCoeffs(highpass, EQ_FS), f, EQ_FS);
    for (const b of activeBands()) {
      const c = coeffsFor(b);
      if (c) db += __W.biquadDb(c, f, EQ_FS);
    }
    return db;
  }

  /** Where a band's handle sits. A gain band rides the combined curve at its
      own frequency; a pass or notch band has no gain to ride, so its handle
      sits on the 0 dB line where it can still be grabbed and dragged sideways. */
  function handleXY(b, w) {
    const x = __W.fToT(b.f) * w;
    const y = hasGain(b) ? yOf(responseAt(b.f)) : yOf(0);
    return { x, y };
  }

  /** The last frame state the tray handed over, so a redraw provoked by a
      knob turn (which has no state of its own) still paints the mountain that
      was there rather than dropping it for one frame. */
  let lastState = null;

  function drawCurve(state) {
    const w = __W.boxWidth(curveCv, 0);
    if (!__W.hasArea(w, CH)) return;
    const ctx = __W.fitCanvas(curveCv, w, CH);
    geo = { w, plotH: Math.max(1, CH - PAD_B - PAD_T) };
    ctx.clearRect(0, 0, w, CH);
    ctx.fillStyle = '#07080a';
    ctx.fillRect(0, 0, w, CH);

    const plotH = geo.plotH;

    /* The live content, behind everything but the backdrop. Drawn before the
       grid so the gridlines and the 0 dB line stay readable across it — the
       mountain is context, and context does not obscure the scale it is read
       against. */
    if (state) lastState = state;
    try {
      if (updateSpectrum(lastState, w)) drawSpectrum(ctx, w, plotH);
    } catch (err) {
      /* A malformed analysis must not take the curve down with it: the curve
         is the control, and it has to keep drawing. */
      specEnv = null;
      console.error('EQ spectrum overlay failed', err);
    }

    /* grid */
    ctx.font = `500 9px ${__W.MONO}`;
    ctx.textBaseline = 'top';
    ctx.textAlign = 'center';
    for (const f of __W.SPEC_LABELS) {
      const x = Math.round(__W.fToT(f) * w) + 0.5;
      ctx.fillStyle = 'rgba(78,80,73,0.28)';
      ctx.fillRect(x, PAD_T, 1, plotH);
      ctx.fillStyle = '#5c5e56';
      ctx.fillText(__W.fmtHz(f), __W.clamp(x, 14, w - 14), CH - PAD_B + 4);
    }
    ctx.textBaseline = 'middle';
    for (const db of [-12, -6, 6, 12]) {
      const y = Math.round(yOf(db)) + 0.5;
      ctx.fillStyle = 'rgba(78,80,73,0.18)';
      ctx.fillRect(0, y, w, 1);
      ctx.fillStyle = '#4e5049';
      ctx.textAlign = 'left';
      ctx.fillText(__W.sgn(db, 0), 3, y);
      ctx.textAlign = 'center';
    }

    /* the 0 dB line — the thing the curve is read against */
    const y0 = Math.round(yOf(0)) + 0.5;
    ctx.fillStyle = 'rgba(168,137,78,0.45)';
    ctx.fillRect(0, y0, w, 1);

    const p = EQ_PRESETS.find((x) => x.id === preset);
    if (p && p.noCurve) {
      /* The stereo fold has no magnitude of its own, but the low-pass beside
         it does and the bank is standing in for it — so the curve is drawn as
         usual and labelled as the approximation it is, rather than left blank
         while the audio is filtered. */
      ctx.fillStyle = '#7e8077';
      ctx.font = `400 11px ${__W.ENGRAVE}`;
      ctx.textAlign = 'center';
      ctx.letterSpacing = '0.18em';
      ctx.fillText('LIVE PREVIEW APPROXIMATES — THE FOLD TO MONO IS NOT SHOWN',
        w / 2, PAD_T + 10);
      ctx.letterSpacing = '0em';
    }

    /* --- the curve, computed per pixel column -------------------------- */
    const pts = new Float64Array(w);
    for (let x = 0; x < w; x++) pts[x] = responseAt(__W.tToF(x / Math.max(1, w - 1)));

    /* fill between the curve and 0 dB, so a boost and a cut read differently
       without needing two colours */
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
    ctx.strokeStyle = '#ffcf8a';
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    /* band handles: where each active band sits, so the curve and the bank
       below it are visibly the same object — and now the same control, since
       these are what a drag moves. */
    bands.forEach((b, i) => {
      if (!eqBandActive(b)) return;
      const { x, y } = handleXY(b, w);
      const live = drag && drag.id === b.id;
      const r = live ? 5.2 : 4.2;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = live ? '#2a2113' : '#0d0e0c';
      ctx.fill();
      ctx.strokeStyle = live ? '#ffcf8a' : '#d8b877';
      ctx.lineWidth = live ? 2 : 1.4;
      ctx.stroke();
      ctx.fillStyle = live ? '#ffcf8a' : 'rgba(216,184,119,0.85)';
      ctx.font = `500 9px ${__W.MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillText(bandShort(b, i),
        __W.clamp(x, 14, w - 14), __W.clamp(y - 7, 10, CH - PAD_B - 2));
      ctx.textBaseline = 'middle';
    });

    if (highpass > 0) {
      const x = Math.round(__W.fToT(highpass) * w) + 0.5;
      ctx.save();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(111,159,114,0.7)';
      ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(x, PAD_T); ctx.lineTo(x, PAD_T + plotH); ctx.stroke();
      ctx.restore();
    }

    /* how far the chain moves the level, which is what makes loudnorm's job
       change — the number worth knowing before running a master */
    let peak = 0;
    for (let x = 0; x < w; x++) if (Math.abs(pts[x]) > Math.abs(peak)) peak = pts[x];
    ctx.fillStyle = Math.abs(peak) > 3 ? '#d9a441' : '#7e8077';
    ctx.font = `500 10px ${__W.MONO}`;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillText('max ' + __W.sgn(peak, 1) + ' dB', w - 5, PAD_T + 2);
  }

  /* --- dragging a handle -------------------------------------------------
     The curve stops being a picture of the settings and becomes the settings.
     Horizontal is frequency on the same log axis the grid is drawn on,
     vertical is gain, and shift (or the wheel) is Q — the three numbers a
     band has, on the one control where their effect is visible.
  */

  let drag = null;      // { id, pointerId, shift, startQ, startY }

  /** Canvas-local coordinates from a pointer event. */
  function localXY(e) {
    const r = curveCv.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  /** The nearest band handle within a grab radius, or null. */
  function hitHandle(x, y) {
    const w = geo.w || __W.boxWidth(curveCv, 0);
    if (!__W.hasArea(w, CH)) return null;
    let best = null, bestD = 16 * 16;    // a 16 px grab radius, touch-sized
    for (const b of bands) {
      if (!eqBandActive(b)) continue;
      const h = handleXY(b, w);
      const d = (h.x - x) * (h.x - x) + (h.y - y) * (h.y - y);
      if (d < bestD) { bestD = d; best = b; }
    }
    return best;
  }

  function showTip(b, x, y) {
    if (!b) { curveTip.hidden = true; return; }
    const t = EQ_TYPES[b.type];
    const bits = [__W.fmtHz(b.f) + ' Hz'];
    if (hasGain(b)) bits.push(__W.sgn(b.g, 1) + ' dB');
    bits.push('Q ' + b.q.toFixed(2));
    curveTip.textContent = (t ? t.label : 'Band') + ' · ' + bits.join('  ');
    curveTip.hidden = false;
    /* Kept inside the well: a chip that runs off the right edge of a 400 px
       card is a readout you cannot read. */
    const w = geo.w || curveWrap.clientWidth;
    const tw = curveTip.offsetWidth || 150;
    curveTip.style.left = Math.round(__W.clamp(x - tw / 2, 2, Math.max(2, w - tw - 2))) + 'px';
    curveTip.style.top = Math.round(__W.clamp(y - 30, 2, CH - 26)) + 'px';
  }

  curveCv.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const { x, y } = localXY(e);
    const b = hitHandle(x, y);
    if (!b) return;
    try { curveCv.setPointerCapture(e.pointerId); } catch { /* not captured */ }
    drag = { id: b.id, pointerId: e.pointerId, startQ: b.q, startY: y, shift: e.shiftKey };
    curveCv.classList.add('is-dragging');
    showTip(b, x, y);
    drawCurve();
    e.preventDefault();
  });

  curveCv.addEventListener('pointermove', (e) => {
    const { x, y } = localXY(e);
    if (!drag) {
      /* Hover: the cursor says whether there is a handle under it, so the
         curve advertises that it is draggable before anything is pressed. */
      curveCv.classList.toggle('is-over', !!hitHandle(x, y));
      return;
    }
    const b = bandById(drag.id);
    if (!b) { drag = null; return; }
    const w = geo.w || __W.boxWidth(curveCv, 0);
    if (!__W.hasArea(w, CH)) return;

    if (e.shiftKey || drag.shift) {
      /* Shift-drag is Q. Vertical travel from where the shift began, on a log
         scale so the wide end of a Q range is as reachable as the narrow one. */
      drag.shift = true;
      const qr = qRange(b);
      const t = (drag.startY - y) / 160;
      const q = Math.exp(__W.lerp(Math.log(qr.min), Math.log(qr.max),
        __W.clamp((Math.log(drag.startQ) - Math.log(qr.min)) /
              (Math.log(qr.max) - Math.log(qr.min)) + t, 0, 1)));
      b.q = __W.clamp(q, qr.min, qr.max);
    } else {
      const fr = fRange(b);
      b.f = __W.clamp(__W.tToF(__W.clamp(x / Math.max(1, w - 1), 0, 1)), fr.min, fr.max);
      if (hasGain(b)) {
        /* The handle rides the *combined* curve, so dragging it to a y means
           setting this band's gain such that the sum lands there. The other
           bands' contribution at this frequency is what the difference is
           taken against — otherwise two overlapping bands fight the cursor. */
        const others = responseAt(b.f) - (coeffsFor(b)
          ? __W.biquadDb(coeffsFor(b), b.f, EQ_FS) : 0);
        b.g = __W.clamp(dbOf(y) - others, EQ_GAIN.min, EQ_GAIN.max);
      }
    }
    normaliseBand(b);
    syncControls();
    showTip(b, x, y);
    onEdit();
  });

  const endCurveDrag = (e) => {
    if (!drag) return;
    try { curveCv.releasePointerCapture(drag.pointerId); } catch { /* gone */ }
    drag = null;
    curveCv.classList.remove('is-dragging');
    curveTip.hidden = true;
    drawCurve();
  };
  curveCv.addEventListener('pointerup', endCurveDrag);
  curveCv.addEventListener('pointercancel', endCurveDrag);
  curveCv.addEventListener('pointerleave', () => {
    if (!drag) { curveCv.classList.remove('is-over'); curveTip.hidden = true; }
  });

  /* The wheel over a handle is Q, which is the gesture most plugins use and
     the one that needs no modifier. Only over a handle: a wheel anywhere else
     on the curve must still scroll the page. */
  curveCv.addEventListener('wheel', (e) => {
    const { x, y } = localXY(e);
    const b = hitHandle(x, y);
    if (!b) return;
    e.preventDefault();
    const qr = qRange(b);
    const step = (e.shiftKey ? 0.01 : 0.06) * (e.deltaY < 0 ? 1 : -1);
    const t = (Math.log(b.q) - Math.log(qr.min)) / (Math.log(qr.max) - Math.log(qr.min));
    b.q = __W.clamp(Math.exp(__W.lerp(Math.log(qr.min), Math.log(qr.max), __W.clamp(t + step, 0, 1))),
      qr.min, qr.max);
    syncControls();
    showTip(b, x, y);
    onEdit();
  }, { passive: false });

  /* Double-click: on a handle, zero that band (the fastest way to take one
     out of the way); on empty space, add a peak at the frequency clicked,
     which is how a band gets created where it is wanted rather than at a
     default and then dragged. */
  curveCv.addEventListener('dblclick', (e) => {
    e.preventDefault();
    const { x, y } = localXY(e);
    const w = geo.w || __W.boxWidth(curveCv, 0);
    if (!__W.hasArea(w, CH)) return;
    const hit = hitHandle(x, y);
    if (hit) {
      if (hasGain(hit)) { hit.g = 0; syncControls(); onEdit(); }
      else if (removeBand(hit.id)) { rebuildBank(); onEdit(); }
      return;
    }
    const f = __W.tToF(__W.clamp(x / Math.max(1, w - 1), 0, 1));
    const b = addBand(f);
    if (!b) return;
    /* Born with the gain the click asked for, so the band appears where the
       cursor is rather than flat on the line. Clicking on the 0 dB line gives
       a small lift instead of a band that is active but invisible. */
    const want = dbOf(y);
    b.g = __W.clamp(Math.abs(want) < 0.5 ? 2 : want, EQ_GAIN.min, EQ_GAIN.max);
    rebuildBank();
    onEdit();
  });

  /* --- persistence ------------------------------------------------------ */

  function persist() {
    __W.writeStore(STORE, {
      version: 4,
      preset,
      highpass,
      expanded,
      /* The defeat switch is the user's decision about their own monitor
         path, so it survives a reload like every other control here. Absent
         from a version 3 store, and absent reads as ON — the safe default,
         and the state every version-3 session was effectively in once this
         shipped. */
      autoGain,
      /* `enabled` rides along with the numbers: a band switched out is part of
         the arrangement, and a reload that brought every band back in circuit
         would be a reload that changed the sound. Version 2 stores have no
         such field and read back as on, which is what they were. */
      bands: bands.map((b) => ({
        id: b.id, type: b.type, f: b.f, g: b.g, q: b.q,
        enabled: b.enabled !== false,
      })),
    });
  }

  (function restore() {
    loadUserPresets();
    buildPresetRow();

    const s = __W.readStore(STORE, null);
    if (!s) { syncCompUi(); clearClip(); applyPreset('flat'); drawCurve(); return; }

    if (Array.isArray(s.bands) && s.bands.length) {
      /* Schema 2: the band list is saved whole, because it is no longer a
         fixed five and cannot be rebuilt from a map of known ids. */
      const list = [];
      for (const b of s.bands.slice(0, EQ_MAX_BANDS)) {
        if (!b || typeof b !== 'object') continue;
        list.push(normaliseBand({
          id: typeof b.id === 'string' && b.id ? b.id : 'b' + (list.length + 1),
          type: typeof b.type === 'string' ? b.type : 'peaking',
          f: __W.num(b.f), g: __W.num(b.g), q: __W.num(b.q),
          /* Schema 2 has no flag; its bands were all in circuit. */
          enabled: b.enabled !== false,
        }));
      }
      if (list.length) bands = list;
    } else if (s.values && typeof s.values === 'object') {
      /* Schema 1: five bands keyed by id. Read so an existing arrangement
         survives this version rather than being silently reset. */
      for (const b of bands) {
        const v = s.values[b.id];
        if (!v) continue;
        b.f = __W.num(v.f); b.g = __W.num(v.g); b.q = __W.num(v.q);
        normaliseBand(b);
      }
    }

    /* A saved id that no longer exists — a deleted user preset, or a name
       from a future version — falls back to 'custom' rather than leaving a
       pressed button that matches nothing. */
    if (typeof s.preset === 'string') {
      preset = (EQ_PRESETS.some((p) => p.id === s.preset) || userById(s.preset))
        ? s.preset : 'custom';
    }
    if (isFinite(__W.num(s.highpass))) highpass = __W.num(s.highpass);
    /* Only an explicit false defeats it. A store written before the switch
       existed has no opinion, and the answer that cannot surprise anyone with
       a clipped monitor is "compensated". */
    if (s.autoGain === false) autoGain = false;
    if (s.expanded) {
      expanded = true;
      bank.hidden = false;
      bandsToggle.textContent = 'Hide band controls';
      bandsToggle.setAttribute('aria-expanded', 'true');
    }
    rebuildBank();
    syncPresetUi();
    syncOutput();
    /* Before the publish, because publish() applies the trim and the trim
       depends on the restored `autoGain`. */
    syncCompUi();
    clearClip();
    /* Restoring is a publish too: the bands that come back from localStorage
       are the bands the engine must build, and without this a reloaded page
       showed a curve it was not playing. */
    publish();
    drawCurve();
  })();

  /* --- restoring an EQ from a saved workspace ---------------------------
     studio.js owns the workspace (which track, which panel, what was open)
     and the EQ is part of it, but the bands belong to this panel: it holds
     the band bank, the preset row and the curve. So the workspace hands the
     bands over on a `studio-eq-restore` event rather than reaching in, and
     this listener does what the localStorage restore above does — adopt the
     list, rebuild the controls, publish so the engine hears it, redraw.

     The bands arrive from another file, so nothing about them is trusted:
     each goes through the same normaliseBand() as a stored one, the list is
     capped at EQ_MAX_BANDS, and an event carrying nothing usable is ignored
     rather than flattening the EQ the user is working on. */
  window.addEventListener('studio-eq-restore', (e) => {
    const incoming = e && e.detail && e.detail.bands;
    if (!Array.isArray(incoming) || !incoming.length) return;

    const list = [];
    for (const b of incoming.slice(0, EQ_MAX_BANDS)) {
      if (!b || typeof b !== 'object') continue;
      list.push(normaliseBand({
        id: typeof b.id === 'string' && b.id ? b.id : 'b' + (list.length + 1),
        type: typeof b.type === 'string' ? b.type : 'peaking',
        // The engine's own band shape uses freq/gain; a stored one uses f/g.
        // Accept either, so neither side has to translate.
        f: isFinite(__W.num(b.f)) ? __W.num(b.f) : __W.num(b.freq),
        g: isFinite(__W.num(b.g)) ? __W.num(b.g) : __W.num(b.gain),
        q: isFinite(__W.num(b.q)) ? __W.num(b.q) : __W.num(b.Q),
        /* A workspace saved before the toggle carries no flag, and the bands
           it holds are the ones the engine was playing — so they are on. The
           published list only ever contains bands that were in circuit, so a
           round trip through the engine's own shape cannot resurrect one that
           was switched out. */
        enabled: b.enabled !== false,
      }));
    }
    if (!list.length) return;

    bands = list;
    /* A restored arrangement is not one of the built-in chains unless the
       event says so, and claiming otherwise would light a preset button that
       does not match the curve. */
    const want = e.detail.preset;
    preset = (typeof want === 'string' &&
              (EQ_PRESETS.some((p) => p.id === want) || userById(want)))
      ? want : 'custom';
    if (isFinite(__W.num(e.detail.highpass))) highpass = __W.num(e.detail.highpass);

    rebuildBank();
    syncPresetUi();
    syncOutput();
    publish();
    persist();      // the restored state is now this panel's state
    drawCurve();
  });

  return {
    /* Called once per frame by the tray's loop, with the same state every
       other meter gets. No loop of its own: the overlay rides the frame that
       was already happening. */
    render(state) {
      pollClip();
      drawCurve(state);
    },
    /* The smoothed mountain, for a test that needs to check the overlay lines
       up with the axis without going through pixels — the alignment is the
       whole reason the overlay exists, so it is worth being able to assert on
       it directly. Not used by the panel itself. */
    spectrumEnvelope() {
      return specEnv ? { width: specW, db: Array.from(specEnv), live: specLive } : null;
    },
    reset() {
      applyPreset('flat');
      drawCurve();
    },
  };
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { EQ_PRESETS, EQ_TYPES, EQ_TYPE_ORDER, EQ_GAIN, EQ_MAX_BANDS, EQ_DEFAULT_BANDS, EQ_FS, eqBandActive, EqualizerPanel });

})(window.__studioWidgets || (window.__studioWidgets = {}));
