export type VideoCopyValidation = 'strict' | 'container';
export type VideoCopyDiagnosticCode = 'CONTAINER_SYNC_UNVERIFIED' | 'FRAME_NUMBER_DISCONTINUITY'
  | 'SLICE_LAYOUT_UNVERIFIED' | 'REDUNDANT_PICTURE' | 'IDR_DISCARDS_PRIOR_PICTURES'
  | 'SYNC_IDR_MISMATCH' | 'GOP_TIMING_MISMATCH' | 'GOP_PRESENTATION_CROSSING' | 'LEADING_PICTURE'
  | 'PACKETS_OMITTED' | 'PACKET_DURATION_ADJUSTED' | 'DIAGNOSTICS_TRUNCATED';
export interface VideoCopyWarning {
  readonly code: VideoCopyDiagnosticCode;
  readonly severity: 'warning';
  readonly recoverableInContainer: true;
  readonly message: string;
  readonly count: number;
  readonly firstTime?: number;
  readonly lastTime?: number;
  readonly firstRangeIndex?: number;
  readonly lastRangeIndex?: number;
  readonly originalDuration?: number;
  readonly outputDuration?: number;
}
export interface DiagnosticLocation { time?: number; rangeIndex?: number; originalDuration?: number; outputDuration?: number }
/** Aggregate by stable code, never by an unbounded set of per-packet messages. */
export class CopyWarnings {
  private values = new Map<VideoCopyDiagnosticCode, VideoCopyWarning>();
  constructor(initial: readonly VideoCopyWarning[] = []) { for (const warning of initial) this.values.set(warning.code, warning); }
  add(code: VideoCopyDiagnosticCode, message: string, location: DiagnosticLocation = {}, count = 1) {
    if (!this.values.has(code) && this.values.size >= 31) { code = 'DIAGNOSTICS_TRUNCATED'; message = 'Additional diagnostic types were aggregated.'; }
    const old = this.values.get(code);
    this.values.set(code, { code, message: old?.message ?? message, severity: 'warning', recoverableInContainer: true, count: (old?.count ?? 0) + count,
      firstTime: old?.firstTime ?? location.time, lastTime: location.time ?? old?.lastTime,
      firstRangeIndex: old?.firstRangeIndex ?? location.rangeIndex, lastRangeIndex: location.rangeIndex ?? old?.lastRangeIndex,
      originalDuration: old?.originalDuration ?? location.originalDuration, outputDuration: old?.outputDuration ?? location.outputDuration });
  }
  snapshot(): readonly VideoCopyWarning[] { return Object.freeze([...this.values.values()].map(value => Object.freeze({ ...value }))); }
}
