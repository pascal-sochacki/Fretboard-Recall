const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { openBrowser, resolveDesktopInput, mount, snapshotSetup, Round } = require('../game.js');
const setup = snapshotSetup({ instrument: 'guitar', stringCount: 6, offsets: [0, 0, 0, 0, 0, 0], referencePitch: 440 }, { tuningMidis: { 'guitar-6': { Standard: [40, 45, 50, 55, 59, 64] } } });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

function browser() {
  const nodes = [], calls = [], errors = [], samples = [];
  let stopped = 0, closed = 0, frameSize;
  const tones = [], contexts = [];
  const node = () => { const n = { gain: { value: 1, setValueAtTime(value) { this.value = value; }, linearRampToValueAtTime(value) { this.value = value; } }, connect() {}, disconnect() { this.disconnected = true; } }; nodes.push(n); return n; };
  const track = { label: 'USB DI', readyState: 'live', muted: false, stop: () => stopped++, getSettings: () => ({ channelCount: 2, deviceId: 'chosen' }) };
  const stream = { getTracks: () => [track], getAudioTracks: () => [track] };
  class Context {
    constructor() { this.state = 'running'; this.sampleRate = 48000; this.currentTime = 0; this.destination = {}; contexts.push(this); }
    async resume() {} async close() { closed++; }
    createMediaStreamSource() { return node(); } createGain() { return node(); }
    createChannelSplitter() { return node(); }
    createOscillator() { const oscillator = { frequency: { setValueAtTime(value) { oscillator.hz = value; } }, connect(target) { oscillator.output = target; }, disconnect() { oscillator.disconnected = true; }, start(time) { oscillator.startedAt = time; }, stop(time) { oscillator.stoppedAt = time; oscillator.stopCount = (oscillator.stopCount || 0) + 1; } }; tones.push(oscillator); return oscillator; }
    createScriptProcessor(size) { frameSize = size; const n = node(); n.meter = true; return n; }
  }
  const win = {
    AudioContext: Context,
    localStorage: { getItem: () => '{"channel":"right","deviceId":"chosen","method":"crepe"}' },
    navigator: { mediaDevices: { getUserMedia: async ({ audio }) => { assert.deepEqual(audio.deviceId, { exact: 'chosen' }); return stream; } } },
    _ndYinDetect: (frame, rate, minHz) => { calls.push({ frame, rate, minHz }); return { freq: 440, confidence: .95 }; },
    createNoteDetector: () => assert.fail('Async detector must never be constructed'),
  };
  return { win, nodes, calls, errors, samples, tones, contexts, track, stream, frame: value => new Float32Array(frameSize).fill(value), emit: (frame, time) => nodes.find(n => n.meter).onaudioprocess?.({ playbackTime: time, inputBuffer: { getChannelData: () => frame } }), counts: () => ({ stopped, closed }) };
}

