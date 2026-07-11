#import <Foundation/Foundation.h>
#import <React/RCTBridgeModule.h>
#import <React/RCTReloadCommand.h>
#import <CommonCrypto/CommonDigest.h>
#import <zlib.h>

@interface VibestudioMobileHost : NSObject <RCTBridgeModule>
@property(nonatomic, strong) NSFileHandle *bundleStream;
@property(nonatomic, copy) NSString *bundleTransferPath;
@property(nonatomic, copy) NSString *bundleFinalPath;
@end

@implementation VibestudioMobileHost

RCT_EXPORT_MODULE();

static NSString *const VibestudioActiveBundleLocalPath = @"activeBundle.localPath";
static NSString *const VibestudioActiveBundleBuildKey = @"activeBundle.buildKey";
static NSString *const VibestudioActiveBundleIntegrity = @"activeBundle.integrity";
static NSString *const VibestudioActiveBundleSource = @"activeBundle.source";

+ (BOOL)requiresMainQueueSetup
{
  return NO;
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
    if (changed) {
      dispatch_async(dispatch_get_main_queue(), ^{
        RCTReloadCommandSetBundleURL([NSURL fileURLWithPath:canonicalPath]);
        RCTTriggerReloadCommandListeners(@"Vibestudio workspace app bundle activated");
      });
    }
  } @catch (NSException *exception) {
    reject(@"bundle_activate_failed", exception.reason, nil);
  }
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
