'use strict';

const STEPS = 16;
const PITCHES = [72, 71, 69, 67, 65, 64, 62, 60];
const ROWS = PITCHES.length;
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const DRUM_ROWS = ['deep', 'drip'];
const DRUM_COUNT = DRUM_ROWS.length;

const PARAMS = [
  { id: 'waveform', label: 'waveform', type: 'select', options: ['sine', 'triangle', 'square', 'sawtooth'], value: 'triangle' },
  { id: 'detune', label: 'detune', min: 0, max: 50, step: 1, value: 8, unit: 'ct' },
  { id: 'breath', label: 'breath', min: 0, max: 1, step: 0.01, value: 0.22 },
  { id: 'cutoff', label: 'cutoff', min: 200, max: 8000, step: 10, value: 2600, unit: 'Hz' },
  { id: 'vibDepth', label: 'vib depth', type: 'slider', min: 0, max: 60, step: 1, value: 18, unit: 'ct' },
  { id: 'vibRate', label: 'vib rate', type: 'slider', min: 0.5, max: 10, step: 0.1, value: 5.2, unit: 'Hz' },
  { id: 'attack', label: 'attack', type: 'slider', min: 0.005, max: 0.5, step: 0.005, value: 0.06, unit: 's' },
  { id: 'release', label: 'release', type: 'slider', min: 0.05, max: 2, step: 0.05, value: 0.25, unit: 's' },
];

const COMMON_PARAMS = [
  { id: 'detuneAll', label: 'detune all', min: -50, max: 50, step: 1, value: 0, unit: 'ct' },
  { id: 'wet', label: 'wet', min: 0, max: 1, step: 0.01, value: 0.4 },
];

const DRUM_PARAMS = [
  { id: 'underCutoff', label: 'underwater', min: 200, max: 4000, step: 10, value: 1200, unit: 'Hz' },
  { id: 'drumLevel', label: 'drum level', min: 0, max: 1, step: 0.01, value: 0.6 },
  { id: 'deepPitch', label: 'deep pitch', type: 'slider', min: 40, max: 200, step: 1, value: 110, unit: 'Hz' },
  { id: 'deepDecay', label: 'deep decay', type: 'slider', min: 0.1, max: 0.8, step: 0.01, value: 0.3, unit: 's' },
  { id: 'dripTone', label: 'drip tone', type: 'slider', min: 300, max: 3000, step: 10, value: 1200, unit: 'Hz' },
  { id: 'dripDecay', label: 'drip decay', type: 'slider', min: 0.05, max: 0.4, step: 0.01, value: 0.15, unit: 's' },
];

const VOLUME_PARAM = { id: 'volume', label: 'volume', min: 0, max: 1, step: 0.01, value: 0.7 };

const ALL_PARAMS = PARAMS.concat(COMMON_PARAMS, DRUM_PARAMS, [VOLUME_PARAM]);

const FLUTE_DEMO = [[0, 0], [2, 2], [4, 3], [6, 5], [8, 6], [10, 5], [12, 3], [14, 7]];
const DRUM_DEMO = [[0, 0], [8, 0], [6, 1], [14, 1]];

const params = {};
for (const p of ALL_PARAMS) params[p.id] = p.value;

function detuneMul() {
  return Math.pow(2, params.detuneAll / 1200);
}

const notes = Array.from({ length: STEPS }, () => new Array(ROWS).fill(false));
for (const [step, row] of FLUTE_DEMO) notes[step][row] = true;

const drumNotes = Array.from({ length: STEPS }, () => new Array(DRUM_COUNT).fill(false));
for (const [step, row] of DRUM_DEMO) drumNotes[step][row] = true;

let fluteCells = [];
let drumCells = [];
let audio = null;
let noiseBuffer = null;
let isPlaying = false;
let currentStep = 0;
let nextStepTime = 0;
let schedulerId = null;
let playheadStep = -1;
let previewOn = true;

const $ = (sel) => document.querySelector(sel);

function midiToFreq(midi) {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

function makeImpulse(ctx, seconds, decay) {
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * seconds);
  const buf = ctx.createBuffer(2, len, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
  }
  return buf;
}

