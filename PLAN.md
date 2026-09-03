# mmb-viz: a visual explainer and debugger for MMB files

A static website. Drop a `.mmb` file into the browser and get:

1. An annotated hexdump of the whole file, every byte colored by role and
   explained.
2. A steppable verification: run the MMB stack machine one command at a
   time, watch the stacks and heaps change, read a narrative of each step,
   and see which bytes each step consumed.
3. Breakpoints, time travel, an error explorer, and a companion view of the
   relevant spec section.

Scope: everything defined by `mm0-c/mmb.md` (the MMB spec). The MM0
cross-check (`.mm0` file matching) is outside the MMB spec and is not planned
for v1.

Reference material: `~/Projects/mm0/mm0-c/mmb.md` (spec),
`~/Projects/Aufbau/src/trusted/` (verifier.zig, mmb.zig, proof.zig),
`~/Projects/mm0/mm0-c/verifier.c`, and sample files under
`~/Projects/mm0/examples/` and `~/Projects/mm0/tests/mmb/`.

---

## 1. Key decisions (with recommendations)

### 1.1 Browser-native TypeScript verifier, Aufbau as oracle

Decided (2026-09-03): reimplement the parser and stack machine in TypeScript,
designed from the start for instrumentation (explicit state, `step()`,
snapshots, byte provenance on every value).

Why not instrument the Zig/wasm verifier: Aufbau's wasm exposes only a
whole-file `verify_pair`. Stepping, breakpoints, and "which bytes did this
step read" need hooks at every command and at every internal check. Adding
that to the trusted core would either bloat the auditable kernel or require a
serialized trace of every state, which is heavy and awkward to time-travel.
The spec is about 500 lines and Aufbau's verifier is about 1000 lines of Zig,
so a TS port is a bounded job.

Aufbau stays in the picture as the oracle: tests run both verifiers over a
corpus and require agreement on accept/reject (and, for failures, on the
failing statement).

### 1.2 Stack

- Vite + TypeScript, no server, deployed to GitHub Pages (same as Aufbau's
  manual).
- UI: Solid.js. Fine-grained reactivity suits a debugger where each step
  changes a few cells among thousands. Alternatives: Preact + signals, or
  vanilla TS with import maps to match Aufbau's web demo. See open decision
  in section 8.
- Web Worker for whole-file runs (run to end, find first error, build the
  cross-reference index). The per-statement stepper runs on the main thread;
  a single statement's proof is small.
- Tests: Vitest for unit and corpus tests. Playwright optional later.

### 1.3 Expression identity is visible

MMB equality is pointer equality (`Refl`, `URef`). The UI shows every
allocated expression with a stable node id (`#42`) and renders sharing
explicitly. Two structurally equal but distinct terms look different on
screen. This is one of the main things the tool should teach.

### 1.4 Time travel by re-execution

Statements are verified independently (state resets per statement). The
state at step k of statement s is obtained by re-running statement s for k
steps. That makes "step back" trivial and avoids storing snapshots. A small
cache of snapshots every N steps keeps long proofs responsive.

---

## 2. Core data model (`src/core/`, pure TS, no DOM)

### 2.1 Span tree: every byte has an owner

The annotating parser produces a tree of spans over the file:

```ts
interface Span {
  start: number; end: number;     // byte range [start, end)
  kind: SpanKind;                 // 'header.magic' | 'term.entry' | 'proof.cmd' | ...
  label: string;                  // short, for gutters and tooltips
  value?: unknown;                // decoded value (number, string, bitfield struct)
  owner?: DeclRef;                // { kind: 'sort'|'term'|'thm', id }
  target?: number;                // for pointers: the byte offset pointed to
  children?: Span[] | (() => Span[]);  // lazy for large regions
  problems?: Problem[];           // parse-level violations attached here
}
```

Top-level regions: header, sort table, term table, term data (args, unify
streams), theorem table, theorem data, proof stream (statements, commands),
index (entry list, Name table, VarN table, HypN table, string lists,
strings), padding, and any unaccounted bytes (labeled as such, never
silent).

Invariant, checked by tests: the leaves of the span tree partition the
file exactly. No gaps, no overlaps.

