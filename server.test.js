// เทสต์ Google login (บังคับ) — ใช้ JWKS ปลอมในเครื่อง + RSA key จริงที่เราสร้างเอง
// รัน: node --test server.test.js
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const http = require("node:http");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs");

const CLIENT_ID = "test-client.apps.googleusercontent.com";
const ADMIN_EMAIL = "admin@example.com";
const STRIPE_WEBHOOK_SECRET = "whsec_test_chatflyfly";
const SUPABASE_SECRET_KEY = "sb_secret_test_chatflyfly";

// สร้าง RSA key + JWKS server ปลอม ก่อน require server.js (server.js อ่าน env ตอนโหลด)
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const pubJwk = publicKey.export({ format: "jwk" });

const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
// สร้าง ID token (JWT RS256) เลียนแบบ Google
function makeJwt(claims, { kid = "testkid", alg = "RS256", sign = true } = {}) {
  const h = b64u({ alg, kid, typ: "JWT" });
  const p = b64u(claims);
  const data = h + "." + p;
  if (!sign) return data + ".deadbeef";
  const sig = crypto.sign("RSA-SHA256", Buffer.from(data), privateKey).toString("base64url");
  return data + "." + sig;
}
const validClaims = (over = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "gid-123",
  email: "user@example.com",
  name: "สมชาย ใจดี",
  email_verified: true,
  iat: Math.floor(Date.now() / 1000) - 60,
  exp: Math.floor(Date.now() / 1000) + 3600,
  ...over,
});

let base = "";
let api; // exports จาก server.js
let adminSession = "";

