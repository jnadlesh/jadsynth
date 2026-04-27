// Single-HTMLAudioElement player for mobile.
//
// iOS Safari only lets each HTMLAudioElement autoplay if .play() was
// called once during a user gesture on THAT specific element. Howler
// (html5: true) creates a new element per track, which means lock-screen
// next/prev silently fails — the new element was never primed by a tap.
//
// MobilePlayer wraps a single Audio() that lives for the whole session.
// `setSrc()` swaps the URL without recreating the element, so the
// gesture-primed status carries across all tracks. The exposed surface
// matches the subset of Howler's API we actually use.

interface MobilePlayerOptions {
  src: string;
  volume?: number;
  rate?: number;
  onend?: () => void;
}

export class MobilePlayer {
  private audio: HTMLAudioElement;
  private endHandler?: () => void;
  private soundId = 1;

  private playRetryHandler?: () => void;

  constructor(opts: MobilePlayerOptions) {
    this.audio = new Audio();
    this.audio.preload = "auto";
    if (opts.rate != null) this.audio.playbackRate = opts.rate;
    if (opts.volume != null)
      this.audio.volume = Math.max(0, Math.min(1, opts.volume));
    if (opts.onend) {
      this.endHandler = opts.onend;
      this.audio.addEventListener("ended", this.endHandler);
    }
    this.audio.src = opts.src;
  }

  private clearPlayRetry() {
    if (this.playRetryHandler) {
      this.audio.removeEventListener("canplay", this.playRetryHandler);
      this.playRetryHandler = undefined;
    }
  }

  play(_id?: number): number {
    this.clearPlayRetry();

    const tryPlay = () => {
      const promise = this.audio.play();
      if (promise && typeof promise.catch === "function") {
        promise.catch((err: unknown) => {
          // AbortError: a new src/load interrupted us. Wait for canplay
          // and retry — the element is already gesture-primed from earlier
          // taps, so iOS allows the deferred play.
          const name =
            err && typeof err === "object" && "name" in err
              ? (err as { name?: string }).name
              : undefined;
          if (name === "AbortError" || name === "NotSupportedError") {
            this.playRetryHandler = () => {
              this.clearPlayRetry();
              this.audio.play().catch(() => {});
            };
            this.audio.addEventListener("canplay", this.playRetryHandler, {
              once: true,
            });
          }
          /* NotAllowedError = autoplay blocked, can't fix without gesture */
        });
      }
    };

    tryPlay();
    return this.soundId;
  }

  pause(_id?: number): this {
    this.audio.pause();
    return this;
  }

  stop(_id?: number): this {
    this.audio.pause();
    try {
      this.audio.currentTime = 0;
    } catch {
      /* ignore */
    }
    return this;
  }

  playing(_id?: number): boolean {
    return !this.audio.paused && !this.audio.ended;
  }

  seek(): number;
  seek(seconds: number): this;
  seek(seconds?: number): number | this {
    if (seconds === undefined) {
      return this.audio.currentTime || 0;
    }
    try {
      this.audio.currentTime = seconds;
    } catch {
      /* element not ready — ignore */
    }
    return this;
  }

  duration(): number {
    return this.audio.duration || 0;
  }

  volume(): number;
  volume(v: number): this;
  volume(v?: number): number | this {
    if (v === undefined) return this.audio.volume;
    this.audio.volume = Math.max(0, Math.min(1, v));
    return this;
  }

  rate(r: number): this {
    this.audio.playbackRate = Math.max(0.0625, Math.min(16, r));
    return this;
  }

  unload(): void {
    this.clearPlayRetry();
    this.audio.pause();
    if (this.endHandler) {
      this.audio.removeEventListener("ended", this.endHandler);
      this.endHandler = undefined;
    }
    try {
      this.audio.removeAttribute("src");
    } catch {
      /* ignore */
    }
  }

  // Swap the audio source without recreating the underlying element.
  // The element's gesture-primed status persists across tracks.
  setSrc(src: string): void {
    if (this.audio.src.endsWith(src)) return;
    this.clearPlayRetry();
    // Setting .src triggers the load automatically. Calling .load()
    // explicitly aborts any in-flight play() promise with AbortError.
    this.audio.src = src;
  }

  setOnEnded(handler: () => void): void {
    if (this.endHandler) {
      this.audio.removeEventListener("ended", this.endHandler);
    }
    this.endHandler = handler;
    this.audio.addEventListener("ended", handler);
  }

  // Howler-compatible internal accessor used by audio-graph for analyser
  // attachment. Skipped on mobile (the analyser hook bails on small
  // viewports), but matching the shape avoids type gymnastics in callers.
  get _sounds(): Array<{ _node: HTMLAudioElement }> {
    return [{ _node: this.audio }];
  }
}
