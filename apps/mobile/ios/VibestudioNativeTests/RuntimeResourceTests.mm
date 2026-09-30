#import <XCTest/XCTest.h>
#import <AuthenticationServices/AuthenticationServices.h>
#import <React/RCTBridgeModule.h>

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
