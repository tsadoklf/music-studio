/* studio.js — the wiring: frame loop, loading, transport, chat, layout, workspaces, boot
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
   7. Wiring
   ========================================================================== */

const $ = (sel) => document.querySelector(sel);

const el = {
  vuL: $('#vu-left'), vuR: $('#vu-right'),
  lamp: $('#peak-lamp'),
  bars: $('#bars'), corr: $('#corr'),
  spectrum: $('#spectrum'), spectro: $('#spectrogram'),
  play: $('#play'), pause: $('#pause'), stop: $('#stop'), rtz: $('#rtz'),
  scrub: $('#scrub'),
  tCur: $('#t-cur'), tDur: $('#t-dur'),
  source: $('#source-name'),
  roBpm: $('#ro-bpm'), roBpmV: $('#ro-bpm-v'), roMeter: $('#ro-meter'),
  roKey: $('#ro-key'), roKeyV: $('#ro-key-v'),
  roLufsM: $('#ro-lufs-m'), roLufsS: $('#ro-lufs-s'),
  roTp: $('#ro-tp'), roCorr: $('#ro-corr'),
  roPos: $('#ro-pos'), roBar: $('#ro-bar'),
  analyseNow: $('#analyse-now'), analyseAuto: $('#analyse-auto'),
  audioInput: $('#audio-input'), jsonInput: $('#json-input'),
  verdicts: $('#verdicts'),
  lufsM: $('#lufs-m'), lufsS: $('#lufs-s'), lufsI: $('#lufs-i'),
  lufsDelta: $('#lufs-delta'), lra: $('#lra-v'),
  cutoffNote: $('#cutoff-note'),
  rate: $('#meta-rate'), chans: $('#meta-chans'),
  mode: $('#channel-mode'),
  timeline: $('#timeline'),
  splitter: $('#splitter'),
  shell: $('.shell'),
  reset: $('#reset-all'),
  analyzeRun: $('#analyze-run'),
};

const engine = new __S.Engine();

/* The Equalizer panel lives in meters.js and needs to reach the audio graph to
   make a knob audible. One named global is the whole contract between them. */
window.engine = engine;
const vuL = new __S.VuMovement();
const vuR = new __S.VuMovement();
const spectro = new __S.Spectrogram(el.spectro);

let analysis = null;        // precomputed JSON, when loaded
let peakLatch = 0;          // timestamp of the last over
let lastFrame = performance.now();
let cutoffHz = 0;
let sourceKind = 'none';
let staticSpectrumNyquist = 0;  // nyquist for a spectrum that came from JSON

/* ---- VU reference ------------------------------------------------------
   0 VU is pinned to −18 dBFS RMS, the usual digital alignment for a −14 LUFS
   master: it puts a correctly-levelled track's needles dancing around 0
   rather than pinned or asleep at the bottom of the scale. */
const VU_REF_DBFS = -18;

function rmsToVu(rmsDb) {
  if (!isFinite(rmsDb)) return __S.VU_MIN;
  return __S.clamp(rmsDb - VU_REF_DBFS, __S.VU_MIN - 2, __S.VU_MAX + 1.2);
}

/* ---- peak hold --------------------------------------------------------- */

function updateHold(m, now, dt) {
  const v = m.tp;
  if (v > m.hold) { m.hold = v; m.holdAge = now; }
  else if (now - m.holdAge > 1500) {
    // 20 dB per second fall after the 1.5 s hold, the broadcast convention
    m.hold = Math.max(__S.BAR_MIN_DB, m.hold - 20 * dt);
  }
}

/* ---- codec cutoff detection from the live spectrum --------------------- */

/* ---- codec cutoff detection from the live spectrum ---------------------
   A lossy encoder leaves a *cliff*: full-level content right up to the cutoff,
   then a near-vertical drop to nothing that persists over time. Sparse music
   (a solo instrument, a quiet passage) also has no high-frequency energy, but
   it falls away gradually and the edge wanders. So the test is not "where does
   energy stop" — it is "is there a persistent, steep, sustained edge".        */

const cutoffHistory = [];
let cutoffStable = 0;

function detectCutoff(bins, nyquist) {
  const n = bins.length;

  /* Reference level: the median of the strong mid band. Judging the edge
     against the frame's own level, rather than an absolute byte value, keeps a
     quiet passage from reading as a brick wall. */
  const mid = [];
  for (let i = Math.floor(n * 0.02); i < Math.floor(n * 0.25); i++) mid.push(bins[i]);
  if (!mid.length) return;
  mid.sort((a, b) => a - b);
  const ref = mid[mid.length >> 1];
  if (ref < 40) { cutoffStable = Math.max(0, cutoffStable - 3); return; }

  /* What a lossy encoder leaves behind is not a gentle roll-off but a floor:
     measured against a 96 kbps MP3, bins above the cutoff read 0 while the
     band below sits near the mid-band level. Full-bandwidth material stays
     within about 20 of the reference all the way to Nyquist. So the edge is
     the last bin still clearly above an absolute floor. */
  const FLOOR = 12;
  let edge = -1;
  for (let i = n - 1; i > n * 0.05; i--) {
    if (bins[i] > FLOOR) { edge = i; break; }
  }
  if (edge < 0) { cutoffStable = Math.max(0, cutoffStable - 3); return; }

  /* Content reaching the top of the usable band is full bandwidth. The very
     top bins are unreliable, so measure against 0.90 of Nyquist. */
  if (edge > n * 0.90) { cutoffStable = Math.max(0, cutoffStable - 3); return; }

  /* A codec cliff has real level right up to the edge; a dull mix fades. */
  const bLo = Math.max(1, Math.floor(edge * 0.82));
  let below = 0, bn = 0;
  for (let i = bLo; i <= edge; i++) { below += bins[i]; bn++; }
  below = bn ? below / bn : 0;
  if (below < ref - 45) { cutoffStable = Math.max(0, cutoffStable - 3); return; }

  cutoffStable = Math.min(120, cutoffStable + 1);
  cutoffHistory.push(edge * nyquist / n);
  if (cutoffHistory.length > 120) cutoffHistory.shift();

  /* Report only a stable, tightly-agreeing edge held for about a second. */
  if (cutoffStable < 40 || cutoffHistory.length < 30) return;
  const sorted = cutoffHistory.slice().sort((a, b) => a - b);
  const med = sorted[sorted.length >> 1];
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  if ((q3 - q1) > med * 0.10) return;          // a wandering edge is not a codec
  cutoffHz = med < nyquist * 0.90 ? med : 0;
}

/* ---- the frame loop ---------------------------------------------------- */

let freqBytes = null;

function frame() {
  const now = performance.now();
  const dt = Math.min((now - lastFrame) / 1000, 0.1);
  lastFrame = now;

  const bridgeW = el.vuL.parentElement.clientWidth - 14;
  const mL = engine.meters.L, mR = engine.meters.R;

  /* --- drive the movements --- */
  let driveL, driveR;
  if (engine.playing) {
    driveL = rmsToVu(mL.rms);
    driveR = rmsToVu(mR.rms);
  } else if (analysis && analysis._staticVu) {
    driveL = analysis._staticVu[0];
    driveR = analysis._staticVu[1];
  } else {
    driveL = driveR = __S.VU_MIN;
  }

  const nL = vuL.step(driveL, dt);
  const nR = vuR.step(driveR, dt);

  /* --- peak lamp: latches on an over, decays after 1.2 s --- */
  const over = (isFinite(mL.tp) && mL.tp > __S.TP_CEILING) ||
               (isFinite(mR.tp) && mR.tp > __S.TP_CEILING);
  if (over && engine.playing) peakLatch = now;
  const lampLit = now - peakLatch < 1200;
  el.lamp.classList.toggle('lit', lampLit);

  __S.drawVu(el.vuL, 'Left', nL, lampLit, bridgeW);
  __S.drawVu(el.vuR, 'Right', nR, lampLit, bridgeW);

  /* --- digital bars --- */
  updateHold(mL, now, dt);
  updateHold(mR, now, dt);
  const barsW = el.bars.parentElement.clientWidth;
  __S.drawBars(el.bars, [
    { name: 'L', db: isFinite(mL.tp) ? mL.tp : __S.BAR_MIN_DB, hold: mL.hold },
    { name: 'R', db: isFinite(mR.tp) ? mR.tp : __S.BAR_MIN_DB, hold: mR.hold },
  ], barsW);

  __S.drawCorrelation(el.corr, engine.correlation, el.corr.parentElement.clientWidth);

  /* --- spectrum + spectrogram --- */
  const specW = el.spectrum.parentElement.clientWidth;
  if (engine.analyser && engine.playing) {
    if (!freqBytes || freqBytes.length !== engine.analyser.frequencyBinCount) {
      freqBytes = new Uint8Array(engine.analyser.frequencyBinCount);
    }
    engine.analyser.getByteFrequencyData(freqBytes);
    staticSpectrumNyquist = 0;
    const nyq = engine.sampleRate / 2;
    detectCutoff(freqBytes, nyq);
    __S.drawSpectrum(el.spectrum, freqBytes, nyq, cutoffHz, specW);
    if (!spectro.staticMode) spectro.push(freqBytes, nyq);
  } else {
    const nyq = staticSpectrumNyquist || engine.sampleRate / 2;
    __S.drawSpectrum(el.spectrum, freqBytes, nyq, cutoffHz, specW);
  }
  const ph = spectro.staticMode && engine.duration()
    ? engine.currentTime() / engine.duration() : -1;
  spectro.render(specW, cutoffHz, ph);

  /* --- readouts --- */
  updateReadouts();

  /* --- transport --- */
  if (engine.buffer) {
    const t = engine.currentTime();
    el.tCur.textContent = __S.fmtTime(t);
    if (document.activeElement !== el.scrub) {
      el.scrub.value = String((t / engine.duration()) * 1000);
    }
  }

  requestAnimationFrame(frame);
}

/* ---- readouts and verdicts --------------------------------------------- */

let verdictTick = 0;

function updateReadouts() {
  const lm = engine.loudness;
  const a = analysis;

  const mom = lm && isFinite(lm.momentary) ? lm.momentary : (a ? a.momentary_lufs : NaN);
  const sht = lm && isFinite(lm.shortTerm) ? lm.shortTerm : (a ? a.shortterm_lufs : NaN);
  let itg = lm && isFinite(lm.integrated) ? lm.integrated : NaN;
  if (!isFinite(itg) && a && isFinite(a.integrated_lufs)) itg = a.integrated_lufs;

  el.lufsM.textContent = isFinite(mom) ? __S.fmtLu(mom, 1) : '−∞';
  el.lufsS.textContent = isFinite(sht) ? __S.fmtLu(sht, 1) : '−∞';
  el.lufsI.textContent = isFinite(itg) ? __S.fmtLu(itg, 1) : '−∞';

  /* --- the transport's own readout strip -------------------------------
     Live figures while playing, the analysed ones when parked, an em-dash
     when neither exists. Nothing here falls back to a plausible constant. */
  if (el.roLufsM) el.roLufsM.textContent = isFinite(mom) ? __S.fmtLu(mom, 1) : NO_VALUE;
  if (el.roLufsS) el.roLufsS.textContent = isFinite(sht) ? __S.fmtLu(sht, 1) : NO_VALUE;

  const tpNow = isFinite(engine.maxTruePeak) ? engine.maxTruePeak
    : (a && isFinite(a.true_peak_dbtp) ? a.true_peak_dbtp : NaN);
  if (el.roTp) el.roTp.textContent = isFinite(tpNow) ? __S.fmtDb(tpNow, 1) : NO_VALUE;

  const corrNow = engine.playing ? engine.correlation
    : (a && isFinite(a.correlation) ? a.correlation
      : (engine.buffer ? engine.correlation : NaN));
  if (el.roCorr) {
    el.roCorr.textContent = isFinite(corrNow)
      ? (corrNow >= 0 ? '+' : '−') + Math.abs(corrNow).toFixed(2) : NO_VALUE;
  }

  /* Position: the clock and the musical grid say the same thing two ways. */
  const dur = engine.duration() || (a && isFinite(a.duration) ? a.duration : 0);
  const pos = engine.buffer ? engine.currentTime() : 0;
  if (el.roPos) {
    el.roPos.textContent = dur > 0
      ? `${__S.fmtTime(pos)} / ${__S.fmtTime(dur)}` : NO_VALUE;
  }
  if (el.roBar) {
    /* currentTempo is parsed once when the analysis lands, not per frame: a
       beat_times array can hold thousands of entries. */
    el.roBar.textContent = barBeatAt(pos, currentTempo) || NO_VALUE;
  }

  if (isFinite(itg)) {
    const d = itg - __S.TARGET_LUFS;
    const ad = Math.abs(d);
    el.lufsDelta.textContent =
      `${d >= 0 ? '+' : '−'}${ad.toFixed(1)} LU vs −14 target`;
    el.lufsDelta.className = 'delta ' + (ad <= 0.5 ? 'ok' : ad <= 1.5 ? 'warn' : 'bad');
  } else {
    el.lufsDelta.textContent = 'target −14.0 LUFS';
    el.lufsDelta.className = 'delta';
  }

  if (a && isFinite(a.lra)) el.lra.textContent = a.lra.toFixed(1);
  else if (!a) el.lra.textContent = '—';

  /* Verdicts are text: recompute a few times a second, not every frame. */
  if (++verdictTick % 20 !== 0) return;

  const tp = isFinite(engine.maxTruePeak) ? engine.maxTruePeak
    : (a && isFinite(a.true_peak_dbtp) ? a.true_peak_dbtp : NaN);
  const overs = engine.overCount || (a && a.clip_runs) || 0;
  let cut = cutoffHz || (a && a.cutoff_hz) || 0;
  // Ignore a "cutoff" that sits at Nyquist: that is full bandwidth.
  const nyqRef = (a && a.sample_rate ? a.sample_rate : engine.sampleRate) / 2;
  if (cut && cut >= nyqRef * 0.94) cut = 0;
  const corr = engine.playing ? engine.correlation
    : (a && isFinite(a.correlation) ? a.correlation : NaN);

  renderVerdicts([
    ['Loudness', __S.verdictLoudness(itg)],
    ['Clipping', __S.verdictClipping(overs, tp)],
    ['Codec cutoff', __S.verdictCutoff(cut, sourceKind)],
    ['Stereo phase', __S.verdictPhase(corr)],
  ]);

  /* A "cutoff" at Nyquist is not a brick wall, it is simply full bandwidth. */
  const nyqNow = (a && a.sample_rate ? a.sample_rate : engine.sampleRate) / 2;
  const isWall = !!cut && cut < nyqNow * 0.94 && cut < 19000;
  /* With nothing loaded there is no bandwidth to report: claiming "full
     bandwidth to 24.0 kHz" off an empty page states a measurement that was
     never made, and would survive a Reset as if it had been. */
  const measured = !!a || !!engine.buffer;
  el.cutoffNote.textContent = !measured
    ? 'no signal'
    : isWall
      ? `brick wall at ${(cut / 1000).toFixed(1)} kHz — lossy source`
      : `full bandwidth to ${(Math.min(cut || nyqNow, nyqNow) / 1000).toFixed(1)} kHz`;
  el.cutoffNote.classList.toggle('cutoff-flag', isWall);
}

function renderVerdicts(items) {
  const html = items.map(([name, v]) => `
    <div class="verdict" data-state="${v.state}">
      <div class="verdict-head">
        <span class="k">${name}</span>
        <span class="pill">${v.pill}</span>
      </div>
      <p class="verdict-body">${v.body}</p>
    </div>`).join('');
  if (el.verdicts.dataset.sig !== html) {
    el.verdicts.dataset.sig = html;
    el.verdicts.innerHTML = html;
  }
}

/* ---- loading ----------------------------------------------------------- */

async function loadAudioFile(file) {
  el.source.innerHTML = `reading <b>${escapeHtml(file.name)}</b>…`;
  try {
    const buf = await file.arrayBuffer();
    await engine.decode(buf);
    sourceKind = /\.wav$/i.test(file.name) ? 'wav' : 'lossy';
    /* Loading audio supersedes any previously loaded analysis: leaving it in
       place would let the old file's cutoff, peaks and correlation leak into
       the new file's verdicts. A JSON dropped afterwards re-applies. */
    analysis = null;
    cutoffHistory.length = 0;
    cutoffHz = 0;
    cutoffStable = 0;
    staticSpectrumNyquist = 0;
    freqBytes = null;
    spectro.staticMode = false;
    spectro.clear();
    el.source.innerHTML = `<b>${escapeHtml(file.name)}</b>`;
    el.tDur.textContent = __S.fmtTime(engine.duration());
    el.rate.textContent = (engine.buffer.sampleRate / 1000).toFixed(1) + ' kHz';
    el.chans.textContent = engine.buffer.numberOfChannels > 1 ? 'stereo' : 'mono';
    el.mode.textContent = engine.buffer.numberOfChannels > 1 ? 'Stereo' : 'Mono';
    setTransportEnabled(true);
    engine.play();
    setPlayState(true);
    /* Loading audio supersedes the previous analysis, so the tempo and key
       cells must not keep showing the old track's reading. */
    window.StudioAnalysis = null;
    renderMusicalReadouts();
    maybeAutoAnalyse(file.name);
  } catch (err) {
    el.source.innerHTML =
      `<b>${escapeHtml(file.name)}</b> \u00b7 could not be decoded`;
    console.error(err);
  }
}

