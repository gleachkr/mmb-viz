/**
 * The spec's rule for each command, and the same rule instantiated with what
 * a step actually did.
 *
 * The spec writes each command as a before-and-after picture of the machine,
 * `Term t: H; S, e1, ..., en --> H; S, (t e1 ... en)`, where the letters stand
 * for the parts of the state that are left alone and the rest are the entries
 * the command removed or added. A step record already lists exactly those
 * entries, so the instantiated picture keeps the letters and fills in the
 * entries.
 */

import type { StackEntry, StepRecord, UnifyMode } from "./machine";

export interface RuleSchema {
  /** The rule as the spec writes it, one string per line. */
  lines: string[];
  /** Spec section the rule lives in. */
  section: string;
  /** The lines paraphrase the spec's prose rather than quoting a displayed rule. */
  paraphrase?: boolean;
}

const PROOF_RULES: Record<number, string[]> = {
  0x10: ["Term t: H; S, e1, ..., en --> H; S, (t e1 ... en)"],
  0x11: ["TermSave t: H; S, e1, ..., en --> H, (t e1 ... en); S, (t e1 ... en)"],
  0x13: ["Dummy s: H; S --> H, x; S, x"],
  0x14: ["Thm T: H; S, e1, ..., en, e --> H; S', |- e", "where Unify(T): S; e1, ..., en; e --> S'; H'; ."],
  0x15: ["ThmSave T = Thm T, Save", "Thm T: H; S, e1, ..., en, e --> H; S', |- e", "where Unify(T): S; e1, ..., en; e --> S'; H'; ."],
  0x16: ["Hyp: HS; H; S, e --> HS, e; H, |- e; S"],
  0x17: ["Conv: S, e1, |- e2 --> S, |- e1, e1 =?= e2"],
  0x18: ["Refl: S, e =?= e --> S"],
  0x19: ["Symm: S, e1 =?= e2 --> S, e2 =?= e1"],
  0x1a: ["Cong: S, (t e1 ... en) =?= (t e1' ... en') --> S, en =?= en', ..., e1 =?= e1'"],
  0x1b: ["Unfold: S, (t e1 ... en) =?= e', e --> S, e =?= e'", "where Unify(t): e1, ..., en; e --> H'; ."],
  0x1c: ["ConvCut: S, e1 =?= e2 --> S, e1 = e2, e1 =?= e2"],
  0x1e: ["ConvSave: H; S, e1 = e2 --> H, e1 = e2; S"],
  0x1f: ["Save: H; S, s --> H, s; S, s"],
};

const UNIFY_RULES: Record<number, string[]> = {
  0x30: ["UTerm t: S, (t e1 ... en) --> S, en, ..., e1"],
  0x31: ["UTermSave t: H; S, (t e1 ... en) --> H, (t e1 ... en); S, en, ..., e1"],
  0x32: ["URef i: H; S, H[i] --> H; S"],
  0x33: ["UDummy s: H; S, x --> H, x; S"],
  0x36: ["UHyp: MS, |- e; S --> MS; S, e"],
};

/** The spec's rule for the command a step executed, or nothing for a step without one (an unknown opcode). */
export function ruleSchema(rec: StepRecord): RuleSchema | undefined {
  const op = rec.cmd?.op;
  if (rec.level === "stmt") {
    if (!rec.heapPushes.length && !rec.opens) return undefined;
    return { lines: ["H := x1, ..., xn (the declaration's variables); S := .; HS := .", "next_bv := the number of bound variables among them"], section: "Proof Checking", paraphrase: true };
  }
  if (op === undefined) return undefined;
  if (rec.level === "proof") {
    if (op === 0x00) {
      const def = rec.opens === "def-end";
      return {
        lines: def
          ? ["END (def): H; S = e --> Unify(t): x1, ..., xn; e", "the value e must match the def's unify stream"]
          : ["END (theorem): H; S = |- e --> Unify(T): x1, ..., xn; e", "the hypotheses and conclusion must match the theorem's unify stream"],
        section: "Unify Stream",
        paraphrase: true,
      };
    }
    if (op === 0x12) {
      const conv = rec.pops[0]?.kind === "coconv";
      return { lines: conv ? ["Ref i: H; S, e1 =?= e2 --> H; S    (if H[i] = (e1 = e2))"] : ["Ref i: H; S --> H; S, H[i]         (otherwise)"], section: "Proof Checking" };
    }
    if (op === 0x20) {
      const ob = rec.pops[0]?.kind === "coconv";
      return { lines: ob ? ["Sorry: S, e1 =?= e2 -> S"] : ["Sorry: S, e -> S, |- e"], section: "Proof Checking" };
    }
    const lines = PROOF_RULES[op];
    return lines && { lines, section: "Proof Checking" };
  }
  if (op === 0x00) {
    const push = rec.pushes[0];
    const lines =
      push?.kind === "proof"
        ? ["END: S = . --> MS, |- e", "the unify stack must be empty; Thm T then pushes its conclusion"]
        : push?.kind === "coconv"
          ? ["END: S = . --> MS, e =?= e'", "the unify stack must be empty; Unfold then pushes the remaining obligation"]
          : ["END: S = .", "the unify stack must be empty, and every hypothesis must have been matched"];
    return { lines, section: "Unification", paraphrase: true };
  }
  if (op === 0x36 && rec.hypPopped !== undefined) {
    return { lines: ["UHyp: HS, e; S --> HS; S, e    (at the end of a theorem, the hypotheses come from the proof's list)"], section: "Unification", paraphrase: true };
  }
  const lines = UNIFY_RULES[op];
  return lines && { lines, section: "Unification" };
}

