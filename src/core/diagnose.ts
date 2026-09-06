/**
 * The error explorer's reading of a failed verification. The machine says
 * which check failed and what it compared; this module says what kind of
 * mistake that is, shows the expected and actual expressions side by side
 * when the failure is a mismatch, and suggests what the file's author
 * probably intended.
 */

import { hex, type Cmd } from "./bytes";
import { declName, type Layout } from "./layout";
import { type Check, type ExprNode, type Machine, type StackEntry, type StepRecord, type UnifyFrame, STACK_KIND_TEXT } from "./machine";
import { type DeclRef } from "./spans";
import { disassembleUnify, type UExpr } from "./streams";
import type { Trace } from "./verify";

export type DiagnosisKind =
  | "forward-reference"
  | "self-reference"
  | "missing-save"
  | "stack-underflow"
  | "stack-leftover"
  | "wrong-kind"
  | "identity"
  | "conversion"
  | "unify-mismatch"
  | "sort"
  | "disjoint"
  | "hypotheses"
  | "encoding"
  | "declaration"
  | "other";

export const KIND_TITLE: Record<DiagnosisKind, string> = {
  "forward-reference": "Forward reference",
  "self-reference": "Self reference",
  "missing-save": "Reference to a heap entry that does not exist",
  "stack-underflow": "Stack underflow",
  "stack-leftover": "Leftover stack elements at END",
  "wrong-kind": "Wrong kind of stack element",
  identity: "Equal expressions, different nodes",
  conversion: "Conversion between different expressions",
  "unify-mismatch": "Statement and proof disagree",
  sort: "Sort mismatch",
  disjoint: "Disjointness violation",
  hypotheses: "Hypotheses out of step",
  encoding: "Undecodable command",
  declaration: "Declaration inconsistent with its table entry",
  other: "Check failed",
};

/** A run of rendered expression text; marked runs are where the two sides differ. */
export interface Segment {
  text: string;
  mark?: boolean;
}

export interface Compare {
  expectedLabel: string;
  expected: Segment[];
  actualLabel: string;
  actual: Segment[];
  /** The two sides are structurally equal, so only identity separates them. */
  same: boolean;
}

export type Related = { kind: "step"; step: number; label: string } | { kind: "decl"; ref: DeclRef; label: string } | { kind: "offset"; offset: number; label: string };

export interface Diagnosis {
  kind: DiagnosisKind;
  title: string;
  /** What went wrong, in terms of the state. `#N` are node ids and backticks are code, as in step summaries. */
  what: string[];
  /** The reading: what the file's author probably intended, or what usually produces this. */
  likely: string;
  compare?: Compare;
  /** Other places worth looking at. */
  related: Related[];
}

/** Diagnose a failed trace. Repositions the trace's machine; call before `trace.at` for the view. */
export function diagnose(trace: Trace): Diagnosis | undefined {
  const err = trace.result.error;
  const rec = err && trace.records[err.step];
  if (!err?.check || !rec) return undefined;
  const m = trace.at(err.step);
  return new Diagnoser(trace, rec, err.check, m).run();
}

const CMD_DECL: Record<number, DeclRef["kind"]> = { 0x10: "term", 0x11: "term", 0x13: "sort", 0x14: "thm", 0x15: "thm" };
const KIND_WORD: Record<DeclRef["kind"], string> = { sort: "sort", term: "term", thm: "theorem" };

class Diagnoser {
  readonly L: Layout;
  readonly n: string;
  readonly d: string;
  readonly related: Related[] = [];

  constructor(
    readonly trace: Trace,
    readonly rec: StepRecord,
    readonly check: Check,
    /** The machine positioned before the failing step. */
    readonly m: Machine,
  ) {
    this.L = trace.L;
    this.n = check.name;
    this.d = check.detail;
  }

