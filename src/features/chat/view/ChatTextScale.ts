import type { Component } from 'obsidian';

/** Smallest and largest chat text scale, relative to the size Claudian derives from the note font size. */
export const TEXT_SCALE_MIN = 0.5;
export const TEXT_SCALE_MAX = 3;
/** One mouse-wheel notch or command step changes the scale by this factor. */
export const TEXT_SCALE_STEP = 1.1;

/** Obsidian local-storage key (per vault and device) holding the scale. */
export const CHAT_TEXT_SCALE_STORAGE_KEY = 'claudian-chat-text-scale';

/** Read by `--claudian-font-px` and the message text size in `src/style`. */
const SCALE_PROPERTY = '--claudian-text-scale';
/** Wheel deltas this large come from a mouse-wheel notch; smaller ones from a trackpad pinch or smooth scrolling. */
const WHEEL_NOTCH_DELTA = 50;
/** A pinch or a run of wheel notches is saved once it has settled. */
const SAVE_DELAY_MS = 500;

export function clampTextScale(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 1;
  const clamped = Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, value));
  return Math.round(clamped * 1000) / 1000;
}

/** The scale after one Ctrl+wheel event: a fixed step per notch, continuous for small deltas. */
export function wheelTextScale(current: number, deltaY: number, deltaMode: number): number {
  if (deltaY === 0) return clampTextScale(current);
  const notch = deltaMode !== 0 || Math.abs(deltaY) >= WHEEL_NOTCH_DELTA;
  const factor = notch
    ? (deltaY < 0 ? TEXT_SCALE_STEP : 1 / TEXT_SCALE_STEP)
    : Math.exp(-deltaY / 100);
  return clampTextScale(current * factor);
}

/** Where the per-device scale is kept; `null` clears it. */
export interface TextScaleStore {
  load(): unknown;
  save(value: number | null): void;
}

interface TouchPoint {
  readonly clientX: number;
  readonly clientY: number;
}

