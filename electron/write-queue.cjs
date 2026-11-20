/**
 * Saves that never queue up and never block the window.
 *
 * Settings and the durable state files are saved often (every slider step, every caption). A save asked for while the
 * previous one for the same file is still running replaces whatever was waiting, so only the newest body is written
 * next and a burst of changes costs two writes, not fifty. Every caller still gets the result of the write that
 * carried its change. When the app closes, `flushSync` writes what is still waiting with the synchronous writer and
 * tells a write that is in flight not to publish an older body over it.
 */
"use strict";

function createWriteQueue() {
  const slots = new Map();
  const slotFor = (key) => {
    let slot = slots.get(key);
    if (!slot) {
      slot = { active: null, pending: null, epoch: 0 };
      slots.set(key, slot);
    }
    return slot;
  };

  async function pump(key, slot) {
    while (slot.pending) {
      const job = slot.pending;
      slot.pending = null;
      const epoch = slot.epoch;
      let result = false;
      try {
        result = await job.write(job.value, { shouldCommit: () => slot.epoch === epoch });
      } catch (error) {
        result = false;
        if (typeof job.onError === "function") job.onError(error);
      }
      for (const done of job.waiters) done(result);
    }
    slot.active = null;
  }

  /** Ask for `value` to be saved. Resolves to what `write` returned for the write that carried it. */
  function submit(key, value, { write, writeSync, onError }) {
    const slot = slotFor(key);
    return new Promise((resolve) => {
      if (slot.pending) {
        slot.pending.value = value;
        slot.pending.waiters.push(resolve);
      } else {
        slot.pending = { value, write, writeSync, onError, waiters: [resolve] };
      }
      if (!slot.active) slot.active = pump(key, slot);
    });
  }

  /** Resolves when nothing is running or waiting for `key`. */
  async function idle(key) {
    const slot = slots.get(key);
    while (slot && (slot.active || slot.pending)) {
      await (slot.active || Promise.resolve());
      if (slot.pending && !slot.active) slot.active = pump(key, slot);
    }
  }

  async function drain() {
    await Promise.all([...slots.keys()].map((key) => idle(key)));
  }

  /** The app is closing: write what is waiting now, with the synchronous writer. */
  function flushSync() {
    for (const slot of slots.values()) {
      if (!slot.pending) continue;
      const job = slot.pending;
      slot.pending = null;
      slot.epoch += 1;
      let result = false;
      try {
        result = job.writeSync ? job.writeSync(job.value) : false;
      } catch (error) {
        if (typeof job.onError === "function") job.onError(error);
      }
      for (const done of job.waiters) done(result);
    }
  }

  return { submit, idle, drain, flushSync };
}

module.exports = { createWriteQueue };
