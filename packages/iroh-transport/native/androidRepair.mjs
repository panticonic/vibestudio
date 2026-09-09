/**
 * The repaired Android binding the mobile build resolves, in one place: the
 * build script stamps this version, the install script fetches this archive,
 * and `apps/mobile/android/app/build.gradle` depends on this coordinate.
 *
 * Upstream's own coordinate is kept. Only the version carries the repair, so
 * returning to upstream is a version change rather than a rename.
 */
export const IROH_ANDROID_REPAIR = Object.freeze({
  version: "1.1.0-cancel.1",
  coordinate: "computer.iroh:iroh-android",
  archiveUrl:
    "https://github.com/panticonic/vibestudio/releases/download/iroh-native-1.1.0-cancel.1/iroh-android-maven-1.1.0-cancel.1.tar.gz",
});
