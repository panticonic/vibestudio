#import "VibestudioArtifactStore.h"
#import <CommonCrypto/CommonDigest.h>
#import <stdio.h>
#import <errno.h>

NSErrorDomain const VibestudioArtifactErrorDomain = @"app.vibestudio.artifact-store";
NSString *const VibestudioArtifactErrorCodeKey = @"code";

static NSError *VibestudioArtifactError(NSString *code, NSString *message)
{
  return [NSError errorWithDomain:VibestudioArtifactErrorDomain
                             code:1
                         userInfo:@{ VibestudioArtifactErrorCodeKey: code, NSLocalizedDescriptionKey: message }];
}

/// The lowercase hex digest of a well-formed `sha256-<hex>`, or nil.
static NSString *VibestudioIntegrityHex(NSString *integrity)
{
  static NSRegularExpression *pattern;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    pattern = [NSRegularExpression regularExpressionWithPattern:@"^sha256-[0-9A-Fa-f]{64}$" options:0 error:nil];
  });
  if (![integrity isKindOfClass:NSString.class] ||
      [pattern numberOfMatchesInString:integrity options:0 range:NSMakeRange(0, integrity.length)] != 1) {
    return nil;
  }
  return [[integrity substringFromIndex:@"sha256-".length] lowercaseString];
}

@implementation VibestudioArtifactStore {
  NSMutableDictionary<NSString *, NSDictionary *> *_writes;
}

+ (instancetype)shared
{
  static VibestudioArtifactStore *store;
  static dispatch_once_t once;
  dispatch_once(&once, ^{ store = [VibestudioArtifactStore new]; });
  return store;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    _writes = [NSMutableDictionary dictionary];
    // Staged writes do not survive the process that owned them.
    [NSFileManager.defaultManager removeItemAtURL:[self stagingURL] error:nil];
    [NSFileManager.defaultManager createDirectoryAtURL:[self stagingURL] withIntermediateDirectories:YES attributes:nil error:nil];
    [NSFileManager.defaultManager createDirectoryAtURL:[self blobsURL] withIntermediateDirectories:YES attributes:nil error:nil];
    [NSFileManager.defaultManager createDirectoryAtURL:[self buildsURL] withIntermediateDirectories:YES attributes:nil error:nil];
    [[self blobsURL] setResourceValue:@YES forKey:NSURLIsExcludedFromBackupKey error:nil];
  }
  return self;
}

#pragma mark - Hashing

+ (NSString *)integrityOfFileAtPath:(NSString *)path error:(NSError **)error
{
  NSFileHandle *handle = [NSFileHandle fileHandleForReadingAtPath:path];
  if (handle == nil) {
    if (error) *error = VibestudioArtifactError(@"artifact-missing", @"The artifact file could not be opened");
    return nil;
  }
  CC_SHA256_CTX context;
  CC_SHA256_Init(&context);
  while (YES) {
    NSError *readError = nil;
    NSData *chunk = [handle readDataUpToLength:64 * 1024 error:&readError];
    if (chunk == nil) {
      [handle closeAndReturnError:nil];
      if (error) *error = VibestudioArtifactError(@"io-failed", readError.localizedDescription ?: @"The artifact file could not be read");
      return nil;
    }
    if (chunk.length == 0) break;
    CC_SHA256_Update(&context, chunk.bytes, (CC_LONG)chunk.length);
  }
  [handle closeAndReturnError:nil];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256_Final(digest, &context);
  NSMutableString *hex = [NSMutableString stringWithString:@"sha256-"];
  for (int index = 0; index < CC_SHA256_DIGEST_LENGTH; index++) [hex appendFormat:@"%02x", digest[index]];
  return hex;
}

+ (BOOL)verifyFileAtPath:(NSString *)path integrity:(NSString *)integrity error:(NSError **)error
{
  NSString *expected = VibestudioIntegrityHex(integrity);
  if (expected == nil) {
    if (error) *error = VibestudioArtifactError(@"invalid-integrity", @"Integrity must be sha256-<64 hex digits>");
    return NO;
  }
  NSString *actual = [self integrityOfFileAtPath:path error:error];
  if (actual == nil) return NO;
  if (![[actual substringFromIndex:@"sha256-".length] isEqualToString:expected]) {
    if (error) *error = VibestudioArtifactError(@"integrity-mismatch", @"The artifact does not match its declared integrity");
    return NO;
  }
  return YES;
}

