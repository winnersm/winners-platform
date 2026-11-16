"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { usePathname } from "next/navigation";
import styles from "./split-loader.module.css";

/**
 * Pantalla de carga W/M al cambiar de sección desde el menú lateral.
 *
 * La pantalla se corta por una línea que hace de espejo (una W girada 180° es
 * una M). Mientras carga la sección, W y M giran juntas como una sola pieza
 * alrededor del centro, con estela. Cuando la página está completamente
 * cargada, se completa el giro en curso, el par queda quieto en el medio y
 * cada mitad de la pantalla se lleva su letra, dejando ver la sección pedida.
 *
 * "Completamente cargada" = la ruta cambió, no hay peticiones fetch en curso,
 * hubo QUIET_MS de calma y en <main> no quedan esqueletos, spinners visibles
 * ni imágenes a medio cargar. La animación ajusta su ritmo a lo que tardó:
 * si la página llega rápido, acelera y se salta los giros; si tarda, sigue
 * girando hasta que esté lista (con un tope de MAX_WAIT).
 *
 * Prototipo y parámetros: experimentos/splash-wm/index.html.
 */

type SplitLoaderContextValue = { start: (href: string) => void };

const SplitLoaderContext = createContext<SplitLoaderContextValue>({ start: () => {} });

export const useSplitLoader = () => useContext(SplitLoaderContext);

/** Tope (s reales): si la página no termina de cargar, la animación termina igual. */
const MAX_WAIT = 12;
/** Calma (ms) sin peticiones antes de dar la página por cargada. */
const QUIET_MS = 300;
/** Una petición que lleva más de esto (ms) no se espera (sincronizaciones largas, etc.). */
const STALE_REQUEST_MS = 8000;
/** Indicadores de carga que usan las vistas dentro de <main>. */
const BUSY_SELECTOR = ".animate-pulse, .animate-spin, [aria-busy='true']";

interface LoadTracker {
  startedAt: number;
  from: string;
  target: string;
  /** Momento en que cambió la ruta (la página nueva ya está montada). */
  routeAt: number | null;
  /** Peticiones en curso: id → inicio. */
  pending: Map<number, number>;
  total: number;
  done: number;
  lastActivity: number;
}

export function SplitLoaderProvider({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const [runId, setRunId] = useState<number | null>(null);
  const trackerRef = useRef<LoadTracker | null>(null);

  // Cuenta las peticiones fetch hechas mientras la pantalla de carga está activa.
  useEffect(() => {
    const original = window.fetch;
    let seq = 0;
    window.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const tr = trackerRef.current;
      if (!tr) return original.call(window, input, init);
      const id = ++seq;
      tr.pending.set(id, performance.now());
      tr.total++;
      tr.lastActivity = performance.now();
      const end = () => {
        tr.pending.delete(id);
        tr.done++;
        tr.lastActivity = performance.now();
      };
      return original.call(window, input, init).then(
        (res) => { end(); return res; },
        (err) => { end(); throw err; },
      );
    }) as typeof fetch;
    return () => { window.fetch = original; };
  }, []);

  const start = useCallback(
    (href: string) => {
      if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      const now = performance.now();
      trackerRef.current = {
        startedAt: now, from: pathname, target: href, routeAt: null,
        pending: new Map(), total: 0, done: 0, lastActivity: now,
      };
      setRunId((id) => (id ?? 0) + 1);
    },
    [pathname],
  );

  // La página nueva ya está montada cuando cambia la ruta.
  useEffect(() => {
    const tr = trackerRef.current;
    if (tr && tr.routeAt === null && (pathname === tr.target || pathname !== tr.from)) {
      tr.routeAt = performance.now();
      tr.lastActivity = tr.routeAt;
    }
  }, [pathname, runId]);

  const isLoaded = useCallback(() => {
    const tr = trackerRef.current;
    if (!tr || tr.routeAt === null) return false;
    const now = performance.now();
    for (const t of tr.pending.values()) if (now - t < STALE_REQUEST_MS) return false;
    if (now - tr.lastActivity < QUIET_MS) return false;
    const main = document.querySelector("main");
    if (main) {
      for (const el of Array.from(main.querySelectorAll<HTMLElement>(BUSY_SELECTOR))) {
        if (el.getClientRects().length > 0) return false; // indicador visible: sigue cargando
      }
      for (const img of Array.from(main.querySelectorAll("img"))) if (!img.complete) return false;
    }
    return true;
  }, []);

  // Progreso estimado para la línea: hasta el cambio de ruta ~50 %, luego según peticiones.
  const progress = useCallback(() => {
    const tr = trackerRef.current;
    if (!tr) return 0;
    if (tr.routeAt === null) return 0.5 * (1 - Math.exp(-(performance.now() - tr.startedAt) / 1200));
    return 0.6 + 0.32 * (tr.total ? tr.done / tr.total : 1);
  }, []);

  const done = useCallback(() => {
    trackerRef.current = null;
    setRunId(null);
  }, []);

  return (
    <SplitLoaderContext.Provider value={{ start }}>
      {children}
      {runId !== null &&
        createPortal(
          <SplitLoaderOverlay key={runId} isLoaded={isLoaded} progress={progress} onDone={done} />,
          document.body,
        )}
    </SplitLoaderContext.Provider>
  );
}

