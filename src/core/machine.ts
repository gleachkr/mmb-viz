/**
 * The MMB stack machine, written to be watched.
 *
 * `Machine` verifies one statement. Its state is explicit (stack, heap,
 * hypothesis list, next_bv, an optional unify frame, and an append-only
 * expression arena), `step()` executes exactly one command and returns a
 * record of what it read, checked, popped, pushed, and allocated, and
 * `snapshot()`/`restore()` make time travel a matter of re-execution from
 * the nearest keyframe.
 *
 * Semantics follow mm0-c's verifier.c, which is the reference; where the
 * spec text and mm0-c differ (Dummy in a free sort, the shape of Sorry on
 * an obligation, the 56th bound variable) the choice is noted inline and in
 * SPEC_NOTES.md.
 */

import { type Cmd } from "./bytes";
import { declName, type Arg, type Layout, type Statement, type Term, type Thm } from "./layout";
import { PROOF_OPS, UNIFY_OPS } from "./opcodes";
import { childrenOf, type DeclRef, type Span } from "./spans";
import { dummyName, varName } from "./streams";

// ---------------------------------------------------------------------------
// Expressions

export interface ExprNode {
  /** Arena index. Two expressions are equal iff their ids are equal. */
  id: number;
  kind: "var" | "term";
  sort: number;
  bound: boolean;
  /** V(e): the bound variables occurring in e, as a bitmap over the declaration's bound variables and dummies. */
  v: bigint;
  /** FV(e): the free bound variables of e (V minus what the term's binders capture). */
  fv: bigint;
  /** Variables: display name and the heap index the variable was created at. */
  name?: string;
  index?: number;
  /** Bound variables: which bit of the deps bitmaps is theirs. */
  bv?: number;
  /** Applications: the term id and the argument node ids. */
  term?: number;
  args?: number[];
  /** Index of the step that allocated the node; -1 for the initial variables. */
  by: number;
}

export type StackEntry =
  | { kind: "expr"; e: number }
  | { kind: "proof"; e: number }
  | { kind: "conv"; e1: number; e2: number }
  | { kind: "coconv"; e1: number; e2: number };

/** Heap entries are stack entries other than obligations. */
export type HeapEntry = Exclude<StackEntry, { kind: "coconv" }>;

export const STACK_KIND_TEXT: Record<StackEntry["kind"], string> = {
  expr: "expression",
  proof: "proof",
  conv: "conversion",
  coconv: "obligation",
};

/** Which of the spec's three unification contexts a frame is in, plus the def statement's own check. */
export type UnifyMode = "thm" | "unfold" | "def-end" | "thm-end";

export const UNIFY_MODE_TEXT: Record<UnifyMode, string> = {
  thm: "applying a theorem (UThm)",
  unfold: "unfolding a definition (UDef)",
  "def-end": "checking the def's value against its unify stream (UDef)",
  "thm-end": "checking the proved statement against the theorem's unify stream (UThmEnd)",
};

export interface UnifyFrame {
  mode: UnifyMode;
  /** Whose unify stream is being run. */
  owner: DeclRef;
  stream: Span;
  cmds: Span[];
  /** Index into `cmds` of the next command. */
  pc: number;
  ustack: number[];
  uheap: { e: number; saved: boolean }[];
  /** What happens when the stream's END is reached. */
  onEnd: { kind: "thm"; e: number; save: boolean } | { kind: "unfold"; e: number; e2: number } | { kind: "finish" };
}

export type Phase = "init" | "proof" | "done" | "error";

export interface Snapshot {
  phase: Phase;
  pc: number;
  stack: StackEntry[];
  heap: HeapEntry[];
  hyps: number[];
  nextBv: number;
  dummies: number;
  sorryUsed: boolean;
  unify?: UnifyFrame;
  arenaLen: number;
  stepCount: number;
}

// ---------------------------------------------------------------------------
// Step records

export interface Check {
  /** Short name of the rule, as the spec phrases it. */
  name: string;
  /** What was actually compared. */
  detail: string;
  passed: boolean;
  /** Spec section the rule lives in. */
  section: string;
  /** Spans the step read just before this check, since the previous one: the bytes this check consumed. */
  reads?: Span[];
}

export interface VerifyError {
  message: string;
  /** Byte offset of the command that failed. */
  offset: number;
  step: number;
  check?: Check;
}

export interface StepRecord {
  index: number;
  level: "stmt" | "proof" | "unify";
  /** The bytes of the command executed (the statement command for level "stmt"). */
  span: Span;
  cmd?: Cmd;
  mnemonic: string;
  /** Byte spans consulted, in the order they were read. */
  reads: Span[];
  checks: Check[];
  /** Main-stack entries this step removed, deepest first (the spec's left-to-right order). */
  pops: StackEntry[];
  /** Main-stack entries this step added, in push order. */
  pushes: StackEntry[];
  heapPushes: HeapEntry[];
  upops: number[];
  upushes: number[];
  uheapPushes: number[];
  hypPushed?: number;
  /** A UHyp at the end of a theorem took this hypothesis from the list. */
  hypPopped?: number;
  /** Node ids allocated by this step. */
  allocated: number[];
  /** One line of prose about what happened. */
  summary: string;
  /** This step opened a unify frame. */
  opens?: UnifyMode;
  /** This step closed the unify frame. */
  closes?: boolean;
  error?: VerifyError;
}

class Fail extends Error {
  constructor(
    message: string,
    readonly check?: Check,
  ) {
    super(message);
  }
}

const DEPS_MASK = (1n << 55n) - 1n;
/**
 * mm0-c allows 56 bound variables: the 56th gets bit 55, which is reserved
 * in the file's arg fields but fine at run time (tests/mmb/run/dummy_reserved_bit
 * in the mm0 repository exercises exactly this). Aufbau stops at 55.
 */
const MAX_BOUND = 56;

function bits(x: bigint): number[] {
  const out: number[] = [];
  for (let i = 0; i < 56; i++) if ((x >> BigInt(i)) & 1n) out.push(i);
  return out;
}

// ---------------------------------------------------------------------------

export class Machine {
  readonly decl: Term | Thm | undefined;
  readonly declRef: DeclRef | undefined;
  /** "def" for Def/LocalDef bodies, "thm" for Axiom/Thm/LocalThm bodies. */
  readonly mode: "def" | "thm";
  readonly cmds: Span[];
  /**
   * Expression arena. Nodes are deterministic, so a restore only moves
   * `arenaLen` back and re-execution overwrites the same slots with the same
   * nodes; the array itself is never truncated, which keeps every keyframe's
   * nodes reachable.
   */
  readonly arena: ExprNode[] = [];
  arenaLen = 0;

