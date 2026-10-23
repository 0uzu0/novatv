package com.github.catvod.spider;

import com.github.catvod.crawler.Spider;

import java.util.HashMap;
import java.util.List;

/**
 * 演示用 spider jar：模拟一个"未加固的普通 jar"。
 * 用来验证 JVM 侧车的完整链路（加载 → init → search → detail → play），
 * 不抓任何真实站点，只返回内置数据 + 公共测试流。
 */
public class DemoSpider extends Spider {
  private static final String HLS = "https://cdn.jsdelivr.net/gh/feiyang666999/testvideo/sdr4kvideo/playlist.m3u8";

  private String item(String id, String name, String pic, String note, String year) {
    return "{\"vod_id\":\"" + id + "\",\"vod_name\":\"" + name + "\",\"vod_pic\":\"" + pic
        + "\",\"vod_remarks\":\"" + note + "\",\"vod_year\":\"" + year
        + "\",\"vod_content\":\"由 JVM 侧车加载的 demo spider jar 提供\","
        + "\"vod_play_from\":\"jar线路\",\"vod_play_url\":\"正片$" + HLS + "\"}";
  }

  @Override
  public String homeContent(boolean filter) {
    String a = item("j1", "JAR 演示片 · 一", "/assets/p1.svg", "JVM 侧车", "2026");
    String b = item("j2", "JAR 演示片 · 二", "/assets/p3.svg", "JVM 侧车", "2026");
    return "{\"class\":[{\"type_id\":\"demo\",\"type_name\":\"侧车演示\"}],\"list\":[" + a + "," + b + "]}";
  }

  @Override
  public String categoryContent(String tid, boolean isVideo, HashMap<String, String> filters) {
    return homeContent(false).replace("\"class\":[{\"type_id\":\"demo\",\"type_name\":\"侧车演示\"}],", "");
  }

  @Override
  public String searchContent(String key, boolean quick) {
    String a = item("j1", "JAR 演示片 · 一", "/assets/p1.svg", "JVM 侧车", "2026");
    String b = item("j2", "JAR 演示片 · 二", "/assets/p3.svg", "JVM 侧车", "2026");
    return "{\"list\":[" + a + "," + b + "]}";
  }

  @Override
  public String detailContent(List<String> ids) {
    String id = ids == null || ids.isEmpty() ? "j1" : ids.get(0);
    String name = "j2".equals(id) ? "JAR 演示片 · 二" : "JAR 演示片 · 一";
    String pic = "j2".equals(id) ? "/assets/p3.svg" : "/assets/p1.svg";
    return "{\"list\":[" + item(id, name, pic, "JVM 侧车", "2026") + "]}";
  }

  @Override
  public String playerContent(String flag, List<String> ids, HashMap<String, String> flags) {
    return "{\"parse\":0,\"url\":\"" + HLS + "\",\"flag\":\"" + flag + "\"}";
  }
}
