package novatv.host;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.PrintWriter;
import java.io.StringWriter;
import java.lang.reflect.Method;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.net.URLDecoder;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

import dalvik.system.DexClassLoader;

/**
 * NovaTV Android 侧车
 *
 * 唯一职责：在真 Android（ART）里加载加固 spider jar（csp_*Guard），
 * 用与 JVM 侧车一致的 HTTP 协议对外提供 home/category/detail/search/play。
 *
 * 为什么要它：加固包的 classes.dex 只是壳，真实字节码在 assets/*.guard 里，
 * 运行时由 arm 的 .so 解密后交给 ART。JVM / Node / QuickJS 都拿不到字节码。
 *
 * 两种接法（协议完全一样，主服务不区分）：
 *   1. 局域网：本服务监听 0.0.0.0:8899，NAS 上设 SPIDER_ANDROID_URL=http://<手机IP>:8899
 *   2. adb：  adb forward tcp:8898 tcp:8899，NAS 上设 http://127.0.0.1:8898
 *
 * 启动：
 *   adb shell am start-foreground-service -n novatv.host/.HostService \
 *       --es token 你的口令 --ez lan true
 *
 * 接口：
 *   GET  /health[?token=]              → 设备/ABI/jar 状态
 *   POST /load   {url, md5}            → 下载并校验 spider 包（免 adb push）
 *   POST /spider {site, method, params}→ 调 spider
 */
public class HostService extends Service {
  private static final String TAG = "NovaTVHost";
  private static final int NOTIFY_ID = 1001;
  private static final String CHANNEL = "novatv-host";

  private ServerSocket server;
  private final ExecutorService pool = Executors.newFixedThreadPool(4);
  // 4 个线程并发进来，必须用并发容器
  private final Map<String, Object> spiders = new ConcurrentHashMap<String, Object>();
  private final Map<String, DexClassLoader> loaders = new ConcurrentHashMap<String, DexClassLoader>();
  // 加固包解密后的真实加载器（DexNative.getLoader 返回），与上面的 loaders 不是同一个
  private final Map<String, DexClassLoader> activeLoaders = new ConcurrentHashMap<String, DexClassLoader>();
  private final Map<String, String> initErrors = new ConcurrentHashMap<String, String>();
  private final Map<String, Long> loadAttempts = new ConcurrentHashMap<String, Long>();
  private final List<String> logs = Collections.synchronizedList(new ArrayList<String>());

  private String bindHost = "127.0.0.1";
  private int port = 8899;
  private String token = "";
  private String jarPath = "";

  @Override
  public IBinder onBind(Intent intent) {
    return null;
  }

  @Override
  public void onCreate() {
    super.onCreate();
    jarPath = defaultJar();
  }

  @Override
  public int onStartCommand(Intent intent, int flags, int startId) {
    if (intent != null) {
      // 手机直连场景必须 lan=true，否则只监听回环、NAS 连不上
      if (intent.getBooleanExtra("lan", false)) bindHost = "0.0.0.0";
      String h = intent.getStringExtra("host");
      if (h != null && h.length() > 0) bindHost = h;
      port = intent.getIntExtra("port", 8899);
      String t = intent.getStringExtra("token");
      if (t != null) token = t;
    }
    startForegroundCompat();
    if (server == null) {
      new Thread(this::serve, "novatv-host-accept").start();
    }
    log("host service started " + bindHost + ":" + port);
    return START_STICKY;
  }

  @Override
  public void onDestroy() {
    try {
      if (server != null) server.close();
    } catch (Exception ignored) {
    }
    server = null;
    super.onDestroy();
  }