  phase: Phase = "init";
  /** Index into `cmds` of the next proof command. */
  pc = 0;
  stack: StackEntry[] = [];
  heap: HeapEntry[] = [];
  hyps: number[] = [];
  nextBv = 0;
  dummies = 0;
  sorryUsed = false;
  unify: UnifyFrame | undefined;
  stepCount = 0;
  error: VerifyError | undefined;

  /** Names of the bound variables by bit, for printing dependency sets. */
  private bvNames: string[] = [];
  private cur!: StepRecord;

  constructor(
    readonly L: Layout,
    readonly stmt: Statement,
  ) {
    this.declRef = stmt.decl;
    this.decl = stmt.decl?.kind === "term" ? L.terms[stmt.decl.id] : stmt.decl?.kind === "thm" ? L.thms[stmt.decl.id] : undefined;
    this.mode = stmt.decl?.kind === "term" ? "def" : "thm";
    const body = childrenOf(stmt.span).find((s) => s.kind === "proof.body");
    this.cmds = body ? childrenOf(body) : [];
  }

  get done(): boolean {
    return this.phase === "done" || this.phase === "error";
  }

  // -- snapshots ------------------------------------------------------------

  snapshot(): Snapshot {
    const u = this.unify;
    return {
      phase: this.phase,
      pc: this.pc,
      stack: this.stack.slice(),
      heap: this.heap.slice(),
      hyps: this.hyps.slice(),
      nextBv: this.nextBv,
      dummies: this.dummies,
      sorryUsed: this.sorryUsed,
      unify: u ? { ...u, ustack: u.ustack.slice(), uheap: u.uheap.slice() } : undefined,
      arenaLen: this.arenaLen,
      stepCount: this.stepCount,
    };
  }

  restore(s: Snapshot): void {
    this.phase = s.phase;
    this.pc = s.pc;
    this.stack = s.stack.slice();
    this.heap = s.heap.slice();
    this.hyps = s.hyps.slice();
    this.nextBv = s.nextBv;
    this.dummies = s.dummies;
    this.sorryUsed = s.sorryUsed;
    this.unify = s.unify ? { ...s.unify, ustack: s.unify.ustack.slice(), uheap: s.unify.uheap.slice() } : undefined;
    this.arenaLen = s.arenaLen;
    this.bvNames.length = 0;
    for (let i = 0; i < this.arenaLen; i++) {
      const n = this.arena[i]!;
      if (n.bound && n.bv !== undefined) this.bvNames[n.bv] = n.name ?? `bv${n.bv}`;
    }
    this.stepCount = s.stepCount;
    this.error = undefined;
  }

  // -- printing ---------------------------------------------------------------

  node(id: number): ExprNode {
    const n = id < this.arenaLen ? this.arena[id] : undefined;
    if (!n) throw new Fail(`internal: no expression #${id}`);
    return n;
  }

  termName(t: number): string {
    return declName(this.L, { kind: "term", id: t });
  }

  /** Print an expression, MM0 style, outermost parentheses omitted. */
  show(id: number, top = true): string {
    const n = id < this.arenaLen ? this.arena[id] : undefined;
    if (!n) return `#${id}`;
    if (n.kind === "var") return n.name ?? `?${id}`;
    const name = this.termName(n.term!);
    if (!n.args!.length) return name;
    const s = `${name} ${n.args!.map((a) => this.show(a, false)).join(" ")}`;
    return top ? s : `(${s})`;
  }

  showEntry(s: StackEntry): string {
    switch (s.kind) {
      case "expr":
        return this.show(s.e);
      case "proof":
        return `|- ${this.show(s.e)}`;
      case "conv":
        return `${this.show(s.e1)} = ${this.show(s.e2)}`;
      case "coconv":
        return `${this.show(s.e1)} =?= ${this.show(s.e2)}`;
    }
  }

  /** A dependency bitmap as a set of variable names. */
  showDeps(x: bigint): string {
    const names = bits(x).map((b) => this.bvNames[b] ?? `bv${b}`);
    return `{${names.join(", ")}}`;
  }

  /** "depends on {x, y}", or the plain-language form when the bitmap is empty. */
  depsPhrase(x: bigint): string {
    return x === 0n ? "has no bound variable dependencies" : `depends on ${this.showDeps(x)}`;
  }

  /** The dependency set the current proof mode tracks: V in theorem proofs, FV in def bodies. */
  deps(n: ExprNode): bigint {
    return this.mode === "def" ? n.fv : n.v;
  }

  sortName(s: number): string {
    return declName(this.L, { kind: "sort", id: s });
  }

  // -- checks -----------------------------------------------------------------

  private check(name: string, section: string, passed: boolean, detail: string): void {
    const c: Check = { name, section, passed, detail };
    if (this.pendingReads.length) {
      c.reads = this.pendingReads;
      this.pendingReads = [];
    }
    this.cur.checks.push(c);
    if (!passed) throw new Fail(`${name}: ${detail}`, c);
  }

  /** Summaries cost more than the step itself; whole-file runs skip them. */
  verbose = true;

  private say(rec: StepRecord, f: () => string): void {
    if (this.verbose) rec.summary = f();
  }

  /** Spans read since the last check; the next check claims them. */
  private pendingReads: Span[] = [];

  private read(...spans: (Span | undefined)[]): void {
    for (const s of spans) {
      if (!s || this.cur.reads.includes(s)) continue;
      this.cur.reads.push(s);
      this.pendingReads.push(s);
    }
  }

  // -- stack helpers -----------------------------------------------------------

  private pop(): StackEntry {
    const s = this.stack.pop();
    this.check("stack not empty", "Proof Checking", s !== undefined, s ? "" : "the command needs a stack element but the stack is empty");
    // Successive pops reach deeper, so prepend: the record reads bottom to top like the spec's rules.
    this.cur.pops.unshift(s!);
    return s!;
  }

  private popKind<K extends StackEntry["kind"]>(kind: K, what: string): Extract<StackEntry, { kind: K }> {
    const s = this.pop();
    this.check(
      `pop ${what}`,
      "Proof Checking",
      s.kind === kind,
      s.kind === kind ? `popped ${STACK_KIND_TEXT[kind]} ${this.showEntry(s)}` : `expected ${STACK_KIND_TEXT[kind]} ${what} on top of the stack, found ${STACK_KIND_TEXT[s.kind]} ${this.showEntry(s)}`,
    );
    return s as Extract<StackEntry, { kind: K }>;
  }

