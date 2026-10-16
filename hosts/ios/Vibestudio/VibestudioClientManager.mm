#import "VibestudioClientManager.h"
#import "VibestudioArtifactStore.h"
#import "VibestudioInstances.h"
#import "Vibestudio-Swift.h"

#import <React/RCTBridge.h>
#import <React/RCTBundleURLProvider.h>
#import <React/RCTLinkingManager.h>
#import <RCTDefaultReactNativeFactoryDelegate.h>
#import <RCTReactNativeFactory.h>
#import <ReactAppDependencyProvider/RCTAppDependencyProvider.h>
#import <ReactCommon/RCTHost.h>

static NSString *const VibestudioHostRootComponent = @"Vibestudio";
static NSString *const VibestudioClientRootComponent = @"VibestudioClient";
static NSString *const VibestudioHostRuntimeEventName = @"VibestudioHostRuntimeEvent";

#pragma mark - Instance delegate

/// One per React Native instance. The host runs the app's own bundle; a client
/// runs the verified bundle file it was created for and nothing else.
@interface VibestudioInstanceDelegate : RCTDefaultReactNativeFactoryDelegate
@property(nonatomic, copy, nullable) NSURL *clientBundleURL;
@property(nonatomic, copy, nullable) void (^onHostStart)(void);
@end

@implementation VibestudioInstanceDelegate

- (NSURL *)sourceURLForBridge:(RCTBridge *)bridge
{
  return [self bundleURL];
}

- (NSURL *)bundleURL
{
  if (self.clientBundleURL != nil) return self.clientBundleURL;
#if DEBUG
  return [[RCTBundleURLProvider sharedSettings] jsBundleURLForBundleRoot:@"index"];
#else
  return [[NSBundle mainBundle] URLForResource:@"main" withExtension:@"jsbundle"];
#endif
}

- (void)hostDidStart:(RCTHost *)host
{
  [super hostDidStart:host];
  void (^onHostStart)(void) = self.onHostStart;
  if (onHostStart) onHostStart();
}

@end

#pragma mark - Client record

@interface VibestudioClientRecord : NSObject
@property(nonatomic, copy) NSDictionary *spec;
@property(nonatomic, strong) VibestudioInstanceDelegate *delegate;
@property(nonatomic, strong) RCTReactNativeFactory *factory;
@property(nonatomic, strong) UIView *rootView;
@property(nonatomic, strong) UIViewController *viewController;
@property(nonatomic, copy, nullable) RCTPromiseResolveBlock startResolve;
@property(nonatomic, copy, nullable) RCTPromiseRejectBlock startReject;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSDictionary *> *pending; // requestId -> {resolve, reject}
@property(nonatomic, strong) NSMutableArray<NSString *> *queuedEvents; // for the broker that has not attached yet
@end

@implementation VibestudioClientRecord
- (instancetype)init
{
  self = [super init];
  if (self) {
    _pending = [NSMutableDictionary dictionary];
    _queuedEvents = [NSMutableArray array];
  }
  return self;
}
@end

#pragma mark - Manager

static void VibestudioRejectArtifactError(RCTPromiseRejectBlock reject, NSError *error)
{
  NSString *code = error.userInfo[VibestudioArtifactErrorCodeKey] ?: @"native-failed";
  reject(code, error.localizedDescription, error);
}

static NSString *VibestudioJSON(NSDictionary *object)
{
  NSData *data = [NSJSONSerialization dataWithJSONObject:object options:0 error:nil];
  return [[NSString alloc] initWithData:data encoding:NSUTF8StringEncoding];
}

@implementation VibestudioClientManager {
  VibestudioInstanceDelegate *_hostDelegate;
  RCTReactNativeFactory *_hostFactory;
  UIView *_hostRootView;
  UIViewController *_hostViewController;
  __weak UIWindow *_window;
  NSMutableDictionary<NSString *, VibestudioClientRecord *> *_clients;
  NSMapTable<NSString *, id<VibestudioClientEventSink>> *_brokers;
  NSString *_frontTag; // nil: the host's own surface
  __weak id<VibestudioHostEventSink> _hostSink;
  BOOL _ready;
  NSMutableArray<dispatch_block_t> *_whenReady;
}

+ (instancetype)shared
{
  static VibestudioClientManager *manager;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ manager = [VibestudioClientManager new]; });
  return manager;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _clients = [NSMutableDictionary dictionary];
    _brokers = [NSMapTable strongToWeakObjectsMapTable];
    _whenReady = [NSMutableArray array];
  }
  return self;
}

- (void)onMain:(dispatch_block_t)block
{
  if ([NSThread isMainThread]) block();
  else dispatch_async(dispatch_get_main_queue(), block);
}

