const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Round: RuntimeRound, snapshotSetup, choosePitch, noteName, storeRecord, scaledRms } = require('../game.js');
class Round extends RuntimeRound {
  sample(value, now) { return super.sample({ captureTime: now, ...value }, now); }
}

const bases = {
  'guitar-6': [40, 45, 50, 55, 59, 64], 'guitar-7': [35, 40, 45, 50, 55, 59, 64],
  'guitar-8': [30, 35, 40, 45, 50, 55, 59, 64], 'bass-4': [28, 33, 38, 43],
  'bass-5': [23, 28, 33, 38, 43], 'bass-6': [23, 28, 33, 38, 43, 48],
};
const tunings = { tuningMidis: Object.fromEntries(Object.entries(bases).map(([k, v]) => [k, { Standard: v }])) };
function setup(instrument = 'guitar', stringCount = 6, offsets = Array(stringCount).fill(0), referencePitch = 440) {
  return snapshotSetup({ instrument, stringCount, offsets, referencePitch }, tunings);
}
function accept(r, time) {
  for (let t = time; t <= time + 200; t += 20) { r.tick(20); r.sample({ level: 0, midi: null, confidence: 0 }, t); }
  for (let t = time + 220; t <= time + 360; t += 20) {
    r.tick(20);
    if (r.sample({ level: .2, midi: r.target().midi, confidence: .95 }, t)) return t;
  }
  throw new Error('Answer did not accept');
}

