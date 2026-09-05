import { createEffect, createMemo, createRoot, createSignal, For, on, Show } from "solid-js";
import { hex, hex2, hexOffset } from "../core/bytes";
import { categoryOf, showStatement, summarize } from "../core/decls";
import { picture, ruleSchema, type PictureColumn } from "../core/rules";
import { declName, type Statement } from "../core/layout";
import { UNIFY_MODE_TEXT, type Check, type ExprNode, type HeapEntry, type Machine, type StackEntry } from "../core/machine";
import { childrenOf, type Span } from "../core/spans";
import { CATEGORY_CLASS } from "./DeclCard";
import { familyClass } from "./format";
import { debugGoto, debugStep, debugStepBackOver, debugStepOver, debugView, stepBackOverTarget, stepOverTarget, goTo, loaded, openDebugger, reveal, setCenterTab, type DebugView } from "./state";

const KIND_MARK: Record<StackEntry["kind"], string> = { expr: "", proof: "|-", conv: "=", coconv: "=?=" };

/** The entry's expressions without the kind marker (the badge shows it). */
function entryBody(m: Machine, e: StackEntry | HeapEntry): string {
  return "e" in e ? m.show(e.e) : `${m.show(e.e1)} ${e.kind === "conv" ? "=" : "=?="} ${m.show(e.e2)}`;
}

/**
 * The debugger: one statement's verification, one command at a time. The
 * streams on the left show where the machine is; the panels on the right
 * show the stack, heap, hypotheses, and (inside a unification) the unify
 * stack and heap; the narrative below says what the last step did, what it
 * checked, and which bytes it read.
 */
export function Debugger() {
  const L = () => loaded()?.layout;
  // Keep the inspector on the command that just ran.
  createEffect(
    on(
      () => debugView()?.record?.span,
      (span) => span && reveal(span.start),
    ),
  );
  // Node ids belong to one trace: forget the focused node when the session changes.
  const trace = createMemo(() => debugView()?.trace);
  createEffect(
    on(
      trace,
      () => {
        setPinNode(undefined);
        setHoverNode(undefined);
      },
    ),
  );
  return (
    <div class="debugger">
      <Show when={debugView()} fallback={<DebugWelcome />}>
        {(v) => (
          <>
            <Head v={v()} />
            <div class="dbg-body">
              <section class="dbg-streams">
                <ProofStream v={v()} />
                <Show when={v().snap.unify}>{(u) => <UnifyStream v={v()} frame={u()} />}</Show>
              </section>
              <section class="dbg-state">
                <StatePanels v={v()} />
                <NodesPanel v={v()} />
              </section>
            </div>
            <Narrative v={v()} />
          </>
        )}
      </Show>
      <Show when={!L()}>
        <div class="explain muted">No file loaded.</div>
      </Show>
    </div>
  );
}

function DebugWelcome() {
  const L = () => loaded()?.layout;
  const first = () => L()?.statements.find((s) => s.hasProof);
  return (
    <div class="dbg-welcome">
      <div class="explain">
        <p>The debugger runs one statement's proof through the MMB stack machine a command at a time. Open a declaration in the browser on the left and press its debug button, or pick a command in the hexdump and choose "debug this command" in the inspector.</p>
        <p class="muted">Keys: . step, , back, &gt; step over a unification, &lt; back over one, r restart, e run to the end, v switch between hexdump and debugger.</p>
      </div>
      <Show when={first()}>{(st) => <button class="btn" onClick={() => openDebugger(st())}>Debug the first proof: {declName(L()!, st().decl!)}</button>}</Show>
    </div>
  );
}

