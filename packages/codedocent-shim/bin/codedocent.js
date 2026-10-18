#!/usr/bin/env node
// codedocent was renamed to docentflow. Say so, then run docentflow with the same arguments.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

console.error("codedocent is now docentflow. Install it with: npm i -g docentflow\n");

const require = createRequire(import.meta.url);
const root = dirname(require.resolve("docentflow/package.json"));
const child = spawn(process.execPath, [join(root, "dist/docent.js"), ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code, signal) => (signal ? process.kill(process.pid, signal) : process.exit(code ?? 0)));
