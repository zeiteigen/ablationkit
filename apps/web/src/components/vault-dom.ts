/**
 * Where things are on a vault page: the scrolling area (the shell's main), a note by its key, the
 * trail's height. Reading position is a matter of the DOM, so it is measured, not modelled.
 */

export function mainEl(): HTMLElement | null {
  return document.getElementById("main-content");
}

export function noteEl(key: string, scope: ParentNode = document): HTMLElement | null {
  return scope.querySelector<HTMLElement>(`.v-note[data-key="${CSS.escape(key)}"]`);
}

export function trailHeight(): number {
  return document.querySelector<HTMLElement>(".v-trail")?.offsetHeight ?? 40;
}

/** A brief wash of ink over a note just arrived at. */
export function flash(el: Element | null | undefined): void {
  if (!el) return;
  el.classList.remove("v-flash");
  void (el as HTMLElement).offsetWidth;
  el.classList.add("v-flash");
}

/** Scroll the note's head to just under the trail (`start`) or to the middle of the screen. */
export function reveal(el: HTMLElement, mode: "start" | "center" | "nearest"): void {
  const scroller = (el.closest(".v-sheet") as HTMLElement | null) ?? mainEl();
  if (!scroller) return;
  const head = el.querySelector<HTMLElement>(":scope > .v-nh") ?? el;
  const r = head.getBoundingClientRect();
  const top = scroller.getBoundingClientRect().top + (scroller === mainEl() ? trailHeight() : 40);
  if (mode === "center") {
    // A third of the way down what shows: the line, and what it unfolds to, in view.
    const bottom = Math.min(scroller.getBoundingClientRect().bottom, window.innerHeight);
    scroller.scrollTop += r.top - (top + (bottom - top) / 3);
    return;
  }
  if (mode === "start") {
    scroller.scrollTop += r.top - top - 24;
    return;
  }
  if (r.top < top + 8 || r.bottom > window.innerHeight - 40) scroller.scrollTop += r.top - top - 40;
}

/** Wait for React to have painted what was just set, then act. */
export function afterPaint(f: () => void): void {
  requestAnimationFrame(() => requestAnimationFrame(f));
}
