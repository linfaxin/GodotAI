#!/usr/bin/env bash
# Run the real browser test with a private PulseAudio server and, for Firefox,
# an actual X11 display. The null sink processes WebAudio without a speaker.
set -euo pipefail

if [[ $# -lt 4 || "$3" != -- ]]; then
  echo 'Usage: run-browser-worker-linux.sh <chromium|firefox|webkit> <evidence-dir> -- <command> [args...]' >&2
  exit 2
fi
browser_name=$1
evidence_dir=$2
shift 3
case "$browser_name" in chromium|firefox|webkit) ;; *) echo 'Unknown browser' >&2; exit 2 ;; esac
for executable in node pulseaudio pactl; do command -v "$executable" >/dev/null; done
if [[ "$browser_name" == firefox ]]; then
  for executable in Xvfb xdpyinfo; do command -v "$executable" >/dev/null; done
fi
mkdir -p "$evidence_dir/environment"
evidence_dir=$(cd "$evidence_dir" && pwd)
environment_dir="$evidence_dir/environment"
runtime_dir=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/godot-worker-linux.XXXXXX")
chmod 700 "$runtime_dir"
pulse_pid=
xvfb_pid=
cleanup() {
  local status=$?
  trap - EXIT
  set +e
  if [[ -n "$pulse_pid" ]]; then kill "$pulse_pid" 2>/dev/null; wait "$pulse_pid" 2>/dev/null; fi
  if [[ -n "$xvfb_pid" ]]; then kill "$xvfb_pid" 2>/dev/null; wait "$xvfb_pid" 2>/dev/null; fi
  rm -rf "$runtime_dir"
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

export XDG_RUNTIME_DIR="$runtime_dir/runtime"
export PULSE_RUNTIME_PATH="$runtime_dir/pulse"
export PULSE_STATE_PATH="$runtime_dir/pulse-state"
export PULSE_COOKIE="$runtime_dir/pulse-cookie"
export PULSE_SERVER="unix:$runtime_dir/pulse.sock"
export PULSE_SINK=godot_worker_ci
mkdir -m 700 "$XDG_RUNTIME_DIR" "$PULSE_RUNTIME_PATH" "$PULSE_STATE_PATH"
cat > "$environment_dir/pulse.pa" <<EOF
load-module module-native-protocol-unix socket=$runtime_dir/pulse.sock auth-cookie=$PULSE_COOKIE auth-anonymous=0
load-module module-null-sink sink_name=godot_worker_ci rate=48000 channels=2
set-default-sink godot_worker_ci
EOF
pulse_args=(-nF "$environment_dir/pulse.pa" --daemonize=no --exit-idle-time=-1 --use-pid-file=no --log-target=stderr)
if [[ -n "${PULSE_MODULE_PATH:-}" ]]; then pulse_args+=("--dl-search-path=$PULSE_MODULE_PATH"); fi
pulseaudio "${pulse_args[@]}" > "$environment_dir/pulseaudio.log" 2>&1 &
pulse_pid=$!
pulse_ready=0
for attempt in {1..100}; do
  if pactl info > "$environment_dir/pactl-info.txt" 2>/dev/null; then pulse_ready=1; break; fi
  if ! kill -0 "$pulse_pid" 2>/dev/null; then cat "$environment_dir/pulseaudio.log" >&2; exit 1; fi
  sleep 0.1
done
if [[ "$pulse_ready" != 1 ]]; then echo 'PulseAudio startup timed out' >&2; cat "$environment_dir/pulseaudio.log" >&2; exit 1; fi
pactl list short sinks > "$environment_dir/pactl-sinks.txt"
pactl list short modules > "$environment_dir/pactl-modules.txt"
if [[ "$(pactl get-default-sink)" != godot_worker_ci ]]; then echo 'The expected real PulseAudio sink is not selected' >&2; exit 1; fi

export BROWSER_HEADLESS=1
if [[ "$browser_name" == firefox ]]; then
  : > "$environment_dir/xvfb-display.txt"
  Xvfb -displayfd 3 -screen 0 1280x960x24 -nolisten tcp 3> "$environment_dir/xvfb-display.txt" > "$environment_dir/xvfb.log" 2>&1 &
  xvfb_pid=$!
  display_ready=0
  for attempt in {1..100}; do
    if [[ -s "$environment_dir/xvfb-display.txt" ]]; then display_ready=1; break; fi
    if ! kill -0 "$xvfb_pid" 2>/dev/null; then cat "$environment_dir/xvfb.log" >&2; exit 1; fi
    sleep 0.1
  done
  if [[ "$display_ready" != 1 ]]; then echo 'Xvfb startup timed out' >&2; exit 1; fi
  display_number=$(cat "$environment_dir/xvfb-display.txt")
  if [[ ! "$display_number" =~ ^[0-9]+$ ]]; then echo 'Invalid Xvfb display number' >&2; exit 1; fi
  export DISPLAY=":$display_number"
  export BROWSER_HEADLESS=0
  export LIBGL_ALWAYS_SOFTWARE=1
  xdpyinfo -display "$DISPLAY" > "$environment_dir/x11-info.txt"
fi

node --input-type=module - "$browser_name" "$environment_dir" "$@" <<'NODE'
import {writeFile,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const [browser,directory,...command]=process.argv.slice(2);
const version=(name,args)=>{try{return execFileSync(name,args,{encoding:'utf8'}).trim();}catch{return 'unavailable';}};
const report={schemaVersion:1,kind:'godotjs-linux-browser-environment',browser,platform:process.platform,architecture:process.arch,osRelease:await readFile('/etc/os-release','utf8'),node:process.version,headless:process.env.BROWSER_HEADLESS!=='0',display:process.env.DISPLAY??null,softwareGL:process.env.LIBGL_ALWAYS_SOFTWARE??null,pulse:{server:process.env.PULSE_SERVER,sink:process.env.PULSE_SINK,version:version('pulseaudio',['--version']),sampleRate:48000,channels:2,anonymousAuthentication:false,physicalSpeaker:false},packages:version('dpkg-query',['-W','-f=${Package}\t${Version}\n','xvfb','pulseaudio','pulseaudio-utils','libasound2-plugins','libgl1-mesa-dri','x11-utils']),command,recordedAt:new Date().toISOString()};
report.pulseConfigurationSha256=createHash('sha256').update(await readFile(directory+'/pulse.pa')).digest('hex');
await writeFile(directory+'/environment.json',JSON.stringify(report,null,2)+'\n');
console.log(JSON.stringify(report,null,2));
NODE

set +e
"$@" 2>&1 | tee "$evidence_dir/runtime.log"
pipeline_status=("${PIPESTATUS[@]}")
set -e
command_status=${pipeline_status[0]}
if [[ "$command_status" == 0 && "${pipeline_status[1]}" != 0 ]]; then command_status=${pipeline_status[1]}; fi
printf '{"commandExitCode":%s}\n' "$command_status" > "$environment_dir/command-status.json"
exit "$command_status"
