// Xozen server: API akun, panel admin, dan bot WhatsApp (Baileys). Jalankan: npm start
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import pino from "pino";
import QRCode from "qrcode";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, Browsers } from "@whiskeysockets/baileys";

const E = process.env, PORT = +E.PORT || 3000;
const DATA = path.resolve(E.DATA_DIR || "./data"), AUTH_DIR = path.join(DATA, "wa-auth");
const ADMIN_USER = E.ADMIN_USER || "admin", ADMIN_PW = E.ADMIN_PASSWORD || "";
const UP = (E.UPSTREAM_BASE || "https://bandelbanget.xyz/v1").replace(/\/$/, "");
const AI_KEY = E.AI_KEY || "", AI_MODEL = E.AI_MODEL || "deepseek-v4.1-flash", PREFIX = E.BOT_PREFIX || ".";
if (ADMIN_PW.length < 8) { console.error("Isi ADMIN_PASSWORD (minimal 8 karakter) di .env"); process.exit(1); }
const HTML = path.join(path.dirname(fileURLToPath(import.meta.url)), "xozen.html");
fs.mkdirSync(DATA, { recursive: true });

/* ---------- penyimpanan ---------- */
const UF = path.join(DATA, "users.json"), SF = path.join(DATA, "secret");
let users = {}; try { users = JSON.parse(fs.readFileSync(UF, "utf8")); } catch {}
const saveU = () => { fs.writeFileSync(UF + ".tmp", JSON.stringify(users)); fs.renameSync(UF + ".tmp", UF); };
let SECRET; try { SECRET = fs.readFileSync(SF, "utf8"); } catch { SECRET = crypto.randomBytes(32).toString("hex"); fs.writeFileSync(SF, SECRET, { mode: 0o600 }); }
const hp = (pw, salt) => crypto.scryptSync(pw, salt, 32).toString("hex");
const mkU = (username, wa, pw) => { const salt = crypto.randomBytes(16).toString("hex"); return { username, wa, salt, hash: hp(pw, salt), suspended: false, created: Date.now() }; };
const chk = (u, pw) => crypto.timingSafeEqual(Buffer.from(hp(pw, u.salt), "hex"), Buffer.from(u.hash, "hex"));
const nw = s => { s = String(s || "").replace(/\D/g, ""); return s.startsWith("0") ? "62" + s.slice(1) : s; };
const find = id => { id = String(id || "").trim(); return users[id.toLowerCase()] || Object.values(users).find(u => u.wa && u.wa === nw(id)); };
const isAdm = u => u && u.username.toLowerCase() === ADMIN_USER.toLowerCase();
{ const k = ADMIN_USER.toLowerCase(), o = users[k]; users[k] = Object.assign(mkU(ADMIN_USER, nw(E.ADMIN_WA) || (o && o.wa) || "", ADMIN_PW), o ? { created: o.created } : {}); saveU(); }

/* ---------- token & util ---------- */
const sig = p => crypto.createHmac("sha256", SECRET).update(p).digest("base64url");
const sign = n => { const p = Buffer.from(JSON.stringify({ u: n, exp: Date.now() + 48 * 36e5 })).toString("base64url"); return p + "." + sig(p); };
const verify = t => { try { const [p, s] = String(t).split("."), e = sig(p); if (s.length !== e.length || !crypto.timingSafeEqual(Buffer.from(s), Buffer.from(e))) return null; const d = JSON.parse(Buffer.from(p, "base64url")); return d.exp > Date.now() ? d.u : null; } catch { return null; } };
const session = u => ({ token: sign(u.username), user: u.username, admin: !!isAdm(u) });
const bearer = r => (r.headers.authorization || "").replace(/^Bearer\s+/i, "");
const authUser = r => { const n = verify(bearer(r)); return n && users[n.toLowerCase()]; };
const h256 = s => crypto.createHash("sha256").update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(h256(a), h256(b));
const hits = new Map(); setInterval(() => hits.clear(), 3e5).unref();
const limited = (k, n) => { const now = Date.now(), a = (hits.get(k) || []).filter(t => now - t < 6e4); a.push(now); hits.set(k, a); return a.length > n; };
const codes = new Map();
const useCode = (u, pur, c) => { const k = pur + ":" + u.username, r = codes.get(k); if (!r || r.exp < Date.now() || ++r.n > 5) { codes.delete(k); return false; } if (r.c !== String(c).trim()) return false; codes.delete(k); return true; };
const sendCode = (u, pur) => { const c = String(crypto.randomInt(100000, 1000000)); codes.set(pur + ":" + u.username, { c, exp: Date.now() + 6e5, n: 0 }); return sendWA(u.wa, `Kode verifikasi Xozen: *${c}*\nBerlaku 10 menit. Jangan bagikan kode ini ke siapa pun.`); };

