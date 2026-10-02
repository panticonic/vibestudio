import FFT from "fft.js";

export const SAMPLE_RATE = 16000;
const FFT_SIZE = 512;
const HOP = 160;
const WINDOW = 400;
const MEL_BINS = 128;
const hzToMel = (hz) =>
  hz < 1000 ? hz / (200 / 3) : 15 + Math.log(hz / 1000) / (Math.log(6.4) / 27);
const melToHz = (mel) =>
  mel < 15 ? mel * (200 / 3) : 1000 * Math.exp((mel - 15) * (Math.log(6.4) / 27));
const edges = Array.from({ length: MEL_BINS + 2 }, (_, i) => melToHz((i * hzToMel(8000)) / 129));
const filters = Array.from({ length: MEL_BINS }, (_, m) =>
  Float32Array.from(
    { length: FFT_SIZE / 2 + 1 },
    (_, k) =>
      (Math.max(
        0,
        Math.min(
          ((k * SAMPLE_RATE) / FFT_SIZE - edges[m]) / (edges[m + 1] - edges[m]),
          (edges[m + 2] - (k * SAMPLE_RATE) / FFT_SIZE) / (edges[m + 2] - edges[m + 1])
        )
      ) *
        2) /
      (edges[m + 2] - edges[m])
  )
);
const window = Float32Array.from(
  { length: WINDOW },
  (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WINDOW - 1))
);

/** The published CPU frontend: pre-emphasis, centered STFT with constant
 * padding, Slaney mel filters, natural log, sample variance per feature.
 * Audio and intermediate arrays are float32; accumulation uses JS doubles.
 */
export function logMel(audio) {
  if (audio.length < HOP) throw new Error("The recording is too short to transcribe.");
  const fft = new FFT(FFT_SIZE);
  const output = fft.createComplexArray();
  const frame = new Float32Array(FFT_SIZE);
  const power = new Float32Array(FFT_SIZE / 2 + 1);
  const pre = new Float32Array(audio.length);
  pre[0] = audio[0];
  for (let i = 1; i < audio.length; i++) pre[i] = audio[i] - 0.97 * audio[i - 1];
  const frames = Math.floor(audio.length / HOP) + 1;
  const features = new Float32Array(frames * MEL_BINS);
  for (let t = 0; t < frames; t++) {
    frame.fill(0);
    for (let i = 0; i < WINDOW; i++) {
      const index = t * HOP - WINDOW / 2 + i;
      if (index >= 0 && index < pre.length)
        frame[i + (FFT_SIZE - WINDOW) / 2] = pre[index] * window[i];
    }
    fft.realTransform(output, frame);
    for (let k = 0; k < power.length; k++) power[k] = output[2 * k] ** 2 + output[2 * k + 1] ** 2;
    for (let m = 0; m < MEL_BINS; m++) {
      let sum = 0;
      for (let k = 0; k < power.length; k++) sum += power[k] * filters[m][k];
      features[t * MEL_BINS + m] = Math.log(sum + 2 ** -24);
    }
  }
  for (let m = 0; m < MEL_BINS; m++) {
    let mean = 0;
    for (let t = 0; t < frames; t++) mean += features[t * MEL_BINS + m];
    mean /= frames;
    let variance = 0;
    for (let t = 0; t < frames; t++) variance += (features[t * MEL_BINS + m] - mean) ** 2;
    const scale = Math.sqrt(variance / (frames - 1)) + 1e-5;
    for (let t = 0; t < frames; t++)
      features[t * MEL_BINS + m] = (features[t * MEL_BINS + m] - mean) / scale;
  }
  return { features, frames };
}

/** Bound native attention allocation by splitting long dictations at the
 * quietest 100 ms within the final five seconds of each 30-second window. */
export function* audioWindows(audio) {
  const maximum = 30 * SAMPLE_RATE;
  let start = 0;
  while (audio.length - start > maximum) {
    let end = start + maximum;
    let quietest = Infinity;
    for (let candidate = start + 25 * SAMPLE_RATE; candidate <= start + maximum; candidate += HOP) {
      if (audio.length - candidate < HOP) continue;
      let energy = 0;
      for (let i = candidate - 1600; i < candidate; i++) energy += audio[i] ** 2;
      if (energy < quietest) {
        quietest = energy;
        end = candidate;
      }
    }
    yield audio.subarray(start, end);
    start = end;
  }
  if (audio.length - start >= HOP) yield audio.subarray(start);
}