  /** Android 8+ 前台服务必须在 5 秒内挂通知，否则直接被系统杀掉 */
  private void startForegroundCompat() {
    try {
      Notification n;
      if (Build.VERSION.SDK_INT >= 26) {
        NotificationManager nm = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        NotificationChannel ch = new NotificationChannel(CHANNEL, "NovaTV Spider 侧车", NotificationManager.IMPORTANCE_LOW);
        nm.createNotificationChannel(ch);
        n = new Notification.Builder(this, CHANNEL)
            .setContentTitle("NovaTV Spider 侧车运行中")
            .setContentText("监听 " + bindHost + ":" + port)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .build();
      } else {
        n = new Notification.Builder(this)
            .setContentTitle("NovaTV Spider 侧车运行中")
            .setContentText("监听 " + bindHost + ":" + port)
            .setSmallIcon(android.R.drawable.stat_sys_download_done)
            .build();
      }
      startForeground(NOTIFY_ID, n);
    } catch (Throwable e) {
      log("startForeground 失败: " + e);
    }
  }

  private void log(String s) {
    Log.i(TAG, s);
    logs.add(System.currentTimeMillis() + " " + s);
    if (logs.size() > 200) logs.remove(0);
  }

  private void serve() {
    try {
      server = new ServerSocket(port, 16, InetAddress.getByName(bindHost));
      log("listening " + bindHost + ":" + port);
      while (!server.isClosed()) {
        Socket s = server.accept();
        pool.submit(() -> handle(s));
      }
    } catch (Exception e) {
      log("server error " + e);
    }
  }

  private void handle(Socket socket) {
    try {
      InputStream in = socket.getInputStream();
      // 逐字节读到 \r\n\r\n，比状态机稳妥
      ByteArrayOutputStream head = new ByteArrayOutputStream();
      int a = -1, b = -1, c = -1, d;
      while ((d = in.read()) >= 0) {
        head.write(d);
        if (a == '\r' && b == '\n' && c == '\r' && d == '\n') break;
        a = b;
        b = c;
        c = d;
      }
      String[] lines = head.toString("UTF-8").split("\r?\n");
      String requestLine = lines.length > 0 ? lines[0] : "";
      String[] first = requestLine.split(" ");
      String target = first.length > 1 ? first[1] : "/";
      String path = target;
      String query = "";
      int qi = target.indexOf('?');
      if (qi >= 0) {
        path = target.substring(0, qi);
        query = target.length() > qi + 1 ? target.substring(qi + 1) : "";
      }
      int len = 0;
      String headerToken = "";
      for (int i = 1; i < lines.length; i++) {
        String line = lines[i];
        String lower = line.toLowerCase();
        if (lower.startsWith("content-length:")) {
          try {
            len = Integer.parseInt(line.substring(15).trim());
          } catch (Exception ignored) {
          }
        }
        if (lower.startsWith("x-nova-token:")) headerToken = line.substring(13).trim();
      }
      byte[] body = new byte[len];
      int read = 0;
      while (read < len) {
        int n = in.read(body, read, len - read);
        if (n < 0) break;
        read += n;
      }

      String givenToken = headerToken.length() > 0 ? headerToken : queryParam(query, "token");
      if (token.length() > 0 && !token.equals(givenToken)) {
        reply(socket, 401, err("unauthorized", "token 不正确"));
        return;
      }

      String resp;
      if (path.startsWith("/health")) {
        JSONObject o = new JSONObject();
        o.put("ok", true);
        o.put("service", "novatv-android-sidecar");
        o.put("android", Build.VERSION.RELEASE);
        o.put("sdk", Build.VERSION.SDK_INT);
        o.put("abi", Build.SUPPORTED_ABIS.length > 0 ? Build.SUPPORTED_ABIS[0] : "?");
        o.put("model", Build.MANUFACTURER + " " + Build.MODEL);
        o.put("host", bindHost);
        o.put("port", port);
        o.put("tokenRequired", token.length() > 0);
        o.put("jar", jarPath);
        o.put("jarExists", new File(jarPath).exists());
        o.put("jarBytes", new File(jarPath).exists() ? new File(jarPath).length() : 0);
        o.put("loaded", new JSONArray(spiders.keySet()));
        o.put("initErrors", new JSONObject(new java.util.TreeMap<String, String>(initErrors)));
        o.put("libs", new File(getApplicationInfo().nativeLibraryDir).list());
        o.put("logs", new JSONArray(logs));
        resp = o.toString();
      } else if (path.startsWith("/load")) {
        resp = load(new JSONObject(new String(body, "UTF-8"))).toString();
      } else if (path.startsWith("/spider")) {
        resp = spider(new JSONObject(new String(body, "UTF-8"))).toString();
      } else {
        resp = err("not_found", "只支持 /health /load /spider");
        reply(socket, 404, resp);
        return;
      }
      reply(socket, 200, resp);
    } catch (Throwable e) {
      log("handle error " + e);
      try {
        reply(socket, 500, err("internal", String.valueOf(e)));
      } catch (Exception ignored) {
      }
    } finally {
      try {
        socket.close();
      } catch (Exception ignored) {
      }
    }
  }

