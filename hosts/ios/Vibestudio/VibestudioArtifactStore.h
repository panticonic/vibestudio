#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

extern NSErrorDomain const VibestudioArtifactErrorDomain;
/// `userInfo` key holding the machine-readable code the host runtime sees on rejection.
extern NSString *const VibestudioArtifactErrorCodeKey;

/// The verified client-artifact store: blobs keyed by `sha256-<hex>`, written
/// into private staging, hashed against the declared integrity on commit, and
/// published atomically so a reader never sees a partial artifact.
@interface VibestudioArtifactStore : NSObject

+ (instancetype)shared;

/// Streaming SHA-256 of a file, as `sha256-<hex>`. Nil with `error` when it cannot be read.
+ (nullable NSString *)integrityOfFileAtPath:(NSString *)path error:(NSError **)error;
/// Fails with code `invalid-integrity` or `integrity-mismatch` unless the file hashes to `integrity`.
+ (BOOL)verifyFileAtPath:(NSString *)path integrity:(NSString *)integrity error:(NSError **)error;

- (BOOL)hasArtifact:(NSString *)integrity error:(NSError **)error result:(BOOL *)result;
- (nullable NSString *)beginWrite:(NSString *)integrity name:(NSString *)name error:(NSError **)error;
- (BOOL)appendToWrite:(NSString *)writeId bytesBase64:(NSString *)bytesBase64 error:(NSError **)error;
- (BOOL)commitWrite:(NSString *)writeId error:(NSError **)error;
- (void)abortWrite:(NSString *)writeId;
- (NSArray<NSString *> *)listArtifacts;
- (BOOL)removeArtifact:(NSString *)integrity error:(NSError **)error;
- (nullable NSString *)locateArtifact:(NSString *)integrity error:(NSError **)error;
/// Lay one build out as `<builds>/<buildKey>/<path>`, each entry linked or copied from the
/// store and hashed as placed; the directory becomes visible atomically and nothing is
/// visible on failure. Idempotent. Returns the build directory.
- (nullable NSString *)materializeBuild:(NSString *)buildKey entries:(NSArray<NSDictionary *> *)entries error:(NSError **)error;
/// Remove every materialized build directory not named in `keep`.
- (BOOL)retainBuilds:(NSArray<NSString *> *)keep error:(NSError **)error;
- (nullable NSString *)readArtifactBase64:(NSString *)integrity error:(NSError **)error;

@end

NS_ASSUME_NONNULL_END
