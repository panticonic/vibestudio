#import "AppDelegate.h"

#import "VibestudioClientManager.h"

#import <UserNotifications/UserNotifications.h>

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

  // The host runtime starts with the process, before any scene, and outlives
  // every scene and every client.
  [[VibestudioClientManager shared] startHostWithLaunchOptions:launchOptions ?: @{}];
  return YES;
}

- (BOOL)application:(UIApplication *)application
            openURL:(NSURL *)url
            options:(NSDictionary<UIApplicationOpenURLOptionsKey,id> *)options
{
  [[VibestudioClientManager shared] openURL:url options:options];
  return YES;
}

- (BOOL)application:(UIApplication *)application
continueUserActivity:(NSUserActivity *)userActivity
 restorationHandler:(void (^)(NSArray<id<UIUserActivityRestoring>> * _Nullable))restorationHandler
{
  [[VibestudioClientManager shared] continueUserActivity:userActivity];
  return YES;
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
