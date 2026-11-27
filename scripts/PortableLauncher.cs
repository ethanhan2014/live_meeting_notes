using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Security.Cryptography;
using System.Threading;
using System.Windows.Forms;

static class PortableLauncher
{
    const string PayloadHash = "__PAYLOAD_HASH__";

    internal static string EntryPath(string directory, string entry)
    {
        string prefix = Path.GetFullPath(directory) + Path.DirectorySeparatorChar;
        string destination = Path.GetFullPath(Path.Combine(directory, entry));
        if (!destination.StartsWith(prefix, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("The portable archive contains an unsafe path.");
        return destination;
    }

    static string Prepare()
    {
        string parent = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Live Meeting Notes", "portable");
        string directory = Path.Combine(parent, PayloadHash.Substring(0, 24));
        using (var mutex = new Mutex(false, "Local\\LiveMeetingNotesPortable-" + PayloadHash))
        {
            bool locked;
            try { locked = mutex.WaitOne(TimeSpan.FromMinutes(10)); }
            catch (AbandonedMutexException) { locked = true; }
            if (!locked) throw new IOException("Another app launch is still preparing the runtime. Try again shortly.");
            try
            {
                string marker = Path.Combine(directory, ".complete");
                if (File.Exists(marker) && File.ReadAllText(marker) == PayloadHash) return directory;
                Directory.CreateDirectory(parent);
                string staging = directory + ".partial-" + Guid.NewGuid().ToString("N");
                using (var progress = new Form())
                {
                    progress.Text = "Live Meeting Notes";
                    progress.Width = 440; progress.Height = 135;
                    progress.StartPosition = FormStartPosition.CenterScreen;
                    progress.FormBorderStyle = FormBorderStyle.FixedDialog;
                    progress.ControlBox = false;
                    progress.Controls.Add(new Label { Dock = DockStyle.Fill, Padding = new Padding(20),
                        Text = "Preparing the speech runtime for first launch.\nThis can take a few minutes." });
                    progress.Show(); Application.DoEvents();
                    try
                    {
                        Directory.CreateDirectory(staging);
                        using (Stream payload = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
                        {
                            using (var sha = SHA256.Create())
                            {
                                string actual = BitConverter.ToString(sha.ComputeHash(payload)).Replace("-", "").ToLowerInvariant();
                                if (actual != PayloadHash) throw new InvalidDataException("The portable executable is damaged. Download it again.");
                            }
                            payload.Position = 0;
                            using (var archive = new ZipArchive(payload, ZipArchiveMode.Read))
                            {
                                foreach (var entry in archive.Entries)
                                {
                                    string destination = EntryPath(staging, entry.FullName);
                                    if (entry.Name.Length == 0) Directory.CreateDirectory(destination);
                                    else
                                    {
                                        Directory.CreateDirectory(Path.GetDirectoryName(destination));
                                        using (var source = entry.Open())
                                        using (var target = new FileStream(destination, FileMode.CreateNew)) source.CopyTo(target);
                                    }
                                    Application.DoEvents();
                                }
                            }
                        }
                        File.WriteAllText(Path.Combine(staging, ".complete"), PayloadHash);
                        Directory.Move(staging, directory);
                    }
                    finally { if (Directory.Exists(staging)) Directory.Delete(staging, true); }
                }
                return directory;
            }
            finally { mutex.ReleaseMutex(); }
        }
    }

    [STAThread]
    static int Main(string[] args)
    {
        Application.EnableVisualStyles();
        try
        {
            string directory = Prepare();
            if (args.Length == 1 && args[0] == "--verify-portable")
            {
                Console.WriteLine(directory);
                return 0;
            }
            var start = new ProcessStartInfo(Path.Combine(directory, "live-meeting-notes.exe"));
            start.WorkingDirectory = directory; start.UseShellExecute = false;
            start.EnvironmentVariables["MEETING_PYTHON"] = Path.Combine(directory, "python", "python.exe");
            start.EnvironmentVariables["MEETING_MODEL_CACHE"] = Path.Combine(directory, "models");
            start.EnvironmentVariables["TORCH_HOME"] = Path.Combine(directory, "torch");
            start.EnvironmentVariables["PATH"] = Path.Combine(directory, "ffmpeg", "bin") + ";" +
                Path.Combine(directory, "python") + ";" + Environment.GetEnvironmentVariable("PATH");
            if (Directory.Exists(Path.Combine(directory, "webview2")))
                start.EnvironmentVariables["WEBVIEW2_BROWSER_EXECUTABLE_FOLDER"] = Path.Combine(directory, "webview2");
            using (var app = Process.Start(start)) { app.WaitForExit(); return app.ExitCode; }
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.Message);
            if (!(args.Length == 1 && args[0] == "--verify-portable"))
                MessageBox.Show(error.Message, "Could not start Live Meeting Notes", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }
    }
}
