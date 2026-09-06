// Swaps the system arrow for the agent's cursor while a session runs, so the
// person watching can tell the agent's pointer from their own at a glance.
//
// Same lifetime rules as input-lock: closing stdin restores the cursors, a hard
// timeout restores them, and process exit restores them. SetSystemCursor takes
// ownership of the handle it is given, so each cursor id gets its own load.
//
//   agent-cursor.exe <path.cur> [maxSeconds]
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class AgentCursor {
    const uint OCR_NORMAL = 32512;
    const uint OCR_HAND = 32649;
    const uint SPI_SETCURSORS = 0x0057;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadCursorFromFile(string path);
    [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr hcur, uint id);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint p, IntPtr v, uint winini);

    static int restored;
    static void Restore() {
        if (Interlocked.Exchange(ref restored, 1) == 0) SystemParametersInfo(SPI_SETCURSORS, 0, IntPtr.Zero, 0);
    }

    static int Main(string[] args) {
        if (args.Length < 1) return 2;
        int max = args.Length > 1 ? int.Parse(args[1]) : 900;
        foreach (uint id in new uint[] { OCR_NORMAL, OCR_HAND }) {
            IntPtr h = LoadCursorFromFile(args[0]);
            if (h == IntPtr.Zero) { Restore(); return 3; }
            SetSystemCursor(h, id);
        }
        AppDomain.CurrentDomain.ProcessExit += (s, e) => Restore();
        Console.CancelKeyPress += (s, e) => Restore();
        var t = new Thread(() => { Thread.Sleep(max * 1000); Restore(); Environment.Exit(0); });
        t.IsBackground = true; t.Start();
        // stdin EOF = the overlay let go (or died).
        while (Console.In.Read() != -1) { }
        Restore();
        return 0;
    }
}
