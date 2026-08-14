import type { CSSProperties, ReactNode } from "react";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  Sequence,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

const BASE_WIDTH = 1280;
const BASE_HEIGHT = 720;
const ACCENT = "#65f0c2";
const BLUE = "#76a9ff";
const MUTED = "#8494ab";
const MONO = '"SFMono-Regular", "Cascadia Code", Menlo, Consolas, monospace';
const SANS =
  'Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

const clamp = {
  extrapolateLeft: "clamp" as const,
  extrapolateRight: "clamp" as const,
};

type RevealProps = {
  children: ReactNode;
  at: number;
  style?: CSSProperties;
};

function Reveal({ children, at, style }: RevealProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const progress = spring({
    frame: frame - at * fps,
    fps,
    config: { damping: 200 },
    durationInFrames: 0.45 * fps,
  });
  return (
    <div
      style={{
        opacity: progress,
        transform: `translateY(${interpolate(progress, [0, 1], [10, 0])}px)`,
        ...style,
      }}
    >
      {children}
    </div>
  );
}

type TypedCommandProps = {
  at: number;
  text: string;
};

function TypedCommand({ at, text }: TypedCommandProps) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const elapsed = frame / fps - at;
  const visible = Math.max(0, Math.min(text.length, Math.floor(elapsed * 34)));
  const cursorVisible = elapsed >= 0 && Math.floor(elapsed * 2.5) % 2 === 0;

  return (
    <div
      style={{
        color: "#eef6ff",
        opacity: elapsed >= 0 ? 1 : 0,
        whiteSpace: "pre",
      }}
    >
      <span style={{ color: ACCENT }}>$</span> {text.slice(0, visible)}
      <span style={{ color: ACCENT, opacity: cursorVisible ? 1 : 0 }}>▌</span>
    </div>
  );
}

type TerminalLineProps = {
  at: number;
  children: ReactNode;
  color?: string;
  indent?: number;
};

function TerminalLine({
  at,
  children,
  color = MUTED,
  indent = 0,
}: TerminalLineProps) {
  return (
    <Reveal at={at} style={{ color, paddingLeft: indent, whiteSpace: "pre" }}>
      {children}
    </Reveal>
  );
}

function Badge({ at, children }: { at: number; children: ReactNode }) {
  return (
    <Reveal
      at={at}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 8,
        border: "1px solid rgba(118, 169, 255, 0.25)",
        borderRadius: 999,
        background: "rgba(10, 18, 31, 0.76)",
        color: "#c7d5e8",
        fontFamily: SANS,
        fontSize: 14,
        fontWeight: 600,
        padding: "8px 13px",
        boxShadow: "0 10px 35px rgba(0, 0, 0, 0.2)",
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: 999,
          background: ACCENT,
          boxShadow: `0 0 12px ${ACCENT}`,
        }}
      />
      {children}
    </Reveal>
  );
}

