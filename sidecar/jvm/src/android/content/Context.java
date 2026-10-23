package android.content;

/** android.jar 的最小占位：spider 的 init(Context) 需要这个类型才能编译/链接 */
public class Context {
  public String getPackageName() {
    return "novatv.sidecar";
  }

  public Context getApplicationContext() {
    return this;
  }
}