/** One part of the machine state in a picture: its letter, and the entries the step removed from or added to it. */
export interface PictureColumn {
  /** The letter the spec uses. */
  name: string;
  /** What the letter stands for. */
  title: string;
  items: StackEntry[];
  /** The column is known to be empty (the spec writes `.`). */
  empty?: boolean;
}

/** The instantiated rule: the state before the step and after it, unify columns after the main ones. */
export interface Picture {
  before: PictureColumn[];
  after: PictureColumn[];
  /** Index in `after` where the unify frame this step opened begins. */
  opensAt?: number;
}

const expr = (e: number): StackEntry => ({ kind: "expr", e });

const MAIN = {
  HS: "the hypothesis list",
  H: "the heap",
  S: "the main stack",
};

const UNIFY = {
  MS: "the main stack",
  H: "the unify heap: the substitution",
  S: "the unify stack: expressions still to match",
};

/** Fill the rule's picture with the entries the step removed and added. */
export function picture(rec: StepRecord): Picture {
  if (rec.level !== "unify") {
    const save = rec.level === "proof" && rec.cmd?.op === 0x1f;
    const kept = save ? rec.heapPushes.slice(0, 1) : [];
    const before: PictureColumn[] = [];
    const after: PictureColumn[] = [];
    if (rec.hypPushed !== undefined) {
      before.push({ name: "HS", title: MAIN.HS, items: [] });
      after.push({ name: "HS", title: MAIN.HS, items: [expr(rec.hypPushed)] });
    }
    before.push({ name: "H", title: MAIN.H, items: [] }, { name: "S", title: MAIN.S, items: [...rec.pops, ...kept] });
    after.push({ name: "H", title: MAIN.H, items: rec.heapPushes }, { name: "S", title: MAIN.S, items: [...kept, ...rec.pushes] });
    const pic: Picture = { before, after };
    if (rec.opens) {
      pic.opensAt = after.length;
      after.push({ name: "H", title: UNIFY.H, items: rec.uheapPushes.map(expr) }, { name: "S", title: UNIFY.S, items: rec.upushes.map(expr) });
    }
    return pic;
  }
  const before: PictureColumn[] = [];
  const after: PictureColumn[] = [];
  if (rec.closes) {
    // The frame is gone; what remains is the main state, with the conclusion or obligation the frame owed.
    before.push({ name: "H", title: UNIFY.H, items: [] }, { name: "S", title: UNIFY.S, items: rec.upops.map(expr), empty: !rec.upops.length });
    if (rec.heapPushes.length) after.push({ name: "H", title: MAIN.H, items: rec.heapPushes });
    after.push({ name: "MS", title: UNIFY.MS, items: rec.pushes });
    return { before, after };
  }
  if (rec.pops.length || rec.pushes.length) {
    before.push({ name: "MS", title: UNIFY.MS, items: rec.pops });
    after.push({ name: "MS", title: UNIFY.MS, items: rec.pushes });
  }
  if (rec.hypPopped !== undefined) {
    before.push({ name: "HS", title: MAIN.HS, items: [expr(rec.hypPopped)] });
    after.push({ name: "HS", title: MAIN.HS, items: [] });
  }
  before.push({ name: "H", title: UNIFY.H, items: [] }, { name: "S", title: UNIFY.S, items: rec.upops.map(expr) });
  after.push({ name: "H", title: UNIFY.H, items: rec.uheapPushes.map(expr) }, { name: "S", title: UNIFY.S, items: rec.upushes.map(expr) });
  return { before, after };
}
