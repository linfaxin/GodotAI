import * as React from 'react';
import {
  Node, CharacterBody2D, StaticBody2D, CollisionShape2D, Sprite2D, CanvasLayer,
  PanelContainer, VBoxContainer, Label, TextureRect, ProgressBar,
  asset, useAsset, useNodeRef, usePhysicsProcess, vec2,
} from '@godot-js/react';
import type { NodeReadHandle, FrameCommands } from '@godot-js/react';

function ensure(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error('GAME2D_ASSERT: ' + message);
}
const identity = (handle: NodeReadHandle) => JSON.stringify(handle.nativeKey);
const close = (a: number, b: number) => Math.abs(a - b) < 0.1;

function Loading() {
  React.useLayoutEffect(() => { console.log('GAME2D_COLD_LOADING'); }, []);
  return <Label text="Loading the combined texture and physics fixture…" />;
}

function World() {
  // Both texture choices and both shapes are loaded before the world mounts.
  // Changing skins therefore cannot suspend or remount the physical actor.
  const markerA = useAsset(asset('markerA', 'Texture2D'));
  const markerB = useAsset(asset('markerB', 'Texture2D'));
  const floorShape = useAsset(asset('floorShape', 'RectangleShape2D'));
  const actorShape = useAsset(asset('actorShape', 'CapsuleShape2D'));
  const body = useNodeRef<'CharacterBody2D'>();
  const sprite = useNodeRef<'Sprite2D'>();
  const hud = useNodeRef<'Label'>();
  const progress = useNodeRef<'ProgressBar'>();
  const picture = useNodeRef<'TextureRect'>();
  const [skin, setSkin] = React.useState(0);
  const [hudCount, setHud] = React.useState(0);
  const [paused, setPaused] = React.useState(false);
  const [round, setRound] = React.useState(0);
  const state = React.useRef({
    phase: 0, collisions: 0, settled: 0, pausedFrames: 0, resetObserved: false,
    bodyId: '', spriteId: '', y: 0, velocityY: 0,
    oldBody: null as NodeReadHandle<'CharacterBody2D'> | null,
    oldCommands: null as FrameCommands<'CharacterBody2D'> | null,
  });

  usePhysicsProcess(body, { writes: ['position', 'velocity'] }, (commands, dt) => {
    const s = state.current;
    ensure(sprite.current && picture.current && progress.current && hud.current, 'mixed native refs are published');
    if (!paused) {
      commands.setVelocity(vec2(0, Math.min(commands.readVelocity().y + 1200 * dt, 600)));
      if (commands.moveAndSlide()) s.collisions++;
    }
    const position = commands.readPosition();
    const velocity = commands.readVelocity();
    const local = sprite.current.readPosition();
    ensure(close(local.x, 3) && close(local.y, -2), 'Sprite2D keeps its declared local position');
    ensure(sprite.current.read<{ id: string }>('texture').id === (skin === 0 ? 'markerA' : 'markerB'), 'native sprite texture matches the selected skin');
    ensure(picture.current.read<{ id: string }>('texture').id === (skin === 0 ? 'markerA' : 'markerB'), 'HUD texture uses the same mixed resource');
    s.settled = position.y >= 120 && position.y <= 130 && Math.abs(velocity.y) < 0.1 ? s.settled + 1 : 0;

    if (s.phase === 0 && s.collisions > 5 && s.settled >= 10) {
      s.bodyId = identity(body.current!); s.spriteId = identity(sprite.current);
      s.oldBody = body.current; s.oldCommands = commands;
      s.y = position.y; s.velocityY = velocity.y; s.phase = 1;
      console.log('GAME2D_COLLISION_OK', JSON.stringify({ position, velocity, collisions: s.collisions, body: s.bodyId, sprite: s.spriteId }));
      setPaused(true); setSkin(1); setHud(1);
    } else if (s.phase === 1 && paused && skin === 1 && hudCount === 1) {
      ensure(identity(body.current!) === s.bodyId, 'texture and HUD changes preserve body identity');
      ensure(identity(sprite.current) === s.spriteId, 'texture changes preserve sprite identity');
      ensure(close(position.y, s.y) && close(velocity.y, s.velocityY), 'HUD render does not reset movement; pause keeps the body fixed');
      ensure(hud.current.read('text') === 'HUD 1', 'React HUD changed on the native control');
      ensure(progress.current.read('value') === 70, 'native ProgressBar changed without resetting physics');
      if (++s.pausedFrames >= 8) {
        console.log('GAME2D_STABLE_SWAP_HUD_PAUSE_OK', JSON.stringify({ body: s.bodyId, sprite: s.spriteId, pausedFrames: s.pausedFrames, position }));
        s.phase = 2; s.collisions = 0; s.settled = 0;
        setRound(1); setPaused(false);
      }
    } else if (s.phase === 2 && round === 1 && identity(body.current!) !== s.bodyId) {
      ensure(!s.oldBody!.isValid(), 'reset invalidates the old body handle');
      ensure(identity(sprite.current) !== s.spriteId, 'reset retires the old sprite subtree');
      let rejected = false;
      try { s.oldCommands!.setVelocity(vec2(0, 9999)); } catch (error) { rejected = String(error).includes('E_STALE_COMMAND'); }
      ensure(rejected, 'commands saved before reset cannot mutate the replacement');
      if (position.y < 50) s.resetObserved = true;
      if (s.resetObserved && s.collisions > 5 && s.settled >= 10) {
        s.phase = 3;
        console.log('GAME2D_NATIVE_COMPOSITION_OK', JSON.stringify({
          realMoveAndSlide: true, mixedResources: true, resetObserved: s.resetObserved,
          stableTextureSwap: true, hudPreservedPhysics: true, pausedFrames: s.pausedFrames,
          oldHandleInvalid: !s.oldBody!.isValid(), staleCommandRejected: rejected,
          round, position, velocity, collisions: s.collisions,
          body: identity(body.current!), sprite: identity(sprite.current), spriteLocal: local,
        }));
      }
    }
  });

  const texture = skin === 0 ? markerA : markerB;
  return <Node name="Game2DWorld">
    <StaticBody2D name="Floor" position={vec2(100, 150)}>
      <CollisionShape2D name="Shape" shape={floorShape} />
      <Sprite2D name="FloorPicture" texture={markerA} scale={vec2(100, 8)} />
    </StaticBody2D>
    <CharacterBody2D key={round} name="Actor" ref={body}
      initial={{ position: vec2(100, 0), velocity: vec2(0, 0) }} engineOwned={['position', 'velocity']}>
      <CollisionShape2D name="Shape" shape={actorShape} />
      <Sprite2D name="ActorPicture" ref={sprite} position={vec2(3, -2)} texture={texture} scale={vec2(8, 12)} />
    </CharacterBody2D>
    <CanvasLayer name="HUD" layer={5} offset={vec2(270, 20)}>
      <PanelContainer><VBoxContainer customMinimumSize={vec2(200, 140)}>
        <Label ref={hud} text={'HUD ' + hudCount} />
        <TextureRect ref={picture} texture={texture} customMinimumSize={vec2(64, 32)} expandMode={1} stretchMode={0} />
        <ProgressBar ref={progress} value={hudCount === 0 ? 20 : 70} />
      </VBoxContainer></PanelContainer>
    </CanvasLayer>
  </Node>;
}

export default function App() {
  return <React.StrictMode><React.Suspense fallback={<Loading />}><World /></React.Suspense></React.StrictMode>;
}
