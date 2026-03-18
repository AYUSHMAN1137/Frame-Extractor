const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const archiver = require('archiver');
const path = require('path');
const fs = require('fs');
const { execSync, exec } = require('child_process');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ══════════════════════════════════════════════════════════════
// Directory Setup
// ══════════════════════════════════════════════════════════════

const TEMP_DIR = path.join(__dirname, 'temp');
const CACHE_DIR = path.join(__dirname, 'cache'); // For cached videos
const TRANSCRIPT_DIR = path.join(__dirname, 'transcripts'); // For cached transcripts

[TEMP_DIR, CACHE_DIR, TRANSCRIPT_DIR].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// Store active sessions
const sessions = new Map();

// Video cache metadata (videoId -> { path, timestamp, duration, title })
const videoCache = new Map();

// Transcript cache (videoId -> { path, content, timestamp })
const transcriptCache = new Map();

// Cache expiry time (2 hours)
const CACHE_EXPIRY = 2 * 60 * 60 * 1000;
const TEMP_SESSION_EXPIRY = 60 * 60 * 1000;

// ══════════════════════════════════════════════════════════════
// Helper: Build enriched PATH for child processes
// ══════════════════════════════════════════════════════════════

function getEnrichedEnv() {
  const extraPaths = [];
  const home = process.env.USERPROFILE || process.env.HOME || '';

  const pythonScriptsDirs = [
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python312', 'Scripts'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python311', 'Scripts'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python310', 'Scripts'),
    path.join(home, 'AppData', 'Local', 'Programs', 'Python', 'Python39', 'Scripts'),
    path.join(home, 'AppData', 'Roaming', 'Python', 'Python312', 'Scripts'),
    path.join(home, 'AppData', 'Roaming', 'Python', 'Python311', 'Scripts'),
    path.join(home, 'AppData', 'Roaming', 'Python', 'Python310', 'Scripts'),
  ];

  const packagesDir = path.join(home, 'AppData', 'Local', 'Packages');
  if (fs.existsSync(packagesDir)) {
    try {
      const entries = fs.readdirSync(packagesDir).filter(e => e.startsWith('PythonSoftwareFoundation'));
      for (const entry of entries) {
        const scriptsPath = path.join(packagesDir, entry, 'LocalCache', 'local-packages');
        if (fs.existsSync(scriptsPath)) {
          try {
            const pyVersions = fs.readdirSync(scriptsPath).filter(e => e.startsWith('Python'));
            for (const pyVer of pyVersions) {
              extraPaths.push(path.join(scriptsPath, pyVer, 'Scripts'));
            }
          } catch (e) { /* ignore */ }
        }
      }
    } catch (e) { /* ignore */ }
  }

  const ffmpegDirs = [
    'C:\\ffmpeg\\bin',
    path.join(home, 'ffmpeg', 'bin'),
    path.join(home, 'scoop', 'shims'),
  ];

  for (const dir of pythonScriptsDirs) {
    if (fs.existsSync(dir)) extraPaths.push(dir);
  }

  for (const dir of ffmpegDirs) {
    if (fs.existsSync(dir)) extraPaths.push(dir);
  }

  let systemPath = '';
  try {
    systemPath = execSync('powershell -Command "[System.Environment]::GetEnvironmentVariable(\'Path\',\'Machine\') + \';\' + [System.Environment]::GetEnvironmentVariable(\'Path\',\'User\')"', { encoding: 'utf8' }).trim();
  } catch (e) {
    systemPath = process.env.PATH || '';
  }

  const finalPath = [...extraPaths, systemPath, process.env.PATH].filter(Boolean).join(';');
  return { ...process.env, PATH: finalPath };
}

const enrichedEnv = getEnrichedEnv();

// ══════════════════════════════════════════════════════════════
// Helper Functions
// ══════════════════════════════════════════════════════════════

function runCommand(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 50 * 1024 * 1024, env: enrichedEnv, shell: true }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || error.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

function escapePath(p) {
  return p.replace(/\\/g, '/');
}

function formatTime(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = Math.floor(totalSeconds % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function parseTime(timeStr) {
  if (!timeStr && timeStr !== 0) return null;
  if (typeof timeStr === 'number') return timeStr;
  
  const parts = timeStr.split(':').map(Number);
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  } else if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  return parseFloat(timeStr) || 0;
}

// Extract video ID from YouTube URL
function extractVideoId(url) {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }
  
  // Generate hash for other URLs
  return crypto.createHash('md5').update(url).digest('hex').slice(0, 11);
}

