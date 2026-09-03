/**
 * Declarations model: sorts, terms, defs, axioms, and theorems as the
 * declarations browser shows them, with MM0-style signatures rendered from
 * the binder tables and the unify streams.
 */

import { declName, type Arg, type Layout, type Statement, type Term, type Thm } from "./layout";
import { SORT_MODIFIERS } from "./opcodes";
import { type DeclRef, type Problem } from "./spans";
import { disassembleUnify, showExpr, varName, type UnifyDisassembly } from "./streams";

export type DeclCategory = "sort" | "term" | "def" | "axiom" | "theorem";

export interface Binder {
  name: string;
  sort: number;
  sortName: string;
  bound: boolean;
  /** Names of the bound variables this binder depends on. */
  deps: string[];
  arg: Arg;
}

export interface DeclSummary {
  ref: DeclRef;
  id: number;
  name: string;
  category: DeclCategory;
  /** Declared with LocalDef / LocalThm (no MM0 counterpart). */
  local: boolean;
  hasProof: boolean;
  statement?: Statement;
  binders: Binder[];
  /** Return type (terms and defs). */
  ret?: Binder;
  /** MM0-style one-line signature. */
  signature: string;
  unify?: UnifyDisassembly;
  /** Rendered hypotheses (theorems) in Hyp order, with names. */
  hyps: { name: string; text: string }[];
  /** Rendered conclusion (theorems) or value (defs). */
  concl?: string;
  /** Number of bytes in the proof body, or 0. */
  proofBytes: number;
  /** Problems attached to the declaration's own spans (tables, data, unify). */
  problems: Problem[];
  /** Byte offset to select when the declaration is chosen. */
  primaryOffset: number;
}

export function categoryOf(L: Layout, ref: DeclRef): DeclCategory {
  switch (ref.kind) {
    case "sort":
      return "sort";
    case "term":
      return L.terms[ref.id]?.isDef ? "def" : "term";
    case "thm":
      return L.thms[ref.id]?.statement?.opcode === 0x02 ? "axiom" : "theorem";
  }
}

export function sortName(L: Layout, id: number): string {
  return declName(L, { kind: "sort", id });
}

function binders(L: Layout, args: Arg[], names: (string | undefined)[] | undefined): Binder[] {
  const bound: string[] = [];
  const out: Binder[] = [];
  args.forEach((arg, i) => {
    const name = varName(names, i);
    const deps: string[] = [];
    if (!arg.bound) {
      for (let j = 0; j < 55; j++) if ((arg.deps >> BigInt(j)) & 1n) deps.push(bound[j] ?? `bv${j}`);
    }
    out.push({ name, sort: arg.sort, sortName: sortName(L, arg.sort), bound: arg.bound, deps, arg });
    if (arg.bound) bound.push(name);
  });
  return out;
}

/** Group consecutive binders that share sort, boundness, and dependencies: `(a b: wff) {x: nat} (p: wff x)`. */
export function showBinders(bs: Binder[]): string {
  const groups: Binder[][] = [];
  for (const b of bs) {
    const g = groups[groups.length - 1];
    const same = g && g[0]!.sort === b.sort && g[0]!.bound === b.bound && g[0]!.deps.join() === b.deps.join();
    if (same) g.push(b);
    else groups.push([b]);
  }
  return groups
    .map((g) => {
      const names = g.map((b) => b.name).join(" ");
      const type = g[0]!.sortName + (g[0]!.deps.length ? " " + g[0]!.deps.join(" ") : "");
      return g[0]!.bound ? `{${names}: ${type}}` : `(${names}: ${type})`;
    })
    .join(" ");
}

function anonymous(names: (string | undefined)[] | undefined, n: number): boolean {
  for (let i = 0; i < n; i++) {
    const s = names?.[i];
    if (s && s !== "_") return false;
  }
  return true;
}

function firstProblems(...spans: ({ problems?: Problem[] } | undefined)[]): Problem[] {
  return spans.flatMap((s) => s?.problems ?? []);
}

export function summarizeSort(L: Layout, id: number): DeclSummary {
  const s = L.sorts[id]!;
  const name = declName(L, { kind: "sort", id });
  const mods = SORT_MODIFIERS.filter((m) => s.modifiers[m]);
  return {
    ref: { kind: "sort", id },
    id,
    name,
    category: "sort",
    local: false,
    hasProof: false,
    statement: s.statement,
    binders: [],
    signature: `${mods.length ? mods.join(" ") + " " : ""}sort ${name}`,
    hyps: [],
    proofBytes: 0,
    problems: firstProblems(s.span, s.statement?.span),
    primaryOffset: s.span?.start ?? s.statement?.offset ?? 0,
  };
}

