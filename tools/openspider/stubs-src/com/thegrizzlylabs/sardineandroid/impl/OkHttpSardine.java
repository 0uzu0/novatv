package com.thegrizzlylabs.sardineandroid.impl;

import com.thegrizzlylabs.sardineandroid.DavResource;
import com.thegrizzlylabs.sardineandroid.Sardine;

import java.util.ArrayList;
import java.util.List;

/** 编译期桩：真实实现基于 OkHttp，本地没有 jitpack 依赖，这里给空实现。 */
public class OkHttpSardine implements Sardine {

  @Override
  public List<DavResource> list(String url) {
    return new ArrayList<>();
  }

  @Override
  public void setCredentials(String username, String password) {
    // 桩实现：无凭据逻辑
  }
}
