const state = {
  searchResults: [],
  favorites: [],
  currentQueue: [],
  currentIndex: -1,
  isPlaying: false,
  isShuffle: false,
  currentView: 'search-view'
};

const audioEngine = document.getElementById('audio-engine');
const trackTable = document.getElementById('track-table');
const viewTitle = document.getElementById('view-title');
const favCountSpan = document.getElementById('fav-count');
const searchInput = document.getElementById('search-input');
const searchButton = document.getElementById('search-button');
const searchBoxWrapper = document.getElementById('search-box-wrapper');
const playBtn = document.getElementById('btn-play');
const prevBtn = document.getElementById('btn-prev');
const nextBtn = document.getElementById('btn-next');
const shuffleBtn = document.getElementById('btn-shuffle');
const favBtn = document.getElementById('btn-fav');
const progressTimeline = document.getElementById('progress-timeline');
const volumeSlider = document.getElementById('volume-slider');
const timeCurrent = document.getElementById('time-current');
const timeTotal = document.getElementById('time-total');
const playerCover = document.getElementById('player-cover');
const playerTitle = document.getElementById('player-title');
const playerArtist = document.getElementById('player-artist');

const SVG_PLACEHOLDER = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='50' height='50' viewBox='0 0 50 50'><rect width='50' height='50' fill='%23282828'/><text x='50%' y='55%' font-family='sans-serif' font-size='18' fill='%231DB954' text-anchor='middle'>🎵</text></svg>";

function init() {
  setupEventListeners();
  loadSavedFavorites();
  playerCover.src = SVG_PLACEHOLDER;
  executeSearch("anendlessocean");
}

async function executeSearch(query) {
  if (!query || query.trim() === "") return;
  viewTitle.textContent = "Loading tracks...";

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.searchResults = await res.json();
    state.currentView = 'search-view';
    rebuildPlaybackQueue();
    renderTrackDisplayList();
  } catch (err) {
    viewTitle.textContent = "Search Offline";
    trackTable.innerHTML = `<li style="padding:20px; cursor:default; color:#ff5555;">Network connection failed.</li>`;
  }
}

function rebuildPlaybackQueue() {
  state.currentQueue = state.currentView === 'favorites'
    ? [...state.favorites]
    : [...state.searchResults];
  if (state.isShuffle) executeFisherYatesShuffle();
}

function executeFisherYatesShuffle() {
  const queue = state.currentQueue;
  const currentTrack = queue[state.currentIndex];
  for (let i = queue.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [queue[i], queue[j]] = [queue[j], queue[i]];
  }
  if (currentTrack) {
    state.currentIndex = queue.findIndex(t => t.id === currentTrack.id);
  }
}

function renderTrackDisplayList() {
  trackTable.innerHTML = '';
  viewTitle.textContent = state.currentView === 'favorites' ? 'My Favorites' : 'Search Results';
  const tracksToDraw = state.currentView === 'favorites' ? state.favorites : state.searchResults;

  if (!tracksToDraw || tracksToDraw.length === 0) {
    trackTable.innerHTML = `<li style="padding:20px; cursor:default; opacity:0.5;">No tracks to display.</li>`;
    return;
  }

  tracksToDraw.forEach((track, index) => {
    const itemRow = document.createElement('li');
    itemRow.className = 'track-entry';

    const activeTrackObj = state.currentQueue[state.currentIndex];
    if (activeTrackObj && activeTrackObj.id === track.id) {
      itemRow.classList.add('active-playing');
    }

    itemRow.innerHTML = `
      <span class="entry-index">${index + 1}</span>
      <img class="entry-thumbnail" src="${SVG_PLACEHOLDER}" alt="Cover">
      <div class="entry-meta">
        <div class="entry-title"></div>
        <div class="entry-artist"></div>
      </div>
    `;

    itemRow.querySelector('.entry-title').textContent = track.title || 'Untitled';
    itemRow.querySelector('.entry-artist').textContent = track.artist || 'Unknown';

    itemRow.addEventListener('click', () => {
      rebuildPlaybackQueue();
      state.currentIndex = state.currentQueue.findIndex(t => t.id === track.id);
      resolveAndPlay();
    });

    trackTable.appendChild(itemRow);
  });
}

async function resolveAndPlay() {
  const targetTrack = state.currentQueue[state.currentIndex];
  if (!targetTrack) return;

  playerTitle.textContent = "Loading...";
  playerArtist.textContent = targetTrack.artist;
  playerCover.src = SVG_PLACEHOLDER;

  try {
    audioEngine.src = `/api/stream/${targetTrack.id}`;
    playerTitle.textContent = targetTrack.title;
    updateFavoriteButtonUI();
    state.isPlaying = true;
    playBtn.textContent = '⏸';
    audioEngine.play().catch(() => {});
    renderTrackDisplayList();
  } catch (error) {
    playerTitle.textContent = "Error — Try another track";
  }
}

