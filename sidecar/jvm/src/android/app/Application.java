package android.app;

/**
 * android.app.Application 桩。
 *
 * 部分 spider（如 Push）在 init(Context) 里直接把入参强转成 Application：
 * `get().app = ((Application) context);`。侧车传的是 Context 桩，强转会抛
 * ClassCastException → NoClassDefFoundError 连带把整个 init 打挂。
 *
 * 让 Application 继承侧车的 Context，并在 init 时统一传 Application 实例，
 * 就同时满足 `init(Context)` 和内部 `(Application) context` 两种写法。
 */
public class Application extends android.content.Context {

  @Override
  public Application getApplicationContext() {
    return this;
  }

  public void onCreate() {
    // 桩实现：无生命周期
  }
}
