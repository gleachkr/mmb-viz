/**
 * Oracle agreement: mm0-c's verdict on each corpus file must match ours.
 *
 * mm0-c needs an .mm0 file to cross-check the public statements against, so
 * every corpus file here has one: peano's from the mm0 repository, the
 * tutorial's a stub written for the purpose (tests/oracle/tutorial.mm0),
 * and the run tests their own. The binary is built from ~/Projects/mm0/mm0-c
 * on first use (set MM0C to use another); when neither is available the
 * suite is skipped.
 */
import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseLayout } from "../src/core/layout";
import { collectProblems } from "../src/core/spans";
import { verifyFile } from "../src/core/verify";

const ROOT = join(__dirname, "..");
const EXAMPLES = join(ROOT, "public", "examples");
const MM0 = join(homedir(), "Projects", "mm0");

function mm0c(): string | undefined {
  if (process.env.MM0C && existsSync(process.env.MM0C)) return process.env.MM0C;
  const src = join(MM0, "mm0-c", "main.c");
  if (!existsSync(src)) return undefined;
  const dir = join(ROOT, "node_modules", ".cache");
  const bin = join(dir, "mm0-c");
  if (!existsSync(bin)) {
    mkdirSync(dir, { recursive: true });
    const r = spawnSync("gcc", ["main.c", "-O2", "-o", bin], { cwd: join(MM0, "mm0-c") });
    if (r.status !== 0) return undefined;
  }
  return bin;
}

interface Verdict {
  status: "ok" | "sorry" | "error";
  /** Byte offset of the failing statement, when known. */
  stmt?: number;
}

function oracle(bin: string, mmb: string, mm0: string): Verdict {
  const r = spawnSync(bin, [mmb], { input: readFileSync(mm0), encoding: "utf8" });
  if (r.status === 0) return { status: "ok" };
  if (r.status === 3) return { status: "sorry" };
  const m = /^stmt: ([0-9A-F]+)/m.exec(r.stderr);
  return { status: "error", stmt: m ? parseInt(m[1]!, 16) : undefined };
}

function ours(mmb: string): Verdict {
  const L = parseLayout(new Uint8Array(readFileSync(mmb)));
  const r = verifyFile(L);
  if (r.firstError) return { status: "error", stmt: L.statements[r.firstError.index]!.offset };
  // Layout-level violations (bad magic, reserved bits) are errors too; mm0-c reports them before or at some statement.
  if (collectProblems(L.root).concat(L.problems).some((p) => p.severity === "error")) return { status: "error" };
  return { status: r.sorry ? "sorry" : "ok" };
}

const bin = mm0c();
const cases: { mmb: string; mm0: string }[] = [];
const tutorialStub = join(__dirname, "oracle", "tutorial.mm0");
for (const f of readdirSync(EXAMPLES)) {
  if (f === "tutorial.mmb" || f.startsWith("mutant_")) cases.push({ mmb: join(EXAMPLES, f), mm0: tutorialStub });
}
if (existsSync(join(MM0, "examples", "peano.mm0"))) cases.push({ mmb: join(EXAMPLES, "peano.mmb"), mm0: join(MM0, "examples", "peano.mm0") });
const run = join(MM0, "tests", "mmb", "run");
if (existsSync(run)) for (const f of readdirSync(run)) if (f.endsWith(".mmb")) cases.push({ mmb: join(run, f), mm0: join(run, f.replace(/\.mmb$/, ".mm0")) });
// mm0_mmu/fail exercises the .mm0 parser, not the .mmb, so only the pass side is an oracle case.
const mmuPass = join(MM0, "tests", "mm0_mmu", "pass");
if (existsSync(mmuPass)) for (const f of readdirSync(mmuPass)) if (f.endsWith(".mmb") && existsSync(join(mmuPass, f.replace(/\.mmb$/, ".mm0")))) cases.push({ mmb: join(mmuPass, f), mm0: join(mmuPass, f.replace(/\.mmb$/, ".mm0")) });

/**
 * Files where mm0-c is known to be wrong, with our verdict instead.
 * dummy_reserved_bit: a def with 56 dummies whose value unfolds to the 56th.
 * mm0-c masks dependency bit 55 away and accepts the escaping dummy; we
 * track it and reject the def (Aufbau rejects earlier, at the 56th Dummy).
 */
const KNOWN_DIVERGENCE = new Map<string, Verdict["status"]>([[join(run, "dummy_reserved_bit.mmb"), "error"]]);

describe.skipIf(!bin)("mm0-c oracle", () => {
  for (const c of cases) {
    const name = c.mmb.replace(homedir(), "~");
    it(`agrees on ${name}`, () => {
      const theirs = oracle(bin!, c.mmb, c.mm0);
      const mine = ours(c.mmb);
      const known = KNOWN_DIVERGENCE.get(c.mmb);
      if (known) {
        expect(mine.status).toBe(known);
        return;
      }
      expect(mine.status, `mm0-c says ${JSON.stringify(theirs)}`).toBe(theirs.status);
      if (theirs.status === "error" && theirs.stmt !== undefined && mine.stmt !== undefined) expect(mine.stmt).toBe(theirs.stmt);
    });
  }
});
