/**
 * The annotating parser: turns an MMB byte buffer into a span tree in which
 * every byte has an owner, plus decoded declaration tables.
 *
 * The parser never throws on malformed input. Anything the spec forbids is
 * recorded as a Problem on the nearest span (and in `Layout.problems`), and
 * pointers that cannot be followed are simply not followed. Bytes nobody
 * claims become "padding" (all zero) or "unaccounted" spans.
 */

import { Bytes, hex, readCmd, type Cmd } from "./bytes";
import { PROOF_OPS, STATEMENTS, UNIFY_OPS, type StmtInfo } from "./opcodes";
import {
  addProblem,
  type DeclRef,
  type Problem,
  type Span,
  type SpanKind,
} from "./spans";

export const HEADER_SIZE = 40;
export const MAGIC = "MM0B";
export const DEPS_BITS = 55n;
export const DEPS_MASK = (1n << DEPS_BITS) - 1n;

export interface Header {
  magic: string;
  version: number;
  numSorts: number;
  reserved: number;
  numTerms: number;
  numThms: number;
  pTerms: number;
  pThms: number;
  pProof: number;
  reserved2: number;
  pIndex: bigint;
}

export interface SortModifiers {
  pure: boolean;
  strict: boolean;
  provable: boolean;
  free: boolean;
}

export interface Sort {
  id: number;
  raw: number;
  modifiers: SortModifiers;
  span: Span;
  name?: string;
  statement?: Statement;
}

export interface Arg {
  raw: bigint;
  /** 55-bit dependency bitmap over bound variables. */
  deps: bigint;
  reservedBit: boolean;
  sort: number;
  bound: boolean;
  span: Span;
}

export interface Term {
  id: number;
  numArgs: number;
  retSort: number;
  isDef: boolean;
  reserved: number;
  pData: number;
  args: Arg[];
  ret?: Arg;
  pUnify?: number;
  entrySpan: Span;
  dataSpan?: Span;
  unifySpan?: Span;
  name?: string;
  varNames?: (string | undefined)[];
  statement?: Statement;
}

export interface Thm {
  id: number;
  numArgs: number;
  reserved: number;
  pData: number;
  args: Arg[];
  pUnify?: number;
  entrySpan: Span;
  dataSpan?: Span;
  unifySpan?: Span;
  name?: string;
  varNames?: (string | undefined)[];
  hypNames?: (string | undefined)[];
  statement?: Statement;
}

export interface Statement {
  /** Ordinal within the proof stream. */
  index: number;
  offset: number;
  end: number;
  opcode: number;
  info?: StmtInfo;
  decl?: DeclRef;
  local: boolean;
  hasProof: boolean;
  bodyStart: number;
  bodyEnd: number;
  span: Span;
  /**
   * How many sorts, terms, and theorems a reference inside this statement
   * may use: everything declared strictly before it. mm0-c increments its
   * counters only after a statement verifies, so a def or theorem cannot
   * refer to itself.
   */
  avail: Avail;
}

export interface Avail {
  sorts: number;
  terms: number;
  thms: number;
}

export interface IndexEntry {
  type: string;
  data: number;
  ptr: bigint;
  span: Span;
  known: boolean;
}

export interface IndexInfo {
  offset: number;
  numEntries: bigint;
  entries: IndexEntry[];
  span: Span;
  hasNames: boolean;
  hasVarNames: boolean;
  hasHypNames: boolean;
}

export interface Layout {
  bytes: Bytes;
  root: Span;
  header?: Header;
  sorts: Sort[];
  terms: Term[];
  thms: Thm[];
  statements: Statement[];
  proofEnd?: number;
  index?: IndexInfo;
  problems: Problem[];
  /** Bytes per span family, for the file map and statistics. */
  familyBytes: Map<string, number>;
}

/** Deterministic display name for a declaration. */
export function declName(layout: Layout, ref: DeclRef): string {
  switch (ref.kind) {
    case "sort":
      return layout.sorts[ref.id]?.name ?? `s${ref.id}`;
    case "term":
      return layout.terms[ref.id]?.name ?? `t${ref.id}`;
    case "thm":
      return layout.thms[ref.id]?.name ?? `T${ref.id}`;
  }
}

export function parseLayout(buf: Uint8Array): Layout {
  return new Parser(buf).run();
}

// ---------------------------------------------------------------------------

class Parser {
  readonly b: Bytes;
  readonly regions: Span[] = [];
  /** Exact-match reuse of regions reached by several pointers. */
  readonly regionIndex = new Map<string, Span>();
  readonly problems: Problem[] = [];
  readonly layout: Layout;

  constructor(buf: Uint8Array) {
    this.b = new Bytes(buf);
    this.layout = {
      bytes: this.b,
      root: { start: 0, end: buf.length, kind: "file", label: "file" },
      sorts: [],
      terms: [],
      thms: [],
      statements: [],
      problems: this.problems,
      familyBytes: new Map(),
    };
  }

  run(): Layout {
    const header = this.parseHeader();
    if (header) {
      this.layout.header = header;
      this.parseIndex(header);
      this.parseSorts(header);
      this.parseTerms(header);
      this.parseThms(header);
      this.parseProofStream(header);
      this.linkStatements();
    }
    this.assemble();
    return this.layout;
  }

  // -- helpers --------------------------------------------------------------

  problem(offset: number, message: string, severity: Problem["severity"] = "error", span?: Span): void {
    const p = { offset, message, severity };
    this.problems.push(p);
    if (span) addProblem(span, p);
  }

  /**
   * Claim a top-level region. Returns the (possibly pre-existing identical)
   * span, or undefined if the region does not fit in the file.
   */
  claim(span: Span): Span | undefined {
    if (span.start < 0 || span.end > this.b.length || span.end <= span.start) {
      this.problem(
        span.start,
        `${span.label} would occupy [${hex(span.start)}, ${hex(span.end)}) which is outside the ${this.b.length}-byte file`,
      );
      return undefined;
    }
    const key = `${span.kind}:${span.start}:${span.end}`;
    const existing = this.regionIndex.get(key);
    if (existing) return existing;
    this.regionIndex.set(key, span);
    this.regions.push(span);
    return span;
  }

