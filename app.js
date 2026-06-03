// ── State ──────────────────────────────────────────────────────────────────

const USERS = ['Nick', 'Matt', 'Friend'];
const USER_LABELS = { Nick: 'Nick', Matt: 'Matt', Friend: 'Friend of Homyak' };

let state = {
  currentUser: null,
  movies: [],      // { id, title, year, director, scores: { Nick: 0, Matt: 0, Friend: 0 } }
  battles: [],     // { a, b, winner, points, user, ts }
  battleA: null,
  battleB: null,
  leaderboardFilter: 'all',
};

const STORAGE_KEY = 'homyak100_v1';

function loadState() {
  let savedMovies = [];
  let savedBattles = [];
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    if (saved) {
      savedMovies = saved.movies || [];
      savedBattles = saved.battles || [];
    }
  } catch (e) {}

  state.battles = savedBattles;

  // Build a score map from saved data keyed by title (titles are the stable identifier)
  const savedScores = {};
  for (const m of savedMovies) {
    savedScores[m.title] = m.scores || { Nick: 0, Matt: 0, Friend: 0 };
  }

  // Base roster is always MOVIES — preserving scores for known titles
  const canonicalTitles = new Set(MOVIES.map(m => m.title));
  state.movies = MOVIES.map((m, i) => ({
    id: i + 1,
    title: m.title,
    year: m.year,
    director: m.director,
    scores: savedScores[m.title] || { Nick: 0, Matt: 0, Friend: 0 },
  }));

  // Re-attach any custom user-added movies (titles not in the canonical list)
  let nextId = MOVIES.length + 1;
  for (const m of savedMovies) {
    if (!canonicalTitles.has(m.title)) {
      state.movies.push({ ...m, id: nextId++ });
    }
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    movies: state.movies,
    battles: state.battles,
  }));
}

// ── Score helpers ───────────────────────────────────────────────────────────

function totalScore(movie) {
  return (movie.scores.Nick || 0) + (movie.scores.Matt || 0) + (movie.scores.Friend || 0);
}

function filteredScore(movie, filter) {
  if (filter === 'all') return totalScore(movie);
  return movie.scores[filter] || 0;
}

function getLeaderboard(filter) {
  return [...state.movies]
    .sort((a, b) => filteredScore(b, filter) - filteredScore(a, filter));
}

function getRank(movieId, filter) {
  const lb = getLeaderboard(filter);
  return lb.findIndex(m => m.id === movieId) + 1;
}

// ── User selection ──────────────────────────────────────────────────────────

function selectUser(user) {
  state.currentUser = user;
  document.getElementById('current-user-label').textContent = USER_LABELS[user];
  document.getElementById('screen-user').classList.remove('active');
  document.getElementById('screen-main').classList.add('active');
  const view = currentHashView();
  showView(view, false);
  if (view !== 'leaderboard') renderLeaderboard();
  if (view !== 'movies') renderMoviesView();
  if (view === 'battle') newBattle();
}

function switchUser() {
  state.currentUser = null;
  document.getElementById('screen-main').classList.remove('active');
  document.getElementById('screen-user').classList.add('active');
}

// ── Navigation ──────────────────────────────────────────────────────────────

const VALID_VIEWS = ['battle', 'leaderboard', 'movies'];

function currentHashView() {
  const hash = location.hash.replace('#', '');
  return VALID_VIEWS.includes(hash) ? hash : 'battle';
}

function showView(name, pushState = true) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
  document.getElementById('view-' + name).classList.add('active');
  document.getElementById('nav-' + name).classList.add('active');
  if (pushState) location.hash = name;
  if (name === 'leaderboard') renderLeaderboard();
  if (name === 'movies') renderMoviesView();
  if (name === 'battle' && !state.battleA) newBattle();
}

window.addEventListener('hashchange', () => {
  if (state.currentUser) showView(currentHashView(), false);
});

// ── Battle ──────────────────────────────────────────────────────────────────

function pickTwoRandom() {
  const movies = state.movies;
  if (movies.length < 2) return [movies[0], movies[1]];
  let a, b;
  do {
    a = movies[Math.floor(Math.random() * movies.length)];
    b = movies[Math.floor(Math.random() * movies.length)];
  } while (a.id === b.id);
  return [a, b];
}

