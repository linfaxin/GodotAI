/** Checked Godot 4.6.1 ordinary Worker startup, audio imports and presentation ABI. */
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {WORKER_XR_PATH,patchWorkerXR} from './patch-web-worker-xr.mjs';
const XR_IMPLEMENTATION_SHA256='e34160cf7e4fb6073f530c424b2c41b1e6402be155403b223af9381fdbb57069';
export const WORKER_RUNTIME_PATCH='godotjs-web-worker-runtime-v1';
export const WORKER_RUNTIME_ABI=Object.freeze({protocolVersion:2,host:1,audio:1,presentation:1});
const layouts={
  "main/main.cpp": {
    "sha256": "248f7e34fbe5aa3a65275420264af33cca7d29e0ce353120a90b9aaf23e8927c",
    "edits": [
      [
        "\nError Main::setup2(bool p_show_boot_logo) {",
        "\n#ifdef WEB_ENABLED\n// GODOTJS_WORKER_AUDIO_PREFERENCES_V1: queried only after Main::setup(false).\nextern \"C\" int godot_web_worker_audio_mix_rate() {\n\tGLOBAL_DEF_RST(PropertyInfo(Variant::INT, \"audio/driver/mix_rate\", PROPERTY_HINT_RANGE, \"11025,192000,1,or_greater,suffix:Hz\"), AudioDriverManager::DEFAULT_MIX_RATE);\n\tGLOBAL_DEF_RST(PropertyInfo(Variant::INT, \"audio/driver/mix_rate.web\", PROPERTY_HINT_RANGE, \"0,192000,1,or_greater,suffix:Hz\"), 0);\n\treturn MAX(0, int(GLOBAL_GET(\"audio/driver/mix_rate\")));\n}\nextern \"C\" int godot_web_worker_audio_latency() { return Engine::get_singleton()->get_audio_output_latency(); }\nextern \"C\" const char *godot_web_worker_audio_driver() {\n\tERR_FAIL_INDEX_V(audio_driver_idx, AudioDriverManager::get_driver_count(), \"\");\n\treturn AudioDriverManager::get_driver(audio_driver_idx)->get_name();\n}\n#endif\n\nError Main::setup2(bool p_show_boot_logo) {"
      ],
      [
        "\n/* Static members */",
        "\n#ifdef WEB_ENABLED\n#include <emscripten/emscripten.h>\n#ifndef XR_DISABLED\n#include \"servers/xr/xr_interface.h\"\n#endif\n// GODOTJS_WORKER_DRAW_CREDIT_V1: credit gates drawing, never simulation.\nstatic double godot_worker_draw_step_debt = 0.0;\nextern \"C\" EMSCRIPTEN_KEEPALIVE void godot_web_worker_reset_draw_credit() {\n\tgodot_worker_draw_step_debt = 0.0;\n}\nstatic bool godot_web_worker_draw_allowed(bool p_render_loop_enabled) {\n\t// Preserve the upstream draw(false) resource flush when a project disables rendering.\n\tif (!p_render_loop_enabled) return true;\n#ifndef XR_DISABLED\n\tXRServer *xr_server = XRServer::get_singleton();\n\tif (xr_server) {\n\t\tRef<XRInterface> primary = xr_server->get_primary_interface();\n\t\tif (primary.is_valid() && primary->is_initialized()) return true;\n\t}\n#endif\n\treturn EM_ASM_INT({\n\t\tconst callback = Module['godotWorkerDrawAllowed'];\n\t\treturn typeof callback !== 'function' || callback() !== false ? 1 : 0;\n\t}) != 0;\n}\n#endif\n\n/* Static members */"
      ],
      [
        "Error Main::setup(const char *execpath, int argc, char *argv[], bool p_second_phase) {",
        "Error Main::setup(const char *execpath, int argc, char *argv[], bool p_second_phase) {\n#ifdef WEB_ENABLED\n\tgodot_web_worker_reset_draw_credit();\n\tEM_ASM({ Module['godotWorkerResetDrawCredit'] = Module['_godot_web_worker_reset_draw_credit']; });\n#endif"
      ],
      [
        "void Main::cleanup(bool p_force) {",
        "void Main::cleanup(bool p_force) {\n#ifdef WEB_ENABLED\n\tgodot_web_worker_reset_draw_credit();\n\tEM_ASM({ delete Module['godotWorkerResetDrawCredit']; });\n#endif"
      ],
      [
        "\tGodotProfileZoneGrouped(_profile_zone, \"RenderingServer::draw\");\n\tconst bool has_pending_resources_for_processing = RD::get_singleton() && RD::get_singleton()->has_pending_resources_for_processing();\n\tbool wants_present = (DisplayServer::get_singleton()->can_any_window_draw() ||\n\t\t\t\t\t\t\t\t DisplayServer::get_singleton()->has_additional_outputs()) &&\n\t\t\tRenderingServer::get_singleton()->is_render_loop_enabled();\n\n\tif (wants_present || has_pending_resources_for_processing) {\n\t\twants_present |= force_redraw_requested;\n\t\tif ((!force_redraw_requested) && OS::get_singleton()->is_in_low_processor_usage_mode()) {\n\t\t\tif (RenderingServer::get_singleton()->has_changed()) {\n\t\t\t\tRenderingServer::get_singleton()->draw(wants_present, scaled_step); // flush visual commands\n\t\t\t\tEngine::get_singleton()->increment_frames_drawn();\n\t\t\t}\n\t\t} else {\n\t\t\tRenderingServer::get_singleton()->draw(wants_present, scaled_step); // flush visual commands\n\t\t\tEngine::get_singleton()->increment_frames_drawn();\n\t\t\tforce_redraw_requested = false;\n\t\t}\n\t}\n",
        "\tGodotProfileZoneGrouped(_profile_zone, \"RenderingServer::draw\");\n\tconst bool has_pending_resources_for_processing = RD::get_singleton() && RD::get_singleton()->has_pending_resources_for_processing();\n\tconst bool render_loop_enabled = RenderingServer::get_singleton()->is_render_loop_enabled();\n\tbool wants_present = (DisplayServer::get_singleton()->can_any_window_draw() ||\n\t\t\t\t\t\t\t\t DisplayServer::get_singleton()->has_additional_outputs()) &&\n\t\t\trender_loop_enabled;\n\n\t// Consult credit only where upstream would really draw. Low-usage/no-change\n\t// iterations and project-disabled/hidden frames must not accrue draw time.\n\tauto draw_frame = [&](bool p_present) -> bool {\n#ifdef WEB_ENABLED\n\t\tif (!godot_web_worker_draw_allowed(render_loop_enabled)) {\n\t\t\tgodot_worker_draw_step_debt += scaled_step;\n\t\t\treturn false;\n\t\t}\n\t\tconst double draw_step = scaled_step + godot_worker_draw_step_debt;\n\t\tRenderingServer::get_singleton()->draw(p_present, draw_step); // flush visual commands\n\t\tgodot_worker_draw_step_debt = 0.0;\n#else\n\t\tRenderingServer::get_singleton()->draw(p_present, scaled_step); // flush visual commands\n#endif\n\t\treturn true;\n\t};\n\tif (wants_present || has_pending_resources_for_processing) {\n\t\twants_present |= force_redraw_requested;\n\t\tif ((!force_redraw_requested) && OS::get_singleton()->is_in_low_processor_usage_mode()) {\n\t\t\tif (RenderingServer::get_singleton()->has_changed() && draw_frame(wants_present)) {\n\t\t\t\tEngine::get_singleton()->increment_frames_drawn();\n\t\t\t}\n\t\t} else if (draw_frame(wants_present)) {\n\t\t\tEngine::get_singleton()->increment_frames_drawn();\n\t\t\tforce_redraw_requested = false;\n\t\t}\n\t}\n"
      ]
    ]
  },
  "platform/web/web_main.cpp": {
    "sha256": "ad80db0d9bce7e9f46ca02f756f12cf883d279655b317442e1a6f55d70ac293f",
    "edits": [
      [
        "#include <emscripten/emscripten.h>",
        "#include <emscripten/emscripten.h>\n#include <emscripten/eventloop.h>\n#include \"servers/audio/audio_server.h\"\n#include \"servers/audio/audio_driver_dummy.h\""
      ],
      [
        "static bool shutdown_complete = false;",
        "static bool shutdown_complete = false;\n// GODOTJS_WORKER_RUNTIME_V1: a pending first setup phase owns one keepalive.\nstatic int worker_boot_phase = 0;\nstatic bool worker_boot_keepalive = false;\nstatic uint32_t worker_iteration = 0;\nstatic uint32_t worker_commit_serial = 0;\nstatic bool worker_in_iteration = false;\nextern \"C\" int godot_web_worker_audio_mix_rate();\nextern \"C\" int godot_web_worker_audio_latency();\nextern \"C\" const char *godot_web_worker_audio_driver();\nstatic void worker_release_boot_keepalive() {\n\tif (worker_boot_keepalive) { worker_boot_keepalive = false; emscripten_runtime_keepalive_pop(); }\n}\nextern \"C\" EMSCRIPTEN_KEEPALIVE void godot_web_worker_cancel_start() {\n\tEM_ASM({ Module['godotWorkerBootCancelled'] = true; Module['godotWorkerBootEpoch'] = (Module['godotWorkerBootEpoch'] || 0) + 1; });\n\tif (worker_boot_phase == 1 || worker_boot_phase == 2) { worker_boot_phase = -1; worker_release_boot_keepalive(); }\n\t// A partially constructed phase-1 runtime must be destroyed by its Worker\n\t// owner, not Main::cleanup(), which assumes setup2 initialized all servers.\n}\nextern \"C\" void godot_web_worker_frame_committed() {\n\tif (!worker_in_iteration) return;\n\tworker_commit_serial++;\n\tEM_ASM({ if (Module['godotWorkerCommit']) Module['godotWorkerCommit']($0 >>> 0, $1 >>> 0); }, worker_commit_serial, worker_iteration);\n}"
      ],
      [
        "\tif (os->main_loop_iterate()) {",
        "\tworker_iteration++;\n\tworker_in_iteration = true;\n\tEM_ASM({ if (Module['godotWorkerBeginIteration']) Module['godotWorkerBeginIteration']($0 >>> 0); }, worker_iteration);\n\tconst bool should_exit = os->main_loop_iterate();\n\tworker_in_iteration = false;\n\tEM_ASM({ if (Module['godotWorkerEndIteration']) Module['godotWorkerEndIteration']($0 >>> 0, $1 >>> 0); }, worker_iteration, worker_commit_serial);\n\tif (should_exit) {"
      ],
      [
        "/// When calling main, it is assumed FS is setup and synced.\nextern EMSCRIPTEN_KEEPALIVE int godot_web_main(int argc, char *argv[]) {\n\tgodot_init_profiler();\n\n\tos = new OS_Web();\n\n#ifdef TOOLS_ENABLED\n\tWebToolsEditorPlugin::initialize();\n#endif\n\n\t// We must override main when testing is enabled\n\tTEST_MAIN_OVERRIDE\n\n\tError err = Main::setup(argv[0], argc - 1, &argv[1]);\n\n\t// Proper shutdown in case of setup failure.\n\tif (err != OK) {\n\t\t// Will only exit after sync.\n\t\temscripten_set_main_loop(exit_callback, -1, false);\n\t\tgodot_js_os_finish_async(cleanup_after_sync);\n\t\tif (err == ERR_HELP) { // Returned by --help and --version, so success.\n\t\t\treturn EXIT_SUCCESS;\n\t\t}\n\t\treturn EXIT_FAILURE;\n\t}\n\n\tprint_web_header();\n\n\tmain_started = true;\n\n\t// Ease up compatibility.\n\tResourceLoader::set_abort_on_missing_resources(false);\n\n\tint ret = Main::start();\n\tos->set_exit_code(ret);\n\tos->get_main_loop()->initialize();\n#ifdef TOOLS_ENABLED\n\tif (Engine::get_singleton()->is_project_manager_hint() && FileAccess::exists(\"/tmp/preload.zip\")) {\n\t\tPackedStringArray ps;\n\t\tps.push_back(\"/tmp/preload.zip\");\n\t\tSceneTree::get_singleton()->get_root()->emit_signal(SNAME(\"files_dropped\"), ps);\n\t}\n#endif\n\temscripten_set_main_loop(main_loop_callback, -1, false);\n\t// Immediately run the first iteration.\n\t// We are inside an animation frame, we want to immediately draw on the newly setup canvas.\n\tmain_loop_callback();\n\n\treturn os->get_exit_code();\n}\n",
        "static int start_web_runtime() {\n\tprint_web_header();\n\n\tmain_started = true;\n\n\t// Ease up compatibility.\n\tResourceLoader::set_abort_on_missing_resources(false);\n\n\tint ret = Main::start();\n\tos->set_exit_code(ret);\n\tif (ret != EXIT_SUCCESS || !os->get_main_loop()) return EXIT_FAILURE;\n\tos->get_main_loop()->initialize();\n#ifdef TOOLS_ENABLED\n\tif (Engine::get_singleton()->is_project_manager_hint() && FileAccess::exists(\"/tmp/preload.zip\")) {\n\t\tPackedStringArray ps;\n\t\tps.push_back(\"/tmp/preload.zip\");\n\t\tSceneTree::get_singleton()->get_root()->emit_signal(SNAME(\"files_dropped\"), ps);\n\t}\n#endif\n\temscripten_set_main_loop(main_loop_callback, -1, false);\n\t// Immediately run the first iteration.\n\t// We are inside an animation frame, we want to immediately draw on the newly setup canvas.\n\tEM_ASM({ if (Module['preMainLoop']) Module['preMainLoop'](); });\n\tmain_loop_callback();\n\tEM_ASM({ if (Module['postMainLoop']) Module['postMainLoop'](); });\n\n\treturn os->get_exit_code();\n}\n\nextern \"C\" EMSCRIPTEN_KEEPALIVE int godot_web_worker_resume() {\n\tif (worker_boot_phase != 1) return EXIT_FAILURE;\n\tworker_boot_phase = 2;\n\tconst String expected = godot_web_worker_audio_driver();\n\tif (expected == \"Dummy\") {\n\t\t// Explicit no-audio mode has no browser clock or native worker threads.\n\t\t// A Web auto rate of zero must not leak into the native dummy mixer.\n\t\tAudioDriverDummy::get_dummy_singleton()->set_use_threads(false);\n\t\tconst int requested_rate = godot_web_worker_audio_mix_rate();\n\t\tAudioDriverDummy::get_dummy_singleton()->set_mix_rate(requested_rate > 0 ? requested_rate : AudioDriverManager::DEFAULT_MIX_RATE);\n\t}\n\tError err = Main::setup2();\n\tint status = EXIT_FAILURE;\n\tif (err == OK) {\n\t\t// Preserve the selected native driver; failures may not silently fall back.\n\t\tif (AudioDriver::get_singleton() && String(AudioDriver::get_singleton()->get_name()) == expected) status = start_web_runtime();\n\t}\n\tworker_boot_phase = status == EXIT_SUCCESS ? 3 : -1;\n\tworker_release_boot_keepalive();\n\tEM_ASM({\n\t\tif ($0 === 0) { if (Module['godotWorkerStartResolve']) Module['godotWorkerStartResolve'](); }\n\t\telse if (Module['godotWorkerStartReject']) Module['godotWorkerStartReject'](new Error('E_WORKER_NATIVE_START: setup2, audio driver or start failed'));\n\t}, status);\n\treturn status;\n}\n\n/// When calling main, it is assumed FS is setup and synced.\nextern EMSCRIPTEN_KEEPALIVE int godot_web_main(int argc, char *argv[]) {\n\tgodot_init_profiler();\n\tconst bool worker_mode = EM_ASM_INT({ return typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope ? 1 : 0; });\n\tif (worker_mode) {\n\t\tEM_ASM({\n\t\t\tconst audio = globalThis.__godotWorkerAudio;\n\t\t\tif (!audio || typeof audio.prepare !== 'function' || !audio.available()) throw new Error('E_WORKER_AUDIO_BOOTSTRAP: install the declared audio bridge before OS_Web');\n\t\t\tif (typeof Module['godotWorkerStartResolve'] !== 'function') throw new Error('E_WORKER_START_API');\n\t\t});\n\t}\n\tos = new OS_Web();\n#ifdef TOOLS_ENABLED\n\tWebToolsEditorPlugin::initialize();\n#endif\n\tTEST_MAIN_OVERRIDE\n\tError err = Main::setup(argv[0], argc - 1, &argv[1], !worker_mode);\n\tif (err != OK) {\n\t\tif (worker_mode) {\n\t\t\tEM_ASM({ if (Module['godotWorkerStartReject']) Module['godotWorkerStartReject'](new Error('E_WORKER_NATIVE_SETUP')); });\n\t\t\treturn EXIT_FAILURE;\n\t\t}\n\t\temscripten_set_main_loop(exit_callback, -1, false);\n\t\tgodot_js_os_finish_async(cleanup_after_sync);\n\t\treturn err == ERR_HELP ? EXIT_SUCCESS : EXIT_FAILURE;\n\t}\n\tif (!worker_mode) return start_web_runtime();\n\tworker_boot_phase = 1;\n\tworker_boot_keepalive = true;\n\temscripten_runtime_keepalive_push();\n\tEM_ASM({\n\t\tconst epoch = Module['godotWorkerBootEpoch'] = (Module['godotWorkerBootEpoch'] || 0) + 1;\n\t\tModule['godotWorkerBootCancelled'] = false;\n\t\tconst preferences = ({ mixRate: $0, latencyMs: $1, driver: UTF8ToString($2) });\n\t\tconst active = function () { return !Module['godotWorkerBootCancelled'] && Module['godotWorkerBootEpoch'] === epoch; };\n\t\tPromise.resolve().then(function () {\n\t\t\tif (!active()) return;\n\t\t\treturn globalThis.__godotWorkerAudio.prepare(preferences);\n\t\t}).then(function () {\n\t\t\tif (active()) Module['_godot_web_worker_resume']();\n\t\t}).catch(function (error) {\n\t\t\tif (!active()) return;\n\t\t\tModule['_godot_web_worker_cancel_start']();\n\t\t\tif (Module['godotWorkerStartReject']) Module['godotWorkerStartReject'](error);\n\t\t});\n\t}, godot_web_worker_audio_mix_rate(), godot_web_worker_audio_latency(), godot_web_worker_audio_driver());\n\treturn EXIT_SUCCESS;\n}\n"
      ]
    ]
  },
  "platform/web/display_server_web.cpp": {
    "sha256": "2eb1fa9ee86908fcc26c88c44113ac424fd17facacd02b194ca5dfb5d74b7c16",
    "edits": [
      [
        "void DisplayServerWeb::swap_buffers() {",
        "extern \"C\" void godot_web_worker_frame_committed();\n\nvoid DisplayServerWeb::swap_buffers() {"
      ],
      [
        "\t\temscripten_webgl_commit_frame();\n\t}\n#endif\n}\n",
        "\t\tif (emscripten_webgl_commit_frame() == EMSCRIPTEN_RESULT_SUCCESS) {\n\t\t\tgodot_web_worker_frame_committed();\n\t\t}\n\t}\n#endif\n}\n"
      ]
    ]
  },
  "platform/web/js/engine/engine.js": {
    "sha256": "50cf8848b78220bb59e5569d790d3d71d10a321dc3468a46f472967ecb7894c9",
    "edits": [
      [
        "\t\t\t\t\treturn new Promise(function (resolve, reject) {\n\t\t\t\t\t\tfor (const file of preloader.preloadedFiles)",
        "\t\t\t\t\tconst runtime = me.rtenv;\n\t\t\t\t\tconst workerMode = typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;\n\t\t\t\t\tconst startPromise = new Promise(function (resolve, reject) {\n\t\t\t\t\t\tif (workerMode) {\n\t\t\t\t\t\t\t// GODOTJS_WORKER_START_BARRIER_V1\n\t\t\t\t\t\t\tlet settled = false;\n\t\t\t\t\t\t\truntime['godotWorkerStartResolve'] = function () { if (!settled) { settled = true; resolve(); } };\n\t\t\t\t\t\t\truntime['godotWorkerStartReject'] = function (error) { if (!settled) { settled = true; reject(error); } };\n\t\t\t\t\t\t\truntime['godotWorkerCancelStart'] = function () {\n\t\t\t\t\t\t\t\tif (settled) return;\n\t\t\t\t\t\t\t\tif (typeof runtime['_godot_web_worker_cancel_start'] === 'function') runtime['_godot_web_worker_cancel_start']();\n\t\t\t\t\t\t\t\truntime['godotWorkerStartReject'](new DOMException('Worker startup cancelled', 'AbortError'));\n\t\t\t\t\t\t\t};\n\t\t\t\t\t\t}\n\t\t\t\t\t\tfor (const file of preloader.preloadedFiles)"
      ],
      [
        "\t\t\t\t\t\tme.installServiceWorker();\n\t\t\t\t\t\tresolve();\n\t\t\t\t\t});",
        "\t\t\t\t\t\tme.installServiceWorker();\n\t\t\t\t\t\tif (!workerMode) resolve();\n\t\t\t\t\t});\n\t\t\t\t\tif (workerMode) runtime['godotWorkerStartPromise'] = startPromise;\n\t\t\t\t\treturn startPromise;"
      ]
    ]
  },
  "platform/web/js/libs/library_godot_audio.js": {
    "sha256": "8ad61bdce01b1d3ce833608feafe73cd18961aa740c60b5d02d53607f9a7865b",
    "edits": [
      [
        "\tgodot_audio_is_available: function () {",
        "\tgodot_audio_is_available: function () {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { return globalThis.__godotWorkerAudio.available() ? 1 : 0; }"
      ],
      [
        "\tgodot_audio_has_worklet: function () {",
        "\tgodot_audio_has_worklet: function () {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { return globalThis.__godotWorkerAudio.hasWorklet() ? 1 : 0; }"
      ],
      [
        "\tgodot_audio_has_script_processor: function () {",
        "\tgodot_audio_has_script_processor: function () {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { return 0; }"
      ],
      [
        "\tgodot_audio_init: function (\n\t\tp_mix_rate,\n\t\tp_latency,\n\t\tp_state_change,\n\t\tp_latency_update\n\t) {",
        "\tgodot_audio_init: function (\n\t\tp_mix_rate,\n\t\tp_latency,\n\t\tp_state_change,\n\t\tp_latency_update\n\t) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { const audio = globalThis.__godotWorkerAudio; const result = audio.init(GodotRuntime.getHeapValue(p_mix_rate, 'i32'), p_latency, GodotRuntime.get_func(p_state_change), GodotRuntime.get_func(p_latency_update)); if (!result || !Number.isSafeInteger(result.sampleRate) || result.sampleRate <= 0 || !Number.isSafeInteger(result.channels) || result.channels < 1) throw new Error('E_WORKER_AUDIO_INIT'); GodotRuntime.setHeapValue(p_mix_rate, result.sampleRate, 'i32'); GodotOS.atexit(function (resolve, reject) { Promise.resolve(audio.close()).then(resolve, reject); }); return result.channels; }"
      ],
      [
        "\tgodot_audio_resume: function () {",
        "\tgodot_audio_resume: function () {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.resume(); return; }"
      ],
      [
        "\tgodot_audio_input_start: function () {",
        "\tgodot_audio_input_start: function () {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { return globalThis.__godotWorkerAudio.inputStart(); }"
      ],
      [
        "\tgodot_audio_input_stop: function () {",
        "\tgodot_audio_input_stop: function () {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.inputStop(); return; }"
      ],
      [
        "\tgodot_audio_sample_stream_is_registered: function (streamObjectIdStrPtr) {",
        "\tgodot_audio_sample_stream_is_registered: function (streamObjectIdStrPtr) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { return Number(globalThis.__godotWorkerAudio.sampleIsRegistered(GodotRuntime.parseString(streamObjectIdStrPtr))); }"
      ],
      [
        "\tgodot_audio_sample_register_stream: function (\n\t\tstreamObjectIdStrPtr,\n\t\tframesPtr,\n\t\tframesTotal,\n\t\tloopModeStrPtr,\n\t\tloopBegin,\n\t\tloopEnd\n\t) {",
        "\tgodot_audio_sample_register_stream: function (\n\t\tstreamObjectIdStrPtr,\n\t\tframesPtr,\n\t\tframesTotal,\n\t\tloopModeStrPtr,\n\t\tloopBegin,\n\t\tloopEnd\n\t) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleRegister(GodotRuntime.parseString(streamObjectIdStrPtr), HEAPF32.subarray(framesPtr >> 2, (framesPtr >> 2) + framesTotal * 2), framesTotal, GodotRuntime.parseString(loopModeStrPtr), loopBegin, loopEnd); return; }"
      ],
      [
        "\tgodot_audio_sample_unregister_stream: function (streamObjectIdStrPtr) {",
        "\tgodot_audio_sample_unregister_stream: function (streamObjectIdStrPtr) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleUnregister(GodotRuntime.parseString(streamObjectIdStrPtr)); return; }"
      ],
      [
        "\tgodot_audio_sample_start: function (\n\t\tplaybackObjectIdStrPtr,\n\t\tstreamObjectIdStrPtr,\n\t\tbusIndex,\n\t\toffset,\n\t\tpitchScale,\n\t\tvolumePtr\n\t) {",
        "\tgodot_audio_sample_start: function (\n\t\tplaybackObjectIdStrPtr,\n\t\tstreamObjectIdStrPtr,\n\t\tbusIndex,\n\t\toffset,\n\t\tpitchScale,\n\t\tvolumePtr\n\t) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleStart(GodotRuntime.parseString(playbackObjectIdStrPtr), GodotRuntime.parseString(streamObjectIdStrPtr), busIndex, offset, pitchScale, HEAPF32.subarray(volumePtr >> 2, (volumePtr >> 2) + 8)); return; }"
      ],
      [
        "\tgodot_audio_sample_stop: function (playbackObjectIdStrPtr) {",
        "\tgodot_audio_sample_stop: function (playbackObjectIdStrPtr) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleStop(GodotRuntime.parseString(playbackObjectIdStrPtr)); return; }"
      ],
      [
        "\tgodot_audio_sample_set_pause: function (playbackObjectIdStrPtr, pause) {",
        "\tgodot_audio_sample_set_pause: function (playbackObjectIdStrPtr, pause) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.samplePause(GodotRuntime.parseString(playbackObjectIdStrPtr), Boolean(pause)); return; }"
      ],
      [
        "\tgodot_audio_sample_is_active: function (playbackObjectIdStrPtr) {",
        "\tgodot_audio_sample_is_active: function (playbackObjectIdStrPtr) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { return Number(globalThis.__godotWorkerAudio.sampleIsActive(GodotRuntime.parseString(playbackObjectIdStrPtr))); }"
      ],
      [
        "\tgodot_audio_get_sample_playback_position: function (playbackObjectIdStrPtr) {",
        "\tgodot_audio_get_sample_playback_position: function (playbackObjectIdStrPtr) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { return globalThis.__godotWorkerAudio.samplePosition(GodotRuntime.parseString(playbackObjectIdStrPtr)); }"
      ],
      [
        "\tgodot_audio_sample_update_pitch_scale: function (\n\t\tplaybackObjectIdStrPtr,\n\t\tpitchScale\n\t) {",
        "\tgodot_audio_sample_update_pitch_scale: function (\n\t\tplaybackObjectIdStrPtr,\n\t\tpitchScale\n\t) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.samplePitch(GodotRuntime.parseString(playbackObjectIdStrPtr), pitchScale); return; }"
      ],
      [
        "\tgodot_audio_sample_set_volumes_linear: function (\n\t\tplaybackObjectIdStrPtr,\n\t\tbusesPtr,\n\t\tbusesSize,\n\t\tvolumesPtr,\n\t\tvolumesSize\n\t) {",
        "\tgodot_audio_sample_set_volumes_linear: function (\n\t\tplaybackObjectIdStrPtr,\n\t\tbusesPtr,\n\t\tbusesSize,\n\t\tvolumesPtr,\n\t\tvolumesSize\n\t) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleVolumes(GodotRuntime.parseString(playbackObjectIdStrPtr), Array.from(HEAP32.subarray(busesPtr >> 2, (busesPtr >> 2) + busesSize)), HEAPF32.subarray(volumesPtr >> 2, (volumesPtr >> 2) + volumesSize)); return; }"
      ],
      [
        "\tgodot_audio_sample_bus_set_count: function (count) {",
        "\tgodot_audio_sample_bus_set_count: function (count) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleBus('count', count); return; }"
      ],
      [
        "\tgodot_audio_sample_bus_remove: function (index) {",
        "\tgodot_audio_sample_bus_remove: function (index) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleBus('remove', index); return; }"
      ],
      [
        "\tgodot_audio_sample_bus_add: function (atPos) {",
        "\tgodot_audio_sample_bus_add: function (atPos) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleBus('add', atPos); return; }"
      ],
      [
        "\tgodot_audio_sample_bus_move: function (fromPos, toPos) {",
        "\tgodot_audio_sample_bus_move: function (fromPos, toPos) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleBus('move', fromPos, toPos); return; }"
      ],
      [
        "\tgodot_audio_sample_bus_set_send: function (bus, sendIndex) {",
        "\tgodot_audio_sample_bus_set_send: function (bus, sendIndex) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleBus('send', bus, sendIndex); return; }"
      ],
      [
        "\tgodot_audio_sample_bus_set_volume_db: function (bus, volumeDb) {",
        "\tgodot_audio_sample_bus_set_volume_db: function (bus, volumeDb) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleBus('volume', bus, volumeDb); return; }"
      ],
      [
        "\tgodot_audio_sample_bus_set_solo: function (bus, enable) {",
        "\tgodot_audio_sample_bus_set_solo: function (bus, enable) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleBus('solo', bus, Boolean(enable)); return; }"
      ],
      [
        "\tgodot_audio_sample_bus_set_mute: function (bus, enable) {",
        "\tgodot_audio_sample_bus_set_mute: function (bus, enable) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.sampleBus('mute', bus, Boolean(enable)); return; }"
      ],
      [
        "\tgodot_audio_sample_set_finished_callback: function (callbackPtr) {",
        "\tgodot_audio_sample_set_finished_callback: function (callbackPtr) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { const callback = GodotRuntime.get_func(callbackPtr); globalThis.__godotWorkerAudio.setFinishedCallback(function (id) { const ptr = GodotRuntime.allocString(id); try { callback(ptr); } finally { GodotRuntime.free(ptr); } }); return; }"
      ],
      [
        "\tgodot_audio_worklet_create: function (channels) {",
        "\tgodot_audio_worklet_create: function (channels) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.streamCreate(channels); return 0; }"
      ],
      [
        "\tgodot_audio_worklet_start_no_threads: function (\n\t\tp_out_buf,\n\t\tp_out_size,\n\t\tp_out_callback,\n\t\tp_in_buf,\n\t\tp_in_size,\n\t\tp_in_callback\n\t) {",
        "\tgodot_audio_worklet_start_no_threads: function (\n\t\tp_out_buf,\n\t\tp_out_size,\n\t\tp_out_callback,\n\t\tp_in_buf,\n\t\tp_in_size,\n\t\tp_in_callback\n\t) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { globalThis.__godotWorkerAudio.streamStart({ outPtr: p_out_buf, outSamples: p_out_size, inPtr: p_in_buf, inSamples: p_in_size, outCallback: GodotRuntime.get_func(p_out_callback), inCallback: GodotRuntime.get_func(p_in_callback), heap: function () { return HEAPF32; } }); return; }"
      ],
      [
        "\tgodot_audio_script_create: function (buffer_length, channel_count) {",
        "\tgodot_audio_script_create: function (buffer_length, channel_count) {\n\t\t// GODOTJS_WORKER_AUDIO_IMPORT_V1\n\t\tif (globalThis.__godotWorkerAudio) { throw new Error('E_WORKER_AUDIO_SCRIPT_PROCESSOR_UNSUPPORTED'); }"
      ]
    ]
  },
  "platform/web/audio_driver_web.cpp": {
    "sha256": "e73d98ad82ece2e1bfb6cb6e547f41bddaf075b80e81dc834ec5b8198afed6f7",
    "edits": [
      [
        "\tVector<AudioFrame> frames;\n\tint frames_total = mix_rate * length;",
        "\tVector<AudioFrame> frames;\n\t// GODOTJS_WORKER_SAMPLE_ADMISSION_V1: reject before native decode buffers.\n\tconst double frames_estimate = mix_rate * length;\n\tERR_FAIL_COND_MSG(!Math::is_finite(frames_estimate) || frames_estimate < 0 || frames_estimate > INT32_MAX / 2, \"Invalid sample decode size.\");\n\tconst int frames_total = int(frames_estimate);\n\tconst bool sample_cancelled = EM_ASM_INT({\n\t\tconst audio = globalThis.__godotWorkerAudio;\n\t\tif (!audio) return 0;\n\t\t// Revoked audio can still be called by the current native frame before quit.\n\t\tif (!audio.available()) return 1;\n\t\tif (!audio.samplePreflight($0, 2)) throw new Error('E_WORKER_SAMPLE_BUDGET');\n\t\treturn 0;\n\t}, frames_total);\n\tif (sample_cancelled) return;"
      ]
    ]
  },
  "platform/web/js/libs/library_godot_input.js": {
    "sha256": "bdf6ec2ff64820072c44de34fdf46683a1173ea037386059ce2946b02da29db3",
    "edits": [
      [
        "\t$GodotInputDragDrop: {\n\t\tpromises: [],\n\t\tpending_files: [],\n\n\t\tadd_entry: function (entry) {\n\t\t\tif (entry.isDirectory) {\n\t\t\t\tGodotInputDragDrop.add_dir(entry);\n\t\t\t} else if (entry.isFile) {\n\t\t\t\tGodotInputDragDrop.add_file(entry);\n\t\t\t} else {\n\t\t\t\tGodotRuntime.error('Unrecognized entry...', entry);\n\t\t\t}\n\t\t},\n\n\t\tadd_dir: function (entry) {\n\t\t\tGodotInputDragDrop.promises.push(new Promise(function (resolve, reject) {\n\t\t\t\tconst reader = entry.createReader();\n\t\t\t\treader.readEntries(function (entries) {\n\t\t\t\t\tfor (let i = 0; i < entries.length; i++) {\n\t\t\t\t\t\tGodotInputDragDrop.add_entry(entries[i]);\n\t\t\t\t\t}\n\t\t\t\t\tresolve();\n\t\t\t\t});\n\t\t\t}));\n\t\t},\n\n\t\tadd_file: function (entry) {\n\t\t\tGodotInputDragDrop.promises.push(new Promise(function (resolve, reject) {\n\t\t\t\tentry.file(function (file) {\n\t\t\t\t\tconst reader = new FileReader();\n\t\t\t\t\treader.onload = function () {\n\t\t\t\t\t\tconst f = {\n\t\t\t\t\t\t\t'path': file.relativePath || file.webkitRelativePath,\n\t\t\t\t\t\t\t'name': file.name,\n\t\t\t\t\t\t\t'type': file.type,\n\t\t\t\t\t\t\t'size': file.size,\n\t\t\t\t\t\t\t'data': reader.result,\n\t\t\t\t\t\t};\n\t\t\t\t\t\tif (!f['path']) {\n\t\t\t\t\t\t\tf['path'] = f['name'];\n\t\t\t\t\t\t}\n\t\t\t\t\t\tGodotInputDragDrop.pending_files.push(f);\n\t\t\t\t\t\tresolve();\n\t\t\t\t\t};\n\t\t\t\t\treader.onerror = function () {\n\t\t\t\t\t\tGodotRuntime.print('Error reading file');\n\t\t\t\t\t\treject();\n\t\t\t\t\t};\n\t\t\t\t\treader.readAsArrayBuffer(file);\n\t\t\t\t}, function (err) {\n\t\t\t\t\tGodotRuntime.print('Error!');\n\t\t\t\t\treject();\n\t\t\t\t});\n\t\t\t}));\n\t\t},\n\n\t\tprocess: function (resolve, reject) {\n\t\t\tif (GodotInputDragDrop.promises.length === 0) {\n\t\t\t\tresolve();\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tGodotInputDragDrop.promises.pop().then(function () {\n\t\t\t\tsetTimeout(function () {\n\t\t\t\t\tGodotInputDragDrop.process(resolve, reject);\n\t\t\t\t}, 0);\n\t\t\t});\n\t\t},\n\n\t\t_process_event: function (ev, callback) {\n\t\t\tev.preventDefault();\n\t\t\tif (ev.dataTransfer.items) {\n\t\t\t\t// Use DataTransferItemList interface to access the file(s)\n\t\t\t\tfor (let i = 0; i < ev.dataTransfer.items.length; i++) {\n\t\t\t\t\tconst item = ev.dataTransfer.items[i];\n\t\t\t\t\tlet entry = null;\n\t\t\t\t\tif ('getAsEntry' in item) {\n\t\t\t\t\t\tentry = item.getAsEntry();\n\t\t\t\t\t} else if ('webkitGetAsEntry' in item) {\n\t\t\t\t\t\tentry = item.webkitGetAsEntry();\n\t\t\t\t\t}\n\t\t\t\t\tif (entry) {\n\t\t\t\t\t\tGodotInputDragDrop.add_entry(entry);\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t} else {\n\t\t\t\tGodotRuntime.error('File upload not supported');\n\t\t\t}\n\t\t\tnew Promise(GodotInputDragDrop.process).then(function () {\n\t\t\t\tconst DROP = `/tmp/drop-${parseInt(Math.random() * (1 << 30), 10)}/`;\n\t\t\t\tconst drops = [];\n\t\t\t\tconst files = [];\n\t\t\t\tFS.mkdir(DROP.slice(0, -1)); // Without trailing slash\n\t\t\t\tGodotInputDragDrop.pending_files.forEach((elem) => {\n\t\t\t\t\tconst path = elem['path'];\n\t\t\t\t\tGodotFS.copy_to_fs(DROP + path, elem['data']);\n\t\t\t\t\tlet idx = path.indexOf('/');\n\t\t\t\t\tif (idx === -1) {\n\t\t\t\t\t\t// Root file\n\t\t\t\t\t\tdrops.push(DROP + path);\n\t\t\t\t\t} else {\n\t\t\t\t\t\t// Subdir\n\t\t\t\t\t\tconst sub = path.substr(0, idx);\n\t\t\t\t\t\tidx = sub.indexOf('/');\n\t\t\t\t\t\tif (idx < 0 && drops.indexOf(DROP + sub) === -1) {\n\t\t\t\t\t\t\tdrops.push(DROP + sub);\n\t\t\t\t\t\t}\n\t\t\t\t\t}\n\t\t\t\t\tfiles.push(DROP + path);\n\t\t\t\t});\n\t\t\t\tGodotInputDragDrop.promises = [];\n\t\t\t\tGodotInputDragDrop.pending_files = [];\n\t\t\t\tcallback(drops);\n\t\t\t\tif (GodotConfig.persistent_drops) {\n\t\t\t\t\t// Delay removal at exit.\n\t\t\t\t\tGodotOS.atexit(function (resolve, reject) {\n\t\t\t\t\t\tGodotInputDragDrop.remove_drop(files, DROP);\n\t\t\t\t\t\tresolve();\n\t\t\t\t\t});\n\t\t\t\t} else {\n\t\t\t\t\tGodotInputDragDrop.remove_drop(files, DROP);\n\t\t\t\t}\n\t\t\t});\n\t\t},\n\n\t\tremove_drop: function (files, drop_path) {\n\t\t\tconst dirs = [drop_path.substr(0, drop_path.length - 1)];\n\t\t\t// Remove temporary files\n\t\t\tfiles.forEach(function (file) {\n\t\t\t\tFS.unlink(file);\n\t\t\t\tlet dir = file.replace(drop_path, '');\n\t\t\t\tlet idx = dir.lastIndexOf('/');\n\t\t\t\twhile (idx > 0) {\n\t\t\t\t\tdir = dir.substr(0, idx);\n\t\t\t\t\tif (dirs.indexOf(drop_path + dir) === -1) {\n\t\t\t\t\t\tdirs.push(drop_path + dir);\n\t\t\t\t\t}\n\t\t\t\t\tidx = dir.lastIndexOf('/');\n\t\t\t\t}\n\t\t\t});\n\t\t\t// Remove dirs.\n\t\t\tdirs.sort(function (a, b) {\n\t\t\t\tconst al = (a.match(/\\//g) || []).length;\n\t\t\t\tconst bl = (b.match(/\\//g) || []).length;\n\t\t\t\tif (al > bl) {\n\t\t\t\t\treturn -1;\n\t\t\t\t} else if (al < bl) {\n\t\t\t\t\treturn 1;\n\t\t\t\t}\n\t\t\t\treturn 0;\n\t\t\t}).forEach(function (dir) {\n\t\t\t\tFS.rmdir(dir);\n\t\t\t});\n\t\t},\n\n\t\thandler: function (callback) {\n\t\t\treturn function (ev) {\n\t\t\t\tGodotInputDragDrop._process_event(ev, callback);\n\t\t\t};\n\t\t},\n\t},",
        "\t$GodotInputDragDrop: {\n\t\t// GODOTJS_WORKER_DROP_COMPLETION_V1: one owner until all reads settle.\n\t\tpromises: [],\n\t\tpending_files: [],\n\t\tdrop_error: null,\n\t\trunning: false,\n\t\tactive_event: null,\n\n\t\tassert_active: function () {\n\t\t\tconst event = GodotInputDragDrop.active_event;\n\t\t\tif (event && typeof event.godotDropIsActive === 'function' && !event.godotDropIsActive()) {\n\t\t\t\tconst error = new Error('E_WORKER_DROP_CANCELLED');\n\t\t\t\terror.name = 'AbortError';\n\t\t\t\tthrow error;\n\t\t\t}\n\t\t},\n\n\t\trecord_error: function (error) {\n\t\t\tif (!GodotInputDragDrop.drop_error) {\n\t\t\t\tGodotInputDragDrop.drop_error = error instanceof Error ? error : new Error(String(error || 'File drop failed'));\n\t\t\t}\n\t\t},\n\n\t\tadd_entry: function (entry) {\n\t\t\tGodotInputDragDrop.assert_active();\n\t\t\tif (entry.isDirectory) GodotInputDragDrop.add_dir(entry);\n\t\t\telse if (entry.isFile) GodotInputDragDrop.add_file(entry);\n\t\t\telse throw new Error('Unrecognized file drop entry');\n\t\t},\n\n\t\tadd_dir: function (entry) {\n\t\t\tconst pending = new Promise(function (resolve, reject) {\n\t\t\t\tconst reader = entry.createReader();\n\t\t\t\tconst read = function () {\n\t\t\t\t\ttry {\n\t\t\t\t\t\tGodotInputDragDrop.assert_active();\n\t\t\t\t\t\treader.readEntries(function (entries) {\n\t\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\t\tGodotInputDragDrop.assert_active();\n\t\t\t\t\t\t\t\tif (entries.length === 0) { resolve(); return; }\n\t\t\t\t\t\t\t\tentries.forEach(GodotInputDragDrop.add_entry);\n\t\t\t\t\t\t\t\tsetTimeout(read, 0);\n\t\t\t\t\t\t\t} catch (error) { reject(error); }\n\t\t\t\t\t\t}, reject);\n\t\t\t\t\t} catch (error) { reject(error); }\n\t\t\t\t};\n\t\t\t\tread();\n\t\t\t});\n\t\t\tGodotInputDragDrop.promises.push(pending.catch(GodotInputDragDrop.record_error));\n\t\t},\n\n\t\tadd_file: function (entry) {\n\t\t\tconst pending = new Promise(function (resolve, reject) {\n\t\t\t\tentry.file(function (file) {\n\t\t\t\t\ttry {\n\t\t\t\t\t\tGodotInputDragDrop.assert_active();\n\t\t\t\t\t\tconst reader = new FileReader();\n\t\t\t\t\t\treader.onload = function () {\n\t\t\t\t\t\t\ttry {\n\t\t\t\t\t\t\t\tGodotInputDragDrop.assert_active();\n\t\t\t\t\t\t\t\tGodotInputDragDrop.pending_files.push({ path: file.relativePath || file.webkitRelativePath || file.name, name: file.name, type: file.type, size: file.size, data: reader.result });\n\t\t\t\t\t\t\t\tresolve();\n\t\t\t\t\t\t\t} catch (error) { reject(error); }\n\t\t\t\t\t\t};\n\t\t\t\t\t\treader.onerror = function () { reject(reader.error || new Error('Error reading dropped file')); };\n\t\t\t\t\t\treader.onabort = function () { reject(new Error('Dropped file read aborted')); };\n\t\t\t\t\t\treader.readAsArrayBuffer(file);\n\t\t\t\t\t} catch (error) { reject(error); }\n\t\t\t\t}, reject);\n\t\t\t});\n\t\t\tGodotInputDragDrop.promises.push(pending.catch(GodotInputDragDrop.record_error));\n\t\t},\n\n\t\tprocess: function (resolve, reject) {\n\t\t\ttry { GodotInputDragDrop.assert_active(); }\n\t\t\tcatch (error) { GodotInputDragDrop.record_error(error); }\n\t\t\tif (GodotInputDragDrop.promises.length === 0) {\n\t\t\t\tif (GodotInputDragDrop.drop_error) reject(GodotInputDragDrop.drop_error);\n\t\t\t\telse resolve();\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tGodotInputDragDrop.promises.pop().then(function () {\n\t\t\t\tsetTimeout(function () { GodotInputDragDrop.process(resolve, reject); }, 0);\n\t\t\t}, function (error) {\n\t\t\t\tGodotInputDragDrop.record_error(error);\n\t\t\t\tsetTimeout(function () { GodotInputDragDrop.process(resolve, reject); }, 0);\n\t\t\t});\n\t\t},\n\n\t\t_process_event: function (ev, callback) {\n\t\t\tev.preventDefault();\n\t\t\tif (GodotInputDragDrop.running) {\n\t\t\t\tconst error = new Error('E_WORKER_DROP_BUSY');\n\t\t\t\tif (typeof ev.godotDropComplete === 'function') ev.godotDropComplete(error);\n\t\t\t\telse GodotRuntime.error(error);\n\t\t\t\treturn Promise.resolve();\n\t\t\t}\n\t\t\tGodotInputDragDrop.running = true;\n\t\t\tGodotInputDragDrop.drop_error = null;\n\t\t\tGodotInputDragDrop.active_event = ev;\n\t\t\tconst files = [];\n\t\t\tlet drop = null;\n\t\t\tlet owned = false;\n\t\t\ttry {\n\t\t\t\tif (!ev.dataTransfer || !ev.dataTransfer.items) throw new Error('File upload not supported');\n\t\t\t\tfor (const item of ev.dataTransfer.items) {\n\t\t\t\t\tconst entry = 'getAsEntry' in item ? item.getAsEntry() : 'webkitGetAsEntry' in item ? item.webkitGetAsEntry() : null;\n\t\t\t\t\tif (entry) GodotInputDragDrop.add_entry(entry);\n\t\t\t\t}\n\t\t\t} catch (error) { GodotInputDragDrop.record_error(error); }\n\t\t\treturn new Promise(GodotInputDragDrop.process).then(function () {\n\t\t\t\tGodotInputDragDrop.assert_active();\n\t\t\t\tdrop = `/tmp/drop-${parseInt(Math.random() * (1 << 30), 10)}/`;\n\t\t\t\tconst drops = [];\n\t\t\t\tFS.mkdir(drop.slice(0, -1));\n\t\t\t\towned = true;\n\t\t\t\tGodotInputDragDrop.pending_files.forEach(function (file) {\n\t\t\t\t\tGodotInputDragDrop.assert_active();\n\t\t\t\t\tconst path = file.path;\n\t\t\t\t\tfiles.push(drop + path);\n\t\t\t\t\tGodotFS.copy_to_fs(drop + path, file.data);\n\t\t\t\t\tconst slash = path.indexOf('/');\n\t\t\t\t\tconst root = drop + (slash === -1 ? path : path.slice(0, slash));\n\t\t\t\t\tif (drops.indexOf(root) === -1) drops.push(root);\n\t\t\t\t});\n\t\t\t\tGodotInputDragDrop.assert_active();\n\t\t\t\tcallback(drops);\n\t\t\t\tif (GodotConfig.persistent_drops) {\n\t\t\t\t\tconst path = drop;\n\t\t\t\t\tGodotOS.atexit(function (resolve, reject) {\n\t\t\t\t\t\ttry { GodotInputDragDrop.remove_drop(files, path); resolve(); }\n\t\t\t\t\t\tcatch (error) { reject(error); }\n\t\t\t\t\t});\n\t\t\t\t} else GodotInputDragDrop.remove_drop(files, drop);\n\t\t\t\towned = false;\n\t\t\t}).catch(function (error) {\n\t\t\t\tGodotInputDragDrop.record_error(error);\n\t\t\t\tif (owned) {\n\t\t\t\t\ttry { GodotInputDragDrop.remove_drop(files, drop); }\n\t\t\t\t\tcatch (cleanup_error) {\n\t\t\t\t\t\tconst original = GodotInputDragDrop.drop_error;\n\t\t\t\t\t\tGodotInputDragDrop.drop_error = new AggregateError([original, cleanup_error], `${original.message}; file drop cleanup failed: ${cleanup_error.message}`);\n\t\t\t\t\t}\n\t\t\t\t}\n\t\t\t}).finally(function () {\n\t\t\t\tconst error = GodotInputDragDrop.drop_error;\n\t\t\t\tGodotInputDragDrop.promises = [];\n\t\t\t\tGodotInputDragDrop.pending_files = [];\n\t\t\t\tGodotInputDragDrop.drop_error = null;\n\t\t\t\tGodotInputDragDrop.running = false;\n\t\t\t\tGodotInputDragDrop.active_event = null;\n\t\t\t\tif (typeof ev.godotDropComplete === 'function') ev.godotDropComplete(error || undefined);\n\t\t\t\telse if (error) GodotRuntime.error(error);\n\t\t\t});\n\t\t},\n\n\t\tremove_drop: function (files, path) {\n\t\t\tconst dirs = [path.slice(0, -1)];\n\t\t\tlet error = null;\n\t\t\tfiles.forEach(function (file) {\n\t\t\t\ttry { FS.unlink(file); } catch (failure) { if (failure.errno !== GodotFS.ENOENT && !error) error = failure; }\n\t\t\t\tlet dir = file.slice(path.length);\n\t\t\t\tlet slash = dir.lastIndexOf('/');\n\t\t\t\twhile (slash > 0) {\n\t\t\t\t\tdir = dir.slice(0, slash);\n\t\t\t\t\tif (dirs.indexOf(path + dir) === -1) dirs.push(path + dir);\n\t\t\t\t\tslash = dir.lastIndexOf('/');\n\t\t\t\t}\n\t\t\t});\n\t\t\tdirs.sort(function (a, b) { return b.split('/').length - a.split('/').length; }).forEach(function (dir) {\n\t\t\t\ttry { FS.rmdir(dir); } catch (failure) { if (failure.errno !== GodotFS.ENOENT && !error) error = failure; }\n\t\t\t});\n\t\t\tif (error) throw error;\n\t\t},\n\n\t\thandler: function (callback) {\n\t\t\treturn function (ev) { return GodotInputDragDrop._process_event(ev, callback); };\n\t\t},\n\t},\n"
      ]
    ]
  },
  "servers/audio/audio_server.cpp": {
    "sha256": "d1b2e1c2cc909035f836d7446b07190788e8f41e4a4d59218be50f9a4096fe22",
    "edits": [
      [
        "\tfor (int i = 0; i < AudioDriverManager::get_driver_count(); i++) {\n\t\tAudioDriverManager::get_driver(i)->finish();\n\t}\n\n\tfor (int i = 0; i < buses.size(); i++) {",
        "\tfor (int i = 0; i < AudioDriverManager::get_driver_count(); i++) {\n\t\tAudioDriverManager::get_driver(i)->finish();\n\t}\n\n#if defined(WEB_ENABLED) && !defined(THREADS_ENABLED)\n\t// GODOTJS_THREADLESS_AUDIO_SHUTDOWN_V1: no mixer can retire a final fade after Web audio closes.\n\t// Main::cleanup has already finished script languages; do not call user playback virtuals here.\n\t// The vector still owns each sample while its playback/sample Ref cycle is detached.\n\tfor (const Ref<AudioSamplePlayback> &sample : sample_playback_list) {\n\t\tif (sample.is_valid() && sample->stream_playback.is_valid()) {\n\t\t\tsample->stream_playback->set_sample_playback(nullptr);\n\t\t}\n\t}\n\tsample_playback_list.clear();\n\t{\n\t\tfor (AudioStreamPlaybackListNode *playback : playback_list) {\n\t\t\tplayback->state.store(AudioStreamPlaybackListNode::AWAITING_DELETION);\n\t\t\t_delete_stream_playback_list_node(playback);\n\t\t}\n\t}\n\t// SafeList deletions run only after the range iterators have left scope.\n\tplayback_list.maybe_cleanup();\n\t{\n\t\tfor (AudioStreamPlaybackBusDetails *details : bus_details_graveyard) {\n\t\t\tbus_details_graveyard.erase(details, [](AudioStreamPlaybackBusDetails *p) { delete p; });\n\t\t}\n\t}\n\tbus_details_graveyard.maybe_cleanup();\n\t{\n\t\tfor (AudioStreamPlaybackBusDetails *details : bus_details_graveyard_frame_old) {\n\t\t\tbus_details_graveyard_frame_old.erase(details, [](AudioStreamPlaybackBusDetails *p) { delete p; });\n\t\t}\n\t}\n\tbus_details_graveyard_frame_old.maybe_cleanup();\n#endif\n\n\tfor (int i = 0; i < buses.size(); i++) {"
      ]
    ]
  },
  "modules/webrtc/library_godot_webrtc.js": {
    "sha256": "c9321eb9398917f689f6a07b5265ca3b8b392e5080b81a6edd89d6084c948a6e",
    "edits": [
      [
        "\t\t\tconn.ondatachannel = null;\n\t\t\tIDHandler.remove(p_id);",
        "\t\t\tconn.ondatachannel = null;\n\t\t\t// GODOTJS_WORKER_RTC_DESTROY_V1: broker handles require explicit retirement.\n\t\t\ttry {\n\t\t\t\tif (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {\n\t\t\t\t\tconn.close();\n\t\t\t\t}\n\t\t\t} finally {\n\t\t\t\tIDHandler.remove(p_id);\n\t\t\t}"
      ],
      [
        "\t\t// Callbacks\n\t\tcreate: function",
        "\t\t// GODOTJS_WORKER_RTC_LIFETIME_V1: do not reuse old native userdata after close/reinitialize.\n\t\tis_current: function (p_id, p_connection) {\n\t\t\tconst worker = typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope;\n\t\t\treturn !worker || (IDHandler.get(p_id) === p_connection && p_connection.signalingState !== 'closed');\n\t\t},\n\n\t\t// Callbacks\n\t\tcreate: function"
      ],
      [
        "\tgodot_js_rtc_pc_offer_create: function (p_id, p_obj, p_on_session, p_on_error) {\n\t\tconst ref = IDHandler.get(p_id);\n\t\tif (!ref) {\n\t\t\treturn;\n\t\t}\n\t\tconst onsession = GodotRuntime.get_func(p_on_session).bind(null, p_obj);\n\t\tconst onerror = GodotRuntime.get_func(p_on_error).bind(null, p_obj);\n\t\tref.createOffer().then(function (session) {\n\t\t\tGodotRTCPeerConnection.onsession(p_id, onsession, session);\n\t\t}).catch(function (error) {\n\t\t\tGodotRTCPeerConnection.onerror(p_id, onerror, error);\n\t\t});\n\t},\n",
        "\tgodot_js_rtc_pc_offer_create: function (p_id, p_obj, p_on_session, p_on_error) {\n\t\tconst ref = IDHandler.get(p_id);\n\t\tif (!ref) {\n\t\t\treturn;\n\t\t}\n\t\tconst onsession = GodotRuntime.get_func(p_on_session).bind(null, p_obj);\n\t\tconst onerror = GodotRuntime.get_func(p_on_error).bind(null, p_obj);\n\t\tref.createOffer().then(function (session) {\n\t\t\tif (!GodotRTCPeerConnection.is_current(p_id, ref)) return;\n\t\t\tGodotRTCPeerConnection.onsession(p_id, onsession, session);\n\t\t}).catch(function (error) {\n\t\t\tif (!GodotRTCPeerConnection.is_current(p_id, ref)) return;\n\t\t\tGodotRTCPeerConnection.onerror(p_id, onerror, error);\n\t\t});\n\t},\n"
      ],
      [
        "\tgodot_js_rtc_pc_local_description_set: function (p_id, p_type, p_sdp, p_obj, p_on_error) {\n\t\tconst ref = IDHandler.get(p_id);\n\t\tif (!ref) {\n\t\t\treturn;\n\t\t}\n\t\tconst type = GodotRuntime.parseString(p_type);\n\t\tconst sdp = GodotRuntime.parseString(p_sdp);\n\t\tconst onerror = GodotRuntime.get_func(p_on_error).bind(null, p_obj);\n\t\tref.setLocalDescription({\n\t\t\t'sdp': sdp,\n\t\t\t'type': type,\n\t\t}).catch(function (error) {\n\t\t\tGodotRTCPeerConnection.onerror(p_id, onerror, error);\n\t\t});\n\t},\n",
        "\tgodot_js_rtc_pc_local_description_set: function (p_id, p_type, p_sdp, p_obj, p_on_error) {\n\t\tconst ref = IDHandler.get(p_id);\n\t\tif (!ref) {\n\t\t\treturn;\n\t\t}\n\t\tconst type = GodotRuntime.parseString(p_type);\n\t\tconst sdp = GodotRuntime.parseString(p_sdp);\n\t\tconst onerror = GodotRuntime.get_func(p_on_error).bind(null, p_obj);\n\t\tref.setLocalDescription({\n\t\t\t'sdp': sdp,\n\t\t\t'type': type,\n\t\t}).catch(function (error) {\n\t\t\tif (!GodotRTCPeerConnection.is_current(p_id, ref)) return;\n\t\t\tGodotRTCPeerConnection.onerror(p_id, onerror, error);\n\t\t});\n\t},\n"
      ],
      [
        "\tgodot_js_rtc_pc_remote_description_set: function (p_id, p_type, p_sdp, p_obj, p_session_created, p_on_error) {\n\t\tconst ref = IDHandler.get(p_id);\n\t\tif (!ref) {\n\t\t\treturn;\n\t\t}\n\t\tconst type = GodotRuntime.parseString(p_type);\n\t\tconst sdp = GodotRuntime.parseString(p_sdp);\n\t\tconst onerror = GodotRuntime.get_func(p_on_error).bind(null, p_obj);\n\t\tconst onsession = GodotRuntime.get_func(p_session_created).bind(null, p_obj);\n\t\tref.setRemoteDescription({\n\t\t\t'sdp': sdp,\n\t\t\t'type': type,\n\t\t}).then(function () {\n\t\t\tif (type !== 'offer') {\n\t\t\t\treturn Promise.resolve();\n\t\t\t}\n\t\t\treturn ref.createAnswer().then(function (session) {\n\t\t\t\tGodotRTCPeerConnection.onsession(p_id, onsession, session);\n\t\t\t});\n\t\t}).catch(function (error) {\n\t\t\tGodotRTCPeerConnection.onerror(p_id, onerror, error);\n\t\t});\n\t},\n",
        "\tgodot_js_rtc_pc_remote_description_set: function (p_id, p_type, p_sdp, p_obj, p_session_created, p_on_error) {\n\t\tconst ref = IDHandler.get(p_id);\n\t\tif (!ref) {\n\t\t\treturn;\n\t\t}\n\t\tconst type = GodotRuntime.parseString(p_type);\n\t\tconst sdp = GodotRuntime.parseString(p_sdp);\n\t\tconst onerror = GodotRuntime.get_func(p_on_error).bind(null, p_obj);\n\t\tconst onsession = GodotRuntime.get_func(p_session_created).bind(null, p_obj);\n\t\tref.setRemoteDescription({\n\t\t\t'sdp': sdp,\n\t\t\t'type': type,\n\t\t}).then(function () {\n\t\t\tif (!GodotRTCPeerConnection.is_current(p_id, ref)) return;\n\t\t\tif (type !== 'offer') {\n\t\t\t\treturn Promise.resolve();\n\t\t\t}\n\t\t\treturn ref.createAnswer().then(function (session) {\n\t\t\t\tif (!GodotRTCPeerConnection.is_current(p_id, ref)) return;\n\t\t\t\tGodotRTCPeerConnection.onsession(p_id, onsession, session);\n\t\t\t});\n\t\t}).catch(function (error) {\n\t\t\tif (!GodotRTCPeerConnection.is_current(p_id, ref)) return;\n\t\t\tGodotRTCPeerConnection.onerror(p_id, onerror, error);\n\t\t});\n\t},\n"
      ],
      [
        "\tgodot_js_rtc_pc_ice_candidate_add: function (p_id, p_mid_name, p_mline_idx, p_sdp) {\n\t\tconst ref = IDHandler.get(p_id);\n\t\tif (!ref) {\n\t\t\treturn;\n\t\t}\n\t\tconst sdpMidName = GodotRuntime.parseString(p_mid_name);\n\t\tconst sdpName = GodotRuntime.parseString(p_sdp);\n\t\tref.addIceCandidate(new RTCIceCandidate({\n\t\t\t'candidate': sdpName,\n\t\t\t'sdpMid': sdpMidName,\n\t\t\t'sdpMlineIndex': p_mline_idx,\n\t\t}));\n\t},\n",
        "\tgodot_js_rtc_pc_ice_candidate_add: function (p_id, p_mid_name, p_mline_idx, p_sdp) {\n\t\tconst ref = IDHandler.get(p_id);\n\t\tif (!ref) {\n\t\t\treturn;\n\t\t}\n\t\tconst sdpMidName = GodotRuntime.parseString(p_mid_name);\n\t\tconst sdpName = GodotRuntime.parseString(p_sdp);\n\t\tconst pending = ref.addIceCandidate(new RTCIceCandidate({\n\t\t\t'candidate': sdpName,\n\t\t\t'sdpMid': sdpMidName,\n\t\t\t'sdpMlineIndex': p_mline_idx,\n\t\t}));\n\t\tif (typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {\n\t\t\t// Retire late close rejections; active errors retain their original rejected-Promise behavior.\n\t\t\tpending.catch(function (error) {\n\t\t\t\tif (GodotRTCPeerConnection.is_current(p_id, ref)) throw error;\n\t\t\t});\n\t\t}\n\t},\n"
      ]
    ]
  }
};
export const WORKER_RUNTIME_PATHS=Object.freeze([...Object.keys(layouts),WORKER_XR_PATH]);
const hash=source=>createHash('sha256').update(source).digest('hex');
const count=(source,text)=>source.split(text).length-1;
export function patchWorkerRuntimeFile(path,source){
 if(path===WORKER_XR_PATH){
  if(hash(readFileSync(new URL('./patch-web-worker-xr.mjs',import.meta.url)))!==XR_IMPLEMENTATION_SHA256)throw Error('E_WORKER_XR_IMPLEMENTATION_DRIFT');
  return {...patchWorkerXR(source),patchId:WORKER_RUNTIME_PATCH};
 }
 const layout=layouts[path];if(!layout||typeof source!=='string')throw Error('E_WORKER_RUNTIME_PATCH_UNSUPPORTED: '+path);
 let original=source;
 if(hash(source)!==layout.sha256){
  for(const [before,after]of [...layout.edits].reverse()){if(count(original,after)!==1)throw Error('E_WORKER_RUNTIME_PATCH_UNSUPPORTED: changed or partial '+path);original=original.replace(after,before);}
  if(hash(original)!==layout.sha256)throw Error('E_WORKER_RUNTIME_PATCH_UNSUPPORTED: modified '+path);
  return {code:source,changed:false,patchId:WORKER_RUNTIME_PATCH};
 }
 let code=source;for(const [before,after]of layout.edits){if(count(code,before)!==1)throw Error('E_WORKER_RUNTIME_PATCH_UNSUPPORTED: anchor '+path);code=code.replace(before,after);}
 return {code,changed:true,patchId:WORKER_RUNTIME_PATCH};
}
export function workerRuntimeBuildProof(patches){
 const records=patches.filter(record=>record.patchId===WORKER_RUNTIME_PATCH);
 if(records.length!==WORKER_RUNTIME_PATHS.length)throw Error('E_WORKER_RUNTIME_PROOF: incomplete patched source set');
 const files={};let implementation;for(const path of WORKER_RUNTIME_PATHS){const found=records.filter(record=>record.path===path);if(found.length!==1||!(/^[a-f0-9]{64}$/).test(found[0].afterSha256)||!found[0].implementation?.sha256)throw Error('E_WORKER_RUNTIME_PROOF: '+path);files[path]=found[0].afterSha256;implementation=found[0].implementation;}
 return {runtimeAbi:{...WORKER_RUNTIME_ABI},workerPatch:{patchId:WORKER_RUNTIME_PATCH,version:1,implementation,files}};
}
