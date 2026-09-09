package com.musicplayer.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.media.MediaMetadata;
import android.media.session.MediaController;
import android.media.session.MediaSession;
import android.media.session.PlaybackState;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.util.Base64;
import android.util.Log;
import android.view.View;
import android.widget.RemoteViews;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * MediaSessionPlugin
 * 持有 MediaSession + MediaStyle 通知（通知栏 / 锁屏媒体控制）。
 * v2.22.6：播放时由 MediaControlService 把通知(ID 1001)升格为前台媒体通知
 * (foregroundServiceType=mediaPlayback)，使系统将本应用识别为媒体应用，尝试让
 * OriginOS 锁屏渲染系统原生媒体卡（可拖进度）；暂停/隐藏后服务退出、通知降级为普通通知。
 * 音频仍在 WebView 内 <audio> 播放（不引入播放 Service，避免双播放源）。
 * 原生仅负责把播放状态画成系统媒体通知，并把用户的播放/暂停/上下首/拖动进度动作转发回 JS。
 *
 * 线程：session / notification 操作统一切到主线程 Handler 执行。
 */
@CapacitorPlugin(name = "MediaSessionPlugin")
public class MediaSessionPlugin extends Plugin {

    private static final String TAG = "MediaSessionPlugin";
    private static final String CHANNEL_ID = "playback";
    static final int NOTIFY_ID = 1001;   // MediaControlService 也复用此 ID 做前台通知
    private static final String ACTION_MEDIA = "com.musicplayer.app.MEDIA";
    private static final long ACTIONS = PlaybackState.ACTION_PLAY
            | PlaybackState.ACTION_PAUSE
            | PlaybackState.ACTION_PLAY_PAUSE
            | PlaybackState.ACTION_SKIP_TO_NEXT
            | PlaybackState.ACTION_SKIP_TO_PREVIOUS
            | PlaybackState.ACTION_SEEK_TO
            | PlaybackState.ACTION_STOP;

    static MediaSession session;
    static Context appCtx;
    static MediaSessionPlugin instance;

    // 最近一次通知内容缓存：通知权限授予后立即重发（无需等 JS 下一轮推送）
    private static String sLastTitle = "";
    private static String sLastArtist = "";
    private static boolean sLastPlaying = false;
    private static Bitmap sLastBitmap = null;   // 最近一次封面位图：JS 未传 artwork 时复用，避免每秒重解码
    private static String sLastLyric1 = "";     // 最近一次第一行歌词（JS 每轮推送，缺失即为空）
    private static String sLastLyric2 = "";     // 最近一次第二行歌词
    private static double sLastPos = 0.0;       // 最近一次播放位置（秒），用于 pushNow 重画进度
    private static double sLastDur = 0.0;       // 最近一次总时长（秒）

    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    @Override
    public void load() {
        instance = this;
        appCtx = getContext().getApplicationContext();
        // v2.22.7：拉起媒体浏览器服务，常驻注册本应用为“媒体应用”（供系统锁屏/原子随身听识别）
        try {
            appCtx.startService(new Intent(appCtx, MusicMediaBrowserService.class));
        } catch (Exception e) {
            Log.e(TAG, "start MusicMediaBrowserService failed: " + e.getMessage());
        }
    }

