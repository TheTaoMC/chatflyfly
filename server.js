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
const crypto = require("node:crypto");

// โหลด .env.local ถ้ามี (ไม่พึ่ง dotenv) — env จริงของระบบชนะเสมอ
// ไฟล์นี้เก็บ GOOGLE_CLIENT_ID / ADMIN_TOKEN — อย่าขึ้น GitHub (.gitignore มีอยู่แล้ว)
try {
  const envFile = path.join(__dirname, ".env.local");
  if (fs.existsSync(envFile)) {
    for (const line of fs.readFileSync(envFile, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
    }
  }
} catch { /* ไฟล์ไม่ valid ก็ข้ามไป */ }

const PORT = Number(process.env.PORT) || 3000; // Render/Fly ส่ง PORT env มาให้ — ใช้ของเดิมถ้าไม่ตั้ง
// วันไทย (Asia/Bangkok) — ใช้รีเซ็ตโควต้าต่อวัน (ให้หัวใจ/คะแนน)
const dayKey = (ms = Date.now()) => new Date(ms).toLocaleDateString("en-CA", { timeZone: "Asia/Bangkok" }); // YYYY-MM-DD
const MAX_MESSAGES = 200; // เก็บแค่ 200 ข้อความล่าสุดใน memory
const MAX_TEXT = 2000; // จำกัดความยาวข้อความ
const MAX_POSTS = 80; // ฟีดวันนี้อยู่ใน memory เท่านั้น
const MAX_POST_TEXT = 280;
const MAX_COMMENT_TEXT = 280;
const POST_TTL_MS = Number(process.env.POST_TTL_MS) || 24 * 60 * 60 * 1000;
const ROOM_TTL_MS = Number(process.env.ROOM_TTL_MS) || 30 * 60 * 1000;
const QUEUE_TTL_MS = 20 * 60 * 1000;
const MAX_ROOM_TEXT = 500;
const MAX_IMG_BYTES = 5 * 1024 * 1024; // รูปไม่เกิน 5MB
const MAX_JSON_BYTES = MAX_IMG_BYTES * 1.4 + 1024; // JSON upload (base64) ใหญ่สุด
const MAX_ADMIN_UPLOAD_BYTES = 2 * 1024 * 1024; // pixel PNG ไม่ควรใหญ่กว่านี้
const IMAGE_TTL_MS = Number(process.env.IMG_TTL_MS) || 5 * 60 * 1000; // รูปหายอัตโนมัติหลัง 5 นาที (env ใช้ทดสอบ)

// ---- ร้านค้าอวตาร (ซื้อชิ้นส่วนด้วยหัวใจ) ----
// avatar = token 5 ชั้น: b(ชาม)c(ตัว)h(หัว)f(หน้า)o(หมวก) เช่น b1c1h1f1o0
const DEFAULT_TOKEN = "b1c1h1f1o0";
const FREE_PARTS = ["b1", "b2", "b3", "c1", "c2", "c3", "h1", "h2", "h3", "f1", "f2", "f3", "o0", "o1", "o2"]; // ชุดฟรีตอนเริ่ม
const TYPE_IDS = { b: [1, 2, 3, 4, 5], c: [1, 2, 3, 4, 5], h: [1, 2, 3, 4, 5], f: [1, 2, 3, 4], o: [0, 1, 2, 3, 4] }; // variant เดิมของแต่ละชั้น (กัน id ชน)
const SHOP_ITEMS = [
  { id: "b4", name: "ชามทองคำ", price: 50, desc: "ชามหรู ระดับปรมาจารย์" },
  { id: "b5", name: "ชามซากุระ", price: 20, desc: "สีชมพูหวานกิมจิ" },
  { id: "c4", name: "เอี๊ยมเชฟเหลือง", price: 15, desc: "ชุดทำงานเชฟตัวจริง" },
  { id: "c5", name: "เสื้อฮาวาย", price: 25, desc: "มาพักร้อนที่ร้านกัน" },
  { id: "h4", name: "ผมฟ้าคราม", price: 15, desc: "ย้อมฟ้า โคตรเท่" },
  { id: "h5", name: "ผมทอง", price: 30, desc: "สว่างไสวทั้งร้าน" },
  { id: "f4", name: "ตาปีศาจแดง", price: 25, desc: "สายมังกรเท่านั้น" },
  { id: "o3", name: "กิมหยง", price: 10, desc: "หัวหน้าวัยรุ่น" },
  { id: "o4", name: "หมวกเชฟทอง", price: 60, desc: "สุดยอดตำนานราเมง" },
];

// ---- Google login (บังคับ) ----
// ต้องสร้าง OAuth Client ID (Web application) ที่ console.cloud.google.com แล้วใส่ env:
//   GOOGLE_CLIENT_ID=xxx.apps.googleusercontent.com
// ผู้ใช้ต้อง login ด้วย Google ก่อนถึงจะจองชื่อ/ส่งข้อความได้ — แต่ในแชทใช้ชื่อเล่น (ไร้ตัวตน)
// email + ชื่อจริง เก็บไว้หลังบ้านใน identities.json สำหรับผู้ดูแลเท่านั้น (ดู /admin)
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_JWKS_URL = process.env.GOOGLE_JWKS_URL || "https://www.googleapis.com/oauth2/v3/certs"; // เปลี่ยนได้ตอนทดสอบ local
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || ""; // token หน้า/API ผู้ดูแล — ถ้าไม่ตั้ง = ปิดไม่ให้เข้าถึง
const IDENTITIES_FILE = process.env.IDENTITIES_FILE || path.join(__dirname, "identities.json"); // หลังบ้าน (เก็บถาวร)
const BANNED_FILE = process.env.BANNED_FILE || path.join(__dirname, "banned.json"); // blocklist (sub ของ Google)

const UPLOADS_DIR = path.join(__dirname, "uploads");
const AVATARS_DIR = process.env.AVATARS_DIR || path.join(__dirname, "avatars");
// ชิ้นส่วนอวตารที่วาดเอง (สตูดิโอ) — เก็บใน parts.json (committable → อยู่ข้าม deploy)
const PARTS_FILE = process.env.PARTS_FILE || path.join(__dirname, "parts.json");
let customParts = []; // [{id, type, name, colorA, colorB, map[], price}]
try {
  customParts = JSON.parse(fs.readFileSync(PARTS_FILE, "utf8"));
} catch { /* ยังไม่มีไฟล์ = ว่าง */ }
const saveParts = () => fs.writeFileSync(PARTS_FILE, JSON.stringify(customParts, null, 2));
const IMG_EXT = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif", webp: "image/webp" };
const AUDIO_EXT = { webm: "audio/webm", m4a: "audio/mp4", mp3: "audio/mpeg" }; // ข้อความเสียง (kind=voice)
const ALLOWED_EXT = { ...IMG_EXT, ...AUDIO_EXT }; // ใช้ตอนเสิร์ฟ /uploads/<file>
// Render อยู่หลัง reverse proxy เสมอ จึงใช้ X-Forwarded-For ได้; local ปิดไว้กัน header ปลอม
const TRUST_PROXY = process.env.TRUST_PROXY === "true" || process.env.RENDER === "true";

// จำกัด body ระหว่างรับจริง ๆ ไม่ใช่รออ่านจนหมด (กัน memory DoS จาก chunked request)
async function readBody(req, maxBytes = MAX_JSON_BYTES) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      const error = new Error("request too large");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function hasExpectedFileSignature(buf, ext) {
  if (ext === "png") return buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
  if (ext === "jpg" || ext === "jpeg") return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  if (ext === "gif") return buf.length >= 6 && (buf.subarray(0, 6).toString() === "GIF87a" || buf.subarray(0, 6).toString() === "GIF89a");
  if (ext === "webp") return buf.length >= 12 && buf.subarray(0, 4).toString() === "RIFF" && buf.subarray(8, 12).toString() === "WEBP";
  if (ext === "webm") return buf.length >= 4 && buf.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (ext === "mp3") return buf.length >= 3 && (buf.subarray(0, 3).toString() === "ID3" || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0));
  if (ext === "m4a") return buf.length >= 12 && buf.subarray(4, 8).toString() === "ftyp";
  return false;
}

function publicPart(part) {
  const layer = { b: "bowl", c: "body", h: "head", f: "face", o: "hat" }[part.type];
  let version = "";
  try { version = Math.floor(fs.statSync(path.join(AVATARS_DIR, layer, `${part.id}.png`)).mtimeMs).toString(36); } catch { /* ไฟล์หาย = browser จะแสดง fallback */ }
  return { ...part, version };
}

