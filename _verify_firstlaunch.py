import subprocess, re, time, xml.etree.ElementTree as ET

ADB = "E:/vivo/pcsuite/adb/adb.exe"

def adb(args):
    return subprocess.run([ADB] + args, capture_output=True, text=True).stdout

def dump(path):
    adb(["shell", "uiautomator", "dump", path])
    return adb(["shell", "cat", path])

def tap_center_of(text):
    xml = dump("/sdcard/ui.xml")
    root = ET.fromstring(xml)
    for node in root.iter("node"):
        if text in (node.get("text") or ""):
            b = node.get("bounds")  # [x1,y1][x2,y2]
            m = re.findall(r"\d+", b)
            if len(m) == 4:
                x = (int(m[0]) + int(m[2])) // 2
                y = (int(m[1]) + int(m[3])) // 2
                adb(["shell", "input", "tap", str(x), str(y)])
                return True
    return False

def visible_texts():
    xml = dump("/sdcard/ui.xml")
    try:
        root = ET.fromstring(xml)
    except Exception:
        return []
    return [n.get("text") for n in root.iter("node") if n.get("text")]

print("== 初始首屏 ==")
print(sorted(set(t for t in visible_texts() if t in ("用户协议与隐私声明","请选择数据保存位置","同意并继续","确认","点击选择文件夹"))))

tap_center_of("同意并继续")
time.sleep(1.5)
print("== 点「同意并继续」后 ==")
print(sorted(set(t for t in visible_texts() if t in ("用户协议与隐私声明","请选择数据保存位置","同意并继续","确认","点击选择文件夹"))))

tap_center_of("确认")
time.sleep(1.5)
print("== 点「确认」后（期望数据目录页消失，主界面出现）==")
txt = visible_texts()
print("数据目录页可见?", "请选择数据保存位置" in txt)
print("主界面元素可见?", any(x in txt for x in ("播放列表","均衡器","打开文件夹","全部播放")) )