#pragma mark Readiness

/// Runs `block` once the host runtime has called markReady, in arrival order. No delay, no timeout.
- (void)whenReady:(dispatch_block_t)block
{
  if (_ready) block();
  else [_whenReady addObject:[block copy]];
}

- (void)hostRuntimeReady:(id<VibestudioHostEventSink>)sink
{
  [self onMain:^{
    self->_hostSink = sink;
    // Blocks run while `_ready` is still NO so work they enqueue keeps its order.
    while (self->_whenReady.count > 0) {
      dispatch_block_t block = self->_whenReady.firstObject;
      [self->_whenReady removeObjectAtIndex:0];
      block();
    }
    self->_ready = YES;
  }];
}

- (void)hostRuntimeInvalidated:(id<VibestudioHostEventSink>)sink
{
  [self onMain:^{
    if (self->_hostSink != sink) return;
    self->_hostSink = nil;
    self->_ready = NO;
  }];
}

- (void)emitHostEvent:(NSDictionary *)event
{
  [self emitHostEventJSON:VibestudioJSON(event)];
}

- (void)emitHostEventJSON:(NSString *)json
{
  [self onMain:^{
    [self whenReady:^{ [self->_hostSink deliverHostEvent:json]; }];
  }];
}

- (void)emitLinkEvent:(NSString *)url
{
  [self emitHostEvent:@{ @"type": @"link", @"url": url }];
}

/// The share extension's items become `share-in` events once the host runtime
/// is ready; an item's file is deleted when its event is handed over.
- (void)ingestShareInbox
{
  [self onMain:^{
    [self whenReady:^{ [VibestudioLaunchEvents ingestShareInbox]; }];
  }];
}

#pragma mark Host instance and scenes

- (void)startHostWithLaunchOptions:(NSDictionary *)launchOptions
{
  [self onMain:^{
    if (self->_hostFactory != nil) return;
    VibestudioInstanceDelegate *delegate = [VibestudioInstanceDelegate new];
    delegate.dependencyProvider = [RCTAppDependencyProvider new];
    RCTReactNativeFactory *factory = [[RCTReactNativeFactory alloc] initWithDelegate:delegate];
    UIView *rootView = [factory.rootViewFactory viewWithModuleName:VibestudioHostRootComponent
                                                 initialProperties:@{}
                                                     launchOptions:VibestudioHostLaunchOptions(launchOptions)];
    UIViewController *controller = [delegate createRootViewController];
    [delegate setRootView:rootView toRootViewController:controller];
    // Native launch surfaces (App Intents) reach the host runtime through this
    // sink, with or without a scene.
    VibestudioLaunchEvents.sink = ^(NSString *json) { [self emitHostEventJSON:json]; };
    self->_hostDelegate = delegate;
    self->_hostFactory = factory;
    self->_hostRootView = rootView;
    self->_hostViewController = controller;
    [self showFront];
  }];
}

- (void)attachWindow:(UIWindow *)window
{
  [self onMain:^{
    self->_window = window;
    [self showFront];
  }];
}

- (void)detachWindow:(UIWindow *)window
{
  [self onMain:^{
    if (self->_window != window) return;
    window.rootViewController = nil;
    self->_window = nil;
  }];
}

- (UIViewController *)frontViewController
{
  if (_frontTag != nil) return _clients[_frontTag].viewController;
  return _hostViewController;
}

- (void)showFront
{
  UIViewController *controller = [self frontViewController];
  UIWindow *window = _window;
  if (window == nil || controller == nil || window.rootViewController == controller) return;
  window.rootViewController = controller;
  [window makeKeyAndVisible];
}

- (void)openURL:(NSURL *)url options:(NSDictionary *)options
{
  [self onMain:^{
    [self whenReady:^{
      [RCTLinkingManager application:UIApplication.sharedApplication openURL:url options:options];
    }];
  }];
}

- (void)continueUserActivity:(NSUserActivity *)activity
{
  [self onMain:^{
    [self whenReady:^{
      [RCTLinkingManager application:UIApplication.sharedApplication
                continueUserActivity:activity
                  restorationHandler:^(NSArray<id<UIUserActivityRestoring>> *objects) {}];
    }];
  }];
}

#pragma mark Client instances

static NSString *VibestudioSpecString(NSDictionary *spec, NSString *key)
{
  id value = spec[key];
  return [value isKindOfClass:NSString.class] && [value length] > 0 ? value : nil;
}