  private push(s: StackEntry): void {
    this.stack.push(s);
    this.cur.pushes.push(s);
  }

  private pushHeap(s: HeapEntry): void {
    this.heap.push(s);
    this.cur.heapPushes.push(s);
  }

  private alloc(n: Omit<ExprNode, "id" | "by">): ExprNode {
    const node: ExprNode = { ...n, id: this.arenaLen, by: this.cur.index };
    this.arena[this.arenaLen++] = node;
    this.cur.allocated.push(node.id);
    if (node.bound && node.bv !== undefined) this.bvNames[node.bv] = node.name ?? `bv${node.bv}`;
    return node;
  }

  private upop(): number {
    const u = this.unify!;
    const e = u.ustack.pop();
    this.check("unify stack not empty", "Unification", e !== undefined, e === undefined ? "the command needs an expression on the unify stack but it is empty" : "");
    this.cur.upops.push(e!);
    return e!;
  }

  private upush(e: number): void {
    this.unify!.ustack.push(e);
    this.cur.upushes.push(e);
  }

  private upushHeap(e: number, saved: boolean): void {
    this.unify!.uheap.push({ e, saved });
    this.cur.uheapPushes.push(e);
  }

  // -- stepping -----------------------------------------------------------------

  /** Execute one command. Returns undefined once the statement is finished or has failed. */
  step(): StepRecord | undefined {
    if (this.done) return undefined;
    const rec: StepRecord = {
      index: this.stepCount,
      level: "proof",
      span: this.stmt.span,
      mnemonic: "",
      reads: [],
      checks: [],
      pops: [],
      pushes: [],
      heapPushes: [],
      upops: [],
      upushes: [],
      uheapPushes: [],
      allocated: [],
      summary: "",
    };
    this.cur = rec;
    this.pendingReads = [];
    try {
      if (this.phase === "init") this.stepInit(rec);
      else if (this.unify) this.stepUnify(rec, this.unify);
      else this.stepProof(rec);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      this.phase = "error";
      rec.error = { message: e.message, offset: rec.span.start, step: rec.index, check: e.check };
      this.error = rec.error;
      if (!rec.summary) this.say(rec, () => `fails: ${e.message}`);
    }
    this.stepCount++;
    return rec;
  }

  /** Run until done. Returns the number of steps taken. */
  run(limit = Infinity): number {
    let n = 0;
    while (!this.done && n < limit) {
      this.step();
      n++;
    }
    return n;
  }

  // -- statement start -------------------------------------------------------------

  private stepInit(rec: StepRecord): void {
    const st = this.stmt;
    const stmtCmd = childrenOf(st.span).find((s) => s.kind === "proof.stmt_cmd") ?? st.span;
    rec.level = "stmt";
    rec.span = stmtCmd;
    rec.cmd = stmtCmd.value as Cmd | undefined;
    rec.mnemonic = stmtCmd.label;
    this.read(stmtCmd);
    const h = this.L.header;
    this.check("header parsed", "Header", !!h, h ? "" : "the header could not be parsed");
    const decl = st.decl;
    this.check("statement opcode", "Proof Stream", !!st.info && !!decl, st.info ? "" : `unknown statement opcode 0x${st.opcode.toString(16)}`);
    const avail = st.avail;
    const name = declName(this.L, decl!);

    if (decl!.kind === "sort") {
      this.check("sort table has room", "Proof Stream", decl!.id < h!.numSorts, `this is sort ${decl!.id}; the header declares num_sorts = ${h!.numSorts}`);
      this.read(this.L.sorts[decl!.id]?.span);
      this.check("Sort has no body", "Proof Stream", rec.cmd!.data === rec.cmd!.size, `the statement's length ${rec.cmd!.data} ${rec.cmd!.data === rec.cmd!.size ? "equals" : "should equal"} the size of the statement command, ${rec.cmd!.size}`);
      this.say(rec, () => `Declares sort ${decl!.id}, ${name}. Sorts carry no proof; the sort counter becomes ${decl!.id + 1}.`);
      this.phase = "done";
      return;
    }

    if (decl!.kind === "term") {
      const t = this.L.terms[decl!.id];
      this.check("term table has room", "Proof Stream", decl!.id < h!.numTerms && !!t?.entrySpan, `this is term ${decl!.id}; the header declares num_terms = ${h!.numTerms}`);
      this.read(t!.entrySpan);
      this.check("return sort declared", "Term Table", t!.retSort < avail.sorts, `ret_sort is ${t!.retSort} (${this.sortName(t!.retSort)}); ${avail.sorts} sorts have been declared so far`);
      this.read(this.L.sorts[t!.retSort]?.span);
      this.check("not a pure sort", "Sort Table", !this.L.sorts[t!.retSort]!.modifiers.pure, `sort ${this.sortName(t!.retSort)} ${this.L.sorts[t!.retSort]!.modifiers.pure ? "is pure: terms may not have it as their return sort" : "is not pure"}`);
      this.loadArgs(t!.args, t!.varNames);
      const ret = t!.ret;
      this.check("return type present", "Term Table", !!ret, ret ? "" : "the term's data block has no return type");
      this.read(ret!.span);
      this.check("return type matches ret_sort", "Term Table", !ret!.bound && ret!.sort === t!.retSort, `ret is ${ret!.bound ? "bound, " : ""}sort ${this.sortName(ret!.sort)}; ret_sort is ${this.sortName(t!.retSort)}`);
      const bvCount = t!.args.filter((a) => a.bound).length;
      this.check("return deps are declared bound variables", "Term Table", (ret!.deps >> BigInt(bvCount)) === 0n, `ret ${this.depsPhrase(ret!.deps)}; ${bvCount} bound variables are declared`);
      const isDef = t!.isDef;
      if (st.hasProof !== isDef) this.check("statement kind matches is_def", "Proof Stream", false, isDef ? "the term table says this is a def, but the statement has no proof body" : "the term table says this is a term, but the statement has a proof body");
      if (!isDef) {
        this.check("Term has no body", "Proof Stream", rec.cmd!.data === rec.cmd!.size, `the statement's length ${rec.cmd!.data} should equal the size of the statement command, ${rec.cmd!.size}`);
        this.say(rec, () => `Declares term ${decl!.id}, ${name}: ${t!.numArgs} argument${t!.numArgs === 1 ? "" : "s"}, returning ${this.sortName(t!.retSort)}. No proof; the term counter becomes ${decl!.id + 1}.`);
        this.phase = "done";
        return;
      }
      this.say(rec, () => `Begins def ${decl!.id}, ${name}. The heap holds its ${t!.numArgs} argument${t!.numArgs === 1 ? "" : "s"}; the proof stream must now build the value, which is then matched against the unify stream.`);
      this.phase = "proof";
      return;
    }

    const t = this.L.thms[decl!.id];
    this.check("theorem table has room", "Proof Stream", decl!.id < h!.numThms && !!t?.entrySpan, `this is theorem ${decl!.id}; the header declares num_thms = ${h!.numThms}`);
    this.read(t!.entrySpan);
    this.loadArgs(t!.args, t!.varNames);
    const kind = st.opcode === 0x02 ? "axiom" : "theorem";
    this.say(rec, () => `Begins ${kind} ${decl!.id}, ${name}. The heap holds its ${t!.numArgs} variable${t!.numArgs === 1 ? "" : "s"}; the proof stream must build each hypothesis, then ${kind === "axiom" ? "the conclusion" : "a proof of the conclusion"}.`);
    this.phase = "proof";
  }