  run(): Diagnosis {
    const n = this.n;
    const has = (s: string) => n.includes(s);
    if (/declared before this statement$/.test(n)) return this.reference();
    if (n === "heap index in range" || n === "unify heap index in range") return this.missingSave();
    if (n === "stack has the arguments" || n === "stack not empty" || n === "unify stack not empty") return this.underflow();
    if (n === "stack holds exactly one element") return this.leftover();
    if (n.startsWith("pop ") || /^argument \d+ is an expression$/.test(n) || n === "the value is an expression" || /ends with (its conclusion expression|a proof)$/.test(n) || n === "not an obligation" || n === "Sorry pops an expression or an obligation") return this.wrongKind();
    if (n === "both sides are the same node" || n === "obligation matches the saved conversion") return this.identity();
    if (n === "both sides are applications of the same term" || n === "left side is an application" || n === "left side's term is a def") return this.conversion();
    if (n.startsWith("top of unify stack") || n.startsWith("dummy has sort") || n.startsWith("dummy ") || n === "unify stack is empty at END") return this.unifyMismatch();
    if (n === "every hypothesis was matched" || n === "the proof declared a hypothesis for this UHyp" || n === "unify stack is empty before UHyp" || n === "hypothesis has a provable sort") return this.hypotheses();
    if (/has sort |is a bound variable$/.test(n) || has("provable sort") || has("pure sort") || n.startsWith("dummy sort")) return this.sort();
    if (has("disjoint")) return this.disjoint();
    if (has("opcode") || has("decodes") || has("ends with END") || has("statement boundary") || n === "header parsed") return this.encoding();
    if (n.startsWith("binder") || has("table has room") || n.startsWith("return") || has("is_def") || has("has no body") || has("unify stream") || has("bound variables") || has("only in")) return this.declaration();
    return this.other();
  }

  // -- helpers -----------------------------------------------------------------

  private out(kind: DiagnosisKind, what: string[], likely: string, compare?: Compare): Diagnosis {
    return { kind, title: KIND_TITLE[kind], what, likely, compare, related: this.related };
  }

  private show(id: number): string {
    return this.m.show(id);
  }

  private showEntry(s: StackEntry): string {
    return this.m.showEntry(s);
  }

  private get cmd(): Cmd | undefined {
    return this.rec.cmd;
  }

  private get mnemonic(): string {
    return this.rec.mnemonic;
  }

  private stepLabel(k: number): string {
    const r = this.trace.records[k];
    return `step ${k + 1} (${r?.level === "unify" ? "unify " : ""}${r?.mnemonic ?? "?"})`;
  }

  private declStatement(ref: DeclRef) {
    return this.L.statements.find((s) => s.decl?.kind === ref.kind && s.decl.id === ref.id);
  }

  private name(ref: DeclRef): string {
    return declName(this.L, ref);
  }

  /** The last step before the failure that pushed an element equal to `s`. */
  private provenance(s: StackEntry): number | undefined {
    for (let k = this.rec.index - 1; k >= 0; k--) {
      if (this.trace.records[k]!.pushes.some((p) => sameEntry(p, s))) return k;
    }
    return undefined;
  }

  private node(id: number): ExprNode | undefined {
    return id < this.m.arenaLen ? this.m.arena[id] : undefined;
  }

  private structEqual(a: number, b: number): boolean {
    if (a === b) return true;
    const x = this.node(a);
    const y = this.node(b);
    if (!x || !y || x.kind !== y.kind || x.sort !== y.sort) return false;
    if (x.kind === "var") return x.bound === y.bound && x.index === y.index && x.name === y.name;
    return x.term === y.term && x.args!.length === y.args!.length && x.args!.every((p, i) => this.structEqual(p, y.args![i]!));
  }

  /** Render a node as `show` does, marking every occurrence of node `mark`. */
  private segments(root: number, mark?: number): Segment[] {
    const out: Segment[] = [];
    const put = (text: string, marked: boolean) => {
      const last = out[out.length - 1];
      if (last && !!last.mark === marked) last.text += text;
      else out.push(marked ? { text, mark: true } : { text });
    };
    const walk = (id: number, top: boolean, marked: boolean) => {
      const on = marked || id === mark;
      const n = this.node(id);
      if (!n) return put(`#${id}`, on);
      if (n.kind === "var") return put(n.name ?? `?${id}`, on);
      if (!n.args!.length) return put(this.m.termName(n.term!), on);
      if (!top) put("(", on);
      put(this.m.termName(n.term!), on);
      for (const a of n.args!) {
        put(" ", on);
        walk(a, false, on);
      }
      if (!top) put(")", on);
    };
    walk(root, true, false);
    return out;
  }

