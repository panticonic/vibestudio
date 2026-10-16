#import <UIKit/UIKit.h>

@class RCTReactNativeFactory;

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong, readonly) RCTReactNativeFactory *reactNativeFactory;
@property(nonatomic, copy, readonly) NSDictionary *launchOptions;
- (BOOL)prepareInitialURL:(NSURL *)url;
- (void)startReactNativeInWindow:(UIWindow *)window launchOptions:(NSDictionary *)launchOptions;
@end
