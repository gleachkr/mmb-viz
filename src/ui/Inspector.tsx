import { createMemo, For, Show } from "solid-js";
import { hex, type Cmd } from "../core/bytes";
import { EXPLAIN, PROOF_OP_EXPLAIN, STMT_EXPLAIN, UNIFY_OP_EXPLAIN, type OpExplanation } from "../core/explain";
import { family, type Problem, type Span, type SpanKind } from "../core/spans";
import { loaded, selectedChain, goTo, history, goBack, problems, scan, selectedOwner } from "./state";
import { describeValue, familyClass, rangeLabel, FAMILY_TITLES } from "./format";
import { BitView, bitLayoutFor } from "./BitView";
import { DeclCard } from "./DeclCard";
import { SpecPanel } from "./SpecPanel";

/** Table rows in the spec that describe a field span kind. */
const ANCHORS: Partial<Record<SpanKind, string>> = {
  "header.magic": "magic",
  "header.version": "version",
  "header.num_sorts": "num_sorts",
  "header.reserved": "reserved",
  "header.num_terms": "num_terms",
  "header.num_thms": "num_thms",
  "header.p_terms": "p_terms",
  "header.p_thms": "p_thms",
  "header.p_proof": "p_proof",
  "header.reserved2": "reserved2",
  "header.p_index": "p_index",
  "terms.num_args": "num_args",
  "terms.ret_sort": "ret_sort",
  "terms.reserved": "reserved",
  "terms.p_data": "p_data",
  "thms.num_args": "num_args",
  "thms.reserved": "reserved",
  "thms.p_data": "p_data",
  "termdata.arg": "args",
  "termdata.ret": "ret",
  "thmdata.arg": "args",
  "index.num_entries": "num_entries",
  "index.entry_type": "type",
  "index.entry_data": "data",
  "index.entry_ptr": "ptr",
  "names.p_proof": "proof",
  "names.p_name": "name",
  "varnames.ptr": "term_vars",
  "hypnames.ptr": "thm_hyps",
  "strlist.count": "num_strs",
  "strlist.ptr": "strs",
};

/** The opcode-level explanation for a command span, if it is one. */
function opExplanation(s: Span): OpExplanation | undefined {
  const c = s.value as Cmd | undefined;
  if (!c) return undefined;
  switch (s.kind) {
    case "proof.cmd":
      return PROOF_OP_EXPLAIN[c.op];
    case "unify.cmd":
      return UNIFY_OP_EXPLAIN[c.op];
    case "proof.stmt_cmd": {
      const name = s.label.split(" ")[0] ?? "";
      return STMT_EXPLAIN[name];
    }
    case "proof.end":
      return STMT_EXPLAIN.END;
    default:
      return undefined;
  }
}

export function Inspector() {
  const chain = createMemo(() => selectedChain());
  const leaf = createMemo(() => chain()[chain().length - 1]);
  const lines = createMemo(() => {
    const L = loaded()?.layout;
    const s = leaf();
    return L && s ? describeValue(s, L) : [];
  });
  const bits = createMemo(() => {
    const L = loaded()?.layout;
    const s = leaf();
    return L && s ? bitLayoutFor(s, L) : undefined;
  });
  const chainProblems = createMemo<Problem[]>(() => chain().flatMap((s) => s.problems ?? []));
  const explain = () => (leaf() ? EXPLAIN[leaf()!.kind] : undefined);
  const op = createMemo(() => (leaf() ? opExplanation(leaf()!) : undefined));
  const specTitle = () => op()?.spec ?? explain()?.spec;
  const specAnchor = () => op()?.anchor ?? (leaf() ? ANCHORS[leaf()!.kind] : undefined);

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
              {op()?.title ?? explain()?.title ?? s().kind}
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

            <Show when={bits()}>{(b) => <BitView layout={b()} />}</Show>

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

            <Show when={chainProblems().length}>
              <div class="problems">
                <For each={chainProblems()}>
                  {(p) => (
                    <div class={`problem ${p.severity}`}>
                      <span class="mono">{hex(p.offset)}</span> {p.message}
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={op()}>
              {(o) => (
                <div class="explain op-explain">
                  <Show when={o().rule}>
                    <pre class="rule">{o().rule}</pre>
                  </Show>
                  <p>{o().text}</p>
                </div>
              )}
            </Show>
            <Show when={explain()}>
              {(e) => (
                <div class="explain">
                  <p>{e().text}</p>
                </div>
              )}
            </Show>

            <Show when={selectedOwner()}>{(o) => <DeclCard owner={o()} />}</Show>

            <SpecPanel section={specTitle()} anchor={specAnchor()} />
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
      <p>Select a byte in the hexdump, a node in the structure tree, or a declaration. This panel decodes the field it belongs to, shows the declaration it is part of, and quotes the relevant part of the MMB spec.</p>
      <p class="muted">Pointer fields are clickable; Alt+Left goes back.</p>
    </div>
  );
}

function ProblemList() {
  const errors = () => problems().filter((p) => p.severity === "error").length;
  return (
    <Show when={problems().length || !scan()}>
      <div class="problem-list">
        <div class="pane-title">
          Problems{" "}
          <span class="muted">
            <Show when={scan()} fallback="(scanning…)">
              ({problems().length}
              {errors() !== problems().length ? `, ${errors()} errors` : ""})
            </Show>
          </span>
        </div>
        <For each={problems().slice(0, 300)}>
          {(p) => (
            <button class={`problem link-row ${p.severity}`} onClick={() => goTo(p.offset)}>
              <span class="mono">{hex(p.offset)}</span> {p.message}
            </button>
          )}
        </For>
        <Show when={problems().length > 300}>
          <div class="muted skipped">… {problems().length - 300} more</div>
        </Show>
      </div>
    </Show>
  );
}