// หน้าเว็บผู้ดูแล — โชว์คนออนไลน์ + identity (email/ชื่อจริง) ที่เก็บหลังบ้าน
const ADMIN_HTML = `<!DOCTYPE html>
<html lang="th"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ผู้ดูแลร้านราเมง</title><style>
*{box-sizing:border-box}body{font-family:ui-monospace,Consolas,monospace;background:radial-gradient(circle at top,#2b1f4c 0,#110d1b 44%,#0b0911 100%);color:#eeeaf7;margin:0;padding:34px max(20px,calc((100vw - 1240px)/2));min-height:100vh}
h1{margin:0 0 22px;padding:20px 22px;border:1px solid #6b58a1;border-left:6px solid #ffcc00;border-radius:12px;background:linear-gradient(135deg,#2d2250,#171126);color:#ffe28a;font-size:25px;letter-spacing:.5px;box-shadow:0 14px 36px rgba(0,0,0,.3)}
h2{margin:32px 0 12px;color:#ffe1a3;font-size:16px;letter-spacing:.4px;border:0;padding:0}h2::before{content:"";display:inline-block;width:4px;height:18px;margin-right:9px;vertical-align:-3px;border-radius:99px;background:#ffcc00}
p{color:#bdb4d4;line-height:1.6;margin:10px 0}body>p:nth-of-type(1),body>p:nth-of-type(2),body>p:nth-of-type(3){display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 14px;margin:0;border:1px solid #433560;background:#1a1428}body>p:nth-of-type(1){border-radius:10px 10px 0 0}body>p:nth-of-type(3){border-radius:0 0 10px 10px;margin-bottom:18px}
input,select{min-height:38px;padding:8px 10px;border:1px solid #5a4a78;border-radius:7px;background:#100c1b;color:#fff;font:inherit;outline:none}input:focus,select:focus{border-color:#ffcc00;box-shadow:0 0 0 3px rgba(255,204,0,.15)}#q{min-width:min(340px,100%)}
button{min-height:38px;padding:8px 14px;border:1px solid #8466c2;border-radius:7px;background:linear-gradient(#4a3675,#342657);color:#fff1a8;font-weight:700;cursor:pointer;font-family:inherit;transition:transform .12s,filter .12s,box-shadow .12s}button:hover{filter:brightness(1.14);transform:translateY(-1px);box-shadow:0 5px 14px rgba(0,0,0,.28)}button:active{transform:none;box-shadow:none}
table{border-collapse:separate;border-spacing:0;width:100%;margin-bottom:22px;overflow:hidden;border:1px solid #48385f;border-radius:10px;background:#171120}th,td{border-bottom:1px solid #302640;padding:10px 11px;text-align:left;font-size:12px}th{background:#2a2040;color:#d9d0eb;font-size:11px;letter-spacing:.35px;text-transform:uppercase}td{color:#e4dfee}tr:last-child td{border-bottom:0}tr:hover td{background:#21192f}.bad{color:#ff8780;min-height:20px}
.cards{display:grid;grid-template-columns:repeat(4,minmax(130px,1fr));gap:12px;margin:18px 0}.card{position:relative;overflow:hidden;background:linear-gradient(145deg,#241a35,#171120);border:1px solid #4a3965;border-radius:10px;padding:16px;text-align:left;box-shadow:0 8px 20px rgba(0,0,0,.18)}.card::after{content:"";position:absolute;right:-18px;bottom:-28px;width:80px;height:80px;border-radius:50%;background:rgba(154,116,234,.11)}.card b{font-size:27px;display:block}.card span{position:relative;color:#bdb4d4;font-size:12px;z-index:1}
#latestBox{padding:14px 16px;border:1px solid #47375f;border-radius:10px;background:#171120;margin-bottom:12px}#latestBox>b{color:#ffe1a3}.msg2{background:#21192d;border:1px solid #3e3052;border-radius:7px;padding:8px 10px;margin-top:7px;font-size:12px;color:#e8e2f2;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
/* สตูดิโอวาดชุด */
.srow{display:grid;grid-template-columns:170px 1fr 190px;gap:10px;margin:12px 0}.srow select,.srow input{width:100%;min-width:0}
#sTools{display:flex;gap:4px;margin-bottom:6px}
#sTools button{margin:0;width:auto;padding:4px 8px;font-size:11px}
#sTools button.on{background:#ffcc00;color:#12100e}
#sPalette{display:flex;flex-wrap:wrap;gap:3px;margin:6px 0}
#sPalette button{width:20px;height:20px;margin:0;padding:0;border:2px solid #3a2a1a;box-shadow:none}
#sPalette button.onA{border-color:#ffcc00}
#sPalette button.onB{border-color:#ff6ec7}
.studioBody{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-start}
#sGrid{display:grid;grid-template-columns:repeat(16,13px);gap:0;border:2px solid #5a4a3a;width:fit-content}
#sGrid button{width:13px;height:13px;margin:0;padding:0;background:#241b14;border:1px solid #33281c;box-shadow:none}
#sGrid button:hover{border-color:#ffcc00}
#sFile{width:100%;padding:12px;border:1px dashed #70579b;border-radius:8px;background:#171120}#sPreview{min-height:0}#studioPreview img,#sPreview img{width:112px;height:112px;object-fit:contain;image-rendering:pixelated;display:block;border:2px solid #70579b;border-radius:8px;background:#100c1b}
#sErr{color:#ff6ec7;font-size:13px;margin-top:6px;min-height:16px}
.part-item{display:flex;align-items:center;gap:14px;padding:11px 13px;margin-top:8px;border:1px solid #413154;border-radius:9px;background:#1b1527;color:#e9e3f3}.part-item img{width:88px;height:88px;object-fit:contain;image-rendering:pixelated;border-radius:7px;background:#100c1b}.part-item .part-meta{flex:1;min-width:0}.part-item b{display:block;color:#ffe1a3}.part-item span{font-size:11px;color:#bdb4d4}.part-item button.preview{border-color:#6c96c6;background:linear-gradient(#365f88,#294767);color:#dceeff}.part-item button.edit{border-color:#8b6ec2;background:linear-gradient(#563c82,#3d2a60);color:#eee2ff}.part-item button.delete{border-color:#a94b62;background:linear-gradient(#6d2f43,#512333);color:#ffd9dc}
#outfitPreview{display:flex;justify-content:center;align-items:center;min-height:270px;padding:16px;border:1px solid #4b3b62;border-radius:10px;background:radial-gradient(circle at 50% 20%,#2c2140,#120d1c 72%)}.admin-avatar-stack{position:relative;width:152px;height:256px}.admin-avatar-stack img{position:absolute;inset:0;width:100%;height:100%;object-fit:contain;image-rendering:pixelated}.outfit-help{font-size:12px;color:#bdb4d4}
#partsTabs{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 12px}#partsTabs button{min-height:34px;padding:6px 11px;font-size:12px;border-color:#514064;background:#21192d;color:#cfc5df}#partsTabs button.on{border-color:#ffcc00;background:#ffcc00;color:#20152e}
@media(max-width:760px){body{padding:18px 12px}h1{font-size:20px;padding:16px}.cards{grid-template-columns:repeat(2,minmax(0,1fr))}.srow{grid-template-columns:1fr}table{display:block;overflow-x:auto;white-space:nowrap}body>p:nth-of-type(1),body>p:nth-of-type(2),body>p:nth-of-type(3){align-items:stretch}input,#q{width:100%;min-width:0}}
</style></head><body>
<h1>🍜 ศูนย์ควบคุมร้านราเมง</h1>
<p>Admin token: <input id="tok" type="password" placeholder="ADMIN_TOKEN"> <button id="loadBtn" type="button">โหลดข้อมูล</button></p>
<p>เหตุผลการแบน: <input id="reason" placeholder="ไม่บังคับ"> (กดปุ่ม แบน ในตารางด้านล่าง)</p>
<p>ค้นหา: <input id="q" placeholder="ชื่อเล่น / อีเมล / ชื่อจริง"> (กรองทั้ง 3 ตาราง)</p>
<div id="err" class="bad"></div>
<div class="cards" id="cards"></div>
<div id="latestBox"></div>
<h2>คนที่ออนไลน์อยู่ (ชื่อเล่น → ตัวตนจริง)</h2><table id="t1"></table>
<h2>ทุกคนที่เคยเข้าสู่ระบบ (เก็บหลังบ้าน)</h2><table id="t2"></table>
<h2>Blocklist (โดนแบนแล้ว — login ไม่ได้)</h2><table id="t3"></table>
<h2>🛠 สตูดิโออวตาร</h2>
<p>อัปโหลด PNG โปร่งใสที่มีสัดส่วนเดียวกับตัวละคร เลือกเลเยอร์ ตั้งชื่อและราคา จากนั้นบันทึกเพื่อให้ผู้เล่นเลือกใช้ได้</p>
<div class="srow">
  <select id="sType"><option value="b">🍜 ชาม</option><option value="c">👕 ตัว</option><option value="h">🙂 หัว</option><option value="f">😊 หน้า</option><option value="o">🎩 หมวก</option></select>
  <input id="sName" placeholder="ชื่อชิ้นส่วน" maxlength="30">
  <input id="sPrice" type="number" min="0" max="1000" placeholder="ราคา 💗 (0=ฟรี)">
</div>
<div style="margin:10px 0">
  <input type="file" id="sFile" accept="image/png,image/jpeg,image/webp" style="color:#e8e6f0">
</div>
<div id="sPreview" style="margin:10px 0"></div>
<div id="sMode" style="font-size:12px;color:#bdb4d4;margin:8px 0">โหมด: เพิ่มชิ้นส่วนใหม่</div>
<button id="sSave">💾 บันทึกชิ้นส่วน</button> <button id="sCancelEdit" type="button" style="display:none">ยกเลิกแก้ไข</button>
<div id="sErr"></div>
<h2>👗 พรีวิวการแต่งตัว</h2>
<p class="outfit-help">กด <b>พรีวิว</b> บนชิ้นส่วนเพื่อสลับชิ้นในเลเยอร์นั้น — ตัวละครหลักอยู่หลังสุดเสมอ</p>
<div id="outfitPreview"></div>
<h2>🧩 ชิ้นส่วนทั้งหมด</h2>
<div id="partsTabs"></div>
<div id="partsList"></div>
<script nonce="__CSP_NONCE__">
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const fmt=ms=>ms?new Date(ms).toLocaleString('th-TH'):'-';
const fmtT=ms=>new Date(ms).toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'});
const tok=()=>document.getElementById('tok').value;
const reason=()=>document.getElementById('reason').value;
let DATA=null;
async function load(){
  const r=await fetch('/admin/users',{headers:{Authorization:'Bearer '+tok()}});
  const d=await r.json();
  if(!r.ok){document.getElementById('err').textContent='❌ '+(d.error||'fail');return}
  document.getElementById('err').textContent='';
  DATA=d;
  renderCards();
  render();
}
function renderCards(){
  if(!DATA) return;
  const card=(n,t,c)=>'<div class="card"><b style="color:'+c+'">'+n+'</b><span>'+t+'</span></div>';
  document.getElementById('cards').innerHTML=
    card(DATA.online.length,'คนออนไลน์','#7ee08a')+
    card(DATA.identities.length,'เคยเข้าสู่ระบบ','#7ec8e0')+
    card(DATA.banned.length,'คนแบน','#ff6e5c')+
    card(DATA.stats?DATA.stats.messages:0,'ข้อความทั้งหมด','#ffcc00');
  const msgs=(DATA.latest||[]).map(m=>'<div class="msg2">['+fmtT(m.time)+'] <b>'+esc(m.name)+'</b>: '+(m.img?'📷 [รูปภาพ]':esc(m.text))+'</div>').join('');
  document.getElementById('latestBox').innerHTML='<b>💬 ข้อความล่าสุด</b>'+(msgs||'<div class="msg2">ยังไม่มีข้อความ</div>');
}
function render(){
  if(!DATA) return;
  const q=(document.getElementById('q').value||'').trim().toLowerCase();
  const hit=o=>!q||[o.nickname,o.name,o.realName,o.email,o.sub].some(v=>String(v||'').toLowerCase().includes(q))||(o.nickHistory||[]).some(x=>String(x.name||'').toLowerCase().includes(q));
  const btn=(action,args,label)=>'<button type="button" data-admin-action="'+action+'" data-sub="'+esc(args[0])+'">'+label+'</button>';
  const cells=(o,cols)=>cols.map(c=>'<td>'+esc(o[c])+'</td>').join('');
  const hist=o=>{const h=o.nickHistory||[];if(!h.length)return '<td>—</td>';
    const lines=h.map(x=>(x.from?esc(x.from)+' → ':'ตั้งชื่อ ')+esc(x.name)+' ('+fmt(x.at)+')');
    const last=h[0];return '<td title="'+esc(lines.join(String.fromCharCode(10)))+'">'+esc(last.from?last.from+' → '+last.name:'ตั้งชื่อ '+last.name)+'</td>';};
  const t1=DATA.online.filter(hit).map(o=>'<tr>'+cells({name:o.name,avatar:o.avatar,realName:o.realName,email:o.email,lastSeen:fmt(o.lastSeen)},['name','avatar','realName','email','lastSeen'])
    +'<td>'+btn('ban',[o.gid,o.realName,o.email],'แบน')+'</td></tr>').join('');
  const t2=DATA.identities.filter(hit).map(o=>'<tr>'+cells({sub:o.sub,nick:o.nickname||'—',name:o.name,email:o.email,points:o.points||0,hearts:o.hearts||0,day:o.dayPoints||0,firstSeen:fmt(o.firstSeen),lastSeen:fmt(o.lastSeen)},['sub','nick','name','email','points','hearts','day','firstSeen','lastSeen'])
    +hist(o)+'<td>'+btn('ban',[o.sub,o.name,o.email],'แบน')+'</td></tr>').join('');
  const t3=DATA.banned.filter(hit).map(o=>'<tr>'+cells({sub:o.sub,nick:o.nickname||'—',name:o.name,email:o.email,reason:o.reason,bannedAt:fmt(o.bannedAt)},['sub','nick','name','email','reason','bannedAt'])
    +'<td>'+btn('unban',[o.sub],'ปลดแบน')+'</td></tr>').join('');
  document.getElementById('t1').innerHTML='<tr><th>ชื่อเล่น</th><th>อวตาร</th><th>ชื่อจริง</th><th>อีเมล</th><th>ออนไลน์ล่าสุด</th><th></th></tr>'+t1;
  document.getElementById('t2').innerHTML='<tr><th>sub</th><th>ชื่อเล่น</th><th>ชื่อจริง</th><th>อีเมล</th><th>แต้ม</th><th>หัวใจ</th><th>วันนี้</th><th>เข้าแรก</th><th>ล่าสุด</th><th>เปลี่ยนชื่อ</th><th></th></tr>'+t2;
  document.getElementById('t3').innerHTML='<tr><th>sub</th><th>ชื่อเล่น</th><th>ชื่อจริง</th><th>อีเมล</th><th>เหตุผล</th><th>แบนเมื่อ</th><th></th></tr>'+t3;
  document.querySelectorAll('[data-admin-action]').forEach(button=>button.addEventListener('click',()=>button.dataset.adminAction==='ban'?ban(button.dataset.sub):unban(button.dataset.sub)));
}
async function call(path,body){
  const r=await fetch(path,{method:'POST',headers:{Authorization:'Bearer '+tok(),'Content-Type':'application/json'},body:JSON.stringify(body)});
  const d=await r.json();
  if(!r.ok){document.getElementById('err').textContent='❌ '+(d.error||'fail');return}
  load();
}
async function ban(sub,name,email){await call('/admin/ban',{sub,reason:reason()});}
async function unban(sub){await call('/admin/unban',{sub});}
document.getElementById('loadBtn').addEventListener('click',load);
document.getElementById('q').addEventListener('input',render);
// ── สตูดิโอวาดชุด (พรีวิว sprite + วาด 16×16) ──
const shade=(hex,f)=>{const n=parseInt(hex.slice(1),16);return 'rgb('+Math.round(((n>>16)&255)*f)+','+Math.round(((n>>8)&255)*f)+','+Math.round((n&255)*f)+')'};
const SMAPS={
  head:[".....HHHHHH.....","...HHHHHHHHHH...","..HHHHHHHHHHHH..","..HHHHHHHHHHHH..","..HH........HH..",".HH..........HH.",".HH..........HH.","................"],
  face:[".....E....E.....",".......M........"],
  body:["....CCCCCCCC....","...CCCCCCCCCC...","...CCCCCCCCCC...","...CCCCCCCCCC...","....CCCCCCCC...."],
  bowl:["....BBBBBBBB....","..BBBBBBBBBBBB..","..BBBBBBBBBBBB.."],
  chef:[".....OOOOOO.....","....OOOOOOOO....","....OOOOOOOO....","....OOOOOOOO...."],
};
const SCOLS={b:'#5b7fa6',c:'#e8e6f0',h:'#3a2a20',f:'#3a2a20',o:'#ffffff'};
let EDITING=null,EDIT_PARTS=[],OUTFIT={},PART_TAB='all';
document.getElementById('sFile').addEventListener('change',(e)=>{
  const f=e.target.files[0];if(!f)return;
  const r=new FileReader();r.onload=()=>{
    document.getElementById('sPreview').innerHTML='<img src="'+r.result+'" style="width:128px;height:128px;image-rendering:pixelated;border:2px solid #5a4a3a">';
  };r.readAsDataURL(f);
});
async function sSave(){
  const type=document.getElementById('sType').value,name=document.getElementById('sName').value.trim();
  const price=Math.max(0,Math.round(Number(document.getElementById('sPrice').value)||0));
  const err=document.getElementById('sErr');
  const file=document.getElementById('sFile').files[0];
  if(!name)return err.textContent='ใส่ชื่อชิ้นส่วนก่อน';
  if(!file&&!EDITING)return err.textContent='เลือกรูป PNG ก่อน';
  if(!tok())return err.textContent='ต้องใส่ ADMIN_TOKEN ก่อน';
  const fd=new FormData();
  fd.append('name',name);fd.append('price',price);
  if(EDITING)fd.append('id',EDITING);else fd.append('type',type);
  if(file)fd.append('img',file);
  const r=await fetch(EDITING?'/parts/update':'/parts',{method:'POST',headers:{Authorization:'Bearer '+tok()},body:fd});
  const d=await r.json();
  if(!r.ok)return err.textContent='❌ '+(d.error||'fail');
  err.textContent='✅ '+(EDITING?'แก้ไข':'บันทึก')+'แล้ว id='+d.id+(price?' — ขึ้นร้านค้าแล้ว 🛒':' — ทุกคนใช้ฟรี');
  cancelEdit(false);
  refreshParts();
}
function editPart(id){
  const p=EDIT_PARTS.find(x=>x.id===id);if(!p)return;
  EDITING=id;
  document.getElementById('sType').value=p.type;document.getElementById('sType').disabled=true;
  document.getElementById('sName').value=p.name;document.getElementById('sPrice').value=p.price||'';
  document.getElementById('sPreview').innerHTML='<img src="'+esc(p.png)+'?v='+Date.now()+'" style="width:128px;height:128px;image-rendering:pixelated;border:2px solid #5a4a3a">';
  document.getElementById('sMode').textContent='โหมด: แก้ไข '+p.id+' — เปลี่ยน PNG ได้ หรือปล่อยว่างเพื่อใช้รูปเดิม';
  document.getElementById('sSave').textContent='💾 บันทึกการแก้ไข';document.getElementById('sCancelEdit').style.display='inline-block';
  document.getElementById('sName').focus();
}
function cancelEdit(clear=true){
  EDITING=null;document.getElementById('sType').disabled=false;
  document.getElementById('sMode').textContent='โหมด: เพิ่มชิ้นส่วนใหม่';document.getElementById('sSave').textContent='💾 บันทึกชิ้นส่วน';document.getElementById('sCancelEdit').style.display='none';
  document.getElementById('sFile').value='';document.getElementById('sPreview').innerHTML='';
  if(clear){document.getElementById('sName').value='';document.getElementById('sPrice').value='';}
}
document.getElementById('sCancelEdit').addEventListener('click',()=>cancelEdit());
async function refreshParts(){
  const r=await fetch('/parts');
  const d=await r.json();
  const list=document.getElementById('partsList');list.innerHTML='';
  const arr=d.parts||[];
  EDIT_PARTS=arr;
  const tabLabels={all:'ทั้งหมด',b:'🍜 ชาม',c:'👕 ตัว',h:'🙂 หัว',f:'😊 หน้า',o:'🎩 หมวก'};
  const tabs=document.getElementById('partsTabs');
  tabs.innerHTML=Object.entries(tabLabels).map(([type,label])=>'<button class="'+(PART_TAB===type?'on':'')+'" data-type="'+type+'">'+label+' ('+(type==='all'?arr.length:arr.filter(p=>p.type===type).length)+')</button>').join('');
  tabs.querySelectorAll('button').forEach(button=>button.addEventListener('click',()=>{PART_TAB=button.dataset.type;refreshParts();}));
  ['b','c','h','f','o'].forEach(type=>{if(!OUTFIT[type]||!arr.some(p=>p.id===OUTFIT[type])){const latest=arr.filter(p=>p.type===type).at(-1);OUTFIT[type]=latest?latest.id:'';}});
  renderOutfitPreview();
  if(!arr.length){list.innerHTML='<div class="msg2">ยังไม่มีชิ้นส่วนวาดเอง</div>';return}
  const cacheBust=Date.now();
  const shown=PART_TAB==='all'?arr:arr.filter(p=>p.type===PART_TAB);
  if(!shown.length){list.innerHTML='<div class="msg2">ยังไม่มีชิ้นส่วนในแท็บนี้</div>';return}
  shown.forEach(p=>{const div=document.createElement('div');div.className='part-item';
    div.innerHTML='<img src="'+esc(p.png)+'?v='+cacheBust+'" alt=""><div class="part-meta"><b>'+esc(p.name)+'</b><span>ID '+esc(p.id)+' · ชั้น '+esc(p.type)+' · '+(p.price?p.price+' 💗':'ฟรี')+'</span></div>';
    const preview=document.createElement('button');preview.className='preview';preview.textContent='พรีวิว';preview.style.marginLeft='auto';preview.addEventListener('click',()=>{OUTFIT[p.type]=p.id;renderOutfitPreview();});
    const edit=document.createElement('button');edit.className='edit';edit.textContent='แก้ไข';edit.style.marginLeft='8px';edit.addEventListener('click',()=>editPart(p.id));
    const b=document.createElement('button');b.className='delete';b.textContent='ลบ';b.style.marginLeft='8px';b.addEventListener('click',()=>delPart(p.id));
    div.appendChild(preview);div.appendChild(edit);div.appendChild(b);list.appendChild(div);});
}
function renderOutfitPreview(){
  const target=document.getElementById('outfitPreview');
  const layers=['/simple/body.png'];
  ['b','c','h','f','o'].forEach(type=>{const part=EDIT_PARTS.find(p=>p.id===OUTFIT[type]);if(part)layers.push(part.png+'?v='+Date.now());});
  target.innerHTML='<div class="admin-avatar-stack">'+layers.map(src=>'<img src="'+esc(src)+'" alt="">').join('')+'</div>';
}
async function delPart(id){
  const r=await fetch('/parts/delete',{method:'POST',headers:{Authorization:'Bearer '+tok(),'Content-Type':'application/json'},body:JSON.stringify({id})});
  const d=await r.json();
  if(!r.ok){document.getElementById('err').textContent='❌ '+(d.error||'fail');return}
  refreshParts();
}
document.getElementById('sSave').addEventListener('click',sSave);
refreshParts();
</script></body></html>`;