function Head(props: { v: DebugView }) {
  const L = () => loaded()!.layout;
  const st = () => props.v.trace.stmt;
  const name = () => (st().decl ? declName(L(), st().decl!) : "?");
  const cat = () => (st().decl ? categoryOf(L(), st().decl!) : "theorem");
  const sig = createMemo(() => (st().decl ? summarize(L(), st().decl!) : undefined));
  const n = () => props.v.trace.length;
  const result = () => props.v.trace.result;
  const proofs = createMemo(() => L().statements.filter((s) => s.hasProof));
  const neighbor = (dir: -1 | 1): Statement | undefined => {
    const list = proofs();
    const i = list.indexOf(st());
    return list[i + dir];
  };
  return (
    <header class="dbg-head">
      <div class="dbg-title">
        <span class={`cat ${CATEGORY_CLASS[cat()]}`}>{cat()}</span>
        <span class="decl-name">{name()}</span>
        <span class="muted mono">
          statement {st().index} · {hex(st().offset)} · {n()} steps
        </span>
        <span class={`dbg-status ${result().status}`} title={result().error?.message}>
          {result().status === "ok" ? "verifies" : result().status === "sorry" ? "uses Sorry" : "fails"}
        </span>
        <span class="dbg-nav">
          <button class="link small" disabled={!neighbor(-1)} onClick={() => neighbor(-1) && openDebugger(neighbor(-1)!)}>
            ‹ previous proof
          </button>
          <button class="link small" disabled={!neighbor(1)} onClick={() => neighbor(1) && openDebugger(neighbor(1)!)}>
            next proof ›
          </button>
        </span>
      </div>
      <Show when={sig()}>
        {(d) => (
          <div class="dbg-sig" classList={{ folded: folded().has("sig") }}>
            <button class="dbg-sig-fold" onClick={() => toggleFold("sig")} title={folded().has("sig") ? "show the full statement" : "show only the signature"}>
              <span class="dbg-fold">▾</span>
            </button>
            <pre class="dbg-sig-text">{folded().has("sig") ? d().signature : showStatement(d())}</pre>
          </div>
        )}
      </Show>
      <div class="dbg-controls">
        <button class="btn small" onClick={() => debugGoto(0)} title="restart (r)" disabled={props.v.step === 0}>
          ⏮ restart
        </button>
        <button class="btn small" onClick={debugStepBackOver} title="back over a unification (<)" disabled={stepBackOverTarget(props.v.trace.records, props.v.step) === undefined}>
          ◀◀
        </button>
        <button class="btn small" onClick={() => debugStep(-1)} title="step back (,)" disabled={props.v.step === 0}>
          ◀ back
        </button>
        <button class="btn small primary" onClick={() => debugStep(1)} title="step (.)" disabled={props.v.step >= n()}>
          step ▶
        </button>
        <button class="btn small" onClick={debugStepOver} title="step over a unification (>)" disabled={stepOverTarget(props.v.trace.records, props.v.step) === undefined}>
          ▶▶
        </button>
        <button class="btn small" onClick={() => debugGoto(n())} title={result().status === "error" ? "run to the error (e)" : "run to the end (e)"} disabled={props.v.step >= n()}>
          {result().status === "error" ? "⏭ to error" : "⏭ to end"}
        </button>
        <span class="dbg-counter mono">
          step {props.v.step} / {n()}
        </span>
        <input class="dbg-slider" type="range" min={0} max={n()} value={props.v.step} onInput={(e) => debugGoto(Number(e.currentTarget.value))} />
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Streams

const HEAD = 30;
const WINDOW = 40;
const FULL_LIMIT = 400;

function StreamView(props: { title: string; sub?: string; spans: Span[]; executed: number; current?: Span; pick: (i: number) => void; class?: string }) {
  const [all, setAll] = createSignal(false);
  const runs = createMemo<[number, number][]>(() => {
    const n = props.spans.length;
    if (all() || n <= FULL_LIMIT) return [[0, n]];
    const first: [number, number] = [0, Math.min(HEAD, n)];
    const f = props.executed;
    if (f < first[1]) return [first, [first[1], Math.min(n, first[1] + WINDOW)]];
    return [first, [Math.max(first[1], f - WINDOW), Math.min(n, f + WINDOW)]];
  });
  const bytesOf = (s: Span) => {
    const b = loaded()?.layout.bytes;
    if (!b) return "";
    let t = "";
    for (let o = s.start; o < s.end && o < s.start + 5; o++) t += (o > s.start ? " " : "") + hex2(b.u8(o));
    return t;
  };
  let box!: HTMLDivElement;
  // Keep the executing row in view.
  createEffect(
    on(
      () => props.executed,
      () => {
        // Scroll only the rows box: scrollIntoView would also scroll the
        // debugger pane and shift the state panels out of view.
        const el = box?.querySelector<HTMLElement>(".dbg-row.next, .dbg-row.cur");
        if (!el) return;
        const top = el.offsetTop; // .dbg-rows is positioned, so this is box-relative
        const bottom = top + el.offsetHeight;
        if (top < box.scrollTop) box.scrollTop = top;
        else if (bottom > box.scrollTop + box.clientHeight) box.scrollTop = bottom - box.clientHeight;
      },
    ),
  );
  return (
    <div class={`dbg-stream ${props.class ?? ""}`}>
      <div class="dbg-stream-title">
        {props.title}
        <Show when={props.sub}>
          <span class="muted"> · {props.sub}</span>
        </Show>
        <span class="muted"> · {props.spans.length} commands</span>
      </div>
      <div class="dbg-rows" ref={box}>
        <For each={runs()}>
          {(run, ri) => (
            <>
              <Show when={ri() > 0 && run[0] > runs()[0]![1]}>
                <div class="skipped muted">… {run[0] - runs()[0]![1]} skipped …</div>
              </Show>
              <For each={props.spans.slice(run[0], run[1])}>
                {(s, k) => {
                  const i = () => run[0] + k();
                  return (
                    <div
                      class="dbg-row"
                      classList={{ done: i() < props.executed, next: i() === props.executed, cur: props.current === s, problem: !!s.problems?.length, end: s.label.startsWith("END") }}
                      onClick={() => props.pick(i())}
                      title={s.problems?.map((p) => p.message).join("\n") || `click to run up to this command`}
                    >
                      <span class="dbg-marker">{i() === props.executed ? "▶" : props.current === s ? "●" : ""}</span>
                      <span class="disasm-index">{i()}</span>
                      <span class="disasm-offset">{hexOffset(s.start, 5)}</span>
                      <span class="disasm-bytes">{bytesOf(s)}</span>
                      <span class="disasm-op">{s.label}</span>
                    </div>
                  );
                }}
              </For>
            </>
          )}
        </For>
        <Show when={!all() && props.spans.length > FULL_LIMIT}>
          <button class="btn small more" onClick={() => setAll(true)}>
            show all {props.spans.length}
          </button>
        </Show>
      </div>
    </div>
  );
}

function ProofStream(props: { v: DebugView }) {
  const st = () => props.v.trace.stmt;
  const stmtCmd = () => childrenOf(st().span).find((s) => s.kind === "proof.stmt_cmd") ?? st().span;
  const spans = createMemo(() => [stmtCmd(), ...props.v.m.cmds]);
  // Which step ran each command: proof commands run at most once.
  const stepOf = createMemo(() => {
    const map = new Map<Span, number>();
    props.v.trace.records.forEach((r, i) => {
      if (r.level !== "unify") map.set(r.span, i + 1);
    });
    return map;
  });
  const executed = () => (props.v.snap.phase === "init" ? 0 : props.v.snap.pc + 1);
  const current = () => (props.v.record && props.v.record.level !== "unify" ? props.v.record.span : undefined);
  return (
    <StreamView
      title="proof stream"
      sub={props.v.m.mode === "def" ? "building the def's value" : "proving the statement"}
      spans={spans()}
      executed={executed()}
      current={current()}
      class="proof"
      pick={(i) => {
        const k = stepOf().get(spans()[i]!);
        if (k !== undefined) debugGoto(k);
        else debugGoto(props.v.trace.length);
      }}
    />
  );
}

function UnifyStream(props: { v: DebugView; frame: NonNullable<DebugView["snap"]["unify"]> }) {
  const L = () => loaded()!.layout;
  const current = () => (props.v.record?.level === "unify" ? props.v.record.span : undefined);
  return (
    <StreamView
      title={`unify stream of ${declName(L(), props.frame.owner)}`}
      sub={UNIFY_MODE_TEXT[props.frame.mode]}
      spans={props.frame.cmds}
      executed={props.frame.pc}
      current={current()}
      class="unify"
      pick={(i) => {
        const span = props.frame.cmds[i]!;
        const recs = props.v.trace.records;
        for (let k = props.v.frameStart + 1; k < recs.length; k++) {
          const r = recs[k]!;
          if (r.closes) break;
          if (r.level === "unify" && r.span === span) {
            debugGoto(k + 1);
            return;
          }
        }
      }}
    />
  );
}

// ---------------------------------------------------------------------------
// State panels

function EntryText(props: { m: Machine; e: StackEntry | HeapEntry }) {
  const ids = () => ("e" in props.e ? [props.e.e] : [props.e.e1, props.e.e2]);
  return (
    <span class="dbg-entry" classList={{ hit: ids().some((i) => i === focusNode()), has: ids().some((i) => containing().has(i)) }}>
      <Show when={KIND_MARK[props.e.kind]}>
        <span class="dbg-kind" title={props.e.kind}>
          {KIND_MARK[props.e.kind]}
        </span>
      </Show>
      <span class="dbg-expr">{entryBody(props.m, props.e)}</span>
      <span class="node-id muted" title="node ids: equality in MMB is identity of nodes">
        <For each={ids()}>{(i) => <NodeRef id={i} />}</For>
      </span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// Node focus: hovering or pinning a node id highlights every pointer to it

const [hoverNode, setHoverNode] = createSignal<number>();
const [pinNode, setPinNode] = createSignal<number>();
/** The node the reader is looking at: hovered, else pinned. */
const focusNode = () => hoverNode() ?? pinNode();
const NO_NODES: ReadonlySet<number> = new Set();
/** Ids of nodes that have the focused node as a subterm (itself included): arguments precede their parents, so one pass suffices. */
const containing: () => ReadonlySet<number> = createRoot(() =>
  createMemo(() => {
    const f = focusNode();
    const v = debugView();
    if (f === undefined || !v || f >= v.m.arenaLen) return NO_NODES;
    const out = new Set<number>([f]);
    for (let i = f + 1; i < v.m.arenaLen; i++) {
      const n = v.m.arena[i]!;
      if (n.args?.some((a) => out.has(a))) out.add(i);
    }
    return out;
  }),
);

/** A `#N` node id that pins its node on click; inside the nodes panel it also focuses on hover. */
function NodeRef(props: { id: number; hover?: boolean }) {
  return (
    <span
      class="node-ref"
      classList={{ focus: focusNode() === props.id, pinned: pinNode() === props.id }}
      onMouseEnter={() => props.hover && setHoverNode(props.id)}
      onMouseLeave={() => props.hover && setHoverNode(undefined)}
      onClick={(e) => {
        e.stopPropagation();
        setPinNode(pinNode() === props.id ? undefined : props.id);
      }}
      title={props.hover ? "node id: every pointer to this node is highlighted; click to pin" : "node id: click to pin and highlight every pointer to this node"}
    >
      #{props.id}
    </span>
  );
}

/** Which state panels are folded away, by panel class; remembered across sessions. */
const [folded, setFolded] = createSignal<ReadonlySet<string>>(readFolded());
function readFolded(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem("mmb-viz.dbg-folded") ?? "[]") as string[]);
  } catch {
    return new Set();
  }
}
function toggleFold(key: string): void {
  const next = new Set(folded());
  if (!next.delete(key)) next.add(key);
  setFolded(next);
  try {
    localStorage.setItem("mmb-viz.dbg-folded", JSON.stringify([...next]));
  } catch {
    /* private mode: the fold just does not persist */
  }
}

/** A panel's title row with the disclosure triangle. */
function PanelTitle(props: { id: string; title: string; count: number }) {
  return (
    <button class="dbg-panel-title" classList={{ folded: folded().has(props.id) }} onClick={() => toggleFold(props.id)} title={folded().has(props.id) ? "show" : "hide"}>
      <span class="dbg-fold">▾</span>
      {props.title} <span class="muted">{props.count}</span>
    </button>
  );
}

function Panel(props: { title: string; count: number; empty: string; children: unknown; class: string }) {
  return (
    <div class={`dbg-panel ${props.class}`} classList={{ folded: folded().has(props.class) }}>
      <PanelTitle id={props.class} title={props.title} count={props.count} />
      <Show when={!folded().has(props.class)}>
        <Show when={props.count} fallback={<div class="dbg-empty muted">{props.empty}</div>}>
          <div class="dbg-panel-rows">{props.children as never}</div>
        </Show>
      </Show>
    </div>
  );
}

function StatePanels(props: { v: DebugView }) {
  const m = () => props.v.m;
  const s = () => props.v.snap;
  const r = () => props.v.record;
  const newStack = () => r()?.pushes.length ?? 0;
  const newHeap = () => r()?.heapPushes.length ?? 0;
  const newUStack = () => r()?.upushes.length ?? 0;
  const newUHeap = () => r()?.uheapPushes.length ?? 0;
  return (
    <>
      <Panel title="stack" count={s().stack.length} empty="empty" class="stack">
        <For each={s().stack}>
          {(e, i) => (
            <div class="dbg-srow" classList={{ new: i() >= s().stack.length - newStack(), top: i() === s().stack.length - 1 }}>
              <span class="dbg-idx muted" title={i() === s().stack.length - 1 ? "top of the stack" : `stack position ${i()} from the bottom`}>
                {i() === s().stack.length - 1 ? "top" : i()}
              </span>
              <EntryText m={m()} e={e} />
            </div>
          )}
        </For>
      </Panel>
      <Panel title="heap" count={s().heap.length} empty="empty" class="heap">
        <For each={s().heap}>
          {(e, i) => (
            <div class="dbg-srow" classList={{ new: i() >= s().heap.length - newHeap() }}>
              <span class="dbg-idx muted">{i()}</span>
              <EntryText m={m()} e={e} />
            </div>
          )}
        </For>
      </Panel>
      <Show when={m().mode === "thm"}>
        <Panel title="hypotheses" count={s().hyps.length} empty="none yet" class="hyps">
          <For each={s().hyps}>
            {(e, i) => (
              <div class="dbg-srow" classList={{ new: r()?.hypPushed === e && i() === s().hyps.length - 1 }}>
                <span class="dbg-idx muted">{i() + 1}</span>
                <EntryText m={m()} e={{ kind: "expr", e }} />
              </div>
            )}
          </For>
        </Panel>
      </Show>
      <div class="dbg-vars mono">
        <span title="number of bound variables so far: the declaration's plus one per Dummy">next_bv = {s().nextBv}</span>
        <span>dummies = {s().dummies}</span>
        <span classList={{ bad: s().sorryUsed }}>sorry_used = {s().sorryUsed ? "true" : "false"}</span>
        <span>phase = {s().phase}</span>
      </div>
      <Show when={s().unify}>
        {(u) => (
          <div class="dbg-unify">
            <div class="dbg-unify-title">
              unification <span class="muted">· {UNIFY_MODE_TEXT[u().mode]}</span>
            </div>
            <Panel title="unify stack" count={u().ustack.length} empty="empty: every expression has been matched" class="ustack">
              <For each={u().ustack}>
                {(e, i) => (
                  <div class="dbg-srow" classList={{ new: i() >= u().ustack.length - newUStack(), top: i() === u().ustack.length - 1 }}>
                    <span class="dbg-idx muted" title={i() === u().ustack.length - 1 ? "top of the unify stack" : `position ${i()} from the bottom`}>
                      {i() === u().ustack.length - 1 ? "top" : i()}
                    </span>
                    <EntryText m={m()} e={{ kind: "expr", e }} />
                  </div>
                )}
              </For>
            </Panel>
            <Panel title="unify heap" count={u().uheap.length} empty="empty" class="uheap">
              <For each={u().uheap}>
                {(h, i) => (
                  <div class="dbg-srow" classList={{ new: i() >= u().uheap.length - newUHeap() }}>
                    <span class="dbg-idx muted">{i()}</span>
                    <EntryText m={m()} e={{ kind: "expr", e: h.e }} />
                    <Show when={h.saved}>
                      <span class="heap-tag" title="appended by UTermSave">
                        saved
                      </span>
                    </Show>
                  </div>
                )}
              </For>
            </Panel>
          </div>
        )}
      </Show>
    </>
  );
}

// ---------------------------------------------------------------------------
// Arena: the backing store every stack and heap entry points into

/** Where a node is pointed to from, at the current step. */
function usesOf(v: DebugView, id: number): { slots: string[]; parents: number[] } {
  const s = v.snap;
  const slots: string[] = [];
  const has = (e: StackEntry | HeapEntry) => ("e" in e ? e.e === id : e.e1 === id || e.e2 === id);
  s.stack.forEach((e, i) => has(e) && slots.push(i === s.stack.length - 1 ? "stack top" : `stack ${i}`));
  s.heap.forEach((e, i) => has(e) && slots.push(`heap ${i}`));
  s.hyps.forEach((e, i) => e === id && slots.push(`hyp ${i + 1}`));
  s.unify?.ustack.forEach((e, i) => e === id && slots.push(`unify stack ${i}`));
  s.unify?.uheap.forEach((h, i) => h.e === id && slots.push(`unify heap ${i}`));
  const parents: number[] = [];
  for (let i = id + 1; i < v.m.arenaLen; i++) if (v.m.arena[i]!.args?.includes(id)) parents.push(i);
  return { slots, parents };
}

/** A node's structure one level deep: its term applied to argument node ids, or its variable name. */
function NodeShape(props: { m: Machine; n: ExprNode }) {
  return (
    <span class="dbg-node-shape">
      <Show when={props.n.kind === "term"} fallback={<span>{props.n.name}</span>}>
        <span>{props.m.termName(props.n.term!)}</span>
        <For each={props.n.args}>{(a) => <NodeRef id={a} hover />}</For>
      </Show>
    </span>
  );
}

function NodesPanel(props: { v: DebugView }) {
  const m = () => props.v.m;
  const nodes = () => m().arena.slice(0, m().arenaLen);
  const allocated = () => props.v.record?.allocated ?? [];
  const focused = () => {
    const f = focusNode();
    return f !== undefined && f < m().arenaLen ? m().arena[f] : undefined;
  };
  let box: HTMLDivElement | undefined;
  // Keep the node of interest in view: the pinned one, else what this step allocated.
  createEffect(() => {
    const id = pinNode() ?? allocated()[allocated().length - 1];
    if (id === undefined || !box) return;
    box.querySelector(`[data-node="${id}"]`)?.scrollIntoView({ block: "nearest" });
  });
  return (
    <div class="dbg-panel nodes" classList={{ folded: folded().has("nodes") }}>
      <PanelTitle id="nodes" title="nodes" count={m().arenaLen} />
      <div class="dbg-panel-rows" ref={box} hidden={folded().has("nodes")}>
        <For each={nodes()}>
          {(n) => (
            <div
              class="dbg-srow dbg-nrow"
              data-node={n.id}
              classList={{ new: allocated().includes(n.id), hit: focusNode() === n.id, has: focusNode() !== n.id && containing().has(n.id) }}
              onMouseEnter={() => setHoverNode(n.id)}
              onMouseLeave={() => setHoverNode(undefined)}
              onClick={() => setPinNode(pinNode() === n.id ? undefined : n.id)}
            >
              <span class="dbg-idx muted">
                <NodeRef id={n.id} hover />
              </span>
              <NodeShape m={m()} n={n} />
              <Show when={n.kind === "term" && n.args!.length}>
                <span class="dbg-node-text muted">{m().show(n.id)}</span>
              </Show>
              <Show when={n.kind === "var"}>
                <span class="dbg-node-tag muted" title={n.bound ? `bound variable: bit ${n.bv} of the deps bitmaps` : "a regular (non-bound) variable of the declaration"}>
                  {n.bound ? "bound" : "var"}
                </span>
              </Show>
            </div>
          )}
        </For>
      </div>
      <Show when={!folded().has("nodes") && focused()}>{(n) => <NodeCard v={props.v} n={n()} />}</Show>
    </div>
  );
}

/** Everything the verifier knows about one node, and everything pointing at it. */
function NodeCard(props: { v: DebugView; n: ExprNode }) {
  const m = () => props.v.m;
  const uses = createMemo(() => usesOf(props.v, props.n.id));
  const kind = () => (props.n.kind === "term" ? `application of term ${m().termName(props.n.term!)}` : props.n.bound ? `bound variable (bit ${props.n.bv} of the deps bitmaps)` : "variable");
  return (
    <div class="dbg-node-card mono" classList={{ pinned: pinNode() === props.n.id }}>
      <div class="dbg-node-head">
        <NodeRef id={props.n.id} />
        <code class="dbg-node-full">{m().show(props.n.id)}</code>
        <span class="muted">: {m().sortName(props.n.sort)}</span>
        <Show when={pinNode() === props.n.id}>
          <button class="link-plain muted dbg-node-unpin" onClick={() => setPinNode(undefined)} title="unpin">
            ×
          </button>
        </Show>
      </div>
      <div class="dbg-node-facts">
        <span class="dbg-key">is</span>
        <span>{kind()}</span>
        <Show when={props.n.kind === "term"}>
          <span class="dbg-key">args</span>
          <span>
            <Show when={props.n.args!.length} fallback={<span class="muted">none</span>}>
              <For each={props.n.args}>{(a) => <NodeRef id={a} hover />}</For>
            </Show>
          </span>
        </Show>
        <span class="dbg-key" title="V(e): the bound variables occurring anywhere in e">V</span>
        <span>{m().showDeps(props.n.v)}</span>
        <span class="dbg-key" title="FV(e): the bound variables free in e, after the term's binders capture theirs">FV</span>
        <span>{m().showDeps(props.n.fv)}</span>
        <span class="dbg-key">made</span>
        <span>
          <Show when={props.n.by >= 0} fallback="before the proof">
            <button class="link-plain" onClick={() => debugGoto(props.n.by + 1)} title="go to the step that allocated this node">
              step {props.n.by + 1}
            </button>
          </Show>
        </span>
        <span class="dbg-key">in</span>
        <span>
          <Show when={uses().slots.length} fallback={<span class="muted">nothing points here now</span>}>
            {uses().slots.join(", ")}
          </Show>
        </span>
        <span class="dbg-key">under</span>
        <span>
          <Show when={uses().parents.length} fallback={<span class="muted">no larger node yet</span>}>
            <For each={uses().parents}>{(p) => <NodeRef id={p} hover />}</For>
          </Show>
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Narrative

function Narrative(props: { v: DebugView }) {
  const r = () => props.v.record;
  const m = () => props.v.m;
  const failed = (c: Check) => !c.passed;
  // The step's checks in order, each preceded by the bytes it consulted, then whatever
  // the step read after its last check. The command's own bytes are left out: the title names them.
  const trace = () => {
    const rec = r();
    if (!rec) return [];
    const own = (s: Span) => s !== rec.span;
    const items: ({ kind: "read"; spans: Span[] } | { kind: "check"; check: Check })[] = [];
    const claimed = new Set<Span>();
    for (const c of rec.checks) {
      const spans = (c.reads ?? []).filter(own);
      spans.forEach((s) => claimed.add(s));
      if (spans.length) items.push({ kind: "read", spans });
      items.push({ kind: "check", check: c });
    }
    const rest = rec.reads.filter((s) => own(s) && !claimed.has(s));
    if (rest.length) items.push({ kind: "read", spans: rest });
    return items;
  };
  return (
    <section class="dbg-narrative">
      <Show
        when={r()}
        fallback={
          <div class="explain">
            <p>
              Before the first step. The machine starts with an empty stack; the first step reads the statement command and the declaration's table entry, checks the binders, and puts the variables on the heap.
            </p>
          </div>
        }
      >
        {(rec) => (
          <>
            <div class="dbg-step-title">
              <span class="dbg-step-n mono">step {rec().index + 1}</span>
              <span class={`dbg-level ${rec().level}`}>{rec().level === "stmt" ? "statement" : rec().level === "unify" ? "unify" : "proof"}</span>
              <span class="dbg-mnemonic mono">{rec().mnemonic}</span>
              <span class="dbg-step-at mono muted">{hex(rec().span.start)}</span>
            </div>
            <p class="dbg-summary">
              <Prose text={rec().summary} />
            </p>
            <Show when={rec().error}>
              {(err) => (
                <div class="problem error dbg-error">
                  <b>Verification fails here.</b> <NodeText text={err().message} />
                </div>
              )}
            </Show>
            <Show when={ruleSchema(rec())}>
              {(sch) => (
                <div class="dbg-rule">
                  <div class="dbg-rule-row">
                    <span class="dbg-key">rule</span>
                    <div class="dbg-rule-lines">
                      <For each={sch().lines}>{(l) => <div>{l}</div>}</For>
                    </div>
                    <span class="dbg-check-section muted" title={sch().paraphrase ? "not one of the spec's displayed rules; paraphrased from this section" : "the rule as the spec displays it, in this section"}>
                      {sch().section}
                      {sch().paraphrase ? " ¶" : ""}
                    </span>
                  </div>
                  <div class="dbg-rule-row">
                    <span class="dbg-key">here</span>
                    <div class="dbg-rule-pic">
                      <PictureSide m={m()} cols={picture(rec()).before} />
                      <span class="dbg-rule-arrow">--&gt;</span>
                      <PictureSide m={m()} cols={picture(rec()).after} opensAt={picture(rec()).opensAt} />
                    </div>
                  </div>
                </div>
              )}
            </Show>
            <Show when={trace().length}>
              <div class="dbg-checks">
                <For each={trace()}>
                  {(it) =>
                    it.kind === "check" ? (
                      <div class="dbg-check" classList={{ failed: failed(it.check) }}>
                        <span class="dbg-check-mark">{it.check.passed ? "✓" : "✗"}</span>
                        <span class="dbg-check-name">{it.check.name}</span>
                        <span class="dbg-check-detail muted">
                          <Show when={it.check.detail}>
                            <NodeText text={it.check.detail} />
                          </Show>
                        </span>
                        <span class="dbg-check-section muted">{it.check.section}</span>
                      </div>
                    ) : (
                      <div class="dbg-check dbg-read" title="bytes the step consulted at this point; the checks below use them">
                        <span class="dbg-check-mark" />
                        <span class="dbg-check-name dbg-key">read</span>
                        <span class="dbg-reads">
                          <For each={it.spans}>
                            {(s) => (
                              <button
                                class={`crumb link ${familyClass(s)}`}
                                onClick={() => {
                                  goTo(s.start);
                                  setCenterTab("hex");
                                }}
                                title={`${s.kind} at ${hex(s.start)}: show in the hexdump`}
                              >
                                {s.label} <span class="mono">{hex(s.start)}</span>
                              </button>
                            )}
                          </For>
                        </span>
                        <span />
                      </div>
                    )
                  }
                </For>
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}

/** One side of an instantiated rule: the state's letters, each followed by the entries the step removed from or added to it. */
function PictureSide(props: { m: Machine; cols: PictureColumn[]; opensAt?: number }) {
  return (
    <span class="dbg-side">
      <For each={props.cols}>
        {(c, i) => (
          <>
            <Show when={i() === props.opensAt}>
              <span class="dbg-rule-unify" title="the unify frame this step opens: its heap is the substitution, its stack the expression to match">unify:</span>
            </Show>
            <Show when={i() > 0 && i() !== props.opensAt}>
              <span class="dbg-sep">{"; "}</span>
            </Show>
            <span class="dbg-col" title={c.title}>
              <span class="dbg-col-name">{c.name}</span>
              <Show when={c.empty}>
                <span class="dbg-sep">=</span> .
              </Show>
              <For each={c.items}>
                {(e) => (
                  <>
                    <span class="dbg-sep">,</span> <EntryText m={props.m} e={e} />
                  </>
                )}
              </For>
            </span>
          </>
        )}
      </For>
    </span>
  );
}

/** Text with `backticked` runs rendered as code: the machine writes expressions that way in its summaries. */
function Prose(props: { text: string }) {
  const parts = createMemo(() => props.text.split("`"));
  return <For each={parts()}>{(t, i) => (i() % 2 ? <code><NodeText text={t} /></code> : <NodeText text={t} />)}</For>;
}

/** Text whose `#N` mentions are live node references. */
function NodeText(props: { text: string }) {
  const parts = createMemo(() => props.text.split(/(#\d+)/));
  return <For each={parts()}>{(t, i) => (i() % 2 ? <NodeRef id={Number(t.slice(1))} /> : t)}</For>;
}
