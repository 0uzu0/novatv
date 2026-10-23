package android.util;

import java.nio.charset.StandardCharsets;

/**
 * Android Base64 桩，用 JDK 的 java.util.Base64 实现。
 *
 * 开源 spider 大量用 `android.util.Base64.decode(x, Base64.DEFAULT)` 解内置参数，
 * TVBox 生态里这是最常见的一个 Android 依赖，必须给真实行为而不是空实现。
 */
public final class Base64 {

  public static final int DEFAULT = 0;
  public static final int NO_PADDING = 1;
  public static final int NO_WRAP = 2;
  public static final int CRLF = 4;
  public static final int URL_SAFE = 8;
  public static final int NO_CLOSE = 16;

  public static byte[] decode(String str, int flags) {
    return decode(str.getBytes(StandardCharsets.UTF_8), flags);
  }

  public static byte[] decode(byte[] input, int flags) {
    String s = new String(input, StandardCharsets.UTF_8).replaceAll("\\s", "");
    if ((flags & URL_SAFE) != 0) s = s.replace('-', '+').replace('_', '/');
    int pad = s.length() % 4;
    if (pad != 0) s = s + "====".substring(pad);
    return java.util.Base64.getDecoder().decode(s);
  }

  public static String encodeToString(byte[] input, int flags) {
    return new String(encode(input, flags), StandardCharsets.UTF_8);
  }

  public static byte[] encode(byte[] input, int flags) {
    java.util.Base64.Encoder enc =
        (flags & URL_SAFE) != 0 ? java.util.Base64.getUrlEncoder() : java.util.Base64.getEncoder();
    if ((flags & NO_PADDING) != 0) enc = enc.withoutPadding();
    byte[] out = enc.encode(input);
    if ((flags & NO_WRAP) == 0 && out.length > 76) {
      // Android 默认按 76 列换行
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < out.length; i++) {
        if (i > 0 && i % 76 == 0) sb.append('\n');
        sb.append((char) out[i]);
      }
      return sb.toString().getBytes(StandardCharsets.UTF_8);
    }
    return out;
  }

  private Base64() {}
}
