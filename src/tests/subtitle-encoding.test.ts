import { describe, expect, it } from "vitest";
import { decodeSubtitle } from "$lib/server/opensubtitles";

describe("decodeSubtitle", () => {
	it("keeps UTF-8 Persian text", () => {
		const bytes = new TextEncoder().encode("سلام");
		expect(decodeSubtitle(bytes.buffer as ArrayBuffer)).toBe("سلام");
	});

	it("falls back to Windows-1256 for legacy Persian files", () => {
		// "سلام" in Windows-1256
		const bytes = new Uint8Array([0xd3, 0xe1, 0xc7, 0xe3]);
		expect(decodeSubtitle(bytes.buffer)).toBe("سلام");
	});
});