function touchDistance(touches: ArrayLike<TouchPoint>): number {
  const a = touches[0];
  const b = touches[1];
  if (!a || !b) return 0;
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/**
 * The single owner of the chat text scale on this device. It is a multiplier on the sizes Claudian already
 * derives from Obsidian's note font size, set on each document's body so every Claudian surface there follows it.
 */
export class ChatTextScale {
  #value: number;
  readonly #store: TextScaleStore;
  /** Documents holding a bound surface, with how many surfaces each holds. */
  readonly #documents = new Map<Document, number>();
  #pendingSave: { readonly win: Window; readonly id: number } | null = null;

  constructor(store: TextScaleStore) {
    this.#store = store;
    const stored = store.load();
    this.#value = typeof stored === 'number' || typeof stored === 'string' ? clampTextScale(Number(stored)) : 1;
  }

  get value(): number {
    return this.#value;
  }

  set(value: number): void {
    const next = clampTextScale(value);
    if (next === this.#value) return;
    this.#value = next;
    for (const doc of this.#documents.keys()) this.#apply(doc);
    this.#scheduleSave();
  }

  step(direction: 1 | -1): void {
    this.set(this.#value * (direction > 0 ? TEXT_SCALE_STEP : 1 / TEXT_SCALE_STEP));
  }

  reset(): void {
    this.set(1);
  }

  /** Applies the scale to `el`'s document and resizes on Ctrl+scroll or a pinch over `el` until `component` unloads. */
  bind(component: Component, el: HTMLElement): void {
    const doc = el.ownerDocument;
    this.#documents.set(doc, (this.#documents.get(doc) ?? 0) + 1);
    this.#apply(doc);
    const unbind = this.#bindGestures(el);
    component.register(() => {
      unbind();
      const count = (this.#documents.get(doc) ?? 1) - 1;
      if (count > 0) {
        this.#documents.set(doc, count);
      } else {
        this.#documents.delete(doc);
        doc.body.style.removeProperty(SCALE_PROPERTY);
      }
    });
  }

  /** Saves a pending change and removes the scale from every document. */
  dispose(): void {
    if (this.#pendingSave) {
      this.#pendingSave.win.clearTimeout(this.#pendingSave.id);
      this.#pendingSave = null;
      this.#store.save(this.#value === 1 ? null : this.#value);
    }
    for (const doc of this.#documents.keys()) doc.body.style.removeProperty(SCALE_PROPERTY);
    this.#documents.clear();
  }

  #apply(doc: Document): void {
    if (this.#value === 1) {
      doc.body.style.removeProperty(SCALE_PROPERTY);
    } else {
      doc.body.style.setProperty(SCALE_PROPERTY, String(this.#value));
    }
  }

  #scheduleSave(): void {
    const win = this.#documents.keys().next().value?.defaultView ?? window;
    if (this.#pendingSave) this.#pendingSave.win.clearTimeout(this.#pendingSave.id);
    const id = win.setTimeout(() => {
      this.#pendingSave = null;
      this.#store.save(this.#value === 1 ? null : this.#value);
    }, SAVE_DELAY_MS);
    this.#pendingSave = { win, id };
  }

  #bindGestures(el: HTMLElement): () => void {
    let pinch: { readonly startScale: number; readonly startDistance: number } | null = null;
    let gestureStartScale: number | null = null;

    // Capture, so the transcript's own scroll handling never sees a resize gesture; stopping it here also keeps
    // Obsidian's quick font size adjustment from resizing note text at the same time.
    const onWheel = (event: WheelEvent): void => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      event.stopPropagation();
      this.set(wheelTextScale(this.#value, event.deltaY, event.deltaMode));
    };
    const onTouchStart = (event: TouchEvent): void => {
      const distance = event.touches.length === 2 ? touchDistance(event.touches) : 0;
      pinch = distance > 0 ? { startScale: this.#value, startDistance: distance } : null;
    };
    const onTouchMove = (event: TouchEvent): void => {
      if (!pinch || event.touches.length !== 2) return;
      event.preventDefault();
      const distance = touchDistance(event.touches);
      if (distance > 0) this.set(pinch.startScale * distance / pinch.startDistance);
    };
    const onTouchEnd = (event: TouchEvent): void => {
      if (event.touches.length !== 2) pinch = null;
    };
    // Safari reports a pinch as non-standard gesture events. On iOS the touch handlers above already follow the
    // pinch, so these only stop the page zooming; Safari on a Mac trackpad sends gesture events alone.
    const onGestureStart = (event: Event): void => {
      event.preventDefault();
      gestureStartScale = this.#value;
    };
    const onGestureChange = (event: Event): void => {
      event.preventDefault();
      const gestureScale = (event as Event & { scale?: unknown }).scale;
      if (pinch || gestureStartScale === null || typeof gestureScale !== 'number') return;
      this.set(gestureStartScale * gestureScale);
    };
    const onGestureEnd = (): void => {
      gestureStartScale = null;
    };

    const active = { capture: true, passive: false } as const;
    el.addEventListener('wheel', onWheel, active);
    el.addEventListener('touchstart', onTouchStart, { capture: true, passive: true });
    el.addEventListener('touchmove', onTouchMove, active);
    el.addEventListener('touchend', onTouchEnd, { capture: true, passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { capture: true, passive: true });
    el.addEventListener('gesturestart', onGestureStart, active);
    el.addEventListener('gesturechange', onGestureChange, active);
    el.addEventListener('gestureend', onGestureEnd, { capture: true, passive: true });
    return () => {
      el.removeEventListener('wheel', onWheel, active);
      el.removeEventListener('touchstart', onTouchStart, { capture: true });
      el.removeEventListener('touchmove', onTouchMove, active);
      el.removeEventListener('touchend', onTouchEnd, { capture: true });
      el.removeEventListener('touchcancel', onTouchEnd, { capture: true });
      el.removeEventListener('gesturestart', onGestureStart, active);
      el.removeEventListener('gesturechange', onGestureChange, active);
      el.removeEventListener('gestureend', onGestureEnd, { capture: true });
    };
  }
}
