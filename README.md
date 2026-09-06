# mmb-viz

A visual explainer and debugger for Metamath Zero binary proof files (`.mmb`),
as a static website. Drop a file into the browser and every byte is colored by
the structure it belongs to, with an inspector that decodes each field and
quotes the relevant part of the MMB spec.

This is a companion to [Aufbau](https://github.com/gleachkr/aufbau), a Zig
MM0/MMB verifier and compiler. The plan for the whole project is in
`PLAN.md`; observations about where real files differ from the spec text are in
`SPEC_NOTES.md`.

## Status

Milestones M0 to M3 are done:

- annotating parser in `src/core/layout.ts` that turns a file into a span
  tree in which every byte has an owner (tested: the leaves partition every
  corpus file exactly, and well-formed files produce no unaccounted bytes);
- decoded header, sort table, term and theorem tables, binder data, inline
  unify streams, the proof stream's statement layer, and the three index
  tables (`Name`, `VarN`, `HypN`);
- stream disassembly (`src/core/streams.ts`): every unify and proof command
  with its operand resolved to a name, a static heap map so each `Ref i`
  points at the command that produced heap entry `i`, and unify streams
  decoded into expressions;
- declarations browser with MM0-style signatures (`term imp: wff > wff >
  wff`, `theorem mpd (a b c: wff)` with hypotheses and conclusion), filters
  by kind, visibility, problems, and use of `Sorry`;
- bit-field diagrams for `arg`, `ret_sort`, sort modifiers, and the
  `(cmd, data)` prefix byte;
- spec companion: the vendored spec rendered by section, with the rule or
  table row for the selected field highlighted;
- static checks beyond structure: forward and self references, unify stream
  shape (too short, too long, `UHyp`/`UDummy` in the wrong kind of stream),
  unknown opcodes, and heap indices used before they exist;
- proportional file map, virtualized hexdump (16 bytes per row, lazy
  decoding of proof bodies), structure tree, and a tabbed inspector
  (Field, Declaration, Spec, Problems);
- the verifier (`src/core/machine.ts`): the MMB stack machine written to be
  watched, with an explicit stack, heap, hypothesis list, `next_bv`, unify
  frames, and an append-only expression arena; every `step()` returns what
  it read, checked, popped, pushed, and allocated, and every check is named
  after the spec's rule with the section it lives in;
- whole-file verification runs in the background as soon as a file loads
  (peano's 583k steps take under a second) and feeds the declarations
  browser (status dots, a "failed" filter), the Problems tab, and the top
  bar;
- the debugger (center pane): the statement being proved in MM0 style
  (foldable to its one-line signature); step, step back, step over and back over a
  unification, run to the end or to the error, a slider, the proof stream
  and (inside a unification) the unify stream with the program counter,
  panels for the stack, heap, hypotheses, unify stack and unify heap with
  changed entries highlighted and node ids visible, and a narrative for
  each step: the spec's rule for the command (`Term t: H; S, e1, ..., en
  --> H; S, (t e1 ... en)`) and the same rule filled in with the entries
  the step actually popped and pushed, then its checks in order, each
  preceded by the bytes it consulted; the hexdump and the
  debugger follow each other: stepping selects the command's bytes, and
  selecting a proof or unify command in the hexdump moves the machine to
  the step that executes it (opening the owning statement's proof when
  needed); the declarations browser opens a proof in the debugger from a
  row's ▶ button, or by clicking the row while the debugger is showing;
  a nodes panel shows the expression arena every entry points into (each
  node's term applied to its argument ids, its sort, V and FV, the step
  that made it, and everything pointing at it), and hovering any `#N`
  anywhere in the debugger lights up every pointer to that node and every
  larger node containing it; clicking pins it;
- the error explorer (`src/core/diagnose.ts`): when a statement fails, the
  debugger opens at the failing step and reads the failure as a kind of
  mistake (forward or self reference, a Ref to a heap entry that was never
  saved, stack underflow or leftovers at END, the wrong kind of stack
  element, equal expressions that are different nodes, a statement that
  disagrees with its proof, sort and disjointness violations, hypothesis
  counts, undecodable bytes, a declaration at odds with its table entry);
  for mismatches it shows the expected and actual expressions side by side
  with the first differing subterm marked (the theorem's conclusion or
  hypothesis under the substitution the arguments fixed, the def's value,
  or the statement the table claims), says what the author probably
  intended, and links the other places involved: the step that built or
  pushed the offending element, the cited declaration, the bytes; the
  Problems tab names each failing statement's diagnosis;
- the location lives in the URL hash
  (`#example=peano.mmb&at=0x40&view=debug&stmt=ax_mp&step=17`): jumps
  (crumbs, links, declaration rows, opening an example) push a browser
  history entry, so the back button and Alt+Left return to the previous
  pane, selection, and debugger step; stepping and plain clicks only update
  the current entry; a URL naming a bundled example reloads that exact
  place, and a reload keeps it (for a dropped file the URL still holds the
  position, but not the file);
- tests against mm0-c as an oracle (`tests/oracle.test.ts`): accept/reject
  and the failing statement must agree on the tutorial, its mutants, peano,
  and the mm0 repository's run tests; known divergences are listed there
  and in `SPEC_NOTES.md`;
- bundled examples, including fifteen fail-case files generated from the
  tutorial by `scripts/make-mutants.mjs` (each exercises one problem, at the
  layout level or in the verifier; the tests regenerate them to check they
  match, and assert the diagnosis the error explorer gives each one).

Keyboard: `[` and `]` toggle the structure tree and inspector panes (they
start hidden on narrow viewports); `d` switches the left pane between the
structure tree and the declarations browser; `v` switches the center pane
between the hexdump and the debugger; `1`–`4` pick the inspector tab;
Alt+Left goes back after a jump (so does the browser's back button). In the debugger: `.` step, `,` back, `>`
step over a unification, `<` back over one, `r` restart, `e` run to the end.

Next (M4): what-if editing, statistics, dark mode, an accessibility pass,
and a GitHub Pages deploy.

## Develop

```bash
npm install
npm run dev        # http://localhost:5173, or add #example=peano.mmb
npm test           # vitest: header decoding, span partition, corpus
npm run typecheck
npm run build      # static site in dist/
```

The corpus tests also walk `~/Projects/mm0/tests` when that checkout exists;
without it they still run over the bundled examples.

## Layout

```
src/core/     pure TypeScript, no DOM
  bytes.ts      little-endian readers, (cmd, data) decoding
  spans.ts      span tree types and invariants
  opcodes.ts    statement, proof, and unify opcode tables
  layout.ts     the annotating parser
  streams.ts    disassembly, static heap map, unify expressions
  decls.ts      declaration summaries and MM0-style signatures
  spec.ts       spec sections and the markdown renderer
  explain.ts    spec-derived explanations per span kind and opcode
  machine.ts    the stack machine: state, step(), checks, snapshots
  rules.ts      the spec's rule per command, instantiated from a step record
  diagnose.ts   the error explorer: kind of mistake, expected vs actual, reading
  verify.ts     traces with keyframes, whole-file verification
src/ui/       Solid.js components and styling
public/examples/  bundled .mmb files and their manifest
scripts/      mutants.mjs (fail-case patch table), make-mutants.mjs
spec/mmb.md   vendored MMB spec
tests/        vitest; tests/oracle/tutorial.mm0 is the stub the mm0-c oracle needs
```
