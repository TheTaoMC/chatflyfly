// กลุ่มแชทง่ายๆ: http server ไม่พึ่ง dependency เลย
// รัน: node server.js แล้วเปิด http://localhost:3000
// ponytail: ใช้ polling แทน SSE เพราะ trycloudflare (tunnel ฟรี) บัฟเฟอร์ response
//           ที่ไม่มีที่สิ้นสุดค้างไม่ออก — polling ตอบจบทุกครั้ง ใช้ได้ทุกที่
//           ข้อเสีย: ข้อความใหม่ช้าได้ถึง ~1.5 วิ ตามรอบ polling
//           อัปเกรดทีหลัง: ถ้าใช้ tunnel/domain ที่ stream ได้จริง (เช่น named tunnel)
//           ก็เปลี่ยนกลับเป็น SSE หรือ WebSocket ได้
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const PORT = Number(process.env.PORT) || 3000; // Render/Fly ส่ง PORT env มาให้ — ใช้ของเดิมถ้าไม่ตั้ง
const MAX_MESSAGES = 200; // เก็บแค่ 200 ข้อความล่าสุดใน memory
const MAX_TEXT = 2000; // จำกัดความยาวข้อความ
const MAX_IMG_BYTES = 5 * 1024 * 1024; // รูปไม่เกิน 5MB
const IMAGE_TTL_MS = Number(process.env.IMG_TTL_MS) || 5 * 60 * 1000; // รูปหายอัตโนมัติหลัง 5 นาที (env ใช้ทดสอบ)

const UPLOADS_DIR = path.join(__dirname, "uploads");
const ALLOWED_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };

// ---- state ----
const messages = []; // [{id, name, text?, img?, time}]

// ---- ชื่อที่ถูกใช้อยู่ (จองชื่อกันซ้ำ) ----
// ชื่อจะว่างอัตโนมัติเมื่อเจ้าของเงียบเกิน 60 วิ (เผื่อ background tab ที่ browser throttle timer)
const ACTIVE_TTL_MS = Number(process.env.NAME_TTL_MS) || 60_000; // env ใช้ทดสอบ
const activeNames = new Map(); // name -> {avatar, lastSeen}
const touch = (name) => {
  if (!name) return;
  const cur = activeNames.get(name);
  activeNames.set(name, cur ? { ...cur, lastSeen: Date.now() } : { avatar: "👤", lastSeen: Date.now() });
};
setInterval(() => {
  const now = Date.now();
  for (const [n, v] of activeNames) if (now - v.lastSeen > ACTIVE_TTL_MS) activeNames.delete(n);
}, 10_000);
// ponytail: ถ้าเจ้าของเก่าหายไปแล้วชื่อถูกคนอื่นจอง แล้วเจ้าของเก่ากลับมา poll อีกที
// จะถูก touch ให้คืนชีพอีกครั้ง (edge case หายาก — ยอมรับได้ ไม่งั้นต้องทำ session/login)

// ล้างโฟลเดอร์รูปตอนเปิด server (memory ก็ว่างด้วย — ของเก่าทิ้งไปหมด)
fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ลบไฟล์รูป (ไม่สน error — ไฟล์อาจถูกลบไปแล้ว)
const unlinkImg = (imgPath) => imgPath && fs.unlink(path.join(UPLOADS_DIR, path.basename(imgPath)), () => {});

// ไล่ลบรูปที่อายุเกิน 5 นาที ทั้งไฟล์และข้อความ ออกจากทุกคน
setInterval(() => {
  const now = Date.now();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.img && now - m.time > IMAGE_TTL_MS) {
      unlinkImg(m.img);
      messages.splice(i, 1);
    }
  }
}, 30_000);

// เก็บข้อความลง memory (ตัดส่วนเกิน + ลบไฟล์ของข้อความรูปที่หลุดวง)
const pushMessage = (msg) => {
  messages.push(msg);
  if (messages.length > MAX_MESSAGES) {
    for (const m of messages.splice(0, messages.length - MAX_MESSAGES)) unlinkImg(m.img);
  }
};