test("โฟลว์บังคับ Google login (JWKS ปลอม + RSA จริง)", async (t) => {
  const identitiesFile = path.join(os.tmpdir(), `ramen-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const banFile = path.join(os.tmpdir(), `ramen-ban-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const partsFile = path.join(os.tmpdir(), `ramen-parts-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const avatarsDir = fs.mkdtempSync(path.join(os.tmpdir(), "ramen-avatars-"));

  const jwksSrv = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ keys: [{ kty: "RSA", kid: "testkid", use: "sig", alg: "RS256", n: pubJwk.n, e: pubJwk.e }] }));
  });
  await new Promise((r) => jwksSrv.listen(0, "127.0.0.1", r));
  const jwksUrl = `http://127.0.0.1:${jwksSrv.address().port}/certs`;

  const supabaseState = new Map([["identities", []], ["banned", []]]);
  const storageBuckets = new Set();
  const storageObjects = new Map();
  const supabaseSrv = http.createServer(async (req, res) => {
    if (req.headers.apikey !== SUPABASE_SECRET_KEY) { res.writeHead(401); res.end(); return; }
    const url = new URL(req.url, "http://localhost");
    if (url.pathname.startsWith("/storage/v1/")) {
      const storagePath = url.pathname.slice("/storage/v1/".length);
      if (req.method === "HEAD" && storagePath.startsWith("bucket/")) {
        res.writeHead(storageBuckets.has(storagePath.slice(7)) ? 200 : 404); res.end(); return;
      }
      if (req.method === "POST" && storagePath === "bucket") {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const bucket = JSON.parse(Buffer.concat(chunks).toString("utf8")).id;
        storageBuckets.add(bucket); res.writeHead(201); res.end(); return;
      }
      if (req.method === "PUT" && storagePath.startsWith("object/")) {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        storageObjects.set(storagePath.slice(7), Buffer.concat(chunks)); res.writeHead(200); res.end(); return;
      }
      res.writeHead(404); res.end(); return;
    }
    if (url.pathname !== "/rest/v1/app_state") { res.writeHead(404); res.end(); return; }
    if (req.method === "GET") {
      const id = String(url.searchParams.get("id") || "").replace(/^eq\./, "");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(supabaseState.has(id) ? [{ data: supabaseState.get(id) }] : []));
      return;
    }
    if (req.method === "POST") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const row = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      supabaseState.set(row.id, row.data);
      res.writeHead(201);
      res.end();
      return;
    }
    res.writeHead(405);
    res.end();
  });
  await new Promise((r) => supabaseSrv.listen(0, "127.0.0.1", r));

  process.env.GOOGLE_CLIENT_ID = CLIENT_ID;
  process.env.ADMIN_EMAIL = ADMIN_EMAIL;
  process.env.GOOGLE_JWKS_URL = jwksUrl;
  process.env.IDENTITIES_FILE = identitiesFile;
  process.env.BANNED_FILE = banFile;
  process.env.POINT_COOLDOWN_MS = "300"; // เทสต์เร็วๆ — cooldown สั้น
  process.env.DAILY_POINT_CAP = "6"; // เทสต์โควต้า
  process.env.PORT = "0";
  process.env.PARTS_FILE = partsFile;
  process.env.AVATARS_DIR = avatarsDir;
  process.env.STRIPE_WEBHOOK_SECRET = STRIPE_WEBHOOK_SECRET;
  process.env.SUPPORT_PAYMENT_LINK = "https://buy.stripe.com/test_support";
  process.env.SUPPORT_MIN_AMOUNT = "2000";
  process.env.SUPABASE_URL = `http://127.0.0.1:${supabaseSrv.address().port}`;
  process.env.SUPABASE_SECRET_KEY = SUPABASE_SECRET_KEY;

  api = require("./server.js");
  await api.ready;
  await new Promise((r) => api.server.listen(0, r));
  base = `http://127.0.0.1:${api.server.address().port}`;

  await t.test("levelFor: ระดับตามคะแนน (เกณฑ์สูง — ไต่ช้าๆ)", () => {
    assert.equal(api.levelFor(0).title, "นักชิมมือใหม่");
    assert.equal(api.levelFor(299).title, "นักชิมมือใหม่");
    assert.equal(api.levelFor(300).title, "นักกินประจำ");
    assert.equal(api.levelFor(899).title, "นักกินประจำ");
    assert.equal(api.levelFor(900).title, "นักชิมตัวจริง");
    assert.equal(api.levelFor(2100).title, "เชฟฝึกหัด");
    assert.equal(api.levelFor(4500).title, "เซียนราเมง");
    assert.equal(api.levelFor(9000).title, "ปรมาจารย์ราเมง");
    assert.equal(api.levelFor(99999).title, "ปรมาจารย์ราเมง");
  });

  const post = (p, body, headers = {}) =>
    fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  // สร้าง PNG 16×16 ง่ายๆ (white square)
  const makePng = () => {
    const header = Buffer.from([137,80,78,71,13,10,26,10]);
    const zlib = require("node:zlib");
    const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(16,0); ihdr.writeUInt32BE(16,4); ihdr[8]=8; ihdr[9]=6;
    const makeChunk=(t,d)=>{const l=Buffer.alloc(4);l.writeUInt32BE(d.length,0);const tb=Buffer.from(t,"ascii");const crcT=new Uint32Array(256);for(let n=0;n<256;n++){let c=n;for(let k=0;k<8;k++)c=c&1?0xedb88320^(c>>>1):c>>>1;crcT[n]=c;}const crc32=b=>{let c=0xffffffff;for(let i=0;i<b.length;i++)c=crcT[(c^b[i])&0xff]^(c>>>8);return(c^0xffffffff)>>>0;};const cb=Buffer.alloc(4);cb.writeUInt32BE(crc32(Buffer.concat([tb,d])),0);return Buffer.concat([l,tb,d,cb]);};
    const raw=Buffer.alloc((16*4+1)*16); for(let y=0;y<16;y++){raw[y*(16*4+1)]=0;for(let x=0;x<16;x++){const i=y*(16*4+1)+1+x*4;raw[i]=255;raw[i+1]=255;raw[i+2]=255;raw[i+3]=255;}}
    return Buffer.concat([header,makeChunk("IHDR",ihdr),makeChunk("IDAT",zlib.deflateSync(raw)),makeChunk("IEND",Buffer.alloc(0))]);
  };
  const postMultipart = (p, fields, headers = {}) => {
    const boundary = "----TestBoundary" + Date.now();
    const parts = [];
    for (const [k, v] of Object.entries(fields)) {
      if (Buffer.isBuffer(v)) {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`));
        parts.push(v);
        parts.push(Buffer.from("\r\n"));
      } else {
        parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`));
      }
    }
    parts.push(Buffer.from(`--${boundary}--\r\n`));
    const body = Buffer.concat(parts);
    return fetch(base + p, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}`, ...headers }, body });
  };
  const get = (p, headers = {}) => fetch(base + p, { headers });
  const adminHeaders = () => ({ Authorization: `Bearer ${adminSession}` });
  const savedIdentities = () => supabaseState.get("identities");

  t.after(async () => {
    // closeAllConnections: ปิด keep-alive จาก fetch ไม่งั้น server.close() ค้างรอไม่จบ
    await new Promise((r) => { api.server.closeAllConnections(); api.server.close(r); });
    await new Promise((r) => { jwksSrv.closeAllConnections(); jwksSrv.close(r); });
    await new Promise((r) => { supabaseSrv.closeAllConnections(); supabaseSrv.close(r); });
    try { fs.rmSync(identitiesFile, { force: true }); } catch {}
    try { fs.rmSync(banFile, { force: true }); } catch {}
    try { fs.rmSync(partsFile, { force: true }); } catch {}
    try { fs.rmSync(avatarsDir, { recursive: true, force: true }); } catch {}
  });

  // ── verifyGoogleJwt ──
  await t.test("verify: token ที่ถูกต้องผ่าน", async () => {
    const r = await api.verifyGoogleJwt(makeJwt(validClaims()), { clientId: CLIENT_ID, jwksUrl });
    assert.equal(r.ok, true);
    assert.equal(r.sub, "gid-123");
    assert.equal(r.email, "user@example.com");
  });

  await t.test("verify: aud ไม่ตรงโดน reject", async () => {
    const r = await api.verifyGoogleJwt(makeJwt(validClaims({ aud: "other-client" })), { clientId: CLIENT_ID, jwksUrl });
    assert.match(r.error, /client id/);
  });

  await t.test("verify: ลายเซ็นปลอมโดน reject", async () => {
    const r = await api.verifyGoogleJwt(makeJwt(validClaims(), { sign: false }), { clientId: CLIENT_ID, jwksUrl });
    assert.match(r.error, /ลายเซ็น/);
  });

  await t.test("verify: token หมดอายุโดน reject", async () => {
    const r = await api.verifyGoogleJwt(makeJwt(validClaims({ exp: Math.floor(Date.now() / 1000) - 600 })), { clientId: CLIENT_ID, jwksUrl });
    assert.match(r.error, /หมดอายุ/);
  });

  await t.test("verify: issuer ปลอมโดน reject", async () => {
    const r = await api.verifyGoogleJwt(makeJwt(validClaims({ iss: "https://evil.example.com" })), { clientId: CLIENT_ID, jwksUrl });
    assert.match(r.error, /issuer/);
  });

  // ── /google-login ──
  let sessionA, sessionB;
  await t.test("google-login: token ดี → ได้ session + เก็บ identity หลังบ้าน", async () => {
    const res = await post("/google-login", { credential: makeJwt(validClaims()) });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.ok(d.token);
    sessionA = d.token;
    // identities.json ถูกเขียน (หลังบ้าน)
    const saved = savedIdentities();
    assert.equal(saved[0].email, "user@example.com");
    assert.equal(saved[0].name, "สมชาย ใจดี");
  });

  await t.test("google-login: token ปลอม → 401", async () => {
    const res = await post("/google-login", { credential: "not-a-real-jwt" });
    assert.equal(res.status, 401);
  });

  // ── /claim (บังคับ login) ──
  await t.test("claim: ไม่มี session → 401", async () => {
    const res = await post("/claim", { name: "ราเมง1234", avatar: "🦊" });
    assert.equal(res.status, 401);
  });

  await t.test("claim: มี session → จองชื่อได้ (ชื่อเล่นไม่ใช่ชื่อจริง)", async () => {
    const res = await post("/claim", { name: "ราเมง1234", avatar: "🦊", session: sessionA });
    assert.equal(res.status, 200);
    const d = await (await res.json());
    assert.equal(d.ok, true);
  });

  await t.test("claim: คนอื่น (gid ต่าง) แย่งชื่อไม่ได้ → 409", async () => {
    const res2 = await post("/google-login", { credential: makeJwt(validClaims({ sub: "gid-999", email: "other@example.com", name: "อีกคน" })) });
    sessionB = (await res2.json()).token;
    const res = await post("/claim", { name: "ราเมง1234", avatar: "🐸", session: sessionB });
    assert.equal(res.status, 409);
  });

  await t.test("claim: เจ้าของเดิม (gid ตรง) ขอคืนได้ (จำลอง F5)", async () => {
    const res = await post("/claim", { name: "ราเมง1234", avatar: "🦊", session: sessionA });
    assert.equal(res.status, 200);
  });

  // ── สนับสนุนผ่าน Stripe → ชื่อรุ้ง ──
  await t.test("support: ผูก Payment Link กับบัญชี และให้สิทธิ์เฉพาะ webhook ที่เซ็นถูก+จ่ายครบ", async () => {
    const linkRes = await post("/support-link", { session: sessionA });
    assert.equal(linkRes.status, 200);
    const paymentUrl = new URL((await linkRes.json()).url);
    assert.equal(paymentUrl.searchParams.get("locked_prefilled_email"), "user@example.com");
    assert.equal(paymentUrl.searchParams.get("locale"), "th");
    const ref = paymentUrl.searchParams.get("client_reference_id");
    assert.match(ref, /^[A-Za-z0-9_-]{20,100}$/);
    assert.ok(!paymentUrl.toString().includes(sessionA), "ห้ามส่ง session token ไป Stripe");
    assert.ok(!paymentUrl.toString().includes("gid-123"), "ห้ามส่ง Google sub ไป Stripe");

    const event = JSON.stringify({
      id: "evt_support_1",
      type: "checkout.session.completed",
      data: { object: { id: "cs_support_1", payment_status: "paid", currency: "thb", amount_total: 2000, client_reference_id: ref, customer_details: { email: "user@example.com" } } },
    });
    const bad = await fetch(base + "/stripe-webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": "t=1,v1=bad" }, body: event });
    assert.equal(bad.status, 400);
    assert.equal(api.identities.get("gid-123").supporter, undefined);

    const timestamp = Math.floor(Date.now() / 1000);
    const underpaidEvent = event.replace('"amount_total":2000', '"amount_total":1999');
    const underpaidSignature = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${underpaidEvent}`).digest("hex");
    const underpaid = await fetch(base + "/stripe-webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=${underpaidSignature}` }, body: underpaidEvent });
    assert.equal(underpaid.status, 200);
    assert.equal((await underpaid.json()).granted, false);
    assert.equal(api.identities.get("gid-123").supporter, undefined);

    const signature = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${event}`).digest("hex");
    const paid = await fetch(base + "/stripe-webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=${signature}` }, body: event });
    assert.equal(paid.status, 200);
    assert.equal((await paid.json()).granted, true);
    assert.equal(api.identities.get("gid-123").supporter, true);
    assert.equal(api.identities.get("gid-123").supportAmount, 2000);

    const recoveryEvent = JSON.stringify({
      id: "evt_support_recovery",
      type: "checkout.session.completed",
      data: { object: { id: "cs_support_recovery", payment_status: "paid", currency: "thb", amount_total: 2000, client_reference_id: "old-reference", customer_details: { email: "OTHER@example.com" } } },
    });
    const recoverySignature = crypto.createHmac("sha256", STRIPE_WEBHOOK_SECRET).update(`${timestamp}.${recoveryEvent}`).digest("hex");
    const recovered = await fetch(base + "/stripe-webhook", { method: "POST", headers: { "Content-Type": "application/json", "Stripe-Signature": `t=${timestamp},v1=${recoverySignature}` }, body: recoveryEvent });
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).granted, true);
    assert.equal(savedIdentities().find((i) => i.sub === "gid-999").supporter, true, "สิทธิ์กู้จากอีเมลต้องถูกบันทึกลง Supabase");
  });

  await t.test("nickname: จำชื่อเล่นไว้กับบัญชี — login รอบ 2 ได้ชื่อเดิมคืน ไม่ต้องตั้งใหม่", async () => {
    // login ใหม่ด้วยบัญชีเดิม (gid-123) → ต้องได้ nickname "ราเมง1234" กลับมา
    const res = await post("/google-login", { credential: makeJwt(validClaims()) });
    assert.equal(res.status, 200);
    const d = await res.json();
    assert.equal(d.nickname, "ราเมง1234");
    // identities.json เก็บ nickname ไว้กับ sub ด้วย
    const saved = savedIdentities();
    const me = saved.find((i) => i.sub === "gid-123");
    assert.equal(me.nickname, "ราเมง1234");
  });

  // ── /users ไม่รั่วข้อมูลส่วนตัว ──
  await t.test("users: สาธารณะเห็นแค่ชื่อเล่น+อวตาร ไม่มี email/ชื่อจริง", async () => {
    const res = await get("/users");
    const { users } = await res.json();
    const u = users.find((x) => x.name === "ราเมง1234");
    assert.ok(u);
    assert.equal(u.email, undefined);
    assert.equal(u.realName, undefined);
    assert.equal(u.gid, undefined);
    assert.equal(u.supporter, true);
  });

  // ── /send ต้องมี session ──
  await t.test("send: ไม่มี session → 401 / มี session → 200 + ได้ +2 แต้ม และปลอมชื่อไม่ได้", async () => {
    const bad = await post("/send", { name: "ราเมง1234", text: "hi" });
    assert.equal(bad.status, 401);
    const ok = await post("/send", { name: "ชื่อที่พยายามปลอม", text: "hi", session: sessionA });
    assert.equal(ok.status, 200);
    const sent = (await (await get("/messages")).json()).messages.at(-1);
    assert.equal(sent.name, "ราเมง1234");
    assert.equal(sent.supporter, true);
    // ส่งข้อความ = +2 แต้ม → /users โชว์คะแนน + เลเวล (ยังเป็นมือใหม่) + ความคืบหน้า
    const { users } = await (await get("/users")).json();
    const me = users.find((u) => u.name === "ราเมง1234");
    assert.equal(me.points, 2);
    assert.equal(me.title, "นักชิมมือใหม่");
    assert.equal(me.nextTitle, "นักกินประจำ");
    assert.equal(me.toNext, 298); // ต้องอีก 298 แต้ม (300-2)
    assert.equal(me.pct, 1); // แถบความคืบหน้า ~1%
    // คะแนนเก็บถาวรใน identities.json
    const saved = savedIdentities();
    assert.equal(saved.find((i) => i.sub === "gid-123").points, 2);
  });

  await t.test("profile: โปรไฟล์สาธารณะ — มีเลเวล/สถิติ แต่ไม่มี email/ชื่อจริง", async () => {
    const r = await get("/profile?name=" + encodeURIComponent("ราเมง1234"));
    assert.equal(r.status, 200);
    const d = await r.json();
    assert.equal(d.name, "ราเมง1234");
    assert.equal(d.online, true);
    assert.equal(d.avatar, "🦊");
    assert.equal(d.points, 2);
    assert.equal(d.level, "นักชิมมือใหม่");
    assert.equal(d.stats.msgs, 1); // นับสถิติข้อความ
    assert.equal(d.supporter, true);
    assert.equal(d.email, undefined); // ห้ามรั่ว
    assert.equal(d.realName, undefined); // ห้ามรั่ว
    assert.equal(d.sub, undefined); // ห้ามรั่ว
    // ไม่พบผู้ใช้ → 404
    assert.equal((await get("/profile?name=" + encodeURIComponent("ไม่มีตัวตน"))).status, 404);
  });

  // ── /admin/users ──
  await t.test("admin: ต้องเป็น Google session ของ ADMIN_EMAIL จึงเห็น email+ชื่อจริง", async () => {
    const no = await get("/admin/users");
    assert.equal(no.status, 401);
    const bad = await get("/admin/users", { Authorization: "Bearer wrong" });
    assert.equal(bad.status, 401);
    const adminLogin = await post("/google-login", { credential: makeJwt(validClaims({ sub: "gid-admin", email: ADMIN_EMAIL, name: "ผู้ดูแล" })) });
    assert.equal(adminLogin.status, 200);
    adminSession = (await adminLogin.json()).token;
    const denied = await get("/admin/users", { Authorization: `Bearer ${sessionB}` });
    assert.equal(denied.status, 403);
    const ok = await get("/admin/users", adminHeaders());
    assert.equal(ok.status, 200);
    const d = await ok.json();
    const online = d.online.find((x) => x.name === "ราเมง1234");
    assert.equal(online.email, "user@example.com");
    assert.equal(online.realName, "สมชาย ใจดี");
    assert.ok(d.identities.some((i) => i.email === "other@example.com"), "มี identity ของคนที่เคย login ด้วย");
    // summary: stats + ข้อความล่าสุด (ส่งไป 1 ข้อความ "hi" ในเทสต์ send)
    assert.equal(d.stats.messages, 1);
    assert.equal(d.latest.length, 1);
    assert.equal(d.latest[0].name, "ราเมง1234");
    assert.equal(d.latest[0].text, "hi");
    assert.equal((await post("/admin/ban", { sub: "gid-admin" }, adminHeaders())).status, 400, "ผู้ดูแลห้ามแบนตัวเอง");
    const adminPage = await (await get("/admin")).text();
    assert.ok(adminPage.includes(CLIENT_ID));
    assert.ok(adminPage.includes("adminGoogle"));
    assert.ok(!adminPage.includes("ADMIN_TOKEN"));
    const adminScript = adminPage.match(/<script nonce="[^"]+">([\s\S]*)<\/script>/)?.[1] || "";
    assert.ok(adminScript);
    assert.doesNotThrow(() => new Function(adminScript));
  });

  // ── ข้อความเสียง (kind=voice) ──
  await t.test("voice: อัปโหลดเสียง → ข้อความ voice + เสิร์ฟ mime audio + ext เสียงต้องมี kind=voice", async () => {
    await new Promise((r) => setTimeout(r, 320)); // รอพ้น cooldown ของการส่งข้อความก่อน
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0x93, 0x42, 0x82]); // EBML/WebM signature
    const res = await post("/upload", { name: "ราเมง1234", ext: "webm", img: webm.toString("base64"), session: sessionA, kind: "voice" });
    assert.equal(res.status, 200);
    const { messages } = await (await get("/messages")).json();
    const v = messages.find((m) => m.voice);
    assert.ok(v, "มีข้อความ voice");
    assert.equal(v.img, undefined);
    assert.equal(v.text, "");
    // เสิร์ฟไฟล์เสียงด้วย content-type ที่ถูกต้อง
    const f = await get(v.voice);
    assert.equal(f.status, 200);
    assert.match(f.headers.get("content-type"), /audio\/webm/);
    // อัปโหลด ext เสียงโดยไม่ระบุ kind=voice → 400 (กันเอาเสียงปลอมมาเป็นรูป)
    const bad = await post("/upload", { name: "ราเมง1234", ext: "webm", img: "eA==", session: sessionA });
    assert.equal(bad.status, 400);
    // ส่งเสียง = +3 แต้ม (รวมกับข้อความ 2 = 5)
    const { users } = await (await get("/users")).json();
    assert.equal(users.find((u) => u.name === "ราเมง1234").points, 5);
  });

  // ── กันฟาร์มคะแนน: cooldown + โควต้าต่อวัน ──
  await t.test("คะแนน: cooldown กันสแปม + โควต้าวันละ 6 แต้ม (เทสต์ env)", async () => {
    assert.equal((await post("/claim", { name: "ราเมง999", avatar: "🐸", session: sessionB })).status, 200);
    const pts = async () => (await (await get("/users")).json()).users.find((u) => u.name === "ราเมง999")?.points;
    // ส่งข้อความ 1 → ได้ +2
    assert.equal((await post("/send", { name: "ราเมง999", text: "หนึ่ง", session: sessionB })).status, 200);
    assert.equal(await pts(), 2);
    // ส่งซ้ำทันที (ใน cooldown) → ข้อความขึ้น แต่ไม่ให้คะแนน
    const r2 = await post("/send", { name: "ราเมง999", text: "สอง", session: sessionB });
    assert.equal(r2.status, 200);
    assert.equal((await r2.json()).rewarded, false);
    assert.equal(await pts(), 2);
    let msgs = (await (await get("/messages")).json()).messages;
    assert.ok(msgs.some((m) => m.text === "สอง"), "ข้อความสแปมยังส่งได้ แต่ไม่ให้คะแนน");
    // รอพ้น cooldown → ได้คะแนนอีก
    await new Promise((r) => setTimeout(r, 320));
    assert.equal((await post("/send", { name: "ราเมง999", text: "สาม", session: sessionB })).status, 200);
    assert.equal(await pts(), 4);
    // ถึงโควต้า 6 (อีก 2 แต้ม)
    await new Promise((r) => setTimeout(r, 320));
    assert.equal((await post("/send", { name: "ราเมง999", text: "สี่", session: sessionB })).status, 200);
    assert.equal(await pts(), 6);
    // ส่งต่อ → แต้มนิ่ง (โควต้าเต็ม) แต่ข้อความยังขึ้น
    await new Promise((r) => setTimeout(r, 320));
    const rCap = await post("/send", { name: "ราเมง999", text: "ห้า", session: sessionB });
    const capJ = await rCap.json();
    assert.equal(capJ.rewarded, false);
    assert.equal(capJ.dayLeft, 0);
    assert.equal(await pts(), 6);
    // /users คืน dayPoints/dayCap
    const u = (await (await get("/users")).json()).users.find((x) => x.name === "ราเมง999");
    assert.equal(u.dayPoints, 6);
    assert.equal(u.dayCap, 6);
  });

  // ── Ban / Unban (blocklist ด้วย sub ของ Google) ──
  await t.test("ban: ต้องใช้ session แอดมิน, แบนแล้ว login ไม่ได้ + เตะ session, ปลดแบนกลับมาได้", async () => {
    // ไม่มี Google session → 401
    assert.equal((await post("/admin/ban", { sub: "gid-123" })).status, 401);

    // แบน gid-123 (พร้อมเหตุผล)
    const ban = await post("/admin/ban", { sub: "gid-123", reason: "สแปม" }, adminHeaders());
    assert.equal(ban.status, 200);
    assert.ok((await ban.json()).banned.some((b) => b.sub === "gid-123" && b.reason === "สแปม"));

    // session เดิมโดนเตะ → claim ไม่ผ่าน (401 เพราะ session ถูกลบ)
    assert.equal((await post("/claim", { name: "ราเมง1234", avatar: "🦊", session: sessionA })).status, 401);

    // session ที่ฝังเอง (จำลองกรณี session ยังไม่โดนลบ) → 403 จากการเช็ค banned
    api.sessions.set("injected", { sub: "gid-123", email: "user@example.com", name: "สมชาย ใจดี" });
    assert.equal((await post("/claim", { name: "ราเมง1234", avatar: "🦊", session: "injected" })).status, 403);

    // login ใหม่ → 403 ถูกแบน
    assert.equal((await post("/google-login", { credential: makeJwt(validClaims()) })).status, 403);

    // banned.json ถูกเขียน + ขึ้นใน /admin/users
    const au = await (await get("/admin/users", adminHeaders())).json();
    assert.ok(au.banned.some((b) => b.sub === "gid-123"));
    assert.ok(supabaseState.get("banned").some((b) => b.sub === "gid-123"));

    // ปลดแบน → login ได้อีก
    assert.equal((await post("/admin/unban", { sub: "gid-123" }, adminHeaders())).status, 200);
    assert.equal((await post("/google-login", { credential: makeJwt(validClaims()) })).status, 200);
  });

  // ── ประวัติเปลี่ยนชื่อ (10 อันล่าสุด) — ผู้ดูแลเท่านั้น ──
  await t.test("nickHistory: เก็บ 10 อันล่าสุด — admin เห็น, ผู้ใช้ทั่วไป/โปรไฟล์ไม่เห็น", async () => {
    // login ใหม่ (หลังปลดแบน) → session ใหม่
    const lg = await post("/google-login", { credential: makeJwt(validClaims()) });
    assert.equal(lg.status, 200);
    const sess = (await lg.json()).token;

    // ตั้งชื่อแรก + เปลี่ยนชื่ออีก 11 ครั้ง = 12 ครั้ง → เหลือแค่ 10 อันล่าสุด
    for (let i = 1; i <= 12; i++) {
      const r = await post("/claim", { name: "ประวัติ" + i, avatar: "🦊", session: sess });
      assert.equal(r.status, 200);
    }

    // identities.json เก็บ nickHistory 10 อันล่าสุด (ใหม่สุดก่อน)
    const saved = savedIdentities();
    const me = saved.find((i) => i.sub === "gid-123");
    assert.equal(me.nickname, "ประวัติ12");
    assert.equal(me.nickHistory.length, 10);
    assert.equal(me.nickHistory[0].from, "ประวัติ11");
    assert.equal(me.nickHistory[0].name, "ประวัติ12");
    assert.equal(me.nickHistory[9].from, "ประวัติ2"); // อันที่ 11 เก่าโดนตัด
    assert.equal(me.nickHistory[9].name, "ประวัติ3");

    // ผู้ดูแลเห็นผ่าน /admin/users
    const au = await (await get("/admin/users", adminHeaders())).json();
    const adm = au.identities.find((i) => i.sub === "gid-123");
    assert.equal(adm.nickHistory.length, 10);

    // ผู้ใช้ทั่วไป (ร้าน/โปรไฟล์) ไม่เห็น nickHistory
    const pub = (await (await get("/users")).json()).users.find((u) => u.name === "ประวัติ12");
    assert.equal(pub.nickHistory, undefined);
    const prof = await (await get("/profile?name=" + encodeURIComponent("ประวัติ12"))).json();
    assert.equal(prof.nickHistory, undefined);
  });

  // ── ชื่อที่เพิ่งถูกเปลี่ยนทิ้ง (กันแย่งชื่อ) ──
  await t.test("retiredName: คนอื่นแย่งชื่อที่เพิ่งเปลี่ยนทิ้งไม่ได้ (24 ชม.), เจ้าของเดิมขอคืนได้, พ้นเวลาแล้วจองได้", async () => {
    // gid-123 เปลี่ยนจาก "ประวัติ12" → "ลุงราเมง" → "ประวัติ12" โดนทิ้ง (retired)
    const lg = await post("/google-login", { credential: makeJwt(validClaims()) });
    const sess = (await lg.json()).token;
    assert.equal((await post("/claim", { name: "ลุงราเมง", avatar: "🦊", session: sess })).status, 200);
    assert.ok(api.retiredNames.has("ประวัติ12"), "ชื่อเก่าโดนเก็บเข้ารายการกันแย่ง");

    // จำลอง TTL 60 วิผ่าน (ชื่อหลุดจาก activeNames แล้ว) — เหลือแค่กันแย่ง 24 ชม. คุ้มครอง
    api.activeNames.delete("ประวัติ12");

    // คนอื่น (gid-999) แย่งไม่ได้ → 409 (กันแย่ง)
    const lg2 = await post("/google-login", { credential: makeJwt(validClaims({ sub: "gid-999", email: "other@example.com", name: "อีกคน" })) });
    const sessB2 = (await lg2.json()).token;
    const steal = await post("/claim", { name: "ประวัติ12", avatar: "🐸", session: sessB2 });
    assert.equal(steal.status, 409);
    assert.match((await steal.json()).error, /เพิ่งถูกเปลี่ยนทิ้ง/);

    // เจ้าของเดิม (gid-123) ขอคืนได้ทันที → 200
    assert.equal((await post("/claim", { name: "ประวัติ12", avatar: "🦊", session: sess })).status, 200);

    // จำลองผ่านทั้ง 60 วิ + 24 ชม. → ชื่อว่างจริง → คนอื่นจองได้
    api.activeNames.delete("ประวัติ12");
    api.retiredNames.delete("ประวัติ12");
    assert.equal((await post("/claim", { name: "ประวัติ12", avatar: "🐸", session: sessB2 })).status, 200);
  });

  // ── กดหัวใจให้เพื่อน (วันละ 1 ครั้ง, สะสมใน identities) ──
  await t.test("heart: ให้เพื่อนวันละ 1 ครั้ง, สะสมหัวใจ, ให้ตัวเอง/ซ้ำวันไม่ได้", async () => {
    // ผู้ให้ = gid-123 (ชื่อ "ผู้ให้หัวใจ") / ผู้รับ = gid-999 (ชื่อ "ผู้รับหัวใจ")
    const g = (await (await post("/google-login", { credential: makeJwt(validClaims()) })).json()).token;
    const r2 = (await (await post("/google-login", { credential: makeJwt(validClaims({ sub: "gid-999", email: "other@example.com", name: "อีกคน" })) })).json()).token;
    assert.equal((await post("/claim", { name: "ผู้ให้หัวใจ", avatar: "🦊", session: g })).status, 200);
    assert.equal((await post("/claim", { name: "ผู้รับหัวใจ", avatar: "🐸", session: r2 })).status, 200);

    // ไม่มี session → 401
    assert.equal((await post("/heart", { name: "ผู้รับหัวใจ" })).status, 401);
    // ให้ตัวเอง → 400
    assert.equal((await post("/heart", { name: "ผู้ให้หัวใจ", session: g })).status, 400);
    // ผู้รับไม่มีตัวตน → 404
    assert.equal((await post("/heart", { name: "ไม่มีตัวตน", session: g })).status, 404);

    // ให้เพื่อน → 200 + สะสม 1
    const h = await post("/heart", { name: "ผู้รับหัวใจ", session: g });
    assert.equal(h.status, 200);
    assert.equal((await h.json()).hearts, 1);
    // ให้ซ้ำวันเดียวกัน → 409
    const again = await post("/heart", { name: "ผู้รับหัวใจ", session: g });
    assert.equal(again.status, 409);
    assert.match((await again.json()).error, /วันนี้ให้หัวใจ/);

    // identities.json: ผู้รับมี hearts + heartsRecent, ผู้ให้มี heartsGiven วันนี้
    const saved = savedIdentities();
    const recv = saved.find((i) => i.nickname === "ผู้รับหัวใจ");
    assert.equal(recv.hearts, 1);
    assert.equal(recv.heartsRecent[0].from, "ผู้ให้หัวใจ");
    assert.equal(saved.find((i) => i.nickname === "ผู้ให้หัวใจ").heartsGiven.name, "ผู้รับหัวใจ");

    // /users โชว์หัวใจ (สาธารณะเห็นจำนวน)
    const { users } = await (await get("/users")).json();
    assert.equal(users.find((u) => u.name === "ผู้รับหัวใจ").hearts, 1);
    // /profile โชว์ hearts + givenToday (ส่ง session ผู้ให้ → ให้แล้ววันนี้ = true)
    const pr = await (await get("/profile?name=" + encodeURIComponent("ผู้รับหัวใจ") + "&session=" + g)).json();
    assert.equal(pr.hearts, 1);
    assert.equal(pr.givenToday, true);
    assert.equal(pr.email, undefined); // ห้ามรั่ว
    // profile ไม่มี session → givenToday = false
    const pr2 = await (await get("/profile?name=" + encodeURIComponent("ผู้รับหัวใจ"))).json();
    assert.equal(pr2.givenToday, false);

    // วันใหม่ (จำลอง heartsGiven ย้อนหลัง) → ให้ได้อีก + สะสมต่อ
    api.identities.get("gid-123").heartsGiven.date = "2000-01-01";
    const h2 = await post("/heart", { name: "ผู้รับหัวใจ", session: g });
    assert.equal(h2.status, 200);
    assert.equal((await h2.json()).hearts, 2);
  });

  // ── ร้านค้าอวตาร (ซื้อชิ้นส่วนด้วยหัวใจ) ──
  await t.test("shop: รายการสินค้า + /me คืน owned + ซื้อด้วยหัวใจ (ตัดเงิน, กันซ้ำ)", async () => {
    // รายการสินค้า
    const shop = await (await get("/shop")).json();
    assert.equal(shop.items.length, 9);
    assert.ok(shop.items.some((i) => i.id === "b4" && i.price === 50));
    // /me ไม่มี session → 401
    assert.equal((await get("/me")).status, 401);
    // login gid-999 (มี nickname "ผู้รับหัวใจ" จากเทสต์ heart)
    const r2 = (await (await post("/google-login", { credential: makeJwt(validClaims({ sub: "gid-999", email: "other@example.com", name: "อีกคน" })) })).json()).token;
    const me = await (await get("/me?session=" + r2)).json();
    assert.equal(me.nickname, "ผู้รับหัวใจ");
    assert.ok(me.owned.includes("b1") && me.owned.includes("o2"), "มีชุดฟรีครบ");
    // หัวใจไม่พอ → 400
    const poor = await post("/shop/buy", { id: "b4", session: r2 });
    assert.equal(poor.status, 400);
    // ตั้งหัวใจ 50 → ซื้อ b4 (ชามทองคำ) ได้ → เหลือ 0
    api.identities.get("gid-999").hearts = 50;
    const buy = await post("/shop/buy", { id: "b4", session: r2 });
    assert.equal(buy.status, 200);
    const bd = await buy.json();
    assert.equal(bd.hearts, 0);
    assert.ok(bd.owned.includes("b4"));
    // ซื้อซ้ำ → 409
    assert.equal((await post("/shop/buy", { id: "b4", session: r2 })).status, 409);
    // สินค้าไม่มี → 404 / ไม่มี session → 401
    assert.equal((await post("/shop/buy", { id: "zz9", session: r2 })).status, 404);
    assert.equal((await post("/shop/buy", { id: "b4" })).status, 401);
    // identities.json เก็บ owned + หัวใจโดนตัด
    const saved = savedIdentities();
    const buyer = saved.find((i) => i.sub === "gid-999");
    assert.ok(buyer.owned.includes("b4"));
    assert.equal(buyer.hearts, 0);
    // /claim เก็บ avatar token
    assert.equal((await post("/claim", { name: "ผู้รับหัวใจ", avatar: "b2c1h1f1o0", session: r2 })).status, 200);
    const after = savedIdentities().find((i) => i.sub === "gid-999");
    assert.equal(after.avatar, "b2c1h1f1o0");
  });

  // ── สตูดิโอวาดชุด (admin วาดชิ้นส่วน 16×16 → parts.json + ร้านค้า) ──
  await t.test("parts: admin อัปโหลด PNG, /parts คืน, ขึ้นร้านค้า, ซื้อได้", async () => {
    const png = makePng();
    // ไม่มี token → 401
    assert.equal((await postMultipart("/parts", { type: "b", name: "x", price: "0", img: png })).status, 401);
    // ไม่มีรูป → 400
    assert.equal((await postMultipart("/parts", { type: "b", name: "x", price: "0" }, adminHeaders())).status, 400);
    // admin อัปโหลดสำเร็จ → id ถัดไปของ type b = b6
    const save = await postMultipart("/parts", { type: "b", name: "ชามลายไทย", price: "10", img: png }, adminHeaders());
    assert.equal(save.status, 200);
    const sid = (await save.json()).id;
    assert.equal(sid, "b6");
    // /parts คืนชิ้นส่วน (มี .png field)
    const parts = await (await get("/parts")).json();
    assert.ok(parts.parts.some((p) => p.id === "b6" && p.name === "ชามลายไทย" && p.png));
    // ขึ้นร้านค้า (ตั้งราคาไว้ 10)
    const shop = await (await get("/shop")).json();
    assert.ok(shop.items.some((i) => i.id === "b6" && i.price === 10));
    // metadata และ PNG เก็บถาวรใน Supabase Storage/state
    assert.ok(supabaseState.get("parts").some((p) => p.id === "b6"));
    assert.ok(storageObjects.has("avatars/bowl/b6.png"));
    // ผู้ใช้ซื้อ custom part ได้
    const r2 = (await (await post("/google-login", { credential: makeJwt(validClaims({ sub: "gid-999", email: "other@example.com", name: "อีกคน" })) })).json()).token;
    api.identities.get("gid-999").hearts = 20;
    const buy = await post("/shop/buy", { id: "b6", session: r2 });
    assert.equal(buy.status, 200);
    assert.ok((await buy.json()).owned.includes("b6"));
    // เจอ id ซ้ำไม่ได้ (กันชน) — อัปโหลดอีกชิ้น type b → b7
    const save2 = await postMultipart("/parts", { type: "b", name: "อีกชิ้น", price: "0", img: png }, adminHeaders());
    assert.equal((await save2.json()).id, "b7");
    // ลบชิ้นส่วน (admin) → หายจาก /parts + ร้านค้า / ไม่มี token → 401
    assert.equal((await post("/parts/delete", { id: "b7" })).status, 401);
    assert.equal((await post("/parts/delete", { id: "b7" }, adminHeaders())).status, 200);
    const after = await (await get("/parts")).json();
    assert.ok(!after.parts.some((p) => p.id === "b7"), "ลบแล้วต้องหายจาก /parts");
    // ลบของที่ไม่มี → 404
    assert.equal((await post("/parts/delete", { id: "b7" }, adminHeaders())).status, 404);
  });
});
