/* studio-engine.js — the WebAudio engine: the EQ chains, the rack router, the precomputed-JSON adapter
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
   5. Audio engine
   ========================================================================== */

/* Which bands actually do something.
 *
 * Gain is the wrong test on its own: a lowpass, highpass or notch is defined by
 * its corner frequency and does its work at gain 0, so filtering on `b.gain`
 * silently dropped them — the panel would show a lowpass while the audio had
 * none. Only the gain-bearing types (peaking and the shelves) are inert at 0. */
function activeEqBands(bands) {
  const SHAPES_WITHOUT_GAIN = new Set(['highpass', 'lowpass', 'notch', 'bandpass', 'allpass']);
  return (bands || []).filter(
    b => b && b.type && (SHAPES_WITHOUT_GAIN.has(b.type) || Math.abs(b.gain || 0) > 0.01));
}

/* The limiter's named times, in ms. These are maximize.py's LIMIT_ATTACK and
 * LIMIT_RELEASE: the browser limiter must respond the way the render will, so
 * the numbers are copied rather than invented. `auto` has no browser
 * equivalent — alimiter's `asc` adapts to the material — so it previews at a
 * middling 100 ms, which rackApprox() does not flag because the audible
 * difference is small and naming it would bury the two that matter. */
const RACK_LIMIT_ATTACK = { fast: 0.5, mid: 4.0, slow: 20.0 };
const RACK_LIMIT_RELEASE = { fast: 30.0, slow: 300.0, auto: 100.0 };

/* A hard ceiling as a WaveShaper curve: linear up to the limit, flat above.
 *
 * This is the backstop behind the browser limiter's compressor, which
 * overshoots its own threshold by more the harder it is driven (measured:
 * +1.195 dBFS on a -1.0 dBFS threshold at 12 dB of drive). Sampled at an odd
 * length so there is a sample exactly at zero and silence maps to silence. */
function hardCeilingCurve(ceilingDb) {
  const N = 8193;
  const curve = new Float32Array(N);
  const lin = Math.pow(10, __S.clamp(ceilingDb, -60, 0) / 20);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    curve[i] = Math.sign(x) * Math.min(Math.abs(x), lin);
  }
  return curve;
}

/* A transfer curve for the WaveShaper, matching ffmpeg's `asoftclip` types.
 *
 * Below the threshold the curve is linear — the signal passes untouched — and
 * above it the named function rounds the peak instead of the hard corner that
 * clipping would put there. `amount` scales how hard the rounding bites.
 *
 * Sampled over [-1, 1]; an odd length guarantees a sample exactly at zero, so
 * silence maps to silence rather than to a DC offset. */
function softClipCurve(kind, amount, threshold) {
  const N = 8193;
  const curve = new Float32Array(N);
  const t = __S.clamp(threshold == null ? 0.95 : threshold, 0.05, 1);
  const a = __S.clamp(amount == null ? 1 : amount, 0.01, 3);

  const shape = (x) => {
    // x is the amount by which the signal exceeds the threshold, normalised
    // so that 1 is "one full threshold's worth over". The functions all map
    // [0, inf) into [0, 1) so the result can never exceed full scale.
    switch (kind) {
      case 'tanh': return Math.tanh(x * a);
      case 'atan': return Math.atan(x * a) / (Math.PI / 2);
      case 'cubic': { const u = Math.min(x * a, 1); return u - (u * u * u) / 3; }
      case 'exp': return 1 - Math.exp(-x * a);
      case 'alg': return (x * a) / Math.sqrt(1 + (x * a) * (x * a));
      case 'quintic': { const u = Math.min(x * a, 1); return u - (u ** 5) / 5; }
      case 'sin': return Math.sin(Math.min(x * a, 1) * (Math.PI / 2));
      case 'erf': return Math.tanh(x * a * 1.2);     // close enough by eye
      case 'hard': default: return Math.min(x * a, 1);
    }
  };

  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    const mag = Math.abs(x);
    let y;
    if (mag <= t) {
      y = mag;
    } else {
      // Round only the part above the threshold, and scale what remains into
      // the headroom left between the threshold and full scale.
      y = t + (1 - t) * shape((mag - t) / (1 - t));
    }
    curve[i] = Math.sign(x) * Math.min(y, 1);
  }
  return curve;
}