// ---- multipart/form-data parser (ไม่พึ่ง dependency) ----
function parseMultipart(buf, boundary) {
  const result = {};
  const sep = Buffer.from("--" + boundary);
  let pos = 0;
  while (true) {
    const start = buf.indexOf(sep, pos);
    if (start === -1) break;
    const next = buf.indexOf(sep, start + sep.length);
    const part = buf.slice(start + sep.length, next === -1 ? buf.length : next);
    const headerEnd = part.indexOf("\r\n\r\n");
    if (headerEnd === -1) { pos = next === -1 ? buf.length : next; continue; }
    const headers = part.slice(0, headerEnd).toString();
    const body = part.slice(headerEnd + 4, part.length - 2); // strip trailing \r\n
    const nameMatch = headers.match(/name="([^"]+)"/);
    const filenameMatch = headers.match(/filename="([^"]+)"/);
    if (nameMatch) {
      if (filenameMatch) {
        result[nameMatch[1]] = { data: body, filename: filenameMatch[1] };
      } else {
        result[nameMatch[1]] = body.toString();
      }
    }
    pos = next === -1 ? buf.length : next;
  }
  return result;
}

// ---- state ----
const messages = []; // [{id, name, text?, img?, time}]
const posts = []; // [{id, name, text, time, expiresAt, comments: []}] — เก็บชั่วคราว ไม่เขียนลงดิสก์
const matchQueue = new Map(); // sub -> {sub, name, tags, target, joinedAt}
const randomRooms = new Map(); // id -> {id, users, prompt, expiresAt, messages, game}
const OPENING_PROMPTS = ["ถ้าต้องกินเมนูเดิมได้ทุกวัน จะเลือกอะไร?", "เพลงที่กำลังวนฟังอยู่คือเพลงอะไร?", "ช่วงนี้มีเรื่องเล็ก ๆ อะไรที่ทำให้ยิ้มบ้าง?", "ถ้าพรุ่งนี้ว่างทั้งวัน อยากไปไหน?", "ของกินที่คนอื่นชอบ แต่เราไม่อินคืออะไร?"];
const GAME_PROMPTS = ["มื้อดึกในอุดมคติคืออะไร?", "สิ่งแรกที่จะซื้อถ้ามีวันหยุดเพิ่ม 1 วัน?", "อีโมจิ 3 ตัวที่แทนวันนี้ของคุณ", "เมนูที่กินแล้วหายเหนื่อยที่สุด?"];

