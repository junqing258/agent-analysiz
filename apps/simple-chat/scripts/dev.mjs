import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = resolve(appRoot, "dist/index.js");
const forwardedArgs = process.argv.slice(2).filter((arg, index) => !(index === 0 && arg === "--"));
let app;
let compilerExited = false;

const compiler = spawn("tsc", ["-b", "--watch", "--preserveWatchOutput"], {
  cwd: appRoot,
  stdio: ["ignore", "pipe", "pipe"]
});

const relayCompilerOutput = (chunk, output) => {
  const text = String(chunk);
  output.write(text);
  if (text.includes("Found 0 errors") && existsSync(entry)) restartApp();
};
compiler.stdout.on("data", (chunk) => relayCompilerOutput(chunk, process.stdout));
compiler.stderr.on("data", (chunk) => relayCompilerOutput(chunk, process.stderr));
compiler.on("exit", (code) => {
  compilerExited = true;
  if (!stopping) {
    process.exitCode = code ?? 1;
    stopApp();
  }
});

let stopping = false;
let restarting = false;
function startApp() {
  console.log("\n[dev] Starting simple-chat. Source changes will recompile and restart it.\n");
  app = spawn("node", [entry, ...forwardedArgs], { cwd: appRoot, stdio: "inherit" });
  app.on("exit", (code) => {
    const shouldRestart = restarting;
    app = undefined;
    if (shouldRestart) { restarting = false; startApp(); return; }
    if (!stopping && code && code !== 0) console.error(`[dev] simple-chat exited with code ${code}; waiting for source changes.`);
  });
}
function restartApp() {
  if (!app) { startApp(); return; }
  restarting = true;
  stopApp();
}
function stopApp() {
  if (app && !app.killed) app.kill("SIGTERM");
}
function stop() {
  if (stopping) return;
  stopping = true;
  stopApp();
  if (!compilerExited) compiler.kill("SIGTERM");
  setTimeout(() => process.exit(0), 100).unref();
}
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
