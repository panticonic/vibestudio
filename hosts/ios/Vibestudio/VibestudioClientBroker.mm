#import <React/RCTBridge.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInitializing.h>
#import <React/RCTInvalidating.h>

#import "VibestudioClientManager.h"
#import "VibestudioInstances.h"

// The only door a client instance has to the device. Mirrors the native side of
// `createNativeChannel` in packages/rn-client-api/src/native.ts. The instance's
// tag comes from the launch options native code gave this instance, so a client
// cannot name another one. Requests wait, as promises, until the host runtime
// has called markReady; there is no timeout.

static NSString *const VibestudioClientEventName = @"VibestudioClientEvent";

@interface VibestudioClientBroker : NSObject <RCTBridgeModule, RCTInitializing, RCTInvalidating, VibestudioClientEventSink>
@end

@implementation VibestudioClientBroker

RCT_EXPORT_MODULE();

@synthesize bridge = _bridge;
@synthesize callableJSModules = _callableJSModules;

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSString *)tag
{
  return VibestudioBridgeClientTag(_bridge);
}

// `initialize` runs after the bridge and callableJSModules are attached.
- (void)initialize
{
  NSString *tag = [self tag];
  if (tag != nil) [[VibestudioClientManager shared] brokerAttached:self tag:tag];
}

- (void)invalidate
{
  NSString *tag = [self tag];
  if (tag != nil) [[VibestudioClientManager shared] brokerDetached:self tag:tag];
}

- (void)deliverClientEvent:(NSString *)eventJson
{
  [_callableJSModules invokeModule:@"RCTDeviceEventEmitter"
                            method:@"emit"
                          withArgs:@[VibestudioClientEventName, eventJson]];
}

RCT_EXPORT_METHOD(request:(NSString *)method
                  argsJson:(NSString *)argsJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  NSString *tag = [self tag];
  if (tag == nil) {
    reject(@"not-client", @"VibestudioClientBroker serves client instances only", nil);
    return;
  }
  [[VibestudioClientManager shared] clientRequest:tag method:method argsJson:argsJson resolve:resolve reject:reject];
}

@end
