import { Show, onMount } from "solid-js";
import { TopBar } from "./TopBar";
import { FileMap } from "./FileMap";
import { HexDump } from "./HexDump";
import { StructureTree } from "./StructureTree";
import { Declarations } from "./Declarations";
import { Inspector } from "./Inspector";
import { Debugger } from "./Debugger";
import { loaded, loadBytes, loadExample, startRouting, goBack, showTree, showInspector, toggleTree, toggleInspector, leftTab, setLeftTab, setInspTab, centerTab, setCenterTab, debug, debugGoto, debugStep, debugStepOver, debugStepBackOver, verification } from "./state";

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
      if (e.key === "d" || e.key === "D") setLeftTab(leftTab() === "decls" ? "structure" : "decls");
      if (e.key === "1") setInspTab("field");
      if (e.key === "2") setInspTab("decl");
      if (e.key === "3") setInspTab("spec");
      if (e.key === "4") setInspTab("problems");
      if (e.key === "v" || e.key === "V") setCenterTab(centerTab() === "hex" ? "debug" : "hex");
      if (centerTab() === "debug" && debug()) {
        if (e.key === ".") debugStep(1);
        if (e.key === ",") debugStep(-1);
        if (e.key === ">") debugStepOver();
        if (e.key === "<") debugStepBackOver();
        if (e.key === "r" || e.key === "Home") debugGoto(0);
        if (e.key === "e" || e.key === "End") debugGoto(debug()!.trace.length);
      }
    });
    startRouting();
  });

  return (
    <div class="app">
      <TopBar />
      <Show when={loaded()} fallback={<Welcome />}>
        <FileMap />
        <main class="workspace" classList={{ "no-left": !showTree(), "no-right": !showInspector() }}>
          <Show when={showTree()}>
            <aside class="pane pane-left">
              <div class="tabs" role="tablist">
                <button class="tab" role="tab" classList={{ on: leftTab() === "structure" }} onClick={() => setLeftTab("structure")}>
                  Structure
                </button>
                <button class="tab" role="tab" classList={{ on: leftTab() === "decls" }} onClick={() => setLeftTab("decls")}>
                  Declarations
                </button>
              </div>
              <Show when={leftTab() === "structure"} fallback={<Declarations />}>
                <StructureTree />
              </Show>
            </aside>
          </Show>
          <section class="pane pane-center">
            <div class="tabs" role="tablist">
              <button class="tab" role="tab" classList={{ on: centerTab() === "hex" }} onClick={() => setCenterTab("hex")} title="the annotated bytes (v toggles)">
                Hexdump
              </button>
              <button class="tab" role="tab" classList={{ on: centerTab() === "debug" }} onClick={() => setCenterTab("debug")} title="step through a proof (v toggles)">
                Debugger
                <Show when={verification()?.errors}>
                  <span class="tab-n bad">{verification()!.errors} failing</span>
                </Show>
              </button>
            </div>
            <Show when={centerTab() === "hex"} fallback={<Debugger />}>
              <HexDump />
            </Show>
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
          A visual explainer for Metamath Zero binary proof files. Drop a <code>.mmb</code> file anywhere on this page, or pick an example above.
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