function ensureAudio() {
  if (audio) {
    if (audio.ctx.state === 'suspended') audio.ctx.resume();
    return audio;
  }
  const AC = window.AudioContext || window.webkitAudioContext;
  const ctx = new AC();

  const master = ctx.createGain();
  master.gain.value = params.volume;

  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -18;
  comp.knee.value = 24;
  comp.ratio.value = 6;
  comp.attack.value = 0.005;
  comp.release.value = 0.15;

  master.connect(comp);
  comp.connect(ctx.destination);

  const convolver = ctx.createConvolver();
  convolver.buffer = makeImpulse(ctx, 2.2, 2.6);
  const reverbOut = ctx.createGain();
  reverbOut.gain.value = 0.9;
  convolver.connect(reverbOut);
  reverbOut.connect(master);

  const bus = ctx.createGain();
  const dry = ctx.createGain();
  dry.gain.value = 1;
  const wet = ctx.createGain();
  wet.gain.value = params.wet;
  bus.connect(dry);
  dry.connect(master);
  bus.connect(wet);
  wet.connect(convolver);

  const drumBus = ctx.createGain();
  drumBus.gain.value = params.drumLevel;
  const drumFilter = ctx.createBiquadFilter();
  drumFilter.type = 'lowpass';
  drumFilter.frequency.value = params.underCutoff;
  drumFilter.Q.value = 0.7;
  const drumDry = ctx.createGain();
  drumDry.gain.value = 1;
  drumBus.connect(drumFilter);
  drumFilter.connect(drumDry);
  drumDry.connect(master);
  drumFilter.connect(wet);

  const noiseLen = Math.floor(ctx.sampleRate * 2);
  noiseBuffer = ctx.createBuffer(1, noiseLen, ctx.sampleRate);
  const nd = noiseBuffer.getChannelData(0);
  for (let i = 0; i < noiseLen; i++) nd[i] = Math.random() * 2 - 1;

  audio = { ctx, master, bus, wet, drumBus, drumFilter };
  return audio;
}

function playNote(freq, t, dur) {
  const { ctx, bus } = audio;
  const f = freq * detuneMul();

  const env = ctx.createGain();
  env.gain.value = 0;
  env.connect(bus);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.value = params.cutoff;
  filter.Q.value = 0.7;
  filter.connect(env);

  const lfo = ctx.createOscillator();
  lfo.type = 'sine';
  lfo.frequency.value = params.vibRate;
  const lfoGain = ctx.createGain();
  lfoGain.gain.setValueAtTime(0, t);
  const vibDelay = Math.max(params.attack * 2, 0.2);
  lfoGain.gain.linearRampToValueAtTime(params.vibDepth, t + vibDelay);
  lfo.connect(lfoGain);

  const osc1 = ctx.createOscillator();
  osc1.type = params.waveform;
  osc1.frequency.value = f;
  const osc2 = ctx.createOscillator();
  osc2.type = 'sine';
  osc2.frequency.value = f;
  osc2.detune.value = params.detune;
  lfoGain.connect(osc1.detune);
  lfoGain.connect(osc2.detune);

  const oscMix = ctx.createGain();
  oscMix.gain.value = 0.5;
  osc1.connect(oscMix);
  osc2.connect(oscMix);
  oscMix.connect(filter);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  noise.loop = true;
  const breathFilter = ctx.createBiquadFilter();
  breathFilter.type = 'bandpass';
  breathFilter.frequency.value = Math.min(Math.max(f * 2, 400), 4000);
  breathFilter.Q.value = 1.5;
  const breathGain = ctx.createGain();
  breathGain.gain.value = params.breath * 0.4;
  noise.connect(breathFilter);
  breathFilter.connect(breathGain);
  breathGain.connect(filter);

  const a = params.attack;
  const r = params.release;
  const gate = dur * 0.9;
  const holdEnd = t + Math.max(a, gate);
  const peak = 0.55;
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(peak, t + a);
  env.gain.setValueAtTime(peak, holdEnd);
  env.gain.exponentialRampToValueAtTime(0.0001, holdEnd + r);

  const stopAt = holdEnd + r + 0.05;
  osc1.start(t);
  osc2.start(t);
  lfo.start(t);
  noise.start(t);
  osc1.stop(stopAt);
  osc2.stop(stopAt);
  lfo.stop(stopAt);
  noise.stop(stopAt);
}

