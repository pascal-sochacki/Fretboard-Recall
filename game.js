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
  const LIVE_EXPIRES_MS = 350;
  const STORAGE_KEY = 'fretboard_recall.records.v1';
  const RANDOM_RECORD_SUFFIX = ':random';

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
    constructor(setup, random = Math.random, { randomMode = false } = {}) {
      this.setup = setup;
      this.random = random;
      this.mode = randomMode ? 'random' : 'standard';
      this.pass = 0;
      this.string = 0;
      this.pitch = null;
      if (this.mode === 'random') this.chooseRandomPrompt();
      else this.pitch = choosePitch(null, random);
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
      if (this.mode === 'random') {
        if (this.answers.length === 5 * this.setup.stringCount) this.done = true;
        else this.chooseRandomPrompt();
        this.resetGate();
        return true;
      }
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
          return { index: s.index, label: s.label, ...(this.mode === 'random' ? { count: answers.length } : {}), totalMs, averageMs: answers.length ? totalMs / answers.length : null };
        }),
        ...(this.mode === 'random' ? { mode: this.mode } : {}),
      };
    }
  }

  function storeRecord(storage, setup, result, mode = 'standard') {
    let records = JSON.parse(storage.getItem(STORAGE_KEY) || '{}');
    if (!records || typeof records !== 'object' || Array.isArray(records)) throw new Error('Invalid local records.');
    if (!['standard', 'random'].includes(mode)) throw new Error('Invalid round mode.');
    const key = mode === 'random' ? `${setup.key}${RANDOM_RECORD_SUFFIX}` : setup.key;
    const old = records[key];
    const valid = old && Number.isInteger(old.completed) && old.completed >= 0 && Number.isFinite(old.bestMs) && old.bestMs >= 0;
    records[key] = { setup, ...(mode === 'random' ? { mode } : {}), completed: (valid ? old.completed : 0) + 1, bestMs: valid ? Math.min(old.bestMs, result.totalMs) : result.totalMs, latest: result };
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

  function mount(win, container, random = Math.random) {
    const doc = win.document;
    container.innerHTML = `<section class="fr-game" aria-label="Fretboard Recall">
      <header class="fr-header"><div><p class="fr-eyebrow">One note. Every string.</p><h2>Fretboard Recall</h2></div><span class="fr-badge">5 passes · Local records</span></header>
      <p class="fr-setup">Reading your FeedBack setup…</p>
      <div class="fr-action-row"><label class="fr-mode"><input type="checkbox" class="fr-random-mode"> Random note + string</label>
      <div class="fr-controls"><button type="button" class="fr-input" hidden>Confirm desktop input</button><button type="button" class="fr-pause" disabled>Pause</button><button type="button" class="fr-retry">Start round</button><button type="button" class="fr-settings">Host settings</button><button type="button" class="fr-leave">Stop / Back to songs</button></div></div>
      <div class="fr-round-progress"><div class="fr-passes" aria-label="Five passes"></div><p class="fr-progress"></p><progress class="fr-completion" max="1" value="0" aria-label="Accepted answers"></progress></div>
      <div class="fr-cards">
        <section class="fr-target" aria-label="Requested note"><p class="fr-eyebrow">Your target · pitch class</p><div aria-live="polite" aria-atomic="true"><p class="fr-note"></p><p class="fr-string"></p></div><p class="fr-hint">Find this note on the requested string. Frets 0–11. Each pass goes lowest-side to highest-side.</p></section>
        <section class="fr-live" aria-label="Live detected note"><p class="fr-eyebrow">Live input · detected note</p><p class="fr-detected">—</p><p class="fr-live-status">Not listening</p><p class="fr-hint">Reported pitch and octave only. Physical string is not detected.</p></section>
      </div>
      <section class="fr-strings-panel" aria-label="Physical strings, highest-side to lowest-side"><div class="fr-diagram-heading"><h3>Requested string</h3><span>Open tuning · no fret hints</span></div><p class="fr-side">Highest-side · string 1</p><ol class="fr-strings"></ol><p class="fr-side">Lowest-side</p></section>
      <div class="fr-feedback"><p class="fr-status" role="status"></p><p class="fr-clock"></p></div>
      <div class="fr-summary"></div>
      <p class="fr-warning">Play only the requested string within frets 0–11. Microphone/DI pitch cannot verify the physical string when the same pitch exists elsewhere. Use the requested string yourself. No string detection is claimed.</p>
    </section>`;
    const el = name => container.querySelector(`.fr-${name}`);
    const elements = new Map();
    const cached = name => { if (!elements.has(name)) elements.set(name, el(name)); return elements.get(name); };
    let generation = 0, adapter = null, round = null, setup = null, alive = true;
    let clockTimer = null, lastClock = win.performance.now(), lastInput = lastClock;
    let error = false, acquiring = false, starting = false;
    let desktopInput = null;
    let stringRows = [], passSteps = [];
    let liveState = '', liveNote = '', liveAt = null;
    const host = win.feedBack;
    const quit = doc.getElementById('mg-stage-quit');
    const text = (name, value) => { const node = cached(name); if (node.textContent !== value) node.textContent = value; };
    function updateControls() {
      const active = !!round && !round.done && !error;
      el('random-mode').disabled = active || starting;
      text('eyebrow', round?.mode === 'random' || (!round && el('random-mode').checked) ? 'Every prompt is independent.' : 'One note. Every string.');
      text('badge', `${round?.mode === 'random' || (!round && el('random-mode').checked) ? 'Random' : '5 passes'} · Local records`);
      text('retry', error ? 'Retry' : round?.done ? 'Play again' : starting ? 'Starting…' : round ? 'Restart round' : 'Start round');
      el('retry').disabled = starting;
    }
    el('random-mode').onchange = updateControls;
    function setLive(state, note = '—') {
      if (liveState === state && liveNote === note) return;
      const labels = { stopped: 'Not listening', startup: 'Reading setup…', consent: 'Waiting for input confirmation', acquiring: 'Opening input…', listening: 'Listening · waiting for a fresh sample', silence: 'Silence · mute before each answer', quiet: 'Listening · signal too quiet for pitch detection', uncertain: 'Uncertain pitch · play one clear note', detected: 'Pitch detected · reported octave', paused: 'Paused · input display cleared', failed: 'Input unavailable · check settings and retry', complete: 'Round complete · input stopped', expired: 'Waiting for fresh audio · last pitch cleared' };
      liveState = state; liveNote = note;
      cached('live').setAttribute('data-state', state);
      text('detected', note); text('live-status', labels[state]);
    }
    function resetLive(state) { liveAt = null; setLive(state); }
    const release = () => { generation++; adapter?.stop(); adapter = null; acquiring = false; starting = false; resetLive('stopped'); };
    const fail = e => {
      if (!alive || error) return;
      error = true;
      release();
      resetLive('failed');
      el('input').hidden = true;
      round?.pause(true);
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
        const open = doc.createElement('span'); open.className = 'fr-open-note'; open.textContent = `${noteName(s.midi)}${Math.floor(s.midi / 12) - 1}`;
        const instruction = doc.createElement('span'); instruction.className = 'fr-string-instruction';
        row.setAttribute('aria-label', s.label);
        row.appendChild(number); row.appendChild(wire); row.appendChild(open); row.appendChild(instruction);
        return { row, instruction };
      });
      cached('strings').replaceChildren(...stringRows.map(s => s.row));
      passSteps = Array.from({ length: 5 }, (_, i) => {
        const step = doc.createElement('span'); step.className = 'fr-pass'; step.textContent = `${i + 1}`; return step;
      });
      cached('passes').replaceChildren(...passSteps);
      cached('completion').max = 5 * setup.stringCount;
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
        row.setAttribute('aria-label', round.mode === 'random' ? `${setup.strings.find(s => s.index === stringIndex).label} · ${sampled} accepted answers${isCurrent ? ' · requested now' : ''}` : setup.strings.find(s => s.index === stringIndex).label);
      });
    }
    function renderPrompt() {
      const target = round.target();
      text('note', noteName(target.pitch));
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
      } catch (_) { text('status', 'Round completed, but local records could not be saved (storage unavailable or corrupted). No public submission.'); }
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
        setLive('detected', `${noteName(midi)}${Math.floor(midi / 12) - 1}`);
      }
      if (round.sample(value, lastInput)) {
        if (round.done) finish(); else renderPrompt();
        return;
      }
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
      release(); error = false; round = null; starting = true; updateControls();
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
        setup = snapshotSetup(after, tunings);
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
    el('pause').onclick = () => {
      if (!round || round.done || error) return;
      updateClock();
      round.pause(!round.paused);
      resetLive(round.paused ? 'paused' : 'listening');
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
