/**
 * Span tree: every byte of an MMB file has an owner.
 *
 * A span is a half-open byte range [start, end) with a kind, a short label,
 * an optional decoded value, and optional children. Children may be lazy
 * (a thunk) for large regions such as proof bodies, so that the hexdump only
 * pays for what it displays.
 *
 * Spans form a physical tree: children are contained in their parent and are
 * sorted by start offset. Logical relations (a term entry pointing at its
 * data block) are expressed with `target` and `owner`, not with nesting.
 */

export type DeclKind = "sort" | "term" | "thm";

export interface DeclRef {
  kind: DeclKind;
  id: number;
}

export interface Problem {
  offset: number;
  message: string;
  /** "error" means a spec violation; "warning" is suspicious but tolerated. */
  severity: "error" | "warning";
}

/**
 * Span kinds. The prefix before the dot is the region family and drives the
 * hexdump color; the full kind selects the explanation.
 */
export type SpanKind =
  | "file"
  | "header"
  | "header.magic"
  | "header.version"
  | "header.num_sorts"
  | "header.reserved"
  | "header.num_terms"
  | "header.num_thms"
  | "header.p_terms"
  | "header.p_thms"
  | "header.p_proof"
  | "header.reserved2"
  | "header.p_index"
  | "sorts"
  | "sorts.entry"
  | "terms"
  | "terms.entry"
  | "terms.num_args"
  | "terms.ret_sort"
  | "terms.reserved"
  | "terms.p_data"
  | "thms"
  | "thms.entry"
  | "thms.num_args"
  | "thms.reserved"
  | "thms.p_data"
  | "termdata"
  | "termdata.arg"
  | "termdata.ret"
  | "thmdata"
  | "thmdata.arg"
  | "unify"
  | "unify.cmd"
  | "proof"
  | "proof.stmt"
  | "proof.stmt_cmd"
  | "proof.body"
  | "proof.cmd"
  | "proof.end"
  | "index"
  | "index.num_entries"
  | "index.entry"
  | "index.entry_type"
  | "index.entry_data"
  | "index.entry_ptr"
  | "names"
  | "names.entry"
  | "names.p_proof"
  | "names.p_name"
  | "varnames"
  | "varnames.ptr"
  | "hypnames"
  | "hypnames.ptr"
  | "strlist"
  | "strlist.count"
  | "strlist.ptr"
  | "string"
  | "padding"
  | "unaccounted";

export interface Span {
  start: number;
  end: number;
  kind: SpanKind;
  label: string;
  /** Decoded value, when the span is a scalar or small struct. */
  value?: unknown;
  /** Which declaration this span belongs to, if any. */
  owner?: DeclRef;
  /** For pointer fields: the absolute file offset pointed at (0 = null). */
  target?: number;
  /** Physical children, sorted by start, contained in [start, end). */
  children?: Span[] | (() => Span[]);
  problems?: Problem[];
}

export function spanLength(s: Span): number {
  return s.end - s.start;
}

/** Materialize (and memoize) a span's children. */
export function childrenOf(s: Span): Span[] {
  if (s.children === undefined) return [];
  if (typeof s.children === "function") {
    const kids = s.children();
    s.children = kids;
    return kids;
  }
  return s.children;
}

export function hasChildren(s: Span): boolean {
  return s.children !== undefined;
}

/** The region family of a kind: "terms.num_args" -> "terms". */
export function family(kind: SpanKind): string {
  const dot = kind.indexOf(".");
  return dot < 0 ? kind : kind.slice(0, dot);
}

/**
 * Find the chain of spans (root first, leaf last) that contain `offset`.
 * Lazy children are materialized along the path only.
 */
export function spanChainAt(root: Span, offset: number): Span[] {
  const chain: Span[] = [];
  let cur: Span | undefined = root;
  while (cur && offset >= cur.start && offset < cur.end) {
    chain.push(cur);
    const kids = childrenOf(cur);
    cur = kids.length ? binarySearch(kids, offset) : undefined;
  }
  return chain;
}

/** Leaf span containing offset, or undefined if nothing does. */
export function leafAt(root: Span, offset: number): Span | undefined {
  const chain = spanChainAt(root, offset);
  return chain[chain.length - 1];
}

function binarySearch(kids: Span[], offset: number): Span | undefined {
  let lo = 0;
  let hi = kids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = kids[mid]!;
    if (offset < k.start) hi = mid - 1;
    else if (offset >= k.end) lo = mid + 1;
    else return k;
  }
  return undefined;
}

/**
 * Walk every leaf in order, materializing lazy children. Used by tests for
 * the partition invariant and by exports.
 */
export function* leaves(root: Span): Generator<Span> {
  const kids = childrenOf(root);
  if (kids.length === 0) {
    yield root;
    return;
  }
  for (const k of kids) yield* leaves(k);
}

/**
 * Check the structural invariants of a span tree:
 * children are inside their parent, sorted, and non-overlapping, and they
 * partition the parent exactly (no gaps). Returns a list of violations.
 */
export function checkPartition(root: Span): string[] {
  const out: string[] = [];
  const visit = (s: Span) => {
    const kids = childrenOf(s);
    if (kids.length === 0) return;
    let cursor = s.start;
    for (const k of kids) {
      if (k.start !== cursor) {
        out.push(
          `${k.kind} "${k.label}" starts at ${k.start}, expected ${cursor} (parent ${s.kind} "${s.label}")`,
        );
      }
      if (k.end > s.end) {
        out.push(`${k.kind} "${k.label}" ends at ${k.end} past parent end ${s.end}`);
      }
      if (k.end <= k.start) {
        out.push(`${k.kind} "${k.label}" is empty or inverted [${k.start}, ${k.end})`);
      }
      cursor = k.end;
      visit(k);
    }
    if (cursor !== s.end) {
      out.push(`${s.kind} "${s.label}" children end at ${cursor}, expected ${s.end}`);
    }
  };
  visit(root);
  return out;
}

/** Collect all problems in the tree (materializing lazy children). */
export function collectProblems(root: Span): Problem[] {
  const out: Problem[] = [];
  const visit = (s: Span) => {
    if (s.problems) out.push(...s.problems);
    for (const k of childrenOf(s)) visit(k);
  };
  visit(root);
  return out;
}

export function addProblem(s: Span, p: Problem): void {
  (s.problems ??= []).push(p);
}
