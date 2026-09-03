import { createMemo, createSignal, For, Show } from "solid-js";
import { hex2, hexOffset } from "../core/bytes";
import { type DecodedCmd } from "../core/streams";
import { loaded, goTo } from "./state";

const HEAD = 40;
const WINDOW = 25;
const FULL_LIMIT = 120;

/**
 * A compact listing of a decoded stream. Long streams show their beginning
 * plus a window around the selected command; a button reveals the rest.
 */
export function Disassembly(props: { cmds: DecodedCmd[]; selected: number; title: string; class?: string }) {
  const [all, setAll] = createSignal(false);
  const selIndex = createMemo(() => props.cmds.findIndex((c) => props.selected >= c.offset && props.selected < c.offset + c.size));

  const runs = createMemo<[number, number][]>(() => {
    const n = props.cmds.length;
    if (all() || n <= FULL_LIMIT) return [[0, n]];
    const first: [number, number] = [0, Math.min(HEAD, n)];
    const f = selIndex();
    if (f < 0 || f < first[1]) return [first];
    return [first, [Math.max(first[1], f - WINDOW), Math.min(n, f + WINDOW)]];
  });
  const shown = () => runs().reduce((s, r) => s + r[1] - r[0], 0);

  return (
    <div class={`disasm ${props.class ?? ""}`}>
      <div class="disasm-title">
        {props.title}
        <span class="muted"> · {props.cmds.length} commands</span>
      </div>
      <div class="disasm-rows">
        <For each={runs()}>
          {(run, i) => (
            <>
              <Show when={i() > 0}>
                <div class="skipped">… {run[0] - runs()[0]![1]} skipped …</div>
              </Show>
              <For each={props.cmds.slice(run[0], run[1])}>{(c) => <Row cmd={c} selected={c.index === selIndex()} />}</For>
            </>
          )}
        </For>
        <Show when={shown() < props.cmds.length}>
          <button class="btn small more" onClick={() => setAll(true)}>
            show all {props.cmds.length}
          </button>
        </Show>
      </div>
    </div>
  );
}

function Row(props: { cmd: DecodedCmd; selected: boolean }) {
  const bytes = () => {
    const b = loaded()?.layout.bytes;
    if (!b) return "";
    let s = "";
    for (let i = 0; i < props.cmd.size; i++) s += (i ? " " : "") + hex2(b.u8(props.cmd.offset + i));
    return s;
  };
  return (
    <div class="disasm-row" classList={{ selected: props.selected, problem: props.cmd.problems.length > 0, end: props.cmd.op === 0 }} onClick={() => goTo(props.cmd.offset)} title={props.cmd.problems.map((p) => p.message).join("\n") || undefined}>
      <span class="disasm-index">{props.cmd.index}</span>
      <span class="disasm-offset">{hexOffset(props.cmd.offset, 5)}</span>
      <span class="disasm-bytes">{bytes()}</span>
      <span class="disasm-op">
        {props.cmd.mnemonic}
        <Show when={props.cmd.operand !== undefined}>
          <span class="disasm-operand"> {props.cmd.operand}</span>
        </Show>
      </span>
      <span class="disasm-note">
        <Show when={props.cmd.heapIndex !== undefined}>
          <span class="heap-tag" title={`this command appends heap entry ${props.cmd.heapIndex}`}>
            H{props.cmd.heapIndex}
          </span>
        </Show>
        <Show when={props.cmd.note}>
          <Show when={props.cmd.target !== undefined} fallback={<span>{props.cmd.note}</span>}>
            <button
              class="link"
              onClick={(e) => {
                e.stopPropagation();
                goTo(props.cmd.target!);
              }}
            >
              {props.cmd.note}
            </button>
          </Show>
        </Show>
      </span>
    </div>
  );
}
