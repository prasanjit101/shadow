const { ElevenLabsClient } = require("elevenlabs");
const settingsService = require("../settings/settingsService");
const { PassThrough } = require("stream");
const Speaker = require("speaker");

class SpeakService {
  constructor() {
    this.elevenLabsClient = null;
    this.initialize();
  }

  async initialize() {
    const apiKey = await settingsService.getElevenLabsApiKey();
    if (apiKey) {
      this.elevenLabsClient = new ElevenLabsClient({ apiKey });
    }
  }

  async speak(text) {
    if (!this.elevenLabsClient) {
      console.log("ElevenLabs API key not set. Cannot speak.");
      return;
    }

    try {
      const audio = await this.elevenLabsClient.textToSpeech.convertAsStream({
        voice: "Rachel",
        model_id: "eleven_multilingual_v2",
        text,
      });

      const audioStream = new PassThrough();
      audio.pipe(audioStream);

      const speaker = new Speaker({
        channels: 1,
        bitDepth: 16,
        sampleRate: 24000,
      });

      audioStream.pipe(speaker);
    } catch (error) {
      console.error("Error speaking text:", error);
    }
  }
}

module.exports = new SpeakService();