class Engine {
  constructor() {
    this.ctx = null;
    this.buffer = null;
    this.source = null;
    this.analyser = null;
    this.splitter = null;
    this.playing = false;
    this.startedAt = 0;
    this.offset = 0;
    this.sampleRate = 48000;

    this.meters = {
      L: { rms: -Infinity, peak: -Infinity, hold: -Infinity, holdAge: 0, tp: -Infinity },
      R: { rms: -Infinity, peak: -Infinity, hold: -Infinity, holdAge: 0, tp: -Infinity },
    };
    this.correlation = 0;
    this.loudness = null;
    this.overCount = 0;
    this.maxTruePeak = -Infinity;

    /* Auto gain compensation, in dB. Set by the EQ panel, which computes it
       from the same coefficients it draws the curve from. Always ≤ 0: this
       trim only ever takes level away. Monitor only — see buildEq(). */
    this.eqTrimDb = 0;
    this.eqTrim = null;
    this.eqBypassed = false;

    /* The rack: the mastering suite as a patchable block. See buildRack().
     * `rackEnabled` is the patch cable — false means the block is out of the
     * signal path entirely, which is what makes the wiring optional rather
     * than a bypass switch on a device that is always there. */
    this.rackEnabled = false;
    this.rackBypassed = false;
    this.rackNodes = null;
    this.rackInput = null;
    this.rackOutput = null;

    /* The second equaliser, a device of its own. Same patch-cable idea as the
     * rack: unpatched it is absent from the graph rather than bypassed in it. */
    this.eq2Enabled = false;
    this.eq2Bypassed = false;
    this.eq2Nodes = null;
    this.eq2Input = null;
    this.eq2Output = null;
  }