function newBattle() {
  document.getElementById('vote-result').classList.add('hidden');
  const [a, b] = pickTwoRandom();
  state.battleA = a;
  state.battleB = b;

  renderBattleCard('a', a);
  renderBattleCard('b', b);

  // Re-enable buttons
  document.querySelectorAll('.vote-btn').forEach(btn => {
    btn.disabled = false;
    btn.style.opacity = '1';
  });
}

function renderBattleCard(side, movie) {
  const rank = getRank(movie.id, 'all');
  const total = totalScore(movie);
  document.getElementById('rank-' + side).textContent =
    rank <= 100 ? `#${rank} in the Homyak 100` : `Ranked #${rank}`;
  document.getElementById('title-' + side).textContent = movie.title;
  document.getElementById('meta-' + side).textContent =
    `${movie.year}  ·  ${movie.director}`;
  document.getElementById('score-' + side).textContent =
    total === 0 ? 'No votes yet' : `${total} pts total`;
}

function vote(side, points) {
  const winner = side === 'a' ? state.battleA : state.battleB;
  const user = state.currentUser;

  winner.scores[user] = (winner.scores[user] || 0) + points;

  state.battles.push({
    a: state.battleA.id,
    b: state.battleB.id,
    winner: winner.id,
    points,
    user,
    ts: Date.now(),
  });

  saveState();

  // Show result
  const label = points === 3 ? 'much better' : 'better';
  document.getElementById('result-text').innerHTML =
    `<strong>${winner.title}</strong> wins — voted <em>${label}</em> (+${points} pts)`;
  document.getElementById('vote-result').classList.remove('hidden');

  // Disable buttons
  document.querySelectorAll('.vote-btn').forEach(btn => {
    btn.disabled = true;
    btn.style.opacity = '0.5';
  });
}

// ── Leaderboard ─────────────────────────────────────────────────────────────

function setFilter(filter) {
  state.leaderboardFilter = filter;
  document.querySelectorAll('.filter-pill').forEach(p => p.classList.remove('active'));
  document.getElementById('filter-' + filter).classList.add('active');
  renderLeaderboard();
}

function renderLeaderboard() {
  const filter = state.leaderboardFilter;
  const ranked = getLeaderboard(filter);
  const container = document.getElementById('leaderboard-list');

  if (ranked.every(m => filteredScore(m, filter) === 0)) {
    container.innerHTML = `<div class="lb-empty">No votes yet — start a battle to build the leaderboard!</div>`;
    return;
  }

  let html = '';
  let passedCutoff = false;

  ranked.forEach((movie, i) => {
    const rank = i + 1;
    const score = filteredScore(movie, filter);

    if (rank === 101 && !passedCutoff) {
      passedCutoff = true;
      html += `<div class="lb-divider"><span class="lb-divider-label">— Outside the Homyak 100 —</span></div>`;
    }

    let rankDisplay = rank;
    let rankClass = '';
    if (rank === 1) { rankDisplay = '🥇'; rankClass = 'gold'; }
    else if (rank === 2) { rankDisplay = '🥈'; rankClass = 'silver'; }
    else if (rank === 3) { rankDisplay = '🥉'; rankClass = 'bronze'; }

    const rowClass = rank === 1 ? 'rank-1' : rank <= 10 ? 'top-10' : rank <= 100 ? 'top-100' : '';

    const breakdown = USERS.map(u => `${u[0]}:${movie.scores[u] || 0}`).join('  ');

    html += `
      <div class="lb-row ${rowClass}">
        <div class="lb-rank ${rankClass}">${rankDisplay}</div>
        <div class="lb-info">
          <div class="lb-title">${movie.title}</div>
          <div class="lb-meta">${movie.year} · ${movie.director}</div>
        </div>
        <div class="lb-scores">
          <div class="lb-total">${score} pts</div>
          ${filter === 'all' ? `<div class="lb-breakdown">${breakdown}</div>` : ''}
        </div>
      </div>`;
  });

  container.innerHTML = html;
}

// ── All Movies View ─────────────────────────────────────────────────────────

