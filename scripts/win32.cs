using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;

public class AgentOverlayWin32 {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);

  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextLengthW(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowThreadProcessId(IntPtr h, out int pid);
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int idx);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

  public class WinInfo {
    public long id; public int pid; public string title;
    public int x, y, width, height; public bool focused; public bool minimized;
  }

  public static List<WinInfo> List() {
    var fg = GetForegroundWindow();
    var res = new List<WinInfo>();
    EnumWindows(delegate (IntPtr h, IntPtr p) {
      if (!IsWindowVisible(h)) return true;
      if (GetWindow(h, 4 /*GW_OWNER*/) != IntPtr.Zero) return true;
      if ((GetWindowLong(h, -20 /*GWL_EXSTYLE*/) & 0x00000080 /*WS_EX_TOOLWINDOW*/) != 0) return true;
      int len = GetWindowTextLengthW(h);
      if (len == 0) return true;
      var sb = new StringBuilder(len + 1);
      GetWindowTextW(h, sb, sb.Capacity);
      RECT r;
      if (!GetWindowRect(h, out r)) return true;
      res.Add(new WinInfo {
        id = h.ToInt64(), pid = PidOf(h), title = sb.ToString(),
        x = r.Left, y = r.Top, width = r.Right - r.Left, height = r.Bottom - r.Top,
        focused = (h == fg), minimized = IsIconic(h)
      });
      return true;
    }, IntPtr.Zero);
    return res;
  }

  static int PidOf(IntPtr h) { int pid; GetWindowThreadProcessId(h, out pid); return pid; }

  public static string Focus(long handle) {
    IntPtr h = new IntPtr(handle);
    if (!IsWindow(h)) return "stale";
    if (IsIconic(h)) ShowWindow(h, 9 /*SW_RESTORE*/);
    // SetForegroundWindow is refused when the caller does not own the foreground.
    // The Alt tap makes the shell treat this thread as user-initiated.
    System.Windows.Forms.SendKeys.SendWait("%");
    return SetForegroundWindow(h) ? "ok" : "refused";
  }
}
