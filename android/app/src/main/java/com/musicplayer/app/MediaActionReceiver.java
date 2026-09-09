package com.musicplayer.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.util.Log;

/**
 * 接收通知栏 / 锁屏的媒体按钮广播（cmd="prev"|"play"|"pause"|"next"|"stop"），
 * 转发到 MediaSessionPlugin.dispatch 以驱动 JS 播放控制。
 */
public class MediaActionReceiver extends BroadcastReceiver {

    private static final String TAG = "MediaActionReceiver";
    private static final String ACTION_MEDIA = "com.musicplayer.app.MEDIA";

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            if (intent == null) return;
            if (!ACTION_MEDIA.equals(intent.getAction())) return;
            String cmd = intent.getStringExtra("cmd");
            if (cmd == null) return;
            double position = intent.getDoubleExtra("position", 0);
            MediaSessionPlugin.dispatch(cmd, position);
        } catch (Exception e) {
            Log.e(TAG, "onReceive failed: " + e.getMessage());
        }
    }
}
