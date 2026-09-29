#import "SceneDelegate.h"
#import "AppDelegate.h"
#import <RCTReactNativeFactory.h>

@implementation SceneDelegate

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
    options:(UISceneConnectionOptions *)connectionOptions
{
  if (![scene isKindOfClass:UIWindowScene.class]) return;
  AppDelegate *appDelegate = (AppDelegate *)UIApplication.sharedApplication.delegate;
  NSMutableDictionary *launchOptions = [appDelegate.launchOptions mutableCopy];
  UIOpenURLContext *urlContext = connectionOptions.URLContexts.anyObject;
  if (urlContext) {
    [appDelegate prepareInitialURL:urlContext.URL];
    launchOptions[UIApplicationLaunchOptionsURLKey] = urlContext.URL;
  }
  for (NSUserActivity *activity in connectionOptions.userActivities) {
    if (![activity.activityType isEqualToString:NSUserActivityTypeBrowsingWeb]) continue;
    [appDelegate prepareInitialURL:activity.webpageURL];
    launchOptions[UIApplicationLaunchOptionsUserActivityDictionaryKey] = @{
      UIApplicationLaunchOptionsUserActivityTypeKey: activity.activityType,
      @"UIApplicationLaunchOptionsUserActivityKey": activity,
    };
    break;
  }
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  [appDelegate.reactNativeFactory startReactNativeWithModuleName:@"Vibestudio"
      inWindow:self.window initialProperties:@{} launchOptions:launchOptions];
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts
{
  AppDelegate *appDelegate = (AppDelegate *)UIApplication.sharedApplication.delegate;
  for (UIOpenURLContext *context in URLContexts) {
    NSMutableDictionary *options = [NSMutableDictionary new];
    if (context.options.sourceApplication) options[UIApplicationOpenURLOptionsSourceApplicationKey] = context.options.sourceApplication;
    if (context.options.annotation) options[UIApplicationOpenURLOptionsAnnotationKey] = context.options.annotation;
    options[UIApplicationOpenURLOptionsOpenInPlaceKey] = @(context.options.openInPlace);
    [appDelegate application:UIApplication.sharedApplication openURL:context.URL options:options];
  }
}

- (void)scene:(UIScene *)scene continueUserActivity:(NSUserActivity *)userActivity
{
  AppDelegate *appDelegate = (AppDelegate *)UIApplication.sharedApplication.delegate;
  [appDelegate application:UIApplication.sharedApplication continueUserActivity:userActivity
      restorationHandler:^(NSArray<id<UIUserActivityRestoring>> *objects) {}];
}

@end
