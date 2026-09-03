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

Milestones M0 and M1 are done:

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
  decoding of proof bodies), structure tree, and inspector;
- bundled examples, including seven fail-case files generated from the
  tutorial by `scripts/make-mutants.mjs` (each exercises one problem, and
  the tests regenerate them to check they match).

Keyboard: `[` and `]` toggle the structure tree and inspector panes (they
start hidden on narrow viewports); `d` switches the left pane between the
structure tree and the declarations browser; Alt+Left goes back after
following a pointer.

Next (M2): the steppable verifier and debugger.

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
src/ui/       Solid.js components and styling
public/examples/  bundled .mmb files and their manifest
scripts/      mutants.mjs (fail-case patch table), make-mutants.mjs
spec/mmb.md   vendored MMB spec
tests/        vitest
```