  private static String err(String code, String msg) {
    try {
      JSONObject o = new JSONObject();
      o.put("ok", false);
      o.put("error", msg);
      o.put("errorClass", code);
      return o.toString();
    } catch (Exception e) {
      return "{\"ok\":false}";
    }
  }

  private static String queryParam(String query, String key) {
    if (query == null || query.length() == 0) return "";
    for (String kv : query.split("&")) {
      int i = kv.indexOf('=');
      if (i <= 0) continue;
      if (!key.equals(kv.substring(0, i))) continue;
      try {
        return URLDecoder.decode(kv.substring(i + 1), "UTF-8");
      } catch (Exception e) {
        return "";
      }
    }
    return "";
  }

  private static void reply(Socket socket, int code, String body) throws Exception {
    byte[] out = body.getBytes("UTF-8");
    OutputStream os = socket.getOutputStream();
    os.write(("HTTP/1.1 " + code + " OK\r\n"
        + "Content-Type: application/json; charset=utf-8\r\n"
        + "Access-Control-Allow-Origin: *\r\n"
        + "Content-Length: " + out.length + "\r\n"
        + "Connection: close\r\n\r\n").getBytes("UTF-8"));
    os.write(out);
    os.flush();
  }

  /**
   * 下载 spider 包并校验 MD5。
   * 手机上没有主服务的文件系统，配置里的 spider 地址才是唯一真相，
   * 所以让侧车自己拉：一次加载，之后走本地缓存。
   */
  private JSONObject load(JSONObject req) {
    JSONObject out = new JSONObject();
    try {
      String url = req.optString("url");
      String md5 = req.optString("md5");
      if (url.length() == 0) throw new IllegalArgumentException("缺少 url");

      File dir = new File(getFilesDir(), "spider");
      if (!dir.exists()) dir.mkdirs();
      File tmp = new File(dir, "download.tmp");
      File dst = new File(dir, "spider.jar");

      HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
      conn.setInstanceFollowRedirects(true);
      conn.setConnectTimeout(15000);
      conn.setReadTimeout(60000);
      conn.setRequestProperty("User-Agent", "okhttp/3.15");
      conn.setRequestProperty("Accept", "*/*");
      int code = conn.getResponseCode();
      if (code < 200 || code >= 300) throw new IllegalStateException("下载失败 HTTP " + code);

      MessageDigest md = MessageDigest.getInstance("MD5");
      InputStream is = conn.getInputStream();
      FileOutputStream fos = new FileOutputStream(tmp);
      byte[] buf = new byte[16384];
      int n;
      long total = 0;
      while ((n = is.read(buf)) > 0) {
        fos.write(buf, 0, n);
        md.update(buf, 0, n);
        total += n;
      }
      fos.close();
      is.close();
      conn.disconnect();

      StringBuilder sb = new StringBuilder();
      for (byte x : md.digest()) sb.append(String.format("%02x", x));
      String actual = sb.toString();
      boolean md5Ok = md5.length() == 0 || md5.equalsIgnoreCase(actual);

      if (!md5Ok) {
        tmp.delete();
        out.put("ok", false);
        out.put("error", "MD5 不匹配");
        out.put("expected", md5);
        out.put("actual", actual);
        return out;
      }
      if (dst.exists()) dst.delete();
      if (!tmp.renameTo(dst)) throw new IllegalStateException("落盘失败 " + dst);

      // 换包后旧实例必须全部作废，否则还指着老 dex
      spiders.clear();
      loaders.clear();
      activeLoaders.clear();
      initErrors.clear();
      jarPath = dst.getAbsolutePath();

      out.put("ok", true);
      out.put("jar", jarPath);
      out.put("bytes", total);
      out.put("md5", actual);
      log("jar loaded " + total + "B md5=" + actual);
    } catch (Throwable e) {
      try {
        out.put("ok", false);
        out.put("error", String.valueOf(e.getMessage()));
        out.put("errorClass", e.getClass().getName());
      } catch (Exception ignored) {
      }
      log("load error " + e);
    }
    return out;
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

      // 主服务给的是它自己机器上的路径，手机上没意义，只认设备本地的包
      String jar = new File(jarPath).exists() ? jarPath : "";
      if (jar.length() == 0) {
        // 设备上还没有包：用主服务随请求送来的配置地址自己拉，一次到位
        String url = site.optString("spiderUrl");
        String md5 = site.optString("spiderMd5");
        if (url.length() == 0) {
          throw new IllegalStateException("设备上没有 spider 包，且请求里没带 spiderUrl；先调 POST /load {url,md5}");
        }
        Long last = loadAttempts.get(url);
        long now = System.currentTimeMillis();
        if (last != null && now - last < 60000 && !new File(jarPath).exists()) {
          throw new IllegalStateException("正在/刚刚拉取过 spider 包，稍后再试（60s 内不重复下载）");
        }
        loadAttempts.put(url, now);
        JSONObject lr = load(packLoadReq(url, md5));
        if (!lr.optBoolean("ok")) {
          throw new IllegalStateException("自动拉取 spider 包失败: " + lr.optString("error"));
        }
        jar = jarPath;
      }

      Object sp = instance(key, api, ext, jar);
      Object data = dispatch(sp, req.optString("method"), req.optJSONObject("params"));
      out.put("ok", true);
      out.put("data", data == null ? "" : String.valueOf(data));
      out.put("tookMs", System.currentTimeMillis() - t0);
      out.put("engine", "android/" + Build.VERSION.RELEASE + " " + Build.SUPPORTED_ABIS[0]);
    } catch (Throwable e) {
      StringWriter sw = new StringWriter();
      e.printStackTrace(new PrintWriter(sw));
      try {
        out.put("ok", false);
        out.put("error", String.valueOf(e.getMessage()));
        out.put("errorClass", e.getClass().getName());
        String st = sw.toString();
        out.put("stack", st.substring(0, Math.min(1200, st.length())));
        out.put("hint", hintFor(e));
        out.put("logs", new JSONArray(logs));
      } catch (Exception ignored) {
      }
      log("spider error " + e);
    }
    return out;
  }

  private static JSONObject packLoadReq(String url, String md5) {
    try {
      JSONObject o = new JSONObject();
      o.put("url", url);
      o.put("md5", md5);
      return o;
    } catch (Exception e) {
      return new JSONObject();
    }
  }

  private static String hintFor(Throwable e) {
    String s = String.valueOf(e);
    if (e instanceof UnsatisfiedLinkError || s.contains("dlopen") || s.contains("couldn't find")) {
      return "native 库没加载：确认 APK 的 lib/<abi>/lib*.so 与加固包 assets/*.so 同名对应；"
          + "x86 设备缺少 arm 转译时也会这样";
    }
    if (e instanceof ClassNotFoundException || s.contains("NoClassDefFoundError")) {
      return "缺宿主类：spider 包只含站点实现，父类 com.github.catvod.crawler.Spider 等必须由 APK 提供";
    }
    if (s.contains("DexNative")) {
      return "加固壳解密失败：确认包内 assets/*.so 已按 ABI 打进 APK，且设备为 arm";
    }
    return "";
  }

  private String defaultJar() {
    File f = new File(new File(getFilesDir(), "spider"), "spider.jar");
    return f.getAbsolutePath();
  }

  private Object instance(String key, String api, String ext, String jarPath) throws Exception {
    String className = resolveClass(api);
    String id = jarPath + "#" + className + "#" + key;
    Object hit = spiders.get(id);
    if (hit != null) return hit;

    File jar = new File(jarPath);
    if (!jar.exists()) throw new IllegalStateException("spider jar 不存在: " + jarPath);

    DexClassLoader cl = activeLoaders.get(jarPath);
    if (cl == null) {
      synchronized (this) {
        cl = activeLoaders.get(jarPath);
        if (cl == null) {
          cl = openJar(jarPath);
          activeLoaders.put(jarPath, cl);
        }
      }
    }

    Class<?> c = Class.forName(className, true, cl);
    Object o = c.getDeclaredConstructor().newInstance();
    applySiteKeyAndInit(o, ext);
    spiders.put(id, o);
    log("loaded " + className + " via " + (isProtected(loaders.get(jarPath)) ? "DexNative" : "direct"));
    return o;
  }

  /**
   * 建 DexClassLoader 并完成 jar 初始化，返回「能真正加载站点类」的那个加载器。
   *
   * 两条路，与 TVBox 的 JarLoader/ProtectedInitJar 完全一致：
   *
   *  A. 普通 jar：直接 Init.init(Context)
   *  B. 加固包（包内有 com.github.catvod.spider.DexNative）：
   *     壳的 classes.dex 只是解密器，真实站点类由 DexNative 解密后装进一个新的 DexClassLoader。
   *     必须走 Init.get() → 注入 Context → DexNative.getLoader(ctx) → 把返回的加载器
   *     反射写回 Init 实例的 DexClassLoader 字段 → replaceCloudDiskNames() / startGoProxy(ctx)。
   *     之后所有站点类都要从那个「新」加载器里取，用原来的 loader 一定 ClassNotFound。
   */
  private DexClassLoader openJar(String jarPath) throws Exception {
    File cache = new File(getFilesDir(), "dexout");
    if (!cache.exists()) cache.mkdirs();

    DexClassLoader raw = new DexClassLoader(
        jarPath, cache.getAbsolutePath(), cache.getAbsolutePath(), getClassLoader());
    loaders.put(jarPath, raw);

    Context app = getApplicationContext();

    // ---- B：加固包 ----
    if (isProtected(raw)) {
      try {
        Class<?> initClz = raw.loadClass("com.github.catvod.spider.Init");

        Object initObj = null;
        try {
          Method get = initClz.getMethod("get");
          get.setAccessible(true);
          initObj = get.invoke(null);
        } catch (Throwable ignored) {
        }

        // Context 注入：优先字段名 c，其次任意 Context 类型字段
        if (initObj != null) {
          try {
            java.lang.reflect.Field f = initClz.getDeclaredField("c");
            f.setAccessible(true);
            f.set(initObj, app);
          } catch (Throwable ignored) {
            for (java.lang.reflect.Field f : initClz.getDeclaredFields()) {
              if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) continue;
              if (!Context.class.isAssignableFrom(f.getType())) continue;
              try {
                f.setAccessible(true);
                f.set(initObj, app);
              } catch (Throwable ignored2) {
              }
            }
          }
        }

        Class<?> dexNative = raw.loadClass("com.github.catvod.spider.DexNative");
        Object loaderObj = dexNative.getMethod("getLoader", Object.class).invoke(null, app);
        if (!(loaderObj instanceof DexClassLoader)) {
          initErrors.put(jarPath, "DexNative.getLoader 未返回 DexClassLoader: "
              + (loaderObj == null ? "null" : loaderObj.getClass().getName()));
          log("protected init 失败: " + initErrors.get(jarPath));
          return raw;
        }
        DexClassLoader real = (DexClassLoader) loaderObj;

        // 把解密后的加载器注入壳的 Init 实例（字段可能是继承来的）
        if (initObj != null) {
          for (Class<?> t = initClz; t != null; t = t.getSuperclass()) {
            for (java.lang.reflect.Field f : t.getDeclaredFields()) {
              if (java.lang.reflect.Modifier.isStatic(f.getModifiers())) continue;
              if (!DexClassLoader.class.isAssignableFrom(f.getType())) continue;
              try {
                f.setAccessible(true);
                f.set(initObj, real);
              } catch (Throwable ignored) {
              }
            }
          }
        }

        try {
          initClz.getMethod("replaceCloudDiskNames").invoke(null);
        } catch (Throwable ignored) {
        }
        try {
          initClz.getMethod("startGoProxy", Context.class).invoke(null, app);
        } catch (Throwable ignored) {
        }

        log("protected jar ready, real loader = " + real);
        injectProxyPort(real);
        return real;
      } catch (Throwable e) {
        initErrors.put(jarPath, String.valueOf(e));
        log("protected init 异常，回落普通 init: " + e);
      }
    }

    // ---- A：普通 jar ----
    try {
      Class<?> initClz = raw.loadClass("com.github.catvod.spider.Init");
      try {
        initClz.getMethod("init", Context.class).invoke(null, app);
      } catch (Throwable ignored) {
      }
    } catch (Throwable ignored) {
    }
    injectProxyPort(raw);
    return raw;
  }

  /**
   * 把侧车端口告诉 spider，这样 csp_* 里的 proxy() 才能生成可访问的代理地址。
   * 类名两个位置都试：TVBox 用 com.github.catvod.Proxy，jar 里是 com.github.catvod.spider.Proxy。
   */
  private void injectProxyPort(DexClassLoader loader) {
    for (String cls : new String[]{"com.github.catvod.Proxy", "com.github.catvod.spider.Proxy"}) {
      try {
        Class<?> c = loader.loadClass(cls);
        for (Method m : c.getMethods()) {
          if (!"set".equals(m.getName())) continue;
          Class<?>[] ps = m.getParameterTypes();
          if (ps.length == 1 && (ps[0] == int.class || ps[0] == Integer.class)) {
            m.invoke(null, port);
            return;
          }
        }
      } catch (Throwable ignored) {
      }
    }
  }

  /** 包内有 DexNative 就是加固包：壳的 classes.dex 只有解密器 */
  private static boolean isProtected(DexClassLoader raw) {
    if (raw == null) return false;
    try {
      raw.loadClass("com.github.catvod.spider.DexNative");
      return true;
    } catch (Throwable e) {
      return false;
    }
  }

  /** ext 与 siteKey 是很多站点的必需输入，缺了会直接空结果 */
  private void applySiteKeyAndInit(Object spider, String ext) {
    try {
      java.lang.reflect.Field f = spider.getClass().getField("siteKey");
      f.set(spider, "");
    } catch (Throwable ignored) {
    }
    for (Method m : spider.getClass().getMethods()) {
      if (!"init".equals(m.getName())) continue;
      Class<?>[] ps = m.getParameterTypes();
      try {
        if (ps.length == 1 && Context.class.isAssignableFrom(ps[0])) {
          m.invoke(spider, this);
          return;
        }
        if (ps.length == 2 && Context.class.isAssignableFrom(ps[0]) && ps[1] == String.class) {
          m.invoke(spider, this, ext == null ? "" : ext);
          return;
        }
      } catch (Throwable ignored) {
      }
    }
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
    if ("home".equals(method)) {
      return c.getMethod("homeContent", boolean.class).invoke(sp, true);
    }
    if ("category".equals(method)) {
      HashMap<String, String> f = new HashMap<String, String>();
      // 真实签名是 categoryContent(String tid, String pg, boolean filter, HashMap extend)
      // 少传一个 pg 会直接 NoSuchMethodException，分类页整页打不开
      return c.getMethod("categoryContent", String.class, String.class, boolean.class, HashMap.class)
          .invoke(sp, p.optString("tid"), String.valueOf(p.optInt("pg", 1)), false, f);
    }
    if ("detail".equals(method)) {
      List<String> ids = new ArrayList<String>();
      ids.add(p.optString("id"));
      return c.getMethod("detailContent", List.class).invoke(sp, ids);
    }
    if ("search".equals(method)) {
      return c.getMethod("searchContent", String.class, boolean.class)
          .invoke(sp, p.optString("wd"), false);
    }
    if ("play".equals(method)) {
      List<String> ids = new ArrayList<String>();
      ids.add(p.optString("ep"));
      return c.getMethod("playerContent", String.class, List.class, HashMap.class)
          .invoke(sp, p.optString("flag"), ids, new HashMap<String, String>());
    }
    throw new IllegalArgumentException("不支持的方法 " + method);
  }
}
