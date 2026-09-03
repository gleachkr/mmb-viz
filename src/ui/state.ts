import { createMemo, createRoot, createSignal } from "solid-js";
import { parseLayout, type Layout } from "../core/layout";
import { allDecls, type DeclSummary } from "../core/decls";
import { collectProblems, spanChainAt, type DeclRef, type Problem, type Span } from "../core/spans";
import { disassembleProof } from "../core/streams";

export interface Loaded {
  name: string;
  layout: Layout;
  parseMs: number;
}

const [loaded, setLoaded] = createSignal<Loaded | undefined>();
/** Selected byte offset, or -1. */
const [selected, setSelected] = createSignal<number>(-1);
/** Hovered byte offset, or -1. */
const [hovered, setHovered] = createSignal<number>(-1);
/** Version counter bumped whenever something asks the hexdump to scroll. */
const [scrollRequest, setScrollRequest] = createSignal<{ offset: number; n: number }>({ offset: 0, n: 0 });
const [history, setHistory] = createSignal<number[]>([]);

export { loaded, selected, hovered, scrollRequest, history };

/** Side panes start hidden on viewports too narrow to show them beside the hexdump. */
const w = typeof window === "undefined" ? 1600 : window.innerWidth;
const [showTree, setShowTree] = createSignal(w >= 1000);
const [showInspector, setShowInspector] = createSignal(w >= 1300);
export { showTree, showInspector };
export const toggleTree = (): void => void setShowTree((v) => !v);
export const toggleInspector = (): void => void setShowInspector((v) => !v);

export type LeftTab = "structure" | "decls";
const [leftTab, setLeftTab] = createSignal<LeftTab>("structure");
export { leftTab, setLeftTab };

/**
 * Results of the deep scan that runs shortly after a file loads: every lazy
 * stream is decoded so that the problem list is complete, the declarations
 * browser has its signatures, and proofs that use Sorry are known.
 */
export interface Scan {
  problems: Problem[];
  decls: DeclSummary[];
  /** Statement indices whose proof uses Sorry. */
  sorry: Set<number>;
  ms: number;
}
const [scan, setScan] = createSignal<Scan | undefined>();
export { scan };

function runScan(layout: Layout): void {
  const t0 = performance.now();
  const sorry = new Set<number>();
  for (const st of layout.statements) {
    if (!st.hasProof) continue;
    if (disassembleProof(layout, st)?.usesSorry) sorry.add(st.index);
  }
  const decls = allDecls(layout);
  const problems = collectProblems(layout.root);
  // Problems recorded on the layout but not on any span (e.g. counter mismatches).
  for (const p of layout.problems) if (!problems.includes(p)) problems.push(p);
  problems.sort((a, b) => a.offset - b.offset);
  setScan({ problems, decls, sorry, ms: performance.now() - t0 });
}

/** All known problems: the scan's complete list once it has run, else the parser's. */
export function problems(): Problem[] {
  return scan()?.problems ?? loaded()?.layout.problems ?? [];
}

export function loadBytes(name: string, bytes: Uint8Array): void {
  const t0 = performance.now();
  const layout = parseLayout(bytes);
  const parseMs = performance.now() - t0;
  setHistory([]);
  setSelected(-1);
  setHovered(-1);
  setScan(undefined);
  setLoaded({ name, layout, parseMs });
  // Let the first paint happen, then decode everything.
  setTimeout(() => {
    if (loaded()?.layout === layout) runScan(layout);
  }, 30);
}

export function goToDecl(ref: DeclRef): void {
  const L = loaded()?.layout;
  if (!L) return;
  const d = ref.kind === "sort" ? L.sorts[ref.id]?.span : ref.kind === "term" ? L.terms[ref.id]?.entrySpan : L.thms[ref.id]?.entrySpan;
  if (d) goTo(d.start);
}

export async function loadExample(file: string): Promise<void> {
  const url = new URL(`examples/${file}`, document.baseURI);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`failed to fetch ${file}: ${res.status}`);
  loadBytes(file, new Uint8Array(await res.arrayBuffer()));
}

/** Select an offset and bring it into view. */
export function goTo(offset: number, pushHistory = true): void {
  const L = loaded()?.layout;
  if (!L) return;
  if (offset < 0 || offset >= L.bytes.length) return;
  if (pushHistory && selected() >= 0 && selected() !== offset) {
    setHistory((h) => [...h.slice(-49), selected()]);
  }
  setSelected(offset);
  setScrollRequest((r) => ({ offset, n: r.n + 1 }));
}

export function goBack(): void {
  const h = history();
  const last = h[h.length - 1];
  if (last === undefined) return;
  setHistory(h.slice(0, -1));
  goTo(last, false);
}

export function select(offset: number): void {
  setSelected(offset);
}

export function hover(offset: number): void {
  setHovered(offset);
}

/** Chain of spans containing the selected offset (root first). Memoized app-wide. */
export const selectedChain: () => Span[] = createRoot(() =>
  createMemo(() => {
    const L = loaded()?.layout;
    const o = selected();
    if (!L || o < 0) return [];
    return spanChainAt(L.root, o);
  }),
);

export function selectedLeaf(): Span | undefined {
  const c = selectedChain();
  return c[c.length - 1];
}

/** The declaration owning the selection: the deepest span on the chain with an owner. */
export const selectedOwner: () => DeclRef | undefined = createRoot(() =>
  createMemo(
    () => {
      const c = selectedChain();
      for (let i = c.length - 1; i >= 0; i--) if (c[i]!.owner) return c[i]!.owner;
      return undefined;
    },
    undefined,
    { equals: (a, b) => a?.kind === b?.kind && a?.id === b?.id },
  ),
);
