/**
 * Stream disassembly: turns the lazily decoded command spans of a unify or
 * proof stream into readable records, and decodes unify streams (which are
 * expressions in polish notation) into expression trees.
 *
 * Everything here is static: no stack machine runs. What can be known
 * without running is still a lot. The heap of a proof grows by exactly one
 * entry on each of TermSave, ThmSave, Dummy, Save, ConvSave, and Hyp, so
 * every `Ref i` can be resolved to the command that produced heap entry i.
 */

import { type Cmd } from "./bytes";
import { declName, type Layout, type Statement, type Term, type Thm } from "./layout";
import { PROOF_OPS, UNIFY_OPS, type OpInfo } from "./opcodes";
import { childrenOf, type DeclRef, type Problem, type Span } from "./spans";

export type ArgKind = OpInfo["arg"] | "unknown";

export interface DecodedCmd {
  /** Ordinal within its stream. */
  index: number;
  offset: number;
  size: number;
  op: number;
  data: number;
  dataBytes: number;
  /** Opcode name, or `?0x2a` for an unknown opcode. */
  mnemonic: string;
  argKind: ArgKind;
  /** The data field as text, when the opcode takes one. */
  operand?: string;
  /** What the operand resolves to: a term name, a variable, a heap entry. */
  note?: string;
  /** Byte offset to jump to for the operand. */
  target?: number;
  /** For commands that push a heap entry: the index that entry gets. */
  heapIndex?: number;
  problems: Problem[];
  span: Span;
}

export type HeapKind = "var" | "dummy" | "expr" | "proof" | "conv" | "hyp" | "any";

export interface HeapSlot {
  index: number;
  kind: HeapKind;
  /** Short name: a variable name, or a description of the saved entry. */
  name: string;
  /** The command that produced this entry (absent for the initial variables). */
  from?: DecodedCmd;
}

export interface ProofDisassembly {
  stmt: Statement;
  cmds: DecodedCmd[];
  /** Heap layout after the whole stream: variables, then one slot per saving command. */
  heap: HeapSlot[];
  usesSorry: boolean;
  /** Number of Hyp commands. */
  hyps: number;
  /** Number of Dummy commands. */
  dummies: number;
  /** Problems on any command span. */
  problems: Problem[];
  /** True when the stream ends with END exactly at the statement boundary. */
  wellTerminated: boolean;
}

// ---------------------------------------------------------------------------
// Unify expressions

export type UExpr =
  | { kind: "var"; index: number; name: string }
  | { kind: "dummy"; index: number; name: string; sort: number }
  | { kind: "app"; term: number; name: string; args: UExpr[]; heapIndex?: number }
  /** A URef to a saved subterm (not a variable): rendered structurally, but sharing is recorded. */
  | { kind: "ref"; index: number; to: UExpr }
  | { kind: "error"; message: string };

export interface UnifyDisassembly {
  owner: DeclRef;
  cmds: DecodedCmd[];
  /** The def's value. */
  value?: UExpr;
  /** The theorem's conclusion. */
  concl?: UExpr;
  /** Hypotheses in Hyp order (the stream stores them last-first). */
  hyps: UExpr[];
  /** Heap after decoding: variables, then saved subterms and dummies. */
  heap: HeapSlot[];
  dummies: { index: number; name: string; sort: number }[];
  problems: Problem[];
}

/** Print an expression in s-expression style, outermost parentheses omitted. */
export function showExpr(e: UExpr): string {
  return show(e, true);
}

function show(e: UExpr, top: boolean): string {
  switch (e.kind) {
    case "var":
    case "dummy":
      return e.name;
    case "ref":
      return show(e.to, top);
    case "error":
      return `⟨${e.message}⟩`;
    case "app": {
      if (e.args.length === 0) return e.name;
      const inner = `${e.name} ${e.args.map((a) => show(a, false)).join(" ")}`;
      return top ? inner : `(${inner})`;
    }
  }
}

/** Size of an expression in nodes, for deciding how to lay it out. */
export function exprSize(e: UExpr): number {
  switch (e.kind) {
    case "app":
      return 1 + e.args.reduce((n, a) => n + exprSize(a), 0);
    case "ref":
      return exprSize(e.to);
    default:
      return 1;
  }
}

// ---------------------------------------------------------------------------

/** Variable name for argument i of a declaration, with a deterministic fallback. */
export function varName(names: (string | undefined)[] | undefined, i: number): string {
  const n = names?.[i];
  return n && n !== "_" ? n : `v${i}`;
}

/** Name for the j-th dummy of a declaration with `numArgs` arguments. */
export function dummyName(names: (string | undefined)[] | undefined, numArgs: number, j: number): string {
  const n = names?.[numArgs + j];
  return n && n !== "_" ? n : `d${j}`;
}

export function hypName(names: (string | undefined)[] | undefined, k: number): string {
  const n = names?.[k];
  return n && n !== "_" ? n : `h${k + 1}`;
}

