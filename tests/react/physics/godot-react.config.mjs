export default {
  entries: { physics: { module: "src/Physics.tsx", startupAssets: ["floorShape", "actorShape"] } },
  profileId: "behavior-physics-v1",
  assets: {
    floorShape: { source: "assets/floor-shape.tres", type: "RectangleShape2D" },
    actorShape: { source: "assets/actor-shape.tres", type: "CapsuleShape2D" },
  },
  mode: "production",
};
