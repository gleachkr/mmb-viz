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

Milestone M0 is done:

- annotating parser in `src/core/layout.ts` that turns a file into a span tree
  in which every byte has an owner (tested: the leaves partition every corpus
  file exactly, and well-formed files produce no unaccounted bytes);
- decoded header, sort table, term and theorem tables, binder data, inline
  unify streams, the proof stream's statement layer, and the three index
  tables (`Name`, `VarN`, `HypN`);
- proportional file map, virtualized hexdump (16 bytes per row, lazy decoding
  of proof bodies), structure tree, and inspector with spec explanations;
- bundled examples, including two malformed files that exercise error
  tolerance.

Keyboard: `[` and `]` toggle the structure tree and inspector panes (they
start hidden on narrow viewports); Alt+Left goes back after following a
pointer.

Next (M1 and M2): every-byte-owned stream disassembly views, the declarations
browser, then the steppable verifier and debugger.

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
  explain.ts    spec-derived explanations per span kind
src/ui/       Solid.js components and styling
public/examples/  bundled .mmb files and their manifest
spec/mmb.md   vendored MMB spec
tests/        vitest
```