function baseCmd(L: Layout, span: Span, index: number, ops: Record<number, OpInfo>): DecodedCmd {
  const c = span.value as Cmd;
  const info = ops[c.op];
  const argKind: ArgKind = info ? info.arg : "unknown";
  const out: DecodedCmd = {
    index,
    offset: c.offset,
    size: c.size,
    op: c.op,
    data: c.data,
    dataBytes: c.dataBytes,
    mnemonic: info ? info.name : `?0x${c.op.toString(16).padStart(2, "0")}`,
    argKind,
    problems: span.problems ?? [],
    span,
    target: span.target,
  };
  if (argKind !== "none" && (c.dataBytes > 0 || argKind !== "unknown")) out.operand = String(c.data);
  if (argKind === "none" && c.data !== 0) out.operand = String(c.data);
  switch (argKind) {
    case "term":
      out.note = L.terms[c.data] ? declName(L, { kind: "term", id: c.data }) : "no such term";
      break;
    case "thm":
      out.note = L.thms[c.data] ? declName(L, { kind: "thm", id: c.data }) : "no such theorem";
      break;
    case "sort":
      out.note = L.sorts[c.data] ? declName(L, { kind: "sort", id: c.data }) : "no such sort";
      break;
  }
  return out;
}

/** The decoded command spans of a stream span (unify stream or proof body). */
function cmdSpans(stream: Span): Span[] {
  return childrenOf(stream).filter((s) => s.kind === "unify.cmd" || s.kind === "proof.cmd");
}

// ---------------------------------------------------------------------------
// Proof streams

/** Number of hypotheses a theorem's unify stream declares (its UHyp count). */
export function hypCount(L: Layout, thm: Thm): number {
  if (!thm.unifySpan) return 0;
  let n = 0;
  for (const s of cmdSpans(thm.unifySpan)) if ((s.value as Cmd).op === 0x36) n++;
  return n;
}

export function disassembleProof(L: Layout, stmt: Statement): ProofDisassembly | undefined {
  const body = childrenOf(stmt.span).find((s) => s.kind === "proof.body");
  const decl = stmt.decl;
  if (!body || !decl) return undefined;
  const d = decl.kind === "term" ? L.terms[decl.id] : decl.kind === "thm" ? L.thms[decl.id] : undefined;
  const numArgs = d?.numArgs ?? 0;
  const varNames = d?.varNames;
  const hypNames = decl.kind === "thm" ? L.thms[decl.id]?.hypNames : undefined;

  const heap: HeapSlot[] = [];
  for (let i = 0; i < numArgs; i++) heap.push({ index: i, kind: "var", name: varName(varNames, i) });

  const cmds: DecodedCmd[] = [];
  const problems: Problem[] = [];
  let usesSorry = false;
  let hyps = 0;
  let dummies = 0;
  let sawEnd = false;
  const spans = cmdSpans(body);
  spans.forEach((span, index) => {
    const c = baseCmd(L, span, index, PROOF_OPS);
    problems.push(...c.problems);
    const push = (kind: HeapKind, name: string) => {
      c.heapIndex = heap.length;
      heap.push({ index: heap.length, kind, name, from: c });
    };
    switch (c.op) {
      case 0x00:
        sawEnd = true;
        break;
      case 0x11: // TermSave
        push("expr", `(${c.note ?? "?"} …)`);
        break;
      case 0x12: {
        // Ref
        const slot = heap[c.data];
        c.note = slot ? (slot.kind === "var" || slot.kind === "dummy" ? slot.name : `${slot.name} from #${slot.from?.index ?? "?"}`) : "not on the heap yet";
        if (slot?.from) c.target = slot.from.offset;
        if (!slot) c.problems = [...c.problems, { offset: c.offset, message: `heap index ${c.data} is beyond the ${heap.length} entries the heap has at this point`, severity: "error" }];
        break;
      }
      case 0x13: {
        // Dummy
        const name = dummyName(varNames, numArgs, dummies++);
        c.note = `${name}: ${c.note ?? "?"}`;
        push("dummy", name);
        break;
      }
      case 0x15: // ThmSave
        push("proof", `|- from ${c.note ?? "?"}`);
        break;
      case 0x16: {
        // Hyp
        const name = hypName(hypNames, hyps++);
        c.note = name;
        push("hyp", `|- ${name}`);
        break;
      }
      case 0x1e: // ConvSave
        push("conv", "conversion");
        break;
      case 0x1f: // Save
        push("any", "saved");
        break;
      case 0x20:
        usesSorry = true;
        break;
    }
    cmds.push(c);
  });
  const last = cmds[cmds.length - 1];
  const wellTerminated = sawEnd && !!last && last.op === 0 && last.offset + last.size === stmt.bodyEnd && childrenOf(body).every((s) => s.kind === "proof.cmd");
  return { stmt, cmds, heap, usesSorry, hyps, dummies, problems, wellTerminated };
}

// ---------------------------------------------------------------------------
// Unify streams

