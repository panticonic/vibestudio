export const IROH_RELEASE_SET = Object.freeze({
  id: "iroh-ffi-1.1.0-core-1.0.2",
  bindingVersion: "1.1.0",
  bindingCommit: "5e451092dba0c1a09ee83ff6e5be37b1152a5c58",
  embeddedCoreVersion: "1.0.2",
  relayVersion: "1.0.2",
  npmIntegrity:
    "sha512-DlrJ4Sza5MiI+WwQg63lg+7eSbxlfQR2Bd+wVDjo7XTqenALD2OCRoSfPTuD12IhcvDbVHr4l7qH48DilocqYA==",
  iosXcframeworkSha256: "ad46dadf09f9224157512992923562931ed60f252414230d50893a4d515c5776",
  androidAarSha256: "ed747f627da6dad314b25b9ff17d38232d8d75cb31e663af348368e6be845ab8",
} as const);

export const IROH_NODE_OPTIONAL_PACKAGE_INTEGRITIES = Object.freeze({
  "@number0/iroh-android-arm-eabi":
    "sha512-PcrwZUGdqEnR0/tus0ehulEa68wVrJRJzFjZN5iBV1Jjhgy00oQ5hKtRdCam1lYAQp3jWmRGktLHF2ejj0xAMg==",
  "@number0/iroh-android-arm64":
    "sha512-wmnWLRNIHYARAecXbXPwZwduoFkmI+Bt75RSa+NZ3mdXiU+hBwWbHt7x0OEDtG8sMOgGgM22nqWemeU9r+UPqA==",
  "@number0/iroh-darwin-arm64":
    "sha512-CM6gaQ+6r9K0HRswc2gOKeGL8XYUHUbz7ESkgOltBFin9OsYKmIo+JVYFxlahH8C7ypGEKq1ybU22Ifcf2kXnQ==",
  "@number0/iroh-linux-arm-gnueabihf":
    "sha512-5K4Kaz4gzyPo5s5LLAFO0zLXc2F0EZ3BXeMKzQc5zuPaeHQt4XqdwxozXVtn0/3EiUYqFNH1JIowagpwahxAlw==",
  "@number0/iroh-linux-arm-musleabihf":
    "sha512-Bz/vWWauI9t96imq8Jq1a2La4u5K9jVTjuCgm6gjpcFIp7wivfv4syZ4HlbgVD61C3Aqjb89lnlhzMd5qE/w0w==",
  "@number0/iroh-linux-arm64-gnu":
    "sha512-AZHpCKQEcJdXya9llNld5u+S2Cz+ehWgGzILtpEJ1qljNYJAClDovzA+5ehUVaXEc+P7ZUNQ+pIjMcWXM0cAug==",
  "@number0/iroh-linux-arm64-musl":
    "sha512-4ZS/U2L4+zk2E5cn5WmxxuUDTkdwWiyxRq0NFArRQNFbuH7mjtQok2aDIbOIFOIrTTB4x1hwb4Gt0OJw4om4SQ==",
  "@number0/iroh-linux-x64-gnu":
    "sha512-P2mo734gUjrfJgwbma1fHAyfeWqtY5IHTx53b1peei2/05JKZ2JJ4LS/YzI4qYW20mVtLKD9GS0T3q/iFYVC9Q==",
  "@number0/iroh-linux-x64-musl":
    "sha512-GTnr8v59AeS5iGmXLyqcgLCsTAFW2w6tdfDzjyyCYr6iO3h4vZuBv9HG3CwaVU+vOzzig9ojDzauDLgl96nniw==",
  "@number0/iroh-win32-arm64-msvc":
    "sha512-LvG4Vcw8D7tFAxZpuZsh6rmyW1YmtS3McDIQjEUNhf9VNBFzQ7WHyEIxdr1GAg/HvC8rmPJ1MQBM24RCDbdUew==",
  "@number0/iroh-win32-x64-msvc":
    "sha512-1eSztLtesLu2tHdAgr9KNPBsSVdiz2+MDHNvCVDtH+UQAN8F+21YqAAbRJB0ctBvB5zcGeTwYawGaqVMTyRVJg==",
} as const);

export const IROH_RELAY_1_0_2_LINUX_ASSET_SHA256 = Object.freeze({
  "aarch64-unknown-linux-gnu": "5810cd3b0861640026deb4423a80d79af130242a34fe9b244d1bf4fd7fc1fdcd",
  "aarch64-unknown-linux-musl": "9a548087f7b1f3a25f5c932790bc0836dd3cb6ffb28d6104b63d18478ed2c51d",
  "x86_64-unknown-linux-gnu": "7faf12b2b0137b5993e8dd1fb7557b2e61fee1a53486db74bb80d5c96907af93",
  "x86_64-unknown-linux-musl": "3d6c37a66f8b21da620f9d83ce4682639aa2de9910bbf1e8e7981cf8478964ea",
} as const);

export type IrohReleaseSet = typeof IROH_RELEASE_SET;
