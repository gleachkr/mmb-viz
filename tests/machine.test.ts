import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLayout, declName } from "../src/core/layout";
import { Machine, type StepRecord } from "../src/core/machine";
import { Trace, verifyFile } from "../src/core/verify";

const EXAMPLES = join(__dirname, "..", "public", "examples");
const load = (name: string) => new Uint8Array(readFileSync(join(EXAMPLES, name)));

describe("verifier on the corpus", () => {
  it("accepts the tutorial", () => {
    const r = verifyFile(parseLayout(load("tutorial.mmb")));
    expect(r.errors).toBe(0);
    expect(r.sorry).toBe(0);
    expect(r.results).toHaveLength(20);
  });

  it("accepts peano (every opcode except Sorry is exercised)", () => {
    const L = parseLayout(load("peano.mmb"));
    const r = verifyFile(L);
    expect(r.firstError && `${r.firstError.index} ${declName(L, L.statements[r.firstError.index]!.decl!)}: ${r.firstError.error?.message}`).toBeUndefined();
    expect(r.sorry).toBe(0);
    expect(r.steps).toBeGreaterThan(500000);
  });

  it("tracks the 56th bound variable instead of masking it (mm0-c wrongly accepts this file)", () => {
    // def choose (.x00 ... .x55: s): s = $ ... ? x55 $ unfolds to the dummy x55, which escapes.
    const L = parseLayout(load("dummy_reserved_bit.mmb"));
    const r = verifyFile(L);
    // The file has no debugging index, so the def is known only as term 3.
    expect(r.firstError && L.statements[r.firstError.index]!.decl).toEqual({ kind: "term", id: 3 });
    expect(r.firstError?.error?.message).toContain("value's free variables are declared in ret");
  });

  it("fails the index-overflow test file where mm0-c does (Ref 3 with a 3-entry heap)", () => {
    const L = parseLayout(load("gi_header_p_index_overflow.mmb"));
    const r = verifyFile(L);
    expect(r.firstError?.error).toMatchObject({ offset: 0x360, message: expect.stringContaining("heap index in range") });
  });
});

describe("stepping", () => {
  const L = parseLayout(load("tutorial.mmb"));
  const stmtOf = (name: string) => L.statements.find((s) => s.decl && declName(L, s.decl) === name)!;

  it("records what an axiom application reads, checks, pops, and pushes", () => {
    // theorem a1i (h: $ b $): $ a -> b $ = ax_mp ax_1 h
    const t = new Trace(L, stmtOf("a1i"));
    expect(t.result.status).toBe("ok");
    const names = t.records.map((r) => `${r.level}:${r.mnemonic}`);
    expect(names[0]).toBe("stmt:LocalThm (length 27)");
    expect(names.slice(1, 4)).toEqual(["proof:Ref 1", "proof:Hyp", "proof:Ref 1"]);
    const hyp = t.records[2]!;
    expect(hyp.pops).toEqual([{ kind: "expr", e: 1 }]);
    expect(hyp.heapPushes).toEqual([{ kind: "proof", e: 1 }]);
    expect(hyp.hypPushed).toBe(1);
    expect(hyp.checks.map((c) => `${c.name}:${c.passed}`)).toContain("hypothesis has a provable sort:true");

    const thm = t.records.find((r) => r.mnemonic.startsWith("Thm 3"))!; // ax_mp
    expect(thm.opens).toBe("thm");
    expect(thm.reads.map((s) => s.kind)).toEqual(expect.arrayContaining(["proof.cmd", "thms.entry", "thmdata.arg", "unify"]));
    expect(thm.checks.every((c) => c.passed)).toBe(true);
    // The steps that follow run ax_mp's unify stream: URef 1, UHyp, URef 0, UHyp, UTerm 0, URef 0, URef 1, END.
    const after = t.records.slice(thm.index + 1, thm.index + 9);
    expect(after.map((r) => r.level)).toEqual(Array(8).fill("unify"));
    expect(after.map((r) => r.mnemonic.split(" ")[0])).toEqual(["URef", "UHyp", "URef", "UHyp", "UTerm", "URef", "URef", "END"]);
    const end = after[7]!;
    expect(end.closes).toBe(true);
    expect(end.pushes).toEqual([{ kind: "proof", e: expect.any(Number) }]);
    expect(end.summary).toContain("Unification succeeded");
  });

  it("finishes a theorem by matching the proved statement, hypotheses last-first", () => {
    const t = new Trace(L, stmtOf("mpd"));
    const last = t.records[t.records.length - 1]!;
    expect(last.level).toBe("unify");
    expect(last.summary).toContain("is verified");
    const uhyps = t.records.filter((r) => r.level === "unify" && r.mnemonic === "UHyp" && r.summary.includes("Takes the last hypothesis"));
    expect(uhyps).toHaveLength(2);
    expect(t.machine.hyps).toEqual([]);
    expect(t.machine.stack).toEqual([{ kind: "proof", e: expect.any(Number) }]);
  });

  it("time travel by re-execution reproduces every state", () => {
    const st = stmtOf("syl");
    const t = new Trace(L, st);
    // Reference: a fresh machine stepped forward once per snapshot.
    const m = new Machine(L, st);
    const snaps = [m.snapshot()];
    while (m.step()) snaps.push(m.snapshot());
    expect(snaps.length).toBe(t.length + 1);
    for (const k of [0, 1, 5, t.length - 1, t.length, 3, 0]) {
      const mk = t.at(k);
      expect(mk.snapshot()).toEqual(snaps[k]);
    }
  });

  it("prints expressions with the declaration's variable names", () => {
    const t = new Trace(L, stmtOf("ax_2"));
    const m = t.at(t.length);
    expect(m.show((m.stack[0] as { e: number }).e)).toBe("imp (imp a (imp b c)) (imp (imp a b) (imp a c))");
  });

  it("reports Sorry as used but keeps stepping", () => {
    const S = parseLayout(load("mutant_sorry.mmb"));
    const t = new Trace(S, S.statements[7]!);
    expect(t.result.status).toBe("sorry");
    const sorry = t.records.find((r) => r.mnemonic === "Sorry")!;
    expect(sorry.pops).toEqual([{ kind: "expr", e: expect.any(Number) }]);
    expect(sorry.pushes).toEqual([{ kind: "proof", e: (sorry.pops[0] as { e: number }).e }]);
  });

  it("stops at the failing check and keeps the record", () => {
    const F = parseLayout(load("mutant_refl_distinct.mmb"));
    const t = new Trace(F, F.statements[10]!);
    expect(t.result.status).toBe("error");
    const last: StepRecord = t.records[t.records.length - 1]!;
    expect(last.mnemonic).toBe("Refl");
    expect(last.error?.check?.name).toBe("both sides are the same node");
    expect(last.checks.filter((c) => !c.passed)).toHaveLength(1);
    expect(t.at(t.length).done).toBe(true);
    expect(t.at(t.length - 1).done).toBe(false);
  });
});
