package com.musicplayer.app;

import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.Drawable;
import android.os.Build;
import android.os.ParcelFileDescriptor;
import android.util.Base64;
import android.util.Log;
import android.view.WindowManager;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;

/**
 * WallpaperPlugin
 * - getSystemWallpaper(): 取系统静态壁纸（drawable），免权限，返回 base64 PNG。
 *   注意：当第三方「动态壁纸」激活时，系统静态壁纸通常是默认图，
 *   因此本方法拿到的不是动态那张（Android 限制）。
 * - exitApp(): 用户拒绝协议时退出应用。
 * - setLiveBlur(radius): 第三方动态壁纸（live 模式）窗口级模糊。
 *   利用 Android 12+ (API 31) WindowManager 的 blur-behind 能力，
 *   直接模糊窗口背后的系统壁纸层（CSS backdrop-filter 做不到的正是这层）。
 */
@CapacitorPlugin(name = "WallpaperPlugin")
public class WallpaperPlugin extends Plugin {

    private static final String TAG = "WallpaperPlugin";

    /** 设置 live 模式窗口背后模糊半径（0=关闭）。仅 Android 12+ 有效，旧版本静默忽略。 */
    @PluginMethod
    public void setLiveBlur(PluginCall call) {
        try {
            int radius = call.getInt("radius", 0);
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) {
                // API 31 以下不支持 blur-behind，直接成功返回（保持现状：live 清晰）
                call.resolve();
                return;
            }
            final int r = Math.max(0, Math.min(150, radius));
            getActivity().runOnUiThread(() -> {
                try {
                    WindowManager.LayoutParams lp = getActivity().getWindow().getAttributes();
                    if (r > 0) {
                        lp.flags |= WindowManager.LayoutParams.FLAG_BLUR_BEHIND;
                    } else {
                        lp.flags &= ~WindowManager.LayoutParams.FLAG_BLUR_BEHIND;
                    }
                    lp.setBlurBehindRadius(r);
                    getActivity().getWindow().setAttributes(lp);
                    Log.d(TAG, "setLiveBlur radius=" + r);
                    call.resolve();
                } catch (Exception e) {
                    Log.e(TAG, "setLiveBlur failed: " + e.getMessage());
                    call.reject("设置壁纸模糊失败: " + e.getMessage());
                }
            });
        } catch (Exception e) {
            Log.e(TAG, "setLiveBlur error: " + e.getMessage());
            call.reject("设置壁纸模糊失败: " + e.getMessage());
        }
    }

    /** 取系统静态壁纸为 base64（用于「系统背景」模式） */
    @PluginMethod
    public void getSystemWallpaper(PluginCall call) {
        try {
            android.app.WallpaperManager wm =
                    android.app.WallpaperManager.getInstance(getContext());
            Bitmap bitmap = null;

            // 优先：getWallpaperFile（部分 ROM 免权限）
            try {
                ParcelFileDescriptor pfd = wm.getWallpaperFile(
                        android.app.WallpaperManager.FLAG_SYSTEM);
                if (pfd != null) {
                    FileInputStream fis = new FileInputStream(pfd.getFileDescriptor());
                    bitmap = BitmapFactory.decodeStream(fis);
                    fis.close();
                    pfd.close();
                }
            } catch (Exception ignore) { /* 继续尝试 getDrawable */ }

            // 兜底：getDrawable（系统静态壁纸 drawable，一般免权限）
            if (bitmap == null) {
                Drawable drawable = wm.getDrawable();
                if (drawable == null) {
                    call.reject("无法获取系统壁纸");
                    return;
                }
                if (drawable instanceof BitmapDrawable) {
                    bitmap = ((BitmapDrawable) drawable).getBitmap();
                } else {
                    int w = drawable.getIntrinsicWidth();
                    int h = drawable.getIntrinsicHeight();
                    if (w <= 0 || h <= 0) { w = 1080; h = 1920; }
                    bitmap = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
                    Canvas canvas = new Canvas(bitmap);
                    drawable.setBounds(0, 0, canvas.getWidth(), canvas.getHeight());
                    drawable.draw(canvas);
                }
            }

            if (bitmap == null) {
                call.reject("无法获取系统壁纸");
                return;
            }

            // 缩小到合理尺寸，减少 base64 传输量
            int maxDim = 1080;
            if (bitmap.getWidth() > maxDim || bitmap.getHeight() > maxDim) {
                float scale = Math.min(
                        (float) maxDim / bitmap.getWidth(),
                        (float) maxDim / bitmap.getHeight());
                bitmap = Bitmap.createScaledBitmap(bitmap,
                        Math.round(bitmap.getWidth() * scale),
                        Math.round(bitmap.getHeight() * scale), true);
            }

            ByteArrayOutputStream baos = new ByteArrayOutputStream();
            bitmap.compress(Bitmap.CompressFormat.JPEG, 82, baos);
            String base64 = Base64.encodeToString(baos.toByteArray(), Base64.NO_WRAP);

            JSObject ret = new JSObject();
            ret.put("data", "data:image/jpeg;base64," + base64);
            call.resolve(ret);
        } catch (Exception e) {
            Log.e(TAG, "getSystemWallpaper failed: " + e.getMessage());
            call.reject("获取系统壁纸失败: " + e.getMessage());
        }
    }

    /** 用户拒绝用户协议时退出应用 */
    @PluginMethod
    public void exitApp(PluginCall call) {
        try {
            getActivity().finishAffinity();
            System.exit(0);
        } catch (Exception e) {
            Log.e(TAG, "exitApp failed: " + e.getMessage());
        }
        if (call != null) call.resolve();
    }
}