async function loadAnalysisFile(file) {
  try {
    const text = await file.text();
    const a = JSON.parse(text);
    applyAnalysis(a, file.name);
  } catch (err) {
    el.source.innerHTML = `<b>${escapeHtml(file.name)}</b> is not valid analysis JSON.`;
    console.error(err);
  }
}

/**
 * Adapt the precomputed analysis. Every field is optional: whatever is
 * present is shown, whatever is missing falls back to the live meters.
 */
/**
 * Normalise either shape of analysis into one flat record:
 *   - `audio-analysis/v1` from analyze.py, whose fields are grouped into
 *     metadata / measures / loudness / envelopes / spectrogram / spectrum /
 *     codec / clipping / stereo blocks
 *   - a flat object with the same values at the top level
 * Everything is optional; whatever is missing falls back to the live meters.
 */
function normaliseAnalysis(a) {
  const meta = a.metadata || {};
  const loud = a.loudness || {};
  const meas = a.measures || {};
  const codec = a.codec || {};
  const clip = a.clipping || {};
  const st = a.stereo || {};
  const spec = a.spectrum || {};
  const pick = (...vals) => vals.find((v) => v !== undefined && v !== null);

  const n = {
    duration: pick(meta.duration, a.duration),
    sample_rate: pick(meta.sample_rate, a.sample_rate),
    channels: pick(meta.channels, a.channels),
    filename: pick(meta.filename, a.filename),

    // analyze.py puts the ffmpeg loudness figures in `measures`; the
    // `loudness` block holds the momentary/short-term series and their maxima.
    integrated_lufs: pick(meas.integrated_lufs, loud.integrated_lufs,
                          a.integrated_lufs),
    true_peak_dbtp: pick(meas.true_peak_dbtp, loud.true_peak_dbtp,
                         a.true_peak_dbtp),
    lra: pick(meas.lra, loud.lra, a.lra),
    momentary_lufs: pick(loud.max_momentary, a.momentary_lufs),
    shortterm_lufs: pick(loud.max_short_term, a.shortterm_lufs),

    sample_peak_db: pick(meas.peak, a.peak_db),
    rms_db: pick(meas.rms, a.rms_db),

    cutoff_hz: pick(codec.cutoff_hz, a.cutoff_hz),
    lossy_suspected: pick(codec.lossy_suspected, a.lossy_suspected),
    codec_verdict: codec.verdict,

    clipped_samples: pick(clip.clipped_samples, a.clipped_samples),
    clip_runs: pick(clip.runs, a.clip_runs,
      Array.isArray(a.clipping_events) ? a.clipping_events.length : undefined),

    correlation: pick(st.correlation, a.stereo_correlation, a.correlation),
    balance_db: st.balance_db,
  };

  /* Short-term LUFS series: analyze.py gives {times, lufs}. */
  const stSeries = loud.short_term || a.short_term;
  if (stSeries && Array.isArray(stSeries.lufs)) {
    n.shortterm_series = stSeries.lufs;
    if (!isFinite(n.shortterm_lufs)) {
      const fin = stSeries.lufs.filter((v) => isFinite(v));
      if (fin.length) n.shortterm_lufs = Math.max(...fin);
    }
  }

  const momSeries = loud.momentary || a.momentary;
  if (momSeries && Array.isArray(momSeries.lufs)) {
    n.momentary_series = momSeries.lufs;
  }

  /* Per-channel envelopes: analyze.py nests them under envelopes.channels[]. */
  const env = a.envelopes;
  if (env && Array.isArray(env.channels) && env.channels.length) {
    n.rms_db_channels = env.channels.map((c) => c.rms_db || null).filter(Boolean);
    n.peak_db_channels = env.channels.map((c) => c.peak_db || null).filter(Boolean);
    n.channel_peaks_dbfs = env.channels.map((c) => {
      const arr = c.peak_db || [];
      let m = -Infinity;
      for (const v of arr) if (isFinite(v) && v > m) m = v;
      return m;
    });
  } else if (a.rms_envelope || a.peak_envelope) {
    const e = a.rms_envelope || a.peak_envelope;
    n.rms_db_channels = Array.isArray(e[0]) ? e : [e];
  }
  if (!n.channel_peaks_dbfs && Array.isArray(a.channel_peaks_dbfs)) {
    n.channel_peaks_dbfs = a.channel_peaks_dbfs;
  }

  /* Average spectrum: analyze.py gives spectrum.db with spectrum.freqs. */
  n.average_spectrum = pick(spec.db, a.average_spectrum);
  n.spectrum_freqs = pick(spec.freqs, a.spectrum_freqs);
  n.bands = pick(spec.bands, a.bands);

  /* Spectrogram: analyze.py stores db + shape + layout + freqs. */
  const sg = a.spectrogram;
  if (sg && Array.isArray(sg.db) && Array.isArray(sg.shape)) {
    n.spectrogram = sg.db;
    n.spectrogram_shape = sg.shape;
    n.spectrogram_layout = sg.layout && /freq-major/.test(sg.layout)
      ? 'freq-major' : 'time-major';
    n.spectrogram_freqs = sg.freqs;
  } else if (Array.isArray(a.spectrogram) && Array.isArray(a.spectrogram_shape)) {
    n.spectrogram = a.spectrogram;
    n.spectrogram_shape = a.spectrogram_shape;
    n.spectrogram_layout = a.spectrogram_layout || 'time-major';
    n.spectrogram_freqs = a.spectrogram_freqs;
  }

  return n;
}

function applyAnalysis(raw, name) {
  const a = normaliseAnalysis(raw);
  analysis = a;

  /* Publish the analysis whole, before anything is derived from it, so a
     reader that wants a block this file ignores gets what the worker wrote. */
  window.StudioAnalysis = raw && typeof raw === 'object' ? raw : null;
  renderMusicalReadouts();

  // Targets travel with the analysis, so master.py stays the single source.
  __S.applyTargets(raw && raw.targets);

  if (isFinite(a.sample_rate)) {
    el.rate.textContent = (a.sample_rate / 1000).toFixed(1) + ' kHz';
    if (!engine.buffer) engine.sampleRate = a.sample_rate;
  }
  if (a.channels) {
    el.chans.textContent = a.channels > 1 ? 'stereo' : 'mono';
    el.mode.textContent = a.channels > 1 ? 'Stereo' : 'Mono';
  }
  if (isFinite(a.duration) && !engine.buffer) el.tDur.textContent = __S.fmtTime(a.duration);
  if (isFinite(a.cutoff_hz) && a.cutoff_hz > 0) cutoffHz = a.cutoff_hz;

  /* Park the needles at the track's representative level so the dials read as
     a measurement of the analysed file rather than sitting dead at rest. */
  const chans = a.rms_db_channels;
  if (chans && chans.length) {
    const meanDb = (arr) => {
      let sum = 0, n = 0;
      for (const v of arr) if (isFinite(v) && v > -60) { sum += v; n++; }
      return n ? sum / n : -60;
    };
    const l = rmsToVu(meanDb(chans[0]));
    const r = rmsToVu(meanDb(chans[1] || chans[0]));
    a._staticVu = [l, r];
  } else if (isFinite(a.integrated_lufs)) {
    const v = rmsToVu(a.integrated_lufs);
    a._staticVu = [v, v];
  }

  /* Peak-hold ticks from the analysed peaks. */
  if (Array.isArray(a.channel_peaks_dbfs) && a.channel_peaks_dbfs.length) {
    const pk = a.channel_peaks_dbfs;
    engine.meters.L.hold = pk[0];
    engine.meters.R.hold = pk[1] !== undefined ? pk[1] : pk[0];
    engine.meters.L.tp = engine.meters.L.hold;
    engine.meters.R.tp = engine.meters.R.hold;
  } else if (isFinite(a.sample_peak_db)) {
    engine.meters.L.hold = engine.meters.R.hold = a.sample_peak_db;
    engine.meters.L.tp = engine.meters.R.tp = a.sample_peak_db;
  }
  if (isFinite(a.true_peak_dbtp)) engine.maxTruePeak = a.true_peak_dbtp;
  if (isFinite(a.correlation)) engine.correlation = a.correlation;
  if (isFinite(a.clip_runs)) engine.overCount = a.clip_runs;

  /* The colour map, drawn whole. */
  if (a.spectrogram && a.spectrogram_shape) {
    const bins = a.spectrogram_layout === 'freq-major'
      ? a.spectrogram_shape[0] : a.spectrogram_shape[1];
    const hzPerBin = a.sample_rate ? (a.sample_rate / 2) / bins : null;
    spectro.drawStatic(a.spectrogram, a.spectrogram_shape, hzPerBin,
      a.spectrogram_layout, a.spectrogram_freqs);
  }

  /* The average spectrum replaces the live curve when nothing is playing. */
  if (Array.isArray(a.average_spectrum) && a.average_spectrum.length) {
    const arr = a.average_spectrum;
    let lo = Infinity, hi = -Infinity;
    for (const v of arr) {
      if (!isFinite(v)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (!(hi > lo)) { lo = 0; hi = 1; }
    if (hi - lo > 90) lo = hi - 90;
    freqBytes = new Uint8Array(arr.length);
    for (let i = 0; i < arr.length; i++) {
      const v = isFinite(arr[i]) ? arr[i] : lo;
      freqBytes[i] = __S.clamp(Math.round((v - lo) / (hi - lo) * 255), 0, 255);
    }
    /* The spectrum drawing maps bin -> Hz linearly, so when analyze.py hands
       us its own frequency table, tell the drawing the top of that table. */
    if (Array.isArray(a.spectrum_freqs) && a.spectrum_freqs.length === arr.length) {
      staticSpectrumNyquist = a.spectrum_freqs[a.spectrum_freqs.length - 1];
    } else if (a.sample_rate) {
      staticSpectrumNyquist = a.sample_rate / 2;
    }
  }

  const label = a.filename || name;
  el.source.innerHTML = engine.buffer
    ? `<b>${escapeHtml(el.source.textContent.split('\u00b7')[0].trim())}</b>` +
      ' <span style="color:#6f9f72">+ analysis</span>'
    : `<b>${escapeHtml(label)}</b> \u00b7 analysis only, no audio`;

  verdictTick = 19;   // force a verdict refresh on the next frame
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* ======================================================== tempo and key ====
 * A worker adds two optional blocks to the analysis JSON:
 *
 *   "tempo": {bpm, confidence, meter, beat_times[]}
 *   "key":   {name, confidence, alternatives[]}
 *
 * Both may be absent, either field inside them may be null, and a confidence
 * figure is a real number that is often low. Everything below reads them
 * defensively: an absent block is an em-dash, and a reading the estimator was
 * not sure of is shown dimmed and marked rather than stated as fact. There is
 * no branch anywhere that invents a number when one is missing.
 * ========================================================================= */

/** Below this, the estimator is guessing and the panel must say so. */
const CONFIDENCE_FLOOR = 0.5;

/** The dash a readout shows when there is nothing to show. Never a zero. */
const NO_VALUE = '—';

/**
 * Pull the tempo block out of either analysis shape.
 * @returns {{bpm:number|null, confidence:number, meter:string|null,
 *            beats:number[], sure:boolean}|null}
 */
function readTempo(raw) {
  const t = raw && typeof raw === 'object' ? raw.tempo : null;
  if (!t || typeof t !== 'object') return null;
  const bpm = Number(t.bpm);
  const conf = Number(t.confidence);
  const beats = Array.isArray(t.beat_times)
    ? t.beat_times.filter((v) => Number.isFinite(Number(v))).map(Number)
    : [];
  /* A block with no usable bpm and no beats carries nothing; treat it as
     absent rather than rendering an empty shell of a reading. */
  if (!Number.isFinite(bpm) && !beats.length) return null;
  return {
    bpm: Number.isFinite(bpm) && bpm > 0 ? bpm : null,
    confidence: Number.isFinite(conf) ? conf : 0,
    meter: typeof t.meter === 'string' && t.meter ? t.meter : null,
    beats,
    sure: Number.isFinite(conf) ? conf >= CONFIDENCE_FLOOR : false,
  };
}

/**
 * Pull the key block out of either analysis shape.
 * @returns {{name:string, confidence:number, alternatives:string[],
 *            sure:boolean}|null}
 */
function readKey(raw) {
  const k = raw && typeof raw === 'object' ? raw.key : null;
  if (!k || typeof k !== 'object') return null;
  const name = typeof k.name === 'string' ? k.name.trim() : '';
  if (!name) return null;
  const conf = Number(k.confidence);
  return {
    name,
    confidence: Number.isFinite(conf) ? conf : 0,
    alternatives: Array.isArray(k.alternatives)
      ? k.alternatives.filter((v) => typeof v === 'string' && v) : [],
    sure: Number.isFinite(conf) ? conf >= CONFIDENCE_FLOOR : false,
  };
}

/**
 * Beats per bar, from the metre string. Only the numerator matters for
 * counting bars, and anything unparseable means we cannot count them at all —
 * which is reported as such, not defaulted to four.
 * @returns {number|null}
 */
function beatsPerBar(meter) {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*$/.exec(String(meter || ''));
  if (!m) return null;
  const n = Number(m[1]);
  return n >= 1 && n <= 32 ? n : null;
}

/**
 * Bar and beat at a position in seconds.
 *
 * Prefers the measured beat grid when the worker supplied one — a real track
 * drifts, and counting from a single average BPM walks away from the music
 * over a few minutes. Falls back to a constant tempo when only a bpm is known.
 * Returns null when the metre or the tempo is missing, so the caller can print
 * a dash instead of a bar number that means nothing.
 *
 * @param {number} seconds
 * @returns {string|null}  e.g. "9:3"
 */
function barBeatAt(seconds, tempo) {
  if (!tempo || !Number.isFinite(seconds) || seconds < 0) return null;
  const per = beatsPerBar(tempo.meter);
  if (!per) return null;

  let beatIndex = null;

  if (tempo.beats.length >= 2) {
    const beats = tempo.beats;
    const last = beats[beats.length - 1];
    if (seconds < beats[0]) {
      /* Before the first beat we are in the pick-up: bar 1 beat 1, not a
         negative bar. */
      beatIndex = 0;
    } else if (seconds > last) {
      /* Past the end of the supplied grid. A worker may send only the beats it
         was confident about, and the transport still has to count — so carry on
         at the average spacing of the grid rather than sticking on its last
         line, which would freeze the bar counter part-way through the track. */
      const spacing = (last - beats[0]) / (beats.length - 1);
      beatIndex = spacing > 0
        ? beats.length - 1 + Math.floor((seconds - last) / spacing)
        : beats.length - 1;
    } else {
      /* How many grid lines have gone by. */
      let lo = 0, hi = beats.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (beats[mid] <= seconds) lo = mid; else hi = mid - 1;
      }
      beatIndex = lo;
    }
  } else if (tempo.bpm) {
    beatIndex = Math.floor(seconds * tempo.bpm / 60);
  }

  if (beatIndex === null) return null;
  const bar = Math.floor(beatIndex / per) + 1;
  const beat = (beatIndex % per) + 1;
  return `${bar}:${beat}`;
}

/* The last analysis object, whole and unmodified, for anything else on the
   page that wants to read a block this file does not itself use. It is the
   raw JSON rather than the normalised record on purpose: a reader after
   `tempo` or `key` wants what the worker wrote, not our flattening of it. */
window.StudioAnalysis = null;

/** The parsed tempo of the loaded analysis, or null. Parsed once, read often. */
let currentTempo = null;

/** Paint one readout cell, marking a low-confidence reading as doubted. */
function setReadout(cell, valueEl, text, sure) {
  if (!valueEl) return;
  valueEl.textContent = text;
  if (cell) cell.classList.toggle('is-unsure', text !== NO_VALUE && sure === false);
}

/** The tempo and key cells. Called when an analysis arrives, not per frame. */
function renderMusicalReadouts() {
  currentTempo = readTempo(window.StudioAnalysis);
  const tempo = currentTempo;
  const key = readKey(window.StudioAnalysis);

  if (tempo && tempo.bpm !== null) {
    setReadout(el.roBpm, el.roBpmV, tempo.bpm.toFixed(1), tempo.sure);
    if (el.roMeter) el.roMeter.textContent = tempo.meter || '';
    if (el.roBpm) {
      el.roBpm.title = `${tempo.bpm.toFixed(1)} BPM` +
        (tempo.meter ? `, ${tempo.meter}` : '') +
        ` · confidence ${tempo.confidence.toFixed(2)}` +
        (tempo.sure ? '' : ' — low, treat as a guess');
    }
  } else {
    setReadout(el.roBpm, el.roBpmV, NO_VALUE, true);
    if (el.roMeter) el.roMeter.textContent = '';
    if (el.roBpm) el.roBpm.title = 'No tempo in this analysis';
  }

  if (key) {
    setReadout(el.roKey, el.roKeyV, key.name, key.sure);
    if (el.roKey) {
      el.roKey.title = `${key.name} · confidence ${key.confidence.toFixed(2)}` +
        (key.alternatives.length ? ` · or ${key.alternatives.join(', ')}` : '') +
        (key.sure ? '' : ' — low, treat as a guess');
    }
  } else {
    setReadout(el.roKey, el.roKeyV, NO_VALUE, true);
    if (el.roKey) el.roKey.title = 'No key in this analysis';
  }
}

/* ---- transport controls ------------------------------------------------ */

/* One key does both jobs, so it has to SAY which job it is offering. A button
   that plays and pauses but always shows a play triangle is the classic
   ambiguity — the glyph must show the action the next click performs. */
function setPlayState(playing) {
  el.play.classList.toggle('is-latched', !!playing);
  el.play.setAttribute('aria-pressed', playing ? 'true' : 'false');
  const glyph = el.play.querySelector('.key-glyph');
  if (glyph) glyph.textContent = playing ? '\u23F8' : '\u25B6';
  const label = playing ? 'Pause' : 'Play';
  el.play.title = label;
  el.play.setAttribute('aria-label', label);
}

/** Enable or disable the whole key gang together. */
function setTransportEnabled(on) {
  for (const k of [el.play, el.rtz]) {
    if (k) k.disabled = !on;
  }
  el.scrub.disabled = !on;
}

el.play.addEventListener('click', () => {
  if (!engine.buffer) return;
  /* The only play/pause control there is; the space bar routes here too. */
  if (engine.playing) { engine.pause(); setPlayState(false); }
  else { engine.play(); setPlayState(true); }
});



/* Back to start keeps whatever the transport was doing: rewind under play
   keeps playing from the top, rewind while stopped stays parked at zero —
   which together with the play/pause toggle is everything the old Stop key
   did, in one fewer control. */
if (el.rtz) el.rtz.addEventListener('click', () => {
  if (!engine.buffer) return;
  engine.seek(0);
  syncTransportDisplay(0);
});

/** Put a known position on the scrub and the timecode without waiting a frame. */
function syncTransportDisplay(t) {
  const dur = engine.duration();
  el.tCur.textContent = __S.fmtTime(t);
  el.scrub.value = dur > 0 ? String((t / dur) * 1000) : '0';
}

engine.onended = () => setPlayState(false);

el.scrub.addEventListener('input', () => {
  if (!engine.buffer) return;
  const t = (Number(el.scrub.value) / 1000) * engine.duration();
  el.tCur.textContent = __S.fmtTime(t);
});

el.scrub.addEventListener('change', () => {
  if (!engine.buffer) return;
  engine.seek((Number(el.scrub.value) / 1000) * engine.duration());
});

document.addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.target.type !== 'range') return;
  if (e.code === 'Space') { e.preventDefault(); el.play.click(); }
  else if (e.code === 'ArrowLeft' && engine.buffer) {
    engine.seek(engine.currentTime() - 5);
  } else if (e.code === 'ArrowRight' && engine.buffer) {
    engine.seek(engine.currentTime() + 5);
  }
});