  /** The spec's binder rules, applied while the variables are put on the heap. */
  private loadArgs(args: Arg[], names: (string | undefined)[] | undefined): void {
    this.nextBv = 0;
    args.forEach((a, i) => {
      this.read(a.span);
      const name = varName(names, i);
      this.check(`binder ${name}: sort declared`, "Term Table", a.sort < this.stmt.avail.sorts, `sort ${a.sort} (${this.sortName(a.sort)}); ${this.stmt.avail.sorts} sorts have been declared so far`);
      if (a.bound) {
        this.check(`binder ${name}: bound variable not in a strict sort`, "Sort Table", !this.L.sorts[a.sort]!.modifiers.strict, `sort ${this.sortName(a.sort)} ${this.L.sorts[a.sort]!.modifiers.strict ? "is strict, which forbids bound variables" : "is not strict"}`);
        this.check(`binder ${name}: bound variable deps`, "Term Table", a.deps === 1n << BigInt(this.nextBv), `deps must be exactly bit ${this.nextBv} (this is bound variable ${this.nextBv}); found ${this.showDeps(a.deps)}`);
        this.check("at most 56 bound variables", "Term Table", this.nextBv < MAX_BOUND, `bound variable ${this.nextBv} would need bit ${this.nextBv}; the deps bitmap has bits 0 to 55`);
        const n = this.alloc({ kind: "var", sort: a.sort, bound: true, v: a.deps, fv: a.deps, name, index: i, bv: this.nextBv });
        this.nextBv++;
        this.pushHeap({ kind: "expr", e: n.id });
      } else {
        this.check(`binder ${name}: deps are earlier bound variables`, "Term Table", (a.deps >> BigInt(this.nextBv)) === 0n, `${name} ${this.depsPhrase(a.deps)}; ${this.nextBv} bound variables precede it`);
        const n = this.alloc({ kind: "var", sort: a.sort, bound: false, v: a.deps, fv: a.deps, name, index: i });
        this.pushHeap({ kind: "expr", e: n.id });
      }
    });
  }

  // -- proof commands ---------------------------------------------------------------