function renderMoviesView() {
  const query = (document.getElementById('search-input')?.value || '').toLowerCase().trim();
  const ranked = getLeaderboard('all');
  const filtered = query
    ? ranked.filter(m =>
        m.title.toLowerCase().includes(query) ||
        m.director.toLowerCase().includes(query) ||
        String(m.year).includes(query))
    : ranked;

  document.getElementById('movie-count').textContent = state.movies.length;

  if (query && filtered.length === 0) {
    const displayTitle = (document.getElementById('search-input')?.value || '').trim();
    document.getElementById('movies-list').innerHTML = `
      <div class="no-results">
        <p>No movie matching "<strong>${displayTitle}</strong>" in the list.</p>
        <button class="add-from-search-btn" onclick="addFromSearch()">+ Add "${displayTitle}"</button>
        <div id="inline-lookup-status" class="lookup-status"></div>
        <div id="inline-add-details" class="inline-add-details hidden">
          <div class="inline-fields">
            <input type="number" id="inline-year" placeholder="Year" min="1888" max="2030" />
            <input type="text" id="inline-director" placeholder="Director" />
            <button onclick="confirmAddFromSearch()">Add to list</button>
          </div>
        </div>
      </div>`;
    return;
  }

  let html = `<table class="movies-table">
    <thead><tr>
      <th class="col-rank">#</th>
      <th>Title</th>
      <th class="col-year">Year</th>
      <th class="col-director">Director</th>
      <th class="col-score">Pts</th>
    </tr></thead><tbody>`;

  filtered.forEach(movie => {
    const rank = getRank(movie.id, 'all');
    const score = totalScore(movie);
    html += `<tr>
      <td class="col-rank">${rank}</td>
      <td class="col-title">${movie.title}</td>
      <td class="col-year">${movie.year}</td>
      <td class="col-director">${movie.director}</td>
      <td class="col-score">${score}</td>
    </tr>`;
  });

  html += '</tbody></table>';
  document.getElementById('movies-list').innerHTML = html;
}

async function addFromSearch() {
  const title = (document.getElementById('search-input')?.value || '').trim();
  if (!title) return;

  const statusEl = document.getElementById('inline-lookup-status');
  const detailsEl = document.getElementById('inline-add-details');
  if (statusEl) { statusEl.textContent = 'Looking up…'; statusEl.className = 'lookup-status loading'; }

  try {
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title + ' film')}&format=json&origin=*&srlimit=5`;
    const searchData = await fetch(searchUrl).then(r => r.json());
    const hits = (searchData.query && searchData.query.search) || [];

    let year = '', director = '';
    if (hits.length) {
      const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(hits[0].title)}`;
      const summary = await fetch(summaryUrl).then(r => r.json());
      const extract = summary.extract || '';
      const yearMatch = extract.match(/\bis an? (\d{4})\b/);
      const dirMatch = extract.match(/directed by ([A-Z][a-zÀ-ÖØ-öø-ÿ\-']+(?:\s+[A-Z][a-zÀ-ÖØ-öø-ÿ\-']+){1,3})/);
      year = yearMatch ? parseInt(yearMatch[1]) : '';
      director = dirMatch ? dirMatch[1].replace(/\s*\[.*?\]/g, '').trim() : '';
    }

    if (statusEl) {
      statusEl.textContent = year || director ? `Found: ${title} (${year || '?'})` : 'Couldn\'t auto-fill — enter details below.';
      statusEl.className = 'lookup-status ' + (year || director ? 'ok' : 'warn');
    }
    if (detailsEl) {
      detailsEl.classList.remove('hidden');
      const yearEl = document.getElementById('inline-year');
      const dirEl = document.getElementById('inline-director');
      if (yearEl && year) yearEl.value = year;
      if (dirEl && director) dirEl.value = director;
    }
  } catch (e) {
    if (statusEl) { statusEl.textContent = 'Lookup failed — enter details below.'; statusEl.className = 'lookup-status warn'; }
    if (detailsEl) detailsEl.classList.remove('hidden');
  }
}