/* ---- file inputs and drag-and-drop ------------------------------------- */

const AUDIO_RE = /\.(wav|mp3|m4a|aac|flac|ogg|opus|aiff?)$/i;

function routeFile(file) {
  if (/\.json$/i.test(file.name)) loadAnalysisFile(file);
  else if (AUDIO_RE.test(file.name) || file.type.startsWith('audio/')) loadAudioFile(file);
  else el.source.innerHTML =
    `<b>${escapeHtml(file.name)}</b> is not audio or analysis JSON.`;
}

$('#pick-audio').addEventListener('click', () => el.audioInput.click());
$('#pick-json').addEventListener('click', () => el.jsonInput.click());

el.audioInput.addEventListener('change', (e) => {
  if (e.target.files[0]) routeFile(e.target.files[0]);
});
el.jsonInput.addEventListener('change', (e) => {
  if (e.target.files[0]) routeFile(e.target.files[0]);
});

/* Only a drag carrying FILES is a load. The bench also lets panels be dragged
 * around, and although that is a pointer-event drag rather than a native one —
 * so it fires none of these — a text selection dragged across the page does
 * fire them, and used to raise the full-screen "RELEASE TO LOAD" overlay for a
 * drag that could never load anything. `dataTransfer.types` is the reliable
 * test during a drag, because `.files` is deliberately empty until the drop. */
function dragHasFiles(e) {
  const t = e.dataTransfer && e.dataTransfer.types;
  if (!t) return false;
  return Array.prototype.indexOf.call(t, 'Files') >= 0;
}

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  if (++dragDepth === 1) document.body.classList.add('dropping');
});
window.addEventListener('dragover', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
});
window.addEventListener('dragleave', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('dropping'); }
});
window.addEventListener('drop', (e) => {
  if (!dragHasFiles(e)) return;
  e.preventDefault();
  dragDepth = 0;
  document.body.classList.remove('dropping');
  const files = Array.from(e.dataTransfer.files || []);
  // Load the JSON last so its readouts win over a freshly decoded file.
  files.filter((f) => !/\.json$/i.test(f.name)).forEach(routeFile);
  files.filter((f) => /\.json$/i.test(f.name)).forEach(routeFile);
});

/* ---- boot --------------------------------------------------------------
   The page opens showing a worked example: a short synthesised passage at
   the delivery target so every instrument reads a real value on load,
   plainly marked as a demo tone rather than passed off as the user's file. */

function demoAnalysis() {
  const FRAMES = 240, BINS = 128;
  const sr = 48000, nyq = sr / 2, cut = 16000;
  /* freq-major, matching analyze.py: db[f * frames + t] */
  const db = new Float32Array(BINS * FRAMES);
  const freqs = [];
  for (let b = 0; b < BINS; b++) freqs.push((b + 0.5) * nyq / BINS);

  for (let t = 0; t < FRAMES; t++) {
    const phase = t / FRAMES;
    const drive = 0.55 + 0.45 * Math.sin(phase * Math.PI * 2 - Math.PI / 2);
    for (let b = 0; b < BINS; b++) {
      const f = freqs[b];
      let v = -14 - 11 * Math.log10(Math.max(f, 30) / 90);      // spectral tilt
      v += 7 * Math.exp(-Math.pow((Math.log10(f) - Math.log10(220)) / 0.16, 2));
      v += 5 * Math.exp(-Math.pow((Math.log10(f) - Math.log10(2600)) / 0.2, 2));
      v += (Math.sin(t * 0.7 + b * 0.35) + Math.sin(t * 0.21 + b * 1.7)) * 2.1;
      v += 14 * Math.log10(drive);
      if (f > cut) v -= 42 + (f - cut) / 900;                   // the brick wall
      db[b * FRAMES + t] = v;
    }
  }

  const avg = [];
  for (let b = 0; b < BINS; b++) {
    let s2 = 0;
    for (let t = 0; t < FRAMES; t++) s2 += db[b * FRAMES + t];
    avg.push(s2 / FRAMES);
  }

  const rmsL = [], rmsR = [], pkL = [], pkR = [];
  for (let t = 0; t < FRAMES; t++) {
    const phase = t / FRAMES;
    const d = 0.55 + 0.45 * Math.sin(phase * Math.PI * 2 - Math.PI / 2);
    const base = 20 * Math.log10(d);
    rmsL.push(-19.5 + base + Math.sin(t * 0.9) * 0.8);
    rmsR.push(-19.3 + base + Math.cos(t * 0.8) * 0.8);
    pkL.push(-6.4 + base + Math.sin(t * 1.7) * 1.4);
    pkR.push(-6.2 + base + Math.cos(t * 1.5) * 1.4);
  }

  return {
    schema: 'audio-analysis/v1',
    metadata: {
      filename: 'example-analysis.json',
      duration: 206.4, sample_rate: sr, channels: 2,
      bit_depth: 24, subtype: 'PCM_24',
    },
    measures: { rms: -19.4, peak: -0.9, crest_factor: 18.5, sample_peak: 0.9016 },
    loudness: {
      integrated_lufs: -13.2, true_peak_dbtp: -0.6, lra: 8.4,
      max_momentary: -12.1, max_short_term: -12.8,
      gate_threshold_lufs: -23.2, source: 'ffmpeg loudnorm',
    },
    envelopes: {
      points_per_second: 10,
      channels: [
        { rms_db: rmsL, peak_db: pkL },
        { rms_db: rmsR, peak_db: pkR },
      ],
    },
    spectrogram: {
      shape: [BINS, FRAMES],
      layout: 'freq-major: db[f * frames + t]',
      freqs, db: Array.from(db),
    },
    spectrum: { freqs, db: avg },
    codec: {
      cutoff_hz: cut, confidence: 0.82, drop_db: 42,
      nyquist_hz: nyq, lossy_suspected: true,
      verdict: 'lossy source suspected',
    },
    clipping: {
      clipped_samples: 0, clipped_fraction: 0, runs: 0,
      longest_run: 0, clipping_suspected: false, worst: [],
    },
    stereo: {
      stereo: true, correlation: 0.61, mid_rms_db: -19.1,
      side_rms_db: -27.4, side_to_mid_db: -8.3, balance_db: 0.2,
    },
  };
}

/* =============================================================== splitter ==
 * The seam between the question rail and the instrument column. Dragging it
 * moves one custom property on .shell, which is the whole layout contract —
 * no element is measured or resized by hand, so the grid reflows itself and
 * every canvas picks the new width up on its next frame.
 *
 * The chosen width is remembered. localStorage throws outright in a private
 * window, so every access is guarded.
 * ========================================================================= */

const RAIL_KEY = 'music-studio.rail-width';
const RAIL_MIN = 300;
const RAIL_MAX = 680;
const RAIL_DEFAULT = 420;

function readRailWidth() {
  try {
    const v = Number(localStorage.getItem(RAIL_KEY));
    return Number.isFinite(v) && v > 0 ? __S.clamp(v, RAIL_MIN, RAIL_MAX) : RAIL_DEFAULT;
  } catch { return RAIL_DEFAULT; }
}

function writeRailWidth(px) {
  try { localStorage.setItem(RAIL_KEY, String(Math.round(px))); }
  catch { /* nothing to do: the bench still works, it just forgets */ }
}

function setRailWidth(px, persist) {
  const w = __S.clamp(Math.round(px), RAIL_MIN, RAIL_MAX);
  if (el.shell) el.shell.style.setProperty('--rail-w', w + 'px');
  if (el.splitter) el.splitter.setAttribute('aria-valuenow', String(w));
  if (persist) writeRailWidth(w);
  return w;
}

/* The masthead is a FIXED bar pinned to the top of the window, so it is out of
 * flow and reserves no space. Two things therefore have to be handed to CSS:
 *
 *   --masthead-h  the bar's height plus the gap that belongs under it. .shell
 *                 takes this as padding-top, which is what stops the first
 *                 panel and the rail from sliding under the bar.
 *   --rail-top    where the content's top edge sits in the VIEWPORT once the
 *                 page is scrolled — which, for a fixed bar, is simply the
 *                 same number. It is the sticky offset for the question rail
 *                 and the splitter, and the term their height is taken from.
 *
 * Both are measured rather than written as CSS constants because the bar's
 * type is clamp()ed and it wraps at narrow widths.
 *
 * NOTE the ordering trap this replaces: the old version derived the offset
 * from `shell.getBoundingClientRect().top`, which now INCLUDES the padding
 * this same function sets, so each measurement fed the next and the rail
 * walked down the page on every resize. The bar's own height is the only
 * independent term, so it is the only one read. */
function trackMastheadHeight() {
  const head = document.querySelector('.masthead');
  if (!head || !el.shell) return;
  const measure = () => {
    /* Where the shell's left edge actually is. The bar is fixed and so spans
       the whole window, while the shell is centred inside a max-width, so the
       bar has to be told where the bench's first column starts or its own
       columns line up with nothing. Measured rather than derived from 100vw,
       which counts a scrollbar the shell's box does not.

       Set on the ROOT, not the shell: the bar reads it as its own padding, and
       although the bar is a child of .shell today, a value that positions the
       bar must not depend on that staying true. */
    const left = Math.max(0, Math.round(el.shell.getBoundingClientRect().left));
    document.documentElement.style.setProperty('--shell-left', left + 'px');

    /* the grid gap below the bar counts too: the content starts after it */
    const gap = parseFloat(getComputedStyle(el.shell).rowGap) || 0;
    const h = Math.round(head.getBoundingClientRect().height + gap);
    el.shell.style.setProperty('--masthead-h', h + 'px');
    /* A fixed bar occupies the top `h` pixels of the viewport at every scroll
       position, so the first row of content clears it at exactly `h`. No page
       gutter is added: body's top padding sits UNDER the bar and is already
       spent. */
    el.shell.style.setProperty('--rail-top', h + 'px');
  };
  measure();
  window.addEventListener('resize', measure);
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(measure).observe(head);
  } else {
    window.addEventListener('resize', measure);
  }
}

function wireSplitter() {
  const bar = el.splitter;
  if (!bar || !el.shell) return;

  setRailWidth(readRailWidth(), false);
  bar.setAttribute('aria-valuemin', String(RAIL_MIN));
  bar.setAttribute('aria-valuemax', String(RAIL_MAX));

  /* Pointer events cover mouse, pen and touch in one path, and capture keeps
     the drag alive when the cursor outruns the 9px seam. */
  let dragging = false;

  const widthFromPointer = (clientX) => {
    const left = el.shell.getBoundingClientRect().left;
    return clientX - left;
  };

  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    dragging = true;
    bar.classList.add('is-dragging');
    document.body.classList.add('is-splitting');
    try { bar.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    e.preventDefault();
  });

  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    setRailWidth(widthFromPointer(e.clientX), false);
  });

  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    bar.classList.remove('is-dragging');
    document.body.classList.remove('is-splitting');
    try { bar.releasePointerCapture(e.pointerId); } catch { /* never captured */ }
    /* Persist once, on release, rather than on every move. */
    writeRailWidth(Number(bar.getAttribute('aria-valuenow')) || RAIL_DEFAULT);
  };

  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);

  /* Double-click returns the seam to where it shipped. */
  bar.addEventListener('dblclick', () => setRailWidth(RAIL_DEFAULT, true));

  /* Keyboard: the arrows nudge, shift coarsens, Home/End go to the stops. */
  bar.addEventListener('keydown', (e) => {
    const cur = Number(bar.getAttribute('aria-valuenow')) || RAIL_DEFAULT;
    const step = e.shiftKey ? 40 : 10;
    let next = null;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') next = cur - step;
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') next = cur + step;
    else if (e.key === 'Home') next = RAIL_MIN;
    else if (e.key === 'End') next = RAIL_MAX;
    else if (e.key === 'Enter' || e.key === ' ') next = RAIL_DEFAULT;
    if (next === null) return;
    e.preventDefault();
    setRailWidth(next, true);
  });
}

/* ======================================================== timed findings ==
 * The analysis log: one row per finding, in time order, each folding open to
 * the longer comment. `renderTimeline(items)` is the only way rows get here;
 * items are {time_s, severity, title, detail}.
 * ========================================================================= */

const SEVERITY_MARK = { ok: '✓', warn: '!', bad: '✗' };

/**
 * Move the transport to a position in the track.
 * Does nothing — quietly, not noisily — when no audio is loaded: a finding can
 * outlive the file it was measured from, and a dead click is better than a
 * thrown exception on a page whose whole job is to keep running.
 * @param {number} seconds
 */
function seekTo(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return false;
  if (!engine.buffer) return false;
  const dur = engine.duration();
  if (!(dur > 0)) return false;
  const t = __S.clamp(seconds, 0, dur);
  engine.seek(t);
  el.tCur.textContent = __S.fmtTime(t);
  el.scrub.value = String((t / dur) * 1000);
  return true;
}
window.seekTo = seekTo;

/** The findings currently on screen, so a reset can tell whether to redraw. */
let timelineItems = [];

/**
 * Draw the timed findings.
 * @param {Array<{time_s:number, severity:string, title:string, detail:string}>} items
 */
function renderTimeline(items) {
  const box = el.timeline;
  if (!box) return;

  const list = Array.isArray(items) ? items.slice() : [];
  list.sort((a, b) => (Number(a && a.time_s) || 0) - (Number(b && b.time_s) || 0));
  timelineItems = list;

  if (!list.length) {
    box.innerHTML =
      '<p class="timeline-empty">No analysis yet — click <b>Analyze</b>.</p>';
    return;
  }

  const seekable = !!engine.buffer && engine.duration() > 0;

  box.innerHTML = list.map((it, i) => {
    const sev = ['ok', 'warn', 'bad'].includes(it.severity) ? it.severity : 'warn';
    const t = Number(it.time_s);
    const stamp = Number.isFinite(t) ? __S.fmtTime(t) : '—:—';
    const detail = it.detail ? String(it.detail) : '';
    const canSeek = seekable && Number.isFinite(t);
    /* The timecode is its own button, a sibling of the fold control rather than
       a child of it: a focusable control nested inside a button is neither
       valid nor reachable by keyboard in the way it looks like it should be. */
    return `
    <div class="finding" data-severity="${sev}" data-index="${i}">
      <div class="finding-row">
        <button type="button" class="finding-time"
                data-seek="${Number.isFinite(t) ? t : ''}"
                data-seekable="${canSeek ? 'yes' : 'no'}"
                title="${canSeek ? 'Move the transport to ' + stamp
                                 : 'Load the audio to jump here'}"
                aria-label="${canSeek ? 'Play from ' + stamp : stamp + ', no audio loaded'}"
                >${stamp}</button>
        <button type="button" class="finding-open" aria-expanded="false"
                aria-controls="finding-detail-${i}">
          <span class="finding-mark" aria-hidden="true">${SEVERITY_MARK[sev]}</span>
          <span class="finding-title">${escapeHtml(it.title || 'Finding')}</span>
          <span class="finding-caret" aria-hidden="true"></span>
        </button>
      </div>
      <p class="finding-detail" id="finding-detail-${i}" hidden>${escapeHtml(detail)}</p>
    </div>`;
  }).join('');
}

