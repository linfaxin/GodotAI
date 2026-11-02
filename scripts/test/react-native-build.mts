import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { basename, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const moduleRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const args = process.argv.slice(2);
function option(name: string, fallback?: string) {
    const index = args.indexOf(name);
    if (index >= 0) {
        const value = args[index + 1];
        if (!value || value.startsWith("--")) throw new Error(`Missing value for ${name}`);
        return value;
    }
    return fallback;
}
const engine = option("--engine", "qjs");
if (engine !== "qjs" && engine !== "v8") throw new Error("--engine must be qjs or v8");
const godotSource = option("--godot-source", process.env.GODOT_SOURCE);
const buildRoot = option("--out");
if (!godotSource || !buildRoot) {
    throw new Error("Usage: node scripts/test/react-native-build.mts --godot-source <Godot source/cache> --out <independent build tree> [--engine qjs|v8] [--scons <path>] [--deps <directory>] [--sync-only]");
}
const sourceRoot = resolve(godotSource);
const destination = resolve(buildRoot);
if (sourceRoot === destination || destination === moduleRoot || moduleRoot.startsWith(`${destination}/`) || destination.startsWith(`${moduleRoot}/`) || destination.startsWith(`${sourceRoot}/`)) {
    throw new Error("The build output must be an independent directory, not the source workspace");
}
if (!existsSync(join(sourceRoot, "SConstruct"))) throw new Error("Godot source has no SConstruct");
mkdirSync(destination, { recursive: true });
if (!existsSync(join(destination, "SConstruct"))) {
    cpSync(sourceRoot, destination, { recursive: true, preserveTimestamps: true, dereference: false });
}
const destinationModule = join(destination, "modules/GodotJS");
// The SDK may contain per-directory symlinks to the working module. Do not compile
// through them: SCons would write object files into the developer's checkout.
rmSync(destinationModule, { recursive: true, force: true });
const excluded = new Set([".git", "node_modules", ".godot", "__pycache__"]);
const copyFilter = (source: string) => !excluded.has(basename(source)) && !/\.(?:o|os|obj|pdb|ilk)$/.test(source);
cpSync(moduleRoot, destinationModule, {
    recursive: true,
    preserveTimestamps: true,
    dereference: false,
    filter: copyFilter,
});
const testJs = join(moduleRoot, "tests/project/.godot/GodotJS");
if (existsSync(testJs)) {
    cpSync(testJs, join(destinationModule, "tests/project/.godot/GodotJS"), {
        recursive: true, preserveTimestamps: true,
    });
}
const dependencies = option("--deps");
if (dependencies) {
    for (const name of ["v8", "lws"]) {
        const path = join(resolve(dependencies), name);
        if (existsSync(path)) cpSync(path, join(destinationModule, name), { recursive: true, preserveTimestamps: true });
    }
}

function sourceFiles(directory: string): string[] {
    const result: string[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (excluded.has(entry.name)) continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) result.push(...sourceFiles(path));
        else if (entry.isFile() && !/\.(?:o|os|obj|a|pdb|ilk)$/.test(path)) result.push(path);
    }
    return result;
}
const nativeRoots = ["bridge", "compat", "impl", "internal", "weaver", "weaver-editor", "tests", "quickjs", "quickjs-ng"];
function scopedFontconfig() {
    const version = readFileSync(join(destination, "version.py"), "utf8");
    for (const [field, expected] of [["major", "4"], ["minor", "6"], ["patch", "1"]]) {
        if (!new RegExp(`^${field}\\s*=\\s*${expected}\\s*$`, "m").test(version)) throw new Error("The scoped fontconfig recipe is certified only for Godot 4.6.1");
    }
    const macroUsers: string[] = [], headerIncluders: string[] = [];
    for (const file of sourceFiles(destination).filter(file => /\.(?:cpp|c|cc|cxx|h|hpp|hxx|inc)$/.test(file))) {
        const content = readFileSync(file, "utf8"), path = relative(destination, file).replaceAll("\\", "/");
        if (/\bFONTCONFIG_ENABLED\b/.test(content)) macroUsers.push(path);
        if (/^\s*#\s*include\s*[<"](?:[^>"\n]*\/)?os_linuxbsd\.h[>"]/m.test(content)) headerIncluders.push(path);
    }
    const expectedMacroUsers = ["platform/linuxbsd/os_linuxbsd.cpp", "platform/linuxbsd/os_linuxbsd.h"];
    const expectedIncluders = ["platform/linuxbsd/godot_linuxbsd.cpp", "platform/linuxbsd/libgodot_linuxbsd.cpp", "platform/linuxbsd/os_linuxbsd.cpp"];
    if (JSON.stringify(macroUsers.sort()) !== JSON.stringify(expectedMacroUsers) || JSON.stringify(headerIncluders.sort()) !== JSON.stringify(expectedIncluders)) {
        throw new Error(`Fontconfig scope changed; refusing a potentially inconsistent class layout: ${JSON.stringify({macroUsers, headerIncluders})}`);
    }
    const digest = (value: string) => createHash("sha256").update(value).digest("hex");
    const statePath = join(destination, ".godotjs-react-build-recipe.json");
    const state = existsSync(statePath) ? JSON.parse(readFileSync(statePath, "utf8")) : undefined;
    const marker = "# GodotJS scoped fontconfig build recipe v1";
    const changes = [
        { path: "platform/linuxbsd/detect.py", find: 'env.Append(CPPDEFINES=["FONTCONFIG_ENABLED"])', replace: 'env["godotjs_scoped_fontconfig"] = True', count: 2 },
        { path: "platform/linuxbsd/SCsub", find: 'Import("env")', replace: `Import("env")\n\n${marker}\nif env.get("godotjs_scoped_fontconfig", False):\n    env = env.Clone()\n    env.AppendUnique(CPPDEFINES=["FONTCONFIG_ENABLED"])`, count: 1 },
    ];
    const patches = changes.map(change => {
        const file = join(destination, change.path), current = readFileSync(file, "utf8");
        const previous = state?.patches?.find((entry: {path: string}) => entry.path === change.path);
        if (previous) {
            if (current !== previous.after || digest(previous.before) !== previous.originalSha256 || digest(current) !== previous.patchedSha256) throw new Error(`Previously scoped Godot recipe was edited: ${change.path}`);
            return previous;
        }
        if (current.includes(marker) || current.includes("godotjs_scoped_fontconfig")) throw new Error(`Unowned Godot recipe modification: ${change.path}`);
        if (current.split(change.find).length - 1 !== change.count) throw new Error(`Godot 4.6.1 build recipe changed: ${change.path}`);
        const after = current.replaceAll(change.find, change.replace);
        return { ...change, before: current, after, originalSha256: digest(current), patchedSha256: digest(after) };
    });
    for (const patch of patches) writeFileSync(join(destination, patch.path), patch.after);
    const result = { kind: "godotjs-scoped-fontconfig-v1", originalGodotVersion: "4.6.1.stable", versionFileSha256: digest(version), macroUsers, headerIncluders, patches };
    writeFileSync(statePath, JSON.stringify(result, null, 2) + "\n");
    return result;
}
const godotBuildRecipe = scopedFontconfig();
const godotBuildRecipeSha256 = createHash("sha256").update(JSON.stringify(godotBuildRecipe)).digest("hex");
const inputPaths = ["SCsub", "config.py", "register_types.cpp", "register_types.h", "jsb.config.h", "jsb.h"]
    .map(path => join(destinationModule, path))
    .filter(existsSync);
for (const root of nativeRoots) {
    const directory = join(destinationModule, root);
    if (existsSync(directory)) inputPaths.push(...sourceFiles(directory).filter(path => /\.(?:h|hpp|cpp|c|py)$/.test(path)));
}
const hashes = Object.fromEntries(inputPaths.sort().map(path => [
    relative(destinationModule, path), createHash("sha256").update(readFileSync(path)).digest("hex"),
]));
const sourceSnapshotHash = createHash("sha256").update(JSON.stringify(hashes)).digest("hex");
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: moduleRoot, encoding: "utf8" });
const flags = [
    "platform=linuxbsd", "target=editor", "arch=x86_64", "optimize=none", "debug_symbols=no", "lto=none", "tests=yes",
    "skip_js_runtime=yes", "modules_enabled_by_default=no", "module_GodotJS_enabled=yes", "module_gdscript_enabled=yes",
    "module_regex_enabled=yes", "module_freetype_enabled=yes", "module_text_server_fb_enabled=yes", "module_svg_enabled=yes",
    "module_multiplayer_enabled=yes", "module_enet_enabled=yes", "module_godot_physics_2d_enabled=yes", "module_godot_physics_3d_enabled=yes",
    "vulkan=no", "opengl3=no", "x11=no", "wayland=no", "alsa=no", "pulseaudio=no", "dbus=no", "speechd=no", "accesskit=no", "fontconfig=yes", "use_sowrap=yes", "use_static_cpp=yes",
    `use_quickjs_ng=${engine === "qjs" ? "yes" : "no"}`,
    `-j${option("--jobs", "4")}`,
];
const reportPath = join(destination, "react-native-build.json");
const report: Record<string, unknown> = {
    schemaVersion: 1, status: "snapshotted", sourceCommit: git.stdout.trim(), sourceSnapshotHash,
    sourceModule: moduleRoot, snapshotModule: destinationModule, godotSource: sourceRoot,
    engine, flags, inputs: hashes, godotBuildRecipe, godotBuildRecipeSha256,
};
writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
if (args.includes("--sync-only")) {
    console.log(JSON.stringify({ status: report.status, sourceSnapshotHash, reportPath }));
} else {
    const scons = option("--scons", "scons")!;
    const result = spawnSync(scons, flags, { cwd: destination, stdio: "inherit", shell: false });
    const binary = join(destination, "bin/godot.linuxbsd.editor.x86_64");
    report.status = result.status === 0 ? "built" : "failed";
    report.exitCode = result.status;
    report.error = result.error?.message;
    if (result.status === 0) {
        if (!existsSync(binary)) throw new Error("SCons succeeded without producing a Godot binary");
        report.binary = binary;
        report.binaryBytes = statSync(binary).size;
        report.binarySha256 = createHash("sha256").update(readFileSync(binary)).digest("hex");
    }
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
    if (result.status !== 0) process.exit(result.status ?? 1);
    console.log(JSON.stringify({ status: report.status, binary, sourceSnapshotHash, reportPath }));
}
