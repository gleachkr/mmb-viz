import { batch, createEffect, createMemo, createRoot, createSignal, on } from "solid-js";
import { parseLayout, type Layout } from "../core/layout";
import { allDecls, type DeclSummary } from "../core/decls";
import { collectProblems, spanChainAt, type DeclRef, type Problem, type Span } from "../core/spans";
import { disassembleProof } from "../core/streams";
import { type Machine, type Snapshot, type StepRecord } from "../core/machine";
import { Trace, verifyStatement, type StatementResult } from "../core/verify";
import { diagnose, type Diagnosis, type Related } from "../core/diagnose";
import { declName, type Statement } from "../core/layout";

export interface Loaded {
  name: string;
  layout: Layout;
  parseMs: number;
  /** The bundled example this file is, when it is one: the only kind a URL can reload. */
  example?: string;
}

const [loaded, setLoaded] = createSignal<Loaded | undefined>();
/** Selected byte offset, or -1. */
const [selected, setSelected] = createSignal<number>(-1);
/** Hovered byte offset, or -1. */
const [hovered, setHovered] = createSignal<number>(-1);
/** Version counter bumped whenever something asks the hexdump to scroll. */
const [scrollRequest, setScrollRequest] = createSignal<{ offset: number; n: number }>({ offset: 0, n: 0 });
/** Whether a jump has been made that the back button can undo (browser history entries this page pushed). */
const [canGoBack, setCanGoBack] = createSignal(false);

export { loaded, selected, hovered, scrollRequest, canGoBack };

/** Side panes start hidden on viewports too narrow to show them beside the hexdump. */
const w = typeof window === "undefined" ? 1600 : window.innerWidth;
const [showTree, setShowTree] = createSignal(w >= 1000);
const [showInspector, setShowInspector] = createSignal(w >= 1300);
export { showTree, showInspector };
export const toggleTree = (): void => void setShowTree((v) => !v);
export const toggleInspector = (): void => void setShowInspector((v) => !v);
/** Open the inspector on its Problems tab. */
export function showProblemsTab(): void {
  setShowInspector(true);
  setInspTab("problems");
}

export type LeftTab = "structure" | "decls";
const [leftTab, setLeftTab] = createSignal<LeftTab>("structure");
export { leftTab, setLeftTab };

/** Which inspector subtab is showing: the field, its declaration, the spec, or the file's problems. */
export type InspTab = "field" | "decl" | "spec" | "problems";
const [inspTab, setInspTab] = createSignal<InspTab>("field");
export { inspTab, setInspTab };

/** The center pane shows either the hexdump or the debugger. */
export type CenterTab = "hex" | "debug";
const [centerTab, setCenterTab] = createSignal<CenterTab>("hex");
export { centerTab, setCenterTab };

/**
 * Results of the deep scan that runs shortly after a file loads: every lazy
 * stream is decoded so that the problem list is complete, the declarations
 * browser has its signatures, and proofs that use Sorry are known.
 */
export interface Scan {
  problems: Problem[];
  decls: DeclSummary[];
  /** Statement indices whose proof uses Sorry. */
  sorry: Set<number>;
  ms: number;
}
const [scan, setScan] = createSignal<Scan | undefined>();
export { scan };

function runScan(layout: Layout): void {
  const t0 = performance.now();
  const sorry = new Set<number>();
  for (const st of layout.statements) {
    if (!st.hasProof) continue;
    if (disassembleProof(layout, st)?.usesSorry) sorry.add(st.index);
  }
  const decls = allDecls(layout);
  const problems = collectProblems(layout.root);
  // Problems recorded on the layout but not on any span (e.g. counter mismatches).
  for (const p of layout.problems) if (!problems.includes(p)) problems.push(p);
  problems.sort((a, b) => a.offset - b.offset);
  setScan({ problems, decls, sorry, ms: performance.now() - t0 });
}