  /** A fixed-size scalar field span. */
  field(start: number, size: number, kind: SpanKind, label: string, value: unknown, extra: Partial<Span> = {}): Span {
    return { start, end: start + size, kind, label, value, ...extra };
  }

  /** Target and jump for an absolute pointer field: the value is the file offset. Null and out-of-range pointers get no jump. */
  absolute(name: string, v: number | bigint): Partial<Span> {
    const n = Number(v);
    if (v === 0n || v === 0 || v > BigInt(this.b.length)) return {};
    return { target: n, jump: { name, how: [{ text: `${hex(n)} = .value, an absolute file offset` }] } };
  }

  /** Convert a u64 pointer to a number, or undefined if it cannot address the file. */
  ptr64(v: bigint, what: string, offset: number, span?: Span): number | undefined {
    if (v > BigInt(this.b.length)) {
      this.problem(offset, `${what} = ${hex(v)} points outside the ${this.b.length}-byte file`, "error", span);
      return undefined;
    }
    return Number(v);
  }

  ptr32(v: number, what: string, offset: number, span?: Span): number | undefined {
    if (v > this.b.length) {
      this.problem(offset, `${what} = ${hex(v)} points outside the ${this.b.length}-byte file`, "error", span);
      return undefined;
    }
    return v;
  }

  checkAlign(offset: number, align: number, what: string, span?: Span): void {
    if (offset % align !== 0) {
      this.problem(offset, `${what} at ${hex(offset)} is not ${align}-byte aligned`, "error", span);
    }
  }

  nameOf(ref: DeclRef): string {
    return declName(this.layout, ref);
  }

  // -- header ---------------------------------------------------------------

  parseHeader(): Header | undefined {
    const b = this.b;
    if (b.length < HEADER_SIZE) {
      this.problem(0, `file is ${b.length} bytes; the header alone is ${HEADER_SIZE} bytes`);
      return undefined;
    }
    const h: Header = {
      magic: b.str4(0),
      version: b.u8(4),
      numSorts: b.u8(5),
      reserved: b.u16(6),
      numTerms: b.u32(8),
      numThms: b.u32(12),
      pTerms: b.u32(16),
      pThms: b.u32(20),
      pProof: b.u32(24),
      reserved2: b.u32(28),
      pIndex: b.u64(32),
    };
    const kids: Span[] = [
      this.field(0, 4, "header.magic", "magic", h.magic),
      this.field(4, 1, "header.version", "version", h.version),
      this.field(5, 1, "header.num_sorts", "num_sorts", h.numSorts),
      this.field(6, 2, "header.reserved", "reserved", h.reserved),
      this.field(8, 4, "header.num_terms", "num_terms", h.numTerms),
      this.field(12, 4, "header.num_thms", "num_thms", h.numThms),
      this.field(16, 4, "header.p_terms", "p_terms", h.pTerms, this.absolute("term table", h.pTerms)),
      this.field(20, 4, "header.p_thms", "p_thms", h.pThms, this.absolute("theorem table", h.pThms)),
      this.field(24, 4, "header.p_proof", "p_proof", h.pProof, this.absolute("proof stream", h.pProof)),
      this.field(28, 4, "header.reserved2", "reserved2", h.reserved2),
      this.field(32, 8, "header.p_index", "p_index", h.pIndex, this.absolute("index", h.pIndex)),
    ];
    const span: Span = { start: 0, end: HEADER_SIZE, kind: "header", label: "header", children: kids };
    this.claim(span);

    if (h.magic !== MAGIC) this.problem(0, `magic is "${h.magic}", expected "${MAGIC}"`, "error", kids[0]);
    if (h.version !== 1) this.problem(4, `version is ${h.version}; this tool understands version 1`, "warning", kids[1]);
    if (h.reserved !== 0) this.problem(6, `reserved field is ${h.reserved}, should be 0`, "error", kids[3]);
    if (h.reserved2 !== 0) this.problem(28, `reserved2 field is ${h.reserved2}, should be 0`, "error", kids[9]);
    return h;
  }

  // -- sort table -----------------------------------------------------------

  parseSorts(h: Header): void {
    if (h.numSorts === 0) return;
    const start = HEADER_SIZE;
    const kids: Span[] = [];
    for (let i = 0; i < h.numSorts; i++) {
      const o = start + i;
      if (o >= this.b.length) break;
      const raw = this.b.u8(o);
      const modifiers: SortModifiers = {
        pure: !!(raw & 1),
        strict: !!(raw & 2),
        provable: !!(raw & 4),
        free: !!(raw & 8),
      };
      const ref: DeclRef = { kind: "sort", id: i };
      const span = this.field(o, 1, "sorts.entry", `sort ${i}: ${this.nameOf(ref)}`, modifiers, { owner: ref });
      if (raw & 0xf0) this.problem(o, `sort ${i} has unused modifier bits set (${hex(raw)})`, "error", span);
      kids.push(span);
      this.layout.sorts[i] = { id: i, raw, modifiers, span, name: this.layout.sorts[i]?.name };
    }
    const span: Span = { start, end: start + kids.length, kind: "sorts", label: "sort table", children: kids };
    this.claim(span);
  }

  // -- term table -----------------------------------------------------------