function Terminal() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const entrance = spring({
    frame: frame - 0.5 * fps,
    fps,
    config: { damping: 200 },
    durationInFrames: 0.7 * fps,
  });
  const exit = interpolate(frame, [11.55 * fps, 12.15 * fps], [1, 0], {
    ...clamp,
    easing: Easing.inOut(Easing.quad),
  });
  const scroll = interpolate(frame, [7.4 * fps, 8.15 * fps], [0, -126], {
    ...clamp,
    easing: Easing.inOut(Easing.quad),
  });

  return (
    <div
      style={{
        position: "absolute",
        left: 120,
        top: 142,
        width: 1040,
        height: 472,
        overflow: "hidden",
        border: "1px solid rgba(151, 176, 211, 0.17)",
        borderRadius: 18,
        background: "rgba(8, 15, 27, 0.94)",
        boxShadow:
          "0 34px 90px rgba(0, 0, 0, 0.48), 0 0 80px rgba(57, 128, 255, 0.07)",
        opacity: entrance * exit,
        transform: `translateY(${interpolate(entrance, [0, 1], [28, 0])}px) scale(${interpolate(
          entrance,
          [0, 1],
          [0.97, 1],
        )})`,
        transformOrigin: "50% 50%",
      }}
    >
      <div
        style={{
          height: 44,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 16px",
          borderBottom: "1px solid rgba(151, 176, 211, 0.12)",
          background: "rgba(17, 27, 43, 0.9)",
        }}
      >
        {["#ff6b6b", "#ffd166", "#65f0c2"].map((color) => (
          <span
            key={color}
            style={{
              width: 10,
              height: 10,
              borderRadius: 999,
              background: color,
            }}
          />
        ))}
        <span
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            textAlign: "center",
            color: "#718199",
            fontFamily: SANS,
            fontSize: 12,
            fontWeight: 600,
            letterSpacing: 0.4,
          }}
        >
          oh-my-dsh — terminal
        </span>
      </div>

      <div style={{ height: 428, overflow: "hidden" }}>
        <div
          style={{
            padding: "23px 29px",
            transform: `translateY(${scroll}px)`,
            fontFamily: MONO,
            fontSize: 16,
            lineHeight: "28px",
            letterSpacing: -0.15,
          }}
        >
          <TypedCommand at={1.05} text="oh-my-dsh list" />
          <div style={{ height: 7 }} />
          <TerminalLine at={1.8} color="#c8d5e7">
            Available setups:
          </TerminalLine>
          <TerminalLine at={2.05}>
            <span style={{ color: BLUE }}>coding</span> Coding 0.1.0 Build,
            debug, test, review
          </TerminalLine>
          <TerminalLine at={2.3}>
            <span style={{ color: BLUE }}>research</span> Research 0.1.0 Cited,
            evidence-driven research
          </TerminalLine>
          <TerminalLine at={2.55}>
            <span style={{ color: BLUE }}>investing</span> Investing 0.1.0
            Scenarios, risks, no trade execution
          </TerminalLine>

          <div style={{ height: 20 }} />
          <TypedCommand at={4.0} text="oh-my-dsh use research --default" />
          <div style={{ height: 7 }} />
          <TerminalLine at={5.1} color="#c8d5e7">
            Default Agent Setup changed:
          </TerminalLine>
          <TerminalLine at={5.35} indent={2}>
            <span style={{ color: "#8fa0b7" }}>coding</span>
            <span style={{ color: ACCENT }}> → research</span>
          </TerminalLine>
          <TerminalLine at={5.65}>
            Existing sessions were not modified.
          </TerminalLine>

          <div style={{ height: 20 }} />
          <TypedCommand
            at={7.55}
            text="oh-my-dsh agent fork investing --as long-term"
          />
          <div style={{ height: 7 }} />
          <TerminalLine at={9.05} color="#c8d5e7">
            Created Investing
          </TerminalLine>
          <TerminalLine at={9.3}>
            Based on: dev.oh-my-dsh.investing@0.1.0
          </TerminalLine>
          <TerminalLine at={9.58}>
            Editable: ~/.dsh/oh-my-dsh/agents/long-term/agent.yaml
          </TerminalLine>
        </div>
      </div>
    </div>
  );
}

