#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#import <CommonCrypto/CommonDigest.h>
#import <math.h>
#import "VibestudioInstances.h"

extern WKWebsiteDataStore *VibestudioWorkspaceDataStore(NSString *scope);

// The natives a browser panel needs: the immutable asset store and workspace
// cookie clearing. Client instances only, and only a client granted
// `panel-hosting`; every method rejects with `capability-denied` otherwise
// (the host instance is not a client and cannot use it either).
@interface VibestudioPanelHost : NSObject <RCTBridgeModule, RCTInvalidating>
@property(nonatomic, strong) dispatch_queue_t resourceQueue;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableDictionary *> *assetWrites;
// Several client instances may run at once, each with its own module instance
// over the same blob store; staging is private to the instance that writes it.
@property(nonatomic, copy) NSString *stagingId;
@end

@implementation VibestudioPanelHost

RCT_EXPORT_MODULE();

@synthesize bridge = _bridge;

static NSString *const VibestudioAssetHandlePrefix = @"vibestudio-asset-v1:";
static NSInteger const VibestudioAssetIndexSchema = 1;
static unsigned long long const VibestudioAssetStoreMaxBytes = 256ULL * 1024ULL * 1024ULL;

- (instancetype)init
{
  self = [super init];
  if (self) {
    _resourceQueue = dispatch_queue_create("app.vibestudio.mobile.asset-store", DISPATCH_QUEUE_SERIAL);
    _assetWrites = [NSMutableDictionary dictionary];
    _stagingId = NSUUID.UUID.UUIDString.lowercaseString;
    // Staged writes do not survive the process that owned them.
    static dispatch_once_t staleStagingOnce;
    dispatch_once(&staleStagingOnce, ^{
      [NSFileManager.defaultManager removeItemAtURL:[[self assetStoreRootURL] URLByAppendingPathComponent:@"staging" isDirectory:YES] error:nil];
    });
    [NSFileManager.defaultManager createDirectoryAtURL:[self assetBlobsURL] withIntermediateDirectories:YES attributes:nil error:nil];
    [NSFileManager.defaultManager createDirectoryAtURL:[self assetIndexesURL] withIntermediateDirectories:YES attributes:nil error:nil];
    [[self assetBlobsURL] setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  }
  return self;
}

+ (BOOL)requiresMainQueueSetup
{
  return NO;
}

- (dispatch_queue_t)methodQueue
{
  return self.resourceQueue;
}

- (void)invalidate
{
  dispatch_async(self.resourceQueue, ^{
    [self abortAllAssetWrites];
    [NSFileManager.defaultManager removeItemAtURL:[self assetStagingURL] error:nil];
  });
}

RCT_EXPORT_METHOD(clearWorkspaceCookies:(NSString *)scope resolver:(RCTPromiseResolveBlock)resolve rejecter:(RCTPromiseRejectBlock)reject) {
  if (!VibestudioRequireClientCapability(self.bridge, @"panel-hosting", @"VibestudioPanelHost", reject)) return;
  dispatch_async(dispatch_get_main_queue(), ^{
    if (scope.length == 0) { reject(@"workspace_cookie_clear_failed", @"A workspace browser profile is required", nil); return; }
    [VibestudioWorkspaceDataStore(scope) removeDataOfTypes:[NSSet setWithObject:WKWebsiteDataTypeCookies]
        modifiedSince:[NSDate distantPast] completionHandler:^{ resolve(nil); }];
  });
}


RCT_EXPORT_METHOD(assetStoreLookup:(NSDictionary *)assetNamespace
                  key:(NSString *)key
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!VibestudioRequireClientCapability(self.bridge, @"panel-hosting", @"VibestudioPanelHost", reject)) return;
  @try {
    // A promise resolved with nil has no argument and becomes JS undefined.
    // A cache miss is explicitly null in the shared native store contract.
    resolve([self lookupStoredAsset:assetNamespace key:key] ?: NSNull.null);
  } @catch (NSException *exception) {
    reject(@"asset_store_lookup_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(assetStoreOpenWrite:(NSDictionary *)assetNamespace
                  key:(NSString *)key
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!VibestudioRequireClientCapability(self.bridge, @"panel-hosting", @"VibestudioPanelHost", reject)) return;
  @try {
    NSString *namespaceKey = [self validatedAssetNamespace:assetNamespace];
    [self validateAssetKey:key];
    NSString *writeId = NSUUID.UUID.UUIDString.lowercaseString;
    NSURL *staging = [self assetStagingURL];
    [NSFileManager.defaultManager createDirectoryAtURL:staging withIntermediateDirectories:YES attributes:nil error:nil];
    NSURL *transfer = [staging URLByAppendingPathComponent:[writeId stringByAppendingString:@".transfer"] isDirectory:NO];
    [NSFileManager.defaultManager createFileAtPath:transfer.path contents:nil attributes:nil];
    NSFileHandle *stream = [NSFileHandle fileHandleForWritingAtPath:transfer.path];
    if (!stream) [NSException raise:@"VibestudioAssetStoreOpenFailed" format:@"Could not open asset transfer file"];
    if (!self.assetWrites) self.assetWrites = [NSMutableDictionary dictionary];
    self.assetWrites[writeId] = [@{
      @"namespace": namespaceKey,
      @"key": key,
      @"transferPath": transfer.path,
      @"stream": stream,
      @"size": @0,
    } mutableCopy];
    resolve(writeId);
  } @catch (NSException *exception) {
    reject(@"asset_store_open_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(assetStoreAppend:(NSString *)writeId
                  bytesBase64:(NSString *)bytesBase64
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!VibestudioRequireClientCapability(self.bridge, @"panel-hosting", @"VibestudioPanelHost", reject)) return;
  @try {
    NSMutableDictionary *write = self.assetWrites[writeId];
    if (!write) [NSException raise:@"VibestudioAssetStoreAppendFailed" format:@"Unknown asset-store write handle"];
    NSData *bytes = [[NSData alloc] initWithBase64EncodedString:bytesBase64 options:0];
    if (!bytes) [NSException raise:@"VibestudioAssetStoreAppendFailed" format:@"Asset chunk was not valid base64"];
    [(NSFileHandle *)write[@"stream"] writeData:bytes];
    write[@"size"] = @([write[@"size"] unsignedLongLongValue] + bytes.length);
    resolve(nil);
  } @catch (NSException *exception) {
    [self abortAssetWrite:writeId];
    reject(@"asset_store_append_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(assetStoreCommit:(NSString *)writeId
                  metadataJson:(NSString *)metadataJson
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!VibestudioRequireClientCapability(self.bridge, @"panel-hosting", @"VibestudioPanelHost", reject)) return;
  NSMutableDictionary *write = self.assetWrites[writeId];
  [self.assetWrites removeObjectForKey:writeId];
  if (!write) {
    reject(@"asset_store_commit_failed", @"Unknown asset-store write handle", nil);
    return;
  }
  @try {
    [self validatedAssetMetadata:metadataJson];
    NSFileHandle *stream = write[@"stream"];
    [stream synchronizeFile];
    [stream closeFile];
    NSString *transferPath = write[@"transferPath"];
    NSString *digest = [self sha256File:transferPath];
    unsigned long long size = [write[@"size"] unsignedLongLongValue];
    if (size > VibestudioAssetStoreMaxBytes) {
      [NSException raise:@"VibestudioAssetStoreCommitFailed" format:@"Immutable asset exceeds the durable store byte cap"];
    }
    NSURL *blobs = [self assetBlobsURL];
    [NSFileManager.defaultManager createDirectoryAtURL:blobs withIntermediateDirectories:YES attributes:nil error:nil];
    [blobs setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
    NSURL *blob = [blobs URLByAppendingPathComponent:digest isDirectory:NO];
    BOOL isDirectory = NO;
    if ([NSFileManager.defaultManager fileExistsAtPath:blob.path isDirectory:&isDirectory]) {
      NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:blob.path error:nil];
      if (isDirectory || [attributes fileSize] != size) {
        [NSException raise:@"VibestudioAssetStoreCommitFailed" format:@"Stored asset blob disagrees with its digest record"];
      }
      [NSFileManager.defaultManager removeItemAtPath:transferPath error:nil];
    } else {
      NSError *moveError = nil;
      if (![NSFileManager.defaultManager moveItemAtPath:transferPath toPath:blob.path error:&moveError]) {
        [NSException raise:@"VibestudioAssetStoreCommitFailed" format:@"Could not atomically publish stored asset blob: %@", moveError.localizedDescription];
      }
    }
    NSString *namespaceKey = write[@"namespace"];
    NSMutableDictionary *index = [self readAssetIndex:namespaceKey];
    NSMutableDictionary *entries = index[@"entries"];
    entries[[self sha256Text:write[@"key"]]] = @{
      @"key": write[@"key"],
      @"digest": digest,
      @"size": @(size),
      @"metadataJson": metadataJson,
    };
    [self writeAssetIndex:index namespace:namespaceKey];
    [self trimAssetStore:VibestudioAssetStoreMaxBytes];
    resolve([self storedAssetResult:digest size:size metadataJson:metadataJson]);
  } @catch (NSException *exception) {
    @try { [(NSFileHandle *)write[@"stream"] closeFile]; } @catch (__unused NSException *ignored) {}
    [NSFileManager.defaultManager removeItemAtPath:write[@"transferPath"] error:nil];
    reject(@"asset_store_commit_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(assetStoreAbort:(NSString *)writeId
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!VibestudioRequireClientCapability(self.bridge, @"panel-hosting", @"VibestudioPanelHost", reject)) return;
  [self abortAssetWrite:writeId];
  resolve(nil);
}

RCT_EXPORT_METHOD(assetStoreTrim:(double)maxBytes
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!VibestudioRequireClientCapability(self.bridge, @"panel-hosting", @"VibestudioPanelHost", reject)) return;
  @try {
    if (!isfinite(maxBytes) || maxBytes < 0 || floor(maxBytes) != maxBytes) {
      [NSException raise:@"VibestudioAssetStoreTrimFailed" format:@"Invalid asset-store byte limit"];
    }
    [self trimAssetStore:(unsigned long long)maxBytes];
    resolve(nil);
  } @catch (NSException *exception) {
    reject(@"asset_store_trim_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(assetStoreClear:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!VibestudioRequireClientCapability(self.bridge, @"panel-hosting", @"VibestudioPanelHost", reject)) return;
  @try {
    [self abortAllAssetWrites];
    [NSFileManager.defaultManager removeItemAtURL:[self assetStoreRootURL] error:nil];
    if (self.assetWrites.count != 0) {
      [NSException raise:@"VibestudioAssetStoreClearFailed" format:@"Asset-store clear left active write handles"];
    }
    resolve(nil);
  } @catch (NSException *exception) {
    reject(@"asset_store_clear_failed", exception.reason, nil);
  }
}

- (NSDictionary *)lookupStoredAsset:(NSDictionary *)assetNamespace key:(NSString *)key
{
  NSString *namespaceKey = [self validatedAssetNamespace:assetNamespace];
  [self validateAssetKey:key];
  NSURL *indexURL = [self assetIndexURL:namespaceKey];
  if (![NSFileManager.defaultManager fileExistsAtPath:indexURL.path]) return nil;
  NSMutableDictionary *index = [self readAssetIndex:namespaceKey];
  NSMutableDictionary *entries = index[@"entries"];
  NSString *entryKey = [self sha256Text:key];
  NSDictionary *entry = entries[entryKey];
  if (!entry) return nil;
  if (![entry[@"key"] isEqualToString:key]) {
    [NSException raise:@"VibestudioAssetStoreCorrupt" format:@"Asset-store index key collision"];
  }
  NSString *digest = entry[@"digest"];
  NSNumber *size = entry[@"size"];
  NSString *metadataJson = entry[@"metadataJson"];
  if (![self isAssetDigest:digest] || ![size isKindOfClass:NSNumber.class] || size.longLongValue < 0 || metadataJson.length == 0) {
    [NSException raise:@"VibestudioAssetStoreCorrupt" format:@"Asset-store index entry is corrupt"];
  }
  [self validatedAssetMetadata:metadataJson];
  NSURL *blob = [[self assetBlobsURL] URLByAppendingPathComponent:digest isDirectory:NO];
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:blob.path error:nil];
  if (!attributes || ![attributes.fileType isEqualToString:NSFileTypeRegular] ||
      attributes.fileSize != size.unsignedLongLongValue) {
    // Payloads are reconstructable and excluded from OS backup. Repair a
    // retained index after restore (or a truncated payload) by converting the
    // dangling mapping into a normal cache miss.
    [entries removeObjectForKey:entryKey];
    [self writeAssetIndex:index namespace:namespaceKey];
    return nil;
  }
  [NSFileManager.defaultManager setAttributes:@{NSFileModificationDate: NSDate.date} ofItemAtPath:blob.path error:nil];
  return [self storedAssetResult:digest size:size.unsignedLongLongValue metadataJson:metadataJson];
}

- (NSDictionary *)storedAssetResult:(NSString *)digest size:(unsigned long long)size metadataJson:(NSString *)metadataJson
{
  return @{
    @"handle": [VibestudioAssetHandlePrefix stringByAppendingString:digest],
    @"size": @(size),
    @"metadataJson": metadataJson,
  };
}

- (NSString *)validatedAssetNamespace:(NSDictionary *)assetNamespace
{
  NSString *server = [assetNamespace[@"serverEndpointId"] isKindOfClass:NSString.class]
    ? [assetNamespace[@"serverEndpointId"] lowercaseString] : nil;
  NSString *workspace = [assetNamespace[@"workspaceIdentity"] isKindOfClass:NSString.class]
    ? assetNamespace[@"workspaceIdentity"] : nil;
  if (![self isAssetDigest:server]) {
    [NSException raise:@"VibestudioAssetNamespaceInvalid" format:@"Asset namespace has invalid server Endpoint ID"];
  }
  NSString *nul = [NSString stringWithCharacters:(unichar[]){0} length:1];
  if (workspace.length == 0 || workspace.length > 512 || [workspace rangeOfString:nul].location != NSNotFound) {
    [NSException raise:@"VibestudioAssetNamespaceInvalid" format:@"Asset namespace has invalid workspace identity"];
  }
  return [NSString stringWithFormat:@"%@%C%@", server, (unichar)0, workspace];
}

- (void)validateAssetKey:(NSString *)key
{
  NSString *nul = [NSString stringWithCharacters:(unichar[]){0} length:1];
  if (key.length == 0 || key.length > 16 * 1024 || [key rangeOfString:nul].location != NSNotFound) {
    [NSException raise:@"VibestudioAssetKeyInvalid" format:@"Invalid asset-store key"];
  }
}

- (NSDictionary *)validatedAssetMetadata:(NSString *)metadataJson
{
  if (metadataJson.length == 0 || metadataJson.length > 64 * 1024) {
    [NSException raise:@"VibestudioAssetMetadataInvalid" format:@"Asset metadata is invalid"];
  }
  NSData *data = [metadataJson dataUsingEncoding:NSUTF8StringEncoding];
  NSDictionary *metadata = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
  if (![metadata isKindOfClass:NSDictionary.class] || [metadata[@"status"] integerValue] != 200) {
    [NSException raise:@"VibestudioAssetMetadataInvalid" format:@"Only successful assets can be stored"];
  }
  NSDictionary *headers = metadata[@"replayHeaders"];
  __block BOOL immutable = NO;
  __block BOOL noStore = NO;
  if ([headers isKindOfClass:NSDictionary.class]) {
    [headers enumerateKeysAndObjectsUsingBlock:^(id headerKey, id value, BOOL *stop) {
      if ([headerKey isKindOfClass:NSString.class] && [value isKindOfClass:NSString.class] &&
          [headerKey caseInsensitiveCompare:@"cache-control"] == NSOrderedSame) {
        for (NSString *token in [value componentsSeparatedByString:@","]) {
          if ([[token stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet]
                caseInsensitiveCompare:@"immutable"] == NSOrderedSame) {
            immutable = YES;
          }
          if ([[token stringByTrimmingCharactersInSet:NSCharacterSet.whitespaceCharacterSet]
                caseInsensitiveCompare:@"no-store"] == NSOrderedSame) {
            noStore = YES;
          }
        }
      }
    }];
  }
  if (!immutable || noStore) {
    [NSException raise:@"VibestudioAssetMetadataInvalid" format:@"Only immutable, storable assets can be stored"];
  }
  NSNumber *gzip = metadata[@"gzip"];
  if (![metadata[@"contentType"] isKindOfClass:NSString.class] || [metadata[@"contentType"] length] == 0 ||
      ![gzip isKindOfClass:NSNumber.class] || CFGetTypeID((__bridge CFTypeRef)gzip) != CFBooleanGetTypeID()) {
    [NSException raise:@"VibestudioAssetMetadataInvalid" format:@"Asset metadata fields are invalid"];
  }
  return metadata;
}

- (NSMutableDictionary *)readAssetIndex:(NSString *)namespaceKey
{
  NSURL *url = [self assetIndexURL:namespaceKey];
  if (![NSFileManager.defaultManager fileExistsAtPath:url.path]) {
    return [@{
      @"schemaVersion": @(VibestudioAssetIndexSchema),
      @"namespaceDigest": [self sha256Text:namespaceKey],
      @"entries": [NSMutableDictionary dictionary],
    } mutableCopy];
  }
  NSData *data = [NSData dataWithContentsOfURL:url];
  NSDictionary *parsed = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil] : nil;
  if (![parsed isKindOfClass:NSDictionary.class] ||
      [parsed[@"schemaVersion"] integerValue] != VibestudioAssetIndexSchema ||
      ![parsed[@"namespaceDigest"] isEqualToString:[self sha256Text:namespaceKey]] ||
      ![parsed[@"entries"] isKindOfClass:NSMutableDictionary.class]) {
    [NSException raise:@"VibestudioAssetStoreCorrupt" format:@"Asset-store index is corrupt"];
  }
  return [parsed mutableCopy];
}

- (void)writeAssetIndex:(NSDictionary *)index namespace:(NSString *)namespaceKey
{
  NSURL *indexes = [self assetIndexesURL];
  [NSFileManager.defaultManager createDirectoryAtURL:indexes withIntermediateDirectories:YES attributes:nil error:nil];
  NSData *data = [NSJSONSerialization dataWithJSONObject:index options:0 error:nil];
  if (!data || ![data writeToURL:[self assetIndexURL:namespaceKey] options:NSDataWritingAtomic error:nil]) {
    [NSException raise:@"VibestudioAssetStoreWriteFailed" format:@"Could not atomically publish asset index"];
  }
}

- (void)trimAssetStore:(unsigned long long)maxBytes
{
  NSArray<NSURL *> *blobs = [NSFileManager.defaultManager contentsOfDirectoryAtURL:[self assetBlobsURL]
    includingPropertiesForKeys:@[NSURLIsRegularFileKey, NSURLFileSizeKey, NSURLContentModificationDateKey]
    options:0 error:nil] ?: @[];
  NSMutableArray<NSDictionary *> *candidates = [NSMutableArray array];
  unsigned long long total = 0;
  for (NSURL *url in blobs) {
    NSNumber *regular = nil;
    NSNumber *size = nil;
    NSDate *modified = nil;
    [url getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil];
    [url getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
    [url getResourceValue:&modified forKey:NSURLContentModificationDateKey error:nil];
    if (!regular.boolValue || ![self isAssetDigest:url.lastPathComponent]) continue;
    total += size.unsignedLongLongValue;
    [candidates addObject:@{@"url": url, @"size": size ?: @0, @"modified": modified ?: NSDate.distantPast}];
  }
  if (total <= maxBytes) return;
  [candidates sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    return [left[@"modified"] compare:right[@"modified"]];
  }];
  NSMutableSet<NSString *> *evicted = [NSMutableSet set];
  for (NSDictionary *candidate in candidates) {
    if (total <= maxBytes) break;
    NSURL *url = candidate[@"url"];
    total -= [candidate[@"size"] unsignedLongLongValue];
    [evicted addObject:url.lastPathComponent];
  }
  NSArray<NSURL *> *indexes = [NSFileManager.defaultManager contentsOfDirectoryAtURL:[self assetIndexesURL]
    includingPropertiesForKeys:nil options:0 error:nil] ?: @[];
  for (NSURL *url in indexes) {
    NSData *data = [NSData dataWithContentsOfURL:url];
    NSMutableDictionary *index = data ? [NSJSONSerialization JSONObjectWithData:data options:NSJSONReadingMutableContainers error:nil] : nil;
    NSMutableDictionary *entries = [index[@"entries"] isKindOfClass:NSMutableDictionary.class] ? index[@"entries"] : nil;
    if (!entries) [NSException raise:@"VibestudioAssetStoreCorrupt" format:@"Asset-store index is corrupt"];
    BOOL changed = NO;
    for (NSString *entryKey in entries.allKeys.copy) {
      if ([evicted containsObject:entries[entryKey][@"digest"]]) {
        [entries removeObjectForKey:entryKey];
        changed = YES;
      }
    }
    if (changed) {
      NSData *updated = [NSJSONSerialization dataWithJSONObject:index options:0 error:nil];
      if (!updated || ![updated writeToURL:url options:NSDataWritingAtomic error:nil]) {
        [NSException raise:@"VibestudioAssetStoreWriteFailed" format:@"Could not publish trimmed asset index"];
      }
    }
  }
  for (NSString *digest in evicted) {
    NSError *error = nil;
    if (![NSFileManager.defaultManager removeItemAtURL:[[self assetBlobsURL] URLByAppendingPathComponent:digest] error:&error]) {
      [NSException raise:@"VibestudioAssetStoreWriteFailed" format:@"Could not evict stored asset: %@", error.localizedDescription];
    }
  }
}

- (void)abortAssetWrite:(NSString *)writeId
{
  NSDictionary *write = self.assetWrites[writeId];
  [self.assetWrites removeObjectForKey:writeId];
  if (!write) return;
  @try { [(NSFileHandle *)write[@"stream"] closeFile]; } @catch (__unused NSException *ignored) {}
  [NSFileManager.defaultManager removeItemAtPath:write[@"transferPath"] error:nil];
}

- (void)abortAllAssetWrites
{
  for (NSString *writeId in self.assetWrites.allKeys.copy) [self abortAssetWrite:writeId];
}

- (NSString *)sha256File:(NSString *)path
{
  NSInputStream *input = [NSInputStream inputStreamWithFileAtPath:path];
  [input open];
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  uint8_t buffer[64 * 1024];
  NSInteger count = 0;
  while ((count = [input read:buffer maxLength:sizeof(buffer)]) > 0) CC_SHA256_Update(&context, buffer, (CC_LONG)count);
  [input close];
  if (count < 0) [NSException raise:@"VibestudioAssetStoreReadFailed" format:@"Could not hash stored asset"];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  return [self hexDigest:digest length:CC_SHA256_DIGEST_LENGTH];
}

- (NSString *)sha256Text:(NSString *)text
{
  NSData *data = [text dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  return [self hexDigest:digest length:CC_SHA256_DIGEST_LENGTH];
}

- (NSString *)hexDigest:(const unsigned char *)digest length:(NSUInteger)length
{
  NSMutableString *out = [NSMutableString stringWithCapacity:length * 2];
  for (NSUInteger index = 0; index < length; index++) [out appendFormat:@"%02x", digest[index]];
  return out;
}

- (BOOL)isAssetDigest:(NSString *)value
{
  if (![value isKindOfClass:NSString.class] || value.length != 64) return NO;
  NSCharacterSet *invalid = [[NSCharacterSet characterSetWithCharactersInString:@"0123456789abcdef"] invertedSet];
  return [value rangeOfCharacterFromSet:invalid].location == NSNotFound;
}

- (NSURL *)assetStoreRootURL
{
  NSURL *support = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
  return [support URLByAppendingPathComponent:@"vibestudio-panel-assets" isDirectory:YES];
}

- (NSURL *)assetBlobsURL { return [[self assetStoreRootURL] URLByAppendingPathComponent:@"blobs" isDirectory:YES]; }
- (NSURL *)assetIndexesURL { return [[self assetStoreRootURL] URLByAppendingPathComponent:@"indexes" isDirectory:YES]; }
- (NSURL *)assetStagingURL
{
  return [[[self assetStoreRootURL] URLByAppendingPathComponent:@"staging" isDirectory:YES] URLByAppendingPathComponent:self.stagingId isDirectory:YES];
}
- (NSURL *)assetIndexURL:(NSString *)namespaceKey
{
  return [[self assetIndexesURL] URLByAppendingPathComponent:[[self sha256Text:namespaceKey] stringByAppendingString:@".json"] isDirectory:NO];
}

@end