  parseTerms(h: Header): void {
    if (h.numTerms === 0) return;
    const start = h.pTerms;
    const size = 8 * h.numTerms;
    const table: Span = { start, end: start + size, kind: "terms", label: "term table", children: [] };
    if (!this.claim(table)) return;
    this.checkAlign(start, 8, "term table", table);
    if (start < HEADER_SIZE + h.numSorts) this.problem(start, "term table overlaps the header or sort table", "error", table);
    const kids = table.children as Span[];

    for (let i = 0; i < h.numTerms; i++) {
      const o = start + 8 * i;
      const numArgs = this.b.u16(o);
      const retByte = this.b.u8(o + 2);
      const reserved = this.b.u8(o + 3);
      const pData = this.b.u32(o + 4);
      const ref: DeclRef = { kind: "term", id: i };
      const isDef = !!(retByte & 0x80);
      const retSort = retByte & 0x7f;
      const name = this.nameOf(ref);
      const fields: Span[] = [
        this.field(o, 2, "terms.num_args", "num_args", numArgs, { owner: ref }),
        this.field(o + 2, 1, "terms.ret_sort", "ret_sort / is_def", { sort: retSort, isDef }, { owner: ref }),
        this.field(o + 3, 1, "terms.reserved", "reserved", reserved, { owner: ref }),
        this.field(o + 4, 4, "terms.p_data", "p_data", pData, { owner: ref, ...this.absolute("binder data", pData) }),
      ];
      const entry: Span = {
        start: o,
        end: o + 8,
        kind: "terms.entry",
        label: `${isDef ? "def" : "term"} ${i}: ${name}`,
        owner: ref,
        children: fields,
      };
      kids.push(entry);
      if (reserved !== 0) this.problem(o + 3, `term ${i} reserved byte is ${reserved}, should be 0`, "error", fields[2]);
      if (retSort >= h.numSorts) this.problem(o + 2, `term ${i} return sort ${retSort} is out of range (num_sorts = ${h.numSorts})`, "error", fields[1]);

      const term: Term = {
        id: i,
        numArgs,
        retSort,
        isDef,
        reserved,
        pData,
        args: [],
        entrySpan: entry,
        name: this.layout.terms[i]?.name,
        varNames: this.layout.terms[i]?.varNames,
      };
      this.layout.terms[i] = term;
      this.parseTermData(h, term, fields[3]!);
    }
  }

  parseTermData(h: Header, term: Term, ptrSpan: Span): void {
    const ref: DeclRef = { kind: "term", id: term.id };
    const start = this.ptr32(term.pData, `term ${term.id} p_data`, ptrSpan.start, ptrSpan);
    if (start === undefined) return;
    const fixed = 8 * term.numArgs + 8;
    if (!this.b.has(start, fixed)) {
      this.problem(start, `term ${term.id} data (${fixed} bytes) runs past the end of the file`, "error", ptrSpan);
      return;
    }
    // The unify stream (defs only) follows the binders inline.
    const unify = term.isDef ? this.scanUnifyStream(start + fixed, ref) : undefined;
    const kids: Span[] = [];
    const data: Span = {
      start,
      end: unify ? unify.end : start + fixed,
      kind: "termdata",
      label: `${term.isDef ? "def" : "term"} ${term.id} data: ${this.nameOf(ref)}`,
      owner: ref,
      children: kids,
    };
    const claimed = this.claim(data);
    if (!claimed) return;
    if (claimed !== data) {
      // Another term points at exactly this block. Reuse its spans.
      term.dataSpan = claimed;
      return;
    }
    term.dataSpan = data;
    this.checkAlign(start, 8, `term ${term.id} data`, data);
    for (let i = 0; i < term.numArgs; i++) {
      const arg = this.parseArg(start + 8 * i, "termdata.arg", `arg ${i}`, ref, h, term.varNames?.[i]);
      term.args.push(arg);
      kids.push(arg.span);
    }
    const ret = this.parseArg(start + 8 * term.numArgs, "termdata.ret", "ret", ref, h);
    term.ret = ret;
    kids.push(ret.span);
    if (ret.bound) this.problem(ret.span.start, `term ${term.id} return type has bound = 1; ret does not use bound`, "error", ret.span);
    if (ret.sort !== term.retSort) {
      this.problem(ret.span.start, `term ${term.id} ret.sort = ${ret.sort} disagrees with ret_sort = ${term.retSort} in the term table`, "error", ret.span);
    }
    this.checkArgDeps(term.args, ref);
    if (unify) {
      term.pUnify = unify.start;
      term.unifySpan = unify.span;
      kids.push(unify.span);
      if (unify.problem) this.problem(unify.start, unify.problem, "error", unify.span);
    }
  }

  // -- theorem table --------------------------------------------------------

  parseThms(h: Header): void {
    if (h.numThms === 0) return;
    const start = h.pThms;
    const size = 8 * h.numThms;
    const table: Span = { start, end: start + size, kind: "thms", label: "theorem table", children: [] };
    if (!this.claim(table)) return;
    this.checkAlign(start, 8, "theorem table", table);
    const kids = table.children as Span[];

    for (let i = 0; i < h.numThms; i++) {
      const o = start + 8 * i;
      const numArgs = this.b.u16(o);
      const reserved = this.b.u16(o + 2);
      const pData = this.b.u32(o + 4);
      const ref: DeclRef = { kind: "thm", id: i };
      const name = this.nameOf(ref);
      const fields: Span[] = [
        this.field(o, 2, "thms.num_args", "num_args", numArgs, { owner: ref }),
        this.field(o + 2, 2, "thms.reserved", "reserved", reserved, { owner: ref }),
        this.field(o + 4, 4, "thms.p_data", "p_data", pData, { owner: ref, ...this.absolute("binder data", pData) }),
      ];
      const entry: Span = {
        start: o,
        end: o + 8,
        kind: "thms.entry",
        label: `thm ${i}: ${name}`,
        owner: ref,
        children: fields,
      };
      kids.push(entry);
      if (reserved !== 0) this.problem(o + 2, `theorem ${i} reserved field is ${reserved}, should be 0`, "error", fields[1]);

      const thm: Thm = {
        id: i,
        numArgs,
        reserved,
        pData,
        args: [],
        entrySpan: entry,
        name: this.layout.thms[i]?.name,
        varNames: this.layout.thms[i]?.varNames,
        hypNames: this.layout.thms[i]?.hypNames,
      };
      this.layout.thms[i] = thm;
      this.parseThmData(h, thm, fields[2]!);
    }
  }

