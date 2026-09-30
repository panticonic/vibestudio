#import <XCTest/XCTest.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <React/RCTBridgeModule.h>
#import <react-native-webview/RNCWebViewImpl.h>

@interface RoutingWebView : WKWebView
@property (nonatomic, strong) NSURL *requestURL;
@property (nonatomic, strong) NSURL *fileURL;
@end
@implementation RoutingWebView
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
- (dispatch_queue_t)methodQueue;
- (void)invalidate;
@end

@interface MobileHostLifecycleTests : XCTestCase
@end

@implementation MobileHostLifecycleTests

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