interface EngineHooks {
  isLoaded: () => boolean;
  progress: () => number;
  onDone: () => void;
}

function SplitLoaderOverlay(props: EngineHooks) {
  const rootRef = useRef<HTMLDivElement>(null);
  const hooksRef = useRef(props);

  useEffect(() => {
    hooksRef.current = props;
  });

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const q = (name: string) => root.querySelector<HTMLDivElement>(`[data-part="${name}"]`)!;
    const engine = createEngine(
      {
        root,
        top: q("top"),
        bottom: q("bottom"),
        seam: q("seam"),
        fill: q("fill"),
        glow: q("glow"),
        backdrop: q("backdrop"),
        layers: [q("layerA"), q("layerB")],
      },
      {
        isLoaded: () => hooksRef.current.isLoaded(),
        progress: () => hooksRef.current.progress(),
        onDone: () => hooksRef.current.onDone(),
      },
    );
    return engine.destroy;
  }, []);

  return (
    <div ref={rootRef} className={styles.root} role="progressbar" aria-label="Cargando sección" aria-busy="true">
      <svg className={styles.defs} aria-hidden="true" focusable="false">
        <defs>
          {/* recorta las puntas: la letra queda entre y=14 y y=86, simétrica respecto a (60,50) */}
          <clipPath id="splitLoaderClip" clipPathUnits="userSpaceOnUse">
            <rect x="-10" y="14" width="140" height="72" />
          </clipPath>
          <linearGradient id="splitLoaderGrad" gradientUnits="userSpaceOnUse" x1="0" y1="14" x2="0" y2="86">
            <stop offset="0" stopColor="#ffffff" />
            <stop offset="1" stopColor="#c3cdff" />
          </linearGradient>
        </defs>
      </svg>
      <div className={styles.backdrop} data-part="backdrop" />
      <div className={`${styles.half} ${styles.top}`} data-part="top" />
      <div className={`${styles.half} ${styles.bottom}`} data-part="bottom" />
      <div className={styles.glow} data-part="glow" />
      <div className={styles.seam} data-part="seam">
        <div className={styles.seamFill} data-part="fill" />
      </div>
      <div className={styles.layer} data-part="layerA" />
      <div className={styles.layer} data-part="layerB" />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Motor de la animación (DOM directo + requestAnimationFrame)
// ---------------------------------------------------------------------------

/** Parámetros elegidos en el prototipo. */
const P = {
  hop: 1.1, // s por giro
  turns: 1, // vueltas extra por giro (cada giro = ½ + turns vueltas)
  anticipation: 0.8, // impulso hacia atrás antes de girar
  spread: 0.35, // apertura al girar (W sube, M baja)
  trail: 0.75, // intensidad de la estela
  trailLength: 110, // ms
  trailBlur: 6, // px
  colors: ["#a9bbff", "#2f4ef0"] as const,
};

const INTRO = 1.6; // s: corte de pantalla + aparición de las letras
const OUTRO = 1.15; // s: sellado + separación
const GAP = 1.5; // px: media abertura de la grieta mientras carga
const TRAVEL = 0.8; // fracción de cada giro en movimiento (el resto, pausa en W sobre M)
// unidades del dibujo (viewBox 140×120, letra de 112×72 centrada en 60,50)
const U = { halfH: 36, nearGap: 6, spreadMax: 40 };

const POINTS = "4,-10 36,86 60,36 84,86 116,-10";
const glyphSVG = (stroke: string) =>
  `<svg viewBox="-10 -10 140 120" aria-hidden="true"><g clip-path="url(#splitLoaderClip)"><polyline points="${POINTS}" fill="none" stroke="${stroke}" stroke-width="16" stroke-linejoin="miter" stroke-miterlimit="10"/></g></svg>`;

const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const remap = (v: number, a: number, b: number) => clamp((v - a) / (b - a), 0, 1);
const easeInCubic = (t: number) => t * t * t;
const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const easeOutExpo = (t: number) => (t >= 1 ? 1 : 1 - Math.pow(2, -10 * t));
const easeOutBack = (t: number, c = 1.70158) => 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
// con c > 0 primero retrocede (anticipación) y al final se pasa (rebote)
const easeInOutBack = (t: number, c = 1.70158) => {
  const c2 = c * 1.525;
  return t < 0.5
    ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2
    : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2;
};
const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
const mix = (a: string, b: string, t: number) => {
  const A = hex(a), B = hex(b);
  return `rgb(${A.map((v, i) => Math.round(lerp(v, B[i], t))).join(",")})`;
};

interface Pose { x: number; y: number; r: number; s: number }

interface Elements {
  root: HTMLDivElement;
  top: HTMLDivElement;
  bottom: HTMLDivElement;
  seam: HTMLDivElement;
  fill: HTMLDivElement;
  glow: HTMLDivElement;
  backdrop: HTMLDivElement;
  layers: [HTMLDivElement, HTMLDivElement];
}

/**
 * Velocidad de la animación una vez cargada la página, según lo que tardó (ms reales):
 * cuanto más rápido llegó, más rápido se completa y se abre.
 */
const exitSpeed = (ms: number) => (ms < 700 ? 2.2 : ms < 1600 ? 1.8 : ms < 3000 ? 1.45 : 1.2);

function createEngine(els: Elements, hooks: EngineHooks) {
  const { root, top, bottom, seam, fill, glow, backdrop, layers } = els;

  // --- letras: la principal y N copias para la estela ---
  const n = Math.round(clamp(P.trailLength / 9, 4, 24));
  const mains: HTMLDivElement[] = [];
  const ghosts: HTMLDivElement[][] = [[], []];
  const ghostBase: number[] = [];
  layers.forEach((layer, i) => {
    layer.textContent = "";
    for (let k = n; k >= 1; k--) {
      const el = document.createElement("div");
      el.className = `${styles.glyph} ${styles.ghost}`;
      el.innerHTML = glyphSVG("currentColor");
      layer.appendChild(el);
      ghosts[i][k - 1] = el;
    }
    const m = document.createElement("div");
    m.className = `${styles.glyph} ${styles.main}`;
    m.innerHTML = glyphSVG("url(#splitLoaderGrad)");
    layer.appendChild(m);
    mains[i] = m;
  });
  for (let k = 1; k <= n; k++) {
    const f = k / n;
    ghostBase[k - 1] = Math.pow(1 - k / (n + 1), 1.2);
    const blur = `blur(${(P.trailBlur * Math.pow(f, 0.8) + 0.4).toFixed(2)}px)`;
    const color = mix(P.colors[0], P.colors[1], Math.pow(f, 0.7));
    for (const arr of ghosts) {
      arr[k - 1].style.filter = blur;
      arr[k - 1].style.color = color;
    }
  }

  // --- medidas ---
  let cx = 0, cy = 0, H = 0, u = 1, gw = 0, gh = 0;
  const measure = () => {
    const W = root.clientWidth;
    H = root.clientHeight;
    cx = W / 2;
    cy = H / 2;
    gw = clamp(W * 0.3, 84, 150);
    u = gw / 140;
    gh = (gw * 120) / 140;
    for (const layer of layers)
      for (const el of Array.from(layer.children) as HTMLElement[]) {
        el.style.width = `${gw}px`;
        el.style.height = `${gh}px`;
      }
  };
  measure();

  // tau = tiempo de la animación; avanza a `speed` veces el tiempo real
  const startedAt = performance.now();
  let tau = 0, last = startedAt, raf = 0, shown = 0, clipped = true;
  let speed = 1, targetSpeed = 1;
  let loadedAt: number | null = null, tEnd: number | null = null;

  // --- poses (funciones puras del tiempo) ---
  // A empieza como W arriba; B es siempre A girada 180° alrededor del centro:
  // por eso giran juntas, como una sola pieza.
  const restR = () => (U.halfH + U.nearGap) * u;

  const pairPose = (ang: number, R: number, s: number): Pose => {
    const rad = (ang * Math.PI) / 180;
    return { x: cx + R * Math.sin(rad), y: cy - R * Math.cos(rad), r: ang, s };
  };

  const introPose = (t: number): Pose => {
    const e = remap(t, 0.7, 1.45);
    const R = lerp(-(U.halfH + 12) * u, restR(), easeOutBack(e, 1.3));
    return { x: cx, y: cy - R, r: 0, s: lerp(0.82, 1, easeOutCubic(e)) };
  };

  // Un giro: la W sube y la M baja (se abren), giran juntas y vuelven a cerrarse.
  const hopPose = (i: number, p: number): Pose => {
    const c = 1.70158 * P.anticipation;
    const q = remap(p, 0, TRAVEL);
    const D = 180 + 360 * P.turns;
    const ang = i * D + D * easeInOutBack(q, c * 0.5);
    const open = easeOutCubic(remap(q, 0, 0.32)) * (1 - easeInOutCubic(remap(q, 0.62, 1)));
    return pairPose(ang, restR() + P.spread * U.spreadMax * u * open, 1 + 0.06 * open);
  };

  const pulseAt = (a: Pose) => Math.exp(-Math.pow(Math.abs(a.y - cy) / (16 * u), 2));

  const panelOffsetAt = (t: number): number => {
    if (t < INTRO) {
      const a = easeOutCubic(remap(t, 0.42, 0.56));
      const relax = easeInOutCubic(remap(t, 0.56, 1.05));
      return GAP * a + 9 * a * (1 - relax); // golpe del corte y se asienta
    }
    if (tEnd === null || t < tEnd) {
      const lt = (t - INTRO) / P.hop, i = Math.floor(lt);
      return GAP + 1.4 * pulseAt(hopPose(i, lt - i));
    }
    const o = t - tEnd;
    const seal = easeInOutCubic(remap(o, 0.1, 0.26));
    const open = easeInOutCubic(remap(o, 0.3, OUTRO));
    return GAP * (1 - seal) + open * (H / 2 + 24);
  };

  // Salida: el par está quieto en el medio, se aprieta contra la línea y se separa.
  const outroPose = (t: number): Pose => {
    const iLast = Math.round(((tEnd as number) - INTRO) / P.hop) - 1;
    const st = iLast >= 0 ? hopPose(iLast, 1) : introPose(INTRO);
    const side = st.y <= cy ? -1 : 1;
    const press = 4 * u * Math.sin(Math.PI * remap(t, 0, 0.42));
    const ride = Math.max(0, panelOffsetAt((tEnd as number) + t) - GAP);
    return { ...st, x: cx, y: cy + side * (restR() - press + ride) };
  };

  const poseA = (t: number): Pose => {
    if (t < INTRO) return introPose(t);
    if (tEnd === null || t < tEnd) {
      const lt = (t - INTRO) / P.hop, i = Math.floor(lt);
      return hopPose(i, lt - i);
    }
    return outroPose(t - tEnd);
  };

  const mirror = (a: Pose): Pose => ({ x: 2 * cx - a.x, y: 2 * cy - a.y, r: a.r + 180, s: a.s });

  const sliceAt = (t: number) => {
    const a = easeOutCubic(remap(t, 0.42, 0.52));
    return 12 * a * (1 - easeInOutCubic(remap(t, 0.52, 1.1)));
  };

  const progressAt = () => (loadedAt !== null ? 1 : clamp(hooks.progress(), 0, 0.95));

  const place = (el: HTMLElement, p: Pose) => {
    el.style.transform = `translate3d(${(p.x - gw / 2).toFixed(2)}px,${(p.y - gh / 2).toFixed(2)}px,0) rotate(${p.r.toFixed(2)}deg) scale(${p.s.toFixed(3)})`;
  };

  const render = (dt: number) => {
    const phase = tau < INTRO ? "intro" : tEnd === null || tau < tEnd ? "loop" : "outro";
    const a = poseA(tau);
    place(mains[0], a);
    place(mains[1], mirror(a));

    // estela: la misma letra en instantes anteriores; se suaviza al abrirse
    const step = P.trailLength / 1000 / n;
    const trailK = P.trail * (tEnd !== null && tau > tEnd ? 1 - 0.7 * remap(tau - tEnd, 0.3, 0.58) : 1);
    for (let k = 1; k <= n; k++) {
      const ga = poseA(tau - k * step);
      const moved = clamp(Math.abs(a.r - ga.r) / 22 + Math.hypot(a.x - ga.x, a.y - ga.y) / 14, 0, 1);
      const op = (trailK * ghostBase[k - 1] * moved).toFixed(3);
      const e0 = ghosts[0][k - 1], e1 = ghosts[1][k - 1];
      place(e0, ga);
      place(e1, mirror(ga));
      e0.style.opacity = op;
      e1.style.opacity = op;
    }

    // mitades de la pantalla
    const off = panelOffsetAt(tau), slice = tau < INTRO ? sliceAt(tau) : 0;
    top.style.transform = `translate3d(${(-slice).toFixed(2)}px,${(-off).toFixed(2)}px,0)`;
    bottom.style.transform = `translate3d(${slice.toFixed(2)}px,${off.toFixed(2)}px,0)`;

    // en la intro cada letra solo existe en su mitad: sale de la grieta
    if (tau < INTRO + 0.1) {
      const edge = (H / 2 + off).toFixed(1);
      layers[0].style.clipPath = `inset(0 0 ${edge}px 0)`;
      layers[1].style.clipPath = `inset(${edge}px 0 0 0)`;
      clipped = true;
    } else if (clipped) {
      layers[0].style.clipPath = layers[1].style.clipPath = "none";
      clipped = false;
    }

    // línea + brillo
    const draw = easeOutExpo(remap(tau, 0.1, 0.62));
    let g = 0, alpha = 1, scaleY = 1;
    if (phase === "intro") {
      g = 0.25 * draw + 0.55 * Math.sin(Math.PI * remap(tau, 0.42, 0.95));
    } else if (phase === "loop") {
      g = 0.25 + 0.75 * pulseAt(a);
    } else {
      const o = tau - (tEnd as number);
      const flash = Math.sin(Math.PI * remap(o, 0.08, 0.5));
      alpha = 1 - easeInCubic(remap(o, 0.3, 0.58));
      scaleY = 1 + 2.4 * flash;
      g = (0.3 + 1.1 * flash) * (1 - remap(o, 0.45, 0.8));
    }
    seam.style.transform = `scale(${draw.toFixed(4)},${scaleY.toFixed(3)})`;
    seam.style.opacity = alpha.toFixed(3);
    glow.style.opacity = clamp(g, 0, 1).toFixed(3);
    glow.style.transform = `translateY(-50%) scale(${(0.6 + 0.4 * draw).toFixed(3)},${(0.8 + 0.5 * clamp(g, 0, 1.4)).toFixed(3)})`;

    // progreso dentro de la línea
    shown += (progressAt() - shown) * (1 - Math.exp(-dt * 5));
    fill.style.transform = `scaleX(${shown.toFixed(4)})`;

    // aparece la sección pedida
    const reveal = tEnd !== null && tau >= tEnd ? easeOutCubic(remap(tau - tEnd, 0.36, 1.08)) : 0;
    backdrop.style.opacity = (1 - reveal).toFixed(3);
    // a mitad de la apertura ya se puede usar la página
    root.style.pointerEvents = reveal > 0.5 ? "none" : "auto";
  };

  const frame = (now: number) => {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000));
    last = now;
    const waited = now - startedAt;
    if (loadedAt === null && (hooks.isLoaded() || waited >= MAX_WAIT * 1000)) {
      loadedAt = tau;
      targetSpeed = exitSpeed(waited);
      // Si llegó durante la entrada, sale directo (sin giros); si no, termina el giro en curso.
      tEnd = tau <= INTRO ? INTRO : INTRO + Math.ceil((tau - INTRO) / P.hop - 1e-6) * P.hop;
    }
    speed += (targetSpeed - speed) * (1 - Math.exp(-dt * 6));
    tau += dt * speed;
    if (tEnd !== null && tau >= tEnd + OUTRO) {
      raf = 0;
      hooks.onDone();
      return;
    }
    render(dt);
    raf = requestAnimationFrame(frame);
  };

  render(0);
  raf = requestAnimationFrame(frame);
  window.addEventListener("resize", measure);

  return {
    destroy: () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", measure);
    },
  };
}