/* One delegated listener for the whole list, so re-rendering never leaks
   handlers and a row added later is wired by construction. */
function wireTimeline() {
  const box = el.timeline;
  if (!box) return;

  const jump = (stamp) => {
    const raw = stamp.getAttribute('data-seek');
    if (raw === '' || raw === null) return;
    /* seekTo reports whether it could act; say so rather than pretending. */
    if (!seekTo(Number(raw))) {
      stamp.setAttribute('data-seekable', 'no');
      stamp.title = 'Load the audio to jump here';
    }
  };

  box.addEventListener('click', (e) => {
    const stamp = e.target.closest('.finding-time');
    if (stamp) { jump(stamp); return; }

    const row = e.target.closest('.finding-open');
    if (!row) return;
    const card = row.closest('.finding');
    const detail = card && card.querySelector('.finding-detail');
    if (!detail) return;
    const open = card.classList.toggle('is-open');
    detail.hidden = !open;
    row.setAttribute('aria-expanded', String(open));
  });
}

/* ==================================================================== reset ==
 * Return the bench to rest. Not "stop": every needle goes back to the far left
 * of its arc, every readout to its idle dash, the lamp out, the log empty and
 * the file unloaded — the state the page boots into before anything is
 * measured, rather than the last frame frozen on screen.
 * ========================================================================= */

/* Put every panel back where it ships: one per row, in markup order, nothing
 * collapsed, the rail at its default width. The stored layout is cleared too,
 * so a reload does not quietly restore what was just reset.
 *
 * Saved WORKSPACES are deliberately left alone. They are named work, not
 * accumulated state, and losing them to a button meant for clearing a
 * measurement would be a nasty surprise. */
function resetLayout() {
  try { localStorage.removeItem(LAYOUT_KEY); } catch { /* private window */ }
  try { localStorage.removeItem(COLLAPSE_KEY); } catch { /* ditto */ }
  try { localStorage.removeItem(RAIL_KEY); } catch { /* ditto */ }

  /* One card per row, in the order the markup declares — the arrangement a
     first visit gets. */
  layoutRows = layoutCards().map((section, i) => [layoutId(section, i)]);
  applyLayout(true);

  /* Expand everything: a panel folded away is as much "not default" as one
     moved. */
  document.querySelectorAll('.instruments .unit.is-collapsed').forEach((s) => {
    const btn = s.querySelector('.collapse-btn');
    if (btn) btn.click();
  });

  if (typeof setRailWidth === 'function') setRailWidth(RAIL_DEFAULT);
}

function resetAll() {
  /* --- silence and unload the engine --------------------------------- */
  if (engine.playing) engine.pause();
  engine._teardown();
  engine.buffer = null;
  engine.offset = 0;
  engine.analyser = null;
  engine.loudness = null;
  engine.resetMeters();
  engine.correlation = 0;
  setPlayState(false);

  /* --- the needles: drive them back to rest AND zero the movement -----
     resetMeters() alone only removes the drive; the movement would then swing
     down over its 300 ms. Zeroing x and v as well puts the needle at the peg
     immediately, which is what "rest position" means on a real meter. */
  analysis = null;
  for (const m of [vuL, vuR]) { m.x = __S.VU_MIN; m.v = 0; m._acc = 0; }
  peakLatch = 0;
  el.lamp.classList.remove('lit');

  /* --- spectrum and colour map --------------------------------------- */
  freqBytes = null;
  cutoffHz = 0;
  cutoffStable = 0;
  cutoffHistory.length = 0;
  staticSpectrumNyquist = 0;
  sourceKind = 'none';
  spectro.staticMode = false;
  spectro.clear();

  /* --- readouts back to their idle strings ---------------------------- */
  el.lufsM.textContent = '−∞';
  el.lufsS.textContent = '−∞';
  el.lufsI.textContent = '−∞';
  el.lufsDelta.textContent = `target ${__S.fmtLu(__S.TARGET_LUFS, 1)} LUFS`;
  el.lufsDelta.className = 'delta';
  el.lra.textContent = '—';
  el.cutoffNote.textContent = 'no signal';
  el.cutoffNote.classList.remove('cutoff-flag');

  /* --- transport ------------------------------------------------------ */
  el.tCur.textContent = '0:00';
  el.tDur.textContent = '0:00';
  el.scrub.value = '0';
  setTransportEnabled(false);
  /* The musical readouts belong to the file that was unloaded. */
  window.StudioAnalysis = null;
  renderMusicalReadouts();
  el.source.innerHTML = 'no file loaded';

  /* --- findings and verdicts ------------------------------------------ */
  renderTimeline([]);
  /* Clearing the signature forces the next verdict pass to repaint rather than
     deciding the identical idle HTML means there is nothing to do. */
  el.verdicts.dataset.sig = '';
  verdictTick = 19;

  /* --- the bench itself, back to how it ships ------------------------- *
     Reset means the whole instrument, not only what it was measuring. A
     rearranged bench with every readout blanked is a half-reset: the state
     you can SEE is gone while the state you arranged silently persists, and
     the next load inherits a layout you may have been experimenting with. */
  resetLayout();

  /* Draw one frame at rest immediately. The loop would get there on its own,
     but only after the needles had visibly fallen from wherever they froze. */
  drawRestFrame();
}

/** Paint the instruments once, at rest, without waiting for the loop. */
function drawRestFrame() {
  const bridgeW = el.vuL.parentElement.clientWidth - 14;
  __S.drawVu(el.vuL, 'Left', __S.VU_MIN, false, bridgeW);
  __S.drawVu(el.vuR, 'Right', __S.VU_MIN, false, bridgeW);
  __S.drawBars(el.bars, [
    { name: 'L', db: __S.BAR_MIN_DB, hold: -Infinity },
    { name: 'R', db: __S.BAR_MIN_DB, hold: -Infinity },
  ], el.bars.parentElement.clientWidth);
  __S.drawCorrelation(el.corr, 0, el.corr.parentElement.clientWidth);
  const specW = el.spectrum.parentElement.clientWidth;
  __S.drawSpectrum(el.spectrum, null, engine.sampleRate / 2, 0, specW);
  spectro.render(specW, 0, -1);
}

function wireReset() {
  if (el.reset) el.reset.addEventListener('click', resetAll);
}

/* The Analyze button in the Analysis title row. When a server is listening it
 * runs the same one-click pipeline as the transport's button; opened from
 * file:// there is nothing to run, so it says so in the list rather than
 * failing silently. */
function wireAnalyzeRun() {
  const btn = el.analyzeRun;
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (server.live && server.commands.studio) { analyseNow(); return; }
    renderTimeline([{
      time_s: 0,
      severity: 'warn',
      title: 'No analyser reachable from this page',
      detail: 'A page opened straight off the disk cannot run anything. ' +
              'Serve the studio with serve.py, or run analyze.py in the ' +
              'terminal and drop its JSON onto this page.',
    }]);
  });
}

/* =============================================================== collapse ==
 * Every instrument card folds away. The control is added in script rather than
 * markup so a new card gets one for free, but every card now carries its own
 * engraved title in the markup: a folded drawer that does not say what is
 * inside it is a drawer you have to open to identify, which defeats folding.
 *
 * Collapsed state is per card and remembered, so a bench arranged for one job
 * is still arranged that way next time. localStorage can throw outright in a
 * private window, so every access is guarded.
 * ========================================================================= */

const COLLAPSE_KEY = 'music-studio.collapsed';

function readCollapsed() {
  try {
    return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '[]'));
  } catch { return new Set(); }
}

function writeCollapsed(set) {
  try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set])); }
  catch { /* nothing to do: the bench still works, it just forgets */ }
}

/* The key a panel's collapsed state is stored under.
 *
 * Deliberately NOT the visible title: two panels can legitimately carry the
 * same name (there is a built-in "Spectrum" card and a tray meter also called
 * Spectrum), and keying on text would make folding one fold the other. A
 * renamed panel would also silently lose its saved state. `data-card-id` is
 * stable across both; the title is only a fallback for older markup. */
function cardName(section, i) {
  const id = section.dataset.cardId;
  if (id) return id;
  const h = section.querySelector('.unit-title h2');
  return h ? h.textContent.trim() : (section.getAttribute('aria-label') || `card-${i}`);
}

function wireCollapse() {
  const saved = readCollapsed();
  const cards = document.querySelectorAll('.instruments .unit');

  cards.forEach((section, i) => {
    /* A panel can opt out. The Transport does: it is the control surface for
       everything below it, and a control surface you can fold away is one you
       have to go looking for at the moment you need it most. The body wrapper
       is skipped too — with no control to hide it there is nothing to wrap. */
    if (section.hasAttribute('data-no-collapse')) return;

    const id = cardName(section, i);

    /* Wrap everything under the title (or everything, when there is no title)
       so one element can be hidden without disturbing the header row. */
    const title = section.querySelector('.unit-title');
    const body = document.createElement('div');
    body.className = 'unit-body';
    const move = [...section.children].filter(c => c !== title);
    move.forEach(c => body.appendChild(c));
    section.appendChild(body);

    let head = title;
    if (!head) {
      /* A card with no title in the markup is a mistake rather than a style:
         give it a visible engraved name from its own aria-label so the folded
         drawer is still identifiable, instead of a blank bar. */
      head = document.createElement('div');
      head.className = 'unit-title';
      head.innerHTML = `<h2>${escapeHtml(id)}</h2>`;
      section.insertBefore(head, body);
    }

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'collapse-btn';
    btn.setAttribute('aria-controls', `card-body-${i}`);
    body.id = `card-body-${i}`;

    const apply = (collapsed) => {
      section.classList.toggle('is-collapsed', collapsed);
      body.hidden = collapsed;
      btn.setAttribute('aria-expanded', String(!collapsed));
      btn.title = (collapsed ? 'Expand ' : 'Collapse ') + id;
      btn.setAttribute('aria-label', btn.title);
    };

    apply(saved.has(id));

    btn.addEventListener('click', () => {
      const next = !section.classList.contains('is-collapsed');
      apply(next);
      const now = readCollapsed();
      if (next) now.add(id); else now.delete(id);
      writeCollapsed(now);
      /* No canvas fix-up needed on expand: every draw call re-fits its own
         canvas from the current box, and the render loop never stops. */
    });

    head.appendChild(btn);
  });
}

/* ===================================================================== ask ==
 * The conversational layer. A file:// page cannot hold an API key and cannot
 * reach a model, so this composes the exact `music advise` command and shows
 * an answer when the CLI has already produced one (music scope --open embeds
 * it as window.PRELOADED_ADVICE). The measurements stay the shared ground:
 * whatever the model says, it said it about the numbers on this page.
 * ========================================================================= */

function askTrackHint() {
  const p = (analysis && analysis.path) || window.PRELOADED_NAME || '';
  const m = String(p).match(/tracks\/([^/]+)/);
  return m ? m[1] : '<track>';
}

function composeAskCommand(question) {
  const track = askTrackHint();
  const q = (question || '').trim();
  return q
    ? `music advise ${track} --ask ${JSON.stringify(q)}`
    : `music advise ${track}`;
}

/* Served by serve.py, or opened straight off the disk? Everything that runs a
 * command is gated on this. Opened from file:// the panel still composes
 * commands to paste, exactly as before. */
const server = { live: false, readOnly: true, root: null, commands: {} };

async function detectServer() {
  if (!location.protocol.startsWith('http')) return;
  try {
    const r = await fetch('/api/health', { cache: 'no-store' });
    if (!r.ok) return;
    const h = await r.json();
    server.live = true;
    server.readOnly = !!h.read_only;
    server.root = h.root;
    server.commands = h.commands || {};
  } catch { /* no server: the compose-only path stays correct */ }
  const note = document.getElementById('ask-note');
  if (note && server.live) {
    note.textContent = server.readOnly
      ? 'connected · read-only'
      : 'connected · writes ask first';
  }
}

async function api(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error || `request failed (${r.status})`);
  return data;
}

/* Parse a `music ...` line out of the model's answer into something the API
 * can take. Only the commands the server actually exposes are offered; a line
 * mentioning anything else stays text you can read but not run. */
