import { Platform } from "react-native";

/**
 * Keys and drag and drop on the web and desktop apps, for the inspector (client/inspector.tsx) and the
 * board (client/board.tsx). React Native has neither key events outside a text input nor drag and
 * drop, so this listens on the page itself; on iOS and Android it does nothing and the screens'
 * buttons are the way.
 */

/** The parts of a DOM key event the inspector reads. */
interface KeyEvent {
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  defaultPrevented: boolean;
  target: unknown;
  preventDefault(): void;
}

interface Page {
  addEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  removeEventListener(type: "keydown", listener: (event: KeyEvent) => void): void;
  document?: { querySelector(selector: string): unknown; elementFromPoint?(x: number, y: number): unknown };
}

/** The parts of a DOM element `onView` reads; on the web a View's ref is one. */
interface Element {
  isConnected?: boolean;
  getBoundingClientRect(): { left: number; top: number; width: number; height: number };
  contains(other: unknown): boolean;
}

/** Whether a key went to something that takes text: a key there is typing, not navigation. */
function typing(target: unknown): boolean {
  const t = target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (!t || typeof t !== "object") return false;
  const tag = typeof t.tagName === "string" ? t.tagName.toUpperCase() : "";
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable === true;
}

/**
 * Whether `node` (a View's ref) is what the person sees at its own centre: false for a screen the
 * host keeps mounted under another one, and for a panel a dialog's backdrop covers. Off the web, or
 * when the page cannot tell, false.
 */
export function onView(node: unknown): boolean {
  if (Platform.OS !== "web") return false;
  const page = globalThis as unknown as Partial<Page>;
  const el = node as Partial<Element> | null;
  if (!el || typeof el.getBoundingClientRect !== "function" || typeof el.contains !== "function" || el.isConnected === false) return false;
  if (typeof page.document?.elementFromPoint !== "function") return false;
  const box = el.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return false;
  return el.contains(page.document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2));
}

/**
 * Calls `handler` with the key of each keydown on the page that is not typing and not under an open
 * dialog; `handler` returns whether it used the key, which then goes no further. Returns the
 * cleanup; a no-op off the web.
 */
export function onPageKey(handler: (key: { key: string; alt: boolean }) => boolean): () => void {
  if (Platform.OS !== "web") return () => {};
  const page = globalThis as unknown as Partial<Page>;
  if (typeof page.addEventListener !== "function" || typeof page.removeEventListener !== "function") return () => {};
  const listener = (event: KeyEvent) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.shiftKey || typing(event.target)) return;
    // A host dialog (a form, a confirmation) owns Escape and the arrows while it is open.
    if (page.document?.querySelector('[role="dialog"], [aria-modal="true"]')) return;
    if (handler({ key: event.key, alt: event.altKey })) event.preventDefault();
  };
  page.addEventListener("keydown", listener);
  return () => page.removeEventListener!("keydown", listener);
}

/** The parts of a DOM drag event the board reads. */
interface DragEvent {
  clientY: number;
  preventDefault(): void;
  stopPropagation(): void;
  dataTransfer?: { setData(type: string, value: string): void; effectAllowed?: string; dropEffect?: string } | null;
}

/** The parts of a DOM element drag and drop needs; on the web a View's ref is one. */
interface DragNode {
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
  addEventListener(type: string, listener: (event: DragEvent) => void): void;
  removeEventListener(type: string, listener: (event: DragEvent) => void): void;
  getBoundingClientRect(): { top: number; height: number };
}

const asDragNode = (node: unknown): DragNode | undefined => {
  if (Platform.OS !== "web") return undefined;
  const n = node as Partial<DragNode> | null;
  return n && typeof n.addEventListener === "function" && typeof n.setAttribute === "function" && typeof n.getBoundingClientRect === "function" ? (n as DragNode) : undefined;
};

/** The id the page is dragging now; one drag at a time. */
let dragged: string | undefined;

/**
 * Makes `node` (a View's ref) draggable on the web and desktop apps, carrying `id`; `onEnd` runs when
 * the drag ends, dropped or not. React Native has no drag and drop, so off the web this does nothing
 * and the board's buttons are the way. Returns the cleanup.
 */
export function draggable(node: unknown, id: string, onEnd: () => void): () => void {
  const el = asDragNode(node);
  if (!el) return () => {};
  const start = (event: DragEvent) => {
    dragged = id;
    // Firefox starts a drag only with data set.
    event.dataTransfer?.setData("text/plain", id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  };
  const end = () => {
    dragged = undefined;
    onEnd();
  };
  el.setAttribute("draggable", "true");
  el.addEventListener("dragstart", start);
  el.addEventListener("dragend", end);
  return () => {
    // A card gone mid-drag (a refresh moved it) may never see its dragend.
    if (dragged === id) dragged = undefined;
    el.removeAttribute("draggable");
    el.removeEventListener("dragstart", start);
    el.removeEventListener("dragend", end);
  };
}

/**
 * Takes drops on `node` (a View's ref) on the web: `over` while a drag of `draggable` is above it,
 * `drop` with the dragged id and whether it landed in the lower half. A drop target inside another
 * takes the drop alone. Off the web a no-op. Returns the cleanup.
 */
export function dropTarget(node: unknown, handlers: { over?: () => void; drop: (id: string, after: boolean) => void }): () => void {
  const el = asDragNode(node);
  if (!el) return () => {};
  const over = (event: DragEvent) => {
    if (!dragged) return;
    // Without this the page refuses the drop.
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    handlers.over?.();
  };
  const drop = (event: DragEvent) => {
    const id = dragged;
    if (!id) return;
    event.preventDefault();
    event.stopPropagation();
    const box = el.getBoundingClientRect();
    handlers.drop(id, event.clientY > box.top + box.height / 2);
  };
  el.addEventListener("dragover", over);
  el.addEventListener("drop", drop);
  return () => {
    el.removeEventListener("dragover", over);
    el.removeEventListener("drop", drop);
  };
}