  private stepProof(rec: StepRecord): void {
    const span = this.cmds[this.pc];
    const st = this.stmt;
    if (!span) {
      rec.span = st.span;
      this.check("proof body ends with END", "Proof Stream", false, this.cmds.length ? "the body's commands ran out without an END" : "the statement has no proof body");
      return;
    }
    rec.span = span;
    this.read(span);
    const cmd = span.value as Cmd | undefined;
    this.check("command decodes", "Proof Stream", span.kind === "proof.cmd" && !!cmd, span.kind === "proof.cmd" ? "" : span.label);
    rec.cmd = cmd;
    const info = PROOF_OPS[cmd!.op];
    rec.mnemonic = info ? span.label : `unknown opcode 0x${cmd!.op.toString(16)}`;
    this.check("known proof opcode", "Proof Stream", !!info, info ? "" : `opcode 0x${cmd!.op.toString(16).padStart(2, "0")} is not a proof command`);
    this.pc++;
    const data = cmd!.data;
    const L = this.L;

    switch (cmd!.op) {
      case 0x00: {
        // END
        this.endOfProof(rec, span);
        return;
      }
      case 0x10:
      case 0x11: {
        // Term / TermSave
        const save = cmd!.op === 0x11;
        const t = L.terms[data];
        this.check("term declared before this statement", "Proof Stream", data < st.avail.terms && !!t?.entrySpan, `term ${data}${t ? ` (${this.termName(data)})` : ""}; ${st.avail.terms} terms are available here${data === this.declRef?.id && this.declRef.kind === "term" ? " (a def may not use itself)" : ""}`);
        this.read(t!.entrySpan, t!.dataSpan);
        const n = t!.numArgs;
        this.check("stack has the arguments", "Proof Checking", this.stack.length >= n, `${this.termName(data)} takes ${n} argument${n === 1 ? "" : "s"}; the stack has ${this.stack.length} element${this.stack.length === 1 ? "" : "s"}`);
        const argEntries = this.stack.splice(this.stack.length - n, n);
        rec.pops.unshift(...argEntries);
        const args: number[] = [];
        const bvDeps: bigint[] = [];
        let v = 0n;
        let fv = 0n;
        argEntries.forEach((s, i) => {
          const targ = t!.args[i]!;
          this.read(targ.span);
          const argName = varName(t!.varNames, i);
          this.check(`argument ${i + 1} is an expression`, "Proof Checking", s.kind === "expr", s.kind === "expr" ? "" : `${STACK_KIND_TEXT[s.kind]} ${this.showEntry(s)} where an expression was expected`);
          const e = this.node((s as { e: number }).e);
          args.push(e.id);
          this.checkSort(e, targ, `argument ${i + 1} (${argName})`);
          v |= e.v;
          if (targ.bound) {
            bvDeps.push(e.fv);
          } else {
            let d = e.fv;
            bvDeps.forEach((bd, j) => {
              if ((targ.deps >> BigInt(j)) & 1n) d &= ~bd;
            });
            fv |= d;
          }
        });
        if (t!.ret) {
          this.read(t!.ret.span);
          bvDeps.forEach((bd, j) => {
            if ((t!.ret!.deps >> BigInt(j)) & 1n) fv |= bd;
          });
        }
        const node = this.alloc({ kind: "term", sort: t!.retSort, bound: false, v, fv, term: data, args });
        this.push({ kind: "expr", e: node.id });
        if (save) this.pushHeap({ kind: "expr", e: node.id });
        this.say(rec, () => `${n ? `Pops ${n} argument${n === 1 ? "" : "s"} and allocates` : "Allocates"} \`#${node.id} = ${this.show(node.id)} : ${this.sortName(t!.retSort)}\`, pushed on the stack${save ? ` and saved as heap entry ${this.heap.length - 1}` : ""}.`);
        return;
      }
      case 0x12: {
        // Ref
        this.check("heap index in range", "Proof Checking", data < this.heap.length, `Ref ${data}; the heap has ${this.heap.length} entr${this.heap.length === 1 ? "y" : "ies"}`);
        const hEntry = this.heap[data]!;
        if (hEntry.kind === "conv") {
          const ob = this.popKind("coconv", "obligation");
          this.check("obligation matches the saved conversion", "Proof Checking", ob.e1 === hEntry.e1 && ob.e2 === hEntry.e2, `heap entry ${data} proves ${this.showEntry(hEntry)}; the obligation is ${this.showEntry(ob)}${ob.e1 === hEntry.e1 && ob.e2 === hEntry.e2 ? "" : " (the sides must be the same nodes)"}`);
          this.say(rec, () => `Heap entry ${data} is a conversion, so Ref discharges the obligation \`${this.showEntry(ob)}\` instead of pushing.`);
        } else {
          this.push(hEntry);
          this.say(rec, () => {
            return `Pushes heap entry ${data}, ${STACK_KIND_TEXT[hEntry.kind]} \`${this.showEntry(hEntry)}\`, on the stack. The stack entry is a pointer to the interned expression node #${hEntry.e}, not a copy: Refl and unification compare pointers.`;
          });
        }
        return;
      }
      case 0x13: {
        // Dummy
        const s = L.sorts[data];
        this.check("sort declared before this statement", "Proof Stream", data < st.avail.sorts && !!s, `sort ${data}; ${st.avail.sorts} sorts are available here`);
        this.read(s!.span);
        this.check("dummy sort not strict", "Sort Table", !s!.modifiers.strict, `sort ${this.sortName(data)} ${s!.modifiers.strict ? "is strict, which forbids bound variables" : "is not strict"}`);
        // mm0-c and Aufbau also reject free sorts; the spec text only mentions strict.
        this.check("dummy sort not free", "Sort Table", !s!.modifiers.free, `sort ${this.sortName(data)} ${s!.modifiers.free ? "is free, which forbids dummy variables (mm0-c rule; the spec text omits it)" : "is not free"}`);
        this.check("at most 56 bound variables", "Proof Checking", this.nextBv < MAX_BOUND, `this would be bound variable ${this.nextBv}, needing bit ${this.nextBv}; the deps bitmap has bits 0 to 55`);
        const numArgs = this.decl?.numArgs ?? 0;
        const name = dummyName(this.decl?.varNames, numArgs, this.dummies++);
        const bit = 1n << BigInt(this.nextBv);
        const node = this.alloc({ kind: "var", sort: data, bound: true, v: bit, fv: bit, name, index: this.heap.length, bv: this.nextBv });
        this.nextBv++;
        this.push({ kind: "expr", e: node.id });
        this.pushHeap({ kind: "expr", e: node.id });
        this.say(rec, () => `Allocates a new bound variable \`${name} : ${this.sortName(data)}\` (bit ${node.bv} of the deps bitmaps), pushed on the stack and saved as heap entry ${this.heap.length - 1}; next_bv becomes ${this.nextBv}.`);
        return;
      }
      case 0x14:
      case 0x15: {
        // Thm / ThmSave
        const save = cmd!.op === 0x15;
        this.check("Thm only in axiom and theorem proofs", "Proof Checking", this.mode === "thm", "a def body may not apply theorems");
        const t = L.thms[data];
        const tname = declName(L, { kind: "thm", id: data });
        this.check("theorem declared before this statement", "Proof Stream", data < st.avail.thms && !!t?.entrySpan, `theorem ${data}${t ? ` (${tname})` : ""}; ${st.avail.thms} theorems are available here${data === this.declRef?.id && this.declRef.kind === "thm" ? " (a theorem may not cite itself)" : ""}`);
        this.read(t!.entrySpan, t!.dataSpan);
        const e = this.popKind("expr", "the conclusion e");
        const n = t!.numArgs;
        this.check("stack has the arguments", "Proof Checking", this.stack.length >= n, `${tname} takes ${n} argument${n === 1 ? "" : "s"}; the stack has ${this.stack.length} element${this.stack.length === 1 ? "" : "s"} below the conclusion`);
        const argEntries = this.stack.splice(this.stack.length - n, n);
        rec.pops.unshift(...argEntries);
        const uheap: { e: number; saved: boolean }[] = [];
        const bvDeps: bigint[] = [];
        argEntries.forEach((s, i) => {
          const targ = t!.args[i]!;
          this.read(targ.span);
          const argName = varName(t!.varNames, i);
          this.check(`argument ${i + 1} is an expression`, "Proof Checking", s.kind === "expr", s.kind === "expr" ? "" : `${STACK_KIND_TEXT[s.kind]} ${this.showEntry(s)} where an expression was expected`);
          const ex = this.node((s as { e: number }).e);
          this.checkSort(ex, targ, `argument ${i + 1} (${argName})`);
          const d = this.deps(ex);
          if (targ.bound) {
            for (let j = 0; j < i; j++) {
              const prev = this.node(uheap[j]!.e);
              const overlap = this.deps(prev) & d;
              this.check(`bound ${argName} disjoint from earlier arguments`, "Proof Checking", overlap === 0n, `${argName} := ${this.show(ex.id)} must not occur in argument ${j + 1} := ${this.show(prev.id)}${overlap ? `; both use ${this.showDeps(overlap)}` : ""}`);
            }
            bvDeps.push(d);
          } else {
            bvDeps.forEach((bd, j) => {
              const allowed = ((targ.deps >> BigInt(j)) & 1n) === 1n;
              const overlap = bd & d;
              if (!allowed || overlap) {
                this.check(`${argName} disjoint from bound variable ${this.bvName(t!, j)}`, "Proof Checking", allowed || overlap === 0n, allowed ? `${argName} is declared to depend on ${this.bvName(t!, j)}, so overlap is allowed` : `${argName} := ${this.show(ex.id)} is not declared to depend on ${this.bvName(t!, j)}, so they must share no variables${overlap ? `; both use ${this.showDeps(overlap)}` : ""}`);
              }
            });
          }
          uheap.push({ e: ex.id, saved: false });
        });
        const stream = t!.unifySpan;
        this.check("theorem has a unify stream", "Theorem Table", !!stream, stream ? "" : "the theorem's data block has no unify stream");
        this.openUnify(rec, "thm", { kind: "thm", id: data }, stream!, uheap, e.e, { kind: "thm", e: e.e, save });
        this.say(rec, () => `Applies ${tname} with ${n} argument${n === 1 ? "" : "s"} to prove \`${this.show(e.e)}\`. The arguments become the unify heap and the unify stream must now match the claimed conclusion${t!.hypNames?.length || stream!.label.includes("UHyp") ? " and the hypotheses on the stack" : ""}.`);
        return;
      }
      case 0x16: {
        // Hyp
        this.check("Hyp only in axiom and theorem proofs", "Proof Checking", this.mode === "thm", "a def body has no hypotheses");
        const e = this.popKind("expr", "the hypothesis");
        const n = this.node(e.e);
        this.read(L.sorts[n.sort]?.span);
        this.check("hypothesis has a provable sort", "Proof Checking", !!L.sorts[n.sort]?.modifiers.provable, `sort ${this.sortName(n.sort)} ${L.sorts[n.sort]?.modifiers.provable ? "is provable" : "is not provable"}`);
        this.hyps.push(e.e);
        rec.hypPushed = e.e;
        this.pushHeap({ kind: "proof", e: e.e });
        this.say(rec, () => `Records \`${this.show(e.e)}\` as hypothesis ${this.hyps.length} and saves \`|- ${this.show(e.e)}\` as heap entry ${this.heap.length - 1}.`);
        return;
      }
      case 0x17: {
        // Conv
        const p = this.popKind("proof", "|- e2");
        const e1 = this.popKind("expr", "e1");
        this.push({ kind: "proof", e: e1.e });
        this.push({ kind: "coconv", e1: e1.e, e2: p.e });
        this.say(rec, () => `Claims \`|- ${this.show(e1.e)}\` from \`|- ${this.show(p.e)}\`, leaving the obligation \`${this.show(e1.e)} =?= ${this.show(p.e)}\` to discharge.`);
        return;
      }
      case 0x18: {
        // Refl
        const ob = this.popKind("coconv", "e1 =?= e2");
        this.check("both sides are the same node", "Proof Checking", ob.e1 === ob.e2, `#${ob.e1} ${this.show(ob.e1)} and #${ob.e2} ${this.show(ob.e2)}${ob.e1 === ob.e2 ? "" : " are different nodes (pointer equality, not structural)"}`);
        this.say(rec, () => `Discharges \`${this.showEntry(ob)}\`: both sides are node #${ob.e1}.`);
        return;
      }
      case 0x19: {
        // Sym
        const ob = this.popKind("coconv", "e1 =?= e2");
        this.push({ kind: "coconv", e1: ob.e2, e2: ob.e1 });
        this.say(rec, () => `Swaps the obligation to \`${this.show(ob.e2)} =?= ${this.show(ob.e1)}\`.`);
        return;
      }
      case 0x1a: {
        // Cong
        const ob = this.popKind("coconv", "(t e1 ... en) =?= (t e1' ... en')");
        const a = this.node(ob.e1);
        const b = this.node(ob.e2);
        this.check("both sides are applications of the same term", "Proof Checking", a.kind === "term" && b.kind === "term" && a.term === b.term, `${this.show(a.id)} is ${a.kind === "term" ? `an application of ${this.termName(a.term!)}` : "a variable"}; ${this.show(b.id)} is ${b.kind === "term" ? `an application of ${this.termName(b.term!)}` : "a variable"}`);
        for (let i = a.args!.length - 1; i >= 0; i--) this.push({ kind: "coconv", e1: a.args![i]!, e2: b.args![i]! });
        this.say(rec, () => `Splits the obligation into ${a.args!.length} obligation${a.args!.length === 1 ? "" : "s"}, one per argument of ${this.termName(a.term!)}, with the first argument's on top.`);
        return;
      }
      case 0x1b: {
        // Unfold
        const e = this.popKind("expr", "e");
        const ob = this.popKind("coconv", "(t e1 ... en) =?= e'");
        const a = this.node(ob.e1);
        this.check("left side is an application", "Proof Checking", a.kind === "term", a.kind === "term" ? "" : `${this.show(a.id)} is a variable`);
        const t = L.terms[a.term!]!;
        this.read(t.entrySpan);
        this.check("left side's term is a def", "Proof Checking", t.isDef, `${this.termName(a.term!)} ${t.isDef ? "is a def" : "is a term, which has no value to unfold"}`);
        this.check("def has a unify stream", "Term Table", !!t.unifySpan, "");
        const uheap = a.args!.map((id) => ({ e: id, saved: false }));
        this.openUnify(rec, "unfold", { kind: "term", id: a.term! }, t.unifySpan!, uheap, e.e, { kind: "unfold", e: e.e, e2: ob.e2 });
        this.say(rec, () => `Unfolds \`${this.show(a.id)}\`: its arguments become the unify heap and the unify stream of ${this.termName(a.term!)} must match \`${this.show(e.e)}\`; then the obligation becomes \`${this.show(e.e)} =?= ${this.show(ob.e2)}\`.`);
        return;
      }
      case 0x1c: {
        // ConvCut
        const ob = this.popKind("coconv", "e1 =?= e2");
        this.push({ kind: "conv", e1: ob.e1, e2: ob.e2 });
        this.push({ kind: "coconv", e1: ob.e1, e2: ob.e2 });
        this.say(rec, () => `Keeps the conversion \`${this.show(ob.e1)} = ${this.show(ob.e2)}\` beneath its obligation, so it can be saved once discharged.`);
        return;
      }
      case 0x1e: {
        // ConvSave
        const c = this.popKind("conv", "e1 = e2");
        this.pushHeap(c);
        this.say(rec, () => `Moves the conversion \`${this.showEntry(c)}\` to heap entry ${this.heap.length - 1}.`);
        return;
      }
      case 0x1f: {
        // Save
        const top = this.stack[this.stack.length - 1];
        this.check("stack not empty", "Proof Checking", !!top, top ? "" : "Save needs a stack element");
        this.check("not an obligation", "Proof Checking", top!.kind !== "coconv", top!.kind === "coconv" ? `${this.showEntry(top!)} is an obligation, which cannot be saved` : "");
        this.pushHeap(top as HeapEntry);
        this.say(rec, () => `Saves ${STACK_KIND_TEXT[top!.kind]} \`${this.showEntry(top!)}\` as heap entry ${this.heap.length - 1} without popping it.`);
        return;
      }
      case 0x20: {
        // Sorry
        this.check("Sorry only in axiom and theorem proofs", "Proof Checking", this.mode === "thm", "a def body may not use Sorry");
        this.sorryUsed = true;
        const s = this.pop();
        if (s.kind === "expr") {
          this.push({ kind: "proof", e: s.e });
          this.say(rec, () => `Admits \`|- ${this.show(s.e)}\` without proof. The statement can no longer count as verified.`);
        } else {
          // The spec drops an obligation; mm0-c's code pops a conversion instead (see SPEC_NOTES).
          this.check("Sorry pops an expression or an obligation", "Proof Checking", s.kind === "coconv", `found ${STACK_KIND_TEXT[s.kind]} ${this.showEntry(s)}`);
          this.say(rec, () => `Drops the obligation \`${this.showEntry(s)}\` without discharging it. The statement can no longer count as verified.`);
        }
        return;
      }
      default:
        this.check("known proof opcode", "Proof Stream", false, `opcode 0x${cmd!.op.toString(16)} is not a proof command`);
    }
  }

