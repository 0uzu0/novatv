package novatv;

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
 * 设计要点（为什么用反射而不是强类型）：
 *   TVBox 生态的 spider jar 各自自带不同版本的 com.github.catvod.crawler.Spider
 *   （老版 3 参 categoryContent、新版 4 参，playerContent 形参也换过）。
 *   如果侧车用自己编译的 Spider 强转，父子类不是同一个 Class，必然 ClassCastException
 *   或 NoSuchMethodError。所以这里：
 *     1) 用 ChildFirstClassLoader 让 jar 自带的 com.github.catvod.* 生效
 *     2) 派发全部走反射，按「新签名优先、旧签名兜底」的候选链找方法
 *   这样同一台侧车既能跑老 jar，也能跑 FongMi 2024+ 的 jar。
 *
 * 协议：POST /spider  {site:{key,api,ext,spiderJar}, method, params:{...}}
 *      → {ok:true, data:"<spider 原始返回值>"} / {ok:false, error}
 *      GET /health → {ok:true, java, jars:[...], spiders:[...]}
 */
public final class Sidecar {
  private static final Map<String, Object> INSTANCES = new HashMap<>();
  private static final Map<String, URLClassLoader> LOADERS = new HashMap<>();
  private static final List<String> LOGS = new ArrayList<>();
  private static int port = 8899;

  /**
   * 让 jar 自带的 com.github.catvod.* / org.json / org.jsoup 优先于侧车自己的 classpath。
   * 其余（android.*、okhttp3.*、java.*）仍走父加载器，保证「Context 只有一个」。
   */
  private static final class ChildFirstLoader extends URLClassLoader {
    ChildFirstLoader(URL[] urls, ClassLoader parent) {
      super(urls, parent);
    }

