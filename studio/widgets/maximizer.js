/* ==========================================================================
   maximizer.js — the mastering suite panel
   --------------------------------------------------------------------------
   Compressor, stereo imager, maximizer and soft clip: maximize.py's four
   devices, in MClass's fixed order, with MClass's own control names and
   units. "Ratio 3:1, attack 15 ms" is how the job is discussed between
   people; `acompressor=threshold=0.15:ratio=3` is not, and a panel that made
   you translate would be a worse interface than the command line it fronts.

   Publishes window.StudioRack — { settings } in the shape the engine in
   studio.js reads on every build and every retune. The field names are
   maximize.py's CLI flags with the hyphens turned to underscores, so the
   panel, the preview and the emitted command line cannot drift apart: there
   is one vocabulary and all three speak it.

   THE PANEL IS A PREVIEW. THE CLI IS THE AUTHORITY. The browser cannot do
   everything ffmpeg does — a compressor release past 1 s, adaptive release,
   a crossover on the imager — so anything it can only approximate is read
   back from engine.rackApprox() and said on the face, beside the knob it
   affects. A knob reading 2.4 s while the monitor previews 1.0 s is the one
   failure this panel must never have.

   Depends on: core.js (elem, clamp, num, sgn, readStore, writeStore,
   fitCanvas, hasArea, MONO, ENGRAVE), knob.js (Knob).

   Loaded as a classic script from index.html, in the order widgets/README.md
   lists. Each file is its own IIFE over the shared namespace `__W`
   (window.__studioWidgets), so nothing here reaches global scope and nothing
   collides with studio.js, which declares clamp, lerp, SPEC_LABELS and more at
   top level.
   ========================================================================= */
