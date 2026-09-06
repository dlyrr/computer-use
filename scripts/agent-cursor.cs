// Swaps the system cursors for the agent's cursor while a session runs, so the
// person watching can tell the agent's pointer from their own at a glance.
//
// Every standard cursor id is replaced, not just the arrow, otherwise the
// I-beam over text or the hand over a link brings the default look back. And
// it is re-applied every second: anything that reloads the cursor set (a
// pointer-size change, a theme event, another app calling SPI_SETCURSORS)
// would otherwise silently undo it mid-session.
//
// Same lifetime rules as input-lock: closing stdin restores the cursors, a hard
// timeout restores them, and process exit restores them. SetSystemCursor takes
// ownership of the handle it is given, so each id gets its own load each time.
//
//   agent-cursor.exe <path.cur> [maxSeconds]
using System;
using System.Runtime.InteropServices;
using System.Threading;

public class AgentCursor {
    static readonly uint[] IDS = {
        32512, // OCR_NORMAL
        32513, // OCR_IBEAM
        32514, // OCR_WAIT
        32515, // OCR_CROSS
        32516, // OCR_UP
        32642, // OCR_SIZENWSE
        32643, // OCR_SIZENESW
        32644, // OCR_SIZEWE
        32645, // OCR_SIZENS
        32646, // OCR_SIZEALL
        32648, // OCR_NO
        32649, // OCR_HAND
        32650, // OCR_APPSTARTING
        32651, // OCR_HELP
    };
    const uint SPI_SETCURSORS = 0x0057;

    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr LoadCursorFromFile(string path);
    [DllImport("user32.dll")] static extern bool SetSystemCursor(IntPtr hcur, uint id);
    [DllImport("user32.dll")] static extern bool SystemParametersInfo(uint action, uint p, IntPtr v, uint winini);

    static int restored;
    static void Restore() {
        if (Interlocked.Exchange(ref restored, 1) == 0) SystemParametersInfo(SPI_SETCURSORS, 0, IntPtr.Zero, 0);
    }

    static bool Apply(string file) {
        foreach (uint id in IDS) {
            IntPtr h = LoadCursorFromFile(file);
            if (h == IntPtr.Zero) return false;
            SetSystemCursor(h, id);
        }
        return true;
    }

    static int Main(string[] args) {
        if (args.Length < 1) return 2;
        int max = args.Length > 1 ? int.Parse(args[1]) : 900;
        if (!Apply(args[0])) { Restore(); return 3; }
        AppDomain.CurrentDomain.ProcessExit += (s, e) => Restore();
        Console.CancelKeyPress += (s, e) => Restore();

        // stdin EOF = the overlay let go (or died).
        var done = new ManualResetEvent(false);
        var reader = new Thread(() => { try { while (Console.In.Read() != -1) { } } catch { } done.Set(); });
        reader.IsBackground = true; reader.Start();

        var deadline = DateTime.UtcNow.AddSeconds(max);
        while (!done.WaitOne(1000) && DateTime.UtcNow < deadline) Apply(args[0]);
        Restore();
        return 0;
    }
}
