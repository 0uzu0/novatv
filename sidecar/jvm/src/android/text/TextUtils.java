package android.text;

/**
 * android.text.TextUtils 的 JVM 侧车实现。
 *
 * <p>第三方 spider jar 在 Android 上编译，普遍调用 {@code TextUtils.isEmpty / equals}。
 * 纯 JVM 没有 android.jar（有也是抛 RuntimeException("Stub!") 的空壳），
 * 所以这里给一份行为等价的实现，让 jar 能在侧车里真跑起来。
 *
 * <p>只实现「爬虫代码实际会用到」的那几个方法；UI 相关的不需要。
 */
public final class TextUtils {
  private TextUtils() {}

  public static boolean isEmpty(CharSequence str) {
    return str == null || str.length() == 0;
  }

  public static boolean equals(CharSequence a, CharSequence b) {
    if (a == b) return true;
    if (a == null || b == null || a.length() != b.length()) return false;
    if (a instanceof String && b instanceof String) return a.equals(b);
    for (int i = 0; i < a.length(); i++) {
      if (a.charAt(i) != b.charAt(i)) return false;
    }
    return true;
  }

  public static boolean equalsIgnoreCase(CharSequence a, CharSequence b) {
    if (a == b) return true;
    if (a == null || b == null || a.length() != b.length()) return false;
    return a.toString().equalsIgnoreCase(b.toString());
  }

  public static String join(CharSequence delimiter, Iterable<?> tokens) {
    StringBuilder sb = new StringBuilder();
    boolean first = true;
    if (tokens != null) {
      for (Object t : tokens) {
        if (!first) sb.append(delimiter);
        sb.append(t);
        first = false;
      }
    }
    return sb.toString();
  }

  public static String join(CharSequence delimiter, Object[] tokens) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < tokens.length; i++) {
      if (i > 0) sb.append(delimiter);
      sb.append(tokens[i]);
    }
    return sb.toString();
  }

  public static String[] split(String text, String expression) {
    if (text == null || text.isEmpty()) return new String[0];
    return text.split(expression);
  }

  public static String substring(CharSequence source, int start, int end) {
    return source.subSequence(start, end).toString();
  }

  public static boolean isDigitsOnly(CharSequence str) {
    if (isEmpty(str)) return false;
    for (int i = 0; i < str.length(); i++) {
      if (!Character.isDigit(str.charAt(i))) return false;
    }
    return true;
  }

  public static String nullIfEmpty(String str) {
    return isEmpty(str) ? null : str;
  }

  public static String emptyIfNull(String str) {
    return str == null ? "" : str;
  }
}