/** All known problems: the scan's complete list once it has run, else the parser's. */
export function problems(): Problem[] {
  return scan()?.problems ?? loaded()?.layout.problems ?? [];
}

export function loadBytes(name: string, bytes: Uint8Array, example?: string): void {
  const t0 = performance.now();
  const layout = parseLayout(bytes);
  const parseMs = performance.now() - t0;
  batch(() => {
    setSelected(-1);
    setHovered(-1);
    setScan(undefined);
    setDebug(undefined);
    setCenterTab("hex");
    resetVerification(layout);
    setLoaded({ name, layout, parseMs, example });
  });
  // Let the first paint happen, then decode everything, then verify everything.
  setTimeout(() => {
    if (loaded()?.layout !== layout) return;
    runScan(layout);
    startVerification(layout);
  }, 30);
}

// ---------------------------------------------------------------------------
// Whole-file verification, in slices so the page stays responsive.

export interface Verification {
  layout: Layout;
  results: (StatementResult | undefined)[];
  done: number;
  total: number;
  errors: number;
  sorry: number;
  steps: number;
  ms: number;
  running: boolean;
}
const [verification, setVerification] = createSignal<Verification | undefined>();
export { verification };

function resetVerification(layout: Layout): void {
  setVerification({ layout, results: new Array(layout.statements.length).fill(undefined), done: 0, total: layout.statements.length, errors: 0, sorry: 0, steps: 0, ms: 0, running: false });
}

const SLICE_MS = 40;

function startVerification(layout: Layout): void {
  const v = verification();
  if (!v || v.layout !== layout) return;
  const results = v.results.slice();
  let done = 0;
  let errors = 0;
  let sorry = 0;
  let steps = 0;
  let ms = 0;
  const publish = (running: boolean) => setVerification({ layout, results: results.slice(), done, total: results.length, errors, sorry, steps, ms, running });
  const slice = () => {
    if (loaded()?.layout !== layout) return;
    const t0 = performance.now();
    while (done < results.length && performance.now() - t0 < SLICE_MS) {
      const r = verifyStatement(layout, layout.statements[done]!);
      results[done] = r;
      done++;
      steps += r.steps;
      ms += r.ms;
      if (r.status === "error") errors++;
      if (r.status === "sorry") sorry++;
    }
    publish(done < results.length);
    if (done < results.length) setTimeout(slice, 0);
  };
  publish(true);
  setTimeout(slice, 0);
}

/** Verification result of a statement, once the whole-file run has reached it. */
export function resultOf(stmtIndex: number): StatementResult | undefined {
  return verification()?.results[stmtIndex];
}

// ---------------------------------------------------------------------------
// Debugger

export interface DebugSession {
  trace: Trace;
  /** Number of steps executed so far (0 = before the first). */
  step: number;
}
const [debug, setDebug] = createSignal<DebugSession | undefined>();
export { debug };

/** Open the debugger on a statement, positioned after `step` steps. */
export function openDebugger(stmt: Statement, step?: number): void {
  const L = loaded()?.layout;
  if (!L) return;
  const cur = debug();
  const trace = cur && cur.trace.stmt === stmt && cur.trace.L === L ? cur.trace : new Trace(L, stmt);
  const k = step ?? (cur?.trace === trace ? cur.step : 0);
  setDebug({ trace, step: Math.max(0, Math.min(k, trace.length)) });
  setCenterTab("debug");
}

/** Open the debugger on a statement's proof: at the failing step when it fails, else at the start; an open session on it is left where it is. */
export function debugStatement(stmt: Statement): void {
  const cur = debug();
  if (cur?.trace.stmt === stmt && cur.trace.L === loaded()?.layout) setCenterTab("debug");
  else openDebugger(stmt, resultOf(stmt.index)?.status === "error" ? Infinity : 0);
}

