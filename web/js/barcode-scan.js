/**
 * barcode-scan.js — ক্যামেরা দিয়ে বারকোড স্ক্যান
 *
 *  • decodeGray(gray, w, h)  : গ্রেস্কেল ছবি থেকে বারকোড পড়ে (Code 128 ও EAN-13/UPC-A) — শুধু JavaScript, ইন্টারনেট/লাইব্রেরি লাগে না
 *  • startCamera(video, cb)  : মোবাইল ক্যামেরা চালু করে ক্রমাগত স্ক্যান করে।
 *                              ব্রাউজারে BarcodeDetector থাকলে সেটাই আগে ব্যবহার করে, না পেলে/না পড়লে নিজের ডিকোডার।
 *
 * বার/স্পেসের প্রস্থ (run-length) মিলিয়ে পড়া হয়; Code 128-এর Checksum ও EAN-এর Check digit যাচাই করা হয়,
 * তাই ভুল পড়ার সম্ভাবনা প্রায় নেই।
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BarcodeScan = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ---------------- Code 128 টেবিল ---------------- */
  const C128 = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232'
  ].map(function (s) { return s.split('').map(Number); });
  const STOP = [2, 3, 3, 1, 1, 1, 2];

  /* ---------------- EAN-13 টেবিল ---------------- */
  const EAN_L = ['0001101', '0011001', '0010011', '0111101', '0100011', '0110001', '0101111', '0111011', '0110111', '0001011'];
  const EAN_R = EAN_L.map(function (b) { return b.split('').map(function (c) { return c === '0' ? '1' : '0'; }).join(''); });
  const EAN_G = EAN_R.map(function (b) { return b.split('').reverse().join(''); });
  const EAN_PARITY = ['LLLLLL', 'LLGLGG', 'LLGGLG', 'LLGGGL', 'LGLLGG', 'LGGLLG', 'LGGGLL', 'LGLGLG', 'LGLGGL', 'LGGLGL'];
  const bitsToRuns = function (b) {
    const out = []; let cur = b[0], n = 0;
    for (let i = 0; i < b.length; i++) { if (b[i] === cur) n++; else { out.push(n); cur = b[i]; n = 1; } }
    out.push(n); return out;
  };
  const EAN_RUNS = { L: EAN_L.map(bitsToRuns), G: EAN_G.map(bitsToRuns), R: EAN_R.map(bitsToRuns) };

  /* ---------------- ১) এক সারি → run-length ---------------- */
  /** এক সারির উজ্জ্বলতা → [{d: কালো?, n: পিক্সেল}] (স্থানীয় min/max থ্রেশহোল্ড) */
  function toRuns(row) {
    const n = row.length, half = Math.max(12, Math.round(n / 10));
    const dark = new Uint8Array(n);
    // sliding window min/max (monotonic deque)
    const dqMin = [], dqMax = [];
    let head1 = 0, head2 = 0, nextAdd = 0;
    for (let i = 0; i < n; i++) {
      const hi = Math.min(n - 1, i + half);
      while (nextAdd <= hi) {
        const v = row[nextAdd];
        while (dqMin.length > head1 && row[dqMin[dqMin.length - 1]] >= v) dqMin.pop();
        dqMin.push(nextAdd);
        while (dqMax.length > head2 && row[dqMax[dqMax.length - 1]] <= v) dqMax.pop();
        dqMax.push(nextAdd);
        nextAdd++;
      }
      const lo = i - half;
      while (dqMin[head1] < lo) head1++;
      while (dqMax[head2] < lo) head2++;
      const mn = row[dqMin[head1]], mx = row[dqMax[head2]];
      dark[i] = (mx - mn >= 28 && row[i] < (mn + mx) / 2) ? 1 : 0;
    }
    const runs = []; let cur = dark[0], len = 1;
    for (let i = 1; i < n; i++) {
      if (dark[i] === cur) len++;
      else { runs.push({ d: cur, n: len }); cur = dark[i]; len = 1; }
    }
    runs.push({ d: cur, n: len });
    return runs;
  }

  /* ---------------- ২) Code 128 ---------------- */
  /** runs[i..i+5] কে candidate প্রতীকগুলোর সাথে মেলায় → {val, err} */
  function matchSym(runs, i, cands) {
    let sum = 0;
    for (let k = 0; k < 6; k++) sum += runs[i + k].n;
    const X = sum / 11;
    if (X < 0.7) return null;
    let best = -1, bestErr = 1e9;
    for (let c = 0; c < cands.length; c++) {
      const p = C128[cands[c]]; let err = 0;
      for (let k = 0; k < 6; k++) { err += Math.abs(runs[i + k].n / X - p[k]); if (err > bestErr) break; }
      if (err < bestErr) { bestErr = err; best = cands[c]; }
    }
    return bestErr <= (X < 2.6 ? 2.0 : 1.7) ? { val: best, err: bestErr } : null;   // ছোট মাপে পিক্সেল-ভুল বেশি, তাই একটু ঢিলে
  }
  const ALL_DATA = []; for (let v = 0; v < 103; v++) ALL_DATA.push(v);
  const ALL_SYM = ALL_DATA.concat([103, 104, 105]);
  const STARTS = [103, 104, 105];

  function code128Text(vals) {                    // vals: Start সহ, Checksum ছাড়া
    let set = { 103: 'A', 104: 'B', 105: 'C' }[vals[0]], out = '', shift = false;
    for (let i = 1; i < vals.length; i++) {
      const v = vals[i];
      if (set === 'C') {
        if (v <= 99) out += (v < 10 ? '0' : '') + v;
        else if (v === 100) set = 'B'; else if (v === 101) set = 'A';
        continue;
      }
      if (v === 99) { set = 'C'; continue; }
      if (v === 100) { if (set === 'A') set = 'B'; continue; }
      if (v === 101) { if (set === 'B') set = 'A'; continue; }
      if (v === 98) { shift = true; continue; }
      if (v >= 96) continue;                       // FNC1-4
      const use = shift ? (set === 'A' ? 'B' : 'A') : set;
      shift = false;
      out += String.fromCharCode(use === 'A' ? (v < 64 ? v + 32 : v - 64) : v + 32);
    }
    return out;
  }

  function decode128(runs) {
    const N = runs.length;
    for (let s = 0; s + 20 <= N; s++) {
      if (!runs[s].d) continue;
      const st = matchSym(runs, s, STARTS);
      if (!st) continue;
      const vals = [st.val];
      let pos = s + 6;
      while (vals.length < 90 && pos + 6 <= N) {
        if (vals.length >= 3 && pos + 7 <= N) {   // Stop প্যাটার্ন এখানে কি না
          let sum = 0; for (let k = 0; k < 7; k++) sum += runs[pos + k].n;
          const X = sum / 13; let err = 0;
          for (let k = 0; k < 7; k++) err += Math.abs(runs[pos + k].n / X - STOP[k]);
          if (err <= 2.3 && runs[pos].d) {
            const cs = vals[vals.length - 1], data = vals.slice(0, -1);
            let total = data[0];
            for (let j = 1; j < data.length; j++) total += data[j] * j;
            if (total % 103 === cs) { const t = code128Text(data); if (t) return t; }
          }
        }
        const m = matchSym(runs, pos, ALL_DATA);
        if (!m) break;
        vals.push(m.val); pos += 6;
      }
    }
    return null;
  }

  /* ---------------- ৩) EAN-13 / UPC-A ---------------- */
  function matchEan(runs, i, tables) {            // ৪টি run → {digit, table}
    let sum = 0;
    for (let k = 0; k < 4; k++) sum += runs[i + k].n;
    const X = sum / 7;
    if (X < 0.7) return null;
    let best = null, bestErr = 1e9;
    tables.forEach(function (t) {
      for (let d = 0; d < 10; d++) {
        const p = EAN_RUNS[t][d]; let err = 0;
        for (let k = 0; k < 4; k++) err += Math.abs(runs[i + k].n / X - p[k]);
        if (err < bestErr) { bestErr = err; best = { digit: d, table: t }; }
      }
    });
    return bestErr <= 1.4 ? best : null;
  }
  function decodeEan13(runs) {
    const N = runs.length;
    for (let s = 0; s + 59 <= N; s++) {
      if (!runs[s].d) continue;
      const X = (runs[s].n + runs[s + 1].n + runs[s + 2].n) / 3;
      if (X < 0.7) continue;
      if (Math.abs(runs[s].n / X - 1) > 0.5 || Math.abs(runs[s + 1].n / X - 1) > 0.5 || Math.abs(runs[s + 2].n / X - 1) > 0.5) continue;
      let pos = s + 3, digits = [], parity = '', ok = true;
      for (let i = 0; i < 6 && ok; i++) {
        const m = matchEan(runs, pos, ['L', 'G']);
        if (!m) ok = false; else { digits.push(m.digit); parity += m.table; pos += 4; }
      }
      if (!ok) continue;
      let cs = 0; for (let k = 0; k < 5; k++) cs += runs[pos + k].n;      // মাঝের গার্ড (৫ run ≈ ৫ module)
      if (Math.abs(cs / X - 5) > 1.6) continue;
      pos += 5;
      for (let i = 0; i < 6 && ok; i++) {
        const m = matchEan(runs, pos, ['R']);
        if (!m) ok = false; else { digits.push(m.digit); pos += 4; }
      }
      if (!ok) continue;
      const first = EAN_PARITY.indexOf(parity);
      if (first < 0) continue;
      const all = [first].concat(digits);
      let sum = 0; for (let i = 0; i < 12; i++) sum += all[i] * (i % 2 === 0 ? 1 : 3);
      if ((10 - sum % 10) % 10 !== all[12]) continue;
      return all.join('');
    }
    return null;
  }

  function decodeRuns(runs) {
    if (runs.length < 20) return null;
    let t = decode128(runs);
    if (t !== null) return { text: t, format: 'code_128' };
    t = decodeEan13(runs);
    if (t !== null) return { text: t, format: 'ean_13' };
    return null;
  }
  /** এক সারি (আয়না-উল্টো হলেও) পড়া */
  function decodeRow(row) {
    const runs = toRuns(row);
    let r = decodeRuns(runs) || decodeRuns(runs.slice().reverse());
    if (r || runs.length < 30) return r;
    // বারকোড খুব ছোট (module ~২px) হলে সারি দ্বিগুণ করে (interpolate) আবার চেষ্টা — প্রান্ত আরও নির্ভুল হয়
    const n = row.length, up = new Float32Array(n * 2);
    for (let i = 0; i < n; i++) { up[2 * i] = row[i]; up[2 * i + 1] = i + 1 < n ? (row[i] + row[i + 1]) / 2 : row[i]; }
    const runs2 = toRuns(up);
    return decodeRuns(runs2) || decodeRuns(runs2.slice().reverse());
  }

  /* ---------------- ৪) পুরো ছবি ---------------- */
  /** gray: Uint8Array/Array (w*h)। মাঝখান থেকে বাইরের দিকে অনেকগুলো আনুভূমিক ও উল্লম্ব লাইন পড়ে */
  function decodeGray(gray, w, h, opts) {
    opts = opts || {};
    const lines = opts.lines || 25;
    const order = function (n) {                     // মাঝ থেকে বাইরে
      const a = [];
      for (let i = 0; i < n; i++) a.push(i);
      const mid = (n - 1) / 2;
      return a.sort(function (x, y) { return Math.abs(x - mid) - Math.abs(y - mid); });
    };
    const rowBuf = new Float32Array(w);
    for (const t of order(lines)) {                  // আনুভূমিক
      const y = Math.round(h * (0.12 + 0.76 * t / (lines - 1)));
      const y0 = Math.max(0, y - 1), y1 = Math.min(h - 1, y + 1), cnt = y1 - y0 + 1;
      for (let x = 0; x < w; x++) { let s = 0; for (let yy = y0; yy <= y1; yy++) s += gray[yy * w + x]; rowBuf[x] = s / cnt; }
      const r = decodeRow(rowBuf);
      if (r) return r;
    }
    if (opts.vertical === false) return null;
    const colBuf = new Float32Array(h), vl = Math.max(9, lines - 8);
    for (const t of order(vl)) {                     // উল্লম্ব (ফোন ঘোরানো থাকলে)
      const x = Math.round(w * (0.12 + 0.76 * t / (vl - 1)));
      const x0 = Math.max(0, x - 1), x1 = Math.min(w - 1, x + 1), cnt = x1 - x0 + 1;
      for (let y = 0; y < h; y++) { let s = 0; for (let xx = x0; xx <= x1; xx++) s += gray[y * w + xx]; colBuf[y] = s / cnt; }
      const r = decodeRow(colBuf);
      if (r) return r;
    }
    return null;
  }

  /* ---------------- ৫) ক্যামেরা (শুধু ব্রাউজারে) ---------------- */
  /**
   * startCamera(video, onResult, opts) → Promise<controller>
   *   controller: { stop(), setTorch(on) → Promise<boolean>, torchSupported, engine }
   *   onResult({text, format, engine}) — প্রতিবার একটি বারকোড পড়লে (একই কোড ~১.৫ সেকেন্ডের মধ্যে আবার এলে বাদ)
   */
  async function startCamera(video, onResult, opts) {
    opts = opts || {};
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw new Error('এই ব্রাউজারে ক্যামেরা ব্যবহার করা যায় না (HTTPS দরকার)');
    }
    let stream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } }
      });
    } catch (e) {
      try { stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true }); }
      catch (e2) {
        const name = (e2 && e2.name) || '';
        throw new Error(name === 'NotAllowedError' ? 'ক্যামেরার অনুমতি দেওয়া হয়নি — সেটিংস থেকে অনুমতি দিন' :
          name === 'NotFoundError' ? 'ক্যামেরা পাওয়া যায়নি' : 'ক্যামেরা চালু করা যায়নি: ' + (e2 && e2.message || name));
      }
    }
    video.setAttribute('playsinline', ''); video.muted = true; video.srcObject = stream;
    await video.play();

    const track = stream.getVideoTracks()[0];
    let torchSupported = false;
    try { const caps = track.getCapabilities ? track.getCapabilities() : {}; torchSupported = !!caps.torch; } catch (e) { /* ঠিক আছে */ }
    try { if (track.applyConstraints) await track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) { /* সব ক্যামেরায় নেই */ }

    let detector = null;
    if (!opts.noNative && typeof BarcodeDetector !== 'undefined') {
      try {
        const want = ['code_128', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_39'];
        const sup = BarcodeDetector.getSupportedFormats ? await BarcodeDetector.getSupportedFormats() : want;
        const formats = want.filter(function (f) { return sup.indexOf(f) >= 0; });
        if (formats.length) detector = new BarcodeDetector({ formats: formats });
      } catch (e) { detector = null; }
    }

    const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d', { willReadFrequently: true });
    let stopped = false, busy = false, last = '', lastAt = 0, timer = null, nativeMisses = 0;
    const emit = function (text, format, engine) {
      const now = Date.now();
      if (text === last && now - lastAt < (opts.repeatMs || 1500)) return;
      last = text; lastAt = now;
      try { onResult({ text: text, format: format, engine: engine }); } catch (e) { /* UI ত্রুটি স্ক্যান থামাবে না */ }
    };
    const tick = async function () {
      if (stopped) return;
      if (!busy && video.readyState >= 2 && video.videoWidth) {
        busy = true;
        try {
          let found = null;
          if (detector) {
            try {
              const r = await detector.detect(video);
              if (r && r.length && r[0].rawValue) found = { text: r[0].rawValue, format: r[0].format, engine: 'native' };
            } catch (e) { nativeMisses++; if (nativeMisses > 5) detector = null; }
          }
          if (!found) {
            const vw = video.videoWidth, vh = video.videoHeight, sc = Math.min(1, 960 / Math.max(vw, vh));
            const w = Math.round(vw * sc), h = Math.round(vh * sc);
            if (canvas.width !== w) { canvas.width = w; canvas.height = h; }
            ctx.drawImage(video, 0, 0, w, h);
            const d = ctx.getImageData(0, 0, w, h).data, g = new Uint8Array(w * h);
            for (let i = 0, p = 0; i < g.length; i++, p += 4) g[i] = (d[p] * 77 + d[p + 1] * 151 + d[p + 2] * 28) >> 8;
            const r = decodeGray(g, w, h);
            if (r) found = { text: r.text, format: r.format, engine: 'js' };
          }
          if (found) emit(found.text, found.format, found.engine);
        } catch (e) { /* পরের ফ্রেমে আবার */ }
        busy = false;
      }
      timer = setTimeout(tick, 110);
    };
    tick();

    return {
      torchSupported: torchSupported, engine: detector ? 'native' : 'js',
      stop: function () {
        stopped = true; if (timer) clearTimeout(timer);
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ঠিক আছে */ }
        try { video.srcObject = null; } catch (e) { /* ঠিক আছে */ }
      },
      setTorch: async function (on) {
        try { await track.applyConstraints({ advanced: [{ torch: !!on }] }); return !!on; } catch (e) { return false; }
      }
    };
  }

  return { decodeGray: decodeGray, decodeRow: decodeRow, decodeRuns: decodeRuns, toRuns: toRuns, startCamera: startCamera };
});
