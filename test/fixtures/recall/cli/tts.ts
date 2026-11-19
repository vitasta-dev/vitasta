import { Command } from "commander";

export const tts = new Command("tts")
  .option("-m, --model <model>", "TTS model", "tts-1")
  .action(() => {});