function playDeep(t) {
  const { ctx, drumBus } = audio;
  const d = params.deepDecay;

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  const base = params.deepPitch * detuneMul();
  osc.frequency.setValueAtTime(base, t);
  osc.frequency.exponentialRampToValueAtTime(Math.max(base * 0.45, 30), t + d);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.8, t + 0.005);
  env.gain.exponentialRampToValueAtTime(0.0001, t + d);

  osc.connect(env);
  env.connect(drumBus);
  osc.start(t);
  osc.stop(t + d + 0.05);
}

function playDrip(t) {
  const { ctx, drumBus } = audio;
  const d = params.dripDecay;
  const f = params.dripTone * detuneMul();

  const osc = ctx.createOscillator();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(f, t);
  osc.frequency.exponentialRampToValueAtTime(f * 2.2, t + 0.06);

  const env = ctx.createGain();
  env.gain.setValueAtTime(0, t);
  env.gain.linearRampToValueAtTime(0.5, t + 0.004);
  env.gain.exponentialRampToValueAtTime(0.0001, t + d);

  osc.connect(env);
  env.connect(drumBus);
  osc.start(t);
  osc.stop(t + d + 0.05);

  const noise = ctx.createBufferSource();
  noise.buffer = noiseBuffer;
  const nf = ctx.createBiquadFilter();
  nf.type = 'bandpass';
  nf.frequency.value = f * 1.5;
  nf.Q.value = 2;
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.25, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + d * 0.6);
  noise.connect(nf);
  nf.connect(ng);
  ng.connect(drumBus);
  noise.start(t);
  noise.stop(t + d);
}

function stepDuration() {
  const bpm = Math.min(110, Math.max(80, parseFloat($('#bpm').value) || 100));
  return 60 / bpm / 4;
}

function scheduleStep(step, t) {
  const dur = stepDuration();
  for (let row = 0; row < ROWS; row++) {
    if (notes[step][row]) {
      playNote(midiToFreq(PITCHES[row]), t, dur);
    }
  }
  for (let row = 0; row < DRUM_COUNT; row++) {
    if (!drumNotes[step][row]) continue;
    if (row === 0) playDeep(t);
    else playDrip(t);
  }
}

function schedulerTick() {
  const { ctx } = audio;
  while (nextStepTime < ctx.currentTime + 0.12) {
    const step = currentStep;
    scheduleStep(step, nextStepTime);
    const delay = Math.max(0, (nextStepTime - ctx.currentTime) * 1000);
    setTimeout(() => setPlayhead(step), delay);
    nextStepTime += stepDuration();
    currentStep = (currentStep + 1) % STEPS;
  }
}

function rollRemove(cellsArr, rowCount, step, cls) {
  for (let row = 0; row < rowCount; row++) {
    cellsArr[row][step].classList.remove(cls);
  }
}

function rollAdd(cellsArr, rowCount, step, cls) {
  for (let row = 0; row < rowCount; row++) {
    cellsArr[row][step].classList.add(cls);
  }
}

function setPlayhead(step) {
  if (!isPlaying) return;
  if (playheadStep >= 0) {
    rollRemove(fluteCells, ROWS, playheadStep, 'playing');
    rollRemove(drumCells, DRUM_COUNT, playheadStep, 'playing');
  }
  playheadStep = step;
  rollAdd(fluteCells, ROWS, step, 'playing');
  rollAdd(drumCells, DRUM_COUNT, step, 'playing');
}

function clearPlayhead() {
  if (playheadStep < 0) return;
  rollRemove(fluteCells, ROWS, playheadStep, 'playing');
  rollRemove(drumCells, DRUM_COUNT, playheadStep, 'playing');
  playheadStep = -1;
}

function startPlayback() {
  ensureAudio();
  isPlaying = true;
  currentStep = 0;
  nextStepTime = audio.ctx.currentTime + 0.06;
  schedulerId = setInterval(schedulerTick, 25);
  $('#btn-play').textContent = 'Stop';
}

function stopPlayback() {
  isPlaying = false;
  clearInterval(schedulerId);
  clearPlayhead();
  $('#btn-play').textContent = 'Play';
}

