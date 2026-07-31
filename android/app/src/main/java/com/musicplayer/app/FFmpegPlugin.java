package com.musicplayer.app;

import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * FFmpegPlugin — 原生 FFmpeg 转码插件
 *
 * TODO: ffmpeg-kit 的 Java API 目前无法从 Maven/GitHub 获取（项目已归档）。
 * 当前版本：transcode 方法直接返回错误，JS 端自动回退到 Web Audio WAV 转码。
 * 后续获取到 ffmpeg-kit aar 后，取消注释下面的 import 和实现代码即可启用原生转码。
 *
 * 启用步骤：
 * 1. 获取 ffmpeg-kit aar（从原版 APK 提取或 GitHub releases 下载）
 * 2. 放到 android/app/libs/ffmpeg-kit.aar
 * 3. build.gradle 加: implementation files('libs/ffmpeg-kit.aar')
 * 4. .so 文件放 android/app/src/main/jniLibs/arm64-v8a/
 * 5. 取消注释下方 import 和代码
 */
@CapacitorPlugin(name = "FFmpegPlugin")
public class FFmpegPlugin extends Plugin {

    private static final String TAG = "FFmpegPlugin";

    /**
     * 同步转码 — 当前不可用，返回错误让 JS 回退到 Web Audio
     */
    @PluginMethod
    public void transcode(PluginCall call) {
        Log.w(TAG, "原生 FFmpeg 未集成，JS 端将回退到 Web Audio WAV 转码");
        call.reject("原生 FFmpeg 不可用，请使用 Web Audio 转码");

        // === 启用原生 FFmpeg 后取消注释 ===
        // String inputPath = call.getString("inputPath");
        // String outputPath = call.getString("outputPath");
        // String codec = call.getString("codec", "libmp3lame");
        // String bitrate = call.getString("bitrate", "192k");
        // String sampleRate = call.getString("sampleRate", "44100");
        // String channels = call.getString("channels", "2");
        //
        // String cmd = "-y -i " + inputPath + " -c:a " + codec + " -b:a " + bitrate
        //     + " -ar " + sampleRate + " -ac " + channels + " " + outputPath;
        // FFmpegSession session = FFmpegKit.execute(cmd);
        // if (ReturnCode.isSuccess(session.getReturnCode())) {
        //     JSObject ret = new JSObject();
        //     ret.put("success", true);
        //     ret.put("outputPath", outputPath);
        //     call.resolve(ret);
        // } else {
        //     call.reject("转码失败, returnCode=" + session.getReturnCode());
        // }
    }

    @PluginMethod
    public void transcodeAsync(PluginCall call) {
        call.reject("原生 FFmpeg 不可用，请使用 Web Audio 转码");
    }

    @PluginMethod
    public void getMediaInfo(PluginCall call) {
        call.reject("原生 FFmpeg 不可用");
    }

    @PluginMethod
    public void cancelTranscode(PluginCall call) {
        call.resolve();
    }
}
