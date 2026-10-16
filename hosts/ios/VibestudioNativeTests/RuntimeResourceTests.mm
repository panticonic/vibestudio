#import <XCTest/XCTest.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <React/RCTBridgeModule.h>
#import <React/UIView+React.h>
#import <React/RCTFabricSurface.h>
#import <React/RCTSurfacePresenter.h>
#import <React/RCTSurfaceDelegate.h>
#import <React/RCTSurfaceView.h>
#import <ReactCommon/RCTHost.h>
#import <RCTReactNativeFactory.h>
#import <react-native-webview/RNCWebViewImpl.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>
#include <react/renderer/components/view/ViewComponentDescriptor.h>
#include <future>
#include <thread>

namespace {
using namespace facebook::react;
struct DescriptorConstructionProbe {
  ComponentDescriptorRegistry::Shared registry;
  mutable std::thread reader;
  mutable bool readFinishedBeforePublication = false;
  mutable bool foundBeforePublication = true;
};
ComponentDescriptor::Unique constructDescriptorWithConcurrentReader(const ComponentDescriptorParameters &parameters)
{
  auto probe = std::static_pointer_cast<const DescriptorConstructionProbe>(parameters.flavor);
  auto completed = std::make_shared<std::promise<bool>>();
  auto result = completed->get_future();
  probe->reader = std::thread([probe, completed] {
    completed->set_value(probe->registry->hasComponentDescriptorAt(ViewShadowNode::Handle()));
  });
  probe->readFinishedBeforePublication = result.wait_for(std::chrono::seconds(1)) == std::future_status::ready;
  if (probe->readFinishedBeforePublication) probe->foundBeforePublication = result.get();
  return std::make_unique<const ViewComponentDescriptor>(parameters);
}
}

@interface ComponentRegistryConcurrencyTests : XCTestCase
@end
@implementation ComponentRegistryConcurrencyTests
- (void)testDescriptorConstructionDoesNotBlockReadersUntilPublication
{
  ComponentDescriptorProviderRegistry providers;
  auto context = std::make_shared<const ContextContainer>();
  auto probe = std::make_shared<DescriptorConstructionProbe>();
  probe->registry = providers.createComponentDescriptorRegistry({{}, context, nullptr});
  providers.add({ViewShadowNode::Handle(), ViewShadowNode::Name(), probe, constructDescriptorWithConcurrentReader});
  probe->reader.join();
  XCTAssertTrue(probe->readFinishedBeforePublication);
  XCTAssertFalse(probe->foundBeforePublication);
  XCTAssertTrue(probe->registry->hasComponentDescriptorAt(ViewShadowNode::Handle()));
  probe->registry.reset();
}
@end

@interface RoutingWebView : WKWebView
@property (nonatomic, strong) NSURL *requestURL;
@property (nonatomic, strong) NSURL *fileURL;
@end
@implementation RoutingWebView
- (NSURL *)URL { return self.requestURL; }
- (WKNavigation *)loadRequest:(NSURLRequest *)request { self.requestURL = request.URL; return nil; }
- (WKNavigation *)loadFileURL:(NSURL *)URL allowingReadAccessToURL:(NSURL *)root { self.fileURL = URL; return nil; }
@end

@interface RNCWebViewImpl (SourceRoutingTest)
- (void)visitSource;
- (void)syncCookiesToWebView:(void (^)(void))completion;
@end
@interface SourceRoutingView : RNCWebViewImpl
@end
@implementation SourceRoutingView
- (void)syncCookiesToWebView:(void (^)(void))completion { completion(); }
@end

@interface WorkspaceWebView : RNCWebViewImpl
@property(nonatomic, copy) NSString *workspaceProfile;
@property(nonatomic, copy) RCTDirectEventBlock onWorkspaceWebsiteNotification;
- (void)userContentController:(WKUserContentController *)controller didReceiveScriptMessage:(WKScriptMessage *)message;
- (WKWebViewConfiguration *)setUpWkWebViewConfig;
- (void)resetupScripts:(WKWebViewConfiguration *)configuration;
@end

