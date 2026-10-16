// The React Native JavaScript project lives here; the native projects are the
// sibling hosts (hosts/android, hosts/ios). Point the React Native CLI (and so
// autolinking) at them.
module.exports = {
  project: {
    android: { sourceDir: "../android" },
    ios: { sourceDir: "../ios" },
  },
};
