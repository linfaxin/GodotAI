# Summer native input evidence

Use a disposable copy of this project with the official Summer desktop app. The fixture polls input from Godot's physics callback. It writes startup and action edges to independent JSONL files and renders a marker at the position that `engine.game_probe` reads.

## Prepare the desktop host

1. Obtain the native editor from the [Summer download page](https://www.summerengine.com/download). The collector expects desktop version 0.8.8 unless you pass `--editor-version`. Use Node.js 22 or newer and install the separately pinned toolkit with `npm install --prefix <toolkit-directory> summer-engine@4.9.2`.
2. Copy `project.godot`, `main.tscn` and `player.gd` to a new directory. Make another directory for traces. Set `GODOTAI_SUMMER_TRACE_DIR` to that absolute path in the editor's launch environment and start the native executable with `--editor --path <fixture-copy>`. The editor must have a working display and the fixture must be open. Leave the game stopped. If the environment variable is omitted, the fixture writes to its actual user data directory and prints the resolved path at game startup.
3. Select the running editor whose `resourceRoot` is the fixture directory from `~/.summer/instances/`. Use its `instanceId` for collection. Keep the raw registry files private because they contain a local API token. If the editor uses a separate discovery state directory, pass `--state-dir` with that directory.

## Collect the original evidence

```sh
node apps/playground/scripts/collect-summer-native.mjs \
  --out "$evidence" \
  --project "$fixture" \
  --cli "$toolkit/node_modules/summer-engine/dist/bin/summer.js" \
  --binary "$editor" \
  --instance-id "$instance" \
  --trace-dir "$traces"
```

Use a new output directory. On Windows, run the same command with absolute paths for the toolkit entry and native executable. The collector calls Node directly on the public toolkit entry, so it does not depend on PowerShell or `cmd.exe` JSON quoting for Summer input.

For a Windows validation environment without PowerShell, pass `--process-probe` with a trusted Windows helper that takes one PID and writes the operating system's full executable path to stdout. The collector hashes the helper, resolves the actual process path, and checks it against the expected editor. Use `--runner-label` to record compatibility layers such as Wine and a virtual display.

The collector checks the bound editor and game identities and preserves the public CLI request and response files, original Probe images, and fixture traces. The required smoke submits the shared explicit 0/4 edge input, records four held physics ticks and the resulting movement, then probes a new run for the initial position. Collection and offline verification check the CLI outcome, tool terminal state and operation result. Both match each screenshot's `image_frame` to the state sample's `frame.process_frames`. The offline verifier also measures the marker position in the saved image.

Opening and playing the fixture in Summer can normalize the project settings and scene, omit values at Godot defaults, and add editor metadata and resource IDs. The collector preserves both observed project and scene snapshots, checks their behavior-bearing settings and scene data, compares the script bytes, and independently verifies the physics settings emitted by the running fixture.

The default full run requires the smoke, unknown action, no running game, and the literal `hold_ms: 50` case at default and confirmed fixed cadence. A held input requires a completed native receipt and an independently observed release. Read `cases.holdMillisecondsDefault.released.heldTicks` and `cases.holdMillisecondsFixed.released.heldTicks` from the report. One Windows 0.8.8 capture under Wine and Xvfb measured three ticks by default and four with `fixed_fps: 60`. The two receipts listed only the press in their scheduled frame range. Use the independent trace for the actual release frame.

The report's `requiredCases` lists the cases needed for the selected mode. A failed or incomplete required case makes the report `failed`. If the cases complete and the explicit physics timing differs, the report records `difference` and still collects the other cases. Both statuses exit nonzero. With `--smoke-only`, the explicit 0/4 case is the only requirement and the additional cases are marked `not_run`. Interruption remains untested in both modes.

Evidence file references in `report.json` are relative to the output directory and use forward slashes on every platform. Host paths, such as the bound executable and the original fixture trace location, remain in the host's own format.

A collector timeout preserves the recorded responses and leaves the operation outcome unknown. The collector does not retry input. It stops a game only after identifying the game as its own fixture run. If it cannot safely confirm cleanup, inspect the fixture editor before opening another run.