  /**
   * Render a decoded unify expression with the declaration's variables
   * replaced by the frame's substitution, marking the subterm the `pc`-th
   * unify command of this expression describes.
   */
  private usegments(e: UExpr, u: UnifyFrame, pc: number): Segment[] {
    const out: Segment[] = [];
    const put = (text: string, marked: boolean) => {
      const last = out[out.length - 1];
      if (last && !!last.mark === marked) last.text += text;
      else out.push(marked ? { text, mark: true } : { text });
    };
    let count = 0;
    const walk = (x: UExpr, top: boolean, marked: boolean) => {
      const on = marked || count === pc;
      count++;
      switch (x.kind) {
        case "var": {
          const h = u.uheap[x.index];
          return put(h ? this.m.show(h.e, false) : x.name, on);
        }
        case "dummy":
          return put(x.name, on);
        case "ref":
          return put(x.to.kind === "app" && x.to.args.length ? `(${uShow(x.to)})` : uShow(x.to), on);
        case "error":
          return put(`⟨${x.message}⟩`, on);
        case "app": {
          if (!x.args.length) return put(x.name, on);
          if (!top) put("(", on);
          put(x.name, on);
          for (const a of x.args) {
            put(" ", on);
            walk(a, false, on);
          }
          if (!top) put(")", on);
        }
      }
    };
    const uShow = (x: UExpr): string => {
      switch (x.kind) {
        case "var": {
          const h = u.uheap[x.index];
          return h ? this.m.show(h.e, false) : x.name;
        }
        case "dummy":
          return x.name;
        case "ref":
          return uShow(x.to);
        case "error":
          return `⟨${x.message}⟩`;
        case "app":
          return x.args.length ? `${x.name} ${x.args.map((a) => (a.kind === "app" && a.args.length ? `(${uShow(a)})` : uShow(a))).join(" ")}` : x.name;
      }
    };
    walk(e, true, false);
    return out;
  }

  private text(segs: Segment[]): string {
    return segs.map((s) => s.text).join("");
  }

  /** The marked text, without the parentheses a subterm is printed with. */
  private marked(segs: Segment[]): string {
    const t = segs.filter((s) => s.mark).map((s) => s.text).join("");
    return t.startsWith("(") && t.endsWith(")") ? t.slice(1, -1) : t;
  }

  // -- readings ------------------------------------------------------------------

