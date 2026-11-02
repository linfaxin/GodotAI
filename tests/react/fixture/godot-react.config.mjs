export default {
  entries: { app: { module: "src/App.tsx", startupAssets: ["marker"] } },
  templates: { panel: "templates/Panel.tscn" },
  assets: { marker: { source: "assets/marker.tres", type: "Resource" } },
  mode: "production",
};