  parseThmData(h: Header, thm: Thm, ptrSpan: Span): void {
    const ref: DeclRef = { kind: "thm", id: thm.id };
    const start = this.ptr32(thm.pData, `theorem ${thm.id} p_data`, ptrSpan.start, ptrSpan);
    if (start === undefined) return;
    const fixed = 8 * thm.numArgs;
    if (!this.b.has(start, fixed)) {
      this.problem(start, `theorem ${thm.id} data (${fixed} bytes) runs past the end of the file`, "error", ptrSpan);
      return;
    }
    const unify = this.scanUnifyStream(start + fixed, ref);
    const kids: Span[] = [];
    const data: Span = {
      start,
      end: unify ? unify.end : start + fixed,
      kind: "thmdata",
      label: `thm ${thm.id} data: ${this.nameOf(ref)}`,
      owner: ref,
      children: kids,
    };
    if (data.end === data.start) {
      // No args and no readable unify stream: nothing to claim.
      this.problem(start, `theorem ${thm.id} has no readable data at ${hex(start)}`, "error", ptrSpan);
      return;
    }
    const claimed = this.claim(data);
    if (!claimed) return;
    if (claimed !== data) {
      thm.dataSpan = claimed;
      return;
    }
    thm.dataSpan = data;
    this.checkAlign(start, 8, `theorem ${thm.id} data`, data);
    for (let i = 0; i < thm.numArgs; i++) {
      const arg = this.parseArg(start + 8 * i, "thmdata.arg", `arg ${i}`, ref, h, thm.varNames?.[i]);
      thm.args.push(arg);
      kids.push(arg.span);
    }
    this.checkArgDeps(thm.args, ref);
    if (unify) {
      thm.pUnify = unify.start;
      thm.unifySpan = unify.span;
      kids.push(unify.span);
      if (unify.problem) this.problem(unify.start, unify.problem, "error", unify.span);
    }
  }

  // -- args -----------------------------------------------------------------

  parseArg(o: number, kind: SpanKind, label: string, owner: DeclRef, h: Header, varName?: string): Arg {
    const raw = this.b.u64(o);
    const deps = raw & DEPS_MASK;
    const reservedBit = ((raw >> 55n) & 1n) === 1n;
    const sort = Number((raw >> 56n) & 0x7fn);
    const bound = ((raw >> 63n) & 1n) === 1n;
    const value = { deps, reservedBit, sort, bound };
    const span = this.field(o, 8, kind, varName ? `${label}: ${varName}` : label, value, { owner });
    const arg: Arg = { raw, deps, reservedBit, sort, bound, span };
    if (reservedBit) this.problem(o, `${label} of ${owner.kind} ${owner.id} has the reserved bit 55 set`, "error", span);
    if (sort >= h.numSorts) this.problem(o, `${label} of ${owner.kind} ${owner.id} has sort ${sort}, out of range (num_sorts = ${h.numSorts})`, "error", span);
    return arg;
  }

  /**
   * Spec: the i-th bound variable must have deps = 1 << i (counting bound
   * variables only), and a non-bound variable may only depend on bound
   * variables declared before it.
   */
  checkArgDeps(args: Arg[], owner: DeclRef): void {
    let bv = 0n;
    for (const a of args) {
      if (a.bound) {
        const expected = 1n << bv;
        if (a.deps !== expected) {
          this.problem(a.span.start, `bound ${a.span.label} of ${owner.kind} ${owner.id} has deps ${hex(a.deps)}, expected ${hex(expected)} (bound variables depend only on themselves)`, "error", a.span);
        }
        bv++;
      } else if (a.deps >> bv !== 0n) {
        this.problem(a.span.start, `${a.span.label} of ${owner.kind} ${owner.id} depends on a bound variable declared later`, "error", a.span);
      }
    }
  }

  // -- unify streams --------------------------------------------------------

  /**
   * Find the extent of the unify stream starting at `start` by scanning to
   * END. Commands are decoded lazily. Returns undefined if not even one
   * command can be read.
   */
  scanUnifyStream(start: number, owner: DeclRef): { start: number; end: number; span: Span; problem?: string } | undefined {
    if (start >= this.b.length) return undefined;
    let pos = start;
    let end: number;
    let problem: string | undefined;
    for (;;) {
      const cmd = readCmd(this.b, pos);
      if (!cmd) {
        problem = `unify stream of ${owner.kind} ${owner.id} runs past the end of the file`;
        end = this.b.length;
        break;
      }
      pos += cmd.size;
      if (cmd.op === 0) {
        end = pos;
        if (cmd.offset + 5 > this.b.length) problem = `unify stream END at ${hex(cmd.offset)} is closer than 5 bytes to the end of the file (read-ahead rule)`;
        break;
      }
      if (!UNIFY_OPS[cmd.op]) {
        problem = `unknown unify opcode ${hex(cmd.op)} at ${hex(cmd.offset)}`;
        end = pos;
        break;
      }
    }
    const span: Span = {
      start,
      end,
      kind: "unify",
      label: `unify stream: ${this.nameOf(owner)}`,
      owner,
      children: () => this.checkUnifyShape(this.decodeCmds(start, end, "unify.cmd", owner, UNIFY_OPS, this.availFor(owner)), owner),
    };
    return { start, end, span, problem };
  }

  /**
   * The shape of a unify stream is fixed by the arities of its terms: it is
   * one expression in polish notation, and for theorems each UHyp is
   * followed by one more. Count the expressions still owed and report a
   * stream that ends too early or goes on too long.
   */
  checkUnifyShape(cmds: Span[], owner: DeclRef): Span[] {
    let owed = 1;
    for (const span of cmds) {
      if (span.kind !== "unify.cmd") break;
      const cmd = span.value as Cmd;
      if (cmd.op === 0) {
        if (owed > 0) addProblem(span, { offset: span.start, message: `unify stream ends while ${owed} subexpression${owed === 1 ? " is" : "s are"} still expected (END came too early)`, severity: "error" });
        break;
      }
      if (owed === 0 && cmd.op !== 0x36) {
        addProblem(span, { offset: span.start, message: "the expression is complete but the stream continues (END came too late)", severity: "error" });
        break;
      }
      switch (cmd.op) {
        case 0x30:
        case 0x31:
          owed += (this.layout.terms[cmd.data]?.numArgs ?? 0) - 1;
          break;
        case 0x32:
        case 0x33:
          owed -= 1;
          break;
        case 0x36:
          if (owner.kind === "term") addProblem(span, { offset: span.start, message: "UHyp is only allowed in the unify stream of an axiom or theorem", severity: "error" });
          else if (owed > 0) addProblem(span, { offset: span.start, message: `UHyp arrives while ${owed} subexpression${owed === 1 ? " is" : "s are"} still expected`, severity: "error" });
          owed += 1;
          break;
      }
      if (cmd.op === 0x33 && owner.kind === "thm") addProblem(span, { offset: span.start, message: "UDummy is only allowed in the unify stream of a def", severity: "error" });
    }
    return cmds;
  }