#pragma mark - Paths

- (NSURL *)rootURL
{
  NSURL *support = [[NSFileManager.defaultManager URLsForDirectory:NSApplicationSupportDirectory inDomains:NSUserDomainMask] firstObject];
  return [support URLByAppendingPathComponent:@"vibestudio-client-artifacts" isDirectory:YES];
}
- (NSURL *)blobsURL { return [[self rootURL] URLByAppendingPathComponent:@"blobs" isDirectory:YES]; }
- (NSURL *)buildsURL { return [[self rootURL] URLByAppendingPathComponent:@"builds" isDirectory:YES]; }
- (NSURL *)stagingURL { return [[self rootURL] URLByAppendingPathComponent:@"staging" isDirectory:YES]; }

/// The blob path of a validated integrity; sets `error` for a malformed one.
- (NSString *)blobPath:(NSString *)integrity error:(NSError **)error
{
  NSString *hex = VibestudioIntegrityHex(integrity);
  if (hex == nil) {
    if (error) *error = VibestudioArtifactError(@"invalid-integrity", @"Integrity must be sha256-<64 hex digits>");
    return nil;
  }
  return [[self blobsURL] URLByAppendingPathComponent:hex isDirectory:NO].path;
}

#pragma mark - Store

- (BOOL)hasArtifact:(NSString *)integrity error:(NSError **)error result:(BOOL *)result
{
  NSString *path = [self blobPath:integrity error:error];
  if (path == nil) return NO;
  *result = [NSFileManager.defaultManager fileExistsAtPath:path];
  return YES;
}

- (NSString *)beginWrite:(NSString *)integrity name:(NSString *)name error:(NSError **)error
{
  if ([self blobPath:integrity error:error] == nil) return nil;
  if (![name isKindOfClass:NSString.class] || name.length == 0) {
    if (error) *error = VibestudioArtifactError(@"invalid-name", @"An artifact write needs a name");
    return nil;
  }
  NSString *writeId = NSUUID.UUID.UUIDString.lowercaseString;
  NSString *path = [[self stagingURL] URLByAppendingPathComponent:writeId isDirectory:NO].path;
  [NSFileManager.defaultManager createDirectoryAtURL:[self stagingURL] withIntermediateDirectories:YES attributes:nil error:nil];
  if (![NSFileManager.defaultManager createFileAtPath:path contents:nil attributes:nil]) {
    if (error) *error = VibestudioArtifactError(@"io-failed", @"Could not create the artifact staging file");
    return nil;
  }
  NSFileHandle *handle = [NSFileHandle fileHandleForWritingAtPath:path];
  if (handle == nil) {
    [NSFileManager.defaultManager removeItemAtPath:path error:nil];
    if (error) *error = VibestudioArtifactError(@"io-failed", @"Could not open the artifact staging file");
    return nil;
  }
  @synchronized(self) {
    _writes[writeId] = @{ @"integrity": integrity, @"path": path, @"handle": handle };
  }
  return writeId;
}

- (NSDictionary *)writeForId:(NSString *)writeId
{
  @synchronized(self) { return _writes[writeId]; }
}

- (BOOL)appendToWrite:(NSString *)writeId bytesBase64:(NSString *)bytesBase64 error:(NSError **)error
{
  NSDictionary *write = [self writeForId:writeId];
  if (write == nil) {
    if (error) *error = VibestudioArtifactError(@"unknown-write", @"Unknown artifact write handle");
    return NO;
  }
  NSData *bytes = [[NSData alloc] initWithBase64EncodedString:bytesBase64 options:0];
  if (bytes == nil) {
    [self abortWrite:writeId];
    if (error) *error = VibestudioArtifactError(@"invalid-chunk", @"The artifact chunk was not valid base64");
    return NO;
  }
  NSError *writeError = nil;
  if (![(NSFileHandle *)write[@"handle"] writeData:bytes error:&writeError]) {
    [self abortWrite:writeId];
    if (error) *error = VibestudioArtifactError(@"io-failed", writeError.localizedDescription ?: @"Could not stage the artifact chunk");
    return NO;
  }
  return YES;
}

