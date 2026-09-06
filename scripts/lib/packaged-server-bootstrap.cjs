// Test transport for cross-platform delivery to the production shutdown handler.
// Windows kill(SIGTERM) is TerminateProcess, so it cannot exercise ordered quit.
const [entry, ...args] = process.argv.slice(2);
if (!entry || !process.versions.electron || !process.send)
  throw new Error("Installed Electron and owned IPC are required");
process.argv = [process.execPath, entry, ...args];
process.on("message", (message) => {
  if (message === "packaged-smoke-stop") process.emit("SIGTERM");
});
require(entry);
