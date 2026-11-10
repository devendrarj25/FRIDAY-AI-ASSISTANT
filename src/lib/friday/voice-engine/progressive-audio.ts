/**
 * FRIDAY · play audio while it is still arriving.
 *
 * A streamed mp3 reply comes as pieces; a piece need not decode on its own. A `MediaSource` takes the pieces in
 * order and the audio element plays what it has, so the first words are heard before the clause is finished. The
 * element is created and attached at once (a MediaSource only opens once it is attached to an element) but not
 * played until the voice library asks, so a clause made ahead of its turn stays silent and keeps buffering.
 *
 * Everything the browser provides is injected, so this is tested without a browser. When `audio/mpeg` is not
 * supported the caller keeps the older way: join the pieces and play one clip.
 */

export type MediaImpl = {
  MediaSource: {
    new (): MediaSourceLike;
    isTypeSupported(type: string): boolean;
  };
  Audio: new () => AudioLike;
  URL: { createObjectURL(source: unknown): string; revokeObjectURL(url: string): void };
};

export type SourceBufferLike = {
  updating: boolean;
  appendBuffer(data: Uint8Array): void;
  /** Cancels an append in progress; present on real source buffers. */
  abort?(): void;
  addEventListener(name: "updateend" | "error", fn: () => void): void;
};

export type MediaSourceLike = {
  readyState: string;
  addSourceBuffer(type: string): SourceBufferLike;
  endOfStream(): void;
  addEventListener(name: "sourceopen", fn: () => void): void;
  removeSourceBuffer?(buffer: SourceBufferLike): void;
};

export type AudioLike = {
  src: string;
  preload: string;
  pause?(): void;
  removeAttribute?(name: string): void;
  load?(): void;
  addEventListener(name: "ended" | "error", fn: () => void, options?: { once: boolean }): void;
};

export const MP3_TYPE = "audio/mpeg";

export const progressiveSupported = (impl: MediaImpl | null | undefined): impl is MediaImpl =>
  Boolean(impl?.MediaSource?.isTypeSupported?.(MP3_TYPE));

export class ProgressiveAudio {
  readonly audio: AudioLike;
  private readonly source: MediaSourceLike;
  private buffer: SourceBufferLike | null = null;
  private readonly queue: Uint8Array[] = [];
  private finished = false;
  private url: string;
  private revoked = false;
  private failed = false;
  private disposed = false;

  constructor(private readonly impl: MediaImpl) {
    this.audio = new impl.Audio();
    this.audio.preload = "auto";
    this.source = new impl.MediaSource();
    this.url = impl.URL.createObjectURL(this.source);
    this.source.addEventListener("sourceopen", () => this.open());
    this.audio.src = this.url;
    const release = () => this.release();
    this.audio.addEventListener("ended", release, { once: true });
    this.audio.addEventListener("error", release, { once: true });
  }

  private open() {
    if (this.buffer || this.failed || this.disposed) return;
    try {
      this.buffer = this.source.addSourceBuffer(MP3_TYPE);
      this.buffer.addEventListener("updateend", () => this.pump());
      this.buffer.addEventListener("error", () => {
        this.failed = true;
        this.release();
      });
      this.pump();
    } catch {
      this.failed = true;
      this.release();
    }
  }

  private pump() {
    const buffer = this.buffer;
    if (!buffer || this.failed || this.disposed || buffer.updating) return;
    const next = this.queue.shift();
    if (next) {
      try {
        buffer.appendBuffer(next);
      } catch {
        this.failed = true;
        this.release();
      }
      return;
    }
    if (this.finished && this.source.readyState === "open") {
      try {
        this.source.endOfStream();
      } catch {
        /* already ended */
      }
    }
  }

  /** Add the next piece, in order. */
  append(bytes: Uint8Array) {
    if (this.failed || this.finished || this.disposed) return;
    this.queue.push(bytes);
    this.pump();
  }

  /** No more pieces: close the stream once the queue is written. */
  end() {
    if (this.disposed) return;
    this.finished = true;
    this.pump();
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  /** Pieces written to the queue and not yet handed to the source buffer. */
  get queuedPieces(): number {
    return this.queue.length;
  }

  /**
   * Cancel: stop the element, drop every queued piece, close the stream and give back the object URL, whatever
   * state it is in (not yet open, mid-append, finished, already failed). Safe to call twice; every later call to
   * append, end or a late browser event does nothing. Used when the owner interrupts, so a clause that was still
   * arriving cannot keep its MediaSource, its buffers or its URL alive.
   */
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.finished = true;
    this.queue.length = 0;
    try {
      this.audio.pause?.();
    } catch {
      /* already stopped */
    }
    const buffer = this.buffer;
    if (buffer) {
      try {
        if (buffer.updating) buffer.abort?.();
      } catch {
        /* nothing to abort */
      }
    }
    if (this.source.readyState === "open") {
      try {
        this.source.endOfStream();
      } catch {
        /* already ended */
      }
    }
    this.release();
    try {
      // Detach the element from the stream so the browser can free the decoder and the buffered audio.
      this.audio.removeAttribute?.("src");
      this.audio.load?.();
    } catch {
      /* the element is gone */
    }
  }

  get isFailed(): boolean {
    return this.failed;
  }

  private release() {
    if (this.revoked) return;
    this.revoked = true;
    try {
      this.impl.URL.revokeObjectURL(this.url);
    } catch {
      /* nothing to release */
    }
  }
}
