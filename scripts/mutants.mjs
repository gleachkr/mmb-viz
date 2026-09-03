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
/** @typedef {{ file: string, title: string, description: string, patches: Patch[], truncate?: number, expectProblems: string[] }} Mutant */

// a1i's 25-byte proof body, rewritten to cite a1i itself (theorem 6):
//   Ref 1; Hyp; Ref 2 (|- h); Ref 0; Ref 1; Ref 0; Ref 1; Term 0; Thm 6; END
// with wider encodings of Hyp and Ref 0 so the length is unchanged.
const CIRCULAR_BODY = [0x52, 0x01, 0x96, 0x00, 0x00, 0x52, 0x02, 0xd2, 0, 0, 0, 0, 0x52, 0x01, 0xd2, 0, 0, 0, 0, 0x52, 0x01, 0x10, 0x54, 0x06, 0x00];
const A1I_BODY = [0x52, 0x01, 0x16, 0x52, 0x01, 0x12, 0x52, 0x01, 0x12, 0x52, 0x01, 0x11, 0x10, 0x14, 0x52, 0x02, 0x52, 0x01, 0x52, 0x03, 0x52, 0x03, 0x54, 0x03, 0x00];

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