export function disassembleUnify(L: Layout, owner: DeclRef): UnifyDisassembly | undefined {
  const d: Term | Thm | undefined = owner.kind === "term" ? L.terms[owner.id] : owner.kind === "thm" ? L.thms[owner.id] : undefined;
  if (!d?.unifySpan) return undefined;
  const isDef = owner.kind === "term";
  const numArgs = d.numArgs;
  const varNames = d.varNames;
  const hypNames = owner.kind === "thm" ? (d as Thm).hypNames : undefined;

  const cmds = cmdSpans(d.unifySpan).map((s, i) => baseCmd(L, s, i, UNIFY_OPS));
  const problems: Problem[] = cmds.flatMap((c) => c.problems);
  const heap: HeapSlot[] = [];
  const hexprs: (UExpr | "pending")[] = [];
  for (let i = 0; i < numArgs; i++) {
    heap.push({ index: i, kind: "var", name: varName(varNames, i) });
    hexprs.push({ kind: "var", index: i, name: varName(varNames, i) });
  }
  const dummies: UnifyDisassembly["dummies"] = [];
  let pos = 0;
  let truncated = false;

  const problem = (c: DecodedCmd | undefined, message: string) => {
    const p: Problem = { offset: c?.offset ?? d.unifySpan!.end, message, severity: "error" };
    problems.push(p);
    if (c) c.problems = [...c.problems, p];
  };

  const parse = (): UExpr => {
    const c = cmds[pos];
    if (!c || c.op === 0) {
      // Reported on the END span by the layout parser's shape check.
      truncated = true;
      return { kind: "error", message: "missing" };
    }
    pos++;
    switch (c.op) {
      case 0x30:
      case 0x31: {
        // UTerm / UTermSave
        const t = L.terms[c.data];
        const name = c.note ?? `t${c.data}`;
        const node: UExpr = { kind: "app", term: c.data, name, args: [] };
        if (c.op === 0x31) {
          node.heapIndex = heap.length;
          c.heapIndex = heap.length;
          heap.push({ index: heap.length, kind: "expr", name: `(${name} …)`, from: c });
          hexprs.push("pending");
        }
        const n = t?.numArgs ?? 0;
        for (let i = 0; i < n; i++) node.args.push(parse());
        if (node.heapIndex !== undefined) hexprs[node.heapIndex] = node;
        return node;
      }
      case 0x32: {
        // URef
        const e = hexprs[c.data];
        const slot = heap[c.data];
        if (e === undefined) {
          problem(c, `heap index ${c.data} is beyond the ${heap.length} entries the unify heap has at this point`);
          c.note = "not on the heap yet";
          return { kind: "error", message: `URef ${c.data}` };
        }
        if (e === "pending") {
          problem(c, `heap entry ${c.data} refers to the term currently being read: a cyclic term, which is not legal`);
          c.note = "cyclic";
          return { kind: "error", message: `cycle via ${c.data}` };
        }
        c.note = slot && (slot.kind === "var" || slot.kind === "dummy") ? slot.name : `${slot?.name ?? "?"} from #${slot?.from?.index ?? "?"}`;
        if (slot?.from) c.target = slot.from.offset;
        return e.kind === "var" || e.kind === "dummy" ? e : { kind: "ref", index: c.data, to: e };
      }
      case 0x33: {
        // UDummy (a UDummy in a theorem is reported by the layout parser)
        const name = dummyName(varNames, numArgs, dummies.length);
        const node: UExpr = { kind: "dummy", index: heap.length, name, sort: c.data };
        c.note = `${name}: ${c.note ?? "?"}`;
        c.heapIndex = heap.length;
        heap.push({ index: heap.length, kind: "dummy", name, from: c });
        hexprs.push(node);
        dummies.push({ index: node.index, name, sort: c.data });
        return node;
      }
      case 0x36:
        // Reported by the layout parser's shape check.
        return { kind: "error", message: "UHyp" };
      default:
        problem(c, `unknown unify opcode ${c.mnemonic}`);
        return { kind: "error", message: c.mnemonic };
    }
  };

  const out: UnifyDisassembly = { owner, cmds, hyps: [], heap, dummies, problems };
  if (cmds.length === 0) {
    problems.push({ offset: d.unifySpan.start, message: "empty unify stream", severity: "error" });
    return out;
  }
  const first = parse();
  if (isDef) out.value = first;
  else out.concl = first;
  const hypsInStreamOrder: UExpr[] = [];
  while (pos < cmds.length && cmds[pos]!.op === 0x36) {
    pos++;
    hypsInStreamOrder.push(parse());
  }
  out.hyps = hypsInStreamOrder.slice().reverse();
  // Name the UHyp commands after the hypothesis each introduces: the stream lists them last-first.
  let k = hypsInStreamOrder.length;
  for (const c of cmds) if (c.op === 0x36) c.note = hypName(hypNames, --k);
  void isDef;
  return out;
}
