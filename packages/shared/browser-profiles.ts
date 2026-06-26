import type { BrowserProfile } from "./types.ts";

export const browserProfiles: BrowserProfile[] = [
	{
		name: "chrome-windows",
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
		platform: "Win32",
		languages: ["en-US", "en"],
		viewport: { width: 1366, height: 768 },
		deviceMemory: 8,
		hardwareConcurrency: 8,
		colorDepth: 24,
		timezoneId: "America/New_York",
		webglVendor: "Google Inc. (NVIDIA)",
		webglRenderer:
			"ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)",
		secChUa:
			'"Google Chrome";v="126", "Chromium";v="126", "Not-A.Brand";v="24"',
		secChUaMobile: "?0",
		secChUaPlatform: '"Windows"',
	},
	{
		name: "firefox-linux",
		userAgent:
			"Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
		platform: "Linux x86_64",
		languages: ["en-US", "en"],
		viewport: { width: 1440, height: 900 },
		deviceMemory: 8,
		hardwareConcurrency: 6,
		colorDepth: 24,
		timezoneId: "America/Chicago",
		webglVendor: "Mesa/X.org",
		webglRenderer: "AMD Radeon RX 6700 XT",
		secChUa: '"Firefox";v="127", "Not-A.Brand";v="24"',
		secChUaMobile: "?0",
		secChUaPlatform: '"Linux"',
	},
	{
		name: "safari-macos",
		userAgent:
			"Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
		platform: "MacIntel",
		languages: ["en-US", "en"],
		viewport: { width: 1512, height: 982 },
		deviceMemory: 8,
		hardwareConcurrency: 8,
		colorDepth: 30,
		timezoneId: "America/Los_Angeles",
		webglVendor: "Apple Inc.",
		webglRenderer: "Apple M2",
		secChUa: '"Safari";v="17", "Not-A.Brand";v="24"',
		secChUaMobile: "?0",
		secChUaPlatform: '"macOS"',
	},
	{
		name: "edge-windows",
		userAgent:
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0",
		platform: "Win32",
		languages: ["en-US", "en"],
		viewport: { width: 1536, height: 864 },
		deviceMemory: 16,
		hardwareConcurrency: 12,
		colorDepth: 24,
		timezoneId: "America/New_York",
		webglVendor: "Google Inc. (Intel)",
		webglRenderer:
			"ANGLE (Intel, Intel Iris Xe Graphics Direct3D11 vs_5_0 ps_5_0, D3D11)",
		secChUa:
			'"Microsoft Edge";v="126", "Chromium";v="126", "Not-A.Brand";v="24"',
		secChUaMobile: "?0",
		secChUaPlatform: '"Windows"',
	},
	{
		name: "chrome-android",
		userAgent:
			"Mozilla/5.0 (Linux; Android 14; Pixel 8 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36",
		platform: "Linux armv81",
		languages: ["en-US", "en"],
		viewport: { width: 412, height: 915 },
		deviceMemory: 8,
		hardwareConcurrency: 8,
		colorDepth: 24,
		timezoneId: "America/New_York",
		webglVendor: "Google Inc. (Qualcomm)",
		webglRenderer: "ANGLE (Qualcomm, Adreno 740, OpenGL ES 3.2)",
		secChUa:
			'"Google Chrome";v="126", "Chromium";v="126", "Not-A.Brand";v="24"',
		secChUaMobile: "?1",
		secChUaPlatform: '"Android"',
	},
];
