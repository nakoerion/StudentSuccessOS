/**
 * Hold a decision for an undo window before sending it. Undo inside the window simply
 * never sends it, so undo never has to reverse a saved row (the action inbox's model).
 * Framework-free so the "undo before save sends nothing" rule is unit-tested.
 */
export interface UndoQueue<T> {
  /** Hold `item`; it is committed after the window unless undone. Returns its key. */
  schedule(item: T): number;
  /** Drop a held item before it is sent. False if it was already sent (or unknown). */
  undo(key: number): boolean;
  /** Send one held item now (or all of them). */
  flush(key?: number): Promise<void>;
  pending(): { key: number; item: T }[];
}

export function createUndoQueue<T>(opts: {
  delayMs: number;
  commit: (item: T) => Promise<void>;
  onChange?: () => void;
}): UndoQueue<T> {
  const held = new Map<number, { item: T; timer: ReturnType<typeof setTimeout> }>();
  let next = 0;

  const send = async (key: number) => {
    const entry = held.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    held.delete(key);
    opts.onChange?.();
    await opts.commit(entry.item);
  };

  return {
    schedule(item) {
      const key = ++next;
      held.set(key, { item, timer: setTimeout(() => void send(key), opts.delayMs) });
      opts.onChange?.();
      return key;
    },
    undo(key) {
      const entry = held.get(key);
      if (!entry) return false;
      clearTimeout(entry.timer);
      held.delete(key);
      opts.onChange?.();
      return true;
    },
    async flush(key) {
      const keys = key === undefined ? [...held.keys()] : [key];
      await Promise.all(keys.map((k) => send(k)));
    },
    pending() {
      return [...held.entries()].map(([key, { item }]) => ({ key, item }));
    },
  };
}
