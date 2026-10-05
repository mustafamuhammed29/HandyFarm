using System;
using System.Diagnostics;
using System.IO;

class Program
{
    static int Main(string[] args)
    {
        string appHome = FindAppHome();
        if (string.IsNullOrEmpty(appHome))
        {
            Console.Error.WriteLine("Error: Could not locate Maestro installation home.");
            return 1;
        }

        string libPath = Path.Combine(appHome, "lib", "*");
        string javaExe = FindJava();
        if (string.IsNullOrEmpty(javaExe))
        {
            Console.Error.WriteLine("Error: Java 17+ is required to run Maestro. Please set JAVA_HOME or install JDK.");
            return 1;
        }

        ProcessStartInfo psi = new ProcessStartInfo(javaExe);
        psi.UseShellExecute = false;

        string jvmArgs = "--enable-native-access=ALL-UNNAMED -classpath \"" + libPath + "\" maestro.cli.AppKt";
        foreach (string a in args)
        {
            if (a.Contains(" ") || a.Contains("\""))
            {
                jvmArgs += " \"" + a.Replace("\"", "\\\"") + "\"";
            }
            else
            {
                jvmArgs += " " + a;
            }
        }
        psi.Arguments = jvmArgs;

        using (Process proc = Process.Start(psi))
        {
            proc.WaitForExit();
            return proc.ExitCode;
        }
    }

    static string FindAppHome()
    {
        string envHome = Environment.GetEnvironmentVariable("MAESTRO_HOME");
        if (!string.IsNullOrEmpty(envHome) && Directory.Exists(Path.Combine(envHome, "lib")))
        {
            return envHome;
        }

        string baseDir = AppDomain.CurrentDomain.BaseDirectory;
        string relativeHome = Path.GetFullPath(Path.Combine(baseDir, ".."));
        if (Directory.Exists(Path.Combine(relativeHome, "lib")))
        {
            return relativeHome;
        }

        string localApp = Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        string defaultInstall = Path.Combine(localApp, "Programs", "maestro", "maestro");
        if (Directory.Exists(Path.Combine(defaultInstall, "lib")))
        {
            return defaultInstall;
        }

        return null;
    }

    static string FindJava()
    {
        string javaHome = Environment.GetEnvironmentVariable("JAVA_HOME");
        if (string.IsNullOrEmpty(javaHome))
        {
            javaHome = Environment.GetEnvironmentVariable("JAVA_HOME", EnvironmentVariableTarget.Machine);
        }
        if (!string.IsNullOrEmpty(javaHome))
        {
            string candidate = Path.Combine(javaHome, "bin", "java.exe");
            if (File.Exists(candidate)) return candidate;
        }

        string adoptium = @"C:\Program Files\Eclipse Adoptium";
        if (Directory.Exists(adoptium))
        {
            foreach (var dir in Directory.GetDirectories(adoptium, "jdk*"))
            {
                string candidate = Path.Combine(dir, "bin", "java.exe");
                if (File.Exists(candidate)) return candidate;
            }
        }

        return "java.exe";
    }
}