- (void)startClient:(NSDictionary *)spec resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  NSString *tag = VibestudioSpecString(spec, @"tag");
  id capabilities = spec[@"grantedCapabilities"];
  BOOL validCapabilities = [capabilities isKindOfClass:NSArray.class];
  for (id capability in validCapabilities ? capabilities : @[]) validCapabilities &= [capability isKindOfClass:NSString.class];
  if (tag == nil || VibestudioSpecString(spec, @"bundlePath") == nil || VibestudioSpecString(spec, @"integrity") == nil || !validCapabilities) {
    reject(@"invalid-spec", @"A client spec needs a tag, bundlePath, integrity and grantedCapabilities", nil);
    return;
  }
  [self verifiedLaunch:[spec copy] requireExisting:NO resolve:resolve reject:reject];
}

- (void)reloadClient:(NSString *)tag bundle:(NSDictionary *)bundle resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  if (VibestudioSpecString(bundle, @"bundlePath") == nil || VibestudioSpecString(bundle, @"integrity") == nil) {
    reject(@"invalid-spec", @"A bundle needs a bundlePath and integrity", nil);
    return;
  }
  [self onMain:^{
    VibestudioClientRecord *record = self->_clients[tag];
    if (record == nil) {
      reject(@"unknown-client", @"No running client has this tag", nil);
      return;
    }
    NSMutableDictionary *spec = [record.spec mutableCopy];
    [spec addEntriesFromDictionary:@{
      @"bundlePath": bundle[@"bundlePath"],
      @"integrity": bundle[@"integrity"],
      @"buildKey": bundle[@"buildKey"] ?: NSNull.null,
      @"assetsRoot": bundle[@"assetsRoot"] ?: NSNull.null,
    }];
    [self verifiedLaunch:spec requireExisting:YES resolve:resolve reject:reject];
  }];
}

/// Re-hash the bundle against the integrity it was given immediately before an
/// instance is created from it, whatever the host runtime believed. Nothing is
/// loaded when it does not match.
- (void)verifiedLaunch:(NSDictionary *)spec requireExisting:(BOOL)requireExisting
               resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  dispatch_async(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
    NSError *error = nil;
    if (![VibestudioArtifactStore verifyFileAtPath:spec[@"bundlePath"] integrity:spec[@"integrity"] error:&error]) {
      VibestudioRejectArtifactError(reject, error);
      return;
    }
    [self onMain:^{
      NSString *tag = spec[@"tag"];
      BOOL existed = self->_clients[tag] != nil;
      if (requireExisting && !existed) {
        reject(@"unknown-client", @"The client was stopped before its bundle could be reloaded", nil);
        return;
      }
      BOOL keepFront = existed && [self->_frontTag isEqualToString:tag];
      // Starting a tag that already runs reloads it.
      if (existed) [self tearDownClient:tag];
      [self launchClient:spec resolve:resolve reject:reject];
      if (keepFront || !requireExisting) self->_frontTag = tag;
      [self showFront];
    }];
  });
}

- (void)launchClient:(NSDictionary *)spec resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  NSString *tag = spec[@"tag"];
  VibestudioClientRecord *record = [VibestudioClientRecord new];
  record.spec = spec;
  record.startResolve = resolve;
  record.startReject = reject;

  VibestudioInstanceDelegate *delegate = [VibestudioInstanceDelegate new];
  delegate.dependencyProvider = [RCTAppDependencyProvider new];
  delegate.clientBundleURL = [NSURL fileURLWithPath:spec[@"bundlePath"]];
  __weak VibestudioClientManager *weakSelf = self;
  __weak VibestudioClientRecord *weakRecord = record;
  delegate.onHostStart = ^{
    dispatch_async(dispatch_get_main_queue(), ^{
      VibestudioClientManager *manager = weakSelf;
      VibestudioClientRecord *started = weakRecord;
      // A record that was torn down or replaced already settled its start.
      if (manager == nil || started == nil || manager->_clients[tag] != started) return;
      RCTPromiseResolveBlock done = started.startResolve;
      started.startResolve = nil;
      started.startReject = nil;
      if (done) done(nil);
    });
  };
  record.delegate = delegate;
  record.factory = [[RCTReactNativeFactory alloc] initWithDelegate:delegate];
  _clients[tag] = record;

  record.rootView = [record.factory.rootViewFactory
      viewWithModuleName:VibestudioClientRootComponent
       initialProperties:@{}
           launchOptions:VibestudioClientLaunchOptions(tag, spec[@"grantedCapabilities"])];
  record.viewController = [delegate createRootViewController];
  [delegate setRootView:record.rootView toRootViewController:record.viewController];
}

