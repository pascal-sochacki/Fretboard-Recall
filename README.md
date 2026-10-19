# Fretboard Recall

Standalone chart-free [FeedBack](https://github.com/got-feedback/feedBack)
minigame, ID `fretboard_recall`. Direct browser script and scoped CSS; no build,
CDN, dependencies, backend, leaderboard or XP.

## Install / supported input

Install this directory as a standard plugin in **your own installation's**
`plugins/fretboard_recall`, or use the host's external plugin-directory setup,
then reload/restart FeedBack. This checkout has not been installed into siblings.
Enable the bundled Minigames framework and Note Detection plugin.

**FeedBack Desktop is supported conditionally through its Electron audio
capture**, with explicit confirmation of the host-configured device/channel.
Native ring polling is not used. The game reads `audio.getCurrentDevice()` and
`audio.listSources()` and requires one uniquely matching, exact-name Electron
`audioinput` device (not `default` / `communications`). It displays that input,
channel and native driver type; click **Use Electron capture** to consent before
any capture starts. It opens the matched device ID exactly and verifies the
resulting track's device ID, label and channel availability. No new device/tuning
selectors, automatic OS-default microphone substitution, or native routing /
monitor changes. An identity watcher aborts if native host device/channel changes.

This works only where Electron can simultaneously open that input. ASIO-only,
exclusive-device, hidden-label, differently named and duplicate-name inputs fail
explicitly instead of guessing. Allow OS/app microphone permission, choose a
host input/channel exposed to Electron, and Retry. The game **does not** switch
the native engine away from ASIO or stop host audio to make capture work.
Supported native channels are mono first pair, channel 1, or channel 2.
Matching names is a conservative, user-confirmed mapping—not proof that native
and Chromium driver endpoints are physically identical. Check the displayed DI
and actual signal before use; no physical identity guarantee is claimed.

In an ordinary web browser, select an explicit device/channel in host Note
Detection settings. Use HTTPS or localhost and allow input permission.

Requires recent host `workingTuning.get`, lifecycle `on/off/navigate`, and exact
`/api/tunings.tuningMidis` mappings. Supports guitar 6/7/8 and bass 4/5/6 strings,
integer-semitone custom offsets and A4 400–480 Hz. Unknown/unresolved tuning is
not Standard: select/resolve the live tuning in the host tuner, then Retry.
Some very low tunings/high sample rates are explicitly rejected if a complete
analysis window cannot resolve the fundamental at the required callback cadence.

## Use

1. Select your actual instrument, count, tuning and input **in FeedBack**, then
   open Minigames → Fretboard Recall. No duplicated setup selectors.
2. A round has five passes. Each selects one of all twelve pitch classes,
   excluding the preceding pass's pitch. Find that same pitch class on every
   string, lowest-side to highest-side (standard guitar: low E, A, D, G, B,
   high E), within frets **0–11**, in the intended
   octave. The screen gives only note name and string instruction, not the fret,
    answer hint, reference sound or fret locations. Accidentals have dual names.
3. Mute all strings briefly, then pluck the requested string. The next prompt
   displays immediately on acceptance, but must observe a new mute before
   arming. Wrong notes never advance or penalize. No skip.
4. Pause/Resume excludes paused time and resets the gate. Background tabs pause;
   resume explicitly. Stop/Back or the stage Quit abandons without a record.
   Host tuning changes abandon visibly; Retry starts fresh.

**Microphone/DI pitch cannot verify the physical string when identical pitch
exists elsewhere.** Honor the requested string yourself. No string detection
is claimed. String labels include number (1 = highest-side), open-note octave,
and highest/lowest-side markers. Duplicate open names/pitches remain distinct
by string number. Re-entrant tunings retain physical host mapping order rather
than sorting by pitch.

The responsive UI separates the prominent target pitch class from the live
detected chromatic note and its reported octave. A physical-string diagram shows
numbered open notes, highlighting **only the requested string**, never a fret or
an inferred detected string. The diagram keeps highest-side at the top and
lowest-side at the bottom; each pass starts at the bottom and progresses upward.
Pass steps and an answer-progress bar track the round.
Live input uses the same callback and level/confidence thresholds as grading:
held wrong notes remain visible without advancing, while silence, quiet input,
uncertain pitch, acquisition, pause and failure have explicit text states.
The last note clears after 350 ms without a callback and on lifecycle resets;
it is never relabeled as a match to the next prompt. Target changes are politely
announced; the live note does not flood screen readers with audio-rate updates.

Silence requires 180 ms below scaled PCM RMS 0.02, followed by RMS ≥0.04,
confidence ≥0.70, and ±35 cents of the exact expected octave persisting for
120 ms. Missing/repeated processing timestamps never accumulate the gate;
callback arrival gaps over 100 ms reset it. Each loud callback gets a new
synchronous pitch calculation on **that callback's complete PCM buffer**.
Adjust host input noise/gain if muting cannot arm; no pitch-verifier miss or
low-confidence estimate is treated as silence.

Responses are timed from prompt display to acceptance, **including muting**,
initial device acquisition and DSP/gate latency, excluding pause time. Live
round/prompt elapsed and progress accompany the prompt. Completion shows total,
average per answer, and each string's total/average across five responses.

Records are only in this browser/device/origin's `localStorage`, key
`fretboard_recall.records.v1`: completed count, personal best total and latest
summary, grouped by exact instrument/count/ordered offsets/reference/indexed
open MIDI mapping. Abandonment does not save. Storage failure is visible.
No cloud account, export, public submission or synchronization. Clearing site
storage removes records.

## Source-supported API decisions and review fixes

- Inspected `feedBack/plugins/minigames/README.md` and `screen.js`: manifest
  discovery and safe pending registration. `sdk.end()` **always** publicly
  submits/awards shared XP, including Quit. This plugin never invokes it or
  `submitRun`/`runSummary`. Completion stays in the private stage summary;
  New round resets locally. A stage-Quit capture listener prevents its default
  handler and navigates with `feedBack.navigate('home')`, triggering the
  framework's non-scoring navigation teardown. Settings also navigates away.
  No global SDK/private framework state is patched. The generic hub still
  shows “Runs 0 / Best 0” and shared profile chrome, not local records. An
  unrelated external caller explicitly invoking global `end()` would still
  submit: this plugin does not alter global behavior.
- `static/capabilities/note-detection.js` is a control-plane skeleton, not an
  executable audio pitch/level binding provider. A nominal binding cannot
  deliver the required primitives here.
- **Removed the asynchronous detector-instance snapshot path.** Inspected Note
  Detection 1.32.0 `screen.js:1453–1498` declares `_ndYinDetect(buffer,
  sampleRate, minFreqHz)` at top level as a synchronous function, returning
  `{freq, confidence, underBuffered}`. Its manifest declares a classic script;
  the host's `static/js/plugin-loader.js:651–666` loads it as such, making this
  declaration callable on `window`. This is an **internal, version-sensitive
  host primitive**, not a claimed stable public SDK. It is explicitly checked;
  a module-only/changed host that does not expose it fails before input opens.
  No host DSP code is copied and no `_harness` test-only hooks are used.
- The game binds that host YIN function and passes each new Web Audio
  `ScriptProcessor` callback's entire selected-channel frame directly to it.
  No cached `rawMidi`/confidence, asynchronous CREPE, overlapping analysis,
  polling, zero-padded cold-start window or frame accumulation exists. The
  host's saved method is deliberately **not followed**: even if host song
  detection uses CREPE/HPS, this isolated game uses synchronous YIN for
  callback-local estimates. No global settings/detector ownership is changed.
  An incompatible Promise/underbuffered return fails explicitly.
- Browser input uses exact saved Note Detection device/channel and verifies
  `track.getSettings()`. Only private capture nodes are made, with a final
  unconditional zero gain to destination. Neither a detector instance nor a
  song highway/chart provider is constructed. Cleanup disconnects all owned
  nodes, clears callbacks, stops owned tracks, closes its AudioContext and
  removes timers/listeners. Startup and callbacks remain generation-guarded.
- Further read-only desktop exploration found a real existing Electron route:
  `src/main/main.ts:974–1039` installs origin/port-scoped permission handlers
  allowing audio-only `getUserMedia`, and `1097–1161` handles macOS microphone
  permission. Note Detection `screen.js:15554–15639` already uses parallel
  browser capture for native training recordings; `11955–11979` deliberately
  hides its browser device picker when native audio is managed. Therefore the
  game does **not** assume a saved browser device is the current native device:
  it uses the read-only native identity APIs plus Electron enumeration and
  explicit capture consent described above. No desktop bridge or sibling API
  was added. DSP executes synchronously on Electron's new callback buffers just
  as on web, through the inspected host YIN primitive.
- **Removed native pooled sources altogether**, addressing retained DSP and
  ineffective monitor mute as well as freshness/sentinel support blockers.
  Inspected desktop `SourcePool.cpp:28–47` does not reset every reused chain's
  effects; `SourceChain`/`SignalChain` monitor mute is not a guaranteed final
  output kill for arbitrary retained chains. `SourceChain.cpp:349–369` returns
  nonempty zero-padded PCM even before any samples have arrived. Preload/bridge
  raw pitch APIs can exist while returning perpetual missing-addon sentinels.
  No exposed input capture progression counter was found: device metrics contain
  overflow/underflow/output-ring counts, not input sample sequence. The native
  primary `setMonitorKill` is unconditional but global and not requester-owned;
  there is no equivalent pooled-source kill/reset contract in preload. The
  audio-input/monitoring capability returns session summaries, not a transferable
  captured stream or timestamped input chunks. Rather than mutate native DSP,
  change global monitoring or invent ring freshness, this adapter only performs
  native identity **reads** and uses independently owned Electron capture after
  confirmation. Missing native pitch addon sentinels are irrelevant because
  no native pitch estimate is read.
- Host working tuning and exact server Standard MIDI rows define indexed opens.
  No runtime hardcoded standard mapping or stale-song tuning fallback. Host
  tuning provenance is shown honestly, not claimed physical verification by
  this game.

## Honest remaining limitations

No real microphone/DI, browser UI integration, or desktop device run was tested.
Desktop Electron capture is source-supported and mock-tested, not hardware
validated. Direct native/ASIO-only capture remains blocked by the missing input
progression API; no sibling APIs were added or modified.

For native-only devices, the minimal proposed **future host addition** is a
read-only requester-scoped input tap: open against the selected source without
adding a monitor/DSP chain, return successive complete chunks with actual engine
sample rate, source/device/channel identity, a stream-generation ID and monotonic
captured-sample end index, report unavailable/stopped/overflow explicitly, and
close only that requester's tap. Sequence is callback/sample progression, not
an impossible ADC-freshness guarantee. This would avoid pooled resets/monitor
kill entirely and allow this plugin to run host synchronous DSP on new chunks.
It requires changes to native addon → bridge → preload (and ideally host
audio-input binding), so **user permission is needed before implementing it**.

Web Audio `AudioProcessingEvent.playbackTime` is a **processing timestamp**,
not a hardware ADC capture timestamp. Increasing timestamps prove successive
callback buffers were processed; the synchronous calculation ensures the
estimate comes from that same buffer. They do **not** prove the driver supplied
fresh physical samples. A malfunctioning driver can replay PCM while the browser
clock advances; no available API can distinguish this from legitimately equal
audio. The game does not compare sample values and pretend that proves capture
progress. Muted/dead tracks, suspended context, missing/repeated processing
timestamps and callback starvation fail/reset explicitly, but zero input cannot
distinguish a disconnected cable upstream of a running interface from silence.

YIN may lock onto a harmonic/wrong octave with suppressed fundamentals,
distortion, low bass or polyphony. Exact-octave checks apply to the **reported**
estimate; they cannot guarantee the DSP was correct. Use clean single-string DI.
Private windows are sized to cover at least two periods of the lowest configured
open pitch (minimum 4096); supported callback windows are at most 100 ms.
Fixed gates/latencies are not calibrated reaction-time measurements. The internal
YIN seam is a compatibility limitation and deliberately fails on unsupported
host versions rather than falling back to timestamp-free snapshots.

Before release test hardware note/octave accuracy, duplicate notes, repeated
ring-out, tuning changes, permissions, unplug/replug, backgrounding, and
concurrent host detection. These remain real-device validation tasks.

## Tests

```sh
npm test
node --check game.js
git diff --check
```

Node built-in tests, no install/build. Pure logic tests cover all twelve pitches,
all mappings, octaves, **actual low-confidence samples**, silence/persistence,
repeated/missing timestamps, pause, five passes, timing and local records.
Lifecycle mocks cover synchronous per-buffer DSP vs stale async snapshots,
unsupported async returns, desktop explicit consent, exact-name/device/channel
mapping and mismatch/duplicate/exclusive failures, native identity changes,
desktop capture with no DSP/monitor/ring writes,
explicit input/permission failures, late permission cleanup, repeated processing
timestamps, owned-node cleanup, completed browser rounds and real EventTarget
Quit cancellation/propagation. UI mocks also cover held wrong-note display,
silence/quiet/uncertain states, freshness expiry, pause/resume, retry acquisition,
late teardown, completion, stable note DOM writes, and physical diagram ordering
for every supported string count (including re-entrant and duplicate opens).
Mocks cannot prove rendered layout, screen-reader behavior, driver freshness or hardware
DSP accuracy; no invented native timestamp fields are used in tests.

## License

Original code is **MIT** (`LICENSE`); no host DSP/framework implementation copied.
Inspected FeedBack core is **AGPL-3.0** and Note Detection declares **MIT**.
This license does not relicense FeedBack or remove combined/derived application
distribution/network obligations. Preserve upstream notices and assess your
deployment's license requirements; not legal advice.