function handlePlayPauseAction() {
  if (state.currentIndex === -1 && state.currentQueue.length > 0) {
    state.currentIndex = 0;
    resolveAndPlay();
    return;
  }
  if (state.isPlaying) {
    audioEngine.pause();
    playBtn.textContent = '▶';
    state.isPlaying = false;
  } else {
    audioEngine.play();
    playBtn.textContent = '⏸';
    state.isPlaying = true;
  }
}

function skipNext() {
  if (state.currentQueue.length === 0) return;
  state.currentIndex = (state.currentIndex + 1) % state.currentQueue.length;
  resolveAndPlay();
}

function skipPrevious() {
  if (state.currentQueue.length === 0) return;
  state.currentIndex = state.currentIndex <= 0
    ? state.currentQueue.length - 1
    : state.currentIndex - 1;
  resolveAndPlay();
}

function toggleShuffleState() {
  state.isShuffle = !state.isShuffle;
  shuffleBtn.classList.toggle('active', state.isShuffle);
  rebuildPlaybackQueue();
}

function mutateFavoriteStatus() {
  const track = state.currentQueue[state.currentIndex];
  if (!track) return;
  const foundIndex = state.favorites.findIndex(f => f.id === track.id);
  if (foundIndex > -1) {
    state.favorites.splice(foundIndex, 1);
  } else {
    state.favorites.push(track);
  }
  saveFavoritesToStorage();
  updateFavoriteButtonUI();
  favCountSpan.textContent = state.favorites.length;
  if (state.currentView === 'favorites') {
    rebuildPlaybackQueue();
    renderTrackDisplayList();
  }
}

function updateFavoriteButtonUI() {
  const currentTrack = state.currentQueue[state.currentIndex];
  const isFav = currentTrack && state.favorites.some(f => f.id === currentTrack.id);
  favBtn.textContent = isFav ? '♥' : '♡';
  favBtn.style.color = isFav ? '#1db954' : '#bababa';
}

function cleanTimeConversion(seconds) {
  if (isNaN(seconds)) return '0:00';
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = Math.floor(seconds % 60);
  return `${minutes}:${remainingSeconds < 10 ? '0' : ''}${remainingSeconds}`;
}

function saveFavoritesToStorage() {
  localStorage.setItem('youtube_jukebox_favs', JSON.stringify(state.favorites));
}

function loadSavedFavorites() {
  const stored = localStorage.getItem('youtube_jukebox_favs');
  if (stored) {
    state.favorites = JSON.parse(stored);
    favCountSpan.textContent = state.favorites.length;
  }
}

function setupEventListeners() {
  searchButton.addEventListener('click', (e) => {
    e.preventDefault();
    executeSearch(searchInput.value);
  });

  searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      executeSearch(searchInput.value);
    }
  });

  playBtn.addEventListener('click', handlePlayPauseAction);
  nextBtn.addEventListener('click', skipNext);
  prevBtn.addEventListener('click', skipPrevious);
  shuffleBtn.addEventListener('click', toggleShuffleState);
  favBtn.addEventListener('click', mutateFavoriteStatus);

  audioEngine.addEventListener('timeupdate', () => {
    if (audioEngine.duration) {
      progressTimeline.value = (audioEngine.currentTime / audioEngine.duration) * 100;
      timeCurrent.textContent = cleanTimeConversion(audioEngine.currentTime);
    }
  });

  audioEngine.addEventListener('loadedmetadata', () => {
    timeTotal.textContent = cleanTimeConversion(audioEngine.duration);
  });

  audioEngine.addEventListener('ended', skipNext);

  progressTimeline.addEventListener('input', () => {
    if (audioEngine.duration) {
      audioEngine.currentTime = (progressTimeline.value / 100) * audioEngine.duration;
    }
  });

  volumeSlider.addEventListener('input', () => {
    audioEngine.volume = volumeSlider.value;
  });

  document.querySelectorAll('.navigation-menu .menu-item').forEach(tab => {
    tab.addEventListener('click', (e) => {
      const target = e.target.closest('.menu-item');
      document.querySelectorAll('.navigation-menu .menu-item').forEach(t => t.classList.remove('active'));
      target.classList.add('active');
      state.currentView = target.dataset.type;
      searchBoxWrapper.style.display = state.currentView === 'search-view' ? 'flex' : 'none';
      rebuildPlaybackQueue();
      renderTrackDisplayList();
    });
  });
}

init();