  /** Decode a run of (cmd, data) pairs into leaf spans. */
  /** Declarations visible from inside a term or theorem's own streams. */
  availFor(owner: DeclRef | undefined): Avail | undefined {
    if (!owner) return undefined;
    const d = owner.kind === "term" ? this.layout.terms[owner.id] : owner.kind === "thm" ? this.layout.thms[owner.id] : undefined;
    return d?.statement?.avail;
  }

  decodeCmds(start: number, end: number, kind: SpanKind, owner: DeclRef | undefined, ops: Record<number, { name: string; arg: string }>, avail: Avail | undefined): Span[] {
    const out: Span[] = [];
    let pos = start;
    while (pos < end) {
      const cmd = readCmd(this.b, pos, end);
      if (!cmd) {
        const span: Span = { start: pos, end, kind: "unaccounted", label: "truncated command", owner };
        addProblem(span, { offset: pos, message: "command is truncated", severity: "error" });
        out.push(span);
        pos = end;
        break;
      }
      const info = ops[cmd.op];
      const label = info ? this.cmdLabel(info, cmd) : `unknown opcode ${hex(cmd.op)}`;
      const span: Span = { start: pos, end: pos + cmd.size, kind, label, value: cmd, owner };
      if (!info) addProblem(span, { offset: pos, message: `unknown opcode ${hex(cmd.op)}`, severity: "error" });
      if (info && (info.arg === "term" || info.arg === "thm" || info.arg === "sort")) {
        const d = info.arg === "term" ? this.layout.terms[cmd.data]?.entrySpan : info.arg === "thm" ? this.layout.thms[cmd.data]?.entrySpan : this.layout.sorts[cmd.data]?.span;
        const h = this.layout.header;
        if (d && h) {
          span.target = d.start;
          const data = { text: `.data ${cmd.data}` };
          span.jump =
            info.arg === "term"
              ? { name: "term entry", how: [{ text: `${hex(d.start)} = ` }, { text: `p_terms ${hex(h.pTerms)}`, link: 16 }, { text: " + 8 × " }, data] }
              : info.arg === "thm"
                ? { name: "theorem entry", how: [{ text: `${hex(d.start)} = ` }, { text: `p_thms ${hex(h.pThms)}`, link: 20 }, { text: " + 8 × " }, data] }
                : { name: "sort entry", how: [{ text: `${hex(d.start)} = ` }, { text: `end of header ${hex(HEADER_SIZE)}`, link: 0 }, { text: " + " }, data] };
        }
      }
      if (info) this.checkReference(span, info.arg, cmd, avail);
      out.push(span);
      pos += cmd.size;
      if (cmd.op === 0) break;
    }
    if (pos < end) {
      out.push({ start: pos, end, kind: "unaccounted", label: "bytes after END", owner });
    }
    return out;
  }

  /**
   * A command's operand must name a declaration that exists and was
   * declared before the statement being read (no forward references, and no
   * self-reference). Heap indices are checked by the verifier, not here.
   */
  checkReference(span: Span, arg: string, cmd: Cmd, avail: Avail | undefined): void {
    const h = this.layout.header;
    if (!h) return;
    const total = arg === "term" ? h.numTerms : arg === "thm" ? h.numThms : arg === "sort" ? h.numSorts : -1;
    if (total < 0) return;
    const what = arg === "thm" ? "theorem" : arg;
    if (cmd.data >= total) {
      addProblem(span, { offset: span.start, message: `${what} ${cmd.data} does not exist (the table has ${total})`, severity: "error" });
      return;
    }
    if (!avail) return;
    const limit = arg === "term" ? avail.terms : arg === "thm" ? avail.thms : avail.sorts;
    if (cmd.data >= limit) {
      const self = cmd.data === limit && span.owner?.kind === arg && span.owner.id === cmd.data;
      addProblem(span, {
        offset: span.start,
        message: self
          ? `${what} ${cmd.data} refers to itself; only declarations before this statement may be used`
          : `forward reference: ${what} ${cmd.data} is declared after this statement (only ${limit} ${what}s are available here)`,
        severity: "error",
      });
    }
  }

  cmdLabel(info: { name: string; arg: string }, cmd: Cmd): string {
    switch (info.arg) {
      case "term":
        return `${info.name} ${cmd.data} (${this.nameOf({ kind: "term", id: cmd.data })})`;
      case "thm":
        return `${info.name} ${cmd.data} (${this.nameOf({ kind: "thm", id: cmd.data })})`;
      case "sort":
        return `${info.name} ${cmd.data} (${this.nameOf({ kind: "sort", id: cmd.data })})`;
      case "heap":
        return `${info.name} ${cmd.data}`;
      default:
        return cmd.data !== 0 ? `${info.name} (data ${cmd.data})` : info.name;
    }
  }

  // -- proof stream ---------------------------------------------------------

