import * as React from 'react';
import { VBoxContainer, Label, PanelContainer, MarginContainer, ScrollContainer, TextureRect, ProgressBar, Sprite2D, asset, useAsset, useNodeRef, vec2 } from '@godot-js/react';

function Media() {
  const texture = useAsset(asset('marker', 'Texture2D'));
  const margin = useNodeRef<'MarginContainer'>();
  const progress = useNodeRef<'ProgressBar'>();
  const picture = useNodeRef<'TextureRect'>();
  const [controlled, setControlled] = React.useState(true);
  React.useEffect(() => { const id = setTimeout(() => setControlled(false), 250); return () => clearTimeout(id); }, []);
  React.useLayoutEffect(() => {
    console.log('PLAYGROUND_MEDIA ' + JSON.stringify({ controlled, margin: margin.current?.read('marginLeft'), value: progress.current?.read('value'), texture: picture.current?.read('texture') }));
  }, [controlled]);
  return <VBoxContainer name="Media" customMinimumSize={vec2(360, 250)}>
    <PanelContainer name="Panel"><MarginContainer name="Margin" ref={margin} initial={{ marginLeft: 4 }} marginLeft={controlled ? 12 : undefined}><Label text="PNG decoded in the browser" /></MarginContainer></PanelContainer>
    <TextureRect name="Picture" ref={picture} texture={texture} customMinimumSize={vec2(128, 64)} expandMode={1} stretchMode={0} />
    <ProgressBar name="Progress" ref={progress} initial={{ value: 7.25 }} value={controlled ? 42.5 : undefined} />
    <ScrollContainer name="Scroll" customMinimumSize={vec2(128, 32)}><VBoxContainer><Label text="Native internal scrollbars stay outside the React host graph" /></VBoxContainer></ScrollContainer>
    <Sprite2D name="Sprite" texture={texture} position={vec2(240, 100)} scale={vec2(20, 20)} />
  </VBoxContainer>;
}
export default function App() { return <React.Suspense fallback={<Label text="Loading image…" />}><Media /></React.Suspense>; }