@interface NotificationOriginFixture : NSObject
@property(nonatomic, copy) NSString *protocol;
@property(nonatomic, copy) NSString *host;
@property(nonatomic, assign) NSInteger port;
@end
@implementation NotificationOriginFixture
@end
@interface NotificationFrameFixture : NSObject
@property(nonatomic, assign, getter=isMainFrame) BOOL mainFrame;
@property(nonatomic, strong) NotificationOriginFixture *securityOrigin;
@end
@implementation NotificationFrameFixture
@end
@interface NotificationMessageFixture : NSObject
@property(nonatomic, copy) NSString *name;
@property(nonatomic, copy) NSString *body;
@property(nonatomic, strong) NotificationFrameFixture *frameInfo;
@end
@implementation NotificationMessageFixture
@end

@interface WorkspaceScriptLifecycleTests : XCTestCase
@end
@implementation WorkspaceScriptLifecycleTests
- (void)testNotificationArgumentsAcceptJsonFragmentsAndRejectMalformedRequests
{
  void (^check)(void) = ^{
    WorkspaceWebView *owner = [WorkspaceWebView new];
    owner.reactTag = @1;
    RoutingWebView *webView = [RoutingWebView new];
    webView.requestURL = [NSURL URLWithString:@"https://example.com/"];
    [owner setValue:webView forKey:@"_webView"];
    NotificationOriginFixture *origin = [NotificationOriginFixture new];
    origin.protocol = @"https"; origin.host = @"example.com"; origin.port = 443;
    NotificationFrameFixture *frame = [NotificationFrameFixture new];
    frame.mainFrame = YES; frame.securityOrigin = origin;
    NotificationMessageFixture *message = [NotificationMessageFixture new];
    message.name = @"vibestudioWebsiteNotifications"; message.frameInfo = frame;
    NSMutableArray *arguments = [NSMutableArray new];
    owner.onWorkspaceWebsiteNotification = ^(NSDictionary *event) { [arguments addObject:event[@"argsJson"]]; };
    for (NSString *body in @[@"[]", @"invalid json", @"{\"requestId\":\"null-args\",\"method\":\"permissionState\",\"args\":null}", @"{\"requestId\":\"string-args\",\"method\":\"permissionState\",\"args\":\"test\"}"]) {
      message.body = body;
      XCTAssertNoThrow([owner userContentController:nil didReceiveScriptMessage:(WKScriptMessage *)message]);
    }
    XCTAssertEqualObjects(arguments, (@[@"null", @"\"test\""]));
    owner.onWorkspaceWebsiteNotification = nil;
    message.body = @"{\"requestId\":\"no-host\",\"method\":\"permissionState\"}";
    XCTAssertNoThrow([owner userContentController:nil didReceiveScriptMessage:(WKScriptMessage *)message]);
  };
  if (NSThread.isMainThread) check();
  else dispatch_sync(dispatch_get_main_queue(), check);
}

- (void)testWorkspaceAdaptersAreAvailableToStartupScriptsAfterEveryRebuild
{
  XCTestExpectation *loaded = [self expectationWithDescription:@"Both documents execute their startup bridge"];
  loaded.expectedFulfillmentCount = 2;
  NSMutableArray *retainedViews = [NSMutableArray new];
  dispatch_async(dispatch_get_main_queue(), ^{
    WorkspaceWebView *owner = [WorkspaceWebView new];
    XCTAssertTrue(owner.javaScriptEnabled);
    owner.workspaceProfile = [@"native-script-test:" stringByAppendingString:NSUUID.UUID.UUIDString];
    owner.messagingEnabled = YES;
    NSString *startup = @"window.ReactNativeWebView.postMessage(typeof globalThis.__vibestudioWorkspaceNative + ',' + typeof globalThis.__vibestudioWebsiteNotificationsNative);";
    owner.injectedJavaScriptBeforeContentLoaded = startup;
    WKWebViewConfiguration *configuration = [owner setUpWkWebViewConfig];
    configuration.websiteDataStore = [WKWebsiteDataStore nonPersistentDataStore];
    XCTAssertTrue([configuration.userContentController.userScripts containsObject:[owner valueForKey:@"postMessageScript"]], @"Script rebuilding must preserve the inherited message bridge");
    WKWebView *webView = [[WKWebView alloc] initWithFrame:CGRectMake(0, 0, 320, 480) configuration:configuration];
    [owner setValue:webView forKey:@"_webView"];
    __weak WorkspaceWebView *weakOwner = owner;
    __weak WKWebView *weakWebView = webView;
    __block NSUInteger documents = 0;
    owner.onMessage = ^(NSDictionary *event) {
      XCTAssertEqualObjects(event[@"data"], @"object,object");
      documents += 1;
      [loaded fulfill];
      if (documents == 1) {
        weakOwner.injectedJavaScriptBeforeContentLoaded = [startup stringByAppendingString:@"true;"];
        [weakWebView loadHTMLString:@"<!doctype html><html><body>Rebuilt native script fixture</body></html>" baseURL:nil];
      }
    };
    UIWindowScene *scene = (UIWindowScene *)UIApplication.sharedApplication.connectedScenes.anyObject;
    UIWindow *window = [[UIWindow alloc] initWithWindowScene:scene];
    UIViewController *controller = [UIViewController new];
    controller.view = webView;
    window.rootViewController = controller;
    window.hidden = NO;
    [retainedViews addObjectsFromArray:@[owner, window]];
    [webView loadHTMLString:@"<!doctype html><html><body>Native script lifecycle fixture</body></html>" baseURL:nil];
  });
  [self waitForExpectations:@[loaded] timeout:30];
  void (^cleanup)(void) = ^{
    for (id object in retainedViews) if ([object isKindOfClass:UIWindow.class]) ((UIWindow *)object).hidden = YES;
    [retainedViews removeAllObjects];
  };
  if (NSThread.isMainThread) cleanup();
  else dispatch_sync(dispatch_get_main_queue(), cleanup);
}