  parseProofStream(h: Header): void {
    const start = this.ptr32(h.pProof, "p_proof", 24);
    if (start === undefined) return;
    const stmts: Span[] = [];
    const counters = { sort: 0, term: 0, thm: 0 };
    let pos = start;
    let end = start;
    for (let index = 0; ; index++) {
      const cmd = readCmd(this.b, pos);
      if (!cmd) {
        this.problem(pos, "proof stream runs past the end of the file without an END");
        end = this.b.length;
        break;
      }
      if (cmd.op === 0) {
        const endSpan: Span = { start: pos, end: pos + cmd.size, kind: "proof.end", label: "END of proof stream", value: cmd };
        if (pos + 5 > this.b.length) this.problem(pos, "final END is closer than 5 bytes to the end of the file (read-ahead rule)", "error", endSpan);
        stmts.push(endSpan);
        end = pos + cmd.size;
        break;
      }
      const info = STATEMENTS[cmd.op];
      const stmtEnd = pos + cmd.data;
      const stmtSpan: Span = { start: pos, end: Math.min(stmtEnd, this.b.length), kind: "proof.stmt", label: "", children: [] };
      if (!info) {
        this.problem(pos, `unknown statement opcode ${hex(cmd.op)}`, "error", stmtSpan);
        stmtSpan.label = `unknown statement ${hex(cmd.op)}`;
        stmtSpan.end = pos + cmd.size;
        stmtSpan.children = [{ start: pos, end: pos + cmd.size, kind: "proof.stmt_cmd", label: stmtSpan.label, value: cmd }];
        stmts.push(stmtSpan);
        end = pos + cmd.size;
        break;
      }
      if (cmd.data < cmd.size || stmtEnd > this.b.length) {
        this.problem(pos, `statement length ${cmd.data} at ${hex(pos)} is invalid (ends at ${hex(stmtEnd)}, file is ${this.b.length} bytes)`, "error", stmtSpan);
        stmtSpan.end = Math.max(pos + cmd.size, Math.min(stmtEnd, this.b.length));
      }

      // Assign the declaration this statement introduces. References inside
      // it may only use what was declared before (mm0-c counts a statement
      // only after verifying it).
      const avail: Avail = { sorts: counters.sort, terms: counters.term, thms: counters.thm };
      const decl: DeclRef =
        info.decl === "sort"
          ? { kind: "sort", id: counters.sort++ }
          : info.decl === "term"
            ? { kind: "term", id: counters.term++ }
            : { kind: "thm", id: counters.thm++ };
      let hasProof = info.hasProof;
      if (cmd.op === 0x05) hasProof = this.layout.terms[decl.id]?.isDef ?? false;
      const inRange =
        (decl.kind === "sort" && decl.id < h.numSorts) ||
        (decl.kind === "term" && decl.id < h.numTerms) ||
        (decl.kind === "thm" && decl.id < h.numThms);
      if (!inRange) this.problem(pos, `${info.name} statement introduces ${decl.kind} ${decl.id}, beyond the table size`, "error", stmtSpan);
      const name = inRange ? this.nameOf(decl) : `${decl.kind} ${decl.id}`;
      const stmtName = cmd.op === 0x05 ? (hasProof ? "Def" : "Term") : info.name;
      stmtSpan.label = `${stmtName} ${decl.id}: ${name}`;
      stmtSpan.owner = decl;

      const cmdSpan: Span = { start: pos, end: pos + cmd.size, kind: "proof.stmt_cmd", label: `${stmtName} (length ${cmd.data})`, value: cmd, owner: decl, target: stmtEnd, jump: { name: "next statement", how: [{ text: `${hex(stmtEnd)} = start ${hex(pos)} + .data ${hex(cmd.data)}` }] } };
      const kids = stmtSpan.children as Span[];
      kids.push(cmdSpan);
      const bodyStart = pos + cmd.size;
      const bodyEnd = stmtSpan.end;
      if (bodyEnd > bodyStart) {
        const body: Span = {
          start: bodyStart,
          end: bodyEnd,
          kind: "proof.body",
          label: hasProof ? `proof: ${name}` : `unexpected body of ${stmtName} ${decl.id}`,
          owner: decl,
          children: () => this.decodeProofBody(bodyStart, bodyEnd, decl, avail),
        };
        if (!hasProof) this.problem(bodyStart, `${stmtName} statement ${decl.id} has a ${bodyEnd - bodyStart}-byte body but should have none`, "error", body);
        kids.push(body);
      } else if (hasProof) {
        this.problem(pos, `${stmtName} statement ${decl.id} has no proof body`, "error", stmtSpan);
      }
      stmts.push(stmtSpan);
      const stmt: Statement = {
        index,
        offset: pos,
        end: stmtSpan.end,
        opcode: cmd.op,
        info,
        decl,
        local: info.local,
        hasProof,
        bodyStart,
        bodyEnd,
        span: stmtSpan,
        avail,
      };
      this.layout.statements.push(stmt);
      if (stmtSpan.end <= pos) break;
      pos = stmtSpan.end;
    }
    if (counters.sort !== h.numSorts) this.problem(start, `proof stream declares ${counters.sort} sorts but the header says ${h.numSorts}`);
    if (counters.term !== h.numTerms) this.problem(start, `proof stream declares ${counters.term} terms but the header says ${h.numTerms}`);
    if (counters.thm !== h.numThms) this.problem(start, `proof stream declares ${counters.thm} theorems but the header says ${h.numThms}`);
    const span: Span = { start, end, kind: "proof", label: "proof stream", children: stmts };
    this.claim(span);
    this.layout.proofEnd = end;
  }

  decodeProofBody(start: number, end: number, owner: DeclRef, avail: Avail): Span[] {
    const out = this.decodeCmds(start, end, "proof.cmd", owner, PROOF_OPS, avail);
    const last = out[out.length - 1];
    if (!last || last.kind === "unaccounted" || (last.value as Cmd | undefined)?.op !== 0) {
      const target = last ?? out[0];
      if (target) addProblem(target, { offset: end, message: "proof body does not end with END exactly at the statement boundary", severity: "error" });
    }
    return out;
  }

  /** Attach statements to their declarations and check index proof pointers. */
  linkStatements(): void {
    for (const st of this.layout.statements) {
      if (!st.decl) continue;
      const d = st.decl;
      const target = d.kind === "sort" ? this.layout.sorts[d.id] : d.kind === "term" ? this.layout.terms[d.id] : this.layout.thms[d.id];
      if (target) target.statement = st;
    }
  }

  // -- index ----------------------------------------------------------------

