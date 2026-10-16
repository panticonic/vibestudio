#import "VibestudioInstances.h"
#import <React/RCTBridge.h>

NSString *const VibestudioInstanceRoleKey = @"vibestudio.instance.role";
NSString *const VibestudioInstanceRoleHost = @"host";
NSString *const VibestudioInstanceRoleClient = @"client";
NSString *const VibestudioInstanceTagKey = @"vibestudio.instance.tag";
NSString *const VibestudioInstanceCapabilitiesKey = @"vibestudio.instance.capabilities";

NSDictionary *VibestudioHostLaunchOptions(NSDictionary *appLaunchOptions)
{
  NSMutableDictionary *options = [(appLaunchOptions ?: @{}) mutableCopy];
  options[VibestudioInstanceRoleKey] = VibestudioInstanceRoleHost;
  return options;
}

NSDictionary *VibestudioClientLaunchOptions(NSString *tag, NSArray<NSString *> *capabilities)
{
  return @{
    VibestudioInstanceRoleKey: VibestudioInstanceRoleClient,
    VibestudioInstanceTagKey: tag,
    VibestudioInstanceCapabilitiesKey: capabilities,
  };
}

static NSDictionary *VibestudioBridgeLaunchOptions(id bridge)
{
  if (bridge == nil || ![bridge respondsToSelector:@selector(launchOptions)]) return nil;
  id options = [bridge launchOptions];
  return [options isKindOfClass:NSDictionary.class] ? options : nil;
}

BOOL VibestudioBridgeIsHost(id bridge)
{
  return [VibestudioBridgeLaunchOptions(bridge)[VibestudioInstanceRoleKey] isEqual:VibestudioInstanceRoleHost];
}

NSString *VibestudioBridgeClientTag(id bridge)
{
  NSDictionary *options = VibestudioBridgeLaunchOptions(bridge);
  if (![options[VibestudioInstanceRoleKey] isEqual:VibestudioInstanceRoleClient]) return nil;
  id tag = options[VibestudioInstanceTagKey];
  return [tag isKindOfClass:NSString.class] && [tag length] > 0 ? tag : nil;
}

BOOL VibestudioBridgeHasCapability(id bridge, NSString *capability)
{
  if (VibestudioBridgeClientTag(bridge) == nil) return NO;
  id granted = VibestudioBridgeLaunchOptions(bridge)[VibestudioInstanceCapabilitiesKey];
  return [granted isKindOfClass:NSArray.class] && [granted containsObject:capability];
}

BOOL VibestudioRequireHostBridge(id bridge, NSString *moduleName, RCTPromiseRejectBlock reject)
{
  if (VibestudioBridgeIsHost(bridge)) return YES;
  reject(@"not-host", [NSString stringWithFormat:@"%@ is available to the host runtime only", moduleName], nil);
  return NO;
}

BOOL VibestudioRequireClientCapability(id bridge, NSString *capability, NSString *moduleName, RCTPromiseRejectBlock reject)
{
  if (VibestudioBridgeHasCapability(bridge, capability)) return YES;
  reject(@"capability-denied",
         [NSString stringWithFormat:@"%@ requires the %@ capability", moduleName, capability], nil);
  return NO;
}
