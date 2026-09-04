import { hex, type Cmd } from "../core/bytes";
import { declName, type Layout } from "../core/layout";
import { PROOF_OPS, UNIFY_OPS, STATEMENTS, SORT_MODIFIERS } from "../core/opcodes";
import { family, jumpText, type JumpPart, type Span } from "../core/spans";

/** Family -> CSS class suffix. Kept explicit so the palette is auditable. */
export const FAMILIES = [
  "header",
  "sorts",
  "terms",
  "thms",
  "termdata",
  "thmdata",
  "unify",
  "proof",
  "index",
  "names",
  "varnames",
  "hypnames",
  "strlist",
  "string",
  "padding",
  "unaccounted",
] as const;

export const FAMILY_TITLES: Record<string, string> = {
  file: "file",
  header: "header",
  sorts: "sort table",
  terms: "term table",
  thms: "theorem table",
  termdata: "term data",
  thmdata: "theorem data",
  unify: "unify streams",
  proof: "proof stream",
  index: "index",
  names: "Name table",
  varnames: "VarN table",
  hypnames: "HypN table",
  strlist: "string lists",
  string: "strings",
  padding: "padding",
  unaccounted: "unaccounted",
};

export function familyClass(s: Span): string {
  return "fam-" + family(s.kind);
}

export function bytesLabel(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

export function rangeLabel(s: Span): string {
  return `${hex(s.start)} – ${hex(s.end)} (${s.end - s.start} bytes)`;
}

export interface ValueLine {
  key: string;
  value: string;
  /** Offset to jump to when clicked. */
  link?: number;
  mono?: boolean;
  /** Rich value: pieces with their own links; replaces `value` when present. */
  parts?: JumpPart[];
}

/** Turn a span's decoded value into key/value lines for the inspector. */
export function describeValue(s: Span, L: Layout): ValueLine[] {
  const v = s.value;
  const out: ValueLine[] = [];
  const fam = family(s.kind);
  switch (s.kind) {
    // Bit-packed kinds: the bit view shows the fields; only the raw value goes here.
    case "sorts.entry": {
      const m = v as Record<string, boolean>;
      const raw = L.sorts[s.owner!.id]?.raw ?? 0;
      out.push({ key: "byte", value: `${hex(raw, 2)} = ${raw.toString(2).padStart(8, "0")}b`, mono: true });
      out.push({ key: "modifiers", value: SORT_MODIFIERS.filter((k) => m[k]).join(" ") || "(none)" });
      break;
    }
    case "terms.ret_sort":
      break;
    case "termdata.arg":
    case "termdata.ret":
    case "thmdata.arg": {
      out.push({ key: "u64", value: hex(L.bytes.u64(s.start), 16), mono: true });
      break;
    }
    case "unify.cmd":
    case "proof.cmd":
    case "proof.stmt_cmd":
    case "proof.end": {
      const c = v as Cmd;
      const first = L.bytes.u8(c.offset);
      const table = s.kind === "unify.cmd" ? UNIFY_OPS : s.kind === "proof.cmd" || s.kind === "proof.end" ? PROOF_OPS : undefined;
      const name = table ? table[c.op]?.name : STATEMENTS[c.op]?.name ?? (c.op === 0 ? "END" : undefined);
      out.push({ key: "encoding", value: `${c.size} byte${c.size === 1 ? "" : "s"}: opcode ${hex(first & 0x3f, 2)}${c.dataBytes ? ` + ${c.dataBytes}-byte data` : ", no data"}`, mono: true });
      out.push({ key: "opcode", value: `${hex(c.op, 2)} ${name ?? "(unknown)"}`, mono: true });
      out.push({ key: "data", value: c.dataBytes > 0 ? `${c.data} (${hex(c.data)})` : "0 (implicit: no data bytes follow)", mono: true });
      break;
    }
    case "string":
      out.push({ key: "text", value: JSON.stringify(v), mono: true });
      break;
    default:
      if (typeof v === "number") {
        out.push({ key: "value", value: `${v} (${hex(v)})`, mono: true });
      } else if (typeof v === "bigint") {
        out.push({ key: "value", value: `${v} (${hex(v)})`, mono: true });
      } else if (typeof v === "string") {
        out.push({ key: "value", value: JSON.stringify(v), mono: true });
      }
  }
  if (s.jump && s.target !== undefined) out.push({ key: s.jump.name, value: jumpText(s.jump), parts: s.jump.how, mono: true });
  if (s.owner) {
    const d = L[s.owner.kind === "sort" ? "sorts" : s.owner.kind === "term" ? "terms" : "thms"][s.owner.id];
    const at = s.owner.kind === "sort" ? (d as { span?: Span } | undefined)?.span?.start : (d as { entrySpan?: Span } | undefined)?.entrySpan?.start;
    out.push({ key: "belongs to", value: `${s.owner.kind} ${s.owner.id}: ${declName(L, s.owner)}`, link: at !== s.start ? at : undefined });
  }
  void fam;
  return out;
}

/** Dependency bitmap as the names of the owner's bound variables. */
export function depsLabel(deps: bigint, s: Span, L: Layout): string {
  if (deps === 0n) return "0 (no dependencies)";
  const bits: number[] = [];
  for (let i = 0; i < 55; i++) if ((deps >> BigInt(i)) & 1n) bits.push(i);
  // Try to name the bound variables of the owner.
  const owner = s.owner;
  const args = owner?.kind === "term" ? L.terms[owner.id]?.args : owner?.kind === "thm" ? L.thms[owner.id]?.args : undefined;
  const varNames = owner?.kind === "term" ? L.terms[owner.id]?.varNames : owner?.kind === "thm" ? L.thms[owner.id]?.varNames : undefined;
  const boundNames: string[] = [];
  if (args) {
    args.forEach((a, i) => {
      if (a.bound) boundNames.push(varNames?.[i] ?? `x${i}`);
    });
  }
  const named = bits.map((b) => boundNames[b] ?? `bv${b}`);
  return `${hex(deps)} → {${named.join(", ")}}`;
}

/** Short one-line summary for tree rows. */
export function summary(s: Span): string {
  if (s.kind === "string") return "";
  const v = s.value;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  return "";
}