function applyLive(id) {
  if (!audio) return;
  if (id === 'volume') audio.master.gain.value = params.volume;
  if (id === 'wet') audio.wet.gain.value = params.wet;
  if (id === 'drumLevel') audio.drumBus.gain.value = params.drumLevel;
  if (id === 'underCutoff') audio.drumFilter.frequency.value = params.underCutoff;
}

function fmtValue(p, v) {
  return p.unit ? v + ' ' + p.unit : String(v);
}

class Knob {
  constructor(p, onChange) {
    this.p = p;
    this.onChange = onChange;
    this.value = params[p.id];
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 40 40');
    svg.setAttribute('width', '40');
    svg.setAttribute('height', '40');
    svg.setAttribute('role', 'slider');
    svg.setAttribute('tabindex', '0');
    svg.setAttribute('aria-label', p.label);
    svg.setAttribute('aria-valuemin', p.min);
    svg.setAttribute('aria-valuemax', p.max);
    svg.classList.add('knob');

    const body = document.createElementNS(ns, 'circle');
    body.setAttribute('cx', '20');
    body.setAttribute('cy', '20');
    body.setAttribute('r', '15');
    body.setAttribute('fill', '#000616');
    body.setAttribute('stroke', '#2C3DDD');

    this.ptr = document.createElementNS(ns, 'line');
    this.ptr.setAttribute('x1', '20');
    this.ptr.setAttribute('y1', '20');
    this.ptr.setAttribute('x2', '20');
    this.ptr.setAttribute('y2', '6');
    this.ptr.setAttribute('stroke', '#33AAFF');
    this.ptr.setAttribute('stroke-width', '2.5');
    this.ptr.setAttribute('stroke-linecap', 'round');

    svg.append(body, this.ptr);
    svg.addEventListener('pointerdown', (e) => this.startDrag(e));
    svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    svg.addEventListener('keydown', (e) => this.onKey(e));
    svg.addEventListener('dblclick', () => this.set(p.value));

    this.svg = svg;
    this.render();
  }

  quantize(v) {
    const p = this.p;
    let x = Math.round((v - p.min) / p.step) * p.step + p.min;
    x = Math.min(p.max, Math.max(p.min, x));
    return Math.round(x * 1e4) / 1e4;
  }

  set(v) {
    this.value = this.quantize(v);
    params[this.p.id] = this.value;
    this.render();
    this.onChange(this.value);
  }

  render() {
    const t = (this.value - this.p.min) / (this.p.max - this.p.min);
    this.ptr.setAttribute('transform', 'rotate(' + (-135 + t * 270) + ' 20 20)');
    this.svg.setAttribute('aria-valuenow', this.value);
  }

  startDrag(e) {
    e.preventDefault();
    this.svg.focus();
    this.svg.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startVal = this.value;
    const move = (ev) => {
      const d = (startY - ev.clientY) / 150;
      this.set(startVal + d * (this.p.max - this.p.min));
    };
    const up = () => {
      this.svg.removeEventListener('pointermove', move);
      this.svg.removeEventListener('pointerup', up);
      this.svg.removeEventListener('pointercancel', up);
    };
    this.svg.addEventListener('pointermove', move);
    this.svg.addEventListener('pointerup', up);
    this.svg.addEventListener('pointercancel', up);
  }

  onWheel(e) {
    e.preventDefault();
    const dir = e.deltaY < 0 ? 1 : -1;
    this.set(this.value + dir * this.p.step * (e.shiftKey ? 1 : 5));
  }

  onKey(e) {
    let d = 0;
    if (e.key === 'ArrowUp' || e.key === 'ArrowRight') d = this.p.step;
    else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') d = -this.p.step;
    else return;
    e.preventDefault();
    this.set(this.value + d * (e.shiftKey ? 10 : 1));
  }
}