  private reference(): Diagnosis {
    const st = this.trace.stmt;
    const kind = this.cmd ? CMD_DECL[this.cmd.op] : undefined;
    const word = kind ? KIND_WORD[kind] : "declaration";
    const id = this.cmd?.data ?? -1;
    const ref: DeclRef | undefined = kind ? { kind, id } : undefined;
    const self = this.d.includes("may not");
    const here = st.decl ? `${this.name(st.decl)} (statement ${st.index})` : `statement ${st.index}`;
    if (self && ref) {
      this.related.push({ kind: "decl", ref, label: `the table entry of ${this.name(ref)}` });
      return this.out(
        "self-reference",
        [`The proof of \`${this.name(ref)}\` cites \`${this.name(ref)}\` itself: ${word} ${id} is the declaration being verified.`],
        `A declaration is only available to the statements after it, so nothing may use itself: a theorem that cites itself would prove itself, and a def that uses itself would have no finite value. mm0-c rejects the reference; the cited index is most likely off by one, or the proof was moved from another theorem without renumbering its Thm operands.`,
      );
    }
    const avail = kind === "term" ? st.avail.terms : kind === "thm" ? st.avail.thms : st.avail.sorts;
    const target = ref && this.declStatement(ref);
    const exists = ref && (kind === "sort" ? !!this.L.sorts[id] : kind === "term" ? !!this.L.terms[id]?.entrySpan : !!this.L.thms[id]?.entrySpan);
    const what: string[] = [];
    if (ref && exists) {
      what.push(`The proof cites ${word} ${id}, \`${this.name(ref)}\`, but at ${here} only ${word}s 0 to ${avail - 1} have been declared${target ? `: \`${this.name(ref)}\` is statement ${target.index}, which comes ${target.index > st.index ? "after" : "at or after"} this one` : ""}.`);
      this.related.push({ kind: "decl", ref, label: `the table entry of ${this.name(ref)}` });
      if (target) this.related.push({ kind: "offset", offset: target.offset, label: `its statement at ${hex(target.offset)}` });
    } else {
      what.push(`The proof cites ${word} ${id}, but the file declares no such ${word}${avail ? ` (${word}s 0 to ${avail - 1} are available here)` : ""}.`);
    }
    return this.out(
      "forward-reference",
      what,
      `MMB lists declarations in the order they are checked, and a proof may only use what precedes it; a verifier reads the file once, front to back, and knows nothing about later statements. mm0-rs emits declarations in dependency order, so a file like this was assembled or edited by hand, or the operand is wrong: a ${kind === "thm" ? "Thm" : "Term"} operand off by one cites a neighbour in the table instead of the intended declaration.`,
    );
  }

  private missingSave(): Diagnosis {
    const unify = this.n.startsWith("unify");
    const idx = this.cmd?.data ?? -1;
    if (unify) {
      const u = this.m.unify!;
      return this.out(
        "missing-save",
        [`\`URef ${idx}\` asks for unify heap entry ${idx}, but the unify heap has ${u.uheap.length} entr${u.uheap.length === 1 ? "y" : "ies"}${u.uheap.length ? `: ${u.uheap.map((h, i) => `${i}: \`${this.show(h.e)}\``).join(", ")}` : ""}.`],
        `The unify heap holds the declaration's variables and then whatever the stream itself saved with UTermSave and UDummy, in stream order. A URef past the end means the stream expected an earlier subterm to have been saved, or the index is off by one. The unify stream is the declaration's statement, so this is an error in the table entry rather than in the proof.`,
      );
    }
    const heap = this.m.heap;
    const what = [`\`Ref ${idx}\` asks for heap entry ${idx}, but the heap has ${heap.length} entr${heap.length === 1 ? "y" : "ies"}${heap.length ? `: ${heap.map((h, i) => `${i}: \`${this.showEntry(h)}\``).join(", ")}` : ""}.`];
    // The most recent expression built without saving it is the usual suspect.
    for (let k = this.rec.index - 1; k >= 0; k--) {
      const r = this.trace.records[k]!;
      if (r.level === "proof" && (r.cmd?.op === 0x10 || r.cmd?.op === 0x14) && r.pushes.length && !r.heapPushes.length) {
        what.push(`The last result built without saving it is \`${this.showEntry(r.pushes[0]!)}\` at ${this.stepLabel(k)}; had that been ${r.cmd.op === 0x10 ? "TermSave" : "ThmSave"}, it would be heap entry ${heap.length}.`);
        this.related.push({ kind: "step", step: k + 1, label: `${this.stepLabel(k)}, the unsaved result` });
        break;
      }
    }
    return this.out(
      "missing-save",
      what,
      `Heap entries are numbered in the order they are created: the variables first, then one per Save, TermSave, ThmSave, ConvSave, Dummy, and Hyp. A Ref past the end almost always means an earlier result was meant to be saved and reused, so a Term or Thm should have been its saving form; otherwise the Ref index is off by one.`,
    );
  }

  private underflow(): Diagnosis {
    const stack = this.m.stack;
    const held = stack.length ? `holds ${stack.length}: ${stack.map((s) => `\`${this.showEntry(s)}\``).join(", ")}` : "is empty";
    const what = [`\`${this.mnemonic}\` needs more than the stack has: ${this.d}. The stack ${held}.`];
    return this.out(
      "stack-underflow",
      what,
      `A proof stream is in reverse Polish order: every operand is pushed before the command that consumes it, so a term's arguments and a theorem's hypotheses, arguments, and conclusion all precede it. Either something is missing before this command, or the command comes one step too early: the elements it needs are being built after it.`,
    );
  }

  private leftover(): Diagnosis {
    const stack = this.m.stack;
    const isDef = this.m.mode === "def";
    const what = stack.length
      ? [`At \`END\` the stack must hold exactly one element, the ${isDef ? "def's value" : "proved statement"}. It holds ${stack.length}: ${stack.map((s) => `\`${this.showEntry(s)}\``).join(", ")}.`]
      : [`At \`END\` the stack must hold exactly one element, the ${isDef ? "def's value" : "proved statement"}. It is empty: the proof built nothing.`];
    if (stack.length > 1) {
      const extra = stack.slice(0, -1);
      for (const s of extra) {
        const k = this.provenance(s);
        if (k !== undefined) this.related.push({ kind: "step", step: k + 1, label: `${this.stepLabel(k)} pushed \`${this.showEntry(s)}\`` });
      }
    }
    return this.out(
      "stack-leftover",
      what,
      stack.length
        ? `Everything pushed must be consumed. Elements left below the result were built and never used, which usually means a Term or Thm that should have combined them is missing, or an operand was pushed twice. The steps that pushed the extra elements are linked below.`
        : `Every proof body must build the ${isDef ? "value" : "statement"} it ends with; an empty body cannot be right, so either the body was truncated or its commands were removed.`,
    );
  }

  private wrongKind(): Diagnosis {
    const stack = this.m.stack;
    const top = stack[stack.length - 1];
    const what = [`\`${this.mnemonic}\`: ${this.d}.`];
    if (top) {
      const k = this.provenance(top);
      if (k !== undefined) {
        what.push(`The top of the stack, ${STACK_KIND_TEXT[top.kind]} \`${this.showEntry(top)}\`, was pushed by ${this.stepLabel(k)}.`);
        this.related.push({ kind: "step", step: k + 1, label: `${this.stepLabel(k)}, which pushed it` });
      }
    }
    return this.out(
      "wrong-kind",
      what,
      `Each command consumes elements of a particular kind: expressions come from Ref, Term, and Dummy; proofs \`|- e\` from Thm and Hyp; obligations \`e1 =?= e2\` from Conv, Cong, Unfold, and Symm; conversions \`e1 = e2\` from ConvCut and ConvSave. Finding one kind where another is expected means a command is missing or out of order between the step that pushed the element and this one.`,
    );
  }

  private identity(): Diagnosis {
    const top = this.m.stack[this.m.stack.length - 1];
    if (!top || (top.kind !== "coconv" && top.kind !== "conv")) return this.other();
    const a = top.e1;
    const b = top.e2;
    const same = this.structEqual(a, b);
    if (this.n === "obligation matches the saved conversion") {
      return this.out(
        "identity",
        [`\`${this.mnemonic}\`: ${this.d}.`],
        `A saved conversion \`e1 = e2\` discharges only an obligation whose two sides are the very same nodes, not merely equal-looking expressions. The obligation here was built from different nodes than the conversion that was saved, so either the wrong heap entry is cited, or the expressions were rebuilt instead of being shared with Save and Ref.`,
      );
    }
    const compare: Compare = { expectedLabel: "left side", expected: this.segments(a), actualLabel: "right side", actual: this.segments(b), same };
    if (same) {
      const ka = this.node(a)?.by ?? -1;
      const kb = this.node(b)?.by ?? -1;
      if (ka >= 0) this.related.push({ kind: "step", step: ka + 1, label: `${this.stepLabel(ka)} built #${a}` });
      if (kb >= 0) this.related.push({ kind: "step", step: kb + 1, label: `${this.stepLabel(kb)} built #${b}` });
      return this.out(
        "identity",
        [`\`Refl\` closes an obligation only when both sides are the same node. Here #${a} and #${b} print alike, \`${this.show(a)}\`, but are two different nodes: the expression was built twice.`],
        `The verifier compares expressions by identity, and an expression built twice is two nodes. To use one expression in several places, save it once (Save, TermSave, ThmSave) and Ref it afterwards: the Ref returns the same node. mm0-rs shares subterms this way automatically, so a proof with a duplicated build was assembled by hand or lost a Save when it was edited.`,
        compare,
      );
    }
    return this.out(
      "conversion",
      [`\`Refl\` closes an obligation only when both sides are the same expression. Here they differ: \`${this.show(a)}\` on the left and \`${this.show(b)}\` on the right.`],
      `Refl is for obligations whose sides are already identical. When they are not, the obligation has to be reduced first: Cong splits two applications of the same term into one obligation per argument, Unfold replaces a def on the left by its value, Symm swaps the sides, and ConvCut lets a saved conversion be cited. If none of those can make the sides meet, the proof step that produced this obligation (a Conv after a Thm) claimed a conclusion the theorem does not give.`,
      compare,
    );
  }

  private conversion(): Diagnosis {
    const top = this.m.stack[this.m.stack.length - 1];
    const compare = top && top.kind === "coconv" ? { expectedLabel: "left side", expected: this.segments(top.e1), actualLabel: "right side", actual: this.segments(top.e2), same: this.structEqual(top.e1, top.e2) } : undefined;
    return this.out(
      "conversion",
      [`\`${this.mnemonic}\`: ${this.d}.`],
      this.mnemonic === "Cong"
        ? `Cong applies to an obligation between two applications of the same term, and reduces it to obligations between their arguments. When the heads differ, the sides can only be brought together by unfolding a def (Unfold, on the left side), or the obligation is simply false and the Conv that created it claimed the wrong conclusion.`
        : `Unfold replaces a def application on the left side of an obligation by the def's value. It needs a def there: a plain term has no value, and a variable is not an application. Symm swaps the sides when the def is on the right.`,
      compare,
    );
  }

  private unifyMismatch(): Diagnosis {
    const u = this.m.unify;
    if (!u) return this.other();
    const dis = disassembleUnify(this.L, u.owner);
    const ownerName = this.name(u.owner);
    const part = u.roots.length - 1;
    const root = u.roots[part]!;
    // The unify command index within the part being matched: commands since the last UHyp.
    let base = 0;
    for (let i = 0; i < u.pc; i++) if ((u.cmds[i]!.value as Cmd | undefined)?.op === 0x36) base = i + 1;
    const pc = u.pc - base;
    const expectedExpr: UExpr | undefined = part === 0 ? (dis?.value ?? dis?.concl) : dis?.hyps[dis.hyps.length - part];
    const hypLabel = part > 0 && u.owner.kind === "thm" ? hypNameOf(this.L, u.owner.id, dis ? dis.hyps.length - part : part - 1) : undefined;
    const atEnd = this.n === "unify stack is empty at END";
    const popped = this.rec.upops[0];
    const expected = expectedExpr ? this.usegments(expectedExpr, u, atEnd ? -1 : pc) : [{ text: "(undecodable unify stream)" }];
    const actual = this.segments(root, atEnd ? undefined : popped);
    const same = !atEnd && popped !== undefined && u.mode !== "unfold" && this.n === "top of unify stack is unify heap entry" && this.structEqual(popped, u.uheap[this.cmd?.data ?? -1]?.e ?? -1);

    let expectedLabel: string;
    let actualLabel: string;
    let what: string;
    let likely: string;
    const diff = atEnd
      ? `The unify stream ended while \`${u.ustack.map((e) => this.show(e)).join("`, `")}\` remained unmatched: the ${part === 0 ? "statement" : "hypothesis"} is smaller than the expression the proof gave.`
      : `Unification walks the ${part === 0 ? (u.mode === "unfold" || u.mode === "def-end" ? "value" : "conclusion") : "hypothesis"} from the outside in, and this is the first place they differ: the stream expects \`${this.marked(expected) || "?"}\` where the proof has \`${popped !== undefined ? this.show(popped) : "?"}\`${same ? ", the same expression as a different node" : ""}.`;
    switch (u.mode) {
      case "thm-end": {
        expectedLabel = `the statement of ${ownerName} claims`;
        actualLabel = "the proof establishes";
        what = part === 0 ? `The proof proves \`${this.show(root)}\`; the theorem's own statement, its unify stream in the theorem table, says \`${this.text(expected)}\`.` : `The proof's hypothesis ${hypLabel} is \`${this.show(root)}\`; the theorem's statement says \`${this.text(expected)}\`.`;
        likely = `The unify stream is the theorem's public statement, what other proofs see when they cite it, and the proof body must establish exactly that expression. mm0-rs writes both from one declaration, so a mismatch means one side was edited, or this proof body belongs to a different theorem than the table entry it sits under.`;
        this.related.push({ kind: "decl", ref: u.owner, label: `the statement of ${ownerName}` });
        break;
      }
      case "def-end": {
        expectedLabel = `the unify stream of ${ownerName} says the value is`;
        actualLabel = "the body builds";
        what = `The def's body builds \`${this.show(root)}\`; its unify stream in the term table, which is what other proofs see when they unfold \`${ownerName}\`, says \`${this.text(expected)}\`.`;
        likely = `A def's value is stored twice: once as the proof body that builds it, once as the unify stream that later Unfold steps match against. They must describe the same expression. One of them has been edited, or the unify stream was written for a different definition.`;
        this.related.push({ kind: "decl", ref: u.owner, label: `the table entry of ${ownerName}` });
        break;
      }
      case "thm": {
        const subst = substitution(this.L, u, this.m);
        expectedLabel = part === 0 ? `${ownerName}'s conclusion with these arguments` : `${ownerName}'s hypothesis ${hypLabel} with these arguments`;
        actualLabel = part === 0 ? "the proof supplies" : "the proof supplies the proof of";
        what = `\`Thm ${ownerName}\`${subst ? ` with ${subst}` : ""} ${part === 0 ? "yields" : `needs its hypothesis ${hypLabel},`} \`${this.text(expected)}\`; the stack ${part === 0 ? "claims" : "supplies"} \`${this.show(root)}\`.`;
        likely = `Thm pops the arguments, then ${part === 0 ? "the expression the theorem is supposed to conclude" : "one proof per hypothesis"}, and checks them against the theorem's statement. Either the arguments are wrong, and with them the substitution, or the ${part === 0 ? "conclusion on top of the stack was built for a different theorem" : "hypothesis proofs are in the wrong order or prove something else"}, or the operand cites the wrong theorem and a neighbour of \`${ownerName}\` in the table was intended.`;
        this.related.push({ kind: "decl", ref: u.owner, label: `the statement of ${ownerName}` });
        break;
      }
      default: {
        const subst = substitution(this.L, u, this.m);
        expectedLabel = `${ownerName} unfolds to`;
        actualLabel = "the obligation's right side is";
        what = `Unfolding \`${ownerName}\`${subst ? ` with ${subst}` : ""} gives \`${this.text(expected)}\`; the proof claims it equals \`${this.show(root)}\`.`;
        likely = `Unfold replaces the def by its value with the application's arguments substituted, and the result must match the other side of the obligation exactly. The obligation came from a Conv after a Thm, so either that theorem's conclusion is not what the proof claims, or the def is not the one meant to be unfolded here.`;
        this.related.push({ kind: "decl", ref: u.owner, label: `the value of ${ownerName}` });
      }
    }
    if (same) likely = `The two expressions are equal but are different nodes, and the verifier compares by identity. When a statement mentions a subterm twice (or a theorem's hypothesis repeats part of the conclusion), the unify stream saves it with UTermSave and cites it with URef, so the proof must supply the very same node in both places: build it once, Save it, and Ref it. ` + likely;
    const frame = this.frameOpener();
    if (frame >= 0) this.related.push({ kind: "step", step: frame + 1, label: `${this.stepLabel(frame)}, which started this unification` });
    return this.out("unify-mismatch", [what, diff], likely, { expectedLabel, expected, actualLabel, actual, same });
  }

  /** Index of the record that opened the current unify frame. */
  private frameOpener(): number {
    for (let k = this.rec.index - 1; k >= 0; k--) if (this.trace.records[k]!.opens) return k;
    return -1;
  }

  private hypotheses(): Diagnosis {
    const u = this.m.unify;
    const dis = u && disassembleUnify(this.L, u.owner);
    const declared = dis?.hyps.length ?? 0;
    const inProof = this.trace.records.filter((r) => r.cmd?.op === 0x16 && r.level === "proof").length;
    const what = [`\`${this.mnemonic}\`: ${this.d}.`];
    if (u?.mode === "thm-end") what.push(`The theorem's statement lists ${declared} hypothes${declared === 1 ? "is" : "es"}; the proof declared ${inProof} with Hyp.`);
    if (this.n === "hypothesis has a provable sort") return this.sort();
    return this.out(
      "hypotheses",
      what,
      u?.mode === "thm"
        ? `When a theorem is applied, one proof per hypothesis must be on the stack below the arguments, in hypothesis order, and the theorem's unify stream matches each in turn. The stack ran out of proofs, so a hypothesis was not proved before the Thm command, or the arguments and hypotheses are interleaved in the wrong order.`
        : `The proof must declare exactly the hypotheses the theorem's statement lists, with Hyp, in order; at the end the unify stream takes them back one by one (the stream lists them last-first). A count that differs means a Hyp is missing or extra, or the proof body and the table entry belong to different theorems.`,
    );
  }

  private sort(): Diagnosis {
    return this.out(
      "sort",
      [`\`${this.mnemonic}\`: ${this.n}, but ${this.d}.`],
      this.n.includes("provable")
        ? `Only expressions of a provable sort can be hypotheses or conclusions; a sort is provable when its declaration says so. An expression of another sort here means the wrong expression was proved, or the sort table entry lacks the provable modifier.`
        : this.n.includes("bound variable")
          ? `A binder declared as a bound variable (\`{x: s}\` in MM0) must be instantiated by a variable, never by a compound expression: the theorem may quantify over it. Supplying an expression there means the arguments are in the wrong order, or the theorem is not the one intended.`
          : `MMB has no implicit coercion: every argument must have exactly the sort the term or theorem declares for it, and every dummy must be in a sort that allows it. The usual cause is two arguments in the wrong order, or an operand citing a neighbouring term or theorem by mistake.`,
    );
  }

  private disjoint(): Diagnosis {
    return this.out(
      "disjoint",
      [`\`${this.mnemonic}\`: ${this.n}; ${this.d}.`],
      `When a theorem is applied, its bound variables must be instantiated by distinct variables, and any other argument may mention one of them only if the theorem's binder declares that dependency. This is Metamath's disjoint variable condition, tracked here as the V and FV sets shown in the nodes panel. The usual cause is using the same variable for two bound variables, or substituting an expression that contains x for a variable declared independent of x.`,
    );
  }

  private encoding(): Diagnosis {
    this.related.push({ kind: "offset", offset: this.rec.span.start, label: `the bytes at ${hex(this.rec.span.start)}` });
    return this.out(
      "encoding",
      [`${this.n}: ${this.d}.`],
      `The bytes here do not form a valid command, while the commands around them decode, so this is a corrupted or hand-edited byte rather than a mis-parsed stream. The opcode tables are in the spec's Proof Stream and Unify Stream sections; the inspector's bit view shows how the first byte splits into the length tag and the opcode.`,
    );
  }

  private declaration(): Diagnosis {
    const st = this.trace.stmt;
    if (st.decl) this.related.push({ kind: "decl", ref: st.decl, label: `the table entry of ${this.name(st.decl)}` });
    return this.out(
      "declaration",
      [`\`${this.mnemonic}\`: ${this.n}; ${this.d}.`],
      this.n.includes("only in")
        ? `Def bodies and theorem proofs allow different commands: a def body builds an expression and may not apply theorems, declare hypotheses, or use Sorry, and its unify stream may not declare hypotheses either. A command from the other kind of body here means the statement opcode and the body disagree about what is being declared.`
        : `The statement in the proof stream and the declaration's table entry describe the same object twice, and the verifier checks them against each other: binder sorts and dependencies, the return type, the presence of a body. A disagreement means one of the two was edited, or the statement is under the wrong table entry.`,
    );
  }

  private other(): Diagnosis {
    return this.out("other", [`\`${this.mnemonic}\`: ${this.n}${this.d ? `; ${this.d}` : ""}.`], `The check named after the spec's rule failed; the rule and the state it was applied to are shown above.`);
  }
}

function sameEntry(a: StackEntry, b: StackEntry): boolean {
  if (a.kind !== b.kind) return false;
  if ("e" in a && "e" in b) return a.e === b.e;
  if ("e1" in a && "e1" in b) return a.e1 === b.e1 && a.e2 === b.e2;
  return false;
}

function hypNameOf(L: Layout, thm: number, k: number): string {
  const n = L.thms[thm]?.hypNames?.[k];
  return n && n !== "_" ? n : `h${k + 1}`;
}

/** The substitution a theorem application or an unfold fixed: `a := x, b := (imp x y)`. */
function substitution(L: Layout, u: UnifyFrame, m: Machine): string {
  const d = u.owner.kind === "term" ? L.terms[u.owner.id] : u.owner.kind === "thm" ? L.thms[u.owner.id] : undefined;
  if (!d) return "";
  const parts: string[] = [];
  for (let i = 0; i < d.numArgs && i < u.uheap.length; i++) {
    const name = d.varNames?.[i] ?? `v${i}`;
    parts.push(`${name} := \`${m.show(u.uheap[i]!.e)}\``);
  }
  return parts.join(", ");
}
