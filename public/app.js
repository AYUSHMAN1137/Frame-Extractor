/* Frame Extractor - JavaScript */

(function () {
  'use strict';

  // DOM Elements
  function $(id) { return document.getElementById(id); }

  var urlInput = $('urlInput');
  var pasteBtn = $('pasteBtn');
  var fetchBtn = $('fetchBtn');
  var videoInfo = $('videoInfo');
  var videoThumb = $('videoThumb');
  var videoTitle = $('videoTitle');
  var videoChannel = $('videoChannel');
  var videoDuration = $('videoDuration');
  var videoCached = $('videoCached');

  var settingsSection = $('settingsSection');
  var startMin = $('startMin');
  var startSec = $('startSec');
  var endMin = $('endMin');
  var endSec = $('endSec');
  var fromStartBtn = $('fromStartBtn');
  var tillEndBtn = $('tillEndBtn');

  var modeNumFrames = $('modeNumFrames');
  var modeGap = $('modeGap');
  var numFramesField = $('numFramesField');
  var gapField = $('gapField');
  var numFramesInput = $('numFramesInput');
  var gapInput = $('gapInput');
  var frameHint = $('frameHint');
  var transcriptCheckbox = $('transcriptCheckbox');
  var extractBtn = $('extractBtn');

  var progressSection = $('progressSection');
  var progressTitle = $('progressTitle');
  var progressDesc = $('progressDesc');

  var transcriptSection = $('transcriptSection');
  var transcriptToggle = $('transcriptToggle');
  var transcriptContent = $('transcriptContent');
  var transcriptLoading = $('transcriptLoading');
  var transcriptError = $('transcriptError');
  var transcriptText = $('transcriptText');
  var langSelect = $('langSelect');
  var downloadTranscriptWithTime = $('downloadTranscriptWithTime');
  var downloadTranscriptPlain = $('downloadTranscriptPlain');

  var resultsSection = $('resultsSection');
  var frameCountBadge = $('frameCountBadge');
  var framesGrid = $('framesGrid');
  var downloadAllBtn = $('downloadAllBtn');
  var newExtractionBtn = $('newExtractionBtn');

  var lightbox = $('lightbox');
  var lightboxImg = $('lightboxImg');
  var lightboxClose = $('lightboxClose');
  var lightboxPrev = $('lightboxPrev');
  var lightboxNext = $('lightboxNext');
  var lightboxCounter = $('lightboxCounter');
  var lightboxDownload = $('lightboxDownload');

  var errorToast = $('errorToast');
  var errorMessage = $('errorMessage');
  var successToast = $('successToast');
  var successMessage = $('successMessage');

  // State
  var currentVideoData = null;
  var currentVideoId = null;
  var currentMode = 'numFrames';
  var currentSessionId = null;
  var currentFrames = [];
  var currentLightboxIndex = 0;
  var hasTranscript = false;
  var transcriptCollapsed = false;
  var STORAGE_KEY = 'frame_extractor_state_v1';

  // Utilities
  function formatDuration(seconds) {
    if (!seconds || seconds <= 0) return '0:00';
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    if (h > 0) {
      return h + ':' + pad(m) + ':' + pad(s);
    }
    return m + ':' + pad(s);
  }

  function pad(n) { return String(n).padStart(2, '0'); }

  function getStartSeconds() {
    var min = parseInt(startMin.value) || 0;
    var sec = parseInt(startSec.value) || 0;
    return min * 60 + sec;
  }

  function getEndSeconds() {
    if (!currentVideoData) return 0;
    var min = parseInt(endMin.value);
    var sec = parseInt(endSec.value);
    if (isNaN(min) && isNaN(sec)) {
      return currentVideoData.duration;
    }
    return (min || 0) * 60 + (sec || 0);
  }

  function formatTimeForAPI(seconds) {
    if (seconds === null || seconds === undefined) return null;
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = Math.floor(seconds % 60);
    return pad(h) + ':' + pad(m) + ':' + pad(s);
  }

  function showError(msg) {
    errorMessage.textContent = msg;
    errorToast.classList.remove('hidden');
    setTimeout(function() { errorToast.classList.add('hidden'); }, 5000);
  }

  function showSuccess(msg) {
    successMessage.textContent = msg;
    successToast.classList.remove('hidden');
    setTimeout(function() { successToast.classList.add('hidden'); }, 3000);
  }

  function escapeHtml(text) {
    var div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function saveState() {
    try {
      var state = {
        url: urlInput.value.trim(),
        currentVideoData: currentVideoData,
        currentVideoId: currentVideoId,
        currentMode: currentMode,
        currentSessionId: currentSessionId,
        currentFrames: currentFrames,
        hasTranscript: hasTranscript,
        transcriptChecked: !!transcriptCheckbox.checked,
        fromStartActive: fromStartBtn.classList.contains('active'),
        tillEndActive: tillEndBtn.classList.contains('active'),
        startMin: startMin.value,
        startSec: startSec.value,
        endMin: endMin.value,
        endSec: endSec.value,
        numFrames: numFramesInput.value,
        gap: gapInput.value
      };
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {}
  }

  function clearState() {
    try {
      sessionStorage.removeItem(STORAGE_KEY);
    } catch (e) {}
  }

  function renderFrames() {
    frameCountBadge.textContent = currentFrames.length;
    framesGrid.innerHTML = '';
    currentFrames.forEach(function(frameUrl, i) {
      var div = document.createElement('div');
      div.className = 'frame-item';
      div.innerHTML = '<img src="' + frameUrl + '" alt="Frame ' + (i + 1) + '">' +
        '<div class="frame-overlay"><span class="frame-number">' + (i + 1) + '</span></div>';
      div.addEventListener('click', function() { openLightbox(i); });
      framesGrid.appendChild(div);
    });
  }

  function applyMode(mode) {
    currentMode = mode === 'gap' ? 'gap' : 'numFrames';
    if (currentMode === 'gap') {
      modeGap.classList.add('active');
      modeNumFrames.classList.remove('active');
      gapField.classList.remove('hidden');
      numFramesField.classList.add('hidden');
    } else {
      modeNumFrames.classList.add('active');
      modeGap.classList.remove('active');
      numFramesField.classList.remove('hidden');
      gapField.classList.add('hidden');
    }
    updateHint();
  }

  function restoreState() {
    var raw;
    try {
      raw = sessionStorage.getItem(STORAGE_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;

    try {
      var state = JSON.parse(raw);
      if (state.url) {
        urlInput.value = state.url;
      }
      if (state.currentVideoData) {
        currentVideoData = state.currentVideoData;
        currentVideoId = state.currentVideoId;
        videoThumb.src = currentVideoData.thumbnail || '';
        videoTitle.textContent = currentVideoData.title || 'Unknown';
        var chSvg = videoChannel.querySelector('svg').outerHTML;
        videoChannel.innerHTML = chSvg + ' ' + (currentVideoData.channel || 'Unknown');
        var durSvg = videoDuration.querySelector('svg').outerHTML;
        videoDuration.innerHTML = durSvg + ' ' + formatDuration(currentVideoData.duration);
        if (currentVideoData.isCached) {
          videoCached.classList.remove('hidden');
        }
        videoInfo.classList.remove('hidden');
        settingsSection.classList.remove('hidden');
        extractBtn.classList.remove('hidden');
      }

      startMin.value = state.startMin || '';
      startSec.value = state.startSec || '';
      endMin.value = state.endMin || '';
      endSec.value = state.endSec || '';
      numFramesInput.value = state.numFrames || '10';
      gapInput.value = state.gap || '5';
      transcriptCheckbox.checked = !!state.transcriptChecked;

      fromStartBtn.classList.toggle('active', !!state.fromStartActive);
      tillEndBtn.classList.toggle('active', !!state.tillEndActive);
      applyMode(state.currentMode || 'numFrames');

      currentSessionId = state.currentSessionId || null;
      currentFrames = Array.isArray(state.currentFrames) ? state.currentFrames : [];
      hasTranscript = !!state.hasTranscript;

      if (currentFrames.length > 0 && currentSessionId) {
        resultsSection.classList.remove('hidden');
        renderFrames();
      }

      if (transcriptCheckbox.checked && currentVideoId) {
        fetchTranscript(urlInput.value.trim());
      }

      updateHint();
    } catch (e) {
      clearState();
    }
  }

  function updateHint() {
    if (!currentVideoData) {
      frameHint.textContent = '10 frames, evenly distributed';
      return;
    }
    var start = getStartSeconds();
    var end = getEndSeconds();
    var duration = Math.max(1, end - start);

    if (currentMode === 'numFrames') {
      var n = parseInt(numFramesInput.value) || 10;
      if (n === 1) {
        frameHint.textContent = 'Single frame from middle';
      } else {
        var interval = duration / (n - 1);
        frameHint.textContent = n + ' frames, every ' + interval.toFixed(1) + 's';
      }
    } else {
      var gap = parseFloat(gapInput.value) || 5;
      var frames = Math.floor(duration / gap);
      frameHint.textContent = '~' + frames + ' frames (every ' + gap + 's)';
    }
  }

  // Paste button
  pasteBtn.addEventListener('click', function() {
    if (navigator.clipboard && navigator.clipboard.readText) {
      navigator.clipboard.readText().then(function(text) {
        urlInput.value = text;
      }).catch(function() {
        showError('Unable to paste');
      });
    }
  });

  // Fetch video info
  fetchBtn.addEventListener('click', function() {
    var url = urlInput.value.trim();
    if (!url) {
      showError('Please enter a YouTube URL');
      return;
    }

    var ytRegex = /^(https?:\/\/)?(www\.)?(youtube\.com\/(watch\?v=|embed\/|shorts\/)|youtu\.be\/)/;
    if (!ytRegex.test(url)) {
      showError('Invalid YouTube URL');
      return;
    }

    fetchBtn.disabled = true;
    fetchBtn.innerHTML = '<svg class="spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10" stroke-dasharray="32" stroke-linecap="round"/></svg> Loading...';

    transcriptSection.classList.add('hidden');
    hasTranscript = false;

    fetch('/api/video-info?url=' + encodeURIComponent(url))
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.error) throw new Error(data.error);

        currentVideoData = data;
        currentVideoId = data.videoId;

        videoThumb.src = data.thumbnail || '';
        videoTitle.textContent = data.title || 'Unknown';

        var chSvg = videoChannel.querySelector('svg').outerHTML;
        videoChannel.innerHTML = chSvg + ' ' + (data.channel || 'Unknown');

        var durSvg = videoDuration.querySelector('svg').outerHTML;
        videoDuration.innerHTML = durSvg + ' ' + formatDuration(data.duration);

        if (data.isCached) {
          videoCached.classList.remove('hidden');
          showSuccess('Video cached - fast extraction!');
        } else {
          videoCached.classList.add('hidden');
        }

        videoInfo.classList.remove('hidden');
        settingsSection.classList.remove('hidden');
        extractBtn.classList.remove('hidden');

        startMin.value = '';
        startSec.value = '';
        endMin.value = '';
        endSec.value = '';

        updateHint();
        saveState();

        if (transcriptCheckbox.checked) {
          fetchTranscript(url);
        }
      })
      .catch(function(err) {
        showError(err.message);
      })
      .finally(function() {
        fetchBtn.disabled = false;
        fetchBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="8"/><path d="M21 21l-4.35-4.35"/></svg> Fetch';
      });
  });

  // Transcript checkbox
  transcriptCheckbox.addEventListener('change', function() {
    saveState();
    if (transcriptCheckbox.checked && currentVideoId) {
      fetchTranscript(urlInput.value.trim());
    } else {
      transcriptSection.classList.add('hidden');
      hasTranscript = false;
    }
  });

  function fetchTranscript(url) {
    transcriptSection.classList.remove('hidden');
    transcriptLoading.classList.remove('hidden');
    transcriptError.classList.add('hidden');
    transcriptText.innerHTML = '';

    var lang = (langSelect && langSelect.value) ? langSelect.value : 'original';
    fetch('/api/transcript?url=' + encodeURIComponent(url) + '&lang=' + encodeURIComponent(lang))
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.error) throw new Error(data.error);

        hasTranscript = true;
        transcriptLoading.classList.add('hidden');

        var html = '';
        data.transcript.forEach(function(item) {
          html += '<div class="transcript-line">';
          html += '<span class="transcript-time">' + item.time + '</span>';
          html += '<span>' + escapeHtml(item.text) + '</span>';
          html += '</div>';
        });
        transcriptText.innerHTML = html;
        saveState();
      })
      .catch(function(err) {
        transcriptLoading.classList.add('hidden');
        transcriptError.classList.remove('hidden');
        transcriptError.textContent = 'No transcript available';
        hasTranscript = false;
      });
  }

  if (langSelect) {
    langSelect.addEventListener('change', function() {
      if (transcriptCheckbox.checked && currentVideoId) {
        fetchTranscript(urlInput.value.trim());
      }
    });
  }

  // Transcript toggle
  transcriptToggle.addEventListener('click', function() {
    transcriptCollapsed = !transcriptCollapsed;
    if (transcriptCollapsed) {
      transcriptContent.classList.add('collapsed');
      transcriptToggle.style.transform = 'rotate(180deg)';
    } else {
      transcriptContent.classList.remove('collapsed');
      transcriptToggle.style.transform = '';
    }
  });

  // Mode toggle
  modeNumFrames.addEventListener('click', function() {
    applyMode('numFrames');
    saveState();
  });

  modeGap.addEventListener('click', function() {
    applyMode('gap');
    saveState();
  });

  // Time buttons
  fromStartBtn.addEventListener('click', function() {
    fromStartBtn.classList.toggle('active');
    if (fromStartBtn.classList.contains('active')) {
      startMin.value = '';
      startSec.value = '';
    }
    updateHint();
    saveState();
  });

  tillEndBtn.addEventListener('click', function() {
    tillEndBtn.classList.toggle('active');
    if (tillEndBtn.classList.contains('active')) {
      endMin.value = '';
      endSec.value = '';
    }
    updateHint();
    saveState();
  });

  // Input listeners
  [startMin, startSec, endMin, endSec, numFramesInput, gapInput].forEach(function(el) {
    el.addEventListener('input', function() {
      if (el === startMin || el === startSec) {
        fromStartBtn.classList.remove('active');
      }
      if (el === endMin || el === endSec) {
        tillEndBtn.classList.remove('active');
      }
      updateHint();
      saveState();
    });
  });

  // Extract frames
  extractBtn.addEventListener('click', function() {
    if (!currentVideoData) {
      showError('Please fetch video info first');
      return;
    }

    var url = urlInput.value.trim();
    var startTime = null;
    var endTime = null;

    if (!fromStartBtn.classList.contains('active')) {
      startTime = formatTimeForAPI(getStartSeconds());
    }
    if (!tillEndBtn.classList.contains('active')) {
      endTime = formatTimeForAPI(getEndSeconds());
    }

    var body = {
      url: url,
      startTime: startTime,
      endTime: endTime,
      mode: currentMode
    };

    if (currentMode === 'numFrames') {
      body.numFrames = parseInt(numFramesInput.value) || 10;
    } else {
      body.gapSeconds = parseFloat(gapInput.value) || 5;
    }

    extractBtn.disabled = true;
    progressSection.classList.remove('hidden');
    resultsSection.classList.add('hidden');
    progressTitle.textContent = 'Processing...';
    progressDesc.textContent = currentVideoData.isCached ? 'Using cached video' : 'Downloading video';

    fetch('/api/extract-frames', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
      .then(function(res) { return res.json(); })
      .then(function(data) {
        if (data.error) throw new Error(data.error);

        currentSessionId = data.sessionId;
        
        // Extract URLs from frame objects
        currentFrames = data.frames.map(function(f) {
          return typeof f === 'object' ? f.url : f;
        });

        progressSection.classList.add('hidden');
        resultsSection.classList.remove('hidden');

        renderFrames();

        showSuccess('Extracted ' + currentFrames.length + ' frames!');

        // Mark video as cached now
        videoCached.classList.remove('hidden');
        saveState();
      })
      .catch(function(err) {
        progressSection.classList.add('hidden');
        showError(err.message);
      })
      .finally(function() {
        extractBtn.disabled = false;
      });
  });

  // Download all
  downloadAllBtn.addEventListener('click', function() {
    if (!currentSessionId) return;

    var downloadUrl = '/api/download-all/' + currentSessionId;
    if (hasTranscript && currentVideoId) {
      downloadUrl += '?videoId=' + encodeURIComponent(currentVideoId);
    }

    var a = document.createElement('a');
    a.href = downloadUrl;
    a.download = '';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    showSuccess('Download started');
  });

  // Download transcript
  downloadTranscriptWithTime.addEventListener('click', function() {
    if (!currentVideoId) return;
    window.location.href = '/api/download-transcript/' + currentVideoId + '?timestamps=true';
  });

  downloadTranscriptPlain.addEventListener('click', function() {
    if (!currentVideoId) return;
    window.location.href = '/api/download-transcript/' + currentVideoId + '?timestamps=false';
  });

  // New extraction
  newExtractionBtn.addEventListener('click', function() {
    resultsSection.classList.add('hidden');
    transcriptSection.classList.add('hidden');
    currentFrames = [];
    currentSessionId = null;
    framesGrid.innerHTML = '';
    numFramesInput.value = 10;
    clearState();
    updateHint();
  });

  // Lightbox
  function openLightbox(index) {
    if (!currentFrames.length) return;
    currentLightboxIndex = index;
    updateLightbox();
    lightbox.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
  }

  function closeLightbox() {
    lightbox.classList.add('hidden');
    document.body.style.overflow = '';
  }

  function updateLightbox() {
    var frame = currentFrames[currentLightboxIndex];
    lightboxImg.src = frame;
    lightboxCounter.textContent = (currentLightboxIndex + 1) + ' / ' + currentFrames.length;
    lightboxDownload.href = frame;
    lightboxDownload.download = 'frame_' + (currentLightboxIndex + 1) + '.jpg';
  }

  lightboxClose.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', function(e) {
    if (e.target === lightbox) closeLightbox();
  });

  lightboxPrev.addEventListener('click', function(e) {
    e.stopPropagation();
    currentLightboxIndex = (currentLightboxIndex - 1 + currentFrames.length) % currentFrames.length;
    updateLightbox();
  });

  lightboxNext.addEventListener('click', function(e) {
    e.stopPropagation();
    currentLightboxIndex = (currentLightboxIndex + 1) % currentFrames.length;
    updateLightbox();
  });

  document.addEventListener('keydown', function(e) {
    if (lightbox.classList.contains('hidden')) return;
    if (e.key === 'Escape') closeLightbox();
    if (e.key === 'ArrowLeft') lightboxPrev.click();
    if (e.key === 'ArrowRight') lightboxNext.click();
  });

  // Enter key on URL input
  urlInput.addEventListener('keypress', function(e) {
    if (e.key === 'Enter') fetchBtn.click();
  });

  // Initialize
  restoreState();
  updateHint();

})();
