using System;
using System.Diagnostics;
using System.IO;
using System.Text;

// No interview window. Diagnostics and errors are always saved locally.
class Launcher {
    [STAThread]
    static int Main(string[] args) {
        string root = AppDomain.CurrentDomain.BaseDirectory;
        string support = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "LingXu");
        string logs = Path.Combine(support, "logs");
        Directory.CreateDirectory(logs);
        string log = Path.Combine(logs, "launch-" + DateTime.UtcNow.ToString("yyyyMMdd-HHmmss-fff") + ".log");
        try {
            // Accept only documented switches; no user-controlled command interpolation.
            string suffix = "";
            foreach(string arg in args) {
                if(arg == "--setup" || arg == "--check-audio") suffix += " " + arg;
                else throw new ArgumentException("Supported options: --setup, --check-audio");
            }
            var info = new ProcessStartInfo(Path.Combine(root, "node.exe"), "\"" + Path.Combine(root, "app", "scripts", "human-interview.mjs") + "\"" + suffix);
            info.WorkingDirectory = Path.Combine(root, "app");
            info.UseShellExecute = false;
            info.CreateNoWindow = true;
            info.RedirectStandardOutput = true;
            info.RedirectStandardError = true;
            info.RedirectStandardInput = true;
            using (var writer = new StreamWriter(log, false, new UTF8Encoding(false))) {
                object gate = new object();
                using (var process = new Process()) {
                    process.StartInfo = info;
                    process.OutputDataReceived += (s, e) => { if(e.Data != null) lock(gate) { writer.WriteLine(e.Data); writer.Flush(); } };
                    process.ErrorDataReceived += (s, e) => { if(e.Data != null) lock(gate) { writer.WriteLine(e.Data); writer.Flush(); } };
                    process.Start(); process.StandardInput.Close();
                    process.BeginOutputReadLine(); process.BeginErrorReadLine();
                    process.WaitForExit();
                    return process.ExitCode;
                }
            }
        } catch(Exception e) {
            File.AppendAllText(log, e.ToString(), Encoding.UTF8);
            return 1;
        }
    }
}
