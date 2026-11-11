/**
 * 在真实 Electron（Chromium）环境里验证缩略图转码逻辑。
 *
 * 由 scripts/verify-thumb-transcode.ps1 调用：
 *   THUMB_UTIL   = esbuild 打包后的 thumbnailImage.js 路径
 *   THUMB_TARGETS= JSON 数组 [{ name, url }]
 */
const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');

const utilPath = process.env.THUMB_UTIL || path.join(__dirname, '.tmp-thumb-util.js');
const outPath = process.env.THUMB_OUT || path.join(__dirname, '.tmp-thumb-report.json');
const targets = JSON.parse(process.env.THUMB_TARGETS || '[]');

if (!fs.existsSync(utilPath)) {
  console.error(`找不到工具产物: ${utilPath}`);
  app.exit(1);
}

const utilCode = fs.readFileSync(utilPath, 'utf8');

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 900, height: 700 });
  // 必须用 file://（secure context），否则 WebCodecs 的 ImageDecoder 不可用 ——
  // 打包后的应用正是 file:// 加载页面，开发模式则是 http://localhost:5173，
  // 两者都是 secure context。
  const pagePath = path.join(os.tmpdir(), `thumb-verify-${Date.now()}.html`);
  fs.writeFileSync(pagePath, '<!doctype html><html><body>thumb verifier</body></html>', 'utf8');
  await win.loadFile(pagePath);

  const script = `
    (async () => {
      ${utilCode}
      const targets = ${JSON.stringify(targets)};
      const report = [];
      for (const target of targets) {
        const started = performance.now();
        let probe = '';
        try {
          // 独立复现一次「头部解析」，把解析到的真实尺寸显示出来便于对照
          const resp = await fetch(target.url, { cache: 'force-cache' });
          const blob = await resp.blob();
          const buf = new Uint8Array(await blob.slice(0, 65536).arrayBuffer());
          const view = new DataView(buf.buffer);
          const asc = (s, n) => String.fromCharCode(...buf.subarray(s, s + n));
          let size = 'unknown';
          if (asc(0, 3) === 'GIF') size = view.getUint16(6, true) + 'x' + view.getUint16(8, true) + '(gif)';
          else if (asc(0, 4) === '\\x89PNG') size = view.getUint32(16) + 'x' + view.getUint32(20) + '(png)';
          else if (buf[0] === 0xff && buf[1] === 0xd8) {
            let off = 2;
            while (off + 9 <= buf.length) {
              if (buf[off] !== 0xff) { off++; continue; }
              const marker = buf[off + 1];
              if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
                size = view.getUint16(off + 7) + 'x' + view.getUint16(off + 5) + '(jpeg)';
                break;
              }
              off += 2 + view.getUint16(off + 2);
            }
          }
          probe = '文件 ' + Math.round(blob.size / 1024) + ' KB, 头部解析 ' + size;
        } catch (err) {
          probe = 'probe 异常: ' + (err && err.message ? err.message : err);
        }

        try {
          const prepared = await ThumbUtil.getPreparedThumbnail(target.url, 640, 320);
          report.push({
            name: target.name,
            ms: Math.round(performance.now() - started),
            action: prepared ? '转码为静态小图' : '直接使用原图',
            bytes: prepared ? prepared.bytes : null,
            kb: prepared ? Math.round(prepared.bytes / 102.4) / 10 : null,
            probe,
          });
        } catch (err) {
          report.push({
            name: target.name,
            ms: Math.round(performance.now() - started),
            action: '失败: ' + err.message,
            probe,
          });
        }
      }
      return report;
    })()
  `;

  try {
    const report = await win.webContents.executeJavaScript(script, true);
    // Windows 下 Electron 主进程的 console 输出不一定会回到父控制台，写到文件回传
    fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
    app.exit(0);
  } catch (err) {
    fs.writeFileSync(outPath, JSON.stringify([{ name: '(执行失败)', action: String(err && err.message ? err.message : err) }], null, 2), 'utf8');
    app.exit(1);
  }
});