Two-level laziness: regions and table entries are eager; per-command spans
inside a stream are decoded on demand (when scrolled into view, selected,
or reached by the stepper). An offset-to-span lookup (binary search over
region starts, then decode within) drives hexdump coloring for visible rows
only.

Bit-level spans: `arg` (deps bitmap of 55 bits, reserved bit, sort, bound),
`term.ret_sort` (u7 + is_def), the sort modifier byte, and the `(cmd, data)`
prefix byte (2-bit length tag + 6-bit opcode). These get a bit-view widget.

### 2.2 Declarations model

```ts
interface Sort { id; modifiers: { pure, strict, provable, free }; span }
interface Term { id; numArgs; retSort; isDef; args: Arg[]; ret: Arg; unify?: UnifyStream; name?; varNames?; span }
interface Thm  { id; numArgs; args: Arg[]; unify: UnifyStream; name?; varNames?; hypNames?; span }
interface Arg  { deps: bigint /* 55 bits */; sort; bound; span }
```

Names come from the index when present. Fallback names are deterministic
(`s0`, `t12`, `T340`, `x3`, `h1`). The `HypN` magic in the spec table is a
typo (it repeats VarN's value); we match on the actual 4-byte string.

### 2.3 Stream disassembly

A unify stream or proof stream decodes into a list of
`{ offset, size, opcode, data, mnemonic, argKind }` records. Proof streams
also decode the statement layer (`Sort`, `Term/Def`, `LocalDef`, `Axiom`,
`Thm`, `LocalThm`, `END`) with the relative-length pointer and the running
sort/term/thm counters. Malformed streams (unknown opcode, truncated
command, `END` too close to end of file) are recorded as problems, not
exceptions, so the hexdump still renders.

### 2.4 The machine

```ts
interface MachineState {
  stmt: StatementRef;              // which statement we are inside
  pc: number;                      // byte offset of next command
  stack: StackEntry[];             // expr | proof | conv | convObligation
  heap: HeapEntry[];               // expr | proof | conv
  hyps: ExprId[];
  nextBv: number;
  counters: { sorts, terms, thms }; // "available" counts for forward-ref checks
  unify?: UnifyFrame;              // present while inside Thm/Unfold/Def unification
  arena: Expr[];                   // node id -> { kind, sort, bound, deps, term, args }
  sorryUsed: boolean;
}
interface UnifyFrame { stream; pc; ustack: ExprId[]; uheap: ExprId[]; reason: 'thm'|'unfold'|'def'; }
```

`step(state): StepRecord` executes one command (or one unify command when a
unify frame is active) and returns:

```ts
interface StepRecord {
  cmd: DecodedCmd;                 // with byte span
  reads: Span[];                   // bytes consulted: the cmd, term/thm table entry, args, unify stream
  checks: Check[];                 // { name, spec anchor, passed, detail }
  effects: Effect[];               // pushes/pops/allocations, for diff highlighting
  narrative: string;               // templated prose
  error?: VerifyError;
}
```

Every check in the spec is a named predicate in `checks.ts` with a spec
anchor, so the UI can say "sort(e1) must equal term[t].args[0].sort
(Proof Checking, Term)" and the tests can assert that a fail-case file fails
on exactly that check.

Step granularity: a `Thm` or `Unfold` command is one step at the outer level
("step over"), but the user can "step into" the unification and watch
`URef`/`UTerm`/`UHyp` operate on the unify stack and heap. `Def` statements
also run unification (proof stream value vs unify stream), shown the same
way.

Dependency and free-variable sets (`V`, `FV`, `deps` bitmaps) are computed
per expression and shown as named variable sets, since the `Thm` dependency
checks are the hardest part of the spec to understand.

### 2.5 Whole-file driver

`runAll(file, { until })` in a worker: iterates statements, verifies each,
and yields per-statement results (ok, error with StepRecord, timing). Also
builds a cross-reference index: for each term and theorem, which statements
reference it. This backs "find first error", statement-list status icons,
and "who uses this".

---

## 3. UI

Layout: a top bar (file picker, examples, run controls), a left column
(file map + structure tree or statement list, tabbed), a center (hexdump or
debugger, tabbed), and a right column (inspector: explanation, spec section,
selected value).

### 3.1 Loading

Drag and drop, file input, or a bundled example: `peano.mmb` (large,
realistic), the tutorial `03-mm1-intro.mmb` (small), and the fail-case
files from `mm0/tests/mmb` (each demonstrates one error). Files are kept in
memory only.

### 3.2 File map

A proportional bar (or a treemap for the index) showing regions by size and
color. Click to scroll the hexdump. During stepping, a cursor shows where
the pc is.

### 3.3 Hexdump

Virtualized, 16 bytes per row, offsets, hex, ASCII. Background color per
span kind, with alternating shades for adjacent entries of the same kind so
boundaries are visible. Hover shows the span chain (`proof stream >
statement Thm #340 "ax_mp" > cmd Term 12`) and the decoded value. Click
selects a span; the structure tree and inspector follow. Pointers are
clickable and jump to the target with a highlight, and a back button.

A "decoded gutter" mode (like a hex editor's pattern view) shows the parsed
fields beside the bytes, so a term table row reads as
`num_args=2 ret_sort=wff is_def=0 p_data=0x0A48`.

### 3.4 Structure tree

The span tree as a collapsible outline: Header, Sort table, Term table,
Theorem table, Proof stream (statements), Index (tables). Selecting a node
highlights its bytes. Search by name or id.

### 3.5 Declarations browser

Sorts with modifiers. Terms and theorems with signatures rendered from the
arg table (bound vars shown as binders, dependencies shown explicitly),
unify stream disassembly, and, for theorems, the proof stream disassembly.
Filter by name, kind, local/public, has-proof, uses `Sorry`.

### 3.6 Debugger

- Statement list with status (unverified, ok, error, sorry) and a "run all"
  button. Click to open a statement.
- Disassembly of the statement's proof stream with the pc marker,
  breakpoints in the gutter, and the byte offset of each command.
- Panels: main stack, heap, hypotheses, `next_bv`, and (when active) the
  unify stack and unify heap with the unify stream disassembly. Changed
  entries flash on each step.
- Expression view: pretty-printed with names, node id, sort, bound flag,
  and V/FV sets. Hovering a subterm highlights all other occurrences of the
  same node (sharing).
- Controls: step, step into, step over, step out, step back, continue,
  run to error, restart statement. Keyboard shortcuts.
- Breakpoints: at a command, on an opcode kind (every `Unfold`), on a
  statement (by name), on any error, on use of a theorem or term.
- Narrative panel: for the current step, the rule from the spec (before and
  after stack pictures, like the spec's `H; S, e1..en --> ...` notation,
  instantiated with real values), the list of checks with pass/fail, and
  what was read from the file (with links that highlight bytes).
- The hexdump stays linked: the current command's bytes and the table rows
  it consulted are highlighted; clicking a command in the hexdump jumps the
  debugger to that step.

### 3.7 Error explorer

When a statement fails: the failing command, the failed check with its spec
rule, the state at that moment, and a suggested reading of what the file
author probably intended (for the common cases: forward reference, sort
mismatch, missing `Save`, unify mismatch).

### 3.8 Spec companion

The spec is vendored and split by heading. The inspector shows the section
relevant to the current selection (a span kind or an opcode maps to an
anchor). Rendered from markdown at build time.

### 3.9 Extras (in rough priority order)

- Shareable URLs: `#example=peano&stmt=ax_mp&step=17` for bundled files.
- What-if editing: flip a byte or edit a field in the hexdump, re-parse and
  re-verify, and see what breaks. Cheap once parsing is fast, and very
  instructive.
- Statistics: region sizes, opcode histogram, largest proofs, deepest
  stacks, most-used theorems.
- Command encoding widget: show how a `(cmd, data)` prefix byte splits into
  the 2-bit length tag and 6-bit opcode.
- Expression DAG drawing for the current stack (small graph, sharing
  visible as shared nodes).
- Export: trace of a statement as text, or the annotated layout as JSON.
- Oracle mode (dev only): run Aufbau's wasm verifier alongside and compare.

---

## 4. Explanation content

Explanations are data, not scattered strings: a map from span kind and
opcode to a template function producing prose from decoded values. Static
text is adapted from the spec. Dynamic text names the actual term, sort, and
heap indices involved. Keeping them in one module (`core/explain/`) makes
them reviewable against the spec.

Every spec concept must have at least one explanation entry: header fields,
sort modifiers, arg bitfields, the `term`/`def` distinction, unify vs proof
streams (polish vs reverse polish), the statement layer and its relative
pointers, forward-reference rules, each opcode, each stack element kind,
`V`/`FV`, the `END` read-ahead rule, and each index table.

---

## 5. Testing

- Unit tests per decoder and per opcode, written from the spec text.
- Span partition invariant on every corpus file.
- Corpus: `peano.mmb` accepts; each `mm0/tests/mmb` fail case fails on the
  expected check; Aufbau integration examples (compiled with mm0-rs, as
  Aufbau's integration tests already do) accept.
- Oracle agreement: for every corpus file, our accept/reject matches
  Aufbau's native verifier (`mm0-zig`) and, where convenient, `mm0-c`.
- Mutation tests: flip reserved bits, pointers, and opcodes in a good file
  and assert the error lands on the right check. These double as content
  for the what-if feature.
- Performance budget: parse and lay out peano.mmb under 200 ms, run all
  statements under 2 s in the worker, hexdump scroll at 60 fps.

---

## 6. Repository layout

```
mmb-viz/
  package.json  vite.config.ts  tsconfig.json
  public/examples/          bundled .mmb files + a manifest with descriptions
  spec/mmb.md               vendored spec, sliced by heading at build time
  src/core/
    bytes.ts                cursor, little-endian readers, (cmd,data) decoding
    layout.ts               annotating parser -> span tree
    decls.ts                sort/term/thm models, arg bitfields, naming
    streams.ts              unify and proof stream disassembly
    index.ts                debugging index tables
    expr.ts                 arena, node ids, V/FV computation
    checks.ts               every spec check as a named predicate with anchor
    machine.ts              state, step(), unify frames
    driver.ts               run a statement, run all, snapshots, xref
    explain/                templates keyed by span kind and opcode
    problems.ts             parse-level problem records
  src/worker/               whole-file runs off the main thread
  src/ui/                   App, FileMap, HexDump, StructureTree, Declarations,
                            Debugger/*, Inspector, SpecPanel
  tests/                    unit, corpus, oracle
```

---

## 7. Milestones

M0, skeleton (done 2026-09-03): scaffold, load a file, decode header and
tables and index, hexdump with region coloring, file map, structure tree.

M1, complete layout (done 2026-09-03): streams disassembled, every byte
owned, bit views, declarations browser, spec companion, problems surfaced
for malformed files. Span partition test green on the corpus.

M2, machine: stepper with all opcodes and checks, corpus and oracle tests
green. Debugger UI with step/back/continue, stack/heap/hyps panels,
disassembly with pc, byte highlighting linked to the hexdump.

M3, teaching features: step into unification, breakpoints, narrative panel
with instantiated spec rules, expression identity and V/FV display, error
explorer, statement list with run-all status.

M4, polish and publish: shareable URLs, what-if editing, statistics,
keyboard shortcuts, dark mode, accessibility pass, GitHub Pages deploy,
README.

---

## 8. Decisions log

Settled 2026-09-03:

1. Verifier: browser-native TypeScript; Aufbau's native verifier is a test
   oracle only.
2. UI framework: Solid.js.
3. `Sorry`: supported, and `sorry_used` is shown as visible machine state.
   Note the spec sets the flag in both cases (proof of anything, and
   discharging a conversion obligation). Aufbau's `opSorry` only sets it on
   the proof case, so a proof that uses `Sorry` solely to discharge `=?=`
   obligations is accepted by Aufbau as fully verified. Our corpus should
   include a mutation test for exactly that, and the oracle comparison must
   tolerate this known divergence (or Aufbau gets fixed first).
4. MM0 cross-check: not in v1.

Still open: project name and license (directory is `mmb-viz`; Aufbau is
Apache-2.0).