/* ---------- bot WhatsApp ---------- */
const WA = { state: "stopped", me: "", qr: "", code: "", log: [], sock: null, want: false, busy: false, phone: "" };
const log = t => { WA.log.push(new Date().toLocaleTimeString("id-ID") + " " + t); if (WA.log.length > 100) WA.log.shift(); };
const view = () => ({ state: WA.state, me: WA.me, qr: WA.qr, code: WA.code, log: WA.log });
async function sendWA(num, text) {
  num = nw(num); if (!num || WA.state !== "ready" || !WA.sock) return false;
  try { await WA.sock.sendMessage(num + "@s.whatsapp.net", { text }); return true; } catch (e) { log("Gagal kirim pesan: " + e.message); return false; }
}
async function runCmd(c, a) {
  if (c === "ping") return "Pong! Bot aktif.";
  if (c === "menu" || c === "help") return `*Xozen Bot*\n${PREFIX}ping : cek bot\n${PREFIX}ai <pertanyaan> : tanya AI\n${PREFIX}menu : daftar perintah`;
  if (c === "ai") {
    if (!a) return `Contoh: ${PREFIX}ai apa itu fotosintesis?`;
    if (!AI_KEY) return "AI belum dikonfigurasi (AI_KEY kosong).";
    const r = await fetch(UP + "/chat/completions", { method: "POST", signal: AbortSignal.timeout(6e4), headers: { "Content-Type": "application/json", Authorization: "Bearer " + AI_KEY },
      body: JSON.stringify({ model: AI_MODEL, messages: [{ role: "system", content: "Kamu adalah Xozen, asisten AI di WhatsApp. Jawab ringkas dalam bahasa pengguna." }, { role: "user", content: a }] }) });
    if (!r.ok) return "AI error (" + r.status + ")";
    const j = await r.json(); return (j.choices?.[0]?.message?.content || "").trim() || "(tidak ada jawaban)";
  }
}
async function onMsg({ messages, type }) {
  if (type !== "notify") return;
  for (const m of messages) {
    const jid = m.key.remoteJid;
    if (!m.message || m.key.fromMe || !jid || jid === "status@broadcast" || jid.endsWith("@newsletter")) continue;
    const t = (m.message.conversation || m.message.extendedTextMessage?.text || "").trim();
    if (!t.startsWith(PREFIX)) continue;
    const [c, ...a] = t.slice(PREFIX.length).split(/\s+/);
    try { const r = await runCmd(c.toLowerCase(), a.join(" ")); if (r) await WA.sock.sendMessage(jid, { text: r }, { quoted: m }); } catch (e) { log("Error perintah: " + e.message); }
  }
}
async function waStart(phone) {
  if (WA.sock || WA.busy) return;
  WA.busy = true; WA.want = true; WA.phone = nw(phone); WA.qr = WA.code = ""; WA.state = "starting";
  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion().catch(() => ({}));
    const sock = makeWASocket({ version, auth: state, logger: pino({ level: "silent" }), printQRInTerminal: false, browser: Browsers.ubuntu("Xozen"), markOnlineOnConnect: false });
    WA.sock = sock;
    sock.ev.on("creds.update", saveCreds);
    sock.ev.on("messages.upsert", onMsg);
    sock.ev.on("connection.update", async u => {
      if (WA.sock !== sock) return;
      const { connection, lastDisconnect, qr } = u;
      if (qr && !state.creds.registered) {
        if (WA.phone) {
          if (!WA.code) try { const c = await sock.requestPairingCode(WA.phone); WA.code = c.slice(0, 4) + "-" + c.slice(4); WA.state = "pair"; log("Kode pairing dibuat. Masukkan di WhatsApp > Perangkat tertaut > Tautkan dengan nomor telepon."); } catch (e) { log("Gagal membuat kode pairing: " + e.message); }
        } else { WA.qr = await QRCode.toDataURL(qr, { margin: 1, width: 260 }); WA.state = "qr"; log("QR siap, silakan scan."); }
      }
      if (connection === "open") { WA.qr = WA.code = ""; WA.me = String(sock.user?.id || "").split(":")[0].split("@")[0]; WA.state = "ready"; log("Terhubung sebagai " + WA.me); }
      if (connection === "close") {
        const code = lastDisconnect?.error?.output?.statusCode; WA.sock = null; WA.qr = WA.code = "";
        if (code === DisconnectReason.loggedOut) { fs.rmSync(AUTH_DIR, { recursive: true, force: true }); WA.me = ""; WA.want = false; WA.state = "stopped"; log("Sesi keluar dari HP. Login ulang diperlukan."); }
        else if (WA.want) { WA.state = "starting"; log("Koneksi terputus (kode " + code + "), menyambung ulang..."); setTimeout(() => WA.want && waStart(WA.phone), code === DisconnectReason.restartRequired ? 500 : 3000); }
        else WA.state = "stopped";
      }
    });
  } catch (e) { log("Gagal memulai bot: " + e.message); WA.sock = null; WA.state = "stopped"; WA.want = false; }
  finally { WA.busy = false; }
}
async function waHalt() { WA.want = false; const s = WA.sock; WA.sock = null; if (s) try { s.end(undefined); } catch {} WA.qr = WA.code = ""; WA.state = "stopped"; }
async function waAct(a, phone) {
  if (a === "start") { if (WA.state === "stopped") await waStart(phone); }
  else if (a === "restart") { await waHalt(); await waStart(phone); }
  else if (a === "stop") { await waHalt(); log("Bot dihentikan."); }
  else if (a === "logout") { if (WA.sock) try { await WA.sock.logout(); } catch {} await waHalt(); fs.rmSync(AUTH_DIR, { recursive: true, force: true }); WA.me = ""; log("Sesi WhatsApp dihapus."); }
}