function parseMusicCommand(line) {
  const parts = line.trim().match(/(?:[^\s"]+|"[^"]*")+/g) || [];
  if (parts[0] !== 'music' && parts[0] !== 'music.py') return null;
  const name = parts[1];
  if (!server.commands[name]) return null;

  const options = {};
  const allowed = server.commands[name].options || {};
  for (let i = 2; i < parts.length; i++) {
    const tok = parts[i].replace(/^"|"$/g, '');

    /* Anything that is not a flag is a positional. The API takes named options
       only, so a positional means this line does not describe a call we can
       make — and it is usually a placeholder like <track> that points at no
       real file. Offering to run it would be offering to master nothing. */
    if (!tok.startsWith('--')) return null;

    if (!(tok in allowed)) return null;              // an unknown flag: do not offer
    if (allowed[tok] === 'flag') { options[tok] = true; continue; }
    const val = (parts[i + 1] || '').replace(/^"|"$/g, '');
    if (!val || val.startsWith('--')) return null;
    if (/[<>]/.test(val)) return null;               // a placeholder, not a path
    options[tok] = val;
    i++;
  }
  /* A command with no options at all would run on defaults we never showed. */
  return Object.keys(options).length ? { command: name, options } : null;
}

/* ---- the transcript ----------------------------------------------------
 * A conversation, not a command composer. Every turn is appended; nothing is
 * ever rebuilt from scratch, so the history stands and the scroll position
 * means something. The turns are also kept as data for the session, so a
 * later question reads in the context of the ones before it.
 * ------------------------------------------------------------------------ */

/** The session's turns: {role:'user'|'assistant'|'system', text:string}. */
const chatLog = [];

/** True once the "not connected" notice has been said, so it is said once. */
let saidOffline = false;

function askOut() { return document.getElementById('ask-out'); }

/** Scroll the transcript to the newest turn. */
function scrollChat() {
  const out = askOut();
  if (out) out.scrollTop = out.scrollHeight;
}

/**
 * Append one turn.
 * @param {'user'|'assistant'|'system'} role
 * @param {string} html        already-safe markup for the bubble
 * @param {string} [variant]   an extra modifier class, e.g. 'error'
 * @returns {HTMLElement} the turn element, so a placeholder can be replaced
 */
function appendTurn(role, html, variant) {
  const out = askOut();
  if (!out) return null;
  const turn = document.createElement('div');
  turn.className = `turn turn--${role}` + (variant ? ` turn--${variant}` : '');
  const who = role === 'user' ? 'You' : role === 'assistant' ? 'Studio' : '';
  turn.innerHTML =
    (who ? `<span class="turn-who">${who}</span>` : '') +
    `<div class="turn-body">${html}</div>`;
  out.appendChild(turn);
  scrollChat();
  return turn;
}

/** A turn from the operator. Plain text, escaped. */
function chatUser(text) {
  chatLog.push({ role: 'user', text });
  appendTurn('user', `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`);
}

/** A turn from the model. Markdown-formatted, and any runnable command wired. */
function chatAssistant(text, variant, undoBands) {
  chatLog.push({ role: 'assistant', text });
  const turn = appendTurn('assistant', formatAdvice(text), variant);
  if (turn) wireRunnableCommands(turn);

  /* An EQ move applied without asking needs a way back, and it has to be right
     here in the turn that made it — not somewhere in the panel. */
  if (turn && undoBands) {
    const bar = document.createElement('div');
    bar.className = 'ask-actions';
    const undo = document.createElement('button');
    undo.type = 'button';
    undo.className = 'ask-run';
    undo.textContent = 'Undo';
    undo.addEventListener('click', () => {
      window.StudioEq = window.StudioEq || {};
      window.StudioEq.bands = undoBands;
      window.dispatchEvent(new CustomEvent('studio-eq-restore',
        { detail: { bands: undoBands } }));
      undo.disabled = true;
      undo.textContent = 'Undone';
    }, { once: true });
    bar.appendChild(undo);
    turn.appendChild(bar);
  }

  scrollChat();
  return turn;
}

/** The page speaking about itself: not connected, no file, and so on. */
function chatSystem(text, extraHtml) {
  chatLog.push({ role: 'system', text });
  appendTurn('system', `<p>${escapeHtml(text)}</p>` + (extraHtml || ''));
}

/** Three lamps, until the reply lands. Returns the element to replace. */
function chatThinking() {
  return appendTurn('assistant',
    '<span class="think-dot"></span><span class="think-dot"></span>' +
    '<span class="think-dot"></span>', 'thinking');
}

/**
 * Offer the CLI as a fallback — a command to copy and run elsewhere. This is
 * never the answer to a question; it is what to do when the page cannot ask
 * one on your behalf.
 */
function fallbackCommandHtml(question) {
  const cmd = composeAskCommand(question);
  return `<pre class="ask-cmd"><code>${escapeHtml(cmd)}</code></pre>` +
    '<div class="ask-actions">' +
    `<button type="button" class="ask-copy" data-copy="${escapeHtml(cmd)}">Copy command</button>` +
    '</div>';
}

/* One delegated handler for every Copy button the transcript ever grows. */
function wireCopyButtons() {
  const out = askOut();
  if (!out) return;
  out.addEventListener('click', (e) => {
    const btn = e.target.closest('.ask-copy[data-copy]');
    if (!btn) return;
    const text = btn.dataset.copy;
    const done = (msg) => {
      btn.textContent = msg;
      setTimeout(() => { btn.textContent = 'Copy command'; }, 1400);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => done('Copied'),
                                               () => done('Copy failed'));
    } else {
      done('Copy failed');
    }
  });
}

/* Any `music ...` line inside an answer gets a Run button, provided the server
 * exposes that command and every flag in it. Writes go through confirm first. */
function wireRunnableCommands(scope) {
  if (!server.live || !scope) return;
  scope.querySelectorAll('.ask-cmd').forEach(pre => {
    const parsed = parseMusicCommand(pre.textContent || '');
    if (!parsed) return;
    const writes = !!(server.commands[parsed.command] || {}).writes;
    if (writes && server.readOnly) return;

    const bar = document.createElement('div');
    bar.className = 'ask-actions';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ask-run' + (writes ? ' ask-run--writes' : '');
    btn.textContent = writes ? 'Run (writes audio)' : 'Run';
    btn.addEventListener('click', () => runCommand(parsed, btn));
    bar.appendChild(btn);
    pre.after(bar);
  });
}

/* The machine's own log of what actually ran: a running turn at the foot of
   the conversation, so a command's output sits in time order with the words
   around it rather than in a separate box that has to be found. A fresh turn
   is started whenever something else has spoken since the last line. */
function transcript() {
  const out = askOut();
  if (!out) return null;
  let t = out.lastElementChild && out.lastElementChild.querySelector
    ? out.lastElementChild.querySelector('.ask-log') : null;
  if (!t) {
    const turn = appendTurn('assistant', '<div class="ask-log"></div>', 'log');
    t = turn ? turn.querySelector('.ask-log') : null;
  }
  return t;
}

function logLine(text, kind = '') {
  const t = transcript();
  if (!t) return null;
  const p = document.createElement('pre');
  p.className = 'ask-log-line' + (kind ? ' is-' + kind : '');
  p.textContent = text;
  t.appendChild(p);
  scrollChat();
  return p;
}

async function runCommand(parsed, btn) {
  btn.disabled = true;
  const label = btn.textContent;
  try {
    const plan = await api('/api/prepare', parsed);

    if (plan.confirm) {
      /* A command that writes is shown exactly as it will run, and waits. */
      const ok = window.confirm(
        'This will write audio.\n\n' + plan.display +
        '\n\nRun it?'
      );
      if (!ok) { btn.disabled = false; btn.textContent = label; return; }
      parsed.confirm = plan.confirm;
    }

    btn.textContent = 'Running…';
    logLine('$ ' + plan.display, 'cmd');
    const res = await api('/api/run', parsed);
    if (res.stderr.trim()) logLine(res.stderr.trim());
    if (res.stdout.trim()) logLine(res.stdout.trim());
    logLine(res.returncode === 0
      ? `done in ${res.seconds}s`
      : `exit ${res.returncode} after ${res.seconds}s`,
      res.returncode === 0 ? 'ok' : 'bad');
  } catch (err) {
    logLine(String(err.message || err), 'bad');
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/**
 * Send one question and put the reply in the transcript.
 *
 * The question always goes to the model, with or without an analysis: a
 * general question about mastering does not need a file, and advise.py is
 * content with a missing --analysis. If the server refuses anyway, the refusal
 * is shown as what it is — an answer that did not come — inside the
 * conversation, never as a command box pretending to be a reply.
 *
 * @param {string} question
 */
/* ---- tone requests go to the equaliser, not the advisor ---------------- *
 *
 * "more highs" and "cut the hum" are instructions to the EQ, not questions
 * about the measurements. Routing everything to `advise` meant the chat
 * answered a request to DO something with an explanation of how to do it
 * yourself — which is what it was built to avoid.
 *
 * The test is deliberately conservative: a sentence must both name a tonal
 * move and read as an instruction. Anything ambiguous stays with the advisor,
 * because a wrong answer there costs a paragraph, while a wrong EQ move costs
 * a surprise change to what you are hearing. */
/* Stems, not exact words: 'boxy' and 'boxiness' are the same request, and
 listing every inflection by hand is how one of them gets missed. */
const TONE_WORDS = /\b(bass|low|lows|sub|bottom|bod(y|ies)|warm\w*|boom\w*|mud\w*|box\w*|honk\w*|mid|mids|midrange|presen\w*|high|highs|top|treble|bright\w*|brillian\w*|air|airy|sheen|harsh\w*|sibilan\w*|ess|hiss\w*|hum|buzz\w*|rumbl\w*|thin\w*|dull\w*|dark\w*|muffl\w*|sharp\w*|crisp\w*|shrill\w*|nasal|tinny|woolly|cloud\w*)\b/i;
const TONE_VERBS = /\b(add|more|less|boost|lift|raise|increase|cut|reduce|lower|drop|dip|remove|clean|clear|tame|soften|roll ?off|notch|attenuate|brighten|darken|warm up|open up|eq)\b/i;
const QUESTIONY = /^(what|why|how|is|are|does|do|should|can|could|would|when|which|who)\b|\?\s*$/i;

function isToneRequest(text) {
const s = String(text || '').trim();
if (!s || QUESTIONY.test(s)) return false;
if (!TONE_WORDS.test(s)) return false;

/* A verb is the clearest signal, but it is not required. "a bit mid-hi" is
   plainly an instruction to the equaliser and has no verb at all; demanding
   one sent it to the advisor, which can only describe commands — so the user
   asked for a change and got a lecture.
   
   A short phrase built around a tone word IS the request. Anything longer is
   probably a sentence about the track rather than an instruction to it, so
   it still needs a verb to qualify. */
if (TONE_VERBS.test(s)) return true;
const words = s.split(/\s+/).filter(Boolean);
return words.length <= 5;
}

/* Set when a turn applies EQ, cleared by any other kind of reply. Declared
 * before isEqFollowUp reads it: `let` has a temporal dead zone, so a call that
 * runs before the declaration throws rather than seeing undefined. */
let lastTurnMovedEq = false;

/* "more", "again", "a bit less" — a short follow-up with no tone word of its
 * own, which only means anything because of the turn before it. Treated as a
 * tone request ONLY when the last thing the studio did was move the EQ, so a
 * bare "more" after an explanation still goes to the advisor. */
const FOLLOW_UP = /^(more|less|again|a bit more|a bit less|bit more|bit less|harder|softer|stronger|weaker|too much|not enough|keep going|further)\b[\s.!]*$/i;

function isEqFollowUp(text) {
if (!lastTurnMovedEq) return false;
return FOLLOW_UP.test(String(text || '').trim());
}



/* Apply what eqchat.py returned, and say what changed in plain terms. The
 * bands are already validated server-side; this only has to place them. */
function applyChatEq(payload, question) {
const bands = (payload && payload.bands) || [];
if (!bands.length) {
  chatAssistant(payload && payload.summary
    ? payload.summary
    : 'No EQ change for that — try naming a frequency range.');
  return;
}

/* Remember the previous setting so the move can be taken back. Undo is what
   makes applying-without-asking reasonable: the EQ is an audition, and a
   wrong move should cost one click. */
const before = JSON.parse(JSON.stringify((window.StudioEq && window.StudioEq.bands) || []));
const next = payload.replace ? bands.slice() : mergeEqBands(before, bands);

window.StudioEq = window.StudioEq || {};
window.StudioEq.bands = next;
window.dispatchEvent(new CustomEvent('studio-eq-restore', { detail: { bands: next } }));

const lines = bands.map(b => {
  const hz = b.freq >= 1000 ? (b.freq / 1000).toFixed(1) + ' kHz' : Math.round(b.freq) + ' Hz';
  const g = b.type === 'peaking' || b.type === 'lowshelf' || b.type === 'highshelf'
    ? `  ${b.gain > 0 ? '+' : ''}${b.gain.toFixed(1)} dB` : '';
  return `• ${b.type} ${hz}${g}  Q ${b.q}`;
}).join('\n');

chatAssistant((payload.summary ? payload.summary + '\n\n' : '') + lines, 'eq', before);
}

/* Merge a returned band into what is already set.
 *
 * Matching on id alone does not work: the model returns bands with no id, so
 * "more" produced a SECOND 8 kHz shelf stacked on the first rather than
 * raising it. Two shelves is a different sound from one shelf turned up, and
 * nothing on screen said it had happened.
 *
 * So match on what makes two bands the same filter — the same type at
 * substantially the same frequency. A third of an octave is the tolerance:
 * wide enough to catch 8000 against 8200, tight enough that a deliberate pair
 * at 3 kHz and 5 kHz stays two bands. */
function sameBand(a, b) {
  if (a.type !== b.type) return false;
  const lo = Math.min(a.freq, b.freq), hi = Math.max(a.freq, b.freq);
  return lo > 0 && hi / lo < 1.26;
}

function mergeEqBands(current, incoming) {
  const out = current.slice();
  for (const b of incoming) {
    let i = b.id ? out.findIndex(x => x.id === b.id) : -1;
    if (i < 0) i = out.findIndex(x => sameBand(x, b));
    if (i >= 0) out[i] = Object.assign({}, out[i], b, { id: out[i].id });
    else out.push(Object.assign({ id: 'chat-' + Math.random().toString(36).slice(2, 7) }, b));
  }
  return out;
}


async function askServer(question) {
  const thinking = chatThinking();
  const drop = () => { if (thinking && thinking.parentNode) thinking.remove(); };

  /* A path if we have one, and no invention if we do not. */
  const path = (analysis && analysis.analysisPath) || window.PRELOADED_PATH || null;
  const options = { '--ask': question };
  if (path) options['--analysis'] = path;

  const tone = isToneRequest(question) || isEqFollowUp(question);
  if (tone) {
    /* Send what is already set, so the equaliser EDITS rather than starting
       from flat. Without this, "more" cannot mean "more of what you just did"
       — the model has no idea anything was done. */
    const now = (window.StudioEq && window.StudioEq.bands) || [];
    if (now.length) options['--bands-json'] = JSON.stringify(now);
  }

  try {
    const res = await api('/api/run',
      { command: tone ? 'eq' : 'advise', options });
    if (tone) {
      drop();
      let payload = null;
      try { payload = JSON.parse((res.stdout || '').trim().split('\n').pop()); }
      catch { /* fall through to the error path below */ }
      if (res.returncode === 0 && payload && !payload.error) {
        lastTurnMovedEq = (payload.bands || []).length > 0;
        applyChatEq(payload, question);
      } else {
        chatAssistant((payload && payload.error) ||
          (res.stderr || 'The equaliser returned nothing.').trim(), 'error');
      }
      return;
    }
    drop();
    const text = (res.stdout || '').trim();
    if (res.returncode === 0 && text) {
      lastTurnMovedEq = false;   // an explanation, not a move
      chatAssistant(text);
    } else {
      /* The command ran and had nothing to say, or said it on stderr. Either
         way it is the model's turn that failed, so it is reported in the
         model's place in the conversation. */
      const why = (res.stderr || res.stdout || '').trim();
      chatAssistant(
        why || 'The advisor returned nothing. Check the server log.', 'error');
      if (!path) {
        chatSystem('No analysis is loaded, so that question was answered ' +
          'without the measurements. Load one for an answer about this track.');
      }
    }
  } catch (err) {
    drop();
    chatAssistant(String((err && err.message) || err), 'error');
  } finally {
    drop();
    scrollChat();
  }
}

/**
 * Handle one message from the composer: the user's bubble goes up at once,
 * then either the server answers or the page explains why it cannot.
 */
function sendMessage(text) {
  const q = String(text || '').trim();
  if (!q) return;
  chatUser(q);

  if (server.live && server.commands.advise) {
    askServer(q);
    return;
  }

  /* Offline. Say so once, then hand over the command as a fallback — the
     conversation stays the shape it is, and the CLI is the way out of it
     rather than the substance of the reply. */
  if (!saidOffline) {
    saidOffline = true;
    chatSystem('Not connected — start `music serve` to chat here.');
  }
  appendTurn('assistant',
    '<p>I cannot reach a model from this page. Run this in the terminal ' +
    'to ask it:</p>' + fallbackCommandHtml(q), 'error');
  chatLog.push({ role: 'assistant', text: composeAskCommand(q) });
  scrollChat();
}

/* Minimal markdown: the model replies with **bold** and ``` blocks. */
function formatAdvice(text) {
  const parts = String(text).split(/```(?:\w+)?\n?/);
  return parts.map((chunk, i) => {
    if (i % 2 === 1) return `<pre class="ask-cmd"><code>${escapeHtml(chunk.trim())}</code></pre>`;
    return escapeHtml(chunk)
      .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .split(/\n{2,}/).filter(Boolean).map(p => `<p>${p.replace(/\n/g, ' ')}</p>`).join('');
  }).join('');
}

/* ============================================================== one click ==
 * Analyse, report, advise — in a single action.
 *
 * A browser never learns where a dropped file lives on disk, so the button
 * cannot work from the file input alone. When served, it asks for a path
 * relative to the server's root; the server resolves it, refuses anything
 * outside, and runs the whole pipeline in one call.
 * ========================================================================= */

function currentTrackPath() {
  /* Prefer a path we were told about; fall back to the loaded file's name,
     which is usually right when the root is the track's own folder. */
  if (window.PRELOADED_PATH) {
    return String(window.PRELOADED_PATH).replace(/analysis\.json$/, '') || null;
  }
  return (analysis && analysis.filename) || null;
}

/* ---- the auto latch ----------------------------------------------------
   Whether loading a file should analyse it without being asked. Remembered
   between sessions; localStorage throws outright in a private window, so both
   ends are guarded and the bench simply forgets rather than failing. */

const AUTO_KEY = 'music-studio.analyse-auto';

function readAutoAnalyse() {
  try { return localStorage.getItem(AUTO_KEY) === '1'; }
  catch { return false; }
}

function writeAutoAnalyse(on) {
  try { localStorage.setItem(AUTO_KEY, on ? '1' : '0'); }
  catch { /* nothing to do: the setting just does not survive the session */ }
}

/**
 * Run the offline analysis.
 * @param {string} [pathHint]  a path to use instead of asking for one
 * @param {boolean} [silent]   true when the run was triggered by a load rather
 *                             than a click: never put up a prompt in that case,
 *                             because an automatic action must not block on a
 *                             dialogue nobody asked for.
 */
async function analyseNow(pathHint, silent) {
  const btn = el.analyseNow;
  if (!btn) return;
  if (btn.dataset.running === '1') return;       // one run at a time

  if (!server.live || !server.commands.studio) {
    chatSystem('Not connected — start `music serve` to analyse from this page.');
    return;
  }

  let rel = pathHint || '';
  if (!rel) {
    if (silent) return;
    rel = window.prompt(
      'Path to the audio file, relative to the server root:',
      currentTrackPath() || '') || '';
  }
  if (!rel) return;

  const label = btn.dataset.label || btn.textContent;
  btn.dataset.label = label;
  btn.dataset.running = '1';
  btn.disabled = true;
  btn.classList.add('is-running');
  btn.textContent = 'Analysing…';
  btn.setAttribute('aria-busy', 'true');
  logLine('$ studio --in ' + rel, 'cmd');

  try {
    const res = await api('/api/run', {
      command: 'studio',
      options: { '--in': rel },
    });
    let payload = null;
    try { payload = JSON.parse((res.stdout || '').trim().split('\n').pop()); }
    catch { /* fall through to the raw output below */ }

    if (!payload || !payload.ok) {
      logLine((payload && payload.error) || res.stderr || 'analysis failed', 'bad');
      return;
    }

    logLine(payload.headline, payload.verdicts.some(v => v.severity === 'bad') ? 'bad' : 'ok');
    for (const v of payload.verdicts) {
      logLine(`${v.severity === 'bad' ? '✗' : v.severity === 'warn' ? '!' : '✓'} ${v.title}`,
              v.severity === 'ok' ? 'ok' : v.severity === 'bad' ? 'bad' : '');
    }
    /* The same findings, on the Analysis panel's timed list. A verdict without
       a time is still worth showing, so it lands at 0:00 rather than being
       dropped for want of a timestamp. */
    renderTimeline(payload.verdicts.map((v) => ({
      time_s: Number.isFinite(v.time_s) ? v.time_s
        : (Number.isFinite(v.time) ? v.time : 0),
      severity: v.severity,
      title: v.title,
      detail: v.detail || v.body || v.message || '',
    })));
    for (const [k, p] of Object.entries(payload.files)) logLine(`${k}: ${p}`);

    /* The advice that came with the run is a turn in the conversation, appended
       after the log it belongs to. Nothing is rebuilt, so nothing is lost. */
    if (payload.advice) {
      window.PRELOADED_ADVICE = payload.advice;
      chatAssistant(String(payload.advice));
    }
    /* Put the analysis we just produced onto the meters, so the page and the
       transcript never disagree about the same file. The server serves only
       its own directory, so the JSON is fetched through the command channel
       rather than by URL. */
    try {
      const rendered = await fetch('/api/analysis?path=' +
        encodeURIComponent(payload.files.analysis));
      if (rendered.ok) {
        applyAnalysis(await rendered.json(), rel.split('/').pop());
        logLine('meters updated', 'ok');
      }
    } catch { /* the reports are written either way */ }
  } catch (err) {
    logLine(String(err.message || err), 'bad');
  } finally {
    btn.dataset.running = '';
    btn.disabled = false;
    btn.classList.remove('is-running');
    btn.textContent = label;
    btn.removeAttribute('aria-busy');
  }
}

function wireAnalyseButton() {
  const btn = el.analyseNow;
  if (btn) {
    btn.dataset.label = btn.textContent;
    btn.addEventListener('click', () => analyseNow());
  }

  const auto = el.analyseAuto;
  if (auto) {
    auto.checked = readAutoAnalyse();
    auto.addEventListener('change', () => writeAutoAnalyse(auto.checked));
  }
}

/** Called after a file loads. Runs the analysis only if the latch is down. */
function maybeAutoAnalyse(name) {
  if (!el.analyseAuto || !el.analyseAuto.checked) return;
  if (!server.live || !server.commands.studio) return;
  /* A browser never learns where a dropped file lives, so the name is the best
     guess available and is only right when the server root is the track's own
     folder. When it is wrong the server refuses the path and says so — which
     is the correct outcome, and better than a dialogue on every load. */
  analyseNow(name, true);
}

function wireAsk() {
  const input = document.getElementById('ask-input');
  const go = document.getElementById('ask-go');
  const chips = document.getElementById('ask-chips');
  const presets = document.getElementById('ask-presets');
  if (!input || !go) return;

  wireCopyButtons();

  const send = () => {
    const q = input.value;
    if (!q.trim()) return;
    input.value = '';
    sendMessage(q);
  };

  go.addEventListener('click', send);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });

  /* A preset is a question, so it is sent as one — it does not fill the box
     and wait, and it certainly does not compose a command. */
  if (chips) {
    chips.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-q]');
      if (!b) return;
      const q = b.dataset.q || b.textContent.trim();
      if (presets) presets.open = false;
      sendMessage(q);
    });
  }

  /* The opening line: what this conversation is grounded in. */
  chatSystem('Ask about the measurements on this bench. The model reads the ' +
    'numbers, not the audio.');

  /* An answer the CLI already produced (music scope --open embeds it) opens
     the conversation rather than sitting in a box of its own. */
  if (window.PRELOADED_ADVICE) chatAssistant(String(window.PRELOADED_ADVICE));
}

/* ================================================================= layout ==
 * The bench as a set of rows. A row holds one, two or three panels; the panels
 * in a row share its width evenly. Dragging a panel by its title bar moves it;
 * dropping on the left or right edge of another panel joins that panel's row,
 * dropping above or below opens a new full-width row.
 *
 * THE DOM STAYS FLAT. Every panel is a direct child of `.instruments` and a
 * row is expressed only as a span on each panel — never as a wrapper element.
 * This is forced by meters.js, whose `applyArrangement()` does
 * `state.container.appendChild(section)` for each meter on every tray edit: a
 * panel nested in a row wrapper would be pulled straight back out to be a
 * direct child the first time somebody switched a meter on or off, silently
 * dismantling the layout. Flat, that same appendChild is only a reorder, and
 * the observer below re-derives the spans from the new document order.
 *
 * So the model is: an ORDER (the document order of the panels) plus a set of
 * ROW BREAKS. `rows` is the canonical form — an array of arrays of card ids —
 * and the DOM is written from it, never read as the source of truth except
 * when reconciling panels that appeared from elsewhere.
 * ========================================================================= */

const MAX_PER_ROW = 3;
const SPAN_FOR = { 1: 12, 2: 6, 3: 4 };

/* Panels that do not exist when this file boots but are expected to arrive:
 * meters.js mounts these five into `.instruments` on its own DOMContentLoaded
 * handler, which runs after ours. A saved layout naming them must survive the
 * window in which they are absent — see the note in reconcileRows(). Kept as a
 * plain list rather than read from window.StudioMeters, because at boot that
 * global does not exist yet either; METER_IDS below is the same set and is
 * asserted against the live registry once meters.js has mounted. */
const LAYOUT_EXPECTED = new Set([
  'loudness-time', 'goniometer', 'spectrum', 'dynamics', 'equalizer',
]);

/* The working layout, autosaved on every change. This is what survives a plain
 * reload; a named workspace is a separate, deliberate save. */
const LAYOUT_KEY = 'music-studio.layout';

/** Every panel on the bench, in document order. */
function layoutCards() {
  const host = document.querySelector('.instruments');
  if (!host) return [];
  return [...host.children].filter(
    (n) => n.classList && n.classList.contains('unit'));
}

/** The stable id a panel is tracked by — the same key collapse already uses,
 *  so a workspace and a folded state always agree about which card is which. */
function layoutId(section, i) {
  return cardName(section, i);
}

/** id -> element, for the panels currently on the bench. */
function cardMap() {
  const m = new Map();
  layoutCards().forEach((s, i) => m.set(layoutId(s, i), s));
  return m;
}

/* The canonical layout: an array of rows, each an array of card ids. Starts
 * empty and is filled by the first reconcile, which runs once the panels
 * (including the ones meters.js mounts) are in the document. */
let layoutRows = [];

function readLayout() {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null');
    return normaliseRows(raw && raw.rows);
  } catch { return []; }
}

function writeLayout() {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify({ rows: layoutRows }));
  } catch { /* a private window forgets the arrangement; it still works */ }
}

/** Coerce anything claiming to be a row list into a sane one: arrays of
 *  strings, no empties, no row longer than three, no id twice. */
function normaliseRows(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const row of raw) {
    if (!Array.isArray(row)) continue;
    const clean = [];
    for (const id of row) {
      if (typeof id !== 'string' || seen.has(id)) continue;
      seen.add(id);
      clean.push(id);
      if (clean.length === MAX_PER_ROW) break;
    }
    if (clean.length) out.push(clean);
  }
  return out;
}

/** Drop ids that are no longer on the bench and give every panel that is on it
 *  but missing from the layout a full-width row of its own, at the end. This is
 *  what makes the layout survive meters.js adding, hiding or reordering cards,
 *  and what makes a workspace saved before a new meter existed still load. */
function reconcileRows(rows, cards) {
  const present = new Set(cards.keys());
  const out = [];
  const placed = new Set();
  for (const row of rows) {
    /* An id is kept when its panel is on the bench OR when it is a panel that
       is expected to arrive later.
       ---------------------------------------------------------------------
       This second clause is load-bearing. studio.js boots before meters.js
       mounts, so at the first reconcile only the five built-in panels exist
       and the five meter panels do not. Dropping an absent id here meant a
       saved row like ["goniometer", "spectrum"] was pruned to nothing at boot,
       the meters were then re-added as separate full-width rows by the loop
       below, and writeLayout() persisted that — so any row grouping meter
       panels quietly destroyed itself on every reload. Holding a placeholder
       for a panel that has not mounted yet keeps the row intact until it
       does. An id that is neither present nor expected really is gone (a
       renamed or removed panel) and is still dropped. */
    const keep = row.filter((id) =>
      !placed.has(id) && (present.has(id) || LAYOUT_EXPECTED.has(id)));
    keep.forEach((id) => placed.add(id));
    if (keep.length) out.push(keep);
  }
  for (const id of cards.keys()) {
    if (!placed.has(id)) out.push([id]);
  }
  return out;
}

/* A write to the DOM from layoutRows sets off the MutationObserver that
 * watches for meters.js reordering. This flag tells the observer the change
 * was ours and needs no reconcile, which would otherwise be an endless loop. */
let layoutWriting = false;

/** Write `layoutRows` to the document: panels in row order, each carrying the
 *  span its row implies. */
function applyLayout(persist) {
  const host = document.querySelector('.instruments');
  if (!host) return;
  const cards = cardMap();
  layoutRows = reconcileRows(layoutRows, cards);

  layoutWriting = true;
  try {
    for (const row of layoutRows) {
      /* The span comes from how many panels in this row are actually on the
         bench, not how many the row names. A row can legitimately name a panel
         that has not mounted yet (a meter, before meters.js runs) or one that
         is switched off in the tray; counting those would hand the survivors a
         half or third width and leave a visible gap where the absent panel
         would have been. Counting only what is present means a two-panel row
         with one panel absent renders that panel full width, and it returns to
         a half as soon as its partner appears. */
      const live = row.filter((id) => {
        const s = cards.get(id);
        return s && !s.hidden;
      });
      const span = SPAN_FOR[live.length] || 12;
      for (const id of row) {
        const section = cards.get(id);
        if (!section) continue;
        section.dataset.span = String(span);
        /* appendChild on a child already here is a move, which keeps every
           canvas, context and listener alive — the same trick meters.js uses
           to reorder without rebuilding. */
        host.appendChild(section);
      }
    }
  } finally {
    /* Released after a microtask, so the observer's own callback — which is
       delivered asynchronously — still sees the flag set for our writes. */
    Promise.resolve().then(() => { layoutWriting = false; });
  }

  if (persist !== false) writeLayout();

}

/** Where a card sits now: [rowIndex, colIndex], or null. */
function findCard(id) {
  for (let r = 0; r < layoutRows.length; r++) {
    const c = layoutRows[r].indexOf(id);
    if (c >= 0) return [r, c];
  }
  return null;
}

/** Take a card out of the layout, dropping the row if it empties. */
function removeCard(id) {
  const at = findCard(id);
  if (!at) return;
  const [r, c] = at;
  layoutRows[r].splice(c, 1);
  if (!layoutRows[r].length) layoutRows.splice(r, 1);
}

/* ---- moving a card -------------------------------------------------------
 * Two shapes of move, matching the two shapes of drop:
 *   beside(target, side)  — join the target's row to its left or right
 *   above(target, side)   — open a new full-width row before or after it
 * Both are expressed against a TARGET CARD rather than an index, because the
 * index changes the moment the dragged card is lifted out. */

/** Join `id` into the row holding `targetId`, on the given side. */
function moveBeside(id, targetId, side) {
  if (id === targetId) return false;
  const before = findCard(targetId);
  if (!before) return false;
  /* A full row still accepts a card that is already in it — that is a reorder,
     not a fourth arrival. `from` can be null for a card the layout has not
     seen yet, which counts as coming from outside the row. */
  const from = findCard(id);
  if (layoutRows[before[0]].length >= MAX_PER_ROW &&
      (!from || from[0] !== before[0])) return false;

  removeCard(id);
  const at = findCard(targetId);     // re-read: the lift may have shifted it
  if (!at) return false;
  const [r, c] = at;
  layoutRows[r].splice(side === 'left' ? c : c + 1, 0, id);
  return true;
}

/** Put `id` in a new full-width row above or below the row holding
 *  `targetId`. */
function moveToNewRow(id, targetId, side) {
  const before = findCard(targetId);
  if (!before) return false;
  /* A card already alone in its row, asked to make a new row adjacent to
     itself, has nothing to do — and acting would be an off-by-one shuffle. */
  if (findCard(id) && findCard(id)[0] === before[0] &&
      layoutRows[before[0]].length === 1) return false;

  removeCard(id);
  const at = findCard(targetId);
  if (!at) return false;
  layoutRows.splice(side === 'above' ? at[0] : at[0] + 1, 0, [id]);
  return true;
}

/* ---- the drop-zone overlay ----------------------------------------------
 * The old interaction was a thin gold seam that appeared when the pointer
 * strayed into an invisible quarter-width band at the edge of a panel. It
 * worked, but only once you already knew it was there: there was nothing on
 * screen saying where a release would land, so aiming was guesswork and the
 * most common outcome of a drag was a panel somewhere you did not ask for.
 *
 * It is replaced by an explicit, visible map of the bench, raised the instant
 * a drag begins:
 *
 *   - the page dims, so the structure reads over the content;
 *   - every existing ROW is outlined, so the thing being edited is visible;
 *   - every legal landing is a real, sizeable TARGET carrying its own words —
 *     a full-width bar between each pair of rows saying "New row", and a
 *     left/right half on each panel saying "Join this row".
 *
 * A zone lights on hover and states what it will do. A row that already holds
 * three panels still shows its side zones, marked "Row is full" in the
 * faceplate's warning red and refusing the drop — a refusal you can see beats
 * a drop that silently does nothing.
 *
 * The zones are plain absolutely-positioned divs in one overlay element that
 * is a sibling of the panels rather than a child of any of them, so nothing
 * here is inside `.instruments` and meters.js's appendChild storm cannot tear
 * it out. Geometry is measured once per drag (and on scroll/resize), not per
 * pointer move: the layout cannot change mid-drag, since a drop is what
 * changes it.
 * ========================================================================= */

/** Does the viewport currently allow more than one column? Read from the same
 *  media query the stylesheet uses, so the two can never disagree: below this
 *  the grid overrides every span back to full width, so a side drop or a
 *  "place left" would describe a row that cannot be seen. */
function multiColumnAllowed() {
  return window.matchMedia('(min-width: 1101px)').matches;
}

let zoneLayer = null;     // the overlay element
let zoneList = [];        // [{ el, kind, id, side, full, label }]
let zoneActive = null;    // the zone under the pointer

function zoneOverlay() {
  if (zoneLayer && zoneLayer.isConnected) return zoneLayer;
  zoneLayer = document.createElement('div');
  zoneLayer.className = 'drop-zones';
  zoneLayer.setAttribute('aria-hidden', 'true');
  document.body.appendChild(zoneLayer);
  return zoneLayer;
}

/** A single target. `rect` is in viewport coordinates; the overlay is fixed,
 *  so no scroll offset is added. */
function makeZone(rect, kind, id, side, full, label) {
  const z = document.createElement('div');
  z.className = 'drop-zone drop-zone--' + kind + (full ? ' is-full' : '');
  z.style.left = rect.left + 'px';
  z.style.top = rect.top + 'px';
  z.style.width = Math.max(0, rect.width) + 'px';
  z.style.height = Math.max(0, rect.height) + 'px';
  const tag = document.createElement('span');
  tag.className = 'drop-zone-label';
  tag.textContent = full ? 'Row is full' : label;
  z.appendChild(tag);
  return { el: z, kind, id, side, full, label };
}

/** Outline an existing row, so the structure being edited is visible. */
function makeRowOutline(rect) {
  const o = document.createElement('div');
  o.className = 'drop-row-outline';
  o.style.left = rect.left + 'px';
  o.style.top = rect.top + 'px';
  o.style.width = Math.max(0, rect.width) + 'px';
  o.style.height = Math.max(0, rect.height) + 'px';
  return o;
}

/** The viewport rect covering a whole row: the union of its visible panels. */
function rowRect(row, cards) {
  let r = null;
  for (const id of row) {
    const s = cards.get(id);
    if (!s || s.hidden) continue;
    const b = s.getBoundingClientRect();
    if (!r) r = { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
    else {
      r.left = Math.min(r.left, b.left);
      r.top = Math.min(r.top, b.top);
      r.right = Math.max(r.right, b.right);
      r.bottom = Math.max(r.bottom, b.bottom);
    }
  }
  if (!r) return null;
  r.width = r.right - r.left;
  r.height = r.bottom - r.top;
  return r;
}

/** Build the whole map for a drag of `draggedId`. */
function buildZones(draggedId) {
  const layer = zoneOverlay();
  layer.innerHTML = '';
  zoneList = [];
  zoneActive = null;

  const cards = cardMap();
  const multi = multiColumnAllowed();
  const BAR = 34;          // height of a "new row" bar
  const from = findCard(draggedId);

  /* The rows that are actually on screen, with their geometry. A row whose
     every panel is hidden (all its meters switched off) has no rect and is
     skipped entirely. */
  const rows = [];
  for (let r = 0; r < layoutRows.length; r++) {
    const rect = rowRect(layoutRows[r], cards);
    if (rect) rows.push({ index: r, rect, ids: layoutRows[r] });
  }
  if (!rows.length) return;

  for (const row of rows) layer.appendChild(makeRowOutline(row.rect));

  /* --- "new row" bars, above the first row and below every row ----------
     Each is anchored to a TARGET PANEL and a side, because that is what
     moveToNewRow() takes: an index would be invalidated the moment the
     dragged panel is lifted out of the layout. */
  const addRowBar = (row, side) => {
    /* A panel alone in its row, asked to open a new row against itself, has
       nothing to do — the same no-op moveToNewRow() refuses. Do not offer it
       as a target at all rather than let it be clicked and do nothing. */
    if (from && from[0] === row.index && row.ids.length === 1) return;
    const anchor = row.ids.find((id) => {
      const s = cards.get(id);
      return s && !s.hidden;
    });
    if (!anchor) return;
    const y = side === 'above' ? row.rect.top - BAR - 3 : row.rect.bottom + 3;
    zoneList.push(makeZone(
      { left: row.rect.left, top: y, width: row.rect.width, height: BAR },
      'row', anchor, side, false, 'New row here'));
  };

  addRowBar(rows[0], 'above');
  for (const row of rows) addRowBar(row, 'below');

  /* --- side zones on each panel ----------------------------------------
     Half a panel each, so the target is as large as it can be without
     overlapping its neighbour. Below the multi-column breakpoint the bench is
     one column by decree and a side drop would build a row nobody can see, so
     only the row bars above are offered. */
  if (multi) {
    for (const row of rows) {
      const rowLen = row.ids.filter((id) => {
        const s = cards.get(id);
        return s && !s.hidden;
      }).length;
      const sameRow = from && from[0] === row.index;
      /* A full row can still be REORDERED from within — moving a panel already
         in it changes the order, not the count — so the refusal only applies
         to a panel arriving from another row. */
      const full = rowLen >= MAX_PER_ROW && !sameRow;

      for (const id of row.ids) {
        if (id === draggedId) continue;
        const s = cards.get(id);
        if (!s || s.hidden) continue;
        const b = s.getBoundingClientRect();
        const half = b.width / 2;
        zoneList.push(makeZone(
          { left: b.left, top: b.top, width: half, height: b.height },
          'side', id, 'left', full, 'Join row, left'));
        zoneList.push(makeZone(
          { left: b.left + half, top: b.top, width: half, height: b.height },
          'side', id, 'right', full, 'Join row, right'));
      }
    }
  }

  /* Side zones are painted first so a "new row" bar, which is the smaller and
     more precise target, always sits on top where the two touch. */
  for (const z of zoneList) {
    if (z.kind === 'side') layer.appendChild(z.el);
  }
  for (const z of zoneList) {
    if (z.kind === 'row') layer.appendChild(z.el);
  }

  document.body.classList.add('is-zoning');
}

function clearZones() {
  if (zoneLayer) zoneLayer.innerHTML = '';
  zoneList = [];
  zoneActive = null;
  document.body.classList.remove('is-zoning');
}

/** Which zone is under (x, y)? The LAST match wins, which matches the paint
 *  order above: the row bars are on top, so a point inside both a side zone
 *  and a row bar resolves to the bar the user can see. */
function zoneAt(x, y) {
  let hit = null;
  for (const z of zoneList) {
    const r = z.el.getBoundingClientRect();
    if (x >= r.left && x <= r.right && y >= r.top && y <= r.bottom) {
      if (!hit || z.kind === 'row') hit = z;
    }
  }
  return hit;
}

/** Light the zone under the pointer and dim the rest. */
function highlightZone(z) {
  if (zoneActive === z) return;
  if (zoneActive) zoneActive.el.classList.remove('is-on');
  zoneActive = z;
  if (z) z.el.classList.add('is-on');
}

/** Carry out a decided drop. Returns true when the layout actually changed. */
function commitIntent(draggedId, zone) {
  if (!zone || zone.full) return false;
  const ok = zone.kind === 'side'
    ? moveBeside(draggedId, zone.id, zone.side)
    : moveToNewRow(draggedId, zone.id, zone.side);
  if (ok) applyLayout();
  return ok;
}

/* ---- the pointer drag ----------------------------------------------------
 * Pointer events, not HTML5 drag-and-drop, and deliberately so. The page
 * already owns window-level dragenter/dragover/drop for FILE loading, which
 * puts the whole body into its "RELEASE TO LOAD" state; a native element drag
 * fires those same events and would flash that overlay every time a panel was
 * moved. Pointer events are a separate channel entirely, so the two cannot
 * collide — and they work under a finger, which native DnD does not.
 *
 * The file drop path is additionally hardened below to ignore any drag that
 * is not carrying files, so the two remain independent from both ends.
 * ========================================================================= */

const DRAG_SLOP = 5;   // px before a press becomes a drag rather than a click

function wirePanelDrag() {
  const host = document.querySelector('.instruments');
  if (!host) return;

  let active = null;

  const onMove = (e) => {
    if (!active) return;
    if (!active.started) {
      if (Math.hypot(e.clientX - active.x0, e.clientY - active.y0) < DRAG_SLOP) {
        return;
      }
      active.started = true;
      active.section.classList.add('is-dragging');
      document.body.classList.add('is-panel-dragging');
      /* The map goes up the instant the press becomes a drag, not on the first
         hover near an edge: the whole point is that the targets are on screen
         BEFORE the aiming starts. Built once — the layout cannot change
         mid-drag, because a drop is the only thing that changes it. */
      buildZones(active.id);
    }
    active.zone = zoneAt(e.clientX, e.clientY);
    highlightZone(active.zone);
  };

  const finish = (commit) => {
    if (!active) return;
    const a = active;
    active = null;
    clearZones();
    a.section.classList.remove('is-dragging');
    document.body.classList.remove('is-panel-dragging');
    try { a.section.releasePointerCapture(a.pointerId); } catch { /* gone */ }
    if (commit && a.started) commitIntent(a.id, a.zone);
  };

  host.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    const title = e.target.closest('.unit-title');
    if (!title) return;
    const section = title.parentElement;
    if (!section || !section.classList.contains('unit')) return;
    if (section.hasAttribute('data-no-drag')) return;
    /* The title row carries real controls — the collapse key, Analysis's own
       Analyze button. A press on one of those is a click, not a grab. */
    if (e.target.closest('button, a, input, select, textarea')) return;

    const cards = cardMap();
    let id = null;
    for (const [k, v] of cards) if (v === section) { id = k; break; }
    if (!id) return;

    active = {
      id, section, pointerId: e.pointerId,
      x0: e.clientX, y0: e.clientY, started: false, zone: null,
    };
    try { section.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
  });

  host.addEventListener('pointermove', onMove);
  host.addEventListener('pointerup', () => finish(true));
  host.addEventListener('pointercancel', () => finish(false));

  /* Escape abandons a drag in flight, leaving the bench as it was. */
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && active) { e.preventDefault(); finish(false); }
  });

  /* A drag that ends outside the instruments column still has to be cleaned
     up, or the body keeps its grabbing cursor. */
  window.addEventListener('pointerup', () => { if (active) finish(true); });
}

/* ---- keyboard moves ------------------------------------------------------
 * The title bar is a real control, so it is focusable and announces itself.
 * Modifier + arrow moves the panel: left/right within and between rows,
 * up/down between rows. Nothing here needs a pointer.
 * ========================================================================= */

let liveRegion = null;

function announce(msg) {
  if (!liveRegion) {
    liveRegion = document.createElement('div');
    liveRegion.className = 'layout-live';
    liveRegion.setAttribute('role', 'status');
    liveRegion.setAttribute('aria-live', 'polite');
    document.body.appendChild(liveRegion);
  }
  /* Re-setting identical text does not re-announce; the space forces it. */
  liveRegion.textContent = msg + (liveRegion.textContent === msg ? ' ' : '');
}

/** Say where a panel has landed, in the terms the user thinks in. */
function describePlace(id) {
  const at = findCard(id);
  if (!at) return '';
  const [r, c] = at;
  const row = layoutRows[r];
  const where = `row ${r + 1} of ${layoutRows.length}`;
  return row.length > 1
    ? `${where}, position ${c + 1} of ${row.length}`
    : `${where}, full width`;
}

/** Move a panel one step in a direction. Returns true if anything moved. */
function stepCard(id, dir) {
  const at = findCard(id);
  if (!at) return false;
  const [r, c] = at;
  const row = layoutRows[r];

  if (dir === 'left' || dir === 'right') {
    const to = dir === 'left' ? c - 1 : c + 1;
    if (to >= 0 && to < row.length) {
      /* Within the row: swap with the neighbour. */
      row.splice(c, 1);
      row.splice(to, 0, id);
      return true;
    }
    /* Off the end of the row: join the neighbouring row, if it has space. */
    const nr = dir === 'left' ? r - 1 : r + 1;
    if (nr < 0 || nr >= layoutRows.length) return false;
    if (!multiColumnAllowed()) return false;
    if (layoutRows[nr].length >= MAX_PER_ROW) return false;
    removeCard(id);
    /* The lift may have removed row r entirely and shifted nr down by one. */
    const target = nr > r && row.length === 1 ? nr - 1 : nr;
    if (target < 0 || target >= layoutRows.length) return false;
    layoutRows[target][dir === 'left' ? 'push' : 'unshift'](id);
    return true;
  }

  /* Up and down: leave the row and open a new one of your own. Within a
     multi-column row this is how a panel gets back to full width. */
  const nr = dir === 'up' ? r - 1 : r + 1;
  if (row.length === 1) {
    /* Already alone: swap whole rows with the neighbour. */
    if (nr < 0 || nr >= layoutRows.length) return false;
    const tmp = layoutRows[r];
    layoutRows[r] = layoutRows[nr];
    layoutRows[nr] = tmp;
    return true;
  }
  removeCard(id);
  layoutRows.splice(dir === 'up' ? r : r + 1, 0, [id]);
  return true;
}

function wireLayoutKeys() {
  const host = document.querySelector('.instruments');
  if (!host) return;

  host.addEventListener('keydown', (e) => {
    const title = e.target.closest('.unit-title');
    if (!title || title !== e.target) return;
    const section = title.parentElement;
    if (!section || section.hasAttribute('data-no-drag')) return;

    const DIRS = {
      ArrowLeft: 'left', ArrowRight: 'right',
      ArrowUp: 'up', ArrowDown: 'down',
    };
    const dir = DIRS[e.key];
    if (!dir) return;
    /* A modifier is required: bare arrows on a focused element must stay
       available for scrolling and for the browser's own caret browsing. */
    if (!(e.altKey || e.ctrlKey || e.metaKey || e.shiftKey)) return;
    e.preventDefault();

    let id = null;
    for (const [k, v] of cardMap()) if (v === section) { id = k; break; }
    if (!id) return;

    if (stepCard(id, dir)) {
      applyLayout();
      /* The move re-appends the element, which drops focus on the title bar;
         put it straight back so a second press continues the move. */
      title.focus();
      announce(`${panelTitle(section)} moved to ${describePlace(id)}`);
    } else {
      announce(`${panelTitle(section)} cannot move further ${dir}`);
    }
  });
}

/** The engraved name of a panel, for spoken feedback. */
function panelTitle(section) {
  const h = section.querySelector('.unit-title h2');
  return h ? h.textContent.trim() : 'Panel';
}

/** Make every title bar a described, focusable drag handle. Re-run whenever
 *  panels appear, since meters.js mounts five of its own after boot. */
function markHandles() {
  layoutCards().forEach((section, i) => {
    const title = section.querySelector('.unit-title');
    if (!title || title.dataset.handle === '1') return;
    if (section.hasAttribute('data-no-drag')) return;
    title.dataset.handle = '1';
    title.tabIndex = 0;
    title.setAttribute('role', 'button');
    const name = panelTitle(section);
    title.setAttribute('aria-label',
      `${name} panel — drag to rearrange, or hold Alt and press the arrow ` +
      `keys to move it`);
    title.setAttribute('aria-roledescription', 'draggable panel');
  });
}

/* ---- the placement menu -------------------------------------------------
 * The macOS window-tiling analogy, and the precise path: a small control in
 * every panel's title bar that opens a list of places the panel can go, each
 * of which performs the move on a single click with no dragging at all.
 *
 * This is not a convenience wrapper around the drag — it is the accessible
 * route. Everything the drag can express is here as a named command, so a
 * pointer that cannot hold a drag, a keyboard, or a person who simply does not
 * want to aim never has to touch the zone map. The options are generated from
 * the panel's CURRENT place, so what is offered is always something that would
 * actually change the bench: an option that would be a no-op is disabled with
 * the reason on it rather than silently doing nothing.
 *
 * At one-column widths (the same media query the stylesheet uses) only up and
 * down are offered — the side and width options describe rows that cannot be
 * seen there.
 * ========================================================================= */

let placementMenu = null;     // the open menu element, or null
let placementOwner = null;    // the button that opened it

function closePlacement() {
  if (placementMenu) {
    placementMenu.remove();
    placementMenu = null;
  }
  if (placementOwner) {
    placementOwner.setAttribute('aria-expanded', 'false');
    placementOwner = null;
  }
}

/* ---- the moves the menu offers ------------------------------------------
 * Each is expressed against the layout model, never against the DOM, and each
 * returns true only when it actually changed something — that is what decides
 * whether the option is offered as live or disabled. */

/** Put `id` alone in a full-width row of its own, keeping its vertical place.
 *  This is "make full width" for a panel sharing a row. */
function placeFullWidth(id) {
  const at = findCard(id);
  if (!at) return false;
  const [r] = at;
  if (layoutRows[r].length === 1) return false;   // already full width
  removeCard(id);
  /* Directly below what is left of the row it was in, so the panel stays
     where the eye last saw it rather than jumping to the end of the bench. */
  layoutRows.splice(r + 1, 0, [id]);
  return true;
}

/** Move `id` to position `col` within its own row (0 = left). Used for the
 *  "place left / centre / right" options. */
function placeAtColumn(id, col) {
  const at = findCard(id);
  if (!at) return false;
  const [r, c] = at;
  const row = layoutRows[r];
  if (col < 0 || col >= row.length || col === c) return false;
  row.splice(c, 1);
  row.splice(col, 0, id);
  return true;
}

/** Join the row above or below, if that row has room. This is how a panel
 *  BECOMES part of a 2- or 3-across row from the menu, with no drag. */
function placeJoinRow(id, dir, side) {
  const at = findCard(id);
  if (!at) return false;
  const [r] = at;
  const nr = dir === 'up' ? r - 1 : r + 1;
  if (nr < 0 || nr >= layoutRows.length) return false;
  if (layoutRows[nr].length >= MAX_PER_ROW) return false;
  const alone = layoutRows[r].length === 1;
  removeCard(id);
  /* Lifting the panel may have deleted its old row and shifted the target up
     by one. */
  const target = (alone && nr > r) ? nr - 1 : nr;
  if (target < 0 || target >= layoutRows.length) return false;
  if (side === 'left') layoutRows[target].unshift(id);
  else layoutRows[target].push(id);
  return true;
}

/** Give `id` a new full-width row of its own at the very end of the bench. */
function placeOwnRowAtEnd(id) {
  const at = findCard(id);
  if (!at) return false;
  const [r] = at;
  if (r === layoutRows.length - 1 && layoutRows[r].length === 1) return false;
  removeCard(id);
  layoutRows.push([id]);
  return true;
}

/** Run a move, write it to the page, and say what happened. */
function runPlacement(id, fn, label) {
  const section = cardMap().get(id);
  if (!fn()) {
    announce(`${section ? panelTitle(section) : 'Panel'} — ${label} changes nothing`);
    return;
  }
  applyLayout();
  const now = cardMap().get(id);
  if (now) announce(`${panelTitle(now)} moved to ${describePlace(id)}`);
}

/** The option list for a panel, in the order it is shown. Each entry is
 *  { label, run, off } — `off` being a reason it is unavailable, which is
 *  shown rather than hidden so the menu's shape does not jump about. */
function placementOptions(id) {
  const at = findCard(id);
  if (!at) return [];
  const [r, c] = at;
  const row = layoutRows[r];
  const multi = multiColumnAllowed();
  const opts = [];

  /* --- vertical: always available, at every width --------------------- */
  opts.push({
    label: 'Move up',
    off: r === 0 && row.length === 1 ? 'already at the top' : '',
    run: () => stepCard(id, 'up'),
  });
  opts.push({
    label: 'Move down',
    off: r === layoutRows.length - 1 && row.length === 1
      ? 'already at the bottom' : '',
    run: () => stepCard(id, 'down'),
  });

  /* Below the breakpoint the bench is one column whatever the layout says, so
     a width or a side would describe something invisible. Up and down are the
     whole vocabulary there, which is exactly what the brief asks for. */
  if (!multi) return opts;

  opts.push({ sep: true });

  /* --- width ---------------------------------------------------------- */
  opts.push({
    label: 'Make full width',
    off: row.length === 1 ? 'already full width' : '',
    run: () => placeFullWidth(id),
  });

  /* --- position within the row it is already in ------------------------ */
  if (row.length > 1) {
    const names = row.length === 2
      ? ['Place left', 'Place right']
      : ['Place left', 'Place centre', 'Place right'];
    names.forEach((label, i) => {
      opts.push({
        label,
        off: c === i ? 'already there' : '',
        run: () => placeAtColumn(id, i),
      });
    });
  }

  /* --- joining a neighbouring row, which is how a row of 2 or 3 is built
         without ever dragging ----------------------------------------- */
  opts.push({ sep: true });

  const canJoin = (dir) => {
    const nr = dir === 'up' ? r - 1 : r + 1;
    if (nr < 0 || nr >= layoutRows.length) return 'no row there';
    if (layoutRows[nr].length >= MAX_PER_ROW) return 'that row is full';
    return '';
  };

  opts.push({
    label: 'Join row above, left',
    off: canJoin('up'),
    run: () => placeJoinRow(id, 'up', 'left'),
  });
  opts.push({
    label: 'Join row above, right',
    off: canJoin('up'),
    run: () => placeJoinRow(id, 'up', 'right'),
  });
  opts.push({
    label: 'Join row below, left',
    off: canJoin('down'),
    run: () => placeJoinRow(id, 'down', 'left'),
  });
  opts.push({
    label: 'Join row below, right',
    off: canJoin('down'),
    run: () => placeJoinRow(id, 'down', 'right'),
  });

  opts.push({ sep: true });
  opts.push({
    label: 'Move to its own new row',
    off: r === layoutRows.length - 1 && row.length === 1
      ? 'already alone at the end' : '',
    run: () => placeOwnRowAtEnd(id),
  });

  return opts;
}

/** Open the picker under its button. */
function openPlacement(btn, id) {
  closePlacement();

  const opts = placementOptions(id);
  if (!opts.length) return;

  const menu = document.createElement('div');
  menu.className = 'place-menu';
  menu.setAttribute('role', 'menu');
  const section = cardMap().get(id);
  menu.setAttribute('aria-label',
    `Place ${section ? panelTitle(section) : 'panel'}`);

  for (const o of opts) {
    if (o.sep) {
      const hr = document.createElement('div');
      hr.className = 'place-sep';
      menu.appendChild(hr);
      continue;
    }
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'place-item';
    item.setAttribute('role', 'menuitem');
    item.textContent = o.label;
    if (o.off) {
      item.disabled = true;
      item.title = o.off;
      const why = document.createElement('span');
      why.className = 'place-why';
      why.textContent = o.off;
      item.appendChild(why);
    } else {
      item.addEventListener('click', () => {
        closePlacement();
        runPlacement(id, o.run, o.label);
      });
    }
    menu.appendChild(item);
  }

  document.body.appendChild(menu);
  placementMenu = menu;
  placementOwner = btn;
  btn.setAttribute('aria-expanded', 'true');

  /* Positioned in viewport coordinates under the button, then pulled back
     inside the window if it would hang off an edge — a menu that opens off
     screen is a menu that does not open. */
  const b = btn.getBoundingClientRect();
  const m = menu.getBoundingClientRect();
  let left = b.right - m.width;
  let top = b.bottom + 6;
  const pad = 8;
  left = Math.max(pad, Math.min(left, window.innerWidth - m.width - pad));
  if (top + m.height > window.innerHeight - pad) {
    /* No room below: flip above the button, and if there is no room there
       either, sit at the top of the window and let the menu scroll. */
    top = Math.max(pad, b.top - m.height - 6);
  }
  menu.style.left = Math.round(left) + 'px';
  menu.style.top = Math.round(top) + 'px';
  menu.style.maxHeight = Math.round(window.innerHeight - top - pad) + 'px';

  const first = menu.querySelector('.place-item:not([disabled])');
  if (first) first.focus();
}

/** The control itself, added to every panel's title bar. */
function wirePlacementMenus() {
  markPlacementButtons();

  /* One document-level handler rather than one per menu: the menu is rebuilt
     on every open, and a listener per instance would leak. */
  document.addEventListener('pointerdown', (e) => {
    if (!placementMenu) return;
    if (e.target.closest('.place-menu')) return;
    if (e.target.closest('.place-btn')) return;   // its own toggle handles it
    closePlacement();
  });

  document.addEventListener('keydown', (e) => {
    if (!placementMenu) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      const owner = placementOwner;
      closePlacement();
      if (owner) owner.focus();
      return;
    }
    /* Arrow keys walk the list, which is what a menu is expected to do. */
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...placementMenu.querySelectorAll('.place-item:not([disabled])')];
    if (!items.length) return;
    e.preventDefault();
    const at = items.indexOf(document.activeElement);
    const next = e.key === 'ArrowDown'
      ? (at + 1) % items.length
      : (at <= 0 ? items.length - 1 : at - 1);
    items[next].focus();
  });
}

/** Give every panel that does not have one a placement control. Re-run
 *  whenever panels appear, since meters.js mounts five after boot. */
function markPlacementButtons() {
  layoutCards().forEach((section, i) => {
    const title = section.querySelector('.unit-title');
    if (!title) return;
    if (title.querySelector('.place-btn')) return;
    if (section.hasAttribute('data-no-drag')) return;


    const id = layoutId(section, i);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'place-btn';
    btn.setAttribute('aria-haspopup', 'menu');
    btn.setAttribute('aria-expanded', 'false');
    btn.title = `Place ${panelTitle(section)} on the bench`;
    btn.setAttribute('aria-label', btn.title);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (placementOwner === btn) { closePlacement(); return; }
      /* The id is re-derived at open time, not captured: meters.js can
         re-append a panel, and the element this button lives in outlives any
         one reading of the card map. */
      let live = id;
      for (const [k, v] of cardMap()) if (v === section) { live = k; break; }
      openPlacement(btn, live);
    });

    /* The title bar is the drag handle, and a press on a real control in it
       is a click rather than a grab — wirePanelDrag() already refuses any
       pointerdown that lands on a button, so nothing more is needed here than
       keeping this a <button>. */
    title.appendChild(btn);
  });
}

/* ---- watching for panels that arrive from elsewhere ---------------------
 * meters.js mounts its five panels after this script boots, and re-appends
 * them on every tray edit. Both land here: new ids are reconciled into the
 * layout, and a reorder that was not ours is absorbed rather than fought.
 * ========================================================================= */

function watchInstruments() {
  const host = document.querySelector('.instruments');
  if (!host || typeof MutationObserver !== 'function') return;

  let queued = false;
  const observer = new MutationObserver(() => {
    if (layoutWriting || queued) return;
    queued = true;
    /* Coalesce: mount() appends ten times in a row, and applyArrangement()
       once per meter. One pass after the burst is enough. */
    Promise.resolve().then(() => {
      queued = false;
      markHandles();
      /* The five meter panels mount after boot and are re-appended on every
         tray edit, so their placement controls are added here rather than
         only at wire time. The function is idempotent — it skips a title bar
         that already has one — so running it on every burst is free. */
      markPlacementButtons();
      /* A meter that was switched off is `hidden`; it keeps its place in the
         layout so switching it back on returns it where it was. */
      applyLayout();
    });
  });
  observer.observe(host, { childList: true });
}

/* ================================================================ workspaces
 * A workspace is the whole bench: panel order and row grouping, which meters
 * are on, what is folded, the rail width, and the EQ bands.
 *
 * Built-ins ship with the page and cannot be deleted — but selecting one and
 * saving under a new name is an ordinary save, so they are starting points
 * rather than a closed set.
 * ========================================================================= */

const WORKSPACE_KEY = 'music-studio.workspaces';

/* The five meter ids that meters.js owns. Named here so a built-in can say
 * which meters it wants without reaching into that file's internals. */
const METER_IDS = ['loudness-time', 'goniometer', 'spectrum', 'dynamics',
                   'equalizer'];

/* Built-in benches. Each names the rows it wants; any panel not mentioned is
 * appended full-width at the end by reconcileRows, so these stay valid when a
 * new panel is added to the page. */
const BUILTIN_WORKSPACES = [
  {
    id: 'mastering',
    name: 'Mastering',
    builtin: true,
    rows: [
      ['transport'],
      ['vu-bridge', 'levels'],
      ['analysis'],
      ['loudness-time', 'dynamics'],
    ],
    hiddenMeters: ['goniometer', 'spectrum', 'equalizer'],
    collapsed: [],
  },
  {
    id: 'mixing',
    name: 'Mixing',
    builtin: true,
    rows: [
      ['transport'],
      ['spectrum', 'goniometer', 'equalizer'],
      ['vu-bridge', 'levels'],
    ],
    hiddenMeters: ['loudness-time', 'dynamics'],
    collapsed: ['analysis', 'spectrum-builtin'],
  },
  {
    id: 'quick-check',
    name: 'Quick check',
    builtin: true,
    rows: [
      ['transport'],
      ['analysis'],
    ],
    hiddenMeters: METER_IDS.slice(),
    collapsed: ['vu-bridge', 'levels', 'spectrum-builtin'],
  },
];

function readWorkspaces() {
  try {
    const raw = JSON.parse(localStorage.getItem(WORKSPACE_KEY) || 'null');
    if (!Array.isArray(raw)) return [];
    return raw.filter((w) => w && typeof w.name === 'string' && w.id);
  } catch { return []; }
}

function writeWorkspaces(list) {
  try { localStorage.setItem(WORKSPACE_KEY, JSON.stringify(list)); }
  catch { /* private window: the bench works, it just cannot remember */ }
}

/** Built-ins first, then the user's own, which shadow a built-in of the same
 *  id — that is how "overwrite a built-in into a new name" stays possible
 *  without ever destroying the original. */
function allWorkspaces() {
  const saved = readWorkspaces();
  const savedIds = new Set(saved.map((w) => w.id));
  return [
    ...BUILTIN_WORKSPACES.filter((w) => !savedIds.has(w.id)),
    ...saved,
  ];
}

/** Capture the bench exactly as it stands. */
function captureWorkspace(name) {
  const cards = cardMap();
  layoutRows = reconcileRows(layoutRows, cards);

  const collapsed = [];
  for (const [id, section] of cards) {
    if (section.classList.contains('is-collapsed')) collapsed.push(id);
  }

  let hiddenMeters = [];
  try {
    const tray = window.StudioMeters && window.StudioMeters.tray();
    if (tray) hiddenMeters = tray.hidden();
  } catch { /* meters.js absent or not mounted yet */ }

  let bands = [];
  try {
    if (window.StudioEq && Array.isArray(window.StudioEq.bands)) {
      /* A deep copy: the live array is meters.js's own and keeps changing. */
      bands = JSON.parse(JSON.stringify(window.StudioEq.bands));
    }
  } catch { /* an EQ that will not serialise is simply not captured */ }

  let rail = RAIL_DEFAULT;
  if (el.splitter) rail = Number(el.splitter.getAttribute('aria-valuenow')) || rail;

  return {
    id: 'ws-' + Date.now().toString(36),
    name,
    rows: layoutRows.map((r) => r.slice()),
    collapsed,
    hiddenMeters,
    bands,
    rail,
  };
}

/** Put the bench into a saved state. */
function restoreWorkspace(ws) {
  if (!ws) return;

  /* --- the meter tray first: showing a meter that was off adds a panel, and
     the layout has to be written after every panel exists. ---------------- */
  try {
    const tray = window.StudioMeters && window.StudioMeters.tray();
    if (tray && Array.isArray(ws.hiddenMeters)) {
      const want = new Set(ws.hiddenMeters);
      for (const id of METER_IDS) {
        if (want.has(id)) tray.hide(id); else tray.show(id);
      }
    }
  } catch { /* no tray: the built-in panels still rearrange */ }

  /* --- rail width ------------------------------------------------------- */
  if (Number.isFinite(ws.rail)) setRailWidth(ws.rail, true);

  /* --- collapsed states -------------------------------------------------
     Driven through each card's own control rather than by setting the class,
     so the button's aria-expanded, the body's hidden flag and the saved
     collapse key all stay in step with the class. */
  const want = new Set(Array.isArray(ws.collapsed) ? ws.collapsed : []);
  for (const [id, section] of cardMap()) {
    const btn = section.querySelector('.collapse-btn');
    if (!btn) continue;
    const isCollapsed = section.classList.contains('is-collapsed');
    if (want.has(id) !== isCollapsed) btn.click();
  }

  /* --- the layout itself ------------------------------------------------- */
  layoutRows = normaliseRows(ws.rows);
  applyLayout();

  /* --- the EQ -----------------------------------------------------------
     window.StudioEq carries `bands` and `preset` but no apply(): meters.js
     publishes the array and never offers a way in. So the bands are set and
     a 'studio-eq-restore' event is dispatched for meters.js to listen for.
     The apply() branch is kept for the day that file grows one. */
  if (Array.isArray(ws.bands) && ws.bands.length) {
    try {
      window.StudioEq = window.StudioEq || {};
      window.StudioEq.bands = JSON.parse(JSON.stringify(ws.bands));
      if (typeof window.StudioEq.apply === 'function') {
        window.StudioEq.apply(window.StudioEq.bands);
      } else {
        window.dispatchEvent(new CustomEvent('studio-eq-restore',
          { detail: { bands: window.StudioEq.bands } }));
      }
    } catch { /* an EQ that refuses to restore must not stop the layout */ }
  }
}

/* ---- the masthead control ------------------------------------------------ */

const WS_CURRENT_KEY = 'music-studio.workspace-current';

function readCurrentWorkspace() {
  try { return localStorage.getItem(WS_CURRENT_KEY) || ''; }
  catch { return ''; }
}

function writeCurrentWorkspace(id) {
  try { localStorage.setItem(WS_CURRENT_KEY, id || ''); }
  catch { /* nothing to do */ }
}

function fillWorkspaceSelect(select, selectedId) {
  const list = allWorkspaces();
  select.innerHTML = '';

  const none = document.createElement('option');
  none.value = '';
  none.textContent = '— working layout —';
  select.appendChild(none);

  const builtins = list.filter((w) => w.builtin);
  const mine = list.filter((w) => !w.builtin);

  const group = (label, items) => {
    if (!items.length) return;
    const g = document.createElement('optgroup');
    g.label = label;
    for (const w of items) {
      const o = document.createElement('option');
      o.value = w.id;
      o.textContent = w.name;
      g.appendChild(o);
    }
    select.appendChild(g);
  };
  group('Built in', builtins);
  group('Saved', mine);

  select.value = list.some((w) => w.id === selectedId) ? selectedId : '';
  return list;
}

function wireWorkspaces() {
  const select = $('#workspace-select');
  const saveBtn = $('#workspace-save');
  const delBtn = $('#workspace-delete');
  if (!select || !saveBtn || !delBtn) return;

  const refresh = (id) => {
    const list = fillWorkspaceSelect(select, id);
    const chosen = list.find((w) => w.id === select.value);
    /* A built-in cannot be deleted; nor can "the working layout". */
    delBtn.disabled = !chosen || !!chosen.builtin;
    delBtn.title = !chosen
      ? 'Choose a saved workspace to delete it'
      : chosen.builtin
        ? `${chosen.name} is built in and cannot be deleted`
        : `Delete “${chosen.name}”`;
  };

  refresh(readCurrentWorkspace());

  select.addEventListener('change', () => {
    const id = select.value;
    writeCurrentWorkspace(id);
    if (!id) { refresh(id); return; }
    const ws = allWorkspaces().find((w) => w.id === id);
    if (ws) restoreWorkspace(ws);
    refresh(id);
    announce(ws ? `${ws.name} workspace loaded` : 'Workspace not found');
  });

  saveBtn.addEventListener('click', () => {
    const current = allWorkspaces().find((w) => w.id === select.value);
    const suggested = current && !current.builtin ? current.name : '';
    const name = (window.prompt('Name this workspace', suggested) || '').trim();
    if (!name) return;

    const list = readWorkspaces();
    const ws = captureWorkspace(name);
    /* Saving under an existing saved name replaces it, which is what a person
       who typed the same name again meant. A built-in's name is free to reuse:
       the copy shadows it by id only if the ids match, and they never do. */
    const at = list.findIndex((w) => !w.builtin && w.name === name);
    if (at >= 0) { ws.id = list[at].id; list[at] = ws; }
    else list.push(ws);

    writeWorkspaces(list);
    writeCurrentWorkspace(ws.id);
    refresh(ws.id);
    announce(`Workspace ${name} saved`);
  });

  delBtn.addEventListener('click', () => {
    const id = select.value;
    if (!id) return;
    const list = readWorkspaces();
    const at = list.findIndex((w) => w.id === id);
    if (at < 0) return;
    const name = list[at].name;
    if (!window.confirm(`Delete the workspace “${name}”?`)) return;
    list.splice(at, 1);
    writeWorkspaces(list);
    writeCurrentWorkspace('');
    refresh('');
    announce(`Workspace ${name} deleted`);
  });
}

/** Start the layout engine: adopt the saved working layout, mark the handles,
 *  and watch for the panels meters.js is about to mount. */
function wireLayout() {
  layoutRows = readLayout();
  markHandles();
  applyLayout(false);
  wirePanelDrag();
  wireLayoutKeys();
  wirePlacementMenus();
  watchInstruments();
  wireWorkspaces();

  /* The zone map is measured geometry, so a resize or a scroll while a drag is
     somehow still live would leave every target pointing at where a panel used
     to be. Drop the map rather than show a lie; the next pointer move rebuilds
     nothing, so the drag simply ends with no drop, which is the safe outcome.
     The placement menu is dismissed for the same reason. */
  window.addEventListener('resize', () => { clearZones(); closePlacement(); });
  window.addEventListener('scroll', closePlacement, { passive: true });
}

function boot() {
  setTransportEnabled(false);
  trackMastheadHeight();
  wireSplitter();
  wireCollapse();
  wireTimeline();
  wireReset();
  wireAnalyzeRun();
  wireAnalyseButton();
  wireLayout();
  renderTimeline([]);
  renderMusicalReadouts();
  wireAsk();
  detectServer().then(() => {
    /* Say so once we know: the rail's note carries the connection state, and
       an offline page should not claim to be able to chat. */
    if (!server.live) {
      saidOffline = true;
      chatSystem('Not connected — start `music serve` to chat. ' +
        'Questions typed here will come back as a command to run instead.');
    }
  });

  // `music scope --open` writes the analysis into window.PRELOADED_ANALYSIS and
  // opens this page, so the run you just did is on screen without hand-loading
  // a file. A file:// page cannot fetch a sibling JSON — CORS forbids it — so
  // the data is embedded rather than linked.
  const pre = window.PRELOADED_ANALYSIS;
  if (pre && typeof pre === 'object') {
    applyAnalysis(pre, window.PRELOADED_NAME || 'analysis.json');
    el.source.innerHTML =
      `<b>${escapeHtml(window.PRELOADED_NAME || 'analysis.json')}</b>` +
      ' · analysis only';
    requestAnimationFrame(frame);
    return;
  }

  applyAnalysis(demoAnalysis(), 'example-analysis.json');
  el.source.innerHTML =
    '<b>Example measurement</b> · a demonstration reading, not your file';
  el.tDur.textContent = __S.fmtTime(206.4);
  requestAnimationFrame(frame);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}


/* Published for the files that load after this one. */
Object.assign(__S, {  });
})(window.__studio || (window.__studio = {}));
