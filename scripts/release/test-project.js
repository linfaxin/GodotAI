import { execSync } from "child_process";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const rootPath = join(__dirname, "../../../..");
// Use the local Godot build unless the caller supplies a binary path.
const defaultBin =
    process.platform === "win32"
        ? join(rootPath, "bin/godot.windows.editor.dev.x86_64.console.exe")
        : join(rootPath, "bin/godot.linuxbsd.editor.x86_64");
const bin = process.argv[2] || defaultBin;

const projectPath = join(__dirname, "../../tests/project");

try {
    const generateTypes = execSync(`${bin} --headless --editor --generate-types --path ${projectPath}`, {
        encoding: "utf-8",
    });
    console.log(generateTypes);
    const output = execSync(`${bin} --audio-driver Dummy --headless --path ${projectPath}`, {
        encoding: "utf-8",
    });
    console.log(output);
    if (output.toLowerCase().includes("error")) {
        process.exit(1);
    }
} catch (error) {
    console.error(error.stdout || error.message);
    process.exit(1);
}