  private bvName(t: Term | Thm, j: number): string {
    let k = 0;
    for (let i = 0; i < t.args.length; i++) {
      if (!t.args[i]!.bound) continue;
      if (k === j) return varName(t.varNames, i);
      k++;
    }
    return `bv${j}`;
  }

  /** mm0-c's sorts_compatible: same sort, and a bound variable may stand where a regular one is expected but not the reverse. */
  private checkSort(e: ExprNode, targ: Arg, what: string): void {
    const bad = e.sort !== targ.sort;
    this.check(`${what} has sort ${this.sortName(targ.sort)}`, "Proof Checking", !bad, `${this.show(e.id)} has sort ${this.sortName(e.sort)}`);
    if (targ.bound) this.check(`${what} is a bound variable`, "Proof Checking", e.bound, `${this.show(e.id)} is ${e.bound ? "bound" : e.kind === "var" ? "a regular variable" : "an application"}`);
  }

  private endOfProof(rec: StepRecord, span: Span): void {
    const st = this.stmt;
    this.check("END at the statement boundary", "Proof Stream", span.end === st.bodyEnd, `END ends at 0x${span.end.toString(16)}; the statement's length field says the next statement starts at 0x${st.bodyEnd.toString(16)}`);
    this.check("stack holds exactly one element", "Proof Checking", this.stack.length === 1, `the stack has ${this.stack.length} element${this.stack.length === 1 ? "" : "s"}: ${this.stack.map((s) => this.showEntry(s)).join(", ") || "(empty)"}`);
    const top = this.stack[0]!;
    if (this.mode === "def") {
      const t = this.decl as Term;
      this.check("the value is an expression", "Proof Checking", top.kind === "expr", `found ${STACK_KIND_TEXT[top.kind]} ${this.showEntry(top)}`);
      const e = this.node((top as { e: number }).e);
      this.read(t.ret!.span);
      this.checkSort(e, t.ret!, "the value");
      const extra = e.fv & ~t.ret!.deps;
      this.check("value's free variables are declared in ret", "Proof Checking", extra === 0n, `FV(value) = ${this.showDeps(e.fv)}; ret declares ${this.showDeps(t.ret!.deps)}${extra ? `; ${this.showDeps(extra)} would be unaccounted` : ""}`);
      const uheap = this.heap.slice(0, t.numArgs).map((h) => ({ e: (h as { e: number }).e, saved: false }));
      this.check("def has a unify stream", "Term Table", !!t.unifySpan, "");
      this.openUnify(rec, "def-end", this.declRef!, t.unifySpan!, uheap, e.id, { kind: "finish" });
      this.say(rec, () => `The body is complete: the value is \`${this.show(e.id)}\`. Now the unify stream of the def must describe exactly this expression.`);
      return;
    }
    const t = this.decl as Thm;
    const axiom = st.opcode === 0x02;
    this.check(axiom ? "an axiom ends with its conclusion expression" : "a theorem ends with a proof", "Proof Checking", top.kind === (axiom ? "expr" : "proof"), `found ${STACK_KIND_TEXT[top.kind]} ${this.showEntry(top)}`);
    const e = this.node((top as { e: number }).e);
    this.read(this.L.sorts[e.sort]?.span);
    this.check("conclusion has a provable sort", "Proof Checking", !!this.L.sorts[e.sort]?.modifiers.provable, `sort ${this.sortName(e.sort)} ${this.L.sorts[e.sort]?.modifiers.provable ? "is provable" : "is not provable"}`);
    const uheap = this.heap.slice(0, t.numArgs).map((h) => ({ e: (h as { e: number }).e, saved: false }));
    this.check("theorem has a unify stream", "Theorem Table", !!t.unifySpan, "");
    this.openUnify(rec, "thm-end", this.declRef!, t.unifySpan!, uheap, e.id, { kind: "finish" });
    this.say(rec, () => `The proof is complete: ${axiom ? "the conclusion is" : "it proves"} \`${this.show(e.id)}\` with ${this.hyps.length} hypothes${this.hyps.length === 1 ? "is" : "es"}. Now the unify stream must describe exactly this statement.`);
  }