- (BOOL)commitWrite:(NSString *)writeId error:(NSError **)error
{
  NSDictionary *write;
  @synchronized(self) {
    write = _writes[writeId];
    [_writes removeObjectForKey:writeId];
  }
  if (write == nil) {
    if (error) *error = VibestudioArtifactError(@"unknown-write", @"Unknown artifact write handle");
    return NO;
  }
  NSString *stagedPath = write[@"path"];
  NSError *failure = nil;
  BOOL published = NO;
  NSString *blobPath = [self blobPath:write[@"integrity"] error:&failure];
  if (blobPath != nil) {
    NSError *closeError = nil;
    if (![(NSFileHandle *)write[@"handle"] synchronizeAndReturnError:&closeError] ||
        ![(NSFileHandle *)write[@"handle"] closeAndReturnError:&closeError]) {
      failure = VibestudioArtifactError(@"io-failed", closeError.localizedDescription ?: @"Could not finish the staged artifact");
    } else if ([VibestudioArtifactStore verifyFileAtPath:stagedPath integrity:write[@"integrity"] error:&failure]) {
      // rename(2) replaces an existing blob atomically. Writers of one integrity
      // carry identical bytes, so whichever publishes last leaves the same file.
      if (rename(stagedPath.fileSystemRepresentation, blobPath.fileSystemRepresentation) == 0) {
        published = YES;
      } else {
        failure = VibestudioArtifactError(@"io-failed",
          [NSString stringWithFormat:@"Could not publish the artifact: %s", strerror(errno)]);
      }
    }
  }
  if (!published) {
    @try { [(NSFileHandle *)write[@"handle"] closeFile]; } @catch (__unused NSException *ignored) {}
    [NSFileManager.defaultManager removeItemAtPath:stagedPath error:nil];
    if (error) *error = failure;
    return NO;
  }
  return YES;
}

- (void)abortWrite:(NSString *)writeId
{
  NSDictionary *write;
  @synchronized(self) {
    write = _writes[writeId];
    [_writes removeObjectForKey:writeId];
  }
  if (write == nil) return;
  @try { [(NSFileHandle *)write[@"handle"] closeFile]; } @catch (__unused NSException *ignored) {}
  [NSFileManager.defaultManager removeItemAtPath:write[@"path"] error:nil];
}

- (NSArray<NSString *> *)listArtifacts
{
  NSArray<NSString *> *names = [NSFileManager.defaultManager contentsOfDirectoryAtPath:[self blobsURL].path error:nil] ?: @[];
  NSMutableArray<NSString *> *integrities = [NSMutableArray array];
  for (NSString *name in names) {
    NSString *integrity = [@"sha256-" stringByAppendingString:name];
    if (VibestudioIntegrityHex(integrity) != nil) [integrities addObject:integrity];
  }
  return integrities;
}

- (BOOL)removeArtifact:(NSString *)integrity error:(NSError **)error
{
  NSString *path = [self blobPath:integrity error:error];
  if (path == nil) return NO;
  if ([NSFileManager.defaultManager fileExistsAtPath:path]) {
    NSError *removeError = nil;
    if (![NSFileManager.defaultManager removeItemAtPath:path error:&removeError]) {
      if (error) *error = VibestudioArtifactError(@"io-failed", removeError.localizedDescription ?: @"Could not remove the artifact");
      return NO;
    }
  }
  return YES;
}

- (NSString *)locateArtifact:(NSString *)integrity error:(NSError **)error
{
  NSString *path = [self blobPath:integrity error:error];
  if (path == nil) return nil;
  if (![NSFileManager.defaultManager fileExistsAtPath:path]) {
    if (error) *error = VibestudioArtifactError(@"artifact-missing", @"The artifact is not in the store");
    return nil;
  }
  return path;
}

static BOOL VibestudioValidBuildKey(NSString *key)
{
  NSRegularExpression *pattern = [NSRegularExpression regularExpressionWithPattern:@"^[A-Za-z0-9_-]{1,200}$" options:0 error:nil];
  return [key isKindOfClass:NSString.class] && [pattern numberOfMatchesInString:key options:0 range:NSMakeRange(0, key.length)] == 1;
}