/** The statement whose proof or unify stream contains the command at `offset`, given the command's span. */
function statementOfCommand(L: Layout, cmd: Span, offset: number): Statement | undefined {
  if (cmd.kind === "unify.cmd") {
    // A unify stream lives in the term or theorem table; it runs at the end of its own declaration's proof.
    const o = cmd.owner;
    return o && L.statements.find((s) => s.decl?.kind === o.kind && s.decl.id === o.id && s.hasProof);
  }
  return L.statements.find((s) => offset >= s.offset && offset < s.end);
}

/** Index of the record executing the command at `offset` nearest to `step`, or -1. */
function stepNearOffset(trace: Trace, offset: number, step: number): number {
  let best = -1;
  trace.records.forEach((r, k) => {
    if (offset < r.span.start || offset >= r.span.end) return;
    if (best < 0 || Math.abs(k - (step - 1)) < Math.abs(best - (step - 1))) best = k;
  });
  return best;
}

/**
 * Position the debugger at the step that executes the command at `offset`:
 * in the open session when it runs that command, else in a session on the
 * statement the command belongs to. Returns false when the offset is not a
 * proof or unify command. Does not change which pane is showing.
 */
export function debugOffset(offset: number): boolean {
  const L = loaded()?.layout;
  if (!L || offset < 0) return false;
  const cmd = spanChainAt(L.root, offset).find((s) => s.kind === "proof.cmd" || s.kind === "proof.stmt_cmd" || s.kind === "unify.cmd");
  if (!cmd) return false;
  const cur = debug();
  if (cur && cur.trace.L === L) {
    const r = cur.trace.records[cur.step - 1];
    if (r && offset >= r.span.start && offset < r.span.end) return true;
    const k = stepNearOffset(cur.trace, offset, cur.step);
    if (k >= 0) {
      setDebug({ trace: cur.trace, step: k + 1 });
      return true;
    }
  }
  const st = statementOfCommand(L, cmd, offset);
  if (!st) return false;
  const trace = cur?.trace.stmt === st && cur.trace.L === L ? cur.trace : new Trace(L, st);
  const k = stepNearOffset(trace, offset, 0);
  setDebug({ trace, step: k < 0 ? 0 : k + 1 });
  return true;
}

// The hexdump highlight and the debugger follow each other: stepping selects
// the command's bytes (see Debugger), and selecting a command moves the machine.
createRoot(() => createEffect(on(selected, (o) => void debugOffset(o), { defer: true })));

export function debugGoto(step: number): void {
  const d = debug();
  if (!d) return;
  const k = Math.max(0, Math.min(step, d.trace.length));
  if (k !== d.step) setDebug({ trace: d.trace, step: k });
}

export function debugStep(delta: number): void {
  const d = debug();
  if (d) debugGoto(d.step + delta);
}

/**
 * Index of the record that opened the unify frame open at `step`, or -1 when
 * no unification is in progress there. Scans back matching ENDs to openers.
 */
export function frameOpener(recs: readonly StepRecord[], step: number): number {
  let depth = 0;
  for (let k = step - 1; k >= 0; k--) {
    const r = recs[k]!;
    if (r.closes) depth++;
    if (r.opens) {
      if (depth === 0) return k;
      depth--;
    }
  }
  return -1;
}

/** The step just after the END that closes the frame opened at record `opener` (or the end of the trace). */
function frameEnd(recs: readonly StepRecord[], opener: number): number {
  let depth = 0;
  let k = opener;
  do {
    const r = recs[k]!;
    if (r.opens) depth++;
    if (r.closes) depth--;
    k++;
  } while (k < recs.length && depth > 0);
  return k;
}

/**
 * The step that "step over" would land on from `step`: past the unification
 * the next command opens, or past the one currently open. Undefined when
 * neither applies, so stepping over would be no different from stepping.
 */
export function stepOverTarget(recs: readonly StepRecord[], step: number): number | undefined {
  if (recs[step]?.opens) return frameEnd(recs, step);
  const opener = frameOpener(recs, step);
  return opener >= 0 ? frameEnd(recs, opener) : undefined;
}