// Check if cache is valid
function isCacheValid(timestamp) {
  return (Date.now() - timestamp) < CACHE_EXPIRY;
}

// ══════════════════════════════════════════════════════════════
// GET /api/video-info
// ══════════════════════════════════════════════════════════════

app.get('/api/video-info', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)/;
    if (!ytRegex.test(url)) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const videoId = extractVideoId(url);
    const cmd = `yt-dlp --dump-json --no-download "${url}"`;
    const output = await runCommand(cmd);
    const info = JSON.parse(output);

    // Check if we have this video cached
    const cached = videoCache.get(videoId);
    const isCached = cached && isCacheValid(cached.timestamp) && fs.existsSync(cached.path);

    res.json({
      videoId,
      title: info.title || 'Unknown',
      duration: info.duration || 0,
      thumbnail: info.thumbnail || '',
      channel: info.channel || info.uploader || 'Unknown',
      resolution: info.resolution || 'N/A',
      isCached, // Tell frontend if video is already downloaded
      hasTranscript: !!(info.subtitles || info.automatic_captions),
    });
  } catch (err) {
    console.error('Error fetching video info:', err.message);
    res.status(500).json({ error: 'Failed to fetch video info. Make sure yt-dlp is installed and the URL is valid.' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/transcript
// Fetches and returns transcript for a video with language support
// ══════════════════════════════════════════════════════════════

app.get('/api/transcript', async (req, res) => {
  try {
    const { url, lang } = req.query;  // lang: 'original', 'en', 'hi'
    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractVideoId(url);
    const targetLang = lang || 'original';
    const cacheKey = `${videoId}_${targetLang}`;
    
    // Check cache first
    const cached = transcriptCache.get(cacheKey);
    if (cached && isCacheValid(cached.timestamp) && cached.transcript) {
      return res.json({
        videoId,
        transcript: cached.transcript,
        language: cached.language,
        availableLanguages: cached.availableLanguages || ['original'],
        cached: true
      });
    }

    // Create transcript directory
    const transcriptDir = path.join(TRANSCRIPT_DIR, videoId);
    if (!fs.existsSync(transcriptDir)) {
      fs.mkdirSync(transcriptDir, { recursive: true });
    }

    // First, get available subtitles info
    const listCmd = `yt-dlp --list-subs --skip-download "${url}"`;
    let availableLanguages = ['original'];
    try {
      const listOutput = await runCommand(listCmd);
      // Parse available languages
      if (listOutput.includes('en') || listOutput.includes('English')) availableLanguages.push('en');
      if (listOutput.includes('hi') || listOutput.includes('Hindi')) availableLanguages.push('hi');
    } catch (e) { /* ignore */ }

    // Determine subtitle language to download
    let subLangs = '';
    if (targetLang === 'en') {
      subLangs = 'en.*,en-IN,en-US,en-GB,en';
    } else if (targetLang === 'hi') {
      subLangs = 'hi.*,hi-IN,hi';
    } else {
      // Original - try to get any available
      subLangs = 'en.*,hi.*,en,hi';
    }

    const outputTemplate = escapePath(path.join(transcriptDir, `transcript_${targetLang}`));
    
    // Download subtitles
    const cmd = `yt-dlp --skip-download --write-subs --write-auto-subs --sub-langs "${subLangs}" --sub-format "vtt/srt/best" -o "${outputTemplate}" "${url}"`;
    
    try {
      await runCommand(cmd);
    } catch (e) {
      // Subtitles might not be available
    }

    // Find downloaded transcript file
    const files = fs.readdirSync(transcriptDir);
    const transcriptFile = files.find(f => 
      (f.startsWith(`transcript_${targetLang}`) || f.startsWith('transcript')) && 
      (f.endsWith('.vtt') || f.endsWith('.srt'))
    ) || files.find(f => f.endsWith('.vtt') || f.endsWith('.srt'));
    
    if (!transcriptFile) {
      return res.status(404).json({ error: 'No transcript available for this video' });
    }

    const transcriptPath = path.join(transcriptDir, transcriptFile);
    const content = fs.readFileSync(transcriptPath, 'utf8');
    const format = transcriptFile.endsWith('.vtt') ? 'vtt' : 'srt';

    // Parse and clean transcript
    const cleanedTranscript = parseTranscript(content, format);

    // Detect language from filename or content
    let detectedLang = 'original';
    if (transcriptFile.includes('.en') || transcriptFile.includes('en-')) detectedLang = 'en';
    else if (transcriptFile.includes('.hi') || transcriptFile.includes('hi-')) detectedLang = 'hi';

    // Cache it
    transcriptCache.set(cacheKey, {
      path: transcriptPath,
      transcript: cleanedTranscript,
      format,
      language: detectedLang,
      availableLanguages,
      timestamp: Date.now()
    });

    res.json({
      videoId,
      transcript: cleanedTranscript,
      language: detectedLang,
      availableLanguages,
      cached: false
    });
  } catch (err) {
    console.error('Error fetching transcript:', err.message);
    res.status(500).json({ error: 'Failed to fetch transcript' });
  }
});

// Parse VTT/SRT transcript to plain text with timestamps
function parseTranscript(content, format) {
  const lines = content.split('\n');
  const result = [];
  let currentTime = '';
  let currentText = '';

  if (format === 'vtt') {
    // Skip WEBVTT header
    let inCue = false;
    for (const line of lines) {
      if (line.includes('-->')) {
        // Timestamp line
        currentTime = line.split('-->')[0].trim();
        // Remove milliseconds for cleaner display
        currentTime = currentTime.replace(/\.\d+/, '');
        inCue = true;
      } else if (inCue && line.trim() && !line.startsWith('WEBVTT') && !line.match(/^\d+$/)) {
        // Text line - remove HTML tags and duplicates
        const cleanLine = line.replace(/<[^>]+>/g, '').trim();
        if (cleanLine && cleanLine !== currentText) {
          currentText = cleanLine;
          result.push({ time: currentTime, text: cleanLine });
        }
      } else if (line.trim() === '') {
        inCue = false;
      }
    }
  } else {
    // SRT format
    let inCue = false;
    for (const line of lines) {
      if (line.includes('-->')) {
        currentTime = line.split('-->')[0].trim().replace(',', '.');
        currentTime = currentTime.replace(/\.\d+/, '');
        inCue = true;
      } else if (inCue && line.trim() && !line.match(/^\d+$/)) {
        const cleanLine = line.replace(/<[^>]+>/g, '').trim();
        if (cleanLine && cleanLine !== currentText) {
          currentText = cleanLine;
          result.push({ time: currentTime, text: cleanLine });
        }
      } else if (line.trim() === '') {
        inCue = false;
      }
    }
  }

  return result;
}

// ══════════════════════════════════════════════════════════════
// POST /api/extract-frames
// Downloads video (if not cached) and extracts frames
// ══════════════════════════════════════════════════════════════

app.post('/api/extract-frames', async (req, res) => {
  const sessionId = uuidv4();
  const sessionDir = path.join(TEMP_DIR, sessionId);

  try {
    const { url, startTime, endTime, numFrames, gapSeconds, mode } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    const videoId = extractVideoId(url);
    fs.mkdirSync(sessionDir, { recursive: true });

    sessions.set(sessionId, { status: 'initializing', progress: 0 });

    // ── Step 1: Get video info ──
    const infoCmd = `yt-dlp --dump-json --no-download "${url}"`;
    const infoOutput = await runCommand(infoCmd);
    const videoInfo = JSON.parse(infoOutput);
    const videoDuration = videoInfo.duration || 0;

    const start = parseTime(startTime) || 0;
    const end = parseTime(endTime) || videoDuration;
    const segmentDuration = end - start;

    if (segmentDuration <= 0) {
      return res.status(400).json({ error: 'Invalid time range' });
    }

    // ── Step 2: Check cache or download video ──
    let videoPath;
    const cached = videoCache.get(videoId);
    const useCache = cached && isCacheValid(cached.timestamp) && fs.existsSync(cached.path);

    if (useCache) {
      // Use cached video
      sessions.set(sessionId, { status: 'using cached video', progress: 40 });
      videoPath = cached.path;
      console.log(`  📦 Using cached video: ${videoId}`);
    } else {
      // Download video
      sessions.set(sessionId, { status: 'downloading', progress: 10 });
      
      const cacheVideoPath = path.join(CACHE_DIR, `${videoId}.mp4`);
      const downloadCmd = `yt-dlp -f "bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best" --merge-output-format mp4 -o "${escapePath(cacheVideoPath)}" "${url}"`;
      
      await runCommand(downloadCmd);

      // Verify download
      if (!fs.existsSync(cacheVideoPath)) {
        const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith(videoId));
        if (files.length > 0) {
          const actualPath = path.join(CACHE_DIR, files[0]);
          fs.renameSync(actualPath, cacheVideoPath);
        } else {
          throw new Error('Video download failed');
        }
      }

      // Update cache
      videoCache.set(videoId, {
        path: cacheVideoPath,
        timestamp: Date.now(),
        duration: videoDuration,
        title: videoInfo.title
      });

      videoPath = cacheVideoPath;
      console.log(`  ✅ Downloaded and cached: ${videoId}`);
    }

    // ── Step 3: Extract frames ──
    sessions.set(sessionId, { status: 'extracting', progress: 60 });

    const framesDir = path.join(sessionDir, 'frames');
    fs.mkdirSync(framesDir, { recursive: true });

    // Get actual duration if using full video
    let actualDuration = segmentDuration;
    try {
      const probeCmd = `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${escapePath(videoPath)}"`;
      const probeDuration = await runCommand(probeCmd);
      actualDuration = parseFloat(probeDuration) || segmentDuration;
    } catch (e) { /* use calculated */ }

    // For time range extractions, we need to account for start offset
    const effectiveDuration = Math.min(segmentDuration, actualDuration);

    if (mode === 'numFrames') {
      const n = parseInt(numFrames) || 10;
      
      if (n === 1) {
        const midpoint = start + (effectiveDuration / 2);
        const framePath = escapePath(path.join(framesDir, 'frame_0001.png'));
        const extractCmd = `ffmpeg -ss ${midpoint} -i "${escapePath(videoPath)}" -frames:v 1 -q:v 1 "${framePath}" -y`;
        await runCommand(extractCmd);
      } else {
        const interval = effectiveDuration / (n - 1);
        const promises = [];
        
        for (let i = 0; i < n; i++) {
          const timestamp = start + Math.min(i * interval, effectiveDuration - 0.1);
          const frameNum = String(i + 1).padStart(4, '0');
          const framePath = escapePath(path.join(framesDir, `frame_${frameNum}.png`));
          const extractCmd = `ffmpeg -ss ${timestamp.toFixed(3)} -i "${escapePath(videoPath)}" -frames:v 1 -q:v 1 "${framePath}" -y`;
          promises.push(runCommand(extractCmd));
        }
        
        await Promise.all(promises);
      }
    } else {
      // Gap mode
      const gap = parseFloat(gapSeconds) || 1;
      const fps = 1 / gap;
      
      // Use -ss for start time and -t for duration
      const outputPattern = escapePath(path.join(framesDir, 'frame_%04d.png'));
      const extractCmd = `ffmpeg -ss ${start} -i "${escapePath(videoPath)}" -t ${effectiveDuration} -vf "fps=${fps}" -q:v 1 "${outputPattern}" -y`;
      await runCommand(extractCmd);
    }

    // ── Step 4: Collect results ──
    sessions.set(sessionId, { status: 'done', progress: 100 });

    const frameFiles = fs.readdirSync(framesDir)
      .filter(f => f.endsWith('.png') || f.endsWith('.jpg'))
      .sort();

    res.json({
      sessionId,
      videoId,
      frameCount: frameFiles.length,
      frames: frameFiles.map(f => ({
        filename: f,
        url: `/api/frames/${sessionId}/${f}`,
      })),
      videoTitle: videoInfo.title,
      wasCached: useCache,
    });

    // Cleanup after 30 minutes
    setTimeout(() => cleanupSession(sessionId), 30 * 60 * 1000);

  } catch (err) {
    console.error('Error extracting frames:', err.message);
    sessions.delete(sessionId);
    try {
      if (fs.existsSync(sessionDir)) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    } catch (e) { /* ignore */ }
    res.status(500).json({ error: err.message || 'Failed to extract frames' });
  }
});

// ══════════════════════════════════════════════════════════════
// GET /api/frames/:sessionId/:filename
// ══════════════════════════════════════════════════════════════

app.get('/api/frames/:sessionId/:filename', (req, res) => {
  const { sessionId, filename } = req.params;
  const sanitized = path.basename(filename);
  const filePath = path.join(TEMP_DIR, sessionId, 'frames', sanitized);

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Frame not found' });
  }

  res.sendFile(filePath);
});

// ══════════════════════════════════════════════════════════════
// GET /api/download-frames/:sessionId
// Download only frames as ZIP
// ══════════════════════════════════════════════════════════════

app.get('/api/download-frames/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const framesDir = path.join(TEMP_DIR, sessionId, 'frames');

  if (!fs.existsSync(framesDir)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));

  if (frameFiles.length === 0) {
    return res.status(404).json({ error: 'No frames found' });
  }

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="frames_${sessionId.slice(0, 8)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.pipe(res);

  frameFiles.forEach(file => {
    archive.file(path.join(framesDir, file), { name: `frames/${file}` });
  });

  archive.finalize();
});