    @Override
    protected Class<?> loadClass(String name, boolean resolve) throws ClassNotFoundException {
      boolean owned =
          name.startsWith("com.github.catvod.") || name.startsWith("org.json.") || name.startsWith("org.jsoup.");
      if (!owned) return super.loadClass(name, resolve);
      synchronized (getClassLoadingLock(name)) {
        Class<?> c = findLoadedClass(name);
        if (c == null) {
          try {
            c = findClass(name);
          } catch (ClassNotFoundException ignored) {
            // jar 里没有 → 回落到父加载器（可能是侧车自带的占位实现）
          }
        }
        if (c == null) return super.loadClass(name, resolve);
        if (resolve) resolveClass(c);
        return c;
      }
    }
  }

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
      Object sp = instance(key, api, ext, Json.str(site.get("spiderJar")));
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
    if (e instanceof NoSuchMethodError) {
      return "jar 与侧车基类的方法签名不一致：该 jar 按更老/更新的 CatVod API 编译。"
          + "把该 jar 自带的 com/github/catvod/crawler/Spider.class 一起打进 jar 即可（侧车会优先用它）";
    }
    if (e instanceof NoClassDefFoundError || e instanceof ClassNotFoundException) {
      return "jar 里缺少依赖类：把 catvod/okhttp/jsoup/org.json 等依赖一起打进来，或把依赖 jar 放进 sidecar/jvm/libs";
    }
    if (s.contains("dex")) return "这是 Android dex 包，需要 Android 运行时（sidecar/android）";
    if (s.contains("guard") || s.contains("ftyshinidie")) return "加固包在 native 层解密字节码，只能跑在 Android";
    return "";
  }

  private static Object instance(String key, String api, String ext, String jarHint) throws Exception {
    String jarPath = !jarHint.isBlank() ? jarHint : defaultJar();
    String className = resolveClass(api);
    String id = jarPath + "#" + className + "#" + key;
    Object hit = INSTANCES.get(id);
    if (hit != null) return hit;

    File jar = new File(jarPath.replaceFirst("^file:", ""));
    if (!jar.exists()) throw new IllegalStateException("spider jar 不存在: " + jarPath);
    URLClassLoader cl =
        LOADERS.computeIfAbsent(
            jarPath,
            k -> {
              try {
                return new ChildFirstLoader(new URL[] {jar.toURI().toURL()}, Sidecar.class.getClassLoader());
              } catch (Exception e) {
                throw new RuntimeException(e);
              }
            });
    Class<?> c = Class.forName(className, true, cl);
    Object o = c.getDeclaredConstructor().newInstance();
    initSpider(o, ext);
    INSTANCES.put(id, o);
    log("loaded " + className + " from " + jar.getName());
    return o;
  }

  /**
   * init(Context,String) 优先，其次 init(Context)；老 jar 只有前者。
   *
   * 传的是 Application（Context 的子类）：Push 这类源会在 init 里把入参强转成
   * Application，直接给 Context 会 ClassCastException。Application IS-A Context，
   * 对只认 Context 的源没有影响。
   */
  private static void initSpider(Object o, String ext) throws Exception {
    android.content.Context ctx = new android.app.Application();
    try {
      Method m = o.getClass().getMethod("init", android.content.Context.class, String.class);
      unwrap(m, o, new Object[] {ctx, ext});
      return;
    } catch (NoSuchMethodException ignored) {
      // 只有 init(Context) 的老写法
    }
    try {
      Method m = o.getClass().getMethod("init", android.content.Context.class);
      unwrap(m, o, new Object[] {ctx});
    } catch (NoSuchMethodException ignored) {
      // jar 没有 init，视为无状态爬虫
    }
  }

  /** csp_XxxGuard → com.github.catvod.spider.XxxGuard；也支持 "path.jar#com.x.Y" 显式写法 */
  private static String resolveClass(String api) {
    if (api.contains("#")) return api.substring(api.indexOf('#') + 1).trim();
    String name = api.startsWith("csp_") ? api.substring(4) : api;
    if (!name.contains(".")) name = "com.github.catvod.spider." + name;
    return name;
  }

  /**
   * 反射派发。候选链「新签名优先、旧签名兜底」——
   * 因为基类同时声明两套签名（新签名默认转发旧签名），
   * 所以 override 任一版本的 jar 都能被正确命中。
   */
  private static Object dispatch(Object sp, String method, Map<String, Object> p) throws Exception {
    switch (method) {
      case "home":
        return call(sp, "homeContent", new Object[] {true});
      case "homeVod":
        return call(sp, "homeVideoContent", new Object[] {});
      case "category": {
        HashMap<String, String> filters = new HashMap<>();
        Object f = p.get("filters");
        if (f instanceof Map) {
          for (Map.Entry<String, Object> e : ((Map<String, Object>) f).entrySet()) {
            filters.put(e.getKey(), Json.str(e.getValue()));
          }
        }
        String tid = Json.str(p.get("tid"));
        String pg = Json.str(p.get("pg") == null ? "1" : p.get("pg"));
        return call(
            sp,
            "categoryContent",
            new Object[] {tid, pg, false, filters},   // TVBox 2023+ / FongMi
            new Object[] {tid, false, filters});      // 老版 / 加固包同源 API
      }
      case "detail": {
        List<String> ids = new ArrayList<>();
        ids.add(Json.str(p.get("id")));
        return call(sp, "detailContent", new Object[] {ids});
      }
      case "search": {
        String wd = Json.str(p.get("wd"));
        String pg = Json.str(p.get("pg"));
        return call(
            sp,
            "searchContent",
            new Object[] {wd, false, pg},
            new Object[] {wd, false});
      }
      case "play": {
        String flag = Json.str(p.get("flag"));
        String ep = Json.str(p.get("ep"));
        List<String> one = new ArrayList<>();
        one.add(ep);
        return call(
            sp,
            "playerContent",
            new Object[] {flag, ep, new ArrayList<String>()},  // FongMi: (flag, id, vipFlags)
            new Object[] {flag, one, new HashMap<String, String>()}); // 旧: (flag, ids, flags)
      }
      default:
        throw new IllegalArgumentException("不支持的方法 " + method);
    }
  }

  private static Object call(Object sp, String name, Object[]... candidates) throws Exception {
    for (Object[] args : candidates) {
      Method m = find(sp.getClass(), name, args);
      if (m != null) return unwrap(m, sp, args);
    }
    for (Method m : sp.getClass().getMethods()) {
      if (m.getName().equals(name)) {
        throw new NoSuchMethodException(name + " 的签名不在侧车候选链里（jar 用了别的 CatVod API 版本）");
      }
    }
    return ""; // spider 本身没实现这个方法，等同基类空实现
  }

  private static Method find(Class<?> c, String name, Object[] args) {
    for (Method m : c.getMethods()) {
      if (!m.getName().equals(name) || m.getParameterCount() != args.length) continue;
      if (fits(m.getParameterTypes(), args)) return m;
    }
    return null;
  }

  private static boolean fits(Class<?>[] types, Object[] args) {
    for (int i = 0; i < types.length; i++) {
      Class<?> t = types[i];
      Object a = args[i];
      if (t.isPrimitive()) {
        if (a == null) return false;
        if (!wrap(t).isInstance(a)) return false;
      } else if (a != null && !t.isInstance(a)) {
        return false;
      }
    }
    return true;
  }

  private static Class<?> wrap(Class<?> t) {
    if (!t.isPrimitive()) return t;
    if (t == boolean.class) return Boolean.class;
    if (t == int.class) return Integer.class;
    if (t == long.class) return Long.class;
    if (t == double.class) return Double.class;
    if (t == float.class) return Float.class;
    if (t == short.class) return Short.class;
    if (t == byte.class) return Byte.class;
    if (t == char.class) return Character.class;
    return Void.class;
  }

  private static Object unwrap(Method m, Object sp, Object[] args) throws Exception {
    try {
      return m.invoke(sp, args);
    } catch (java.lang.reflect.InvocationTargetException e) {
      Throwable t = e.getCause();
      if (t instanceof Exception ex) throw ex;
      if (t instanceof Error err) throw err;
      throw new RuntimeException(t);
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
