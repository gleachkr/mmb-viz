import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { hex, hex2, hexOffset } from "../core/bytes";
import { categoryOf } from "../core/decls";
import { declName, type Statement } from "../core/layout";
import { UNIFY_MODE_TEXT, type Check, type HeapEntry, type Machine, type StackEntry } from "../core/machine";
import { childrenOf, type Span } from "../core/spans";
import { CATEGORY_CLASS } from "./DeclCard";
import { familyClass } from "./format";
import { debugGoto, debugStep, debugStepBackOver, debugStepOver, debugView, goTo, loaded, openDebugger, reveal, setCenterTab, setInspTab, type DebugView } from "./state";

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
      <div class="dbg-controls">
        <button class="btn small" onClick={() => debugGoto(0)} title="restart (r)" disabled={props.v.step === 0}>
          ⏮ restart
        </button>
        <button class="btn small" onClick={debugStepBackOver} title="back over a unification (<)" disabled={props.v.step === 0}>
          ◀◀
        </button>
        <button class="btn small" onClick={() => debugStep(-1)} title="step back (,)" disabled={props.v.step === 0}>
          ◀ back
        </button>
        <button class="btn small primary" onClick={() => debugStep(1)} title="step (.)" disabled={props.v.step >= n()}>
          step ▶
        </button>
        <button class="btn small" onClick={debugStepOver} title="step over a unification (>)" disabled={props.v.step >= n()}>
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
        const el = box?.querySelector(".dbg-row.next, .dbg-row.cur");
        el?.scrollIntoView({ block: "nearest" });
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
    <span class="dbg-entry">
      <Show when={KIND_MARK[props.e.kind]}>
        <span class="dbg-kind" title={props.e.kind}>
          {KIND_MARK[props.e.kind]}
        </span>
      </Show>
      <span class="dbg-expr">{entryBody(props.m, props.e)}</span>
      <span class="node-id muted" title="node ids: equality in MMB is identity of nodes">
        {ids().map((i) => `#${i}`).join(" ")}
      </span>
    </span>
  );
}

function Panel(props: { title: string; count: number; empty: string; children: unknown; class?: string }) {
  return (
    <div class={`dbg-panel ${props.class ?? ""}`}>
      <div class="dbg-panel-title">
        {props.title} <span class="muted">{props.count}</span>
      </div>
      <Show when={props.count} fallback={<div class="dbg-empty muted">{props.empty}</div>}>
        <div class="dbg-panel-rows">{props.children as never}</div>
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
              <span class="dbg-idx muted">{i() === s().stack.length - 1 ? "top" : ""}</span>
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
                    <span class="dbg-idx muted">{i() === u().ustack.length - 1 ? "top" : ""}</span>
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
// Narrative

function Narrative(props: { v: DebugView }) {
  const r = () => props.v.record;
  const m = () => props.v.m;
  const failed = (c: Check) => !c.passed;
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
              <button class="link small" onClick={() => goTo(rec().span.start)} title="select these bytes">
                {hex(rec().span.start)}
              </button>
              <button class="link small" onClick={() => setInspTab("spec")} title="show the spec rule in the inspector">
                spec
              </button>
            </div>
            <p class="dbg-summary">{rec().summary}</p>
            <Show when={rec().error}>
              {(err) => (
                <div class="problem error dbg-error">
                  <b>Verification fails here.</b> {err().message}
                </div>
              )}
            </Show>
            <Show when={rec().pops.length}>
              <div class="dbg-line">
                <span class="dbg-key">popped</span>
                <For each={rec().pops}>{(e) => <EntryText m={m()} e={e} />}</For>
              </div>
            </Show>
            <Show when={rec().checks.length}>
              <div class="dbg-checks">
                <For each={rec().checks}>
                  {(c) => (
                    <div class="dbg-check" classList={{ failed: failed(c) }}>
                      <span class="dbg-check-mark">{c.passed ? "✓" : "✗"}</span>
                      <span class="dbg-check-name">{c.name}</span>
                      <Show when={c.detail}>
                        <span class="dbg-check-detail muted">{c.detail}</span>
                      </Show>
                      <span class="dbg-check-section muted">{c.section}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
            <Show when={rec().reads.length}>
              <div class="dbg-line">
                <span class="dbg-key">read</span>
                <span class="dbg-reads">
                  <For each={rec().reads}>
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
              </div>
            </Show>
          </>
        )}
      </Show>
    </section>
  );
}