function EndCard() {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const reveal = spring({
    frame,
    fps,
    config: { damping: 200 },
    durationInFrames: 0.7 * fps,
  });
  const fadeOut = interpolate(frame, [2.45 * fps, 2.9 * fps], [1, 0], clamp);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        opacity: reveal * fadeOut,
        transform: `translateY(${interpolate(reveal, [0, 1], [18, 0])}px)`,
        fontFamily: SANS,
      }}
    >
      <div
        style={{
          color: ACCENT,
          fontFamily: MONO,
          fontSize: 25,
          marginBottom: 16,
        }}
      >
        ❯_
      </div>
      <div
        style={{
          color: "#f4f8ff",
          fontSize: 58,
          fontWeight: 760,
          letterSpacing: -2.8,
          lineHeight: 1,
        }}
      >
        Curated agents for real work.
      </div>
      <div style={{ color: "#91a2ba", fontSize: 20, marginTop: 16 }}>
        Switch in seconds. Make them yours. Share anywhere.
      </div>
      <div
        style={{
          marginTop: 34,
          padding: "14px 22px",
          borderRadius: 12,
          border: "1px solid rgba(101, 240, 194, 0.28)",
          background: "rgba(6, 13, 23, 0.88)",
          color: "#dce8f7",
          fontFamily: MONO,
          fontSize: 19,
          boxShadow: "0 15px 50px rgba(0, 0, 0, 0.35)",
        }}
      >
        <span style={{ color: ACCENT }}>$</span> pnpm dlx oh-my-dsh init
      </div>
      <div
        style={{
          color: "#62738c",
          fontFamily: MONO,
          fontSize: 13,
          marginTop: 18,
        }}
      >
        github.com/byhongyu/oh-my-dsh
      </div>
    </div>
  );
}

export function HeroDemo() {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const scale = width / BASE_WIDTH;
  const sceneOpacity = interpolate(
    frame,
    [14.6 * fps, 15 * fps],
    [1, 0],
    clamp,
  );
  const brandOpacity = interpolate(
    frame,
    [11.5 * fps, 12 * fps],
    [1, 0],
    clamp,
  );

  return (
    <AbsoluteFill
      style={{
        overflow: "hidden",
        background: "#050a12",
        opacity: sceneOpacity,
      }}
    >
      <div
        style={{
          position: "absolute",
          width: BASE_WIDTH,
          height: BASE_HEIGHT,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
          background:
            "radial-gradient(circle at 18% 0%, rgba(57, 145, 255, 0.15), transparent 35%), radial-gradient(circle at 86% 82%, rgba(101, 240, 194, 0.12), transparent 34%), linear-gradient(145deg, #07101c 0%, #050a12 58%, #071019 100%)",
        }}
      >
        <div
          style={{
            position: "absolute",
            inset: 0,
            opacity: 0.18,
            backgroundImage:
              "linear-gradient(rgba(136, 167, 204, 0.08) 1px, transparent 1px), linear-gradient(90deg, rgba(136, 167, 204, 0.08) 1px, transparent 1px)",
            backgroundSize: "38px 38px",
            maskImage: "linear-gradient(to bottom, black, transparent 74%)",
          }}
        />

        <div
          style={{
            position: "absolute",
            left: 122,
            top: 70,
            display: "flex",
            alignItems: "baseline",
            gap: 14,
            opacity: brandOpacity,
            fontFamily: SANS,
          }}
        >
          <span style={{ color: ACCENT, fontFamily: MONO, fontSize: 20 }}>
            ❯_
          </span>
          <span
            style={{
              color: "#f0f5fc",
              fontSize: 28,
              fontWeight: 750,
              letterSpacing: -1.1,
            }}
          >
            oh-my-dsh
          </span>
          <span
            style={{
              color: "#6e8099",
              fontSize: 14,
              fontWeight: 600,
              letterSpacing: 0.2,
            }}
          >
            curated agents for DeepSeek Harness
          </span>
        </div>

        <div
          style={{
            position: "absolute",
            right: 122,
            top: 69,
            display: "flex",
            gap: 9,
            opacity: brandOpacity,
          }}
        >
          {frame >= 2.1 * fps && frame < 5.9 * fps ? (
            <Badge at={2.1}>3 focused setups</Badge>
          ) : null}
          {frame >= 5.9 * fps && frame < 9.6 * fps ? (
            <Badge at={5.9}>switch without restart</Badge>
          ) : null}
          {frame >= 9.6 * fps && frame < 11.8 * fps ? (
            <Badge at={9.6}>fork · own · share</Badge>
          ) : null}
        </div>

        <Terminal />

        <Sequence
          from={12 * fps}
          durationInFrames={3 * fps}
          premountFor={1 * fps}
        >
          <EndCard />
        </Sequence>
      </div>
    </AbsoluteFill>
  );
}
