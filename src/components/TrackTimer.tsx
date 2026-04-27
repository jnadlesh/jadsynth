import { useEffect, useRef, useState } from "react";
import { usePlayer } from "~/lib/player-context";
import { getScrubPosition } from "~/lib/scrub-engine";

function format(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function TrackTimer() {
  const { howlRef, currentIndex, isPlaying } = usePlayer();
  const [position, setPosition] = useState(0);
  const [duration, setDuration] = useState(0);

  useEffect(() => {
    setPosition(0);
    setDuration(0);
  }, [currentIndex]);

  const scrubbingRef = useRef(false);

  useEffect(() => {
    let raf = 0;
    let lastIntervalTick = 0;

    const tick = (now: number) => {
      const scrubPos = getScrubPosition();

      if (scrubPos !== null) {
        scrubbingRef.current = true;
        setPosition(scrubPos);
      } else if (now - lastIntervalTick >= 200 || scrubbingRef.current) {
        scrubbingRef.current = false;
        const h = howlRef.current;
        if (h) {
          const seek = h.seek();
          if (typeof seek === "number" && Number.isFinite(seek)) {
            setPosition(seek);
          }
          const d = h.duration();
          if (typeof d === "number" && d > 0) setDuration(d);
        }
        lastIntervalTick = now;
      }

      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [howlRef]);

  const pct = duration > 0 ? Math.min(1, position / duration) : 0;

  return (
    <div className="mt-4 flex w-48 flex-col items-center gap-2 sm:w-56 md:w-64">
      <div className="flex w-full items-center justify-between font-mono text-[0.65rem] uppercase tracking-[0.3em] text-bone/50 tabular-nums">
        <span>{format(position)}</span>
        <span className={isPlaying ? "text-bone/30" : "text-bone/20"}>
          {isPlaying ? "▶" : "❚❚"}
        </span>
        <span>{format(duration)}</span>
      </div>
      <div className="h-[2px] w-full overflow-hidden rounded-full bg-bone/10">
        <div
          className="h-full rounded-full bg-accent/60"
          style={{
            width: `${pct * 100}%`,
            transition: scrubbingRef.current ? "none" : "width 220ms linear",
          }}
        />
      </div>
    </div>
  );
}