/**
 * The step that "back over" would land on from `step`: just before the
 * unification currently open, or the one the last step closed. Undefined
 * when the last step is not part of a unification.
 */
export function stepBackOverTarget(recs: readonly StepRecord[], step: number): number | undefined {
  if (step === 0) return undefined;
  const opener = frameOpener(recs, recs[step - 1]!.closes ? step - 1 : step);
  return opener >= 0 ? opener : undefined;
}

/** Step forward past a whole unification; does nothing when none is about to open. */
export function debugStepOver(): void {
  const d = debug();
  if (!d) return;
  const k = stepOverTarget(d.trace.records, d.step);
  if (k !== undefined) debugGoto(k);
}

/** Step back to before the unification the current step is inside of; does nothing outside one. */
export function debugStepBackOver(): void {
  const d = debug();
  if (!d) return;
  const k = stepBackOverTarget(d.trace.records, d.step);
  if (k !== undefined) debugGoto(k);
}

export function closeDebugger(): void {
  setCenterTab("hex");
}

export interface DebugView {
  trace: Trace;
  step: number;
  m: Machine;
  snap: Snapshot;
  /** The step just executed (undefined at step 0). */
  record?: StepRecord;
  /** Index of the record that opened the current unify frame, if any. */
  frameStart: number;
  /** The error explorer's reading of the failure, for a failing statement. */
  diagnosis?: Diagnosis;
}

const diagnoses = new WeakMap<Trace, Diagnosis | undefined>();
/** The diagnosis of a trace, computed once. Repositions the trace's machine, so call it before `trace.at`. */
function diagnosisOfTrace(trace: Trace): Diagnosis | undefined {
  if (trace.result.status !== "error") return undefined;
  if (!diagnoses.has(trace)) diagnoses.set(trace, diagnose(trace));
  return diagnoses.get(trace);
}

const diagnosesByStatement = new WeakMap<Layout, Map<number, Diagnosis | undefined>>();
/** The diagnosis of a failing statement, tracing it if the debugger has not; undefined when it does not fail. */
export function diagnosisFor(stmt: Statement): Diagnosis | undefined {
  const L = loaded()?.layout;
  if (!L || resultOf(stmt.index)?.status !== "error") return undefined;
  const cur = debug();
  if (cur && cur.trace.stmt === stmt && cur.trace.L === L) return diagnosisOfTrace(cur.trace);
  let map = diagnosesByStatement.get(L);
  if (!map) diagnosesByStatement.set(L, (map = new Map()));
  if (!map.has(stmt.index)) map.set(stmt.index, diagnosisOfTrace(new Trace(L, stmt)));
  return map.get(stmt.index);
}

/** Follow one of a diagnosis's links: a step of the current trace, a declaration, or bytes in the hexdump. */
export function goToRelated(r: Related): void {
  switch (r.kind) {
    case "step":
      debugGoto(r.step);
      break;
    case "decl":
      goToDecl(r.ref);
      break;
    case "offset":
      batch(() => {
        goTo(r.offset);
        setCenterTab("hex");
      });
      break;
  }
}

/** The debugger's current state: the machine re-positioned at the chosen step. */
export const debugView: () => DebugView | undefined = createRoot(() =>
  createMemo(() => {
    const d = debug();
    if (!d) return undefined;
    const diagnosis = diagnosisOfTrace(d.trace);
    const m = d.trace.at(d.step);
    const snap = m.snapshot();
    const frameStart = snap.unify ? frameOpener(d.trace.records, d.step) : -1;
    return { trace: d.trace, step: d.step, m, snap, record: d.trace.records[d.step - 1], frameStart, diagnosis };
  }),
);

/** Spans the hexdump should highlight for the current debug step: the command and what it read. */
export const debugSpans: () => { pc?: Span; reads: Span[] } = createRoot(() =>
  createMemo(() => {
    const v = debugView();
    if (!v) return { reads: [] };
    const r = v.record;
    return r ? { pc: r.span, reads: r.reads.filter((s) => s !== r.span) } : { reads: [] };
  }),
);

