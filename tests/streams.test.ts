import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLayout } from "../src/core/layout";
import { disassembleProof, disassembleUnify, hypCount, showExpr } from "../src/core/streams";
import { allDecls, showStatement, summarize } from "../src/core/decls";

const EXAMPLES = join(__dirname, "..", "public", "examples");
const load = (name: string) => new Uint8Array(readFileSync(join(EXAMPLES, name)));

describe("unify stream decoding", () => {
  const L = parseLayout(load("tutorial.mmb"));

  it("reads a theorem statement: conclusion first, hypotheses last-first", () => {
    // theorem mpd (h1: $ a -> b $) (h2: $ a -> b -> c $): $ a -> c $
    const mpd = L.thms.find((t) => t.name === "mpd")!;
    const u = disassembleUnify(L, { kind: "thm", id: mpd.id })!;
    expect(u.problems).toEqual([]);
    expect(showExpr(u.concl!)).toBe("imp a c");
    expect(u.hyps.map(showExpr)).toEqual(["imp a b", "imp a (imp b c)"]);
    expect(u.cmds.filter((c) => c.mnemonic === "UHyp").map((c) => c.note)).toEqual(["h2", "h1"]);
    expect(hypCount(L, mpd)).toBe(2);
  });

  it("reads a def value", () => {
    const and = L.terms.find((t) => t.name === "and")!;
    const u = disassembleUnify(L, { kind: "term", id: and.id })!;
    expect(showExpr(u.value!)).toBe("not (imp a (not b))");
    expect(u.hyps).toEqual([]);
  });

  it("resolves URef operands to variable names", () => {
    const u = disassembleUnify(L, { kind: "thm", id: L.thms.find((t) => t.name === "ax_mp")!.id })!;
    expect(u.cmds.map((c) => `${c.mnemonic}${c.operand ? " " + c.operand : ""}${c.note ? " ; " + c.note : ""}`)).toEqual([
      "URef 1 ; b",
      "UHyp ; h2",
      "URef 0 ; a",
      "UHyp ; h1",
      "UTerm 0 ; imp",
      "URef 0 ; a",
      "URef 1 ; b",
      "END",
    ]);
  });

  it("decodes every unify stream of peano without problems", () => {
    const P = parseLayout(load("peano.mmb"));
    let n = 0;
    for (const t of P.thms) {
      const u = disassembleUnify(P, { kind: "thm", id: t.id })!;
      expect(u.problems, t.name).toEqual([]);
      expect(u.concl).toBeDefined();
      n++;
    }
    for (const t of P.terms) {
      if (!t.isDef) continue;
      const u = disassembleUnify(P, { kind: "term", id: t.id })!;
      expect(u.problems, t.name).toEqual([]);
      expect(u.value).toBeDefined();
      n++;
    }
    expect(n).toBeGreaterThan(2700);
  });
});

describe("proof stream disassembly", () => {
  const L = parseLayout(load("tutorial.mmb"));

  it("tracks the heap statically", () => {
    const mpd = L.thms.find((t) => t.name === "mpd")!;
    const d = disassembleProof(L, mpd.statement!)!;
    expect(d.wellTerminated).toBe(true);
    expect(d.hyps).toBe(2);
    expect(d.usesSorry).toBe(false);
    expect(d.heap.slice(0, 5).map((h) => `${h.index}:${h.kind}:${h.name}`)).toEqual(["0:var:a", "1:var:b", "2:var:c", "3:expr:(imp …)", "4:hyp:|- h1"]);
    // Ref 4 is the proof of h1, produced by the Hyp at command #3.
    const ref4 = d.cmds.find((c) => c.mnemonic === "Ref" && c.data === 4)!;
    expect(ref4.note).toBe("|- h1 from #3");
    expect(ref4.target).toBe(d.cmds[3]!.offset);
    // Every Ref resolves.
    for (const c of d.cmds) if (c.mnemonic === "Ref") expect(c.problems, `Ref at ${c.offset}`).toEqual([]);
  });

  it("names dummies from the VarN table", () => {
    const P = parseLayout(load("peano.mmb"));
    const withDummy = P.statements.find((st) => st.hasProof && disassembleProof(P, st)!.dummies > 0)!;
    const d = disassembleProof(P, withDummy)!;
    const dummy = d.cmds.find((c) => c.mnemonic === "Dummy")!;
    expect(dummy.note).toMatch(/^[^ ]+: /);
    expect(d.heap[dummy.heapIndex!]!.kind).toBe("dummy");
  });
});

describe("declarations", () => {
  const L = parseLayout(load("tutorial.mmb"));

  it("renders MM0-style statements", () => {
    const stmts = allDecls(L).map(showStatement);
    expect(stmts).toContain("provable sort wff");
    expect(stmts).toContain("term imp: wff > wff > wff");
    expect(stmts).toContain("local def and (a b: wff): wff = not (imp a (not b))");
    expect(stmts).toContain("axiom ax_mp (a b: wff)\n  (h1: $ imp a b $)\n  (h2: $ a $)\n  > $ b $");
    expect(stmts).toContain("theorem id (a: wff)\n  : $ imp a a $");
  });

  it("classifies and links declarations", () => {
    const d = summarize(L, { kind: "thm", id: L.thms.find((t) => t.name === "a1i")!.id })!;
    expect(d.category).toBe("theorem");
    expect(d.local).toBe(true);
    expect(d.hyps).toEqual([{ name: "h", text: "b" }]);
    expect(d.concl).toBe("imp a b");
    expect(d.proofBytes).toBe(25);
    expect(d.problems).toEqual([]);
    const s = summarize(L, { kind: "sort", id: 0 })!;
    expect(s.signature).toBe("provable sort wff");
  });

  it("shows bound variables and dependencies in binders", () => {
    const P = parseLayout(load("peano.mmb"));
    const sigs = allDecls(P).map((d) => d.signature);
    // Some term in peano binds a variable: its signature uses braces.
    expect(sigs.some((s) => /\{[^}]+: nat\}/.test(s))).toBe(true);
    // And some declaration has a dependency annotation "(x: wff y)".
    expect(sigs.some((s) => /\([^)]+: \w+ \w+\)/.test(s))).toBe(true);
  });
});
