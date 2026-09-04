import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseLayout } from "../src/core/layout";
import { checkPartition, collectProblems, leaves } from "../src/core/spans";
import { MUTANTS, applyMutant } from "../scripts/mutants.mjs";
import { verifyFile } from "../src/core/verify";

const EXAMPLES = join(__dirname, "..", "public", "examples");
const base = new Uint8Array(readFileSync(join(EXAMPLES, "tutorial.mmb")));

describe("mutated files", () => {
  for (const m of MUTANTS) {
    it(`${m.file}: reports ${m.expectProblems.join(", ")}`, () => {
      const bytes = applyMutant(base, m);
      // The bundled copy is what the generator produced from the same table.
      expect(new Uint8Array(readFileSync(join(EXAMPLES, m.file)))).toEqual(bytes);
      const L = parseLayout(bytes);
      expect(checkPartition(L.root)).toEqual([]);
      let total = 0;
      for (const leaf of leaves(L.root)) total += leaf.end - leaf.start;
      expect(total).toBe(bytes.length);
      const messages = collectProblems(L.root).concat(L.problems).map((p) => p.message);
      for (const expected of m.expectProblems) {
        expect(messages.some((msg) => msg.includes(expected)), `expected a problem containing "${expected}", got:\n${messages.join("\n")}`).toBe(true);
      }
      if (m.expectVerify) {
        const r = verifyFile(L);
        // The first statement that is not ok must be the one the mutant targets (later ones may fail downstream).
        const bad = r.results.find((x) => x.status !== "ok");
        expect(bad && `${bad.index}:${bad.status}`).toBe(`${m.expectVerify.stmt}:${m.expectVerify.status}`);
        if (m.expectVerify.message) expect(bad!.error?.message).toContain(m.expectVerify.message);
      }
    });
  }

  it("the unmutated file has no problems at all and verifies", () => {
    const L = parseLayout(base);
    expect(collectProblems(L.root)).toEqual([]);
    expect(L.problems).toEqual([]);
    const r = verifyFile(L);
    expect(r.errors).toBe(0);
    expect(r.sorry).toBe(0);
  });
});
