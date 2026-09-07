package app.vibestudio.mobile;

import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import com.facebook.react.bridge.Arguments;
import com.facebook.react.bridge.WritableArray;
import com.facebook.react.bridge.WritableMap;
import com.facebook.react.uimanager.ThemedReactContext;
import com.facebook.react.uimanager.UIManagerHelper;
import com.facebook.react.uimanager.events.Event;
import com.reactnativecommunity.webview.RNCWebView;
import com.reactnativecommunity.webview.RNCWebViewWrapper;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;

/** Native WebView origins and document lifetimes are the authority for website permission requests. */
final class WorkspaceWebView extends RNCWebView {
  private static final class Request {
    final Object token;
    final String id = UUID.randomUUID().toString();
    final long document;
    final ValueCallback<Boolean> callback;
    boolean approved;
    Request(Object token, long document, ValueCallback<Boolean> callback) {
      this.token = token;
      this.document = document;
      this.callback = callback;
    }
  }
  private final Map<String, Request> requests = new HashMap<>();
  private long document = 0;

  WorkspaceWebView(ThemedReactContext context) { super(context); }

  @Override public void requestBrowserPermission(Object token, String origin, String[] resources, ValueCallback<Boolean> callback) {
    String topLevelUrl = getUrl();
    // Android does not identify the initiating frame, so only a matching top-level origin is eligible.
    if (topLevelUrl == null || !sameOrigin(origin, topLevelUrl) || !requests.isEmpty()) {
      callback.onReceiveValue(false);
      return;
    }
    WritableArray capabilities = Arguments.createArray();
    for (String resource : resources) {
      if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) capabilities.pushString("microphone");
      else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) capabilities.pushString("camera");
      else if ("geolocation".equals(resource)) capabilities.pushString("geolocation");
      else { callback.onReceiveValue(false); return; }
    }
    if (resources.length == 0) { callback.onReceiveValue(false); return; }
    Request request = new Request(token, document, callback);
    requests.put(request.id, request);
    WritableMap event = Arguments.createMap();
    event.putString("requestId", request.id);
    event.putString("origin", origin);
    event.putString("topLevelUrl", topLevelUrl);
    event.putArray("capabilities", capabilities);
    event.putBoolean("cancelled", false);
    emit(event);
  }

  void resolvePermission(String id, boolean allowed) {
    Request request = requests.get(id);
    if (request == null || request.approved) return;
    boolean current = allowed && request.document == document;
    if (current) request.approved = true;
    else requests.remove(id);
    request.callback.onReceiveValue(current);
  }

  @Override public boolean finishBrowserPermission(Object token) {
    for (Request request : requests.values()) {
      if (request.token == token) {
        requests.remove(request.id);
        return request.approved && request.document == document;
      }
    }
    return false;
  }

  @Override public void cancelBrowserPermission(Object token) {
    for (Request request : requests.values().toArray(new Request[0])) {
      if (request.token == token) cancel(request, false);
    }
  }

  @Override public void onMainFrameNavigationStarted() {
    document++;
    cancelAll();
  }

  @Override public void destroy() {
    cancelAll();
    super.destroy();
  }

  private void cancelAll() {
    for (Request request : requests.values().toArray(new Request[0])) cancel(request, true);
  }

  private void cancel(Request request, boolean deny) {
    requests.remove(request.id);
    WritableMap event = Arguments.createMap();
    event.putString("requestId", request.id);
    event.putBoolean("cancelled", true);
    emit(event);
    if (deny) request.callback.onReceiveValue(false);
  }

  private void emit(WritableMap data) {
    int tag = RNCWebViewWrapper.getReactTagFromWebView(this);
    data.putInt("target", tag);
    var dispatcher = UIManagerHelper.getEventDispatcherForReactTag(getThemedReactContext(), tag);
    if (dispatcher != null) dispatcher.dispatchEvent(new PermissionEvent(tag, data));
  }

  private static final class PermissionEvent extends Event<PermissionEvent> {
    private final WritableMap data;
    PermissionEvent(int tag, WritableMap data) { super(tag); this.data = data; }
    @Override public String getEventName() { return "topWorkspacePermission"; }
    @Override public boolean canCoalesce() { return false; }
    @Override protected WritableMap getEventData() { return data; }
  }

  private static boolean sameOrigin(String first, String second) {
    Uri a = Uri.parse(first);
    Uri b = Uri.parse(second);
    String scheme = a.getScheme();
    if (!("https".equals(scheme) || "http".equals(scheme)) || a.getHost() == null) return false;
    return scheme.equals(b.getScheme()) && a.getHost().equalsIgnoreCase(b.getHost()) && port(a) == port(b);
  }

  private static int port(Uri uri) {
    return uri.getPort() == -1 ? ("https".equals(uri.getScheme()) ? 443 : 80) : uri.getPort();
  }
}
