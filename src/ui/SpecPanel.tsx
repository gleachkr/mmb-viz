import { createEffect, createMemo, createSignal, on, Show } from "solid-js";
import { SPEC_SECTIONS, specSection, type SpecSection } from "../core/spec";

/**
 * The spec companion: renders the section relevant to the selection and
 * highlights the rule or table row named by `anchor`. Links inside the spec
 * navigate within the panel; the selection's own section comes back when
 * the selection changes.
 */
export function SpecPanel(props: { section?: string; anchor?: string }) {
  const [override, setOverride] = createSignal<string | undefined>();
  const [expanded, setExpanded] = createSignal(false);
  let box!: HTMLDivElement;

  createEffect(on(() => props.section, () => setOverride(undefined)));

  const section = createMemo<SpecSection | undefined>(() => {
    const o = override();
    if (o) return SPEC_SECTIONS.find((s) => s.id === o);
    return specSection(props.section);
  });

  // Highlight and reveal the anchored rule or row after each render.
  createEffect(
    on([section, () => props.anchor, expanded], () => {
      if (!box) return;
      for (const el of box.querySelectorAll(".hit")) el.classList.remove("hit");
      const a = props.anchor;
      if (!a || override()) return;
      const el = box.querySelector(`[data-rule="${a}"], [data-row="${a}"]`);
      if (!(el instanceof HTMLElement)) return;
      el.classList.add("hit");
      box.scrollTop = Math.max(0, el.offsetTop - 10);
    }),
  );

  const onClick = (e: MouseEvent) => {
    const t = e.target instanceof Element ? e.target.closest("a[data-section]") : null;
    if (!t) return;
    e.preventDefault();
    const id = t.getAttribute("data-section")!;
    if (SPEC_SECTIONS.some((s) => s.id === id)) {
      setOverride(id);
      box.scrollTop = 0;
    }
  };

  return (
    <Show when={section()}>
      {(s) => (
        <div class="spec" classList={{ expanded: expanded() }}>
          <div class="spec-head">
            <span class="spec-kicker">spec</span>
            <span class="spec-title">{s().title}</span>
            <Show when={override()}>
              <button class="link small" onClick={() => setOverride(undefined)}>
                back
              </button>
            </Show>
            <button class="link small" onClick={() => setExpanded(!expanded())}>
              {expanded() ? "shrink" : "expand"}
            </button>
          </div>
          <div class="spec-body" ref={box} onClick={onClick} innerHTML={s().html} />
        </div>
      )}
    </Show>
  );
}
