package com.musicplayer.app;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.DocumentsContract;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.Bridge;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.WebViewLocalServer;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.activity.result.ActivityResult;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.reflect.Method;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * DirectoryPickerPlugin — SAF (Storage Access Framework) 目录选择器
 * 
 * 提供 Android 13+ 的目录选择、文件列举、文件读取功能。
 * JS 端通过 window.Capacitor.Plugins.DirectoryPicker 调用。
 */
@CapacitorPlugin(name = "DirectoryPicker")
public class DirectoryPickerPlugin extends Plugin {

    private static final String TAG = "DirPicker";
    private static final int CHUNK_SIZE = 8192;

    // 虚拟主机：必须与 App 资源处理器（authority=localhost）不同，否则 UriMatcher 的 "**"
    // 资源通配会抢走 /saf_audio/* 请求。该主机由 Capacitor 的 shouldInterceptRequest 拦截，不真正走网络。
    private static final String SAF_HOST = "saf.local";

    // 是否已向 Capacitor 本地服务器注册 /saf_audio/* 处理器（只注册一次）
    private boolean safHandlerRegistered = false;

    // 支持的音频扩展名
    private static final Set<String> AUDIO_EXTS = new HashSet<>();
    static {
        String[] exts = {"mp3", "flac", "wav", "ogg", "oga", "aac", "m4a", "mp4",
                         "opus", "webm", "wma", "ape", "aiff", "aif", "alac", "3gp"};
        for (String e : exts) AUDIO_EXTS.add(e);
    }

    /**
     * 打开 SAF 目录选择器
     * 返回 { uri, name, files: [{name, size, documentId, _treeUri}], count }
     */
    @PluginMethod
    public void pickDirectory(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION |
                        Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);

