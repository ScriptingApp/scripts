/**
 * BorderBeam.tsx — an animated comet of light travelling around any border.
 *
 * The drawing is a single GPU pass: `Rectangle().colorEffect(...)` runs
 * `borderBeam` from `shaders/BorderBeam.iphoneos.metallib` (see
 * https://github.com/thomfang/metal-shader-build). `shaders/effects.json`
 * describes the bound arguments.
 *
 *   <BorderBeam colors={BeamPalette.spectrum} shape={{ kind: "rounded", radius: 26 }}>
 *     <Text>Anything you like</Text>
 *   </BorderBeam>
 */
import { Path, Rectangle, Script, useEffect, useRef, useState, ZStack } from "scripting"
import type { BeamDirection, BeamShapeSpec, BeamStyle, BeamTiming } from "./beam"
import { BeamPalette, clamp, defaultTiming, parseColor } from "./beam"

// ---------------------------------------------------------------------------
// one 60 fps clock shared by every beam on screen
// ---------------------------------------------------------------------------

const beat = { time: 0, subs: new Set<() => void>(), timer: null as any, t0: 0 }

function ensureBeat() {
  if (beat.timer != null) return
  beat.t0 = Date.now()
  beat.timer = setInterval(() => {
    beat.time = (Date.now() - beat.t0) / 1000
    beat.subs.forEach((f) => f())
  }, 16)
}

function useBeat(on: boolean) {
  const [, force] = useState(0)
  useEffect(() => {
    if (!on) return
    ensureBeat()
    const bump = () => force((n) => n + 1)
    beat.subs.add(bump)
    return () => {
      beat.subs.delete(bump)
    }
  }, [on])
  return beat.time
}

// ---------------------------------------------------------------------------
// library
// ---------------------------------------------------------------------------

let libPromise: Promise<ShaderLibrary | null> | null = null

/** Loads shaders/effects.json once. Resolves to null when the app cannot load it. */
export function loadBeamLibrary(): Promise<ShaderLibrary | null> {
  if (!libPromise) {
    libPromise = (async () => {
      try {
        const caps = await ShaderLibrary.getCapabilities()
        if (!caps.projectLibraries) {
          console.log("Shader project libraries unavailable:", JSON.stringify(caps))
          return null
        }
        return await ShaderLibrary.load(Path.join(Script.directory, "shaders", "effects.json"))
      } catch (e: any) {
        console.log("Shader library load failed:", e?.code, e?.message)
        return null
      }
    })()
  }
  return libPromise
}

// ---------------------------------------------------------------------------
// component
// ---------------------------------------------------------------------------

export type BorderBeamProps = {
  /** `large` comet, `small` tight ring, `line` sweep along the bottom edge */
  style?: BeamStyle
  /** `{ kind: "rounded", radius }`, `{ kind: "capsule" }` or `{ kind: "circle" }` */
  shape?: BeamShapeSpec
  /** clockwise (left → right along the top edge) or the other way around */
  direction?: BeamDirection
  /** fades the beam in and out instead of tearing it down */
  active?: boolean
  /** first color = tail, last color = head (max 5 used by the shader) */
  colors?: string[]
  /** 0...1 overall brightness */
  intensity?: number
  /** 1 = normal, 2 = twice as fast; may change at any time */
  speed?: number
  timing?: Partial<BeamTiming>
  /** card background, `null` for a transparent container */
  surface?: string | null
  /** extra inset for the content so it never touches the beam */
  contentPadding?: number
  children?: any
}

const STYLE_PARAMS: Record<BeamStyle, { mode: number; side: number; arc: number; glow: number }> = {
  large: { mode: 0, side: 2, arc: 0.36, glow: 20 },
  small: { mode: 0, side: 2, arc: 0.5, glow: 4 },
  line: { mode: 1, side: 2, arc: 0.28, glow: 10 },
}

export function BorderBeam(props: BorderBeamProps) {
  const style: BeamStyle = props.style ?? "large"
  const shape: BeamShapeSpec = props.shape ?? { kind: "rounded", radius: 26 }
  const direction: BeamDirection = props.direction ?? "leftToRight"
  const active = props.active ?? true
  const colors = props.colors ?? BeamPalette.colorful
  const intensity = clamp(props.intensity ?? 1, 0, 1)
  const speed = Math.max(0, props.speed ?? 1)
  const surface = props.surface === undefined ? "#1C1C1E" : props.surface
  const timing: BeamTiming = { ...defaultTiming, ...(props.timing ?? {}) }

  const [lib, setLib] = useState<ShaderLibrary | null>(null)
  const fade = useRef(active ? 1 : 0)
  const spin = useRef(Math.random())
  const last = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    loadBeamLibrary().then((l) => {
      if (alive) setLib(l)
    })
    return () => {
      alive = false
    }
  }, [])

  const now = useBeat(active || fade.current > 0.002)

  if (last.current === null) last.current = now
  let dt = now - last.current
  if (!(dt > 0)) dt = 0
  if (dt > 0.1) dt = 0.1
  last.current = now

  const target = active ? 1 : 0
  const fadeDur = Math.max(0.05, timing.fade)
  if (fade.current < target) fade.current = Math.min(target, fade.current + dt / fadeDur)
  else if (fade.current > target) fade.current = Math.max(target, fade.current - dt / fadeDur)

  const duration = style === "line" ? timing.lineDuration : timing.rotateDuration
  if (dt > 0) spin.current = (spin.current + (dt * speed) / Math.max(0.05, duration)) % 1

  const rgba = colors.length ? colors.map(parseColor) : [parseColor("#FFFFFF")]
  const count = Math.max(1, Math.min(5, rgba.length))
  const at = (i: number) => rgba[Math.min(i, rgba.length - 1)]
  const f4 = (i: number) => {
    const c = at(i)
    return Shader.Argument.float4(c.r / 255, c.g / 255, c.b / 255, c.a)
  }

  const p = STYLE_PARAMS[style]
  const radiusArg = shape.kind === "rounded" ? shape.radius : 1e4

  const shader = lib
    ? lib.shader("borderBeam", [
        Shader.Argument.boundingRect,
        Shader.Argument.float(radiusArg),
        Shader.Argument.float(spin.current),
        Shader.Argument.float(direction === "rightToLeft" ? -1 : 1),
        Shader.Argument.float(p.mode),
        Shader.Argument.float(p.side),
        Shader.Argument.float(p.arc),
        Shader.Argument.float(p.glow),
        Shader.Argument.float(intensity * fade.current),
        f4(0),
        f4(1),
        f4(2),
        f4(3),
        f4(4),
        Shader.Argument.float(count),
      ])
    : undefined

  const shapeValue: any =
    shape.kind === "rounded"
      ? { type: "rect", cornerRadius: shape.radius, style: "circular" }
      : shape.kind === "capsule"
      ? { type: "capsule", style: "circular" }
      : "circle"

  const overlayContent = shader ? (
    <Rectangle
      fill="#FFFFFF"
      allowsHitTesting={false}
      colorEffect={{ shader }}
    />
  ) : undefined

  return (
    <ZStack
      alignment="center"
      padding={props.contentPadding ?? 0}
      background={surface ? { style: surface as any, shape: shapeValue } : undefined}
      overlay={overlayContent ? { alignment: "center", content: overlayContent } : undefined}
    >
      {props.children}
    </ZStack>
  )
}
