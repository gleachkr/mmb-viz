import { createMemo, createSignal, For, Show } from "solid-js";
import { type DeclCategory, type DeclSummary } from "../core/decls";
import { CATEGORY_CLASS } from "./DeclCard";
import { goToDecl, scan, selectedOwner } from "./state";

const CATEGORIES: DeclCategory[] = ["sort", "term", "def", "axiom", "theorem"];
const PAGE = 200;

/**
 * The declarations browser: every sort, term, def, axiom, and theorem with
 * its MM0-style signature, filterable by name, kind, visibility, problems,
 * and use of Sorry.
 */
export function Declarations() {
  const [query, setQuery] = createSignal("");
  const [cats, setCats] = createSignal<Set<DeclCategory>>(new Set(CATEGORIES));
  const [onlyLocal, setOnlyLocal] = createSignal(false);
  const [onlyProblems, setOnlyProblems] = createSignal(false);
  const [onlySorry, setOnlySorry] = createSignal(false);
  const [shown, setShown] = createSignal(PAGE);

  const toggleCat = (c: DeclCategory) => {
    const next = new Set(cats());
    if (next.has(c)) next.delete(c);
    else next.add(c);
    setCats(next);
  };

  const filtered = createMemo<DeclSummary[]>(() => {
    const s = scan();
    if (!s) return [];
    const q = query().trim().toLowerCase();
    return s.decls.filter((d) => {
      if (!cats().has(d.category)) return false;
      if (onlyLocal() && !d.local) return false;
      if (onlyProblems() && d.problems.length === 0) return false;
      if (onlySorry() && !(d.statement && s.sorry.has(d.statement.index))) return false;
      if (q && !d.name.toLowerCase().includes(q) && !d.signature.toLowerCase().includes(q)) return false;
      return true;
    });
  });
  const counts = createMemo(() => {
    const s = scan();
    const out: Record<string, number> = {};
    for (const d of s?.decls ?? []) out[d.category] = (out[d.category] ?? 0) + 1;
    return out;
  });
  const isSelected = (d: DeclSummary) => {
    const o = selectedOwner();
    return !!o && o.kind === d.ref.kind && o.id === d.id;
  };

  return (
    <div class="decls">
      <div class="pane-title">Declarations</div>
      <Show when={scan()} fallback={<div class="explain muted">Decoding every stream…</div>}>
        <div class="decl-filters">
          <input
            class="input"
            type="search"
            placeholder="filter by name or signature"
            value={query()}
            onInput={(e) => {
              setQuery(e.currentTarget.value);
              setShown(PAGE);
            }}
          />
          <div class="chips">
            <For each={CATEGORIES}>
              {(c) => (
                <button class={`chip ${CATEGORY_CLASS[c]}`} classList={{ on: cats().has(c) }} onClick={() => toggleCat(c)} title={`show ${c}s`}>
                  {c} <span class="chip-n">{counts()[c] ?? 0}</span>
                </button>
              )}
            </For>
          </div>
          <div class="chips">
            <button class="chip" classList={{ on: onlyLocal() }} onClick={() => setOnlyLocal(!onlyLocal())} title="only LocalDef and LocalThm">
              local
            </button>
            <button class="chip" classList={{ on: onlyProblems() }} onClick={() => setOnlyProblems(!onlyProblems())} title="only declarations with problems">
              problems
            </button>
            <button class="chip" classList={{ on: onlySorry() }} onClick={() => setOnlySorry(!onlySorry())} title="only proofs that use Sorry">
              sorry <span class="chip-n">{scan()!.sorry.size}</span>
            </button>
          </div>
          <div class="decl-count muted">
            {filtered().length} of {scan()!.decls.length}
          </div>
        </div>
        <div class="decl-list">
          <For each={filtered().slice(0, shown())}>
            {(d) => (
              <div class="decl-row" classList={{ selected: isSelected(d), problem: d.problems.length > 0 }} onClick={() => goToDecl(d.ref)} title={d.signature}>
                <i class={`swatch ${CATEGORY_CLASS[d.category]}`} />
                <span class="decl-row-name">{d.name}</span>
                <span class="decl-row-sig">{sigTail(d)}</span>
              </div>
            )}
          </For>
          <Show when={shown() < filtered().length}>
            <button class="btn small more" onClick={() => setShown(shown() + PAGE)}>
              show {Math.min(PAGE, filtered().length - shown())} more of {filtered().length - shown()}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

/** The signature without the keyword and name, for the list column. */
function sigTail(d: DeclSummary): string {
  const i = d.signature.indexOf(d.name);
  const tail = i < 0 ? d.signature : d.signature.slice(i + d.name.length).trim();
  if (d.category === "axiom" || d.category === "theorem") {
    const hyps = d.hyps.map((h) => h.text).join(", ");
    return [tail, hyps, d.concl !== undefined ? `⊢ ${d.concl}` : ""].filter(Boolean).join("  ");
  }
  if (d.category === "def" && d.concl !== undefined) return `${tail} = ${d.concl}`;
  return tail;
}
