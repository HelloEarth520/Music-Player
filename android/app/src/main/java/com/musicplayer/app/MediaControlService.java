package com.musicplayer.app;

import android.app.Notification;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.util.Log;

/**
 * MediaControlService（v2.22.6）
 * 极薄前台媒体服务：本服务不播放音频、不持有播放逻辑（音频始终在 WebView <audio>）。
 * 作用：播放时把 MediaSessionPlugin 构建的媒体通知（NOTIFY_ID=1001）升格为
 * 前台通知（foregroundServiceType=mediaPlayback），让系统把本应用识别为
 * “当前媒体应用”，尝试让锁屏/通知中心渲染系统原生媒体卡（可拖进度、音量联动）。
 *
 * 生命周期（v2.22.12 起）：
 *   MediaControlService.start()         —— 首次播放起（update/pushNow，幂等）；之后播放/暂停都保持
 *   MediaControlService.stopIfRunning() —— 仅 hide() / cleanupForExit()（真正停止/退出应用）时调用
 *
 * v2.22.12 变更原因：此前暂停即停服务 → OriginOS 会清理“暂停且无前台服务”的媒体通知
 * （v2.22.10 靠 JS 500ms 轮询重推顶住=收起→重弹闪烁；v2.22.11 暂停跳过轮询后通知彻底消失）。
 * 现改为暂停也保持前台服务，通知为系统级常驻媒体通知（播放器标准行为，如网易云）。
 *
 * 注意：
 *   - 不使用音频焦点（v2.22.5 教训：OriginOS 焦点信号频繁，自动暂停监听会误伤播放）。
 *   - onDestroy 用 STOP_FOREGROUND_DETACH 而非 REMOVE：通知本体保留由插件统一撤下。
 *   - START_NOT_STICKY：Activity 被系统杀死后不复活成无音频的“僵尸前台”。
 */
public class MediaControlService extends Service {

    private static final String TAG = "MediaControlService";
    private static volatile boolean sRunning = false;

    /** 播放时拉起前台服务（幂等；后台启动受限等异常直接降级为普通通知，不影响播放） */
    static void start(Context ctx) {
        if (ctx == null || sRunning) return;
        try {
            ctx.startForegroundService(new Intent(ctx, MediaControlService.class));
        } catch (Exception e) {
            Log.e(TAG, "startForegroundService failed (fallback to normal notification): " + e.getMessage());
        }
    }

    /** 暂停 / 隐藏时停掉前台服务 */
    static void stopIfRunning(Context ctx) {
        if (ctx == null || !sRunning) return;
        try {
            ctx.stopService(new Intent(ctx, MediaControlService.class));
        } catch (Exception e) {
            Log.e(TAG, "stopService failed: " + e.getMessage());
        }
    }

    static boolean isRunning() {
        return sRunning;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sRunning = true;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        // 用插件当前缓存的播放状态构建通知并置为前台（startForeground 需在
        // startForegroundService 后尽快调用；此处同线程内立即执行）
        try {
            Notification n = MediaSessionPlugin.buildNotification();
            if (android.os.Build.VERSION.SDK_INT >= 29) {
                startForeground(MediaSessionPlugin.NOTIFY_ID, n,
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
            } else {
                startForeground(MediaSessionPlugin.NOTIFY_ID, n);
            }
            Log.d(TAG, "foreground mediaPlayback started id=" + MediaSessionPlugin.NOTIFY_ID);
        } catch (Exception e) {
            Log.e(TAG, "startForeground failed: " + e.getMessage());
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        sRunning = false;
        try {
            // 仅摘除“前台”标记，保留通知本体（暂停态由插件的 notify() 维护）
            if (android.os.Build.VERSION.SDK_INT >= 24) {
                stopForeground(STOP_FOREGROUND_DETACH);
            }
        } catch (Exception ignored) { }
        Log.d(TAG, "service destroyed (foreground detached, notification kept)");
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
