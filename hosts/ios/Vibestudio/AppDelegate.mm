#import "AppDelegate.h"

#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>
#import <React/RCTBridge.h>
#import <RCTDefaultReactNativeFactoryDelegate.h>
#import <RCTReactNativeFactory.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <UserNotifications/UserNotifications.h>
#import <CommonCrypto/CommonDigest.h>

#if __has_include(<FirebaseCore/FirebaseCore.h>)
#import <FirebaseCore/FirebaseCore.h>
#define VIBESTUDIO_HAS_FIREBASE 1
#elif __has_include(<Firebase.h>)
#import <Firebase.h>
#define VIBESTUDIO_HAS_FIREBASE 1
#else
#define VIBESTUDIO_HAS_FIREBASE 0
#endif

#if __has_include(<RNFBMessaging/RNFBMessaging+AppDelegate.h>)
#import <RNFBMessaging/RNFBMessaging+AppDelegate.h>
#define VIBESTUDIO_HAS_RNFB_MESSAGING 1
#elif __has_include("RNFBMessaging+AppDelegate.h")
#import "RNFBMessaging+AppDelegate.h"
#define VIBESTUDIO_HAS_RNFB_MESSAGING 1
#else
#define VIBESTUDIO_HAS_RNFB_MESSAGING 0
#endif

static NSString *const VibestudioActiveBundleLocalPath = @"activeBundle.localPath";
static NSString *const VibestudioActiveBundleBuildKey = @"activeBundle.buildKey";
static NSString *const VibestudioActiveBundleIntegrity = @"activeBundle.integrity";
static NSString *const VibestudioActiveBundleSource = @"activeBundle.source";
static BOOL VibestudioBundleHasSha256Integrity(NSString *path, NSString *integrity);
static BOOL VibestudioIsPairingURL(NSURL *url);
static void VibestudioClearActiveBundle(void);

@interface VibestudioReactNativeDelegate : RCTDefaultReactNativeFactoryDelegate
@end

@interface AppDelegate ()
@property(nonatomic, strong) RCTReactNativeFactory *reactNativeFactory;
@property(nonatomic, strong) VibestudioReactNativeDelegate *reactNativeDelegate;
@property(nonatomic, copy) NSDictionary *launchOptions;
@end

@implementation AppDelegate

- (BOOL)application:(UIApplication *)application didFinishLaunchingWithOptions:(NSDictionary *)launchOptions
{
#if VIBESTUDIO_HAS_FIREBASE
  if ([FIRApp defaultApp] == nil) {
    @try {
      [FIRApp configure];
    } @catch (NSException *exception) {
      NSLog(@"[Vibestudio] Firebase is not configured: %@", exception.reason);
    }
  }
#else
  NSLog(@"[Vibestudio] FirebaseCore headers are not available; skipping Firebase configure.");
#endif

  [UNUserNotificationCenter currentNotificationCenter].delegate = (id<UNUserNotificationCenterDelegate>)self;

  self.launchOptions = launchOptions ?: @{};
  self.reactNativeDelegate = [VibestudioReactNativeDelegate new];
  self.reactNativeDelegate.dependencyProvider = [RCTAppDependencyProvider new];
  return YES;
}

- (BOOL)prepareInitialURL:(NSURL *)url
{
  if (!VibestudioIsPairingURL(url)) return NO;
  VibestudioClearActiveBundle();
  return YES;
}

- (void)startReactNativeInWindow:(UIWindow *)window launchOptions:(NSDictionary *)launchOptions
{
  // Replacing the runtime makes a new link a launch input, rather than an event
  // sent to the runtime that is about to be discarded. Releasing the old host
  // invalidates its bridgeless instance; the legacy bridge requires invalidate.
  window.rootViewController = nil;
  [self.reactNativeFactory.bridge invalidate];
  self.reactNativeFactory = nil;
  self.reactNativeFactory = [[RCTReactNativeFactory alloc] initWithDelegate:self.reactNativeDelegate];
  [self.reactNativeFactory startReactNativeWithModuleName:@"Vibestudio"
      inWindow:window initialProperties:@{} launchOptions:launchOptions];
}

- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options
{
  return [RCTLinkingManager application:application openURL:url options:options];
}

- (BOOL)application:(UIApplication *)application
continueUserActivity:(NSUserActivity *)userActivity
 restorationHandler:(void (^)(NSArray<id<UIUserActivityRestoring>> * _Nullable))restorationHandler
{
  return [RCTLinkingManager application:application continueUserActivity:userActivity restorationHandler:restorationHandler];
}

- (void)application:(UIApplication *)application
    didReceiveRemoteNotification:(NSDictionary *)userInfo
          fetchCompletionHandler:(void (^)(UIBackgroundFetchResult))completionHandler
{
#if VIBESTUDIO_HAS_RNFB_MESSAGING
  [[RNFBMessagingAppDelegate sharedInstance] application:application didReceiveRemoteNotification:userInfo fetchCompletionHandler:completionHandler];
#else
  completionHandler(UIBackgroundFetchResultNoData);
#endif
}

@end

@implementation VibestudioReactNativeDelegate

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  NSString *activeBundlePath = [defaults stringForKey:VibestudioActiveBundleLocalPath];
  NSString *integrity = [defaults stringForKey:VibestudioActiveBundleIntegrity];
  if (activeBundlePath.length > 0 &&
      [NSFileManager.defaultManager fileExistsAtPath:activeBundlePath] &&
      VibestudioBundleHasSha256Integrity(activeBundlePath, integrity)) {
    return [NSURL fileURLWithPath:activeBundlePath];
  }
  if (activeBundlePath.length > 0) {
    VibestudioClearActiveBundle();
  }
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

@end

static BOOL VibestudioIsPairingURL(NSURL *url)
{
  if (url == nil) return NO;
  NSString *scheme = url.scheme.lowercaseString ?: @"";
  NSString *host = url.host.lowercaseString ?: @"";
  NSString *path = url.path ?: @"";
  if ([scheme isEqualToString:@"vibestudio"] && [host isEqualToString:@"connect"]) return YES;
  if ([scheme isEqualToString:@"https"] && [host isEqualToString:@"vibestudio.app"] && [path isEqualToString:@"/p"]) return YES;
  return NO;
}

static void VibestudioClearActiveBundle(void)
{
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  [defaults removeObjectForKey:VibestudioActiveBundleLocalPath];
  [defaults removeObjectForKey:VibestudioActiveBundleBuildKey];
  [defaults removeObjectForKey:VibestudioActiveBundleIntegrity];
  [defaults removeObjectForKey:VibestudioActiveBundleSource];
  [defaults synchronize];
}

static BOOL VibestudioBundleHasSha256Integrity(NSString *path, NSString *integrity)
{
  if (integrity.length == 0) return NO;
  NSString *expected = [integrity hasPrefix:@"sha256-"] ? [integrity substringFromIndex:@"sha256-".length] : integrity;
  NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"^[A-Fa-f0-9]{64}$" options:0 error:nil];
  if ([regex numberOfMatchesInString:expected options:0 range:NSMakeRange(0, expected.length)] != 1) return NO;

  NSData *data = [NSData dataWithContentsOfFile:path];
  if (data == nil) return NO;
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *actual = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    [actual appendFormat:@"%02x", digest[index]];
  }
  return [actual caseInsensitiveCompare:expected] == NSOrderedSame;
}