  parseIndex(h: Header): void {
    if (h.pIndex === 0n) return;
    const headerSpan = (this.regions[0]!.children as Span[])[10]!;
    const start = this.ptr64(h.pIndex, "p_index", 32, headerSpan);
    if (start === undefined) return;
    if (!this.b.has(start, 8)) {
      this.problem(start, "index is too close to the end of the file to hold num_entries", "error", headerSpan);
      return;
    }
    this.checkAlign(start, 8, "index", headerSpan);
    const numEntries = this.b.u64(start);
    const count = numEntries > 1_000_000n ? 0 : Number(numEntries);
    const kids: Span[] = [this.field(start, 8, "index.num_entries", "num_entries", numEntries)];
    if (count === 0 && numEntries !== 0n) {
      this.problem(start, `index claims ${numEntries} entries, which is implausible`, "error", kids[0]);
    }
    const entries: IndexEntry[] = [];
    let end = start + 8;
    const info: IndexInfo = { offset: start, numEntries, entries, span: undefined as unknown as Span, hasNames: false, hasVarNames: false, hasHypNames: false };
    for (let i = 0; i < count; i++) {
      const o = start + 8 + 16 * i;
      if (!this.b.has(o, 16)) {
        this.problem(o, `index entry ${i} runs past the end of the file`, "error", kids[0]);
        break;
      }
      const type = this.b.str4(o);
      const data = this.b.u32(o + 4);
      const ptr = this.b.u64(o + 8);
      const known = type === "Name" || type === "VarN" || type === "HypN";
      const fields: Span[] = [
        this.field(o, 4, "index.entry_type", "type", type),
        this.field(o + 4, 4, "index.entry_data", "data", data),
        this.field(o + 8, 8, "index.entry_ptr", "ptr", ptr, this.absolute(`"${type}" data`, ptr)),
      ];
      const span: Span = { start: o, end: o + 16, kind: "index.entry", label: `index entry ${i}: "${type}"${known ? "" : " (unknown)"}`, children: fields };
      kids.push(span);
      end = o + 16;
      entries.push({ type, data, ptr, span, known });
      if (!known) this.problem(o, `index entry type "${type}" is not one of Name, VarN, HypN; skipped`, "warning", span);
      if (known && data !== 0) this.problem(o + 4, `index entry "${type}" has data = ${data}, should be 0`, "error", fields[1]);
    }
    const span: Span = { start, end, kind: "index", label: "index", children: kids };
    info.span = span;
    if (!this.claim(span)) return;
    this.layout.index = info;

    for (const e of entries) {
      const target = this.ptr64(e.ptr, `index entry "${e.type}" ptr`, e.span.start + 8, e.span);
      if (target === undefined) continue;
      switch (e.type) {
        case "Name":
          if (info.hasNames) this.problem(e.span.start, "duplicate Name table", "error", e.span);
          else info.hasNames = this.parseNames(h, target, e.span);
          break;
        case "VarN":
          if (info.hasVarNames) this.problem(e.span.start, "duplicate VarN table", "error", e.span);
          else info.hasVarNames = this.parseVarNames(h, target, e.span);
          break;
        case "HypN":
          if (info.hasHypNames) this.problem(e.span.start, "duplicate HypN table", "error", e.span);
          else info.hasHypNames = this.parseHypNames(h, target, e.span);
          break;
      }
    }
  }

  parseNames(h: Header, start: number, entrySpan: Span): boolean {
    const total = h.numSorts + h.numTerms + h.numThms;
    const span: Span = { start, end: start + 16 * total, kind: "names", label: "Name table", children: [] };
    if (!this.claim(span)) return false;
    this.checkAlign(start, 8, "Name table", entrySpan);
    const kids = span.children as Span[];
    const sections: [DeclRef["kind"], number][] = [["sort", h.numSorts], ["term", h.numTerms], ["thm", h.numThms]];
    let o = start;
    for (const [kind, n] of sections) {
      for (let id = 0; id < n; id++, o += 16) {
        const ref: DeclRef = { kind, id };
        const pProof = this.b.u64(o);
        const pName = this.b.u64(o + 8);
        const fields: Span[] = [
          this.field(o, 8, "names.p_proof", "proof", pProof, { owner: ref, ...this.absolute("statement", pProof) }),
          this.field(o + 8, 8, "names.p_name", "name", pName, { owner: ref, ...this.absolute("name string", pName) }),
        ];
        const entry: Span = { start: o, end: o + 16, kind: "names.entry", label: `${kind} ${id} name`, owner: ref, children: fields };
        kids.push(entry);
        const name = pName === 0n ? undefined : this.parseString(pName, `${kind} ${id} name`, fields[1]!, ref);
        if (name !== undefined) {
          entry.label = `${kind} ${id}: ${name}`;
          this.setName(ref, name);
        }
      }
    }
    return true;
  }

  setName(ref: DeclRef, name: string): void {
    const L = this.layout;
    switch (ref.kind) {
      case "sort":
        (L.sorts[ref.id] ??= { id: ref.id, raw: 0, modifiers: { pure: false, strict: false, provable: false, free: false }, span: undefined as unknown as Span }).name = name;
        break;
      case "term":
        (L.terms[ref.id] ??= { id: ref.id, numArgs: 0, retSort: 0, isDef: false, reserved: 0, pData: 0, args: [], entrySpan: undefined as unknown as Span }).name = name;
        break;
      case "thm":
        (L.thms[ref.id] ??= { id: ref.id, numArgs: 0, reserved: 0, pData: 0, args: [], entrySpan: undefined as unknown as Span }).name = name;
        break;
    }
  }

  parseVarNames(h: Header, start: number, entrySpan: Span): boolean {
    const total = h.numTerms + h.numThms;
    const span: Span = { start, end: start + 8 * total, kind: "varnames", label: "VarN table", children: [] };
    if (!this.claim(span)) return false;
    this.checkAlign(start, 8, "VarN table", entrySpan);
    const kids = span.children as Span[];
    let o = start;
    const sections: [DeclRef["kind"], number][] = [["term", h.numTerms], ["thm", h.numThms]];
    for (const [kind, n] of sections) {
      for (let id = 0; id < n; id++, o += 8) {
        const ref: DeclRef = { kind, id };
        const ptr = this.b.u64(o);
        const field = this.field(o, 8, "varnames.ptr", `${kind} ${id} variable names`, ptr, { owner: ref, ...this.absolute("variable names", ptr) });
        kids.push(field);
        if (ptr === 0n) continue;
        const names = this.parseStrList(ptr, `${kind} ${id} variable names`, field, ref);
        if (!names) continue;
        if (kind === "term") {
          this.layout.terms[ref.id] ??= { id: ref.id, numArgs: 0, retSort: 0, isDef: false, reserved: 0, pData: 0, args: [], entrySpan: undefined as unknown as Span };
          this.layout.terms[ref.id]!.varNames = names;
        } else {
          this.layout.thms[ref.id] ??= { id: ref.id, numArgs: 0, reserved: 0, pData: 0, args: [], entrySpan: undefined as unknown as Span };
          this.layout.thms[ref.id]!.varNames = names;
        }
      }
    }
    return true;
  }

