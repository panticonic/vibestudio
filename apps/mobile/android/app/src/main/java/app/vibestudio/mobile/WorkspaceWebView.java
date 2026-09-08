package app.vibestudio.mobile;

import android.net.Uri;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
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
import org.json.JSONObject;

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
  private static final class NotificationCall {
    final long document; final JavaScriptReplyProxy reply; final String method;
    NotificationCall(long document, JavaScriptReplyProxy reply, String method) {
      this.document = document; this.reply = reply; this.method = method;
    }
  }
  private final Map<String, NotificationCall> notificationCalls = new HashMap<>();
  private final Map<String, Long> notificationDocuments = new HashMap<>();
  private long document = 0;

  WorkspaceWebView(ThemedReactContext context) { super(context); }

  void initializeWebsiteNotifications() {
    WebViewCompat.addWebMessageListener(this, "__vibestudioWebsiteNotificationsNative",
        // Android's origin-rule grammar has no scheme-wide wildcard. The
        // callback admits only a matching HTTP(S) top-level document below.
        java.util.Set.of("*"), (view, message, sourceOrigin, isMainFrame, reply) -> {
      String topLevelUrl = getUrl();
      if (!isMainFrame || sourceOrigin == null || topLevelUrl == null || !sameOrigin(sourceOrigin.toString(), topLevelUrl)) return;
      try {
        JSONObject input = new JSONObject(message.getData());
        String requestId = input.getString("requestId");
        String method = input.getString("method");
        if (!("permissionState".equals(method) || "requestPermission".equals(method) || "show".equals(method) || "close".equals(method))) return;
        if (notificationCalls.containsKey(requestId)) {
          reply.postMessage(notificationReply(requestId, false, "Duplicate notification request"));
          return;
        }
        Object args = input.opt("args");
        if ("close".equals(method)) {
          String id = args instanceof String ? (String) args : null;
          if (id == null || !Long.valueOf(document).equals(notificationDocuments.get(id))) {
            reply.postMessage(notificationReply(requestId, false, "Notification does not belong to this document"));
            return;
          }
        }
        notificationCalls.put(requestId, new NotificationCall(document, reply, method));
        emitNotification(requestId, sourceOrigin.toString(), topLevelUrl, method,
            jsonValue(args));
      } catch (Exception ignored) {}
    });
  }

  void resolveWebsiteNotification(String requestId, boolean ok, String valueJson) {
    NotificationCall call = notificationCalls.remove(requestId);
    if (call == null || call.document != document) return;
    if (ok && "show".equals(call.method)) {
      try { notificationDocuments.put(new JSONObject("{\"v\":" + valueJson + "}").getString("v"), document); }
      catch (Exception error) { ok = false; valueJson = JSONObject.quote("Invalid notification id"); }
    }
    call.reply.postMessage("{\"requestId\":" + JSONObject.quote(requestId) + ",\"ok\":" + ok + ",\"value\":" + valueJson + "}");
  }

  void emitWebsiteNotificationEvent(String id, String type) {
    Long owner = notificationDocuments.get(id);
    if (owner == null || owner.longValue() != document) return;
    if ("close".equals(type)) notificationDocuments.remove(id);
    String payload = "{\"event\":{\"id\":" + JSONObject.quote(id) + ",\"type\":" + JSONObject.quote(type) + "}}";
    evaluateJavascript("globalThis.__vibestudioWebsiteNotificationsNative?.onmessage?.({data:" + JSONObject.quote(payload) + "})", null);
  }

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
    cancelWebsiteNotifications();
    document++;
    cancelAll();
  }

  @Override public void destroy() {
    cancelWebsiteNotifications();
    cancelAll();
    super.destroy();
  }

  private void cancelWebsiteNotifications() {
    for (Map.Entry<String, NotificationCall> entry : notificationCalls.entrySet()) {
      entry.getValue().reply.postMessage(notificationReply(entry.getKey(), false, "Document navigated"));
      emitNotificationCancelled(entry.getKey());
    }
    notificationCalls.clear();
    for (String id : notificationDocuments.keySet().toArray(new String[0]))
      emitNotification(UUID.randomUUID().toString(), originOf(getUrl()), getUrl(), "close", JSONObject.quote(id));
    notificationDocuments.clear();
  }

  private static String notificationReply(String id, boolean ok, String value) {
    return "{\"requestId\":" + JSONObject.quote(id) + ",\"ok\":" + ok + ",\"value\":" + JSONObject.quote(value) + "}";
  }

  private static String jsonValue(Object value) {
    if (value == null || value == JSONObject.NULL) return "null";
    return value instanceof String ? JSONObject.quote((String) value) : value.toString();
  }

  private void emitNotification(String id, String origin, String topLevelUrl, String method, String argsJson) {
    WritableMap event = Arguments.createMap();
    event.putString("requestId", id); event.putString("origin", origin); event.putString("topLevelUrl", topLevelUrl);
    event.putString("method", method); event.putString("argsJson", argsJson); event.putBoolean("cancelled", false);
    int tag = RNCWebViewWrapper.getReactTagFromWebView(this); event.putInt("target", tag);
    var dispatcher = UIManagerHelper.getEventDispatcherForReactTag(getThemedReactContext(), tag);
    if (dispatcher != null) dispatcher.dispatchEvent(new NotificationEvent(tag, event));
  }

  private void emitNotificationCancelled(String id) {
    WritableMap event = Arguments.createMap(); event.putString("requestId", id); event.putBoolean("cancelled", true);
    int tag = RNCWebViewWrapper.getReactTagFromWebView(this); event.putInt("target", tag);
    var dispatcher = UIManagerHelper.getEventDispatcherForReactTag(getThemedReactContext(), tag);
    if (dispatcher != null) dispatcher.dispatchEvent(new NotificationEvent(tag, event));
  }

  private static final class NotificationEvent extends Event<NotificationEvent> {
    private final WritableMap data;
    NotificationEvent(int tag, WritableMap data) { super(tag); this.data = data; }
    @Override public String getEventName() { return "topWorkspaceWebsiteNotification"; }
    @Override public boolean canCoalesce() { return false; }
    @Override protected WritableMap getEventData() { return data; }
  }

  private static String originOf(String url) {
    if (url == null) return "";
    Uri uri = Uri.parse(url); int value = port(uri);
    boolean standard = ("https".equals(uri.getScheme()) && value == 443) || ("http".equals(uri.getScheme()) && value == 80);
    return uri.getScheme() + "://" + uri.getHost() + (standard ? "" : ":" + value);
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
