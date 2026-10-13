import { useEffect, useRef, useState } from "react";
import { LayoutChangeEvent, Platform, StyleSheet, View } from "react-native";

const BAR_WIDTH = 2;
const BAR_GAP = 3;
const BAR_STEP = BAR_WIDTH + BAR_GAP;
const MIN_BAR_HEIGHT = 2;
const MAX_BAR_HEIGHT = 22;
const SAMPLE_INTERVAL_MS = 70;
const MAX_SAMPLES = 400;

type Props = {
  /** Normalized 0..1 recorder level supplied by the active recorder. */
  level?: number;
  quietColor: string;
  activeColor: string;
  /** Only enable for capture paths that do not already own a MediaStream. */
  useBrowserAnalyser?: boolean;
};

/**
 * Scrolling dictation waveform: new samples enter on the right and drift
 * left. Silence renders as a row of dots, speech as taller bars.
 */
export function AskPranaRecordingWaveform({
  level = 0,
  quietColor,
  activeColor,
  useBrowserAnalyser = false,
}: Props) {
  const [width, setWidth] = useState(0);
  const [samples, setSamples] = useState<number[]>([]);
  const levelRef = useRef(level);
  levelRef.current = level;
  const webLevelRef = useRef<number | null>(null);

  // Composer recording already owns the microphone through MediaRecorder.
  // Opening a second stream on Android can make the active recorder empty or
  // fail. Keep this opt-in for capture paths that genuinely have no meter.
  useEffect(() => {
    if (
      !useBrowserAnalyser ||
      Platform.OS !== "web" ||
      typeof window === "undefined" ||
      !navigator.mediaDevices?.getUserMedia
    ) {
      return;
    }
    let cancelled = false;
    let release: (() => void) | null = null;

    void (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelled) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const AudioContextCtor = window.AudioContext ||
          (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AudioContextCtor) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        const audioContext = new AudioContextCtor();
        const source = audioContext.createMediaStreamSource(stream);
        const analyser = audioContext.createAnalyser();
        analyser.fftSize = 512;
        source.connect(analyser);
        const buffer = new Uint8Array(analyser.fftSize);
        let frameId: number | null = null;

        const tick = () => {
          analyser.getByteTimeDomainData(buffer);
          let energy = 0;
          for (const sample of buffer) {
            const normalized = (sample - 128) / 128;
            energy += normalized * normalized;
          }
          const rms = Math.sqrt(energy / buffer.length);
          // Typical speech RMS sits around 0.02–0.2.
          webLevelRef.current = Math.min(1, Math.max(0, (rms - 0.01) * 6));
          frameId = window.requestAnimationFrame(tick);
        };
        tick();

        release = () => {
          if (frameId != null) window.cancelAnimationFrame(frameId);
          try { source.disconnect(); } catch { /* ignore */ }
          stream.getTracks().forEach((track) => track.stop());
          void audioContext.close();
        };
      } catch {
        // No level source; the waveform stays as quiet dots.
      }
    })();

    return () => {
      cancelled = true;
      release?.();
    };
  }, [useBrowserAnalyser]);

  useEffect(() => {
    const id = setInterval(() => {
      const value = webLevelRef.current ?? levelRef.current;
      setSamples((current) => {
        const next = current.length >= MAX_SAMPLES ? current.slice(1) : current.slice();
        next.push(Math.min(1, Math.max(0, value)));
        return next;
      });
    }, SAMPLE_INTERVAL_MS);
    return () => clearInterval(id);
  }, []);

  const barCount = Math.max(0, Math.floor((width + BAR_GAP) / BAR_STEP));
  const visible = samples.slice(-barCount);
  const padded = barCount > visible.length
    ? [...new Array(barCount - visible.length).fill(0), ...visible]
    : visible;

  const handleLayout = (event: LayoutChangeEvent) => {
    setWidth(event.nativeEvent.layout.width);
  };

  return (
    <View
      style={styles.container}
      onLayout={handleLayout}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      {padded.map((value, index) => {
        const active = value > 0.08;
        return (
          <View
            key={index}
            style={[
              styles.bar,
              {
                height: MIN_BAR_HEIGHT + value * (MAX_BAR_HEIGHT - MIN_BAR_HEIGHT),
                backgroundColor: active ? activeColor : quietColor,
              },
            ]}
          />
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    height: MAX_BAR_HEIGHT + 4,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    overflow: "hidden",
    gap: BAR_GAP,
  },
  bar: {
    width: BAR_WIDTH,
    borderRadius: BAR_WIDTH / 2,
  },
});
