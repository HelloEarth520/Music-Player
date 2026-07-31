package com.musicplayer.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.activity.result.ActivityResult;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * FilePickerPlugin — 原生图片/视频选择器
 *
 * 背景说明：Capacitor 的 Android WebView 默认不支持 <input type="file">，
 * 因此 HTML 文件选择器在手机上完全失效。本插件用原生 Intent 选取文件，
 * 图片以 base64 dataURL 回传（自动缩放到最长边 1920px，控制体积）；
 * 视频复制到应用私有缓存并返回 file:// 路径（本次会话有效）。
 *
 * JS 端通过 window.Capacitor.Plugins.FilePicker 调用：
 *   pickImage() -> Promise<{ data: "data:image/jpeg;base64,..." }>
 *   pickVideo() -> Promise<{ uri: "file:///.../bgvideo.mp4" }>
 */
@CapacitorPlugin(name = "FilePicker")
public class FilePickerPlugin extends Plugin {

    private static final String TAG = "FilePicker";
    private static final int MAX_IMAGE_DIM = 1920;

    /** 打开系统图片选择器，返回缩放后的 JPEG base64 dataURL */
    @PluginMethod
    public void pickImage(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("image/*");
        intent.putExtra(Intent.EXTRA_MIME_TYPES, new String[]{
            "image/jpeg", "image/png", "image/webp", "image/gif"
        });
        try {
            startActivityForResult(call, intent, "onImagePicked");
        } catch (Exception e) {
            call.reject("无法打开图片选择器: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void onImagePicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("用户取消了选择");
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) { call.reject("未选择图片"); return; }
        try {
            ContentResolver resolver = getContext().getContentResolver();

            // 1) 先读边界，计算缩放比
            BitmapFactory.Options opts = new BitmapFactory.Options();
            opts.inJustDecodeBounds = true;
            InputStream is0 = resolver.openInputStream(uri);
            if (is0 == null) { call.reject("无法打开图片流"); return; }
            BitmapFactory.decodeStream(is0, null, opts);
            is0.close();

            int w = opts.outWidth, h = opts.outHeight;
            int scale = 1;
            int longest = Math.max(w, h);
            if (longest > MAX_IMAGE_DIM) {
                scale = (int) Math.ceil((double) longest / MAX_IMAGE_DIM);
            }

            // 2) 按缩放比解码
            opts.inJustDecodeBounds = false;
            opts.inSampleSize = scale;
            InputStream is = resolver.openInputStream(uri);
            if (is == null) { call.reject("无法打开图片流"); return; }
            Bitmap bmp = BitmapFactory.decodeStream(is, null, opts);
            is.close();
            if (bmp == null) { call.reject("图片解码失败"); return; }

            // 3) 压缩为 JPEG base64
            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            bmp.compress(Bitmap.CompressFormat.JPEG, 85, baos);
            bmp.recycle();
            String base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);

            JSObject ret = new JSObject();
            ret.put("data", "data:image/jpeg;base64," + base64);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "读取图片失败: " + e.getMessage());
            call.reject("读取图片失败: " + e.getMessage());
        }
    }

    /** 打开系统视频选择器，复制到缓存后返回 file:// 路径 */
    @PluginMethod
    public void pickVideo(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("video/*");
        try {
            startActivityForResult(call, intent, "onVideoPicked");
        } catch (Exception e) {
            call.reject("无法打开视频选择器: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void onVideoPicked(PluginCall call, ActivityResult result) {
        if (call == null) return;
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("用户取消了选择");
            return;
        }
        Uri uri = result.getData().getData();
        if (uri == null) { call.reject("未选择视频"); return; }
        try {
            ContentResolver resolver = getContext().getContentResolver();
            InputStream is = resolver.openInputStream(uri);
            if (is == null) { call.reject("无法打开视频"); return; }

            File out = new File(getContext().getCacheDir(), "bgvideo.mp4");
            OutputStream os = new FileOutputStream(out);
            byte[] buf = new byte[8192];
            int n;
            while ((n = is.read(buf)) != -1) os.write(buf, 0, n);
            is.close();
            os.close();

            JSObject ret = new JSObject();
            ret.put("uri", "file://" + out.getAbsolutePath());
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "复制视频失败: " + e.getMessage());
            call.reject("复制视频失败: " + e.getMessage());
        }
    }
}
