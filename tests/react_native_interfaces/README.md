Run after building the React packages and a current GodotJS editor with SceneMultiplayer and ENet:

```sh
node tests/react_native_interfaces/run.mjs /absolute/path/to/godot /tmp/godot-react-rpc-project --mode production --also-development-source
```

The fixture builds through the production compiler and launches two independent processes. It checks an exact `Node2D` leaf, real Script RPC metadata, JSON DTO and stable network IDs, captured native sender IDs, rejected client authority calls, a missing remote NodePath, an unnegotiated transfer channel, local execution, separate valid transfer channels, ordered unreliable delivery, current committed React handlers, one native ready callback and disconnect/reconnect. It then runs the formal production exporter and repeats both peers from an empty directory using the PCK.

Logs and `rpc-report.json` remain in the selected project directory. Negative tests require native rejection diagnostics as well as the absence of a remote handler call. A failed assertion or timeout exits with an error; metadata or a local send status alone cannot pass this fixture.

The command above separately verifies production source, development source with observed StrictMode layout-effect replay and one native ready delivery, and the official production PCK. The completed native build report and executable SHA-256 must match and stay fixed throughout the run; each report records that tuple. Use separate project directories for final certification to retain earlier evidence.
