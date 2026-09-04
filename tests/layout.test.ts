import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parseLayout, declName } from "../src/core/layout";
import { checkPartition, leaves, collectProblems, leafAt, spanChainAt } from "../src/core/spans";

const EXAMPLES = join(__dirname, "..", "public", "examples");
const MM0_TESTS = "/home/graham/Projects/mm0/tests";

function load(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(EXAMPLES, name)));
}

function corpus(): [string, Uint8Array][] {
  const out: [string, Uint8Array][] = readdirSync(EXAMPLES)
    .filter((f) => f.endsWith(".mmb"))
    .map((f) => [f, load(f)]);
  try {
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".mmb")) out.push([p.replace(MM0_TESTS + "/", "mm0-tests/"), new Uint8Array(readFileSync(p))]);
      }
    };
    walk(MM0_TESTS);
  } catch {
    // mm0 checkout not available; the bundled examples still run.
  }
  return out;
}

describe("header", () => {
  it("decodes peano.mmb", () => {
    const L = parseLayout(load("peano.mmb"));
    expect(L.header).toMatchObject({
      magic: "MM0B",
      version: 1,
      numSorts: 3,
      numTerms: 170,
      numThms: 2723,
      pTerms: 48,
      pThms: 8456,
      pProof: 170532,
      pIndex: 875888n,
    });
    expect(L.sorts.length).toBe(3);
    expect(L.terms.length).toBe(170);
    expect(L.thms.length).toBe(2723);
    expect(L.statements.length).toBe(3 + 170 + 2723);
    expect(L.index?.hasNames).toBe(true);
    expect(L.problems.filter((p) => p.severity === "error")).toEqual([]);
  });

  it("names declarations from the index", () => {
    const L = parseLayout(load("tutorial.mmb"));
    const names = L.thms.map((t) => t.name);
    expect(names.every((n) => typeof n === "string" && n.length > 0)).toBe(true);
    expect(declName(L, { kind: "sort", id: 0 })).toBe(L.sorts[0]!.name);
    // Every declaration's statement was found and linked.
    for (const t of L.terms) expect(t.statement?.decl).toEqual({ kind: "term", id: t.id });
    for (const t of L.thms) expect(t.statement?.decl).toEqual({ kind: "thm", id: t.id });
  });

  it("parses a file without a debugging index", () => {
    // dummy_reserved_bit.mmb is rejected by verifiers because its 56th dummy
    // would need dependency bit 55, but its layout is well-formed.
    const L = parseLayout(load("dummy_reserved_bit.mmb"));
    expect(L.index).toBeUndefined();
    expect(L.problems.filter((p) => p.severity === "error")).toEqual([]);
    expect(L.terms.map((t) => t.name)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(declName(L, { kind: "thm", id: 1 })).toBe("T1");
  });

  it("survives a p_index far outside the file", () => {
    const L = parseLayout(load("gi_header_p_index_overflow.mmb"));
    expect(L.index).toBeUndefined();
    expect(L.problems.some((p) => /p_index.*outside/.test(p.message))).toBe(true);
    expect(L.statements.length).toBeGreaterThan(0);
    expect(checkPartition(L.root)).toEqual([]);
  });

  it("finds inline unify streams after the binders", () => {
    const L = parseLayout(load("tutorial.mmb"));
    for (const t of L.terms) {
      if (t.isDef) expect(t.unifySpan?.start).toBe(t.pData + 8 * (t.numArgs + 1));
      else expect(t.unifySpan).toBeUndefined();
    }
    for (const t of L.thms) expect(t.unifySpan?.start).toBe(t.pData + 8 * t.numArgs);
  });

  it("does not throw on garbage", () => {
    for (const len of [0, 3, 39, 40, 41, 100]) {
      const junk = new Uint8Array(len).map((_, i) => (i * 37) & 0xff);
      const L = parseLayout(junk);
      expect(checkPartition(L.root)).toEqual([]);
    }
  });
});

describe("span partition", () => {
  for (const [name, bytes] of corpus()) {
    it(`partitions ${name} exactly`, () => {
      const L = parseLayout(bytes);
      expect(checkPartition(L.root)).toEqual([]);
      let total = 0;
      let count = 0;
      for (const leaf of leaves(L.root)) {
        total += leaf.end - leaf.start;
        count++;
      }
      expect(total).toBe(bytes.length);
      expect(count).toBeGreaterThan(0);
    });
  }

  it("finds the leaf at every offset of tutorial.mmb", () => {
    const bytes = load("tutorial.mmb");
    const L = parseLayout(bytes);
    for (let o = 0; o < bytes.length; o++) {
      const leaf = leafAt(L.root, o);
      expect(leaf, `offset ${o}`).toBeDefined();
      expect(leaf!.start <= o && o < leaf!.end).toBe(true);
    }
    const chain = spanChainAt(L.root, 0);
    expect(chain.map((s) => s.kind)).toEqual(["file", "header", "header.magic"]);
  });

  it("has no unaccounted bytes in well-formed files", () => {
    for (const f of ["peano.mmb", "tutorial.mmb"]) {
      const L = parseLayout(load(f));
      const bad = [...leaves(L.root)].filter((s) => s.kind === "unaccounted");
      expect(bad, f).toEqual([]);
      const probs = collectProblems(L.root).filter((p) => p.severity === "error");
      expect(probs, f).toEqual([]);
    }
  });
});

describe("jumps", () => {
  const L = parseLayout(load("tutorial.mmb"));
  const at = (offset: number) => {
    const chain = spanChainAt(L.root, offset);
    return chain[chain.length - 1]!;
  };

  it("absolute pointers jump to their value", () => {
    const pTerms = at(16);
    expect(pTerms.kind).toBe("header.p_terms");
    expect(pTerms.target).toBe(Number(L.header!.pTerms));
    expect(pTerms.jump).toEqual({ name: "term table", how: `0x${L.header!.pTerms.toString(16)} = .value, an absolute file offset` });
  });

  it("statement commands jump to start + data", () => {
    const st = L.statements[1]!;
    const cmd = at(st.offset);
    expect(cmd.kind).toBe("proof.stmt_cmd");
    expect(cmd.target).toBe(st.end);
    expect(cmd.jump?.name).toBe("next statement");
    expect(cmd.jump?.how).toBe(`0x${st.end.toString(16)} = start 0x${st.offset.toString(16)} + .data 0x${(st.end - st.offset).toString(16)}`);
  });

  it("term references jump to p_terms + 8 × index", () => {
    // A theorem's unify stream starts with a UTerm for the head of its conclusion.
    const thm = L.thms.find((t) => t.unifySpan)!;
    const cmd = at(thm.unifySpan!.start);
    expect(cmd.kind).toBe("unify.cmd");
    expect(cmd.jump?.name).toBe("term entry");
    expect(cmd.jump?.how).toMatch(/^0x[0-9a-f]+ = p_terms 0x[0-9a-f]+ \+ 8 × \.data \d+$/);
    expect(cmd.target).toBe(Number(L.header!.pTerms) + 8 * (cmd.value as { data: number }).data);
  });
});
