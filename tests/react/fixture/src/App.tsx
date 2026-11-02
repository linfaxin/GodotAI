import * as React from "react";
import {
  Node, VBoxContainer, HBoxContainer, CanvasLayer, Label, Button,
  asset, useAsset, useNodeRef, useInput,
} from "@godot-js/react";
import Panel from "@project/react-templates/panel";

const Session = React.createContext("missing-session");

function Counter({ name, initial }: { name: string; initial: number }) {
  const [count, setCount] = React.useState(initial);
  const context = React.useContext(Session);
  const value = useNodeRef<"Label">();
  React.useEffect(() => {
    const saved = value.current;
    if (!saved) throw new Error("Fixture ref was not published before effect");
    return () => {
      const valid = saved.isValid();
      console.log("GODOT_REACT_FIXTURE_CLEANUP", JSON.stringify({
        name, valid, text: valid ? saved.read<string>("text") : "invalid",
      }));
      if (!valid) throw new Error(`Native object released before ${name} cleanup`);
    };
  }, []);
  return (
    <VBoxContainer name={name}>
      <Label name="Value" ref={value} text={`${context}/${name}:${count}`} />
      <Button name="Increment" text="Increment"
        {...(name === "Other" ? { toggleMode: true, buttonPressed: false,
          onToggled: (checked: boolean) => {
            if (!checked) throw new Error("GODOT_REACT_SOURCE_MAP_PROBE");
            console.log("GODOT_REACT_FIXTURE_TOGGLE", JSON.stringify({ name, checked }));
          },
        } : {})}
        onPressed={() => { if (name !== "Other") setCount(n => n + 1); }} />
    </VBoxContainer>
  );
}

function HUD() {
  const context = React.useContext(Session);
  return <CanvasLayer name="HUD"><Label name="Status" text={`HUD:${context}`} /></CanvasLayer>;
}

function ReadyApp() {
  useAsset(asset("marker", "Resource"));
  const app = useNodeRef<"Node">();
  const inputSeen = React.useRef(false);
  useInput(app, (_commands, event) => {
    const dto = event as Record<string, unknown>;
    if (!inputSeen.current && dto.type === "InputEventKey" && dto.pressed === true) {
      inputSeen.current = true;
      if (typeof dto.keycode !== "number" || dto.keycode === 0 || !Object.isFrozen(dto)) throw new Error("Input adapter did not publish a frozen native key DTO");
      console.log("GODOT_REACT_FIXTURE_INPUT_DTO", JSON.stringify({
        type: dto.type, pressed: dto.pressed, keycode: dto.keycode,
        frozen: Object.isFrozen(dto), noNativeMethods: typeof dto.get_class === "undefined",
      }));
    }
  });
  const [initial, setInitial] = React.useState(1);
  const [version, setVersion] = React.useState(0);
  const [session, setSession] = React.useState("ctx-A");
  return (
    <Session.Provider value={session}>
      <Node name="App" ref={app}>
        <Counter name="Main" key={`main-${version}`} initial={initial} />
        <Counter name="Other" key="other" initial={10} />
        <HUD />
        <HBoxContainer name="Actions">
          <Button name="UpdateProps" text="Update props" toggleMode onPressed={() => {
            setInitial(77); setSession("ctx-B");
          }} />
          <Button name="ResetMain" text="Reset main" onPressed={() => setVersion(n => n + 1)} />
        </HBoxContainer>
        <Panel name="Imported" />
        <Label name="AssetStatus" text="asset-ready" />
      </Node>
    </Session.Provider>
  );
}

export default function App() {
  return <React.StrictMode><React.Suspense fallback={<Label name="Loading" text="loading" />}><ReadyApp /></React.Suspense></React.StrictMode>;
}
