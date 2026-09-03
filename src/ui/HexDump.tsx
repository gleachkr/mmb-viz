import { createEffect, createMemo, createSignal, For, Show, on, onMount } from "solid-js";
import { hex2, hexOffset } from "../core/bytes";
import { childrenOf, spanChainAt, type Span } from "../core/spans";
import { loaded, selected, hovered, select, hover, scrollRequest, selectedChain } from "./state";
import { familyClass } from "./format";

const BYTES_PER_ROW = 16;
const ROW_H = 22;
const OVERSCAN = 6;

interface Cell {
  offset: number;
  byte: number;
  cls: string;
  leaf: Span;
}

/**
 * Virtualized 16-bytes-per-row hexdump. Every cell is colored by the family
 * of its leaf span; adjacent leaves alternate shade so boundaries show.
 */
export function HexDump() {
  let scroller!: HTMLDivElement;
  const [scrollTop, setScrollTop] = createSignal(0);
  const [viewH, setViewH] = createSignal(600);

  const length = () => loaded()?.layout.bytes.length ?? 0;
  const rowCount = () => Math.ceil(length() / BYTES_PER_ROW);

  const firstRow = () => Math.max(0, Math.floor(scrollTop() / ROW_H) - OVERSCAN);
  const lastRow = () => Math.min(rowCount(), Math.ceil((scrollTop() + viewH()) / ROW_H) + OVERSCAN);
  const rows = createMemo(() => {
    const out: number[] = [];
    for (let r = firstRow(); r < lastRow(); r++) out.push(r);
    return out;
  });

  onMount(() => {
    const ro = new ResizeObserver(() => setViewH(scroller.clientHeight));
    ro.observe(scroller);
    setViewH(scroller.clientHeight);
  });

  // Scroll to a requested offset, placing it a third of the way down.
  createEffect(
    on(scrollRequest, (req) => {
      if (req.n === 0) return;
      const row = Math.floor(req.offset / BYTES_PER_ROW);
      const target = row * ROW_H - viewH() / 3;
      const top = scroller.scrollTop;
      if (row * ROW_H < top || row * ROW_H + ROW_H > top + viewH()) {
        scroller.scrollTop = Math.max(0, target);
      }
    }),
  );

  // Reset scroll when a new file loads.
  createEffect(on(loaded, () => scroller && (scroller.scrollTop = 0)));

  // The selected leaf and its parent, for highlighting.
  const selLeaf = createMemo(() => {
    const c = selectedChain();
    return c[c.length - 1];
  });
  const selParent = createMemo(() => {
    const c = selectedChain();
    return c.length >= 2 ? c[c.length - 2] : undefined;
  });
  const hovLeaf = createMemo(() => {
    const L = loaded()?.layout;
    const o = hovered();
    if (!L || o < 0) return undefined;
    const c = spanChainAt(L.root, o);
    return c[c.length - 1];
  });

  return (
    <div class="hexdump">
      <div class="hex-header">
        <span class="hex-offset">offset</span>
        <span class="hex-bytes">
          <For each={Array.from({ length: BYTES_PER_ROW }, (_, i) => i)}>{(i) => <span class={`hex-cell hdr${i === 8 ? " gap" : ""}`}>{hex2(i)}</span>}</For>
        </span>
        <span class="hex-ascii-hdr">ascii</span>
      </div>
      <div class="hex-scroller" ref={scroller} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}>
        <div class="hex-spacer" style={{ height: `${rowCount() * ROW_H}px` }}>
          <For each={rows()}>{(r) => <Row row={r} selLeaf={selLeaf()} selParent={selParent()} hovLeaf={hovLeaf()} />}</For>
        </div>
      </div>
      <StatusLine />
    </div>
  );
}

function Row(props: { row: number; selLeaf?: Span; selParent?: Span; hovLeaf?: Span }) {
  const start = () => props.row * BYTES_PER_ROW;

  const cells = createMemo<Cell[]>(() => {
    const L = loaded()?.layout;
    if (!L) return [];
    const out: Cell[] = [];
    const end = Math.min(start() + BYTES_PER_ROW, L.bytes.length);
    let leaf: Span | undefined;
    let parity = 0;
    for (let o = start(); o < end; o++) {
      if (!leaf || o >= leaf.end) {
        const chain = spanChainAt(L.root, o);
        leaf = chain[chain.length - 1]!;
        const parent = chain[chain.length - 2];
        parity = parent ? indexIn(parent, leaf) & 1 : 0;
      }
      let cls = familyClass(leaf) + (parity ? " odd" : "");
      if (o === leaf.start) cls += " lead";
      if (o === leaf.end - 1) cls += " trail";
      if (props.selLeaf && o >= props.selLeaf.start && o < props.selLeaf.end) cls += " sel";
      else if (props.selParent && o >= props.selParent.start && o < props.selParent.end) cls += " ctx";
      cls += edges(props.hovLeaf, o, "hov");
      if (leaf.problems?.length) cls += " prob";
      out.push({ offset: o, byte: L.bytes.u8(o), cls, leaf });
    }
    return out;
  });

  return (
    <div class="hex-row" style={{ top: `${props.row * ROW_H}px` }}>
      <span class="hex-offset">{hexOffset(start())}</span>
      <span class="hex-bytes" onMouseLeave={() => hover(-1)}>
        <For each={cells()}>
          {(c, i) => (
            <span
              class={`hex-cell ${c.cls}${i() === 8 ? " gap" : ""}`}
              onMouseEnter={() => hover(c.offset)}
              onClick={() => select(c.offset)}
            >
              {hex2(c.byte)}
            </span>
          )}
        </For>
      </span>
      <span class="hex-ascii" onMouseLeave={() => hover(-1)}>
        <For each={cells()}>
          {(c) => (
            <span class={`ascii-cell ${c.cls}`} onMouseEnter={() => hover(c.offset)} onClick={() => select(c.offset)}>
              {c.byte >= 0x20 && c.byte < 0x7f ? String.fromCharCode(c.byte) : "·"}
            </span>
          )}
        </For>
      </span>
    </div>
  );
}

/**
 * Classes for a byte inside a highlighted span: `name` on every byte, plus
 * `name-first` / `name-last` at the ends so CSS can draw one border around
 * the whole run rather than one per cell.
 */
function edges(span: Span | undefined, o: number, name: string): string {
  if (!span || o < span.start || o >= span.end) return "";
  let c = " " + name;
  if (o === span.start) c += ` ${name}-first`;
  if (o === span.end - 1) c += ` ${name}-last`;
  return c;
}

function indexIn(parent: Span, leaf: Span): number {
  const kids = childrenOf(parent);
  let lo = 0;
  let hi = kids.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const k = kids[mid]!;
    if (leaf.start < k.start) hi = mid - 1;
    else if (leaf.start >= k.end) lo = mid + 1;
    else return mid;
  }
  return 0;
}

function StatusLine() {
  const chain = createMemo(() => {
    const L = loaded()?.layout;
    const o = hovered() >= 0 ? hovered() : selected();
    if (!L || o < 0) return [];
    return spanChainAt(L.root, o).slice(1);
  });
  return (
    <div class="hex-status">
      <Show when={chain().length} fallback={<span class="muted">Hover a byte to see what it belongs to. Click to inspect.</span>}>
        <For each={chain()}>
          {(s, i) => (
            <>
              <Show when={i() > 0}>
                <span class="crumb-sep">›</span>
              </Show>
              <span class={`crumb ${familyClass(s)}`}>{s.label}</span>
            </>
          )}
        </For>
      </Show>
    </div>
  );
}
