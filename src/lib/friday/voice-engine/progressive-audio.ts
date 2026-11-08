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
  addEventListener(name: "updateend" | "error", fn: () => void): void;
};

export type MediaSourceLike = {
  readyState: string;
  addSourceBuffer(type: string): SourceBufferLike;
  endOfStream(): void;
  addEventListener(name: "sourceopen", fn: () => void): void;
};

export type AudioLike = {
  src: string;
  preload: string;
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
    if (this.buffer || this.failed) return;
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
    if (!buffer || this.failed || buffer.updating) return;
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
    if (this.failed || this.finished) return;
    this.queue.push(bytes);
    this.pump();
  }

  /** No more pieces: close the stream once the queue is written. */
  end() {
    this.finished = true;
    this.pump();
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
