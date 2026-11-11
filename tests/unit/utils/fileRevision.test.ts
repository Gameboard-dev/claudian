import { EventEmitter } from 'node:events';

const watchers: Array<EventEmitter & { close: ReturnType<typeof vi.fn>; listener: () => void }> = [];
let refuse = 0;

vi.mock('node:fs', async importOriginal => ({
  ...await importOriginal<typeof import('node:fs')>(),
  // The operating system's watch, as Node gives it: a refusal throws; a failure later is an 'error' event.
  watch: vi.fn((_path: string, _options: unknown, listener: () => void) => {
    if (refuse > 0) {
      refuse--;
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' });
    }
    const watcher = Object.assign(new EventEmitter(), { close: vi.fn(), listener });
    watchers.push(watcher);
    return watcher;
  }),
}));

import { watchFileChanges } from '@/utils/fileRevision';

beforeEach(() => {
  watchers.length = 0;
  refuse = 0;
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('watchFileChanges', () => {
  it('reports changes, and none once stopped', () => {
    const changes = vi.fn();
    const stop = watchFileChanges('/history.jsonl', changes);
    watchers[0].listener();
    expect(changes).toHaveBeenCalledTimes(1);
    stop?.();
    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    watchers[0].listener();
    expect(changes).toHaveBeenCalledTimes(1);
  });

  it('is null when the file cannot be watched at all', () => {
    refuse = 1;
    expect(watchFileChanges('/missing.jsonl', vi.fn())).toBeNull();
  });

  // A watch that fails later (a stream refused for a while, a dropped connection) must not end following silently.
  it('watches again after a failure, backing off, and reports a change once it does', () => {
    const changes = vi.fn();
    const stop = watchFileChanges('/history.jsonl', changes);
    refuse = 1; // the first attempt to watch again is refused too
    watchers[0].emit('error', new Error('gone'));
    expect(watchers[0].close).toHaveBeenCalledTimes(1);
    expect(watchers).toHaveLength(1);

    vi.advanceTimersByTime(1_000); // refused: tries again later, after a longer wait
    expect(watchers).toHaveLength(1);
    expect(changes).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_999);
    expect(watchers).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(watchers).toHaveLength(2);
    // changes may have been missed while it was not watching
    expect(changes).toHaveBeenCalledTimes(1);
    watchers[1].listener();
    expect(changes).toHaveBeenCalledTimes(2);

    stop?.();
    expect(watchers[1].close).toHaveBeenCalledTimes(1);
  });

  // In a browser the watch starts at once and is refused a moment later (a stream answered 429 or 403): the wait must
  // still grow, or a refused watch is retried every second for as long as the conversation is shown.
  it('keeps backing off while each new watch fails soon after it starts, and waits less again once one holds', () => {
    const stop = watchFileChanges('/history.jsonl', vi.fn());
    watchers[0].emit('error', new Error('refused'));
    vi.advanceTimersByTime(1_000);
    expect(watchers).toHaveLength(2);
    watchers[1].emit('error', new Error('refused')); // refused again, at once
    vi.advanceTimersByTime(1_999);
    expect(watchers).toHaveLength(2); // a longer wait, not one second again
    vi.advanceTimersByTime(1);
    expect(watchers).toHaveLength(3);
    watchers[2].emit('error', new Error('refused'));
    vi.advanceTimersByTime(3_999);
    expect(watchers).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(watchers).toHaveLength(4);

    watchers[3].listener(); // this one works: a change came through it
    watchers[3].emit('error', new Error('dropped later'));
    vi.advanceTimersByTime(1_000);
    expect(watchers).toHaveLength(5); // back to the shortest wait
    stop?.();
  });

  it('stops trying once stopped while it waits', () => {
    const stop = watchFileChanges('/history.jsonl', vi.fn());
    watchers[0].emit('error', new Error('gone'));
    stop?.();
    vi.advanceTimersByTime(120_000);
    expect(watchers).toHaveLength(1);
  });
});
