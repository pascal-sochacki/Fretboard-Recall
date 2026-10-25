// SPDX-License-Identifier: MIT
(function (root) {
  'use strict';

  const NATURAL_NAMES = ['C', null, 'D', null, 'E', 'F', null, 'G', null, 'A', null, 'B'];
  const NAMES = ['C', 'C♯ / D♭', 'D', 'D♯ / E♭', 'E', 'F', 'F♯ / G♭', 'G', 'G♯ / A♭', 'A', 'A♯ / B♭', 'B'];
  const ACCIDENTAL_NAMES = {
    1: ['C♯', 'D♭'], 3: ['D♯', 'E♭'], 6: ['F♯', 'G♭'],
    8: ['G♯', 'A♭'], 10: ['A♯', 'B♭'],
  };
  const mod = n => ((n % 12) + 12) % 12;
  const noteName = (midi, random = Math.random) => {
    const pitch = mod(midi);
    if (NATURAL_NAMES[pitch]) return NATURAL_NAMES[pitch];
    return ACCIDENTAL_NAMES[pitch][random() < 0.5 ? 0 : 1];
  };
  const seconds = ms => `${(ms / 1000).toFixed(2)} s`;
  const SILENCE_MS = 180;
  const HOLD_MS = 120;
  const MAX_GAP_MS = 100;
  const QUIET = 0.02;
  const LOUD = 0.04;
  const LIVE_EXPIRES_MS = 350;
  const STORAGE_KEY = 'fretboard_recall.records.v1';
  const RANDOM_RECORD_SUFFIX = ':random';
  const midiFrequency = (midi, referencePitch) => referencePitch * 2 ** ((midi - 69) / 12);

  function snapshotSetup(state, tunings, random = Math.random) {
    if (!state || !['guitar', 'bass'].includes(state.instrument)) throw new Error('Unsupported or unavailable instrument. Select guitar or bass in FeedBack.');
    const supported = state.instrument === 'guitar' ? [6, 7, 8] : [4, 5, 6];
    if (!supported.includes(state.stringCount)) throw new Error('Unsupported string count.');
    if (!Array.isArray(state.offsets) || state.offsets.length !== state.stringCount || !state.offsets.every(Number.isInteger)) {
      throw new Error('Current tuning is unavailable or unresolved. Choose your tuning in the FeedBack tuner, then retry.');
    }
    if (!Number.isFinite(state.referencePitch) || state.referencePitch < 400 || state.referencePitch > 480) throw new Error('Unsupported reference pitch.');
    const key = `${state.instrument}-${state.stringCount}`;
    const base = tunings?.tuningMidis?.[key]?.Standard;
    if (!Array.isArray(base) || base.length !== state.stringCount || !base.every(Number.isInteger)) throw new Error('FeedBack did not supply an exact standard string mapping (/api/tunings tuningMidis). Update FeedBack and retry.');
    const opens = base.map((m, i) => m + state.offsets[i]);
    if (!opens.every(m => m >= 0 && m + 11 <= 127)) throw new Error('Tuning exceeds the supported pitch range.');
    const strings = opens.map((midi, index) => ({
      index, midi,
      label: `String ${state.stringCount - index} · ${noteName(midi, random)}${Math.floor(midi / 12) - 1}${index === 0 ? ' · lowest-side' : index === opens.length - 1 ? ' · highest-side' : ''}`,
    })).reverse();
    const setup = { instrument: state.instrument, stringCount: state.stringCount, offsets: state.offsets.slice(), referencePitch: state.referencePitch, strings };
    setup.key = JSON.stringify([setup.instrument, setup.stringCount, setup.offsets, setup.referencePitch, strings.map(s => [s.index, s.midi])]);
    return setup;
  }

  function choosePitch(previous, random) {
    const n = Math.floor(random() * (previous === null ? 12 : 11));
    return previous === null || n < previous ? n : n + 1;
  }

  class Round {
    constructor(setup, random = Math.random, { randomMode = false } = {}) {
      this.setup = setup;
      this.random = random;
      this.mode = randomMode ? 'random' : 'standard';
      this.pass = 0;
      this.string = 0;
      this.liveSpellings = new Map();
      if (this.mode === 'random') this.chooseRandomPrompt();
      else this.pitch = choosePitch(null, random);
      this.updatePromptSpelling();
      this.answers = [];
      this.elapsed = 0;
      this.promptAt = 0;
      this.paused = false;
      this.done = false;
      this.lastCaptureTime = null;
      this.resetGate();
    }
    chooseRandomPrompt() {
      this.pitch = Math.floor(this.random() * 12);
      this.string = Math.floor(this.random() * this.setup.stringCount);
    }
    resetGate() {
      this.armed = false;
      this.quietAt = null;
      this.correctAt = null;
      this.lastSample = null;
    }
    target() {
      // Keep the canonical setup/record mapping high-side first; practice starts on the low physical side.
      const s = this.setup.strings[this.setup.stringCount - 1 - this.string];
      return { ...s, pitch: this.pitch, midi: s.midi + mod(this.pitch - s.midi) };
    }
    updatePromptSpelling() {
      this.promptSpelling = noteName(this.pitch, this.random);
    }
    detectedName(midi) {
      const pitch = mod(midi);
      if (!this.liveSpellings.has(pitch)) this.liveSpellings.set(pitch, noteName(pitch, this.random));
      return this.liveSpellings.get(pitch);
    }
    tick(dt) { if (!this.paused && !this.done) this.elapsed += dt; }
    pause(value) { this.paused = value; this.resetGate(); }
    sample({ level, midi, confidence, captureTime }, now) {
      if (this.paused || this.done) return false;
      if (!Number.isFinite(captureTime) || (this.lastCaptureTime !== null && captureTime <= this.lastCaptureTime)) {
        this.resetGate();
        return false;
      }
      this.lastCaptureTime = captureTime;
      if (!Number.isFinite(level) || level < 0 || level > 1) { this.resetGate(); return false; }
      if (this.lastSample !== null && now - this.lastSample > MAX_GAP_MS) this.resetGate();
      this.lastSample = now;
      if (!this.armed) {
        if (level >= QUIET) { this.quietAt = null; return false; }
        if (this.quietAt === null) this.quietAt = now;
        if (now - this.quietAt >= SILENCE_MS) this.armed = true;
        return false;
      }
      const match = level >= LOUD && Number.isFinite(midi) && confidence >= 0.7 && Math.abs(midi - this.target().midi) <= 0.35;
      if (!match) { this.correctAt = null; return false; }
      if (this.correctAt === null) this.correctAt = now;
      if (now - this.correctAt < HOLD_MS) return false;
      const target = this.target();
      this.answers.push({ stringIndex: target.index, pitch: mod(target.pitch), durationMs: this.elapsed - this.promptAt });
      if (this.mode === 'random') {
        if (this.answers.length === 5 * this.setup.stringCount) this.done = true;
        else { this.chooseRandomPrompt(); this.updatePromptSpelling(); }
        this.resetGate();
        return true;
      }
      this.string++;
      let newPitch = false;
      if (this.string === this.setup.stringCount) {
        this.string = 0;
        this.pass++;
        if (this.pass === 5) this.done = true;
        else { this.pitch = choosePitch(this.pitch, this.random); newPitch = true; }
      }
      if (newPitch) this.updatePromptSpelling();
      this.resetGate();
      return true;
    }
    displayed() { this.promptAt = this.elapsed; }
    summary() {
      if (!this.done) throw new Error('Incomplete rounds are not records.');
      const totalMs = this.answers.reduce((sum, a) => sum + a.durationMs, 0);
      return {
        completedAt: new Date().toISOString(), totalMs,
        averageMs: totalMs / this.answers.length,
        answers: this.answers.map(answer => ({ ...answer })),
        strings: this.setup.strings.map(s => {
          const answers = this.answers.filter(a => a.stringIndex === s.index);
          const totalMs = answers.reduce((sum, a) => sum + a.durationMs, 0);
          return { index: s.index, label: s.label, ...(this.mode === 'random' ? { count: answers.length } : {}), totalMs, averageMs: answers.length ? totalMs / answers.length : null };
        }),
        ...(this.mode === 'random' ? { mode: this.mode } : {}),
      };
    }
  }

  function validRecord(record, setup) {
    if (!record || !Number.isSafeInteger(record.completed) || record.completed < 0 || !Number.isFinite(record.bestMs) || record.bestMs < 0 || !record.latest || typeof record.latest !== 'object') return false;
    if (record.runs === undefined) return true;
    if (!Array.isArray(record.runs) || record.runs.length > 100 || record.runs.length > record.completed) return false;
    return record.runs.every(run => {
      if (!run || typeof run.completedAt !== 'string' || !Number.isFinite(Date.parse(run.completedAt)) || !Number.isFinite(run.totalMs) || run.totalMs < 0 || !Number.isFinite(run.averageMs) || !Array.isArray(run.answers) || run.answers.length !== setup.stringCount * 5) return false;
      let totalMs = 0;
      for (const answer of run.answers) {
        if (!answer || !Number.isInteger(answer.pitch) || answer.pitch < 0 || answer.pitch >= 12 || !Number.isInteger(answer.stringIndex) || !setup.strings.some(string => string.index === answer.stringIndex) || !Number.isFinite(answer.durationMs) || answer.durationMs < 0) return false;
        totalMs += answer.durationMs;
      }
      const tolerance = Math.max(1e-6, Math.abs(run.totalMs) * 1e-9);
      return Math.abs(totalMs - run.totalMs) <= tolerance && Math.abs(run.averageMs - run.totalMs / run.answers.length) <= Math.max(1e-6, Math.abs(run.averageMs) * 1e-9);
    });
  }

  function readRecord(storage, setup, mode = 'standard') {
    const records = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid local records.');
    const key = mode === 'random' ? `${setup.key}${RANDOM_RECORD_SUFFIX}` : setup.key;
    const record = records[key];
    if (record && !validRecord(record, setup)) throw new Error('Invalid local record for this setup.');
    return record ? { ...record, runs: record.runs || [] } : { completed: 0, runs: [] };
  }

  function storeRecord(storage, setup, result, mode = 'standard') {
    let records = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid local records.');
    if (!['standard', 'random'].includes(mode)) throw new Error('Invalid round mode.');
    const key = mode === 'random' ? `${setup.key}${RANDOM_RECORD_SUFFIX}` : setup.key;
    const old = records[key];
    if (old && !validRecord(old, setup)) throw new Error('Invalid local record for this setup.');
    if (!Array.isArray(result.answers) || result.answers.length !== setup.stringCount * 5) throw new Error('Incomplete detailed round.');
    const completed = (old?.completed || 0) + 1;
    const run = { completedAt: result.completedAt, totalMs: result.totalMs, averageMs: result.averageMs, answers: result.answers.map(answer => ({ stringIndex: answer.stringIndex, pitch: answer.pitch, durationMs: answer.durationMs })) };
    const runs = [...(old?.runs || []), run].slice(-100);
    const next = { ...(old || {}), setup, ...(mode === 'random' ? { mode } : {}), completed, bestMs: old ? Math.min(old.bestMs, result.totalMs) : result.totalMs, latest: result, runs };
    if (!validRecord(next, setup)) throw new Error('Invalid completed round data.');
    records[key] = next;
    storage.setItem(STORAGE_KEY, JSON.stringify(records));
    return records[key];
  }

  async function resolveDesktopInput(win) {
    const audio = win.feedBackDesktop?.audio;
    if (!audio || typeof audio.getCurrentDevice !== 'function' || typeof audio.listSources !== 'function' || !win.navigator.mediaDevices?.enumerateDevices) throw new Error('Desktop input identity APIs unavailable. Update FeedBack Desktop and retry.');
    const [device, sources, devices] = await Promise.all([audio.getCurrentDevice(), audio.listSources(), win.navigator.mediaDevices.enumerateDevices()]);
    const primary = sources?.find(s => s.id === 0 && s.active && s.deviceKey === 0);
    if (!device?.input || !device.inputType || !primary || !Number.isInteger(primary.inputChannel) || ![-1, 0, 1].includes(primary.inputChannel)) throw new Error('Desktop selected input/channel cannot be mapped to Electron capture. Choose Mono or channel 1/2 in host Input Setup and retry.');
    // Browser device IDs and JUCE IDs are different namespaces. Do not infer
    // identity from substring/alias matches or choose the OS default device.
    const matches = devices.filter(d => d.kind === 'audioinput' && d.label.trim() === device.input.trim() && d.deviceId && !['default', 'communications'].includes(d.deviceId));
    if (matches.length !== 1) throw new Error('Configured native input has no unique exact-name Electron audio input. ASIO-only, differently named, duplicate, or permission-hidden inputs are unsupported without a host mapping API. Check OS microphone permission and host Input Setup, then retry.');
    return { deviceId: matches[0].deviceId, label: matches[0].label, channel: primary.inputChannel === -1 ? 'mono' : primary.inputChannel === 0 ? 'left' : 'right', nativeType: device.inputType, nativeInput: device.input, nativeChannel: primary.inputChannel };
  }

  async function openBrowser(win, setup, onSample, onError, cancelled, desktopConsent = null) {
    if (win.feedBackDesktop?.isDesktop && !desktopConsent) throw new Error('Desktop Electron capture requires explicit confirmation of the configured DI device/channel. Native ring polling is not used.');
    // The inspected classic note_detect script declares this host function at
    // global scope. Its public async snapshot has no estimate timestamp. Bind
    // this version-sensitive primitive explicitly or fail; never poll snapshots.
    const detect = win._ndYinDetect;
    if (typeof detect !== 'function') throw new Error('Synchronous host YIN primitive unavailable (_ndYinDetect). Enable the inspected classic Note Detection plugin or use a compatible host build; timestamp-free async pitch snapshots are unsupported.');
    if (!win.navigator.mediaDevices?.getUserMedia) throw new Error('Microphone access unavailable. Use HTTPS or localhost and allow microphone access.');
    const saved = desktopConsent || JSON.parse(win.localStorage.getItem('slopsmith_notedetect') || '{}');
    if (!['left', 'right', 'mono'].includes(saved.channel)) throw new Error('Configure an input channel in FeedBack Note Detection settings first.');
    if (typeof saved.deviceId !== 'string' || !saved.deviceId || ['default', 'communications'].includes(saved.deviceId)) throw new Error('Select an explicit browser input device in FeedBack Note Detection settings first. Default-device substitution is unsupported.');
    const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 2 };
    if (saved.deviceId) audio.deviceId = { exact: saved.deviceId };
    let stream, ctx, source, gain, splitter, meter, mute;
    let stopped = false;
    let lastCaptureTime = null;
    let identityTimer = null;
    let identityInFlight = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (identityTimer !== null) win.clearInterval(identityTimer);
      if (meter) meter.onaudioprocess = null;
      for (const node of [source, gain, splitter, meter, mute]) { try { node?.disconnect(); } catch (_) {} }
      stream?.getTracks().forEach(t => t.stop());
      if (ctx) ctx.close().catch(() => {});
    };
    try {
      if (desktopConsent) {
        const current = await resolveDesktopInput(win);
        if (JSON.stringify(current) !== JSON.stringify(desktopConsent)) throw new Error('Desktop input changed after confirmation. Retry and confirm the new host input.');
        if (cancelled()) { stop(); return { stop }; }
      }
      stream = await win.navigator.mediaDevices.getUserMedia({ audio });
      if (cancelled()) { stop(); return { stop }; }
      const AC = win.AudioContext || win.webkitAudioContext;
      ctx = new AC({ latencyHint: 'interactive' });
      await ctx.resume();
      if (cancelled()) { stop(); return { stop }; }
      if (ctx.state !== 'running') throw new Error('Audio is suspended. Retry from a user click.');
      const channel = saved.channel === 'left' ? 0 : saved.channel === 'right' ? 1 : -1;
      const track = stream.getAudioTracks()[0];
      if (!track || track.readyState !== 'live') throw new Error('Audio input is not live.');
      const settings = track.getSettings();
      if (settings.deviceId !== saved.deviceId) throw new Error('Browser did not confirm the selected input device. Choose a supported explicit input in host settings.');
      if (desktopConsent && track.label.trim() !== desktopConsent.label.trim()) throw new Error('Electron stream label does not match the confirmed native input. Capture stopped; no substitution is allowed.');
      if (channel >= 0 && !(settings.channelCount > channel)) throw new Error('Selected input channel cannot be verified on this device. Choose Mono in host settings or a supported input.');
      const minHz = Math.min(31, ...setup.strings.map(s => setup.referencePitch * 2 ** ((s.midi - 69) / 12)));
      if (!Number.isFinite(ctx.sampleRate) || ctx.sampleRate <= 0) throw new Error('Audio sample rate unavailable. This capture path is unsupported.');
      let frameSize = 4096;
      while (frameSize < 2 * ctx.sampleRate / minHz) frameSize *= 2;
      if (frameSize > 16384 || frameSize / ctx.sampleRate > 0.1) throw new Error('This tuning/sample-rate combination cannot provide sufficiently frequent resolved host YIN frames. Use a supported tuning or sample rate in host settings.');
      if (cancelled()) { stop(); return { stop }; }
      source = ctx.createMediaStreamSource(stream);
      gain = ctx.createGain();
      gain.gain.value = 1;
      if (channel >= 0) {
        splitter = ctx.createChannelSplitter(2);
        source.connect(splitter);
        splitter.connect(gain, channel, 0);
      } else source.connect(gain);
      meter = ctx.createScriptProcessor(frameSize, 1, 1);
      mute = ctx.createGain();
      mute.gain.value = 0;
      gain.connect(meter); meter.connect(mute); mute.connect(ctx.destination);
      meter.onaudioprocess = e => {
        if (stopped || cancelled()) return;
        try {
          if (ctx.state !== 'running' || track.readyState !== 'live' || track.muted) throw new Error('Audio input stopped or became unavailable. Retry after checking host input settings.');
          // playbackTime is a real Web Audio processing timestamp, NOT a native
          // capture timestamp. It only proves callback-buffer progression.
          const captureTime = e.playbackTime * 1000;
          if (!Number.isFinite(captureTime) || (lastCaptureTime !== null && captureTime <= lastCaptureTime)) throw new Error('Audio processing timestamps are missing or stopped advancing. This capture path is unsupported; check input and retry.');
          lastCaptureTime = captureTime;
          const samples = e.inputBuffer.getChannelData(0);
          if (samples.length !== frameSize) throw new Error('Incomplete live audio analysis frame.');
          const level = scaledRms(samples);
          // Synchronous host DSP consumes THIS callback's complete buffer.
          // Silence never reuses a previous pitch estimate or analysis window.
          const pitch = level >= LOUD ? detect(samples, ctx.sampleRate, minHz) : { freq: -1, confidence: 0 };
          if (!pitch || typeof pitch.then === 'function' || pitch.underBuffered) throw new Error('Host YIN primitive is incompatible or cannot resolve this frame. Async estimates are unsupported.');
          const midi = pitch.freq > 0 ? 69 + 12 * Math.log2(pitch.freq / setup.referencePitch) : null;
          onSample({ level, midi, confidence: pitch.confidence, captureTime });
        } catch (e) { stop(); onError(e); }
      };
      if (desktopConsent) {
        identityTimer = win.setInterval(async () => {
          if (stopped || cancelled() || identityInFlight) return;
          identityInFlight = true;
          try {
            const current = await resolveDesktopInput(win);
            if (stopped || cancelled()) return;
            if (JSON.stringify(current) !== JSON.stringify(desktopConsent)) throw new Error('Desktop host device/channel changed. Capture stopped; Retry and confirm the new input.');
          } catch (e) { if (!stopped && !cancelled()) { stop(); onError(e); } }
          finally { identityInFlight = false; }
        }, 250);
      }
      return { stop };
    } catch (e) { stop(); throw e; }
  }

  function scaledRms(samples) {
    if (!samples || !samples.length) throw new Error('Live input frames unavailable.');
    let sum = 0;
    for (const value of samples) {
      if (!Number.isFinite(value)) throw new Error('Invalid audio input frame.');
      sum += value * value;
    }
    return Math.min(1, Math.sqrt(sum / samples.length) * 5);
  }

  const logic = { Round, snapshotSetup, choosePitch, noteName, midiFrequency, readRecord, storeRecord, scaledRms, resolveDesktopInput, openBrowser, mount };
  if (typeof module !== 'undefined' && module.exports) { module.exports = logic; return; }
  if (root.__fretboardRecallLoaded) return;
  root.__fretboardRecallLoaded = true;

  let current = null;
  function start({ container }) {
    current?.stop();
    const session = mount(root, container);
    current = session;
    session.begin();
  }
  const spec = { id: 'fretboard_recall', title: 'Fretboard Recall', start, stop: () => { current?.stop(); current = null; } };
  if (root.feedBackMinigames) root.feedBackMinigames.register(spec);
  else (root.__feedBackMinigamesPending = root.__feedBackMinigamesPending || []).push(spec);

  function mount(win, container, random = Math.random) {
    const doc = win.document;
    container.innerHTML = `<section class="fr-game" aria-label="Fretboard Recall">
      <header class="fr-header"><div><p class="fr-eyebrow">One note. Every string.</p><h2>Fretboard Recall</h2></div><span class="fr-badge">5 passes · Local records</span></header>
      <p class="fr-setup">Reading your FeedBack setup…</p>
      <div class="fr-action-row"><label class="fr-mode"><input type="checkbox" class="fr-random-mode"> Random note + string</label>
      <div class="fr-controls"><button type="button" class="fr-input" hidden>Confirm desktop input</button><button type="button" class="fr-pause" disabled>Pause</button><button type="button" class="fr-retry">Start round</button><button type="button" class="fr-settings">Host settings</button><button type="button" class="fr-leave">Stop / Back to songs</button></div></div>
      <div class="fr-round-progress"><div class="fr-passes" aria-label="Five passes"></div><p class="fr-progress"></p><progress class="fr-completion" max="1" value="0" aria-label="Accepted answers"></progress></div>
      <div class="fr-cards">
         <section class="fr-target" aria-label="Requested note"><p class="fr-eyebrow">Your target · pitch class</p><div aria-live="polite" aria-atomic="true"><p class="fr-note"></p><p class="fr-string"></p></div><p class="fr-mute-cue" data-state="idle" role="status" aria-live="polite" aria-atomic="true"><span class="fr-mute-cue-icon" aria-hidden="true"></span><span class="fr-mute-cue-text"></span></p><button type="button" class="fr-hear" hidden>Hear note</button><p class="fr-audio-status" role="status" aria-live="polite"></p><p class="fr-hint">Find this note on the requested string. Frets 0–11. Each pass goes lowest-side to highest-side.</p></section>
        <section class="fr-live" aria-label="Live detected note"><p class="fr-eyebrow">Live input · detected note</p><p class="fr-detected">—</p><p class="fr-live-status">Not listening</p><p class="fr-hint">Reported pitch and octave only. Physical string is not detected.</p></section>
      </div>
       <section class="fr-strings-panel" aria-label="Physical strings, highest-side to lowest-side"><div class="fr-diagram-heading"><h3>Requested string</h3></div><p class="fr-side">Highest-side · string 1</p><ol class="fr-strings"></ol><p class="fr-side">Lowest-side</p></section>
      <div class="fr-feedback"><p class="fr-status" role="status"></p><p class="fr-clock"></p></div>
      <div class="fr-summary"></div>
      <section class="fr-history" aria-labelledby="fr-history-title"><h3 id="fr-history-title">Progress for this exact setup</h3><p class="fr-history-note">Saved on this browser/device only. Trends use accepted target answers and round time; the microphone does not identify a physical string or log incorrect notes.</p><p class="fr-history-status" role="status"></p><div class="fr-history-trend"></div><div class="fr-history-heatmap"></div><div class="fr-history-worst"></div></section>
      <p class="fr-warning">Play only the requested string within frets 0–11. Microphone/DI pitch cannot verify the physical string when the same pitch exists elsewhere. Use the requested string yourself. No string detection is claimed.</p>
    </section>`;
    const el = name => container.querySelector(`.fr-${name}`);
    const elements = new Map();
    const cached = name => { if (!elements.has(name)) elements.set(name, el(name)); return elements.get(name); };
    let generation = 0, adapter = null, round = null, setup = null, alive = true;
    let referenceContext = null, referenceTone = null, referenceUnlock = null, referenceAttempt = 0, promptAudioGeneration = 0;
    let clockTimer = null, lastClock = win.performance.now(), lastInput = lastClock;
    let error = false, acquiring = false, starting = false;
    let desktopInput = null;
    let stringRows = [], passSteps = [];
    let liveState = '', liveNote = '', liveAt = null;
    const host = win.feedBack;
    const quit = doc.getElementById('mg-stage-quit');
    const text = (name, value) => { const node = cached(name); if (node.textContent !== value) node.textContent = value; };
    function stopReferenceTone() {
      const tone = referenceTone;
      referenceTone = null;
      if (!tone) return;
      try { tone.oscillator.stop(); } catch (_) {}
      try { tone.oscillator.disconnect(); } catch (_) {}
      try { tone.gain.disconnect(); } catch (_) {}
    }
    function closeReferenceAudio() {
      stopReferenceTone();
      const context = referenceContext;
      referenceContext = null; referenceUnlock = null;
      if (context) { try { Promise.resolve(context.close()).catch(() => {}); } catch (_) {} }
    }
    function wakeReferenceAudio() {
      try {
        const AudioContext = win.AudioContext || win.webkitAudioContext;
        if (!AudioContext) return Promise.resolve(false);
        if (!referenceContext) referenceContext = new AudioContext();
        const context = referenceContext;
        if (context.state === 'running') return Promise.resolve(true);
        return Promise.resolve(context.resume()).then(() => context === referenceContext && context.state === 'running', () => false);
      } catch (_) { return Promise.resolve(false); }
    }
    async function playReferenceTone(manual = false) {
      const promptGeneration = promptAudioGeneration;
      const attempt = ++referenceAttempt;
      const target = round?.target();
      if (!target || !setup || round.paused || round.done || error || !alive) return;
      stopReferenceTone();
      const unlock = manual ? wakeReferenceAudio() : referenceUnlock || wakeReferenceAudio();
      if (!manual) referenceUnlock = null;
      const running = await unlock;
      if (!alive || attempt !== referenceAttempt || promptGeneration !== promptAudioGeneration || !round || round.paused || round.done || !running) {
        if (alive && attempt === referenceAttempt && promptGeneration === promptAudioGeneration && !running) text('audio-status', 'Reference tone was blocked or unavailable. Select Hear note to try again.');
        return;
      }
      const context = referenceContext;
      let oscillator, gain;
      try {
        oscillator = context.createOscillator(); gain = context.createGain();
        const now = context.currentTime;
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(midiFrequency(target.midi, setup.referencePitch), now);
        gain.gain.setValueAtTime(0, now);
        gain.gain.linearRampToValueAtTime(0.12, now + 0.015);
        gain.gain.linearRampToValueAtTime(0, now + 0.36);
        oscillator.connect(gain); gain.connect(context.destination);
        referenceTone = { oscillator, gain };
        oscillator.onended = () => {
          if (referenceTone?.oscillator !== oscillator) return;
          referenceTone = null;
          try { oscillator.disconnect(); } catch (_) {}
          try { gain.disconnect(); } catch (_) {}
        };
        oscillator.start(now); oscillator.stop(now + 0.37);
        text('audio-status', '');
      } catch (_) {
        if (oscillator) { try { oscillator.disconnect(); } catch (_) {} }
        if (gain) { try { gain.disconnect(); } catch (_) {} }
        referenceTone = null;
        text('audio-status', 'Reference tone is unavailable. The round can continue; select Hear note to try again.');
      }
    }
    function updateControls() {
      const active = !!round && !round.done && !error;
      el('random-mode').disabled = active || starting;
      el('hear').disabled = !active || round.paused;
      el('hear').hidden = !round || round.done;
      text('eyebrow', round?.mode === 'random' || (!round && el('random-mode').checked) ? 'Every prompt is independent.' : 'One note. Every string.');
      text('badge', `${round?.mode === 'random' || (!round && el('random-mode').checked) ? 'Random' : '5 passes'} · Local records`);
      text('retry', error ? 'Retry' : round?.done ? 'Play again' : starting ? 'Starting…' : round ? 'Restart round' : 'Start round');
      el('retry').disabled = starting;
    }
    function updateMuteCue() {
      let state = 'idle', message = 'Start a round to see when it is time to play.';
      if (error) { state = 'failed'; message = 'Input unavailable — check settings and retry.'; }
      else if (round?.done) { state = 'complete'; message = 'Round complete.'; }
      else if (round?.paused) { state = 'paused'; message = `Paused — resume, then mute all strings before playing String ${setup.stringCount - round.target().index}.`; }
      else if (round) {
        const number = setup.stringCount - round.target().index;
        if (round.armed) {
          state = 'armed';
          message = `Silence gate armed — now play String ${number}. Wrong notes do not advance; after a correct note, mute again for the next prompt.`;
        } else {
          state = 'waiting';
          message = `Mute all strings for 0.18 s to arm, then play String ${number}.`;
        }
      }
      const cue = cached('mute-cue');
      if (cue.getAttribute('data-state') !== state) cue.setAttribute('data-state', state);
      text('mute-cue-text', message);
    }
    el('random-mode').onchange = () => { updateControls(); if (setup) renderHistory(); };
    function setLive(state, note = '—') {
      if (liveState === state && liveNote === note) return;
      const labels = { stopped: 'Not listening', startup: 'Reading setup…', consent: 'Waiting for input confirmation', acquiring: 'Opening input…', listening: 'Listening · waiting for a fresh sample', silence: 'Silence · mute before each answer', quiet: 'Listening · signal too quiet for pitch detection', uncertain: 'Uncertain pitch · play one clear note', detected: 'Pitch detected · reported octave', paused: 'Paused · input display cleared', failed: 'Input unavailable · check settings and retry', complete: 'Round complete · input stopped', expired: 'Waiting for fresh audio · last pitch cleared' };
      liveState = state; liveNote = note;
      cached('live').setAttribute('data-state', state);
      text('detected', note); text('live-status', labels[state]);
    }
    function resetLive(state) { liveAt = null; setLive(state); }
    const release = () => { generation++; referenceAttempt++; promptAudioGeneration++; closeReferenceAudio(); adapter?.stop(); adapter = null; acquiring = false; starting = false; resetLive('stopped'); };
    const fail = e => {
      if (!alive || error) return;
      error = true;
      release();
      resetLive('failed');
      el('input').hidden = true;
      round?.pause(true);
      updateMuteCue();
      updateControls();
      text('status', `${e.message || e} No record saved. Check host settings, then Retry.`);
      el('pause').disabled = true;
    };
    const leave = e => {
      e?.preventDefault(); e?.stopImmediatePropagation();
      if (typeof host?.navigate !== 'function') { fail(new Error('Host navigation unavailable. Use the app navigation to leave.')); return; }
      release();
      host.navigate('home');
    };
    quit?.addEventListener('click', leave, true);
    el('leave').onclick = leave;
    el('settings').onclick = () => {
      if (!host?.navigate) { fail(new Error('Host settings navigation unavailable.')); return; }
      release(); host.navigate('settings');
    };

    function renderSetup() {
      stringRows = setup.strings.map(s => {
        const row = doc.createElement('li');
        row.className = 'fr-string-row';
        const number = doc.createElement('span'); number.className = 'fr-string-number'; number.textContent = `${setup.stringCount - s.index}`;
        const wire = doc.createElement('span'); wire.className = 'fr-wire'; wire.setAttribute('aria-hidden', 'true'); wire.style.setProperty('--fr-wire-width', `${1 + (setup.stringCount - s.index - 1) * 0.45}px`);
        const instruction = doc.createElement('span'); instruction.className = 'fr-string-instruction';
        row.setAttribute('aria-label', `String ${setup.stringCount - s.index}`);
        row.appendChild(number); row.appendChild(wire); row.appendChild(instruction);
        return { row, instruction };
      });
      cached('strings').replaceChildren(...stringRows.map(s => s.row));
      passSteps = Array.from({ length: 5 }, (_, i) => {
        const step = doc.createElement('span'); step.className = 'fr-pass'; step.textContent = `${i + 1}`; return step;
      });
      cached('passes').replaceChildren(...passSteps);
      cached('completion').max = 5 * setup.stringCount;
      renderHistory();
    }
    function node(tag, className, value) {
      const item = doc.createElement(tag);
      if (className) item.className = className;
      if (value !== undefined) item.textContent = value;
      return item;
    }
    function renderHistory() {
      const status = cached('history-status'), trend = cached('history-trend'), heatmap = cached('history-heatmap'), worst = cached('history-worst');
      trend.replaceChildren(); heatmap.replaceChildren(); worst.replaceChildren();
      let record;
      const mode = round && !round.done ? round.mode : el('random-mode').checked ? 'random' : 'standard';
      try { record = readRecord(win.localStorage, setup, mode); }
      catch (_) { status.textContent = 'Saved progress could not be read (storage unavailable or corrupted). Existing records were not changed.'; return; }
      status.textContent = record.runs.length ? `${record.completed} completed rounds · personal best ${seconds(record.bestMs)} · showing up to the latest 100 detailed rounds. Older aggregate totals are retained; older answer details are not available.` : record.completed ? `${record.completed} older round${record.completed === 1 ? '' : 's'} saved · best ${seconds(record.bestMs)}. Detailed charts start with your next completed round.` : 'No saved rounds for this exact setup yet.';
      if (!record.runs.length) return;

      const heading = node('h4', '', 'Round time trend · oldest to newest');
      trend.appendChild(heading);
       const chart = node('div', 'fr-trend-chart');
       chart.setAttribute('role', 'img');
       chart.setAttribute('aria-label', `Round-time trend chart, oldest to newest, ${record.runs.length} rounds. Open the ordered round list for exact times.`);
       const maxMs = Math.max(...record.runs.map(run => run.totalMs), 1);
       const roundDetails = node('details', 'fr-trend-details');
       roundDetails.appendChild(node('summary', '', 'View exact round times · oldest to newest'));
       const list = node('ol', 'fr-trend');
       record.runs.forEach((run, index) => {
         const date = new Date(run.completedAt);
         const roundNumber = record.completed - record.runs.length + index + 1;
         const label = Number.isNaN(date.getTime()) ? `Round ${roundNumber}` : `Round ${roundNumber} · ${date.toLocaleDateString()}`;
         const bar = node('span', 'fr-trend-bar');
         bar.setAttribute('aria-hidden', 'true'); bar.style.setProperty('--fr-bar-height', `${Math.max(3, run.totalMs / maxMs * 36)}px`);
         chart.appendChild(bar);
         list.appendChild(node('li', 'fr-trend-label', `${label}: ${seconds(run.totalMs)}`));
       });
       roundDetails.appendChild(list);
       trend.appendChild(chart); trend.appendChild(roundDetails);

      heatmap.appendChild(node('h4', '', 'Target pitch class by physical string'));
      heatmap.appendChild(node('p', 'fr-history-note', 'Cells show average / slowest time in seconds · accepted-answer count · intensity level (for example, 1.20 / 2.40 · 3 · L2). Rows are requested strings, highest-side to lowest-side; columns are target pitch classes, not detected string identities.'));
      heatmap.appendChild(node('p', 'fr-history-note', 'Intensity compares populated cells: level 1 is faster and level 4 is slower. Color is not the only indicator.'));
      const table = node('table', 'fr-heatmap');
      table.appendChild(node('caption', '', 'Average accepted-answer times by physical string and target pitch class'));
      const head = node('thead'), headerRow = node('tr');
      const physicalHeader = node('th', '', 'Physical string'); physicalHeader.setAttribute('scope', 'col'); headerRow.appendChild(physicalHeader);
      NAMES.forEach(name => { const header = node('th', '', name); header.setAttribute('scope', 'col'); headerRow.appendChild(header); });
      head.appendChild(headerRow); table.appendChild(head);
      const body = node('tbody');
      const allAnswers = record.runs.flatMap((run, runIndex) => run.answers.map(answer => ({ ...answer, runIndex })));
      const aggregates = new Map();
      allAnswers.forEach(answer => {
        const key = `${answer.stringIndex},${answer.pitch}`;
        let aggregate = aggregates.get(key);
        if (!aggregate) {
          aggregate = { totalMs: 0, count: 0, slowestMs: 0 };
          aggregates.set(key, aggregate);
        }
        aggregate.totalMs += answer.durationMs;
        aggregate.count++;
        aggregate.slowestMs = Math.max(aggregate.slowestMs, answer.durationMs);
      });
      const averages = [...aggregates.values()].map(aggregate => aggregate.totalMs / aggregate.count);
      const minAverage = Math.min(...averages), maxAverage = Math.max(...averages);
      const intensity = average => maxAverage === minAverage ? 1 : Math.min(4, Math.floor((average - minAverage) / (maxAverage - minAverage) * 4) + 1);
      const rows = setup.strings.slice().sort((a, b) => (setup.stringCount - a.index) - (setup.stringCount - b.index));
      rows.forEach(string => {
        const row = node('tr');
        const rowHeader = node('th', '', `String ${setup.stringCount - string.index}${setup.stringCount - string.index === 1 ? ' · highest-side' : setup.stringCount - string.index === setup.stringCount ? ' · lowest-side' : ''}`);
        rowHeader.setAttribute('scope', 'row'); row.appendChild(rowHeader);
        NAMES.forEach((name, pitch) => {
          const cell = node('td');
          const aggregate = aggregates.get(`${string.index},${pitch}`);
          if (aggregate) {
            const average = aggregate.totalMs / aggregate.count;
            const level = intensity(average);
            cell.textContent = `${seconds(average)} / ${seconds(aggregate.slowestMs)} · ${aggregate.count} · L${level}`;
            cell.setAttribute('aria-label', `String ${setup.stringCount - string.index}, target ${name}: average ${seconds(average)}, ${aggregate.count} accepted answers, slowest recent ${seconds(aggregate.slowestMs)}, intensity ${level} of 4${level === 4 ? ', slower' : ''}`);
            cell.setAttribute('data-attempts', aggregate.count);
            cell.setAttribute('data-intensity', level);
          } else { cell.textContent = '—'; cell.setAttribute('aria-label', `String ${setup.stringCount - string.index}, target ${name}: no saved answers`); }
          row.appendChild(cell);
        });
        body.appendChild(row);
      });
      table.appendChild(body);
      const scroll = node('div', 'fr-heatmap-wrap'); scroll.appendChild(table); heatmap.appendChild(scroll);

      const slowest = allAnswers.slice().sort((a, b) => b.durationMs - a.durationMs).slice(0, 5);
      worst.appendChild(node('h4', '', 'Slowest recent accepted answers'));
      const details = node('ol');
      slowest.forEach(answer => {
        const roundIndex = record.completed - record.runs.length + answer.runIndex + 1;
        details.appendChild(node('li', '', `Round ${roundIndex} · ${NAMES[answer.pitch]} · String ${setup.stringCount - answer.stringIndex} · ${seconds(answer.durationMs)}`));
      });
      worst.appendChild(details);
    }
    function renderProgress() {
      cached('completion').value = round.answers.length;
      cached('passes').hidden = round.mode === 'random';
      cached('passes').setAttribute('aria-hidden', String(round.mode === 'random'));
      passSteps.forEach((step, i) => {
        const state = round.done || i < round.pass ? 'complete' : i === round.pass ? 'current' : 'upcoming';
        step.setAttribute('data-state', state);
        step.setAttribute('aria-label', `Pass ${i + 1}: ${state}`);
      });
      const answersByString = new Map();
      for (const answer of round.answers) answersByString.set(answer.stringIndex, (answersByString.get(answer.stringIndex) || 0) + 1);
      stringRows.forEach(({ row, instruction }, i) => {
        const position = setup.stringCount - 1 - i;
        const stringIndex = position;
        const sampled = answersByString.get(stringIndex) || 0;
        const isCurrent = round.target().index === stringIndex;
        const state = round.done ? 'complete' : isCurrent ? 'current' : round.mode === 'random' ? sampled ? 'sampled' : 'upcoming' : position < round.string ? 'complete' : 'upcoming';
        row.setAttribute('data-state', state);
        if (state === 'current') row.setAttribute('aria-current', 'step'); else row.removeAttribute('aria-current');
        instruction.textContent = state === 'current' ? 'Play this string' : round.mode === 'random' ? sampled ? `Answered ${sampled}` : 'Not selected yet' : state === 'complete' ? 'Done' : 'Up next';
        row.setAttribute('aria-label', round.mode === 'random' ? `String ${setup.stringCount - stringIndex} · ${sampled} accepted answers${isCurrent ? ' · requested now' : ''}` : `String ${setup.stringCount - stringIndex}`);
      });
    }
    function renderPrompt() {
      const target = round.target();
      text('note', round.promptSpelling);
      const number = setup.stringCount - target.index;
      text('string', `String ${number}${number === 1 ? ' · highest-side' : number === setup.stringCount ? ' · lowest-side' : ''}`);
      text('progress', round.mode === 'random'
        ? `Random prompts · ${round.answers.length} / ${5 * setup.stringCount} accepted · current string ${number}`
        : `Pass ${round.pass + 1} / 5 · Step ${round.string + 1} / ${setup.stringCount} · ${round.answers.length} / ${5 * setup.stringCount} accepted`);
      renderProgress();
      text('status', 'Mute all strings briefly; then pluck the requested string.');
      text('hint', round.mode === 'random' ? 'Find this note on the requested string. Pitch and string are independently randomized; repeats are possible.' : 'Find this note on the requested string. Frets 0–11. Each pass goes lowest-side to highest-side.');
      // Start timing after assigning the prompt, never after the mute gate.
      round.displayed();
      updateMuteCue();
      promptAudioGeneration++;
      playReferenceTone();
    }
    function updateClock() {
      const now = win.performance.now();
      const dt = now - lastClock;
      lastClock = now;
      if (!alive) return;
      round?.tick(dt);
      if (round && !round.done) text('clock', `Round ${seconds(round.elapsed)} · This prompt ${seconds(round.elapsed - round.promptAt)}${round.paused ? ' · paused' : ''}`);
      if (liveAt !== null && !round?.paused && now - liveAt > LIVE_EXPIRES_MS) resetLive('expired');
      if (adapter && !round?.paused && now - lastInput > 2000) fail(new Error('Live input frames stopped arriving.'));
    }
    function finish() {
      release();
      resetLive('complete');
      updateMuteCue();
      el('pause').disabled = true;
      const result = round.summary();
      text('note', ''); text('string', ''); text('progress', round.mode === 'random' ? `Random round complete · ${round.answers.length} accepted` : `Completed: 5 passes · ${round.answers.length} accepted`);
      renderProgress();
      text('clock', `Total ${seconds(result.totalMs)} · Average ${seconds(result.averageMs)} per answer`);
      const summary = el('summary'); summary.replaceChildren();
      for (const s of result.strings) {
        const p = doc.createElement('p');
        p.textContent = round.mode === 'random'
          ? s.count === 0 ? `${s.label}: no answers this round` : `${s.label}: ${s.count} answers · total ${seconds(s.totalMs)} · average ${seconds(s.averageMs)}`
          : `${s.label}: total ${seconds(s.totalMs)} · average ${seconds(s.averageMs)}`;
        summary.appendChild(p);
      }
      try {
        const record = storeRecord(win.localStorage, setup, result, round.mode);
        text('status', `Saved only on this browser/device. ${record.completed} completed rounds for this exact setup · Personal best ${seconds(record.bestMs)}. No XP or public submission.`);
        renderHistory();
      } catch (_) { text('status', 'Round completed, but local records could not be saved (storage unavailable or corrupted). Existing records were not changed; no public submission.'); }
      updateControls();
    }
    function sample(value) {
      updateClock();
      lastInput = win.performance.now();
      if (!round || round.paused || round.done || error) return;
      // Mirror the grading admission checks before it advances its timestamp.
      // Never display a stale/invalid estimate as a stable live note.
      const valid = Number.isFinite(value.captureTime) && (round.lastCaptureTime === null || value.captureTime > round.lastCaptureTime) && Number.isFinite(value.level) && value.level >= 0 && value.level <= 1;
      liveAt = lastInput;
      if (!valid) setLive('uncertain');
      else if (value.level < QUIET) setLive('silence');
      else if (value.level < LOUD) setLive('quiet');
      else if (!Number.isFinite(value.midi) || !(value.confidence >= 0.7)) setLive('uncertain');
      else {
        const midi = Math.round(value.midi);
        setLive('detected', `${round.detectedName(midi)}${Math.floor(midi / 12) - 1}`);
      }
      if (round.sample(value, lastInput)) {
        if (round.done) finish(); else renderPrompt();
        return;
      }
      updateMuteCue();
      text('status', round.armed ? 'Ready — pluck the requested string. Wrong pitches do not advance.' : 'Mute all strings briefly; then pluck the requested string.');
    }
    async function acquire() {
      const gen = ++generation;
      acquiring = true;
      resetLive('acquiring');
      const cancelled = () => !alive || generation !== gen;
      const received = value => { if (!cancelled()) sample(value); };
      try {
        const handle = await openBrowser(win, setup, received, e => { if (!cancelled()) fail(e); }, cancelled, desktopInput);
        if (cancelled()) { handle.stop(); return; }
        adapter = handle; acquiring = false; lastInput = win.performance.now();
        if (liveAt === null && !round?.paused) setLive('listening');
      } catch (e) { if (!cancelled()) fail(e); }
    }
    async function begin() {
      release(); error = false; round = null; starting = true; updateMuteCue(); updateControls();
      referenceUnlock = wakeReferenceAudio();
      text('audio-status', '');
      resetLive('startup');
      setup = null; stringRows = []; passSteps = [];
      cached('strings').replaceChildren(); cached('passes').replaceChildren(); cached('completion').value = 0;
      text('setup', 'Reading your FeedBack setup…');
      desktopInput = null; el('input').hidden = true;
      text('status', 'Reading current FeedBack instrument and tuning…');
      text('note', ''); text('string', ''); text('clock', ''); text('progress', '');
      el('summary').replaceChildren(); el('pause').disabled = true;
      const gen = generation;
      try {
        if (!host?.workingTuning?.get || !host?.on || !host?.off || !host?.navigate || !quit) throw new Error('Required FeedBack host lifecycle/settings APIs unavailable. Update FeedBack.');
        const before = host.workingTuning.get();
        const response = await win.fetch('/api/tunings');
        if (!response.ok) throw new Error('Host tuning settings could not be read.');
        const tunings = await response.json();
        if (!alive || gen !== generation) return;
        const after = host.workingTuning.get();
        if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Host setup changed during startup. Retry.');
        setup = snapshotSetup(after, tunings, random);
        renderSetup();
        text('setup', `${setup.instrument} · ${setup.stringCount} strings · A4 ${setup.referencePitch} Hz · ${after.provenance === 'verified' ? 'host tuning marked verified' : 'host tuning assumed, not physically verified'}`);
        if (win.feedBackDesktop?.isDesktop) {
          const input = await resolveDesktopInput(win);
          if (!alive || gen !== generation) return;
          if (snapshotSetup(host.workingTuning.get(), tunings).key !== setup.key) throw new Error('Host setup changed during input resolution. Retry.');
          desktopInput = input;
          resetLive('consent');
          text('status', `Desktop input: ${input.label} · ${input.channel === 'mono' ? 'Mono (first pair)' : input.channel === 'left' ? 'Channel 1' : 'Channel 2'} (${input.nativeType}). Confirm to open this exact device through Electron capture, not native/ASIO polling. Native routing and monitoring remain untouched; exclusive devices may refuse simultaneous capture.`);
          text('input', `Use Electron capture: ${input.label}`); el('input').hidden = false;
          el('input').onclick = () => {
            if (!alive || gen !== generation) return;
            referenceUnlock = wakeReferenceAudio();
            try {
              if (snapshotSetup(host.workingTuning.get(), tunings).key !== setup.key) throw new Error('Host setup changed before input confirmation. Retry.');
            } catch (e) { fail(e); return; }
            el('input').hidden = true;
            round = new Round(setup, random, { randomMode: el('random-mode').checked }); lastClock = win.performance.now();
            updateControls();
            renderPrompt(); el('pause').disabled = false; text('pause', 'Pause');
            acquire();
          };
          return;
        }
        round = new Round(setup, random, { randomMode: el('random-mode').checked }); lastClock = win.performance.now();
        updateControls();
        renderPrompt(); el('pause').disabled = false; text('pause', 'Pause');
        await acquire();
      } catch (e) { if (alive && gen === generation) fail(e); }
      finally { if (gen === generation) { starting = false; updateControls(); } }
    }
    el('retry').onclick = () => { if (!starting) begin(); };
    el('hear').onclick = () => { playReferenceTone(true); };
    el('pause').onclick = () => {
      if (!round || round.done || error) return;
      updateClock();
      round.pause(!round.paused);
      if (round.paused) { referenceAttempt++; stopReferenceTone(); }
      updateControls();
      resetLive(round.paused ? 'paused' : 'listening');
      updateMuteCue();
      text('pause', round.paused ? 'Resume' : 'Pause');
      text('status', round.paused ? 'Paused. Resume, mute, then pluck; paused time is excluded.' : 'Mute all strings briefly; then pluck the requested string.');
      lastInput = win.performance.now();
    };
    const visibility = () => {
      if (doc.hidden && round && !round.done && !round.paused) el('pause').onclick();
    };
    const changing = e => { if (e.detail?.id !== 'plugin-minigames') stop(); };
    const tuningChanged = () => { if (starting || (round && !round.done) || desktopInput) fail(new Error('Host instrument/tuning changed. Abandoning this round; retry with the new setup.')); };
    const stop = () => {
      if (!alive) return;
      alive = false; release(); win.clearInterval(clockTimer);
      quit?.removeEventListener('click', leave, true);
      doc.removeEventListener('visibilitychange', visibility);
      host?.off?.('screen:changing', changing); host?.off?.('working-tuning-changed', tuningChanged);
    };
    doc.addEventListener('visibilitychange', visibility);
    host?.on?.('screen:changing', changing); host?.on?.('working-tuning-changed', tuningChanged);
    clockTimer = win.setInterval(updateClock, 50);
    return { begin, stop };
  }
})(typeof window !== 'undefined' ? window : globalThis);
