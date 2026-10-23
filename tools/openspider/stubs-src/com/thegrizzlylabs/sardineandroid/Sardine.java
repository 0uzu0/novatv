package com.thegrizzlylabs.sardineandroid;

import java.io.ByteArrayInputStream;
import java.io.InputStream;
import java.util.Collections;
import java.util.List;

/**
 * 编译期桩：WebDAV 客户端接口。
 *
 * 为什么需要：CatVodSpider 的 `spider/Proxy.java` 引用了 `spider/WebDAV.java`，
 * 而 WebDAV 依赖 `com.github.thegrizzlylabs:sardine-android`（jitpack 坐标，
 * Maven Central 上没有，本地拉不到）。javac 顺着 sourcepath 会把整条链都编一遍，
 * 缺这个包就导致 Bili / Push / Wogg 一起编译失败。
 *
 * 这里只声明「签名用得到」的成员，让编译通过。桩类只进编译 classpath，
 * **不打包进 oss-spiders.jar**；真跑 WebDAV 源时仍会缺类——那本来也不在本项目范围。
 */
public interface Sardine {

  List<DavResource> list(String url);

  void setCredentials(String username, String password);

  /** WebDAV 源代理直连时用：把远端文件当流返回 */
  default InputStream get(String url) {
    return new ByteArrayInputStream(new byte[0]);
  }

  default List<DavResource> list(String url, boolean omitEmpty) {
    return Collections.emptyList();
  }
}