// ---- ชื่อที่ถูกใช้อยู่ (จองชื่อกันซ้ำ) ----
// ชื่อจะว่างอัตโนมัติเมื่อเจ้าของเงียบเกิน 60 วิ (เผื่อ background tab ที่ browser throttle timer)
// แต่ละ entry เก็บ gid (sub จาก Google) — ชื่อผูกกับบัญชี Google: เจ้าของเดิม (gid ตรง) F5/เปลี่ยนชื่อ
// กลับมาขอคืนได้ทันที แต่ถ้าเป็นคนอื่น (gid ไม่ตรง) ถึงจะ 409 กันแย่งชื่อ
const ACTIVE_TTL_MS = Number(process.env.NAME_TTL_MS) || 60_000; // env ใช้ทดสอบ
const activeNames = new Map(); // name -> {avatar, lastSeen, gid, email, realName}
const touch = (name) => {
  if (!name) return;
  const cur = activeNames.get(name);
  activeNames.set(name, cur ? { ...cur, lastSeen: Date.now() } : { avatar: "👤", lastSeen: Date.now() });
};
// ชื่อที่เพิ่งถูกเปลี่ยนทิ้ง (เจ้าของเปลี่ยนชื่อใหม่) — กันคนอื่นแย่งชื่อ 24 ชม. แต่เจ้าของเดิม (gid) ขอคืนได้เสมอ
const NAME_RETIRE_MS = Number(process.env.NAME_RETIRE_MS) || 24 * 60 * 60 * 1000; // env ใช้ทดสอบ
const retiredNames = new Map(); // name -> {gid, freedAt}
setInterval(() => {
  const now = Date.now();
  for (const [n, v] of activeNames) if (now - v.lastSeen > ACTIVE_TTL_MS) activeNames.delete(n);
  for (const [n, v] of retiredNames) if (now - v.freedAt > NAME_RETIRE_MS) retiredNames.delete(n);
}, 10_000);
// ponytail: ถ้าเจ้าของเก่าหายไปแล้วชื่อถูกคนอื่นจอง แล้วเจ้าของเก่ากลับมา poll อีกที
// จะถูก touch ให้คืนชีพอีกครั้ง (edge case หายาก — ยอมรับได้ ไม่งั้นต้องทำ session/login)

// ล้างโฟลเดอร์รูปตอนเปิด server (memory ก็ว่างด้วย — ของเก่าทิ้งไปหมด)
fs.rmSync(UPLOADS_DIR, { recursive: true, force: true });
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ลบไฟล์รูป (ไม่สน error — ไฟล์อาจถูกลบไปแล้ว)
const unlinkImg = (imgPath) => imgPath && fs.unlink(path.join(UPLOADS_DIR, path.basename(imgPath)), () => {});

// ไล่ลบรูป/เสียงที่อายุเกิน 5 นาที ทั้งไฟล์และข้อความ ออกจากทุกคน
setInterval(() => {
  const now = Date.now();
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if ((m.img || m.voice) && now - m.time > IMAGE_TTL_MS) {
      unlinkImg(m.img);
      unlinkImg(m.voice);
      messages.splice(i, 1);
    }
  }
}, 30_000);

// ฟีด "วันนี้": ลบทั้งโพสต์และคอมเมนต์เมื่อครบเวลา เพื่อไม่กินพื้นที่ host ฟรี
const cleanPosts = () => {
  const now = Date.now();
  for (let i = posts.length - 1; i >= 0; i--) if (posts[i].expiresAt <= now) posts.splice(i, 1);
};
setInterval(cleanPosts, 60_000);

const cleanMatching = () => {
  const now = Date.now();
  for (const [sub, item] of matchQueue) if (now - item.joinedAt > QUEUE_TTL_MS) matchQueue.delete(sub);
  for (const [id, room] of randomRooms) if (room.expiresAt <= now) randomRooms.delete(id);
};
setInterval(cleanMatching, 60_000);
const sharesInterest = (a, b) => a.tags.some((tag) => b.tags.includes(tag));
const roomFor = (sub) => {
  cleanMatching();
  return [...randomRooms.values()].find((room) => room.users.some((u) => u.sub === sub));
};
const roomPublic = (room) => room && ({ id: room.id, users: room.users.map(({ name }) => ({ name })), prompt: room.prompt, expiresAt: room.expiresAt, messages: room.messages, game: room.game });

// เก็บข้อความลง memory (ตัดส่วนเกิน + ลบไฟล์ของข้อความรูป/เสียงที่หลุดวง)
const pushMessage = (msg) => {
  messages.push(msg);
  if (messages.length > MAX_MESSAGES) {
    for (const m of messages.splice(0, messages.length - MAX_MESSAGES)) {
      unlinkImg(m.img);
      unlinkImg(m.voice);
    }
  }
};

const json = (res, status, obj) => {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
};

// Rate limit แบบ in-memory: พอสำหรับกันลองของ/ยิงบอทที่ชั้นแอป (ควรเสริม WAF ของ Fly/Cloudflare หากโตขึ้น)
const rateBuckets = new Map();
function clientIp(req) {
  const forwarded = TRUST_PROXY ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "";
  return forwarded || req.socket.remoteAddress || "unknown";
}
function allowRequest(req, limit, windowMs = 60_000) {
  const key = `${clientIp(req)}:${limit}`;
  const now = Date.now();
  const bucket = rateBuckets.get(key) || [];
  const fresh = bucket.filter((at) => now - at < windowMs);
  if (fresh.length >= limit) return false;
  fresh.push(now);
  rateBuckets.set(key, fresh);
  return true;
}
setInterval(() => {
  const cutoff = Date.now() - 60_000;
  for (const [key, times] of rateBuckets) {
    const fresh = times.filter((at) => at >= cutoff);
    if (fresh.length) rateBuckets.set(key, fresh); else rateBuckets.delete(key);
  }
}, 60_000).unref();

// ---- Google login: ตรวจสอบ ID token (JWT RS256) ด้วย crypto ในตัว ไม่พึ่ง library ----
const sessions = new Map(); // sessionToken -> {sub, email, name} (restart แล้วต้อง login ใหม่)
const identities = new Map(); // sub -> {sub, email, name, firstSeen, lastSeen} — เก็บถาวรใน identities.json (หลังบ้าน)
function loadIdentities() {
  try {
    const arr = JSON.parse(fs.readFileSync(IDENTITIES_FILE, "utf8"));
    (Array.isArray(arr) ? arr : []).forEach((i) => i && i.sub && identities.set(i.sub, i));
  } catch { /* ยังไม่มีไฟล์ */ }
}
function saveIdentities() {
  try { fs.writeFileSync(IDENTITIES_FILE, JSON.stringify([...identities.values()], null, 2)); } catch { /* ไม่ fatal */ }
}
loadIdentities();

// ---- Blocklist (ban) — ใช้ sub ของ Google เป็นกุญแจ เก็บใน banned.json ----
const banned = new Map(); // sub -> {sub, email, name, reason, bannedAt}
function loadBanned() {
  try {
    const arr = JSON.parse(fs.readFileSync(BANNED_FILE, "utf8"));
    (Array.isArray(arr) ? arr : []).forEach((b) => b && b.sub && banned.set(b.sub, b));
  } catch { /* ยังไม่มีไฟล์ */ }
}
function saveBanned() {
  try { fs.writeFileSync(BANNED_FILE, JSON.stringify([...banned.values()], null, 2)); } catch { /* ไม่ fatal */ }
}
loadBanned();

