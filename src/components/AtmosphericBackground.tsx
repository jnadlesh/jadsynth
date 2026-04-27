import { useEffect, useRef, useState } from "react";
import { usePlayer } from "~/lib/player-context";
import { useAudioAnalyser } from "~/lib/use-audio-analyser";
import { MOODS, DEFAULT_MOOD, type MoodPreset } from "~/lib/moods";
import { deriveMoodFromImage } from "~/lib/derive-mood";

const TRANSITION_MS = 1500;

type Particle = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  baseSize: number;
  colorIdx: number;
  phase: number;
};

type RGB = { r: number; g: number; b: number };

function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "");
  const v =
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h.padEnd(6, "0");
  return {
    r: parseInt(v.slice(0, 2), 16),
    g: parseInt(v.slice(2, 4), 16),
    b: parseInt(v.slice(4, 6), 16),
  };
}

function rgbToHex({ r, g, b }: RGB): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpRgb(a: RGB, b: RGB, t: number): RGB {
  return {
    r: lerp(a.r, b.r, t),
    g: lerp(a.g, b.g, t),
    b: lerp(a.b, b.b, t),
  };
}

function rgbCss(c: RGB, alpha: number): string {
  return `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${alpha})`;
}

type HSL = { h: number; s: number; l: number };

function rgbToHsl({ r, g, b }: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  const d = max - min;
  if (d > 0.0001) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    switch (max) {
      case rn:
        h = ((gn - bn) / d + (gn < bn ? 6 : 0)) * 60;
        break;
      case gn:
        h = ((bn - rn) / d + 2) * 60;
        break;
      default:
        h = ((rn - gn) / d + 4) * 60;
    }
  }
  return { h, s, l };
}

function hslToRgb({ h, s, l }: HSL): RGB {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = ((h % 360) + 360) % 360 / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let rp = 0;
  let gp = 0;
  let bp = 0;
  if (hp < 1) [rp, gp, bp] = [c, x, 0];
  else if (hp < 2) [rp, gp, bp] = [x, c, 0];
  else if (hp < 3) [rp, gp, bp] = [0, c, x];
  else if (hp < 4) [rp, gp, bp] = [0, x, c];
  else if (hp < 5) [rp, gp, bp] = [x, 0, c];
  else [rp, gp, bp] = [c, 0, x];
  const m = l - c / 2;
  return {
    r: (rp + m) * 255,
    g: (gp + m) * 255,
    b: (bp + m) * 255,
  };
}

function modulateColor(
  baseColor: RGB,
  bass: number,
  treble: number,
  mid: number,
): RGB {
  const hsl = rgbToHsl(baseColor);
  const energy = bass * 0.6 + treble * 0.2 + mid * 0.1;
  const mellowFactor = 0.6;
  const targetS = Math.min(0.78, hsl.s * (mellowFactor + energy * 0.45));
  const targetL = Math.min(
    0.48,
    hsl.l * (0.78 + bass * 0.16 + treble * 0.08),
  );
  const targetH = hsl.h + (mid - 0.5) * 6;
  return hslToRgb({ h: targetH, s: targetS, l: targetL });
}

