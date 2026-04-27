import { useEffect, useRef, type MutableRefObject } from "react";
import {
  attachMediaElement,
  getAnalyser,
  resumeAudio,
} from "./audio-graph";

// We only need the optional `_sounds[0]._node` field; both Howl and our
// MobilePlayer expose it.
export type AudioElementHost = {
  _sounds?: Array<{ _node?: HTMLAudioElement }>;
} | unknown;

export { duckOutput } from "./audio-graph";

type Result = {
  analyserRef: MutableRefObject<AnalyserNode | null>;
  dataRef: MutableRefObject<Uint8Array<ArrayBuffer> | null>;
};

export function useAudioAnalyser(
  howlRef: MutableRefObject<AudioElementHost | null>,
  currentIndex: number,
  isPlaying: boolean,
): Result {
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);

  useEffect(() => {
    if (typeof window === "undefined") return;
    // iOS Safari + createMediaElementSource has a well-known bug where it
    // can silently produce no audio output. Plus the Web Audio chain (LUFS,
    // limiter, analyser) is expensive on mobile. Skip the entire chain on
    // small viewports — audio plays directly through HTMLAudioElement.
    if (window.matchMedia("(max-width: 767px)").matches) return;

    let cancelled = false;
    let attempts = 0;

    const tryConnect = () => {
      if (cancelled) return;
      const h = howlRef.current as
        | { _sounds?: Array<{ _node?: HTMLAudioElement }> }
        | null;
      const node = h?._sounds?.[0]?._node;
      if (!node) {
        if (attempts++ < 600) requestAnimationFrame(tryConnect);
        return;
      }

      const ok = attachMediaElement(node);
      if (!ok) return;

      const analyser = getAnalyser();
      if (analyser) {
        analyserRef.current = analyser;
        dataRef.current = new Uint8Array(
          new ArrayBuffer(analyser.frequencyBinCount),
        );
      }
    };

    requestAnimationFrame(tryConnect);

    const onInteraction = () => resumeAudio();
    window.addEventListener("pointerdown", onInteraction);
    window.addEventListener("keydown", onInteraction);

    return () => {
      cancelled = true;
      window.removeEventListener("pointerdown", onInteraction);
      window.removeEventListener("keydown", onInteraction);
    };
  }, [howlRef, currentIndex, isPlaying]);

  return { analyserRef, dataRef };
}
