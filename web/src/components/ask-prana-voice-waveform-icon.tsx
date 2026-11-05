import Svg, { Rect } from "react-native-svg";

/** Five centered bars. Heights rise and fall so the mark reads as a waveform. */
const BARS = [
  { x: 2.2, height: 7 },
  { x: 6.6, height: 12 },
  { x: 11, height: 18 },
  { x: 15.4, height: 11 },
  { x: 19.8, height: 6 },
] as const;

type Props = {
  size?: number;
  color?: string;
};

export function AskPranaVoiceWaveformIcon({ size = 16, color = "#4ADE80" }: Props) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24">
      {BARS.map((bar) => (
        <Rect
          key={bar.x}
          x={bar.x}
          y={(24 - bar.height) / 2}
          width={2.4}
          height={bar.height}
          rx={1.2}
          fill={color}
        />
      ))}
    </Svg>
  );
}