@end

@interface WebViewSourceRoutingTests : XCTestCase
@end
@implementation WebViewSourceRoutingTests
- (void)testOnlyFileURLsUseTheFileLoader
{
  XCTestExpectation *checked = [self expectationWithDescription:@"WebKit receives the correct URL loader"];
  dispatch_async(dispatch_get_main_queue(), ^{
    for (NSString *uri in @[@"about:blank", @"data:text/html,hello", @"https://example.com/", @"vibestudio-panel://panel/index.html", @"file:///tmp/panel.html"]) {
      SourceRoutingView *view = [SourceRoutingView new];
      RoutingWebView *webView = [RoutingWebView new];
      [view setValue:webView forKey:@"_webView"];
      view.source = @{@"uri": uri};
      NSURL *url = [NSURL URLWithString:uri];
      XCTAssertEqualObjects(url.isFileURL ? webView.fileURL : webView.requestURL, url);
      XCTAssertNil(url.isFileURL ? webView.requestURL : webView.fileURL);
    }
    [checked fulfill];
  });
  [self waitForExpectations:@[checked] timeout:5];
}
@end

@interface VibestudioAuthSession : NSObject
- (void)invalidate;
- (void)start:(NSDictionary *)options resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (void)authSessionTimedOut;
@end

@interface AuthLifecycleTests : XCTestCase
@end

@implementation AuthLifecycleTests

- (void)testInvalidationCancelsTimeoutAndReleasesTheRuntime
{
  XCTestExpectation *ended = [self expectationWithDescription:@"Pending OAuth rejected once"];
  ended.assertForOverFulfill = YES;
  __block __weak VibestudioAuthSession *retired;
  __block NSTimer *timer;
  void (^prepare)(void) = ^{
    VibestudioAuthSession *module = [VibestudioAuthSession new];
    retired = module;
    timer = [NSTimer scheduledTimerWithTimeInterval:60 target:module selector:@selector(authSessionTimedOut) userInfo:nil repeats:NO];
    [module setValue:timer forKey:@"timeoutTimer"];
    ASWebAuthenticationSession *session = [[ASWebAuthenticationSession alloc]
      initWithURL:[NSURL URLWithString:@"https://example.com/oauth"]
      callbackURLScheme:@"vibestudio" completionHandler:^(NSURL *url, NSError *error) {}];
    [module setValue:session forKey:@"session"];
    [module setValue:^(NSString *code, NSString *message, NSError *error) {
      XCTAssertEqualObjects(code, @"auth_session_invalidated");
      [ended fulfill];
    } forKey:@"pendingReject"];
    [module invalidate];
    [module invalidate];
  };
  if (NSThread.isMainThread) prepare();
  else dispatch_sync(dispatch_get_main_queue(), prepare);
  [self waitForExpectations:@[ended] timeout:5];
  XCTAssertFalse(timer.valid);
  NSPredicate *released = [NSPredicate predicateWithBlock:^BOOL(id object, NSDictionary *bindings) { return retired == nil; }];
  XCTNSPredicateExpectation *release = [[XCTNSPredicateExpectation alloc] initWithPredicate:released object:nil];
  [self waitForExpectations:@[release] timeout:5];
}

