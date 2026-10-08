// Preloaded into the graph child by cache-kill-mid-write.test.ts (--import).
// While CHIASMUS_TEST_PAUSE_WRITE is set (the pool sends the parent's
// environment with every job), the first fs.promises.writeFile whose path
// contains it writes half of its data, creates CHIASMUS_TEST_PAUSE_MARKER and
// never returns, so the test can kill the child in the middle of the write.
import { promises as fs, writeFileSync } from "node:fs";

const writeFile = fs.writeFile;
let paused = false;

fs.writeFile = async function (path, data, ...rest) {
  const match = process.env.CHIASMUS_TEST_PAUSE_WRITE;
  if (!paused && match && typeof path === "string" && path.includes(match)) {
    paused = true;
    const bytes = Buffer.from(data);
    await writeFile.call(this, path, bytes.subarray(0, bytes.length >> 1));
    writeFileSync(process.env.CHIASMUS_TEST_PAUSE_MARKER, path);
    return new Promise(() => {});
  }
  return writeFile.call(this, path, data, ...rest);
};
