# Review regression gates

After building both React packages, run this fixture with a source-certified
GodotJS editor binary:

```sh
node tests/react/review-regressions/run.mjs /absolute/path/to/godot /tmp/react-review-regressions
```

It checks actual native process/physics/input rebinding after independent child
key changes, Ready cleanup while the old handle is alive, ordinary Node and
CanvasLayer descendants hidden by Suspense, restored visibility baselines, and
development `initial` diagnostics. It runs development and production source,
the official production exporter, and the PCK from an empty directory.

A separate watch run waits for structured native BootReports, edits the source,
verifies a new process and generation, then checks that cancellation leaves no
native child or reader lease. `review-regressions.json` records the native
certificate, SDK fingerprint, execution modes, business checks and watch result.

Package tests additionally cover a package-shaped consumer with hoisted React
types, lease rejection when a forwarded ref changes ownership, duplicate writer
rejection, failed-build recovery, existing preview handoff, external-process
refusal, and bounded cancellation. Their stand-in process tests exercise Node
supervision; they do not substitute for this Godot fixture.