/* ---------- admin: token & xctl ---------- */
async function tokenCheck(key) {
  const o = new URL(UP).origin, H = { Authorization: "Bearer " + key }, day = t => new Date(t).toISOString().slice(0, 10);
  const g = async u => { try { const r = await fetch(u, { headers: H, signal: AbortSignal.timeout(15e3) }); let d = null; try { d = await r.json(); } catch {} return { status: r.status, data: d }; } catch { return { status: 0, data: null }; } };
  const [usage, sub, bill, models] = await Promise.all([g(o + "/api/usage/token"), g(UP + "/dashboard/billing/subscription"), g(UP + "/dashboard/billing/usage?start_date=2023-01-01&end_date=" + day(Date.now() + 864e5)), g(UP + "/models")]);
  return { usage, sub, bill, models: { status: models.status } };
}
const HELP = "xctl, perintah:\n  status                 ringkasan server\n  users                  daftar pengguna\n  logs                   log bot WhatsApp\n  wa                     status bot\n  wa start|stop|restart|logout [nomor]\n  send <nomor> <pesan>   kirim WhatsApp lewat bot";
async function xctl(cmd) {
  const [c, ...a] = cmd.trim().split(/\s+/), out = s => ({ stdout: s, stderr: "", code: 0 }), bad = s => ({ stdout: "", stderr: s, code: 1 });
  if (c === "--help" || c === "help") return out(HELP);
  if (c === "status") return out(`uptime: ${Math.round(process.uptime())}s\nnode: ${process.version}\npengguna: ${Object.keys(users).length}\nwa: ${WA.state}${WA.me ? " (+" + WA.me + ")" : ""}`);
  if (c === "users") return out(Object.values(users).map(u => `${u.username}\t${u.wa}${u.suspended ? "\tsuspend" : ""}`).join("\n") || "(kosong)");
  if (c === "logs") return out(WA.log.slice(-30).join("\n") || "(kosong)");
  if (c === "wa") { if (!a[0]) return out(WA.state + (WA.me ? " +" + WA.me : "")); if (!/^(start|stop|restart|logout)$/.test(a[0])) return bad("wa: perintah tidak dikenal"); await waAct(a[0], a[1] || ""); return out("wa " + a[0] + " -> " + WA.state); }
  if (c === "send") return (await sendWA(a[0], a.slice(1).join(" "))) ? out("terkirim") : bad("gagal: bot belum terhubung");
  if (!E.XCTL_BIN) return bad("perintah tidak dikenal: " + c + "\nKetik --help");
  return new Promise(r => execFile(E.XCTL_BIN, [c, ...a], { timeout: 2e4, maxBuffer: 1e6 }, (e, so, se) => r({ stdout: so, stderr: se, code: e ? (typeof e.code === "number" ? e.code : 1) : 0 })));
}

