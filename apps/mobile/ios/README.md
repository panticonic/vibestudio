# Vibez1 iOS Native Project

The Xcode project file (`Vibez1.xcodeproj/project.pbxproj`) is too complex
to generate manually. Use React Native CLI to generate it:

```bash
# From the repository root:
npx react-native init Vibez1 --directory temp-ios --version 0.79.2

# Copy the generated iOS project files:
cp -r temp-ios/ios/Vibez1.xcodeproj mobile/ios/
cp -r temp-ios/ios/Vibez1 mobile/ios/  # (merge with existing Info.plist)
cp temp-ios/ios/Vibez1/LaunchScreen.storyboard mobile/ios/Vibez1/

# Clean up:
rm -rf temp-ios
```

After generating, update the Xcode project:
1. Set the bundle identifier to `com.vibez1.mobile`
2. Set the deployment target to iOS 15.0
3. Add the `vibez1` URL scheme in Info.plist for OAuth deep links
4. Run `cd mobile/ios && pod install` to install CocoaPods dependencies

The `Info.plist` and `Podfile` are already configured for Vibez1.
