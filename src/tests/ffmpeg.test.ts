import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createTransmuxStream,
	getPlaybackCompatibility,
	isSupportedFormat,
	needsTransmux,
	normalizeFileForPlayback,
	probeFile,
	transmuxFile,
} from "$lib/server/ffmpeg";

// Mock ffmpeg-installer
vi.mock("@ffmpeg-installer/ffmpeg", () => ({
	default: { path: "/mock/ffmpeg" },
}));

// Mock fluent-ffmpeg
const { mockFfmpegConstructor, mockFfmpegCommand } = vi.hoisted(() => {
	const mockCommand = {
		inputFormat: vi.fn().mockReturnThis(),
		inputOptions: vi.fn().mockReturnThis(),
		outputFormat: vi.fn().mockReturnThis(),
		outputOptions: vi.fn().mockReturnThis(),
		setStartTime: vi.fn().mockReturnThis(),
		output: vi.fn().mockReturnThis(),
		on: vi.fn().mockReturnThis(),
		pipe: vi.fn().mockReturnThis(),
		run: vi.fn(),
	};

	const mockConstructor = Object.assign(
		vi.fn(() => mockCommand),
		{
			setFfmpegPath: vi.fn(),
			setFfprobePath: vi.fn(),
			ffprobe: vi.fn(),
		}
	);

	return {
		mockFfmpegConstructor: mockConstructor,
		mockFfmpegCommand: mockCommand,
	};
});

vi.mock("fluent-ffmpeg", () => ({
	default: mockFfmpegConstructor,
}));

// Hardware detection runs real ffmpeg; pin the CPU encoder so tests do not depend on the machine.
vi.mock("$lib/server/encoder", async (importOriginal) => ({
	...(await importOriginal<typeof import("$lib/server/encoder")>()),
	resolveEncoder: vi.fn(async () => "libx264"),
}));

function mockCodecs(videoCodec = "h264", audioCodec: string | null = "aac", audioChannels = 2): void {
	mockFfmpegConstructor.ffprobe.mockImplementation(
		(_path: string, callback: (err: Error | null, data?: unknown) => void) => {
			callback(null, {
				format: { duration: 100 },
				streams: [
					{ codec_type: "video", codec_name: videoCodec },
					...(audioCodec ? [{ codec_type: "audio", codec_name: audioCodec, channels: audioChannels }] : []),
				],
			});
		}
	);
}

