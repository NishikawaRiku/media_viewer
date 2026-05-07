import express from "express";
import path from "path";
import fs from "fs-extra";
import os from "os";
import dns from "dns/promises";
import open from "open";
import crypto from "crypto";
import sharp from "sharp";
import qrcode from "qrcode";
import archiver from "archiver";
import ffmpeg from "@ts-ffmpeg/fluent-ffmpeg";
import ffmpegPath from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";
import { fileURLToPath } from "url";
import { execSync } from "child_process";

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobeStatic.path);

const app = express();
const PORT = process.env.PORT || 3080;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOGS_DIR = path.join(__dirname, "logs");
fs.ensureDirSync(LOGS_DIR);

function getClientIp(req) {
	const xff = req.headers["x-forwarded-for"];
	if (xff) return xff.split(",")[0].trim();
	return (req.ip || req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
}

function formatLogTimestamp(date = new Date()) {
	const pad = (n, w = 2) => String(n).padStart(w, "0");
	return `${date.getFullYear()}/${pad(date.getMonth()+1)}/${pad(date.getDate())} ` + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

function getAccessLogPath(date = new Date()) {
	const pad = (n) => String(n).padStart(2, "0");
	return path.join(LOGS_DIR, `${date.getFullYear()}_${pad(date.getMonth()+1)}_${pad(date.getDate())}.log`);
}

function formatBytes(bytes) {
	if (bytes >= 1024**3) return `${(bytes/1024**3).toFixed(1)}GB`;
	if (bytes >= 1024**2) return `${(bytes/1024**2).toFixed(1)}MB`;
	if (bytes >= 1024)    return `${(bytes/1024).toFixed(1)}KB`;
	return `${bytes || 0}B`;
}

function errorCodeToJa(err) {
	const code = err?.code;
	if (code === "EBUSY")  return "ファイルロック中 (EBUSY)";
	if (code === "EACCES") return "アクセス権限なし (EACCES)";
	if (code === "ENOSPC") return "ディスク容量不足 (ENOSPC)";
	if (code === "ENOENT") return "ファイル不在 (ENOENT)";
	return err?.message || String(err);
}

function safeDecodeUrl(url) {
	try { return decodeURIComponent(url); }
	catch { return url; }
}

function writeAccessLog(level, ip, method, url, status, durationMs, info) {
	const reqLine = `"${method} ${safeDecodeUrl(url)}"`;
	const infoStr = info ? ` ${info}` : "";
	const line = `[${formatLogTimestamp()}] ${level} <${ip}> ${reqLine} -> ${status} (${durationMs}ms)${infoStr}`;
	fs.appendFile(getAccessLogPath(), line + "\n", () => {});
	const colors = { INFO: "\x1b[37m", WARN: "\x1b[33m", ERROR: "\x1b[31m" };
	const color = colors[level] || colors.INFO;
	console.log(`${color}${line}\x1b[0m`);
}

const loginFailCounts = new Map();

app.use((req, res, next) => {
	const start = Date.now();
	let logged = false;
	const doLog = () => {
		if (logged) return;
		logged = true;
		const ip = getClientIp(req);
		const status = res.statusCode;
		const duration = Date.now() - start;
		let info = res.locals.logInfo;
		if (info === undefined) {
			if (/\.(jpe?g|png|webp|mp4|mov|gif|webm|ico)$/i.test(req.originalUrl.split("?")[0]) && (status === 200 || status === 206)) {
				const cl = res.get("Content-Length");
				if (cl) {
					const size = formatBytes(parseInt(cl));
					info = status === 206 ? `size=${size}（部分取得）` : `size=${size}`;
				}
			}
			if (info === undefined) info = "";
		}
		const level = res.locals.logLevel || (status >= 500 ? "ERROR" : "INFO");
		writeAccessLog(level, ip, req.method, req.originalUrl, status, duration, info);
	};
	res.on("finish", () => setImmediate(doLog));
	res.on("close",  () => setImmediate(doLog));
	next();
});

const _config = (() => {
	try { return JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8")); }
	catch { return {}; }
})();
let TAILNET_DOMAIN = "";

const PASSWORD = (process.argv[2] || "").trim();
const AUTH_TOKEN = PASSWORD ? crypto.createHash("sha256").update(PASSWORD + crypto.randomBytes(16).toString("hex")).digest("hex") : null;

if (AUTH_TOKEN) {
	app.use(express.urlencoded({ extended: false }));
	app.get("/login", (req, res) => {
		if (isAuthenticated(req) && parseCookies(req)["auth_saved"] === "1") {
			res.locals.logInfo = "認証済";
			return res.redirect("/");
		}
		res.sendFile(path.join(PUBLIC_DIR, "login.html"));
	});
	app.post("/login", (req, res) => {
		const ip = getClientIp(req);
		if ((req.body.password || "").trim() === PASSWORD) {
			loginFailCounts.delete(ip);
			const isRemember = req.body.save === "on";
			res.locals.logInfo = `認証成功 save=${isRemember}`;
			if (isRemember) {
				res.setHeader("Set-Cookie", [
					`auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`,
					`auth_saved=1; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
				]);
			} else {
				res.setHeader("Set-Cookie", [
					`auth=${AUTH_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
					`auth_saved=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
				]);
			}
			res.redirect("/");
		} else {
			const count = (loginFailCounts.get(ip) || 0) + 1;
			loginFailCounts.set(ip, count);
			res.locals.logLevel = "WARN";
			res.locals.logInfo  = `認証失敗 count=${count}`;
			res.redirect("/login?error=true");
		}
	});
	app.use((req, res, next) => {
		if (isAuthenticated(req)) return next();
		if (req.path === "/login") return next();
		if (req.path === "/favicon.ico") return next();
		const cookies = parseCookies(req);
		if (cookies["auth"] || cookies["auth_saved"]) {
			res.setHeader("Set-Cookie", [
				`auth=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`,
				`auth_saved=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`
			]);
			res.locals.logInfo = "クッキー失効";
		} else {
			res.locals.logInfo = "未認証";
		}
		res.redirect("/login");
	});
}

function isAuthenticated(req) { return parseCookies(req)["auth"] === AUTH_TOKEN; }
function parseCookies(req) {
	const cookies = {};
	(req.headers.cookie || "").split(";").forEach(c => {
		const [k, ...v] = c.trim().split("=");
		if (k) cookies[k.trim()] = v.join("=").trim();
	});
	return cookies;
}

const PUBLIC_DIR = path.join(__dirname, "public");
const THUMBS_DIR = path.join(PUBLIC_DIR, ".thumbs");
const IMAGE_DIR = path.join(THUMBS_DIR, "image");
const VIDEO_DIR = path.join(THUMBS_DIR, "video");

app.use(express.static(PUBLIC_DIR));
app.use("/.thumbs", express.static(THUMBS_DIR));
if (process.platform === "win32") {
  execSync(`attrib +h "${THUMBS_DIR}"`);
}
fs.ensureDirSync(IMAGE_DIR);
fs.ensureDirSync(VIDEO_DIR);

app.get("/", (req, res) => res.sendFile(path.join(PUBLIC_DIR, "index.html")));
app.get("/api/ip", (req, res) => {
	if (TAILNET_DOMAIN) {
		res.json({ ip: TAILNET_DOMAIN, port: 443 });
	} else {
		res.json({ ip: getIPAddress(), port: PORT });
	}
});
app.get("/api/qr", async (req, res) => {
  try {
    const baseUrl = TAILNET_DOMAIN ? `https://${TAILNET_DOMAIN}` : `http://${getIPAddress()}:${PORT}`;
    const link = `${baseUrl}/`;
    const code = "/.thumbs/qr_code_image.webp";
    res.json({ link, code });
  } catch (err) {
    res.locals.logLevel = "ERROR";
    res.locals.logInfo  = "QRコード情報取得失敗";
    log("ERROR", `QRコード情報取得失敗: ${err.message}`);
    res.status(500).json({ error: "QRコード情報の取得に失敗しました" });
  }
});

function getIPAddress() {
	const nets = os.networkInterfaces();
	const candidates = [];
	for (const name of Object.keys(nets)) {
		for (const net of nets[name]) {
			if (net.family !== "IPv4" || net.internal) continue;
			const [a, b] = net.address.split(".").map(Number);
			if (a === 100 && b >= 64 && b <= 127) continue;
			candidates.push(net.address);
		}
	}
	const lan = candidates.find(ip => /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip));
	return lan || candidates[0] || "localhost";
}

async function resolveTailnetDomain() {
	const raw = _config.tailnetDomain;
	if (typeof raw !== "string") return "";
	const domain = raw.trim();
	if (!domain) return "";
	try {
		await Promise.race([
			dns.lookup(domain),
			new Promise((_, reject) => setTimeout(() => reject(new Error("DNS lookup timeout")), 2000))
		]);
		return domain;
	} catch {
		log("WARN", `Tailnetドメイン「${domain}」の名前解決に失敗しました。`);
		return "";
	}
}

app.get("/api/directories", async (req,res) => {
	try {
		const entries = await fs.readdir(PUBLIC_DIR, { withFileTypes: true });
		const directories = [];
		for (const dir of entries) {
			if(!dir.isDirectory() || dir.name===".thumbs") continue;
			const dirPath = path.join(PUBLIC_DIR, dir.name);
			const files = (await fs.readdir(dirPath)).filter(f=>/\.(jpe?g|png|webp|mp4|mov|gif|webm)$/i.test(f));
			if(!files.length) continue;
			const stats = await Promise.all(files.map(f => fs.stat(path.join(dirPath, f))));
			const size = stats.reduce((sum, s) => sum + s.size, 0);
			directories.push({ name: dir.name, size });
		}
		res.locals.logInfo = `total=${directories.length}件`;
		res.json({directories});
	} catch(err) {
		res.locals.logLevel = "ERROR";
		res.locals.logInfo  = errorCodeToJa(err);
		log("ERROR", `ディレクトリ一覧取得失敗: ${err.message}`);
		res.status(500).json({ error:"ディレクトリ一覧取得に失敗しました" });
	}
});

app.get("/api/directory/:directory", async (req,res) => {
	const directory = req.params.directory;
	const filter    = req.query.filter;
	const sort      = req.query.sort;
	const order     = req.query.order;
	const index     = Math.max(0, parseInt(req.query.index) || 0);
	const limit     = Math.min(1000, Math.max(1, parseInt(req.query.limit) || 100));
	try {
		const dirPath = path.join(PUBLIC_DIR, directory);
		if (!await fs.pathExists(dirPath) || !(await fs.stat(dirPath)).isDirectory()) {
			res.locals.logInfo = "ディレクトリ不在";
			return res.status(404).json({ error: "ディレクトリが存在しません" });
		}

		const allFiles = (await fs.readdir(dirPath)).filter(f => /\.(jpe?g|png|webp|mp4|mov|gif|webm)$/i.test(f));
		if (!allFiles.length) {
			res.locals.logInfo = "空ディレクトリ";
			return res.status(404).json({ error: "ディレクトリが空です" });
		}

		const totalCount = allFiles.length;
		const imageCount = allFiles.filter(f => /\.(jpe?g|png|webp)$/i.test(f)).length;
		const videoCount = allFiles.filter(f => /\.(mp4|mov|gif|webm)$/i.test(f)).length;

		let filteredFiles = allFiles;
		if (filter === "image") {
			filteredFiles = allFiles.filter(f => /\.(jpe?g|png|webp)$/i.test(f));
		} else if (filter === "video") {
			filteredFiles = allFiles.filter(f => /\.(mp4|mov|gif|webm)$/i.test(f));
		}
		if (sort === "time") {
			const mtimes = await Promise.all(filteredFiles.map(f => fs.stat(path.join(dirPath, f)).then(s => s.mtimeMs)));
			filteredFiles = filteredFiles.map((f, i) => ({ f, mtime: mtimes[i] })).sort((a, b) => a.mtime - b.mtime).map(({ f }) => f);
		} else {
			filteredFiles = filteredFiles.slice().sort((a, b) => a.localeCompare(b));
		}
		if (order === "desc") filteredFiles.reverse();

		const pagedFiles = filteredFiles.slice(index, index + limit);

		const filesData = await Promise.all(pagedFiles.map(async f => {
			const ext = path.extname(f).toLowerCase();
			const baseName = path.parse(f).name;
			const isVideoFile = /\.(mp4|mov|gif|webm)$/i.test(ext);
			const thumbPath = isVideoFile
				? "/" + path.join(".thumbs/video", `${directory}_${baseName}.webm`).replace(/\\/g,"/")
				: /\.(jpe?g|png|webp)$/i.test(ext)
					? "/" + path.join(".thumbs/image", `${directory}_${baseName}.webp`).replace(/\\/g,"/")
					: path.join(directory,f).replace(/\\/g,"/");

			const absThumb = path.join(PUBLIC_DIR, thumbPath);
			const defaultThumb = isVideoFile ? "/.thumbs/no_video_thumbnail.webp" : "/.thumbs/no_image_thumbnail.webp";
			const thumbnail = await fs.pathExists(absThumb) ? thumbPath : defaultThumb;
			return { original: "/" + path.join(directory,f).replace(/\\/g,"/"), thumbnail };
		}));

		const hasMore = index + limit < filteredFiles.length;

		res.locals.logInfo = hasMore ? `items=${filesData.length}件` : `items=${filesData.length}件（次ページなし）`;
		res.json({ files: filesData, totalCount, imageCount, videoCount, hasMore });
	} catch(err) {
		res.locals.logLevel = "ERROR";
		res.locals.logInfo  = errorCodeToJa(err);
		log("ERROR", `「${directory}」ディレクトリのメディア読み込み失敗: ${err.message}`);
		res.status(500).json({ error: "メディアファイル読み込みに失敗しました" });
	}
});

app.get("/api/download", async (req, res) => {
	try {
		const dirsParam = req.query.dirs || "";
		const requestedDirs = dirsParam.split(",").map(s => s.trim()).filter(Boolean);
		if (!requestedDirs.length) {
			res.locals.logInfo = "ディレクトリ未指定";
			return res.status(400).json({ error: "ディレクトリが指定されていません" });
		}

		if (requestedDirs.some(d => d.includes(".."))) {
			res.locals.logLevel = "WARN";
			res.locals.logInfo  = "パストラバーサル試行";
			return res.status(400).json({ error: "不正なディレクトリ名です" });
		}

		const hasReservedAccess = requestedDirs.some(d => d === ".thumbs");

		const validDirs = [];
		for (const dirName of requestedDirs) {
			if (dirName.includes("/") || dirName.includes("\\") || dirName === ".thumbs") continue;
			const dirPath = path.join(PUBLIC_DIR, dirName);
			if (!await fs.pathExists(dirPath) || !(await fs.stat(dirPath)).isDirectory()) continue;
			validDirs.push(dirName);
		}
		if (!validDirs.length) {
			if (hasReservedAccess) res.locals.logLevel = "WARN";
			res.locals.logInfo = "有効ディレクトリなし";
			return res.status(404).json({ error: "有効なディレクトリがありません" });
		}

		let totalSize = 0;
		const dirFileMap = new Map();
		for (const dirName of validDirs) {
			const dirPath = path.join(PUBLIC_DIR, dirName);
			const files = (await fs.readdir(dirPath)).filter(f => /\.(jpe?g|png|webp|mp4|mov|gif|webm)$/i.test(f));
			dirFileMap.set(dirName, files);
			const stats = await Promise.all(files.map(f => fs.stat(path.join(dirPath, f))));
			totalSize += stats.reduce((sum, s) => sum + s.size, 0);
		}

		const date = new Date();
		const timestamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2,'0')}${String(date.getDate()).padStart(2,'0')}_${String(date.getHours()).padStart(2,'0')}${String(date.getMinutes()).padStart(2,'0')}${String(date.getSeconds()).padStart(2,'0')}`;
		const filename = `media_viewer_${timestamp}.zip`;

		res.setHeader("Content-Type", "application/zip");
		res.setHeader("Content-Disposition", `attachment; filename="${filename}"; filename*=UTF-8''${encodeURIComponent(filename)}`);

		let bytesSent = 0;
		const originalWrite = res.write.bind(res);
		res.write = function(chunk, ...args) {
			if (chunk) bytesSent += Buffer.byteLength(chunk);
			return originalWrite(chunk, ...args);
		};

		const archive = archiver("zip", { store: true });
		archive.on("error", (err) => {
			res.locals.logLevel = "ERROR";
			res.locals.logInfo  = errorCodeToJa(err);
			log("ERROR", `ZIP生成エラー: ${err.message}`);
			if (!res.headersSent) res.status(500).end();
		});
		res.on("close", () => {
			if (!res.writableEnded) {
				res.locals.logLevel = "WARN";
				res.locals.logInfo  = `total=${validDirs.length}件/size=${formatBytes(bytesSent)}/${formatBytes(totalSize)}（中断）`;
				archive.abort();
			}
		});
		archive.pipe(res);

		for (const [dirName, files] of dirFileMap) {
			const dirPath = path.join(PUBLIC_DIR, dirName);
			for (const file of files) archive.file(path.join(dirPath, file), { name: `${dirName}/${file}` });
		}

		await archive.finalize();
		if (res.writableEnded || !res.locals.logInfo) {
			res.locals.logInfo = `total=${validDirs.length}件/size=${formatBytes(bytesSent)}`;
		}
		log("INFO", `ZIPダウンロード: ${filename} (${validDirs.length}件 / ${validDirs.join(", ")})`);
	} catch (err) {
		res.locals.logLevel = "ERROR";
		res.locals.logInfo  = errorCodeToJa(err);
		log("ERROR", `ZIPダウンロード失敗: ${err.message}`);
		if (!res.headersSent) res.status(500).json({ error: "ZIPダウンロードに失敗しました" });
	}
});

async function generateAllThumbnails() {
	await generateFaviconImage();
    await generateqrcodeImage();
	await generateDummyImage();
	await generateNoImageThumbnail();
	await generateNoVideoThumbnail();
	const entries = (await fs.readdir(PUBLIC_DIR, { withFileTypes: true })).filter(d => d.isDirectory() && d.name !== ".thumbs");
	const dirsToProcess = [];
	for (const dir of entries) {
		const files = (await fs.readdir(path.join(PUBLIC_DIR, dir.name))).filter(f => /\.(jpe?g|png|webp|mp4|mov|gif|webm)$/i.test(f));
		if (!files.length) continue;
		let needsProcessing = false;
		for (const file of files) {
			const ext = path.extname(file).toLowerCase();
			const baseName = path.parse(file).name;
			if (/\.(mp4|mov|gif|webm)$/i.test(ext)) {
				const videoPrevlewPath   = path.join(VIDEO_DIR, `${dir.name}_${baseName}.webm`);
				if (!await fs.pathExists(videoPrevlewPath)) { needsProcessing = true; break; }
				const videoThumbPath = path.join(VIDEO_DIR, `${dir.name}_${baseName}.webp`);
				if (!await fs.pathExists(videoThumbPath)) { needsProcessing = true; break; }
			} else {
				const webpPath = path.join(IMAGE_DIR, `${dir.name}_${baseName}.webp`);
				if (!await fs.pathExists(webpPath)) { needsProcessing = true; break; }
			}
		}
		if (needsProcessing) dirsToProcess.push(dir);
	}
	for (let i = 0; i < dirsToProcess.length; i++) await generateThumbnailsForDir(dirsToProcess[i].name, i + 1, dirsToProcess.length);
}

async function generateFaviconImage() {
	const faviconPath = path.join(PUBLIC_DIR, "favicon.ico");
	if (await fs.pathExists(faviconPath)) return false;
	await printSeparatorOnce();
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 32 32"><rect x="4" y="4" width="11" height="14" rx="1.5" fill="#0288d1"/><rect x="17" y="4" width="11" height="9" rx="1.5" fill="#4fc3f7"/><rect x="4" y="20" width="11" height="8" rx="1.5" fill="#4fc3f7"/><rect x="17" y="15" width="11" height="13" rx="1.5" fill="#0288d1"/></svg>`;
	const sizes = [16, 32, 48, 256];
	const pngBuffers = await Promise.all(sizes.map(size => sharp(Buffer.from(svg)).resize(size, size).png().toBuffer()));
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0);
	header.writeUInt16LE(1, 2);
	header.writeUInt16LE(sizes.length, 4);
	const entries = Buffer.alloc(16 * sizes.length);
	let offset = 6 + 16 * sizes.length;
	for (let i = 0; i < sizes.length; i++) {
		const size = sizes[i];
		const buf = pngBuffers[i];
		const entryOffset = i * 16;
		entries.writeUInt8(size >= 256 ? 0 : size, entryOffset);
		entries.writeUInt8(size >= 256 ? 0 : size, entryOffset + 1);
		entries.writeUInt8(0, entryOffset + 2);
		entries.writeUInt8(0, entryOffset + 3);
		entries.writeUInt16LE(1, entryOffset + 4);
		entries.writeUInt16LE(32, entryOffset + 6);
		entries.writeUInt32LE(buf.length, entryOffset + 8);
		entries.writeUInt32LE(offset, entryOffset + 12);
		offset += buf.length;
	}
	await fs.writeFile(faviconPath, Buffer.concat([header, entries, ...pngBuffers]));
	log("INFO", "「favicon.ico」を生成完了");
	return true;
}

async function generateqrcodeImage(overrideUrl = null) {
	const qrcodePath = path.join(THUMBS_DIR, "qr_code_image.webp");
	if (!overrideUrl) await printSeparatorOnce();
	const url = overrideUrl || (TAILNET_DOMAIN ? `https://${TAILNET_DOMAIN}` : `http://${getIPAddress()}:${PORT}`);
	const dataUrl = await qrcode.toDataURL(url, { width: 320, margin: 2 });
	await sharp(Buffer.from(dataUrl.split(",")[1], "base64")).webp().toFile(qrcodePath);
	if (!overrideUrl) log("INFO", "「qr_code_image.webp」を生成完了");
	return true;
}

async function generateDummyImage() {
	const dummyPath = path.join(THUMBS_DIR, "dummy_image.webp");
	if (await fs.pathExists(dummyPath)) return false;
	await printSeparatorOnce();
	await sharp({ create: { width: 1, height: 1, channels: 4, background: { r:0,g:0,b:0,alpha:0 } } }).webp().toFile(dummyPath);
	log("INFO", "「dummy_image.webp」を生成完了");
	return true;
}

async function generateNoImageThumbnail() {
	const noImagePath = path.join(THUMBS_DIR, "no_image_thumbnail.webp");
	if (await fs.pathExists(noImagePath)) return false;
	await printSeparatorOnce();
	const svg = `<svg width="320" height="320"><rect width="100%" height="100%" fill="rgb(128,128,128)" /><text x="50%" y="50%" font-size="24" fill="white" font-family="Arial, sans-serif" text-anchor="middle" dominant-baseline="middle">No Image Thumbnail</text></svg>`;
	await sharp(Buffer.from(svg)).toFormat("webp").toFile(noImagePath);
	log("INFO", "「no_image_thumbnail.webp」を生成完了");
	return true;
}

async function generateNoVideoThumbnail() {
	const noVideoPath = path.join(THUMBS_DIR, "no_video_thumbnail.webp");
	if (await fs.pathExists(noVideoPath)) return false;
	await printSeparatorOnce();
	const svg = `<svg width="320" height="320"><rect width="100%" height="100%" fill="rgb(128,128,128)" /><text x="50%" y="50%" font-size="24" fill="white" font-family="Arial, sans-serif" text-anchor="middle" dominant-baseline="middle">No Video Thumbnail</text></svg>`;
	await sharp(Buffer.from(svg)).toFormat("webp").toFile(noVideoPath);
	log("INFO", "「no_video_thumbnail.webp」を生成完了");
	return true;
}

async function generateThumbnailsForDir(dirName, index, total) {
	const dirPath = path.join(PUBLIC_DIR, dirName);
	const files = (await fs.readdir(dirPath)).filter(f => /\.(jpe?g|png|webp|mp4|mov|gif|webm)$/i.test(f));
	if (!files.length) return;
	const imageThumbTasks = [], videoPreviewTasks = [], videoThumbTasks = [];
	for (const file of files) {
		const ext = path.extname(file).toLowerCase();
		const baseName = path.parse(file).name;
		const fullPath = path.join(dirPath, file);
		if (/\.(mp4|mov|gif|webm)$/i.test(ext)) {
			const videoThumbPath = path.join(VIDEO_DIR, `${dirName}_${baseName}.webp`);
			const videoPrevlewPath   = path.join(VIDEO_DIR, `${dirName}_${baseName}.webm`);
			if (!await fs.pathExists(videoThumbPath)) videoThumbTasks.push({ videoPath: fullPath, videoThumbPath });
			if (!await fs.pathExists(videoPrevlewPath))   videoPreviewTasks.push({ videoPath: fullPath, videoPrevlewPath });
		} else {
			const webpPath = path.join(IMAGE_DIR, `${dirName}_${baseName}.webp`);
			if (!await fs.pathExists(webpPath)) imageThumbTasks.push({ imagePath: fullPath, webpPath });
		}
	}
	if (!imageThumbTasks.length && !videoThumbTasks.length && !videoPreviewTasks.length) return;
	logSeparator();
	log("INFO", `「${dirName}」(${index} / ${total}) `);
	const BATCH_SIZE = Math.max(os.cpus().length, 4);

	if (imageThumbTasks.length) {
		console.log();
		const start = Date.now();
		const date = new Date();
		const timestamp = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')} `
						+ `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}.${String(date.getMilliseconds()).padStart(3,'0')}`;
		console.log(`[${timestamp}] INFO 画像サムネイル 生成開始（全 ${imageThumbTasks.length} 件）`);
		const linesUp = await processInBatches(imageThumbTasks, BATCH_SIZE, async ({ imagePath, webpPath }) => generateImageThumbnail(imagePath, webpPath));
		const elapsed = ((Date.now() - start) / 1000).toFixed(1);
		process.stdout.write(`\x1b[${linesUp}A\r\x1b[2K[${timestamp}] INFO 画像サムネイル 生成完了（約 ${elapsed} 秒）\x1b[${linesUp}B\r`);
	}

	if (videoThumbTasks.length) {
		if (!imageThumbTasks.length) console.log();
		const start = Date.now();
		const date = new Date();
		const timestamp = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')} `
						+ `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}.${String(date.getMilliseconds()).padStart(3,'0')}`;
		console.log(`[${timestamp}] INFO 動画サムネイル 生成開始（全 ${videoThumbTasks.length} 件）`);
		const linesUp = await processInBatches(videoThumbTasks, BATCH_SIZE, async ({ videoPath, videoThumbPath }) => generateVideoThumbnail(videoPath, videoThumbPath));
		const elapsed = ((Date.now() - start) / 1000).toFixed(1);
		process.stdout.write(`\x1b[${linesUp}A\r\x1b[2K[${timestamp}] INFO 動画サムネイル 生成完了（約 ${elapsed} 秒）\x1b[${linesUp}B\r`);
	}
	if (videoPreviewTasks.length) {
		if (!imageThumbTasks.length && !videoThumbTasks.length) console.log();
		const start = Date.now();
		const date = new Date();
		const timestamp = `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')} `
						+ `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}.${String(date.getMilliseconds()).padStart(3,'0')}`;
		console.log(`[${timestamp}] INFO 動画プレビュー 生成開始（全 ${videoPreviewTasks.length} 件）`);
		const linesUp = await processInBatches(videoPreviewTasks, BATCH_SIZE, async ({ videoPath, videoPrevlewPath }) => generateVideoPreview(videoPath, videoPrevlewPath));
		const elapsed = ((Date.now() - start) / 1000).toFixed(1);
		process.stdout.write(`\x1b[${linesUp}A\r\x1b[2K[${timestamp}] INFO 動画プレビュー 生成完了（約 ${elapsed} 秒）\x1b[${linesUp}B\r`);
	}
}

function shortenError(msg) {
	if (!msg) return "";
	const lines = msg.split("\n").map(l => l.trim()).filter(l => l.length > 0);
	const cleaned = lines.filter(l => {
		if (/^ffprobe version /.test(l)) return false;
		if (/^built with /.test(l)) return false;
		if (/^configuration:/.test(l)) return false;
		if (/^--enable-/.test(l)) return false;
		if (/^lib(av|sw|post)/.test(l)) return false;
		return true;
	});
	let result = cleaned.length ? cleaned[cleaned.length - 1] : (lines[0] || msg);
	result = result.replace(/^[A-Za-z]:[\\/][^:]*:\s*/, "").replace(/^\/[^:]*:\s*/, "");
	return result;
}

async function generateImageThumbnail(imagePath, webpPath) {
	if (await fs.pathExists(webpPath)) return null;
	try {
		await sharp(imagePath).rotate().resize({ width: 320 }).webp().toFile(webpPath);
		return null;
	}
	catch(err) { return `${shortenError(err.message)} (${imagePath})`; }
}

async function generateVideoThumbnail(videoPath, videoThumbPath) {
	if (await fs.pathExists(videoThumbPath)) return null;
	try {
		const stream = await getVideoStream(videoPath);
		const { base, transpose } = getVideoVf(stream);
		const vf = `${base}${transpose}`;
		await new Promise((resolve, reject) => {
			ffmpeg(videoPath)
				.inputOptions(['-noautorotate', '-display_rotation:v 0'])
				.setStartTime(0)
				.outputOptions([`-vf ${vf}`, '-frames:v', '1', '-an'])
				.toFormat('webp')
				.on('end', resolve)
				.on('error', async (err) => {
					if (await fs.pathExists(videoThumbPath)) await fs.remove(videoThumbPath);
					reject(err);
				})
				.save(videoThumbPath);
		});
		return null;
	} catch (err) {
		return `${shortenError(err.message)} (${videoPath})`;
	}
}

async function generateVideoPreview(videoPath, videoPrevlewPath) {
	if (await fs.pathExists(videoPrevlewPath)) return null;
	try {
		const stream = await getVideoStream(videoPath);
		const { base, transpose } = getVideoVf(stream);
		const vf = `${base},fps=15${transpose}`;
		const duration = 3;
		await new Promise((resolve, reject) => {
			ffmpeg(videoPath)
				.inputOptions(['-noautorotate', '-display_rotation:v 0'])
				.setStartTime(0)
				.duration(duration)
				.outputOptions([`-vf ${vf}`, '-c:v libvpx-vp9', '-b:v 0', '-crf 33', '-an'])
				.toFormat('webm')
				.on('end', resolve)
				.on('error', async (err) => {
					if (await fs.pathExists(videoPrevlewPath)) await fs.remove(videoPrevlewPath);
					reject(err);
				})
				.save(videoPrevlewPath);
		});
		return null;
	} catch (err) {
		return `${shortenError(err.message)} (${videoPath})`;
	}
}

async function getVideoStream(videoPath) {
	const metadata = await new Promise((resolve, reject) => {
		ffmpeg.ffprobe(videoPath, (err, data) => err ? reject(err) : resolve(data));
	});
	const stream = metadata.streams.find(s => s.codec_type === "video");
	if (!stream) throw new Error("No video stream found");
	return stream;
}

function getVideoVf(stream) {
	const width  = stream.width;
	const height = stream.height;
	let rotation = 0;
	if (stream.tags?.rotate) {
		rotation = parseInt(stream.tags.rotate);
	} else {
		const displayMatrix = stream.side_data_list?.find(
			s => s.side_data_type === "Display Matrix"
		);
		if (displayMatrix?.rotation !== undefined) {
			rotation = Math.round(-displayMatrix.rotation);
		} else if (typeof stream.rotation === "number") {
			rotation = Math.round(-stream.rotation);
		}
	}

	const absRotation = ((rotation % 360) + 360) % 360;
	if (absRotation === 90 || absRotation === 270) {
		const displayScaleWidth = Math.min(height, 480);
		const transposeDir      = absRotation === 90 ? 1 : 2;
		return { base: `scale=-2:${displayScaleWidth}:flags=bilinear`, transpose: `,transpose=${transposeDir}` };
	} else if (absRotation === 180) {
		const scaleWidth = Math.min(width, 480);
		return { base: `scale=${scaleWidth}:-2:flags=bilinear`, transpose: `,hflip,vflip` };
	} else {
		const scaleWidth = Math.min(width, 480);
		return { base: `scale=${scaleWidth}:-2:flags=bilinear`, transpose: `` };
	}
}

function log(level, message, overwrite = false, persist = false) {
	const date = new Date();
	const timestamp = formatLogTimestamp(date);
	const prefix = { INFO: "INFO ", WARN: "WARN ", ERROR: "ERROR " }[level] || "";
	const colors = { INFO: "\x1b[37m", WARN: "\x1b[33m", ERROR: "\x1b[31m", RESET: "\x1b[0m" };
	const color = colors[level] || colors.INFO;
	const line = `[${timestamp}] ${prefix}${message}`;
	if (overwrite) process.stdout.write(`\r${color}${line}${colors.RESET}`);
	else console.log(`${color}${line}${colors.RESET}`);
	if (persist) {
		const fileMessage = typeof persist === "string" ? persist : message;
		const fileLine = `[${timestamp}] ${prefix}${fileMessage}`;
		fs.appendFile(getAccessLogPath(date), fileLine + "\n", () => {});
	}
}

async function processInBatches(tasks, batchSize, handler) {
	if (!tasks.length) return 0;
	let completed = 0;
	let currentErrorLine = "";
	let hasError = false;

	const getTimestamp = () => {
		const date = new Date();
		return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2,'0')}/${String(date.getDate()).padStart(2,'0')} `
			+ `${String(date.getHours()).padStart(2,'0')}:${String(date.getMinutes()).padStart(2,'0')}:${String(date.getSeconds()).padStart(2,'0')}.${String(date.getMilliseconds()).padStart(3,'0')}`;
	};

	const visualWidth = (str) => {
		const stripped = str.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
		let w = 0;
		for (const ch of stripped) {
			const code = ch.codePointAt(0);
			if ((code >= 0x1100 && code <= 0x115F) ||
				(code >= 0x2E80 && code <= 0x303E) ||
				(code >= 0x3041 && code <= 0x33FF) ||
				(code >= 0x3400 && code <= 0x4DBF) ||
				(code >= 0x4E00 && code <= 0x9FFF) ||
				(code >= 0xA000 && code <= 0xA4CF) ||
				(code >= 0xAC00 && code <= 0xD7A3) ||
				(code >= 0xF900 && code <= 0xFAFF) ||
				(code >= 0xFE30 && code <= 0xFE4F) ||
				(code >= 0xFF00 && code <= 0xFF60)) w += 2;
			else w += 1;
		}
		return w;
	};

	const errorRowsFor = (text) => {
		if (!text) return 1;
		const termW = process.stdout.columns || 120;
		return text.split("\n").reduce((sum, line) => sum + Math.max(1, Math.ceil(visualWidth(line) / termW)), 0);
	};

	const redraw = () => {
		const progressLine = `\x1b[37m[${getTimestamp()}] INFO 進捗 ${drawProgressBar(completed, tasks.length)} (${completed}/${tasks.length})\x1b[0m`;
		const rows = errorRowsFor(currentErrorLine);
		process.stdout.write(`\r\x1b[0J${progressLine}\n${currentErrorLine}\x1b[${rows}A\r`);
	};

	const wrappedHandler = async (task) => {
		const errMsg = await handler(task);
		if (errMsg) {
			currentErrorLine = `\x1b[31m[${getTimestamp()}] ERROR ${errMsg}\x1b[0m`;
			hasError = true;
			redraw();
		}
	};

	redraw();

	for (let i = 0; i < tasks.length; i += batchSize) {
		const batch = tasks.slice(i, i + batchSize);
		await Promise.all(batch.map(wrappedHandler));
		completed += batch.length;
		redraw();
	}

	if (hasError) {
		const rows = errorRowsFor(currentErrorLine);
		process.stdout.write(`\x1b[${rows + 1}B\r`);
		return rows + 2;
	} else {
		process.stdout.write(`\n`);
		return 2;
	}
}

function drawProgressBar(completed, total, width = 30) {
	const percent = completed / total;
	const filled = Math.round(width * percent);
	const bar = "#".repeat(filled) + " ".repeat(width - filled);
	const percentText = (percent * 100).toFixed(1).padStart(5, " ");
	return `[${bar}] ${percentText}%`;
}

let separatorPrinted = false;
async function printSeparatorOnce() {
	if (!separatorPrinted) {
		logSeparator();
		separatorPrinted = true;
	}
}

function logSeparator() {
	console.log("----------------------------------------------------------------------------------------------------");
}

(async () => {
	await generateAllThumbnails();
	logSeparator();
	TAILNET_DOMAIN = await resolveTailnetDomain();

	const server = app.listen(PORT, "0.0.0.0", async () => {
		const url = TAILNET_DOMAIN ? `https://${TAILNET_DOMAIN}` : `http://${getIPAddress()}:${PORT}`;
		log("INFO", `サーバー起動: ${url}（ブラウザを開きます）`, false, `サーバー起動: ${url}`);
		if (TAILNET_DOMAIN) await generateqrcodeImage(url);
		open(url).catch(() => log("WARN", "ブラウザを開けませんでした"));
	});
	server.on("error", (err) => {
		if (err.code === "EADDRINUSE") return;
		log("ERROR", err.message);
	});
})();
