/**
 * Byte-level mutations of the bundled tutorial file that each exercise one
 * kind of problem the layout parser must report. Shared by the generator
 * (`node scripts/make-mutants.mjs`) and the tests, so the bundled files and
 * the test expectations cannot drift apart.
 *
 * Offsets are specific to public/examples/tutorial.mmb; every patch asserts
 * the bytes it expects to find.
 */

/** @typedef {{ at: number, expect: number[], put: number[] }} Patch */
/**
 * @typedef {{ file: string, title: string, description: string, patches: Patch[], truncate?: number,
 *   expectProblems: string[], expectVerify?: { stmt: number, status: "error" | "sorry", message?: string } }} Mutant
 * `expectProblems` are layout-level; `expectVerify` is what the stack machine must report
 * (statement index, and for errors a fragment of the failing check's message).
 */

// a1i's 25-byte proof body, rewritten to cite a1i itself (theorem 6):
//   Ref 1; Hyp; Ref 2 (|- h); Ref 0; Ref 1; Ref 0; Ref 1; Term 0; Thm 6; END
// with wider encodings of Hyp and Ref 0 so the length is unchanged.
const CIRCULAR_BODY = [0x52, 0x01, 0x96, 0x00, 0x00, 0x52, 0x02, 0xd2, 0, 0, 0, 0, 0x52, 0x01, 0xd2, 0, 0, 0, 0, 0x52, 0x01, 0x10, 0x54, 0x06, 0x00];
const A1I_BODY = [0x52, 0x01, 0x16, 0x52, 0x01, 0x12, 0x52, 0x01, 0x12, 0x52, 0x01, 0x11, 0x10, 0x14, 0x52, 0x02, 0x52, 0x01, 0x52, 0x03, 0x52, 0x03, 0x54, 0x03, 0x00];

// id's 53-byte proof body replaced by: Ref 0; Ref 0; Term 0; Save ×7; Sorry; END,
// with wide encodings so the length is unchanged. Proves `imp a a` by Sorry.
const SORRY_BODY = [0x52, 0x00, 0xd2, 0, 0, 0, 0, 0xd0, 0, 0, 0, 0, ...Array(7).fill([0xdf, 0, 0, 0, 0]).flat(), 0xe0, 0, 0, 0, 0, 0x00];
const ID_BODY = [0x12, 0x12, 0x51, 0x01, 0x12, 0x11, 0x12, 0x12, 0x52, 0x02, 0x12, 0x11, 0x11, 0x12, 0x52, 0x02, 0x11, 0x12, 0x12, 0x11, 0x11, 0x10, 0x54, 0x01, 0x12, 0x52, 0x02, 0x52, 0x04, 0x14, 0x52, 0x04, 0x52, 0x07, 0x52, 0x07, 0x54, 0x03, 0x12, 0x52, 0x01, 0x52, 0x05, 0x14, 0x52, 0x05, 0x52, 0x06, 0x52, 0x06, 0x54, 0x03, 0x00];

// or_right's 30-byte proof body replaced by one that builds `imp b (or a b)` twice, as two
// distinct nodes, admits the second by Sorry, and then tries Refl on e1 =?= e2.
const BUILD = [0x52, 0x01, 0x12, 0x52, 0x01, 0x50, 0x03, 0xd0, 0, 0, 0, 0]; // Ref 1; Ref 0; Ref 1; Term 3 (or); Term 0 (imp)
const REFL_BODY = [...BUILD, ...BUILD, 0xa0, 0, 0, 0x17, 0x18, 0x00]; // ...; Sorry; Conv; Refl; END
const OR_RIGHT_BODY = [0x52, 0x01, 0x12, 0x52, 0x01, 0x51, 0x03, 0x11, 0x52, 0x01, 0x12, 0x51, 0x01, 0x52, 0x01, 0x52, 0x04, 0x52, 0x01, 0x11, 0x10, 0x14, 0x17, 0x1a, 0x18, 0x52, 0x05, 0x1b, 0x18, 0x00];