  ensureContext() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC();
      this.sampleRate = this.ctx.sampleRate;
    }
    return this.ctx;
  }

  async decode(arrayBuffer) {
    const ctx = this.ensureContext();
    this.buffer = await ctx.decodeAudioData(arrayBuffer);
    this.sampleRate = this.buffer.sampleRate;
    this.offset = 0;
    this.resetMeters();
    return this.buffer;
  }

  resetMeters() {
    for (const k of ['L', 'R']) {
      Object.assign(this.meters[k],
        { rms: -Infinity, peak: -Infinity, hold: -Infinity, holdAge: 0, tp: -Infinity });
    }
    this.overCount = 0;
    this.maxTruePeak = -Infinity;
    if (this.loudness) this.loudness.reset();
  }

  /**
   * Build the graph. A ScriptProcessorNode does the sample-accurate work
   * (loudness, true peak, correlation); an AnalyserNode feeds the visuals.
   * ScriptProcessor is deprecated but universally available from file://,
   * where an AudioWorklet needs a module URL the browser will refuse to
   * load under the file: scheme in most configurations.
   */
  buildGraph() {
    const ctx = this.ensureContext();
    const buf = this.buffer;

    this.analyser = ctx.createAnalyser();
    this.analyser.fftSize = 4096;
    this.analyser.smoothingTimeConstant = 0.72;
    this.analyser.minDecibels = -90;
    this.analyser.maxDecibels = 0;

    this.loudness = new __S.LoudnessMeter(buf.sampleRate, Math.min(2, buf.numberOfChannels));

    const proc = ctx.createScriptProcessor(2048, 2, 2);
    this._tails = [[0, 0, 0], [0, 0, 0]];
    proc.onaudioprocess = (e) => this._onAudio(e);
    this.proc = proc;

    const gain = ctx.createGain();
    gain.gain.value = 1;
    this.gain = gain;
    return { analyser: this.analyser, proc, gain };
  }

  _onAudio(e) {
    const inp = e.inputBuffer;
    const nch = inp.numberOfChannels;
    const L = inp.getChannelData(0);
    const R = nch > 1 ? inp.getChannelData(1) : L;

    // Silence the processor's own output; the gain node carries the audio.
    const out = e.outputBuffer;
    for (let c = 0; c < out.numberOfChannels; c++) out.getChannelData(c).fill(0);

    if (!this.playing) return;

    const n = L.length;
    let sumL = 0, sumR = 0, pkL = 0, pkR = 0;
    let sumLR = 0, sumLL = 0, sumRR = 0;

    for (let i = 0; i < n; i++) {
      const l = L[i], r = R[i];
      sumL += l * l; sumR += r * r;
      const al = Math.abs(l), ar = Math.abs(r);
      if (al > pkL) pkL = al;
      if (ar > pkR) pkR = ar;
      sumLR += l * r; sumLL += l * l; sumRR += r * r;
    }

    const tpL = __S.truePeakOf(L, this._tails[0]);
    const tpR = __S.truePeakOf(R, this._tails[1]);
    this._tails[0] = [L[n - 3], L[n - 2], L[n - 1]];
    this._tails[1] = [R[n - 3], R[n - 2], R[n - 1]];

    const mL = this.meters.L, mR = this.meters.R;
    mL.rms = __S.dbfs(Math.sqrt(sumL / n));
    mR.rms = __S.dbfs(Math.sqrt(sumR / n));
    mL.peak = __S.dbfs(pkL);
    mR.peak = __S.dbfs(pkR);
    mL.tp = __S.dbfs(tpL);
    mR.tp = __S.dbfs(tpR);

    const tpDb = Math.max(mL.tp, mR.tp);
    if (tpDb > this.maxTruePeak) this.maxTruePeak = tpDb;
    if (pkL >= 0.999 || pkR >= 0.999) this.overCount++;

    // Pearson correlation of L against R over the block.
    const den = Math.sqrt(sumLL * sumRR);
    const corr = den > 1e-9 ? sumLR / den : (nch > 1 ? 0 : 1);
    this.correlation = __S.lerp(this.correlation, corr, 0.25);

    this.loudness.push(nch > 1 ? [L, R] : [L]);
  }

  /* ------------------------------------------------------------------ EQ --
   * A live equaliser, so a knob is something you hear rather than only a
   * number that ends up in a command.
   *
   * BiquadFilterNode implements the same RBJ cookbook filters the response
   * curve is drawn from, so the curve and the sound agree by construction
   * rather than by two implementations happening to match. The band list is
   * whatever the Equalizer panel last published; an empty list is a
   * passthrough, which is also the state before anything is dialled.
   */
  buildEq(ctx) {
    const bands = (window.StudioEq && window.StudioEq.bands) || [];
    const active = activeEqBands(bands);

    /* The trim node: auto gain compensation, and the reason a boost here does
     * not clip.
     *
     * Nothing follows the EQ but ctx.destination — no limiter, and the gain
     * stage before it is fixed at 1.0 — so whatever the filters add lands
     * straight on the browser's output. On a −1 dBFS master, where real
     * masters sit, a +12 dB shelf reaches +4 dBFS and is hard-clipped, and
     * the user hears distortion the monitor path invented. This node carries
     * the inverse of the chain's maximum boost, so the loudest point of the
     * equalised signal sits no higher than the bypassed signal does.
     *
     * It sits BEFORE the filters rather than after: attenuating first keeps
     * the biquads' own internal state away from the region where a resonant
     * boost would overflow, and means the meters downstream read the signal
     * that is actually audible.
     *
     * The number comes from the panel (StudioEq.trimForBands, swept over the
     * same RBJ coefficients the curve is drawn from). This file only holds
     * the node and ramps it.
     *
     * MONITOR ONLY. The trim compensates for the browser having no output
     * ceiling. It is not part of the EQ and must never appear in the emitted
     * ffmpeg chain: master.py applies its own true-peak ceiling after the EQ,
     * so a trim added there would attenuate a second time and deliver a file
     * quieter than asked for. The panel's buildChain() knows nothing about
     * this node, which is the correct arrangement. */
    const trim = ctx.createGain();
    trim.gain.value = this._eqTrimLinear();
    this.eqTrim = trim;

    this.eqNodes = [];
    if (!active.length || this.eqBypassed) {
      /* Nothing to filter. The trim node still stands in for the chain so the
         caller always has an input and an output to wire — and with no bands
         the trim it carries is 0 dB (unity), so this is a passthrough. Under
         bypass the trim is forced to unity below: a bypass that also removed
         a level change would be a level-matched comparison pretending to be
         an A/B of the filters. */
      this.eqInput = this.eqOutput = trim;
      return { input: trim, output: trim };
    }

    let head = null, tail = null;
    for (const b of active) {
      const node = ctx.createBiquadFilter();
      node.type = b.type;
      node.frequency.value = b.freq;
      if (b.type !== 'highpass' && b.type !== 'lowpass') node.gain.value = b.gain;
      node.Q.value = b.q || 0.707;
      if (tail) tail.connect(node); else head = node;
      tail = node;
      this.eqNodes.push({ node, band: b });
    }
    /* trim → filters. The caller wires into the trim, so the attenuation is
       applied before anything can boost. */
    trim.connect(head);
    this.eqInput = trim;
    this.eqOutput = tail;
    return { input: trim, output: tail };
  }

  /** The trim as a linear gain, or unity when it should not apply.
   *
   * Bypass forces unity: bypass exists so the ear can compare the EQ against
   * the untouched source, and a bypass that quietly kept an attenuation would
   * be a level-matched comparison wearing an A/B's clothes. */
  _eqTrimLinear() {
    if (this.eqBypassed) return 1;
    const db = Number(this.eqTrimDb);
    if (!isFinite(db) || db >= 0) return 1;      // only ever attenuates
    return Math.pow(10, db / 20);
  }

  /**
   * Set the auto gain compensation trim, in dB. Negative attenuates; 0 or
   * positive is unity, because this control only ever takes level away.
   *
   * Ramped with setTargetAtTime, exactly as the band updates are, so a fader
   * being moved changes the trim continuously instead of stepping it — a
   * stepped gain on a signal that is already playing is an audible click, and
   * the trim moves on every single frame of a drag.
   *
   * @param {number} db
   */
  setEqTrim(db) {
    const v = Number(db);
    this.eqTrimDb = isFinite(v) ? Math.min(0, v) : 0;
    const node = this.eqTrim;
    if (!node || !this.ctx) return;
    try {
      node.gain.setTargetAtTime(this._eqTrimLinear(), this.ctx.currentTime, 0.01);
    } catch (_) { /* node detached between frames */ }
  }

  /* Apply a changed band list without interrupting playback.
   *
   * Rebuilding the graph would mean stopping and restarting the source, which
   * costs the playhead and makes an A/B impossible. When the shape of the
   * chain is unchanged we only retune the existing nodes, ramping rather than
   * stepping so a turned knob does not click. */
  updateEq(bands) {
    const ctx = this.ctx;
    if (!ctx || !this.eqNodes) return false;

    const active = activeEqBands(bands);
    if (active.length !== this.eqNodes.length) return false;   // needs a rebuild

    const t = ctx.currentTime;
    for (let i = 0; i < active.length; i++) {
      const { node } = this.eqNodes[i];
      const b = active[i];
      if (node.type !== b.type) return false;                  // needs a rebuild
      node.frequency.setTargetAtTime(b.freq, t, 0.01);
      node.Q.setTargetAtTime(b.q || 0.707, t, 0.01);
      if (node.gain) node.gain.setTargetAtTime(b.gain, t, 0.01);
      this.eqNodes[i].band = b;
    }
    return true;
  }

  /* Rebuild the EQ when its shape changed — a band switched on or off, so the
     node count no longer matches. Playback is restarted at the current
     position rather than from the top, so the change is still an A/B. */
  rebuildEq() {
    if (!this.playing) return;
    const at = this.currentTime();
    this.pause();
    this.offset = at;
    this.play();
  }

  /* -------------------------------------------------------------- EQ TWO --
   * A second equaliser, cascading after the first, the way two units bolted
   * into a rack cascade.
   *
   * It is a SEPARATE DEVICE, not a second view of the first: it has its own
   * bands (window.StudioEq2), its own patch state, and its own bypass. The
   * first EQ owns `window.StudioEq` and nothing here touches that global —
   * two panels writing one band list would fight, each overwriting the
   * other's knob on the next publish.
   *
   * No trim node here. The first EQ's auto gain compensation already stands
   * before the filters and is computed from the whole monitor path's worst
   * case; a second trim would attenuate twice and deliver a monitor quieter
   * than the source. The rack's maximizer, when patched, is what holds the
   * ceiling for everything downstream.
   */
  buildEq2(ctx) {
    const bands = (window.StudioEq2 && window.StudioEq2.bands) || [];
    const active = activeEqBands(bands);

    this.eq2Nodes = [];
    if (!active.length || this.eq2Bypassed) {
      const pass = ctx.createGain();
      this.eq2Input = this.eq2Output = pass;
      return { input: pass, output: pass };
    }

    let head = null, tail = null;
    for (const b of active) {
      const node = ctx.createBiquadFilter();
      node.type = b.type;
      node.frequency.value = b.freq;
      if (b.type !== 'highpass' && b.type !== 'lowpass') node.gain.value = b.gain;
      node.Q.value = b.q || 0.707;
      if (tail) tail.connect(node); else head = node;
      tail = node;
      this.eq2Nodes.push({ node, band: b });
    }
    this.eq2Input = head;
    this.eq2Output = tail;
    return { input: head, output: tail };
  }

  /* Retune EQ 2 in place. Same contract as updateEq: false means the shape
   * changed and the graph has to be rebuilt. */
  updateEq2(bands) {
    const ctx = this.ctx;
    if (!ctx || !this.eq2Nodes) return false;
    const active = activeEqBands(bands);
    if (active.length !== this.eq2Nodes.length) return false;
    const t = ctx.currentTime;
    for (let i = 0; i < active.length; i++) {
      const { node } = this.eq2Nodes[i];
      const b = active[i];
      if (node.type !== b.type) return false;
      node.frequency.setTargetAtTime(b.freq, t, 0.01);
      node.Q.setTargetAtTime(b.q || 0.707, t, 0.01);
      if (node.gain) node.gain.setTargetAtTime(b.gain, t, 0.01);
      this.eq2Nodes[i].band = b;
    }
    return true;
  }

  rebuildEq2() {
    if (!this.playing) return;
    const at = this.currentTime();
    this.pause();
    this.offset = at;
    this.play();
  }

  setEq2Bypass(on) {
    this.eq2Bypassed = !!on;
    if (this.playing) this.rebuildEq2();
  }

  /* ---------------------------------------------------------------- RACK --
   * The mastering suite, live: compressor, stereo imager, maximizer and soft
   * clip, in MClass's device order — the same order maximize.py emits.
   *
   * Built as an {input, output} block, exactly like buildEq(), because the
   * router below chains blocks and does not care what is inside one. That is
   * what makes the wiring optional: a device the user has unpatched is simply
   * a block the router skips, and back-panel cables later become a change to
   * the router rather than to any device.
   *
   * THREE PLACES THE BROWSER CANNOT MATCH THE CLI. These are surfaced in the
   * panel rather than clamped silently, because a knob that reads 2.4 s while
   * doing 1.0 s is the kind of lie that costs an afternoon:
   *
   *   1. Compressor release. ffmpeg allows 9 s; DynamicsCompressorNode caps
   *      at 1 s. Anything above is previewed at 1 s and marked approximate.
   *   2. The limiter. There is no limiter node. Built here from a DelayNode
   *      (look-ahead) into a hard-kneed 20:1 compressor. Measured: a source
   *      reaching 0 dBFS came out at -0.05 dBFS.
   *   3. The stereo imager. No node does mid/side, so it is built from a
   *      splitter, gain stages and a merger.
   *
   * The CLI remains the authority. This is a monitor path: it writes nothing,
   * and `music maximize` is what actually renders.
   */
  buildRack(ctx) {
    const s = (window.StudioRack && window.StudioRack.settings) || null;
    if (!s || this.rackBypassed) {
      const pass = ctx.createGain();
      this.rackNodes = null;
      this.rackInput = this.rackOutput = pass;
      return { input: pass, output: pass };
    }

    const nodes = {};
    const blocks = [];

    if (s.comp) {
      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = __S.clamp(s.comp_threshold, -100, 0);
      comp.ratio.value = __S.clamp(s.comp_ratio, 1, 20);
      comp.knee.value = __S.clamp(s.comp_knee, 0, 40);
      comp.attack.value = __S.clamp(s.comp_attack / 1000, 0, 1);
      // The release divergence. clamp() is what makes it a preview rather
      // than a lie; the panel reads rackApprox() to say so on screen.
      comp.release.value = __S.clamp(s.comp_release / 1000, 0, 1);
      nodes.comp = comp;
      // Makeup gain is a separate node: the browser compressor has none.
      if (s.comp_makeup) {
        const mk = ctx.createGain();
        mk.gain.value = Math.pow(10, s.comp_makeup / 20);
        comp.connect(mk);
        nodes.compMakeup = mk;
        blocks.push({ input: comp, output: mk });
      } else {
        blocks.push({ input: comp, output: comp });
      }
    }

    if (s.imager) blocks.push(this._buildImager(ctx, s, nodes));
    if (s.maximize) blocks.push(this._buildMaximizer(ctx, s, nodes));
    if (s.soft_clip) blocks.push(this._buildSoftClip(ctx, s, nodes));

    this.rackNodes = nodes;
    return this._chain(ctx, blocks, 'rack');
  }

  /* Stereo imager: split to L/R, derive mid and side, scale the side by the
   * width, and sum back. A crossover would need two of these on either side
   * of a filter pair; the CLI's xover is not previewed, which rackApprox()
   * reports. Width 0 is mono, 1 is as recorded, above 1 is wider. */
  _buildImager(ctx, s, nodes) {
    const input = ctx.createGain();
    const split = ctx.createChannelSplitter(2);
    const merge = ctx.createChannelMerger(2);

    /* mid = (L+R)/2, side = (L-R)/2, then L = mid + w·side, R = mid - w·side.
     *
     * Every gain here is explicit rather than folded into a shared node.
     * Measured, the folded version was wrong twice over: a `side` node that
     * was itself 0.5 halved an already-halved difference, while feeding both
     * the positive and the inverted side into the merger double-counted it.
     * Width 1 came out at L=0.525/R=0.075 from a 0.5/0.1 input — audibly
     * wider when it should have been bit-transparent. Width 1 is now asserted
     * transparent by the offline check. */
    const g = (v) => { const n = ctx.createGain(); n.gain.value = v; return n; };

    const mid = g(1);            // sums 0.5L + 0.5R from the two feeds below
    const side = g(1);           // sums 0.5L - 0.5R

    const midL = g(0.5), midR = g(0.5);
    const sideL = g(0.5), sideR = g(-0.5);

    input.connect(split);
    split.connect(midL, 0); split.connect(midR, 1);
    midL.connect(mid); midR.connect(mid);
    split.connect(sideL, 0); split.connect(sideR, 1);
    sideL.connect(side); sideR.connect(side);

    // Width acts on the side signal only, which is what "width" means.
    const width = g(__S.clamp(s.hi_width, 0, 2));
    side.connect(width);

    // L = mid + side, R = mid - side. The inversion is its own node so the
    // side signal is counted exactly once per output channel.
    const negS = g(-1);
    width.connect(negS);

    const outL = g(1), outR = g(1);
    mid.connect(outL); width.connect(outL);
    mid.connect(outR); negS.connect(outR);
    outL.connect(merge, 0, 0);
    outR.connect(merge, 0, 1);

    nodes.width = width;
    return { input, output: merge };
  }

  /* Maximizer: input gain, look-ahead, gain riding, then a ceiling.
   *
   * There is no limiter node, so this is built from three. The DelayNode is
   * the look-ahead: the gain computer sees a transient before the signal it
   * is about to act on arrives. The compressor does the musical part, riding
   * the level down over milliseconds the way a limiter's release does.
   *
   * THE COMPRESSOR ALONE IS NOT A CEILING. Measured, driving a -1.0 dBFS
   * threshold: +0.38 dBFS at 6 dB of drive and +1.195 dBFS at 12 dB — it
   * overshoots further the harder it is pushed, because ratio 20:1 is a slope
   * and not a wall. That is the same failure `alimiter` has in the CLI, and
   * the reason invariant 1 exists.
   *
   * So a hard-clipping WaveShaper backstops it at exactly the asked-for
   * ceiling. Measured with the backstop: -0.978 dBFS at 6 dB of drive and
   * -0.991 at 12 dB — the ceiling holds however hard the input is driven,
   * which is the whole job. The compressor keeps the clipper from doing
   * audible work; the clipper keeps the compressor honest.
   *
   * Unlike the CLI this may end the chain: the browser writes no file, so an
   * intersample peak has nothing to damage past the monitor path. Invariant 1
   * governs what master.py emits and is untouched. */
  _buildMaximizer(ctx, s, nodes) {
    const input = ctx.createGain();
    input.gain.value = Math.pow(10, __S.clamp(s.input_gain, -12, 12) / 20);

    const delay = ctx.createDelay(0.05);
    delay.delayTime.value = s.look_ahead ? 0.004 : 0;   // MClass's 4 ms

    const ceiling = __S.clamp(s.limit, -60, 0);
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = ceiling;
    lim.ratio.value = 20;
    lim.knee.value = 0;                                 // no soft shoulder
    lim.attack.value = (RACK_LIMIT_ATTACK[s.limit_attack] ?? 0.5) / 1000;
    lim.release.value = (RACK_LIMIT_RELEASE[s.limit_release] ?? 100) / 1000;

    const wall = ctx.createWaveShaper();
    wall.curve = hardCeilingCurve(ceiling);
    wall.oversample = '4x';

    input.connect(delay);
    delay.connect(lim);
    lim.connect(wall);
    nodes.limiter = lim;
    nodes.inputGain = input;
    nodes.wall = wall;
    return { input, output: wall };
  }

  /* Soft clip: a WaveShaper with the curve the CLI names, at 4x oversampling
   * so the curve's own harmonics do not alias back down. */
  _buildSoftClip(ctx, s, nodes) {
    const ws = ctx.createWaveShaper();
    ws.curve = softClipCurve(s.soft_clip, s.clip_amount, s.clip_threshold);
    ws.oversample = s.clip_oversample >= 4 ? '4x'
      : (s.clip_oversample >= 2 ? '2x' : 'none');
    nodes.clip = ws;
    return { input: ws, output: ws };
  }

  /* Wire a list of blocks head to tail and return the pair. An empty list is
   * a passthrough, so a rack with every device unpatched still has an input
   * and an output for the router to use. */
  _chain(ctx, blocks, which) {
    if (!blocks.length) {
      const pass = ctx.createGain();
      this[which + 'Input'] = this[which + 'Output'] = pass;
      return { input: pass, output: pass };
    }
    for (let i = 0; i < blocks.length - 1; i++) {
      blocks[i].output.connect(blocks[i + 1].input);
    }
    const input = blocks[0].input;
    const output = blocks[blocks.length - 1].output;
    this[which + 'Input'] = input;
    this[which + 'Output'] = output;
    return { input, output };
  }

  /* Which settings the browser is only approximating, for the panel to show.
   * Returns [{knob, asked, preview, why}]. Empty means the preview is exact. */
  rackApprox() {
    const s = (window.StudioRack && window.StudioRack.settings) || null;
    const out = [];
    if (!s) return out;
    if (s.comp && s.comp_release > 1000) {
      out.push({
        knob: 'comp_release', asked: s.comp_release, preview: 1000,
        why: 'WebAudio caps compressor release at 1 s; the CLI allows 9 s.',
      });
    }
    if (s.comp && s.comp_adaptive) {
      out.push({
        knob: 'comp_adaptive', asked: 'on', preview: 'off',
        why: 'No adaptive release in the browser; the render has it.',
      });
    }
    if (s.imager) {
      out.push({
        knob: 'xover', asked: s.xover, preview: null,
        why: 'The CLI splits the band here and widens each half separately; '
           + 'the preview has one width across the whole range.',
      });
      /* The preview applies hi_width to everything, so a low width that
         differs is doing nothing you can hear. Reported only when it actually
         differs: flagging lo_width on every widened master, including the
         common case where both halves match, would train the eye to skip the
         notice — and then the two entries that matter go unread with it. */
      if (Math.abs((s.lo_width ?? 1) - (s.hi_width ?? 1)) > 0.005) {
        out.push({
          knob: 'lo_width', asked: s.lo_width, preview: s.hi_width,
          why: 'The preview widens the whole band by the high width; only the '
             + 'render treats the low band separately.',
        });
      }
    }
    return out;
  }

  /* Live gain reduction, in dB, for the panel's meters. Negative is
   * reduction. Null when the device is not in the chain. */
  rackReduction() {
    const n = this.rackNodes;
    if (!n) return { comp: null, limiter: null };
    return {
      comp: n.comp ? n.comp.reduction : null,
      limiter: n.limiter ? n.limiter.reduction : null,
    };
  }

  /* Rebuild the rack when its shape changed — a device switched on or off.
   * Same restart-in-place as the EQ, so a change stays an A/B. */
  rebuildRack() {
    if (!this.playing) return;
    const at = this.currentTime();
    this.pause();
    this.offset = at;
    this.play();
  }

  /* Retune the rack without rebuilding, when only values moved. Returns
   * false when the shape changed and a rebuild is needed. */
  updateRack() {
    const ctx = this.ctx, n = this.rackNodes;
    const s = (window.StudioRack && window.StudioRack.settings) || null;
    if (!ctx || !n || !s) return false;
    const t = ctx.currentTime;
    const ramp = (param, v) => {
      try { param.setTargetAtTime(v, t, 0.01); } catch (_) { /* detached */ }
    };
    // A device appearing or disappearing is a shape change.
    if (!!s.comp !== !!n.comp) return false;
    if (!!s.maximize !== !!n.limiter) return false;
    if (!!s.soft_clip !== !!n.clip) return false;
    if (!!s.imager !== !!n.width) return false;
    if (s.comp && !!s.comp_makeup !== !!n.compMakeup) return false;

    if (n.comp) {
      ramp(n.comp.threshold, __S.clamp(s.comp_threshold, -100, 0));
      ramp(n.comp.ratio, __S.clamp(s.comp_ratio, 1, 20));
      ramp(n.comp.knee, __S.clamp(s.comp_knee, 0, 40));
      ramp(n.comp.attack, __S.clamp(s.comp_attack / 1000, 0, 1));
      ramp(n.comp.release, __S.clamp(s.comp_release / 1000, 0, 1));
    }
    if (n.compMakeup) ramp(n.compMakeup.gain, Math.pow(10, s.comp_makeup / 20));
    if (n.width) ramp(n.width.gain, __S.clamp(s.hi_width, 0, 2));
    if (n.inputGain) {
      ramp(n.inputGain.gain, Math.pow(10, __S.clamp(s.input_gain, -12, 12) / 20));
    }
    if (n.limiter) {
      ramp(n.limiter.threshold, __S.clamp(s.limit, -60, 0));
      ramp(n.limiter.attack, (RACK_LIMIT_ATTACK[s.limit_attack] ?? 0.5) / 1000);
      ramp(n.limiter.release, (RACK_LIMIT_RELEASE[s.limit_release] ?? 100) / 1000);
      /* The ceiling moves with the threshold. Retuning one without the other
         left the wall where it was, so turning the limit knob down changed
         the gain riding while the actual ceiling stayed put. */
      if (n.wall) n.wall.curve = hardCeilingCurve(__S.clamp(s.limit, -60, 0));
    }
    if (n.clip) {
      // The curve is a buffer, not a param: swapped whole, no ramp available.
      n.clip.curve = softClipCurve(s.soft_clip, s.clip_amount, s.clip_threshold);
    }
    return true;
  }

  /* Bypass the whole rack, for comparing the suite against the source. */
  setRackBypass(on) {
    this.rackBypassed = !!on;
    if (this.playing) this.rebuildRack();
  }

  /* Bypass, for comparing the EQ against the source. */
  setEqBypass(on) {
    this.eqBypassed = !!on;
    /* The trim follows the bypass: out of bypass it comes back to whatever
       the panel last asked for, in bypass it goes to unity. Done before the
       rebuild so the new chain is built with the right value already set. */
    if (this.eqTrim && this.ctx) {
      try {
        this.eqTrim.gain.setTargetAtTime(
          this._eqTrimLinear(), this.ctx.currentTime, 0.01);
      } catch (_) { /* node detached */ }
    }
    if (this.playing) this.rebuildEq();
  }

  play() {
    const ctx = this.ensureContext();
    if (ctx.state === 'suspended') ctx.resume();
    if (!this.buffer || this.playing) return;

    const { analyser, proc, gain } = this.buildGraph();
    const src = ctx.createBufferSource();
    src.buffer = this.buffer;

    /* The EQ sits between the gain stage and everything downstream, so the
     * meters read the equalised signal — what you hear is what they measure.
     * With no bands active, eqIn and eqOut are the same node and this is a
     * plain passthrough. */
    const { input: eqIn, output: eqOut } = this.buildEq(ctx);

    /* The router. Each stage is an {input, output} block, and only the
     * patched ones are wired — an unpatched rack is not a bypassed device in
     * the path, it is absent from the path. Order follows MClass and the CLI:
     * EQ, then the suite. The meters sit at the end, so they always read what
     * is actually audible however the blocks are patched. */
    let tail = eqOut;
    /* EQ 2 sits between the first equaliser and the suite — two units in a
     * rack, in the order they are bolted in. Tone before dynamics, so the
     * compressor reacts to the signal you actually shaped. */
    if (this.eq2Enabled) {
      const { input: eq2In, output: eq2Out } = this.buildEq2(ctx);
      tail.connect(eq2In);
      tail = eq2Out;
    } else {
      this.eq2Nodes = null;
    }
    if (this.rackEnabled) {
      const { input: rackIn, output: rackOut } = this.buildRack(ctx);
      tail.connect(rackIn);
      tail = rackOut;
    } else {
      this.rackNodes = null;
    }

    src.connect(gain);
    gain.connect(eqIn);
    tail.connect(analyser);
    analyser.connect(proc);
    proc.connect(ctx.destination);   // silent, keeps the processor pulling
    tail.connect(ctx.destination);   // the audible path

    /* `onended` fires on a later task, not inside stop(), so a flag that pause()
       clears on the next line is already false by the time this runs — which is
       how pausing came to rewind to zero. Asking instead whether this node is
       still the transport's current source settles it: after a deliberate stop
       it is not (pause() and _teardown() drop it), and only a source that played
       out to its own end is. */
    src.onended = () => {
      if (this.source !== src) return;   // stopped by hand, not the end of the file
      this.playing = false;
      this.offset = 0;
      if (this.onended) this.onended();
    };
    src.start(0, this.offset);
    this.source = src;
    this.startedAt = ctx.currentTime;
    this.playing = true;
  }

  pause() {
    if (!this.playing) return;
    this.offset = this.currentTime();
    const src = this.source;
    /* Drop our claim on the node before stopping it, so the `onended` this
       provokes can see it is no longer the current source and leave the
       playhead where the pause put it. */
    this.source = null;
    this.playing = false;
    try { if (src) src.stop(); } catch (_) { /* already stopped */ }
    this._teardown(src);
  }

  /** @param {AudioBufferSourceNode} [src]  a source already detached by pause() */
  _teardown(src) {
    for (const n of [src || this.source, this.gain, this.eqTrim, this.analyser, this.proc]) {
      if (n) { try { n.disconnect(); } catch (_) { /* not connected */ } }
    }
    /* The rack's own nodes. Missing these left the previous chain still wired
       to ctx.destination after a rebuild, so the old settings stayed audible
       underneath the new ones. */
    for (const n of [this.rackInput, this.rackOutput, this.eq2Input, this.eq2Output]) {
      if (n) { try { n.disconnect(); } catch (_) { /* not connected */ } }
    }
    for (const e of this.eq2Nodes || []) {
      if (e && e.node) { try { e.node.disconnect(); } catch (_) { /* not connected */ } }
    }
    this.eq2Nodes = null;
    for (const n of Object.values(this.rackNodes || {})) {
      if (n) { try { n.disconnect(); } catch (_) { /* not connected */ } }
    }
    this.rackNodes = null;
    if (this.proc) this.proc.onaudioprocess = null;
    this.source = null;
  }

  seek(sec) {
    const was = this.playing;
    if (was) this.pause();
    this.offset = __S.clamp(sec, 0, this.duration());
    this.resetMeters();
    if (was) this.play();
  }

  currentTime() {
    if (!this.buffer) return 0;
    if (!this.playing) return this.offset;
    return __S.clamp(this.offset + (this.ctx.currentTime - this.startedAt), 0, this.duration());
  }

  duration() { return this.buffer ? this.buffer.duration : 0; }
}


/* Published for the files that load after this one. */
Object.assign(__S, { Engine });
})(window.__studio || (window.__studio = {}));
