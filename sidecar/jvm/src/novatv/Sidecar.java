package novatv;

import com.github.catvod.crawler.Spider;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.net.InetSocketAddress;
import java.net.URL;
import java.net.URLClassLoader;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * JVM 侧车：把 TVBox 的 spider jar 跑在服务端
 *
 * 只适用于「未加固」jar：classes.dex 被转成 class、或本来就是普通 jar。
 * 加固包（dex + .so + encrypted guard）这里必然加载失败——那是 Android 才能跑的东西。
 *
 * 协议：POST /spider  {site:{key,api,ext,spiderJar}, method, params:{...}}
 *      → {ok:true, data:"<spider 原始返回值>"} / {ok:false, error}
 *      GET /health → {ok:true, java, jars:[...], spiders:[...]}
 */
public final class Sidecar {
  private static final Map<String, Spider> INSTANCES = new HashMap<>();
  private static final Map<String, URLClassLoader> LOADERS = new HashMap<>();
  private static final List<String> LOGS = new ArrayList<>();
  private static int port = 8899;

  public static void main(String[] args) throws Exception {
    port = Integer.parseInt(System.getenv().getOrDefault("JVM_SIDECAR_PORT", "8899"));
    // 默认只监听回环（本机跑最安全）；容器里必须 0.0.0.0，否则主服务跨容器连不上
    String host = System.getenv().getOrDefault("JVM_SIDECAR_HOST", "127.0.0.1");
    HttpServer server = HttpServer.create(new InetSocketAddress(host, port), 0);
    server.createContext("/health", Sidecar::health);
    server.createContext("/spider", Sidecar::spider);
    server.setExecutor(java.util.concurrent.Executors.newFixedThreadPool(4));
    server.start();
    log("jvm sidecar listening on " + host + ":" + port);
    System.out.println("NovaTV JVM sidecar  ✦  http://" + host + ":" + port);
    System.out.println("  java=" + System.getProperty("java.version") + "  jar=" + defaultJar());
  }

  private static void log(String s) {
    LOGS.add(System.currentTimeMillis() + " " + s);
    if (LOGS.size() > 200) LOGS.remove(0);
  }

  private static String defaultJar() {
    String j = System.getenv("NOVA_SPIDER_JAR");
    if (j != null && !j.isBlank()) return j;
    Path p = Paths.get("sidecar", "jvm", "build", "demo-spider.jar");
    return p.toString();
  }

  private static void health(HttpExchange ex) throws java.io.IOException {
    Map<String, Object> out = new LinkedHashMap<>();
    out.put("ok", true);
    out.put("service", "novatv-jvm-sidecar");
    out.put("java", System.getProperty("java.version"));
    out.put("jar", defaultJar());
    out.put("loaded", new ArrayList<>(INSTANCES.keySet()));
    out.put("logs", new ArrayList<>(LOGS));
    reply(ex, 200, Json.write(out));
  }

  private static void spider(HttpExchange ex) throws java.io.IOException {
    if (!"POST".equalsIgnoreCase(ex.getRequestMethod())) {
      reply(ex, 405, Json.write(Map.of("ok", false, "error", "POST only")));
      return;
    }
    String body = read(ex.getRequestBody());
    Map<String, Object> req;
    try {
      req = Json.obj(Json.parse(body));
    } catch (Exception e) {
      reply(ex, 400, Json.write(Map.of("ok", false, "error", "bad json: " + e.getMessage())));
      return;
    }

    Map<String, Object> site = Json.obj(req.get("site"));
    Map<String, Object> params = Json.obj(req.get("params"));
    String method = Json.str(req.get("method"));
    String api = Json.str(site.get("api"));
    String ext = Json.str(site.get("ext"));
    String key = Json.str(site.get("key"));

    long t0 = System.currentTimeMillis();
    try {
      Spider sp = instance(key, api, ext, Json.str(site.get("spiderJar")));
      Object data = dispatch(sp, method, params);
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("ok", true);
      out.put("data", data);
      out.put("tookMs", System.currentTimeMillis() - t0);
      out.put("engine", "jvm-sidecar/" + System.getProperty("java.version"));
      reply(ex, 200, Json.write(out));
    } catch (Throwable e) {
      log("spider error: " + e);
      Map<String, Object> out = new LinkedHashMap<>();
      out.put("ok", false);
      out.put("error", String.valueOf(e.getMessage()));
      out.put("errorClass", e.getClass().getName());
      out.put("hint", hintFor(e));
      out.put("logs", new ArrayList<>(LOGS));
      reply(ex, 200, Json.write(out));
    }
  }

