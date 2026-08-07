"use client";

import { useEffect, useRef, useState } from "react";

export type SemacadBackdropRenderer = {
  start(): void;
  stop(): void;
  destroy(): void;
};

type Props = {
  createRenderer?: (
    canvas: HTMLCanvasElement
  ) => SemacadBackdropRenderer | null;
};

const VERTEX_SHADER = `
  attribute vec2 position;
  void main() {
    gl_Position = vec4(position, 0.0, 1.0);
  }
`;

const FRAGMENT_SHADER = `
  precision highp float;
  uniform vec2 resolution;
  uniform float time;

  float hash(vec2 point) {
    return fract(sin(dot(point, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float noise(vec2 point) {
    vec2 cell = floor(point);
    vec2 local = fract(point);
    local = local * local * (3.0 - 2.0 * local);
    return mix(
      mix(hash(cell), hash(cell + vec2(1.0, 0.0)), local.x),
      mix(hash(cell + vec2(0.0, 1.0)), hash(cell + vec2(1.0, 1.0)), local.x),
      local.y
    );
  }

  float fbm(vec2 point) {
    float value = 0.0;
    float amplitude = 0.52;
    mat2 transform = mat2(1.62, 1.18, -1.18, 1.62);
    for (int octave = 0; octave < 5; octave++) {
      value += amplitude * noise(point);
      point = transform * point + vec2(0.17);
      amplitude *= 0.5;
    }
    return value;
  }

  void main() {
    vec2 uv = (gl_FragCoord.xy - 0.5 * resolution.xy) /
      min(resolution.x, resolution.y);
    float waveX = sin(time * 0.17);
    float waveY = cos(time * 0.13);
    vec2 domain = vec2(
      fbm(uv * 1.28 + vec2(waveY, waveX) * 0.34),
      fbm(uv * 1.23 + vec2(-waveX, waveY) * 0.29 + vec2(3.7))
    );
    vec2 warped = uv + 1.34 * (domain - 0.5);
    float field = fbm(warped * 1.42 + vec2(waveX * 0.28, waveY * 0.22));
    float detail = fbm((warped + domain) * 2.05 - vec2(waveY * 0.19, waveX * 0.24));
    float ridge = 1.0 - abs(2.0 * field - 1.0);

    vec3 steel = vec3(0.18, 0.29, 0.36);
    vec3 silver = vec3(0.78, 0.84, 0.88);
    vec3 ice = vec3(0.43, 0.71, 0.88);
    vec3 metal = mix(steel, silver, smoothstep(0.12, 0.83, field));
    metal = mix(metal, ice, smoothstep(0.52, 0.9, detail) * 0.52);
    metal += vec3(0.98) * pow(ridge, 14.0) * 0.7;
    metal = mix(
      metal,
      vec3(0.11, 0.16, 0.2),
      smoothstep(0.66, 1.0, domain.x) * 0.34
    );

    float vignette = 1.0 - smoothstep(0.62, 1.05, length(uv));
    metal = mix(metal, metal * vec3(0.82, 0.88, 0.92), 1.0 - vignette);
    metal = mix(metal, vec3(1.0), smoothstep(0.78, 1.02, length(uv)) * 0.18);
    gl_FragColor = vec4(metal, 1.0);
  }
`;

