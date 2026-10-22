// Page elements always exist (see index.html), so a missing one is a bug worth failing loudly on.
export function $<T extends HTMLElement = HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} missing from index.html`);
  return el as T;
}