- (void)testInvalidatedRuntimeRejectsNewOAuthWithoutOpeningASession
{
  XCTestExpectation *ended = [self expectationWithDescription:@"Retired runtime refuses OAuth"];
  VibestudioAuthSession *module = [VibestudioAuthSession new];
  [module invalidate];
  [module start:@{@"authUrl": @"https://example.com/oauth", @"callbackScheme": @"vibestudio"}
    resolver:^(id value) { XCTFail(@"Retired runtime started OAuth"); }
    rejecter:^(NSString *code, NSString *message, NSError *error) {
      XCTAssertEqualObjects(code, @"auth_session_invalidated");
      XCTAssertNil([module valueForKey:@"session"]);
      [ended fulfill];
    }];
  [self waitForExpectations:@[ended] timeout:5];
}

@end

@interface VibestudioMobileHost : NSObject
- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller;
- (void)assetStoreLookup:(NSDictionary *)assetNamespace key:(NSString *)key resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject;
- (dispatch_queue_t)methodQueue;
- (void)invalidate;
@end

@interface MobileHostLifecycleTests : XCTestCase
@end

@implementation MobileHostLifecycleTests

- (void)testBrowserPickerCancellationResolvesExplicitNullOnce
{
  VibestudioMobileHost *module = [VibestudioMobileHost new];
  XCTestExpectation *cancelled = [self expectationWithDescription:@"Picker cancellation is a bridge null"];
  dispatch_async(dispatch_get_main_queue(), ^{
    __block NSUInteger resolutions = 0;
    RCTPromiseResolveBlock resolve = ^(id result) {
      resolutions += 1;
      XCTAssertEqualObjects(result, NSNull.null);
    };
    [module setValue:[resolve copy] forKey:@"browserImportPickerResolve"];
    [module documentPickerWasCancelled:nil];
    [module documentPickerWasCancelled:nil];
    XCTAssertEqual(resolutions, 1U);
    XCTAssertNil([module valueForKey:@"browserImportPickerResolve"]);
    XCTAssertNil([module valueForKey:@"browserImportPickerReject"]);
    [module invalidate];
    [cancelled fulfill];
  });
  [self waitForExpectations:@[cancelled] timeout:5];
}

- (void)testAssetCacheMissResolvesExplicitNull
{
  VibestudioMobileHost *module = [VibestudioMobileHost new];
  NSDictionary *assetNamespace = @{
    @"serverEndpointId": [@"a" stringByPaddingToLength:64 withString:@"a" startingAtIndex:0],
    @"workspaceIdentity": NSUUID.UUID.UUIDString,
  };
  XCTestExpectation *resolved = [self expectationWithDescription:@"Cache miss is an explicit bridge null"];
  dispatch_async([module methodQueue], ^{
    [module assetStoreLookup:assetNamespace key:@"/missing-native-test-asset" resolver:^(id result) {
      XCTAssertEqualObjects(result, NSNull.null);
      [resolved fulfill];
    } rejecter:^(NSString *code, NSString *message, NSError *error) {
      XCTFail(@"Cache lookup rejected: %@ %@", code, message);
      [resolved fulfill];
    }];
    [module invalidate];
  });
  [self waitForExpectations:@[resolved] timeout:5];
}

