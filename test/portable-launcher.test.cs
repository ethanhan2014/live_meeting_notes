using System;
using System.IO;

static class PortableLauncherTests
{
    static void Main()
    {
        string root = Path.Combine(Path.GetTempPath(), "meeting-portable-test");
        string valid = PortableLauncher.EntryPath(root, "runtime/main.cjs");
        if (valid != Path.Combine(root, "runtime", "main.cjs")) throw new Exception("Valid archive entry rejected.");
        foreach (string entry in new [] { "../outside.exe", "..\\outside.exe", "C:\\outside.exe", "/outside.exe", "../meeting-portable-test-sibling/unsafe.exe" })
        {
            try { PortableLauncher.EntryPath(root, entry); }
            catch (InvalidDataException) { continue; }
            throw new Exception("Archive traversal accepted: " + entry);
        }
        Console.WriteLine("Portable archive path checks passed.");
    }
}
