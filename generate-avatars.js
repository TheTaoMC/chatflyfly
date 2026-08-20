// generate-avatars.js — สร้าง PNG files 16×16 สำหรับชิ้นส่วนอวตารทุกชั้น
// แต่ละชิ้นส่วน = PNG 1 เลเยอร์ (ไม่ซ้อนกัน) — frontend ใช้ CSS ซ้อน 5 เลเยอร์
// รัน: node generate-avatars.js
// ผลลัพธ์: avatars/bowl/b1.png, avatars/body/c1.png, ... avatars/hat/o4.png

const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// ---- Pixel maps 16×16 (คัดลอกจาก server.js) ----
const MAPS = {
  bowl: ["....BBBBBBBB....", "..BBBBBBBBBBBB..", "..BBBBBBBBBBBB.."],
  head: [
    ".....HHHHHH.....",
    "...HHHHHHHHHH...",
    "..HHHHHHHHHHHH..",
    "..HHHHHHHHHHHH..",
    "..HHFFFFFFFFHH..",
    ".HHFFFFFFFFFFHH.",
    ".HHFFFFFFFFFFHH.",
    "...FFFFFFFFFF...",
  ],
  body: [
    "....CCCCCCCC....",
    "...CCCCCCCCCC...",
    "...CCCCCCCCCC...",
    "...CCCCCCCCCC...",
    "....CCCCCCCC....",
  ],
  face: [".....E....E.....", ".......M........"],
  chef: [".....OOOOOO.....", "....OOOOOOOO....", "....OOOOOOOO....", "....OOOOOOOO...."],
  straw: [".....OOOOOO.....", "....OOOOOOOO....", "...OOOOOOOOOO...", "...OOOOOOOOOO..."],
  band: ["..OOOOOOOOOOOO..", "..OOOOOOOOOOOO.."],
  gold: ["....OOOOOOOO....", "...OOOOOOOOOO...", "...OOOOOOOOOO...", "...OOOOOOOOOO..."],
};

const PARTS = {
  b: { vars: { 1: { n: "ชามกระเบื้อง", c: "#5b7fa6" }, 2: { n: "ชามไม้", c: "#a9714b" }, 3: { n: "ชามสแตนเลส", c: "#b9b9b9" }, 4: { n: "ชามทองคำ", c: "#e9c93c" }, 5: { n: "ชามซากุระ", c: "#f5a3c0" } } },
  c: { vars: { 1: { n: "เสื้อขาว", c: "#e8e6f0" }, 2: { n: "เสื้อดำ", c: "#4a4a4a" }, 3: { n: "เสื้อแดง", c: "#d94f4f" }, 4: { n: "เอี๊ยมเชฟเหลือง", c: "#ffcc00" }, 5: { n: "เสื้อฮาวาย", c: "#5aa7e8" } } },
  h: { vars: { 1: { n: "ผมดำ", c: "#3a2a20" }, 2: { n: "ผมส้ม", c: "#e67e22" }, 3: { n: "ผมม่วง", c: "#b48ce0" }, 4: { n: "ผมฟ้าคราม", c: "#5aa7e8" }, 5: { n: "ผมทอง", c: "#e9c93c" } } },
  f: { vars: { 1: { n: "ตาดำ", c: "#3a2a20" }, 2: { n: "ตาฟ้า", c: "#5aa7e8" }, 3: { n: "ตาเขียว", c: "#5cb85c" }, 4: { n: "ตาปีศาจแดง", c: "#e74c3c" } } },
  o: { vars: { 0: { n: "ไม่ใส่", c: "" }, 1: { n: "หมวกเชฟ", c: "#ffffff" }, 2: { n: "หมวกฟาง", c: "#e9c93c" }, 3: { n: "กิมหยง", c: "#5aa7e8" }, 4: { n: "หมวกเชฟทอง", c: "#e9c93c" } } },
};

