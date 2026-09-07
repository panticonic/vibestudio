#import <React/RCTViewManager.h>
#import <React/RCTUIManager.h>
#import <React/UIView+React.h>
#import <RNCWebViewManager.h>
#import <RNCWebViewImpl.h>
#import <WebKit/WebKit.h>
#import <CommonCrypto/CommonDigest.h>

WKWebsiteDataStore *VibestudioWorkspaceDataStore(NSString *scope) {
  if (scope.length == 0) @throw [NSException exceptionWithName:NSInvalidArgumentException reason:@"A workspace browser profile is required" userInfo:nil];
  NSData *data = [scope dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  // Deterministic UUID, scoped by server, device account, and workspace.
  digest[6] = (digest[6] & 0x0f) | 0x50;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  NSUUID *identifier = [[NSUUID alloc] initWithUUIDBytes:digest];
  return [WKWebsiteDataStore dataStoreForIdentifier:identifier];
}

// RNCWebView's configuration hook runs before WKWebView is created.
@interface RNCWebViewImpl (WorkspaceConfiguration)
- (WKWebViewConfiguration *)setUpWkWebViewConfig;
@end

@interface WorkspaceWebView : RNCWebViewImpl
@property(nonatomic, copy) NSString *workspaceProfile;
@property(nonatomic, copy) RCTDirectEventBlock onWorkspacePermission;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *permissionRequests;
@property(nonatomic, assign) NSUInteger documentEpoch;
- (void)resolvePermission:(NSString *)requestId allowed:(BOOL)allowed;
@end

@implementation WorkspaceWebView
- (void)cancelPermissionRequests {
  NSDictionary *requests = [_permissionRequests copy];
  [_permissionRequests removeAllObjects];
  for (NSString *requestId in requests) {
    if (_onWorkspacePermission) _onWorkspacePermission(@{ @"requestId": requestId, @"cancelled": @YES, @"target": self.reactTag });
    void (^decision)(WKPermissionDecision) = requests[requestId][@"decision"];
    decision(WKPermissionDecisionDeny);
  }
}

- (void)webView:(WKWebView *)webView didStartProvisionalNavigation:(WKNavigation *)navigation {
  _documentEpoch++;
  [self cancelPermissionRequests];
}

- (void)removeFromSuperview {
  [self cancelPermissionRequests];
  [super removeFromSuperview];
}

- (void)webView:(WKWebView *)webView
    requestMediaCapturePermissionForOrigin:(WKSecurityOrigin *)origin
    initiatedByFrame:(WKFrameInfo *)frame
    type:(WKMediaCaptureType)type
    decisionHandler:(void (^)(WKPermissionDecision))decisionHandler {
  NSURL *url = webView.URL;
  NSInteger defaultPort = [url.scheme.lowercaseString isEqualToString:@"https"] ? 443 : 80;
  NSInteger urlPort = url.port ? url.port.integerValue : defaultPort;
  NSInteger originPort = origin.port == 0 ? defaultPort : origin.port;
  BOOL supportedScheme = [url.scheme.lowercaseString isEqualToString:@"https"] || [url.scheme.lowercaseString isEqualToString:@"http"];
  if (!_onWorkspacePermission || !frame.mainFrame || !supportedScheme ||
      ![origin.protocol.lowercaseString isEqualToString:url.scheme.lowercaseString] ||
      ![origin.host.lowercaseString isEqualToString:url.host.lowercaseString] || originPort != urlPort) {
    decisionHandler(WKPermissionDecisionDeny);
    return;
  }
  NSArray *capabilities;
  switch (type) {
    case WKMediaCaptureTypeCamera: capabilities = @[@"camera"]; break;
    case WKMediaCaptureTypeMicrophone: capabilities = @[@"microphone"]; break;
    case WKMediaCaptureTypeCameraAndMicrophone: capabilities = @[@"camera", @"microphone"]; break;
    default: decisionHandler(WKPermissionDecisionDeny); return;
  }
  if (!_permissionRequests) _permissionRequests = [NSMutableDictionary new];
  NSString *requestId = NSUUID.UUID.UUIDString;
  _permissionRequests[requestId] = @{ @"decision": [decisionHandler copy], @"epoch": @(_documentEpoch) };
  NSURLComponents *components = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
  components.path = @""; components.query = nil; components.fragment = nil;
  components.user = nil; components.password = nil;
  _onWorkspacePermission(@{ @"requestId": requestId, @"cancelled": @NO, @"target": self.reactTag,
    @"origin": components.string, @"topLevelUrl": url.absoluteString, @"capabilities": capabilities });
}

- (void)resolvePermission:(NSString *)requestId allowed:(BOOL)allowed {
  NSDictionary *request = _permissionRequests[requestId];
  if (!request) return;
  [_permissionRequests removeObjectForKey:requestId];
  void (^decision)(WKPermissionDecision) = request[@"decision"];
  decision(allowed && [request[@"epoch"] unsignedIntegerValue] == _documentEpoch ? WKPermissionDecisionGrant : WKPermissionDecisionDeny);
}

- (void)setWorkspaceProfile:(NSString *)scope {
  if (scope.length == 0 || (_workspaceProfile && ![_workspaceProfile isEqualToString:scope])) {
    @throw [NSException exceptionWithName:NSInvalidArgumentException reason:@"A browser view requires one immutable workspace profile" userInfo:nil];
  }
  _workspaceProfile = [scope copy];
}

- (WKWebViewConfiguration *)setUpWkWebViewConfig {
  if (_workspaceProfile.length == 0) {
    @throw [NSException exceptionWithName:NSInvalidArgumentException reason:@"A workspace browser profile is required before loading" userInfo:nil];
  }
  WKWebViewConfiguration *configuration = [super setUpWkWebViewConfig];
  configuration.websiteDataStore = VibestudioWorkspaceDataStore(_workspaceProfile);
  return configuration;
}
@end

@interface WorkspaceWebViewManager : RNCWebViewManager
@end

@implementation WorkspaceWebViewManager
RCT_EXPORT_MODULE(VibestudioWorkspaceWebView)
RCT_EXPORT_VIEW_PROPERTY(workspaceProfile, NSString)
RCT_EXPORT_VIEW_PROPERTY(onWorkspacePermission, RCTDirectEventBlock)
RCT_EXPORT_METHOD(resolveWorkspacePermission:(nonnull NSNumber *)reactTag requestId:(NSString *)requestId allowed:(BOOL)allowed) {
  [self.bridge.uiManager addUIBlock:^(__unused RCTUIManager *manager, NSDictionary<NSNumber *, UIView *> *views) {
    UIView *view = views[reactTag];
    if ([view isKindOfClass:WorkspaceWebView.class]) [(WorkspaceWebView *)view resolvePermission:requestId allowed:allowed];
  }];
}
+ (BOOL)requiresMainQueueSetup { return YES; }
- (NSDictionary *)constantsToExport { return @{ @"profilesSupported": @YES }; }
- (UIView *)view { return [WorkspaceWebView new]; }
@end
