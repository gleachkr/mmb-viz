import { createMemo, For, Show } from "solid-js";
import { childrenOf, family } from "../core/spans";
import { loaded, selected, goTo } from "./state";
import { FAMILY_TITLES, bytesLabel } from "./format";
import { hex } from "../core/bytes";

interface Segment {
  fam: string;
  start: number;
  end: number;
}

/** Proportional map of the file: consecutive top-level regions of one family merge into a segment. */
export function FileMap() {
  const segments = createMemo<Segment[]>(() => {
    const L = loaded()?.layout;
    if (!L) return [];
    const out: Segment[] = [];
    for (const r of childrenOf(L.root)) {
      const fam = family(r.kind);
      const last = out[out.length - 1];
      // Alignment padding belongs with the structure it follows.
      if (last && last.end === r.start && (last.fam === fam || fam === "padding")) last.end = r.end;
      else out.push({ fam, start: r.start, end: r.end });
    }
    return out;
  });

  const total = () => loaded()?.layout.bytes.length ?? 1;
  const MIN = 0.25; // percent, so tiny regions stay visible

  const legend = createMemo(() => {
    const L = loaded()?.layout;
    if (!L) return [];
    const order = Object.keys(FAMILY_TITLES);
    return [...L.familyBytes.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]));
  });

  return (
    <div class="filemap">
      <div class="filemap-bar" role="list">
        <For each={segments()}>
          {(seg) => (
            <div
              role="listitem"
              class={`filemap-seg fam-${seg.fam}`}
              style={{ "flex-grow": String(Math.max(((seg.end - seg.start) / total()) * 100, MIN)) }}
              title={`${FAMILY_TITLES[seg.fam] ?? seg.fam}: ${hex(seg.start)} – ${hex(seg.end)} (${bytesLabel(seg.end - seg.start)})`}
              onClick={() => goTo(seg.start)}
            />
          )}
        </For>
        <Show when={selected() >= 0}>
          <div class="filemap-cursor" style={{ left: `${(selected() / total()) * 100}%` }} />
        </Show>
      </div>
      <div class="filemap-legend">
        <For each={legend()}>
          {([fam, bytes]) => (
            <span class="legend-item">
              <i class={`swatch fam-${fam}`} />
              {FAMILY_TITLES[fam] ?? fam}
              <span class="muted"> {bytesLabel(bytes)}</span>
            </span>
          )}
        </For>
      </div>
    </div>
  );
}
