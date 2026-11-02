import * as React from "react";
import {
  Node, StaticBody2D, CharacterBody2D, CollisionShape2D,
  asset, useAsset, useNodeRef, usePhysicsProcess, vec2,
} from "@godot-js/react";

function PhysicsWorld() {
  const floorShape = useAsset(asset("floorShape", "RectangleShape2D"));
  const actorShape = useAsset(asset("actorShape", "CapsuleShape2D"));
  const actor = useNodeRef<"CharacterBody2D">();
  const progress = React.useRef({ frames: 0, collisions: 0, settled: 0, sent: false, staleChecked: false });
  usePhysicsProcess(actor, { writes: ["position", "velocity"] }, (commands, dt) => {
    const state = progress.current;
    state.frames++;
    commands.setVelocity(vec2(0, Math.min(commands.readVelocity().y + 1200 * dt, 600)));
    if (commands.moveAndSlide()) state.collisions++;
    const position = commands.readPosition();
    const velocity = commands.readVelocity();
    state.settled = position.y >= 120 && position.y <= 130 && Math.abs(velocity.y) < 0.1 ? state.settled + 1 : 0;
    if (!state.staleChecked) {
      state.staleChecked = true;
      Promise.resolve().then(() => {
        try { commands.setVelocity(vec2(0, 9999)); }
        catch (error) {
          if (!String(error).includes("E_")) throw error;
          console.log("GODOT_REACT_PHYSICS_STALE_TOKEN_OK", String(error));
          return;
        }
        throw new Error("Expired frame command escaped its synchronous dispatch");
      });
    }
    if (!state.sent && state.frames > 20 && state.collisions > 5 && state.settled >= 10) {
      state.sent = true;
      console.log("GODOT_REACT_PHYSICS_BEHAVIOR_OK", JSON.stringify({
        frames: state.frames, collisions: state.collisions, settled: state.settled,
        position, velocity, realMoveAndSlide: true,
      }));
    }
  });
  return <Node name="PhysicsWorld">
    <StaticBody2D name="Floor" position={vec2(100, 150)}>
      <CollisionShape2D name="Shape" shape={floorShape} />
    </StaticBody2D>
    <CharacterBody2D name="Actor" ref={actor}
      initial={{ position: vec2(100, 0), velocity: vec2(0, 0) }}
      engineOwned={["position", "velocity"]}>
      <CollisionShape2D name="Shape" shape={actorShape} />
    </CharacterBody2D>
  </Node>;
}

export default function App() {
  return <React.StrictMode><React.Suspense fallback={null}><PhysicsWorld /></React.Suspense></React.StrictMode>;
}
