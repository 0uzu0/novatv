package novatv.host;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import dalvik.system.DexClassLoader;

/**
 * NovaTV Android 侧车
 *
 * 唯一职责：在真 Android（ART）里加载固化 spider jar（csp_*Guard），
 * 用与 JVM 侧车一致的 HTTP 协议对外提供 home/category/detail/search/play。
 *
 * 端口：设备内 127.0.0.1:8899，宿主机用 adb forward tcp:8898 tcp:8899 映射。
 *
 * 关键点：
 *   - 必须用 DexClassLoader（jar 里是 classes.dex，不是 class）
 *   - parent 传本 APK 的 ClassLoader，让 jar 能链接到 com.github.catvod.crawler.Spider
 *   - 加固包的 native 库已在 jar 的 assets/ 里，DexClassLoader 不会自动解压 .so，
 *     所以首次加载前要把 assets/ftyguard_v*.so 解到 app 的 lib 目录（见 prepareNative）
 */
public class HostService extends Service {
  private static final String TAG = "NovaTVHost";
  private static final int PORT = 8899;
  private static final String PKG = "novatv.host";

  private ServerSocket server;
  private final ExecutorService pool = Executors.newFixedThreadPool(4);
  private final Map<String, Object> spiders = new HashMap<>();
  private final Map<String, DexClassLoader> loaders = new HashMap<>();
  private final List<String> logs = new ArrayList<>();

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (server == null) {
      new Thread(this::serve, "novatv-host-accept").start();
    }
    log("host service started");
    return START_STICKY;
  }

  private void log(String s) {
    Log.i(TAG, s);
    logs.add(System.currentTimeMillis() + " " + s);
    if (logs.size() > 200) logs.remove(0);
  }

  private void serve() {
    try {
      server = new ServerSocket(PORT, 16, InetAddress.getByName("127.0.0.1"));
      log("listening 127.0.0.1:" + PORT);
      while (!server.isClosed()) {
        Socket s = server.accept();
        pool.submit(() -> handle(s));
      }
    } catch (Exception e) {
      log("server error " + e);
    }
  }

  private void handle(Socket socket) {
    try (Socket s = socket) {
      InputStream in = s.getInputStream();
      ByteArrayOutputStream head = new ByteArrayOutputStream();
      int b, state = 0;
      while ((b = in.read()) >= 0) {
        head.write(b);
        if (b == '\n' && (state == 1 || state == 3)) {
          if (state == 3) break;
          state++;
        } else if (b == '\r') {
          state++;
        } else {
          state = 0;
        }
      }
      String headText = head.toString("UTF-8");
      String[] lines = headText.split("\r?\n");
      String[] first = lines[0].split(" ");
      String path = first.length > 1 ? first[1] : "/";
      int len = 0;
      for (String line : lines) {
        if (line.toLowerCase().startsWith("content-length:")) {
          len = Integer.parseInt(line.substring(15).trim());
        }
      }
      byte[] body = new byte[len];
      int read = 0;
      while (read < len) {
        int n = in.read(body, read, len - read);
        if (n < 0) break;
        read += n;
      }

      String resp;
      if (path.startsWith("/health")) {
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("service", "novatv-android-sidecar");
        o.put("android", android.os.Build.VERSION.RELEASE);
        o.put("abi", android.os.Build.SUPPORTED_ABIS[0]);
        o.put("loaded", new JSONArray(spiders.keySet()));
        resp = o.toString();
      } else if (path.startsWith("/spider")) {
        resp = spider(new JSONObject(new String(body, "UTF-8"))).toString();
      } else {
        resp = "{\"ok\":false,\"error\":\"not found\"}";
      }
      byte[] out = resp.getBytes("UTF-8");
      OutputStream os = s.getOutputStream();
      os.write(("HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: "
          + out.length + "\r\nConnection: close\r\n\r\n").getBytes("UTF-8"));
      os.write(out);
      os.flush();
    } catch (Exception e) {
      log("handle error " + e);
    }
  }

  private JSONObject spider(JSONObject req) {
    JSONObject out = new JSONObject();
    long t0 = System.currentTimeMillis();
    try {
      JSONObject site = req.optJSONObject("site");
      if (site == null) site = new JSONObject();
      String api = site.optString("api");
      String ext = site.optString("ext");
      String key = site.optString("key");
      String jar = site.optString("spiderJar");
      if (jar.isEmpty()) jar = defaultJar();

      Object sp = instance(key, api, ext, jar);
      Object data = dispatch(sp, req.optString("method"), req.optJSONObject("params"));
      out.put("ok", true);
      out.put("data", data == null ? "" : String.valueOf(data));
      out.put("tookMs", System.currentTimeMillis() - t0);
      out.put("engine", "android/" + android.os.Build.VERSION.RELEASE);
    } catch (Throwable e) {
      StringWriter sw = new StringWriter();
      e.printStackTrace(new PrintWriter(sw));
      try {
        out.put("ok", false);
        out.put("error", String.valueOf(e.getMessage()));
        out.put("errorClass", e.getClass().getName());
        out.put("stack", sw.toString().substring(0, Math.min(1200, sw.toString().length())));
        out.put("logs", new JSONArray(logs));
      } catch (Exception ignored) {
      }
      log("spider error " + e);
    }
    return out;
  }

  private String defaultJar() {
    File ext = getExternalFilesDir(null);
    if (ext != null) return new File(ext, "spider.jar").getAbsolutePath();
    return new File(getFilesDir(), "spider.jar").getAbsolutePath();
  }

  private Object instance(String key, String api, String ext, String jarPath) throws Exception {
    String className = resolveClass(api);
    String id = jarPath + "#" + className + "#" + key;
    Object hit = spiders.get(id);
    if (hit != null) return hit;

    File jar = new File(jarPath);
    if (!jar.exists()) throw new IllegalStateException("spider jar 不存在: " + jarPath);
    File cache = new File(getFilesDir(), "dexout");
    if (!cache.exists()) cache.mkdirs();

    DexClassLoader cl = loaders.get(jarPath);
    if (cl == null) {
      cl = new DexClassLoader(jarPath, cache.getAbsolutePath(), null, getClassLoader());
      loaders.put(jarPath, cl);
    }
    Class<?> c = Class.forName(className, true, cl);
    Object o = c.getDeclaredConstructor().newInstance();

    // init(Context) 或 init(Context, String)
    for (Method m : c.getMethods()) {
      if (!"init".equals(m.getName())) continue;
      Class<?>[] ps = m.getParameterTypes();
      if (ps.length == 1) {
        m.invoke(o, this);
        break;
      }
      if (ps.length == 2 && ps[1] == String.class) {
        m.invoke(o, this, ext);
        break;
      }
    }
    spiders.put(id, o);
    log("loaded " + className);
    return o;
  }

  private String resolveClass(String api) {
    if (api.contains("#")) return api.substring(api.indexOf('#') + 1).trim();
    String name = api.startsWith("csp_") ? api.substring(4) : api;
    if (!name.contains(".")) name = "com.github.catvod.spider." + name;
    return name;
  }

  private Object dispatch(Object sp, String method, JSONObject p) throws Exception {
    if (p == null) p = new JSONObject();
    Class<?> c = sp.getClass();
    switch (method) {
      case "home":
        return c.getMethod("homeContent", boolean.class).invoke(sp, true);
      case "category": {
        HashMap<String, String> f = new HashMap<>();
        return c.getMethod("categoryContent", String.class, boolean.class, HashMap.class)
            .invoke(sp, p.optString("tid"), false, f);
      }
      case "detail": {
        List<String> ids = new ArrayList<>();
        ids.add(p.optString("id"));
        return c.getMethod("detailContent", List.class).invoke(sp, ids);
      }
      case "search":
        return c.getMethod("searchContent", String.class, boolean.class)
            .invoke(sp, p.optString("wd"), false);
      case "play": {
        List<String> ids = new ArrayList<>();
        ids.add(p.optString("ep"));
        return c.getMethod("playerContent", String.class, List.class, HashMap.class)
            .invoke(sp, p.optString("flag"), ids, new HashMap<String, String>());
      }
      default:
        throw new IllegalArgumentException("不支持的方法 " + method);
    }
  }
}