describe("FFmpeg Service", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockCodecs();
		mockFfmpegCommand.run.mockReset();
		// Reset event handlers
		mockFfmpegCommand.on.mockImplementation((event, callback) => {
			if (event === "end") {
				queueMicrotask(callback);
			}
			return mockFfmpegCommand;
		});
	});

	describe("Format Helpers", () => {
		it("should identify transmuxable formats", () => {
			expect(needsTransmux("video.mkv")).toBe(true);
			expect(needsTransmux("video.avi")).toBe(true);
			expect(needsTransmux("video.mp4")).toBe(false);
		});

		it("should identify supported formats", () => {
			expect(isSupportedFormat("video.mp4")).toBe(true);
			expect(isSupportedFormat("video.mkv")).toBe(true);
			expect(isSupportedFormat("text.txt")).toBe(false);
		});
	});

	describe("createTransmuxStream", () => {
		it("should create a transmux stream", () => {
			const input = new PassThrough();
			const stream = createTransmuxStream({ inputStream: input, fileName: "video.mkv" });

			expect(mockFfmpegConstructor).toHaveBeenCalledWith(input);
			expect(mockFfmpegCommand.inputFormat).toHaveBeenCalledWith("matroska");
			expect(mockFfmpegCommand.outputFormat).toHaveBeenCalledWith("mp4");
			expect(stream).toBeInstanceOf(PassThrough);
			expect(mockFfmpegCommand.inputOptions).toHaveBeenCalledWith([
				"-fflags",
				"+genpts",
				"-analyzeduration",
				"5M",
				"-probesize",
				"5M",
			]);
			const options = mockFfmpegCommand.outputOptions.mock.calls.flat(2);
			expect(options[options.indexOf("-movflags") + 1]).toBe("frag_keyframe+empty_moov+default_base_moof");
			// A non-seekable input cannot be separately probed without consuming it.
			expect(mockFfmpegConstructor.ffprobe).not.toHaveBeenCalled();
			expect(options[options.indexOf("-c:a") + 1]).toBe("aac");
		});

		it("should handle start time", () => {
			const input = new PassThrough();
			createTransmuxStream({ inputStream: input, start: 10 });

			expect(mockFfmpegCommand.setStartTime).toHaveBeenCalledWith(10);
		});

		it("should handle errors", () => {
			const input = new PassThrough();
			const onError = vi.fn();

			// Mock error handler
			mockFfmpegCommand.on.mockImplementation((event, callback) => {
				if (event === "error") {
					queueMicrotask(() => {
						callback(new Error("FFmpeg error"), null, "stderr output");
					});
				}
				return mockFfmpegCommand;
			});

			// We need to wait for the async error handling
			return new Promise<void>((resolve) => {
				const onError = vi.fn().mockImplementation(() => {
					resolve();
				});
				const stream = createTransmuxStream({ inputStream: input, onError });
				stream.on("error", () => {}); // Prevent uncaught exception
			});
		});
	});

	describe("transmuxFile", () => {
		it.each([
			["aac", 2, "copy"],
			["mp3", 1, "copy"],
			["aac", 6, "aac"],
			["ac3", 6, "aac"],
		])("transmuxes %s (%i channels) with audio=%s", async (codec, channels, encoder) => {
			mockCodecs("h264", codec, channels);
			await transmuxFile("input.mkv", "output.mp4");
			const options = mockFfmpegCommand.outputOptions.mock.calls.flat(2);
			expect(options[options.indexOf("-c:v") + 1]).toBe("copy");
			expect(options[options.indexOf("-c:a") + 1]).toBe(encoder);
			expect(options[options.indexOf("-movflags") + 1]).toBe("+faststart");
			if (encoder === "copy") {
				expect(options).not.toContain("-ac");
				expect(options).not.toContain("-b:a");
			}
		});

		it("should transmux file", async () => {
			mockFfmpegCommand.run.mockImplementation(() => {
				// Simulate success
			});

			await transmuxFile("input.mkv", "output.mp4");

			expect(mockFfmpegConstructor).toHaveBeenCalledWith("input.mkv");
			expect(mockFfmpegCommand.output).toHaveBeenCalledWith("output.mp4");
			expect(mockFfmpegCommand.run).toHaveBeenCalled();
		});

		it("should handle transmux errors", async () => {
			mockFfmpegCommand.on.mockImplementation((event, callback) => {
				if (event === "error") {
					queueMicrotask(() => callback(new Error("Transmux failed")));
				}
				return mockFfmpegCommand;
			});

			await expect(transmuxFile("input.mkv", "output.mp4")).rejects.toThrow("Transmux failed");
		});
	});

	describe("probeFile", () => {
		it("should probe file metadata", async () => {
			const mockMetadata = {
				format: { duration: 100 },
				streams: [
					{ codec_type: "video", codec_name: "h264" },
					{ codec_type: "audio", codec_name: "aac", channels: 2 },
				],
			};

			mockFfmpegConstructor.ffprobe.mockImplementation(
				(_path: string, callback: (err: Error | null, data?: unknown) => void) => {
					callback(null, mockMetadata);
				}
			);

			const result = await probeFile("movie.mp4");

			expect(result).toEqual({
				videoCodec: "h264",
				audioCodec: "aac",
				duration: 100,
				audioChannels: 2,
				hasDataStreams: false,
				videoHeight: null,
				pixelFormat: null,
			});
		});

		it("should handle probe errors", async () => {
			mockFfmpegConstructor.ffprobe.mockImplementation(
				(_path: string, callback: (err: Error | null, data?: unknown) => void) => {
					callback(new Error("Probe failed"));
				}
			);

			await expect(probeFile("movie.mp4")).rejects.toThrow("Probe failed");
		});
	});

	describe("normalizeFileForPlayback", () => {
		it.each([
			["h264", "aac", 2, "copy", "copy"],
			["h264", "mp3", 1, "copy", "copy"],
			["h264", "aac", 6, "copy", "aac"],
			["h264", "aac", 0, "copy", "aac"],
			["h264", "ac3", 6, "copy", "aac"],
			["h264", "dts", 2, "copy", "aac"],
			["vp9", "opus", 2, "copy", "aac"],
			["h264", "vorbis", 2, "copy", "aac"],
			["hevc", "aac", 2, "libx264", "copy"],
			["hevc", "eac3", 6, "libx264", "aac"],
			["h264", null, 0, "copy", "aac"],
		])("normalizes %s/%s (%i channels) using video=%s, audio=%s", async (videoCodec, audioCodec, channels, videoEncoder, audioEncoder) => {
			mockCodecs(videoCodec, audioCodec, channels);
			await normalizeFileForPlayback("input.mkv", "output.mp4");

			const options = mockFfmpegCommand.outputOptions.mock.calls.flat(2);
			expect(options[options.indexOf("-c:v") + 1]).toBe(videoEncoder);
			expect(options[options.indexOf("-c:a") + 1]).toBe(audioEncoder);
			if (audioEncoder === "copy") {
				expect(options).not.toContain("-ac");
				expect(options).not.toContain("-b:a");
			} else {
				expect(options[options.indexOf("-ac") + 1]).toBe("2");
			}
			if (videoEncoder === "copy") {
				expect(options).not.toContain("-preset");
				expect(options).not.toContain("-pix_fmt");
			}
		});

		it("reports only finite progress clamped from 0 to 1", async () => {
			mockFfmpegConstructor.ffprobe.mockImplementation(
				(_path: string, callback: (err: Error | null, data?: unknown) => void) => {
					callback(null, {
						format: { duration: 100 },
						streams: [
							{ codec_type: "video", codec_name: "h264" },
							{ codec_type: "audio", codec_name: "aac", channels: 2 },
						],
					});
				}
			);
			mockFfmpegCommand.on.mockImplementation((event, callback) => {
				if (event === "progress") {
					callback({ percent: undefined });
					callback({ percent: Number.NaN });
					callback({ percent: -10 });
					callback({ percent: 50 });
					callback({ percent: 120 });
				} else if (event === "end") {
					queueMicrotask(callback);
				}
				return mockFfmpegCommand;
			});
			const onProgress = vi.fn();

			await normalizeFileForPlayback("input.mkv", "output.mp4", onProgress);

			expect(onProgress.mock.calls).toEqual([[0], [0.5], [1]]);
		});
	});

	describe("getPlaybackCompatibility", () => {
		it("ignores embedded mp4 text subtitle data tracks", async () => {
			mockFfmpegConstructor.ffprobe.mockImplementation(
				(_path: string, callback: (err: Error | null, data?: unknown) => void) => {
					callback(null, {
						format: { duration: 100 },
						streams: [
							{ codec_type: "video", codec_name: "h264" },
							{ codec_type: "audio", codec_name: "aac", channels: 2 },
							{
								codec_type: "data",
								codec_name: "bin_data",
								codec_tag_string: "text",
								tags: { handler_name: "SubtitleHandler" },
							},
						],
					});
				}
			);

			const result = await getPlaybackCompatibility("movie.mp4");

			expect(result.requiresNormalization).toBe(false);
		});
	});
});
