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

@class WorkspaceWebView;
@interface WorkspaceNotificationMessageHandler : NSObject <WKScriptMessageHandler>
@property(nonatomic, weak) WorkspaceWebView *owner;
@end

@interface WorkspaceRpcMessageHandler : NSObject <WKScriptMessageHandlerWithReply>
@property(nonatomic, weak) WorkspaceWebView *owner;
@end

@interface WorkspaceWebView : RNCWebViewImpl
@property(nonatomic, copy) NSString *workspaceProfile;
@property(nonatomic, copy) RCTDirectEventBlock onWorkspaceRequest;
@property(nonatomic, copy) NSString *workspaceDocumentId;
@property(nonatomic, copy) NSString *workspaceOrigin;
@property(nonatomic, strong) NSMutableDictionary *workspaceCalls;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSString *> *workspaceMethods;
@property(nonatomic, assign) NSTimeInterval workspaceInputAt;
@property(nonatomic, assign) NSTimeInterval workspaceInputConsumedAt;
@property(nonatomic, assign) BOOL workspaceConnected;
@property(nonatomic, strong) NSMutableArray *workspaceMessages;
@property(nonatomic, copy) void (^workspaceReceiver)(id, NSString *);
@property(nonatomic, strong) WorkspaceRpcMessageHandler *workspaceMessageHandler;
- (void)receiveWorkspaceMessage:(WKScriptMessage *)message reply:(void (^)(id, NSString *))reply;
- (void)resolveWorkspaceRequest:(NSString *)documentId requestId:(NSString *)requestId ok:(BOOL)ok valueJson:(NSString *)valueJson;
- (void)deliverWorkspaceMessage:(NSString *)documentId messageJson:(NSString *)messageJson;

@property(nonatomic, copy) RCTDirectEventBlock onWorkspacePermission;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *permissionRequests;
@property(nonatomic, assign) NSUInteger documentEpoch;
@property(nonatomic, copy) RCTDirectEventBlock onWorkspaceWebsiteNotification;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *notificationCalls;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSNumber *> *notificationDocuments;
@property(nonatomic, strong) WorkspaceNotificationMessageHandler *notificationMessageHandler;
- (void)resolvePermission:(NSString *)requestId allowed:(BOOL)allowed;
- (void)resolveWebsiteNotification:(NSString *)requestId ok:(BOOL)ok valueJson:(NSString *)valueJson;
- (void)emitWebsiteNotificationEvent:(NSString *)notificationId type:(NSString *)type;
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message;
@end

@implementation WorkspaceWebView

// Native input evidence cannot be supplied through the page's message payload.
- (UIView *)hitTest:(CGPoint)point withEvent:(UIEvent *)event {
  UIView *target = [super hitTest:point withEvent:event];
  if (target && event && event.type == UIEventTypeTouches) _workspaceInputAt = event.timestamp;
  return target;
}

- (void)pressesBegan:(NSSet<UIPress *> *)presses withEvent:(UIPressesEvent *)event {
  if (event) _workspaceInputAt = event.timestamp;
  [super pressesBegan:presses withEvent:event];
}

- (void)invalidateWorkspaceConnection {
  _workspaceConnected = NO;
  for (NSString *requestId in _workspaceMethods.allKeys) {
    if (![_workspaceMethods[requestId] isEqualToString:@"connect"]) continue;
    void (^reply)(id, NSString *) = _workspaceCalls[requestId];
    [_workspaceMethods removeObjectForKey:requestId];
    [_workspaceCalls removeObjectForKey:requestId];
    if (reply) reply(nil, @"Workspace connection was retired");
  }
}

- (BOOL)consumeWorkspaceInput {
  NSTimeInterval age = NSProcessInfo.processInfo.systemUptime - _workspaceInputAt;
  if (_workspaceInputAt <= _workspaceInputConsumedAt || age < 0 || age > 5) return NO;
  _workspaceInputConsumedAt = _workspaceInputAt;
  return YES;
}

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
  [self retireWorkspaceDocument];
  [self cancelWebsiteNotifications];
  _documentEpoch++;
  [self cancelPermissionRequests];
}

