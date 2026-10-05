#!/usr/bin/env node
// macbox on npm: runs the macbox CLI, downloading it on first use.
//
// The CLI is a single Go binary served from https://api.macbox.build/dl/. This wrapper
// fetches the build for this OS and CPU, checks it against the published SHA256SUMS,
// keeps it in ~/.macbox/bin/<version>/, and runs it with the same arguments, stdin,
// stdout, and exit code. That makes `npx -y macbox mcp` work as an MCP server.
//
// Everything the wrapper itself prints goes to stderr: on stdout, an MCP client expects
// nothing but protocol messages.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");

const BASE = process.env.MACBOX_DOWNLOAD_URL || "https://api.macbox.build/dl";
const HOME = process.env.MACBOX_HOME || path.join(os.homedir(), ".macbox");
const BIN_DIR = path.join(HOME, "bin");

function target() {
  const plat = { darwin: "darwin", linux: "linux" }[process.platform];
  const arch = { x64: "amd64", arm64: "arm64" }[process.arch];
  if (!plat || !arch) {
    throw new Error(`macbox runs on macOS and Linux (x64 or arm64), not ${process.platform} ${process.arch}`);
  }
  return `macbox-${plat}-${arch}`;
}

async function get(url, timeoutMs) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "macbox-npm" } });
  if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

// newestCached is the highest version already downloaded, for when the network is down.
function newestCached(name) {
  let dirs = [];
  try {
    dirs = fs.readdirSync(BIN_DIR).filter((v) => fs.existsSync(path.join(BIN_DIR, v, name)));
  } catch {}
  dirs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return dirs.length ? path.join(BIN_DIR, dirs[dirs.length - 1], name) : null;
}

async function binary() {
  const name = target();
  let version;
  try {
    version = (await get(`${BASE}/VERSION`, 5000)).toString().trim();
  } catch (e) {
    const cached = newestCached(name);
    if (cached) return cached; // offline: run what we have
    throw new Error(`could not reach ${BASE} to download macbox: ${e.message}`);
  }
  if (!/^[0-9A-Za-z._-]+$/.test(version)) throw new Error(`unexpected version ${JSON.stringify(version)}`);
  const file = path.join(BIN_DIR, version, name);
  if (fs.existsSync(file)) return file;

  process.stderr.write(`macbox: downloading macbox ${version} for ${name.slice(7)}\n`);
  const [bin, sums] = await Promise.all([get(`${BASE}/${name}`, 120000), get(`${BASE}/SHA256SUMS`, 15000)]);
  const want = sums
    .toString()
    .split("\n")
    .map((l) => l.trim().split(/\s+/))
    .find(([, f]) => f === name);
  const got = crypto.createHash("sha256").update(bin).digest("hex");
  if (!want || want[0] !== got) throw new Error(`checksum mismatch for ${name}; not running it`);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, bin, { mode: 0o755 });
  fs.renameSync(tmp, file); // atomic, so a second process never runs half a file
  return file;
}

binary()
  .then((file) => {
    const child = spawn(file, process.argv.slice(2), { stdio: "inherit" });
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
    child.on("exit", (code, signal) => process.exit(signal ? 128 + (os.constants.signals[signal] || 0) : code ?? 0));
    child.on("error", (e) => {
      process.stderr.write(`macbox: ${e.message}\n`);
      process.exit(2);
    });
  })
  .catch((e) => {
    process.stderr.write(`macbox: ${e.message}\n`);
    process.exit(2);
  });