static BOOL VibestudioValidEntryPath(NSString *path)
{
  if (![path isKindOfClass:NSString.class] || path.length == 0 || [path containsString:@"\\"] ||
      [path rangeOfCharacterFromSet:NSCharacterSet.controlCharacterSet].location != NSNotFound) return NO;
  for (NSString *segment in [path componentsSeparatedByString:@"/"]) {
    if (segment.length == 0 || [segment isEqualToString:@"."] || [segment isEqualToString:@".."]) return NO;
  }
  return YES;
}

- (NSString *)materializeBuild:(NSString *)buildKey entries:(NSArray<NSDictionary *> *)entries error:(NSError **)error
{
  if (!VibestudioValidBuildKey(buildKey) || ![entries isKindOfClass:NSArray.class]) {
    if (error) *error = VibestudioArtifactError(@"invalid-build", @"A build needs a safe buildKey and an entry list");
    return nil;
  }
  NSFileManager *files = NSFileManager.defaultManager;
  NSString *finalPath = [[self buildsURL] URLByAppendingPathComponent:buildKey isDirectory:YES].path;
  if ([files fileExistsAtPath:finalPath]) return finalPath;
  NSString *tmp = [[self stagingURL] URLByAppendingPathComponent:[@"build-" stringByAppendingString:NSUUID.UUID.UUIDString] isDirectory:YES].path;
  NSError *failure = nil;
  BOOL ok = [files createDirectoryAtPath:tmp withIntermediateDirectories:YES attributes:nil error:&failure];
  for (NSDictionary *entry in ok ? entries : @[]) {
    NSString *entryPath = entry[@"path"];
    NSString *integrity = entry[@"integrity"];
    if (!VibestudioValidEntryPath(entryPath)) {
      failure = VibestudioArtifactError(@"invalid-path", @"A build entry path must be relative and stay inside the build");
      ok = NO; break;
    }
    NSString *source = [self locateArtifact:integrity error:&failure];
    if (source == nil) { ok = NO; break; }
    NSString *target = [tmp stringByAppendingPathComponent:entryPath];
    [files createDirectoryAtPath:target.stringByDeletingLastPathComponent withIntermediateDirectories:YES attributes:nil error:nil];
    NSError *placeError = nil;
    if (![files linkItemAtPath:source toPath:target error:&placeError] &&
        ![files copyItemAtPath:source toPath:target error:&placeError]) {
      failure = VibestudioArtifactError(@"io-failed", placeError.localizedDescription ?: @"Could not place a build entry");
      ok = NO; break;
    }
    if (![VibestudioArtifactStore verifyFileAtPath:target integrity:integrity error:&failure]) { ok = NO; break; }
  }
  if (ok && rename(tmp.fileSystemRepresentation, finalPath.fileSystemRepresentation) != 0) {
    // A concurrent materialization of the same build published first; the entries are the same.
    if (![files fileExistsAtPath:finalPath]) {
      failure = VibestudioArtifactError(@"io-failed", [NSString stringWithFormat:@"Could not publish the build: %s", strerror(errno)]);
      ok = NO;
    }
  }
  [files removeItemAtPath:tmp error:nil];
  if (!ok) {
    if (error) *error = failure;
    return nil;
  }
  return finalPath;
}

- (BOOL)retainBuilds:(NSArray<NSString *> *)keep error:(NSError **)error
{
  NSArray<NSString *> *names = [NSFileManager.defaultManager contentsOfDirectoryAtPath:[self buildsURL].path error:nil] ?: @[];
  for (NSString *name in names) {
    if ([keep containsObject:name]) continue;
    NSError *removeError = nil;
    if (![NSFileManager.defaultManager removeItemAtPath:[[self buildsURL] URLByAppendingPathComponent:name].path error:&removeError]) {
      if (error) *error = VibestudioArtifactError(@"io-failed", removeError.localizedDescription ?: @"Could not remove a build");
      return NO;
    }
  }
  return YES;
}

- (NSString *)readArtifactBase64:(NSString *)integrity error:(NSError **)error
{
  NSString *path = [self locateArtifact:integrity error:error];
  if (path == nil) return nil;
  NSError *readError = nil;
  NSData *data = [NSData dataWithContentsOfFile:path options:0 error:&readError];
  if (data == nil) {
    if (error) *error = VibestudioArtifactError(@"io-failed", readError.localizedDescription ?: @"Could not read the artifact");
    return nil;
  }
  return [data base64EncodedStringWithOptions:0];
}

@end