// ══════════════════════════════════════════════════════════════
// GET /api/download-transcript/:videoId
// Download transcript as text file (with or without timestamps)
// ══════════════════════════════════════════════════════════════

app.get('/api/download-transcript/:videoId', (req, res) => {
  const { videoId } = req.params;
  const { timestamps } = req.query; // 'true' or 'false'
  const withTimestamps = timestamps !== 'false';
  
  // Find any cached transcript for this video
  let cached = null;
  for (const [key, value] of transcriptCache.entries()) {
    if (key.startsWith(videoId)) {
      cached = value;
      break;
    }
  }
  
  if (!cached || !cached.transcript) {
    return res.status(404).json({ error: 'Transcript not found' });
  }

  let plainText;
  if (withTimestamps) {
    plainText = cached.transcript.map(item => `[${item.time}] ${item.text}`).join('\n');
  } else {
    plainText = cached.transcript.map(item => item.text).join('\n');
  }
  
  const filename = withTimestamps ? `transcript_${videoId}_with_timestamps.txt` : `transcript_${videoId}.txt`;
  
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(plainText);
});

// ══════════════════════════════════════════════════════════════
// GET /api/download-all/:sessionId
// Download frames + transcript as ZIP
// ══════════════════════════════════════════════════════════════

app.get('/api/download-all/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const { videoId } = req.query;
  
  const framesDir = path.join(TEMP_DIR, sessionId, 'frames');

  if (!fs.existsSync(framesDir)) {
    return res.status(404).json({ error: 'Session not found' });
  }

  const frameFiles = fs.readdirSync(framesDir).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="youtube_extract_${sessionId.slice(0, 8)}.zip"`);

  const archive = archiver('zip', { zlib: { level: 1 } });
  archive.pipe(res);

  // Add frames
  frameFiles.forEach(file => {
    archive.file(path.join(framesDir, file), { name: `frames/${file}` });
  });

  // Add transcript if available
  if (videoId) {
    let cached = null;
    for (const [key, value] of transcriptCache.entries()) {
      if (key.startsWith(videoId) && isCacheValid(value.timestamp) && fs.existsSync(value.path)) {
        cached = value;
        break;
      }
    }
    if (cached && fs.existsSync(cached.path)) {
      const content = fs.readFileSync(cached.path, 'utf8');
      const parsed = parseTranscript(content, cached.format);
      const plainText = parsed.map(item => `[${item.time}] ${item.text}`).join('\n');
      
      archive.append(plainText, { name: 'transcript.txt' });
      archive.append(content, { name: `transcript.${cached.format}` });
    }
  }

  archive.finalize();
});

// ══════════════════════════════════════════════════════════════
// DELETE /api/cleanup/:sessionId
// ══════════════════════════════════════════════════════════════

app.delete('/api/cleanup/:sessionId', (req, res) => {
  cleanupSession(req.params.sessionId);
  res.json({ message: 'Cleaned up' });
});

function cleanupSession(sessionId) {
  const sessionDir = path.join(TEMP_DIR, sessionId);
  try {
    if (fs.existsSync(sessionDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    sessions.delete(sessionId);
  } catch (e) {
    console.error('Cleanup error:', e.message);
  }
}

// ══════════════════════════════════════════════════════════════
// GET /api/cache-status
// Get cache status for debugging
// ══════════════════════════════════════════════════════════════

app.get('/api/cache-status', (req, res) => {
  const videos = [];
  for (const [id, data] of videoCache.entries()) {
    videos.push({
      id,
      title: data.title,
      valid: isCacheValid(data.timestamp) && fs.existsSync(data.path),
      age: Math.round((Date.now() - data.timestamp) / 1000 / 60) + ' minutes'
    });
  }
  
  const transcripts = [];
  for (const [id, data] of transcriptCache.entries()) {
    transcripts.push({
      id,
      format: data.format,
      valid: isCacheValid(data.timestamp) && fs.existsSync(data.path)
    });
  }
  
  res.json({ videos, transcripts });
});

// ══════════════════════════════════════════════════════════════
// Cleanup old cache files
// ══════════════════════════════════════════════════════════════

function cleanupOldFiles() {
  const now = Date.now();

  if (fs.existsSync(CACHE_DIR)) {
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      const filePath = path.join(CACHE_DIR, file);
      try {
        const stats = fs.statSync(filePath);
        if (stats.isFile() && (now - stats.mtimeMs) > CACHE_EXPIRY) {
          fs.unlinkSync(filePath);
          console.log(`  🧹 Removed old cached video file: ${file}`);
        }
      } catch (e) { /* ignore */ }
    }
  }

  if (fs.existsSync(TRANSCRIPT_DIR)) {
    const entries = fs.readdirSync(TRANSCRIPT_DIR);
    for (const entry of entries) {
      const entryPath = path.join(TRANSCRIPT_DIR, entry);
      try {
        const stats = fs.statSync(entryPath);
        if (stats.isDirectory() && (now - stats.mtimeMs) > CACHE_EXPIRY) {
          fs.rmSync(entryPath, { recursive: true, force: true });
          console.log(`  🧹 Removed old transcript folder: ${entry}`);
        }
      } catch (e) { /* ignore */ }
    }
  }

  for (const [id, data] of videoCache.entries()) {
    const expired = !isCacheValid(data.timestamp);
    const missingFile = !data.path || !fs.existsSync(data.path);
    if (expired || missingFile) {
      try {
        if (data.path && fs.existsSync(data.path)) {
          fs.unlinkSync(data.path);
        }
      } catch (e) { /* ignore */ }
      videoCache.delete(id);
      console.log(`  🧹 Removed expired video cache metadata: ${id}`);
    }
  }

  for (const [id, data] of transcriptCache.entries()) {
    const expired = !isCacheValid(data.timestamp);
    const missingFile = !data.path || !fs.existsSync(data.path);
    if (expired || missingFile) {
      try {
        const dir = data.path ? path.dirname(data.path) : '';
        if (dir && fs.existsSync(dir)) {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      } catch (e) { /* ignore */ }
      transcriptCache.delete(id);
      console.log(`  🧹 Removed expired transcript cache metadata: ${id}`);
    }
  }

  if (fs.existsSync(TEMP_DIR)) {
    const entries = fs.readdirSync(TEMP_DIR);
    for (const entry of entries) {
      const entryPath = path.join(TEMP_DIR, entry);
      try {
        const stats = fs.statSync(entryPath);
        if (stats.isDirectory() && (now - stats.mtimeMs) > TEMP_SESSION_EXPIRY) {
          fs.rmSync(entryPath, { recursive: true, force: true });
          sessions.delete(entry);
          console.log(`  🧹 Cleaned up old session: ${entry}`);
        }
      } catch (e) { /* ignore */ }
    }
  }
}

// ══════════════════════════════════════════════════════════════
// Start Server
// ══════════════════════════════════════════════════════════════

const server = app.listen(PORT, () => {
  console.log(`\n  🎬 YouTube Frame Extractor`);
  console.log(`  ─────────────────────────`);
  console.log(`  Server running at: http://localhost:${PORT}`);
  console.log(`  Press Ctrl+C to stop\n`);

  try {
    execSync('yt-dlp --version', { stdio: 'pipe', env: enrichedEnv });
    console.log('  ✅ yt-dlp found');
  } catch {
    console.log('  ❌ yt-dlp not found! Install: pip install yt-dlp');
  }
  
  try {
    execSync('ffmpeg -version', { stdio: 'pipe', env: enrichedEnv });
    console.log('  ✅ ffmpeg found');
  } catch {
    console.log('  ❌ ffmpeg not found! Download from https://ffmpeg.org');
  }
  
  console.log('');
  cleanupOldFiles();
});

// Run cleanup every 30 minutes
setInterval(cleanupOldFiles, 30 * 60 * 1000);

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n  👋 Shutting down...');
  server.close(() => process.exit(0));
});

process.on('SIGTERM', () => {
  console.log('\n  👋 Shutting down...');
  server.close(() => process.exit(0));
});
