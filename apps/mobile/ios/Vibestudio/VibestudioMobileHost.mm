#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTReloadCommand.h>
#import <CommonCrypto/CommonDigest.h>
#import <math.h>
#import <zlib.h>

@interface VibestudioMobileHost : NSObject <RCTBridgeModule>
@property(nonatomic, strong) NSFileHandle *bundleStream;
@property(nonatomic, copy) NSString *bundleTransferPath;
@property(nonatomic, copy) NSString *bundleFinalPath;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableDictionary *> *assetWrites;
@end

@implementation VibestudioMobileHost

RCT_EXPORT_MODULE();

static NSString *const VibestudioActiveBundleLocalPath = @"activeBundle.localPath";
static NSString *const VibestudioActiveBundleBuildKey = @"activeBundle.buildKey";
static NSString *const VibestudioActiveBundleIntegrity = @"activeBundle.integrity";
static NSString *const VibestudioActiveBundleSource = @"activeBundle.source";
static NSString *const VibestudioAssetHandlePrefix = @"vibestudio-asset-v1:";
static NSInteger const VibestudioAssetIndexSchema = 1;
static unsigned long long const VibestudioAssetStoreMaxBytes = 256ULL * 1024ULL * 1024ULL;

- (instancetype)init
{
  self = [super init];
  if (self) {
    _assetWrites = [NSMutableDictionary dictionary];
    [NSFileManager.defaultManager removeItemAtURL:[self assetStagingURL] error:nil];
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
  return dispatch_queue_create("app.vibestudio.mobile.asset-store", DISPATCH_QUEUE_SERIAL);
}

- (NSDictionary *)constantsToExport
{
  BOOL firebaseConfigured = [[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"] != nil;
  return @{ @"firebaseConfigured": @(firebaseConfigured) };
}

RCT_EXPORT_METHOD(resetToNativeBootstrap:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    [self closeBundleStream];
    [self clearActiveBundle];
    resolve(@{ @"reloading": @YES });
    dispatch_async(dispatch_get_main_queue(), ^{
      RCTReloadCommandSetBundleURL(nil);
      RCTTriggerReloadCommandListeners(@"Vibestudio mobile host reset");
    });
  } @catch (NSException *exception) {
    reject(@"bootstrap_reset_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(appendBundleChunk:(NSString *)bytesBase64
                  buildKey:(NSString *)buildKey
                  artifactPath:(NSString *)artifactPath
                  reset:(BOOL)reset
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    if (reset) {
      [self closeBundleStream];
      NSString *safeBuildKey = [self safePathSegment:buildKey];
      NSString *safeArtifact = [self safePathSegment:artifactPath];
      NSURL *cacheURL = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject];
      NSURL *dirURL = [[cacheURL URLByAppendingPathComponent:@"vibestudio-rn" isDirectory:YES] URLByAppendingPathComponent:safeBuildKey isDirectory:YES];
      [NSFileManager.defaultManager createDirectoryAtURL:dirURL withIntermediateDirectories:YES attributes:nil error:nil];
      NSURL *finalURL = [dirURL URLByAppendingPathComponent:safeArtifact isDirectory:NO];
      NSURL *transferURL = [dirURL URLByAppendingPathComponent:[safeArtifact stringByAppendingString:@".transfer"] isDirectory:NO];
      [NSFileManager.defaultManager createFileAtPath:transferURL.path contents:nil attributes:nil];
      self.bundleFinalPath = finalURL.path;
      self.bundleTransferPath = transferURL.path;
      self.bundleStream = [NSFileHandle fileHandleForWritingAtPath:transferURL.path];
      if (self.bundleStream == nil) {
        [NSException raise:@"VibestudioBundleAppendFailed" format:@"Could not open bundle transfer file"];
      }
    }
    if (self.bundleStream == nil) {
      [NSException raise:@"VibestudioBundleAppendFailed" format:@"appendBundleChunk called before reset"];
    }
    NSData *chunk = [[NSData alloc] initWithBase64EncodedString:bytesBase64 options:NSDataBase64DecodingIgnoreUnknownCharacters];
    if (chunk == nil) {
      [NSException raise:@"VibestudioBundleAppendFailed" format:@"Bundle chunk was not valid base64"];
    }
    [self.bundleStream writeData:chunk];
    resolve(nil);
  } @catch (NSException *exception) {
    [self closeBundleStream];
    reject(@"bundle_append_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(finalizeBundleWrite:(NSString *)integrity
                  gzip:(BOOL)gzip
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    if (self.bundleStream == nil || self.bundleTransferPath.length == 0 || self.bundleFinalPath.length == 0) {
      [NSException raise:@"VibestudioBundleFinalizeFailed" format:@"finalizeBundleWrite called before any chunk"];
    }
    [self.bundleStream synchronizeFile];
    [self closeBundleStream];
    NSData *transferData = [NSData dataWithContentsOfFile:self.bundleTransferPath];
    if (transferData == nil) {
      [NSException raise:@"VibestudioBundleFinalizeFailed" format:@"Could not read bundle transfer file"];
    }
    NSData *bundleData = gzip ? [self gunzipData:transferData] : transferData;
    [self verifySha256Integrity:integrity data:bundleData];
    if (![bundleData writeToFile:self.bundleFinalPath atomically:YES]) {
      [NSException raise:@"VibestudioBundleFinalizeFailed" format:@"Could not write prepared React Native bundle"];
    }
    [NSFileManager.defaultManager removeItemAtPath:self.bundleTransferPath error:nil];
    NSString *localPath = self.bundleFinalPath;
    self.bundleTransferPath = nil;
    self.bundleFinalPath = nil;
    resolve(@{ @"localPath": localPath });
  } @catch (NSException *exception) {
    [self closeBundleStream];
    if (self.bundleTransferPath.length > 0) {
      [NSFileManager.defaultManager removeItemAtPath:self.bundleTransferPath error:nil];
    }
    self.bundleTransferPath = nil;
    self.bundleFinalPath = nil;
    reject(@"bundle_finalize_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(activatePreparedAppBundle:(NSString *)localPath
                  buildKey:(NSString *)buildKey
                  integrity:(NSString *)integrity
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSString *canonicalPath = [self validatedPreparedBundlePath:localPath];
    NSData *bundleData = [NSData dataWithContentsOfFile:canonicalPath];
    if (bundleData == nil) {
      [NSException raise:@"VibestudioBundleActivationInvalid" format:@"Prepared React Native bundle could not be read"];
    }
    [self verifySha256Integrity:integrity data:bundleData];
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    BOOL changed =
      ![[defaults stringForKey:VibestudioActiveBundleLocalPath] isEqualToString:canonicalPath] ||
      ![[defaults stringForKey:VibestudioActiveBundleBuildKey] isEqualToString:buildKey] ||
      ![[defaults stringForKey:VibestudioActiveBundleIntegrity] isEqualToString:integrity];
    [defaults setObject:canonicalPath forKey:VibestudioActiveBundleLocalPath];
    [defaults setObject:buildKey forKey:VibestudioActiveBundleBuildKey];
    [defaults setObject:integrity forKey:VibestudioActiveBundleIntegrity];
    [defaults synchronize];
    resolve(@{ @"activated": @(changed) });
  } @catch (NSException *exception) {
    reject(@"bundle_activate_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(reloadActiveAppBundle:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
    NSString *localPath = [defaults stringForKey:VibestudioActiveBundleLocalPath];
    if (localPath.length == 0) {
      [NSException raise:@"VibestudioBundleReloadInvalid" format:@"No active React Native bundle is available"];
    }
    resolve(@{ @"reloading": @YES });
    dispatch_async(dispatch_get_main_queue(), ^{
      RCTReloadCommandSetBundleURL([NSURL fileURLWithPath:localPath]);
      RCTTriggerReloadCommandListeners(@"Vibestudio workspace app bundle activated");
    });
  } @catch (NSException *exception) {
    reject(@"bundle_reload_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(assetStoreLookup:(NSDictionary *)namespace
                  key:(NSString *)key
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    resolve([self lookupStoredAsset:namespace key:key]);
  } @catch (NSException *exception) {
    reject(@"asset_store_lookup_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(assetStoreOpenWrite:(NSDictionary *)namespace
                  key:(NSString *)key
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    NSString *namespaceKey = [self validatedAssetNamespace:namespace];
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
  [self abortAssetWrite:writeId];
  resolve(nil);
}

RCT_EXPORT_METHOD(assetStoreTrim:(double)maxBytes
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
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

- (NSDictionary *)lookupStoredAsset:(NSDictionary *)namespace key:(NSString *)key
{
  NSString *namespaceKey = [self validatedAssetNamespace:namespace];
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

- (NSString *)validatedAssetNamespace:(NSDictionary *)namespace
{
  NSString *server = [namespace[@"serverIdentity"] isKindOfClass:NSString.class]
    ? [namespace[@"serverIdentity"] lowercaseString] : nil;
  NSString *workspace = [namespace[@"workspaceIdentity"] isKindOfClass:NSString.class]
    ? namespace[@"workspaceIdentity"] : nil;
  if (![self isAssetDigest:server]) {
    [NSException raise:@"VibestudioAssetNamespaceInvalid" format:@"Asset namespace has invalid server identity"];
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
- (NSURL *)assetStagingURL { return [[self assetStoreRootURL] URLByAppendingPathComponent:@"staging" isDirectory:YES]; }
- (NSURL *)assetIndexURL:(NSString *)namespaceKey
{
  return [[self assetIndexesURL] URLByAppendingPathComponent:[[self sha256Text:namespaceKey] stringByAppendingString:@".json"] isDirectory:NO];
}

- (void)closeBundleStream
{
  @try {
    [self.bundleStream closeFile];
  } @catch (__unused NSException *exception) {
  }
  self.bundleStream = nil;
}

- (void)clearActiveBundle
{
  NSUserDefaults *defaults = [NSUserDefaults standardUserDefaults];
  [defaults removeObjectForKey:VibestudioActiveBundleLocalPath];
  [defaults removeObjectForKey:VibestudioActiveBundleBuildKey];
  [defaults removeObjectForKey:VibestudioActiveBundleIntegrity];
  [defaults removeObjectForKey:VibestudioActiveBundleSource];
  [defaults synchronize];
}

- (NSData *)gunzipData:(NSData *)data
{
  if (data.length == 0) return [NSData data];
  z_stream stream;
  memset(&stream, 0, sizeof(stream));
  stream.next_in = (Bytef *)data.bytes;
  stream.avail_in = (uInt)data.length;
  int status = inflateInit2(&stream, 16 + MAX_WBITS);
  if (status != Z_OK) {
    [NSException raise:@"VibestudioBundleFinalizeFailed" format:@"Could not initialize gzip decoder"];
  }
  NSMutableData *out = [NSMutableData dataWithLength:64 * 1024];
  NSMutableData *result = [NSMutableData data];
  do {
    if (stream.total_out >= result.length + out.length) {
      [out setLength:out.length * 2];
    }
    stream.next_out = (Bytef *)out.mutableBytes;
    stream.avail_out = (uInt)out.length;
    status = inflate(&stream, Z_NO_FLUSH);
    if (status != Z_OK && status != Z_STREAM_END) {
      inflateEnd(&stream);
      [NSException raise:@"VibestudioBundleFinalizeFailed" format:@"Gzipped bundle transfer could not be decoded"];
    }
    NSUInteger produced = out.length - stream.avail_out;
    if (produced > 0) {
      [result appendBytes:out.bytes length:produced];
    }
  } while (status != Z_STREAM_END);
  inflateEnd(&stream);
  return result;
}

- (void)verifySha256Integrity:(NSString *)integrity data:(NSData *)data
{
  NSString *expected = [integrity hasPrefix:@"sha256-"] ? [integrity substringFromIndex:@"sha256-".length] : integrity;
  NSRegularExpression *regex = [NSRegularExpression regularExpressionWithPattern:@"^[A-Fa-f0-9]{64}$" options:0 error:nil];
  if ([regex numberOfMatchesInString:expected options:0 range:NSMakeRange(0, expected.length)] != 1) {
    [NSException raise:@"VibestudioBundleIntegrityUnsupported" format:@"Unsupported React Native bundle integrity: %@", integrity];
  }
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *actual = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) {
    [actual appendFormat:@"%02x", digest[index]];
  }
  if ([actual caseInsensitiveCompare:expected] != NSOrderedSame) {
    [NSException raise:@"VibestudioBundleIntegrityMismatch" format:@"React Native bundle integrity mismatch"];
  }
}

- (NSString *)validatedPreparedBundlePath:(NSString *)localPath
{
  NSString *canonicalPath = [localPath stringByResolvingSymlinksInPath];
  NSURL *cacheURL = [[NSFileManager.defaultManager URLsForDirectory:NSCachesDirectory inDomains:NSUserDomainMask] firstObject];
  NSString *bundleRoot = [[[cacheURL URLByAppendingPathComponent:@"vibestudio-rn" isDirectory:YES] path] stringByResolvingSymlinksInPath];
  BOOL isUnderRoot = [canonicalPath isEqualToString:bundleRoot] || [canonicalPath hasPrefix:[bundleRoot stringByAppendingString:@"/"]];
  BOOL isDirectory = NO;
  if (!isUnderRoot || ![NSFileManager.defaultManager fileExistsAtPath:canonicalPath isDirectory:&isDirectory] || isDirectory) {
    [NSException raise:@"VibestudioBundleActivationInvalid" format:@"Prepared React Native bundle is outside the app cache"];
  }
  return canonicalPath;
}

- (NSString *)safePathSegment:(NSString *)value
{
  NSMutableString *out = [NSMutableString stringWithCapacity:value.length];
  NSCharacterSet *allowed = [NSCharacterSet characterSetWithCharactersInString:@"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789._-"];
  for (NSUInteger index = 0; index < value.length; index++) {
    unichar ch = [value characterAtIndex:index];
    if ([allowed characterIsMember:ch]) {
      [out appendFormat:@"%C", ch];
    } else {
      [out appendString:@"_"];
    }
  }
  return out.length > 0 ? out : @"bundle";
}

@end
