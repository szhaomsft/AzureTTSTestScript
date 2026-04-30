// AzureTTSStreaming — C# program to call Azure HD voice in streaming mode.
//
// Usage:
//   dotnet run -- --key <KEY> --region <REGION> [options]
//
// Options:
//   --key      <key>      Azure Speech subscription key (required)
//   --region   <region>  Azure region, e.g. eastus (required)
//   --voice    <voice>   Voice name (default: en-US-Ava:DragonHDLatestNeural)
//   --locale   <locale>  BCP-47 locale tag (default: en-US)
//   --text     <text>    Text to synthesize (default: built-in sample)
//   --output   <file>    Output WAV file path (default: output.wav)
//                        Pass "-" to play audio to the default speaker instead.
//
// The program uses StartSpeakingSsmlAsync / AudioDataStream so audio bytes are
// received and written incrementally as the service streams them back, rather
// than waiting for the full synthesis to complete first.

using System;
using System.IO;
using System.Threading.Tasks;
using Microsoft.CognitiveServices.Speech;
using Microsoft.CognitiveServices.Speech.Audio;

namespace AzureTTSStreaming
{
    internal static class Program
    {
        // Default sample text used when --text is not supplied.
        private const string DefaultText =
            "In the rapidly evolving world of artificial intelligence, voice synthesis has undergone " +
            "a remarkable transformation over the past decade. Early text-to-speech systems produced " +
            "robotic, monotone output that was immediately recognizable as synthetic. Today, neural " +
            "text-to-speech models, particularly high-definition voices powered by deep learning, " +
            "generate speech that is nearly indistinguishable from natural human conversation. " +
            "These models capture subtle prosodic patterns, breathing rhythms, and emotional " +
            "inflections that bring synthesized voices to life. Azure HD Neural Voice, built on " +
            "Microsoft's latest Dragon neural architecture, represents the cutting edge of this " +
            "technology, delivering studio-quality audio with remarkably low latency through a " +
            "streaming architecture that begins delivering audio within milliseconds of receiving " +
            "the synthesis request, long before the full audio has been generated server-side.";

        static async Task<int> Main(string[] args)
        {
            // --- Parse arguments ---
            string? key = null;
            string? region = null;
            string voice = "en-US-Ava:DragonHDLatestNeural";
            string locale = "en-US";
            string text = DefaultText;
            string output = "output.wav";

            for (int i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--key":    key    = Next(args, ref i); break;
                    case "--region": region = Next(args, ref i); break;
                    case "--voice":  voice  = Next(args, ref i); break;
                    case "--locale": locale = Next(args, ref i); break;
                    case "--text":   text   = Next(args, ref i); break;
                    case "--output": output = Next(args, ref i); break;
                    case "--help":
                    case "-h":
                        PrintUsage();
                        return 0;
                    default:
                        Console.Error.WriteLine($"Unknown argument: {args[i]}");
                        PrintUsage();
                        return 1;
                }
            }

            if (string.IsNullOrWhiteSpace(key) || string.IsNullOrWhiteSpace(region))
            {
                Console.Error.WriteLine("Error: --key and --region are required.");
                PrintUsage();
                return 1;
            }

            // --- Configure speech service ---
            var speechConfig = SpeechConfig.FromSubscription(key, region);

            // Request 24-kHz 16-bit mono PCM so we can wrap it in a WAV header.
            speechConfig.SetSpeechSynthesisOutputFormat(
                SpeechSynthesisOutputFormat.Riff24Khz16BitMonoPcm);

            // --- Build SSML ---
            // HD voices require SSML to specify the exact voice name (including the
            // DragonHD suffix).  Plain text synthesis maps to the default voice and
            // may not activate the HD model.
            string ssml = BuildSsml(voice, locale, EscapeXml(text));

            // --- Stream synthesis ---
            bool writeToFile = output != "-";
            Console.WriteLine($"Voice  : {voice}");
            Console.WriteLine($"Region : {region}");
            Console.WriteLine($"Output : {(writeToFile ? output : "<speaker>")}");
            Console.WriteLine();

