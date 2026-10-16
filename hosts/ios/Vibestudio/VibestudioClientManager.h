#import <UIKit/UIKit.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

/// Receives JSON events for the host runtime's JavaScript (implemented by `VibestudioHostRuntime`).
@protocol VibestudioHostEventSink <NSObject>
- (void)deliverHostEvent:(NSString *)eventJson;
@end

/// Receives JSON events for one client instance's JavaScript (implemented by `VibestudioClientBroker`).
@protocol VibestudioClientEventSink <NSObject>
- (void)deliverClientEvent:(NSString *)eventJson;
@end

/**
 * Owns every React Native instance of the app (docs/client-hosts-and-clients-plan.md §5.4).
 *
 * The host instance starts with the process and outlives every scene. Client
 * instances are created from verified bundle files and shown by swapping the
 * window's root view controller. Native never interprets what a client asks:
 * requests are forwarded to the host runtime as `client-request` events and
 * answered by the host through `respond` / `reject`.
 *
 * All state lives on the main queue; every entry point may be called from any thread.
 */
@interface VibestudioClientManager : NSObject

+ (instancetype)shared;

#pragma mark App and scene

/// Create and start the host instance headlessly. Called once, before any scene.
- (void)startHostWithLaunchOptions:(NSDictionary *)launchOptions;
/// The scene's window: show whichever surface is in front in it.
- (void)attachWindow:(UIWindow *)window;
/// The scene went away: release its window so the surfaces can be shown in the next one.
- (void)detachWindow:(UIWindow *)window;
/// Links reach the host runtime's JavaScript through the Linking module once the host is ready.
- (void)openURL:(NSURL *)url options:(NSDictionary *)options;
- (void)continueUserActivity:(NSUserActivity *)activity;

#pragma mark Host runtime (module VibestudioHostRuntime)

- (void)hostRuntimeReady:(id<VibestudioHostEventSink>)sink;
- (void)hostRuntimeInvalidated:(id<VibestudioHostEventSink>)sink;
- (void)startClient:(NSDictionary *)spec resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)reloadClient:(NSString *)tag bundle:(NSDictionary *)bundle resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)stopClient:(NSString *)tag reason:(NSString *)reason resolve:(RCTPromiseResolveBlock)resolve;
- (void)focusClient:(NSString *)tag resolve:(RCTPromiseResolveBlock)resolve reject:(RCTPromiseRejectBlock)reject;
- (void)showHostSurfaceResolve:(RCTPromiseResolveBlock)resolve;
- (void)respondToRequest:(NSString *)requestId tag:(NSString *)tag resultJson:(NSString *)resultJson;
- (void)rejectRequest:(NSString *)requestId tag:(NSString *)tag code:(NSString *)code message:(NSString *)message;
- (void)emitToClient:(NSString *)tag eventJson:(NSString *)eventJson;

#pragma mark Client broker (module VibestudioClientBroker)

- (void)brokerAttached:(id<VibestudioClientEventSink>)broker tag:(NSString *)tag;
- (void)brokerDetached:(id<VibestudioClientEventSink>)broker tag:(NSString *)tag;
- (void)clientRequest:(NSString *)tag
               method:(NSString *)method
             argsJson:(NSString *)argsJson
              resolve:(RCTPromiseResolveBlock)resolve
               reject:(RCTPromiseRejectBlock)reject;

@end

NS_ASSUME_NONNULL_END
