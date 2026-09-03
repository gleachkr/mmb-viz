import { Show, onMount } from "solid-js";
import { TopBar } from "./TopBar";
import { FileMap } from "./FileMap";
import { HexDump } from "./HexDump";
import { StructureTree } from "./StructureTree";
import { Inspector } from "./Inspector";
import { loaded, loadBytes, loadExample, goBack, showTree, showInspector, toggleTree, toggleInspector } from "./state";

export function App() {
  onMount(() => {
    // Global drag-and-drop: anywhere on the page.
    const prevent = (e: DragEvent) => {
      e.preventDefault();
      document.body.classList.toggle("dragging", e.type === "dragover");
    };
    window.addEventListener("dragover", prevent);
    window.addEventListener("dragleave", prevent);
    window.addEventListener("drop", async (e) => {
      e.preventDefault();
      document.body.classList.remove("dragging");
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
    });
    window.addEventListener("keydown", (e) => {
      if (e.altKey && e.key === "ArrowLeft") {
        e.preventDefault();
        goBack();
      }
      if (e.target instanceof HTMLElement && ["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
      if (e.key === "[") toggleTree();
      if (e.key === "]") toggleInspector();
    });
    const params = new URLSearchParams(location.hash.replace(/^#/, ""));
    const ex = params.get("example");
    if (ex) void loadExample(ex);
  });

  return (
    <div class="app">
      <TopBar />
      <Show when={loaded()} fallback={<Welcome />}>
        <FileMap />
        <main class="workspace" classList={{ "no-left": !showTree(), "no-right": !showInspector() }}>
          <Show when={showTree()}>
            <aside class="pane pane-left">
              <StructureTree />
            </aside>
          </Show>
          <section class="pane pane-center">
            <HexDump />
          </section>
          <Show when={showInspector()}>
            <aside class="pane pane-right">
              <Inspector />
            </aside>
          </Show>
        </main>
      </Show>
    </div>
  );
}

function Welcome() {
  return (
    <div class="welcome">
      <div class="welcome-card">
        <h1>
          <span class="brand-mark">mmb</span>-viz
        </h1>
        <p class="lede">
          A visual explainer for Metamath Zero binary proof files. Drop a <code>.mmb</code> file anywhere on this page, or pick an example above, and every byte will be
          colored by the structure it belongs to.
        </p>
        <p class="hint">
          What you get in this build: the annotated hexdump, a proportional file map, the structure tree, and an inspector that decodes every field with the relevant
          passage of the spec. The steppable verifier comes next.
        </p>
        <div class="welcome-actions">
          <button class="btn primary" onClick={() => void loadExample("tutorial.mmb")}>
            Open the tutorial file
          </button>
          <button class="btn" onClick={() => void loadExample("peano.mmb")}>
            Open Peano arithmetic (876 KB)
          </button>
        </div>
      </div>
    </div>
  );
}
