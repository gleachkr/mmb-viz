import { createResource, For, Show } from "solid-js";
import { loaded, loadBytes, loadExample, goBack, history, showTree, showInspector, toggleTree, toggleInspector } from "./state";
import { bytesLabel } from "./format";

interface ExampleMeta {
  file: string;
  title: string;
  description: string;
}

async function fetchManifest(): Promise<ExampleMeta[]> {
  const res = await fetch(new URL("examples/manifest.json", document.baseURI));
  return res.ok ? ((await res.json()) as ExampleMeta[]) : [];
}

export function TopBar() {
  const [examples] = createResource(fetchManifest);
  let fileInput!: HTMLInputElement;

  const onFile = async () => {
    const f = fileInput.files?.[0];
    if (!f) return;
    loadBytes(f.name, new Uint8Array(await f.arrayBuffer()));
    fileInput.value = "";
  };

  return (
    <header class="topbar">
      <div class="brand">
        <span class="brand-mark">mmb</span>-viz
        <span class="brand-sub">MMB explainer</span>
      </div>

      <div class="topbar-controls">
        <label class="btn">
          Open .mmb
          <input ref={fileInput} type="file" accept=".mmb,application/octet-stream" onChange={onFile} hidden />
        </label>
        <select
          class="select"
          onChange={(e) => {
            const v = e.currentTarget.value;
            if (v) void loadExample(v);
            e.currentTarget.value = "";
          }}
        >
          <option value="">Examples…</option>
          <For each={examples() ?? []}>{(ex) => <option value={ex.file} title={ex.description}>{ex.title}</option>}</For>
        </select>
        <button class="btn" disabled={history().length === 0} onClick={goBack} title="Back (Alt+Left)">
          ← back
        </button>
      </div>

      <Show when={loaded()}>
        <div class="pane-toggles" role="group" aria-label="panes">
          <button class="btn toggle" classList={{ on: showTree() }} onClick={toggleTree} title="Show or hide the structure tree ([)" aria-pressed={showTree()}>
            ◧ structure
          </button>
          <button class="btn toggle" classList={{ on: showInspector() }} onClick={toggleInspector} title="Show or hide the inspector (])" aria-pressed={showInspector()}>
            inspector ◨
          </button>
        </div>
      </Show>

      <Show when={loaded()}>
        {(L) => (
          <div class="file-stats">
            <span class="file-name">{L().name}</span>
            <span class="stat">{bytesLabel(L().layout.bytes.length)}</span>
            <span class="stat">{L().layout.sorts.length} sorts</span>
            <span class="stat">{L().layout.terms.length} terms</span>
            <span class="stat">{L().layout.thms.length} thms</span>
            <span class="stat muted">parsed in {L().parseMs.toFixed(0)} ms</span>
            <Show when={L().layout.problems.filter((p) => p.severity === "error").length}>
              {(n) => <span class="stat bad">{n()} problem{n() === 1 ? "" : "s"}</span>}
            </Show>
          </div>
        )}
      </Show>
    </header>
  );
}
