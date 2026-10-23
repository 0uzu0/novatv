package android.util;

/**
 * Android 日志桩。
 *
 * 开源 spider 里到处是 `Log.d(tag, msg)`（比如 SpiderDebug），服务端没有 logcat，
 * 直接把内容打到 stderr 即可。方法签名与 Android 一致，返回 int。
 */
public final class Log {

  public static int v(String tag, String msg) {
    return print("V", tag, msg, null);
  }

  public static int v(String tag, String msg, Throwable tr) {
    return print("V", tag, msg, tr);
  }

  public static int d(String tag, String msg) {
    return print("D", tag, msg, null);
  }

  public static int d(String tag, String msg, Throwable tr) {
    return print("D", tag, msg, tr);
  }

  public static int i(String tag, String msg) {
    return print("I", tag, msg, null);
  }

  public static int i(String tag, String msg, Throwable tr) {
    return print("I", tag, msg, tr);
  }

  public static int w(String tag, String msg) {
    return print("W", tag, msg, null);
  }

  public static int w(String tag, String msg, Throwable tr) {
    return print("W", tag, msg, tr);
  }

  public static int e(String tag, String msg) {
    return print("E", tag, msg, null);
  }

  public static int e(String tag, String msg, Throwable tr) {
    return print("E", tag, msg, tr);
  }

  private static int print(String lv, String tag, String msg, Throwable tr) {
    System.err.println("[" + lv + "/" + tag + "] " + msg);
    if (tr != null) tr.printStackTrace();
    return 0;
  }

  private Log() {}
}
