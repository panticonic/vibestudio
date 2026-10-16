#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>

NS_ASSUME_NONNULL_BEGIN

// React Native instances are told apart by the launch options native code gives
// them. Launch options are written by native code only, so an instance's JS
// cannot claim another role. A module reads them through its own `bridge`
// (an `RCTBridge`, or the per-instance `RCTBridgeProxy` in bridgeless mode).
extern NSString *const VibestudioInstanceRoleKey;
extern NSString *const VibestudioInstanceRoleHost;
extern NSString *const VibestudioInstanceRoleClient;
/// Client instances only: the client principal tag (`client:<id>:react-native:<deviceId>`).
extern NSString *const VibestudioInstanceTagKey;
/// Client instances only: the capabilities granted when the instance was started.
extern NSString *const VibestudioInstanceCapabilitiesKey;

/// Launch options of the host instance: the app's own options plus the host role.
NSDictionary *VibestudioHostLaunchOptions(NSDictionary *_Nullable appLaunchOptions);
NSDictionary *VibestudioClientLaunchOptions(NSString *tag, NSArray<NSString *> *capabilities);

BOOL VibestudioBridgeIsHost(id _Nullable bridge);
/// The tag of the client instance that owns `bridge`, or nil for any other instance.
NSString *_Nullable VibestudioBridgeClientTag(id _Nullable bridge);
/// True only for a client instance that was granted `capability`.
BOOL VibestudioBridgeHasCapability(id _Nullable bridge, NSString *capability);

/// Rejects `reject` and returns NO unless `bridge` is the host instance's.
BOOL VibestudioRequireHostBridge(id _Nullable bridge, NSString *moduleName, RCTPromiseRejectBlock reject);
/// Rejects `reject` and returns NO unless `bridge` belongs to a client granted `capability`.
BOOL VibestudioRequireClientCapability(id _Nullable bridge, NSString *capability, NSString *moduleName, RCTPromiseRejectBlock reject);

NS_ASSUME_NONNULL_END
