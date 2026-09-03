# Notes on the MMB spec versus real files

Observations made while writing the layout parser, checked against the
mm0-rs exporter (`mm0-rs/src/mmb/export.rs`) and Aufbau's trusted reader
(`src/trusted/terms.zig`, `theorems.zig`). These matter for the explainer
text: the tool should describe what files actually contain.

1. **Unify streams are inline, not pointed to.** The spec lists a
   `unify: p32<unify_stream>` field at the end of `term_data` and `thm_data`.
   No such pointer exists in files produced by mm0-rs. The unify stream
   begins immediately after the last `arg` (after `ret` for defs) and runs to
   its `END` byte. Aufbau computes the stream start as
   `p_data + 8 * (num_args + 1)` for defs and `p_data + 8 * num_args` for
   theorems. The next data block is then 8-byte aligned, so a few zero bytes
   of padding usually follow each stream.

2. **Theorem unify streams put the conclusion first.** The spec's prose says
   the pattern is `UHyp, <h1>, ..., UHyp, <hn>, <concl>`. mm0-rs writes
   `<concl>, UHyp, <hn>, ..., UHyp, <h1>`: conclusion first, then the
   hypotheses in reverse declaration order. This is consistent with the
   stack-machine semantics (the unify stack starts holding the conclusion,
   and each `UHyp` pops the most recently pushed hypothesis proof from the
   main stack), and Aufbau's architecture notes call it out as the least
   obvious control-flow detail in the verifier.

3. **`HypN` magic typo.** The index-table row for `"HypN"` repeats the
   `VarN` value `0x4E726156`. The real value of the four ASCII bytes
   `H y p N` is `0x4E707948`. Match on the string.

4. **`Term` and `Def` share opcode 0x05.** The spec says so; the parser
   decides by the `is_def` bit of the term-table entry with the running term
   index, which means the term table must be parsed before the proof stream.

5. **The reserved bit 55 in `arg` is the 56th bound variable.** The test
   file `dummy_reserved_bit.mmb` has a def with 56 dummies. Its layout is
   fully well-formed; the rejection happens in the verifier when the 56th
   `Dummy` command would need dependency bit 55 (Aufbau: `TooManyBoundVars`).