/// Destroy the client's instance. Releasing its host invalidates the instance.
- (void)tearDownClient:(NSString *)tag
{
  VibestudioClientRecord *record = _clients[tag];
  if (record == nil) return;
  [_clients removeObjectForKey:tag];
  [_brokers removeObjectForKey:tag];
  if ([_frontTag isEqualToString:tag]) {
    _frontTag = nil;
    [self showFront];
  }
  RCTPromiseRejectBlock startReject = record.startReject;
  record.startResolve = nil;
  record.startReject = nil;
  if (startReject) startReject(@"client-stopped", @"The client was stopped before it started", nil);
  for (NSDictionary *entry in record.pending.allValues) {
    ((RCTPromiseRejectBlock)entry[@"reject"])(@"client-stopped", @"The client was stopped", nil);
  }
  [record.pending removeAllObjects];
  [record.rootView removeFromSuperview];
  record.factory.rootViewFactory.reactHost = nil;
  record.rootView = nil;
  record.viewController = nil;
  record.factory = nil;
  record.delegate = nil;
}

- (void)stopClient:(NSString *)tag reason:(NSString *)reason resolve:(RCTPromiseResolveBlock)resolve
{
  [self onMain:^{
    [self tearDownClient:tag];
    resolve(nil);
  }];
}

- (void)focusClient:(NSString *)tag resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject
{
  [self onMain:^{
    if (self->_clients[tag] == nil) {
      reject(@"unknown-client", @"No running client has this tag", nil);
      return;
    }
    self->_frontTag = tag;
    [self showFront];
    resolve(nil);
  }];
}

- (void)showHostSurfaceResolve:(RCTPromiseResolveBlock)resolve
{
  [self onMain:^{
    self->_frontTag = nil;
    [self showFront];
    resolve(nil);
  }];
}

#pragma mark Broker

- (void)brokerAttached:(id<VibestudioClientEventSink>)broker tag:(NSString *)tag
{
  [self onMain:^{
    VibestudioClientRecord *record = self->_clients[tag];
    if (record == nil) return;
    [self->_brokers setObject:broker forKey:tag];
    NSArray<NSString *> *queued = [record.queuedEvents copy];
    [record.queuedEvents removeAllObjects];
    for (NSString *json in queued) [broker deliverClientEvent:json];
  }];
}

- (void)brokerDetached:(id<VibestudioClientEventSink>)broker tag:(NSString *)tag
{
  [self onMain:^{
    if ([self->_brokers objectForKey:tag] == broker) [self->_brokers removeObjectForKey:tag];
  }];
}

- (void)clientRequest:(NSString *)tag
               method:(NSString *)method
             argsJson:(NSString *)argsJson
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject
{
  [self onMain:^{
    VibestudioClientRecord *record = self->_clients[tag];
    if (record == nil) {
      reject(@"client-stopped", @"This client is not running", nil);
      return;
    }
    NSString *requestId = NSUUID.UUID.UUIDString.lowercaseString;
    record.pending[requestId] = @{ @"resolve": [resolve copy], @"reject": [reject copy] };
    // The host runtime serves requests only after it said it is ready.
    [self whenReady:^{
      if (self->_clients[tag] != record || record.pending[requestId] == nil) return;
      [self emitHostEvent:@{
        @"type": @"client-request",
        @"tag": tag,
        @"requestId": requestId,
        @"method": method,
        @"argsJson": argsJson,
      }];
    }];
  }];
}

- (NSDictionary *)takePending:(NSString *)requestId tag:(NSString *)tag
{
  VibestudioClientRecord *record = _clients[tag];
  NSDictionary *entry = record.pending[requestId];
  if (entry != nil) [record.pending removeObjectForKey:requestId];
  return entry;
}

// Settling is idempotent: a request that is already settled, or whose client
// instance is gone, has nothing left to answer.
- (void)respondToRequest:(NSString *)requestId tag:(NSString *)tag resultJson:(NSString *)resultJson
{
  [self onMain:^{
    NSDictionary *entry = [self takePending:requestId tag:tag];
    if (entry) ((RCTPromiseResolveBlock)entry[@"resolve"])(resultJson);
  }];
}

- (void)rejectRequest:(NSString *)requestId tag:(NSString *)tag code:(NSString *)code message:(NSString *)message
{
  [self onMain:^{
    NSDictionary *entry = [self takePending:requestId tag:tag];
    if (entry) ((RCTPromiseRejectBlock)entry[@"reject"])(code, message, nil);
  }];
}

- (void)emitToClient:(NSString *)tag eventJson:(NSString *)eventJson
{
  [self onMain:^{
    VibestudioClientRecord *record = self->_clients[tag];
    if (record == nil) return; // A stopped tag drops it.
    id<VibestudioClientEventSink> broker = [self->_brokers objectForKey:tag];
    if (broker) [broker deliverClientEvent:eventJson];
    else [record.queuedEvents addObject:eventJson];
  }];
}

@end
