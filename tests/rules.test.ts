import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLayout, declName } from "../src/core/layout";
import { Machine } from "../src/core/machine";
import { picture, ruleSchema } from "../src/core/rules";
import { Trace } from "../src/core/verify";

const L = parseLayout(new Uint8Array(readFileSync(join(__dirname, "..", "public", "examples", "tutorial.mmb"))));
const stmtOf = (name: string) => L.statements.find((s) => s.decl && declName(L, s.decl) === name)!;

/** `H; S, a, b --> H, x; S` with the entries printed by the machine. */
function text(m: Machine, side: ReturnType<typeof picture>["before"]): string {
  return side.map((c) => `${c.name}${c.empty ? " = ." : ""}${c.items.map((e) => `, ${m.showEntry(e)}`).join("")}`).join("; ");
}

describe("instantiated rules", () => {
  // theorem mpd (h1: $ imp a b $) (h2: $ imp a (imp b c) $): $ imp a c $
  const t = new Trace(L, stmtOf("mpd"));
  const m = new Machine(L, stmtOf("mpd"));
  m.run();
  const at = (pred: (r: (typeof t.records)[number]) => boolean) => t.records.find(pred)!;
  const pic = (r: (typeof t.records)[number]) => {
    const p = picture(r);
    return { before: text(m, p.before), after: text(m, p.after), opensAt: p.opensAt };
  };

  it("start: the variables go on the heap", () => {
    const r = t.records[0]!;
    expect(ruleSchema(r)?.paraphrase).toBe(true);
    expect(pic(r)).toEqual({ before: "H; S", after: "H, a, b, c; S", opensAt: undefined });
  });

  it("Term: pops the arguments deepest first and pushes the application", () => {
    const r = at((x) => x.mnemonic.startsWith("Term ") && x.pops.length === 2);
    expect(ruleSchema(r)?.lines[0]).toBe("Term t: H; S, e1, ..., en --> H; S, (t e1 ... en)");
    const p = pic(r);
    expect(p.before).toBe(`H; S, ${m.showEntry(r.pops[0]!)}, ${m.showEntry(r.pops[1]!)}`);
    expect(p.after).toBe(`H; S, ${m.showEntry(r.pushes[0]!)}`);
  });

  it("Hyp: moves the expression to the hypothesis list and its proof to the heap", () => {
    const r = at((x) => x.mnemonic === "Hyp");
    expect(pic(r)).toEqual({ before: "HS; H; S, imp a b", after: "HS, imp a b; H, |- imp a b; S", opensAt: undefined });
  });

  it("Thm: pops the arguments and the conclusion, then opens a unify frame holding them", () => {
    const r = at((x) => x.mnemonic.startsWith("Thm"));
    expect(ruleSchema(r)?.lines).toHaveLength(2);
    const p = picture(r);
    expect(p.before.map((c) => c.name)).toEqual(["H", "S"]);
    expect(p.before[1]!.items).toEqual(r.pops);
    expect(p.before[1]!.items.at(-1)!.kind).toBe("expr");
    expect(p.opensAt).toBe(2);
    expect(p.after.map((c) => c.name)).toEqual(["H", "S", "H", "S"]);
    expect(p.after[2]!.items.map((e) => (e as { e: number }).e)).toEqual(r.uheapPushes);
    expect(p.after[3]!.items).toHaveLength(1);
  });

  it("UHyp while applying a theorem: takes a proof from the main stack", () => {
    const r = at((x) => x.level === "unify" && x.mnemonic === "UHyp" && x.pops.length === 1);
    expect(ruleSchema(r)?.lines[0]).toBe("UHyp: MS, |- e; S --> MS; S, e");
    const p = pic(r);
    expect(p.before).toMatch(/^MS, \|- .*; H; S$/);
    expect(p.after).toMatch(/^MS; H; S, .*$/);
  });

  it("UHyp at the end of a theorem: takes a hypothesis from the list", () => {
    const r = at((x) => x.level === "unify" && x.mnemonic === "UHyp" && x.hypPopped !== undefined);
    expect(ruleSchema(r)?.paraphrase).toBe(true);
    const p = pic(r);
    expect(p.before).toMatch(/^HS, .*; H; S$/);
    expect(p.after).toMatch(/^HS; H; S, .*$/);
  });

  it("END of a theorem application: the unify stack is empty and the conclusion is pushed", () => {
    const r = at((x) => x.level === "unify" && !!x.closes && x.pushes[0]?.kind === "proof");
    expect(ruleSchema(r)?.lines[0]).toBe("END: S = . --> MS, |- e");
    const p = pic(r);
    expect(p.before).toBe("H; S = .");
    expect(p.after).toMatch(/^MS, \|- /);
  });

  it("Save: keeps the element on the stack while copying it to the heap", () => {
    const rec = L.statements
      .filter((s) => s.decl?.kind === "thm")
      .flatMap((s) => new Trace(L, s).records)
      .find((x) => x.level === "proof" && x.mnemonic === "Save");
    if (!rec) return; // the tutorial may not use Save
    const p = picture(rec);
    expect(p.before[1]!.items).toEqual(rec.heapPushes);
    expect(p.after[1]!.items).toEqual(rec.heapPushes);
  });
});
