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
  for (UIOpenURLContext *context in connectionOptions.URLContexts) {
    [manager openURL:context.URL options:[self openOptions:context]];
  }
  for (NSUserActivity *activity in connectionOptions.userActivities) {
    [manager continueUserActivity:activity];
  }
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