  private openUnify(rec: StepRecord, mode: UnifyMode, owner: DeclRef, stream: Span, uheap: { e: number; saved: boolean }[], target: number, onEnd: UnifyFrame["onEnd"]): void {
    this.read(stream);
    const cmds = childrenOf(stream);
    this.unify = { mode, owner, stream, cmds, pc: 0, ustack: [target], uheap, onEnd };
    rec.opens = mode;
    rec.upushes.push(target);
    rec.uheapPushes.push(...uheap.map((u) => u.e));
  }

  // -- unify commands ----------------------------------------------------------------

  private stepUnify(rec: StepRecord, u: UnifyFrame): void {
    rec.level = "unify";
    const span = u.cmds[u.pc];
    if (!span) {
      rec.span = u.stream;
      this.check("unify stream ends with END", "Unify Stream", false, "the stream's commands ran out without an END");
      return;
    }
    rec.span = span;
    this.read(span);
    const cmd = span.value as Cmd | undefined;
    this.check("command decodes", "Unify Stream", span.kind === "unify.cmd" && !!cmd, span.kind === "unify.cmd" ? "" : span.label);
    rec.cmd = cmd;
    const info = UNIFY_OPS[cmd!.op];
    rec.mnemonic = info ? span.label : `unknown opcode 0x${cmd!.op.toString(16)}`;
    this.check("known unify opcode", "Unify Stream", !!info, info ? "" : `opcode 0x${cmd!.op.toString(16).padStart(2, "0")} is not a unify command`);
    u.pc++;
    const data = cmd!.data;
    const isDef = u.mode === "unfold" || u.mode === "def-end";

    switch (cmd!.op) {
      case 0x00: {
        this.check("unify stack is empty at END", "Unification", u.ustack.length === 0, u.ustack.length ? `${u.ustack.length} expression${u.ustack.length === 1 ? "" : "s"} left unmatched: ${u.ustack.map((e) => this.show(e)).join(", ")}` : "");
        if (u.mode === "thm-end") this.check("every hypothesis was matched", "Unification", this.hyps.length === 0, this.hyps.length ? `${this.hyps.length} hypothes${this.hyps.length === 1 ? "is" : "es"} of the proof ${this.hyps.length === 1 ? "was" : "were"} not consumed by a UHyp: ${this.hyps.map((e) => this.show(e)).join(", ")}` : "");
        this.unify = undefined;
        rec.closes = true;
        const end = u.onEnd;
        if (end.kind === "thm") {
          this.push({ kind: "proof", e: end.e });
          if (end.save) this.pushHeap({ kind: "proof", e: end.e });
          this.say(rec, () => `Unification succeeded: pushes \`|- ${this.show(end.e)}\`${end.save ? ` and saves it as heap entry ${this.heap.length - 1}` : ""}.`);
        } else if (end.kind === "unfold") {
          this.push({ kind: "coconv", e1: end.e, e2: end.e2 });
          this.say(rec, () => `The def unfolds as claimed: pushes the obligation \`${this.show(end.e)} =?= ${this.show(end.e2)}\`.`);
        } else {
          this.phase = "done";
          this.say(rec, () => this.mode === "def" ? "The value matches the unify stream. The def is verified." : `The proved statement matches the unify stream. The ${this.stmt.opcode === 0x02 ? "axiom" : "theorem"} is verified${this.sorryUsed ? ", except that Sorry was used" : ""}.`);
        }
        return;
      }
      case 0x32: {
        // URef
        this.check("unify heap index in range", "Unification", data < u.uheap.length, `URef ${data}; the unify heap has ${u.uheap.length} entr${u.uheap.length === 1 ? "y" : "ies"}`);
        const e = this.upop();
        const h = u.uheap[data]!.e;
        this.check("top of unify stack is unify heap entry", "Unification", e === h, `heap entry ${data} is #${h} ${this.show(h)}; the stack holds #${e} ${this.show(e)}${e === h ? "" : " (a different node; equality is by identity)"}`);
        this.say(rec, () => `Matches \`${this.show(e)}\` against unify heap entry ${data}: both are pointers to interned node #${e}.`);
        return;
      }
      case 0x30:
      case 0x31: {
        // UTerm / UTermSave
        const save = cmd!.op === 0x31;
        const e = this.upop();
        const n = this.node(e);
        const t = this.L.terms[data];
        this.read(t?.entrySpan);
        this.check(`top of unify stack is an application of ${t ? this.termName(data) : `term ${data}`}`, "Unification", n.kind === "term" && n.term === data, n.kind === "term" ? `found an application of ${this.termName(n.term!)}: ${this.show(e)}` : `found the variable ${this.show(e)}`);
        for (let i = n.args!.length - 1; i >= 0; i--) this.upush(n.args![i]!);
        if (save) this.upushHeap(e, true);
        this.say(rec, () => `\`${this.show(e)}\` is an application of ${this.termName(data)}; its ${n.args!.length} argument${n.args!.length === 1 ? "" : "s"} go back on the unify stack, first argument on top${save ? `, and the whole is saved as unify heap entry ${u.uheap.length - 1}` : ""}.`);
        return;
      }
      case 0x33: {
        // UDummy
        this.check("UDummy only in def values", "Unification", isDef, `this unify stream is being run while ${UNIFY_MODE_TEXT[u.mode]}`);
        const e = this.upop();
        const n = this.node(e);
        this.check("top of unify stack is a bound variable", "Unification", n.kind === "var" && n.bound, `found ${n.kind === "var" ? "the regular variable" : "the application"} ${this.show(e)}`);
        this.check(`dummy has sort ${this.sortName(data)}`, "Unification", n.sort === data, `${this.show(e)} has sort ${this.sortName(n.sort)}`);
        u.uheap.forEach((h, i) => {
          if (h.saved) return;
          const other = this.node(h.e);
          const overlap = this.deps(other) & n.v;
          this.check(`dummy ${this.show(e)} not used by unify heap entry ${i}`, "Unification", overlap === 0n, `entry ${i} is ${this.show(h.e)}${overlap ? `, which uses ${this.show(e)}` : ""}`);
        });
        this.upushHeap(e, false);
        this.say(rec, () => `\`${this.show(e)}\` is a fresh bound variable of sort ${this.sortName(data)}, distinct from everything substituted so far; it becomes unify heap entry ${u.uheap.length - 1}.`);
        return;
      }
      case 0x36: {
        // UHyp
        this.check("UHyp only in theorem statements", "Unification", !isDef, `this unify stream is being run while ${UNIFY_MODE_TEXT[u.mode]}`);
        if (u.mode === "thm") {
          const p = this.popKind("proof", "|- e (a hypothesis of the theorem being applied)");
          this.upush(p.e);
          this.say(rec, () => `Pops the proof \`|- ${this.show(p.e)}\` from the main stack; the following unify commands must match it against the hypothesis.`);
        } else {
          this.check("unify stack is empty before UHyp", "Unification", u.ustack.length === 0, u.ustack.length ? `${u.ustack.length} expression${u.ustack.length === 1 ? "" : "s"} left unmatched: ${u.ustack.map((x) => this.show(x)).join(", ")}` : "");
          this.check("the proof declared a hypothesis for this UHyp", "Unification", this.hyps.length > 0, "the proof's hypothesis list is empty, but the unify stream declares another hypothesis");
          const e = this.hyps.pop()!;
          rec.hypPopped = e;
          this.upush(e);
          this.say(rec, () => `Takes the last hypothesis the proof declared, \`${this.show(e)}\`; the following unify commands must match it.`);
        }
        return;
      }
      default:
        this.check("known unify opcode", "Unify Stream", false, `opcode 0x${cmd!.op.toString(16)} is not a unify command`);
    }
  }
}

