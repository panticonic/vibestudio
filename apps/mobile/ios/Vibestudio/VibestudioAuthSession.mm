#import <AuthenticationServices/AuthenticationServices.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#import <UIKit/UIKit.h>

@interface VibestudioAuthSession : NSObject <RCTBridgeModule, RCTInvalidating, ASWebAuthenticationPresentationContextProviding>
@property(nonatomic, assign) BOOL invalidated;
@property(nonatomic, strong) ASWebAuthenticationSession *session;
@property(nonatomic, copy) RCTPromiseResolveBlock pendingResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock pendingReject;
@property(nonatomic, strong) NSTimer *timeoutTimer;
@end

@implementation VibestudioAuthSession

RCT_EXPORT_MODULE();

- (void)invalidate
{
  dispatch_async(dispatch_get_main_queue(), ^{
    self.invalidated = YES;
    RCTPromiseRejectBlock reject = self.pendingReject;
    ASWebAuthenticationSession *session = self.session;
    [self clearPending];
    [session cancel];
    if (reject) reject(@"auth_session_invalidated", @"The OAuth runtime was invalidated", nil);
  });
}

+ (BOOL)requiresMainQueueSetup
{
  return YES;
}

RCT_EXPORT_METHOD(start:(NSDictionary *)options
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.invalidated) {
      reject(@"auth_session_invalidated", @"The OAuth runtime was invalidated", nil);
      return;
    }
    if (self.session != nil) {
      reject(@"auth_session_busy", @"An OAuth auth session is already active", nil);
      return;
    }

    NSString *authUrlRaw = [options[@"authUrl"] isKindOfClass:[NSString class]] ? options[@"authUrl"] : nil;
    NSString *callbackScheme = [options[@"callbackScheme"] isKindOfClass:[NSString class]] ? options[@"callbackScheme"] : nil;
    if (authUrlRaw.length == 0 || callbackScheme.length == 0) {
      reject(@"auth_session_invalid", @"authUrl and callbackScheme are required", nil);
      return;
    }

    NSURL *authUrl = [NSURL URLWithString:authUrlRaw];
    if (authUrl == nil || authUrl.scheme.length == 0) {
      reject(@"auth_session_invalid", @"authUrl must be an absolute URL", nil);
      return;
    }

    self.pendingResolve = resolve;
    self.pendingReject = reject;

    __weak VibestudioAuthSession *weakSelf = self;
    __block __weak ASWebAuthenticationSession *startedSession;
    self.session = [[ASWebAuthenticationSession alloc]
      initWithURL:authUrl
      callbackURLScheme:callbackScheme
      completionHandler:^(NSURL * _Nullable callbackURL, NSError * _Nullable error) {
        VibestudioAuthSession *strongSelf = weakSelf;
        if (strongSelf == nil || strongSelf.session != startedSession) return;
        RCTPromiseResolveBlock pendingResolve = strongSelf.pendingResolve;
        RCTPromiseRejectBlock pendingReject = strongSelf.pendingReject;
        [strongSelf clearPending];
        if (pendingResolve == nil || pendingReject == nil) return;

        if (error != nil) {
          NSString *code = error.code == ASWebAuthenticationSessionErrorCodeCanceledLogin
            ? @"auth_session_cancelled"
            : @"auth_session_failed";
          pendingReject(code, error.localizedDescription ?: @"OAuth auth session failed", error);
          return;
        }
        if (callbackURL == nil) {
          pendingReject(@"auth_session_failed", @"OAuth auth session completed without a callback URL", nil);
          return;
        }
        pendingResolve(@{ @"url": callbackURL.absoluteString });
      }];
    startedSession = self.session;

    self.session.presentationContextProvider = self;
    if ([options[@"prefersEphemeral"] respondsToSelector:@selector(boolValue)]) {
      self.session.prefersEphemeralWebBrowserSession = [options[@"prefersEphemeral"] boolValue];
    }
    if ([options[@"timeoutMs"] respondsToSelector:@selector(doubleValue)]) {
      NSTimeInterval timeout = MAX(1.0, [options[@"timeoutMs"] doubleValue] / 1000.0);
      self.timeoutTimer = [NSTimer scheduledTimerWithTimeInterval:timeout
                                                           target:self
                                                         selector:@selector(authSessionTimedOut)
                                                         userInfo:nil
                                                          repeats:NO];
    }

    if (![self.session start]) {
      [self clearPending];
      reject(@"auth_session_failed", @"ASWebAuthenticationSession refused to start", nil);
    }
  });
}

- (void)authSessionTimedOut
{
  RCTPromiseRejectBlock pendingReject = self.pendingReject;
  ASWebAuthenticationSession *session = self.session;
  [self clearPending];
  [session cancel];
  if (pendingReject != nil) {
    pendingReject(@"auth_session_timeout", @"OAuth auth session timed out", nil);
  }
}

- (void)clearPending
{
  [self.timeoutTimer invalidate];
  self.timeoutTimer = nil;
  self.session = nil;
  self.pendingResolve = nil;
  self.pendingReject = nil;
}

- (ASPresentationAnchor)presentationAnchorForWebAuthenticationSession:(ASWebAuthenticationSession *)session
{
  UIWindow *keyWindow = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (![scene isKindOfClass:[UIWindowScene class]]) continue;
    UIWindowScene *windowScene = (UIWindowScene *)scene;
    for (UIWindow *window in windowScene.windows) {
      if (window.isKeyWindow) return window;
      if (keyWindow == nil) keyWindow = window;
    }
  }
  return keyWindow ?: UIApplication.sharedApplication.windows.firstObject;
}

@end
