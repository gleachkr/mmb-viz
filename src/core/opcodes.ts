/** Opcode tables from the MMB spec. */

export const STMT_END = 0x00;

export interface StmtInfo {
  name: string;
  hasProof: boolean;
  decl: "sort" | "term" | "thm";
  local: boolean;
}

/** Statement opcodes (first command of each statement in the proof stream). */
export const STATEMENTS: Record<number, StmtInfo> = {
  0x04: { name: "Sort", hasProof: false, decl: "sort", local: false },
  0x05: { name: "Term/Def", hasProof: false, decl: "term", local: false }, // hasProof depends on is_def
  0x0d: { name: "LocalDef", hasProof: true, decl: "term", local: true },
  0x02: { name: "Axiom", hasProof: true, decl: "thm", local: false },
  0x06: { name: "Thm", hasProof: true, decl: "thm", local: false },
  0x0e: { name: "LocalThm", hasProof: true, decl: "thm", local: true },
};

export interface OpInfo {
  name: string;
  /** What the data field refers to. */
  arg: "none" | "term" | "heap" | "sort" | "thm";
}

/** Proof stream opcodes. */
export const PROOF_OPS: Record<number, OpInfo> = {
  0x00: { name: "END", arg: "none" },
  0x10: { name: "Term", arg: "term" },
  0x11: { name: "TermSave", arg: "term" },
  0x12: { name: "Ref", arg: "heap" },
  0x13: { name: "Dummy", arg: "sort" },
  0x14: { name: "Thm", arg: "thm" },
  0x15: { name: "ThmSave", arg: "thm" },
  0x16: { name: "Hyp", arg: "none" },
  0x17: { name: "Conv", arg: "none" },
  0x18: { name: "Refl", arg: "none" },
  0x19: { name: "Sym", arg: "none" },
  0x1a: { name: "Cong", arg: "none" },
  0x1b: { name: "Unfold", arg: "none" },
  0x1c: { name: "ConvCut", arg: "none" },
  0x1e: { name: "ConvSave", arg: "none" },
  0x1f: { name: "Save", arg: "none" },
  0x20: { name: "Sorry", arg: "none" },
};

/** Unify stream opcodes. */
export const UNIFY_OPS: Record<number, OpInfo> = {
  0x00: { name: "END", arg: "none" },
  0x30: { name: "UTerm", arg: "term" },
  0x31: { name: "UTermSave", arg: "term" },
  0x32: { name: "URef", arg: "heap" },
  0x33: { name: "UDummy", arg: "sort" },
  0x36: { name: "UHyp", arg: "none" },
};

export const SORT_MODIFIERS = ["pure", "strict", "provable", "free"] as const;