  parseHypNames(h: Header, start: number, entrySpan: Span): boolean {
    const span: Span = { start, end: start + 8 * h.numThms, kind: "hypnames", label: "HypN table", children: [] };
    if (!this.claim(span)) return false;
    this.checkAlign(start, 8, "HypN table", entrySpan);
    const kids = span.children as Span[];
    for (let id = 0; id < h.numThms; id++) {
      const o = start + 8 * id;
      const ref: DeclRef = { kind: "thm", id };
      const ptr = this.b.u64(o);
      const field = this.field(o, 8, "hypnames.ptr", `thm ${id} hypothesis names`, ptr, { owner: ref, ...this.absolute("hypothesis names", ptr) });
      kids.push(field);
      if (ptr === 0n) continue;
      const names = this.parseStrList(ptr, `thm ${id} hypothesis names`, field, ref);
      if (!names) continue;
      this.layout.thms[id] ??= { id, numArgs: 0, reserved: 0, pData: 0, args: [], entrySpan: undefined as unknown as Span };
      this.layout.thms[id]!.hypNames = names;
    }
    return true;
  }

  parseStrList(ptr: bigint, what: string, ptrSpan: Span, owner: DeclRef): (string | undefined)[] | undefined {
    const start = this.ptr64(ptr, what, ptrSpan.start, ptrSpan);
    if (start === undefined) return undefined;
    if (!this.b.has(start, 8)) {
      this.problem(start, `${what}: string list is too close to the end of the file`, "error", ptrSpan);
      return undefined;
    }
    const countBig = this.b.u64(start);
    if (countBig > 100_000n) {
      this.problem(start, `${what}: string list claims ${countBig} entries`, "error", ptrSpan);
      return undefined;
    }
    const count = Number(countBig);
    const kids: Span[] = [this.field(start, 8, "strlist.count", "num_strs", countBig, { owner })];
    const span: Span = { start, end: start + 8 + 8 * count, kind: "strlist", label: what, owner, children: kids };
    const claimed = this.claim(span);
    if (!claimed) return undefined;
    this.checkAlign(start, 8, what, ptrSpan);
    const names: (string | undefined)[] = [];
    if (claimed !== span) {
      // Shared list: reconstruct names from the existing spans.
      for (const k of claimed.children as Span[]) {
        if (k.kind === "strlist.ptr") names.push(k.value === 0n ? undefined : this.readString(Number(k.value)));
      }
      return names;
    }
    for (let i = 0; i < count; i++) {
      const o = start + 8 + 8 * i;
      const p = this.b.u64(o);
      const field = this.field(o, 8, "strlist.ptr", `string ${i}`, p, { owner, ...this.absolute("string", p) });
      kids.push(field);
      const s = p === 0n ? undefined : this.parseString(p, `${what} [${i}]`, field, owner);
      if (s !== undefined) field.label = `string ${i}: ${s}`;
      names.push(s);
    }
    return names;
  }

  /** Read a cstr without claiming a region (for shared lists). */
  readString(start: number): string | undefined {
    const len = this.b.cstrLength(start);
    return len < 0 ? undefined : this.b.utf8(start, len);
  }

  parseString(ptr: bigint, what: string, ptrSpan: Span, owner: DeclRef): string | undefined {
    const start = this.ptr64(ptr, what, ptrSpan.start, ptrSpan);
    if (start === undefined) return undefined;
    const len = this.b.cstrLength(start);
    if (len < 0) {
      this.problem(start, `${what}: string is not NUL-terminated before the end of the file`, "error", ptrSpan);
      return undefined;
    }
    const value = this.b.utf8(start, len);
    const span: Span = { start, end: start + len + 1, kind: "string", label: `"${value}"`, value, owner };
    const claimed = this.claim(span);
    if (!claimed) return undefined;
    if (claimed === span) {
      // A trailing NUL is expected; validate UTF-8 by round-tripping.
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(this.b.buf.subarray(start, start + len));
      } catch {
        this.problem(start, `${what}: string is not valid UTF-8`, "error", span);
      }
    }
    return value;
  }

  // -- assembly -------------------------------------------------------------

  /** Sort regions, resolve overlaps, fill gaps, compute family byte counts. */
  assemble(): void {
    const regions = this.regions.slice().sort((a, b) => a.start - b.start || b.end - a.end);
    const kids: Span[] = [];
    let cursor = 0;
    const fill = (from: number, to: number) => {
      if (to <= from) return;
      const zero = this.b.allZero(from, to);
      const span: Span = { start: from, end: to, kind: zero ? "padding" : "unaccounted", label: zero ? `padding (${to - from} bytes)` : `unaccounted (${to - from} bytes)` };
      if (!zero) this.problem(from, `${to - from} bytes at ${hex(from)} are not referenced by any structure`, "warning", span);
      kids.push(span);
    };
    for (const r of regions) {
      if (r.start < cursor) {
        this.problem(r.start, `${r.kind} "${r.label}" [${hex(r.start)}, ${hex(r.end)}) overlaps an earlier structure; not shown in the tree`, "error", r);
        continue;
      }
      fill(cursor, r.start);
      kids.push(r);
      cursor = r.end;
    }
    fill(cursor, this.b.length);
    this.layout.root.children = kids;

    const fam = this.layout.familyBytes;
    for (const k of kids) {
      const f = k.kind.includes(".") ? k.kind.slice(0, k.kind.indexOf(".")) : k.kind;
      fam.set(f, (fam.get(f) ?? 0) + (k.end - k.start));
    }
  }
}