test('safe pending and immediate registration matches manifest once', () => {
  const source = fs.readFileSync(require.resolve('../game.js'), 'utf8');
  const id = JSON.parse(fs.readFileSync(require.resolve('../plugin.json'), 'utf8')).id;
  for (const ready of [true, false]) {
    const registered = []; const window = ready ? { feedBackMinigames: { register: s => registered.push(s) } } : {};
    const context = vm.createContext({ window }); vm.runInContext(source, context); vm.runInContext(source, context);
    const specs = ready ? registered : window.__feedBackMinigamesPending;
    assert.equal(specs.length, 1); assert.equal(specs[0].id, id);
  }
});
test('desktop requires consent before touching retained DSP, monitor, padded ring or permission', async () => {
  const b = browser();
  b.win.feedBackDesktop = { isDesktop: true, audio: new Proxy({}, { get() { assert.fail('Native API must not be touched'); } }) };
  b.win.navigator.mediaDevices.getUserMedia = () => assert.fail('Native input must not fall back to a browser mic');
  await assert.rejects(openBrowser(b.win, setup, () => assert.fail('sample'), () => {}, () => false), /explicit confirmation/);
});
function desktop(b) {
  const intervals = new Map(); let id = 0;
  const state = { input: 'USB DI', inputType: 'CoreAudio', channel: 1, devices: [{ kind: 'audioinput', label: 'USB DI', deviceId: 'chosen' }] };
  b.win.navigator.mediaDevices.enumerateDevices = async () => state.devices;
  const methods = { getCurrentDevice: async () => ({ input: state.input, inputType: state.inputType }), listSources: async () => [{ id: 0, active: true, deviceKey: 0, inputChannel: state.channel }] };
  b.win.feedBackDesktop = { isDesktop: true, audio: new Proxy(methods, { get(target, name) { if (!(name in target)) assert.fail(`Must not invoke native mutation/poll: ${String(name)}`); return target[name]; } }) };
  b.win.setInterval = cb => { intervals.set(++id, cb); return id; }; b.win.clearInterval = id => intervals.delete(id);
  return { state, intervals };
}
test('desktop maps only unique exact configured device and first-pair channel', async () => {
  const b = browser(), d = desktop(b);
  const input = await resolveDesktopInput(b.win);
  assert.equal(input.deviceId, 'chosen'); assert.equal(input.channel, 'right');
  for (const devices of [[], [{ kind: 'audioinput', label: 'USB DI alias', deviceId: 'chosen' }], [{ kind: 'audioinput', label: 'USB DI', deviceId: 'default' }], [{ kind: 'audioinput', label: 'USB DI', deviceId: 'a' }, { kind: 'audioinput', label: 'USB DI', deviceId: 'b' }]]) {
    d.state.devices = devices; await assert.rejects(resolveDesktopInput(b.win), /unique exact-name/);
  }
  d.state.channel = 2; await assert.rejects(resolveDesktopInput(b.win), /channel cannot be mapped/);
});
test('desktop consent opens confirmed Electron device with private final mute, no native writes', async () => {
  const b = browser(), d = desktop(b), input = await resolveDesktopInput(b.win);
  const handle = await openBrowser(b.win, setup, s => b.samples.push(s), e => b.errors.push(e), () => false, input);
  b.emit(b.frame(.05), 0); assert.equal(b.samples.length, 1); assert.equal(b.samples[0].midi, 69);
  assert.equal(d.intervals.size, 1); assert.equal(b.nodes.filter(n => n.gain.value === 0).length, 1);
  handle.stop(); assert.equal(d.intervals.size, 0); assert.deepEqual(b.counts(), { stopped: 1, closed: 1 });
});
test('desktop confirmation invalidated by native input change before capture', async () => {
  const b = browser(), d = desktop(b), input = await resolveDesktopInput(b.win);
  d.state.channel = 0;
  b.win.navigator.mediaDevices.getUserMedia = () => assert.fail('No capture after identity change');
  await assert.rejects(openBrowser(b.win, setup, () => {}, () => {}, () => false, input), /changed after confirmation/);
});
test('desktop device/channel watcher stops only owned Electron stream', async () => {
  const b = browser(), d = desktop(b), input = await resolveDesktopInput(b.win);
  const handle = await openBrowser(b.win, setup, () => {}, e => b.errors.push(e), () => false, input);
  d.state.channel = 0;
  await [...d.intervals.values()][0]();
  assert.match(b.errors[0].message, /device\/channel changed/); assert.equal(d.intervals.size, 0);
  assert.deepEqual(b.counts(), { stopped: 1, closed: 1 }); handle.stop();
});
test('desktop stream-label mismatch and exclusive-device denial do not substitute input', async () => {
  const b = browser(); desktop(b); const input = await resolveDesktopInput(b.win);
  b.track.label = 'Other input';
  await assert.rejects(openBrowser(b.win, setup, () => {}, () => {}, () => false, input), /stream label/);
  const denied = browser(); desktop(denied); const consent = await resolveDesktopInput(denied.win);
  denied.win.navigator.mediaDevices.getUserMedia = async () => { throw new Error('Device in use (exclusive)'); };
  await assert.rejects(openBrowser(denied.win, setup, () => {}, () => {}, () => false, consent), /exclusive/);
});
test('desktop late consent capture cancellation releases only the arriving Electron stream', async () => {
  const b = browser(), d = desktop(b), input = await resolveDesktopInput(b.win), pending = deferred();
  let cancelled = false;
  b.win.navigator.mediaDevices.getUserMedia = () => pending.promise;
  const opening = openBrowser(b.win, setup, () => assert.fail('late sample'), () => {}, () => cancelled, input);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  cancelled = true; pending.resolve(b.stream);
  const handle = await opening; handle.stop();
  assert.deepEqual(b.counts(), { stopped: 1, closed: 0 }); assert.equal(d.intervals.size, 0);
});
test('async-only host detector fails visibly before permission; no invented estimate freshness', async () => {
  const b = browser(); delete b.win._ndYinDetect;
  b.win.navigator.mediaDevices.getUserMedia = () => assert.fail('No capture with unsupported detector');
  await assert.rejects(openBrowser(b.win, setup, () => {}, () => {}, () => false), /async pitch snapshots are unsupported/);
});
test('late permission resolution cleans up stream before building nodes', async () => {
  const b = browser(), pending = deferred(); let cancelled = false;
  b.win.navigator.mediaDevices.getUserMedia = () => pending.promise;
  const opening = openBrowser(b.win, setup, () => {}, () => {}, () => cancelled);
  cancelled = true; pending.resolve(b.stream); const handle = await opening; handle.stop();
  assert.deepEqual(b.counts(), { stopped: 1, closed: 0 }); assert.equal(b.nodes.length, 0);
});
test('explicit device/channel and permission failures offer recovery instead of substitution', async () => {
  const b = browser(); b.win.localStorage.getItem = () => '{"channel":"mono"}';
  await assert.rejects(openBrowser(b.win, setup, () => {}, () => {}, () => false), /explicit browser input/);
  b.win.localStorage.getItem = () => '{"channel":"mono","deviceId":"chosen"}';
  b.win.navigator.mediaDevices.getUserMedia = async () => { throw new Error('Permission denied'); };
  await assert.rejects(openBrowser(b.win, setup, () => {}, () => {}, () => false), /Permission denied/);
});
test('sync host DSP consumes each complete callback buffer; async snapshots cannot leak stale pitch', async () => {
  const b = browser(); const r = new Round(setup);
  r.pitch = 9;
  b.win.noteDetect = { getCalibrationSnapshot: () => ({ rawMidi: r.target().midi, heardConfidencePct: 100 }) };
  const freq = 440 * 2 ** ((r.target().midi - 69) / 12);
  let correct = true;
  b.win._ndYinDetect = (frame, rate) => { b.calls.push({ frame, rate }); return { freq: correct ? freq : freq * 2 ** (1 / 12), confidence: 1 }; };
  const handle = await openBrowser(b.win, setup, s => { b.samples.push(s); r.tick(85); r.sample(s, s.captureTime); }, e => b.errors.push(e), () => false);
  for (let i = 0; i < 4; i++) b.emit(b.frame(0), i * .085);
  assert.equal(r.armed, true);
  b.emit(b.frame(.05), .34);
  correct = false;
  for (let i = 5; i < 10; i++) b.emit(b.frame(.05), i * .085);
  assert.equal(r.answers.length, 0); assert.equal(b.calls.length, 6);
  assert.equal(new Set(b.calls.map(c => c.frame)).size, 6);
  correct = true;
  for (let i = 10; i < 13; i++) b.emit(b.frame(.05), i * .085);
  assert.equal(r.answers.length, 1);
  handle.stop(); handle.stop(); assert.deepEqual(b.counts(), { stopped: 1, closed: 1 });
  assert.ok(b.nodes.every(n => n.disconnected)); assert.equal(b.errors.length, 0);
  assert.equal(b.nodes.filter(n => n.gain.value === 0).length, 1);
});
test('reused or absent real processing timestamp terminates capture before analysis/admission', async () => {
  for (const time of [0, undefined, NaN]) {
    const b = browser(); const handle = await openBrowser(b.win, setup, s => b.samples.push(s), e => b.errors.push(e), () => false);
    b.emit(b.frame(0), 0); b.emit(b.frame(.05), time);
    assert.equal(b.samples.length, 1); assert.equal(b.calls.length, 0);
    assert.match(b.errors[0].message, /timestamps/); assert.equal(b.counts().stopped, 1); handle.stop();
  }
});
test('async or underbuffered primitive fails instead of admitting a held estimate', async () => {
  for (const result of [Promise.resolve({ freq: 440, confidence: 1 }), { freq: 440, confidence: 1, underBuffered: true }]) {
    const b = browser(); b.win._ndYinDetect = () => result;
    const handle = await openBrowser(b.win, setup, () => assert.fail('sample'), e => b.errors.push(e), () => false);
    b.emit(b.frame(.05), 0); assert.match(b.errors[0].message, /incompatible/); handle.stop();
  }
});
test('exact-device mismatch stops stream instead of accepting a substituted input', async () => {
  const b = browser(); b.track.getSettings = () => ({ deviceId: 'other', channelCount: 2 });
  await assert.rejects(openBrowser(b.win, setup, () => {}, () => {}, () => false), /did not confirm/);
  assert.deepEqual(b.counts(), { stopped: 1, closed: 1 });
});

