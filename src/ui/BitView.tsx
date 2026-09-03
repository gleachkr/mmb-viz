import { For, Show } from "solid-js";
import { hex } from "../core/bytes";
import { declName, type Layout } from "../core/layout";
import { PROOF_OPS, STATEMENTS, UNIFY_OPS } from "../core/opcodes";
import { type Span } from "../core/spans";
import { depsLabel } from "./format";
import { goTo } from "./state";

export interface BitField {
  name: string;
  /** Inclusive bit range, LSB = 0. */
  lo: number;
  hi: number;
  /** Decoded value as text. */
  value: string;
  /** Highlight as a violation. */
  bad?: boolean;
  /** Offset to jump to (the sort byte for sort fields). */
  link?: number;
}

export interface BitLayout {
  width: number;
  raw: bigint;
  fields: BitField[];
}

function bitsOf(raw: bigint, lo: number, hi: number): string {
  let s = "";
  for (let i = hi; i >= lo; i--) s += (raw >> BigInt(i)) & 1n ? "1" : "0";
  return s;
}

function fieldValue(raw: bigint, lo: number, hi: number): bigint {
  return (raw >> BigInt(lo)) & ((1n << BigInt(hi - lo + 1)) - 1n);
}

/** Bit layout for the bit-packed span kinds; undefined for everything else. */
export function bitLayoutFor(s: Span, L: Layout): BitLayout | undefined {
  const b = L.bytes;
  const sortLabel = (id: number) => `${id} ${L.sorts[id] ? declName(L, { kind: "sort", id }) : "(out of range)"}`;
  const sortLink = (id: number) => L.sorts[id]?.span?.start;
  switch (s.kind) {
    case "termdata.arg":
    case "termdata.ret":
    case "thmdata.arg": {
      const raw = b.u64(s.start);
      const sort = Number(fieldValue(raw, 56, 62));
      const reserved = fieldValue(raw, 55, 55) === 1n;
      const deps = fieldValue(raw, 0, 54);
      const bound = fieldValue(raw, 63, 63) === 1n;
      return {
        width: 64,
        raw,
        fields: [
          { name: "bound", lo: 63, hi: 63, value: bound ? "1: bound variable" : "0", bad: s.kind === "termdata.ret" && bound },
          { name: "sort", lo: 56, hi: 62, value: sortLabel(sort), bad: sort >= L.sorts.length, link: sortLink(sort) },
          { name: "reserved", lo: 55, hi: 55, value: reserved ? "1 (must be 0)" : "0", bad: reserved },
          { name: "deps", lo: 0, hi: 54, value: depsLabel(deps, s, L) },
        ],
      };
    }
    case "terms.ret_sort": {
      const raw = BigInt(b.u8(s.start));
      const sort = Number(fieldValue(raw, 0, 6));
      return {
        width: 8,
        raw,
        fields: [
          { name: "is_def", lo: 7, hi: 7, value: raw >> 7n ? "1: def" : "0: term" },
          { name: "ret_sort", lo: 0, hi: 6, value: sortLabel(sort), bad: sort >= L.sorts.length, link: sortLink(sort) },
        ],
      };
    }
    case "sorts.entry": {
      const raw = BigInt(b.u8(s.start));
      const flag = (i: number, name: string): BitField => ({ name, lo: i, hi: i, value: (raw >> BigInt(i)) & 1n ? "1" : "0" });
      const unused = fieldValue(raw, 4, 7);
      return {
        width: 8,
        raw,
        fields: [{ name: "unused", lo: 4, hi: 7, value: unused ? `${unused} (must be 0)` : "0", bad: unused !== 0n }, flag(3, "free"), flag(2, "provable"), flag(1, "strict"), flag(0, "pure")],
      };
    }
    case "unify.cmd":
    case "proof.cmd":
    case "proof.stmt_cmd":
    case "proof.end": {
      const raw = BigInt(b.u8(s.start));
      const tag = Number(raw >> 6n);
      const op = Number(raw & 0x3fn);
      const table = s.kind === "unify.cmd" ? UNIFY_OPS : s.kind === "proof.cmd" ? PROOF_OPS : s.kind === "proof.stmt_cmd" ? STATEMENTS : PROOF_OPS;
      const name = table[op]?.name ?? (op === 0 ? "END" : "unknown");
      return {
        width: 8,
        raw,
        fields: [
          { name: "len", lo: 6, hi: 7, value: `${tag}: ${[0, 1, 2, 4][tag]} byte${tag === 1 ? "" : "s"} follow` },
          { name: "opcode", lo: 0, hi: 5, value: `${hex(op, 2)} ${name}`, bad: !table[op] && op !== 0 },
        ],
      };
    }
    default:
      return undefined;
  }
}

/**
 * A bit-field diagram: one box per field, widest bit range first, with the
 * field name, its bits, and the decoded value.
 */
export function BitView(props: { layout: BitLayout }) {
  const fields = () => props.layout.fields.slice().sort((a, b) => b.hi - a.hi);
  return (
    <div class="bitview">
      <div class="bitview-strip">
        <For each={fields()}>
          {(f) => (
            <div class="bitfield" classList={{ bad: !!f.bad, flag: f.hi === f.lo }} style={{ "flex-grow": String(f.hi - f.lo + 1) }} title={`bits ${f.lo}${f.hi !== f.lo ? `–${f.hi}` : ""}: ${f.value}`}>
              <div class="bitfield-name">
                {f.name}
                <span class="bitfield-range">{f.hi === f.lo ? ` ${f.lo}` : ` ${f.hi}–${f.lo}`}</span>
              </div>
              <div class="bitfield-bits">{bitsOf(props.layout.raw, f.lo, f.hi)}</div>
            </div>
          )}
        </For>
      </div>
      <table class="kv bitview-values">
        <tbody>
          <For each={fields()}>
            {(f) => (
              <tr classList={{ bad: !!f.bad }}>
                <th>{f.name}</th>
                <td>
                  <Show when={f.link !== undefined} fallback={f.value}>
                    <button class="link" onClick={() => goTo(f.link!)}>
                      {f.value}
                    </button>
                  </Show>
                  <Show when={f.bad}>
                    <span class="bad-mark"> ✗</span>
                  </Show>
                </td>
              </tr>
            )}
          </For>
        </tbody>
      </table>
    </div>
  );
}
