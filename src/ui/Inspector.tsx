import { createMemo, For, Show } from "solid-js";
import { hex } from "../core/bytes";
import { EXPLAIN } from "../core/explain";
import { type Problem } from "../core/spans";
import { loaded, selectedChain, goTo, history, goBack } from "./state";
import { describeValue, familyClass, rangeLabel, FAMILY_TITLES } from "./format";
import { family } from "../core/spans";

export function Inspector() {
  const chain = createMemo(() => selectedChain());
  const leaf = createMemo(() => chain()[chain().length - 1]);
  const lines = createMemo(() => {
    const L = loaded()?.layout;
    const s = leaf();
    return L && s ? describeValue(s, L) : [];
  });
  const problems = createMemo<Problem[]>(() => chain().flatMap((s) => s.problems ?? []));
  const explain = () => (leaf() ? EXPLAIN[leaf()!.kind] : undefined);

  return (
    <div class="inspector">
      <div class="pane-title">Inspector</div>
      <Show when={leaf()} fallback={<NothingSelected />}>
        {(s) => (
          <>
            <div class="crumbs">
              <For each={chain().slice(1)}>
                {(c, i) => (
                  <>
                    <Show when={i() > 0}>
                      <span class="crumb-sep">›</span>
                    </Show>
                    <button class={`crumb link ${familyClass(c)}`} onClick={() => goTo(c.start)}>
                      {c.label}
                    </button>
                  </>
                )}
              </For>
            </div>

            <h2 class="insp-title">
              <i class={`swatch big ${familyClass(s())}`} />
              {explain()?.title ?? s().kind}
            </h2>
            <div class="insp-label">{s().label}</div>
            <div class="insp-range mono">{rangeLabel(s())}</div>
            <div class="insp-kind muted">
              {FAMILY_TITLES[family(s().kind)]} · <code>{s().kind}</code>
            </div>

            <Show when={lines().length}>
              <table class="kv">
                <tbody>
                  <For each={lines()}>
                    {(l) => (
                      <tr>
                        <th>{l.key}</th>
                        <td class={l.mono ? "mono" : ""}>
                          <Show when={l.link !== undefined} fallback={l.value}>
                            <button class="link" onClick={() => goTo(l.link!)}>
                              {l.value}
                            </button>
                          </Show>
                        </td>
                      </tr>
                    )}
                  </For>
                </tbody>
              </table>
            </Show>

            <div class="insp-actions">
              <Show when={s().target !== undefined && s().target! > 0}>
                <button class="btn small" onClick={() => goTo(s().target!)}>
                  follow pointer → {hex(s().target!)}
                </button>
              </Show>
              <Show when={history().length}>
                <button class="btn small" onClick={goBack}>
                  ← back
                </button>
              </Show>
            </div>

            <Show when={problems().length}>
              <div class="problems">
                <For each={problems()}>
                  {(p) => (
                    <div class={`problem ${p.severity}`}>
                      <span class="mono">{hex(p.offset)}</span> {p.message}
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={explain()}>
              {(e) => (
                <div class="explain">
                  <p>{e().text}</p>
                  <Show when={e().spec}>
                    <p class="spec-ref muted">Spec: {e().spec}</p>
                  </Show>
                </div>
              )}
            </Show>
          </>
        )}
      </Show>
      <ProblemList />
    </div>
  );
}

function NothingSelected() {
  return (
    <div class="explain">
      <p>Select a byte in the hexdump or a node in the structure tree. This panel decodes the field it belongs to and quotes the relevant part of the MMB spec.</p>
      <p class="muted">Pointer fields are clickable; Alt+Left goes back.</p>
    </div>
  );
}

function ProblemList() {
  const problems = () => loaded()?.layout.problems ?? [];
  return (
    <Show when={problems().length}>
      <div class="problem-list">
        <div class="pane-title">
          Problems <span class="muted">({problems().length})</span>
        </div>
        <For each={problems().slice(0, 200)}>
          {(p) => (
            <button class={`problem link-row ${p.severity}`} onClick={() => goTo(p.offset)}>
              <span class="mono">{hex(p.offset)}</span> {p.message}
            </button>
          )}
        </For>
      </div>
    </Show>
  );
}