            if (writeToFile)
            {
                return await SynthesizeToFileAsync(speechConfig, ssml, output);
            }
            else
            {
                return await SynthesizeToSpeakerAsync(speechConfig, ssml);
            }
        }

        // -------------------------------------------------------------------------
        // Streaming synthesis → WAV file
        // -------------------------------------------------------------------------
        private static async Task<int> SynthesizeToFileAsync(
            SpeechConfig speechConfig, string ssml, string outputPath)
        {
            // Use a pull-audio-output stream so we can intercept raw PCM bytes as
            // they arrive from the service without going through a speaker device.
            using var pullStream = AudioOutputStream.CreatePullStream();
            using var audioConfig = AudioConfig.FromStreamOutput(pullStream);
            using var synthesizer = new SpeechSynthesizer(speechConfig, audioConfig);

            // Latency tracking.
            var requestStart = System.Diagnostics.Stopwatch.StartNew();
            long ttfabMs = -1;  // time-to-first-audio-byte
            bool firstChunk = true;

            // Subscribe to events for progress reporting.
            synthesizer.SynthesisStarted   += (_, e) => Console.WriteLine($"[{requestStart.ElapsedMilliseconds,6} ms] Synthesis started.");
            synthesizer.Synthesizing       += (_, e) =>
            {
                if (firstChunk)
                {
                    ttfabMs = requestStart.ElapsedMilliseconds;
                    firstChunk = false;
                    Console.WriteLine($"[{ttfabMs,6} ms] First audio chunk received (TTFAB = {ttfabMs} ms).");
                }
                Console.Write($"\r[{requestStart.ElapsedMilliseconds,6} ms] Received {e.Result.AudioData.Length,7} bytes so far…   ");
            };
            synthesizer.SynthesisCompleted += (_, e) =>
            {
                Console.WriteLine();
                Console.WriteLine($"[{requestStart.ElapsedMilliseconds,6} ms] Synthesis completed. Total audio bytes: {e.Result.AudioData.Length}");
            };
            synthesizer.SynthesisCanceled  += (_, e) =>
            {
                var detail = SpeechSynthesisCancellationDetails.FromResult(e.Result);
                Console.Error.WriteLine($"[Event] Synthesis cancelled: {detail.Reason} — {detail.ErrorDetails}");
            };

            // StartSpeakingSsmlAsync returns as soon as the service begins streaming;
            // audio data is available through AudioDataStream before synthesis ends.
            Console.WriteLine("Starting streaming synthesis …");
            using var result = await synthesizer.StartSpeakingSsmlAsync(ssml);
            long startReturnMs = requestStart.ElapsedMilliseconds;
            Console.WriteLine($"[{startReturnMs,6} ms] StartSpeakingSsmlAsync returned (request-to-stream-open latency = {startReturnMs} ms).");

            if (result.Reason == ResultReason.Canceled)
            {
                var detail = SpeechSynthesisCancellationDetails.FromResult(result);
                Console.Error.WriteLine($"Synthesis failed: {detail.Reason} — {detail.ErrorDetails}");
                return 1;
            }

            // Drain the audio data stream, writing chunks to the output file.
            using var dataStream = AudioDataStream.FromResult(result);
            using var fileStream = new FileStream(outputPath, FileMode.Create, FileAccess.Write);

            byte[] buffer = new byte[8192];
            uint totalBytes = 0;

            Console.WriteLine($"Streaming audio to '{outputPath}' …");
            while (true)
            {
                uint bytesRead = dataStream.ReadData(buffer);
                if (bytesRead == 0)
                    break;

                await fileStream.WriteAsync(buffer.AsMemory(0, (int)bytesRead));
                totalBytes += bytesRead;
                Console.Write($"\r  Written {totalBytes,8} bytes …   ");
            }

            Console.WriteLine();
            Console.WriteLine($"Done. Saved {totalBytes} bytes to '{outputPath}'.");

            // --- Latency summary ---
            long totalMs = requestStart.ElapsedMilliseconds;
            Console.WriteLine();
            Console.WriteLine("=== Latency Summary ===");
            Console.WriteLine($"  Time-to-first-audio-byte (TTFAB) : {(ttfabMs >= 0 ? ttfabMs + " ms" : "n/a")}");
            Console.WriteLine($"  Total synthesis + write time      : {totalMs} ms");
            Console.WriteLine($"  Audio size                        : {totalBytes} bytes");
            Console.WriteLine("=======================");
            return 0;
        }