export function summarizeTerm(L: Layout, t: Term): DeclSummary {
  const ref: DeclRef = { kind: "term", id: t.id };
  const name = declName(L, ref);
  const bs = binders(L, t.args, t.varNames);
  const ret: Binder | undefined = t.ret ? { name: "", sort: t.ret.sort, sortName: sortName(L, t.ret.sort), bound: false, deps: [], arg: t.ret } : undefined;
  if (ret && t.ret) {
    const bound = bs.filter((b) => b.bound).map((b) => b.name);
    for (let j = 0; j < 55; j++) if ((t.ret.deps >> BigInt(j)) & 1n) ret.deps.push(bound[j] ?? `bv${j}`);
  }
  const retText = ret ? ret.sortName + (ret.deps.length ? " " + ret.deps.join(" ") : "") : sortName(L, t.retSort);
  const keyword = t.isDef ? (t.statement?.local ? "local def" : "def") : "term";
  let signature: string;
  if (!t.isDef && anonymous(t.varNames, t.numArgs) && bs.every((b) => !b.bound && b.deps.length === 0)) {
    signature = `${keyword} ${name}: ${[...bs.map((b) => b.sortName), retText].join(" > ")}`;
  } else {
    signature = `${keyword} ${name}${bs.length ? " " + showBinders(bs) : ""}: ${retText}`;
  }
  const unify = t.isDef ? disassembleUnify(L, ref) : undefined;
  const st = t.statement;
  return {
    ref,
    id: t.id,
    name,
    category: t.isDef ? "def" : "term",
    local: st?.local ?? false,
    hasProof: st?.hasProof ?? t.isDef,
    statement: st,
    binders: bs,
    ret,
    signature,
    unify,
    hyps: [],
    concl: unify?.value ? showExpr(unify.value) : undefined,
    proofBytes: st ? Math.max(0, st.bodyEnd - st.bodyStart) : 0,
    problems: firstProblems(t.entrySpan, ...(t.entrySpan?.children as { problems?: Problem[] }[] | undefined) ?? [], t.dataSpan, ...t.args.map((a) => a.span), t.ret?.span, t.unifySpan, ...(unify ? [{ problems: unify.problems }] : [])),
    primaryOffset: t.entrySpan?.start ?? st?.offset ?? 0,
  };
}

export function summarizeThm(L: Layout, t: Thm): DeclSummary {
  const ref: DeclRef = { kind: "thm", id: t.id };
  const name = declName(L, ref);
  const bs = binders(L, t.args, t.varNames);
  const st = t.statement;
  const category: DeclCategory = st?.opcode === 0x02 ? "axiom" : "theorem";
  const keyword = category === "axiom" ? "axiom" : st?.local ? "local theorem" : "theorem";
  const unify = disassembleUnify(L, ref);
  const hyps = (unify?.hyps ?? []).map((h, k) => ({ name: hypNameOf(t, k), text: showExpr(h) }));
  return {
    ref,
    id: t.id,
    name,
    category,
    local: st?.local ?? false,
    hasProof: st?.hasProof ?? true,
    statement: st,
    binders: bs,
    signature: `${keyword} ${name}${bs.length ? " " + showBinders(bs) : ""}`,
    unify,
    hyps,
    concl: unify?.concl ? showExpr(unify.concl) : undefined,
    proofBytes: st ? Math.max(0, st.bodyEnd - st.bodyStart) : 0,
    problems: firstProblems(t.entrySpan, ...(t.entrySpan?.children as { problems?: Problem[] }[] | undefined) ?? [], t.dataSpan, ...t.args.map((a) => a.span), t.unifySpan, ...(unify ? [{ problems: unify.problems }] : [])),
    primaryOffset: t.entrySpan?.start ?? st?.offset ?? 0,
  };
}

function hypNameOf(t: Thm, k: number): string {
  const n = t.hypNames?.[k];
  return n && n !== "_" ? n : `h${k + 1}`;
}

export function summarize(L: Layout, ref: DeclRef): DeclSummary | undefined {
  switch (ref.kind) {
    case "sort":
      return L.sorts[ref.id] ? summarizeSort(L, ref.id) : undefined;
    case "term": {
      const t = L.terms[ref.id];
      return t?.entrySpan ? summarizeTerm(L, t) : undefined;
    }
    case "thm": {
      const t = L.thms[ref.id];
      return t?.entrySpan ? summarizeThm(L, t) : undefined;
    }
  }
}

/** Every declaration in declaration order (sorts, then terms, then theorems). */
export function allDecls(L: Layout): DeclSummary[] {
  const out: DeclSummary[] = [];
  L.sorts.forEach((s, i) => s.span && out.push(summarizeSort(L, i)));
  for (const t of L.terms) if (t.entrySpan) out.push(summarizeTerm(L, t));
  for (const t of L.thms) if (t.entrySpan) out.push(summarizeThm(L, t));
  return out;
}

/** The full multi-line statement of a declaration, MM0 style. */
export function showStatement(d: DeclSummary): string {
  const lines = [d.signature];
  if (d.category === "def" && d.concl !== undefined) lines[0] += ` = ${d.concl}`;
  for (const h of d.hyps) lines.push(`  (${h.name}: $ ${h.text} $)`);
  if ((d.category === "axiom" || d.category === "theorem") && d.concl !== undefined) lines.push(`  ${d.hyps.length ? ">" : ":"} $ ${d.concl} $`);
  return lines.join("\n");
}
