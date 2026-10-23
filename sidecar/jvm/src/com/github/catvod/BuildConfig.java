package com.github.catvod;

/**
 * Android 侧由 Gradle 自动生成的 BuildConfig 桩。
 *
 * 开源 spider 里有少量代码直接引用 `com.github.catvod.BuildConfig.CLIENT_ID`
 * （阿里云盘扫码登录用）。服务端没有 Android 构建流程，这里补一个最小常量，
 * 让这些类能编过、也能在 JVM 侧车上被类加载器找到。
 *
 * 只有走「阿里云盘 / 网盘类」站点时才真正用到，普通站点不碰这个类。
 */
public final class BuildConfig {
  public static final boolean DEBUG = false;
  public static final String APPLICATION_ID = "com.github.catvod";
  public static final String BUILD_TYPE = "release";
  public static final String CLIENT_ID = "d3NmR2ZhbGx0YWtlQ3J5cHRv";

  private BuildConfig() {}
}
