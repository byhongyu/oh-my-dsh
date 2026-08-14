import { Composition } from "remotion";

import { HeroDemo } from "./video";

export function RemotionRoot() {
  return (
    <>
      <Composition
        id="HeroDemo"
        component={HeroDemo}
        durationInFrames={15 * 30}
        fps={30}
        width={1280}
        height={720}
      />
      <Composition
        id="HeroDemoGif"
        component={HeroDemo}
        durationInFrames={15 * 15}
        fps={15}
        width={960}
        height={540}
      />
    </>
  );
}
