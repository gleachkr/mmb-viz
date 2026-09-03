import { describe, expect, it } from "vitest";
import { SPEC_SECTIONS, renderMarkdown, specSection } from "../src/core/spec";
import { EXPLAIN, PROOF_OP_EXPLAIN, STMT_EXPLAIN, UNIFY_OP_EXPLAIN } from "../src/core/explain";
import { PROOF_OPS, STATEMENTS, UNIFY_OPS } from "../src/core/opcodes";

describe("spec companion", () => {
  it("splits the spec by heading", () => {
    const ids = SPEC_SECTIONS.map((s) => s.id);
    expect(ids).toEqual([
      "the-mmb-file-format",
      "encoding-and-types",
      "header",
      "sort-table",
      "term-table",
      "theorem-table",
      "unify-stream",
      "proof-stream",
      "proof-checking",
      "unification",
      "debugging-index",
      "the-name-table-names-for-statements",
      "the-varn-table-names-for-variables",
      "the-hypn-table-names-for-hypotheses",
    ]);
  });

  it("every explanation points at an existing section", () => {
    for (const e of Object.values(EXPLAIN)) if (e.spec) expect(specSection(e.spec), e.spec).toBeDefined();
    for (const e of [...Object.values(PROOF_OP_EXPLAIN), ...Object.values(UNIFY_OP_EXPLAIN), ...Object.values(STMT_EXPLAIN)]) {
      const s = specSection(e.spec)!;
      expect(s, e.spec).toBeDefined();
      if (e.anchor) expect(s.html, `${e.title} -> ${e.anchor}`).toMatch(new RegExp(`data-(rule|row)="${e.anchor}"`));
    }
  });

  it("every opcode has an explanation", () => {
    for (const op of Object.keys(PROOF_OPS)) expect(PROOF_OP_EXPLAIN[Number(op)], `proof op ${op}`).toBeDefined();
    for (const op of Object.keys(UNIFY_OPS)) expect(UNIFY_OP_EXPLAIN[Number(op)], `unify op ${op}`).toBeDefined();
    for (const s of Object.values(STATEMENTS)) for (const name of s.name.split("/")) expect(STMT_EXPLAIN[name], name).toBeDefined();
  });

  it("tags rules and table rows", () => {
    const pc = specSection("Proof Checking")!;
    for (const name of ["Term", "TermSave", "Ref", "Dummy", "Thm", "Hyp", "Conv", "Refl", "Cong", "Unfold", "ConvCut", "ConvSave", "Save", "Sorry"]) {
      expect(pc.html).toContain(`data-rule="${name}"`);
    }
    expect(specSection("Header")!.html).toContain('data-row="p_index"');
    // Consecutive rules separated by blank lines form one list.
    expect(pc.html.match(/<ul><li data-rule=/g)!.length).toBe(1);
  });

  it("renders inline markdown", () => {
    expect(renderMarkdown("a `b <c>` **d** *e* [f](#g)")).toBe('<p>a <code>b &lt;c&gt;</code> <strong>d</strong> <em>e</em> <a href="#g" data-section="g">f</a></p>');
    expect(renderMarkdown("* one\n  * two\n* three")).toBe("<ul><li>one<ul><li>two</li></ul></li><li>three</li></ul>");
    expect(renderMarkdown("| A | B |\n| - | - |\n| `x` | y |")).toBe('<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr data-row="x"><td><code>x</code></td><td>y</td></tr></tbody></table>');
  });
});
