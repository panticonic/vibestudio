#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTReloadCommand.h>
#import <CommonCrypto/CommonDigest.h>
#import <dlfcn.h>
#import <math.h>
#import <objc/message.h>
#import <zlib.h>

@interface VibestudioMobileHost : NSObject <RCTBridgeModule, UIDocumentPickerDelegate>
@property(nonatomic, strong) NSFileHandle *bundleStream;
@property(nonatomic, copy) NSString *bundleTransferPath;
@property(nonatomic, copy) NSString *bundleFinalPath;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableDictionary *> *assetWrites;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableDictionary *> *browserImportArchives;
@property(nonatomic, copy) RCTPromiseResolveBlock browserImportPickerResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock browserImportPickerReject;
@property(nonatomic, strong) UIDocumentPickerViewController *browserImportPicker;
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
static NSString *const VibestudioBrowserImportHandlePrefix = @"vibestudio-browser-import-v1:";
static NSTimeInterval const VibestudioBrowserImportTTL = 60.0 * 60.0;
static unsigned long long const VibestudioBrowserImportArchiveMaxBytes = 512ULL * 1024ULL * 1024ULL;
static unsigned long long const VibestudioBrowserImportExpandedMaxBytes = 2ULL * 1024ULL * 1024ULL * 1024ULL;
static unsigned long long const VibestudioBrowserImportEntryMaxBytes = 512ULL * 1024ULL * 1024ULL;
static NSUInteger const VibestudioBrowserImportEntryMaxCount = 20000;
static unsigned long long const VibestudioBrowserImportCompressionRatio = 200;
static unsigned long long const VibestudioBrowserImportRatioGraceBytes = 1024ULL * 1024ULL;
static NSUInteger const VibestudioBrowserImportReadMaxBytes = 512 * 1024;

static uint16_t VibestudioReadLE16(const uint8_t *bytes) {
  return (uint16_t)bytes[0] | ((uint16_t)bytes[1] << 8);
}

static uint32_t VibestudioReadLE32(const uint8_t *bytes) {
  return (uint32_t)bytes[0] | ((uint32_t)bytes[1] << 8) | ((uint32_t)bytes[2] << 16) | ((uint32_t)bytes[3] << 24);
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _assetWrites = [NSMutableDictionary dictionary];
    _browserImportArchives = [NSMutableDictionary dictionary];
    [NSFileManager.defaultManager removeItemAtURL:[self assetStagingURL] error:nil];
    [NSFileManager.defaultManager createDirectoryAtURL:[self assetBlobsURL] withIntermediateDirectories:YES attributes:nil error:nil];
    [NSFileManager.defaultManager createDirectoryAtURL:[self assetIndexesURL] withIntermediateDirectories:YES attributes:nil error:nil];
    [[self assetBlobsURL] setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
    [self cleanupBrowserImportArchivesDeletingAll:YES];
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

RCT_EXPORT_METHOD(openSafariBrowserDataExport:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  dispatch_async(dispatch_get_main_queue(), ^{
    dlopen("/System/Library/Frameworks/SafariServices.framework/SafariServices", RTLD_LAZY | RTLD_LOCAL);
    Class settings = NSClassFromString(@"SFSafariSettings");
    SEL selector = NSSelectorFromString(@"openExportBrowsingDataSettingsWithCompletionHandler:");
    if (settings == Nil || ![settings respondsToSelector:selector]) {
      resolve(@{
        @"opened": @NO,
        @"unavailableReason": @"Safari browser-data export requires a newer version of iOS",
      });
      return;
    }
    typedef void (*OpenSafariExport)(id, SEL, void (^)(NSError *));
    ((OpenSafariExport)objc_msgSend)(settings, selector, ^(NSError *error) {
      if (error) {
        resolve(@{ @"opened": @NO, @"unavailableReason": error.localizedDescription ?: @"Safari could not open its export sheet" });
      } else {
        resolve(@{ @"opened": @YES });
      }
    });
  });
}

RCT_EXPORT_METHOD(pickBrowserImportArchive:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @synchronized(self) {
    if (self.browserImportPickerResolve != nil) {
      reject(@"browser_import_pick_busy", @"A browser-import document picker is already active", nil);
      return;
    }
    self.browserImportPickerResolve = resolve;
    self.browserImportPickerReject = reject;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    NSArray<UTType *> *types = @[
      UTTypeZIP,
      UTTypeHTML,
      [UTType typeWithIdentifier:@"public.comma-separated-values-text"],
      UTTypeJSON,
    ];
    UIDocumentPickerViewController *picker = [[UIDocumentPickerViewController alloc] initForOpeningContentTypes:types asCopy:YES];
    picker.delegate = self;
    picker.allowsMultipleSelection = NO;
    UIViewController *presenter = [self browserImportPresentationController];
    if (presenter == nil) {
      [self rejectBrowserImportPicker:@"browser_import_pick_unavailable" message:@"No foreground view controller is available"];
      return;
    }
    self.browserImportPicker = picker;
    [presenter presentViewController:picker animated:YES completion:nil];
  });
}

RCT_EXPORT_METHOD(readBrowserImportEntry:(NSString *)handle
                  name:(NSString *)name
                  offset:(double)offset
                  maxBytes:(double)maxBytes
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    resolve([self readBrowserImportEntryHandle:handle name:name offset:offset maxBytes:maxBytes]);
  } @catch (NSException *exception) {
    reject(@"browser_import_read_failed", exception.reason, nil);
  }
}

