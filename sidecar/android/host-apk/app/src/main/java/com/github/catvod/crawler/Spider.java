package com.github.catvod.crawler;

import android.content.Context;

import org.json.JSONObject;

import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * CatVod spider 基类（宿主侧最小兼容实现）。
 *
 * 为什么需要它：spider 包里只有站点实现（csp_*Guard → com.github.catvod.spider.*Guard），
 * 它们的父类 com.github.catvod.crawler.Spider 由 TVBox 宿主 APP 提供，jar 里没有定义。
 * 我们自己起侧车就必须把这个基类带上，否则 Class.forName 会因解析不到父类报
 * NoClassDefFoundError。
 *
 * 签名与 TVBoxOS 保持一致（同包同名同方法），spider 的 invokevirtual 才能解析到。
 */
public class Spider {

    public static JSONObject empty = new JSONObject();
    public String siteKey;

    protected static Context mContext;

    public void init(Context context) {
        mContext = context;
    }

    public void init(Context context, String extend) {
        init(context);
    }

    public String homeContent(boolean filter) {
        return "";
    }

    public String homeVideoContent() {
        return "";
    }

    public String categoryContent(String tid, String pg, boolean filter, HashMap<String, String> extend) {
        return "";
    }

    public String detailContent(List<String> ids) {
        return "";
    }

    public String searchContent(String key, boolean quick) {
        return "";
    }

    public String searchContent(String key, boolean quick, String pg) {
        return searchContent(key, quick);
    }

    public String playerContent(String flag, String id, List<String> vipFlags) {
        return "";
    }

    public boolean isVideoFormat(String url) {
        return false;
    }

    public boolean manualVideoCheck() {
        return false;
    }

    public String liveContent(String url) {
        return "";
    }

    public void cancelByTag() {
    }

    public void destroy() {
    }

    public Object[] proxyLocal(Map<String, String> params) {
        return null;
    }

    public Object[] proxy(Map<String, String> params) {
        return proxyLocal(params);
    }

    public String action(String action) {
        return null;
    }
}
