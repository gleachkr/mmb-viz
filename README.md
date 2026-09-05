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

Milestones M0, M1, and M2 are done:

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
- the debugger (center pane): step, step back, step over and back over a
  unification, run to the end or to the error, a slider, the proof stream
  and (inside a unification) the unify stream with the program counter,
  panels for the stack, heap, hypotheses, unify stack and unify heap with
  changed entries highlighted and node ids visible, and a narrative for
  each step with its checks and the bytes it read; the hexdump and the
  debugger follow each other: stepping selects the command's bytes, and
  selecting a proof or unify command in the hexdump moves the machine to
  the step that executes it (opening the owning statement's proof when
  needed); the declarations browser opens a proof in the debugger from a
  row's ▶ button, or by clicking the row while the debugger is showing;
- tests against mm0-c as an oracle (`tests/oracle.test.ts`): accept/reject
  and the failing statement must agree on the tutorial, its mutants, peano,
  and the mm0 repository's run tests; known divergences are listed there
  and in `SPEC_NOTES.md`;
- bundled examples, including eleven fail-case files generated from the
  tutorial by `scripts/make-mutants.mjs` (each exercises one problem, at the
  layout level or in the verifier, and the tests regenerate them to check
  they match).

Keyboard: `[` and `]` toggle the structure tree and inspector panes (they
start hidden on narrow viewports); `d` switches the left pane between the
structure tree and the declarations browser; `v` switches the center pane
between the hexdump and the debugger; `1`–`4` pick the inspector tab;
Alt+Left goes back after a jump. In the debugger: `.` step, `,` back, `>`
step over a unification, `<` back over one, `r` restart, `e` run to the end.

Next (M3): breakpoints, the narrative panel with instantiated spec rules,
expression identity and V/FV display, and the error explorer.

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
  verify.ts     traces with keyframes, whole-file verification
src/ui/       Solid.js components and styling
public/examples/  bundled .mmb files and their manifest
scripts/      mutants.mjs (fail-case patch table), make-mutants.mjs
spec/mmb.md   vendored MMB spec
tests/        vitest; tests/oracle/tutorial.mm0 is the stub the mm0-c oracle needs
```
