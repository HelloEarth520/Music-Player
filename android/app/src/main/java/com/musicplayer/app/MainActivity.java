package com.musicplayer.app;

import android.Manifest;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.os.Build;
import android.os.Bundle;
import android.graphics.Color;
import android.graphics.drawable.ColorDrawable;
import android.view.View;
import android.view.WindowManager;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(DirectoryPickerPlugin.class);
        registerPlugin(FFmpegPlugin.class);
        registerPlugin(WallpaperPlugin.class);
        registerPlugin(FilePickerPlugin.class);
        registerPlugin(MediaSessionPlugin.class);
        super.onCreate(savedInstanceState);

        // 关键：让系统把（第三方）动态壁纸渲染到本窗口后面
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);

        // 音量键始终调节「媒体」音量（而非铃声音量）；锁屏/通知栏场景配合
        // MediaSession 让系统把本应用识别为媒体播放者 → 系统媒体卡音量控制可用
        setVolumeControlStream(AudioManager.STREAM_MUSIC);

        makeTransparent();
        requestNotificationPermissionIfNeeded();
    }

    @Override
    public void onResume() {
        super.onResume();
        // 保险：resume 时再确认一次（Capacitor 加载后可能会重置 WebView 背景）
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
        makeTransparent();
    }

    // 把 WebView 背景设为透明，才能透出后面的动态壁纸
    private void makeTransparent() {
        if (getBridge() != null && getBridge().getWebView() != null) {
            getBridge().getWebView().setBackgroundColor(0); // 0 = 完全透明
            // 关键：允许「非用户手势」触发的播放（通知栏/锁屏按钮经系统广播回调 audio.play()，
            // 在 WebView 里不算用户手势，默认会被自动播放策略拦截 → 切歌不自动播放/强制改状态失败）
            getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false);
        }
    }

    /** Android 13+ 必须在运行时请求通知权限，否则媒体通知被系统静默丢弃（通知栏/锁屏控制不出现） */
    private static final int REQ_NOTIFICATION_PERM = 42001;
    private void requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < 33) return;
        if (checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                == PackageManager.PERMISSION_GRANTED) return;
        requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_NOTIFICATION_PERM);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_NOTIFICATION_PERM && grantResults != null && grantResults.length > 0
                && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
            // 授权成功：若当前已有播放，立即把媒体通知补出来
            MediaSessionPlugin.pushNow();
        }
    }

    @Override
    public void onDestroy() {
        // v2.22.12：用户主动关闭（isFinishing=true：小窗 × / 从最近任务划掉 / 返回键退出）时，
        // 音频随 WebView 一并销毁，必须同步停掉前台媒体服务并撤下通知——否则 MediaControlService
        // 没人通知它停，通知/服务残留成“只能去应用信息强停”的僵尸。
        // Home 键回桌面不走 onDestroy（仅 onStop），后台播放不受影响。
        if (isFinishing()) {
            MediaSessionPlugin.cleanupForExit();
        }
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) {
            // 全屏沉浸式：状态栏 + 导航栏全隐藏，边缘滑入临时呼出
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
            );
            // 重新确保壁纸透出（焦点变化后某些 ROM 会重置窗口标志）
            getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);
            makeTransparent();
        }
    }
}
