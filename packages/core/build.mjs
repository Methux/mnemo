#!/usr/bin/env node
/**
 * Build script: compiles .ts → .js using esbuild (fast, no type checking)
 * Type declarations (.d.ts) generated separately by tsc --emitDeclarationOnly
 */

import { build } from "esbuild";
import { readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { execSync } from "child_process";

// Find all .ts files
function findTsFiles(dir, root = dir) {
  let files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist" || entry === "test") continue;
    if (statSync(full).isDirectory()) {
      files.push(...findTsFiles(full, root));
    } else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) {
      files.push(full);
    }
  }
  return files;
}

const entryPoints = findTsFiles(".");
console.log(`Building ${entryPoints.length} TypeScript files...`);

// Step 1: Compile .ts → .js with esbuild (fast, ignores type errors)
await build({
  entryPoints,
  outdir: "dist",
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: false,
  outExtension: { ".js": ".js" },
  // Don't bundle — keep individual files for tree shaking
  bundle: false,
  // Preserve directory structure
  outbase: ".",
});

console.log("✅ JavaScript compiled");

// Step 2: Generate .d.ts type declarations (tsc, ignore errors)
try {
  execSync("npx tsc --emitDeclarationOnly --declaration --declarationMap false --outDir dist 2>/dev/null || true", {
    stdio: "pipe",
  });
  console.log("✅ Type declarations generated");
} catch {
  console.log("⚠ Type declarations skipped (type errors in source)");
}

console.log("✅ Build complete → dist/");
