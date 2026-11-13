# Border Beam

An animated comet of light that travels around the border of any view, drawn by a
single Metal `colorEffect` pass — a Scripting port of
[ismnoiet/border-beam-ios](https://github.com/ismnoiet/border-beam-ios).

```tsx
import { BorderBeam } from "./BorderBeam"
import { BeamPalette } from "./beam"

<BorderBeam colors={BeamPalette.spectrum} shape={{ kind: "rounded", radius: 26 }}>
  <Text padding={18}>Anything you like</Text>
</BorderBeam>
```

## Props

| Prop | Type | Default | Notes |
|---|---|---|---|
| `style` | `"large" \| "small" \| "line"` | `"large"` | comet / tight ring / sweep along the bottom edge |
| `shape` | `{ kind: "rounded", radius } \| { kind: "capsule" } \| { kind: "circle" }` | `rounded(26)` | |
| `direction` | `"leftToRight" \| "rightToLeft"` | `"leftToRight"` | judged along the top edge |
| `active` | `boolean` | `true` | fades the beam in / out |
| `colors` | `string[]` | `BeamPalette.colorful` | first = tail, last = head; the shader uses up to 5 |
| `intensity` | `number` | `1` | 0…1 overall brightness |
| `speed` | `number` | `1` | 1 = normal lap time; changeable live |
| `timing` | `Partial<BeamTiming>` | `{ rotateDuration: 2.4, lineDuration: 2.0, fade: 0.6 }` | seconds |
| `surface` | `string \| null` | `"#1C1C1E"` | container fill |
| `contentPadding` | `number` | `0` | inset so content never touches the beam |

Palettes: `colorful`, `gemini`, `spectrum`, `neon`, `sunset`, `aurora`, `silver`, `mono`,
plus `singlePalette("#39E6C3")` for a one-colour beam.

## How it works

- `shaders/BorderBeam.metal` — signed-distance field for the rounded box, perimeter
  parameterised by arc length (so corners never distort the beam), 24 Gaussian blobs
  for the glow, crisp edge + halo in the same pass.
- `shaders/effects.json` — the Scripting shader manifest: 15 bound arguments
  (`boundingRect`, 8 × `float`, 5 × `float4` palette entries, `float` colour count).
- `BorderBeam.tsx` — loads the library once, drives `phase` from one shared 60 fps
  clock, and attaches the shader to a `Rectangle` overlaid on the container.

Rebuild the metallib by pushing `shaders/BorderBeam.metal` to
[metal-shader-build](https://github.com/thomfang/metal-shader-build); CI commits the
new `.metallib` under `build/`.

Requires iOS 18+ and `ShaderLibrary.getCapabilities().projectLibraries === true`.