        // -------------------------------------------------------------------------
        // Streaming synthesis → default speaker (uses SDK's built-in audio output)
        // -------------------------------------------------------------------------
        private static async Task<int> SynthesizeToSpeakerAsync(
            SpeechConfig speechConfig, string ssml)
        {
            // When no AudioConfig is passed the SDK routes audio to the default speaker.
            using var synthesizer = new SpeechSynthesizer(speechConfig);

            synthesizer.SynthesisStarted   += (_, e) => Console.WriteLine("[Event] Synthesis started — audio is playing.");
            synthesizer.Synthesizing       += (_, e) => Console.Write($"\r[Event] Received {e.Result.AudioData.Length,7} bytes so far…   ");
            synthesizer.SynthesisCompleted += (_, e) =>
            {
                Console.WriteLine();
                Console.WriteLine("[Event] Synthesis and playback complete.");
            };
            synthesizer.SynthesisCanceled  += (_, e) =>
            {
                var detail = SpeechSynthesisCancellationDetails.FromResult(e.Result);
                Console.Error.WriteLine($"[Event] Synthesis cancelled: {detail.Reason} — {detail.ErrorDetails}");
            };

            Console.WriteLine("Starting streaming synthesis to speaker …");
            using var result = await synthesizer.StartSpeakingSsmlAsync(ssml);

            if (result.Reason == ResultReason.Canceled)
            {
                var detail = SpeechSynthesisCancellationDetails.FromResult(result);
                Console.Error.WriteLine($"Synthesis failed: {detail.Reason} — {detail.ErrorDetails}");
                return 1;
            }

            // Wait for playback to finish.
            using var dataStream = AudioDataStream.FromResult(result);
            byte[] buffer = new byte[8192];
            while (dataStream.ReadData(buffer) > 0) { /* drain */ }

            return 0;
        }

        // -------------------------------------------------------------------------
        // Helpers
        // -------------------------------------------------------------------------

        private static string BuildSsml(string voice, string locale, string escapedText) =>
            $"""
            <speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis"
                   xml:lang="{locale}">
              <voice name="{voice}">
                {escapedText}
              </voice>
            </speak>
            """;

        private static string EscapeXml(string text) =>
            text
                .Replace("&", "&amp;")
                .Replace("<", "&lt;")
                .Replace(">", "&gt;")
                .Replace("'", "&apos;")
                .Replace("\"", "&quot;");

        private static string Next(string[] args, ref int i)
        {
            if (++i >= args.Length)
                throw new ArgumentException($"Missing value after '{args[i - 1]}'.");
            return args[i];
        }

        private static void PrintUsage()
        {
            Console.WriteLine("""
                Usage: dotnet run -- --key <KEY> --region <REGION> [options]

                Options:
                  --key      <key>     Azure Speech subscription key  (required)
                  --region   <region>  Azure region, e.g. eastus      (required)
                  --voice    <voice>   Voice name
                                       (default: en-US-Ava:DragonHDLatestNeural)
                  --locale   <locale>  BCP-47 locale tag (default: en-US)
                  --text     <text>    Text to synthesize
                  --output   <file>    Output WAV file (default: output.wav)
                                       Use "-" to play to the default speaker.

                Examples:
                  dotnet run -- --key abc123 --region eastus
                  dotnet run -- --key abc123 --region eastus ^
                               --voice en-GB-Sonia:DragonHDLatestNeural ^
                               --locale en-GB ^
                               --text "Hello from the UK!" ^
                               --output sonia.wav
                  dotnet run -- --key abc123 --region eastus --output -
                """);
        }
    }
}