- (void)testRuntimeRetirementRemovesOnlyOwnedTransientFiles
{
  VibestudioMobileHost *module = [VibestudioMobileHost new];
  XCTAssertEqual([module methodQueue], [module methodQueue]);
  NSString *root = [NSTemporaryDirectory() stringByAppendingPathComponent:NSUUID.UUID.UUIDString];
  [NSFileManager.defaultManager createDirectoryAtPath:root withIntermediateDirectories:YES attributes:nil error:nil];
  NSString *transfer = [root stringByAppendingPathComponent:@"bundle.transfer"];
  NSString *asset = [root stringByAppendingPathComponent:@"asset.transfer"];
  NSString *archive = [root stringByAppendingPathComponent:@"browser.zip"];
  NSString *committed = [root stringByAppendingPathComponent:@"committed.bundle"];
  for (NSString *path in @[transfer, asset, archive, committed]) {
    [NSFileManager.defaultManager createFileAtPath:path contents:[@"test" dataUsingEncoding:NSUTF8StringEncoding] attributes:nil];
  }
  XCTestExpectation *cleaned = [self expectationWithDescription:@"Native staging resources retired"];
  dispatch_async([module methodQueue], ^{
    [module setValue:[NSFileHandle fileHandleForWritingAtPath:transfer] forKey:@"bundleStream"];
    [module setValue:transfer forKey:@"bundleTransferPath"];
    [module setValue:committed forKey:@"bundleFinalPath"];
    [module setValue:[@{@"write": [@{@"transferPath": asset, @"stream": [NSFileHandle fileHandleForWritingAtPath:asset]} mutableCopy]} mutableCopy] forKey:@"assetWrites"];
    [module setValue:[@{@"archive": [@{@"path": archive} mutableCopy]} mutableCopy] forKey:@"browserImportArchives"];
    [module invalidate];
    [module invalidate];
    dispatch_async([module methodQueue], ^{
      XCTAssertNil([module valueForKey:@"bundleStream"]);
      XCTAssertEqual([(NSDictionary *)[module valueForKey:@"assetWrites"] count], 0U);
      XCTAssertEqual([(NSDictionary *)[module valueForKey:@"browserImportArchives"] count], 0U);
      for (NSString *path in @[transfer, asset, archive]) XCTAssertFalse([NSFileManager.defaultManager fileExistsAtPath:path]);
      XCTAssertTrue([NSFileManager.defaultManager fileExistsAtPath:committed]);
      [cleaned fulfill];
    });
  });
  [self waitForExpectations:@[cleaned] timeout:5];
  [NSFileManager.defaultManager removeItemAtPath:root error:nil];
}

@end

#import <React/RCTStatusBarManager.h>
#import <React/RCTUtils.h>
#import <React-RCTAppDelegate/RCTDefaultReactNativeFactoryDelegate.h>

@interface RCTStatusBarManager (NativeTestMethods)
- (void)setStyle:(NSString *)style animated:(BOOL)animated;
- (void)setHidden:(BOOL)hidden withAnimation:(NSString *)animation;
@end

@interface StatusBarLifecycleTests : XCTestCase
@end

@implementation StatusBarLifecycleTests

- (void)testStatusBarModuleUpdatesTheSceneRootController
{
  XCTestExpectation *updated = [self expectationWithDescription:@"Status bar attributes reach the scene controller"];
  dispatch_async(dispatch_get_main_queue(), ^{
    XCTAssertNotEqualObjects([NSBundle.mainBundle objectForInfoDictionaryKey:@"UIViewControllerBasedStatusBarAppearance"], @NO);
    UIViewController *root = RCTKeyWindow().rootViewController;
    XCTAssertTrue([root isKindOfClass:RCTStatusBarViewController.class]);
    if (![root isKindOfClass:RCTStatusBarViewController.class]) { [updated fulfill]; return; }
    RCTStatusBarViewController *controller = (RCTStatusBarViewController *)root;
    UIStatusBarStyle originalStyle = controller.preferredStatusBarStyle;
    BOOL originalHidden = controller.prefersStatusBarHidden;
    UIStatusBarAnimation originalAnimation = controller.preferredStatusBarUpdateAnimation;
    RCTStatusBarManager *manager = [RCTStatusBarManager new];
    [manager setStyle:@"dark-content" animated:NO];
    [manager setHidden:YES withAnimation:@"fade"];
    dispatch_async(dispatch_get_main_queue(), ^{
      XCTAssertEqual(controller.preferredStatusBarStyle, UIStatusBarStyleDarkContent);
      XCTAssertTrue(controller.prefersStatusBarHidden);
      XCTAssertEqual(controller.preferredStatusBarUpdateAnimation, UIStatusBarAnimationFade);
      controller.reactStatusBarStyle = originalStyle;
      controller.reactStatusBarHidden = originalHidden;
      controller.reactStatusBarAnimation = originalAnimation;
      [controller setNeedsStatusBarAppearanceUpdate];
      [updated fulfill];
    });
  });
  [self waitForExpectations:@[updated] timeout:5];
}

