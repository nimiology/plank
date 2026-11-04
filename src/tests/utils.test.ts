import { describe, expect, it } from "vitest";
import { cn, formatFileSize, tmdbImage } from "$lib/utils";

describe("Utils", () => {
	describe("cn (classname merger)", () => {
		it("should merge class names", () => {
			expect(cn("class1", "class2")).toBe("class1 class2");
		});

		it("should handle conditional classes", () => {
			expect(cn("class1", "class2", false)).toBe("class1 class2");
		});

		it("should result in tailwind merge behavior", () => {
			// tailwind-merge should resolve conflicts (keeps last class)
			expect(cn("p-2 p-4")).toBe("p-4");
			expect(cn("bg-blue-500 bg-red-500")).toBe("bg-red-500");
		});

		it("should handle arrays and objects", () => {
			expect(cn(["class1", "class2"])).toBe("class1 class2");
			expect(cn({ class1: true, class2: false })).toBe("class1");
		});
	});

	describe("formatFileSize", () => {
		it("should keep whole bytes below one unit", () => {
			expect(formatFileSize(0)).toBe("0 B");
			expect(formatFileSize(999)).toBe("999 B");
			expect(formatFileSize(1023)).toBe("1023 B");
		});

		it("should step up one unit at each boundary", () => {
			expect(formatFileSize(1024)).toBe("1.0 KB");
			expect(formatFileSize(1024 ** 2)).toBe("1.0 MB");
			expect(formatFileSize(1024 ** 3)).toBe("1.00 GB");
			expect(formatFileSize(1024 ** 4)).toBe("1.00 TB");
		});

		it("should stop at the largest unit", () => {
			expect(formatFileSize(1024 ** 5)).toBe("1024.00 TB");
		});

		it("should reject a byte count that is not a finite, positive number", () => {
			expect(() => formatFileSize(-1)).toThrow(/must not be negative/);
			expect(() => formatFileSize(Number.NaN)).toThrow(/must be finite/);
			expect(() => formatFileSize(Number.POSITIVE_INFINITY)).toThrow(/must be finite/);
		});
	});

	describe("tmdbImage", () => {
		it("routes TMDB images through plank and leaves others alone", () => {
			expect(tmdbImage("https://image.tmdb.org/t/p/w342/abc.jpg")).toBe("/api/tmdb-image/w342/abc.jpg");
			expect(tmdbImage("/api/images/library/x/poster.jpg")).toBe("/api/images/library/x/poster.jpg");
			expect(tmdbImage(null)).toBeNull();
		});
	});
});