function createShader(
  gl: WebGLRenderingContext,
  type: number,
  source: string
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

export function createSemacadWebGLRenderer(
  canvas: HTMLCanvasElement
): SemacadBackdropRenderer | null {
  const context = canvas.getContext("webgl", {
    alpha: false,
    antialias: false,
    powerPreference: "high-performance"
  });
  if (!context) return null;
  const gl: WebGLRenderingContext = context;

  const vertex = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = createShader(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }

  const program = gl.createProgram();
  const buffer = gl.createBuffer();
  if (!program || !buffer) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (program) gl.deleteProgram(program);
    if (buffer) gl.deleteBuffer(buffer);
    return null;
  }

  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteBuffer(buffer);
    gl.deleteProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return null;
  }

  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    gl.STATIC_DRAW
  );
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const resolution = gl.getUniformLocation(program, "resolution");
  const time = gl.getUniformLocation(program, "time");
  let frame = 0;
  let startedAt = performance.now();
  let elapsedBeforePause = 0;
  let running = false;
  let destroyed = false;
  let resizePending = true;

  const resizeObserver =
    typeof ResizeObserver === "undefined"
      ? null
      : new ResizeObserver(() => {
          resizePending = true;
        });
  resizeObserver?.observe(canvas);

  function resize() {
    if (!resizePending) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 1.35);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      gl.viewport(0, 0, width, height);
    }
    resizePending = false;
  }

  function draw(now: number) {
    if (!running || destroyed) return;
    resize();
    gl.uniform2f(resolution, canvas.width, canvas.height);
    gl.uniform1f(time, (elapsedBeforePause + now - startedAt) / 1000);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    frame = requestAnimationFrame(draw);
  }

  return {
    start() {
      if (running || destroyed) return;
      running = true;
      startedAt = performance.now();
      frame = requestAnimationFrame(draw);
    },
    stop() {
      if (!running) return;
      elapsedBeforePause += performance.now() - startedAt;
      running = false;
      cancelAnimationFrame(frame);
    },
    destroy() {
      if (destroyed) return;
      if (running) {
        elapsedBeforePause += performance.now() - startedAt;
        running = false;
        cancelAnimationFrame(frame);
      }
      destroyed = true;
      resizeObserver?.disconnect();
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertex);
      gl.deleteShader(fragment);
    }
  };
}

export function SemacadHeroBackdrop({
  createRenderer = createSemacadWebGLRenderer
}: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [renderer, setRenderer] = useState<"poster" | "webgl">("poster");

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const desktop = window.matchMedia("(min-width: 768px)");
    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    const coarsePointer = window.matchMedia("(any-pointer: coarse)");
    const canvas = canvasRef.current;
    if (!canvas) return;

    let instance: SemacadBackdropRenderer | null = null;
    let intersecting = true;
    let contextHealthy = true;
    const isEligible = () =>
      desktop.matches &&
      !reducedMotion.matches &&
      !coarsePointer.matches &&
      (navigator.maxTouchPoints ?? 0) === 0;
    const syncPlayback = () => {
      if (!isEligible() || !contextHealthy) {
        instance?.stop();
        setRenderer("poster");
        return;
      }
      if (!instance) {
        instance = createRenderer(canvas);
        if (!instance) {
          contextHealthy = false;
          setRenderer("poster");
          return;
        }
      }
      setRenderer("webgl");
      if (intersecting && !document.hidden) instance.start();
      else instance.stop();
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            intersecting = entries[0]?.isIntersecting ?? false;
            syncPlayback();
          });
    if (rootRef.current) observer?.observe(rootRef.current);

    const onVisibilityChange = () => syncPlayback();
    const onContextLost = (event: Event) => {
      event.preventDefault();
      contextHealthy = false;
      instance?.stop();
      setRenderer("poster");
    };
    const mediaQueries = [desktop, reducedMotion, coarsePointer];
    document.addEventListener("visibilitychange", onVisibilityChange);
    canvas.addEventListener("webglcontextlost", onContextLost);
    for (const query of mediaQueries) {
      query.addEventListener("change", syncPlayback);
    }
    syncPlayback();

    return () => {
      observer?.disconnect();
      document.removeEventListener("visibilitychange", onVisibilityChange);
      canvas.removeEventListener("webglcontextlost", onContextLost);
      for (const query of mediaQueries) {
        query.removeEventListener("change", syncPlayback);
      }
      instance?.destroy();
    };
  }, [createRenderer]);

  return (
    <div
      ref={rootRef}
      data-testid="semacad-hero-backdrop"
      data-renderer={renderer}
      aria-hidden="true"
      className="absolute inset-0 -z-10 overflow-hidden bg-[#dbe4eb] bg-[url('/semacad/semacad-liquid-metal-poster.avif')] bg-cover bg-center"
    >
      <canvas
        ref={canvasRef}
        className={`absolute inset-0 size-full transition-opacity duration-700 ${
          renderer === "webgl" ? "opacity-100" : "opacity-0"
        }`}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_50%_25%,rgba(255,255,255,0.52),transparent_36%),linear-gradient(to_bottom,rgba(255,255,255,0.08),rgba(255,255,255,0.22))]" />
    </div>
  );
}
