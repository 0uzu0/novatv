package com.github.catvod.crawler;

import android.content.Context;
import java.util.HashMap;
import java.util.List;

/**
 * CatVod Spider 抽象类的最小占位实现。
 *
 * <p>签名对齐 TVBox 2023+ / FongMi 的 {@code com.github.catvod.crawler.Spider}，
 * 目的是让「未加固的第三方 spider jar」可以在纯 JVM 上直接加载，不需要 Android。
 *
 * <p>兼容策略：新版契约里 categoryContent / searchContent 都多了分页参数，playerContent
 * 换了形参类型。这里把新旧签名都声明出来，新签名默认转发到旧签名 —— 这样
 * override 旧签名的老 jar 和 override 新签名的新 jar 都能工作。
 * 具体派发由 {@code novatv.Sidecar} 按「子类实际 override 了哪个」决定。
 */
public abstract class Spider {
  /** 站点标识，宿主注入（FongMi 新版用）。 */
  public String siteKey;

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

  /** 旧签名（TVBox 早期 / 加固包用的），3 参。 */
  public String categoryContent(String tid, boolean isVideo, HashMap<String, String> filters) {
    return "";
  }

  /** 新签名（TVBox 2023+ / FongMi），4 参。默认转发到旧签名。 */
  public String categoryContent(String tid, String pg, boolean filter, HashMap<String, String> extend) {
    return categoryContent(tid, filter, extend);
  }

  public String detailContent(List<String> ids) {
    return "";
  }

  /** 旧签名，2 参。 */
  public String searchContent(String key, boolean quick) {
    return "";
  }

  /** 新签名，3 参。默认转发到旧签名。 */
  public String searchContent(String key, boolean quick, String pg) {
    return searchContent(key, quick);
  }

  /** 旧签名（TVBox 早期）：ids 是播放列表、flags 是线路参数。 */
  public String playerContent(String flag, List<String> ids, HashMap<String, String> flags) {
    return "";
  }

  /** 新签名（TVBox 2023+ / FongMi）：单条 id + vipFlags。 */
  public String playerContent(String flag, String id, List<String> vipFlags) {
    java.util.ArrayList<String> one = new java.util.ArrayList<>();
    if (id != null) one.add(id);
    return playerContent(flag, one, new HashMap<>());
  }

  /** 宿主代理前缀（需要时由侧车注入），默认空。 */
  public String getProxyUrl() {
    return "";
  }

  /** 代理调用入口，宿主有 do=proxy 请求时用。 */
  public Object[] proxyLocal(HashMap<String, String> params) {
    return null;
  }
}