/* ---------- HTTP ---------- */
const CORS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS" };
const J = (res, s, o) => { res.writeHead(s, { "Content-Type": "application/json", ...CORS }); res.end(JSON.stringify(o)); };
const readBody = req => new Promise(r => { let d = ""; req.on("data", c => { d += c; if (d.length > 1e6) req.destroy(); }); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch { r({}); } }); });

http.createServer(async (req, res) => {
  const p = new URL(req.url, "http://x").pathname, m = req.method;
  if (m === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }
  try {
    if (m === "GET" && (p === "/" || p === "/xozen.html")) return fs.readFile(HTML, (e, d) => { res.writeHead(e ? 404 : 200, { "Content-Type": "text/html; charset=utf-8" }); res.end(e ? "Taruh xozen.html di folder yang sama dengan server.mjs" : d); });
    const b = m === "POST" ? await readBody(req) : {};
    const ip = E.TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : req.socket.remoteAddress;

    if (p.startsWith("/api/auth/")) {
      if (limited(ip, 20)) return J(res, 429, { error: "Terlalu banyak percobaan. Tunggu semenit." });
      if (p === "/api/auth/me" && m === "GET") { const u = authUser(req); if (!u) return J(res, 401, { error: "Sesi berakhir." }); if (u.suspended) return J(res, 403, { suspended: true, error: "Akun ditangguhkan." }); return J(res, 200, session(u)); }
      if (m !== "POST") return J(res, 405, { error: "Metode tidak didukung." });
      if (p === "/api/auth/register") {
        const un = String(b.username || "").trim(), wa = nw(b.wa), pw = String(b.password || "");
        if (!/^[A-Za-z0-9_.]{3,20}$/.test(un)) return J(res, 400, { error: "Username 3-20 karakter: huruf, angka, _ atau ." });
        if (wa.length < 8 || wa.length > 15) return J(res, 400, { error: "Nomor WhatsApp tidak valid." });
        if (pw.length < 6) return J(res, 400, { error: "Kata sandi minimal 6 karakter." });
        if (users[un.toLowerCase()]) return J(res, 409, { error: "Username sudah dipakai." });
        if (Object.values(users).some(x => x.wa === wa)) return J(res, 409, { error: "Nomor WhatsApp sudah terdaftar." });
        const u = users[un.toLowerCase()] = mkU(un, wa, pw); saveU(); return J(res, 200, session(u));
      }
      if (p === "/api/auth/login") {
        const u = find(b.id);
        if (!u || !chk(u, String(b.password || ""))) return J(res, 401, { error: "Username/nomor atau kata sandi salah." });
        if (u.suspended) { const ok = await sendCode(u, "sus"); return J(res, 403, { suspended: true, error: ok ? "Akun ditangguhkan admin. Kode verifikasi dikirim ke WhatsApp." : "Akun ditangguhkan admin dan bot WhatsApp sedang offline. Hubungi admin." }); }
        return J(res, 200, session(u));
      }
      if (p === "/api/auth/code") { const u = find(b.id); if (u && b.purpose === "reset") await sendCode(u, "reset"); return J(res, 200, { ok: true }); }
      if (p === "/api/auth/verify") { const u = find(b.id); if (!u || !useCode(u, "sus", b.code)) return J(res, 400, { error: "Kode salah atau kedaluwarsa." }); u.suspended = false; saveU(); return J(res, 200, session(u)); }
      if (p === "/api/auth/reset") {
        const u = find(b.id), pw = String(b.password || "");
        if (pw.length < 6) return J(res, 400, { error: "Kata sandi minimal 6 karakter." });
        if (!u || !useCode(u, "reset", b.code)) return J(res, 400, { error: "Kode salah atau kedaluwarsa." });
        u.salt = crypto.randomBytes(16).toString("hex"); u.hash = hp(pw, u.salt); saveU(); return J(res, 200, { ok: true });
      }
      return J(res, 404, { error: "Tidak ditemukan." });
    }

    if (p.startsWith("/admin/users")) {
      if (!isAdm(authUser(req))) return J(res, 403, { error: "Khusus admin." });
      const mm = p.match(/^\/admin\/users(?:\/([^/]+)(?:\/(suspend|unsuspend))?)?$/);
      if (!mm) return J(res, 404, { error: "Tidak ditemukan." });
      if (!mm[1]) return J(res, 200, Object.values(users).map(u => ({ username: u.username, wa: u.wa, suspended: u.suspended })));
      const t = users[decodeURIComponent(mm[1]).toLowerCase()];
      if (!t) return J(res, 404, { error: "Pengguna tidak ada." });
      if (isAdm(t)) return J(res, 400, { error: "Akun admin tidak bisa diubah." });
      if (m === "DELETE") delete users[t.username.toLowerCase()]; else if (mm[2]) t.suspended = mm[2] === "suspend"; else return J(res, 405, { error: "Metode tidak didukung." });
      saveU(); return J(res, 200, { ok: true });
    }

    if (p.startsWith("/api/") || p === "/token/check") {
      if (!safeEq(bearer(req), ADMIN_PW)) return J(res, limited("f" + ip, 10) ? 429 : 401, { error: "Password admin salah." });
      if (p === "/api/config") return J(res, 200, { ok: true, name: "Xozen" });
      if (p === "/api/wa" && m === "GET") return J(res, 200, view());
      const w = p.match(/^\/api\/wa\/(start|restart|stop|logout)$/);
      if (w && m === "POST") { await waAct(w[1], b.phone || ""); return J(res, 200, view()); }
      if (p === "/api/xctl" && m === "POST") return J(res, 200, await xctl(String(b.cmd || "--help")));
      if (p === "/token/check" && m === "POST") return J(res, 200, await tokenCheck(String(b.key || "")));
    }
    J(res, 404, { error: "Tidak ditemukan." });
  } catch (e) { console.error(e); J(res, 500, { error: "Kesalahan server." }); }
}).listen(PORT, () => {
  console.log("Xozen server di http://localhost:" + PORT);
  if (fs.existsSync(path.join(AUTH_DIR, "creds.json"))) waStart("");
});
process.on("unhandledRejection", e => log("Error: " + (e && e.message || e)));
