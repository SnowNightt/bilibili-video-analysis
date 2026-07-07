const { existsSync } = require('node:fs');
const { spawnSync } = require('node:child_process');

function candidates() {
  const result = [];
  if (process.env.BVA_FFMPEG_PATH) result.push(['BVA_FFMPEG_PATH', process.env.BVA_FFMPEG_PATH]);
  result.push(['PATH', 'ffmpeg']);
  try {
    const staticPath = require('ffmpeg-static');
    if (staticPath) result.push(['ffmpeg-static', staticPath]);
  } catch (error) {
    result.push(['ffmpeg-static', `not resolvable: ${error.message}`]);
  }
  return result;
}

let ok = false;
for (const [source, command] of candidates()) {
  const looksLikePath = /[\\/]/.test(command) || /^[A-Za-z]:/.test(command);
  const exists = looksLikePath ? existsSync(command) : true;
  const run = exists ? spawnSync(command, ['-version'], { encoding: 'utf8', windowsHide: true }) : undefined;
  const firstLine = run?.stdout?.split(/\r?\n/).find(Boolean);
  if (run?.status === 0) {
    console.log(`[ok] ${source}: ${command}`);
    console.log(firstLine);
    ok = true;
    break;
  }
  const reason = exists ? run?.error?.message || run?.stderr || `exit ${run?.status}` : 'file does not exist';
  console.log(`[fail] ${source}: ${command}`);
  console.log(`       ${String(reason).trim()}`);
}

if (!ok) {
  console.error('\nffmpeg is unavailable. Install ffmpeg or set BVA_FFMPEG_PATH to a working ffmpeg.exe.');
  process.exit(1);
}
