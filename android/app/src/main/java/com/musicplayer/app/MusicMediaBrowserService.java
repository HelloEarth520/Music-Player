package com.musicplayer.app;

import android.media.browse.MediaBrowser;
import android.media.session.MediaSession;
import android.os.Bundle;
import android.service.media.MediaBrowserService;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;

/**
 * MusicMediaBrowserService（v2.22.7）
 * 把应用注册为系统认可的"媒体应用"：
 * 系统 UI（锁屏媒体卡 / OriginOS 原子随身听 / 蓝牙 / 车机）通过 MediaBrowser
 * 连接本服务取得 MediaSession token，从而渲染原生媒体控制（可拖进度、音量联动）。
 *
 * 会话单一来源：本服务在 onCreate 创建 MediaSession，并交给
 * MediaSessionPlugin.adoptSession 接管（通知 / 前台服务 / 按钮动作全部复用该会话）。
 * 播放控制回调与插件内联一致（makeSessionCallback），动作照常转发 JS。
 *
 * 生命周期：MediaSessionPlugin.load() 时 startService 常驻（非前台），进程存活期间保持注册；
 * 播放中另有 MediaControlService 做 mediaPlayback 前台（保活 + 前台通知呈现）。
 * 本服务没有可浏览内容树（无 onLoadChildren 数据），只作为会话出口。
 */
public class MusicMediaBrowserService extends MediaBrowserService {

    private static final String TAG = "MusicMediaBrowserService";
    private MediaSession mSession;

    @Override
    public void onCreate() {
        super.onCreate();
        mSession = new MediaSession(this, "MusicPlayer");
        mSession.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS
                | MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
        mSession.setCallback(MediaSessionPlugin.makeSessionCallback());
        // 全应用会话单一来源：释放插件侧旧会话并指向本服务的会话
        MediaSessionPlugin.adoptSession(mSession);
        setSessionToken(mSession.getSessionToken());
        Log.d(TAG, "MediaBrowserService up, session token adopted");
    }

    @Override
    public BrowserRoot onGetRoot(String clientPackageName, int clientUid, Bundle rootHints) {
        // 放行所有客户端（SystemUI / 原子随身听 / 蓝牙 / 车机）；本应用无浏览树，仅提供会话
        return new BrowserRoot("music", null);
    }

    @Override
    public void onLoadChildren(String parentId, Result<List<MediaBrowser.MediaItem>> result) {
        result.sendResult(new ArrayList<MediaBrowser.MediaItem>());
    }

    @Override
    public void onDestroy() {
        try {
            if (mSession != null) {
                mSession.release();
                mSession = null;
            }
        } catch (Exception ignored) { }
        Log.d(TAG, "MediaBrowserService destroyed");
        super.onDestroy();
    }
}