const json = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;

  // หน้า UI
  if (method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html")));
    return;
  }

  // เสิร์ฟรูปที่อัปโหลด — ใช้ basename เท่านั้น (กัน path traversal) + nosniff กัน XSS
  if (method === "GET" && url.pathname.startsWith("/uploads/")) {
    const filename = path.basename(url.pathname);
    const ext = path.extname(filename).slice(1).toLowerCase();
    const mime = ALLOWED_EXT[ext];
    if (!mime) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    fs.readFile(path.join(UPLOADS_DIR, filename), (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end("gone"); // รูปถูกลบไปแล้ว (เกิน 5 นาที)
        return;
      }
      res.writeHead(200, { "Content-Type": mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "public, max-age=300" });
      res.end(data);
    });
    return;
  }

  // ดึงข้อความทั้งหมด (client poll ทุก 1.5 วิ) — ส่ง ?name=xxx มาด้วยเพื่อเป็น heartbeat ยืนยันว่ายังอยู่
  if (method === "GET" && url.pathname === "/messages") {
    touch(url.searchParams.get("name"));
    json(res, 200, { messages });
    return;
  }

  // จองชื่อก่อนเข้าแชท — ชื่อซ้ำโดน reject (409)
  if (method === "POST" && url.pathname === "/claim") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const name = String(data.name || "").trim().slice(0, 50);
    if (!name) {
      json(res, 400, { error: "name required" });
      return;
    }
    if (activeNames.has(name)) {
      json(res, 409, { error: "ชื่อนี้มีคนใช้อยู่" });
      return;
    }
    const avatar = String(data.avatar || "").trim().slice(0, 8) || "👤";
    activeNames.set(name, { avatar, lastSeen: Date.now() });
    json(res, 200, { ok: true });
    return;
  }

  // รายชื่อคนที่อยู่ในห้องตอนนี้ (ฝั่งซ้าย "ร้านตัวละคร")
  if (method === "GET" && url.pathname === "/users") {
    json(res, 200, { users: [...activeNames.entries()].map(([name, v]) => ({ name, avatar: v.avatar })) });
    return;
  }

  // ส่งข้อความตัวหนังสือ
  if (method === "POST" && url.pathname === "/send") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    // input validation (trust boundary)
    const name = String(data.name || "").trim().slice(0, 50);
    const text = String(data.text || "").trim().slice(0, MAX_TEXT);
    if (!name || !text) {
      json(res, 400, { error: "name and text required" });
      return;
    }
    touch(name);
    pushMessage({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), name, text, time: Date.now() });
    json(res, 200, { ok: true });
    return;
  }

  // อัปโหลดรูป (ส่งเป็น base64 ใน JSON — ไม่ต้อง parse multipart ให้ยุ่งยาก)
  if (method === "POST" && url.pathname === "/upload") {
    let body = "";
    for await (const chunk of req) body += chunk;
    if (body.length > MAX_IMG_BYTES * 1.4 + 512) {
      // base64 ยาวกว่าไฟล์จริง ~33% — ตัดตั้งแต่ต้นถ้าเกิน
      json(res, 413, { error: "file too large (max 5MB)" });
      return;
    }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const name = String(data.name || "").trim().slice(0, 50);
    const ext = String(data.ext || "").toLowerCase();
    if (!name || !ALLOWED_EXT[ext]) {
      json(res, 400, { error: "name required and only jpg/png/gif/webp allowed" });
      return;
    }
    // ตรวจว่าเป็น base64 จริงๆ (regex คร่าวๆ แล้วลอง decode)
    if (!/^[A-Za-z0-9+/=\s]+$/.test(String(data.img || ""))) {
      json(res, 400, { error: "invalid image data" });
      return;
    }
    const buf = Buffer.from(String(data.img), "base64");
    if (buf.length === 0 || buf.length > MAX_IMG_BYTES) {
      json(res, 413, { error: "file too large (max 5MB)" });
      return;
    }
    touch(name);
    // ชื่อไฟล์เราสร้างเองทั้งหมด — ไม่เอา filename จาก user (กัน disguised file)
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
    pushMessage({
      id: Date.now() + "-" + Math.random().toString(36).slice(2, 7),
      name,
      text: "",
      img: `/uploads/${filename}`,
      time: Date.now(),
    });
    json(res, 200, { ok: true });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

server.listen(PORT, () => {
  console.log(`แชทกลุ่มพร้อมแล้ว: http://localhost:${PORT} (รูปจะถูกลบหลัง ${IMAGE_TTL_MS / 1000} วิ)`);
});

// ponytail: เก็บข้อความใน memory เท่านั้น — server รีสตาร์ทแล้วข้อความและรูปหาย
// อัปเกรดทีหลัง: เปลี่ยน messages เป็น SQLite (better-sqlite3) หรือเขียน append-only JSON file
// ponytail: ไม่มี auth / ไม่มีแยกห้อง — ใครก็เข้ามาแชทด้วยกันได้ในห้องเดียว
