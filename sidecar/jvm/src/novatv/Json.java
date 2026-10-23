package novatv;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** 最小 JSON 解析/序列化：侧车不引第三方依赖，保证 java -cp 直接能跑 */
public final class Json {
  private final String s;
  private int i;

  private Json(String s) {
    this.s = s;
  }

  public static Object parse(String text) {
    Json p = new Json(text);
    p.ws();
    Object v = p.value();
    return v;
  }

  @SuppressWarnings("unchecked")
  public static Map<String, Object> obj(Object o) {
    return o instanceof Map ? (Map<String, Object>) o : new LinkedHashMap<>();
  }

  @SuppressWarnings("unchecked")
  public static List<Object> arr(Object o) {
    return o instanceof List ? (List<Object>) o : new ArrayList<>();
  }

  public static String str(Object o) {
    return o == null ? "" : String.valueOf(o);
  }

  private void ws() {
    while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
  }

  private Object value() {
    char c = s.charAt(i);
    if (c == '{') return object();
    if (c == '[') return array();
    if (c == '"') return string();
    if (s.startsWith("true", i)) { i += 4; return Boolean.TRUE; }
    if (s.startsWith("false", i)) { i += 5; return Boolean.FALSE; }
    if (s.startsWith("null", i)) { i += 4; return null; }
    return number();
  }

  private Map<String, Object> object() {
    Map<String, Object> m = new LinkedHashMap<>();
    i++;
    ws();
    if (s.charAt(i) == '}') { i++; return m; }
    while (true) {
      ws();
      String k = string();
      ws();
      i++; // :
      ws();
      m.put(k, value());
      ws();
      char c = s.charAt(i++);
      if (c == '}') return m;
    }
  }

  private List<Object> array() {
    List<Object> l = new ArrayList<>();
    i++;
    ws();
    if (s.charAt(i) == ']') { i++; return l; }
    while (true) {
      ws();
      l.add(value());
      ws();
      char c = s.charAt(i++);
      if (c == ']') return l;
    }
  }

  private String string() {
    StringBuilder b = new StringBuilder();
    i++; // "
    while (true) {
      char c = s.charAt(i++);
      if (c == '"') break;
      if (c == '\\') {
        char e = s.charAt(i++);
        switch (e) {
          case 'n': b.append('\n'); break;
          case 't': b.append('\t'); break;
          case 'r': b.append('\r'); break;
          case 'b': b.append('\b'); break;
          case 'f': b.append('\f'); break;
          case 'u':
            b.append((char) Integer.parseInt(s.substring(i, i + 4), 16));
            i += 4;
            break;
          default: b.append(e);
        }
      } else b.append(c);
    }
    return b.toString();
  }

  private Object number() {
    int st = i;
    while (i < s.length() && "-+.eE0123456789".indexOf(s.charAt(i)) >= 0) i++;
    String t = s.substring(st, i);
    if (t.contains(".") || t.contains("e") || t.contains("E")) return Double.parseDouble(t);
    return Long.parseLong(t);
  }

  public static String write(Object o) {
    StringBuilder b = new StringBuilder();
    writeTo(o, b);
    return b.toString();
  }

  private static void writeTo(Object o, StringBuilder b) {
    if (o == null) { b.append("null"); return; }
    if (o instanceof String) { quote((String) o, b); return; }
    if (o instanceof Number || o instanceof Boolean) { b.append(o); return; }
    if (o instanceof Map) {
      b.append('{');
      boolean first = true;
      for (Map.Entry<?, ?> e : ((Map<?, ?>) o).entrySet()) {
        if (!first) b.append(',');
        first = false;
        quote(String.valueOf(e.getKey()), b);
        b.append(':');
        writeTo(e.getValue(), b);
      }
      b.append('}');
      return;
    }
    if (o instanceof Iterable) {
      b.append('[');
      boolean first = true;
      for (Object v : (Iterable<?>) o) {
        if (!first) b.append(',');
        first = false;
        writeTo(v, b);
      }
      b.append(']');
      return;
    }
    quote(String.valueOf(o), b);
  }

  private static void quote(String s, StringBuilder b) {
    b.append('"');
    for (int k = 0; k < s.length(); k++) {
      char c = s.charAt(k);
      switch (c) {
        case '"': b.append("\\\""); break;
        case '\\': b.append("\\\\"); break;
        case '\n': b.append("\\n"); break;
        case '\r': b.append("\\r"); break;
        case '\t': b.append("\\t"); break;
        default:
          if (c < 0x20) b.append(String.format("\\u%04x", (int) c));
          else b.append(c);
      }
    }
    b.append('"');
  }
}
