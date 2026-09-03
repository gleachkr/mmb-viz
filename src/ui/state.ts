import { createMemo, createRoot, createSignal } from "solid-js";
import { parseLayout, type Layout } from "../core/layout";
import { spanChainAt, type Span } from "../core/spans";

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

export function loadBytes(name: string, bytes: Uint8Array): void {
  const t0 = performance.now();
  const layout = parseLayout(bytes);
  const parseMs = performance.now() - t0;
  setHistory([]);
  setSelected(-1);
  setHovered(-1);
  setLoaded({ name, layout, parseMs });
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
