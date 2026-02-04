/* eslint-disable no-restricted-globals */
/**
 * AudioWorkletProcessor that:
 * - Buffers input Float32 PCM
 * - Downsamples to a target sample rate (defaults to 16kHz)
 * - Converts to signed 16-bit PCM (little-endian via Int16Array)
 * - Posts ArrayBuffer chunks back to the main thread
 *
 * The main thread can forward these buffers to a WebSocket directly.
 */

class Pcm16DownsamplerProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        const processorOptions = options?.processorOptions || {};
        this._targetSampleRate = Number(processorOptions.targetSampleRate) || 16000;
        this._chunkSize = Math.max(256, Number(processorOptions.chunkSize) || 4096);

        // Circular buffer to accumulate input samples so we can process in larger chunks.
        this._capacity = Math.max(this._chunkSize * 4, 16384);
        this._buffer = new Float32Array(this._capacity);
        this._write = 0;
        this._read = 0;
        this._available = 0;
        this._paused = false;

        this.port.onmessage = (event) => {
            const data = event?.data || {};
            if (data.type === "setPaused") {
                this._paused = Boolean(data.paused);
                if (this._paused) {
                    this._write = 0;
                    this._read = 0;
                    this._available = 0;
                }
            } else if (data.type === "reset") {
                this._write = 0;
                this._read = 0;
                this._available = 0;
            }
        };
    }

    _push(input) {
        // If we overflow, drop newest samples (keeps audio graph alive without crashing).
        for (let i = 0; i < input.length; i++) {
            if (this._available >= this._capacity) {
                return;
            }
            this._buffer[this._write] = input[i];
            this._write = (this._write + 1) % this._capacity;
            this._available++;
        }
    }

    _popChunk(out) {
        for (let i = 0; i < out.length; i++) {
            out[i] = this._buffer[this._read];
            this._read = (this._read + 1) % this._capacity;
        }
        this._available -= out.length;
    }

    _floatTo16BitPcm(f32) {
        const out = new Int16Array(f32.length);
        for (let i = 0; i < f32.length; i++) {
            const s = Math.max(-1, Math.min(1, f32[i]));
            out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }
        return out;
    }

    // Simple downsampler for speech: averages samples within each output frame.
    _downsampleToTargetRate(input, inputSampleRate) {
        if (!input || input.length === 0) return new Int16Array(0);
        if (inputSampleRate === this._targetSampleRate) {
            return this._floatTo16BitPcm(input);
        }

        const ratio = inputSampleRate / this._targetSampleRate;
        const newLength = Math.max(1, Math.round(input.length / ratio));
        const result = new Int16Array(newLength);

        let offsetBuffer = 0;
        for (let i = 0; i < newLength; i++) {
            const nextOffsetBuffer = Math.round((i + 1) * ratio);
            let sum = 0;
            let count = 0;
            for (let j = offsetBuffer; j < nextOffsetBuffer && j < input.length; j++) {
                sum += input[j];
                count++;
            }
            offsetBuffer = nextOffsetBuffer;
            const avg = count ? sum / count : 0;
            const s = Math.max(-1, Math.min(1, avg));
            result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        }

        return result;
    }

    process(inputs, outputs) {
        const input = inputs?.[0]?.[0];
        const output = outputs?.[0]?.[0];

        // Keep the node "active" by passing audio through (it will be muted by GainNode in main thread).
        if (input && output) {
            output.set(input);
        }

        if (this._paused) {
            return true;
        }

        if (!input || input.length === 0) {
            return true;
        }

        this._push(input);

        // Use the global worklet `sampleRate` (same as the AudioContext rate).
        while (this._available >= this._chunkSize) {
            const chunk = new Float32Array(this._chunkSize);
            this._popChunk(chunk);

            const pcm16 = this._downsampleToTargetRate(chunk, sampleRate);
            if (pcm16.length > 0) {
                // Transfer the underlying ArrayBuffer for efficiency.
                this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
            }
        }

        return true;
    }
}

registerProcessor("pcm16-downsampler", Pcm16DownsamplerProcessor);
