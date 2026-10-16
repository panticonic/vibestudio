#import <Foundation/Foundation.h>
#import <UIKit/UIKit.h>
#import <UniformTypeIdentifiers/UniformTypeIdentifiers.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTInvalidating.h>
#import "VibestudioInstances.h"
#import <dlfcn.h>
#import <math.h>
#import <objc/message.h>
#import <zlib.h>

// Host instance only: the device-owned surface of the host runtime (browser-data
// import, Firebase availability). The asset store and workspace cookies a
// browser panel needs live in `VibestudioPanelHost`, which only a client holding
// `panel-hosting` can use.
@interface VibestudioMobileHost : NSObject <RCTBridgeModule, RCTInvalidating, UIDocumentPickerDelegate>
@property(nonatomic, strong) dispatch_queue_t resourceQueue;
@property(atomic, assign) BOOL invalidated;
@property(nonatomic, strong) NSMutableDictionary<NSString *, NSMutableDictionary *> *browserImportArchives;
@property(nonatomic, copy) RCTPromiseResolveBlock browserImportPickerResolve;
@property(nonatomic, copy) RCTPromiseRejectBlock browserImportPickerReject;
@property(nonatomic, strong) UIDocumentPickerViewController *browserImportPicker;
@end

@implementation VibestudioMobileHost

RCT_EXPORT_MODULE();

@synthesize bridge = _bridge;

- (void)invalidate
{
  self.invalidated = YES;
  dispatch_async(self.resourceQueue, ^{
    // Remove only this module's staging files; a replacement may already exist.
    for (NSDictionary *archive in self.browserImportArchives.allValues) {
      [NSFileManager.defaultManager removeItemAtPath:archive[@"path"] error:nil];
    }
    [self.browserImportArchives removeAllObjects];
  });
  dispatch_async(dispatch_get_main_queue(), ^{
    [self rejectBrowserImportPicker:@"browser_import_invalidated" message:@"The browser-import runtime was invalidated"];
    self.browserImportPicker.delegate = nil;
    [self.browserImportPicker dismissViewControllerAnimated:NO completion:nil];
    self.browserImportPicker = nil;
  });
}

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
    _resourceQueue = dispatch_queue_create("app.vibestudio.mobile.browser-import", DISPATCH_QUEUE_SERIAL);
    _browserImportArchives = [NSMutableDictionary dictionary];
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
  return self.resourceQueue;
}

- (NSDictionary *)constantsToExport
{
  BOOL firebaseConfigured = [[NSBundle mainBundle] pathForResource:@"GoogleService-Info" ofType:@"plist"] != nil;
  return @{ @"firebaseConfigured": @(firebaseConfigured) };
}

RCT_EXPORT_METHOD(openSafariBrowserDataExport:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)
{
  if (!VibestudioRequireHostBridge(self.bridge, @"VibestudioMobileHost", reject)) return;
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
  if (!VibestudioRequireHostBridge(self.bridge, @"VibestudioMobileHost", reject)) return;
  @synchronized(self) {
    if (self.invalidated) {
      reject(@"browser_import_invalidated", @"The browser-import runtime was invalidated", nil);
      return;
    }
    if (self.browserImportPickerResolve != nil) {
      reject(@"browser_import_pick_busy", @"A browser-import document picker is already active", nil);
      return;
    }
    self.browserImportPickerResolve = resolve;
    self.browserImportPickerReject = reject;
  }
  dispatch_async(dispatch_get_main_queue(), ^{
    if (self.invalidated) return;
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
  if (!VibestudioRequireHostBridge(self.bridge, @"VibestudioMobileHost", reject)) return;
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
  if (!VibestudioRequireHostBridge(self.bridge, @"VibestudioMobileHost", reject)) return;
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
    if (self.invalidated) return;
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
  if (resolve != nil) resolve(value ?: NSNull.null);
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
  const uint8_t *signatureBytes = static_cast<const uint8_t *>(signature.bytes);
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
  const uint8_t *bytes = static_cast<const uint8_t *>(archiveData.bytes);
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

@end
