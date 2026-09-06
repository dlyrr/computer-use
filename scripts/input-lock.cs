// Swallows the user's physical keyboard and mouse input while the agent is
// driving, so a stray click or keystroke cannot fight the agent mid-action.
//
// It has to be a separate process: low-level hooks need their own message loop,
// and putting the machine's input in the hands of a process that might block is
// how people get locked out of their own computer. Everything here is arranged
// so the lock CANNOT outlive its usefulness:
//
//   1. Escape always releases it. The hook checks for Escape before anything.
//   2. Closing stdin releases it - so if the overlay dies, the lock dies.
//   3. A hard timeout releases it even if both of those fail.
//   4. Killing this process releases it, because Windows tears down hooks when
//      the owning process exits.
//
// Injected input (SetWindowsHookEx reports it via the INJECTED flags) is passed
// through untouched, which is what lets the agent keep working while the person
// at the keyboard is held off.
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class InputLock {
    const int WH_KEYBOARD_LL = 13;
    const int WH_MOUSE_LL = 14;
    const int HC_ACTION = 0;
    const uint WM_QUIT = 0x0012;
    const int VK_ESCAPE = 0x1B;
    const uint LLKHF_INJECTED = 0x10;
    const uint LLMHF_INJECTED = 0x01;

    delegate IntPtr HookProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, HookProc lpfn, IntPtr hMod, uint dwThreadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hhk);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string lpModuleName);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern int GetMessage(out MSG lpMsg, IntPtr hWnd, uint min, uint max);
    [DllImport("user32.dll")] static extern bool PostThreadMessage(uint idThread, uint Msg, IntPtr wParam, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT { public uint vkCode; public uint scanCode; public uint flags; public uint time; public IntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)]
    struct MSLLHOOKSTRUCT { public int x; public int y; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }

    static IntPtr kbHook, msHook;
    static HookProc kbProc, msProc; // kept in statics so the GC cannot collect them
    static uint mainThread;
    static volatile bool escapePressed;

    // Nothing slow may happen inside a hook: Windows silently drops a
    // low-level hook that takes longer than LowLevelHooksTimeout, which would
    // release the lock at random. So the hook only sets a flag.
    static IntPtr OnKey(int code, IntPtr w, IntPtr l) {
        if (code == HC_ACTION) {
            KBDLLHOOKSTRUCT d = (KBDLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(KBDLLHOOKSTRUCT));
            if ((d.flags & LLKHF_INJECTED) == 0) {
                if (d.vkCode == VK_ESCAPE) {
                    escapePressed = true;
                    PostThreadMessage(mainThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
                }
                return (IntPtr)1; // swallow real keystrokes
            }
        }
        return CallNextHookEx(kbHook, code, w, l);
    }

    static IntPtr OnMouse(int code, IntPtr w, IntPtr l) {
        if (code == HC_ACTION) {
            MSLLHOOKSTRUCT d = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(l, typeof(MSLLHOOKSTRUCT));
            if ((d.flags & LLMHF_INJECTED) == 0) return (IntPtr)1; // swallow real mouse
        }
        return CallNextHookEx(msHook, code, w, l);
    }

    public static int Main(string[] args) {
        int maxSeconds = 300;
        if (args.Length > 0) Int32.TryParse(args[0], out maxSeconds);
        if (maxSeconds < 1) maxSeconds = 1;
        mainThread = GetCurrentThreadId();

        // The overlay dying closes this pipe. That is the safety net that makes
        // it impossible to be left locked out by a crash.
        Thread stdinWatch = new Thread(delegate () {
            try { while (Console.In.Read() != -1) { } } catch { }
            PostThreadMessage(mainThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        });
        stdinWatch.IsBackground = true;
        stdinWatch.Start();

        Thread deadline = new Thread(delegate () {
            Thread.Sleep(maxSeconds * 1000);
            PostThreadMessage(mainThread, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
        });
        deadline.IsBackground = true;
        deadline.Start();

        kbProc = new HookProc(OnKey);
        msProc = new HookProc(OnMouse);
        IntPtr mod = GetModuleHandle(null);
        kbHook = SetWindowsHookEx(WH_KEYBOARD_LL, kbProc, mod, 0);
        msHook = SetWindowsHookEx(WH_MOUSE_LL, msProc, mod, 0);
        if (kbHook == IntPtr.Zero || msHook == IntPtr.Zero) {
            if (kbHook != IntPtr.Zero) UnhookWindowsHookEx(kbHook);
            if (msHook != IntPtr.Zero) UnhookWindowsHookEx(msHook);
            Console.Out.WriteLine("error");
            Console.Out.Flush();
            return 1;
        }

        Console.Out.WriteLine("locked");
        Console.Out.Flush();

        MSG msg;
        while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }

        UnhookWindowsHookEx(kbHook);
        UnhookWindowsHookEx(msHook);
        Console.Out.WriteLine(escapePressed ? "escape" : "released");
        Console.Out.Flush();
        return 0;
    }
}
