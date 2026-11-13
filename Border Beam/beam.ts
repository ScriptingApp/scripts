/**
 * beam.ts — shared vocabulary for the border beam: style/shape/timing types,
 * palettes and color helpers. All rendering lives in BorderBeam.metal
 * (compiled by https://github.com/thomfang/metal-shader-build).
 */

export type BeamStyle = "large" | "small" | "line"

export type BeamDirection = "leftToRight" | "rightToLeft"

export type BeamShapeSpec =
  | { kind: "rounded"; radius: number }
  | { kind: "capsule" }
  | { kind: "circle" }

export type BeamTiming = {
  /** seconds for one full lap (orbit styles) */
  rotateDuration: number
  /** seconds for one there-and-back sweep (`line`) */
  lineDuration: number
  /** seconds to fade in / out when `active` toggles */
  fade: number
}

export const defaultTiming: BeamTiming = {
  rotateDuration: 2.4,
  lineDuration: 2.0,
  fade: 0.6,
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

// ---------------------------------------------------------------------------
// Colors
// ---------------------------------------------------------------------------

export type RGBA = { r: number; g: number; b: number; a: number }

const NAMED: Record<string, RGBA> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  clear: { r: 0, g: 0, b: 0, a: 0 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
}

/** Parses `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb(...)`, `rgba(...)`, and a few names. */
export function parseColor(input: string): RGBA {
  const s = (input || "").trim().toLowerCase()
  const named = NAMED[s]
  if (named) return named

  if (s.startsWith("#")) {
    let hex = s.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      hex = hex
        .split("")
        .map((c) => c + c)
        .join("")
    }
    if (hex.length === 6) hex += "ff"
    if (hex.length === 8) {
      const v = parseInt(hex, 16)
      if (!Number.isNaN(v)) {
        return {
          r: (v >>> 24) & 0xff,
          g: (v >>> 16) & 0xff,
          b: (v >>> 8) & 0xff,
          a: (v & 0xff) / 255,
        }
      }
    }
  }

  const m = s.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(",").map((p) => parseFloat(p.trim()))
    if (parts.length >= 3) {
      return {
        r: clamp(parts[0], 0, 255),
        g: clamp(parts[1], 0, 255),
        b: clamp(parts[2], 0, 255),
        a: parts.length > 3 ? clamp(parts[3], 0, 1) : 1,
      }
    }
  }

  return { r: 255, g: 255, b: 255, a: 1 }
}

export function rgbaString(c: RGBA, alpha: number): string {
  const a = clamp(c.a * alpha, 0, 1)
  return `rgba(${Math.round(c.r)},${Math.round(c.g)},${Math.round(c.b)},${
    Math.round(a * 1000) / 1000
  })`
}

/** Same color with a different opacity, as a CSS string. */
export function withAlpha(color: string, alpha: number): string {
  return rgbaString(parseColor(color), alpha)
}

// ---------------------------------------------------------------------------
// Palettes (first color = tail, last = head)
// ---------------------------------------------------------------------------

export const BeamPalette: Record<string, string[]> = {
  colorful: ["#40D973", "#3399F2", "#B359F2", "#FF59A6", "#FFA640"],
  gemini: ["#4285F5", "#9C73CC", "#EB4236", "#FA8C33", "#FABD05", "#33A854"],
  spectrum: ["#4280F5", "#40B3E6", "#40D1D9", "#40C766", "#FABD33", "#FA8538", "#EB4740"],
  neon: ["#00E5FF", "#4D66FF", "#D933FF", "#FF3399"],
  sunset: ["#FFC74D", "#FF8050", "#FF4D73", "#B34DE6"],
  aurora: ["#4DFFB3", "#33CCFF", "#8066FF", "#E680FF"],
  silver: ["#BFCFFF33", "#E6EDFF", "#BFCFFF33"],
  mono: ["#FFFFFF40", "#FFFFFFE6", "#FFFFFF40"],
}

/** One color, fading in and out along its length. */
export function singlePalette(color: string): string[] {
  return [withAlpha(color, 0.3), color, withAlpha(color, 0.3)]
}
