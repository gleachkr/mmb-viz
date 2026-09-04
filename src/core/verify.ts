/**
 * Drivers around the machine: trace one statement with keyframes for time
 * travel, and verify a whole file statement by statement.
 */

import { type Layout, type Statement } from "./layout";
import { Machine, type Snapshot, type StepRecord, type VerifyError } from "./machine";

export type Status = "ok" | "sorry" | "error";

export interface StatementResult {
  index: number;
  status: Status;
  error?: VerifyError;
  steps: number;
  ms: number;
}

/** Steps between keyframes. Re-executing up to this many steps is well under a millisecond. */
const KEYFRAME_EVERY = 64;

/**
 * A complete run of one statement: every step record, plus keyframes so that
 * the machine state after any step can be rebuilt quickly.
 */
export class Trace {
  readonly records: StepRecord[] = [];
  readonly keyframes = new Map<number, Snapshot>();
  readonly machine: Machine;
  readonly result: StatementResult;

  constructor(
    readonly L: Layout,
    readonly stmt: Statement,
  ) {
    const t0 = performance.now();
    const m = new Machine(L, stmt);
    this.machine = m;
    this.keyframes.set(0, m.snapshot());
    for (;;) {
      const r = m.step();
      if (!r) break;
      this.records.push(r);
      if (m.stepCount % KEYFRAME_EVERY === 0 || m.done) this.keyframes.set(m.stepCount, m.snapshot());
    }
    this.result = {
      index: stmt.index,
      status: m.error ? "error" : m.sorryUsed ? "sorry" : "ok",
      error: m.error,
      steps: this.records.length,
      ms: performance.now() - t0,
    };
  }

  get length(): number {
    return this.records.length;
  }

  /**
   * The machine positioned after `k` steps (0 = before the first step). The
   * returned machine is the trace's own, so call again before relying on it
   * after another `at`.
   */
  at(k: number): Machine {
    k = Math.max(0, Math.min(k, this.records.length));
    const m = this.machine;
    if (m.stepCount === k && !m.error) return m;
    let base = k - (k % KEYFRAME_EVERY);
    while (base > 0 && !this.keyframes.has(base)) base -= KEYFRAME_EVERY;
    const snap = this.keyframes.get(base) ?? this.keyframes.get(0)!;
    m.restore(snap);
    while (m.stepCount < k) m.step();
    return m;
  }

  /** Index of the first step whose command starts at `offset`, or -1. */
  stepAtOffset(offset: number): number {
    return this.records.findIndex((r) => offset >= r.span.start && offset < r.span.end);
  }
}

/** Verify a single statement without keeping records. */
export function verifyStatement(L: Layout, stmt: Statement): StatementResult {
  const t0 = performance.now();
  const m = new Machine(L, stmt);
  m.verbose = false;
  const steps = m.run();
  return { index: stmt.index, status: m.error ? "error" : m.sorryUsed ? "sorry" : "ok", error: m.error, steps, ms: performance.now() - t0 };
}

/** Verify every statement in order, yielding each result as it is produced. */
export function* verifyAll(L: Layout): Generator<StatementResult> {
  for (const st of L.statements) yield verifyStatement(L, st);
}

export interface FileResult {
  results: StatementResult[];
  firstError?: StatementResult;
  sorry: number;
  errors: number;
  steps: number;
  ms: number;
}

export function verifyFile(L: Layout): FileResult {
  const t0 = performance.now();
  const results: StatementResult[] = [];
  let firstError: StatementResult | undefined;
  let sorry = 0;
  let errors = 0;
  let steps = 0;
  for (const r of verifyAll(L)) {
    results.push(r);
    steps += r.steps;
    if (r.status === "sorry") sorry++;
    if (r.status === "error") {
      errors++;
      firstError ??= r;
    }
  }
  return { results, firstError, sorry, errors, steps, ms: performance.now() - t0 };
}
