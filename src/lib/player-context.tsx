import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Howl } from "howler";
import { tracks as allTracks, type Track } from "./tracks";
import { shuffleTracksArtFirst } from "./shuffle-tracks";
import { freeBuffersExcept, prepareTrack } from "./scrub-engine";

export type ScrubDirection = "none" | "ffwd" | "rewind";

type PlayerState = {
  currentIndex: number;
  isPlaying: boolean;
  rate: number;
  volume: number;
  current: Track;
  tracks: Track[];
  catalogOpen: boolean;
  scrubDirection: ScrubDirection;
  setScrubDirection: (d: ScrubDirection) => void;
  howlRef: React.MutableRefObject<Howl | null>;
  rateLockRef: React.MutableRefObject<boolean>;
  setIndex: (i: number) => void;
  next: () => void;
  prev: () => void;
  toggle: () => void;
  setRate: (r: number) => void;
  setVolume: (v: number) => void;
  openCatalog: () => void;
  closeCatalog: () => void;
  toggleCatalog: () => void;
};

const PlayerContext = createContext<PlayerState | null>(null);

export function PlayerProvider({ children }: { children: ReactNode }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [rate, setRateState] = useState(1);
  const [volume, setVolumeState] = useState(() => {
    if (typeof window === "undefined") return 0.8;
    const stored = window.localStorage.getItem("jadsynth.volume");
    if (stored === null) return 0.8;
    const parsed = parseFloat(stored);
    if (!Number.isFinite(parsed)) return 0.8;
    return Math.max(0, Math.min(1, parsed));
  });
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [scrubDirection, setScrubDirection] = useState<ScrubDirection>("none");
  const [tracks, setTracks] = useState<Track[]>(allTracks);

  useEffect(() => {
    setTracks(shuffleTracksArtFirst());
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const isMobile = window.matchMedia("(max-width: 767px)").matches;
    if (isMobile) return;
    const src = tracks[currentIndex]?.src;
    if (!src) return;
    prepareTrack(src).catch(() => {});
    freeBuffersExcept([src]);
  }, [currentIndex, tracks]);

  const howlRef = useRef<Howl | null>(null);
  const soundIdRef = useRef<number | null>(null);
  const rateLockRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const volumeRef = useRef(volume);
  const crossfadeRafRef = useRef<number | null>(null);
  const crossfadePrevRef = useRef<Howl | null>(null);

  useEffect(() => {
    volumeRef.current = volume;
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem("jadsynth.volume", String(volume));
    } catch {
      /* storage unavailable / quota — ignore */
    }
  }, [volume]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
      if (crossfadeRafRef.current !== null)
        cancelAnimationFrame(crossfadeRafRef.current);
      crossfadePrevRef.current?.unload();
      howlRef.current?.unload();
    };
  }, []);

  const skipNextLoadRef = useRef(false);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Lock-screen / Bluetooth next-prev pre-loaded the Howl synchronously
    // inside the gesture window so iOS would actually play it. Skip the
    // normal load path here so we don't double-create.
    if (skipNextLoadRef.current) {
      skipNextLoadRef.current = false;
      return;
    }

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    rateLockRef.current = false;

    if (crossfadeRafRef.current !== null) {
      cancelAnimationFrame(crossfadeRafRef.current);
      crossfadeRafRef.current = null;
    }
    if (crossfadePrevRef.current) {
      crossfadePrevRef.current.unload();
      crossfadePrevRef.current = null;
    }

    const prev = howlRef.current;
    const prevId = soundIdRef.current;

    const sound = new Howl({
      src: [tracks[currentIndex].src],
      html5: true,
      rate: 1,
      volume: 0,
      onend: () => setCurrentIndex((i) => (i + 1) % tracks.length),
    });
    howlRef.current = sound;
    soundIdRef.current = null;

    const isSmallViewport =
      typeof window !== "undefined" &&
      window.matchMedia("(max-width: 767px)").matches;

    if (isPlaying && prev && prev.playing(prevId ?? undefined) && !isSmallViewport) {
      crossfadePrevRef.current = prev;
      soundIdRef.current = sound.play();

      const CROSSFADE_DURATION = 1.2;
      const startTime = performance.now();
      const prevStartVol = prev.volume();
      const targetVol = volumeRef.current;

      const tick = () => {
        const t = (performance.now() - startTime) / 1000;
        const p = Math.min(1, t / CROSSFADE_DURATION);

        const inEased = Math.sin((p * Math.PI) / 2);
        const outEased = Math.cos((p * Math.PI) / 2);

        sound.volume(Math.max(0, Math.min(1, targetVol * inEased)));
        prev.volume(Math.max(0, prevStartVol * outEased));

        if (p >= 1) {
          sound.volume(volumeRef.current);
          prev.stop();
          prev.unload();
          crossfadePrevRef.current = null;
          crossfadeRafRef.current = null;
          return;
        }
        crossfadeRafRef.current = requestAnimationFrame(tick);
      };
      crossfadeRafRef.current = requestAnimationFrame(tick);
    } else {
      prev?.unload();
      sound.volume(volumeRef.current);
      if (isPlaying) {
        soundIdRef.current = sound.play();
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentIndex, tracks]);

  useEffect(() => {
    if (rateLockRef.current) return;
    howlRef.current?.rate(rate);
  }, [rate]);

  useEffect(() => {
    if (rateLockRef.current) return;
    howlRef.current?.volume(volume);
  }, [volume]);

  useEffect(() => {
    const h = howlRef.current;
    if (!h) return;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }

    const FADE_OUT_DURATION = 0.6;

    if (isPlaying) {
      rateLockRef.current = false;
      const alreadyPlaying = h.playing(soundIdRef.current ?? undefined);
      if (!alreadyPlaying) {
        h.volume(volumeRef.current);
        if (soundIdRef.current !== null) {
          h.play(soundIdRef.current);
        } else {
          soundIdRef.current = h.play();
        }
      } else {
        h.volume(volumeRef.current);
      }
    } else {
      if (!h.playing(soundIdRef.current ?? undefined)) {
        return;
      }

      // On mobile, the rapid h.volume() calls in the fade loop cause
      // HTMLAudioElement to hiccup / loop the same buffer chunk. Skip the
      // tape-stop fade entirely on small viewports — just pause cleanly.
      const isSmallViewport =
        typeof window !== "undefined" &&
        window.matchMedia("(max-width: 767px)").matches;

      if (isSmallViewport) {
        h.pause();
        h.volume(volumeRef.current);
        return;
      }

      rateLockRef.current = true;
      const start = performance.now();
      const startVol = h.volume();

      const tick = () => {
        if (!rateLockRef.current) return;
        const t = (performance.now() - start) / 1000;
        const p = Math.min(1, t / FADE_OUT_DURATION);

        const v = startVol * Math.cos((p * Math.PI) / 2);
        h.volume(Math.max(0, v));

        if (p >= 1) {
          h.volume(0);
          h.pause();
          h.volume(volumeRef.current);
          rateLockRef.current = false;
          rafRef.current = null;
          return;
        }
        rafRef.current = requestAnimationFrame(tick);
      };
      rafRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying]);

  const setIndex = useCallback((i: number) => {
    setCurrentIndex(((i % tracks.length) + tracks.length) % tracks.length);
    setIsPlaying(true);
  }, []);

  const next = useCallback(() => setIndex(currentIndex + 1), [currentIndex, setIndex]);
  const prev = useCallback(() => setIndex(currentIndex - 1), [currentIndex, setIndex]);
  const toggle = useCallback(() => setIsPlaying((p) => !p), []);

  const current = tracks[currentIndex];

  // Stable refs so the action handlers always read the latest values
  // without ever being re-registered (re-registration causes a brief gap
  // iOS treats as "no handler set" and disables the corresponding control).
  const tracksRef = useRef(tracks);
  const currentIndexRef = useRef(currentIndex);
  const setIsPlayingRef = useRef(setIsPlaying);
  useEffect(() => {
    tracksRef.current = tracks;
    currentIndexRef.current = currentIndex;
    setIsPlayingRef.current = setIsPlaying;
  });

  // Synchronously swap to the next/prev track inside the user-gesture
  // window. iOS Safari treats each HTMLAudioElement separately for autoplay
  // — if we wait for the React effect to create the new Howl, the gesture
  // has expired and `play()` silently fails on the new element. Doing the
  // unload/create/play here keeps it within the gesture.
  const swapTrackImmediate = useCallback((delta: 1 | -1) => {
    const total = tracksRef.current.length;
    if (total === 0) return;
    const cur = currentIndexRef.current;
    const newIdx = (((cur + delta) % total) + total) % total;
    const newSrc = tracksRef.current[newIdx]?.src;
    if (!newSrc) return;

    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (crossfadeRafRef.current !== null) {
      cancelAnimationFrame(crossfadeRafRef.current);
      crossfadeRafRef.current = null;
    }
    if (crossfadePrevRef.current) {
      try {
        crossfadePrevRef.current.unload();
      } catch {
        /* ignore */
      }
      crossfadePrevRef.current = null;
    }
    rateLockRef.current = false;

    if (howlRef.current) {
      try {
        howlRef.current.unload();
      } catch {
        /* ignore */
      }
    }

    const newHowl = new Howl({
      src: [newSrc],
      html5: true,
      rate: 1,
      volume: volumeRef.current,
      onend: () =>
        setCurrentIndex((i) => (i + 1) % tracksRef.current.length),
    });
    howlRef.current = newHowl;
    soundIdRef.current = newHowl.play();

    skipNextLoadRef.current = true;
    setCurrentIndex(newIdx);
    setIsPlayingRef.current(true);
  }, []);

  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    const ms = navigator.mediaSession;
    try {
      ms.setActionHandler("play", () => {
        const h = howlRef.current;
        if (h && !h.playing(soundIdRef.current ?? undefined)) {
          h.play(soundIdRef.current ?? undefined);
        }
        setIsPlayingRef.current(true);
      });
      ms.setActionHandler("pause", () => {
        const h = howlRef.current;
        if (h && h.playing(soundIdRef.current ?? undefined)) {
          h.pause();
        }
        setIsPlayingRef.current(false);
      });
      ms.setActionHandler("nexttrack", () => swapTrackImmediate(1));
      ms.setActionHandler("previoustrack", () => swapTrackImmediate(-1));
      ms.setActionHandler("seekto", (details) => {
        if (details.seekTime != null) {
          howlRef.current?.seek(details.seekTime);
        }
      });
      ms.setActionHandler("seekbackward", (details) => {
        const h = howlRef.current;
        if (!h) return;
        const cur = h.seek();
        const pos = typeof cur === "number" ? cur : 0;
        h.seek(Math.max(0, pos - (details.seekOffset ?? 10)));
      });
      ms.setActionHandler("seekforward", (details) => {
        const h = howlRef.current;
        if (!h) return;
        const cur = h.seek();
        const pos = typeof cur === "number" ? cur : 0;
        const dur = h.duration() || 0;
        h.seek(Math.min(dur - 0.1, pos + (details.seekOffset ?? 10)));
      });
    } catch {
      /* unsupported action — ignore */
    }
  }, [swapTrackImmediate]);

  // Update metadata when the track changes.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    if (typeof MediaMetadata === "undefined") return;

    const artwork: MediaImage[] = current.artworkSrc
      ? [
          {
            src: new URL(current.artworkSrc, window.location.origin).href,
            sizes: "1080x1080",
            type: "image/jpeg",
          },
        ]
      : [];

    navigator.mediaSession.metadata = new MediaMetadata({
      title: current.title,
      artist: current.album || "JADSYNTH",
      album: "JADSYNTH",
      artwork,
    });
  }, [current]);

  // Mirror the playback state — also re-asserts metadata when playback
  // starts (iOS sometimes drops it if it was set before any audio played).
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    navigator.mediaSession.playbackState = isPlaying ? "playing" : "paused";
  }, [isPlaying]);

  // Periodically push position state so the lock-screen scrubber works.
  // Only runs while playing — avoids unnecessary work on mobile.
  useEffect(() => {
    if (typeof navigator === "undefined" || !("mediaSession" in navigator)) {
      return;
    }
    if (!isPlaying) return;
    const ms = navigator.mediaSession;
    const id = window.setInterval(() => {
      const h = howlRef.current;
      if (!h) return;
      const dur = h.duration();
      if (typeof dur !== "number" || dur <= 0) return;
      const pos = h.seek();
      const seekTime = typeof pos === "number" ? pos : 0;
      try {
        ms.setPositionState({
          duration: dur,
          playbackRate: 1,
          position: Math.max(0, Math.min(dur, seekTime)),
        });
      } catch {
        /* setPositionState may throw if values invalid — ignore */
      }
    }, 2500);
    return () => clearInterval(id);
  }, [isPlaying]);
  const setRate = useCallback((r: number) => {
    setRateState(Math.max(0.25, Math.min(2.5, r)));
  }, []);
  const setVolume = useCallback((v: number) => {
    setVolumeState(Math.max(0, Math.min(1, v)));
  }, []);

  const openCatalog = useCallback(() => setCatalogOpen(true), []);
  const closeCatalog = useCallback(() => setCatalogOpen(false), []);
  const toggleCatalog = useCallback(() => setCatalogOpen((o) => !o), []);

  const value = useMemo<PlayerState>(
    () => ({
      currentIndex,
      isPlaying,
      rate,
      volume,
      current: tracks[currentIndex],
      tracks,
      catalogOpen,
      scrubDirection,
      setScrubDirection,
      howlRef,
      rateLockRef,
      setIndex,
      next,
      prev,
      toggle,
      setRate,
      setVolume,
      openCatalog,
      closeCatalog,
      toggleCatalog,
    }),
    [
      currentIndex,
      isPlaying,
      rate,
      volume,
      tracks,
      catalogOpen,
      scrubDirection,
      setIndex,
      next,
      prev,
      toggle,
      setRate,
      setVolume,
      openCatalog,
      closeCatalog,
      toggleCatalog,
    ],
  );

  return (
    <PlayerContext.Provider value={value}>{children}</PlayerContext.Provider>
  );
}

export function usePlayer() {
  const ctx = useContext(PlayerContext);
  if (!ctx) throw new Error("usePlayer must be used inside PlayerProvider");
  return ctx;
}
