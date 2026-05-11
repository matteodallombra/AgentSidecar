#!/usr/bin/env node

const payload = process.argv[2];
if (!payload) {
  console.error("Usage: terminal-qr.js <payload>");
  process.exit(64);
}

const VERSION = 5;
const SIZE = VERSION * 4 + 17;
const DATA_CODEWORDS = 108;
const ECC_CODEWORDS = 26;

const bytes = [...Buffer.from(payload, "utf8")];
if (bytes.length > 106) {
  console.error(`QR payload is too long for this setup code (${bytes.length} bytes, max 106).`);
  process.exit(65);
}

const EXP = new Array(512);
const LOG = new Array(256);
let x = 1;
for (let i = 0; i < 255; i++) {
  EXP[i] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];

const data = encodeData(bytes);
const ecc = reedSolomon(data, ECC_CODEWORDS);
const codewords = [...data, ...ecc];
const qr = buildMatrix(codewords);

printQR(qr);

function encodeData(input) {
  const bits = [];
  appendBits(bits, 0b0100, 4);
  appendBits(bits, input.length, 8);
  for (const byte of input) appendBits(bits, byte, 8);
  appendBits(bits, 0, Math.min(4, DATA_CODEWORDS * 8 - bits.length));
  while (bits.length % 8 !== 0) bits.push(0);

  const output = [];
  for (let i = 0; i < bits.length; i += 8) {
    output.push(bits.slice(i, i + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
  }
  for (let pad = 0xec; output.length < DATA_CODEWORDS; pad = pad === 0xec ? 0x11 : 0xec) output.push(pad);
  return output;
}

function appendBits(bits, value, length) {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
}

function gfMul(a, b) {
  return a && b ? EXP[LOG[a] + LOG[b]] : 0;
}

function reedSolomon(input, degree) {
  let generator = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(generator.length + 1).fill(0);
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= generator[j];
      next[j + 1] ^= gfMul(generator[j], EXP[i]);
    }
    generator = next;
  }

  const result = new Array(degree).fill(0);
  for (const byte of input) {
    const factor = byte ^ result.shift();
    result.push(0);
    for (let i = 0; i < degree; i++) result[i] ^= gfMul(generator[i + 1], factor);
  }
  return result;
}

function buildMatrix(input) {
  let best = null;
  for (let mask = 0; mask < 8; mask++) {
    const modules = Array.from({ length: SIZE }, () => Array(SIZE).fill(null));
    const reserved = Array.from({ length: SIZE }, () => Array(SIZE).fill(false));

    drawFunctionPatterns(modules, reserved);
    drawCodewords(modules, reserved, input, mask);
    drawFormatBits(modules, reserved, mask);

    const penalty = score(modules);
    if (!best || penalty < best.penalty) best = { modules, penalty };
  }
  return best.modules;
}

function setModule(modules, reserved, x, y, dark, isFunction = true) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  modules[y][x] = !!dark;
  if (isFunction) reserved[y][x] = true;
}

function drawFunctionPatterns(modules, reserved) {
  drawFinder(modules, reserved, 0, 0);
  drawFinder(modules, reserved, SIZE - 7, 0);
  drawFinder(modules, reserved, 0, SIZE - 7);

  for (let i = 0; i < SIZE; i++) {
    setModule(modules, reserved, 6, i, i % 2 === 0);
    setModule(modules, reserved, i, 6, i % 2 === 0);
  }

  drawAlignment(modules, reserved, 30, 30);
  setModule(modules, reserved, 8, VERSION * 4 + 9, true);

  reserveFormat(modules, reserved);
}

function drawFinder(modules, reserved, x, y) {
  for (let dy = -1; dy <= 7; dy++) {
    for (let dx = -1; dx <= 7; dx++) {
      const xx = x + dx;
      const yy = y + dy;
      const dark = dx >= 0 && dx <= 6 && dy >= 0 && dy <= 6 && (dx === 0 || dx === 6 || dy === 0 || dy === 6 || (dx >= 2 && dx <= 4 && dy >= 2 && dy <= 4));
      setModule(modules, reserved, xx, yy, dark);
    }
  }
}

function drawAlignment(modules, reserved, cx, cy) {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const dark = Math.max(Math.abs(dx), Math.abs(dy)) !== 1;
      setModule(modules, reserved, cx + dx, cy + dy, dark);
    }
  }
}

function reserveFormat(modules, reserved) {
  for (let i = 0; i <= 8; i++) {
    if (i !== 6) {
      setModule(modules, reserved, 8, i, false);
      setModule(modules, reserved, i, 8, false);
    }
  }
  for (let i = 0; i < 8; i++) {
    setModule(modules, reserved, SIZE - 1 - i, 8, false);
    setModule(modules, reserved, 8, SIZE - 1 - i, false);
  }
}