const TYPE_DIR = { b: "bowl", c: "body", h: "head", f: "face", o: "hat" };
const OFFSET_Y = { bowl: 13, head: 0, body: 8, face: 6, hat: 0 };
const HAT_MAP = { 1: "chef", 2: "straw", 3: "band", 4: "gold" };

// ---- PNG helpers ----
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function shadeHex(hex, f) {
  const [r, g, b] = hexToRgb(hex);
  return "#" + [Math.round(r * f), Math.round(g * f), Math.round(b * f)].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function mapToPixels(mapLines, colorMap, offsetY) {
  const pixels = new Array(16 * 16 * 4).fill(0); // RGBA
  for (let y = 0; y < mapLines.length; y++) {
    for (let x = 0; x < mapLines[y].length; x++) {
      const ch = mapLines[y][x];
      if (ch !== "." && colorMap[ch]) {
        const [r, g, b] = hexToRgb(colorMap[ch]);
        const idx = ((offsetY + y) * 16 + x) * 4;
        pixels[idx] = r; pixels[idx + 1] = g; pixels[idx + 2] = b; pixels[idx + 3] = 255;
      }
    }
  }
  return pixels;
}

function pixelsToPng(pixels) {
  const width = 16, height = 16;
  const header = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(width, 0); ihdrData.writeUInt32BE(height, 4);
  ihdrData[8] = 8; ihdrData[9] = 6; // 8-bit RGBA
  const ihdr = makeChunk("IHDR", ihdrData);

  // IDAT
  const raw = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0;
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 4, di = y * (width * 4 + 1) + 1 + x * 4;
      raw[di] = pixels[si]; raw[di + 1] = pixels[si + 1]; raw[di + 2] = pixels[si + 2]; raw[di + 3] = pixels[si + 3];
    }
  }
  const idat = makeChunk("IDAT", zlib.deflateSync(raw));
  const iend = makeChunk("IEND", Buffer.alloc(0));
  return Buffer.concat([header, ihdr, idat, iend]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const typeB = Buffer.from(type, "ascii");
  const crcB = Buffer.alloc(4); crcB.writeUInt32BE(crc32(Buffer.concat([typeB, data])), 0);
  return Buffer.concat([len, typeB, data, crcB]);
}

const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }

// ---- สร้างไฟล์ ----
const outDir = path.join(__dirname, "avatars");
let count = 0;

for (const [type, info] of Object.entries(PARTS)) {
  const dirName = TYPE_DIR[type];
  const dir = path.join(outDir, dirName);
  fs.mkdirSync(dir, { recursive: true });

  for (const [id, variant] of Object.entries(info.vars)) {
    if (type === "o" && +id === 0) continue; // ไม่ใส่หมวก = ไม่มีไฟล์

    let mapLines, colorMap;
    if (type === "o") {
      const hatKey = HAT_MAP[+id];
      if (!hatKey) continue;
      mapLines = MAPS[hatKey];
      colorMap = { O: variant.c };
    } else {
      const charMap = { b: "B", c: "C", h: "H", f: "E" };
      const charKey = charMap[type];
      mapLines = MAPS[TYPE_DIR[type]];
      colorMap = { [charKey]: variant.c };
      // head ต้องมี F (ผิว) ด้วย
      if (type === "h") colorMap["F"] = "#f2c9a0";
      // face ต้องมี M (ปาก) ด้วย
      if (type === "f") colorMap["M"] = "#7a4a30";
    }

    const pixels = mapToPixels(mapLines, colorMap, OFFSET_Y[TYPE_DIR[type]]);
    const png = pixelsToPng(pixels);
    const filePath = path.join(dir, `${type}${id}.png`);
    fs.writeFileSync(filePath, png);
    count++;
    console.log(`  ✓ ${dirName}/${type}${id}.png`);
  }
}

console.log(`\nสร้าง PNG สำเร็จ ${count} ไฟล์ ที่ ${outDir}/`);
