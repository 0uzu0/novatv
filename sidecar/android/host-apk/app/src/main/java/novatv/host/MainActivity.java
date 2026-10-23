package novatv.host;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.text.InputType;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.util.Collections;
import java.util.List;

/**
 * 一个按钮的界面：启动侧车，然后把「手机 IP:端口 + 口令」显示出来。
 *
 * 这样手机不接电脑也能用：装好 APK → 点一下 → 把屏幕上的地址填进 NAS 的 SPIDER_ANDROID_URL。
 * 不用 adb，也不用把手机连到 NAS 上。
 */
public class MainActivity extends Activity {
  private EditText tokenInput;
  private TextView info;

  @Override
  protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    float d = getResources().getDisplayMetrics().density;
    int pad = (int) (18 * d);

    LinearLayout root = new LinearLayout(this);
    root.setOrientation(LinearLayout.VERTICAL);
    root.setPadding(pad, pad, pad, pad);

    TextView title = new TextView(this);
    title.setText("NovaTV Spider 侧车");
    title.setTextSize(22);
    root.addView(title);

    TextView desc = new TextView(this);
    desc.setText("在手机的 Android Runtime 里运行加固 spider 包，\n"
        + "把结果以 HTTP 提供给 NAS 上的 NovaTV。\n"
        + "浏览器只负责播放，不需要运行任何 spider 逻辑。");
    desc.setTextSize(13);
    desc.setPadding(0, (int) (10 * d), 0, (int) (14 * d));
    root.addView(desc);

    tokenInput = new EditText(this);
    tokenInput.setHint("口令（留空则不校验，建议填一个）");
    tokenInput.setInputType(InputType.TYPE_CLASS_TEXT);
    root.addView(tokenInput);

    Button start = new Button(this);
    start.setText("启动侧车（监听 0.0.0.0:8899）");
    start.setOnClickListener(new View.OnClickListener() {
      @Override
      public void onClick(View v) {
        startSidecar();
      }
    });
    root.addView(start);

    info = new TextView(this);
    info.setTextSize(13);
    info.setPadding(0, (int) (16 * d), 0, 0);
    info.setText("未启动");

    // 注意：一个 View 只能有一个父容器，info 只加进 ScrollView
    ScrollView scroll = new ScrollView(this);
    scroll.addView(info);
    root.addView(scroll);

    setContentView(root);
  }

  private void startSidecar() {
    String token = tokenInput.getText().toString().trim();

    Intent i = new Intent(this, HostService.class);
    i.putExtra("lan", true);
    i.putExtra("port", 8899);
    if (token.length() > 0) i.putExtra("token", token);
    if (Build.VERSION.SDK_INT >= 26) startForegroundService(i);
    else startService(i);

    String ip = localIp();
    StringBuilder sb = new StringBuilder();
    sb.append("已启动\n\n");
    sb.append("NAS 上设置环境变量：\n");
    sb.append("SPIDER_ANDROID_URL=http://").append(ip).append(":8899\n");
    if (token.length() > 0) {
      sb.append("SPIDER_TOKEN=").append(token).append("\n");
    }
    sb.append("\n自检（在 NAS 上执行）：\n");
    sb.append("curl http://").append(ip).append(":8899/health");
    if (token.length() > 0) sb.append("?token=").append(token);
    sb.append("\n\n首次使用还要让手机把 spider 包拉下来：\n");
    sb.append("POST /load {url, md5}（NovaTV 会自动带上配置里的地址）\n\n");
    sb.append("注意：手机与 NAS 要在同一局域网，且不要开省电限制，\n否则系统会杀掉后台服务。");
    info.setText(sb.toString());
  }

  /** 取局域网 IPv4（跳过回环和蜂窝网段） */
  private String localIp() {
    try {
      List<NetworkInterface> nifs = Collections.list(NetworkInterface.getNetworkInterfaces());
      for (NetworkInterface nif : nifs) {
        if (!nif.isUp() || nif.isLoopback()) continue;
        for (InetAddress addr : Collections.list(nif.getInetAddresses())) {
          if (addr instanceof Inet4Address && !addr.isLoopbackAddress()) {
            String ip = addr.getHostAddress();
            if (ip != null && (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172."))) {
              return ip;
            }
          }
        }
      }
    } catch (Exception ignored) {
    }
    return "<手机IP>";
  }
}