function dom() {
  const nodes = new Map(), subscriptions = new Map(), timers = new Set(); let now = 0;
  const node = () => ({ _text: '', writes: 0, get textContent() { return this._text; }, set textContent(value) { this._text = value; this.writes++; }, disabled: false, children: [], attributes: {}, style: { setProperty() {} }, setAttribute(k, v) { this.attributes[k] = v; }, getAttribute(k) { return this.attributes[k] ?? null; }, removeAttribute(k) { delete this.attributes[k]; }, replaceChildren(...children) { this.children = children; }, appendChild(n) { this.children.push(n); } });
  // EventTarget executes capture listeners before the framework's onclick.
  const quit = new EventTarget(); let publicEnds = 0;
  const quitClick = () => { const event = new Event('click', { cancelable: true }); if (quit.dispatchEvent(event)) publicEnds++; };
  const container = { innerHTML: '', querySelector(k) { assert.match(this.innerHTML, new RegExp(`class="[^"]*\\b${k.slice(1)}\\b`), `Selector ${k} must exist in mounted markup`); if (!nodes.has(k)) nodes.set(k, node()); return nodes.get(k); } };
  const doc = new EventTarget(); doc.getElementById = () => quit; doc.createElement = node;
  const host = { workingTuning: { get: () => ({ instrument: 'guitar', stringCount: 6, offsets: setup.offsets.slice(), referencePitch: 440 }) }, on: (k, cb) => subscriptions.set(k, cb), off: k => subscriptions.delete(k), navigate: id => subscriptions.get('screen:changing')?.({ detail: { id } }) };
  const win = { document: doc, feedBack: host, performance: { now: () => now }, setInterval: cb => { timers.add(cb); return cb; }, clearInterval: cb => timers.delete(cb), fetch: async () => ({ ok: true, json: async () => ({ tuningMidis: { 'guitar-6': { Standard: [40, 45, 50, 55, 59, 64] } } }) }) };
  return { win, container, nodes, quit, quitClick, subscriptions, timers, ends: () => publicEnds, advance: ms => { now += ms; timers.forEach(cb => cb()); } };
}
test('Quit actually prevents default and stops same-target listeners, not only directly calling handler', async () => {
  const d = dom(); const game = mount(d.win, d.container); await game.begin();
  let bubbled = 0; d.quit.addEventListener('click', () => bubbled++);
  d.quitClick(); assert.equal(d.ends(), 0); assert.equal(bubbled, 0);
  assert.equal(d.timers.size, 0); assert.equal(d.subscriptions.size, 0); game.stop();
});
test('navigation while awaiting tuning cancels without acquiring input', async () => {
  const d = dom(), pending = deferred(); d.win.fetch = () => pending.promise;
  const game = mount(d.win, d.container); const starting = game.begin();
  d.win.feedBack.navigate('settings'); pending.resolve({ ok: true, json: async () => ({}) }); await starting;
  assert.equal(d.nodes.get('.fr-note').textContent, ''); assert.equal(d.timers.size, 0);
});
test('complete mounted browser round saves once locally and never submits framework end', async () => {
  const d = dom(), b = browser(); Object.assign(d.win, b.win); let saves = 0, freq = 440;
  b.win._ndYinDetect = d.win._ndYinDetect = () => ({ freq, confidence: 1 });
  const records = new Map(); d.win.localStorage = { getItem: k => k === 'slopsmith_notedetect' ? '{"deviceId":"chosen","channel":"mono"}' : records.get(k), setItem: (k, v) => { saves++; records.set(k, v); } };
  d.win.feedBackMinigames = { end: () => assert.fail('public submission') };
  const game = mount(d.win, d.container, () => 0); await game.begin(); let time = 0;
  assert.equal(d.nodes.get('.fr-results').hidden, true);
  assert.equal(d.nodes.get('.fr-round-progress').hidden, true);
  assert.equal(d.nodes.get('.fr-string').textContent, 'String 6 · lowest-side');
  assert.equal(d.nodes.get('.fr-progress').textContent, 'Pass 1 / 5 · Step 1 / 6 · 0 / 30 accepted');
  const emit = value => { d.advance(85); b.emit(b.frame(value), (time += .085)); };
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const opens = [64, 59, 55, 50, 45, 40];
  for (let answer = 0; answer < 30; answer++) {
    for (let i = 0; i < 4; i++) emit(0);
    const pc = names.indexOf(d.nodes.get('.fr-note').textContent);
    const string = +d.nodes.get('.fr-string').textContent.match(/String (\d)/)[1] - 1;
    assert.equal(string, 5 - answer % 6);
    assert.equal(d.nodes.get('.fr-progress').textContent, `Pass ${Math.floor(answer / 6) + 1} / 5 · Step ${answer % 6 + 1} / 6 · ${answer} / 30 accepted`);
    assert.doesNotMatch(d.nodes.get('.fr-progress').textContent, /String/);
    const rows = d.nodes.get('.fr-strings').children;
    rows.forEach((row, i) => {
      assert.equal(row.attributes['data-state'], i > string ? 'complete' : i === string ? 'current' : 'upcoming');
      assert.equal(row.attributes['aria-current'], i === string ? 'step' : undefined);
    });
    const midi = opens[string] + ((pc - opens[string]) % 12 + 12) % 12;
    freq = 440 * 2 ** ((midi - 69) / 12);
    for (let i = 0; i < 3; i++) emit(.05);
  }
  assert.match(d.nodes.get('.fr-progress').textContent, /Completed: 5 passes/);
  assert.equal(d.nodes.get('.fr-mute-cue').attributes['data-state'], 'complete');
  assert.match(d.nodes.get('.fr-mute-cue-text').textContent, /Round complete/);
  assert.equal(d.nodes.get('.fr-live').attributes['data-state'], 'complete');
  assert.equal(d.nodes.get('.fr-completion').value, 30);
  assert.ok(d.nodes.get('.fr-strings').children.every(row => row.attributes['data-state'] === 'complete' && !row.attributes['aria-current']));
  assert.equal(d.nodes.get('.fr-summary').children.length, 6); assert.equal(saves, 1);
  assert.equal(d.nodes.get('.fr-results').hidden, false);
  assert.equal(d.nodes.get('.fr-results').open, false);
  assert.equal(d.nodes.get('.fr-string-summary').open, false);
  assert.equal(d.nodes.get('.fr-progress-details').open, false);
  assert.equal(d.nodes.get('.fr-results-area').hidden, false);
  assert.equal(d.nodes.get('.fr-game').attributes['data-complete'], 'true');
  assert.match(d.nodes.get('.fr-round-total').textContent, /Total .* · Average .* per answer/);
  const worst = d.nodes.get('.fr-history-worst');
  assert.equal(worst.children[1].children.length, 5);
  assert.ok(worst.children[1].children.every(item => / · String \d · .* s$/.test(item.textContent)));
  assert.doesNotMatch(worst.children[1].children[0].textContent, /Round/);
  assert.ok(d.container.innerHTML.indexOf('fr-completion-panel') < d.container.innerHTML.indexOf('fr-history-trend'));
  assert.match(d.container.innerHTML, /<details class="fr-results" hidden><summary>Round results &amp; progress/);
  assert.match(d.container.innerHTML, /<details class="fr-progress-details"><summary>Progress charts &amp; fretboard/);
  assert.match(d.nodes.get('.fr-history-status').textContent, /1 completed rounds.*showing up to the latest 100/);
  const trend = d.nodes.get('.fr-history-trend');
  d.nodes.get('.fr-progress-details').open = true;
  assert.equal(d.nodes.get('.fr-progress-details').open, true);
  d.nodes.get('.fr-progress-details').open = false;
  assert.equal(trend.children[1].attributes.role, 'img');
  assert.equal(trend.children[1].children.length, 1);
  assert.equal(trend.children[2].children[1].children.length, 1);
  assert.match(trend.children[2].children[0].textContent, /View exact round times/);
  const heatmap = d.nodes.get('.fr-history-heatmap').children[3].children[0];
  assert.equal(heatmap.children[1].children[0].children.length, 13);
  assert.deepEqual(heatmap.children[1].children[0].children.slice(1).map(header => header.textContent), Array.from({ length: 12 }, (_, fret) => `Fret ${fret}`));
  assert.equal(heatmap.children[2].children.length, 6);
  assert.match(heatmap.children[2].children[0].children[0].textContent, /String 1 · highest-side · open E4/);
  assert.match(heatmap.children[2].children[5].children[0].textContent, /String 6 · lowest-side · open E2/);
  const rows = heatmap.children[2].children;
  const cells = rows.flatMap(row => row.children.slice(1));
  assert.ok(cells.some(cell => /^[A-G](?:♯ \/ [A-G]♭)? · \d+\.\d+ s \/ \d+\.\d+ s · \d+ · L[1-4]$/.test(cell.textContent)));
  assert.ok(cells.every(cell => cell.textContent.length < 48));
  assert.ok(cells.some(cell => /String \d, .+, fret \d: average .* accepted answers, slowest recent .* intensity [1-4] of 4/.test(cell.attributes['aria-label'])));
  assert.ok(cells.some(cell => cell.textContent === '—' && /String \d, .+, fret \d: no saved answers/.test(cell.attributes['aria-label'])));
  rows.forEach((row, rowIndex) => {
    const openMidi = [64, 59, 55, 50, 45, 40][rowIndex];
    const used = row.children.slice(1).filter(cell => cell.attributes['data-attempts']);
    assert.equal(used.reduce((total, cell) => total + +cell.attributes['data-attempts'], 0), 5);
    used.forEach((cell, fret) => {
      const column = row.children.indexOf(cell) - 1;
      const notes = ['C', 'C♯ / D♭', 'D', 'D♯ / E♭', 'E', 'F', 'F♯ / G♭', 'G', 'G♯ / A♭', 'A', 'A♯ / B♭', 'B'];
      const expectedNote = notes[(openMidi + column) % 12];
      assert.equal(cell.textContent.split(' · ')[0], expectedNote);
      assert.match(cell.attributes['aria-label'], new RegExp(`fret ${column}:`));
    });
  });
  const cFretColumns = rows.map(row => row.children.slice(1).findIndex(cell => cell.textContent.startsWith('C ·')));
  assert.ok(new Set(cFretColumns.filter(fret => fret >= 0)).size > 1);
  assert.match(d.nodes.get('.fr-history-heatmap').children[2].textContent, /level 1 is faster and level 4 is slower/);
  assert.match(d.container.innerHTML, /does not identify a physical string or log incorrect notes/);
  assert.equal(d.nodes.get('.fr-retry').textContent, 'Play again');
  d.nodes.get('.fr-retry').onclick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(d.nodes.get('.fr-results').hidden, true);
  assert.equal(d.nodes.get('.fr-results').open, false);
  assert.equal(d.nodes.get('.fr-results-area').hidden, true);
  assert.equal(d.nodes.get('.fr-game').attributes['data-complete'], undefined);
  assert.equal(d.nodes.get('.fr-string-summary').open, false);
  assert.equal(d.nodes.get('.fr-progress-details').open, false);
  assert.equal(d.nodes.get('.fr-progress').textContent, 'Pass 1 / 5 · Step 1 / 6 · 0 / 30 accepted');
  assert.deepEqual(b.counts(), { stopped: 1, closed: 2 }); game.stop(); assert.equal(d.timers.size, 0);
});
test('failed completion save clears previously rendered slowest answers', async () => {
  const d = dom(), b = browser(); Object.assign(d.win, b.win);
  let time = 0, freq = 440;
  d.win._ndYinDetect = () => ({ freq, confidence: 1 });
  const answers = Array.from({ length: 30 }, (_, i) => ({ stringIndex: i % 6, pitch: i % 12, durationMs: 100 }));
  const run = { completedAt: new Date().toISOString(), totalMs: 3000, averageMs: 100, answers };
  const previous = { [setup.key]: { completed: 1, bestMs: 3000, latest: {}, runs: [run] } };
  d.win.localStorage = {
    getItem: key => key === 'slopsmith_notedetect' ? '{"deviceId":"chosen","channel":"mono"}' : JSON.stringify(previous),
    setItem() { throw new Error('storage unavailable'); },
  };
  const game = mount(d.win, d.container, () => 0); await game.begin();
  const get = name => d.nodes.get(`.fr-${name}`);
  assert.equal(get('results-area').hidden, true);
  assert.equal(get('results').hidden, true);
  const emit = value => { d.advance(85); b.emit(b.frame(value), (time += .085)); };
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const opens = [64, 59, 55, 50, 45, 40];
  for (let answer = 0; answer < 30; answer++) {
    for (let i = 0; i < 4; i++) emit(0);
    const pitch = names.indexOf(get('note').textContent);
    const string = +get('string').textContent.match(/String (\d)/)[1] - 1;
    freq = 440 * 2 ** ((opens[string] + ((pitch - opens[string]) % 12 + 12) % 12 - 69) / 12);
    for (let i = 0; i < 3; i++) emit(.05);
  }
  assert.equal(get('retry').textContent, 'Play again');
  assert.match(get('history-worst').children[0].textContent, /Recent slowest answers are unavailable/);
  assert.equal(get('history-worst').children.length, 1);
  assert.equal(get('results-area').hidden, false);
  game.stop();
});
test('results start hidden in one native disclosure and active play uses compact desktop columns', () => {
  const d = dom(), game = mount(d.win, d.container);
  assert.match(d.container.innerHTML, /<div class="fr-results-area" hidden>[\s\S]*<section class="fr-completion-panel"[\s\S]*fr-history-worst[\s\S]*<details class="fr-results" hidden><summary>Round results &amp; progress<\/summary>/);
  assert.match(d.container.innerHTML, /<details class="fr-results" hidden><summary>Round results &amp; progress<\/summary><div class="fr-results-content">\s*<details class="fr-string-summary"><summary>Per-string round summary/);
  assert.match(d.container.innerHTML, /<details class="fr-progress-details"><summary>Progress charts &amp; fretboard<\/summary><div class="fr-history-trend"><\/div><div class="fr-history-heatmap"><\/div><\/details>/);
  game.stop();
  const css = fs.readFileSync(require.resolve('../assets/game.css'), 'utf8');
  assert.match(css, /\.fr-active-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.1fr\) minmax\(0, \.85fr\) minmax\(250px, 1fr\)/);
  assert.match(css, /\.fr-string-row\s*\{[^}]*min-height:\s*25px/);
  assert.match(css, /\.fr-game\s*\{[^}]*padding:\s*clamp\(12px, 2vw, 22px\)/);
  assert.match(css, /\.fr-game \[hidden\]\s*\{\s*display:\s*none !important;/);
  assert.match(css, /\.fr-results > summary\s*\{[^}]*cursor:\s*pointer/);
  assert.match(css, /\.fr-completion-panel\s*\{[^}]*#193c30/);
  assert.match(css, /\.fr-history-worst li\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(css, /@media \(max-width: 600px\)[\s\S]*?\.fr-active-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\)/);
  assert.match(css, /\.fr-heatmap-wrap\s*\{\s*overflow-x:\s*auto;/);
  assert.match(css, /\.fr-trend-chart\s*\{[^}]*height:\s*44px/);
  assert.match(css, /\.fr-trend-details summary\s*\{\s*cursor:\s*pointer;/);
});
test('responsive history charts remain compact and horizontally scrollable', () => {
  const css = fs.readFileSync(require.resolve('../assets/game.css'), 'utf8');
  assert.match(css, /\.fr-heatmap-wrap\s*\{\s*overflow-x:\s*auto;/);
  assert.match(css, /\.fr-trend-chart\s*\{[^}]*height:\s*44px/);
  assert.match(css, /\.fr-trend-details summary\s*\{\s*cursor:\s*pointer;/);
});
test('mute cue uses distinct waiting and armed colors and remains distinct in forced colors', () => {
  const css = fs.readFileSync(require.resolve('../assets/game.css'), 'utf8');
  assert.match(css, /\.fr-mute-cue\s*\{[^}]*#f2a94a[^}]*#ffe0a6/);
  assert.match(css, /\.fr-mute-cue\[data-state="armed"\]\s*\{[^}]*var\(--fr-accent\)[^}]*#d4ffe9/);
  assert.match(css, /@media \(forced-colors: active\)[\s\S]*?\.fr-mute-cue\[data-state="waiting"\][^{]*\{[^}]*dashed/);
  assert.match(css, /\.fr-mute-cue\[data-state="armed"\][^{]*\{[^}]*Highlight/);
});
test('random mode UI stays selectable only between rounds, reports actual prompts, and saves separate records', async () => {
  const d = dom(), b = browser(); Object.assign(d.win, b.win);
  let time = 0;
  d.win._ndYinDetect = () => ({ freq: 440 * 2 ** ((48 - 69) / 12), confidence: 1 });
  const records = new Map();
  d.win.localStorage = { getItem: key => key === 'slopsmith_notedetect' ? '{"deviceId":"chosen","channel":"mono"}' : records.get(key), setItem: (key, value) => records.set(key, value) };
  const game = mount(d.win, d.container, () => .01);
  d.nodes.get('.fr-random-mode').checked = true;
  d.nodes.get('.fr-random-mode').onchange();
  await game.begin();
  const get = name => d.nodes.get(`.fr-${name}`);
  assert.equal(get('badge').textContent, 'Random · Local records');
  assert.equal(get('random-mode').disabled, true);
  assert.equal(get('passes').hidden, true);
  assert.match(get('progress').textContent, /^Random prompts · 0 \/ 30 accepted · current string 6$/);
  assert.equal(get('string').textContent, 'String 6 · lowest-side');
  const emit = value => { d.advance(85); b.emit(b.frame(value), (time += .085)); };
  for (let answer = 0; answer < 30; answer++) {
    assert.equal(get('note').textContent, 'C');
    assert.equal(get('string').textContent, 'String 6 · lowest-side');
    for (let i = 0; i < 4; i++) emit(0);
    for (let i = 0; i < 3; i++) emit(.05);
  }
  assert.match(get('progress').textContent, /^Random round complete · 30 accepted$/);
  assert.equal(get('retry').textContent, 'Play again');
  assert.equal(get('random-mode').disabled, false);
  assert.match(get('summary').children[5].textContent, /30 answers/);
  assert.match(get('summary').children[0].textContent, /no answers this round/);
  assert.equal(JSON.parse(records.get('fretboard_recall.records.v1')).hasOwnProperty(`${setup.key}:random`), true);
  assert.ok(d.container.innerHTML.indexOf('fr-action-row') < d.container.innerHTML.indexOf('fr-strings-panel'));
  get('random-mode').checked = false;
  get('retry').onclick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.match(get('progress').textContent, /^Pass 1 \/ 5/);
  assert.equal(get('passes').hidden, false);
});

test('random preference saves separately and restores across mounts; invalid or unavailable storage defaults safely', async () => {
  const records = new Map();
  const storage = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) };
  const d = dom(); d.win.localStorage = storage;
  let game = mount(d.win, d.container);
  const mode = d.nodes.get('.fr-random-mode');
  assert.equal(mode.checked, false);
  mode.checked = true; mode.onchange();
   assert.deepEqual(JSON.parse(records.get('fretboard_recall.preferences.v1')), { version: 1, randomMode: true, hardMode: false });
  assert.equal(records.has('fretboard_recall.records.v1'), false);
  game.stop();

  const reloaded = dom(); reloaded.win.localStorage = storage;
  game = mount(reloaded.win, reloaded.container);
  assert.equal(reloaded.nodes.get('.fr-random-mode').checked, true);
  await game.begin();
  assert.match(reloaded.nodes.get('.fr-progress').textContent, /^Random prompts/);
  game.stop();

  for (const stored of ['not-json', '{"version":2,"randomMode":true}', '{"version":1,"randomMode":"true"}']) {
    const corrupt = dom(); corrupt.win.localStorage = { getItem: () => stored, setItem() { throw new Error('unavailable'); } };
    const session = mount(corrupt.win, corrupt.container);
    assert.equal(corrupt.nodes.get('.fr-random-mode').checked, false);
    corrupt.nodes.get('.fr-random-mode').checked = true;
    assert.doesNotThrow(() => corrupt.nodes.get('.fr-random-mode').onchange());
    session.stop();
  }
  const unavailable = dom(); Object.defineProperty(unavailable.win, 'localStorage', { get() { throw new Error('blocked'); } });
  const session = mount(unavailable.win, unavailable.container);
  assert.equal(unavailable.nodes.get('.fr-random-mode').checked, false);
  unavailable.nodes.get('.fr-random-mode').checked = true;
  assert.doesNotThrow(() => unavailable.nodes.get('.fr-random-mode').onchange());
  session.stop();
});

test('hard preference migrates random-only v1 settings and persists both independent modes', () => {
  const saved = new Map([['fretboard_recall.preferences.v1', '{"version":1,"randomMode":true}']]);
  const storage = { getItem: key => saved.get(key) ?? null, setItem: (key, value) => saved.set(key, value) };
  const d = dom(); d.win.localStorage = storage;
  const game = mount(d.win, d.container);
  assert.equal(d.nodes.get('.fr-random-mode').checked, true);
  assert.equal(d.nodes.get('.fr-hard-mode').checked, false);
  d.nodes.get('.fr-hard-mode').checked = true;
  d.nodes.get('.fr-hard-mode').onchange();
  assert.deepEqual(JSON.parse(saved.get('fretboard_recall.preferences.v1')), { version: 1, randomMode: true, hardMode: true });
  game.stop();
  const next = dom(); next.win.localStorage = storage;
  const restored = mount(next.win, next.container);
  assert.equal(next.nodes.get('.fr-random-mode').checked, true);
  assert.equal(next.nodes.get('.fr-hard-mode').checked, true);
  restored.stop();
});

test('hard UI exposes wrong count, advances once per muted mistake, completes at 30 correct, and restarts cleanly', async () => {
  const d = dom(), b = browser(); Object.assign(d.win, b.win);
  let time = 0, midi = 48;
  d.win._ndYinDetect = () => ({ freq: 440 * 2 ** ((midi - 69) / 12), confidence: 1 });
  const records = new Map();
  d.win.localStorage = { getItem: key => key === 'slopsmith_notedetect' ? '{"deviceId":"chosen","channel":"mono"}' : records.get(key), setItem: (key, value) => records.set(key, value) };
  const game = mount(d.win, d.container, () => .01);
  const get = name => d.nodes.get(`.fr-${name}`);
  get('hard-mode').checked = true; get('hard-mode').onchange();
  await game.begin();
  assert.equal(get('badge').textContent, 'Hard · 30 correct · Local records');
  assert.equal(get('passes').hidden, true);
  assert.match(get('progress').textContent, /0 \/ 30 correct · current string 6 · 0 wrong/);
  assert.equal(get('round-progress').hidden, false);
  const emit = value => { d.advance(85); b.emit(b.frame(value), (time += .085)); };
  const arm = () => { for (let i = 0; i < 4; i++) emit(0); };
  const pitchForPrompt = () => {
    const aliases = { 'C♯ / D♭': 1, 'D♯ / E♭': 3, 'F♯ / G♭': 6, 'G♯ / A♭': 8, 'A♯ / B♭': 10 };
    const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
    const spelling = get('note').textContent;
    const pitch = aliases[spelling] ?? names.indexOf(spelling);
    const stringNumber = +get('string').textContent.match(/String (\d)/)[1];
    const open = [64, 59, 55, 50, 45, 40][stringNumber - 1];
    return open + ((pitch - open) % 12 + 12) % 12;
  };
  const firstPrompt = `${get('note').textContent}/${get('string').textContent}`;
  arm(); midi = pitchForPrompt() + 1;
  for (let i = 0; i < 3; i++) emit(.05);
  assert.match(get('progress').textContent, /0 \/ 30 correct.*1 wrong/);
  assert.equal(get('wrong-count-active').textContent, 'Wrong notes: 1');
  assert.equal(get('status').textContent, 'Wrong note — next target. Mute all strings before playing again.');
  const afterMistake = `${get('note').textContent}/${get('string').textContent}`;
  for (let i = 0; i < 8; i++) emit(.05);
  assert.equal(get('wrong-count-active').textContent, 'Wrong notes: 1', 'held wrong note is not callback spam');
  assert.notEqual(afterMistake, firstPrompt);

  for (let answer = 0; answer < 30; answer++) {
    arm(); midi = pitchForPrompt();
    for (let i = 0; i < 3; i++) emit(.05);
    if (answer < 29) assert.match(get('progress').textContent, new RegExp(`${answer + 1} / 30 correct`));
  }
  assert.match(get('progress').textContent, /exactly 30 correct · 1 wrong/);
  assert.match(get('round-total').textContent, /Wrong notes: 1/);
  assert.equal(get('completion').value, 30);
  assert.equal(get('summary').children.length, 6);
  const stored = JSON.parse(records.get('fretboard_recall.records.v1'));
  assert.equal(stored[`${setup.key}:hard`].latest.wrongCount, 1);
  assert.equal(stored[setup.key], undefined);
  const completedResult = structuredClone(stored[`${setup.key}:hard`].latest);
  get('hard-mode').checked = false; get('hard-mode').onchange();
  assert.equal(get('badge').textContent, '5 passes · Local records');
  assert.equal(get('history-status').textContent, 'No saved rounds for this exact setup yet.');
  get('random-mode').checked = true; get('random-mode').onchange();
  assert.equal(get('badge').textContent, 'Random · Local records');
  assert.equal(get('history-status').textContent, 'No saved rounds for this exact setup yet.');
  get('hard-mode').checked = true; get('hard-mode').onchange();
  assert.equal(get('badge').textContent, 'Hard · 30 correct · Local records');
  assert.equal(get('history-status').textContent, 'No saved rounds for this exact setup yet.');
  get('random-mode').checked = false; get('random-mode').onchange();
  assert.match(get('history-status').textContent, /^1 completed rounds · personal best /);
  assert.deepEqual(JSON.parse(records.get('fretboard_recall.records.v1'))[`${setup.key}:hard`].latest, completedResult);
  get('retry').onclick();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.match(get('progress').textContent, /0 \/ 30 correct.*0 wrong/);
  assert.equal(get('wrong-count-active').textContent, 'Wrong notes: 0');
  game.stop();
});

test('requested-string diagram hides open pitches and play again starts a fresh round', async () => {
  const d = dom(), b = browser(); Object.assign(d.win, b.win);
  const game = mount(d.win, d.container, () => 0); await game.begin();
  assert.equal(d.nodes.get('.fr-retry').textContent, 'Starting…');
  assert.doesNotMatch(d.container.innerHTML, /Open tuning|no fret hints|fr-open-note/);
  assert.equal(d.nodes.get('.fr-strings').children[0].children.length, 3);
  assert.equal(d.nodes.get('.fr-strings').children[0].attributes['aria-label'], 'String 1');
  game.stop();
});

test('each prompt plays its exact target MIDI pitch and replay/stop clean owned audio', async () => {
  const d = dom(), b = browser(); Object.assign(d.win, b.win);
  const game = mount(d.win, d.container, () => 0);
  await game.begin();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  const expectedHz = 440 * 2 ** ((48 - 69) / 12);
  assert.equal(b.tones.length, 1);
  assert.ok(Math.abs(b.tones[0].hz - expectedHz) < 1e-9);
  assert.equal(b.tones[0].stoppedAt, .37);
  assert.equal(d.nodes.get('.fr-hear').hidden, false);
  d.nodes.get('.fr-hear').onclick();
  for (let i = 0; i < 4; i++) await Promise.resolve();
  assert.equal(b.tones.length, 2);
  assert.equal(b.tones[0].stopCount, 2);
  game.stop();
  assert.equal(b.tones[1].stopCount, 2);
  assert.equal(b.tones[1].disconnected, true);
  assert.deepEqual(b.counts(), { stopped: 1, closed: 2 });
});

test('blocked automatic reference playback is visible and manual replay recovers', async () => {
  const d = dom(), b = browser(); Object.assign(d.win, b.win);
  let resumes = 0;
  d.win.AudioContext = class extends b.win.AudioContext {
    constructor() { super(); this.state = 'suspended'; }
    async resume() { resumes++; if (resumes === 1) throw new Error('blocked'); this.state = 'running'; }
  };
  const game = mount(d.win, d.container, () => 0);
  await game.begin();
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.match(d.nodes.get('.fr-audio-status').textContent, /blocked or unavailable/i);
  assert.equal(d.nodes.get('.fr-status').textContent.includes('blocked'), false);
  d.nodes.get('.fr-hear').onclick();
  for (let i = 0; i < 8; i++) await Promise.resolve();
  assert.equal(b.tones.length, 1);
  assert.equal(d.nodes.get('.fr-audio-status').textContent, '');
  game.stop();
});

test('saved exact-setup history appears on startup and empty/legacy states are explicit', async () => {
  for (const legacy of [false, true, 'detailed']) {
    const d = dom(), b = browser(); Object.assign(d.win, b.win);
    const key = JSON.stringify(['guitar', 6, [0, 0, 0, 0, 0, 0], 440, [[5, 64], [4, 59], [3, 55], [2, 50], [1, 45], [0, 40]]]);
    const answers = Array.from({ length: 30 }, (_, i) => ({ stringIndex: i % 6, pitch: i % 12, durationMs: 20 + i }));
    const records = legacy ? { [key]: { completed: 4, bestMs: 1200, latest: { totalMs: 1300 }, ...(legacy === 'detailed' ? { runs: [{ completedAt: new Date().toISOString(), totalMs: 1035, averageMs: 34.5, answers }] } : {}) } } : {};
    d.win.localStorage = { getItem: name => name === 'fretboard_recall.records.v1' ? JSON.stringify(records) : '{"deviceId":"chosen","channel":"mono"}' };
    const game = mount(d.win, d.container); await game.begin();
    if (legacy === 'detailed') {
      assert.match(d.nodes.get('.fr-history-status').textContent, /4 completed rounds.*showing up to the latest 100/);
      assert.equal(d.nodes.get('.fr-history-trend').children[1].children.length, 1);
      assert.equal(d.nodes.get('.fr-history-heatmap').children[3].children[0].children[1].children[0].children.length, 13);
    } else assert.match(d.nodes.get('.fr-history-status').textContent, legacy ? /4 older rounds.*Detailed charts start/ : /No saved rounds for this exact setup/);
    game.stop();
  }
});
test('desktop mounted startup waits for explicit input confirmation before capture', async () => {
  const d = dom(), b = browser(); const native = desktop(b);
  // Keep the session clock timer separate from capture identity timers.
  delete b.win.setInterval; delete b.win.clearInterval;
  Object.assign(d.win, b.win);
  let captures = 0; const get = d.win.navigator.mediaDevices.getUserMedia;
  d.win.navigator.mediaDevices.getUserMedia = async constraints => { captures++; return get(constraints); };
  const game = mount(d.win, d.container, () => 0); await game.begin();
  assert.equal(captures, 0); assert.equal(d.nodes.get('.fr-input').hidden, false);
  assert.equal(d.nodes.get('.fr-live').attributes['data-state'], 'consent');
  assert.match(d.nodes.get('.fr-status').textContent, /USB DI.*Channel 2.*Confirm/);
  d.nodes.get('.fr-input').onclick();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(captures, 1); assert.equal(d.nodes.get('.fr-input').hidden, true);
  game.stop(); assert.equal(d.timers.size, 0); assert.equal(native.intervals.size, 0);
});
test('tuning event during deferred desktop identity resolution invalidates stale startup and records', async () => {
  const d = dom(), b = browser(), pending = deferred(); desktop(b);
  delete b.win.setInterval; delete b.win.clearInterval; Object.assign(d.win, b.win);
  let resolving = false, captures = 0, saves = 0;
  d.win.feedBackDesktop.audio.getCurrentDevice = () => { resolving = true; return pending.promise; };
  d.win.navigator.mediaDevices.getUserMedia = () => { captures++; assert.fail('Stale tuning must not capture'); };
  d.win.localStorage.setItem = () => saves++;
  const game = mount(d.win, d.container); const starting = game.begin();
  for (let i = 0; i < 20; i++) await Promise.resolve();
  assert.equal(resolving, true);
  d.win.feedBack.workingTuning.get = () => ({ instrument: 'guitar', stringCount: 6, offsets: [-2, 0, 0, 0, 0, 0], referencePitch: 440 });
  d.subscriptions.get('working-tuning-changed')({ detail: {} });
  pending.resolve({ input: 'USB DI', inputType: 'CoreAudio' }); await starting;
  assert.equal(d.nodes.get('.fr-input').hidden, true); assert.equal(d.nodes.get('.fr-note').textContent, '');
  assert.equal(d.nodes.get('.fr-pause').disabled, true);
  assert.match(d.nodes.get('.fr-status').textContent, /tuning changed.*retry/i);
  d.nodes.get('.fr-input').onclick?.(); d.advance(1000);
  assert.equal(captures, 0); assert.equal(saves, 0); game.stop();
});
test('unannounced tuning changes during identity resolution or before consent are revalidated', async () => {
  for (const duringResolution of [true, false]) {
    const d = dom(), b = browser(), pending = deferred(); desktop(b);
    delete b.win.setInterval; delete b.win.clearInterval; Object.assign(d.win, b.win);
    if (duringResolution) d.win.feedBackDesktop.audio.getCurrentDevice = () => pending.promise;
    let captures = 0; d.win.navigator.mediaDevices.getUserMedia = () => { captures++; assert.fail('Stale capture'); };
    const game = mount(d.win, d.container); const starting = game.begin();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    d.win.feedBack.workingTuning.get = () => ({ instrument: 'guitar', stringCount: 6, offsets: [-2, 0, 0, 0, 0, 0], referencePitch: 440 });
    if (duringResolution) pending.resolve({ input: 'USB DI', inputType: 'CoreAudio' });
    await starting;
    if (!duringResolution) d.nodes.get('.fr-input').onclick();
    assert.equal(d.nodes.get('.fr-input').hidden, true); assert.equal(d.nodes.get('.fr-note').textContent, '');
    assert.match(d.nodes.get('.fr-status').textContent, /setup changed/); assert.equal(captures, 0); game.stop();
  }
});

test('audio feedback never names played notes and flags only confidently graded wrong notes while armed', async () => {
  const d = dom(), b = browser(); Object.assign(d.win, b.win);
  let midi = 61, confidence = 1, time = 0;
  d.win._ndYinDetect = () => ({ freq: 440 * 2 ** ((midi - 69) / 12), confidence });
  const game = mount(d.win, d.container, () => 0.9); await game.begin();
  const get = name => d.nodes.get(`.fr-${name}`);
  const state = () => get('live').attributes['data-state'];
  const cue = () => get('mute-cue');
  const cueText = () => get('mute-cue-text').textContent;
  const emit = value => { d.advance(85); b.emit(b.frame(value), (time += .085)); };
  assert.equal(state(), 'listening');
  assert.match(d.container.innerHTML, /class="fr-mute-cue"[^>]*role="status" aria-live="polite" aria-atomic="true"/);
  assert.equal(cue().attributes['data-state'], 'waiting');
  assert.match(cueText(), /Mute all strings.*then play String 6/);
  assert.match(d.container.innerHTML, /aria-live="polite" aria-atomic="true"/);
  assert.match(d.container.innerHTML.match(/<section class="fr-live"[\s\S]*?<\/section>/)[0], /role="status" aria-live="polite"/);
  const prompt = get('note').textContent;
  emit(.05);
  assert.equal(state(), 'listening');
  assert.doesNotMatch(get('live-status').textContent, /Wrong note/);
  assert.doesNotMatch(get('status').textContent, /Wrong note/);
  for (let i = 0; i < 4; i++) emit(0);
  assert.equal(state(), 'silence');
  assert.equal(cue().attributes['data-state'], 'armed');
  assert.match(cueText(), /Silence gate armed — now play String 6/);
  const armedCueWrites = get('mute-cue-text').writes;
  // This octave is above every possible low-E answer.
  for (let i = 0; i < 5; i++) emit(.05);
  assert.equal(get('live-status').textContent, 'Wrong note — try again');
  assert.equal(get('status').textContent, 'Wrong note — try again.');
  assert.equal(get('live').attributes['data-state'], 'wrong');
  assert.equal(get('mute-cue-text').writes, armedCueWrites, 'stable armed state does not churn cue DOM');
  assert.equal(state(), 'wrong'); assert.equal(get('completion').value, 0);
  assert.equal(get('note').textContent, prompt);
  assert.match(cueText(), /Silence gate armed — now play String 6/);
  d.advance(351);
  assert.equal(state(), 'expired');
  assert.equal(get('status').textContent, 'Mute all strings briefly; then pluck the requested string.');
  assert.doesNotMatch(get('status').textContent, /Ready|Wrong note/);
  assert.doesNotMatch(get('status').textContent, /String [0-9]|[A-G](?:♯|♭)?\d/);
  for (let i = 0; i < 4; i++) emit(0);
  assert.equal(cue().attributes['data-state'], 'armed');
  assert.match(get('status').textContent, /Ready — pluck the requested string/);
  emit(.05);
  const writes = get('live-status').writes;
  emit(.05); emit(.05);
  assert.equal(get('live-status').writes, writes, 'Stable generic status must not rewrite DOM');
  confidence = .69; emit(.05);
  assert.equal(state(), 'uncertain'); assert.equal(get('live-status').textContent, 'Uncertain audio · play one clear note');
  confidence = 1; emit(.005);
  assert.equal(state(), 'quiet'); assert.equal(get('live-status').textContent, 'Listening · signal too quiet');
  emit(0); assert.equal(state(), 'silence');
  const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
  const aliases = { 'D♭': 1, 'E♭': 3, 'G♭': 6, 'A♭': 8, 'B♭': 10 };
  const pc = names.indexOf(prompt) < 0 ? aliases[prompt] : names.indexOf(prompt); midi = 40 + ((pc - 40) % 12 + 12) % 12;
  for (let i = 0; i < 3; i++) emit(.05);
  assert.equal(get('completion').value, 1);
  assert.match(get('string').textContent, /String 5/);
  assert.equal(cue().attributes['data-state'], 'waiting');
  assert.match(cueText(), /Mute all strings.*then play String 5/);
  assert.equal(get('live-status').textContent, 'Listening · waiting for a fresh sample');
  assert.equal(state(), 'listening');
  assert.doesNotMatch(get('live-status').textContent, /[A-G](?:♯|♭)?\d/);
  assert.match(get('status').textContent, /Mute/);
  assert.equal(get('strings').children[5].children[2].textContent, 'Done');
  assert.equal(get('strings').children[4].children[2].textContent, 'Play this string');
  d.advance(351); assert.equal(state(), 'expired');
  emit(.05); assert.equal(state(), 'listening');
  get('pause').onclick(); assert.equal(state(), 'paused');
  assert.equal(cue().attributes['data-state'], 'paused');
  assert.match(cueText(), /Paused — resume, then mute all strings before playing String 5/);
  emit(.05); assert.equal(state(), 'paused');
  get('pause').onclick(); assert.equal(state(), 'listening');
  assert.equal(cue().attributes['data-state'], 'waiting');
  emit(.05); assert.equal(state(), 'listening');
  d.advance(2100); assert.equal(state(), 'failed');
  assert.equal(cue().attributes['data-state'], 'failed');
  assert.doesNotMatch(cueText(), /Muted — now play/);
  assert.match(get('status').textContent, /frames stopped/);
  await game.begin(); assert.equal(state(), 'listening'); assert.equal(get('completion').value, 0);
  assert.equal(cue().attributes['data-state'], 'waiting');
  game.stop(); assert.equal(state(), 'stopped');
});

test('retry clears audio status during deferred acquisition and late teardown cannot restore it', async () => {
  const d = dom(), b = browser(); Object.assign(d.win, b.win);
  const game = mount(d.win, d.container); await game.begin();
  d.advance(85); b.emit(b.frame(.05), .085);
  assert.equal(d.nodes.get('.fr-live-status').textContent, 'Listening · waiting for a fresh sample');
  const pending = deferred(); d.win.navigator.mediaDevices.getUserMedia = () => pending.promise;
  const retrying = game.begin();
  assert.equal(d.nodes.get('.fr-live-status').textContent, 'Reading setup…');
  assert.equal(d.nodes.get('.fr-live').attributes['data-state'], 'startup');
  for (let i = 0; i < 10; i++) await Promise.resolve();
  assert.equal(d.nodes.get('.fr-live').attributes['data-state'], 'acquiring');
  game.stop(); pending.resolve(b.stream); await retrying;
  assert.equal(d.nodes.get('.fr-live').attributes['data-state'], 'stopped');
  assert.equal(d.nodes.get('.fr-live-status').textContent, 'Not listening');
  assert.deepEqual(b.counts(), { stopped: 2, closed: 3 });
});

test('string diagram follows indexed physical mapping, not pitch sorting, for every supported count', async () => {
  for (const [instrument, count] of [['guitar', 6], ['guitar', 7], ['guitar', 8], ['bass', 4], ['bass', 5], ['bass', 6]]) {
    const d = dom(), b = browser(); Object.assign(d.win, b.win);
    // Re-entrant, duplicate opens: highest-side is deliberately the lowest pitch.
    const opens = Array.from({ length: count }, (_, i) => i === count - 1 ? 40 : 64);
    const state = { instrument, stringCount: count, offsets: opens.map(() => 0), referencePitch: 440 };
    const tunings = { tuningMidis: { [`${instrument}-${count}`]: { Standard: opens } } };
    d.win.feedBack.workingTuning.get = () => state;
    d.win.fetch = async () => ({ ok: true, json: async () => tunings });
    let time = 0, midi;
    d.win._ndYinDetect = () => ({ freq: 440 * 2 ** ((midi - 69) / 12), confidence: 1 });
    const game = mount(d.win, d.container, () => 0); await game.begin();
    const rows = d.nodes.get('.fr-strings').children;
    assert.equal(rows.length, count);
    assert.equal(rows[0].children.length, 3);
    assert.equal(rows[count - 1].children.length, 3);
    rows.forEach((row, i) => {
      assert.equal(row.children[0].textContent, `${i + 1}`);
      assert.equal(row.children[2].textContent, i === count - 1 ? 'Play this string' : 'Up next');
      assert.equal(row.attributes['data-state'], i === count - 1 ? 'current' : 'upcoming');
      assert.equal(row.attributes['aria-current'], i === count - 1 ? 'step' : undefined);
    });
    assert.equal(d.nodes.get('.fr-completion').max, 5 * count);
    assert.equal(d.nodes.get('.fr-passes').children.length, 5);
    assert.equal(d.nodes.get('.fr-passes').children[0].attributes['data-state'], 'current');
    assert.equal(d.nodes.get('.fr-string').textContent, `String ${count} · lowest-side`);
    const emit = value => { d.advance(85); b.emit(b.frame(value), (time += .085)); };
    const names = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
    for (let answer = 0; answer < 5 * count; answer++) {
      const index = answer % count;
      assert.match(d.nodes.get('.fr-string').textContent, new RegExp(`^String ${count - index}(?: ·|$)`));
      assert.equal(d.nodes.get('.fr-progress').textContent, `Pass ${Math.floor(answer / count) + 1} / 5 · Step ${index + 1} / ${count} · ${answer} / ${5 * count} accepted`);
      rows.forEach((row, i) => {
        const position = count - 1 - i;
        assert.equal(row.attributes['data-state'], position < index ? 'complete' : position === index ? 'current' : 'upcoming');
        assert.equal(row.attributes['aria-current'], position === index ? 'step' : undefined);
      });
      const pc = names.indexOf(d.nodes.get('.fr-note').textContent);
      midi = opens[index] + ((pc - opens[index]) % 12 + 12) % 12;
      for (let i = 0; i < 4; i++) emit(0);
      for (let i = 0; i < 3; i++) emit(.05);
    }
    assert.equal(d.nodes.get('.fr-completion').value, 5 * count);
    assert.ok(rows.every(row => row.attributes['data-state'] === 'complete'));
    game.stop();
  }
});