function parseBlur(filter: string): number {
  return parseFloat(filter.match(/blur\(([\d.]+)/)?.[1] ?? "40");
}

function smoothstep(t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function interpolateMood(
  from: MoodPreset,
  to: MoodPreset,
  rawT: number,
): MoodPreset {
  const t = smoothstep(rawT);
  const fromBg = hexToRgb(from.background);
  const toBg = hexToRgb(to.background);
  const fromColors = from.colors.map(hexToRgb);
  const toColors = to.colors.map(hexToRgb);
  return {
    name: "interpolated",
    background: rgbToHex(lerpRgb(fromBg, toBg, t)),
    colors: [
      rgbToHex(lerpRgb(fromColors[0], toColors[0], t)),
      rgbToHex(lerpRgb(fromColors[1], toColors[1], t)),
      rgbToHex(lerpRgb(fromColors[2], toColors[2], t)),
    ],
    particleCount: from.particleCount,
    sizeRange: from.sizeRange,
    driftSpeed: lerp(from.driftSpeed, to.driftSpeed, t),
    bassReactivity: lerp(from.bassReactivity, to.bassReactivity, t),
    trebleReactivity: lerp(from.trebleReactivity, to.trebleReactivity, t),
    blendMode: t > 0.5 ? to.blendMode : from.blendMode,
    filter: `blur(${lerp(parseBlur(from.filter), parseBlur(to.filter), t)}px)`,
    baseOpacity: lerp(from.baseOpacity, to.baseOpacity, t),
  };
}

export function AtmosphericBackground() {
  const { current, howlRef, currentIndex, isPlaying } = usePlayer();
  const { analyserRef, dataRef } = useAudioAnalyser(
    howlRef,
    currentIndex,
    isPlaying,
  );
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const initialMood: MoodPreset = current.mood
    ? MOODS[current.mood]
    : MOODS[DEFAULT_MOOD];

  const moodRef = useRef<MoodPreset>(initialMood);
  const targetMoodRef = useRef<MoodPreset>(initialMood);
  const transitionStartRef = useRef<number>(0);
  const [, forceTick] = useState(0);

  const startTransitionTo = (mood: MoodPreset) => {
    const elapsed = performance.now() - transitionStartRef.current;
    const t = Math.min(1, elapsed / TRANSITION_MS);
    moodRef.current = interpolateMood(
      moodRef.current,
      targetMoodRef.current,
      t,
    );
    targetMoodRef.current = mood;
    transitionStartRef.current = performance.now();
    forceTick((n) => n + 1);
  };

  useEffect(() => {
    let cancelled = false;

    if (current.mood) {
      startTransitionTo(MOODS[current.mood]);
      return;
    }

    if (current.artworkSrc) {
      deriveMoodFromImage(current.artworkSrc)
        .then((mood) => {
          if (cancelled) return;
          startTransitionTo(mood);
        })
        .catch(() => {
          if (cancelled) return;
          startTransitionTo(MOODS[DEFAULT_MOOD]);
        });
    } else {
      startTransitionTo(MOODS[DEFAULT_MOOD]);
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current.mood, current.artworkSrc]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const isSmallViewport = window.matchMedia("(max-width: 767px)").matches;
    const dpr = isSmallViewport
      ? 1
      : Math.min(window.devicePixelRatio || 1, 1.5);
    const particleCap = isSmallViewport ? 3 : Infinity;
    const blurScale = isSmallViewport ? 0.4 : 1;
    let particles: Particle[] = [];

    const VELOCITY_SCALE = 14;

    const initParticles = (mood: MoodPreset, w: number, h: number) => {
      const minSide = Math.min(w, h);
      const count = Math.min(mood.particleCount, particleCap);
      particles = Array.from({ length: count }, (_, i) => {
        const angle = Math.random() * Math.PI * 2;
        const speed =
          mood.driftSpeed * VELOCITY_SCALE * (0.6 + Math.random() * 0.8);
        return {
          x: Math.random() * w,
          y: Math.random() * h,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed,
          baseSize:
            (mood.sizeRange[0] +
              Math.random() * (mood.sizeRange[1] - mood.sizeRange[0])) *
            minSide,
          colorIdx: i,
          phase: Math.random() * Math.PI * 2,
        };
      });
    };

    const resize = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      initParticles(targetMoodRef.current, w, h);
    };

    resize();
    window.addEventListener("resize", resize);

    let raf = 0;
    let lastTime = performance.now();
    let frameSkip = 0;
    let smoothedBass = 0;
    let smoothedMid = 0;
    let smoothedTreble = 0;
    let bassPeak = 0;

    const draw = (now: number) => {
      if (isSmallViewport) {
        frameSkip = (frameSkip + 1) % 2;
        if (frameSkip === 0) {
          raf = requestAnimationFrame(draw);
          return;
        }
      }
      const dt = Math.min(0.05, (now - lastTime) / 1000);
      lastTime = now;

      const w = window.innerWidth;
      const h = window.innerHeight;

      const transitionT = Math.min(
        1,
        (now - transitionStartRef.current) / TRANSITION_MS,
      );
      const fromMood = moodRef.current;
      const toMood = targetMoodRef.current;
      const visible = interpolateMood(fromMood, toMood, transitionT);

      if (transitionT >= 1) moodRef.current = toMood;

      const visibleBlur = parseBlur(visible.filter) * blurScale;
      canvas.style.filter = `blur(${visibleBlur}px)`;

      let bassRaw = 0;
      let midRaw = 0;
      let trebleRaw = 0;
      const analyser = analyserRef.current;
      const data = dataRef.current;
      if (analyser && data) {
        analyser.getByteFrequencyData(data as Uint8Array<ArrayBuffer>);
        const bassEnd = Math.floor(data.length * 0.1);
        const midEnd = Math.floor(data.length * 0.45);
        let bsum = 0;
        let msum = 0;
        let tsum = 0;
        for (let i = 0; i < bassEnd; i++) bsum += data[i];
        for (let i = bassEnd; i < midEnd; i++) msum += data[i];
        for (let i = midEnd; i < data.length; i++) tsum += data[i];
        bassRaw = bsum / (bassEnd * 255);
        midRaw = msum / ((midEnd - bassEnd) * 255);
        trebleRaw = tsum / ((data.length - midEnd) * 255);
      }

      const bass = Math.pow(bassRaw, 0.65);
      const mid = Math.pow(midRaw, 0.7);
      const treble = Math.pow(trebleRaw, 0.7);

      smoothedBass = lerp(smoothedBass, bass, 0.35);
      smoothedMid = lerp(smoothedMid, mid, 0.25);
      smoothedTreble = lerp(smoothedTreble, treble, 0.25);

      bassPeak = Math.max(bass, bassPeak * 0.92);

      const bgRgb = hexToRgb(visible.background);

      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = `rgb(${Math.round(bgRgb.r)}, ${Math.round(bgRgb.g)}, ${Math.round(bgRgb.b)})`;
      ctx.fillRect(0, 0, w, h);

      ctx.globalCompositeOperation = visible.blendMode;

      const colors = visible.colors.map(hexToRgb);
      const bassReact = visible.bassReactivity;
      const trebleReact = visible.trebleReactivity;
      const baseOpacity = visible.baseOpacity;

      const cx = w / 2;
      const cy = h / 2;
      const minSide = Math.min(w, h);

      const driftMul = 1 + smoothedMid * 0.8 + bassPeak * 0.6;
      const edgeMargin = minSide * 0.05;
      const minX = edgeMargin;
      const maxX = w - edgeMargin;
      const minY = edgeMargin;
      const maxY = h - edgeMargin;

      const VERTICES = isSmallViewport ? 10 : 16;

      for (const p of particles) {
        p.x += p.vx * driftMul * dt;
        p.y += p.vy * driftMul * dt;

        if (p.x < minX) {
          p.x = minX;
          p.vx = Math.abs(p.vx);
        } else if (p.x > maxX) {
          p.x = maxX;
          p.vx = -Math.abs(p.vx);
        }
        if (p.y < minY) {
          p.y = minY;
          p.vy = Math.abs(p.vy);
        } else if (p.y > maxY) {
          p.y = maxY;
          p.vy = -Math.abs(p.vy);
        }

        const sizeMul =
          1 + smoothedBass * bassReact * 0.7 + bassPeak * 0.25;
        const r = p.baseSize * sizeMul;

        const energy = smoothedBass * 0.5 + smoothedTreble * 0.25;
        const opacity = Math.min(
          0.42,
          baseOpacity * 0.35 +
            energy * 0.22 +
            smoothedTreble * trebleReact * 0.28,
        );

        const baseColor = colors[p.colorIdx % colors.length];
        const color = modulateColor(
          baseColor,
          smoothedBass,
          smoothedTreble,
          smoothedMid,
        );

        const grad = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 1.15);
        grad.addColorStop(0, rgbCss(color, opacity));
        grad.addColorStop(0.5, rgbCss(color, opacity * 0.45));
        grad.addColorStop(1, rgbCss(color, 0));
        ctx.fillStyle = grad;

        const t = now * 0.0008;
        const bassWobble = smoothedBass * 0.18 + bassPeak * 0.1;
        const trebleRipple = smoothedTreble * 0.06;

        const points: Array<{ x: number; y: number }> = [];
        for (let i = 0; i < VERTICES; i++) {
          const angle = (i / VERTICES) * Math.PI * 2;
          const wobble =
            Math.sin(angle * 2 + t + p.phase) * 0.1 +
            Math.sin(angle * 3 + t * 1.4 + p.phase * 1.7) * 0.07 +
            Math.cos(angle * 4 + t * 0.8 + p.phase) * bassWobble +
            Math.sin(angle * 6 + t * 2.1 + p.phase * 2) * trebleRipple;
          const rr = r * (1 + wobble);
          points.push({
            x: p.x + Math.cos(angle) * rr,
            y: p.y + Math.sin(angle) * rr,
          });
        }

        ctx.beginPath();
        const last = points[VERTICES - 1];
        const first = points[0];
        ctx.moveTo((last.x + first.x) / 2, (last.y + first.y) / 2);
        for (let i = 0; i < VERTICES; i++) {
          const cur = points[i];
          const next = points[(i + 1) % VERTICES];
          ctx.quadraticCurveTo(
            cur.x,
            cur.y,
            (cur.x + next.x) / 2,
            (cur.y + next.y) / 2,
          );
        }
        ctx.closePath();
        ctx.fill();
      }

      ctx.globalCompositeOperation = "source-over";
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(0, 0, w, h);

      const vigInner = minSide * 0.3;
      const vigOuter = Math.hypot(w, h) * 0.75;
      const vig = ctx.createRadialGradient(cx, cy, vigInner, cx, cy, vigOuter);
      vig.addColorStop(0, "rgba(0,0,0,0)");
      vig.addColorStop(1, "rgba(0,0,0,0.65)");
      ctx.fillStyle = vig;
      ctx.fillRect(0, 0, w, h);

      raf = requestAnimationFrame(draw);
    };

    raf = requestAnimationFrame(draw);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    };
  }, [analyserRef, dataRef]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden
      className="pointer-events-none fixed inset-0 -z-10"
    />
  );
}
