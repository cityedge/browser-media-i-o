import { fail, nonnegative, positive } from './errors.js';

export type FrameRate = number | { numerator: number; denominator: number };
export function frameRateValue(rate: FrameRate): number {
  if (typeof rate === 'number') { positive(rate, 'fps'); return rate; }
  positive(rate.numerator, 'fps.numerator', true);
  positive(rate.denominator, 'fps.denominator', true);
  return rate.numerator / rate.denominator;
}

/** Absolute timeline time. Never accumulate frame durations to advance the clock. */
export function frameTime(index: number, rate: FrameRate): number {
  nonnegative(index, 'frame index');
  if (!Number.isSafeInteger(index)) fail('INVALID_ARGUMENT', 'Frame index must be a safe integer.');
  return index / frameRateValue(rate);
}

export function frameTiming(index: number, rate: FrameRate) {
  const start = Math.round(frameTime(index, rate) * 1e6);
  const end = Math.round(frameTime(index + 1, rate) * 1e6);
  if (!Number.isSafeInteger(end) || end <= start) fail('INVALID_ARGUMENT', 'Frame timestamps exceed microsecond precision.');
  return { timestamp: start / 1e6, duration: (end - start) / 1e6 };
}
