/** @vitest-environment jsdom */
// @test-ci {"inputs":["src/style/base/container.css"]}

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { Component } from 'obsidian';

import {
  ChatTextScale,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
  TEXT_SCALE_STEP,
  type TextScaleStore,
} from '@/features/chat/view/ChatTextScale';

const SCALE_PROPERTY = '--claudian-text-scale';
const SAVE_SETTLE_MS = 1000;

function createStore(initial: unknown = null): TextScaleStore & { saved: (number | null)[] } {
  const saved: (number | null)[] = [];
  return {
    saved,
    load: () => initial,
    save: (value) => { saved.push(value); },
  };
}

function bodyScale(): string {
  return document.body.style.getPropertyValue(SCALE_PROPERTY);
}

function wheel(target: HTMLElement, init: WheelEventInit): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  target.dispatchEvent(event);
  return event;
}

function touch(target: HTMLElement, type: string, points: [number, number][]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touches = points.map(([clientX, clientY]) => ({ clientX, clientY }));
  Object.defineProperty(event, 'touches', { value: touches });
  target.dispatchEvent(event);
  return event;
}

function mountPane(scale: ChatTextScale): { pane: HTMLElement; transcript: HTMLElement; component: Component } {
  const pane = document.body.createDiv({ cls: 'claudian-container' });
  const transcript = pane.createDiv({ cls: 'claudian-messages' });
  const component = new Component();
  component.load();
  scale.bind(component, pane);
  return { pane, transcript, component };
}

describe('ChatTextScale', () => {
  let windowWheels: WheelEvent[];
  const recordWindowWheel = (event: WheelEvent): void => { windowWheels.push(event); };

  beforeEach(() => {
    vi.useFakeTimers();
    windowWheels = [];
    // Stand-in for Obsidian's own Ctrl+scroll handler, which would resize note text as well.
    window.addEventListener('wheel', recordWindowWheel);
  });

  afterEach(() => {
    window.removeEventListener('wheel', recordWindowWheel);
    document.body.empty();
    document.body.style.removeProperty(SCALE_PROPERTY);
    vi.useRealTimers();
  });

  it('resizes chat text on Ctrl+scroll over the pane and keeps the event from Obsidian', () => {
    const scale = new ChatTextScale(createStore());
    const { transcript, component } = mountPane(scale);

    const up = wheel(transcript, { deltaY: -100, ctrlKey: true });
    expect(up.defaultPrevented).toBe(true);
    expect(windowWheels).toEqual([]);
    expect(Number(bodyScale())).toBeCloseTo(TEXT_SCALE_STEP, 3);

    wheel(transcript, { deltaY: 100, ctrlKey: true });
    expect(scale.value).toBe(1);

    component.unload();
  });

  it('leaves plain scrolling alone', () => {
    const scale = new ChatTextScale(createStore());
    const { transcript, component } = mountPane(scale);

    const plain = wheel(transcript, { deltaY: -100 });
    expect(plain.defaultPrevented).toBe(false);
    expect(windowWheels).toHaveLength(1);
    expect(scale.value).toBe(1);
    expect(bodyScale()).toBe('');

    component.unload();
  });

  it('scales continuously for small trackpad-pinch deltas', () => {
    const scale = new ChatTextScale(createStore());
    const { transcript, component } = mountPane(scale);

    wheel(transcript, { deltaY: -10, ctrlKey: true });
    expect(scale.value).toBeCloseTo(Math.exp(0.1), 3);

    component.unload();
  });

  it('follows a two-finger pinch and stops the browser zooming the page', () => {
    const scale = new ChatTextScale(createStore());
    const { transcript, component } = mountPane(scale);

    touch(transcript, 'touchstart', [[100, 100], [200, 100]]);
    const spread = touch(transcript, 'touchmove', [[50, 100], [250, 100]]);
    expect(spread.defaultPrevented).toBe(true);
    expect(scale.value).toBeCloseTo(2, 3);

    touch(transcript, 'touchend', [[50, 100]]);
    const oneFinger = touch(transcript, 'touchmove', [[60, 100]]);
    expect(oneFinger.defaultPrevented).toBe(false);
    expect(scale.value).toBeCloseTo(2, 3);

    component.unload();
  });

  it('keeps the scale within its bounds', () => {
    const scale = new ChatTextScale(createStore());
    const { transcript, component } = mountPane(scale);

    for (let i = 0; i < 60; i += 1) wheel(transcript, { deltaY: -100, ctrlKey: true });
    expect(scale.value).toBe(TEXT_SCALE_MAX);
    for (let i = 0; i < 60; i += 1) wheel(transcript, { deltaY: 100, ctrlKey: true });
    expect(scale.value).toBe(TEXT_SCALE_MIN);

    component.unload();
  });

  it('restores the saved scale, saves changes once they settle, and clears them on reset', () => {
    const store = createStore(1.5);
    const scale = new ChatTextScale(store);
    const { transcript, component } = mountPane(scale);
    expect(bodyScale()).toBe('1.5');

    wheel(transcript, { deltaY: -100, ctrlKey: true });
    wheel(transcript, { deltaY: -100, ctrlKey: true });
    expect(store.saved).toEqual([]);
    vi.advanceTimersByTime(SAVE_SETTLE_MS);
    expect(store.saved).toEqual([scale.value]);

    scale.reset();
    expect(bodyScale()).toBe('');
    vi.advanceTimersByTime(SAVE_SETTLE_MS);
    expect(store.saved.at(-1)).toBeNull();

    component.unload();
  });

  it('ignores a stored value that is not a usable scale', () => {
    for (const stored of ['big', -2, 0, Number.NaN, {}]) {
      expect(new ChatTextScale(createStore(stored)).value).toBe(1);
    }
  });

  it('removes its property from the document when the last pane closes', () => {
    const scale = new ChatTextScale(createStore(1.25));
    const first = mountPane(scale);
    const second = mountPane(scale);

    first.component.unload();
    expect(bodyScale()).toBe('1.25');
    second.component.unload();
    expect(bodyScale()).toBe('');

    wheel(second.transcript, { deltaY: -100, ctrlKey: true });
    expect(scale.value).toBe(1.25);
  });

  // The type scale and message text read the property: tests/unit/style/base/variables.test.ts and
  // components/messages.test.ts.
  it('keeps a mobile browser from zooming the page on a pinch over the pane', () => {
    // jsdom's CSS parser drops touch-action, so the declaration is read from the stylesheet itself.
    const css = readFileSync(join(process.cwd(), 'src/style/base/container.css'), 'utf-8');
    const paneRule = /(?:^|\n)\.claudian-container \{([^}]*)\}/.exec(css)?.[1] ?? '';

    expect(paneRule).toMatch(/touch-action: pan-x pan-y;/);
  });
});
