// Regenerate the bundled fail-case files and their manifest entries.
import { readFileSync, writeFileSync } from "node:fs";
import { MUTANTS, applyMutant } from "./mutants.mjs";

const dir = new URL("../public/examples/", import.meta.url);
const base = new Uint8Array(readFileSync(new URL("tutorial.mmb", dir)));
const manifestUrl = new URL("manifest.json", dir);
const manifest = JSON.parse(readFileSync(manifestUrl, "utf8")).filter((e) => !e.file.startsWith("mutant_"));
for (const m of MUTANTS) {
  writeFileSync(new URL(m.file, dir), applyMutant(base, m));
  manifest.push({ file: m.file, title: m.title, description: m.description });
  console.log("wrote", m.file);
}
writeFileSync(manifestUrl, JSON.stringify(manifest, null, 2) + "\n");
