# Hero demo source

This isolated Remotion project renders the silent hero demo embedded in the
repository README. It intentionally sits outside the product pnpm workspace so
video tooling does not become a product or CI dependency.

```bash
cd media/hero-demo
pnpm install --frozen-lockfile
pnpm render:mp4
pnpm render:gif
```

The composition is 15 seconds. `HeroDemo` renders a 1280×720 MP4 at 30 fps;
`HeroDemoGif` renders a 960×540 GIF at 15 fps for GitHub's inline README.