// ---- คะแนน + เลเวล (นักชิมมือใหม่ → ปรมาจารย์ราเมง) ----
// กิจกรรมทุกอย่างให้คะแนน เก็บใน identities (ถาวรข้าม restart) — เลเวลคำนวณจากคะแนน
// เกณฑ์แบบโค้งยากขึ้นเรื่อยๆ (MMORPG style) — ถึงขั้นสูงสุดต้อง ~3 เดือน (คุยทั้งวันที่โควต้า 100/วัน)
// อยากให้สมาชิกอยู่กันนานๆ ไม่ตันไว
const LEVELS = [
  { min: 0, title: "นักชิมมือใหม่", icon: "🍙" },
  { min: 300, title: "นักกินประจำ", icon: "🍜" },
  { min: 900, title: "นักชิมตัวจริง", icon: "🥢" },
  { min: 2100, title: "เชฟฝึกหัด", icon: "🍥" },
  { min: 4500, title: "เซียนราเมง", icon: "🏆" },
  { min: 9000, title: "ปรมาจารย์ราเมง", icon: "👑" },
];
// กันฟาร์มคะแนน: cooldown (ได้คะแนน 1 ครั้งต่อช่วงเวลา) + โควต้าวันละไม่เกิน DAILY_POINT_CAP ต่อคน
const POINT_COOLDOWN_MS = Number(process.env.POINT_COOLDOWN_MS) || 5000; // ส่งถี่แค่ไหน ข้อความขึ้น แต่คะแนนให้ทุก 5 วิ
const DAILY_POINT_CAP = Number(process.env.DAILY_POINT_CAP) || 100; // วันละ 100 แต้ม/คน → ถึงขั้นสูงสุดต้อง ~8 วัน
const levelFor = (points) => { let lv = LEVELS[0]; for (const l of LEVELS) if (points >= l.min) lv = l; return lv; };
const addPoints = (sub, n, kind) => {
  if (!sub) return { awarded: false };
  const now = Date.now();
  const day = Math.floor(now / 86400000); // เปลี่ยนวัน = reset โควต้า
  let id = identities.get(sub) || { sub, firstSeen: now };
  // สถิตินับทุกครั้ง (แม้สแปม — แยกจากคะแนน) ใช้ในหน้าโปรไฟล์
  if (kind === "msg") id.msgCount = (id.msgCount || 0) + 1;
  else if (kind === "voice") id.voiceCount = (id.voiceCount || 0) + 1;
  else if (kind === "img") id.imgCount = (id.imgCount || 0) + 1;
  // 1) cooldown — ส่งถี่เกินไปในรอบนี้ ไม่ได้คะแนน (ข้อความยังขึ้นปกติ)
  if (id.lastPointAt && now - id.lastPointAt < POINT_COOLDOWN_MS) { identities.set(sub, id); saveIdentities(); return { awarded: false, cooldown: true }; }
  if (id.pointDay !== day) { id.pointDay = day; id.dayPoints = 0; }
  // 2) โควต้าวันนี้เต็ม — ไม่ได้คะแนนเพิ่มจนกว่าจะเปลี่ยนวัน
  if ((id.dayPoints || 0) >= DAILY_POINT_CAP) { identities.set(sub, id); saveIdentities(); return { awarded: false, capped: true, dayLeft: 0 }; }
  id.points = (id.points || 0) + n;
  id.dayPoints = (id.dayPoints || 0) + n;
  id.lastPointAt = now;
  id.lastSeen = now;
  identities.set(sub, id);
  saveIdentities();
  return { awarded: true, dayLeft: Math.max(0, DAILY_POINT_CAP - id.dayPoints) };
};

let jwksCache = new Map(); // url -> {keys, fetchedAt}
async function fetchJwks(url) {
  const c = jwksCache.get(url);
  if (c && Date.now() - c.fetchedAt < 6 * 60 * 60 * 1000) return c.keys;
  const res = await fetch(url);
  if (!res.ok) throw new Error("jwks fetch failed");
  const { keys } = await res.json();
  jwksCache.set(url, { keys, fetchedAt: Date.now() });
  return keys;
}
const b64u = (s) => Buffer.from(s.replace(/-/g, "+").replace(/_/g, "/"), "base64");

async function verifyGoogleJwt(token, opts = {}) {
  const clientId = opts.clientId || GOOGLE_CLIENT_ID;
  const jwksUrl = opts.jwksUrl || GOOGLE_JWKS_URL;
  if (!clientId) return { error: "server ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID" };
  const parts = String(token).split(".");
  if (parts.length !== 3) return { error: "token ไม่ถูกต้อง" };
  let header, payload;
  try {
    header = JSON.parse(b64u(parts[0]));
    payload = JSON.parse(b64u(parts[1]));
  } catch {
    return { error: "token ไม่ถูกต้อง" };
  }
  const now = Date.now() / 1000;
  if (payload.iss !== "https://accounts.google.com" && payload.iss !== "accounts.google.com") return { error: "issuer ไม่ถูกต้อง" };
  if (payload.aud !== clientId) return { error: "client id ไม่ตรงกับที่ตั้งไว้" };
  if (!payload.sub) return { error: "token ไม่มี sub" };
  if (payload.exp && payload.exp < now - 300) return { error: "token หมดอายุ" };
  if (header.alg !== "RS256") return { error: "algorithm ไม่รองรับ" };
  let keys;
  try {
    keys = await fetchJwks(jwksUrl);
  } catch {
    return { error: "ติดต่อ Google ไม่ได้" };
  }
  const key = keys.find((k) => k.kid === header.kid && k.kty === "RSA");
  if (!key) return { error: "ไม่พบ key ที่ตรงกับ token" };
  try {
    const pub = crypto.createPublicKey({ key: { kty: "RSA", n: key.n, e: key.e }, format: "jwk" });
    if (!crypto.verify("RSA-SHA256", Buffer.from(parts[0] + "." + parts[1]), pub, b64u(parts[2]))) return { error: "ลายเซ็นไม่ตรง" };
  } catch {
    return { error: "verify ล้มเหลว" };
  }
  return { ok: true, sub: payload.sub, email: payload.email, name: payload.name };
}

