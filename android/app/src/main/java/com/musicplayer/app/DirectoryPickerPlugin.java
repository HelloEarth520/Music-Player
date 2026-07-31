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

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;

import androidx.activity.result.ActivityResult;

import java.io.ByteArrayOutputStream;
import java.io.FileInputStream;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
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

        while (cursor.moveToNext()) {
            String docId = cursor.getString(0);
            String name = cursor.getString(1);
            long size = cursor.getLong(2);
            String mime = cursor.getString(3);

            if (name == null) continue;

            // 检查是否是音频文件
            String ext = getExtension(name);
            if (ext != null && AUDIO_EXTS.contains(ext.toLowerCase())) {
                JSObject fileObj = new JSObject();
                fileObj.put("name", name);
                fileObj.put("size", size);
                fileObj.put("documentId", docId);
                fileObj.put("mimeType", mime != null ? mime : "audio/*");
                fileObj.put("_treeUri", treeUri.toString());
                fileObj.put("_isSafFile", true);
                result.add(fileObj);
            }
        }
        cursor.close();

        return result;
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
