import { createEffect, createMemo, createSignal, For, Show, on } from "solid-js";
import { hex } from "../core/bytes";
import { childrenOf, family, hasChildren, type Span } from "../core/spans";
import { loaded, selectedChain, goTo, selected } from "./state";
import { FAMILY_TITLES, bytesLabel, familyClass } from "./format";

const PAGE = 150;
const WINDOW = 40;

/**
 * Which items of a long list to render: the first `shown`, plus a window
 * around `focus` if it lies beyond them. Returns runs of [from, to).
 */
function visibleRuns(total: number, shown: number, focus: number): [number, number][] {
  const first: [number, number] = [0, Math.min(shown, total)];
  if (focus < 0 || focus < first[1]) return [first];
  const from = Math.max(first[1], focus - WINDOW);
  const to = Math.min(total, focus + WINDOW);
  return [first, [from, to]];
}

interface Group {
  fam: string;
  regions: Span[];
  bytes: number;
}

/**
 * Collapsible outline of the span tree. Top-level regions are grouped by
 * family (all 2723 theorem data blocks under one node) so the root stays
 * readable; long child lists are paginated.
 */
export function StructureTree() {
  const groups = createMemo<Group[]>(() => {
    const L = loaded()?.layout;
    if (!L) return [];
    const map = new Map<string, Group>();
    for (const r of childrenOf(L.root)) {
      const fam = family(r.kind);
      let g = map.get(fam);
      if (!g) map.set(fam, (g = { fam, regions: [], bytes: 0 }));
      g.regions.push(r);
      g.bytes += r.end - r.start;
    }
    return [...map.values()];
  });

  // The top-level region on the selected chain, for auto-expansion.
  const selRegion = () => selectedChain()[1];

  return (
    <div class="tree">
      <div class="pane-title">Structure</div>
      <For each={groups()}>
        {(g) => (
          <Show when={g.regions.length > 1} fallback={<Node span={g.regions[0]!} depth={0} />}>
            <GroupNode group={g} open={() => selRegion() !== undefined && g.regions.includes(selRegion()!)} />
          </Show>
        )}
      </For>
    </div>
  );
}

function GroupNode(props: { group: Group; open: () => boolean }) {
  const [open, setOpen] = createSignal(false);
  const [shown, setShown] = createSignal(PAGE);
  createEffect(on(props.open, (o) => o && setOpen(true)));
  const focus = () => {
    const sel = selectedChain()[1];
    return sel ? props.group.regions.indexOf(sel) : -1;
  };
  const runs = () => visibleRuns(props.group.regions.length, shown(), focus());
  return (
    <div class="node">
      <div class="node-row depth-0" onClick={() => setOpen(!open())}>
        <span class={`caret ${open() ? "open" : ""}`}>▸</span>
        <i class={`swatch ${"fam-" + props.group.fam}`} />
        <span class="node-label">{FAMILY_TITLES[props.group.fam] ?? props.group.fam}</span>
        <span class="node-meta">
          {props.group.regions.length} × · {bytesLabel(props.group.bytes)}
        </span>
      </div>
      <Show when={open()}>
        <div class="node-kids">
          <For each={runs()}>
            {(run, i) => (
              <>
                <Show when={i() > 0}>
                  <div class="skipped">… {run[0] - runs()[0]![1]} skipped …</div>
                </Show>
                <For each={props.group.regions.slice(run[0], run[1])}>{(r) => <Node span={r} depth={1} />}</For>
              </>
            )}
          </For>
          <Show when={shown() < props.group.regions.length}>
            <button class="btn small more" onClick={() => setShown(shown() + PAGE)}>
              show {Math.min(PAGE, props.group.regions.length - shown())} more of {props.group.regions.length - shown()}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}

function Node(props: { span: Span; depth: number }) {
  const [open, setOpen] = createSignal(false);
  const [shown, setShown] = createSignal(PAGE);
  let row!: HTMLDivElement;

  const onChain = createMemo(() => selectedChain().includes(props.span));
  const isLeafSelected = createMemo(() => {
    const c = selectedChain();
    return c[c.length - 1] === props.span;
  });
  createEffect(() => {
    if (onChain() && hasChildren(props.span)) setOpen(true);
  });
  const focus = () => {
    if (!onChain()) return -1;
    const c = selectedChain();
    const next = c[c.indexOf(props.span) + 1];
    return next ? childrenOf(props.span).indexOf(next) : -1;
  };
  createEffect(
    on(selected, () => {
      if (isLeafSelected()) row?.scrollIntoView({ block: "nearest" });
    }),
  );

  const kids = () => (open() ? childrenOf(props.span) : []);
  const runs = () => visibleRuns(kids().length, shown(), focus());

  return (
    <div class="node">
      <div
        ref={row}
        class={`node-row depth-${Math.min(props.depth, 6)} ${isLeafSelected() ? "selected" : onChain() ? "on-chain" : ""}`}
        onClick={() => goTo(props.span.start)}
      >
        <Show when={hasChildren(props.span)} fallback={<span class="caret none" />}>
          <span
            class={`caret ${open() ? "open" : ""}`}
            onClick={(e) => {
              e.stopPropagation();
              setOpen(!open());
            }}
          >
            ▸
          </span>
        </Show>
        <i class={`swatch ${familyClass(props.span)}`} />
        <span class="node-label" classList={{ problem: !!props.span.problems?.length }}>
          {props.span.label}
        </span>
        <span class="node-meta">
          {hex(props.span.start)} · {props.span.end - props.span.start}
        </span>
      </div>
      <Show when={open()}>
        <div class="node-kids">
          <For each={runs()}>
            {(run, i) => (
              <>
                <Show when={i() > 0}>
                  <div class="skipped">… {run[0] - runs()[0]![1]} skipped …</div>
                </Show>
                <For each={kids().slice(run[0], run[1])}>{(k) => <Node span={k} depth={props.depth + 1} />}</For>
              </>
            )}
          </For>
          <Show when={shown() < kids().length}>
            <button class="btn small more" onClick={() => setShown(shown() + PAGE)}>
              show {Math.min(PAGE, kids().length - shown())} more of {kids().length - shown()}
            </button>
          </Show>
        </div>
      </Show>
    </div>
  );
}