function paramControl(p) {
  const row = document.createElement('div');
  row.className = 'param';

  const out = document.createElement('span');
  out.className = 'param-value';
  out.textContent = fmtValue(p, params[p.id]);

  const label = document.createElement('span');
  label.className = 'param-label';
  label.textContent = p.label;

  if (p.type === 'select') {
    const sel = document.createElement('select');
    for (const opt of p.options) {
      const o = document.createElement('option');
      o.value = opt;
      o.textContent = opt;
      if (opt === p.value) o.selected = true;
      sel.appendChild(o);
    }
    sel.addEventListener('input', () => {
      params[p.id] = sel.value;
      out.textContent = fmtValue(p, params[p.id]);
      applyLive(p.id);
    });
    row.append(label, sel, out);
  } else if (p.type === 'slider') {
    row.classList.add('param-slider');
    const input = document.createElement('input');
    input.type = 'range';
    input.min = p.min;
    input.max = p.max;
    input.step = p.step;
    input.value = p.value;
    input.addEventListener('input', () => {
      params[p.id] = parseFloat(input.value);
      out.textContent = fmtValue(p, params[p.id]);
      applyLive(p.id);
    });
    row.append(label, input, out);
  } else {
    const knob = new Knob(p, () => {
      out.textContent = fmtValue(p, params[p.id]);
      applyLive(p.id);
    });
    row.append(knob.svg, label, out);
  }
  return row;
}

function buildRoll(container, rowLabels, onClick) {
  const cellRefs = [];
  for (let row = 0; row < rowLabels.length; row++) {
    const label = document.createElement('div');
    label.className = 'note-label';
    label.textContent = rowLabels[row];
    container.appendChild(label);
    cellRefs[row] = [];
    for (let step = 0; step < STEPS; step++) {
      const cell = document.createElement('button');
      cell.type = 'button';
      cell.className = 'cell';
      cell.addEventListener('click', () => onClick(step, row, cell));
      container.appendChild(cell);
      cellRefs[row].push(cell);
    }
  }
  return cellRefs;
}

function fluteLabels() {
  return PITCHES.map((midi) => NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1));
}

function onFluteCellClick(step, row, cell) {
  notes[step][row] = !notes[step][row];
  cell.classList.toggle('active', notes[step][row]);
  if (previewOn && notes[step][row]) {
    ensureAudio();
    playNote(midiToFreq(PITCHES[row]), audio.ctx.currentTime + 0.01, 0.25);
  }
}

function onDrumCellClick(step, row, cell) {
  drumNotes[step][row] = !drumNotes[step][row];
  cell.classList.toggle('active', drumNotes[step][row]);
  if (previewOn && drumNotes[step][row]) {
    ensureAudio();
    if (row === 0) playDeep(audio.ctx.currentTime + 0.01);
    else playDrip(audio.ctx.currentTime + 0.01);
  }
}

function buildPanel(container, list) {
  for (const p of list) {
    container.appendChild(paramControl(p));
  }
}

function initControls() {
  $('#btn-play').addEventListener('click', () => {
    if (isPlaying) stopPlayback();
    else startPlayback();
  });
  const bpm = $('#bpm');
  bpm.addEventListener('input', () => {
    $('#bpm-value').textContent = bpm.value;
  });
  $('#btn-preview').addEventListener('click', () => {
    previewOn = !previewOn;
    $('#btn-preview').textContent = 'preview: ' + (previewOn ? 'on' : 'off');
  });
  $('#btn-clear').addEventListener('click', () => {
    for (let s = 0; s < STEPS; s++) {
      for (let r = 0; r < ROWS; r++) {
        notes[s][r] = false;
        fluteCells[r][s].classList.remove('active');
      }
      for (let r = 0; r < DRUM_COUNT; r++) {
        drumNotes[s][r] = false;
        drumCells[r][s].classList.remove('active');
      }
    }
  });
}

fluteCells = buildRoll($('#piano-roll'), fluteLabels(), onFluteCellClick);
for (const [step, row] of FLUTE_DEMO) fluteCells[row][step].classList.add('active');
drumCells = buildRoll($('#drum-roll'), DRUM_ROWS, onDrumCellClick);
for (const [step, row] of DRUM_DEMO) drumCells[row][step].classList.add('active');
$('#volume-knob').append(paramControl(VOLUME_PARAM));
buildPanel($('#panel'), PARAMS);
buildPanel($('#common-panel'), COMMON_PARAMS);
buildPanel($('#drum-panel'), DRUM_PARAMS);
initControls();