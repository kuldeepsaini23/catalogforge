/**
 * One command after `docker compose up -d`: migrate, make fixtures if missing, then run the web app
 * and the worker together with prefixed logs. Ctrl+C stops both.
 *
 *   bun run up            # dev server (hot reload) + worker
 *   bun run up -- --prod  # production build + next start + worker
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

const prod = process.argv.includes("--prod");
const bun = process.platform === "win32" ? "bun.exe" : "bun";

function step(label: string, args: string[]) {
  console.log(`\n▶ ${label}`);
  const r = spawnSync(bun, args, { stdio: "inherit", shell: process.platform === "win32" });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (!existsSync(".env")) {
  console.error("No .env found. Copy .env.example to .env first (it works as-is with the mock AI).");
  process.exit(1);
}
step("applying database migrations", ["run", "db:migrate"]);
if (!existsSync("fixtures/out/sample-200.csv")) step("generating sample supplier sheets and photos", ["run", "fixtures"]);
if (prod) step("building", ["run", "build"]);

const children: ChildProcess[] = [];
function run(name: string, args: string[], colour: string) {
  const child = spawn(bun, args, { shell: process.platform === "win32", env: process.env });
  const prefix = `\x1b[${colour}m${name.padEnd(6)}\x1b[0m│ `;
  const pipe = (data: Buffer) => process.stdout.write(data.toString().replace(/^(?=.)/gm, prefix));
  child.stdout?.on("data", pipe);
  child.stderr?.on("data", pipe);
  child.on("exit", (code) => {
    console.log(`${prefix}exited (${code})`);
    shutdown(code ?? 0);
  });
  children.push(child);
}

let stopping = false;
function shutdown(code: number) {
  if (stopping) return;
  stopping = true;
  for (const c of children) if (c.exitCode === null) c.kill();
  setTimeout(() => process.exit(code), 500);
}
process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

run("web", ["run", prod ? "start" : "dev"], "36");
run("worker", ["run", "worker"], "35");
console.log("\nCatalogForge is starting: http://localhost:3000 (dashboard) and http://localhost:3000/store/DE (storefront)\n");
