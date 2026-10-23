package com.github.catvod.crawler;

import android.content.Context;
import java.util.HashMap;
import java.util.List;

/**
 * CatVod Spider 抽象类的最小占位实现。
 * 未加固的 spider jar 编译时依赖这些类，宿主要提供它们才能链接。
 * 方法签名与 TVBox 的 com.github.catvod.crawler.Spider 保持一致。
 */
public abstract class Spider {
  public void init(Context context) throws Exception {}

  public void init(Context context, String extend) throws Exception {
    init(context);
  }

  public String homeContent(boolean filter) {
    return "";
  }

  public String homeVideoContent() {
    return "";
  }

  public String categoryContent(String tid, boolean isVideo, HashMap<String, String> filters) {
    return "";
  }

  public String detailContent(List<String> ids) {
    return "";
  }

  public String searchContent(String key, boolean quick) {
    return "";
  }

  public String playerContent(String flag, List<String> ids, HashMap<String, String> flags) {
    return "";
  }
}
