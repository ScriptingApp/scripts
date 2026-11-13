import {
  Button,
  HStack,
  NavigationStack,
  Picker,
  ScrollView,
  Slider,
  Spacer,
  Text,
  VStack,
  useState,
} from "scripting"
import { BorderBeam } from "./BorderBeam"
import { BeamPalette, BeamStyle, singlePalette } from "./beam"

const CARD = "#15151B"
const DIM = "rgba(255,255,255,0.52)"
const SOFT = "rgba(255,255,255,0.72)"

function Chip({ title }: { title: string }) {
  return (
    <Text
      font={12}
      foregroundStyle={SOFT}
      padding={{ horizontal: 10, vertical: 5 }}
      background="rgba(255,255,255,0.07)"
      clipShape="capsule"
    >
      {title}
    </Text>
  )
}

function SectionTitle({ children }: { children: string }) {
  return (
    <Text
      font={12}
      bold
      foregroundStyle="rgba(255,255,255,0.38)"
      textCase="uppercase"
      frame={{ maxWidth: "infinity", alignment: "leading" }}
    >
      {children}
    </Text>
  )
}

function Gallery() {
  const [style, setStyle] = useState<BeamStyle>("large")
  const [speed, setSpeed] = useState(1)
  const [live, setLive] = useState(true)


  return (
    <NavigationStack
      navigationTitle="Border Beam"
      navigationBarTitleDisplayMode="inline"
      preferredColorScheme="dark"
    >
      <ScrollView>
        <VStack
          spacing={20}
          padding={{ horizontal: 20, top: 12, bottom: 48 }}
          background="#08080C"
        >
          <VStack spacing={6} alignment="leading" frame={{ maxWidth: "infinity" }}>
            <Text font={28} bold foregroundStyle="#FFFFFF">
              Border Beam
            </Text>
            <Text font={13} foregroundStyle={DIM}>
              A comet of light orbiting any border — one Metal pass, ported from
              border-beam-ios.
            </Text>
          </VStack>

          <SectionTitle>Prompt card · large · spectrum · reversed</SectionTitle>
          <BorderBeam
            style="large"
            shape={{ kind: "rounded", radius: 26 }}
            direction="rightToLeft"
            colors={BeamPalette.spectrum}
            surface={CARD}
          >
            <VStack spacing={14} alignment="leading" padding={20} frame={{ maxWidth: "infinity" }}>
              <Text font={16} bold foregroundStyle="#FFFFFF">
                Ask anything
              </Text>
              <Text font={13} foregroundStyle={DIM} lineLimit={2}>
                Draft a launch plan for a border beam component, then port it to
                the Scripting Canvas API.
              </Text>
              <HStack spacing={8}>
                <Chip title="Design" />
                <Chip title="Code" />
                <Chip title="Plan" />
                <Spacer />
              </HStack>
            </VStack>
          </BorderBeam>

          <SectionTitle>Small · tight ring</SectionTitle>
          <HStack spacing={16} frame={{ maxWidth: "infinity" }}>
            <BorderBeam
              style="small"
              shape={{ kind: "circle" }}
              colors={BeamPalette.neon}
              surface="#1A1A22"
              timing={{ rotateDuration: 1.8 }}
            >
              <Text font={16} foregroundStyle="#FFFFFF" padding={26}>
                ■
              </Text>
            </BorderBeam>

            <BorderBeam
              style="small"
              shape={{ kind: "capsule" }}
              colors={BeamPalette.aurora}
              direction="rightToLeft"
              surface="#1A1A22"
              contentPadding={1}
            >
              <HStack spacing={8} padding={{ horizontal: 22, vertical: 14 }}>
                <Text font={13} bold foregroundStyle="#FFFFFF">
                  ▶
                </Text>
                <Text font={13} bold foregroundStyle="#FFFFFF">
                  Preview
                </Text>
              </HStack>
            </BorderBeam>

            <Spacer />
          </HStack>

          <SectionTitle>Line · sweeps the bottom edge</SectionTitle>
          <BorderBeam
            style="line"
            shape={{ kind: "capsule" }}
            colors={BeamPalette.silver}
            surface="#15151B"
          >
            <HStack spacing={10} padding={{ horizontal: 18, vertical: 14 }} frame={{ maxWidth: "infinity" }}>
              <Text font={13} foregroundStyle={DIM}>
                ⌕
              </Text>
              <Text font={13} foregroundStyle={SOFT}>
                Search components…
              </Text>
              <Spacer />
            </HStack>
          </BorderBeam>

          <SectionTitle>Pricing card · sunset</SectionTitle>
          <BorderBeam
            style="large"
            shape={{ kind: "rounded", radius: 22 }}
            colors={BeamPalette.sunset}
            intensity={0.9}
            timing={{ rotateDuration: 3.4 }}
            surface={CARD}
          >
            <VStack spacing={10} alignment="leading" padding={20} frame={{ maxWidth: "infinity" }}>
              <Text font={12} bold foregroundStyle="rgba(255,199,77,0.9)" textCase="uppercase">
                Pro
              </Text>
              <HStack spacing={4}>
                <Text font={30} bold foregroundStyle="#FFFFFF">
                  $9
                </Text>
                <Text font={13} foregroundStyle={DIM}>
                  / month
                </Text>
              </HStack>
              <Text font={13} foregroundStyle={DIM}>
                Every beam, every palette, every shape. Cancel anytime.
              </Text>
            </VStack>
          </BorderBeam>

          <SectionTitle>Single color · fast lap</SectionTitle>
          <BorderBeam
            style="large"
            shape={{ kind: "capsule" }}
            colors={singlePalette("#39E6C3")}
            timing={{ rotateDuration: 1.6 }}
            surface="#0F1A1A"
          >
            <HStack spacing={10} padding={{ horizontal: 18, vertical: 13 }}>
              <Text font={13} bold foregroundStyle="#39E6C3">
                ●
              </Text>
              <Text font={13} foregroundStyle={SOFT}>
                Synced just now
              </Text>
            </HStack>
          </BorderBeam>

          <SectionTitle>Live controls</SectionTitle>
          <VStack spacing={16} padding={18} background="#101016" clipShape={{ type: "rect", cornerRadius: 18 }}>
            <VStack spacing={8} alignment="leading" frame={{ maxWidth: "infinity" }}>
              <HStack>
                <Text font={13} foregroundStyle={SOFT}>
                  Style
                </Text>
                <Spacer />
                <Text font={12} foregroundStyle={DIM}>
                  {style}
                </Text>
              </HStack>
              <Picker
                title="Style"
                pickerStyle="segmented"
                value={style}
                onChanged={(v: string) => setStyle(v as BeamStyle)}
              >
                <Text tag="large">Large</Text>
                <Text tag="small">Small</Text>
                <Text tag="line">Line</Text>
              </Picker>
            </VStack>

            <VStack spacing={4} alignment="leading" frame={{ maxWidth: "infinity" }}>
              <HStack>
                <Text font={13} foregroundStyle={SOFT}>
                  Speed
                </Text>
                <Spacer />
                <Text font={12} foregroundStyle={DIM}>
                  {speed.toFixed(1)}×
                </Text>
              </HStack>
              <Slider min={0.2} max={3} step={0.1} value={speed} onChanged={setSpeed} />
            </VStack>

            <Button
              title={live ? "Pause the beam" : "Resume the beam"}
              action={() => setLive(!live)}
            />
          </VStack>

          <SectionTitle>Live preview</SectionTitle>
          <BorderBeam
            style={style}
            shape={{ kind: "rounded", radius: 24 }}
            colors={BeamPalette.colorful}
            active={live}
            speed={speed}
            surface={CARD}
          >
            <VStack spacing={8} padding={22} frame={{ maxWidth: "infinity" }}>
              <Text font={15} bold foregroundStyle="#FFFFFF">
                {live ? "Beam running" : "Beam paused"}
              </Text>
              <Text font={12} foregroundStyle={DIM}>
                Toggle, retime and restyle it from the controls above — the beam
                keeps its position instead of jumping.
              </Text>
            </VStack>
          </BorderBeam>

          <Text font={11} foregroundStyle="rgba(255,255,255,0.3)" padding={{ top: 8 }}>
            Effect ported from github.com/ismnoiet/border-beam-ios · drawing by
            TimelineCanvas + Canvas 2D
          </Text>
        </VStack>
      </ScrollView>
    </NavigationStack>
  )
}

export { Gallery }
export default Gallery