        try {
            startActivityForResult(call, intent, "onDirectoryPicked");
        } catch (Exception e) {
            call.reject("无法打开目录选择器: " + e.getMessage());
        }
    }

    @ActivityCallback
    private void onDirectoryPicked(PluginCall call, ActivityResult result) {
        if (call == null) {
            return;
        }
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null) {
            call.reject("用户取消了选择");
            return;
        }

        Uri treeUri = result.getData().getData();
        if (treeUri == null) {
            call.reject("未选择目录");
            return;
        }

        // 保留持久化权限
        try {
            getContext().getContentResolver().takePersistableUriPermission(
                treeUri,
                Intent.FLAG_GRANT_READ_URI_PERMISSION
            );
        } catch (SecurityException e) {
            Log.w(TAG, "无法获取持久化权限: " + e.getMessage());
        }

        // 列出音频文件
        JSArray filesArray = new JSArray();
        int count = 0;
        try {
            List<JSObject> files = listAudioFiles(treeUri);
            for (JSObject f : files) {
                filesArray.put(f);
                count++;
            }
        } catch (Exception e) {
            Log.e(TAG, "列出文件失败: " + e.getMessage());
        }

        // 提取目录名
        String dirName = extractDirName(treeUri);

        JSObject ret = new JSObject();
        ret.put("uri", treeUri.toString());
        ret.put("name", dirName);
        ret.put("files", filesArray);
        ret.put("count", count);
        call.resolve(ret);
    }

    /**
     * 列出已保存目录下的文件（通过 treeUri）
     * 接收 { treeUri }
     * 返回 { files: [...], count }
     */
    @PluginMethod
    public void listFiles(PluginCall call) {
        String treeUriStr = call.getString("treeUri");
        if (treeUriStr == null) {
            call.reject("缺少 treeUri 参数");
            return;
        }

        try {
            Uri treeUri = Uri.parse(treeUriStr);
            List<JSObject> files = listAudioFiles(treeUri);

            JSArray filesArray = new JSArray();
            for (JSObject f : files) {
                filesArray.put(f);
            }

            JSObject ret = new JSObject();
            ret.put("files", filesArray);
            ret.put("count", files.size());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("列出文件失败: " + e.getMessage());
        }
    }

    /**
     * 读取文件内容（base64）
     * 接收 { treeUri, documentId }
     * 返回 { data: base64String }
     */
    @PluginMethod
    public void readFile(PluginCall call) {
        String treeUriStr = call.getString("treeUri");
        String documentId = call.getString("documentId");

        if (treeUriStr == null || documentId == null) {
            call.reject("缺少 treeUri 或 documentId 参数");
            return;
        }

        try {
            Uri treeUri = Uri.parse(treeUriStr);
            Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);

            ContentResolver resolver = getContext().getContentResolver();
            InputStream is = resolver.openInputStream(fileUri);
            if (is == null) {
                call.reject("无法打开文件流");
                return;
            }

            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[CHUNK_SIZE];
            int n;
            while ((n = is.read(chunk)) != -1) {
                buffer.write(chunk, 0, n);
            }
            is.close();

            String base64 = Base64.encodeToString(buffer.toByteArray(), Base64.NO_WRAP);

            JSObject ret = new JSObject();
            ret.put("data", base64);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取文件失败: " + e.getMessage());
        }
    }

    /**
     * 读取小文本文件（如 .lrc 歌词）内容
     * 接收 { treeUri, documentId }
     * 返回 { text }
     * 仅限歌词等小型文本：超过 2MB 直接拒绝，防止误用导致内存问题
     */
    @PluginMethod
    public void readTextFile(PluginCall call) {
        String treeUriStr = call.getString("treeUri");
        String documentId = call.getString("documentId");

        if (treeUriStr == null || documentId == null) {
            call.reject("缺少 treeUri 或 documentId 参数");
            return;
        }

        try {
            Uri treeUri = Uri.parse(treeUriStr);
            Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);

            ContentResolver resolver = getContext().getContentResolver();
            InputStream is = resolver.openInputStream(fileUri);
            if (is == null) {
                call.reject("无法打开文件流");
                return;
            }

            ByteArrayOutputStream buffer = new ByteArrayOutputStream();
            byte[] chunk = new byte[CHUNK_SIZE];
            int n;
            while ((n = is.read(chunk)) != -1) {
                buffer.write(chunk, 0, n);
                if (buffer.size() > 2 * 1024 * 1024) {
                    is.close();
                    call.reject("文件过大，仅支持 2MB 以内的文本");
                    return;
                }
            }
            is.close();

            String text = buffer.toString("UTF-8");

            JSObject ret = new JSObject();
            ret.put("text", text);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("读取文本失败: " + e.getMessage());
        }
    }

    /**
     * 把 SAF 文件流式拷贝到应用缓存目录，并通过 Capacitor 本地服务器返回一个
     * 与页面同源（https://localhost）的可播放 URL，交由 WebView <audio> 播放。
     *
     * 为什么不能直接返回 file:// 路径：
     *   页面运行在 https://localhost（Capacitor 本地服务器）下，Chrome 会拒绝从
     *   https 页面加载 file:// 资源（"Not allowed to load local resource"），且
     *   fetch(file://) 也被禁止。因此必须走同源的 https://localhost 虚拟路径。
     *
     * 关键：分块写入磁盘，绝不把整文件读入内存，从而根治大文件（如 70MB+）导致的 OOM 闪退。
     *
     * 接收 { treeUri, documentId, ext? }
     * 返回 { url: "https://saf.local/saf_audio/saf_xxx.mp3", path, size }
     */
    @PluginMethod
    public void getPlayableFile(PluginCall call) {
        String treeUriStr = call.getString("treeUri");
        String documentId = call.getString("documentId");
        String extParam = call.getString("ext");

        if (treeUriStr == null || documentId == null) {
            call.reject("缺少 treeUri 或 documentId 参数");
            return;
        }

        // 统一成带点的扩展名（如 ".mp3"），用于缓存文件名与 MIME 嗅探
        String ext = normalizeExt(extParam);
        if (ext.isEmpty()) {
            String dn = getDisplayName(Uri.parse(treeUriStr), documentId);
            if (dn != null) {
                int dot = dn.lastIndexOf('.');
                if (dot > 0) ext = dn.substring(dot);
            }
        }

        InputStream is = null;
        OutputStream os = null;
        try {
            Uri treeUri = Uri.parse(treeUriStr);
            Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);

            ContentResolver resolver = getContext().getContentResolver();
            is = resolver.openInputStream(fileUri);
            if (is == null) {
                call.reject("无法打开文件流");
                return;
            }

            // 用 documentId 的哈希命名，并带上真实扩展名（用于 MIME 嗅探），
            // 保证同一文件复用同一缓存文件，避免缓存无限膨胀
            File cacheDir = new File(getContext().getCacheDir(), "saf_audio");
            if (!cacheDir.exists()) cacheDir.mkdirs();
            String fileName = "saf_" + Integer.toHexString(documentId.hashCode()) + ext;
            File outFile = new File(cacheDir, fileName);

            os = new FileOutputStream(outFile);
            byte[] chunk = new byte[CHUNK_SIZE];
            int n;
            long total = 0;
            while ((n = is.read(chunk)) != -1) {
                os.write(chunk, 0, n);
                total += n;
            }
            os.flush();

            // 注册虚拟路径处理器（只注册一次），返回 https://saf.local/saf_audio/...
            ensureSafAudioHandlerRegistered();
            Bridge bridge = (Bridge) getBridge();
            String url = bridge.getScheme() + "://" + SAF_HOST + "/saf_audio/" + fileName;

            JSObject ret = new JSObject();
            ret.put("url", url);
            ret.put("path", "file://" + outFile.getAbsolutePath());
            ret.put("size", total);
            call.resolve(ret);

            // 异步清理：缓存超过阈值时删除最旧文件，避免无限占用存储
            pruneSafCacheIfNeeded(cacheDir);
        } catch (Exception e) {
            call.reject("拷贝文件失败: " + e.getMessage());
        } finally {
            try { if (is != null) is.close(); } catch (Exception ignore) {}
            try { if (os != null) os.close(); } catch (Exception ignore) {}
        }
    }

    /**
     * 通过反射向 Capacitor 的 WebViewLocalServer 注册一个作用域为 /saf_audio/* 的处理器，
     * 直接把缓存目录里的音频文件以独立虚拟主机 https://saf.local 的可播放 URL 提供给 WebView。
     * 之所以不用 localhost：localhost 下 App 资源处理器的 "**" 通配会抢先命中、把请求
     * 引到自身资源处理导致 "Unable to open asset URL"。saf.local 主机下没有 "**"，必然命中本处理器。
     * 这样 <audio src> 与带 CORS 头的 fetch() 都能正常工作，且天然支持 Range 拖拽 seek。
     */
    private void ensureSafAudioHandlerRegistered() {
        if (safHandlerRegistered) return;
        try {
            Bridge bridge = (Bridge) getBridge();
            WebViewLocalServer server = bridge.getLocalServer();
            if (server == null) {
                Log.w(TAG, "WebViewLocalServer 为空，无法注册 saf_audio 处理器");
                return;
            }
            Method register = WebViewLocalServer.class.getDeclaredMethod(
                    "register", Uri.class, WebViewLocalServer.PathHandler.class);
            register.setAccessible(true);

            final File cacheDir = new File(getContext().getCacheDir(), "saf_audio");
            if (!cacheDir.exists()) cacheDir.mkdirs();

            WebViewLocalServer.PathHandler handler = new WebViewLocalServer.PathHandler() {
                @Override
                public InputStream handle(Uri url) {
                    String seg = url.getLastPathSegment();
                    if (seg == null) return null;
                    File f = new File(cacheDir, seg);
                    if (!f.exists() || !f.isFile()) return null;
                    try {
                        return new FileInputStream(f);
                    } catch (IOException e) {
                        return null;
                    }
                }

                // 给响应加 CORS 头，使页面（https://localhost）能用 fetch() 跨域读取
                // 本虚拟主机（https://saf.local）的音频流来抽取专辑封面。
                // <audio> 播放本身不受 CORS 限制，这里只补齐封面抽取所需的跨域许可。
                @Override
                public Map<String, String> buildDefaultResponseHeaders() {
                    Map<String, String> headers = new HashMap<>();
                    Map<String, String> base = super.buildDefaultResponseHeaders();
                    if (base != null) headers.putAll(base);
                    headers.put("Access-Control-Allow-Origin", "*");
                    return headers;
                }
            };

            // 关键：注册到与 App 资源处理器（authority=localhost）不同的主机 saf.local。
            // 否则 UriMatcher 中 localhost 的 "**" 资源通配会先于 /saf_audio/* 命中并返回
            // App 自身资源处理器，导致 "Unable to open asset URL"。saf.local 下没有 "**"，
            // 请求必然落到本处理器。
            Uri uri = Uri.parse(bridge.getScheme() + "://" + SAF_HOST + "/saf_audio/*");
            register.invoke(server, uri, handler);
            safHandlerRegistered = true;
            Log.i(TAG, "saf_audio 同源处理器已注册: " + uri);
        } catch (Exception e) {
            Log.e(TAG, "注册 saf_audio 处理器失败: " + e.getMessage());
        }
    }

    /** 缓存文件过多时删除最旧的，保留最近 64 个 */
    private void pruneSafCacheIfNeeded(File cacheDir) {
        try {
            File[] files = cacheDir.listFiles((dir, name) -> name.startsWith("saf_"));
            if (files == null || files.length <= 64) return;
            java.util.Arrays.sort(files, (a, b) -> Long.compare(a.lastModified(), b.lastModified()));
            int toDelete = files.length - 64;
            for (int i = 0; i < toDelete; i++) {
                files[i].delete();
            }
            Log.i(TAG, "saf_audio 缓存清理，删除 " + toDelete + " 个旧文件");
        } catch (Exception ignore) {}
    }

    /** 取 SAF 文档的显示名（用于推断真实扩展名，独立于 JS 传入的 ext） */
    private String getDisplayName(Uri treeUri, String documentId) {
        try {
            Uri fileUri = DocumentsContract.buildDocumentUriUsingTree(treeUri, documentId);
            Cursor c = getContext().getContentResolver().query(
                fileUri, new String[]{ DocumentsContract.Document.COLUMN_DISPLAY_NAME }, null, null, null);
            if (c != null) {
                try { if (c.moveToFirst()) return c.getString(0); } finally { c.close(); }
            }
        } catch (Exception ignore) {}
        return null;
    }

    /** 把扩展名规范成带点的形式（"mp3" -> ".mp3"，".mp3" -> ".mp3"，null/空 -> ""） */
    private static String normalizeExt(String ext) {
        if (ext == null || ext.isEmpty()) return "";
        return ext.startsWith(".") ? ext : "." + ext;
    }

    /**
     * 检查 URI 是否仍有访问权限
     * 接收 { uri }
     * 返回 { granted: boolean }
     */
    @PluginMethod
    public void checkPermission(PluginCall call) {
        String uriStr = call.getString("uri");
        if (uriStr == null) {
            call.reject("缺少 uri 参数");
            return;
        }

        try {
            Uri uri = Uri.parse(uriStr);
            boolean granted = false;

            // 检查持久化权限列表
            for (android.content.UriPermission perm : getContext().getContentResolver().getPersistedUriPermissions()) {
                if (perm.getUri().equals(uri) && perm.isReadPermission()) {
                    granted = true;
                    break;
                }
            }

            // 如果持久化权限没有，尝试直接访问
            if (!granted) {
                try {
                    String docId = DocumentsContract.getTreeDocumentId(uri);
                    Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(uri, docId);
                    Cursor cursor = getContext().getContentResolver().query(childrenUri, null, null, null, null);
                    if (cursor != null) {
                        cursor.close();
                        granted = true;
                    }
                } catch (SecurityException e) {
                    granted = false;
                }
            }

            JSObject ret = new JSObject();
            ret.put("granted", granted);
            call.resolve(ret);
        } catch (Exception e) {
            JSObject ret = new JSObject();
            ret.put("granted", false);
            call.resolve(ret);
        }
    }

    // ============================================================
    // 内部方法
    // ============================================================

    /**
     * 列出目录下的所有音频文件
     */
    private List<JSObject> listAudioFiles(Uri treeUri) throws Exception {
        List<JSObject> result = new ArrayList<>();
        ContentResolver resolver = getContext().getContentResolver();

        String parentDocId = DocumentsContract.getTreeDocumentId(treeUri);
        Uri childrenUri = DocumentsContract.buildChildDocumentsUriUsingTree(treeUri, parentDocId);

        Cursor cursor = resolver.query(
            childrenUri,
            new String[]{
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
                DocumentsContract.Document.COLUMN_SIZE,
                DocumentsContract.Document.COLUMN_MIME_TYPE
            },
            null, null, null
        );

        if (cursor == null) return result;

        // 第一遍全量收集：音频条目 + 同目录「文件名(小写)→documentId」映射（供歌词/封面兄弟文件匹配）
        List<JSObject> audioObjs = new ArrayList<>();
        Map<String, List<String>> nameToDocIds = new HashMap<>();
        while (cursor.moveToNext()) {
            String docId = cursor.getString(0);
            String name = cursor.getString(1);
            long size = cursor.getLong(2);
            String mime = cursor.getString(3);
            if (name == null || docId == null) continue;

            String key = name.toLowerCase();
            List<String> ids = nameToDocIds.get(key);
            if (ids == null) { ids = new ArrayList<>(); nameToDocIds.put(key, ids); }
            ids.add(docId);

            String ext = getExtension(name);
            if (ext != null && AUDIO_EXTS.contains(ext.toLowerCase())) {
                JSObject fileObj = new JSObject();
                fileObj.put("name", name);
                fileObj.put("size", size);
                fileObj.put("documentId", docId);
                fileObj.put("mimeType", mime != null ? mime : "audio/*");
                fileObj.put("_treeUri", treeUri.toString());
                fileObj.put("_isSafFile", true);
                audioObjs.add(fileObj);
            }
        }
        cursor.close();

        // 兄弟文件匹配：网易云导出三件套同目录同名 —— 歌词 {基名}.lrc、封面 {基名}-*.{jpg,jpeg,png,webp}
        for (JSObject o : audioObjs) {
            String audioName = o.getString("name");
            if (audioName == null) continue;
            String base = audioName.toLowerCase();
            int dot = base.lastIndexOf('.');
            if (dot > 0) base = base.substring(0, dot);

            List<String> lyricIds = nameToDocIds.get(base + ".lrc");
            if (lyricIds != null && !lyricIds.isEmpty()) o.put("_lyricDocId", lyricIds.get(0));

            String coverId = null;
            String coverPrefix = base + "-";
            for (Map.Entry<String, List<String>> e : nameToDocIds.entrySet()) {
                String k = e.getKey();
                if (k.startsWith(coverPrefix) && isImageName(k) && !e.getValue().isEmpty()) {
                    coverId = e.getValue().get(0);
                    break;
                }
            }
            if (coverId != null) o.put("_coverDocId", coverId);
            result.add(o);
        }
        return result;
    }

    /** 是否为常见图片文件名（小写，用于同目录封面匹配） */
    private static boolean isImageName(String nameLower) {
        return nameLower.endsWith(".jpg") || nameLower.endsWith(".jpeg")
            || nameLower.endsWith(".png") || nameLower.endsWith(".webp");
    }

    /** 从文件名提取扩展名（小写） */
    private String getExtension(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0 || dot == name.length() - 1) return null;
        return name.substring(dot + 1).toLowerCase();
    }

    /** 从 URI 提取目录名 */
    private String extractDirName(Uri treeUri) {
        try {
            String docId = DocumentsContract.getTreeDocumentId(treeUri);
            // docId 格式如 "primary:Music" 或 "primary:Music/SubFolder"
            String last = docId;
            int colon = docId.indexOf(':');
            if (colon >= 0) {
                last = docId.substring(colon + 1);
            }
            int slash = last.lastIndexOf('/');
            if (slash >= 0) {
                last = last.substring(slash + 1);
            }
            return last.isEmpty() ? "未命名目录" : last;
        } catch (Exception e) {
            return "未命名目录";
        }
    }
}