- (void)testReplacementFactoryStartsWithANewAppearanceOwner
{
  RCTDefaultReactNativeFactoryDelegate *factory = [RCTDefaultReactNativeFactoryDelegate new];
  RCTStatusBarViewController *old = (RCTStatusBarViewController *)[factory createRootViewController];
  XCTAssertTrue([old isKindOfClass:RCTStatusBarViewController.class]);
  old.reactStatusBarHidden = YES;
  old.reactStatusBarStyle = UIStatusBarStyleLightContent;
  RCTStatusBarViewController *replacement = (RCTStatusBarViewController *)[factory createRootViewController];
  XCTAssertNotEqual(old, replacement);
  XCTAssertFalse(replacement.prefersStatusBarHidden);
  XCTAssertEqual(replacement.preferredStatusBarStyle, UIStatusBarStyleDefault);
}

@end

@interface FabricSurfaceLifecycleTests : XCTestCase <RCTSurfaceDelegate>
@property(nonatomic, strong) XCTestExpectation *running;
@end
@implementation FabricSurfaceLifecycleTests
- (RCTSurfacePresenter *)isolatedPresenter
{
  id appDelegate = UIApplication.sharedApplication.delegate;
  RCTReactNativeFactory *factory = [appDelegate valueForKey:@"reactNativeFactory"];
  RCTSurfacePresenter *hostPresenter = factory.rootViewFactory.reactHost.surfacePresenter;
  XCTAssertNotNil(hostPresenter);
  if (!hostPresenter) return nil;
  return [[RCTSurfacePresenter alloc] initWithContextContainer:hostPresenter.contextContainer
      runtimeExecutor:[](std::function<void(facebook::jsi::Runtime &)> &&callback) {}
      bridgelessBindingsExecutor:std::nullopt];
}
- (void)surface:(RCTSurface *)surface didChangeStage:(RCTSurfaceStage)stage
{
  if (stage == RCTSurfaceStageRunning) [self.running fulfill];
}
- (void)testRepeatedStartsQueueOnlyOneAttachment
{
  self.running = [self expectationWithDescription:@"The empty surface starts exactly once"];
  __block RCTSurfacePresenter *presenter;
  __block RCTFabricSurface *surface;
  dispatch_async(dispatch_get_main_queue(), ^{
    presenter = [self isolatedPresenter];
    if (!presenter) { [self.running fulfill]; return; }
    surface = [[RCTFabricSurface alloc] initWithSurfacePresenter:presenter moduleName:@"" initialProperties:@{}];
    surface.delegate = self;
    // Hold the main queue while both callers request a start. Neither queued
    // attachment can run yet, so this reproduces the Registered/Starting gap.
    dispatch_sync(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      [surface start];
      [surface start];
    });
  });
  [self waitForExpectations:@[self.running] timeout:10];
  void (^cleanup)(void) = ^{
    XCTAssertEqual(surface.view.subviews.count, 1U);
    [surface stop];
    [presenter unregisterSurface:surface];
    surface = nil;
    presenter = nil;
  };
  if (NSThread.isMainThread) cleanup();
  else dispatch_sync(dispatch_get_main_queue(), cleanup);
}
- (void)testStopCancelsAnAttachmentQueuedBeforeTheMainQueueRuns
{
  XCTestExpectation *drained = [self expectationWithDescription:@"Cancelled attachment drains"];
  dispatch_async(dispatch_get_main_queue(), ^{
    RCTSurfacePresenter *presenter = [self isolatedPresenter];
    if (!presenter) { [drained fulfill]; return; }
    RCTFabricSurface *surface = [[RCTFabricSurface alloc] initWithSurfacePresenter:presenter moduleName:@"" initialProperties:@{}];
    dispatch_sync(dispatch_get_global_queue(QOS_CLASS_USER_INITIATED, 0), ^{
      [surface start];
      [surface stop];
    });
    [presenter unregisterSurface:surface];
    dispatch_async(dispatch_get_main_queue(), ^{
      XCTAssertEqual(surface.view.subviews.count, 0U);
      [drained fulfill];
    });
  });
  [self waitForExpectations:@[drained] timeout:10];
}
@end
