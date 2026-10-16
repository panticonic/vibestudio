#import "SceneDelegate.h"
#import "VibestudioClientManager.h"

// A scene only presents the surface in front. The host runtime and every client
// instance belong to the app; links reach the host's JavaScript through the
// Linking module, never by restarting React Native.
@implementation SceneDelegate

- (NSDictionary *)openOptions:(UIOpenURLContext *)context
{
  NSMutableDictionary *options = [NSMutableDictionary new];
  if (context.options.sourceApplication) options[UIApplicationOpenURLOptionsSourceApplicationKey] = context.options.sourceApplication;
  if (context.options.annotation) options[UIApplicationOpenURLOptionsAnnotationKey] = context.options.annotation;
  options[UIApplicationOpenURLOptionsOpenInPlaceKey] = @(context.options.openInPlace);
  return options;
}

- (void)scene:(UIScene *)scene
    willConnectToSession:(UISceneSession *)session
    options:(UISceneConnectionOptions *)connectionOptions
{
  if (![scene isKindOfClass:UIWindowScene.class]) return;
  self.window = [[UIWindow alloc] initWithWindowScene:(UIWindowScene *)scene];
  VibestudioClientManager *manager = [VibestudioClientManager shared];
  [manager attachWindow:self.window];
  if (connectionOptions.shortcutItem != nil) [self openShortcutItem:connectionOptions.shortcutItem];
  for (UIOpenURLContext *context in connectionOptions.URLContexts) {
    [manager openURL:context.URL options:[self openOptions:context]];
  }
  for (NSUserActivity *activity in connectionOptions.userActivities) {
    [manager continueUserActivity:activity];
  }
}

// A home-screen quick action carries its link in userInfo (set when the
// snapshot was published); it reaches the host runtime as a `link` event.
- (void)openShortcutItem:(UIApplicationShortcutItem *)item
{
  NSString *link = item.userInfo[@"link"];
  if ([link isKindOfClass:NSString.class]) [[VibestudioClientManager shared] emitLinkEvent:link];
}

- (void)windowScene:(UIWindowScene *)windowScene
    performActionForShortcutItem:(UIApplicationShortcutItem *)shortcutItem
               completionHandler:(void (^)(BOOL))completionHandler
{
  [self openShortcutItem:shortcutItem];
  completionHandler(YES);
}

// Items the share extension left in the App Group inbox are ingested on activation.
- (void)sceneDidBecomeActive:(UIScene *)scene
{
  [[VibestudioClientManager shared] ingestShareInbox];
}

- (void)sceneDidDisconnect:(UIScene *)scene
{
  if (self.window != nil) [[VibestudioClientManager shared] detachWindow:self.window];
}

- (void)scene:(UIScene *)scene openURLContexts:(NSSet<UIOpenURLContext *> *)URLContexts
{
  for (UIOpenURLContext *context in URLContexts) {
    [[VibestudioClientManager shared] openURL:context.URL options:[self openOptions:context]];
  }
}

- (void)scene:(UIScene *)scene continueUserActivity:(NSUserActivity *)userActivity
{
  [[VibestudioClientManager shared] continueUserActivity:userActivity];
}

@end