/** Select an offset and scroll to it without touching the back history. */
export function reveal(offset: number): void {
  goTo(offset, false);
}

export function goToDecl(ref: DeclRef): void {
  const L = loaded()?.layout;
  if (!L) return;
  const d = ref.kind === "sort" ? L.sorts[ref.id]?.span : ref.kind === "term" ? L.terms[ref.id]?.entrySpan : L.thms[ref.id]?.entrySpan;
  if (!d) return;
  goTo(d.start);
  setInspTab("decl");
}

/** Fetch and load a bundled example. Opening one is a jump the back button can undo, unless `push` is false. */
export async function loadExample(file: string, push = true): Promise<void> {
  const url = new URL(`examples/${file}`, document.baseURI);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${file}: ${res.status}`);
  if (push) pushNext = true;
  loadBytes(file, new Uint8Array(await res.arrayBuffer()), file);
}

/**
 * Select an offset and bring it into view. A jump (the default) leaves the
 * previous location in the browser history, so back returns to it; stepping
 * and plain clicks pass `pushHistory = false` and only update the current entry.
 */
export function goTo(offset: number, pushHistory = true): void {
  const L = loaded()?.layout;
  if (!L) return;
  if (offset < 0 || offset >= L.bytes.length) return;
  if (pushHistory && selected() >= 0 && selected() !== offset) pushNext = true;
  setSelected(offset);
  setScrollRequest((r) => ({ offset, n: r.n + 1 }));
}

/** Return to the location before the last jump (the browser's own back). */
export function goBack(): void {
  if (canGoBack()) history.back();
}

export function select(offset: number): void {
  setSelected(offset);
}

export function hover(offset: number): void {
  setHovered(offset);
}

/** Chain of spans containing the selected offset (root first). Memoized app-wide. */
export const selectedChain: () => Span[] = createRoot(() =>
  createMemo(() => {
    const L = loaded()?.layout;
    const o = selected();
    if (!L || o < 0) return [];
    return spanChainAt(L.root, o);
  }),
);

export function selectedLeaf(): Span | undefined {
  const c = selectedChain();
  return c[c.length - 1];
}

/** The declaration owning the selection: the deepest span on the chain with an owner. */
export const selectedOwner: () => DeclRef | undefined = createRoot(() =>
  createMemo(
    () => {
      const c = selectedChain();
      for (let i = c.length - 1; i >= 0; i--) if (c[i]!.owner) return c[i]!.owner;
      return undefined;
    },
    undefined,
    { equals: (a, b) => a?.kind === b?.kind && a?.id === b?.id },
  ),
);

// ---------------------------------------------------------------------------
// Routing: the location is mirrored into the URL hash, so that the browser's
// back button undoes jumps, a reload keeps the place, and a URL can be shared.
// Jumps push a history entry; stepping and selecting only update the current one.

/** Where the user is: enough to restore the view, and to name it in a URL. */
export interface Location {
  /** Bundled example file, when the loaded file is one. */
  example?: string;
  /** Selected byte offset. */
  at?: number;
  /** Which center pane is showing; absent means the hexdump. */
  view?: CenterTab;
  /** The statement open in the debugger, by its declaration's name (or `#index`). */
  stmt?: string;
  /** The debugger's position within that statement's proof. */
  step?: number;
}

/** Depth of the history entry this page is on, kept in `history.state` to know whether back stays on the page. */
interface RouteState {
  mmb: number;
}

/** Set by a jump: the next hash update pushes a history entry instead of replacing the current one. */
let pushNext = false;

export function currentLocation(): Location {
  const l = loaded();
  if (!l) return {};
  const loc: Location = { example: l.example };
  if (selected() >= 0) loc.at = selected();
  if (centerTab() === "debug") loc.view = "debug";
  const d = debug();
  if (d && d.trace.L === l.layout) {
    loc.stmt = d.trace.stmt.decl ? declName(l.layout, d.trace.stmt.decl) : `#${d.trace.stmt.index}`;
    loc.step = d.step;
  }
  return loc;
}

