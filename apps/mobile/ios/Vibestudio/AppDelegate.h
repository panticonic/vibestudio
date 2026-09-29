#import <UIKit/UIKit.h>

@class RCTReactNativeFactory;

@interface AppDelegate : UIResponder <UIApplicationDelegate>
@property(nonatomic, strong, readonly) RCTReactNativeFactory *reactNativeFactory;
@property(nonatomic, copy, readonly) NSDictionary *launchOptions;
- (void)prepareInitialURL:(NSURL *)url;
@end