function confirmAddFromSearch() {
  const title = (document.getElementById('search-input')?.value || '').trim();
  const year = parseInt(document.getElementById('inline-year')?.value || '');
  const director = (document.getElementById('inline-director')?.value || '').trim();

  if (!year || !director) {
    alert('Please fill in year and director.');
    return;
  }
  if (state.movies.some(m => m.title.toLowerCase() === title.toLowerCase())) {
    alert('That movie is already in the list.');
    return;
  }

  const newId = Math.max(...state.movies.map(m => m.id), 0) + 1;
  state.movies.push({ id: newId, title, year, director, scores: { Nick: 0, Matt: 0, Friend: 0 } });
  saveState();

  document.getElementById('search-input').value = '';
  renderMoviesView();
}

let lookupTimer = null;

function showAddMovie() {
  document.getElementById('add-movie-form').classList.remove('hidden');
  document.getElementById('new-title').focus();
}

function hideAddMovie() {
  document.getElementById('add-movie-form').classList.add('hidden');
  document.getElementById('new-title').value = '';
  document.getElementById('new-year').value = '';
  document.getElementById('new-director').value = '';
  clearLookupStatus();
}

function setLookupStatus(msg, type) {
  const el = document.getElementById('lookup-status');
  if (!el) return;
  el.textContent = msg;
  el.className = 'lookup-status ' + (type || '');
}

function clearLookupStatus() {
  setLookupStatus('', '');
}

function onTitleInput() {
  clearTimeout(lookupTimer);
  const title = document.getElementById('new-title').value.trim();
  if (title.length < 2) { clearLookupStatus(); return; }
  setLookupStatus('Looking up…', 'loading');
  lookupTimer = setTimeout(() => lookupMovie(title), 600);
}

async function lookupMovie(title) {
  try {
    // Step 1: search Wikipedia for the movie page
    const searchUrl = `https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(title + ' film')}&format=json&origin=*&srlimit=5`;
    const searchRes = await fetch(searchUrl);
    const searchData = await searchRes.json();
    const hits = (searchData.query && searchData.query.search) || [];

    if (!hits.length) {
      setLookupStatus('No match found — fill in manually.', 'warn');
      return;
    }

    // Step 2: fetch the summary of the best hit
    const pageTitle = hits[0].title;
    const summaryUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(pageTitle)}`;
    const summaryRes = await fetch(summaryUrl);
    const summary = await summaryRes.json();
    const extract = summary.extract || '';

    // Parse year: "is a YYYY" or "is an YYYY"
    const yearMatch = extract.match(/\bis an? (\d{4})\b/);
    const year = yearMatch ? parseInt(yearMatch[1]) : '';

    // Parse director: "directed by Firstname Lastname"
    const dirMatch = extract.match(/directed by ([A-Z][a-zÀ-ÖØ-öø-ÿ\-']+(?:\s+[A-Z][a-zÀ-ÖØ-öø-ÿ\-']+){1,3})/);
    const director = dirMatch ? dirMatch[1].replace(/\s*\[.*?\]/g, '').trim() : '';

    if (!year && !director) {
      setLookupStatus(`Found "${pageTitle}" but couldn't parse details — fill in manually.`, 'warn');
      return;
    }

    const yearEl = document.getElementById('new-year');
    const dirEl = document.getElementById('new-director');
    if (year && !yearEl.value) yearEl.value = year;
    if (director && !dirEl.value) dirEl.value = director;

    setLookupStatus(`Found: ${pageTitle} (${year || '?'})`, 'ok');
  } catch (e) {
    setLookupStatus('Lookup failed — fill in manually.', 'warn');
  }
}

function addMovie() {
  const title = document.getElementById('new-title').value.trim();
  const year = parseInt(document.getElementById('new-year').value);
  const director = document.getElementById('new-director').value.trim();

  if (!title || !year || !director) {
    alert('Please fill in title, year, and director.');
    return;
  }

  if (state.movies.some(m => m.title.toLowerCase() === title.toLowerCase())) {
    alert('That movie is already in the list.');
    return;
  }

  const newId = Math.max(...state.movies.map(m => m.id), 0) + 1;
  state.movies.push({
    id: newId,
    title,
    year,
    director,
    scores: { Nick: 0, Matt: 0, Friend: 0 },
  });

  saveState();
  hideAddMovie();
  renderMoviesView();
}

// ── Init ────────────────────────────────────────────────────────────────────

loadState();