    private void ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = (NotificationManager) appCtx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        if (nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, "播放控制", NotificationManager.IMPORTANCE_LOW);
        ch.setSound(null, null);
        ch.enableVibration(false);
        ch.setShowBadge(false);
        nm.createNotificationChannel(ch);
    }

    private void ensureSession() {
        if (appCtx == null) appCtx = getContext().getApplicationContext();
        if (session == null) {
            session = new MediaSession(appCtx, "MusicPlayer");
            session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                    | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
            session.setCallback(makeSessionCallback());
        }
    }

    /** 生成与 JS 联动的 MediaSession 回调（插件与 MusicMediaBrowserService 共用，行为一致） */
    static MediaSession.Callback makeSessionCallback() {
        return new MediaSession.Callback() {
            @Override
            public void onPlay() {
                emitAction("play", 0);
            }

            @Override
            public void onPause() {
                emitAction("pause", 0);
            }

            @Override
            public void onSkipToNext() {
                emitAction("next", 0);
            }

            @Override
            public void onSkipToPrevious() {
                emitAction("prev", 0);
            }

            @Override
            public void onSeekTo(long pos) {
                // 原生以 ms 传，转发给 JS 时转成秒
                emitAction("seek", pos / 1000.0);
            }

            @Override
            public void onStop() {
                emitAction("stop", 0);
            }
        };
    }

    /** 新会话接管（MediaBrowserService 拥有者）：释放插件侧旧会话，保证全应用单一会话 */
    static void adoptSession(MediaSession s) {
        if (s == null) return;
        MediaSession old = session;
        if (old != null && old != s) {
            try {
                old.setActive(false);
                old.release();
            } catch (Exception ignored) { }
        }
        session = s;
    }

    private void notifyAction(String action, double position) {
        emitAction(action, position);
    }

    /** 原生侧动作统一出口 → JS（session 回调 / 各入口共用） */
    static void emitAction(String action, double position) {
        if (instance == null) return;
        JSObject obj = new JSObject();
        obj.put("action", action);
        if ("seek".equals(action)) obj.put("position", position);
        instance.notifyListeners("action", obj);
    }

    @PluginMethod
    public void update(PluginCall call) {
        mainHandler.post(() -> {
            try {
                ensureChannel();
                ensureSession();

                String title = call.getString("title", "");
                String artist = call.getString("artist", "");
                boolean playing = call.getBoolean("playing", false);
                double position = call.getDouble("position", 0.0);
                double duration = call.getDouble("duration", 0.0);
                double speed = call.getDouble("speed", 1.0);
                boolean canPrev = call.getBoolean("canPrev", false);
                boolean canNext = call.getBoolean("canNext", false);
                String artwork = call.getString("artwork", null);
                String lyric1 = call.getString("lyric1", "");
                String lyric2 = call.getString("lyric2", "");

                // PlaybackState（位置用 ms，速度用 float）
                PlaybackState.Builder psb = new PlaybackState.Builder();
                int st = playing ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED;
                psb.setState(st, (long) (position * 1000), (float) speed);
                psb.setActions(ACTIONS);
                session.setPlaybackState(psb.build());

                // MediaMetadata
                MediaMetadata.Builder mmb = new MediaMetadata.Builder();
                mmb.putString(MediaMetadata.METADATA_KEY_TITLE, title != null ? title : "");
                mmb.putString(MediaMetadata.METADATA_KEY_ARTIST, artist != null ? artist : "");
                mmb.putLong(MediaMetadata.METADATA_KEY_DURATION, (long) (duration * 1000));
                // artwork 协议（v2.21 优化，避免每秒跨桥传大 base64 + 重复解码）：
                //   null（未传）→ 沿用上次位图（每秒进度推送即此场景）
                //   ""（空串） → 显式清空封面
                //   非空 base64 → 解码新封面并缓存
                if (artwork == null) {
                    if (sLastBitmap != null) mmb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, sLastBitmap);
                } else if (artwork.isEmpty()) {
                    sLastBitmap = null;   // 清空封面（新歌无封面时由 JS 显式传 ""）
                } else {
                    Bitmap bmp = decodeArtwork(artwork);
                    if (bmp != null) {
                        sLastBitmap = bmp;
                        mmb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, bmp);
                    } else if (sLastBitmap != null) {
                        mmb.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART, sLastBitmap);
                    }
                }
                session.setMetadata(mmb.build());

                session.setActive(true);
                sLastTitle = title != null ? title : "";
                sLastArtist = artist != null ? artist : "";
                sLastPlaying = playing;
                sLastLyric1 = lyric1 != null ? lyric1 : "";
                sLastLyric2 = lyric2 != null ? lyric2 : "";
                sLastPos = position;
                sLastDur = duration;
                postNotification(sLastTitle, sLastArtist, playing, sLastLyric1, sLastLyric2, position, duration);
                // v2.22.12：前台服务生命周期跟随“媒体会话”，不再随播放/暂停切换启停。
                // 历史(v2.22.6-2.22.11)：暂停即 stopIfRunning() 摘除前台 → OriginOS 会清理
                // “暂停且无前台服务”的媒体通知；此前靠 JS 每 500ms 轮询重推顶住（表现=收起→重弹
                // 闪烁），v2.22.11 暂停停轮询后通知被清即彻底消失。现在暂停也保持前台，
                // 通知为系统级常驻（不被清、不闪烁），服务仅在 hide()/停止时真正退出。
                MediaControlService.start(appCtx);   // 幂等：已在运行则 no-op
                Log.d(TAG, "update OK title=" + sLastTitle + " playing=" + playing + " pos=" + position + "/" + duration
                        + " lyric1='" + sLastLyric1 + "' art=" + (artwork == null ? "keep" : (artwork.isEmpty() ? "clear" : "new")));
                call.resolve();
            } catch (Exception e) {
                Log.e(TAG, "update failed: " + e.getMessage());
                call.reject("update failed: " + e.getMessage());
            }
        });
    }

    /** 解码 base64 封面，按最长边 ≤512 等比缩放 */
    private Bitmap decodeArtwork(String base64) {
        try {
            byte[] data = Base64.decode(base64, Base64.DEFAULT);
            Bitmap raw = BitmapFactory.decodeByteArray(data, 0, data.length);
            if (raw == null) return null;
            int w = raw.getWidth();
            int h = raw.getHeight();
            final int max = 512;
            if (w <= max && h <= max) return raw;
            float scale = Math.min((float) max / w, (float) max / h);
            return Bitmap.createScaledBitmap(raw,
                    Math.round(w * scale), Math.round(h * scale), true);
        } catch (Exception e) {
            Log.e(TAG, "decodeArtwork failed: " + e.getMessage());
            return null;
        }
    }

    /** 格式化为 m:ss（分钟无前导零，秒补零） */
    private static String formatTime(int totalSeconds) {
        if (totalSeconds < 0) totalSeconds = 0;
        int m = totalSeconds / 60;
        int s = totalSeconds % 60;
        return m + ":" + (s < 10 ? "0" + s : String.valueOf(s));
    }

    /** 构建媒体通知（读取 sLast* 静态缓存，供本类 post 与 MediaControlService 前台通知复用） */
    static Notification buildNotification() {
        String appName = appCtx.getString(R.string.app_name);
        String title = sLastTitle;
        String artist = sLastArtist;
        boolean playing = sLastPlaying;
        String lyric1 = sLastLyric1;
        String lyric2 = sLastLyric2;
        double position = sLastPos;
        double duration = sLastDur;

        // ===== v2.22.4：浅色自绘 RemoteViews（白底深字，等宽按钮撑满）=====
        // 演进：v2.22.0 自绘(正常) → v2.22.1 加 View 点击区(整条消失) → v2.22.2 改 ImageButton
        // 点击区(恢复)但黑底难看 → v2.22.3 系统原生(按钮窄/右侧空) → v2.22.4 浅色自绘。
        // 锁屏仍交给系统媒体卡（MediaStyle token），此视图只影响通知栏内容区。
        final int INK = 0xFF111827;      // 图标深色（原 drawable 是白色，浅底上要重新着色）
        final int INK_MUTED = 0xFF6B7280;
        RemoteViews rv = new RemoteViews(appCtx.getPackageName(), R.layout.notification_media);

        // 封面：有图用位图；无图回退占位图标并染灰（白图标在浅底上不可见）
        if (sLastBitmap != null) {
            rv.setImageViewBitmap(R.id.notif_cover, sLastBitmap);
        } else {
            rv.setImageViewResource(R.id.notif_cover, R.drawable.ic_stat_music);
            rv.setInt(R.id.notif_cover, "setColorFilter", INK_MUTED);
        }

        // 标题
        rv.setTextViewText(R.id.notif_title, (title != null && !title.isEmpty()) ? title : appName);

        // 歌词降级：lyric1 非空 → 两行歌词；lyric1 空 → line1 显示 artist，line2 隐藏
        if (lyric1 != null && !lyric1.isEmpty()) {
            rv.setTextViewText(R.id.notif_line1, lyric1);
            if (lyric2 != null && !lyric2.isEmpty()) {
                rv.setTextViewText(R.id.notif_line2, lyric2);
                rv.setViewVisibility(R.id.notif_line2, View.VISIBLE);
            } else {
                rv.setViewVisibility(R.id.notif_line2, View.GONE);
            }
        } else {
            rv.setTextViewText(R.id.notif_line1, (artist != null && !artist.isEmpty()) ? artist : "");
            rv.setViewVisibility(R.id.notif_line2, View.GONE);
        }

        // 时间 + 进度条
        int durSec = (int) Math.max(0, duration);
        int posSec = (int) Math.max(0, position);
        if (durSec > 0 && posSec > durSec) posSec = durSec;
        rv.setTextViewText(R.id.notif_cur, formatTime(posSec));
        rv.setTextViewText(R.id.notif_dur, formatTime(durSec));
        int progress = 0;
        if (duration > 0) {
            progress = (int) (position / duration * 1000);
            if (progress < 0) progress = 0;
            if (progress > 1000) progress = 1000;
        }
        rv.setProgressBar(R.id.notif_seek, 1000, progress, false);

        // 按钮行：三等宽 ImageButton 撑满，图标染深色（drawable 本身是白）
        rv.setImageViewResource(R.id.notif_playpause,
                playing ? R.drawable.ic_media_pause : R.drawable.ic_media_play);
        rv.setInt(R.id.notif_prev, "setColorFilter", INK);
        rv.setInt(R.id.notif_playpause, "setColorFilter", INK);
        rv.setInt(R.id.notif_next, "setColorFilter", INK);
        rv.setOnClickPendingIntent(R.id.notif_prev, makePi("prev", 1));
        rv.setOnClickPendingIntent(R.id.notif_playpause, makePi(playing ? "pause" : "play", 2));
        rv.setOnClickPendingIntent(R.id.notif_next, makePi("next", 3));

        // 进度区「点哪跳哪」：10 个等分隐形区（ImageButton），各自把目标秒数随广播带出
        final int[] zoneIds = {R.id.notif_zone0, R.id.notif_zone1, R.id.notif_zone2, R.id.notif_zone3,
                R.id.notif_zone4, R.id.notif_zone5, R.id.notif_zone6, R.id.notif_zone7,
                R.id.notif_zone8, R.id.notif_zone9};
        if (duration > 0) {
            for (int i = 0; i < zoneIds.length; i++) {
                double target = duration * (i + 0.5) / zoneIds.length;
                rv.setOnClickPendingIntent(zoneIds[i], makePi("seek", 100 + i, target));
            }
        }

        Notification.Builder nb = new Notification.Builder(appCtx, CHANNEL_ID);
        nb.setSmallIcon(R.drawable.ic_stat_music);
        nb.setOnlyAlertOnce(true);
        nb.setOngoing(true);    // v2.22.10 常驻：播放/暂停都保持不折叠不闪烁（滑除=停止）
        nb.setShowWhen(false);
        nb.setVisibility(Notification.VISIBILITY_PUBLIC);
        // 同时给系统默认区也填上标题/正文，保证展开前(系统渲染标题行)一致
        nb.setContentTitle((title != null && !title.isEmpty()) ? title : appName);
        String artistStr = (artist != null && !artist.isEmpty()) ? artist : "";
        boolean hasLyric = lyric1 != null && !lyric1.isEmpty();
        nb.setContentText(hasLyric ? lyric1 : artistStr);
        if (sLastBitmap != null) nb.setLargeIcon(sLastBitmap);

        // contentIntent：点击打开应用
        Intent contentIntent = new Intent(appCtx, MainActivity.class);
        contentIntent.setAction(Intent.ACTION_MAIN);
        contentIntent.addCategory(Intent.CATEGORY_LAUNCHER);
        contentIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
        PendingIntent contentPi = PendingIntent.getActivity(appCtx, 5, contentIntent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        nb.setContentIntent(contentPi);

        // deleteIntent：滑动移除通知 = 停止
        nb.setDeleteIntent(makePi("stop", 4));

        // 自定义内容视图（折叠与展开同一浅色布局）
        nb.setCustomContentView(rv);
        nb.setCustomBigContentView(rv);

        // MediaStyle：锁屏系统媒体卡 / 蓝牙联动（锁屏由系统渲染，可拖进度）
        Notification.MediaStyle style = new Notification.MediaStyle();
        style.setMediaSession(session.getSessionToken());
        nb.setStyle(style);

        return nb.build();
    }

    private void postNotification(String title, String artist, boolean playing,
                                   String lyric1, String lyric2, double position, double duration) {
        NotificationManager nm = (NotificationManager) appCtx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (nm == null) return;
        // 注：title/artist/... 与 sLast* 由调用方先赋值，渲染统一走 buildNotification()（读静态缓存）
        try {
            nm.notify(NOTIFY_ID, buildNotification());
            Log.d(TAG, "notify() posted id=" + NOTIFY_ID + " ongoing=" + playing);
        } catch (Exception e) {
            Log.e(TAG, "notify failed: " + e.getMessage() + " -> retry minimal");
            try {
                String appName = appCtx.getString(R.string.app_name);
                String artistStr = (artist != null && !artist.isEmpty()) ? artist : "";
                Notification.Builder fb = new Notification.Builder(appCtx, CHANNEL_ID);
                fb.setSmallIcon(R.drawable.ic_stat_music);
                fb.setContentTitle((title != null && !title.isEmpty()) ? title : appName);
                fb.setContentText(artistStr);
                fb.setOnlyAlertOnce(true);
                fb.setOngoing(true);   // v2.22.10 降级兜底同样常驻
                Intent contentIntent = new Intent(appCtx, MainActivity.class);
                contentIntent.setAction(Intent.ACTION_MAIN);
                contentIntent.addCategory(Intent.CATEGORY_LAUNCHER);
                contentIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_NEW_TASK);
                fb.setContentIntent(PendingIntent.getActivity(appCtx, 5, contentIntent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));
                fb.setDeleteIntent(makePi("stop", 64));
                nm.notify(NOTIFY_ID, fb.build());
                Log.d(TAG, "notify() minimal posted id=" + NOTIFY_ID);
            } catch (Exception e2) {
                Log.e(TAG, "notify minimal failed too: " + e2.getMessage());
            }
        }
    }

    /** 构造广播到 MediaActionReceiver 的 PendingIntent（cmd=prev/next/play/pause/stop/seek，无位置） */
    private static PendingIntent makePi(String cmd, int code) {
        return makePi(cmd, code, 0);
    }

    /** 构造广播到 MediaActionReceiver 的 PendingIntent；seek 时带目标位置（秒） */
    private static PendingIntent makePi(String cmd, int code, double positionSec) {
        Intent intent = new Intent(appCtx, MediaActionReceiver.class);
        intent.setAction(ACTION_MEDIA);
        intent.putExtra("cmd", cmd);
        if (positionSec > 0) intent.putExtra("position", positionSec);
        return PendingIntent.getBroadcast(appCtx, code, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 通知权限授予后立即重发媒体通知（由 MainActivity 在授权回调里调用） */
    static void pushNow() {
        if (instance == null) return;
        instance.mainHandler.post(() -> {
            try {
                if (appCtx == null) return;
                instance.ensureChannel();
                instance.ensureSession();
                if (session == null) return;
                PlaybackState.Builder psb = new PlaybackState.Builder();
                psb.setState(sLastPlaying ? PlaybackState.STATE_PLAYING : PlaybackState.STATE_PAUSED, 0L, 1.0f);
                psb.setActions(ACTIONS);
                session.setPlaybackState(psb.build());
                session.setActive(true);
                instance.postNotification(sLastTitle, sLastArtist, sLastPlaying,
                        sLastLyric1, sLastLyric2, sLastPos, sLastDur);
                // v2.22.12：前台服务跟随会话——只要曾有过播放内容即保持前台（幂等），
                // 暂停态授权回调也不会出现“通知无前台服务保护被系统清理”的情况。
                if (sLastTitle != null && !sLastTitle.isEmpty()) MediaControlService.start(appCtx);
            } catch (Exception e) {
                Log.e(TAG, "pushNow failed: " + e.getMessage());
            }
        });
    }

    @PluginMethod
    public void hide(PluginCall call) {
        mainHandler.post(() -> {
            try {
                MediaControlService.stopIfRunning(appCtx);
                NotificationManager nm = (NotificationManager) appCtx.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm != null) nm.cancel(NOTIFY_ID);
                if (session != null) {
                    // v2.22.7：会话由 MusicMediaBrowserService 持有，hide 只取消通知并停用会话
                    // （不销毁），保持应用在系统媒体列表中的注册，下次播放直接复用
                    session.setActive(false);
                }
            } catch (Exception e) {
                Log.e(TAG, "hide failed: " + e.getMessage());
            } finally {
                if (call != null) call.resolve();
            }
        });
    }

    /** 供 MediaActionReceiver 调用：把广播 cmd 映射到 MediaSession 传输控制 */
    static void dispatch(String cmd, double position) {
        if (session == null || cmd == null) return;
        try {
            MediaController ctl = session.getController();
            if (ctl == null) return;
            MediaController.TransportControls tc = ctl.getTransportControls();
            if ("prev".equals(cmd)) tc.skipToPrevious();
            else if ("next".equals(cmd)) tc.skipToNext();
            else if ("play".equals(cmd)) tc.play();
            else if ("pause".equals(cmd)) tc.pause();
            else if ("seek".equals(cmd)) tc.seekTo((long) (position * 1000)); // 秒 → 毫秒
            else if ("stop".equals(cmd)) tc.stop();
        } catch (Exception e) {
            Log.e(TAG, "dispatch failed: " + e.getMessage());
        }
    }

    /**
     * v2.22.12：Activity 被用户主动关闭（isFinishing：划掉任务 / 小窗 × / 返回退出）时调用。
     * 音频在 WebView 内，Activity 销毁即播放终止——必须同步停掉前台媒体服务并撤下通知，
     * 否则服务+通知残留成“只能去应用信息强停”的僵尸。Home 键回桌面不触发本方法（播放继续）。
     */
    static void cleanupForExit() {
        try {
            MediaControlService.stopIfRunning(appCtx);
            NotificationManager nm = (NotificationManager) appCtx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null) nm.cancel(NOTIFY_ID);
            if (session != null) session.setActive(false);
            Log.d(TAG, "cleanupForExit: service stopped, notification cancelled");
        } catch (Exception e) {
            Log.e(TAG, "cleanupForExit failed: " + e.getMessage());
        }
    }
}
