package com.musicplayer.app;

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
        super.onCreate(savedInstanceState);

        // 关键：让系统把（第三方）动态壁纸渲染到本窗口后面
        getWindow().setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_SHOW_WALLPAPER);

        makeTransparent();
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
        }
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