/** The URL hash for a location: `#example=peano.mmb&at=0x40&view=debug&stmt=ax_mp&step=17`. */
export function formatLocation(loc: Location): string {
  const p = new URLSearchParams();
  if (loc.example) p.set("example", loc.example);
  if (loc.at !== undefined) p.set("at", `0x${loc.at.toString(16)}`);
  if (loc.view === "debug") p.set("view", "debug");
  if (loc.stmt !== undefined) p.set("stmt", loc.stmt);
  if (loc.step !== undefined) p.set("step", String(loc.step));
  const q = p.toString();
  return q ? `#${q}` : "";
}

export function parseLocation(hash: string): Location {
  const p = new URLSearchParams(hash.replace(/^#/, ""));
  const loc: Location = {};
  const ex = p.get("example");
  if (ex) loc.example = ex;
  const at = p.get("at");
  if (at !== null && /^(0x[0-9a-f]+|\d+)$/i.test(at)) loc.at = Number(at);
  if (p.get("view") === "debug") loc.view = "debug";
  const stmt = p.get("stmt");
  if (stmt) loc.stmt = stmt;
  const step = p.get("step");
  if (step !== null && /^\d+$/.test(step)) loc.step = Number(step);
  return loc;
}

/** The statement a URL names: by declaration name, or `#index`; a proof is preferred when names collide. */
function statementNamed(L: Layout, name: string): Statement | undefined {
  if (/^#\d+$/.test(name)) return L.statements[Number(name.slice(1))];
  const named = L.statements.filter((s) => s.decl && declName(L, s.decl) === name);
  return named.find((s) => s.hasProof) ?? named[0];
}

/** Restore a location in the loaded file; the file itself must already be loaded. */
function applyLocation(loc: Location): void {
  const l = loaded();
  if (!l) return;
  batch(() => {
    const st = loc.stmt !== undefined ? statementNamed(l.layout, loc.stmt) : undefined;
    if (st) openDebugger(st, loc.step ?? 0);
    setCenterTab(loc.view === "debug" && st ? "debug" : "hex");
    if (loc.at !== undefined && loc.at < l.layout.bytes.length) goTo(loc.at, false);
    else setSelected(-1);
  });
}

function depth(): number {
  const st = history.state as RouteState | null;
  return typeof st?.mmb === "number" ? st.mmb : 0;
}

/** Write the current location to the URL, pushing an entry when a jump asked for one. */
function syncHash(): void {
  const hash = formatLocation(currentLocation());
  const push = pushNext;
  pushNext = false;
  if (hash === location.hash) return;
  const url = hash || location.pathname + location.search;
  if (push) {
    history.pushState({ mmb: depth() + 1 } satisfies RouteState, "", url);
    setCanGoBack(true);
  } else {
    history.replaceState({ mmb: depth() } satisfies RouteState, "", url);
  }
}

/** Bring the app to the location in the URL, loading the example it names when that is not the loaded file. */
async function followHash(): Promise<void> {
  const loc = parseLocation(location.hash);
  if (loc.example && loc.example !== loaded()?.example) {
    await loadExample(loc.example, false);
    if (loaded()?.example !== loc.example) return;
  }
  applyLocation(loc);
}

/**
 * Start mirroring the location into the URL hash and following the browser's
 * back and forward buttons. Loads the example the URL names, if any.
 */
export function startRouting(): void {
  if (history.state === null) history.replaceState({ mmb: 0 } satisfies RouteState, "", location.href);
  setCanGoBack(depth() > 0);
  window.addEventListener("popstate", () => {
    setCanGoBack(depth() > 0);
    void followHash();
  });
  createRoot(() => createEffect(on([loaded, selected, centerTab, debug], syncHash, { defer: true })));
  void followHash();
}