- (void)removeFromSuperview {
  [self retireWorkspaceDocument];
  [self cancelWebsiteNotifications];
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
  _notificationMessageHandler = [WorkspaceNotificationMessageHandler new];
  _notificationMessageHandler.owner = self;
  [configuration.userContentController addScriptMessageHandler:_notificationMessageHandler name:@"vibestudioWebsiteNotifications"];
  NSString *adapter = @"globalThis.__vibestudioWebsiteNotificationsNative={postMessage:function(value){window.webkit.messageHandlers.vibestudioWebsiteNotifications.postMessage(value)},onmessage:null};";
  [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:adapter injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
  _workspaceMessageHandler = [WorkspaceRpcMessageHandler new];
  _workspaceMessageHandler.owner = self;
  [configuration.userContentController addScriptMessageHandlerWithReply:_workspaceMessageHandler contentWorld:WKContentWorld.pageWorld name:@"vibestudioWorkspace"];
  // WebKit replies target the requesting JavaScript context, including the receive
  // wait. Never evaluate a reply into whichever document happens to be visible.
  NSString *workspaceAdapter = @"(() => { const send = value => window.webkit.messageHandlers.vibestudioWorkspace.postMessage(value); const bridge = {onmessage:null,postMessage:value=>{void send(value).then(data=>bridge.onmessage?.({data}));}}; globalThis.__vibestudioWorkspaceNative=bridge; const receive=async()=>{try{for(;;){const data=await send(JSON.stringify({method:'receive'}));bridge.onmessage?.({data});}}catch(_){}}; void receive(); })();";
  [configuration.userContentController addUserScript:[[WKUserScript alloc] initWithSource:workspaceAdapter injectionTime:WKUserScriptInjectionTimeAtDocumentStart forMainFrameOnly:YES]];
  return configuration;
}

- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  if (![message.name isEqualToString:@"vibestudioWebsiteNotifications"] || !message.frameInfo.mainFrame || ![message.body isKindOfClass:NSString.class]) return;
  NSURL *url = self.webView.URL;
  WKSecurityOrigin *source = message.frameInfo.securityOrigin;
  NSInteger port = url.port ? url.port.integerValue : ([url.scheme.lowercaseString isEqualToString:@"https"] ? 443 : 80);
  NSInteger sourcePort = source.port == 0 ? ([source.protocol.lowercaseString isEqualToString:@"https"] ? 443 : 80) : source.port;
  if (!url || ![source.protocol.lowercaseString isEqualToString:url.scheme.lowercaseString] || ![source.host.lowercaseString isEqualToString:url.host.lowercaseString] || port != sourcePort) return;
  NSData *data = [(NSString *)message.body dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *input = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  NSString *requestId = input[@"requestId"], *method = input[@"method"];
  if (![requestId isKindOfClass:NSString.class] || ![@[@"permissionState", @"requestPermission", @"show", @"close"] containsObject:method]) return;
  if (!_notificationCalls) _notificationCalls = [NSMutableDictionary new];
  if (!_notificationDocuments) _notificationDocuments = [NSMutableDictionary new];
  if (_notificationCalls[requestId]) {
    [self sendWebsiteNotificationPayload:@{ @"requestId": requestId, @"ok": @NO, @"value": @"Duplicate notification request" }];
    return;
  }
  id args = input[@"args"] ?: NSNull.null;
  if ([method isEqualToString:@"close"] && (![args isKindOfClass:NSString.class] || ![_notificationDocuments[args] isEqual:@(_documentEpoch)])) {
    [self sendWebsiteNotificationPayload:@{ @"requestId": requestId, @"ok": @NO, @"value": @"Notification does not belong to this document" }];
    return;
  }
  _notificationCalls[requestId] = @{ @"epoch": @(_documentEpoch), @"method": method };
  NSData *argsData = [NSJSONSerialization dataWithJSONObject:args options:0 error:nil];
  NSURLComponents *origin = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
  origin.path = @""; origin.query = nil; origin.fragment = nil; origin.user = nil; origin.password = nil;
  _onWorkspaceWebsiteNotification(@{ @"requestId": requestId, @"target": self.reactTag, @"origin": origin.string,
    @"topLevelUrl": url.absoluteString, @"method": method, @"argsJson": [[NSString alloc] initWithData:argsData encoding:NSUTF8StringEncoding], @"cancelled": @NO });
}

- (void)receiveWorkspaceMessage:(WKScriptMessage *)message reply:(void (^)(id, NSString *))reply {
  NSURL *url = self.webView.URL;
  WKSecurityOrigin *source = message.frameInfo.securityOrigin;
  NSInteger port = url.port ? url.port.integerValue : ([url.scheme.lowercaseString isEqualToString:@"https"] ? 443 : 80);
  NSInteger sourcePort = source.port ?: ([source.protocol.lowercaseString isEqualToString:@"https"] ? 443 : 80);
  BOOL supported = [source.protocol isEqualToString:@"https"] || [source.protocol isEqualToString:@"http"];
  if (!_onWorkspaceRequest || !supported || !message.frameInfo.mainFrame || ![message.body isKindOfClass:NSString.class] || ![source.host.lowercaseString isEqualToString:url.host.lowercaseString] || ![source.protocol.lowercaseString isEqualToString:url.scheme.lowercaseString] || port != sourcePort) {
    reply(nil, @"Workspace bridge requires the current top-level website"); return;
  }
  id input = [NSJSONSerialization JSONObjectWithData:[message.body dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (![input isKindOfClass:NSDictionary.class]) { reply(nil, @"Invalid workspace request"); return; }
  if (!_workspaceDocumentId) {
    _workspaceDocumentId = NSUUID.UUID.UUIDString;
    NSURLComponents *origin = [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO];
    origin.path = @""; origin.query = nil; origin.fragment = nil; origin.user = nil; origin.password = nil;
    if (([origin.scheme isEqualToString:@"https"] && port == 443) || ([origin.scheme isEqualToString:@"http"] && port == 80)) origin.port = nil;
    _workspaceOrigin = origin.string;
    _workspaceCalls = [NSMutableDictionary new]; _workspaceMethods = [NSMutableDictionary new]; _workspaceMessages = [NSMutableArray new];
  }
  NSString *method = input[@"method"], *requestId = input[@"requestId"];
  if (![method isKindOfClass:NSString.class]) { reply(nil, @"Invalid workspace method"); return; }
  if ([method isEqualToString:@"receive"]) {
    if (_workspaceReceiver) { reply(nil, @"A document receive is already pending"); return; }
    if (_workspaceMessages.count) { NSString *next = _workspaceMessages.firstObject; [_workspaceMessages removeObjectAtIndex:0]; reply(next, nil); }
    else _workspaceReceiver = [reply copy];
    return;
  }
  if (![method isKindOfClass:NSString.class] || ![requestId isKindOfClass:NSString.class] || requestId.length > 200 || _workspaceCalls[requestId]) { reply(nil, @"Invalid workspace request"); return; }
  if ([method isEqualToString:@"connect"] && !_workspaceConnected && ![self consumeWorkspaceInput]) {
    reply(nil, @"Connect requires a fresh interaction with this website"); return;
  }
  if ([method isEqualToString:@"disconnect"]) [self invalidateWorkspaceConnection];
  _workspaceMethods[requestId] = method;
  NSData *args = [NSJSONSerialization dataWithJSONObject:input[@"args"] ?: @[] options:NSJSONWritingFragmentsAllowed error:nil];
  _workspaceCalls[requestId] = [reply copy];
  _onWorkspaceRequest(@{ @"documentId": _workspaceDocumentId, @"origin": _workspaceOrigin, @"requestId": requestId,
    @"method": method, @"argsJson": [[NSString alloc] initWithData:args encoding:NSUTF8StringEncoding], @"target": self.reactTag });
}

- (void)resolveWorkspaceRequest:(NSString *)documentId requestId:(NSString *)requestId ok:(BOOL)ok valueJson:(NSString *)valueJson {
  if (![_workspaceDocumentId isEqualToString:documentId]) return;
  void (^reply)(id, NSString *) = _workspaceCalls[requestId];
  if (!reply) return;
  [_workspaceCalls removeObjectForKey:requestId];
  if (ok && [_workspaceMethods[requestId] isEqualToString:@"connect"]) _workspaceConnected = YES;
  [_workspaceMethods removeObjectForKey:requestId];
  NSString *payload = [NSString stringWithFormat:@"{\"requestId\":%@,\"ok\":%@,\"value\":%@}", [self quotedJson:requestId], ok ? @"true" : @"false", valueJson];
  reply(payload, nil);
}

- (void)deliverWorkspaceMessage:(NSString *)documentId messageJson:(NSString *)messageJson {
  if (![_workspaceDocumentId isEqualToString:documentId]) return;
  NSDictionary *payload = [NSJSONSerialization JSONObjectWithData:[messageJson dataUsingEncoding:NSUTF8StringEncoding] options:0 error:nil];
  if (![payload isKindOfClass:NSDictionary.class]) return;
  if ([payload[@"disconnected"] boolValue]) [self invalidateWorkspaceConnection];
  if (_workspaceReceiver) { void (^reply)(id, NSString *) = _workspaceReceiver; _workspaceReceiver = nil; reply(messageJson, nil); }
  else [_workspaceMessages addObject:messageJson];
}

- (void)retireWorkspaceDocument {
  if (_workspaceDocumentId && _onWorkspaceRequest) _onWorkspaceRequest(@{ @"documentId": _workspaceDocumentId, @"origin": _workspaceOrigin,
    @"requestId": NSUUID.UUID.UUIDString, @"method": @"retire", @"argsJson": @"[]", @"target": self.reactTag });
  for (void (^reply)(id, NSString *) in _workspaceCalls.allValues) reply(nil, @"Website document retired");
  [_workspaceCalls removeAllObjects]; [_workspaceMethods removeAllObjects]; [_workspaceMessages removeAllObjects];
  _workspaceConnected = NO; _workspaceInputAt = 0; _workspaceInputConsumedAt = 0;
  if (_workspaceReceiver) _workspaceReceiver(nil, @"Website document retired");
  _workspaceReceiver = nil; _workspaceDocumentId = nil; _workspaceOrigin = nil;
}

- (void)resolveWebsiteNotification:(NSString *)requestId ok:(BOOL)ok valueJson:(NSString *)valueJson {
  NSDictionary *call = _notificationCalls[requestId];
  [_notificationCalls removeObjectForKey:requestId];
  if (!call || ![call[@"epoch"] isEqual:@(_documentEpoch)]) return;
  NSData *data = [valueJson dataUsingEncoding:NSUTF8StringEncoding];
  id value = [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingFragmentsAllowed error:nil];
  if (ok && [call[@"method"] isEqualToString:@"show"] && [value isKindOfClass:NSString.class]) _notificationDocuments[value] = @(_documentEpoch);
  [self sendWebsiteNotificationPayload:@{ @"requestId": requestId, @"ok": @(ok), @"value": value ?: NSNull.null }];
}

- (void)emitWebsiteNotificationEvent:(NSString *)notificationId type:(NSString *)type {
  if (![_notificationDocuments[notificationId] isEqual:@(_documentEpoch)]) return;
  if ([type isEqualToString:@"close"]) [_notificationDocuments removeObjectForKey:notificationId];
  [self sendWebsiteNotificationPayload:@{ @"event": @{ @"id": notificationId, @"type": type } }];
}

- (void)sendWebsiteNotificationPayload:(NSDictionary *)payload {
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:nil];
  NSString *json = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  NSString *script = [NSString stringWithFormat:@"globalThis.__vibestudioWebsiteNotificationsNative?.onmessage?.({data:%@})", [self quotedJson:json]];
  [self.webView evaluateJavaScript:script completionHandler:nil];
}

- (NSString *)quotedJson:(NSString *)value {
  NSData *data = [NSJSONSerialization dataWithJSONObject:@[value] options:0 error:nil];
  NSString *array = [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
  return [array substringWithRange:NSMakeRange(1, array.length - 2)];
}

- (void)cancelWebsiteNotifications {
  for (NSString *requestId in _notificationCalls) {
    [self sendWebsiteNotificationPayload:@{ @"requestId": requestId, @"ok": @NO, @"value": @"Document navigated" }];
    _onWorkspaceWebsiteNotification(@{ @"requestId": requestId, @"target": self.reactTag, @"cancelled": @YES });
  }
  [_notificationCalls removeAllObjects];
  NSURL *url = self.webView.URL;
  NSURLComponents *origin = url ? [NSURLComponents componentsWithURL:url resolvingAgainstBaseURL:NO] : nil;
  origin.path = @""; origin.query = nil; origin.fragment = nil; origin.user = nil; origin.password = nil;
  for (NSString *notificationId in _notificationDocuments) {
    NSData *args = [NSJSONSerialization dataWithJSONObject:notificationId options:NSJSONWritingFragmentsAllowed error:nil];
    _onWorkspaceWebsiteNotification(@{ @"requestId": NSUUID.UUID.UUIDString, @"target": self.reactTag,
      @"origin": origin.string ?: @"", @"topLevelUrl": url.absoluteString ?: @"", @"method": @"close",
      @"argsJson": [[NSString alloc] initWithData:args encoding:NSUTF8StringEncoding], @"cancelled": @NO });
  }
  [_notificationDocuments removeAllObjects];
}
@end


@implementation WorkspaceNotificationMessageHandler
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message {
  [_owner userContentController:controller didReceiveScriptMessage:message];
}
@end

@implementation WorkspaceRpcMessageHandler
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message replyHandler:(void (^)(id, NSString *))replyHandler {
  if (_owner) [_owner receiveWorkspaceMessage:message reply:replyHandler];
  else replyHandler(nil, @"Website host closed");
}
@end

@interface WorkspaceWebViewManager : RNCWebViewManager
@end

@implementation WorkspaceWebViewManager
RCT_EXPORT_MODULE(VibestudioWorkspaceWebView)
RCT_EXPORT_VIEW_PROPERTY(workspaceProfile, NSString)
RCT_EXPORT_VIEW_PROPERTY(onWorkspaceRequest, RCTDirectEventBlock)
RCT_EXPORT_METHOD(resolveWorkspaceRequest:(nonnull NSNumber *)reactTag documentId:(NSString *)documentId requestId:(NSString *)requestId ok:(BOOL)ok valueJson:(NSString *)valueJson) {
  [self.bridge.uiManager addUIBlock:^(__unused RCTUIManager *manager, NSDictionary<NSNumber *, UIView *> *views) {
    UIView *view = views[reactTag]; if ([view isKindOfClass:WorkspaceWebView.class]) [(WorkspaceWebView *)view resolveWorkspaceRequest:documentId requestId:requestId ok:ok valueJson:valueJson];
  }];
}
RCT_EXPORT_METHOD(deliverWorkspaceMessage:(nonnull NSNumber *)reactTag documentId:(NSString *)documentId messageJson:(NSString *)messageJson) {
  [self.bridge.uiManager addUIBlock:^(__unused RCTUIManager *manager, NSDictionary<NSNumber *, UIView *> *views) {
    UIView *view = views[reactTag]; if ([view isKindOfClass:WorkspaceWebView.class]) [(WorkspaceWebView *)view deliverWorkspaceMessage:documentId messageJson:messageJson];
  }];
}
RCT_EXPORT_VIEW_PROPERTY(onWorkspacePermission, RCTDirectEventBlock)
RCT_EXPORT_VIEW_PROPERTY(onWorkspaceWebsiteNotification, RCTDirectEventBlock)
RCT_EXPORT_METHOD(resolveWorkspacePermission:(nonnull NSNumber *)reactTag requestId:(NSString *)requestId allowed:(BOOL)allowed) {
  [self.bridge.uiManager addUIBlock:^(__unused RCTUIManager *manager, NSDictionary<NSNumber *, UIView *> *views) {
    UIView *view = views[reactTag];
    if ([view isKindOfClass:WorkspaceWebView.class]) [(WorkspaceWebView *)view resolvePermission:requestId allowed:allowed];
  }];
}
RCT_EXPORT_METHOD(resolveWebsiteNotification:(nonnull NSNumber *)reactTag requestId:(NSString *)requestId ok:(BOOL)ok valueJson:(NSString *)valueJson) {
  [self.bridge.uiManager addUIBlock:^(__unused RCTUIManager *manager, NSDictionary<NSNumber *, UIView *> *views) {
    UIView *view = views[reactTag]; if ([view isKindOfClass:WorkspaceWebView.class]) [(WorkspaceWebView *)view resolveWebsiteNotification:requestId ok:ok valueJson:valueJson];
  }];
}
RCT_EXPORT_METHOD(emitWebsiteNotificationEvent:(nonnull NSNumber *)reactTag notificationId:(NSString *)notificationId type:(NSString *)type) {
  [self.bridge.uiManager addUIBlock:^(__unused RCTUIManager *manager, NSDictionary<NSNumber *, UIView *> *views) {
    UIView *view = views[reactTag]; if ([view isKindOfClass:WorkspaceWebView.class]) [(WorkspaceWebView *)view emitWebsiteNotificationEvent:notificationId type:type];
  }];
}
+ (BOOL)requiresMainQueueSetup { return YES; }
- (NSDictionary *)constantsToExport { return @{ @"profilesSupported": @YES }; }
- (UIView *)view { return [WorkspaceWebView new]; }
@end