  private static String hintFor(Throwable e) {
    String s = String.valueOf(e);
    if (e instanceof NoClassDefFoundError || e instanceof ClassNotFoundException) {
      return "jar 里缺少依赖类：普通 jar 需要把 catvod/okhttp/jsoup 等依赖一起打进来，或改用 Android 侧车";
    }
    if (s.contains("dex")) return "这是 Android dex 包，需要 Android 运行时（sidecar/android）";
    if (s.contains("guard") || s.contains("ftyshinidie")) return "加固包在 native 层解密字节码，只能跑在 Android";
    return "";
  }

  private static Spider instance(String key, String api, String ext, String jarHint) throws Exception {
    String jarPath = !jarHint.isBlank() ? jarHint : defaultJar();
    String className = resolveClass(api);
    String id = jarPath + "#" + className + "#" + key;
    Spider hit = INSTANCES.get(id);
    if (hit != null) return hit;

    File jar = new File(jarPath.replaceFirst("^file:", ""));
    if (!jar.exists()) throw new IllegalStateException("spider jar 不存在: " + jarPath);
    URLClassLoader cl = LOADERS.computeIfAbsent(jarPath, k -> {
      try {
        return new URLClassLoader(new URL[] {jar.toURI().toURL()}, Sidecar.class.getClassLoader());
      } catch (Exception e) {
        throw new RuntimeException(e);
      }
    });
    Class<?> c = Class.forName(className, true, cl);
    Object o = c.getDeclaredConstructor().newInstance();
    if (!(o instanceof Spider)) throw new IllegalStateException(className + " 未继承 com.github.catvod.crawler.Spider");
    Spider sp = (Spider) o;
    sp.init(new android.content.Context(), ext);
    INSTANCES.put(id, sp);
    log("loaded " + className + " from " + jar.getName());
    return sp;
  }

  /** csp_XxxGuard → com.github.catvod.spider.XxxGuard；也支持 "path.jar#com.x.Y" 显式写法 */
  private static String resolveClass(String api) {
    if (api.contains("#")) return api.substring(api.indexOf('#') + 1).trim();
    String name = api.startsWith("csp_") ? api.substring(4) : api;
    if (!name.contains(".")) name = "com.github.catvod.spider." + name;
    return name;
  }

  @SuppressWarnings("unchecked")
  private static Object dispatch(Spider sp, String method, Map<String, Object> p) throws Exception {
    switch (method) {
      case "home":
        return sp.homeContent(true);
      case "homeVod":
        return sp.homeVideoContent();
      case "category": {
        HashMap<String, String> filters = new HashMap<>();
        Object f = p.get("filters");
        if (f instanceof Map) {
          for (Map.Entry<String, Object> e : ((Map<String, Object>) f).entrySet()) {
            filters.put(e.getKey(), Json.str(e.getValue()));
          }
        }
        return sp.categoryContent(Json.str(p.get("tid")), false, filters);
      }
      case "detail": {
        List<String> ids = new ArrayList<>();
        ids.add(Json.str(p.get("id")));
        return sp.detailContent(ids);
      }
      case "search":
        return sp.searchContent(Json.str(p.get("wd")), false);
      case "play": {
        List<String> ids = new ArrayList<>();
        ids.add(Json.str(p.get("ep")));
        return sp.playerContent(Json.str(p.get("flag")), ids, new HashMap<>());
      }
      default:
        throw new IllegalArgumentException("不支持的方法 " + method);
    }
  }

  private static String read(InputStream in) throws java.io.IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buf = new byte[8192];
    int n;
    while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
    return out.toString(StandardCharsets.UTF_8);
  }

  private static void reply(HttpExchange ex, int code, String body) throws java.io.IOException {
    byte[] b = body.getBytes(StandardCharsets.UTF_8);
    ex.getResponseHeaders().set("Content-Type", "application/json; charset=utf-8");
    ex.sendResponseHeaders(code, b.length);
    try (OutputStream os = ex.getResponseBody()) {
      os.write(b);
    }
  }
}
