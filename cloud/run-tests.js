import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const testFiles = [
  "test-worker.js",
  "test-attendance.js",
  "test-deadlines.js",
  "test-moodle-session.js",
  "test-telegram.js",
  "test-ical-ajax.js",
  "test-dropbox-dedup.js"
];

const testDirectory = fileURLToPath(new URL(".", import.meta.url));

for (const testFile of testFiles) {
  console.log(`\n=== ${testFile} ===`);
  const result = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    `globalThis.print = console.log; await import(${JSON.stringify(`./${testFile}`)})`
  ], {
    cwd: testDirectory,
    stdio: "inherit"
  });

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log("\nAll Spectra test suites passed.");