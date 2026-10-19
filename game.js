// SPDX-License-Identifier: MIT
(function (root) {
  'use strict';

  const NAMES = ['C', 'C♯ / D♭', 'D', 'D♯ / E♭', 'E', 'F', 'F♯ / G♭', 'G', 'G♯ / A♭', 'A', 'A♯ / B♭', 'B'];
  const mod = n => ((n % 12) + 12) % 12;
  const noteName = midi => NAMES[mod(midi)];
  const seconds = ms => `${(ms / 1000).toFixed(2)} s`;
  const SILENCE_MS = 180;
  const HOLD_MS = 120;
  const MAX_GAP_MS = 100;
  const QUIET = 0.02;
  const LOUD = 0.04;
  const STORAGE_KEY = 'fretboard_recall.records.v1';

  function snapshotSetup(state, tunings) {
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
      label: `String ${state.stringCount - index} · ${noteName(midi)}${Math.floor(midi / 12) - 1}${index === 0 ? ' · lowest-side' : index === opens.length - 1 ? ' · highest-side' : ''}`,
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
    constructor(setup, random = Math.random) {
      this.setup = setup;
      this.random = random;
      this.pass = 0;
      this.string = 0;
      this.pitch = choosePitch(null, random);
      this.answers = [];
      this.elapsed = 0;
      this.promptAt = 0;
      this.paused = false;
      this.done = false;
      this.lastCaptureTime = null;
      this.resetGate();
    }
    resetGate() {
      this.armed = false;
      this.quietAt = null;
      this.correctAt = null;
      this.lastSample = null;
    }
    target() {
      const s = this.setup.strings[this.string];
      return { ...s, pitch: this.pitch, midi: s.midi + mod(this.pitch - s.midi) };
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
      this.answers.push({ stringIndex: this.target().index, durationMs: this.elapsed - this.promptAt });
      this.string++;
      if (this.string === this.setup.stringCount) {
        this.string = 0;
        this.pass++;
        if (this.pass === 5) this.done = true;
        else this.pitch = choosePitch(this.pitch, this.random);
      }
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
        strings: this.setup.strings.map(s => {
          const answers = this.answers.filter(a => a.stringIndex === s.index);
          const totalMs = answers.reduce((sum, a) => sum + a.durationMs, 0);
          return { index: s.index, label: s.label, totalMs, averageMs: totalMs / answers.length };
        }),
      };
    }
  }

  function storeRecord(storage, setup, result) {
    let records = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid local records.');
    const old = records[setup.key];
    const valid = old && Number.isInteger(old.completed) && old.completed >= 0 && Number.isFinite(old.bestMs) && old.bestMs >= 0;
    records[setup.key] = { setup, completed: (valid ? old.completed : 0) + 1, bestMs: valid ? Math.min(old.bestMs, result.totalMs) : result.totalMs, latest: result };
    storage.setItem(STORAGE_KEY, JSON.stringify(records));
    return records[setup.key];
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

  const logic = { Round, snapshotSetup, choosePitch, noteName, storeRecord, scaledRms, resolveDesktopInput, openBrowser, mount };
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

  function mount(win, container) {
    const doc = win.document;
    container.innerHTML = `<section class="fr-game" aria-label="Fretboard Recall">
      <p class="fr-setup"></p><p class="fr-progress"></p>
      <div class="fr-target" aria-live="polite"><p class="fr-note"></p><p class="fr-string"></p></div>
      <p class="fr-status" role="status"></p><p class="fr-clock"></p>
      <div class="fr-summary"></div>
      <div class="fr-controls"><button type="button" class="fr-input" hidden>Confirm desktop input</button><button type="button" class="fr-pause">Pause</button><button type="button" class="fr-retry">Retry / New round</button><button type="button" class="fr-settings">Host settings</button><button type="button" class="fr-leave">Stop / Back to songs</button></div>
      <p class="fr-warning">Play only the requested string within frets 0–11. Microphone/DI pitch cannot verify the physical string when the same pitch exists elsewhere. Use the requested string yourself. No string detection is claimed.</p>
    </section>`;
    const el = name => container.querySelector(`.fr-${name}`);
    let generation = 0, adapter = null, round = null, setup = null, alive = true;
    let clockTimer = null, lastClock = win.performance.now(), lastInput = lastClock;
    let error = false, acquiring = false, starting = false;
    let desktopInput = null;
    const host = win.feedBack;
    const quit = doc.getElementById('mg-stage-quit');
    const text = (name, value) => { el(name).textContent = value; };
    const release = () => { generation++; adapter?.stop(); adapter = null; acquiring = false; starting = false; };
    const fail = e => {
      if (!alive || error) return;
      error = true;
      release();
      el('input').hidden = true;
      round?.pause(true);
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

    function renderPrompt() {
      const target = round.target();
      text('note', noteName(target.pitch));
      text('string', target.label);
      text('progress', `Pass ${round.pass + 1} / 5 · String ${round.string + 1} / ${setup.stringCount} · ${round.answers.length} / ${5 * setup.stringCount} accepted`);
      text('status', 'Mute all strings briefly; then pluck the requested string.');
      // Start timing after assigning the prompt, never after the mute gate.
      round.displayed();
    }
    function updateClock() {
      const now = win.performance.now();
      const dt = now - lastClock;
      lastClock = now;
      if (!alive) return;
      round?.tick(dt);
      if (round && !round.done) text('clock', `Round ${seconds(round.elapsed)} · This prompt ${seconds(round.elapsed - round.promptAt)}${round.paused ? ' · paused' : ''}`);
      if (adapter && !round?.paused && now - lastInput > 2000) fail(new Error('Live input frames stopped arriving.'));
    }
    function finish() {
      release();
      el('pause').disabled = true;
      const result = round.summary();
      text('note', ''); text('string', ''); text('progress', `Completed: 5 passes · ${round.answers.length} accepted`);
      text('clock', `Total ${seconds(result.totalMs)} · Average ${seconds(result.averageMs)} per answer`);
      const summary = el('summary'); summary.replaceChildren();
      for (const s of result.strings) {
        const p = doc.createElement('p');
        p.textContent = `${s.label}: total ${seconds(s.totalMs)} · average ${seconds(s.averageMs)}`;
        summary.appendChild(p);
      }
      try {
        const record = storeRecord(win.localStorage, setup, result);
        text('status', `Saved only on this browser/device. ${record.completed} completed rounds for this exact setup · Personal best ${seconds(record.bestMs)}. No XP or public submission.`);
      } catch (_) { text('status', 'Round completed, but local records could not be saved (storage unavailable or corrupted). No public submission.'); }
    }
    function sample(value) {
      updateClock();
      lastInput = win.performance.now();
      if (!round || round.paused || round.done || error) return;
      if (round.sample(value, lastInput)) {
        if (round.done) finish(); else renderPrompt();
        return;
      }
      text('status', round.armed ? 'Ready — pluck the requested string. Wrong pitches do not advance.' : 'Mute all strings briefly; then pluck the requested string.');
    }
    async function acquire() {
      const gen = ++generation;
      acquiring = true;
      const cancelled = () => !alive || generation !== gen;
      const received = value => { if (!cancelled()) sample(value); };
      try {
        const handle = await openBrowser(win, setup, received, e => { if (!cancelled()) fail(e); }, cancelled, desktopInput);
        if (cancelled()) { handle.stop(); return; }
        adapter = handle; acquiring = false; lastInput = win.performance.now();
      } catch (e) { if (!cancelled()) fail(e); }
    }
    async function begin() {
      release(); error = false; round = null;
      starting = true;
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
        setup = snapshotSetup(after, tunings);
        text('setup', `${setup.instrument} · ${setup.stringCount} strings · A4 ${setup.referencePitch} Hz · ${after.provenance === 'verified' ? 'host tuning marked verified' : 'host tuning assumed, not physically verified'}`);
        if (win.feedBackDesktop?.isDesktop) {
          const input = await resolveDesktopInput(win);
          if (!alive || gen !== generation) return;
          if (snapshotSetup(host.workingTuning.get(), tunings).key !== setup.key) throw new Error('Host setup changed during input resolution. Retry.');
          desktopInput = input;
          text('status', `Desktop input: ${input.label} · ${input.channel === 'mono' ? 'Mono (first pair)' : input.channel === 'left' ? 'Channel 1' : 'Channel 2'} (${input.nativeType}). Confirm to open this exact device through Electron capture, not native/ASIO polling. Native routing and monitoring remain untouched; exclusive devices may refuse simultaneous capture.`);
          text('input', `Use Electron capture: ${input.label}`); el('input').hidden = false;
          el('input').onclick = () => {
            if (!alive || gen !== generation) return;
            try {
              if (snapshotSetup(host.workingTuning.get(), tunings).key !== setup.key) throw new Error('Host setup changed before input confirmation. Retry.');
            } catch (e) { fail(e); return; }
            el('input').hidden = true;
            round = new Round(setup); lastClock = win.performance.now();
            renderPrompt(); el('pause').disabled = false; text('pause', 'Pause');
            acquire();
          };
          return;
        }
        round = new Round(setup); lastClock = win.performance.now();
        renderPrompt(); el('pause').disabled = false; text('pause', 'Pause');
        await acquire();
      } catch (e) { if (alive && gen === generation) fail(e); }
      finally { if (gen === generation) starting = false; }
    }
    el('retry').onclick = () => { if (!acquiring) begin(); };
    el('pause').onclick = () => {
      if (!round || round.done || error) return;
      updateClock();
      round.pause(!round.paused);
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
