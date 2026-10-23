package com.thegrizzlylabs.sardineandroid;

/** 编译期桩：WebDAV 目录项。只保留 spider 代码读取的字段访问器。 */
public class DavResource {

  public String getName() {
    return "";
  }

  public String getPath() {
    return "";
  }

  public boolean isDirectory() {
    return false;
  }

  public long getContentLength() {
    return 0L;
  }

  public java.util.Date getModified() {
    return new java.util.Date(0L);
  }

  @Override
  public String toString() {
    return getPath();
  }
}