function drawCodewords(modules, reserved, input, mask) {
  const bits = [];
  for (const byte of input) appendBits(bits, byte, 8);

  let bitIndex = 0;
  let upward = true;
  for (let right = SIZE - 1; right >= 1; right -= 2) {
    if (right === 6) right--;
    for (let vert = 0; vert < SIZE; vert++) {
      const y = upward ? SIZE - 1 - vert : vert;
      for (let col = 0; col < 2; col++) {
        const x = right - col;
        if (reserved[y][x]) continue;
        let dark = bitIndex < bits.length ? bits[bitIndex++] === 1 : false;
        if (maskBit(mask, x, y)) dark = !dark;
        modules[y][x] = dark;
      }
    }
    upward = !upward;
  }
}

function maskBit(mask, x, y) {
  switch (mask) {
    case 0: return (x + y) % 2 === 0;
    case 1: return y % 2 === 0;
    case 2: return x % 3 === 0;
    case 3: return (x + y) % 3 === 0;
    case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
    case 5: return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6: return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    case 7: return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function drawFormatBits(modules, reserved, mask) {
  const bits = formatBits(mask);
  const a = [
    [0, 8], [1, 8], [2, 8], [3, 8], [4, 8], [5, 8], [7, 8], [8, 8],
    [8, 7], [8, 5], [8, 4], [8, 3], [8, 2], [8, 1], [8, 0],
  ];
  const b = [
    [SIZE - 1, 8], [SIZE - 2, 8], [SIZE - 3, 8], [SIZE - 4, 8], [SIZE - 5, 8], [SIZE - 6, 8], [SIZE - 7, 8], [SIZE - 8, 8],
    [8, SIZE - 7], [8, SIZE - 6], [8, SIZE - 5], [8, SIZE - 4], [8, SIZE - 3], [8, SIZE - 2], [8, SIZE - 1],
  ];
  for (let i = 0; i < 15; i++) {
    const dark = ((bits >>> i) & 1) !== 0;
    setModule(modules, reserved, a[i][0], a[i][1], dark);
    setModule(modules, reserved, b[i][0], b[i][1], dark);
  }
}

function formatBits(mask) {
  const eccL = 0b01;
  let data = (eccL << 3) | mask;
  let bits = data << 10;
  const generator = 0b10100110111;
  for (let i = 14; i >= 10; i--) {
    if (((bits >>> i) & 1) !== 0) bits ^= generator << (i - 10);
  }
  return (((data << 10) | bits) ^ 0b101010000010010) & 0x7fff;
}

function score(modules) {
  let penalty = 0;
  for (let y = 0; y < SIZE; y++) penalty += scoreRuns(modules[y]);
  for (let x = 0; x < SIZE; x++) penalty += scoreRuns(modules.map((row) => row[x]));

  for (let y = 0; y < SIZE - 1; y++) {
    for (let x = 0; x < SIZE - 1; x++) {
      const color = modules[y][x];
      if (modules[y][x + 1] === color && modules[y + 1][x] === color && modules[y + 1][x + 1] === color) penalty += 3;
    }
  }

  const pattern = "10111010000";
  const reverse = "00001011101";
  for (let y = 0; y < SIZE; y++) {
    const row = modules[y].map(Number).join("");
    penalty += countPattern(row, pattern) * 40 + countPattern(row, reverse) * 40;
  }
  for (let x = 0; x < SIZE; x++) {
    const col = modules.map((row) => Number(row[x])).join("");
    penalty += countPattern(col, pattern) * 40 + countPattern(col, reverse) * 40;
  }

  const dark = modules.flat().filter(Boolean).length;
  const percent = (dark * 100) / (SIZE * SIZE);
  penalty += Math.floor(Math.abs(percent - 50) / 5) * 10;
  return penalty;
}

function scoreRuns(line) {
  let penalty = 0;
  let runColor = line[0];
  let runLength = 1;
  for (let i = 1; i < line.length; i++) {
    if (line[i] === runColor) {
      runLength++;
    } else {
      if (runLength >= 5) penalty += runLength - 2;
      runColor = line[i];
      runLength = 1;
    }
  }
  if (runLength >= 5) penalty += runLength - 2;
  return penalty;
}

function countPattern(value, pattern) {
  let count = 0;
  for (let index = value.indexOf(pattern); index !== -1; index = value.indexOf(pattern, index + 1)) count++;
  return count;
}

function printQR(modules) {
  const quiet = 2;
  console.log("");
  console.log("Scan with the iPhone/iPad Camera app to pair AgentSidecar:");
  for (let y = -quiet; y < SIZE + quiet; y += 2) {
    let line = "";
    for (let x = -quiet; x < SIZE + quiet; x++) {
      const top = darkAt(modules, x, y);
      const bottom = darkAt(modules, x, y + 1);
      line += top && bottom ? "█" : top ? "▀" : bottom ? "▄" : " ";
    }
    console.log(line);
  }
  console.log("");
}

function darkAt(modules, x, y) {
  return x >= 0 && y >= 0 && x < SIZE && y < SIZE ? modules[y][x] : false;
}
