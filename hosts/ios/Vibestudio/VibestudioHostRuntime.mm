#import <React/RCTBridgeModule.h>
#import <React/RCTEventEmitter.h>

#import "VibestudioArtifactStore.h"
#import "VibestudioClientManager.h"
#import "VibestudioInstances.h"

// The native side of the mobile host runtime. Mirrors `HostRuntimeNativeModule`
// in hosts/react-native/src/host/nativeHostRuntime.ts. Exists for the host
// instance only: every method rejects with `not-host` from any other instance.
// Native carries JSON between client instances and the host runtime's
// JavaScript; it never interprets a request.

static NSString *const VibestudioHostRuntimeEventName = @"VibestudioHostRuntimeEvent";

@interface VibestudioHostRuntime : RCTEventEmitter <RCTBridgeModule, VibestudioHostEventSink>
@end

#define VIBESTUDIO_HOST_ONLY() \
  if (!VibestudioRequireHostBridge(self.bridge, @"VibestudioHostRuntime", reject)) return;

static void VibestudioRejectNativeError(RCTPromiseRejectBlock reject, NSError *error)
{
  NSString *code = error.userInfo[VibestudioArtifactErrorCodeKey] ?: @"native-failed";
  reject(code, error.localizedDescription, error);
}

/// Artifact work hashes and copies files; it must not hold up `respond` and `emit`.
static dispatch_queue_t VibestudioArtifactQueue(void)
{
  static dispatch_queue_t queue;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    queue = dispatch_queue_create("app.vibestudio.host-runtime.artifacts", DISPATCH_QUEUE_CONCURRENT);
  });
  return queue;
}

@implementation VibestudioHostRuntime

RCT_EXPORT_MODULE();

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (NSArray<NSString *> *)supportedEvents
{
  return @[VibestudioHostRuntimeEventName];
}

- (void)deliverHostEvent:(NSString *)eventJson
{
  [self sendEventWithName:VibestudioHostRuntimeEventName body:eventJson];
}

- (void)invalidate
{
  [[VibestudioClientManager shared] hostRuntimeInvalidated:self];
  [super invalidate];
}

#pragma mark Instances

RCT_EXPORT_METHOD(markReady:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  [[VibestudioClientManager shared] hostRuntimeReady:self];
  resolve(nil);
}

RCT_EXPORT_METHOD(startClient:(NSDictionary *)spec
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  [[VibestudioClientManager shared] startClient:spec resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(reloadClient:(NSString *)tag
                  bundle:(NSDictionary *)bundle
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  [[VibestudioClientManager shared] reloadClient:tag bundle:bundle resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(stopClient:(NSString *)tag
                  reason:(NSString *)reason
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  [[VibestudioClientManager shared] stopClient:tag reason:reason resolve:resolve];
}

RCT_EXPORT_METHOD(focusClient:(NSString *)tag
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  [[VibestudioClientManager shared] focusClient:tag resolve:resolve reject:reject];
}

RCT_EXPORT_METHOD(showHostSurface:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  [[VibestudioClientManager shared] showHostSurfaceResolve:resolve];
}

#pragma mark Broker

RCT_EXPORT_METHOD(respond:(NSString *)tag
                  requestId:(NSString *)requestId
                  resultJson:(NSString *)resultJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  [[VibestudioClientManager shared] respondToRequest:requestId tag:tag resultJson:resultJson];
  resolve(nil);
}

RCT_EXPORT_METHOD(reject:(NSString *)tag
                  requestId:(NSString *)requestId
                  code:(NSString *)code
                  message:(NSString *)message
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  [[VibestudioClientManager shared] rejectRequest:requestId tag:tag code:code message:message];
  resolve(nil);
}

RCT_EXPORT_METHOD(emit:(NSString *)tag
                  eventJson:(NSString *)eventJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  [[VibestudioClientManager shared] emitToClient:tag eventJson:eventJson];
  resolve(nil);
}

#pragma mark Artifact store

RCT_EXPORT_METHOD(artifactHas:(NSString *)integrity
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    NSError *error = nil;
    BOOL present = NO;
    if ([[VibestudioArtifactStore shared] hasArtifact:integrity error:&error result:&present]) resolve(@(present));
    else VibestudioRejectNativeError(reject, error);
  });
}

RCT_EXPORT_METHOD(artifactBeginWrite:(NSString *)integrity
                  name:(NSString *)name
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    NSError *error = nil;
    NSString *writeId = [[VibestudioArtifactStore shared] beginWrite:integrity name:name error:&error];
    if (writeId) resolve(writeId);
    else VibestudioRejectNativeError(reject, error);
  });
}

RCT_EXPORT_METHOD(artifactAppend:(NSString *)writeId
                  bytesBase64:(NSString *)bytesBase64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    NSError *error = nil;
    if ([[VibestudioArtifactStore shared] appendToWrite:writeId bytesBase64:bytesBase64 error:&error]) resolve(nil);
    else VibestudioRejectNativeError(reject, error);
  });
}

RCT_EXPORT_METHOD(artifactCommit:(NSString *)writeId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    NSError *error = nil;
    if ([[VibestudioArtifactStore shared] commitWrite:writeId error:&error]) resolve(nil);
    else VibestudioRejectNativeError(reject, error);
  });
}

RCT_EXPORT_METHOD(artifactAbort:(NSString *)writeId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    [[VibestudioArtifactStore shared] abortWrite:writeId];
    resolve(nil);
  });
}

RCT_EXPORT_METHOD(artifactList:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    resolve([[VibestudioArtifactStore shared] listArtifacts]);
  });
}

RCT_EXPORT_METHOD(artifactRemove:(NSString *)integrity
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    NSError *error = nil;
    if ([[VibestudioArtifactStore shared] removeArtifact:integrity error:&error]) resolve(nil);
    else VibestudioRejectNativeError(reject, error);
  });
}

RCT_EXPORT_METHOD(artifactLocate:(NSString *)integrity
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    NSError *error = nil;
    NSString *path = [[VibestudioArtifactStore shared] locateArtifact:integrity error:&error];
    if (path) resolve(path);
    else VibestudioRejectNativeError(reject, error);
  });
}

RCT_EXPORT_METHOD(artifactMaterializeBuild:(NSString *)buildKey
                  entries:(NSArray *)entries
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    NSError *error = nil;
    NSString *directory = [[VibestudioArtifactStore shared] materializeBuild:buildKey entries:entries error:&error];
    if (directory) resolve(directory);
    else VibestudioRejectNativeError(reject, error);
  });
}

RCT_EXPORT_METHOD(artifactRetainBuilds:(NSArray<NSString *> *)keep
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    NSError *error = nil;
    if ([[VibestudioArtifactStore shared] retainBuilds:keep error:&error]) resolve(nil);
    else VibestudioRejectNativeError(reject, error);
  });
}

RCT_EXPORT_METHOD(artifactRead:(NSString *)integrity
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  VIBESTUDIO_HOST_ONLY();
  dispatch_async(VibestudioArtifactQueue(), ^{
    NSError *error = nil;
    NSString *base64 = [[VibestudioArtifactStore shared] readArtifactBase64:integrity error:&error];
    if (base64) resolve(base64);
    else VibestudioRejectNativeError(reject, error);
  });
}

@end