RCT_EXPORT_METHOD(releaseBrowserImportArchive:(NSString *)handle
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  @try {
    [self releaseBrowserImportArchiveHandle:handle];
    resolve(nil);
  } @catch (NSException *exception) {
    reject(@"browser_import_release_failed", exception.reason, nil);
  }
}

- (void)documentPicker:(UIDocumentPickerViewController *)controller didPickDocumentsAtURLs:(NSArray<NSURL *> *)urls
{
  self.browserImportPicker = nil;
  NSURL *url = urls.firstObject;
  if (url == nil) {
    [self rejectBrowserImportPicker:@"browser_import_pick_failed" message:@"The document picker did not return a file"];
    return;
  }
  dispatch_async([self methodQueue], ^{
    @try {
      NSDictionary *result = [self stageBrowserImportArchiveURL:url];
      [self resolveBrowserImportPicker:result];
    } @catch (NSException *exception) {
      [self rejectBrowserImportPicker:@"browser_import_pick_failed" message:exception.reason];
    }
  });
}

- (void)documentPickerWasCancelled:(UIDocumentPickerViewController *)controller
{
  self.browserImportPicker = nil;
  [self resolveBrowserImportPicker:nil];
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

- (UIViewController *)browserImportPresentationController
{
  UIWindow *window = nil;
  for (UIScene *scene in UIApplication.sharedApplication.connectedScenes) {
    if (scene.activationState != UISceneActivationStateForegroundActive || ![scene isKindOfClass:UIWindowScene.class]) continue;
    for (UIWindow *candidate in ((UIWindowScene *)scene).windows) {
      if (candidate.isKeyWindow) { window = candidate; break; }
    }
    if (window != nil) break;
  }
  UIViewController *controller = window.rootViewController;
  while (controller.presentedViewController != nil) controller = controller.presentedViewController;
  return controller;
}

- (void)resolveBrowserImportPicker:(id)value
{
  RCTPromiseResolveBlock resolve = nil;
  @synchronized(self) {
    resolve = self.browserImportPickerResolve;
    self.browserImportPickerResolve = nil;
    self.browserImportPickerReject = nil;
  }
  if (resolve != nil) resolve(value);
}

- (void)rejectBrowserImportPicker:(NSString *)code message:(NSString *)message
{
  RCTPromiseRejectBlock reject = nil;
  @synchronized(self) {
    reject = self.browserImportPickerReject;
    self.browserImportPickerResolve = nil;
    self.browserImportPickerReject = nil;
  }
  if (reject != nil) reject(code, message, nil);
}

- (NSDictionary *)stageBrowserImportArchiveURL:(NSURL *)sourceURL
{
  [self cleanupBrowserImportArchivesDeletingAll:NO];
  NSNumber *sourceSize = nil;
  NSString *sourceName = nil;
  UTType *sourceType = nil;
  [sourceURL getResourceValue:&sourceSize forKey:NSURLFileSizeKey error:nil];
  [sourceURL getResourceValue:&sourceName forKey:NSURLNameKey error:nil];
  [sourceURL getResourceValue:&sourceType forKey:NSURLContentTypeKey error:nil];
  if (sourceSize != nil && sourceSize.unsignedLongLongValue > VibestudioBrowserImportArchiveMaxBytes) {
    [NSException raise:@"VibestudioBrowserImportArchiveTooLarge" format:@"Browser export exceeds the archive byte limit"];
  }
  NSString *displayName = sourceName.lastPathComponent.length > 0 ? sourceName.lastPathComponent : @"browser-export";
  if (displayName.length > 512) displayName = [displayName substringToIndex:512];
  NSString *handle = [VibestudioBrowserImportHandlePrefix stringByAppendingString:NSUUID.UUID.UUIDString.lowercaseString];
  NSURL *root = [self browserImportArchiveRootURL];
  NSDictionary *protection = @{ NSFileProtectionKey: NSFileProtectionComplete };
  NSError *directoryError = nil;
  if (![NSFileManager.defaultManager createDirectoryAtURL:root withIntermediateDirectories:YES attributes:protection error:&directoryError]) {
    [NSException raise:@"VibestudioBrowserImportStageFailed" format:@"Could not create protected import storage: %@", directoryError.localizedDescription];
  }
  [root setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  NSURL *destination = [root URLByAppendingPathComponent:[handle substringFromIndex:VibestudioBrowserImportHandlePrefix.length] isDirectory:NO];
  BOOL securityScoped = [sourceURL startAccessingSecurityScopedResource];
  @try {
    NSInputStream *input = [NSInputStream inputStreamWithURL:sourceURL];
    if (input == nil || ![NSFileManager.defaultManager createFileAtPath:destination.path contents:nil attributes:protection]) {
      [NSException raise:@"VibestudioBrowserImportStageFailed" format:@"The selected browser export could not be staged"];
    }
    NSFileHandle *output = [NSFileHandle fileHandleForWritingAtPath:destination.path];
    [input open];
    unsigned long long total = 0;
    uint8_t buffer[64 * 1024];
    NSInteger count = 0;
    while ((count = [input read:buffer maxLength:sizeof(buffer)]) > 0) {
      total += (unsigned long long)count;
      if (total > VibestudioBrowserImportArchiveMaxBytes) {
        [input close];
        [output closeFile];
        [NSException raise:@"VibestudioBrowserImportArchiveTooLarge" format:@"Browser export exceeds the archive byte limit"];
      }
      [output writeData:[NSData dataWithBytes:buffer length:(NSUInteger)count]];
    }
    [input close];
    [output synchronizeFile];
    [output closeFile];
    if (count < 0 || total == 0) {
      [NSException raise:@"VibestudioBrowserImportStageFailed" format:@"The selected browser export could not be read"];
    }
    [NSFileManager.defaultManager setAttributes:protection ofItemAtPath:destination.path error:nil];
    NSArray<NSDictionary *> *entries = [self inspectBrowserImportArchiveURL:destination displayName:displayName];
    NSMutableDictionary *entriesByName = [NSMutableDictionary dictionaryWithCapacity:entries.count];
    NSMutableArray *publicEntries = [NSMutableArray arrayWithCapacity:entries.count];
    for (NSDictionary *entry in entries) {
      entriesByName[entry[@"name"]] = entry;
      [publicEntries addObject:@{ @"name": entry[@"name"], @"size": entry[@"size"] }];
    }
    NSMutableDictionary *archive = [@{
      @"path": destination.path,
      @"displayName": displayName,
      @"size": @(total),
      @"entries": entriesByName,
      @"lastAccessed": NSDate.date,
    } mutableCopy];
    NSString *mimeType = sourceType.preferredMIMEType;
    if (mimeType.length > 0) archive[@"mimeType"] = mimeType;
    self.browserImportArchives[handle] = archive;
    NSMutableDictionary *result = [@{
      @"handle": handle,
      @"displayName": displayName,
      @"size": @(total),
      @"entries": publicEntries,
    } mutableCopy];
    if (mimeType.length > 0) result[@"mimeType"] = mimeType;
    return result;
  } @catch (NSException *exception) {
    [NSFileManager.defaultManager removeItemAtURL:destination error:nil];
    @throw exception;
  } @finally {
    if (securityScoped) [sourceURL stopAccessingSecurityScopedResource];
  }
}

- (NSArray<NSDictionary *> *)inspectBrowserImportArchiveURL:(NSURL *)url displayName:(NSString *)displayName
{
  NSFileHandle *signatureFile = [NSFileHandle fileHandleForReadingAtPath:url.path];
  NSData *signature = [signatureFile readDataOfLength:4];
  [signatureFile closeFile];
  const uint8_t *signatureBytes = signature.bytes;
  BOOL zip = signature.length == 4 && signatureBytes[0] == 0x50 && signatureBytes[1] == 0x4b &&
    ((signatureBytes[2] == 0x03 && signatureBytes[3] == 0x04) || (signatureBytes[2] == 0x05 && signatureBytes[3] == 0x06));
  if (!zip) {
    NSSet *extensions = [NSSet setWithArray:@[@"html", @"htm", @"csv", @"json"]];
    if (![extensions containsObject:displayName.pathExtension.lowercaseString]) {
      [NSException raise:@"VibestudioBrowserImportTypeUnsupported" format:@"Select a ZIP, HTML, CSV, or JSON browser export"];
    }
    NSString *name = [self validatedBrowserImportEntryName:displayName];
    NSNumber *size = nil;
    [url getResourceValue:&size forKey:NSURLFileSizeKey error:nil];
    return @[@{ @"name": name, @"size": size ?: @0, @"method": @(-1), @"dataOffset": @0, @"compressedSize": size ?: @0, @"crc32": @0 }];
  }
  NSData *archiveData = [NSData dataWithContentsOfURL:url options:NSDataReadingMappedIfSafe error:nil];
  if (archiveData.length < 22) {
    [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export ZIP is truncated"];
  }
  const uint8_t *bytes = archiveData.bytes;
  NSUInteger searchStart = archiveData.length > 65557 ? archiveData.length - 65557 : 0;
  NSUInteger eocd = NSNotFound;
  for (NSUInteger cursor = archiveData.length - 22;; cursor--) {
    if (VibestudioReadLE32(bytes + cursor) == 0x06054b50 &&
        cursor + 22 + VibestudioReadLE16(bytes + cursor + 20) == archiveData.length) {
      eocd = cursor;
      break;
    }
    if (cursor == searchStart) break;
  }
  if (eocd == NSNotFound) [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export ZIP has no valid central directory"];
  uint16_t disk = VibestudioReadLE16(bytes + eocd + 4);
  uint16_t directoryDisk = VibestudioReadLE16(bytes + eocd + 6);
  uint16_t diskEntries = VibestudioReadLE16(bytes + eocd + 8);
  uint16_t totalEntries = VibestudioReadLE16(bytes + eocd + 10);
  uint32_t directorySize = VibestudioReadLE32(bytes + eocd + 12);
  uint32_t directoryOffset = VibestudioReadLE32(bytes + eocd + 16);
  if (disk != 0 || directoryDisk != 0 || diskEntries != totalEntries || totalEntries == UINT16_MAX ||
      directorySize == UINT32_MAX || directoryOffset == UINT32_MAX) {
    [NSException raise:@"VibestudioBrowserImportZipUnsupported" format:@"Multi-disk and ZIP64 browser exports are not supported"];
  }
  if (totalEntries > VibestudioBrowserImportEntryMaxCount ||
      (uint64_t)directoryOffset + directorySize > eocd) {
    [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export ZIP central directory is out of bounds"];
  }
  NSMutableArray<NSDictionary *> *entries = [NSMutableArray array];
  NSMutableSet<NSString *> *canonicalNames = [NSMutableSet set];
  NSMutableArray<NSDictionary *> *ranges = [NSMutableArray array];
  uint64_t expanded = 0;
  NSUInteger cursor = directoryOffset;
  for (NSUInteger index = 0; index < totalEntries; index++) {
    if (cursor + 46 > eocd || VibestudioReadLE32(bytes + cursor) != 0x02014b50) {
      [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export ZIP central directory is malformed"];
    }
    uint16_t flags = VibestudioReadLE16(bytes + cursor + 8);
    uint16_t method = VibestudioReadLE16(bytes + cursor + 10);
    uint32_t crc = VibestudioReadLE32(bytes + cursor + 16);
    uint32_t compressedSize = VibestudioReadLE32(bytes + cursor + 20);
    uint32_t size = VibestudioReadLE32(bytes + cursor + 24);
    uint16_t nameLength = VibestudioReadLE16(bytes + cursor + 28);
    uint16_t extraLength = VibestudioReadLE16(bytes + cursor + 30);
    uint16_t commentLength = VibestudioReadLE16(bytes + cursor + 32);
    uint32_t localOffset = VibestudioReadLE32(bytes + cursor + 42);
    uint64_t next = (uint64_t)cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || nameLength == 0 || (flags & 1) != 0 || (method != 0 && method != 8) ||
        size == UINT32_MAX || compressedSize == UINT32_MAX || localOffset == UINT32_MAX) {
      [NSException raise:@"VibestudioBrowserImportZipUnsupported" format:@"Browser export ZIP contains an unsupported entry"];
    }
    NSData *nameData = [NSData dataWithBytes:bytes + cursor + 46 length:nameLength];
    NSString *rawName = [[NSString alloc] initWithData:nameData encoding:NSUTF8StringEncoding];
    if (rawName == nil) [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export ZIP contains a non-UTF-8 path"];
    BOOL directory = [rawName hasSuffix:@"/"] || [rawName hasSuffix:@"\\"];
    NSString *name = [self validatedBrowserImportEntryName:rawName];
    NSString *canonical = [name.precomposedStringWithCanonicalMapping lowercaseString];
    if ([canonicalNames containsObject:canonical]) {
      [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export contains duplicate archive paths"];
    }
    [canonicalNames addObject:canonical];
    if ((uint64_t)localOffset + 30 > directoryOffset || VibestudioReadLE32(bytes + localOffset) != 0x04034b50) {
      [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export ZIP local entry is out of bounds"];
    }
    uint16_t localFlags = VibestudioReadLE16(bytes + localOffset + 6);
    uint16_t localMethod = VibestudioReadLE16(bytes + localOffset + 8);
    uint16_t localNameLength = VibestudioReadLE16(bytes + localOffset + 26);
    uint16_t localExtraLength = VibestudioReadLE16(bytes + localOffset + 28);
    uint64_t dataOffset = (uint64_t)localOffset + 30 + localNameLength + localExtraLength;
    if (localFlags != flags || localMethod != method || dataOffset + compressedSize > directoryOffset ||
        localNameLength != nameLength || memcmp(bytes + localOffset + 30, nameData.bytes, nameLength) != 0) {
      [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export ZIP entry headers disagree"];
    }
    if (!directory) {
      if (size > VibestudioBrowserImportEntryMaxBytes || expanded + size > VibestudioBrowserImportExpandedMaxBytes ||
          (size > VibestudioBrowserImportRatioGraceBytes && (compressedSize == 0 || size > (uint64_t)compressedSize * VibestudioBrowserImportCompressionRatio))) {
        [NSException raise:@"VibestudioBrowserImportZipUnsafe" format:@"Browser export contains an oversized or suspiciously compressed entry"];
      }
      expanded += size;
      [ranges addObject:@{ @"start": @(dataOffset), @"end": @(dataOffset + compressedSize) }];
      [entries addObject:@{
        @"name": name,
        @"size": @(size),
        @"compressedSize": @(compressedSize),
        @"method": @(method),
        @"dataOffset": @(dataOffset),
        @"crc32": @(crc),
      }];
    }
    cursor = (NSUInteger)next;
  }
  if (cursor != (uint64_t)directoryOffset + directorySize || entries.count == 0) {
    [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export ZIP central directory size is inconsistent"];
  }
  [ranges sortUsingComparator:^NSComparisonResult(NSDictionary *left, NSDictionary *right) {
    return [left[@"start"] compare:right[@"start"]];
  }];
  uint64_t previousEnd = 0;
  for (NSDictionary *range in ranges) {
    uint64_t start = [range[@"start"] unsignedLongLongValue];
    if (start < previousEnd) [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Browser export ZIP entries overlap"];
    previousEnd = [range[@"end"] unsignedLongLongValue];
  }
  return entries;
}

- (NSString *)validatedBrowserImportEntryName:(NSString *)value
{
  if (![value isKindOfClass:NSString.class] || value.length == 0 || value.length > 4096 || [value rangeOfString:@"\0"].location != NSNotFound) {
    [NSException raise:@"VibestudioBrowserImportPathInvalid" format:@"Browser export contains an invalid archive path"];
  }
  NSString *normalized = [[value stringByReplacingOccurrencesOfString:@"\\" withString:@"/"] precomposedStringWithCanonicalMapping];
  while ([normalized hasSuffix:@"/"]) normalized = [normalized substringToIndex:normalized.length - 1];
  if (normalized.length == 0 || [normalized hasPrefix:@"/"] ||
      [normalized rangeOfString:@"^[A-Za-z]:/" options:NSRegularExpressionSearch].location != NSNotFound) {
    [NSException raise:@"VibestudioBrowserImportPathInvalid" format:@"Browser export contains an absolute archive path"];
  }
  NSCharacterSet *controls = [NSCharacterSet controlCharacterSet];
  if ([normalized rangeOfCharacterFromSet:controls].location != NSNotFound) {
    [NSException raise:@"VibestudioBrowserImportPathInvalid" format:@"Browser export contains control characters in an archive path"];
  }
  for (NSString *part in [normalized componentsSeparatedByString:@"/"]) {
    if (part.length == 0 || [part isEqualToString:@"."] || [part isEqualToString:@".."]) {
      [NSException raise:@"VibestudioBrowserImportPathInvalid" format:@"Browser export contains a traversing archive path"];
    }
  }
  return normalized;
}

- (NSDictionary *)readBrowserImportEntryHandle:(NSString *)handle
                                           name:(NSString *)requestedName
                                         offset:(double)offsetValue
                                       maxBytes:(double)maxBytesValue
{
  [self cleanupBrowserImportArchivesDeletingAll:NO];
  if (![handle hasPrefix:VibestudioBrowserImportHandlePrefix]) {
    [NSException raise:@"VibestudioBrowserImportHandleInvalid" format:@"Invalid browser-import archive handle"];
  }
  if (!isfinite(offsetValue) || offsetValue < 0 || floor(offsetValue) != offsetValue ||
      !isfinite(maxBytesValue) || maxBytesValue < 1 || floor(maxBytesValue) != maxBytesValue ||
      maxBytesValue > VibestudioBrowserImportReadMaxBytes) {
    [NSException raise:@"VibestudioBrowserImportReadInvalid" format:@"Browser-import read range is invalid"];
  }
  NSMutableDictionary *archive = self.browserImportArchives[handle];
  if (archive == nil) {
    [NSException raise:@"VibestudioBrowserImportHandleExpired" format:@"Browser-import archive handle is unavailable or expired"];
  }
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:archive[@"path"] error:nil];
  if (attributes == nil || [attributes fileSize] != [archive[@"size"] unsignedLongLongValue]) {
    [NSException raise:@"VibestudioBrowserImportArchiveChanged" format:@"Browser-import archive changed after validation"];
  }
  NSString *name = [self validatedBrowserImportEntryName:requestedName];
  NSDictionary *entry = archive[@"entries"][name];
  if (entry == nil) [NSException raise:@"VibestudioBrowserImportEntryMissing" format:@"Unknown browser-import archive entry"];
  uint64_t size = [entry[@"size"] unsignedLongLongValue];
  uint64_t offset = (uint64_t)offsetValue;
  if (offset > size) [NSException raise:@"VibestudioBrowserImportReadInvalid" format:@"Browser-import read offset exceeds the entry size"];
  NSUInteger count = (NSUInteger)MIN((uint64_t)maxBytesValue, size - offset);
  NSInteger method = [entry[@"method"] integerValue];
  NSData *data = method == 8
    ? [self readDeflatedBrowserImportEntry:entry path:archive[@"path"] offset:offset count:count]
    : [self readStoredBrowserImportEntry:entry path:archive[@"path"] offset:offset count:count];
  if (data.length != count) {
    [NSException raise:@"VibestudioBrowserImportReadInvalid" format:@"Browser-import archive ended before its declared entry size"];
  }
  archive[@"lastAccessed"] = NSDate.date;
  return @{
    @"dataBase64": [data base64EncodedStringWithOptions:0],
    @"eof": @(offset + data.length >= size),
  };
}

- (NSData *)readStoredBrowserImportEntry:(NSDictionary *)entry
                                    path:(NSString *)path
                                  offset:(uint64_t)offset
                                   count:(NSUInteger)count
{
  uint64_t dataOffset = [entry[@"dataOffset"] unsignedLongLongValue];
  if ([entry[@"method"] integerValue] == 0 &&
      [entry[@"compressedSize"] unsignedLongLongValue] != [entry[@"size"] unsignedLongLongValue]) {
    [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Stored ZIP entry has inconsistent sizes"];
  }
  NSFileHandle *file = [NSFileHandle fileHandleForReadingAtPath:path];
  if (file == nil) [NSException raise:@"VibestudioBrowserImportReadFailed" format:@"Browser-import archive is unavailable"];
  @try {
    [file seekToFileOffset:dataOffset + offset];
    return [file readDataOfLength:count];
  } @finally {
    [file closeFile];
  }
}

- (NSData *)readDeflatedBrowserImportEntry:(NSDictionary *)entry
                                      path:(NSString *)path
                                    offset:(uint64_t)offset
                                     count:(NSUInteger)count
{
  if (count == 0) return [NSData data];
  uint64_t dataOffset = [entry[@"dataOffset"] unsignedLongLongValue];
  uint64_t compressedRemaining = [entry[@"compressedSize"] unsignedLongLongValue];
  uint64_t declaredSize = [entry[@"size"] unsignedLongLongValue];
  uint64_t targetEnd = offset + count;
  NSFileHandle *file = [NSFileHandle fileHandleForReadingAtPath:path];
  if (file == nil) [NSException raise:@"VibestudioBrowserImportReadFailed" format:@"Browser-import archive is unavailable"];
  [file seekToFileOffset:dataOffset];
  z_stream stream;
  memset(&stream, 0, sizeof(stream));
  if (inflateInit2(&stream, -MAX_WBITS) != Z_OK) {
    [file closeFile];
    [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Could not initialize ZIP decoder"];
  }
  NSMutableData *result = [NSMutableData dataWithCapacity:count];
  uLong crc = crc32(0L, Z_NULL, 0);
  uint64_t producedTotal = 0;
  int status = Z_OK;
  @try {
    uint8_t output[64 * 1024];
    while (status != Z_STREAM_END && (producedTotal < targetEnd || targetEnd == declaredSize)) {
      if (stream.avail_in == 0) {
        NSUInteger nextLength = (NSUInteger)MIN(compressedRemaining, (uint64_t)(64 * 1024));
        if (nextLength == 0) [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Compressed ZIP entry ended early"];
        NSData *input = [file readDataOfLength:nextLength];
        if (input.length != nextLength) [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Compressed ZIP entry is truncated"];
        compressedRemaining -= input.length;
        stream.next_in = (Bytef *)input.bytes;
        stream.avail_in = (uInt)input.length;
        do {
          stream.next_out = output;
          stream.avail_out = sizeof(output);
          status = inflate(&stream, Z_NO_FLUSH);
          if (status != Z_OK && status != Z_STREAM_END) {
            [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"Compressed ZIP entry is malformed"];
          }
          NSUInteger produced = sizeof(output) - stream.avail_out;
          if (produced > 0) {
            if (producedTotal + produced > declaredSize) {
              [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"ZIP entry expands beyond its declared size"];
            }
            crc = crc32(crc, output, (uInt)produced);
            uint64_t chunkStart = producedTotal;
            uint64_t chunkEnd = producedTotal + produced;
            uint64_t copyStart = MAX(offset, chunkStart);
            uint64_t copyEnd = MIN(targetEnd, chunkEnd);
            if (copyEnd > copyStart) {
              [result appendBytes:output + (copyStart - chunkStart) length:(NSUInteger)(copyEnd - copyStart)];
            }
            producedTotal = chunkEnd;
          }
        } while (stream.avail_in > 0 && status != Z_STREAM_END && (producedTotal < targetEnd || targetEnd == declaredSize));
      }
    }
    if (targetEnd == declaredSize &&
        (status != Z_STREAM_END || producedTotal != declaredSize || (uint32_t)crc != [entry[@"crc32"] unsignedIntValue])) {
      [NSException raise:@"VibestudioBrowserImportZipInvalid" format:@"ZIP entry failed its size or checksum validation"];
    }
  } @finally {
    inflateEnd(&stream);
    [file closeFile];
  }
  return result;
}

- (void)releaseBrowserImportArchiveHandle:(NSString *)handle
{
  if (![handle hasPrefix:VibestudioBrowserImportHandlePrefix]) {
    [NSException raise:@"VibestudioBrowserImportHandleInvalid" format:@"Invalid browser-import archive handle"];
  }
  NSDictionary *archive = self.browserImportArchives[handle];
  [self.browserImportArchives removeObjectForKey:handle];
  if (archive != nil) {
    NSError *error = nil;
    if (![NSFileManager.defaultManager removeItemAtPath:archive[@"path"] error:&error] &&
        [NSFileManager.defaultManager fileExistsAtPath:archive[@"path"]]) {
      [NSException raise:@"VibestudioBrowserImportReleaseFailed" format:@"Could not delete staged browser export: %@", error.localizedDescription];
    }
  }
}

- (void)cleanupBrowserImportArchivesDeletingAll:(BOOL)deleteAll
{
  NSDate *now = NSDate.date;
  for (NSString *handle in self.browserImportArchives.allKeys.copy) {
    NSDictionary *archive = self.browserImportArchives[handle];
    if (deleteAll || [now timeIntervalSinceDate:archive[@"lastAccessed"]] >= VibestudioBrowserImportTTL) {
      [self.browserImportArchives removeObjectForKey:handle];
      [NSFileManager.defaultManager removeItemAtPath:archive[@"path"] error:nil];
    }
  }
  NSURL *root = [self browserImportArchiveRootURL];
  NSArray<NSURL *> *files = [NSFileManager.defaultManager contentsOfDirectoryAtURL:root
    includingPropertiesForKeys:@[NSURLContentModificationDateKey, NSURLIsRegularFileKey] options:0 error:nil] ?: @[];
  NSSet<NSString *> *activePaths = [NSSet setWithArray:[self.browserImportArchives.allValues valueForKey:@"path"]];
  for (NSURL *file in files) {
    NSDate *modified = nil;
    NSNumber *regular = nil;
    [file getResourceValue:&modified forKey:NSURLContentModificationDateKey error:nil];
    [file getResourceValue:&regular forKey:NSURLIsRegularFileKey error:nil];
    if (![activePaths containsObject:file.path] &&
        (deleteAll || !regular.boolValue || modified == nil || [now timeIntervalSinceDate:modified] >= VibestudioBrowserImportTTL)) {
      [NSFileManager.defaultManager removeItemAtURL:file error:nil];
    }
  }
}

- (NSURL *)browserImportArchiveRootURL
{
  NSURL *support = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
  return [support URLByAppendingPathComponent:@"vibestudio-browser-import" isDirectory:YES];
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
