import * as React from "react";
import { Node, Button } from "@godot-js/react";
import Panel from "@project/react-templates/panel";

function Content() {
  const [version, setVersion] = React.useState(0);
  return <Node name="LocalWorld">
    <Panel name="A" key={`a-${version}`} />
    <Panel name="B" key="b" />
    <Button name="ResetA" text="Reset A" onPressed={() => setVersion(n => n + 1)} />
  </Node>;
}

export default function App() {
  return <React.StrictMode><React.Suspense fallback={null}><Content /></React.Suspense></React.StrictMode>;
}
