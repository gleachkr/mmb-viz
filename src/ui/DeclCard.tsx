import { createMemo, For, Show } from "solid-js";
import { hex } from "../core/bytes";
import { showStatement, summarize, type DeclSummary } from "../core/decls";
import { type DeclRef } from "../core/spans";
import { disassembleProof } from "../core/streams";
import { Disassembly } from "./Disassembly";
import { loaded, goTo, selected } from "./state";
import { bytesLabel } from "./format";

export const CATEGORY_CLASS: Record<DeclSummary["category"], string> = {
  sort: "fam-sorts",
  term: "fam-terms",
  def: "fam-terms",
  axiom: "fam-thms",
  theorem: "fam-thms",
};

/** The declaration that owns the selected bytes: its statement, streams, and links. */
export function DeclCard(props: { owner: DeclRef }) {
  const L = () => loaded()?.layout;
  const d = createMemo(() => {
    const layout = L();
    return layout ? summarize(layout, props.owner) : undefined;
  });
  const proof = createMemo(() => {
    const layout = L();
    const st = d()?.statement;
    return layout && st && st.hasProof ? disassembleProof(layout, st) : undefined;
  });
  const decl = () => {
    const layout = L();
    const o = props.owner;
    if (!layout) return undefined;
    return o.kind === "sort" ? undefined : o.kind === "term" ? layout.terms[o.id] : layout.thms[o.id];
  };

  return (
    <Show when={d()}>
      {(dd) => (
        <div class="decl-card">
          <div class="decl-head">
            <span class={`cat ${CATEGORY_CLASS[dd().category]}`}>{dd().category}</span>
            <span class="decl-name">{dd().name}</span>
            <span class="muted">
              {dd().ref.kind} {dd().id}
            </span>
          </div>
          <pre class="decl-stmt">{showStatement(dd())}</pre>

          <Show when={dd().unify?.dummies.length}>
            <div class="decl-dummies muted">
              dummies: <For each={dd().unify!.dummies}>{(x, i) => <span>{i() ? ", " : ""}{x.name}</span>}</For>
            </div>
          </Show>

          <div class="decl-links">
            <Show when={dd().ref.kind === "sort"}>
              <button class="link" onClick={() => goTo(L()!.sorts[dd().id]!.span.start)}>sort table entry</button>
            </Show>
            <Show when={decl()?.entrySpan}>{(s) => <button class="link" onClick={() => goTo(s().start)}>table entry {hex(s().start)}</button>}</Show>
            <Show when={decl()?.dataSpan}>{(s) => <button class="link" onClick={() => goTo(s().start)}>binders {hex(s().start)}</button>}</Show>
            <Show when={decl()?.unifySpan}>{(s) => <button class="link" onClick={() => goTo(s().start)}>unify stream {hex(s().start)}</button>}</Show>
            <Show when={dd().statement}>{(st) => <button class="link" onClick={() => goTo(st().offset)}>statement {hex(st().offset)}</button>}</Show>
            <Show when={dd().statement?.hasProof}>
              <button class="link" onClick={() => goTo(dd().statement!.bodyStart)}>
                proof {hex(dd().statement!.bodyStart)} · {bytesLabel(dd().proofBytes)}
              </button>
            </Show>
          </div>

          <Show when={dd().problems.length}>
            <div class="problems">
              <For each={dd().problems.slice(0, 8)}>
                {(p) => (
                  <button class={`problem link-row ${p.severity}`} onClick={() => goTo(p.offset)}>
                    <span class="mono">{hex(p.offset)}</span> {p.message}
                  </button>
                )}
              </For>
            </div>
          </Show>

          <Show when={dd().unify}>{(u) => <Disassembly cmds={u().cmds} selected={selected()} title="unify stream" class="unify" />}</Show>
          <Show when={proof()}>
            {(p) => (
              <>
                <Disassembly cmds={p().cmds} selected={selected()} title={`proof${p().usesSorry ? " (uses Sorry)" : ""}`} class="proof" />
                <div class="heap-map">
                  <span class="muted">heap after the proof: </span>
                  <For each={p().heap.slice(0, 40)}>
                    {(h) => (
                      <Show when={h.from} fallback={<span class="heap-slot" title="argument">{h.index}:{h.name}</span>}>
                        <button class="heap-slot link" onClick={() => goTo(h.from!.offset)} title={`appended by command #${h.from!.index}`}>
                          {h.index}:{h.name}
                        </button>
                      </Show>
                    )}
                  </For>
                  <Show when={p().heap.length > 40}>
                    <span class="muted"> … {p().heap.length - 40} more</span>
                  </Show>
                </div>
              </>
            )}
          </Show>
        </div>
      )}
    </Show>
  );
}
