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

5. **The 56th bound variable and the reserved bit 55.** The mm0 test file
   `tests/mmb/run/dummy_reserved_bit` is a soundness probe: a def with 56
   dummies whose value unfolds to the 56th, `x55`, which then escapes into
   `axiom seed: $ pred choose $` and lets `theorem bad {x: s}: $ pred x $`
   be proved. Bit 55 is reserved in the file's `arg` fields, but at run time
   mm0-c allocates the 56th dummy with bit 55 and then masks the bit away
   in every dependency check (`TYPE_DEPS_MASK` is 55 bits), so it accepts
   the file. Aufbau caps bound variables at 55 and rejects the 56th `Dummy`
   (`TooManyBoundVars`). This tool allows 56 bound variables, like mm0-c,
   but tracks bit 55 like any other and so rejects the def at the check
   "value's free variables are declared in ret". The oracle test records the
   file as a known divergence.

6. **Self-reference is a forward reference.** mm0-c increments its running
   sort/term/theorem counters only after a statement has been verified
   (`verifier.c`, `g_num_terms++` after the def's proof and `g_num_thms++`
   after the theorem's proof), so a def cannot mention itself in its value
   and a theorem cannot cite itself in its proof. Aufbau (as of 2026-09)
   passes `term_count + 1` and `thm_count + 1` as the available counts to
   `verifyDef` and `verifyThm`, which lets a theorem prove itself by `Thm`
   on its own index. `public/examples/mutant_circular_proof.mmb` is a
   25-byte proof of `a1i` that does exactly that; mm0-c should reject it and
   Aufbau accepts it. This tool follows mm0-c and reports the self-reference
   as a layout problem.

7. **Command encodings need not be minimal.** The `(cmd, data)` length tag
   only says how many data bytes follow; `Ref 0` may be written as `12`,
   `52 00`, `92 00 00`, or `d2 00 00 00 00`. mm0-rs always emits the shortest
   form. The mutant generator uses wider forms to replace a proof body with
   one of exactly the same length without moving anything else in the file.

8. **`Dummy` in a `free` sort.** The spec's `Dummy s` rule only requires
   `!sort[s].strict`; mm0-c and Aufbau also reject `free` sorts (`free`
   means "no dummy variables of this sort" in MM0). The verifier here
   follows the implementations and says so in the check's detail.

9. **`Sorry` on a conversion obligation.** The spec says
   `Sorry: S, e1 =?= e2 -> S`. mm0-c's `CMD_PROOF_SORRY` pops the top and,
   when it is not an expression, requires a *conversion* (`STACK_TYPE_CONV`,
   `e1 = e2`) followed by an expression, which is the layout of `e1 = e2`
   on its stack, not of an obligation. That looks like a slip; this tool
   implements the spec (an obligation is dropped). Files using `Sorry` fail
   verification either way. Aufbau follows the spec too.

10. **`V` versus `FV` in theorem proofs.** The `Thm T` rule in the spec
    writes its disjointness conditions with `FV`, but mm0-c caches one
    dependency set per expression, `V(e)` while proving theorems and
    `FV(e)` while checking def bodies ("`mm0-c` will cache one or the
    other"), and Aufbau does the same. The machine here computes both sets
    for every expression and uses the mode's set in the checks, so the
    debugger can show `V` and `FV` side by side.

11. **Where the running counters are checked.** mm0-c checks
    `term_id < g_num_terms` (the running count) on every `Term` and
    `Thm`, and `sort < g_num_sorts` on binders and `Dummy`, so a forward or
    self reference fails at the command that makes it. The layout parser
    reports the same condition statically (item 6); the machine reports it
    again as the failing check when stepping.
