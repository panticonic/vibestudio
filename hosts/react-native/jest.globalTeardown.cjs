/** Jest awaits teardown after its workers have joined; async retirement cannot run in an exit callback. */
module.exports = async function teardown() {
  const key = Symbol.for("vibestudio.react-native.projection");
  const projection = globalThis[key];
  try {
    await projection?.release();
  } finally {
    delete globalThis[key];
  }
};
