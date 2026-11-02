```sh
node tests/react_source_maps/run.mjs /absolute/path/to/current/godot /tmp/react-source-map-probe
```

This separate negative fixture compiles real React TSX with esbuild, then verifies the exact authored line through both `bridge.formatStack(error.stack)` and the native uncaught-exception path. The compressed fixture requires a precise original location when engine columns are available, and an unchanged generated-JS location when a columnless line is ambiguous. Expected exceptions stay outside application BootReports. Logs, raw and mapped stacks, and `source-map-report.json` remain in the selected directory.