test('all 12 notes have exactly one intended fret in 0–11 on all supported mappings', () => {
  for (const key of Object.keys(bases)) {
    const [instrument, n] = key.split('-');
    const s = setup(instrument, +n);
    assert.deepEqual(s.strings.map(s => s.index), Array.from({ length: +n }, (_, i) => +n - i - 1));
    for (let pc = 0; pc < 12; pc++) {
      const r = new Round(s); r.pitch = pc;
      for (let i = 0; i < +n; i++) {
        r.string = i;
        const target = r.target();
        const open = s.strings[+n - 1 - i].midi;
        assert.equal(target.index, i);
        assert.ok(target.midi - open >= 0 && target.midi - open <= 11);
        assert.equal(target.midi % 12, pc);
      }
    }
  }
});
test('random selection covers all twelve and never immediately repeats', () => {
  assert.deepEqual(Array.from({ length: 12 }, (_, i) => choosePitch(null, () => (i + .1) / 12)), Array.from({ length: 12 }, (_, i) => i));
  for (let prev = 0; prev < 12; prev++) {
    const values = Array.from({ length: 11 }, (_, i) => choosePitch(prev, () => (i + .1) / 11));
    assert.equal(new Set(values).size, 11); assert.ok(!values.includes(prev));
  }
});
test('dual accidentals and duplicate string labels distinguish octaves and positions', () => {
  assert.equal(noteName(8), 'G♯ / A♭');
  const s = setup();
  assert.match(s.strings[0].label, /E4.*highest/); assert.match(s.strings[5].label, /E2.*lowest/);
  const dup = setup('guitar', 6, [24, 19, 14, 9, 5, 0]);
  assert.equal(new Set(dup.strings.map(s => s.label)).size, 6);
});
test('unsupported, unresolved and malformed host setup fails without standard fallback', () => {
  const state = { instrument: 'guitar', stringCount: 6, offsets: [0, 0, 0, 0, 0, 0], referencePitch: 440 };
  for (const partial of [{ instrument: 'ukulele' }, { stringCount: 4 }, { offsets: null }, { offsets: [0] }, { offsets: [0, 0, 0, 0, 0, NaN] }, { referencePitch: 0 }]) {
    assert.throws(() => snapshotSetup({ ...state, ...partial }, tunings));
  }
  assert.throws(() => snapshotSetup(state, {}));
});
test('exact setup key separates instrument, mapping, tuning and reference', () => {
  const keys = [setup(), setup('guitar', 6, [-2, 0, 0, 0, 0, 0]), setup('guitar', 7), setup('bass', 6), setup('guitar', 6, [0, 0, 0, 0, 0, 0], 442)].map(s => s.key);
  assert.equal(new Set(keys).size, keys.length);
});
test('every pass progresses low physical side to high for standard, custom and re-entrant mappings', () => {
  for (const [key, base] of Object.entries(bases)) {
    const [instrument, count] = key.split('-');
    const n = +count;
    for (const [mapping, offsets] of [
      [base, Array(n).fill(0)],
      [base, Array.from({ length: n }, (_, i) => i % 2 ? 2 : -2)],
      [Array.from({ length: n }, (_, i) => i === n - 1 ? 40 : 64), Array(n).fill(0)],
    ]) {
      const s = snapshotSetup({ instrument, stringCount: n, offsets, referencePitch: 440 }, { tuningMidis: { [key]: { Standard: mapping } } });
      const canonical = Array.from({ length: n }, (_, i) => [n - 1 - i, mapping[n - 1 - i] + offsets[n - 1 - i]]);
      assert.deepEqual(s.strings.map(s => [s.index, s.midi]), canonical);
      assert.equal(s.key, JSON.stringify([instrument, n, offsets, 440, canonical]));
      const r = new Round(s, () => .5);
      let time = 0;
      for (let pass = 0; pass < 5; pass++) {
        for (let index = 0; index < n; index++) {
          const target = r.target();
          const open = mapping[index] + offsets[index];
          assert.equal(r.pass, pass);
          assert.equal(target.index, index);
          assert.equal(target.midi, open + ((r.pitch - open) % 12 + 12) % 12);
          time = accept(r, time) + 20;
          if (!r.done) r.displayed();
        }
      }
      assert.equal(r.done, true);
      assert.deepEqual(r.answers.map(a => a.stringIndex), Array.from({ length: 5 * n }, (_, i) => i % n));
      assert.deepEqual(r.summary().strings.map(s => s.index), canonical.map(s => s[0]));
      assert.deepEqual(s.strings.map(s => [s.index, s.midi]), canonical);
    }
  }
});
test('ringing, wrong pitches, low confidence and wrong octaves never advance', () => {
  const r = new Round(setup());
  for (let t = 0; t < 1000; t += 20) assert.equal(r.sample({ level: .2, midi: r.target().midi, confidence: 1 }, t), false);
  for (let t = 1000; t <= 1200; t += 20) r.sample({ level: 0 }, t);
  assert.equal(r.armed, true);
  for (const delta of [1, 12, -12]) for (let t = 1220; t < 1500; t += 20) assert.equal(r.sample({ level: .2, midi: r.target().midi + delta, confidence: 1 }, t), false);
  for (let t = 1500; t < 1800; t += 20) assert.equal(r.sample({ level: .2, midi: r.target().midi, confidence: .2 }, t), false);
  assert.equal(r.answers.length, 0);
});
test('missing or reused processing timestamps never accumulate silence or pitch hold', () => {
  const r = new RuntimeRound(setup());
  for (let t = 0; t < 300; t += 20) r.sample({ level: 0, captureTime: 0 }, t);
  assert.equal(r.armed, false);
  for (let t = 300; t <= 500; t += 20) r.sample({ level: 0, captureTime: t }, t);
  assert.equal(r.armed, true);
  for (let t = 520; t < 800; t += 20) r.sample({ level: .2, midi: r.target().midi, confidence: 1, captureTime: 520 }, t);
  assert.equal(r.answers.length, 0);
  r.sample({ level: 0 }, 800); assert.equal(r.armed, false);
});
test('silence must be contiguous measured samples, not failed pitch verification', () => {
  const r = new Round(setup());
  for (let t = 0; t < 300; t += 20) r.sample({ level: .1, midi: null, confidence: 0 }, t);
  assert.equal(r.armed, false);
  r.sample({ level: 0 }, 400); r.sample({ level: 0 }, 1000);
  assert.equal(r.armed, false);
  r.sample({ level: NaN }, 1020); assert.equal(r.quietAt, null);
});
test('five passes retain pitch within each pass, immediate next prompt and rearm', () => {
  const r = new Round(setup(), () => .5);
  let time = 0, previousPitch = null;
  for (let pass = 0; pass < 5; pass++) {
    const pitch = r.pitch; assert.notEqual(pitch, previousPitch);
    for (let string = 0; string < 6; string++) {
      assert.equal(r.pitch, pitch); assert.equal(r.string, string);
      time = accept(r, time) + 20;
      assert.equal(r.armed, false);
      if (!r.done) r.displayed();
    }
    previousPitch = pitch;
  }
  assert.equal(r.done, true); assert.equal(r.answers.length, 30);
  const summary = r.summary();
  assert.equal(summary.totalMs, r.elapsed); assert.equal(summary.averageMs, summary.totalMs / 30);
  for (const s of summary.strings) assert.equal(s.averageMs, s.totalMs / 5);
});
test('random mode independently selects repeatable pitch classes and physical strings for five times string count', () => {
  const s = setup();
  let choice = 0;
  const r = new Round(s, () => {
    const call = choice++, prompt = Math.floor(call / 2);
    return call % 2 ? (prompt === 0 ? .01 : .99) : ([.01, .99, .01][prompt] ?? .5);
  }, { randomMode: true });
  assert.equal(r.mode, 'random');
  assert.equal(r.pitch, 0); assert.equal(r.target().index, 0);
  let time = 0;
  for (let answer = 0; answer < 5 * s.stringCount; answer++) {
    if (answer === 0) { assert.equal(r.pitch, 0); assert.equal(r.target().index, 0); }
    if (answer === 1) { assert.equal(r.pitch, 11); assert.equal(r.target().index, 5); }
    if (answer === 2) { assert.equal(r.pitch, 0); assert.equal(r.target().index, 5); }
    const target = r.target();
    const open = s.strings.find(item => item.index === target.index).midi;
    assert.equal(target.midi, open + ((target.pitch - open) % 12 + 12) % 12);
    time = accept(r, time) + 20;
    if (!r.done) r.displayed();
  }
  assert.equal(r.done, true); assert.equal(r.answers.length, 30);
  assert.equal(r.answers[0].stringIndex, 0);
  assert.ok(r.answers.slice(1).every(answer => answer.stringIndex === 5));
  const result = r.summary();
  assert.equal(result.mode, 'random');
  assert.deepEqual(result.strings.map(item => item.count), [29, 0, 0, 0, 0, 1]);
  assert.equal(result.strings[1].averageMs, null);
  assert.ok(result.strings.slice(1, 5).every(item => item.totalMs === 0 && item.averageMs === null));
});
test('pause excludes time and clears silence/hit state without skipping', () => {
  const r = new Round(setup()); r.tick(100); r.sample({ level: 0 }, 100);
  r.pause(true); r.tick(5000); assert.equal(r.elapsed, 100);
  r.sample({ level: .2, midi: r.target().midi, confidence: 1 }, 5000);
  r.pause(false); assert.equal(r.armed, false); assert.equal(r.answers.length, 0);
  assert.throws(() => r.summary());
});
test('local records save only supplied completed summaries grouped by exact setup', () => {
  const map = new Map(); const storage = { getItem: k => map.get(k), setItem: (k, v) => map.set(k, v) };
  const a = setup(), b = setup('bass', 4);
  assert.equal(storeRecord(storage, a, { totalMs: 200 }).completed, 1);
  assert.equal(storeRecord(storage, a, { totalMs: 300 }).bestMs, 200);
  assert.equal(storeRecord(storage, a, { totalMs: 100 }).bestMs, 100);
  assert.equal(storeRecord(storage, b, { totalMs: 500 }).completed, 1);
  assert.equal(storeRecord(storage, a, { totalMs: 700 }, 'random').completed, 1);
  assert.equal(storeRecord(storage, a, { totalMs: 600 }, 'random').bestMs, 600);
  assert.equal(storeRecord(storage, a, { totalMs: 150 }).completed, 4);
  const stored = JSON.parse(map.values().next().value);
  assert.equal(stored[`${a.key}:random`].completed, 2);
  assert.equal(stored[a.key].completed, 4);
  assert.equal(Object.hasOwn(stored[a.key], 'mode'), false);
  assert.throws(() => storeRecord({ getItem: () => '{' }, a, { totalMs: 1 }));
});
test('RMS meters raw signal without DSP or held pitch as a silence proxy', () => {
  assert.equal(scaledRms(new Float32Array(20)), 0);
  assert.ok(Math.abs(scaledRms([.02, -.02]) - .1) < 1e-6);
  assert.throws(() => scaledRms([])); assert.throws(() => scaledRms([NaN]));
});