(function (__W) {
'use strict';

/* --- the defaults ---------------------------------------------------------
   Copied field for field from maximize.py's Settings dataclass, whose own
   comment is "Defaults are 'device bypassed'". They are load-bearing twice
   over: they are what the panel opens with, and they are what the emitted
   command line is diffed against — only a field that departs from here earns
   a flag, which is what keeps a one-knob change a one-flag command. Any drift
   from maximize.py here shows up as a command that renders something other
   than what is on screen. */
const RACK_DEFAULTS = {
  // --- compressor ---------------------------------------------------------
  comp: false,
  comp_threshold: -18.0,       // dB,  MClass: -36..0
  comp_ratio: 2.0,             // :1,  ffmpeg caps at 20
  comp_attack: 20.0,           // ms
  comp_release: 250.0,         // ms
  comp_knee: 4.0,              // dB
  comp_makeup: 0.0,            // dB
  comp_adaptive: false,
  // --- stereo imager ------------------------------------------------------
  imager: false,
  xover: 500.0,                // Hz,  100..6000
  lo_width: 1.0,               // 0 mono, 1 as recorded, 2 very wide
  hi_width: 1.0,
  // --- maximizer ----------------------------------------------------------
  maximize: false,
  input_gain: 0.0,             // dB,  ±12
  limit: -1.0,                 // dBFS ceiling
  limit_attack: 'fast',
  limit_release: 'auto',
  look_ahead: true,
  // --- soft clip ----------------------------------------------------------
  soft_clip: '',               // '' = off
  clip_amount: 1.0,
  clip_threshold: 0.95,
  clip_oversample: 4,
};

/* The order the fields are emitted in. An object's key order would do the
   same job today, but a command line whose flag order depends on how the
   object happened to be built is a command line that changes when someone
   reorders a literal — and these get pasted into notes and compared by eye. */
const RACK_FIELD_ORDER = [
  'comp', 'comp_threshold', 'comp_ratio', 'comp_attack', 'comp_release',
  'comp_knee', 'comp_makeup', 'comp_adaptive',
  'imager', 'xover', 'lo_width', 'hi_width',
  'maximize', 'input_gain', 'limit', 'limit_attack', 'limit_release',
  'look_ahead',
  'soft_clip', 'clip_amount', 'clip_threshold', 'clip_oversample',
];

/* --- the presets ----------------------------------------------------------
   Copied from maximize.py's PRESETS, values and prose alike. Same rule as
   equalizer.js's EQ_PRESETS: these must stay byte-identical to the Python,
   because `--preset loud` in the emitted command is a promise that the render
   will sound like the preview. Only the fields the Python names are listed;
   everything else comes from RACK_DEFAULTS, exactly as `Settings(...)` fills
   in the rest of its dataclass. */
const RACK_PRESETS = [
  { id: 'gentle', label: 'Gentle',
    why: 'Barely there. Evens the level without changing the shape of a ' +
         'performance — the setting to reach for when a mix is already good.',
    set: { comp: true, comp_threshold: -20.0, comp_ratio: 1.8,
           comp_attack: 30.0, comp_release: 300.0, comp_knee: 6.0,
           comp_adaptive: true,
           maximize: true, input_gain: 1.0, limit_attack: 'mid',
           limit_release: 'auto' } },
  { id: 'loud', label: 'Loud',
    why: 'Competitive loudness. Pushes into the limiter and rounds what is ' +
         'left with soft clip, which is how a maximizer buys level without ' +
         'crunch.',
    set: { comp: true, comp_threshold: -16.0, comp_ratio: 2.5,
           comp_attack: 10.0, comp_release: 180.0, comp_knee: 4.0,
           comp_adaptive: true,
           maximize: true, input_gain: 4.0, limit_attack: 'fast',
           limit_release: 'auto',
           soft_clip: 'tanh', clip_amount: 1.0, clip_threshold: 0.94 } },
  { id: 'broadcast', label: 'Broadcast',
    why: 'Tight and consistent, for speech or anything heard on a phone. ' +
         'Sacrifices dynamics deliberately; do not use it on music you like.',
    set: { comp: true, comp_threshold: -24.0, comp_ratio: 3.0,
           comp_attack: 5.0, comp_release: 120.0, comp_knee: 2.0,
           maximize: true, input_gain: 2.0, limit_attack: 'fast',
           limit_release: 'fast' } },
  { id: 'wide', label: 'Wide',
    why: 'Opens the top and tightens the bottom. A narrow low end is not a ' +
         'style choice — it is headroom, and it survives a mono fold-down.',
    set: { imager: true, xover: 300.0, lo_width: 0.85, hi_width: 1.25,
           maximize: true, input_gain: 1.0, limit_attack: 'mid' } },
  { id: 'glue', label: 'Glue',
    why: 'Slow and shallow, no limiting. The compressor as an ensemble ' +
         'effect rather than a level control: it makes parts sound recorded ' +
         'together.',
    set: { comp: true, comp_threshold: -22.0, comp_ratio: 1.6,
           comp_attack: 50.0, comp_release: 400.0, comp_knee: 8.0,
           comp_adaptive: true } },
];

/* maximize.py's SOFT_CLIP_TYPES, in its order. `''` is prepended as "off"
   because on this panel the curve selector is also the device's on switch —
   there is no separate soft_clip boolean in the settings. */
const SOFT_CLIP_TYPES = ['hard', 'tanh', 'atan', 'cubic', 'exp', 'alg',
                         'quintic', 'sin', 'erf'];

const LIMIT_ATTACKS = ['fast', 'mid', 'slow'];
const LIMIT_RELEASES = ['fast', 'slow', 'auto'];

/* What each settings field is called ON THE FACEPLATE.
 *
 * `rackApprox()` reports by field name because that is the engine's own
 * vocabulary, but "comp_adaptive" is not what the user is looking at — the
 * switch beside it says "Adaptive release". The notice names the control, not
 * the variable. Anything missing here falls back to the field name, which is
 * ugly but never wrong. Keep in step with the knobRow/toggle/choice labels. */
const RACK_KNOB_LABELS = {
  comp_threshold: 'Thresh', comp_ratio: 'Ratio', comp_attack: 'Attack',
  comp_release: 'Release', comp_knee: 'Knee', comp_makeup: 'Makeup',
  comp_adaptive: 'Adaptive release',
  xover: 'Crossover', lo_width: 'Low width', hi_width: 'High width',
  input_gain: 'In gain', limit: 'Ceiling',
  limit_attack: 'Attack', limit_release: 'Release', look_ahead: 'Look ahead',
  soft_clip: 'Curve', clip_amount: 'Amount', clip_threshold: 'Thresh',
  clip_oversample: 'Oversample',
};

/* The gain-reduction meters' floor. alimiter and a browser compressor both
   spend their lives in the top few dB — a scale to −40 would leave every
   honest reading as a sliver against the rail — while a compressor genuinely
   working sits around −6. 20 dB holds a preset at full tilt with room over. */
const GR_FLOOR = -20;

/** Both meters are the same instrument twice, so they are one function. The
    reading is negative dB (reduction); the bar grows from the right, because
    that is the direction a gain reduction meter has always moved. */
function GrMeter(name, title) {
  const root = __W.elem('div', 'rack-gr');
  const head = __W.elem('div', 'rack-gr-head');
  head.appendChild(__W.elem('span', 'rack-gr-name', name));
  const read = __W.elem('span', 'rack-gr-read', '—');
  head.appendChild(read);
  root.appendChild(head);

  const cv = __W.elem('canvas', 'rack-gr-bar');
  cv.setAttribute('role', 'img');
  cv.setAttribute('aria-label', title);
  root.appendChild(cv);

  const H = 14;
  /* The needle is smoothed, the number is not. A bar redrawn from the raw
     per-frame reading flickers into unreadability at 60 Hz; a number that
     lagged the audio would be the wrong kind of lie on the one readout that
     exists to prove the chain is live. So the bar gets a ballistic and the
     figure gets the truth. */
  let shown = 0;

  function draw(db) {
    const w = __W.boxWidth(cv, 0);
    if (!__W.hasArea(w, H)) return;
    const ctx = __W.fitCanvas(cv, w, H);
    ctx.clearRect(0, 0, w, H);

    ctx.fillStyle = '#0d0e0c';
    ctx.fillRect(0, 0, w, H);

    // Ticks every 6 dB, so the eye has something to measure the bar against.
    for (let d = -6; d > GR_FLOOR; d -= 6) {
      const x = Math.round(w * (1 - d / GR_FLOOR)) + 0.5;
      ctx.fillStyle = 'rgba(78,80,73,0.35)';
      ctx.fillRect(x, 0, 1, H);
    }

    if (db == null) {
      ctx.fillStyle = '#3a3c36';
      ctx.font = `400 8.5px ${__W.ENGRAVE}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.letterSpacing = '0.18em';
      ctx.fillText('OUT', w / 2, H / 2);
      ctx.letterSpacing = '0px';
      return;
    }

    const t = __W.clamp(shown / GR_FLOOR, 0, 1);      // 0 at rest, 1 at floor
    const bw = Math.round(w * t);
    if (bw > 0) {
      /* Amber up to 6 dB, red past it — not because 6 dB is wrong, but
         because past it you are making a decision about the performance
         rather than controlling a level, and the meter should say which one
         you are doing. */
      const g = ctx.createLinearGradient(w - bw, 0, w, 0);
      g.addColorStop(0, shown < -6 ? '#cf5340' : '#ffb454');
      g.addColorStop(1, shown < -6 ? '#ff7a5e' : '#ffd79a');
      ctx.fillStyle = g;
      ctx.fillRect(w - bw, 0, bw, H);
    }

    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.lineWidth = 1;
    ctx.strokeRect(0.5, 0.5, w - 1, H - 1);
  }

  return {
    root,
    /** @param {number|null} db negative for reduction; null = not in chain */
    set(db) {
      if (db == null || !isFinite(db)) {
        shown = 0;
        read.textContent = '—';
        read.classList.add('is-idle');
        draw(null);
        return;
      }
      read.classList.remove('is-idle');
      /* Fast attack, slow release: the classic meter ballistic, and the one
         that matches what the ear notices. A symmetric smoother hides exactly
         the transients a compressor is there to catch. */
      shown = db < shown ? db * 0.5 + shown * 0.5 : db * 0.08 + shown * 0.92;
      read.textContent = (db <= -0.05 ? __W.sgn(db, 1) : '0.0') + ' dB';
      draw(db);
    },
    repaint() { draw(0); },
  };
}

/* ==========================================================================
   Maximizer — the panel.

   Four device sections in MClass's order, which is not arbitrary: compress
   before you widen, because a compressor reacts to the mid signal and
   widening first changes what it reacts to; clip after the limiter, because
   clipping is what buys the last dB the limiter could not.

   Every control writes into one settings object, publishes it, and asks the
   engine to retune. `updateRack()` returning false means a device appeared or
   disappeared and the graph has to be rebuilt — the panel does not try to
   work out which changes those are, because the engine already knows and a
   second copy of that knowledge here would be a bug waiting for a new device.
   ========================================================================= */

function Maximizer(host) {
  const STORE = 'music-studio.rack';

  /* --- state ---------------------------------------------------------- */

  const settings = Object.assign({}, RACK_DEFAULTS);
  let preset = '';        // '' = none/edited; otherwise a RACK_PRESETS id
  let patched = false;    // engine.rackEnabled — the cable, not the bypass
  let bypassed = false;
  const knobs = new Map();          // settings field -> Knob, for approx marks

  /* --- the engine ------------------------------------------------------ */

  function engineOf() {
    try { return window.engine || (window.Studio && window.Studio.engine) || null; }
    catch { return null; }
  }

  /* --- markup ----------------------------------------------------------- */

  /* The wiring row comes first, above everything. On a Reason rack the cable
     is round the back and out of sight; here the whole suite is optional, so
     the one control that decides whether any of the rest is audible cannot be
     buried under four device panels. */
  const patchBtn = __W.elem('button', 'rack-patch');
  patchBtn.type = 'button';
  patchBtn.appendChild(__W.elem('span', 'rack-patch-jack'));
  const patchText = __W.elem('span', 'rack-patch-text', 'Patch in');
  patchBtn.appendChild(patchText);
  patchBtn.setAttribute('aria-pressed', 'false');

  const bypassBtn = __W.elem('button', 'eq-bypass', 'Bypass');
  bypassBtn.type = 'button';
  bypassBtn.setAttribute('aria-pressed', 'false');
  bypassBtn.title = 'Hear the source with the suite patched but doing nothing';

  const grComp = GrMeter('Comp GR', 'Compressor gain reduction, in dB');
  const grLimit = GrMeter('Limiter GR', 'Limiter gain reduction, in dB');
  const grRow = __W.elem('div', 'rack-grs');
  grRow.appendChild(grComp.root);
  grRow.appendChild(grLimit.root);

  const wiring = __W.elem('div', 'eq-controls rack-wiring');
  wiring.appendChild(patchBtn);
  wiring.appendChild(bypassBtn);

  const wiringNote = __W.elem('p', 'eq-hint',
    'Patch in puts the suite in the signal path; out of path it is not ' +
    'built at all, which is not the same as bypassing it. Bypass keeps the ' +
    'cable and mutes the devices, for an A/B against the source. The ' +
    'monitor is a preview — ' +
    'music maximize renders.');

  const presetRow = __W.elem('div', 'eq-presets');
  const presetBtns = new Map();
  const presetWhy = __W.elem('p', 'eq-why', '');

  /* The approximation summary. One line above the sections, plus a mark on
     each affected knob: the mark is what you see while turning that knob, the
     line is what you see when deciding whether to trust the monitor at all. */
  const approxNote = __W.elem('p', 'rack-approx');
  approxNote.hidden = true;
  approxNote.setAttribute('role', 'status');

  const sections = __W.elem('div', 'rack-sections');

  const out = __W.elem('div', 'eq-out');
  const outLabel = __W.elem('div', 'eq-out-label', 'The command that renders this for real');
  const outField = __W.elem('input', 'eq-chain');
  outField.type = 'text';
  outField.readOnly = true;
  outField.spellcheck = false;
  outField.setAttribute('aria-label', 'The maximize command these settings produce');
  const copyBtn = __W.elem('button', 'eq-copy', 'Copy');
  copyBtn.type = 'button';
  const resetBtn = __W.elem('button', 'eq-copy eq-copy--ghost', 'Reset');
  resetBtn.type = 'button';
  const outRow = __W.elem('div', 'eq-out-row');
  outRow.appendChild(outField);
  outRow.appendChild(copyBtn);
  outRow.appendChild(resetBtn);
  out.appendChild(outLabel);
  out.appendChild(outRow);

  /* The meters go INSIDE the wiring row: they report on what the patch and
     bypass buttons decide, so they belong in that group rather than on a
     separate band above the panel. */
  wiring.appendChild(grRow);
  host.appendChild(wiring);
  host.appendChild(wiringNote);
  host.appendChild(presetRow);
  host.appendChild(presetWhy);
  host.appendChild(approxNote);
  host.appendChild(sections);
  host.appendChild(out);

  /* --- publishing and retuning -------------------------------------------
     One path out of this panel, taken by every control. The settings object
     is published by identity — the engine reads `window.StudioRack.settings`
     fresh on every build and every retune, so mutating it in place is the
     contract rather than a shortcut, and a control that rebuilt the object
     would leave the engine holding a stale one.

     Retune first, rebuild only if the shape moved. A rebuild restarts the
     source at the current offset: cheap, but audible, and doing it on every
     knob turn would make an A/B impossible. */
  function publish() {
    window.StudioRack = window.StudioRack || {};
    window.StudioRack.settings = settings;
    try {
      const eng = engineOf();
      if (!eng) return;
      if (typeof eng.updateRack === 'function' && !eng.updateRack()) {
        if (eng.playing && typeof eng.rebuildRack === 'function') eng.rebuildRack();
      }
    } catch { /* the panel still reads correctly with no engine */ }
  }

  /** Every control change lands here: write the value, drop the preset lamp
      if this was a hand edit, publish, and redraw the derived readouts.
      @param {boolean} fromPreset true when a preset load caused this, which
             is the one change that must NOT put the lamp out. */
  function onEdit(fromPreset) {
    if (!fromPreset) {
      /* Presets are starting points, not modes — maximize.py says so in its
         own docstring. The moment a knob moves, the lamp goes out: a lit
         `loud` beside settings that are no longer `loud` would put a
         `--preset loud` in the command line that renders something else. */
      if (preset) { preset = ''; syncPresetUi(); }
    }
    publish();
    syncApprox();
    syncCommand();
    persist();
  }

  /* --- controls ---------------------------------------------------------
     Three builders, because a mastering panel is knobs, switches and named
     choices and nothing else. Each writes straight into `settings` under the
     field name that is also maximize.py's flag — there is no mapping table to
     get out of step. */

  /** A knob bound to a settings field. `field` is the CLI flag name, which is
      also the key rackApprox() reports against, so the approximation mark can
      find its knob without a second lookup table. */
  function knob(field, opts) {
    const k = __W.Knob(Object.assign({
      value: settings[field],
      def: RACK_DEFAULTS[field],
      onChange: (v) => { settings[field] = v; onEdit(false); },
    }, opts));
    knobs.set(field, k);
    return k;
  }

  /** A device power switch, or any other boolean. Reuses the band-power
      styling from the EQ's strips: same object — a small latching switch with
      a lamp — so it should be the same control. */
  function toggle(field, label, opts) {
    const o = opts || {};
    const b = __W.elem('button', 'eq-band-power rack-power');
    b.type = 'button';
    b.appendChild(__W.elem('span', 'eq-band-lamp'));
    b.appendChild(__W.elem('span', 'eq-band-power-text', label));
    if (o.title) b.title = o.title;

    const sync = () => {
      const on = !!settings[field];
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    };
    b.addEventListener('click', () => {
      settings[field] = !settings[field];
      sync();
      if (o.after) o.after();
      onEdit(false);
    });
    sync();
    return { root: b, sync };
  }

  /** A named choice — the limiter's attack and release, the clip curve. These
      are the controls MClass gives names rather than numbers to, because on a
      limiter the useful settings are few and the name carries the intent. */
  function choice(field, label, values, opts) {
    const o = opts || {};
    const wrap = __W.elem('div', 'rack-choice');
    wrap.appendChild(__W.elem('div', 'eq-row-name', label));
    const sel = __W.elem('select', 'faceplate-select faceplate-select--small');
    sel.setAttribute('aria-label', label);
    for (const v of values) {
      const opt = __W.elem('option', null, o.labels ? (o.labels[v] || v) : v);
      opt.value = v;
      sel.appendChild(opt);
    }
    sel.value = String(settings[field]);
    sel.addEventListener('change', () => {
      const raw = sel.value;
      settings[field] = o.numeric ? Number(raw) : raw;
      if (o.after) o.after();
      onEdit(false);
    });
    wrap.appendChild(sel);
    return { root: wrap, sync() { sel.value = String(settings[field]); } };
  }

  /* --- the four device sections ---------------------------------------- */

  const syncers = [];        // everything that has to follow a preset load

  /** One device: a header carrying its power switch, and a body of controls
      that visibly go dead when the switch is out. The dead look is the EQ's
      `.eq-band.is-off`, because it is the same statement — these controls are
      still set to something, and none of it is reaching the audio. */
  function section(title, note, powerField, build, opts) {
    const o = opts || {};
    const root = __W.elem('div', 'rack-dev');
    const head = __W.elem('div', 'rack-dev-head');
    const names = __W.elem('div', 'rack-dev-names');
    names.appendChild(__W.elem('div', 'eq-band-name', title));
    names.appendChild(__W.elem('div', 'eq-band-kind', note));
    head.appendChild(names);

    const body = __W.elem('div', 'rack-dev-body');

    let isOn;
    if (o.on) {
      // Soft clip has no boolean: the curve selector is the switch, and a
      // separate power lamp beside it would be two controls for one fact.
      isOn = o.on;
    } else {
      const pw = toggle(powerField, 'On', { title: `Put the ${title} in the chain` });
      head.appendChild(pw.root);
      syncers.push(pw.sync);
      isOn = () => !!settings[powerField];
    }

    build(body);
    root.appendChild(head);
    root.appendChild(body);
    sections.appendChild(root);

    const sync = () => root.classList.toggle('is-off', !isOn());
    syncers.push(sync);
    sync();
    return root;
  }

  /* The ≈ chips, keyed by the settings field rackApprox() reports against.
     Declared before the builders that fill it rather than after: a `const`
     in temporal dead zone throws on read, and the only thing keeping that
     from happening here is the order the builders happen to be called in. */
  const approxMarks = new Map();   // settings field -> the ≈ chip on its label

  /** A knob and its readout, side by side — the EQ's `.eq-row` layout, which
      exists because a column of knobs with labels underneath wastes the width
      a card actually has. The returned wrapper is where an approximation mark
      is hung. */
  function knobRow(field, label, opts) {
    const row = __W.elem('div', 'eq-row');
    const face = __W.elem('div', 'eq-row-ctl');
    const side = __W.elem('div', 'eq-row-side');
    const k = knob(field, Object.assign({ label, size: 38 }, opts));
    /* The knob's own label is engraved under the cap; here the name sits
       beside it instead, so the cap can be small and the name can be long
       enough to be a word rather than an abbreviation. */
    k.root.querySelector('.knob-label').remove();
    face.appendChild(k.root);
    const nameEl = __W.elem('div', 'eq-row-name', label);
    side.appendChild(nameEl);
    side.appendChild(k.root.querySelector('.knob-field'));
    row.appendChild(face);
    row.appendChild(side);
    /* The mark for an approximated value, hung on the name rather than the
       knob: the knob is a canvas that repaints itself, and the name is the
       thing the eye reads when it wants to know what this control is. */
    const mark = __W.elem('span', 'rack-approx-mark', '≈');
    nameEl.appendChild(mark);
    approxMarks.set(field, mark);
    return row;
  }

  /* 1 — Compressor. First in the chain because a compressor reacts to the mid
     signal, and anything that changes the image before it changes what it is
     reacting to. */
  section('Compressor', 'level control · MClass order: first', 'comp', (body) => {
    const grid = __W.elem('div', 'rack-knobs');
    grid.appendChild(knobRow('comp_threshold', 'Thresh',
      { min: -36, max: 0, unit: 'dB', digits: 1 }));
    grid.appendChild(knobRow('comp_ratio', 'Ratio',
      { min: 1, max: 20, unit: ':1', digits: 1 }));
    grid.appendChild(knobRow('comp_attack', 'Attack',
      /* Log, and not because it is a frequency: attack is 0.01 ms to 2 s, and
         on a linear knob everything a compressor is normally set to lives in
         the first two degrees of travel. */
      { min: 0.01, max: 2000, unit: 'ms', digits: 1, curve: 'log' }));
    grid.appendChild(knobRow('comp_release', 'Release',
      { min: 0.01, max: 9000, unit: 'ms', digits: 0, curve: 'log' }));
    grid.appendChild(knobRow('comp_knee', 'Knee',
      { min: 1, max: 8, unit: 'dB', digits: 1 }));
    grid.appendChild(knobRow('comp_makeup', 'Makeup',
      { min: -12, max: 24, unit: 'dB', digits: 1 }));
    body.appendChild(grid);

    const sw = toggle('comp_adaptive', 'Adaptive release',
      { title: 'Release that follows the material. The render has it; the ' +
               'browser preview does not, and says so.' });
    syncers.push(sw.sync);
    const row = __W.elem('div', 'rack-switches');
    row.appendChild(sw.root);
    const mark = __W.elem('span', 'rack-approx-mark', '≈');
    sw.root.appendChild(mark);
    approxMarks.set('comp_adaptive', mark);
    body.appendChild(row);
  });

  /* 2 — Stereo imager. */
  section('Stereo imager', 'width either side of a crossover', 'imager', (body) => {
    const grid = __W.elem('div', 'rack-knobs');
    grid.appendChild(knobRow('xover', 'Crossover',
      /* Log, for the usual reason: 100 Hz to 6 kHz is nearly six octaves, and
         a linear knob would spend half its travel above 3 kHz where nobody
         sets a low/high split. */
      { min: 100, max: 6000, unit: 'Hz', digits: 0, curve: 'log' }));
    grid.appendChild(knobRow('lo_width', 'Low width',
      { min: 0, max: 2, unit: '×', digits: 2 }));
    grid.appendChild(knobRow('hi_width', 'High width',
      { min: 0, max: 2, unit: '×', digits: 2 }));
    body.appendChild(grid);
    body.appendChild(__W.elem('p', 'eq-hint',
      '0 is mono, 1 is as recorded, 2 is very wide. A narrow low end is ' +
      'headroom, not a style choice — and it survives a mono fold-down.'));
  });

  /* 3 — Maximizer. In Reason this is last; here it cannot be. Measured:
     ffmpeg's alimiter asked for −1.0 dBFS still let +0.4 dBTP through, so
     master.py's loudnorm applies the true-peak ceiling afterwards and this
     device is never the last word. */
  section('Maximizer', 'input gain into a limiter', 'maximize', (body) => {
    const grid = __W.elem('div', 'rack-knobs');
    grid.appendChild(knobRow('input_gain', 'In gain',
      { min: -12, max: 12, unit: 'dB', digits: 1 }));
    grid.appendChild(knobRow('limit', 'Ceiling',
      { min: -12, max: 0, unit: 'dB', digits: 1 }));
    body.appendChild(grid);

    const row = __W.elem('div', 'rack-switches');
    const atk = choice('limit_attack', 'Attack', LIMIT_ATTACKS);
    const rel = choice('limit_release', 'Release', LIMIT_RELEASES);
    syncers.push(atk.sync, rel.sync);
    row.appendChild(atk.root);
    row.appendChild(rel.root);
    const la = toggle('look_ahead', 'Look ahead',
      { title: '4 ms of look-ahead, so the limiter is already moving when ' +
               'the transient arrives' });
    syncers.push(la.sync);
    row.appendChild(la.root);
    body.appendChild(row);

    body.appendChild(__W.elem('p', 'eq-hint',
      'The ceiling here is not the delivery ceiling. alimiter limits sample ' +
      'peaks and lets intersample peaks past; music master applies the ' +
      'true-peak ceiling after this stage.'));
  });

  /* 4 — Soft clip. Last, because clipping is what buys the dB the limiter
     could not: rounding a peak the limiter has already flattened. */
  section('Soft clip', 'rounds what the limiter left', null, (body) => {
    const row = __W.elem('div', 'rack-switches');
    const curve = choice('soft_clip', 'Curve', [''].concat(SOFT_CLIP_TYPES), {
      labels: { '': 'off' },
      // Turning the curve on or off adds or removes a node: a shape change,
      // which publish() discovers from updateRack() returning false.
      after: () => syncAll(),
    });
    syncers.push(curve.sync);
    row.appendChild(curve.root);
    const os = choice('clip_oversample', 'Oversample', [1, 2, 4], {
      numeric: true, labels: { 1: 'none', 2: '2×', 4: '4×' },
    });
    syncers.push(os.sync);
    row.appendChild(os.root);
    body.appendChild(row);

    const grid = __W.elem('div', 'rack-knobs');
    grid.appendChild(knobRow('clip_amount', 'Amount',
      { min: 0.01, max: 3, unit: '', digits: 2 }));
    grid.appendChild(knobRow('clip_threshold', 'Thresh',
      { min: 0.05, max: 1, unit: '', digits: 2 }));
    body.appendChild(grid);
  }, { on: () => !!settings.soft_clip });

  /* --- the wiring controls --------------------------------------------- */

  function syncPatchUi() {
    patchBtn.classList.toggle('is-on', patched);
    patchBtn.setAttribute('aria-pressed', String(patched));
    patchText.textContent = patched ? 'Patched in' : 'Patch in';
    patchBtn.title = patched
      ? 'The suite is in the signal path. Click to unpatch — the devices are ' +
        'then not built at all, which is not the same as bypassing them.'
      : 'The suite is out of the signal path. Click to patch it in.';
    /* Bypass is meaningless with no cable in, and a bypass switch that could
       be pressed while nothing was patched would be a switch that did
       nothing — the worst kind on a panel meant to be trusted. */
    bypassBtn.disabled = !patched;
  }

  patchBtn.addEventListener('click', () => {
    patched = !patched;
    syncPatchUi();
    try {
      const eng = engineOf();
      if (eng) {
        eng.rackEnabled = patched;
        /* Patching is a shape change by definition — the block is either in
           the graph or it is not — so there is nothing for updateRack() to
           retune and the rebuild is unconditional. */
        if (eng.playing && typeof eng.rebuildRack === 'function') eng.rebuildRack();
      }
    } catch { /* no engine: the switch still reads correctly */ }
    persist();
  });

  bypassBtn.addEventListener('click', () => {
    bypassed = !bypassed;
    bypassBtn.classList.toggle('is-on', bypassed);
    bypassBtn.setAttribute('aria-pressed', String(bypassed));
    try {
      const eng = engineOf();
      if (eng && typeof eng.setRackBypass === 'function') eng.setRackBypass(bypassed);
    } catch { /* no engine */ }
    persist();
  });

  /* --- presets ---------------------------------------------------------- */

  function buildPresetRow() {
    presetRow.textContent = '';
    presetBtns.clear();
    for (const p of RACK_PRESETS) {
      const b = __W.elem('button', 'eq-preset', p.label);
      b.type = 'button';
      b.setAttribute('aria-pressed', 'false');
      b.title = p.why;
      /* Toggle, not latch: clicking the lit preset returns everything to the
         bypassed defaults, so the same button both applies and removes. */
      b.addEventListener('click', () => applyPreset(preset === p.id ? '' : p.id));
      presetRow.appendChild(b);
      presetBtns.set(p.id, b);
    }
  }

  /** Load a preset, or — with '' — return to maximize.py's own defaults.
      A preset sets EVERY field, not just the ones it names: `Settings(...)`
      in the Python fills the rest from the dataclass defaults, so a panel
      that only overlaid the named fields would leave the previous preset's
      soft clip running under `glue`, which switches none on. */
  function applyPreset(id) {
    Object.assign(settings, RACK_DEFAULTS);
    const p = RACK_PRESETS.find((x) => x.id === id);
    if (p) Object.assign(settings, p.set);
    preset = p ? p.id : '';
    syncAll();
    onEdit(true);
  }

  function syncPresetUi() {
    for (const [id, b] of presetBtns) {
      const on = id === preset;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    }
    const p = RACK_PRESETS.find((x) => x.id === preset);
    presetWhy.textContent = p
      ? p.why
      : 'Presets are starting points, not modes: load one and turn anything ' +
        'you like — the lamp goes out and the command line below follows the ' +
        'knobs, not the name.';
  }

  /** Push `settings` back out to every control. Called after a preset load
      and after a restore, because both change values behind the controls'
      backs — a knob that kept showing the old number would be a panel lying
      about what it is sending to the engine. */
  function syncAll() {
    for (const [field, k] of knobs) k.set(settings[field]);
    for (const s of syncers) s();
    syncPresetUi();
    syncApprox();
    syncCommand();
  }

  /* --- the approximation notice ------------------------------------------
     Read from the engine rather than recomputed here. The engine is what
     actually builds the nodes, so it is the only thing that knows what it
     could not build; a second list in this file would be a list that goes
     stale the first time the engine learns a new trick. */
  function syncApprox() {
    let list = [];
    try {
      const eng = engineOf();
      if (eng && typeof eng.rackApprox === 'function') list = eng.rackApprox() || [];
    } catch { list = []; }

    /* Cleared by class, not by the `hidden` attribute. `.rack-approx-mark`
       carries `display: inline-block`, and a display rule beats the UA's
       `[hidden] { display: none }` — so `mark.hidden = true` left every chip
       on screen and the panel claimed each of twelve knobs was approximated.
       A mark that cannot be trusted is worse than no mark, since this is the
       one readout whose whole job is to be believed. */
    for (const m of approxMarks.values()) { m.classList.remove('is-on'); m.title = ''; }

    if (!list.length) {
      approxNote.hidden = true;
      approxNote.textContent = '';
      return;
    }

    /* Built as elements rather than one string. Three of these can be live at
       once, and run together into a paragraph they read as a wall — the one
       readout whose whole job is to be scanned in a second and believed. */
    approxNote.textContent = '';
    const head = __W.elem('span', 'rack-approx-head',
      list.length === 1
        ? 'One setting is previewed approximately — the render uses what the knobs say.'
        : list.length + ' settings are previewed approximately — the render uses '
          + 'what the knobs say.');
    approxNote.appendChild(head);

    const ul = __W.elem('ul', 'rack-approx-list');
    for (const a of list) {
      if (!a || !a.knob) continue;
      /* "asked 2.4 s, previewing 1.0 s" — both values, always, and under the
         knob's own printed name rather than its settings field. `comp_adaptive`
         is what the code calls it; "Adaptive release" is what the faceplate
         says, and the faceplate is what the user is looking at. */
      const label = RACK_KNOB_LABELS[a.knob] || a.knob;
      const asked = fmtApprox(a.asked);
      const prev = a.preview == null
        ? 'not previewed at all'
        : 'previewing ' + fmtApprox(a.preview);
      const li = __W.elem('li');
      li.appendChild(__W.elem('b', 'rack-approx-knob', label));
      li.appendChild(document.createTextNode(` — asked ${asked}, ${prev}. ${a.why || ''}`.trimEnd()));
      ul.appendChild(li);

      const mark = approxMarks.get(a.knob);
      if (mark) {
        mark.classList.add('is-on');
        mark.title = `${label}: asked ${asked}, ${prev}. ${a.why || ''}`.trim();
      }
    }
    approxNote.appendChild(ul);
    approxNote.hidden = false;
  }

  function fmtApprox(v) {
    if (typeof v === 'number' && isFinite(v)) {
      return (Math.abs(v) >= 100 ? Math.round(v) : Math.round(v * 100) / 100) + '';
    }
    return String(v);
  }

  /* --- the command line ---------------------------------------------------
     The CLI is the authority, so this is not decoration: it is the way out of
     the panel and into a file. Only fields that differ from maximize.py's
     defaults are emitted, because a line carrying all twenty-two flags hides
     the two that were actually changed.

     Two forms, and which one appears is a real distinction. A clean preset
     goes out as `music maximize <track> --preset <name>` — the front-end
     command, which takes a preset and nothing else. Anything hand-set has to
     go to maximize.py directly, because that is where the per-knob flags
     live; `music maximize` does not accept them. Emitting the friendlier
     command with flags it would reject is the kind of help that costs an
     afternoon. */
  function flagOf(field) { return '--' + field.replace(/_/g, '-'); }

  /** Numbers as maximize.py's argparse wants them, and as a person reads
      them: no 1.0000000002, and no stripped trailing zero that turns 250 into
      25. Only the fractional part is ever trimmed. */
  function nfmt(v) {
    const s = Number(v).toFixed(3);
    if (s.indexOf('.') < 0) return s;
    return s.replace(/0+$/, '').replace(/\.$/, '');
  }

  function changedFields() {
    const out = [];
    for (const f of RACK_FIELD_ORDER) {
      const v = settings[f], d = RACK_DEFAULTS[f];
      if (typeof v === 'number' && typeof d === 'number') {
        // Float equality on a knob that has been dragged back to its default
        // is a coin toss; a thousandth is below any of these controls'
        // resolution and well above the drag's rounding error.
        if (Math.abs(v - d) > 1e-3) out.push(f);
      } else if (v !== d) {
        out.push(f);
      }
    }
    return out;
  }

  function buildCommand() {
    const changed = changedFields();
    if (preset) return `music maximize <track> --preset ${preset}`;
    if (!changed.length) return 'music maximize <track>   # everything bypassed';

    const parts = ['python3 maximize.py --in <track>.wav --out <track>-max.wav'];
    for (const f of changed) {
      const v = settings[f];
      if (typeof v === 'boolean') {
        /* The booleans are not symmetric on the command line, because they
           are not symmetric in argparse: --comp and --comp-adaptive are
           store_true with no off switch (the default is already off), while
           look_ahead is store_false spelled --no-look-ahead. Emitting
           --look-ahead would be a flag that does not exist. */
        if (f === 'look_ahead') { if (!v) parts.push('--no-look-ahead'); continue; }
        if (v) parts.push(flagOf(f));
        continue;
      }
      if (typeof v === 'string') {
        if (v) parts.push(flagOf(f) + ' ' + v);
        continue;
      }
      parts.push(flagOf(f) + ' ' + nfmt(v));
    }
    return parts.join(' ');
  }

  function syncCommand() {
    outField.value = buildCommand();
    /* Three states, because the line below is three different things. A clean
       preset is reachable through the friendly front-end command; a hand edit
       is not, since `music maximize` takes only --preset and the per-knob
       flags live on maximize.py. And a panel sitting at the defaults has
       nothing to render at all — labelling that "hand-set" would be the panel
       describing work nobody has done. */
    if (preset) {
      outLabel.textContent =
        `Preset "${preset}", unedited — the front-end command renders it`;
    } else if (!changedFields().length) {
      outLabel.textContent =
        'Everything at its default — nothing to render until a device is on';
    } else {
      outLabel.textContent =
        'Hand-set — music maximize takes only --preset, so this goes to maximize.py';
    }
  }

  copyBtn.addEventListener('click', () => {
    outField.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    if (!ok && navigator.clipboard) {
      // The async path is the modern one, but it is unavailable from file://
      // in some browsers, which is exactly where this page is opened.
      try { navigator.clipboard.writeText(outField.value); ok = true; } catch { /* no */ }
    }
    copyBtn.textContent = ok ? 'Copied' : 'Select + ⌘C';
    setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1400);
  });

  resetBtn.addEventListener('click', () => applyPreset(''));

  /* --- persistence ------------------------------------------------------
     The settings, the preset lamp and the wiring. The wiring is part of it on
     purpose: a suite that quietly unpatched itself on reload would have the
     user hearing an unprocessed monitor while looking at a full set of knobs.
     localStorage can throw outright in a private window; the helpers swallow
     it and the bench simply forgets. */
  function persist() {
    __W.writeStore(STORE, {
      version: 1,
      settings: Object.assign({}, settings),
      preset,
      patched,
      bypassed,
    });
  }

  (function restore() {
    buildPresetRow();

    const s = __W.readStore(STORE, null);
    if (s && s.settings && typeof s.settings === 'object') {
      /* Field by field and type-checked, never Object.assign of the stored
         blob: a store written by an older version, or edited by hand, must
         not be able to put a string in comp_ratio and have it reach a
         WebAudio param. Anything unrecognised keeps its default. */
      for (const f of RACK_FIELD_ORDER) {
        const v = s.settings[f], d = RACK_DEFAULTS[f];
        if (typeof d === 'boolean') { if (typeof v === 'boolean') settings[f] = v; }
        else if (typeof d === 'number') { if (isFinite(__W.num(v))) settings[f] = __W.num(v); }
        else if (typeof d === 'string') { if (typeof v === 'string') settings[f] = v; }
      }
      /* A curve name from a future version would build nothing and read as a
         device that is on but silent. Unknown names fall back to off. */
      if (settings.soft_clip && SOFT_CLIP_TYPES.indexOf(settings.soft_clip) < 0) {
        settings.soft_clip = '';
      }
      if (LIMIT_ATTACKS.indexOf(settings.limit_attack) < 0) {
        settings.limit_attack = RACK_DEFAULTS.limit_attack;
      }
      if (LIMIT_RELEASES.indexOf(settings.limit_release) < 0) {
        settings.limit_release = RACK_DEFAULTS.limit_release;
      }
      if ([1, 2, 4].indexOf(settings.clip_oversample) < 0) {
        settings.clip_oversample = RACK_DEFAULTS.clip_oversample;
      }
    }
    if (s && typeof s.preset === 'string' &&
        RACK_PRESETS.some((p) => p.id === s.preset)) {
      preset = s.preset;
    }
    patched = !!(s && s.patched);
    bypassed = !!(s && s.bypassed);

    bypassBtn.classList.toggle('is-on', bypassed);
    bypassBtn.setAttribute('aria-pressed', String(bypassed));
    syncPatchUi();

    try {
      const eng = engineOf();
      if (eng) {
        eng.rackEnabled = patched;
        if (typeof eng.setRackBypass === 'function') eng.setRackBypass(bypassed);
      }
    } catch { /* no engine yet: the wiring is re-applied on the first edit */ }

    syncAll();
    /* Restoring is a publish too: the settings that came back are the ones
       the engine must build, and without this a reloaded page would show a
       full set of knobs over a chain built from the defaults. */
    publish();
    grComp.repaint();
    grLimit.repaint();
  })();

  return {
    /* Called once per frame by the tray's loop. The meters are the panel's
       proof that the chain is live, so they are read from the engine every
       frame rather than pushed from a change handler — a number that only
       moved when a knob moved would prove nothing at all. */
    render() {
      let r = null;
      try {
        const eng = engineOf();
        if (eng && typeof eng.rackReduction === 'function') r = eng.rackReduction();
      } catch { r = null; }
      /* Unpatched or bypassed, the devices are out of the graph and whatever
         the last reading was is stale. Showing it would be a meter reporting
         on audio nobody is hearing. */
      const live = patched && !bypassed && r;
      grComp.set(live ? r.comp : null);
      grLimit.set(live ? r.limiter : null);
    },
    reset() {
      applyPreset('');
      grComp.set(null);
      grLimit.set(null);
    },
    /* The settings, for a test that wants to assert on what the panel is
       sending without going through window. Not used by the panel itself. */
    settings() { return Object.assign({}, settings); },
    command() { return buildCommand(); },
  };
}

/* Publish to the shared namespace for the other widget files. */
Object.assign(__W, { RACK_DEFAULTS, RACK_FIELD_ORDER, RACK_PRESETS, SOFT_CLIP_TYPES, GrMeter, Maximizer });

})(window.__studioWidgets || (window.__studioWidgets = {}));
