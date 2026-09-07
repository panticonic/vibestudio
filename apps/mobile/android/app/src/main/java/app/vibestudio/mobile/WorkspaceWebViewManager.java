package app.vibestudio.mobile;

import androidx.webkit.WebViewCompat;
import com.facebook.react.bridge.ReadableArray;
import java.util.HashMap;
import java.util.Collections;
import androidx.webkit.WebViewFeature;
import com.facebook.react.uimanager.ReactStylesDiffMap;
import com.facebook.react.uimanager.StateWrapper;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.annotations.ReactProp;
import com.reactnativecommunity.webview.RNCWebView;
import com.reactnativecommunity.webview.RNCWebViewManager;
import com.reactnativecommunity.webview.RNCWebViewWrapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Map;
import java.util.WeakHashMap;

/** Select the immutable browser profile before React Native configures or loads the WebView. */
public final class WorkspaceWebViewManager extends RNCWebViewManager {
  private final Map<RNCWebViewWrapper, String> scopes = new WeakHashMap<>();

  @Override public String getName() { return "VibestudioWorkspaceWebView"; }

  @Override public Map<String, Object> getExportedViewConstants() {
    return Collections.singletonMap("profilesSupported", WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE));
  }

  @Override protected RNCWebViewWrapper createViewInstance(
      int reactTag, ThemedReactContext context, ReactStylesDiffMap props, StateWrapper state) {
    String scope = props == null ? null : props.getString("workspaceProfile");
    if (scope == null || scope.isEmpty()) throw new IllegalArgumentException("A workspace browser profile is required");
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.MULTI_PROFILE)) {
      throw new IllegalStateException("Update Android System WebView to open isolated workspaces");
    }
    RNCWebView webView = new WorkspaceWebView(context);
    WebViewCompat.setProfile(webView, profileName(scope));
    RNCWebViewWrapper view = super.createViewInstance(context, webView);
    scopes.put(view, scope);
    // React Native's initial-props hook owns these steps when it is overridden.
    view.setId(reactTag);
    addEventEmitters(context, view);
    updateProperties(view, props);
    if (state != null) {
      Object extra = updateState(view, props, state);
      if (extra != null) updateExtraData(view, extra);
    }
    return view;
  }

  @Override public Map<String, Object> getExportedCustomDirectEventTypeConstants() {
    Map<String, Object> events = new HashMap<>(super.getExportedCustomDirectEventTypeConstants());
    events.put("topWorkspacePermission", Collections.singletonMap("registrationName", "onWorkspacePermission"));
    return events;
  }

  @Override public void receiveCommand(RNCWebViewWrapper view, String command, ReadableArray args) {
    if ("resolveWorkspacePermission".equals(command)) {
      if (args != null && args.size() == 2) {
        ((WorkspaceWebView) view.getWebView()).resolvePermission(args.getString(0), args.getBoolean(1));
      }
      return;
    }
    super.receiveCommand(view, command, args);
  }

  @ReactProp(name = "workspaceProfile")
  public void setWorkspaceProfile(RNCWebViewWrapper view, String scope) {
    if (!scopes.getOrDefault(view, "").equals(scope)) {
      throw new IllegalStateException("A browser view cannot move between workspace profiles");
    }
  }

  @Override public void onDropViewInstance(RNCWebViewWrapper view) {
    scopes.remove(view);
    super.onDropViewInstance(view);
  }

  static String profileName(String scope) {
    try {
      byte[] digest = MessageDigest.getInstance("SHA-256").digest(scope.getBytes(StandardCharsets.UTF_8));
      StringBuilder result = new StringBuilder("workspace-");
      for (byte item : digest) result.append(String.format("%02x", item & 0xff));
      return result.toString();
    } catch (NoSuchAlgorithmException impossible) {
      throw new IllegalStateException("SHA-256 is required for browser profile identity", impossible);
    }
  }
}
