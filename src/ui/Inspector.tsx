import { createMemo, For, Show } from "solid-js";
import { hex, type Cmd } from "../core/bytes";
import { EXPLAIN, PROOF_OP_EXPLAIN, STMT_EXPLAIN, UNIFY_OP_EXPLAIN, type OpExplanation } from "../core/explain";
import { family, type Problem, type Span, type SpanKind } from "../core/spans";
import { loaded, selectedChain, goTo, history, goBack, problems, scan, selectedOwner, inspTab, setInspTab, type InspTab } from "./state";
import { describeValue, familyClass, rangeLabel, FAMILY_TITLES } from "./format";
import { BitView, bitLayoutFor } from "./BitView";
import { DeclCard } from "./DeclCard";
import { SpecPanel } from "./SpecPanel";
import { declName } from "../core/layout";

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

const TABS: { id: InspTab; label: string; key: string }[] = [
  { id: "field", label: "Field", key: "1" },
  { id: "decl", label: "Declaration", key: "2" },
  { id: "spec", label: "Spec", key: "3" },
  { id: "problems", label: "Problems", key: "4" },
];

export function Inspector() {
  const chain = createMemo(() => selectedChain());
  const leaf = createMemo(() => chain()[chain().length - 1]);
  const explain = () => (leaf() ? EXPLAIN[leaf()!.kind] : undefined);
  const op = createMemo(() => (leaf() ? opExplanation(leaf()!) : undefined));
  const specTitle = () => op()?.spec ?? explain()?.spec;
  const specAnchor = () => op()?.anchor ?? (leaf() ? ANCHORS[leaf()!.kind] : undefined);
  const ownerName = () => {
    const L = loaded()?.layout;
    const o = selectedOwner();
    return L && o ? declName(L, o) : undefined;
  };
  const errorCount = () => problems().filter((p) => p.severity === "error").length;

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
          </>
        )}
      </Show>

      <div class="tabs insp-tabs" role="tablist">
        <For each={TABS}>
          {(t) => (
            <button
              class="tab"
              role="tab"
              classList={{ on: inspTab() === t.id, empty: (t.id === "decl" && !selectedOwner()) || (t.id === "spec" && !specTitle()) || (t.id === "field" && !leaf()) }}
              onClick={() => setInspTab(t.id)}
              title={`${t.label} (key ${t.key})`}
            >
              {t.label}
              <Show when={t.id === "problems" && scan()}>
                <span class="tab-n" classList={{ bad: errorCount() > 0 }}>
                  {problems().length}
                </span>
              </Show>
              <Show when={t.id === "decl" && ownerName()}>
                <span class="tab-n">{ownerName()}</span>
              </Show>
            </button>
          )}
        </For>
      </div>

      <div class="insp-body" classList={{ [`insp-${inspTab()}`]: true }}>
        <Show when={inspTab() === "field"}>
          <Show when={leaf()}>{(s) => <FieldTab span={s()} chain={chain()} op={op()} />}</Show>
        </Show>
        <Show when={inspTab() === "decl"}>
          <Show when={selectedOwner()} fallback={<div class="explain muted">{leaf() ? "These bytes do not belong to any declaration." : "Nothing selected."}</div>}>
            {(o) => <DeclCard owner={o()} />}
          </Show>
        </Show>
        <Show when={inspTab() === "spec"}>
          <Show when={specTitle()} fallback={<div class="explain muted">{leaf() ? "No spec section is tied to this field." : "Nothing selected."}</div>}>
            <SpecPanel section={specTitle()} anchor={specAnchor()} full />
          </Show>
        </Show>
        <Show when={inspTab() === "problems"}>
          <ProblemList />
        </Show>
      </div>
    </div>
  );
}

/** The selected field: decoded values, bit layout, jumps, problems, and what it means. */
function FieldTab(props: { span: Span; chain: Span[]; op: OpExplanation | undefined }) {
  const lines = createMemo(() => {
    const L = loaded()?.layout;
    return L ? describeValue(props.span, L) : [];
  });
  const bits = createMemo(() => {
    const L = loaded()?.layout;
    return L ? bitLayoutFor(props.span, L) : undefined;
  });
  const chainProblems = createMemo<Problem[]>(() => props.chain.flatMap((s) => s.problems ?? []));
  const explain = () => EXPLAIN[props.span.kind];
  const jump = () => (props.span.target !== undefined && props.span.target > 0 ? props.span.jump ?? "follow pointer" : undefined);

  return (
    <>
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
        <Show when={jump()}>
          <button class="btn small" onClick={() => goTo(props.span.target!)}>
            {jump()} → {hex(props.span.target!)}
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

      <Show when={props.op}>
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
    </>
  );
}

function NothingSelected() {
  return (
    <div class="explain">
      <p>Select a byte in the hexdump, a node in the structure tree, or a declaration. The tabs below decode the field it belongs to, show the declaration it is part of, and quote the relevant part of the MMB spec.</p>
      <p class="muted">Pointer fields are clickable; Alt+Left goes back.</p>
    </div>
  );
}

function ProblemList() {
  const errors = () => problems().filter((p) => p.severity === "error").length;
  return (
    <div class="problem-list">
      <div class="problem-summary muted">
        <Show when={scan()} fallback="Scanning every stream…">
          <Show when={problems().length} fallback="No problems found in this file.">
            {problems().length} problem{problems().length === 1 ? "" : "s"}
            {errors() !== problems().length ? `, ${errors()} error${errors() === 1 ? "" : "s"}` : ""} in the whole file
          </Show>
        </Show>
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
  );
}