// ---- HTTP ----
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const method = req.method;
  const cspNonce = crypto.randomBytes(16).toString("base64");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), geolocation=(), payment=()");
  res.setHeader("X-Frame-Options", "DENY");
  if (url.pathname === "/" || url.pathname === "/admin") {
    res.setHeader("Content-Security-Policy", `default-src 'self'; script-src 'self' https://accounts.google.com 'nonce-${cspNonce}'; style-src 'self' 'unsafe-inline' https://accounts.google.com; img-src 'self' data: https://*.giphy.com; connect-src 'self' https://api.giphy.com https://accounts.google.com; frame-src https://accounts.google.com; media-src 'self'; base-uri 'self'; frame-ancestors 'none'`);
  }

  const isStatic = method === "GET" && (url.pathname === "/" || url.pathname === "/admin" || url.pathname.startsWith("/uploads/") || url.pathname.startsWith("/avatars/") || url.pathname === "/simple/body.png");
  const rateLimit = url.pathname === "/google-login" ? 20 : (url.pathname === "/upload" ? 10 : ((method === "POST" && url.pathname.startsWith("/parts")) ? 20 : (method === "GET" ? 180 : 100)));
  if (!isStatic && !allowRequest(req, rateLimit)) {
    res.setHeader("Retry-After", "60");
    json(res, 429, { error: "ส่งคำขอถี่เกินไป กรุณารอสักครู่" });
    return;
  }

  // หน้า UI — ใส่ GOOGLE_CLIENT_ID ลงไปใน index.html ตอนเสิร์ฟ (ไม่ต้องแก้ไฟล์)
  if (method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(fs.readFileSync(path.join(__dirname, "index.html"), "utf8").replace("__GOOGLE_CLIENT_ID__", GOOGLE_CLIENT_ID).replace("__CSP_NONCE__", cspNonce));
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

  // เสิร์ฟ avatar PNG files (/avatars/bowl/b1.png, /avatars/body/c1.png, ...)
  if (method === "GET" && url.pathname.startsWith("/avatars/")) {
    const parts = url.pathname.split("/");
    if (parts.length !== 4) { res.writeHead(404); res.end("not found"); return; }
    const layer = parts[2];
    const file = path.basename(parts[3]);
    const validLayers = ["bowl", "body", "head", "face", "hat"];
    if (!validLayers.includes(layer) || !/^[a-z]\d+\.png$/.test(file)) {
      res.writeHead(404); res.end("not found"); return;
    }
    fs.readFile(path.join(AVATARS_DIR, layer, file), (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
      res.end(data);
    });
    return;
  }

  // ตัวละครหลักชั่วคราวหนึ่งเลเยอร์; เลเยอร์แต่งตัวจะเพิ่มภายหลัง
  if (method === "GET" && url.pathname === "/simple/body.png") {
    fs.readFile(path.join(__dirname, "simple", "body.png"), (err, data) => {
      if (err) { res.writeHead(404); res.end("not found"); return; }
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
      res.end(data);
    });
    return;
  }

  // ดึงข้อความทั้งหมด (client poll ทุก 1.5 วิ) — ส่ง ?name=xxx มาด้วยเพื่อเป็น heartbeat ยืนยันว่ายังอยู่
  if (method === "GET" && url.pathname === "/messages") {
    // ห้ามให้ client เลือกชื่อ heartbeat เอง ไม่งั้นใช้ปลอมการออนไลน์ของคนอื่นได้
    const session = sessions.get(String(url.searchParams.get("session") || ""));
    const identity = session && identities.get(session.sub);
    if (identity?.nickname) touch(identity.nickname);
    json(res, 200, { messages });
    return;
  }

  // ฟีดชั่วคราว: เก็บเฉพาะ 24 ชั่วโมงล่าสุดใน memory (restart ก็หายด้วย)
  if (method === "GET" && url.pathname === "/posts") {
    cleanPosts();
    json(res, 200, { posts: [...posts].sort((a, b) => b.time - a.time) });
    return;
  }

  if (method === "POST" && (url.pathname === "/posts" || url.pathname === "/posts/comment")) {
    let body;
    try { body = (await readBody(req, 16 * 1024)).toString(); } catch (e) { json(res, e.status || 400, { error: "request too large" }); return; }
    let data;
    try { data = JSON.parse(body); } catch { json(res, 400, { error: "invalid json" }); return; }
    const sess = sessions.get(String(data.session || ""));
    if (!sess) { json(res, 401, { error: "ต้องเข้าสู่ระบบด้วย Google ก่อน" }); return; }
    if (banned.has(sess.sub)) { json(res, 403, { error: "บัญชีนี้ถูกแบนแล้ว" }); return; }
    const identity = identities.get(sess.sub);
    const name = String(data.name || "").trim().slice(0, 50);
    if (!identity || !name || identity.nickname !== name) { json(res, 401, { error: "ต้องจองชื่อก่อน" }); return; }
    const text = String(data.text || "").trim().slice(0, url.pathname === "/posts" ? MAX_POST_TEXT : MAX_COMMENT_TEXT);
    if (!text) { json(res, 400, { error: "ข้อความว่างไม่ได้" }); return; }
    cleanPosts();
    if (url.pathname === "/posts") {
      const now = Date.now();
      posts.unshift({ id: `${now}-${Math.random().toString(36).slice(2, 7)}`, name, text, time: now, expiresAt: now + POST_TTL_MS, comments: [] });
      if (posts.length > MAX_POSTS) posts.length = MAX_POSTS;
      json(res, 200, { ok: true });
      return;
    }
    const post = posts.find((p) => p.id === String(data.postId || ""));
    if (!post) { json(res, 404, { error: "โพสต์นี้หมดอายุแล้ว" }); return; }
    post.comments.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name, text, time: Date.now() });
    json(res, 200, { ok: true });
    return;
  }

  // สุ่มโต๊ะ: ห้องไม่ถาวร, ใช้ interest ที่ทับกัน และเลือกได้ 2 หรือ 5 คน
  if (url.pathname.startsWith("/match/")) {
    let body = "";
    try { if (method === "POST") body = (await readBody(req, 16 * 1024)).toString(); } catch (e) { json(res, e.status || 400, { error: "request too large" }); return; }
    let data = {};
    try { if (body) data = JSON.parse(body); } catch { json(res, 400, { error: "invalid json" }); return; }
    const session = method === "GET" ? url.searchParams.get("session") : data.session;
    const sess = sessions.get(String(session || ""));
    if (!sess) { json(res, 401, { error: "ต้องเข้าสู่ระบบด้วย Google ก่อน" }); return; }
    if (banned.has(sess.sub)) { json(res, 403, { error: "บัญชีนี้ถูกแบนแล้ว" }); return; }
    const identity = identities.get(sess.sub);
    if (!identity || !identity.nickname) { json(res, 401, { error: "ต้องจองชื่อก่อน" }); return; }
    cleanMatching();

    if (method === "GET" && url.pathname === "/match/status") {
      const room = roomFor(sess.sub), waiting = matchQueue.get(sess.sub);
      json(res, 200, { room: roomPublic(room), waiting: waiting ? { target: waiting.target, tags: waiting.tags, joinedAt: waiting.joinedAt } : null });
      return;
    }
    if (method === "POST" && url.pathname === "/match/leave") {
      matchQueue.delete(sess.sub);
      const room = roomFor(sess.sub);
      if (room) {
        room.users = room.users.filter((u) => u.sub !== sess.sub);
        if (room.users.length < 2) randomRooms.delete(room.id);
        else if (room.game && room.game.answers.length >= room.users.length) room.game.done = true;
      }
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && url.pathname === "/match/join") {
      if (roomFor(sess.sub)) { json(res, 409, { error: "คุณอยู่ในโต๊ะแล้ว" }); return; }
      const target = Number(data.target);
      const tags = [...new Set((Array.isArray(data.tags) ? data.tags : []).map((v) => String(v).trim()).filter((v) => /^[\p{L}\p{N} -]{1,20}$/u.test(v)))].slice(0, 3);
      if (![2, 5].includes(target) || !tags.length) { json(res, 400, { error: "เลือกความสนใจอย่างน้อย 1 อย่าง และจำนวนคน 2 หรือ 5 คน" }); return; }
      const me = { sub: sess.sub, name: identity.nickname, tags, target, joinedAt: Date.now() };
      matchQueue.set(sess.sub, me);
      const candidates = [...matchQueue.values()].filter((item) => item.target === target && item.sub !== me.sub && sharesInterest(me, item)).sort((a, b) => a.joinedAt - b.joinedAt);
      if (candidates.length >= target - 1) {
        const users = [me, ...candidates.slice(0, target - 1)];
        const room = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, users: users.map(({ sub, name }) => ({ sub, name })), prompt: OPENING_PROMPTS[Math.floor(Math.random() * OPENING_PROMPTS.length)], expiresAt: Date.now() + ROOM_TTL_MS, messages: [], game: null };
        users.forEach((u) => matchQueue.delete(u.sub));
        randomRooms.set(room.id, room);
        json(res, 200, { ok: true, room: roomPublic(room) });
      } else json(res, 200, { ok: true, waiting: true });
      return;
    }
    const room = roomFor(sess.sub);
    if (!room) { json(res, 404, { error: "ยังไม่มีโต๊ะ หรือโต๊ะหมดเวลาแล้ว" }); return; }
    if (method === "POST" && url.pathname === "/match/send") {
      const text = String(data.text || "").trim().slice(0, MAX_ROOM_TEXT);
      if (!text) { json(res, 400, { error: "ข้อความว่างไม่ได้" }); return; }
      room.messages.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, name: identity.nickname, text, time: Date.now() });
      if (room.messages.length > 120) room.messages.splice(0, room.messages.length - 120);
      json(res, 200, { ok: true });
      return;
    }
    if (method === "POST" && url.pathname === "/match/game") {
      if (!room.game || room.game.done) room.game = { id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, prompt: GAME_PROMPTS[Math.floor(Math.random() * GAME_PROMPTS.length)], answers: [], done: false };
      const answer = String(data.answer || "").trim().slice(0, 280);
      if (!answer) { json(res, 200, { ok: true, room: roomPublic(room) }); return; }
      room.game.answers = room.game.answers.filter((a) => a.sub !== sess.sub);
      room.game.answers.push({ sub: sess.sub, name: identity.nickname, text: answer });
      if (room.game.answers.length >= room.users.length) room.game.done = true;
      json(res, 200, { ok: true, room: roomPublic(room) });
      return;
    }
    json(res, 404, { error: "not found" });
    return;
  }

  // เข้าสู่ระบบด้วย Google — รับ ID token มาตรวจสอบ แล้วคืน session ของเราเอง (เก็บใน localStorage)
  if (method === "POST" && url.pathname === "/google-login") {
    let body;
    try { body = (await readBody(req, 32 * 1024)).toString(); } catch (e) { json(res, e.status || 400, { error: "request too large" }); return; }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const r = await verifyGoogleJwt(String(data.credential || ""));
    if (r.error) {
      json(res, 401, { error: "Google ยืนยันตัวตนไม่ผ่าน: " + r.error });
      return;
    }
    // ตรวจ blocklist — โดนแบนแล้ว login ไม่ได้เด็ดขาด
    if (banned.has(r.sub)) {
      json(res, 403, { error: "บัญชีนี้ถูกแบนแล้ว", banned: true });
      return;
    }
    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { sub: r.sub, email: r.email || "", name: r.name || "" });
    // เก็บ email/ชื่อจริงไว้หลังบ้าน (ผู้ดูแลเท่านั้น) — ผู้ใช้คนอื่นไม่เห็นเด็ดขาด
    const id = identities.get(r.sub) || { sub: r.sub, firstSeen: Date.now() };
    id.email = r.email || "";
    id.name = r.name || "";
    id.lastSeen = Date.now();
    identities.set(r.sub, id);
    saveIdentities();
    // คืน nickname ที่เคยตั้งไว้กับบัญชีนี้ (ถ้ามี) — login รอบหน้าจะได้ไม่ต้องตั้งชื่อใหม่
    json(res, 200, { ok: true, token, name: id.name, email: id.email, nickname: id.nickname || "" });
    return;
  }

  // จองชื่อก่อนเข้าแชท — ต้อง login Google แล้ว (session) ชื่อผูกกับบัญชี (gid): ซ้ำ/แย่งชื่อโดน 409
  if (method === "POST" && url.pathname === "/claim") {
    let body;
    try { body = (await readBody(req, 16 * 1024)).toString(); } catch (e) { json(res, e.status || 400, { error: "request too large" }); return; }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const sess = sessions.get(String(data.session || ""));
    if (!sess) {
      json(res, 401, { error: "ต้องเข้าสู่ระบบด้วย Google ก่อน" });
      return;
    }
    if (banned.has(sess.sub)) {
      json(res, 403, { error: "บัญชีนี้ถูกแบนแล้ว" });
      return;
    }
    const name = String(data.name || "").trim().slice(0, 50);
    if (!name) {
      json(res, 400, { error: "name required" });
      return;
    }
    const existing = activeNames.get(name);
    // gid ตรง (เจ้าของเดิม) = ขอคืนได้ / ไม่มี gid (entry จาก heartbeat ล้วนๆ) = พ้นสภาพ / gid ต่าง = แย่งชื่อ
    if (existing && existing.gid && existing.gid !== sess.sub) {
      json(res, 409, { error: "ชื่อนี้มีคนใช้อยู่" });
      return;
    }
    // ชื่อที่เพิ่งถูกเปลี่ยนทิ้ง (ภายใน 24 ชม.) — คนอื่นแย่งไม่ได้ แต่เจ้าของเดิมขอคืนได้เสมอ
    const retired = retiredNames.get(name);
    if (retired && retired.gid !== sess.sub && Date.now() - retired.freedAt <= NAME_RETIRE_MS) {
      json(res, 409, { error: "ชื่อนี้เพิ่งถูกเปลี่ยนทิ้ง ยังใช้ไม่ได้ (24 ชม.)" });
      return;
    }
    const avatar = String(data.avatar || "").trim().slice(0, 40) || DEFAULT_TOKEN;
    activeNames.set(name, { avatar, lastSeen: Date.now(), gid: sess.sub, email: sess.email, realName: sess.name });
    // จำชื่อเล่น/อวตารไว้กับบัญชี (sub) — login ครั้งถัดไปไม่ต้องตั้งใหม่ (เก็บหลังบ้าน identities.json)
    const idn = identities.get(sess.sub);
    if (idn) {
      const prev = idn.nickname || "";
      idn.nickname = name;
      idn.avatar = avatar;
      idn.lastSeen = Date.now();
      if (prev !== name) {
        // ชื่อเก่าโดนทิ้ง → กันคนอื่นแย่ง 24 ชม. (เจ้าของเดิมขอคืนได้)
        if (prev) retiredNames.set(prev, { gid: sess.sub, freedAt: Date.now() });
        // ประวัติเปลี่ยนชื่อ — 10 อันล่าสุด (ใหม่สุดก่อน) เก็บไว้กับบัญชี ดูได้เฉพาะผู้ดูแลที่ /admin
        const h = idn.nickHistory || [];
        h.unshift({ from: prev || null, name, at: Date.now() });
        idn.nickHistory = h.slice(0, 10);
      }
      saveIdentities();
    }
    json(res, 200, { ok: true });
    return;
  }

  // รายชื่อคนที่อยู่ในห้องตอนนี้ (ฝั่งซ้าย "ร้านตัวละคร") — เอาคะแนน/เลเวลจาก identities มาโชว์ด้วย
  if (method === "GET" && url.pathname === "/users") {
    json(res, 200, {
      users: [...activeNames.entries()].map(([name, v]) => {
        const id = v.gid ? identities.get(v.gid) : null;
        const points = id ? id.points || 0 : 0;
        const lv = levelFor(points);
        const idx = LEVELS.indexOf(lv);
        const next = LEVELS[idx + 1] || null; // null = ถึงขั้นสูงสุดแล้ว
        return {
          name,
          avatar: v.avatar,
          points,
          title: lv.title,
          icon: lv.icon,
          nextTitle: next ? next.title : "",
          nextIcon: next ? next.icon : "",
          toNext: next ? Math.max(0, next.min - points) : 0,
          pct: next ? Math.min(100, Math.round(((points - lv.min) / (next.min - lv.min)) * 100)) : 100,
          dayPoints: id ? id.dayPoints || 0 : 0,
          dayCap: DAILY_POINT_CAP,
          hearts: id ? id.hearts || 0 : 0, // หัวใจที่สะสมไว้ (แลกของในอนาคต)
        };
      }),
    });
    return;
  }

  // ชิ้นส่วนที่วาดเอง (สตูดิโอ) — client ต้องรู้ map เพื่อเรนเดอร์อวตารของทุกคน
  if (method === "GET" && url.pathname === "/parts") {
    json(res, 200, { parts: customParts.map(publicPart) });
    return;
  }
  // อัปโหลดชิ้นส่วนใหม่ (ผู้ดูแล) — รับ PNG via FormData → เก็บไฟล์ + parts.json
  if (method === "POST" && url.pathname === "/parts") {
    if (!ADMIN_TOKEN || req.headers.authorization !== "Bearer " + ADMIN_TOKEN) {
      json(res, 401, { error: "unauthorized — ต้องใช้ ADMIN_TOKEN" });
      return;
    }
    // parse multipart/form-data manually
    const boundary = req.headers["content-type"]?.match(/boundary=(.+)/)?.[1];
    if (!boundary) { json(res, 400, { error: "missing multipart boundary" }); return; }
    let buf;
    try { buf = await readBody(req, MAX_ADMIN_UPLOAD_BYTES); } catch (e) { json(res, e.status || 400, { error: "file too large (max 2MB)" }); return; }
    const parts = parseMultipart(buf, boundary);
    const type = String(parts.type || "").trim();
    if (!"bchof".includes(type) || type.length !== 1) { json(res, 400, { error: "type ต้องเป็น b/c/h/f/o" }); return; }
    const name = String(parts.name || "").trim().slice(0, 30);
    if (!name) { json(res, 400, { error: "name required" }); return; }
    const price = Math.max(0, Math.min(1000, Math.round(Number(parts.price) || 0)));
    if (!parts.img || !parts.img.data || !hasExpectedFileSignature(parts.img.data, "png")) { json(res, 400, { error: "ต้องอัปโหลดรูป PNG ที่ถูกต้อง" }); return; }
    // id ถัดไปของ type นี้
    const used = new Set((TYPE_IDS[type] || []).map((n) => type + n));
    customParts.forEach((p) => p.type === type && used.add(p.id));
    let n = type === "o" ? 5 : 1;
    while (used.has(type + n)) n++;
    const id = type + n;
    // บันทึกรูป PNG ลง avatars/<layer>/<id>.png
    const layerDir = { b: "bowl", c: "body", h: "head", f: "face", o: "hat" }[type];
    const dir = path.join(AVATARS_DIR, layerDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + ".png"), parts.img.data);
    const part = { id, type, name, price, png: "/avatars/" + layerDir + "/" + id + ".png" };
    customParts.push(part);
    saveParts();
    json(res, 200, { ok: true, id: part.id });
    return;
  }
  // แก้ชื่อ/ราคา และแทนที่ PNG ของชิ้นส่วนเดิมได้ โดยคง id และเลเยอร์ไว้
  if (method === "POST" && url.pathname === "/parts/update") {
    if (!ADMIN_TOKEN || req.headers.authorization !== "Bearer " + ADMIN_TOKEN) {
      json(res, 401, { error: "unauthorized — ต้องใช้ ADMIN_TOKEN" });
      return;
    }
    const boundary = req.headers["content-type"]?.match(/boundary=(.+)/)?.[1];
    if (!boundary) { json(res, 400, { error: "missing multipart boundary" }); return; }
    let uploadBuf;
    try { uploadBuf = await readBody(req, MAX_ADMIN_UPLOAD_BYTES); } catch (e) { json(res, e.status || 400, { error: "file too large (max 2MB)" }); return; }
    const form = parseMultipart(uploadBuf, boundary);
    const id = String(form.id || "").trim();
    const part = customParts.find((item) => item.id === id);
    if (!part) { json(res, 404, { error: "ไม่พบชิ้นส่วน" }); return; }
    const name = String(form.name || "").trim().slice(0, 30);
    if (!name) { json(res, 400, { error: "name required" }); return; }
    const price = Math.max(0, Math.min(1000, Math.round(Number(form.price) || 0)));
    part.name = name;
    part.price = price;
    if (form.img?.data?.length) {
      if (!hasExpectedFileSignature(form.img.data, "png")) { json(res, 400, { error: "ต้องอัปโหลดรูป PNG ที่ถูกต้อง" }); return; }
      const layerDir = { b: "bowl", c: "body", h: "head", f: "face", o: "hat" }[part.type];
      fs.writeFileSync(path.join(AVATARS_DIR, layerDir, part.id + ".png"), form.img.data);
    }
    saveParts();
    json(res, 200, { ok: true, id: part.id });
    return;
  }
  // ลบชิ้นส่วนวาดเอง (ผู้ดูแล) — อวตารที่ใส่ชิ้นส่วนนี้จะคืนเป็นชุดฟรีอัตโนมัติ
  if (method === "POST" && url.pathname === "/parts/delete") {
    if (!ADMIN_TOKEN || req.headers.authorization !== "Bearer " + ADMIN_TOKEN) {
      json(res, 401, { error: "unauthorized — ต้องใช้ ADMIN_TOKEN" });
      return;
    }
    let body;
    try { body = (await readBody(req, 16 * 1024)).toString(); } catch (e) { json(res, e.status || 400, { error: "request too large" }); return; }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const id = String(data.id || "").trim();
    const before = customParts.length;
    customParts = customParts.filter((p) => p.id !== id);
    if (customParts.length === before) { json(res, 404, { error: "ไม่พบชิ้นส่วนนี้" }); return; }
    saveParts();
    json(res, 200, { ok: true });
    return;
  }
  // ร้านค้าอวตาร — รายการสินค้า (ราคาเป็นหัวใจ) รวมชิ้นส่วนวาดเองที่ตั้งราคา
  if (method === "GET" && url.pathname === "/shop") {
    const custom = customParts.filter((p) => p.price > 0).map((p) => ({ id: p.id, name: p.name, price: p.price, desc: "ชิ้นส่วนวาดเอง (สตูดิโอ)" }));
    json(res, 200, { items: [...SHOP_ITEMS, ...custom] });
    return;
  }
  // สถานะของ session นี้ (nickname/avatar/owned/hearts) — ใช้แต่งตัว + ซื้อของ
  if (method === "GET" && url.pathname === "/me") {
    const s = sessions.get(String(url.searchParams.get("session") || ""));
    if (!s) { json(res, 401, { error: "ต้องเข้าสู่ระบบ" }); return; }
    const id = identities.get(s.sub);
    if (!id) { json(res, 404, { error: "ไม่พบผู้ใช้" }); return; }
    if (!id.owned) id.owned = [...FREE_PARTS];
    json(res, 200, { nickname: id.nickname || "", avatar: id.avatar || DEFAULT_TOKEN, owned: id.owned, hearts: id.hearts || 0 });
    return;
  }
  // ซื้อชิ้นส่วนอวตารด้วยหัวใจ — เพิ่มเข้าคลัง (owned) เก็บถาวรใน identities.json
  if (method === "POST" && url.pathname === "/shop/buy") {
    let body;
    try { body = (await readBody(req, 16 * 1024)).toString(); } catch (e) { json(res, e.status || 400, { error: "request too large" }); return; }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const sess = sessions.get(String(data.session || ""));
    if (!sess) { json(res, 401, { error: "ต้องเข้าสู่ระบบด้วย Google ก่อน" }); return; }
    if (banned.has(sess.sub)) { json(res, 403, { error: "บัญชีนี้ถูกแบนแล้ว" }); return; }
    const idn = identities.get(sess.sub);
    if (!idn) { json(res, 401, { error: "ต้องจองชื่อก่อน" }); return; }
    const buyId = String(data.id || "");
    const item = SHOP_ITEMS.find((x) => x.id === buyId) || customParts.find((p) => p.price > 0 && p.id === buyId) || null;
    if (!item) { json(res, 404, { error: "ไม่พบสินค้านี้" }); return; }
    if (!idn.owned) idn.owned = [...FREE_PARTS];
    if (idn.owned.includes(item.id)) { json(res, 409, { error: "มีชิ้นส่วนนี้แล้ว" }); return; }
    const h = idn.hearts || 0;
    if (h < item.price) { json(res, 400, { error: `หัวใจไม่พอ (ต้องการ ${item.price}, มี ${h})` }); return; }
    idn.hearts = h - item.price;
    idn.owned.push(item.id);
    saveIdentities();
    json(res, 200, { ok: true, hearts: idn.hearts, owned: idn.owned });
    return;
  }

  // กดหัวใจให้เพื่อน — ให้ได้ 1 ครั้ง/วัน (ต่อคนที่ให้) หัวใจสะสมไว้กับบัญชีผู้รับ (แลกของในอนาคต)
  if (method === "POST" && url.pathname === "/heart") {
    let body;
    try { body = (await readBody(req, 16 * 1024)).toString(); } catch (e) { json(res, e.status || 400, { error: "request too large" }); return; }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const sess = sessions.get(String(data.session || ""));
    if (!sess) {
      json(res, 401, { error: "ต้องเข้าสู่ระบบด้วย Google ก่อน" });
      return;
    }
    if (banned.has(sess.sub)) {
      json(res, 403, { error: "บัญชีนี้ถูกแบนแล้ว" });
      return;
    }
    const name = String(data.name || "").trim().slice(0, 50);
    if (!name) {
      json(res, 400, { error: "name required" });
      return;
    }
    const giver = identities.get(sess.sub);
    if (!giver) {
      json(res, 401, { error: "ต้องจองชื่อก่อน" });
      return;
    }
    // หาผู้รับ — ออนไลน์ (มี gid) หรือมี identity ตามชื่อเล่น
    const act = activeNames.get(name);
    let recv = (act && act.gid && identities.get(act.gid)) || null;
    if (!recv) recv = [...identities.values()].find((i) => i.nickname === name) || null;
    if (!recv) {
      json(res, 404, { error: "ไม่พบผู้ใช้นี้" });
      return;
    }
    if (recv.sub === sess.sub) {
      json(res, 400, { error: "ให้หัวใจตัวเองไม่ได้" });
      return;
    }
    if (banned.has(recv.sub)) {
      json(res, 400, { error: "ผู้ใช้นี้ถูกแบนแล้ว" });
      return;
    }
    // วันละ 1 ครั้ง (ต่อคนที่ให้)
    const today = dayKey();
    if (giver.heartsGiven && giver.heartsGiven.date === today) {
      json(res, 409, { error: "วันนี้ให้หัวใจไปแล้ว (1 ครั้ง/วัน)" });
      return;
    }
    recv.hearts = (recv.hearts || 0) + 1;
    const recent = recv.heartsRecent || [];
    recent.unshift({ from: giver.nickname || name, at: Date.now() });
    recv.heartsRecent = recent.slice(0, 5);
    giver.heartsGiven = { date: today, name: recv.nickname || name };
    saveIdentities();
    json(res, 200, { ok: true, hearts: recv.hearts, givenToday: true });
    return;
  }

  // ส่งข้อความตัวหนังสือ
  if (method === "POST" && url.pathname === "/send") {
    let body;
    try { body = (await readBody(req, 16 * 1024)).toString(); } catch (e) { json(res, e.status || 400, { error: "request too large" }); return; }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    // บังคับ Google login — ต้องมี session ถึงจะส่งข้อความได้
    const sessSend = sessions.get(String(data.session || ""));
    if (!sessSend) {
      json(res, 401, { error: "ต้องเข้าสู่ระบบด้วย Google ก่อน" });
      return;
    }
    if (banned.has(sessSend.sub)) {
      json(res, 403, { error: "บัญชีนี้ถูกแบนแล้ว" });
      return;
    }
    // input validation (trust boundary)
    const identity = identities.get(sessSend.sub);
    const name = identity?.nickname || "";
    const text = String(data.text || "").trim().slice(0, MAX_TEXT);
    if (!name || !text) {
      json(res, 400, { error: "name and text required" });
      return;
    }
    touch(name);
    // ชื่อมาจาก identity ของ session เท่านั้น — request ปลอมชื่อคนอื่นไม่ได้
    pushMessage({ id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), name, text, time: Date.now() });
    const pt = addPoints(sessSend.sub, 2, "msg"); // ส่งข้อความ = +2 แต้ม (ถ้าไม่สแปม/ไม่เต็มโควต้า)
    json(res, 200, { ok: true, rewarded: pt.awarded, dayLeft: pt.dayLeft });
    return;
  }

  // อัปโหลดรูป (ส่งเป็น base64 ใน JSON — ไม่ต้อง parse multipart ให้ยุ่งยาก)
  if (method === "POST" && url.pathname === "/upload") {
    let body;
    try { body = (await readBody(req, MAX_JSON_BYTES)).toString(); } catch (e) { json(res, e.status || 400, { error: "file too large (max 5MB)" }); return; }
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
    // บังคับ Google login — ต้องมี session ถึงจะส่งรูปได้
    const sessUp = sessions.get(String(data.session || ""));
    if (!sessUp) {
      json(res, 401, { error: "ต้องเข้าสู่ระบบด้วย Google ก่อน" });
      return;
    }
    if (banned.has(sessUp.sub)) {
      json(res, 403, { error: "บัญชีนี้ถูกแบนแล้ว" });
      return;
    }
    const identity = identities.get(sessUp.sub);
    const name = identity?.nickname || "";
    const ext = String(data.ext || "").toLowerCase();
    const isVoice = data.kind === "voice";
    const exts = isVoice ? AUDIO_EXT : IMG_EXT; // รูป = jpg/png/gif/webp, เสียง = webm/m4a/mp3
    if (!name || !exts[ext]) {
      json(res, 400, { error: "name required and only " + (isVoice ? "webm/m4a/mp3" : "jpg/png/gif/webp") + " allowed" });
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
    if (!hasExpectedFileSignature(buf, ext)) {
      json(res, 400, { error: "file content does not match its type" });
      return;
    }
    touch(name);
    // ชื่อไฟล์เราสร้างเองทั้งหมด — ไม่เอา filename จาก user (กัน disguised file)
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    fs.writeFileSync(path.join(UPLOADS_DIR, filename), buf);
    const msg = { id: Date.now() + "-" + Math.random().toString(36).slice(2, 7), name, text: "", time: Date.now() };
    if (isVoice) msg.voice = `/uploads/${filename}`; // ข้อความเสียง (ลบหลัง 5 นาทีเหมือนรูป)
    else msg.img = `/uploads/${filename}`;
    pushMessage(msg);
    const pt = addPoints(sessUp.sub, 3, isVoice ? "voice" : "img"); // ส่งรูป/GIF/เสียง = +3 แต้ม (ถ้าไม่สแปม/ไม่เต็มโควต้า)
    json(res, 200, { ok: true, rewarded: pt.awarded, dayLeft: pt.dayLeft });
    return;
  }

  // หลังบ้านผู้ดูแล — ต้องส่ง Authorization: Bearer <ADMIN_TOKEN> (env) — เห็น email/ชื่อจริงของผู้ใช้
  if (method === "GET" && url.pathname === "/admin/users") {
    if (!ADMIN_TOKEN || req.headers.authorization !== "Bearer " + ADMIN_TOKEN) {
      json(res, 401, { error: "unauthorized — ต้องใช้ ADMIN_TOKEN" });
      return;
    }
    json(res, 200, {
      online: [...activeNames.entries()].map(([name, v]) => ({ name, avatar: v.avatar, gid: v.gid, email: v.email || "", realName: v.realName || "", lastSeen: v.lastSeen })),
      identities: [...identities.values()],
      banned: [...banned.values()],
      stats: { messages: messages.length },
      latest: messages.slice(-5).map((m) => ({ name: m.name, text: (m.text || "").slice(0, 80), img: !!m.img, time: m.time })),
    });
    return;
  }
  // แบน / ปลดแบน (sub ของ Google) — แบนแล้ว: เตะ session เดิมออก + login/ส่งข้อความไม่ได้ทันที
  if (method === "POST" && (url.pathname === "/admin/ban" || url.pathname === "/admin/unban")) {
    if (!ADMIN_TOKEN || req.headers.authorization !== "Bearer " + ADMIN_TOKEN) {
      json(res, 401, { error: "unauthorized — ต้องใช้ ADMIN_TOKEN" });
      return;
    }
    let body;
    try { body = (await readBody(req, 16 * 1024)).toString(); } catch (e) { json(res, e.status || 400, { error: "request too large" }); return; }
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      json(res, 400, { error: "invalid json" });
      return;
    }
    const sub = String(data.sub || "").trim();
    if (!sub) {
      json(res, 400, { error: "sub required" });
      return;
    }
    if (url.pathname === "/admin/ban") {
      const id = identities.get(sub) || {};
      banned.set(sub, { sub, email: id.email || "", name: id.name || "", nickname: id.nickname || "", reason: String(data.reason || "").slice(0, 200), bannedAt: Date.now() });
      saveBanned();
      // เตะ session เดิมทิ้งทันที + ปลดชื่อในร้าน
      for (const [tok, s] of sessions) if (s.sub === sub) sessions.delete(tok);
      for (const [n, v] of activeNames) if (v.gid === sub) activeNames.delete(n);
    } else {
      banned.delete(sub);
      saveBanned();
    }
    json(res, 200, { ok: true, banned: [...banned.values()] });
    return;
  }
  // หน้าเว็บผู้ดูแล (โหลดข้อมูลด้วย ADMIN_TOKEN)
  if (method === "GET" && url.pathname === "/admin") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(ADMIN_HTML.replace("__CSP_NONCE__", cspNonce));
    return;
  }

  // โปรไฟล์สาธารณะ — เฉพาะข้อมูลที่ไม่เปิดเผยตัวตน (ไม่มี email/ชื่อจริง เด็ดขาด)
  if (method === "GET" && url.pathname === "/profile") {
    const name = String(url.searchParams.get("name") || "").trim().slice(0, 50);
    if (!name) { json(res, 400, { error: "name required" }); return; }
    const act = activeNames.get(name);
    let pub = null;
    if (act && act.gid) pub = identities.get(act.gid) || null;
    else pub = [...identities.values()].find((i) => i.nickname === name) || null; // ออฟไลน์ — หาจากชื่อเล่นที่เคยตั้ง
    if (!pub) { json(res, 404, { error: "ไม่พบผู้ใช้นี้" }); return; }
    const points = pub.points || 0;
    const lv = levelFor(points);
    const idx = LEVELS.indexOf(lv);
    const next = LEVELS[idx + 1] || null;
    const online = !!act; // มีชื่อในร้าน (heartbeat/จองชื่อ) = ออนไลน์
    const sessTok = String(url.searchParams.get("session") || "");
    const s = sessions.get(sessTok);
    const myId = s ? identities.get(s.sub) : null;
    const givenToday = !!(myId && myId.heartsGiven && myId.heartsGiven.date === dayKey()); // คนที่เปิดดูให้หัวใจวันนี้ไปแล้วหรือยัง
    json(res, 200, {
      name, // ชื่อเล่น
      avatar: pub.avatar || "👤",
      online,
      level: lv.title, icon: lv.icon, points,
      hearts: pub.hearts || 0,
      givenToday,
      nextTitle: next ? next.title : "", nextIcon: next ? next.icon : "",
      toNext: next ? Math.max(0, next.min - points) : 0,
      pct: next ? Math.min(100, Math.round(((points - lv.min) / (next.min - lv.min)) * 100)) : 100,
      joined: pub.firstSeen,
      lastSeen: pub.lastSeen,
      stats: { msgs: pub.msgCount || 0, imgs: pub.imgCount || 0, voices: pub.voiceCount || 0 },
      // ⚠️ ไม่มี email/realName — ข้อมูลส่วนตัวดูได้เฉพาะผู้ดูแลที่ /admin
    });
    return;
  }

  res.writeHead(404);
  res.end("not found");
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`แชทกลุ่มพร้อมแล้ว: http://localhost:${PORT} (รูปจะถูกลบหลัง ${IMAGE_TTL_MS / 1000} วิ)`);
    if (!GOOGLE_CLIENT_ID) console.log("⚠️ ยังไม่ได้ตั้งค่า GOOGLE_CLIENT_ID — ผู้ใช้จะ login ด้วย Google ไม่ได้ (ดู วิธีใช้.md)");
    if (!ADMIN_TOKEN) console.log("ℹ️ ยังไม่ได้ตั้งค่า ADMIN_TOKEN — หน้า /admin ปิดอยู่");
  });
}

module.exports = { server, verifyGoogleJwt, sessions, identities, activeNames, retiredNames, levelFor };

// ponytail: เก็บข้อความใน memory เท่านั้น — server รีสตาร์ทแล้วข้อความและรูปหาย
// อัปเกรดทีหลัง: เปลี่ยน messages เป็น SQLite (better-sqlite3) หรือเขียน append-only JSON file
// ponytail: ไม่มี auth / ไม่มีแยกห้อง — ใครก็เข้ามาแชทด้วยกันได้ในห้องเดียว
