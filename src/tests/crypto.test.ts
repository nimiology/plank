import { describe, expect, it } from "vitest";
import { decrypt, encrypt } from "$lib/server/crypto";

describe("Crypto Module", () => {
	describe("encrypt / decrypt", () => {
		it("should encrypt and decrypt a string correctly", () => {
			const plaintext = "my-secret-api-key-12345";
			const encrypted = encrypt(plaintext);
			const decrypted = decrypt(encrypted);

			expect(decrypted).toBe(plaintext);
			expect(encrypted).not.toBe(plaintext);
		});

		it("should produce different ciphertexts for the same input (random IV)", () => {
			const plaintext = "same-value";
			const encrypted1 = encrypt(plaintext);
			const encrypted2 = encrypt(plaintext);

			expect(encrypted1).not.toBe(encrypted2);
			expect(decrypt(encrypted1)).toBe(plaintext);
			expect(decrypt(encrypted2)).toBe(plaintext);
		});

		it("should prefix encrypted values with enc:", () => {
			const encrypted = encrypt("test-value");
			expect(encrypted.startsWith("enc:")).toBe(true);
		});

		it("should handle empty strings", () => {
			expect(encrypt("")).toBe("");
			expect(decrypt("")).toBe("");
		});

		it("should handle unicode and special characters", () => {
			const special = 'p@$$w0rd!#%^&*()_+{}|:"<>?日本語';
			const encrypted = encrypt(special);
			const decrypted = decrypt(encrypted);

			expect(decrypted).toBe(special);
		});

		it("should handle long values", () => {
			const longValue = "a".repeat(10_000);
			const encrypted = encrypt(longValue);
			const decrypted = decrypt(encrypted);

			expect(decrypted).toBe(longValue);
		});
	});

	describe("decrypt invalid values", () => {
		it("should return empty string for null-ish input", () => {
			expect(decrypt("")).toBe("");
		});
	});

	describe("tamper detection", () => {
		it("should throw on corrupted ciphertext", () => {
			const encrypted = encrypt("test-value");
			// Change the last ciphertext byte; always to a different value, or the test passes by luck 1 in 256 times
			const lastByte = encrypted.slice(-2);
			const corrupted = `${encrypted.slice(0, -2)}${lastByte === "ff" ? "00" : "ff"}`;

			expect(() => decrypt(corrupted)).toThrow();
		});

		it("should throw on malformed encrypted value", () => {
			expect(() => decrypt("enc:bad-format")).toThrow();
		});
	});
});