/** @type {Mutant[]} */
export const MUTANTS = [
  {
    file: "mutant_bad_magic.mmb",
    title: "Fail case: wrong magic",
    description: "The tutorial file with its second magic byte changed. Everything else parses; a verifier rejects it at byte 0.",
    patches: [{ at: 1, expect: [0x4d], put: [0x58] }],
    expectProblems: ['magic is "MX0B"'],
  },
  {
    file: "mutant_reserved_bits.mmb",
    title: "Fail case: reserved bits set",
    description: "Reserved fields that must be zero are set: in the header, in a sort byte, in a term table entry, and bit 55 of an arg.",
    patches: [
      { at: 6, expect: [0x00], put: [0x01] },
      { at: 40, expect: [0x04], put: [0x14] },
      { at: 67, expect: [0x00], put: [0x01] },
      { at: 126, expect: [0x00], put: [0x80] },
    ],
    expectProblems: ["reserved field is 1", "unused modifier bits", "term 2 reserved byte is 1", "reserved bit 55 set"],
  },
  {
    file: "mutant_forward_ref.mmb",
    title: "Fail case: forward reference",
    description: "The proof of mpd (theorem 8) cites theorem 9 (syl), which is declared after it. The layout is intact; the reference is illegal.",
    patches: [{ at: 1100, expect: [0x01], put: [0x09] }],
    expectProblems: ["forward reference: theorem 9"],
  },
  {
    file: "mutant_circular_proof.mmb",
    title: "Fail case: circular proof",
    description: "The proof of a1i (theorem 6) is replaced by one that applies a1i itself. mm0-c rejects the self-reference; Aufbau (as of 2026-09) accepts it.",
    patches: [{ at: 1004, expect: A1I_BODY, put: CIRCULAR_BODY }],
    expectProblems: ["theorem 6 refers to itself"],
  },
  {
    file: "mutant_unify_arity.mmb",
    title: "Fail case: unify stream too long",
    description: "The unify stream of def `and` starts with URef instead of UTerm, so the value is complete after one command and the rest of the stream is unexpected.",
    patches: [{ at: 144, expect: [0x70, 0x01], put: [0x72, 0x01] }],
    expectProblems: ["END came too late"],
  },
  {
    file: "mutant_unknown_opcode.mmb",
    title: "Fail case: unknown opcode",
    description: "The first command of the proof of `id` is opcode 0x3f, which the spec does not define.",
    patches: [{ at: 897, expect: [0x12], put: [0x3f] }],
    expectProblems: ["unknown opcode 0x3f"],
  },
  {
    file: "mutant_sorry.mmb",
    title: "Sorry: admitted proof",
    description: "The proof of `id` is replaced by one that builds `imp a a` and admits it with Sorry. The layout is fine and the machine accepts every step, but the statement counts as unverified.",
    patches: [{ at: 0x381, expect: ID_BODY, put: SORRY_BODY }],
    expectProblems: [],
    expectVerify: { stmt: 7, status: "sorry" },
  },
  {
    file: "mutant_refl_distinct.mmb",
    title: "Fail case: Refl on distinct nodes",
    description: "The proof of or_right builds `imp b (or a b)` twice, so the conversion obligation has structurally equal but distinct sides. Refl requires the very same node; Save and Ref are the only way to get that.",
    patches: [{ at: 0x3cc, expect: OR_RIGHT_BODY, put: REFL_BODY }],
    expectProblems: [],
    expectVerify: { stmt: 10, status: "error", message: "both sides are the same node" },
  },
  {
    file: "mutant_wrong_conclusion.mmb",
    title: "Fail case: proof of a different statement",
    description: "The unify stream of mpd now claims the conclusion `imp a b` while the proof establishes `imp a c`. The final unification of the proved statement against the theorem table fails on the last URef. (syl, which applies mpd, then fails too.)",
    patches: [{ at: 0x253, expect: [0x02], put: [0x01] }],
    expectProblems: [],
    expectVerify: { stmt: 13, status: "error", message: "top of unify stack is unify heap entry" },
  },
  {
    file: "mutant_bad_stack.mmb",
    title: "Fail case: wrong kind of stack element",
    description: "In the proof of or_right the Conv command is replaced by Refl, which expects a conversion obligation on top of the stack but finds the proof that Thm just pushed.",
    patches: [{ at: 0x3e2, expect: [0x17], put: [0x18] }],
    expectProblems: [],
    expectVerify: { stmt: 10, status: "error", message: "expected obligation" },
  },
  {
    file: "mutant_truncated.mmb",
    title: "Fail case: truncated file",
    description: "The tutorial file cut off in the middle of the proof stream: the index pointer and several statements run past the end.",
    patches: [],
    truncate: 1100,
    expectProblems: ["points outside", "statement length"],
  },
];

/**
 * @param {Uint8Array} base
 * @param {Mutant} m
 * @returns {Uint8Array}
 */
export function applyMutant(base, m) {
  let out = base.slice();
  for (const p of m.patches) {
    for (let i = 0; i < p.expect.length; i++) {
      if (out[p.at + i] !== p.expect[i]) {
        throw new Error(`${m.file}: expected byte ${p.expect[i].toString(16)} at ${p.at + i}, found ${out[p.at + i]?.toString(16)}`);
      }
    }
    if (p.put.length !== p.expect.length) throw new Error(`${m.file}: patch at ${p.at} changes length`);
    out.set(p.put, p.at);
  }
  if (m.truncate !== undefined) out = out.slice(0, m.truncate);
  return out;
}
